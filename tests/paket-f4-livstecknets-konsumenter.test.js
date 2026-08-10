'use strict';

jest.mock('homey');

/**
 * PAKET F4 — LIVSTECKNETS KONSUMENTER (adversariell granskning 2026-08-10)
 *
 * BX-1 (söndagsfältet 2026-08-09) införde livstecknet: en dedupad AISHub-post
 * med färsk fix bevisar att källan fortfarande rapporterar fartyget, och
 * laddar om livsklockan. Åtta granskarfynd visade att signalen läckt ut ur
 * sin egen domän. Sviten låser fyra rättelser:
 *
 *  (1) KLOCKDOMÄNERNA. `_lastSeen` är en LIVSLÄNGDSKLOCKA — den stämplas av
 *      livstecknet, som bär NOLL position. Den låg ändå i exit-fallbackens
 *      max-uttryck (app.js) och kunde göra en 28 minuter gammal position
 *      "23 minuter gammal" ⇒ F63/CLABBYDOO-notisen som grinden infördes för
 *      att stoppa. Positionsgrindar läser numera `_lastConfirmedPositionMs`.
 *
 *  (2) OMLADDNINGSVÄRDET. `_cleanupTimeoutMs` cachade det värde som
 *      PASSAGE_PROTECTION/GRACE_PROTECTION redan MUTERAT — ett stängt
 *      passagefönster (300 s) ratchetades in som fartygets permanenta
 *      livslängd. Nu cachas BASNIVÅN (anroparens närhetstimeout) och
 *      omladdningen är max(kvarvarande, basnivå): kan förlänga, aldrig korta.
 *      Elimination-grenen (100 ms, forceElimination) är strukturellt onåbar
 *      från ett livstecken.
 *
 *  (3) ORPHAN-SVEPET städade cleanupTimers men lämnade kvar `_cleanupTimeoutMs`
 *      och `_cleanupExpiryTimes` — ett återvändande mmsi kunde ärva en
 *      livslängd ur en HELT annan episod (fältlist-fällans klass).
 *
 *  (4) FÄRSKHETSFÖNSTRET var symmetriskt (`|now − fixTs| < 365 s`) trots att
 *      härledningen är ensidig: en FRUSEN framtidsdaterad post fick nästan
 *      dubbel livstid. Nu ensidigt bakåt med klockskevstak framåt (120 s).
 */

const AISBridgeApp = require('../app');
const AISHubClient = require('../lib/connection/AISHubClient');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const {
  AIS_CONFIG, TIMEOUT_SETTINGS, UI_CONSTANTS, TRIGGER_POINTS,
} = require('../lib/constants');

const HUB = AIS_CONFIG.AISHUB;

function makeLogger() {
  return {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };
}

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

function okSweepBody(records = []) {
  return JSON.stringify([
    {
      ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: records.length,
    },
    records,
  ]);
}

/** TIME-fält i AISHubs HUMAN-format för ett givet epoch-ms. */
function timeField(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
}

function quayRecord(fixMs, overrides = {}) {
  return {
    MMSI: 265552100,
    TIME: timeField(fixMs),
    LATITUDE: 58.2790,
    LONGITUDE: 12.2790,
    COG: 0,
    SOG: 0,
    NAVSTAT: 5,
    NAME: 'VIRGO',
    ...overrides,
  };
}

