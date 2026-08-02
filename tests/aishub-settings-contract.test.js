'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * Etapp 2 (2026-08-02): settings-kontraktet för källkonfigurationen +
 * per-källa-notisdedupen + den källmedvetna feed-vakten. Kärnfallen ur
 * granskningen: V1-C2 (aggregatet får ALDRIG maskera aisstream-tystnad),
 * V1-M6 (ett AISHub-fel får inte tysta ett aisstream-nyckelfel i 24h) och
 * V2-C2-följdkravet (aishub_last_poll_at får inte trigga omkonfiguration).
 */

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

describe('Etapp 2: _applyAisSourceConfig läser settings och applicerar på muxen', () => {
  test('normaliserade värden når applySourceConfig', () => {
    const app = makeApp({
      ais_api_key: '  KEY123  ', aishub_username: '  hubuser ', ais_source: 'shadow',
    });
    app.aisClient = { applySourceConfig: jest.fn() };
    app._applyAisSourceConfig();
    expect(app.aisClient.applySourceConfig).toHaveBeenCalledWith({
      source: 'shadow', apiKey: 'KEY123', aishubUsername: 'hubuser',
    });
  });

  test('okänt ais_source-värde ⇒ aisstream', () => {
    const app = makeApp({ ais_api_key: 'KEY', ais_source: 'turbo' });
    app.aisClient = { applySourceConfig: jest.fn() };
    app._applyAisSourceConfig();
    expect(app.aisClient.applySourceConfig.mock.calls[0][0].source).toBe('aisstream');
  });

  test('fallback-notisen: aishub-läge utan username', () => {
    const app = makeApp({ ais_api_key: 'KEY', ais_source: 'both' });
    app.aisClient = { applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    app._applyAisSourceConfig();
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.any(String), 'config:fallback');
  });

  test('degraderingsnotisen: both utan aisstream-nyckel ⇒ solo-AISHub-varning', () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'both' });
    app.aisClient = { applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    app._applyAisSourceConfig();
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.any(String), 'aisstream:nokey');
    // Konfigurationen appliceras ändå — degradering, inte block.
    expect(app.aisClient.applySourceConfig).toHaveBeenCalled();
  });

  test('stub utan applySourceConfig ⇒ ofarlig no-op (testkontraktet)', () => {
    const app = makeApp({ ais_api_key: 'KEY' });
    app.aisClient = { reconnectWithKey: jest.fn(), disconnect: jest.fn() };
    expect(() => app._applyAisSourceConfig()).not.toThrow();
  });
});

describe('Etapp 2: settings-listenern — nya grenar och poll-spärr-undantaget', () => {
  function wireApp(settings) {
    const app = makeApp(settings);
    app.aisClient = { applySourceConfig: jest.fn() };
    app._applyAisSourceConfig = jest.fn();
    app._setupSettingsListener();
    return app;
  }

  test('aishub_username-ändring ⇒ källkonfiguration appliceras', () => {
    const app = wireApp({ aishub_username: 'hubuser' });
    app._onSettingsChanged('aishub_username');
    expect(app._applyAisSourceConfig).toHaveBeenCalledTimes(1);
  });

  test('ais_source-ändring ⇒ källkonfiguration appliceras', () => {
    const app = wireApp({ ais_source: 'shadow' });
    app._onSettingsChanged('ais_source');
    expect(app._applyAisSourceConfig).toHaveBeenCalledTimes(1);
  });

  test('V2-C2-följdkravet: aishub_last_poll_at får ALDRIG trigga omkonfiguration', () => {
    const app = wireApp({});
    app._onSettingsChanged(AIS_CONFIG.AISHUB.LAST_POLL_SETTINGS_KEY);
    expect(app._applyAisSourceConfig).not.toHaveBeenCalled();
  });

  test('ais_api_key-ändring med mux ⇒ via källkonfigurationen (konfigmatrisen)', () => {
    const app = wireApp({ ais_api_key: 'NYCKEL' });
    app._onSettingsChanged('ais_api_key');
    expect(app._applyAisSourceConfig).toHaveBeenCalledTimes(1);
  });
});

