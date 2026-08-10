'use strict';

jest.mock('homey');

const v8 = require('v8');
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
 * KX-3 — A14:s andra halvlek: raden var 100 % död på Homey Pro eftersom
 *        process.memoryUsage() kastar ENOENT (uv_resident_set_memory ⇒ /proc)
 *        i containern. V8-heapen är nu primärkälla, rss är best-effort med
 *        exakt ETT [err] per appstart. OBS: de gamla A14-testerna körde den
 *        ÄKTA process.memoryUsage() och var därför plattformsblinda — de nya
 *        testerna nedan mockar båda källorna explicit.
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
// Fable-granskningen 2026-08-10 (FG-A1/FG-A2): vaktens nollställningsvillkor
// =============================================================================
describe('FG-A1: AISHub-vakten tiger under den AVSIKTLIGA 6h-auth-pausen', () => {
  const riggHubApp = () => {
    const app = riggApp(makeSettings({ ais_api_key: 'KEY' }));
    app.aisClient = {
      isConnected: true,
      kickAishub: jest.fn(),
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
    };
    return app;
  };

  const hubRows = (app) => app.log.mock.calls
    .map((c) => c.join(' '))
    .filter((l) => l.includes('[FEED_WATCHDOG]') && l.includes('aishub:'));

  // Under auth-pausen startas ingen poll ⇒ lastPollStartedAt FRYSER, och
  // klienten räknar sig som frånkopplad. Kedjedöd-grenens tröskel är
  // 2×BACKOFF_MAX_MS + 60 s ≈ 11 min; 45 min är långt bortom den.
  const pausedChain = (extra = {}) => ({
    configured: true,
    isConnected: false,
    lastPollStartedAt: Date.now() - 45 * MIN,
    lastOkResponseAt: Date.now() - 45 * MIN,
    ...extra,
  });

  test('cooldown kvar ⇒ ingen kedjedöd-logg, ingen kick, strikes nollställda', () => {
    const app = riggHubApp();
    app._aishubWatchdogStrikes = 4; // falsk trappa byggd innan fixen

    app._checkAishubFeedHealth(pausedChain({ authCooldownMsLeft: 5.8 * 60 * MIN }));

    expect(hubRows(app)).toHaveLength(0);
    expect(app.aisClient.kickAishub).not.toHaveBeenCalled();
    expect(app._aishubWatchdogStrikes).toBe(0);
  });

  test('samma tick var före fixen 348 rader: pausen släppt (0 kvar) ⇒ vakten ingriper igen', () => {
    const app = riggHubApp();

    app._checkAishubFeedHealth(pausedChain({ authCooldownMsLeft: 0 }));

    const rows = hubRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('kedjan verkar död');
    expect(app.aisClient.kickAishub).toHaveBeenCalledTimes(1);
    expect(app._aishubWatchdogStrikes).toBe(1);
  });

  test('legacy-stub UTAN authCooldownMsLeft ⇒ exakt oförändrat beteende', () => {
    const app = riggHubApp();

    app._checkAishubFeedHealth(pausedChain()); // fältet saknas helt

    expect(hubRows(app)).toHaveLength(1);
    expect(app.aisClient.kickAishub).toHaveBeenCalledTimes(1);
  });

  test('pausen respekteras hela vägen genom _checkAISFeedHealth-dispatchen', () => {
    const app = riggHubApp();
    app._aishubWatchdogStrikes = 3;
    app.aisClient.getConnectionStats = jest.fn().mockReturnValue({
      timeSinceLastMessage: 30 * 1000,
      uptime: 90 * MIN,
      perFeed: {
        aisstream: {
          configured: true,
          isConnected: true,
          timeSinceLastMessage: 30 * 1000,
          uptime: 90 * MIN,
          lastMessageTime: Date.now() - 30 * 1000,
        },
        aishub: pausedChain({ authCooldownMsLeft: 3 * 60 * MIN }),
      },
    });

    app._checkAISFeedHealth();

    expect(hubRows(app)).toHaveLength(0);
    expect(app.aisClient.kickAishub).not.toHaveBeenCalled();
    expect(app._aishubWatchdogStrikes).toBe(0);
  });
});

