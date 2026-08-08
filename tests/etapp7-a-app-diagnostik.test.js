'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { UI_CONSTANTS } = require('../lib/constants');

/**
 * ETAPP 7, FAS A — app-diagnostiken (WS-A). ALLA fixar här är GRÖNA:
 * ingen produktbana ändrar beteende, bara observerbarhet.
 *
 * A1  — TEST_MODE-hålet: monitoring-loopens inline-block extraherade till
 *       anropbara metoder. Loopen är TEST_MODE-gatad ⇒ koden inuti den var
 *       otestbar och åldrades aldrig i regressionsskyddet.
 * A7  — FEED_WATCHDOG: tre storheter i loggen + persisterad tystnad över
 *       omstart (F-18: 20 av 21 strikes ljög; strike 21 sa 120 min när
 *       sanningen var 3 009 min), skäl till reconnectWithKey, delad
 *       strike-räknare.
 * A13 — notisvägens observerbarhet (F-15): projektets egen svälj-fälla i den
 *       enda kanal som når en användare utan loggåtkomst.
 * A14 — heapUsed/RSS i loggen (V8-heapen var helt omätt i 42h-fältprovet).
 */

const MIN = 60 * 1000;

const makeSettings = (store = {}) => ({
  __store: store,
  get: (k) => (k in store ? store[k] : null),
  set: (k, v) => {
    store[k] = v;
  },
  on: jest.fn(),
  off: jest.fn(),
});

const riggApp = (settings = makeSettings()) => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app.homey = { settings };
  return app;
};