// ===========================================================================
// (1) POSITIONSGRINDAR LÄSER POSITIONSKLOCKAN
// ===========================================================================
describe('F4(1): exit-fallbackens 25-minutersport mäter POSITIONENS ålder', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    return app;
  };

  // Utgående sydfarare ~330 m norr om Kanalinfarten, i aktiv transit —
  // allt utom åldern är uppfyllt, så grinden är det enda som kan fälla.
  const exitSnapshot = (overrides = {}) => ({
    mmsi: '265999042',
    name: 'CLABBYDOO-KLASSEN',
    lat: TRIGGER_POINTS.kanalinfarten.lat + 330 / 111320,
    lon: TRIGGER_POINTS.kanalinfarten.lon,
    sog: 5.0,
    cog: 200,
    passedBridges: ['Olidebron'],
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _lastSeen: Date.now(),
    _moored: false,
    _hasMovementProof: true,
    ...overrides,
  });

  test('KÄRNAN: färskt livstecken kan INTE tvätta en 28 min gammal position', async () => {
    const app = makeApp();
    const now = Date.now();
    await app._triggerExitPointFallback(exitSnapshot({
      // Sista RIKTIGA fix 28 min gammal — bortom 25-minutersporten.
      timestamp: now - 28 * 60 * 1000,
      lastPositionUpdate: now - 28 * 60 * 1000,
      // AISHub cachade posten; livstecknet stämplade _lastSeen för 30 s sedan.
      // Med det gamla max-uttrycket blev "åldern" 30 s och notisen avfyrades.
      _lastSeen: now - 30 * 1000,
    }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('EXIT_TRIGGER_STALE'));
  });

  test('GRÄNSEN HÅLLER ÅT ANDRA HÅLLET: färsk position ⇒ notisen avfyras', async () => {
    const app = makeApp();
    const now = Date.now();
    await app._triggerExitPointFallback(exitSnapshot({
      timestamp: now - 3 * 60 * 1000,
      lastPositionUpdate: now - 3 * 60 * 1000,
      _lastSeen: now - 3 * 60 * 1000,
    }));
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledWith(
      expect.objectContaining({ mmsi: '265999042' }), 'Kanalinfarten',
      expect.objectContaining({ detectionTs: expect.any(Number) }),
    );
  });

  test('lastPositionUpdate får fortfarande bära färskheten (F4-E-klockan intakt)', async () => {
    const app = makeApp();
    const now = Date.now();
    // Väntande båt: timestamp saknas i snapshotten men positionen är bekräftad.
    await app._triggerExitPointFallback(exitSnapshot({
      timestamp: undefined,
      lastPositionUpdate: now - 60 * 1000,
      _lastSeen: now,
    }));
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalled();
  });

  test('MUTATIONSVAKT: _lastSeen ensam räcker inte — utan positionsklocka ⇒ skip', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback(exitSnapshot({
      timestamp: undefined,
      lastPositionUpdate: undefined,
      _lastSeen: Date.now(),
    }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('unknown age'));
  });
});

