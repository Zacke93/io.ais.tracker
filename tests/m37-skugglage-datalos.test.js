'use strict';

jest.mock('homey');

/**
 * M37 (helkodsgranskning RUNDA 4, 2026-08-23) — SKUGGLÄGE RÄKNADES SOM
 * PIPELINE-MATANDE KÄLLA: APPEN KUNDE VARA HELT BLIND, OCH ENDA NOTISEN
 * PÅSTOD ATT AISHUB BAR.
 *
 * MEKANISMEN FÖRE FIXEN:
 *  • `sourceWantsHub` i _startConnection inkluderar 'shadow', så tomnyckel-
 *    grenen (som skriver connection_status 'disconnected' och notifierar)
 *    hoppades över. Men skuggläge matar INTE pipelinen: muxen kastar VARJE
 *    hubbfix ("aldrig vidare — beviset ska vara rent") och _hubFeedsPipeline
 *    är falskt. Utan aisstream-nyckel finns alltså ingen källa alls bakom
 *    brotexten eller notiserna.
 *  • _applyAisSourceConfig delade gren med 'both' och skickade i stället
 *    texten att appen "kör enbart AISHub".
 * Mätt: 8 h i det läget gav noll notiser.
 *
 * NÅBARHETEN: inställningssidan REKOMMENDERAR själv skuggläge i minst 48 h och
 * kräver bara username för icke-aisstream-källor — en användare som följer
 * appens egen rekommendation utan aisstream-nyckel hamnar exakt här.
 *
 * FIXEN: shadow bryts ut ur degraderingsgrenen och får en SANN text, och
 * _startConnection skriver 'disconnected' + skickar datalös-notisen även för
 * shadow. `sourceWantsHub` står ORÖRT — skuggtelemetrin ska fortsatt startas
 * (kontraktet i tests/aishub-settings-contract.test.js: connect(null) körs).
 *
 * MUTATIONSPROV (körs manuellt): slå ihop grenarna igen
 * (`(source === 'both' || source === 'shadow')`) ⇒ texttestet nedan faller.
 * Ta bort `blindWithoutKey`-blocket i _startConnection ⇒ status- och
 * notistesterna faller. Ta bort shadow ur `sourceWantsHub` ⇒ connect-testet
 * faller (och det låsta kontraktet i systerfilen).
 */

const AISBridgeApp = require('../app');

function makeApp(settings = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app._updateDeviceCapability = jest.fn();
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

const notifiedText = (app) => app._notifyConnectionIssue.mock.calls
  .filter((c) => c[1] === 'aisstream:nokey')
  .map((c) => String(c[0]))
  .join(' | ');

describe('M37 (a): _applyAisSourceConfig skiljer shadow från both', () => {
  test('SHADOW utan nyckel ⇒ SANN text (ingen källa matar brotext/notiser)', () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'shadow' });
    app.aisClient = { applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    app._applyAisSourceConfig();

    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.any(String), 'aisstream:nokey');
    const text = notifiedText(app);
    expect(text).toContain('skuggläge');
    expect(text).toContain('utan båtdata');
    // Den GAMLA lögnen får inte stå kvar.
    expect(text).not.toContain('kör enbart AISHub');
    // Konfigurationen appliceras ändå — skuggtelemetrin ska leva.
    expect(app.aisClient.applySourceConfig).toHaveBeenCalled();
  });

  test('BOTH utan nyckel ⇒ oförändrad degraderingstext (solo-AISHub bär faktiskt)', () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'both' });
    app.aisClient = { applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    app._applyAisSourceConfig();

    expect(notifiedText(app)).toContain('enbart AISHub');
    expect(notifiedText(app)).not.toContain('skuggläge');
  });

  test('SHADOW MED nyckel ⇒ ingen notis alls (normalläget)', () => {
    const app = makeApp({ ais_api_key: 'KEY', aishub_username: 'hubuser', ais_source: 'shadow' });
    app.aisClient = { applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    app._applyAisSourceConfig();
    expect(app._notifyConnectionIssue).not.toHaveBeenCalled();
  });
});

describe('M37 (b): _startConnection släpper fram datalös-larmet för shadow', () => {
  let savedEnv;
  let savedTestMode;

  beforeEach(() => {
    savedEnv = process.env.NODE_ENV;
    savedTestMode = global.__TEST_MODE__;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;
  });

  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = savedTestMode;
  });

  test('SHADOW utan nyckel: disconnected + datalös-notis MEN muxen startas ändå', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'shadow' });
    app.aisClient = { connect: jest.fn().mockResolvedValue(undefined), applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    app._writeConnectionStatus = jest.fn();
    await app._startConnection();

    // Kontraktet (systerfilen rad ~340): skuggtelemetrin startas.
    expect(app.aisClient.connect).toHaveBeenCalledWith(null);
    // …men användaren får veta att appen är utan data.
    expect(app._writeConnectionStatus).toHaveBeenCalledWith(
      'disconnected',
      expect.stringContaining('skuggläge'),
    );
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(
      expect.stringContaining('skuggläge'),
      'aisstream:nokey',
    );
    // Loggraden om "enbart AISHub-källan" är falsk i skuggläge.
    const logs = app.log.mock.calls.map((c) => String(c[0])).join(' | ');
    expect(logs).toContain('SKUGGMÄTNING');
    expect(logs).not.toContain('startar enbart AISHub-källan');
  });

  test('AISHUB solo utan nyckel: oförändrat — hubben MATAR pipelinen, inget larm', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'aishub' });
    app.aisClient = { connect: jest.fn().mockResolvedValue(undefined), applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    app._writeConnectionStatus = jest.fn();
    await app._startConnection();

    expect(app.aisClient.connect).toHaveBeenCalledWith(null);
    expect(app._writeConnectionStatus).not.toHaveBeenCalled();
    expect(app._notifyConnectionIssue).not.toHaveBeenCalled();
    expect(app.log.mock.calls.map((c) => String(c[0])).join(' | '))
      .toContain('startar enbart AISHub-källan');
  });

  test('BOTH utan nyckel: oförändrat — degradering till solo-AISHub, inget blindhetslarm', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'both' });
    app.aisClient = { connect: jest.fn().mockResolvedValue(undefined), applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    app._writeConnectionStatus = jest.fn();
    await app._startConnection();

    expect(app.aisClient.connect).toHaveBeenCalledWith(null);
    expect(app._writeConnectionStatus).not.toHaveBeenCalled();
  });

  test('SHADOW MED nyckel: normal uppkoppling, inget blindhetslarm', async () => {
    const app = makeApp({ ais_api_key: 'KEY', aishub_username: 'hubuser', ais_source: 'shadow' });
    app.aisClient = { connect: jest.fn().mockResolvedValue(undefined), applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    app._writeConnectionStatus = jest.fn();
    await app._startConnection();

    expect(app.aisClient.connect).toHaveBeenCalledWith('KEY');
    expect(app._writeConnectionStatus).not.toHaveBeenCalled();
    expect(app._notifyConnectionIssue).not.toHaveBeenCalled();
  });

  test('HELT UTAN KÄLLA: dagens tomnyckelgren står orörd (ingen connect)', async () => {
    const app = makeApp({});
    app.aisClient = { connect: jest.fn(), applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    await app._startConnection();
    expect(app.aisClient.connect).not.toHaveBeenCalled();
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.any(String), 'aisstream:nokey');
  });
});
