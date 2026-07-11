'use strict';

jest.mock('homey');

/**
 * ChatGPT-granskning 2 (2026-07-11, mot 0a3b1df) — 20 externa fynd (CG2-1…20)
 * verifierade av 13 Opus 4.8 max-granskare; 9 produktfixar + 3 testinfra.
 * Denna svit låser produktfixarna:
 *
 *   CG2-1: stationär-jitter-gaten i detectBridgePassage — båda samplen FINIT
 *     sog < 0,3 kn + < 60 m rörelse ⇒ ingen passage (Class B-multipath på
 *     motsatt brolinjesida klassades som passage av METHOD 2, conf 0.92).
 *     sog=null lämnar gaten INAKTIV (fartgivarlös-familjen skyddad).
 *   CG2-2: entered-gaten utökad med trigger-punkterna (targetBridge ||
 *     nära Kanalinfarten) — mållös förstakontakt i punktens 300 m-zon
 *     skippades annars permanent (systerkanal-miss från 2026-07-03).
 *     MEDVETET utan currentBridge: den breda varianten fälldes av
 *     facit-fällan (SISU@Stridsbergsbron, 21h — proximity-notisen förekom
 *     gap-fallbacken och bytte riktningstoken northbound→unknown).
 *   CG2-4: _publishUpdate-vakten är GLOBAL (inte per-bridgeKey) och
 *     rerun-kollen läser hela setten — vid 1→0-övergången interleavade
 *     annars 'Klaffbron'- och 'global'-passen och det äldre skrev
 *     token/alarm EFTER det nyare (watchdog-osynligt stale-läge).
 *   CG2-6: available-återhämtningen kräver att ALLA obligatoriska
 *     capabilities finns — en lyckad alarm_generic-skrivning klarerade
 *     annars en enhet vars bridge_text-migrering misslyckats.
 *   CG2-7: _getEffectiveSpeed skiljer SAKNAD fart (sog=null → ETA okänd)
 *     från RAPPORTERAD stillhet (sog=0 → golvet kvar, designat korrekt) —
 *     null→0→0,5 kn-golvet fabricerade ~68-min-ETA för rörlig fartgivarlös.
 *   CG2-10: _pruneDedupCaches prunar persistent-posterna FÖRE
 *     sessionsnycklarna — omvänd ordning lämnade ett 60 s orphan-fönster
 *     (nyckel utan post) som DIVR2-4-spegeln inte kan täcka (den kräver
 *     postens tidsstämpel). Fartgivarlös återfödd i fönstret = permanent
 *     notisblock.
 *   CG2-12: _initGlobalToken bounded (hängande createToken stallade hela
 *     onInit före AIS-anslutningen) + lat token-återskapning i
 *     _setGlobalTokenSafe (transient init-fel lämnade annars token död
 *     till omstart), rate-limitad 60 s.
 *   CG2-15: bridge_text-dedupen jämför STRÄNGEN utöver 32-bitshashen
 *     (1197 äkta kollisionsbuckets i textrymden) — OR-term som bara kan
 *     lägga till skrivningar; null-sentinelens tvångsomskrivning bevarad.
 *   CG2-17: SystemCoordinator.destroy() + med i onUninit-kedjan.
 *
 * Avskrivna (dokumenterade i docs/chatgpt2-granskningen-2026-07-11.md):
 * CG2-3 (accepterad exponering), CG2-5/8/9/13/14 (designval),
 * CG2-11/16 (motbevisade med repro).
 */

const AISBridgeApp = require('../app');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const geometry = require('../lib/utils/geometry');
const { BRIDGES, TRIGGER_POINTS, BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

global.__TEST_MODE__ = true;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

const flushMicrotasks = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

const riggApp = () => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  return app;
};