describe('F4(1): boat_near-vägens stale-grind läser samma klocka', () => {
  // _triggerBoatNearFlow kortsluter i test-läge — stäng av det här (samma
  // teknik som replay-harnessen och RC-S3-sviten) så gaten faktiskt nås.
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;
  });
  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = true;
  });

  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._boatNearTrigger = {};
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app.proximityService = {
      analyzeVesselProximity: jest.fn().mockReturnValue({
        nearestBridge: 'Klaffbron', nearestDistance: 800, bridges: [],
      }),
    };
    return app;
  }

  test('gammal position + färskt livstecken ⇒ FLOW_TRIGGER_STALE (cachen öppnar ingen notisgrind)', async () => {
    const app = makeApp();
    const now = Date.now();
    await app._triggerBoatNearFlow({
      mmsi: '219028819',
      sog: 4.5,
      _hasMovementProof: true,
      _moored: false,
      lat: 58.29,
      lon: 12.29,
      targetBridge: null,
      status: 'en-route',
      timestamp: now - (UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS + 60 * 1000),
      lastPositionUpdate: now - (UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS + 60 * 1000),
      _lastSeen: now,
    });
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('FLOW_TRIGGER_STALE'));
  });

  test('REGRESSIONSVAKT: väntande båt med färskt sampel men frusen position släpps igenom', async () => {
    const app = makeApp();
    const now = Date.now();
    await app._triggerBoatNearFlow({
      mmsi: '219028819',
      sog: 0.2,
      _hasMovementProof: true,
      _moored: false,
      lat: 58.29,
      lon: 12.29,
      targetBridge: 'Klaffbron',
      status: 'waiting',
      timestamp: now - 30 * 1000, // sänder var ~3:e min
      lastPositionUpdate: now - 45 * 60 * 1000, // positionen har stått stilla i kön
      _lastSeen: now,
    });
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('FLOW_TRIGGER_STALE'));
    expect(app.error).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// (2) OMLADDNINGSVÄRDET: BASNIVÅ, INTE ENGÅNGSSKYDD
// ===========================================================================
describe('F4(2): _cleanupTimeoutMs bär BASNIVÅN — engångsskydd ratchetas inte in', () => {
  let svc;
  const MMSI = '265552100';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:41.000Z'));
    svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  function seed(extra = {}) {
    const now = Date.now();
    svc.vessels.set(MMSI, {
      mmsi: MMSI,
      lat: 58.2790,
      lon: 12.2790,
      sog: 0,
      status: 'en-route',
      timestamp: now,
      lastPositionUpdate: now,
      ...extra,
    });
    return svc.vessels.get(MMSI);
  }

  test('PASSAGE_PROTECTION förlänger TIMERN men skriver inte BASNIVÅN', () => {
    const vessel = seed({ lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() });
    svc.passageWindowManager.shouldShowRecentlyPassed = () => true;
    svc.passageWindowManager.getDisplayWindow = () => 300000; // 5 min

    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.FAR_DISTANCE); // närhetsnivån: 120 s

    // Timern bär skyddet …
    expect(svc._cleanupExpiryTimes.get(MMSI)).toBe(Date.now() + 305000);
    // … men det cachade omladdningsvärdet är BASNIVÅN.
    expect(svc._cleanupTimeoutMs.get(MMSI)).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
    expect(vessel).toBeDefined();
  });

  test('KÄRNAN: när passagefönstret stängt laddar livstecknet om 120 s — inte 305 s', () => {
    seed({ lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() });
    svc.passageWindowManager.shouldShowRecentlyPassed = () => true;
    svc.passageWindowManager.getDisplayWindow = () => 300000;
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.FAR_DISTANCE);

    // Fönstret stänger; 250 s senare återstår 55 s av det gamla skyddet.
    svc.passageWindowManager.shouldShowRecentlyPassed = () => false;
    svc.passageWindowManager.isWithinInternalGracePeriod = () => false;
    jest.advanceTimersByTime(250 * 1000);

    expect(svc.noteVesselSeen(MMSI)).toBe(true);
    // Före fixen: 305 s (det muterade värdet). Nu: närhetsnivån.
    expect(svc._cleanupExpiryTimes.get(MMSI)).toBe(Date.now() + TIMEOUT_SETTINGS.FAR_DISTANCE);
    // Och omladdningen blev inte sin egen nya basnivå.
    expect(svc._cleanupTimeoutMs.get(MMSI)).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
  });

  test('RATCHETEN DÖR UT: efter 10 livstecken lever fartyget 120 s, inte 305 s, efter sista', () => {
    seed({ lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() });
    svc.passageWindowManager.shouldShowRecentlyPassed = () => true;
    svc.passageWindowManager.getDisplayWindow = () => 300000;
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.FAR_DISTANCE);
    svc.passageWindowManager.shouldShowRecentlyPassed = () => false;
    svc.passageWindowManager.isWithinInternalGracePeriod = () => false;

    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(65 * 1000);
      svc.noteVesselSeen(MMSI);
    }
    expect(svc.vessels.has(MMSI)).toBe(true);
    // Källan tystnar: kvar är exakt basnivån, inte det gamla skyddet.
    jest.advanceTimersByTime(TIMEOUT_SETTINGS.FAR_DISTANCE + 10);
    expect(svc.vessels.has(MMSI)).toBe(false);
  });

  test('GRACE_PROTECTION behandlas likadant (samma engångsklass)', () => {
    seed({ lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() });
    svc.passageWindowManager.shouldShowRecentlyPassed = () => false;
    svc.passageWindowManager.isWithinInternalGracePeriod = () => true;
    svc.passageWindowManager.getInternalGracePeriod = () => 240000; // 4 min

    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.FAR_DISTANCE);
    expect(svc._cleanupExpiryTimes.get(MMSI)).toBe(Date.now() + 242000);
    expect(svc._cleanupTimeoutMs.get(MMSI)).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
  });

  test('vanlig schemaläggning (utan skydd) cachar precis det anroparen bad om', () => {
    seed();
    svc.passageWindowManager.shouldShowRecentlyPassed = () => false;
    svc.passageWindowManager.isWithinInternalGracePeriod = () => false;
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    expect(svc._cleanupTimeoutMs.get(MMSI)).toBe(TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
  });
});