describe('Etapp 2 (V1-M6): notisdedup per källa/felklass', () => {
  test('olika nycklar dedupar oberoende — AISHub-fel tystar inte aisstream-nyckelfel', async () => {
    const app = makeApp();
    await app._notifyConnectionIssue('aishub-problem', 'aishub:server');
    await app._notifyConnectionIssue('aisstream-nyckelfel', 'aisstream:auth');
    expect(app.homey.notifications.createNotification).toHaveBeenCalledTimes(2);

    // Samma nyckel inom 24h ⇒ dedup.
    await app._notifyConnectionIssue('aishub-problem igen', 'aishub:server');
    expect(app.homey.notifications.createNotification).toHaveBeenCalledTimes(2);
  });

  test('rollback per nyckel: misslyckad leverans spärrar inte nya försök', async () => {
    const app = makeApp();
    app.homey.notifications.createNotification = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    await app._notifyConnectionIssue('första (misslyckas)', 'aishub:auth');
    await app._notifyConnectionIssue('andra (levereras)', 'aishub:auth');
    expect(app.homey.notifications.createNotification).toHaveBeenCalledTimes(2);
  });

  test('bakåtkompatibelt: anrop utan nyckel dedupar på global (befintligt B3-kontrakt)', async () => {
    const app = makeApp();
    await app._notifyConnectionIssue('första felet');
    await app._notifyConnectionIssue('andra felet inom 24h');
    expect(app.homey.notifications.createNotification).toHaveBeenCalledTimes(1);
  });
});

describe('Etapp 2: källneutrala felhanterare', () => {
  test('_onAISAuthError: aishub-källan får AISHub-text och egen dedupnyckel', () => {
    const app = makeApp();
    app._notifyConnectionIssue = jest.fn();
    app._onAISAuthError('Access denied', 'aishub');
    expect(app.error.mock.calls[0].join(' ')).toContain('AISHub');
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.stringContaining('AISHub'), 'aishub:auth');
  });

  test('_onAISAuthError: default (inget feed-argument) är aisstream — legacy-kontraktet', () => {
    const app = makeApp();
    app._notifyConnectionIssue = jest.fn();
    app._onAISAuthError('invalid api key');
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.stringContaining('AISstream.io'), 'aisstream:auth');
  });

  test('_onAISServerError: per-källa text + nyckel', () => {
    const app = makeApp();
    app._notifyConnectionIssue = jest.fn();
    app._onAISServerError('boom', 'aishub');
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.stringContaining('AISHub'), 'aishub:server');
    app._onAISServerError('boom');
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.stringContaining('AISstream.io'), 'aisstream:server');
  });
});