// =============================================================================
// CG2-10: prune-ordningen (persistent-post FÖRE sessionsnyckel)
// =============================================================================
describe('CG2-10: _pruneDedupCaches prunar post och orphan-nyckel i SAMMA tick', () => {
  const KEY = '265001001:Klaffbron';

  const riggPruneApp = (postAgeMs, vesselActive) => {
    const app = riggApp();
    app.vesselDataService = {
      getAllVessels: () => (vesselActive ? [{ mmsi: '265001001' }] : []),
    };
    app._triggeredBoatNearKeys = new Set([KEY]);
    app._persistentRecentTriggers = new Map(
      postAgeMs === null ? [] : [[KEY, { t: Date.now() - postAgeMs, dir: 'north' }]],
    );
    app._persistRecentTriggers = jest.fn();
    return app;
  };

  test('utgången post + frånvarande båt ⇒ BÅDA borta efter EN prune-cykel (orphan-fönstret stängt)', () => {
    const app = riggPruneApp(3 * 60 * 60 * 1000, false); // 3h gammal post
    app._pruneDedupCaches();
    expect(app._persistentRecentTriggers.size).toBe(0);
    expect(app._triggeredBoatNearKeys.size).toBe(0); // nyckeln följde med direkt
  });

  test('färsk post + frånvarande båt ⇒ nyckeln BEHÅLLS (BUG7-bevarandet intakt)', () => {
    const app = riggPruneApp(30 * 60 * 1000, false); // 30 min gammal post
    app._pruneDedupCaches();
    expect(app._persistentRecentTriggers.size).toBe(1);
    expect(app._triggeredBoatNearKeys.has(KEY)).toBe(true);
  });

  test('aktiv båt ⇒ sessionsnyckeln behålls även utan persistent-post', () => {
    const app = riggPruneApp(null, true); // ingen post, båten aktiv
    app._pruneDedupCaches();
    expect(app._triggeredBoatNearKeys.has(KEY)).toBe(true);
  });
});

// =============================================================================
// CG2-15: strängjämförelse utöver hashen i bridge_text-dedupen
// =============================================================================
describe('CG2-15: hash-kollision tappar inte textövergång', () => {
  let app;
  const NEW_TEXT = 'Två båtar på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter';
  const OLD_TEXT = 'En båt på väg mot Klaffbron, beräknad broöppning om 16 minuter';

  const makeSnapshot = (vessels) => ({
    vesselCount: vessels.length,
    relevantVessels: vessels,
    vesselsBeingRemoved: new Set(),
  });

  beforeEach(() => {
    app = riggApp();
    app._isConnected = true;
    app._lastConnectionLost = null;
    app._updateDeviceCapability = jest.fn();
    app._globalBridgeTextToken = null;
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app.bridgeTextService = { generateBridgeText: jest.fn(() => NEW_TEXT) };
    app._validateBridgeTextSummary = jest.fn(() => ({ isValid: true }));
  });

  const bridgeTextWrites = () => app._updateDeviceCapability.mock.calls
    .filter((c) => c[0] === 'bridge_text');

  test('simulerad kollision (hash lika, sträng olik) ⇒ skrivningen sker ändå', async () => {
    app._lastBridgeText = OLD_TEXT;
    app._lastBridgeTextHash = app._hashString(NEW_TEXT); // kollisionen: gamla "hashar" som nya
    await app._processUIUpdate(makeSnapshot([{ mmsi: '1', targetBridge: 'Stridsbergsbron' }]));
    expect(bridgeTextWrites().some((c) => c[1] === NEW_TEXT)).toBe(true);
  });

  test('identisk text + identisk hash ⇒ dedupen håller (ingen skrivstorm-regression)', async () => {
    app._lastBridgeText = NEW_TEXT;
    app._lastBridgeTextHash = app._hashString(NEW_TEXT);
    app._lastBridgeTextUpdate = Date.now(); // inom 60 s-fönstret — ingen force
    await app._processUIUpdate(makeSnapshot([{ mmsi: '1', targetBridge: 'Stridsbergsbron' }]));
    expect(bridgeTextWrites().length).toBe(0);
  });

  test('null-sentinelen (hash=null, sträng oförändrad) tvingar fortfarande omskrivning', async () => {
    app._lastBridgeText = NEW_TEXT;
    app._lastBridgeTextHash = null; // felsentinel efter timeout/misslyckad skrivning
    await app._processUIUpdate(makeSnapshot([{ mmsi: '1', targetBridge: 'Stridsbergsbron' }]));
    expect(bridgeTextWrites().some((c) => c[1] === NEW_TEXT)).toBe(true);
  });
});