describe('F4(2): kontraktet "kan bara skjuta upp döden, aldrig korta ett liv"', () => {
  let svc;
  const MMSI = '265552100';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:41.000Z'));
    svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
    svc.passageWindowManager.shouldShowRecentlyPassed = () => false;
    svc.passageWindowManager.isWithinInternalGracePeriod = () => false;
    const now = Date.now();
    svc.vessels.set(MMSI, {
      mmsi: MMSI, lat: 58.2790, lon: 12.2790, sog: 0, status: 'en-route', timestamp: now, lastPositionUpdate: now,
    });
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  test('RIKTNING A (förlänger): utrinnande timer laddas om till basnivån', () => {
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.FAR_DISTANCE);
    jest.advanceTimersByTime(110 * 1000); // 10 s kvar
    expect(svc.noteVesselSeen(MMSI)).toBe(true);
    expect(svc._cleanupExpiryTimes.get(MMSI)).toBe(Date.now() + TIMEOUT_SETTINGS.FAR_DISTANCE);
  });

  test('RIKTNING B (kortar aldrig): 30 min kvar + 2 min basnivå ⇒ utgången rörs inte', () => {
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN); // 30 min, bas
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.FAR_DISTANCE); // vägras av BUG 6-guarden
    // Basnivån är fortfarande 30 min (den korta schemaläggningen nådde aldrig
    // fram) — och kvarvarande-ledet skyddar oavsett.
    const expiryBefore = svc._cleanupExpiryTimes.get(MMSI);
    jest.advanceTimersByTime(60 * 1000);
    expect(svc.noteVesselSeen(MMSI)).toBe(true);
    expect(svc._cleanupExpiryTimes.get(MMSI)).toBeGreaterThanOrEqual(expiryBefore);
    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(svc.vessels.has(MMSI)).toBe(true);
  });

  test('KONTRAKTET VID KÄLLAN: livstecknet BER aldrig om mindre tid än det som återstår', () => {
    // Fyndets kärna var att noteVesselSeen DELEGERADE hela skyddet till
    // scheduleCleanup ("den äger alla skydd") — men scheduleCleanups första
    // gren kan sätta 100 ms med forceElimination, som medvetet kringgår
    // anti-förkortningen. Kontraktet måste därför gälla redan i det som
    // BEGÄRS, inte bara i det som beviljas. Testet mäter argumentet.
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    svc._cleanupTimeoutMs.set(MMSI, TIMEOUT_SETTINGS.FAR_DISTANCE); // gammal låg nivå
    jest.advanceTimersByTime(60 * 1000);
    const remainingMs = svc._cleanupExpiryTimes.get(MMSI) - Date.now();

    const spy = jest.spyOn(svc, 'scheduleCleanup');
    svc.noteVesselSeen(MMSI);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, askedMs, options] = spy.mock.calls[0];
    expect(askedMs).toBeGreaterThanOrEqual(remainingMs);
    // … och begäran får inte bli fartygets nya basnivå.
    expect(options).toEqual({ oneShot: true });
    spy.mockRestore();
  });

  test('RIKTNING B, direkt bevis: låg basnivå kan inte sänka en lång pågående timer', () => {
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    const expiryBefore = svc._cleanupExpiryTimes.get(MMSI);
    // Plantera en LÅG basnivå direkt i kartan (det tillstånd fyndet beskriver:
    // ett gammalt närhetsvärde som inte längre motsvarar timern).
    svc._cleanupTimeoutMs.set(MMSI, TIMEOUT_SETTINGS.FAR_DISTANCE);
    jest.advanceTimersByTime(60 * 1000);
    svc.noteVesselSeen(MMSI);
    expect(svc._cleanupExpiryTimes.get(MMSI)).toBe(expiryBefore);
  });

  test('100 ms-AVRÄTTNINGEN ÄR OMÖJLIG FRÅN ETT LIVSTECKEN (fyndets kärna)', () => {
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    const expiryBefore = svc._cleanupExpiryTimes.get(MMSI);
    // Predikatet blir sant (exakt det scenario fyndet varnar för: någon gör
    // shouldEliminateVessel tidsberoende, t.ex. "passerad + N s").
    svc.vesselLifecycleManager.shouldEliminateVessel = () => true;

    expect(svc.noteVesselSeen(MMSI)).toBe(false);
    // Ingen 100 ms-timer, ingen elimination-pending, ingen förkortning.
    expect(svc._cleanupExpiryTimes.get(MMSI)).toBe(expiryBefore);
    expect(svc._eliminationPending && svc._eliminationPending.has(MMSI)).toBeFalsy();
    // Livstecknet stämplar ändå livslängdsklockan (diagnostiken bevaras).
    expect(svc.vessels.get(MMSI)._lastSeen).toBe(Date.now());
    jest.advanceTimersByTime(1000);
    expect(svc.vessels.has(MMSI)).toBe(true);
  });

  test('SVEPET ÖVER ALLA BASNIVÅER: ingen omladdning kortar utgången', () => {
    const levels = [
      TIMEOUT_SETTINGS.FAR_DISTANCE,
      TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN,
      60000,
      600000,
    ];
    for (const level of levels) {
      svc._clearCleanupTimer(MMSI);
      svc.scheduleCleanup(MMSI, level);
      const before = svc._cleanupExpiryTimes.get(MMSI);
      jest.advanceTimersByTime(1000);
      svc.noteVesselSeen(MMSI);
      expect(svc._cleanupExpiryTimes.get(MMSI)).toBeGreaterThanOrEqual(before);
    }
  });
});