// =============================================================================
// A1: monitoring-loopens extraherade block
// =============================================================================
describe('A1: monitoring-blocken är anropbara (TEST_MODE-hålet stängt)', () => {
  test('_pruneVesselNameCache släpper utgångna namn och behåller färska', () => {
    const app = riggApp();
    app._VESSEL_NAME_TTL_MS = 30 * 24 * 60 * MIN;
    app._persistVesselNames = jest.fn();
    const now = Date.now();
    app._knownVesselNames = new Map([
      ['111', { name: 'GAMMAL', t: now - 31 * 24 * 60 * MIN }],
      ['222', { name: 'FÄRSK', t: now - 60 * MIN }],
      ['333', null], // trasig post ⇒ ska också städas
    ]);

    app._pruneVesselNameCache();

    expect([...app._knownVesselNames.keys()]).toEqual(['222']);
    expect(app._persistVesselNames).toHaveBeenCalledTimes(1);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('_pruneVesselNameCache utan utgångna poster skriver INTE persistensen', () => {
    const app = riggApp();
    app._VESSEL_NAME_TTL_MS = 30 * 24 * 60 * MIN;
    app._persistVesselNames = jest.fn();
    app._knownVesselNames = new Map([['222', { name: 'FÄRSK', t: Date.now() }]]);

    app._pruneVesselNameCache();

    expect(app._persistVesselNames).not.toHaveBeenCalled();
  });

  test('_pruneAisRejectLogTimes släpper poster äldre än 1 h', () => {
    const app = riggApp();
    const now = Date.now();
    app._aisRejectLogTimes = new Map([
      ['111', now - 61 * MIN],
      ['222', now - 5 * MIN],
      ['333', 'trasig'],
    ]);

    app._pruneAisRejectLogTimes();

    expect([...app._aisRejectLogTimes.keys()]).toEqual(['222']);
  });

  test('_pruneLastKnownPositionsTtl släpper utgångna och persisterar EN gång', () => {
    const app = riggApp();
    app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * MIN;
    app._persistLastKnownPositions = jest.fn();
    const now = Date.now();
    app._lastKnownPositions = new Map([
      ['111', { lat: 58.3, lon: 12.3, t: now - 7 * 60 * MIN }],
      ['222', { lat: 58.3, lon: 12.3, t: now - 10 * MIN }],
    ]);

    app._pruneLastKnownPositionsTtl();

    expect([...app._lastKnownPositions.keys()]).toEqual(['222']);
    expect(app._persistLastKnownPositions).toHaveBeenCalledTimes(1);
  });

  test('_pruneLastKnownPositionsTtl utan utgångna poster skriver INTE persistensen', () => {
    const app = riggApp();
    app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * MIN;
    app._persistLastKnownPositions = jest.fn();
    app._lastKnownPositions = new Map([['222', { lat: 58.3, lon: 12.3, t: Date.now() }]]);

    app._pruneLastKnownPositionsTtl();

    expect(app._persistLastKnownPositions).not.toHaveBeenCalled();
  });

  test('tomma/ouppsatta kartor ⇒ inga kastade fel (loopens defensiva kontrakt)', () => {
    const app = riggApp();
    expect(() => {
      app._pruneVesselNameCache();
      app._pruneAisRejectLogTimes();
      app._pruneLastKnownPositionsTtl();
    }).not.toThrow();
    expect(app.error).not.toHaveBeenCalled();
  });
});

describe('A1: ANROPSORDNINGEN i monitoring-loopen är ett kontrakt', () => {
  let savedEnv;
  let savedTestMode;

  beforeEach(() => {
    // TEST_MODE-kringgång (samma teknik som RC-S3-sviten): loopen sätts annars
    // aldrig upp och den RIKTIGA setInterval-kroppen kan inte prövas.
    savedEnv = process.env.NODE_ENV;
    savedTestMode = global.__TEST_MODE__;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = savedTestMode;
  });

  const riggLoopApp = () => {
    const app = riggApp();
    app.vesselDataService = { getVesselCount: () => 3 };
    app.systemCoordinator = { cleanup: jest.fn() };
    app.aisClient = { pruneFusionState: jest.fn() };
    app._pruneDedupCaches = jest.fn();
    app._pruneVesselNameCache = jest.fn();
    app._pruneAisRejectLogTimes = jest.fn();
    app._pruneLastKnownPositionsTtl = jest.fn();
    app._checkAISFeedHealth = jest.fn();
    app._logProcessMemoryStats = jest.fn();
    return app;
  };

  test('en tick kör alla block i exakt fastlagd ordning', () => {
    const app = riggLoopApp();
    app._setupMonitoring();
    expect(app._monitoringInterval).toBeTruthy();

    jest.advanceTimersByTime(UI_CONSTANTS.MONITORING_INTERVAL_MS);

    const order = (fn) => fn.mock.invocationCallOrder[0];
    const sequence = [
      app._pruneDedupCaches,
      app._pruneVesselNameCache,
      app.systemCoordinator.cleanup,
      app._pruneAisRejectLogTimes,
      app._pruneLastKnownPositionsTtl,
      app._checkAISFeedHealth,
      app.aisClient.pruneFusionState,
      app._logProcessMemoryStats,
    ];
    sequence.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
    for (let i = 1; i < sequence.length; i++) {
      expect(order(sequence[i - 1])).toBeLessThan(order(sequence[i]));
    }

    clearInterval(app._monitoringInterval);
  });

  test('kastande systemCoordinator.cleanup stoppar INTE resten av tickens block', () => {
    const app = riggLoopApp();
    app.systemCoordinator.cleanup = jest.fn(() => {
      throw new Error('boom');
    });
    app._setupMonitoring();

    jest.advanceTimersByTime(UI_CONSTANTS.MONITORING_INTERVAL_MS);

    expect(app._pruneAisRejectLogTimes).toHaveBeenCalledTimes(1);
    expect(app._checkAISFeedHealth).toHaveBeenCalledTimes(1);
    expect(app._logProcessMemoryStats).toHaveBeenCalledTimes(1);
    expect(app.error).toHaveBeenCalled(); // felet SVÄLJS inte

    clearInterval(app._monitoringInterval);
  });

  test('TEST_MODE ⇒ ingen loop alls (hålet finns kvar by design, metoderna nås direkt)', () => {
    global.__TEST_MODE__ = true;
    const app = riggLoopApp();
    app._setupMonitoring();
    expect(app._monitoringInterval).toBeUndefined();
  });
});

// =============================================================================
// A7: FEED_WATCHDOG-loggens tre storheter + persisterad tystnad
// =============================================================================
describe('A7(a): watchdog-loggen redovisar sinceMessage, uptime och sinceConfigured', () => {
  const riggWatchdogApp = ({ store = {}, feedStats }) => {
    const settings = makeSettings({ ais_api_key: 'KEY', ...store });
    const app = riggApp(settings);
    app.aisClient = {
      isConnected: true,
      getConnectionStats: jest.fn().mockReturnValue({
        timeSinceLastMessage: 30 * 1000, // aggregatet hålls färskt av AISHub
        uptime: 90 * MIN,
        perFeed: {
          aisstream: feedStats,
          aishub: {
            configured: true,
            isConnected: true,
            timeSinceLastMessage: 30 * 1000,
            uptime: 90 * MIN,
            lastMessageTime: Date.now() - 30 * 1000,
            lastOkResponseAt: Date.now() - 5000,
            lastPollStartedAt: Date.now() - 5000,
          },
        },
      }),
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
      kickAishub: jest.fn(),
    };
    return app;
  };

  const watchdogRows = (app) => app.log.mock.calls
    .map((c) => c.join(' '))
    .filter((l) => l.includes('[FEED_WATCHDOG]'));

  test('FÄLTFALLET (F-18): tystnad som spänner över omstart redovisas i sin helhet', () => {
    // 42h-fältprovet: strike 21 påstod "no messages for 120 min" medan den
    // verkliga tystnaden var 3 009 min — den började dagen FÖRE körningen.
    const now = Date.now();
    const app = riggWatchdogApp({
      store: {
        feed_silence_ledger: {
          aisstream: { lastMessageAt: now - 3000 * MIN, configuredSince: now - 3010 * MIN },
        },
      },
      feedStats: {
        configured: true,
        isConnected: true,
        timeSinceLastMessage: null, // klienten: "aldrig fått något SEDAN OMSTART"
        uptime: 125 * MIN,
        lastMessageTime: null,
      },
    });

    app._checkAISFeedHealth();

    const rows = watchdogRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('sinceMessage=3000 min');
    expect(rows[0]).toContain('spänner över omstart');
    expect(rows[0]).toContain('uptime=125 min');
    expect(rows[0]).toContain('sinceConfigured=3010 min');
    // Klampen finns kvar — men redovisas som det den är.
    expect(rows[0]).toContain('ingreppsklocka 125 min');
    expect(rows[0]).not.toContain('Infinity');
    // INGRIPANDET är oförändrat.
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledWith('KEY', 'watchdog');
  });

  test('aldrig levererat OCH ingen bokföring ⇒ "aldrig", inte Infinity', () => {
    const app = riggWatchdogApp({
      feedStats: {
        configured: true, isConnected: true, timeSinceLastMessage: null, uptime: 25 * MIN, lastMessageTime: null,
      },
    });

    app._checkAISFeedHealth();

    const rows = watchdogRows(app);
    expect(rows[0]).toContain('sinceMessage=aldrig');
    expect(rows[0]).not.toContain('Infinity');
    expect(rows[0]).toContain('uptime=25 min');
  });

  test('levande klientvärde vinner över äldre bokföring', () => {
    const now = Date.now();
    const app = riggWatchdogApp({
      store: { feed_silence_ledger: { aisstream: { lastMessageAt: now - 3000 * MIN } } },
      feedStats: {
        configured: true,
        isConnected: true,
        timeSinceLastMessage: 25 * MIN,
        uptime: 60 * MIN,
        lastMessageTime: now - 25 * MIN,
      },
    });

    app._checkAISFeedHealth();

    const rows = watchdogRows(app);
    expect(rows[0]).toContain('sinceMessage=25 min');
    expect(rows[0]).not.toContain('spänner över omstart');
  });

  test('trösklarna är OFÖRÄNDRADE: ung socket ⇒ fullt nytt fönster, ingen rad', () => {
    const app = riggWatchdogApp({
      feedStats: {
        configured: true, isConnected: true, timeSinceLastMessage: 45 * MIN, uptime: 5 * MIN, lastMessageTime: Date.now() - 45 * MIN,
      },
    });

    app._checkAISFeedHealth();

    expect(watchdogRows(app)).toHaveLength(0);
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });
});

describe('A7(a): tystnadsbokföringen överlever processomstart', () => {
  test('bokförd lastMessageTime läses av en NY app-instans', () => {
    const store = {};
    const now = Date.now();

    const app1 = riggApp(makeSettings(store));
    app1._noteFeedObservation('aisstream', {
      configured: true, lastMessageTime: now - 5 * MIN,
    }, now);
    expect(store.feed_silence_ledger.aisstream.lastMessageAt).toBe(now - 5 * MIN);

    // "Omstart": ny instans, samma settings-lagring, klienten minns ingenting.
    const app2 = riggApp(makeSettings(store));
    const desc = app2._describeFeedSilence('aisstream', {
      configured: true, timeSinceLastMessage: null, uptime: 2 * MIN, lastMessageTime: null,
    }, now + 60 * MIN);

    expect(desc.fromLedger).toBe(true);
    expect(Math.round(desc.sinceMessageMs / MIN)).toBe(65);
    expect(desc.uptimeMs).toBe(2 * MIN);
  });

  test('bokföringen är monoton — ett äldre värde skriver aldrig över ett nyare', () => {
    const store = {};
    const now = Date.now();
    const app = riggApp(makeSettings(store));

    app._noteFeedObservation('aisstream', { configured: true, lastMessageTime: now }, now);
    app._noteFeedObservation('aisstream', { configured: true, lastMessageTime: now - 60 * MIN }, now);

    expect(app._getFeedSilenceLedger().aisstream.lastMessageAt).toBe(now);
  });

  test('skrivtakten är strypt: andra observationen inom fönstret skriver inte', () => {
    const store = {};
    const now = Date.now();
    const app = riggApp(makeSettings(store));

    app._noteFeedObservation('aisstream', { configured: true, lastMessageTime: now }, now);
    app._noteFeedObservation('aisstream', { configured: true, lastMessageTime: now + MIN }, now + MIN);

    expect(store.feed_silence_ledger.aisstream.lastMessageAt).toBe(now); // inte now+MIN
    // ... men FORCE (strike-vägen) skriver igenom direkt.
    app._persistFeedSilenceLedger(true);
    expect(store.feed_silence_ledger.aisstream.lastMessageAt).toBe(now + MIN);
  });

  test('avkonfigurerad källa nollställer sinceConfigured-klockan', () => {
    const now = Date.now();
    const app = riggApp();
    app._noteFeedObservation('aishub', { configured: true }, now);
    expect(app._getFeedSilenceLedger().aishub.configuredSince).toBe(now);

    app._noteFeedObservation('aishub', { configured: false }, now + 10 * MIN);
    expect(app._getFeedSilenceLedger().aishub.configuredSince).toBeUndefined();

    app._noteFeedObservation('aishub', { configured: true }, now + 20 * MIN);
    expect(app._getFeedSilenceLedger().aishub.configuredSince).toBe(now + 20 * MIN);
  });

  test('skräp i settings kraschar inte loggvägen (stub som svarar samma sak på allt)', () => {
    const app = riggApp({ get: () => 'KEY', on: jest.fn() });
    expect(() => app._describeFeedSilence('aisstream', { uptime: MIN })).not.toThrow();
    expect(app._getFeedSilenceLedger()).toEqual({});
    expect(app.error).not.toHaveBeenCalled();
  });
});

describe('A7(c): strike-räknarna är delade per källa', () => {
  test('per-feed-vägen räknar på _aisstreamWatchdogStrikes, aldrig på legacy-räknaren', () => {
    const settings = makeSettings({ ais_api_key: 'KEY' });
    const app = riggApp(settings);
    app._feedWatchdogStrikes = 7; // legacy-vägens tillstånd
    app.aisClient = {
      isConnected: true,
      getConnectionStats: jest.fn().mockReturnValue({
        timeSinceLastMessage: 30 * 1000,
        uptime: 90 * MIN,
        perFeed: {
          aisstream: {
            configured: true, isConnected: true, timeSinceLastMessage: null, uptime: 25 * MIN, lastMessageTime: null,
          },
          aishub: { configured: false },
        },
      }),
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
      kickAishub: jest.fn(),
    };

    app._checkAISFeedHealth();

    expect(app._aisstreamWatchdogStrikes).toBe(1);
    expect(app._feedWatchdogStrikes).toBe(7); // orörd
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledTimes(1);
  });

  test('legacy-flatvägen räknar fortfarande på _feedWatchdogStrikes', () => {
    const settings = makeSettings({ ais_api_key: 'KEY' });
    const app = riggApp(settings);
    app.aisClient = {
      isConnected: true,
      getConnectionStats: jest.fn().mockReturnValue({ timeSinceLastMessage: 25 * MIN, uptime: 60 * MIN }),
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
    };

    app._checkAISFeedHealth();

    expect(app._feedWatchdogStrikes).toBe(1);
    expect(app._aisstreamWatchdogStrikes).toBeUndefined();
  });

  test('per-feed-backoffen trappar 20 → 40 min på sin EGNA räknare', () => {
    const settings = makeSettings({ ais_api_key: 'KEY' });
    const app = riggApp(settings);
    const feed = (uptimeMin) => ({
      timeSinceLastMessage: 30 * 1000,
      uptime: 90 * MIN,
      perFeed: {
        aisstream: {
          configured: true, isConnected: true, timeSinceLastMessage: null, uptime: uptimeMin * MIN, lastMessageTime: null,
        },
        aishub: { configured: false },
      },
    });
    app.aisClient = {
      isConnected: true,
      getConnectionStats: jest.fn().mockReturnValue(feed(21)),
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
      kickAishub: jest.fn(),
    };

    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledTimes(1);

    app.aisClient.getConnectionStats.mockReturnValue(feed(21));
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledTimes(1); // under 40 min

    app.aisClient.getConnectionStats.mockReturnValue(feed(41));
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledTimes(2);
    expect(app._aisstreamWatchdogStrikes).toBe(2);
  });
});

// =============================================================================
// A13: notisvägens observerbarhet
// =============================================================================
describe('A13: _notifyConnectionIssue säger om notisen gick iväg', () => {
  const riggNotifyApp = ({ withApi = true } = {}) => {
    const app = riggApp();
    app.homey.notifications = withApi
      ? { createNotification: jest.fn().mockResolvedValue(undefined) }
      : undefined;
    return app;
  };

  test('lyckad leverans loggas med nyckel och text', async () => {
    const app = riggNotifyApp();
    await app._notifyConnectionIssue('AIS Tracker: testmeddelande', 'aisstream:silent');

    const rows = app.log.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[AIS_CONNECTION]'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Timeline-notis skickad');
    expect(rows[0]).toContain('aisstream:silent');
    expect(rows[0]).toContain('testmeddelande');
    expect(app.error).not.toHaveBeenCalled();
  });

  test('SVÄLJ-FÄLLAN: saknat notifications-API ⇒ app.error, inte tyst return', async () => {
    const app = riggNotifyApp({ withApi: false });
    await app._notifyConnectionIssue('AIS Tracker: testmeddelande', 'aishub:silent');

    expect(app.error).toHaveBeenCalledTimes(1);
    const row = app.error.mock.calls[0].join(' ');
    expect(row).toContain('kunde INTE skickas');
    expect(row).toContain('aishub:silent');
    // Dedup-stämpeln får INTE sättas: nästa försök ska få gå fram.
    expect(app._connectionIssueNotifiedAt.get('aishub:silent')).toBeUndefined();
  });

  test('dedupad notis lämnar spår (debug), och inget kvitto loggas', async () => {
    const app = riggNotifyApp();
    await app._notifyConnectionIssue('första', 'feeds:silent');
    await app._notifyConnectionIssue('andra inom 24h', 'feeds:silent');

    expect(app.homey.notifications.createNotification).toHaveBeenCalledTimes(1);
    const kvitton = app.log.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('Timeline-notis skickad'));
    expect(kvitton).toHaveLength(1);
    const dedupRows = app.debug.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('dedupad'));
    expect(dedupRows).toHaveLength(1);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('kastande createNotification ⇒ fel loggas, stämpeln rullas tillbaka, inget falskt kvitto', async () => {
    const app = riggNotifyApp();
    app.homey.notifications.createNotification = jest.fn().mockRejectedValue(new Error('nätverksfel'));

    await app._notifyConnectionIssue('AIS Tracker: testmeddelande', 'aisstream:auth');

    expect(app.error).toHaveBeenCalled();
    expect(app._connectionIssueNotifiedAt.get('aisstream:auth')).toBeUndefined();
    const kvitton = app.log.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('Timeline-notis skickad'));
    expect(kvitton).toHaveLength(0);
  });
});

// =============================================================================
// A14: heapUsed/RSS
// =============================================================================
describe('A14: MEMORY_STATS bär processens minne', () => {
  test('raden innehåller heapUsed och rss', () => {
    const app = riggApp();
    app._logProcessMemoryStats();

    const rows = app.debug.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[MEMORY_STATS]'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/heapUsed=\d+\.\d+ MB/);
    expect(rows[0]).toMatch(/rss=\d+\.\d+ MB/);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('kadensen är 10 min — loopens minuttick spammar inte', () => {
    const app = riggApp();
    app._logProcessMemoryStats();
    app._logProcessMemoryStats();
    app._logProcessMemoryStats();

    const rows = app.debug.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[MEMORY_STATS]'));
    expect(rows).toHaveLength(1);

    // 10 minuter senare släpps nästa rad igenom.
    app._processMemoryStatsLoggedAt = Date.now() - 10 * MIN - 1000;
    app._logProcessMemoryStats();
    const rows2 = app.debug.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[MEMORY_STATS]'));
    expect(rows2).toHaveLength(2);
  });
});