// =============================================================================
// CG2-4: global publiceringsserialisering
// =============================================================================
describe('CG2-4: _publishUpdate serialiserar GLOBALT över bridgeKeys', () => {
  let app;

  beforeEach(() => {
    app = riggApp();
    app._inFlightUpdates = new Set();
    app._rerunNeeded = new Set();
    app._updateVersion = 1;
  });

  test('pass med ANNAN bridgeKey blockeras under in-flight och täcks av rerun', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    app._actuallyUpdateUI = jest.fn(() => gate);
    app._determineBridgeKey = jest.fn(() => 'global');

    const p1 = app._publishUpdate(1, 'Klaffbron', ['test']); // pass 1 hänger i skrivfasen
    await flushMicrotasks(2);
    expect(app._inFlightUpdates.size).toBe(1);

    app._updateVersion = 2;
    await app._publishUpdate(2, 'global', ['test']); // nyare pass, ANNAN nyckel
    expect(app._actuallyUpdateUI).toHaveBeenCalledTimes(1); // blockerad — ingen interleaving
    expect(app._rerunNeeded.size).toBe(1);

    release();
    await p1;
    await new Promise((resolve) => {
      setImmediate(resolve);
    }); // rerun via setImmediate
    expect(app._actuallyUpdateUI).toHaveBeenCalledTimes(2); // det blockerade passets innehåll publicerades
    expect(app._rerunNeeded.size).toBe(0);
  });

  test('samma bridgeKey blockeras precis som tidigare (ingen regression)', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    app._actuallyUpdateUI = jest.fn(() => gate);
    app._determineBridgeKey = jest.fn(() => 'Klaffbron');

    const p1 = app._publishUpdate(1, 'Klaffbron', ['test']);
    await flushMicrotasks(2);
    await app._publishUpdate(1, 'Klaffbron', ['test']);
    expect(app._actuallyUpdateUI).toHaveBeenCalledTimes(1);

    release();
    await p1;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(app._actuallyUpdateUI).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// CG2-6: available-återhämtningen gate:as på obligatoriska capabilities
// =============================================================================
describe('CG2-6: capability-migrationens falska available stängd', () => {
  let app;

  const makeDevice = (overrides = {}) => ({
    _initFailed: true,
    hasCapability: () => true,
    setCapabilityValue: jest.fn(() => Promise.resolve()),
    setAvailable: jest.fn(() => Promise.resolve()),
    getName: () => 'TestDevice',
    ...overrides,
  });

  beforeEach(() => {
    app = riggApp();
    app._lastBridgeTextHash = 'x';
    app._lastBridgeAlarm = 'x';
    app._lastConnectionStatus = 'x';
  });

  test('bridge_text saknas ⇒ lyckad alarm_generic-skrivning klarerar INTE enheten', async () => {
    const device = makeDevice({ hasCapability: (cap) => cap !== 'bridge_text' });
    app._devices = new Set([device]);
    await app._writeCapabilityToDevices('alarm_generic', true);
    await flushMicrotasks();
    expect(device.setAvailable).not.toHaveBeenCalled();
    expect(device._initFailed).toBe(true); // förblir ärligt unavailable
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining('INIT_RECOVERY_BLOCKED'));
  });

  test('alla obligatoriska capabilities finns ⇒ återhämtningen klarerar (I1-beteendet)', async () => {
    const device = makeDevice();
    app._devices = new Set([device]);
    await app._writeCapabilityToDevices('alarm_generic', true);
    await flushMicrotasks();
    expect(device.setAvailable).toHaveBeenCalledTimes(1);
    expect(device._initFailed).toBe(false);
  });

  test('stub utan hasCapability-API behandlas som komplett (testlägeskontraktet)', async () => {
    const device = makeDevice({ hasCapability: undefined });
    app._devices = new Set([device]);
    await app._writeCapabilityToDevices('alarm_generic', true);
    await flushMicrotasks();
    expect(device.setAvailable).toHaveBeenCalledTimes(1);
    expect(device._initFailed).toBe(false);
  });
});

// =============================================================================
// CG2-12: init-tokenens härdning
// =============================================================================
describe('CG2-12: global token — bounded init + lat återskapning', () => {
  test('hängande createToken stallar INTE _initGlobalToken (10 s-räddningen)', async () => {
    jest.useFakeTimers();
    try {
      const app = riggApp();
      app._lastBridgeText = '';
      app.homey = { flow: { createToken: () => new Promise(() => {}) } }; // settlar aldrig

      let settled = false;
      const p = app._initGlobalToken().then(() => {
        settled = true;
      });
      jest.advanceTimersByTime(10 * 1000 + 50);
      await p;
      expect(settled).toBe(true); // resolvade via timeout-catch — onInit går vidare
      expect(app._globalBridgeTextToken).toBeUndefined();
      expect(app.error).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('saknad token återskapas lat i _setGlobalTokenSafe och värdet levereras', async () => {
    const app = riggApp();
    const token = {
      value: undefined,
      setValue: jest.fn(function set(v) {
        this.value = v; return Promise.resolve();
      }),
    };
    app.homey = { flow: { createToken: jest.fn(() => Promise.resolve(token)) } };
    app._globalBridgeTextToken = undefined;
    app._lastBridgeText = 'Text A';

    await app._setGlobalTokenSafe('Text A');
    expect(app.homey.flow.createToken).toHaveBeenCalledTimes(1);
    expect(app._globalBridgeTextToken).toBe(token);
    expect(token.value).toBe('Text A');
  });

  test('återskapningen är rate-limitad (inget nytt försök inom 60 s)', async () => {
    const app = riggApp();
    app.homey = { flow: { createToken: jest.fn(() => Promise.reject(new Error('transient'))) } };
    app._globalBridgeTextToken = undefined;
    app._lastBridgeText = '';

    await app._setGlobalTokenSafe('Text A'); // försök 1 — misslyckas, stämplar
    await app._setGlobalTokenSafe('Text B'); // inom 60 s — inget nytt försök
    expect(app.homey.flow.createToken).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// CG2-1: stationär-jitter-gaten i detectBridgePassage
// =============================================================================
describe('CG2-1: stillastående GPS-jitter över brolinjen är ingen passage', () => {
  const klaffbron = { ...BRIDGES.klaffbron };
  const DLAT_20M = 20 / 111320;
  const DLAT_200M = 200 / 111320;

  const mk = (latOffset, sog) => ({
    lat: klaffbron.lat + latOffset, lon: klaffbron.lon, sog, cog: 25,
  });

  test('sog 0,2/0,1 + 20 m på var sida ⇒ passed=false via jitter-gaten', () => {
    const res = geometry.detectBridgePassage(mk(DLAT_20M, 0.2), mk(-DLAT_20M, 0.1), klaffbron);
    expect(res.passed).toBe(false);
    expect(res.method).toBe('stationary_jitter_no_passage');
  });

  test('sog=null lämnar gaten INAKTIV (fartgivarlösa detekteras via rörelse — fail-open)', () => {
    const res = geometry.detectBridgePassage(mk(DLAT_20M, null), mk(-DLAT_20M, null), klaffbron);
    expect(res.method).not.toBe('stationary_jitter_no_passage');
  });

  test('ETT rörligt sample (4 kn) räcker för att gaten inte ska ingripa', () => {
    const res = geometry.detectBridgePassage(mk(DLAT_20M, 0.2), mk(-DLAT_20M, 4.0), klaffbron);
    expect(res.method).not.toBe('stationary_jitter_no_passage');
  });

  test('äkta passage (5 kn, 200 m på var sida) detekteras fortfarande', () => {
    const res = geometry.detectBridgePassage(mk(DLAT_200M, 5.0), mk(-DLAT_200M, 5.0), klaffbron);
    expect(res.passed).toBe(true);
  });
});

// =============================================================================
// CG2-2: entered-gaten harmoniserad med updated-gaten
// =============================================================================
describe('CG2-2: mållös förstakontakt i 300 m-zonen når _triggerBoatNearFlow', () => {
  let app;

  beforeEach(() => {
    app = riggApp();
    app._initializeTargetBridge = jest.fn();
    app._analyzeVesselPosition = jest.fn();
    app._triggerBoatNearFlow = jest.fn();
    app._checkSkippedBridgesFallback = jest.fn();
    app._updateUI = jest.fn();
  });

  const kanal = TRIGGER_POINTS.kanalinfarten;

  test('mållös 66 m från Kanalinfarten ⇒ proximityn körs (S2-klassen: engångschansen missades)', async () => {
    const vessel = {
      mmsi: '265002001',
      lat: kanal.lat + 66 / 111320,
      lon: kanal.lon,
      sog: 5,
      cog: 212,
      targetBridge: null,
      currentBridge: null,
      _finalTargetBridge: null,
    };
    await app._onVesselEntered({ mmsi: vessel.mmsi, vessel });
    expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
  });

  test('currentBridge ENSAM öppnar INTE entered-grinden (SISU-regressionsvakten)', async () => {
    // Medvetet snäv grind: en ÅTERFÖDD båt intill en just gap-passerad bro
    // (SISU@Stridsbergsbron, 21h-korpusen) ska notifieras av skipped-bridges-
    // fallbacken (riktning ur hoppvektorn = northbound), inte av en proximity-
    // notis med cog-läst 'unknown'. S1-klassen (cog-avvikare vid bro) täcks av
    // updated-vägens currentBridge-gren på nästa sample i zonen.
    const vessel = {
      mmsi: '265002002',
      lat: BRIDGES.klaffbron.lat + 250 / 111320,
      lon: BRIDGES.klaffbron.lon,
      sog: 5,
      cog: 230,
      targetBridge: null,
      currentBridge: 'Klaffbron',
      _finalTargetBridge: null,
    };
    await app._onVesselEntered({ mmsi: vessel.mmsi, vessel });
    expect(app._triggerBoatNearFlow).not.toHaveBeenCalled();
  });

  test('mållös långt från allt ⇒ ingen proximity (gaten öppnades inte på vid gavel)', async () => {
    const vessel = {
      mmsi: '265002003',
      lat: 58.2000, // långt söder om kanalen
      lon: 12.2000,
      sog: 5,
      cog: 210,
      targetBridge: null,
      currentBridge: null,
      _finalTargetBridge: null,
    };
    await app._onVesselEntered({ mmsi: vessel.mmsi, vessel });
    expect(app._triggerBoatNearFlow).not.toHaveBeenCalled();
  });
});

// =============================================================================
// CG2-7: null-sog fabricerar inte ETA
// =============================================================================
describe('CG2-7: _getEffectiveSpeed skiljer saknad fart från rapporterad stillhet', () => {
  let calc;

  beforeEach(() => {
    calc = new ProgressiveETACalculator(makeLogger(), {
      getBridgeByName: () => null,
    });
  });

  afterEach(() => {
    if (typeof calc.destroy === 'function') calc.destroy();
  });

  test('sog=null ⇒ null (ETA okänd — inget 0,5 kn-fabricerat 68-min-löfte)', () => {
    expect(calc._getEffectiveSpeed({ mmsi: '1', sog: null })).toBeNull();
  });

  test('sog=undefined/sentinel-icke-finit ⇒ null', () => {
    expect(calc._getEffectiveSpeed({ mmsi: '2', sog: undefined })).toBeNull();
    expect(calc._getEffectiveSpeed({ mmsi: '3', sog: NaN })).toBeNull();
  });

  test('sog=0 (rapporterad stillhet) behåller golvet — SPIKEN/AIR-klassens designade beteende', () => {
    const speed = calc._getEffectiveSpeed({ mmsi: '4', sog: 0 });
    expect(speed).toBeGreaterThanOrEqual(0.5);
  });

  test('finit fart används som förut', () => {
    const speed = calc._getEffectiveSpeed({ mmsi: '5', sog: 4.5 });
    expect(speed).toBeGreaterThan(0.5);
  });
});

// =============================================================================
// CG2-17: SystemCoordinator-shutdownhygien
// =============================================================================
describe('CG2-17: SystemCoordinator.destroy städar debounce-timers', () => {
  test('destroy clearar timers och tömmer tillståndet', () => {
    jest.useFakeTimers();
    try {
      const sc = new SystemCoordinator(makeLogger());
      sc._activateBridgeTextDebounce('265003001', Date.now());
      sc._activateBridgeTextDebounce('265003002', Date.now());
      expect(sc.bridgeTextDebounce.size).toBe(2);

      sc.destroy();
      expect(sc.bridgeTextDebounce.size).toBe(0);
      expect(sc.vesselCoordinationState.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0); // inga överlevande callbacks
    } finally {
      jest.useRealTimers();
    }
  });

  test('onUninit-kedjans destroy-kontrakt: koordinatorn exponerar destroy som funktion', () => {
    const sc = new SystemCoordinator(makeLogger());
    expect(typeof sc.destroy).toBe('function'); // onUninit-loopen kör svc.destroy() på alla listade services
  });
});

// =============================================================================
// CG2-18A-spegel: init-tokensemantiken som replay-assertionen bygger på
// =============================================================================
describe('CG2-18A: tokenleveranskontraktet (_lastBridgeText || DEFAULT)', () => {
  test('_initGlobalToken skriver DEFAULT när textcachen är tom', async () => {
    const app = riggApp();
    const token = {
      value: undefined,
      setValue: jest.fn(function set(v) {
        this.value = v; return Promise.resolve();
      }),
    };
    app.homey = { flow: { createToken: jest.fn(() => Promise.resolve(token)) } };
    app._lastBridgeText = '';

    await app._initGlobalToken();
    expect(token.value).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });
});