describe('F4(2): protection-zonens 10 min är UPPSKOV, inte livslängdsnivå', () => {
  let svc;
  const MMSI = '265552111';
  const KLAFF = { lat: 58.28409551543077, lon: 12.283929525245636 };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:41.000Z'));
    svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
    svc.passageWindowManager.shouldShowRecentlyPassed = () => false;
    svc.passageWindowManager.isWithinInternalGracePeriod = () => false;
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  test('uppskovet skriver inte basnivån — men basnivån ÖVERLEVER uppskovet', () => {
    const now = Date.now();
    svc.vessels.set(MMSI, {
      mmsi: MMSI,
      lat: KLAFF.lat + 0.0005, // ~55 m — inne i 300 m-zonen
      lon: KLAFF.lon,
      sog: 0.1,
      status: 'waiting',
      targetBridge: 'Klaffbron',
      passedBridges: [],
      timestamp: now,
      lastPositionUpdate: now,
    });
    svc.scheduleCleanup(MMSI, TIMEOUT_SETTINGS.FAR_DISTANCE);
    expect(svc._cleanupTimeoutMs.get(MMSI)).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);

    // Timern brinner: protection-zonen skjuter upp raderingen 10 min.
    // (Uppskovet räknas från det ögonblick timern brann, inte från "nu".)
    const firedAt = now + TIMEOUT_SETTINGS.FAR_DISTANCE;
    jest.advanceTimersByTime(TIMEOUT_SETTINGS.FAR_DISTANCE + 10);
    expect(svc.vessels.has(MMSI)).toBe(true);
    expect(svc._cleanupExpiryTimes.get(MMSI)).toBe(firedAt + UI_CONSTANTS.CLEANUP_EXTENSION_MS);
    // Uppskovet blev INTE omladdningsnivå …
    expect(svc._cleanupTimeoutMs.get(MMSI)).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);

    // … och ett livstecken kan därför inte hålla fartyget vid liv i 10 min-steg:
    // 9 min in i uppskovet laddar det om till BASNIVÅN (120 s), inte till en ny
    // tiominutersperiod. Det är skillnaden mellan "källan ser fartyget" och
    // "systemet sköt upp en radering".
    jest.advanceTimersByTime(9 * 60 * 1000);
    expect(svc.noteVesselSeen(MMSI)).toBe(true);
    expect(svc._cleanupExpiryTimes.get(MMSI)).toBe(Date.now() + TIMEOUT_SETTINGS.FAR_DISTANCE);
    expect(svc._cleanupExpiryTimes.get(MMSI))
      .toBeLessThan(Date.now() + UI_CONSTANTS.CLEANUP_EXTENSION_MS);
    expect(svc._cleanupTimeoutMs.get(MMSI)).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
  });
});

