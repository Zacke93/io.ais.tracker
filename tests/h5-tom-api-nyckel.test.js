'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const AISHubClient = require('../lib/connection/AISHubClient');

/**
 * H5 (helkodsgranskning 2026-08-22): en TÖMD API-nyckel var en fullständig
 * no-op — den återkallade credentialen fortsatte användas.
 *
 * MEKANISMEN: app.js skickade `apiKey: apiKey || null` till muxen, och muxens
 * applySourceConfig tolkar null som "BEHÅLL FÖRRA VÄRDET". Den effektiva
 * konfignyckeln blev därför oförändrad, idempotensgrinden returnerade tidigt
 * och varken _reconcile eller disconnect kördes. Inställningssidans löfte
 * (locales/sv.json) var alltså osant: strömmen levde vidare på den nyckel
 * användaren just raderat.
 *
 * TESTET KÖR DEN RIKTIGA MUXEN. tests/api-key-reconnect.test.js testar mot en
 * stub UTAN applySourceConfig och kan därför aldrig se det här — den bevakar
 * legacy-grenen, som är död i produktion sedan muxen alltid har metoden.
 */

function makeApp(settings = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._notifyConnectionIssue = jest.fn().mockResolvedValue(undefined);
  const store = { ...settings };
  app.homey = {
    settings: {
      get: (k) => (k in store ? store[k] : null),
      set: (k, v) => {
        store[k] = v;
      },
      on: jest.fn(),
    },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  app._store = store;
  return app;
}

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

// _reconcile är async och anropas UTAN await från applySourceConfig — låt
// mikrotaskkön tömmas innan vi läser muxens tillstånd.
const flush = () => new Promise((resolve) => {
  setImmediate(resolve);
});

describe('H5: tömd ais_api_key stänger faktiskt av aisstream (riktig mux)', () => {
  let mux;
  let hubConnect;
  let hubDisconnect;

  beforeEach(() => {
    // Inga riktiga HTTP-pollar: hub-barnets livscykel stubbas på prototypen så
    // muxens EGEN rivningslogik ändå körs skarpt.
    hubConnect = jest.spyOn(AISHubClient.prototype, 'connect').mockResolvedValue(undefined);
    hubDisconnect = jest.spyOn(AISHubClient.prototype, 'disconnect').mockImplementation(() => {});
  });

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
    jest.restoreAllMocks();
  });

  function wire(app) {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    jest.spyOn(mux._streamClient, 'connect').mockResolvedValue(undefined);
    jest.spyOn(mux._streamClient, 'disconnect').mockImplementation(() => {});
    jest.spyOn(mux._streamClient, 'reconnectWithKey').mockResolvedValue(undefined);
    app.aisClient = mux;
    return mux;
  }

  test('KÄRNAN: nyckeln raderas i inställningarna ⇒ strömmen rivs och nyckeln nollas', async () => {
    const app = makeApp({ ais_api_key: 'OLDKEY', ais_source: 'aisstream' });
    wire(app);

    app._applyAisSourceConfig();
    await flush();
    expect(mux._config.apiKey).toBe('OLDKEY');
    expect(mux._streamActive).toBe(true);
    expect(mux._streamClient.connect).toHaveBeenCalledWith('OLDKEY');

    // Användaren tömmer fältet (Homey levererar tom sträng).
    app.homey.settings.set('ais_api_key', '');
    app._applyAisSourceConfig();
    await flush();

    expect(mux._config.apiKey).toBeNull();
    expect(mux._streamActive).toBe(false);
    expect(mux._streamClient.disconnect).toHaveBeenCalledTimes(1);
  });

  test('KONTRAKTET: app.js skickar den TRIMMADE strängen, aldrig null-behåll-signalen', () => {
    const app = makeApp({ ais_api_key: '   ', aishub_username: '', ais_source: 'aisstream' });
    app.aisClient = { applySourceConfig: jest.fn() };
    app._applyAisSourceConfig();
    // null här = "behåll förra värdet" i muxen ⇒ raderingen blir en no-op.
    expect(app.aisClient.applySourceConfig).toHaveBeenCalledWith({
      source: 'aisstream', apiKey: '', aishubUsername: '',
    });
  });

  test('SYSTERSTÄLLET: tömt aishub_username river hub-barnet och faller till aisstream', async () => {
    const app = makeApp({ ais_api_key: 'KEY', aishub_username: 'hubuser', ais_source: 'both' });
    wire(app);

    app._applyAisSourceConfig();
    await flush();
    expect(mux._hubClient).not.toBeNull();
    expect(hubConnect).toHaveBeenCalledWith('hubuser');

    app.homey.settings.set('aishub_username', '');
    app._applyAisSourceConfig();
    await flush();

    expect(mux._config.aishubUsername).toBeNull();
    expect(mux._config.source).toBe('aisstream'); // fallback-regeln
    expect(mux._hubClient).toBeNull();
    expect(hubDisconnect).toHaveBeenCalled();
  });

  test('NEGATIV KONTROLL: ett äkta nyckelBYTE återansluter fortfarande (F8-vägen intakt)', async () => {
    const app = makeApp({ ais_api_key: 'OLDKEY', ais_source: 'aisstream' });
    wire(app);
    app._applyAisSourceConfig();
    await flush();

    app.homey.settings.set('ais_api_key', 'NEWKEY');
    app._applyAisSourceConfig();
    await flush();

    expect(mux._config.apiKey).toBe('NEWKEY');
    expect(mux._streamActive).toBe(true);
    expect(mux._streamClient.reconnectWithKey).toHaveBeenCalledWith('NEWKEY', 'key-update');
    expect(mux._streamClient.disconnect).not.toHaveBeenCalled();
  });

  test('NEGATIV KONTROLL: oförändrade inställningar är fortfarande en no-op', async () => {
    const app = makeApp({ ais_api_key: 'KEY', ais_source: 'aisstream' });
    wire(app);
    app._applyAisSourceConfig();
    await flush();
    mux._streamClient.connect.mockClear();

    app._applyAisSourceConfig();
    await flush();

    expect(mux._streamClient.connect).not.toHaveBeenCalled();
    expect(mux._streamClient.disconnect).not.toHaveBeenCalled();
  });
});