describe('Etapp 2 (V1-C2): per-feed-watchdogen — aggregatet får aldrig maskera', () => {
  const MIN = 60 * 1000;

  function makeWatchdogApp(perFeed, { apiKey = 'KEY' } = {}) {
    const app = makeApp({ ais_api_key: apiKey });
    app.aisClient = {
      isConnected: true,
      getConnectionStats: jest.fn().mockReturnValue({
        // Aggregatet är FÄRSKT (aishub-pollen levererar) — fällan som hade
        // avväpnat vakten om den läste platta fält.
        timeSinceLastMessage: 30 * 1000,
        uptime: 90 * MIN,
        perFeed,
      }),
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
      kickAishub: jest.fn(),
    };
    return app;
  }

  test('KÄRNFALLET: aisstream tyst 25 min medan AISHub flödar ⇒ aisstream-omanslutning ändå', () => {
    const app = makeWatchdogApp({
      aisstream: {
        configured: true,
        isConnected: true,
        timeSinceLastMessage: 25 * MIN,
        uptime: 60 * MIN,
        lastMessageTime: Date.now() - 25 * MIN,
      },
      aishub: {
        configured: true,
        isConnected: true,
        timeSinceLastMessage: 30 * 1000,
        uptime: 60 * MIN,
        lastMessageTime: Date.now() - 30 * 1000,
        lastOkResponseAt: Date.now() - 5000,
        lastPollStartedAt: Date.now() - 5000,
      },
    });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledWith('KEY');
  });

  test('nyligen omansluten aisstream (kort uptime) ⇒ fullt nytt fönster (RC-S1-kontraktet per feed)', () => {
    const app = makeWatchdogApp({
      aisstream: {
        configured: true, isConnected: true, timeSinceLastMessage: 45 * MIN, uptime: 5 * MIN, lastMessageTime: null,
      },
      aishub: { configured: false },
    });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });

  test('AISHub-grenen gatas INTE på ais_api_key: död poll-kedja kickas utan nyckel', () => {
    const app = makeWatchdogApp({
      aisstream: { configured: false },
      aishub: {
        configured: true,
        isConnected: true,
        timeSinceLastMessage: 20 * MIN,
        uptime: 60 * MIN,
        lastMessageTime: null,
        lastOkResponseAt: Date.now() - 20 * MIN,
        lastPollStartedAt: Date.now() - 15 * MIN, // > 11 min ⇒ kedjan död
      },
    }, { apiKey: '' });
    app._checkAISFeedHealth();
    expect(app.aisClient.kickAishub).toHaveBeenCalled();
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });

  test('frisk AISHub-kedja (poll nyss startad, svar nyss) ⇒ ingen kick', () => {
    const app = makeWatchdogApp({
      aisstream: { configured: false },
      aishub: {
        configured: true,
        isConnected: true,
        timeSinceLastMessage: 30 * 1000,
        uptime: 60 * MIN,
        lastMessageTime: Date.now() - 30 * 1000,
        lastOkResponseAt: Date.now() - 10 * 1000,
        lastPollStartedAt: Date.now() - 10 * 1000,
      },
    });
    app._checkAISFeedHealth();
    expect(app.aisClient.kickAishub).not.toHaveBeenCalled();
  });

  test('[FEED_SILENT]: konfigurerad källa tyst 20 min medan den andra flödar ⇒ logg + notis per källa', () => {
    const app = makeWatchdogApp({
      aisstream: {
        configured: true, isConnected: true, timeSinceLastMessage: 30 * 1000, uptime: 60 * MIN, lastMessageTime: Date.now() - 30 * 1000,
      },
      aishub: {
        configured: true,
        isConnected: true,
        timeSinceLastMessage: 20 * MIN,
        uptime: 60 * MIN,
        lastMessageTime: Date.now() - 20 * MIN,
        lastOkResponseAt: Date.now() - 5000, // servern svarar (tomma svep) men inga accepterade positioner
        lastPollStartedAt: Date.now() - 5000,
      },
    });
    app._notifyConnectionIssue = jest.fn();
    app._checkAISFeedHealth();
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.stringContaining('AISHub'), 'aishub:silent');
    const silentLogs = app.log.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[FEED_SILENT]'));
    expect(silentLogs.length).toBe(1);
  });

  test('legacy-stubbar utan perFeed ⇒ exakt dagens plattlogik (bakåtkontraktet)', () => {
    const app = makeApp({ ais_api_key: 'KEY' });
    app.aisClient = {
      isConnected: true,
      getConnectionStats: jest.fn().mockReturnValue({ timeSinceLastMessage: 25 * MIN, uptime: 60 * MIN }),
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
    };
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledWith('KEY');
  });
});

describe('Etapp 2: källmedveten _startConnection (tomnyckelgrenen)', () => {
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

  test('ingen nyckel + ingen AISHub-källa ⇒ dagens beteende (notis, ingen connect)', async () => {
    const app = makeApp({});
    app.aisClient = { connect: jest.fn(), applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    await app._startConnection();
    expect(app.aisClient.connect).not.toHaveBeenCalled();
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(expect.any(String), 'aisstream:nokey');
  });

  test('ingen nyckel MEN shadow+username ⇒ muxen startas (AISHub-källan)', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'shadow' });
    app.aisClient = { connect: jest.fn().mockResolvedValue(undefined), applySourceConfig: jest.fn() };
    app._notifyConnectionIssue = jest.fn();
    await app._startConnection();
    expect(app.aisClient.applySourceConfig).toHaveBeenCalled();
    expect(app.aisClient.connect).toHaveBeenCalledWith(null);
  });
});