// ===========================================================================
// (3) ORPHAN-SVEPET STÄDAR BÅDA SYSKONKARTORNA
// ===========================================================================
describe('F4(3): _performOrphanedResourceCleanup städar timerns syskonkartor', () => {
  let svc;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:41.000Z'));
    svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
    svc.passageWindowManager.shouldShowRecentlyPassed = () => false;
    svc.passageWindowManager.isWithinInternalGracePeriod = () => false;
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  test('föräldralösa poster i _cleanupTimeoutMs/_cleanupExpiryTimes raderas', () => {
    svc._cleanupTimeoutMs.set('999999999', TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    svc._cleanupExpiryTimes.set('999999999', Date.now() + 60000);
    svc._performOrphanedResourceCleanup();
    expect(svc._cleanupTimeoutMs.has('999999999')).toBe(false);
    expect(svc._cleanupExpiryTimes.has('999999999')).toBe(false);
  });

  test('poster för LEVANDE fartyg rörs inte', () => {
    const now = Date.now();
    svc.vessels.set('265552100', {
      mmsi: '265552100', lat: 58.279, lon: 12.279, timestamp: now, lastPositionUpdate: now,
    });
    svc.scheduleCleanup('265552100', TIMEOUT_SETTINGS.FAR_DISTANCE);
    svc._performOrphanedResourceCleanup();
    expect(svc._cleanupTimeoutMs.get('265552100')).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
    expect(svc._cleanupExpiryTimes.has('265552100')).toBe(true);
  });

  test('ett återvändande mmsi kan inte ärva livslängd ur en FÖRRA episod', () => {
    // Episod 1: aktiv resa, 30 min. Timern blir föräldralös (fartyget borta).
    svc._cleanupTimeoutMs.set('265552100', TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    svc._performOrphanedResourceCleanup();

    // Episod 2: samma mmsi kommer tillbaka, livstecknet hinner före första
    // riktiga samplets scheduleCleanup.
    const now = Date.now();
    svc.vessels.set('265552100', {
      mmsi: '265552100', lat: 58.279, lon: 12.279, timestamp: now, lastPositionUpdate: now,
    });
    expect(svc.noteVesselSeen('265552100')).toBe(false); // ingen nivå att ärva
    expect(svc.cleanupTimers.has('265552100')).toBe(false);
  });
});

// ===========================================================================
// (4) ENSIDIGT FÄRSKHETSFÖNSTER MED KLOCKSKEVSTAK
// ===========================================================================
describe('F4(4): livstecknets åldersfönster är ensidigt bakåt', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /**
   * Kör två pollar där posten är IDENTISK (dedupas i poll 2) och returnerar
   * antalet livstecken. `fixOffsetMs` är fixens läge relativt poll 1:s nu
   * (negativt = bakåt i tiden, positivt = framtidsdaterad).
   *
   * VIKTIGT för avläsningen: åldersvillkoret prövas i POLL 2, ~65 s senare
   * (POLL_INTERVAL_MS, jitter mockad till 0). En post som ligger +150 s fram
   * vid poll 1 är alltså -85 s "fram" när den dedupas — därför ligger
   * offseten i testerna nedan systematiskt 65 s högre än den effektiva.
   */
  async function seenCountForOffset(fixOffsetMs) {
    const fixMs = Date.now() + fixOffsetMs;
    client = new AISHubClient(makeLogger(), makeStore());
    client._httpGet = jest.fn(async () => ({ statusCode: 200, body: okSweepBody([quayRecord(fixMs)]) }));
    const seen = [];
    client.on('vessel:seen', (p) => seen.push(p));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(5 * 1000);
    await jest.advanceTimersByTimeAsync(70 * 1000); // poll 2 → dedup
    return seen.length;
  }

  test('KÄRNAN: FRUSEN post 300 s FRAM i tiden ger INGET livstecken', async () => {
    // Med det symmetriska |now − fixTs| < 365 s låg den innanför fönstret
    // ända till now₀ + 665 s — nästan dubbla den avsedda livstiden.
    expect(await seenCountForOffset(+300 * 1000)).toBe(0);
  });

  test('KLOCKSKEVEN BEHÅLLS: 85 s framtidsdaterad vid dedup är fortfarande ett livstecken', async () => {
    // +150 s vid poll 1 ⇒ -85 s vid dedup: inom FIX_AGE_CLOCK_SKEW_MARGIN_MS
    // (120 s) — ren klockdrift mellan hubbens TIME och appens klocka.
    expect(await seenCountForOffset(+150 * 1000)).toBe(1);
  });

  test('framtidstaket ligger på skevmarginalen, inte på hela fönstret', async () => {
    expect(HUB.SEEN_MAX_FUTURE_SKEW_MS).toBe(120000);
    expect(HUB.SEEN_MAX_FUTURE_SKEW_MS).toBeLessThan(HUB.SEEN_MAX_FIX_AGE_MS);
    // +210 s vid poll 1 ⇒ -145 s vid dedup: bortom taket ⇒ tyst.
    // Det symmetriska fönstret släppte igenom ända till -365 s.
    expect(await seenCountForOffset(+210 * 1000)).toBe(0);
  });

  test('BAKÅTGRÄNSEN OFÖRÄNDRAD: 200 s gammal fix ⇒ livstecken', async () => {
    // Poll 2 ligger ~70 s senare ⇒ ~270 s < 365 s.
    expect(await seenCountForOffset(-200 * 1000)).toBe(1);
  });

  test('BAKÅTGRÄNSEN OFÖRÄNDRAD: 400 s gammal fix ⇒ inget livstecken', async () => {
    expect(await seenCountForOffset(-400 * 1000)).toBe(0);
  });
});