describe('FG-A2: aisstream-vaktens strikes nollställs vid avkonfigurering', () => {
  const riggStreamApp = () => {
    const app = riggApp(makeSettings({ ais_api_key: 'KEY' }));
    app.aisClient = {
      isConnected: true,
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
    };
    return app;
  };

  test('configured:false ⇒ 0 (källbyte bort och tillbaka ärver inte 120-min-tröskeln)', () => {
    const app = riggStreamApp();
    app._aisstreamWatchdogStrikes = 3;

    app._checkAisstreamFeedHealthPerFeed({ configured: false });

    expect(app._aisstreamWatchdogStrikes).toBe(0);
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });

  test('saknad perFeed-post ⇒ 0 (samma semantik som AISHub-tvillingen)', () => {
    const app = riggStreamApp();
    app._aisstreamWatchdogStrikes = 5;

    app._checkAisstreamFeedHealthPerFeed(undefined);

    expect(app._aisstreamWatchdogStrikes).toBe(0);
  });

  test('NEDKOPPLAD men konfigurerad ⇒ trappan bevaras (klientens backoff äger läget)', () => {
    const app = riggStreamApp();
    app._aisstreamWatchdogStrikes = 3;

    app._checkAisstreamFeedHealthPerFeed({
      configured: true, isConnected: false, timeSinceLastMessage: 90 * MIN, uptime: 90 * MIN,
    });

    expect(app._aisstreamWatchdogStrikes).toBe(3);
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });

  test('efter nollställning startar trappan om på 20 min, inte på 160', () => {
    const app = riggStreamApp();
    app._aisstreamWatchdogStrikes = 3; // gammal backoff: tröskel 160 min → tak 120

    app._checkAisstreamFeedHealthPerFeed({ configured: false });
    // Källan sätts på igen och är tyst i 21 min — precis över basen.
    app._checkAisstreamFeedHealthPerFeed({
      configured: true, isConnected: true, timeSinceLastMessage: null, uptime: 21 * MIN, lastMessageTime: null,
    });

    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledTimes(1);
    expect(app._aisstreamWatchdogStrikes).toBe(1);
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
  // De två testerna här kör den ÄKTA process.memoryUsage()/v8 på dev-/CI-
  // plattformen — ett röktest för att raden alls produceras. De är
  // plattformsberoende och kan per konstruktion inte se Homey Pro-containern;
  // det gör KX-3-sviten längre ned.
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

// =============================================================================
// KX-3 (fältprov 2026-08-09): minnesmätaren på Homey Pro
//
// Fältbevis: 4/4 försök gav `[err] ... ENOENT: no such file or directory,
// uv_resident_set_memory` (10 min isär ⇒ ~144/dygn) och NOLL mätvärden.
// Rotorsak: process.memoryUsage() räknar rss via libuv/proc INNAN V8-fälten
// fylls i ⇒ hela anropet kastar och även heapUsed går förlorad.
// =============================================================================
describe('KX-3: MEMORY_STATS överlever Homey Pro-containern', () => {
  const MB = 1024 * 1024;

  // V8-fixtur med värden som inte kan förväxlas med process.memoryUsage()
  // nedan — så testet bevisar VILKEN källa raden läser ur.
  const heapFixture = () => ({
    used_heap_size: 12 * MB,
    total_heap_size: 20 * MB,
    heap_size_limit: 128 * MB,
    external_memory: 1.5 * MB,
  });

  // Felet Homey Pro faktiskt kastar (fältloggen, rad 87/814/3536/6601).
  const enoentFel = () => Object.assign(
    new Error('ENOENT: no such file or directory, uv_resident_set_memory'),
    { code: 'ENOENT', errno: -2, syscall: 'uv_resident_set_memory' },
  );

  const mätrader = (app) => app.debug.mock.calls
    .map((c) => c.join(' '))
    .filter((l) => l.includes('[MEMORY_STATS] process:'));

  const släppKadensen = (app) => {
    app._processMemoryStatsLoggedAt = Date.now() - 10 * MIN - 1000;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('normalfallet: V8-heapen är källan, rss följer med som best-effort', () => {
    const app = riggApp();
    jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(heapFixture());
    jest.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 42 * MB, heapTotal: 999 * MB, heapUsed: 998 * MB, external: 7 * MB,
    });

    app._logProcessMemoryStats();

    const rader = mätrader(app);
    expect(rader).toHaveLength(1);
    expect(rader[0]).toContain('heapUsed=12.0 MB');
    expect(rader[0]).toContain('heapTotal=20.0 MB');
    expect(rader[0]).toContain('heapLimit=128.0 MB');
    expect(rader[0]).toContain('external=1.5 MB');
    expect(rader[0]).toContain('rss=42.0 MB');
    // Heapen får INTE komma från process.memoryUsage (998/999 = fällan).
    expect(rader[0]).not.toContain('998');
    expect(rader[0]).not.toContain('999');
    expect(app.error).not.toHaveBeenCalled();
  });

  test('ENOENT på rss ⇒ exakt ETT [err] per appstart, heapraden fortsätter', () => {
    const app = riggApp();
    jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(heapFixture());
    const memSpy = jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw enoentFel();
    });

    app._logProcessMemoryStats();
    släppKadensen(app);
    app._logProcessMemoryStats();
    släppKadensen(app);
    app._logProcessMemoryStats();

    // Serien lever: tre mätvärden i stället för fältprovets noll.
    const rader = mätrader(app);
    expect(rader).toHaveLength(3);
    rader.forEach((rad) => {
      expect(rad).toContain('heapUsed=12.0 MB');
      expect(rad).toContain('rss=n/a');
    });

    // Felkanalen: EN rad, med förklaring — inte 144/dygn.
    expect(app.error).toHaveBeenCalledTimes(1);
    const felrad = app.error.mock.calls[0].join(' ');
    expect(felrad).toContain('uv_resident_set_memory');
    expect(felrad).toContain('rss stängs av för den här processen');

    // Permanent avstängning: försöket görs inte om efter första ENOENT.
    expect(memSpy).toHaveBeenCalledTimes(1);
    expect(app._processRssUnavailable).toBe(true);
  });

  test('avstängningen kvarstår för instansen men nollställs vid ny appstart', () => {
    const app = riggApp();
    jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(heapFixture());
    const memSpy = jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw enoentFel();
    });

    app._logProcessMemoryStats();
    expect(memSpy).toHaveBeenCalledTimes(1);

    // 100 kadenser till på samma instans ⇒ inget nytt försök, inget nytt fel.
    for (let i = 0; i < 100; i += 1) {
      släppKadensen(app);
      app._logProcessMemoryStats();
    }
    expect(memSpy).toHaveBeenCalledTimes(1);
    expect(app.error).toHaveBeenCalledTimes(1);
    expect(mätrader(app)).toHaveLength(101);

    // Ny appinstans = ny appstart ⇒ flaggan är borta och försöket görs om
    // (miljön kan ha ändrats mellan starterna).
    const app2 = riggApp();
    app2._logProcessMemoryStats();
    expect(memSpy).toHaveBeenCalledTimes(2);
    expect(app2.error).toHaveBeenCalledTimes(1);
  });

  test('transient fel (ej ENOENT/ENOSYS) loggas EN gång men försöket görs om', () => {
    const app = riggApp();
    jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(heapFixture());
    const memSpy = jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw Object.assign(new Error('EAGAIN: resource temporarily unavailable'), { code: 'EAGAIN' });
    });

    app._logProcessMemoryStats();
    släppKadensen(app);
    app._logProcessMemoryStats();

    expect(memSpy).toHaveBeenCalledTimes(2); // ingen permanent avstängning
    expect(app._processRssUnavailable).toBeFalsy();
    expect(app.error).toHaveBeenCalledTimes(1); // men bara ETT [err]
    expect(app.error.mock.calls[0].join(' ')).toContain('görs om vid nästa kadens');
    const uppföljning = app.debug.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes('rss kunde fortfarande inte läsas'));
    expect(uppföljning).toHaveLength(1);
  });

  test('ENOSYS behandlas som permanent miljöbrist, precis som ENOENT', () => {
    const app = riggApp();
    jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(heapFixture());
    jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw Object.assign(new Error('ENOSYS: function not implemented'), { code: 'ENOSYS' });
    });

    app._logProcessMemoryStats();

    expect(app._processRssUnavailable).toBe(true);
    expect(app.error).toHaveBeenCalledTimes(1);
    expect(mätrader(app)[0]).toContain('rss=n/a');
  });

  test('fel utan .code klassas ändå på meddelandet (reservdetektering)', () => {
    const app = riggApp();
    jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(heapFixture());
    jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory, uv_resident_set_memory');
    });

    app._logProcessMemoryStats();

    expect(app._processRssUnavailable).toBe(true);
    expect(app.error).toHaveBeenCalledTimes(1);
  });

  test('båda källorna döda ⇒ ingen rad, EN förklaring per källa, strupningen håller', () => {
    const app = riggApp();
    jest.spyOn(v8, 'getHeapStatistics').mockImplementation(() => {
      throw new Error('ingen v8');
    });
    jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw enoentFel();
    });

    app._logProcessMemoryStats();
    expect(mätrader(app)).toHaveLength(0);
    // En [err] per källa — tyst död är förbjuden, spam likaså.
    expect(app.error).toHaveBeenCalledTimes(2);
    const fel = app.error.mock.calls.map((c) => c.join(' '));
    expect(fel.some((f) => f.includes('V8:s heapstatistik är inte tillgänglig'))).toBe(true);
    expect(fel.some((f) => f.includes('uv_resident_set_memory'))).toBe(true);

    // Omedelbart nytt anrop (loopen tickar varje minut) ⇒ struppat, inget
    // nytt fel. Stämpeln sätts FÖRE mätningen, just för detta.
    app._logProcessMemoryStats();
    expect(app.error).toHaveBeenCalledTimes(2);

    // Även efter 20 kadenser står felräkningen still.
    for (let i = 0; i < 20; i += 1) {
      släppKadensen(app);
      app._logProcessMemoryStats();
    }
    expect(app.error).toHaveBeenCalledTimes(2);
  });

  test('kadensen är oförändrad 10 min även med mockade källor', () => {
    const app = riggApp();
    jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(heapFixture());
    jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 42 * MB });

    app._logProcessMemoryStats();
    app._logProcessMemoryStats();
    app._logProcessMemoryStats();
    expect(mätrader(app)).toHaveLength(1);

    app._processMemoryStatsLoggedAt = Date.now() - 10 * MIN + 5000; // 9:55 in
    app._logProcessMemoryStats();
    expect(mätrader(app)).toHaveLength(1);

    släppKadensen(app);
    app._logProcessMemoryStats();
    expect(mätrader(app)).toHaveLength(2);
  });
});
