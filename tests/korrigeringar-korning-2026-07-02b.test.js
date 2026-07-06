'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };

/**
 * Regressionstester för eftermiddagskörningen 2026-07-02 (13:28–15:38).
 * Åtta fel identifierade och åtgärdade — se docs/korrigeringar-2026-07-02b.md.
 */

const liveServices = [];

function makeRealVDS() {
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.app = {
    gpsJumpGateService: null,
    passageLatchService: null,
    routeOrderValidator: null,
    debug: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  liveServices.push(svc);
  return svc;
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

afterEach(() => {
  // Rensa äkta timers (scheduleCleanup/_markPassageProcessed) — annars
  // hänger Jest-processen på öppna handles efter att testerna passerat.
  while (liveServices.length > 0) {
    const svc = liveServices.pop();
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  jest.restoreAllMocks();
});

describe('FEL 7a (CLABBYDOO): heuristiska passagemetoder kräver sidbyte av brolinjen', () => {
  const klaffbron = {
    lat: BRIDGES.klaffbron.lat,
    lon: BRIDGES.klaffbron.lon,
    axisBearing: BRIDGES.klaffbron.axisBearing,
    name: 'Klaffbron',
  };

  test('väntande båt som driftar bakåt på SAMMA sida är INTE en passage (progressive_distance)', () => {
    // CLABBYDOO 11:37:18: 78→103 m NORR om Klaffbron i 0,4 kn — förklarades
    // passerad via progressive_distance (conf 0,75) och räknades bort ur
    // texten 8 min före den verkliga passagen.
    const oldVessel = {
      lat: klaffbron.lat + 0.0007, lon: klaffbron.lon, sog: 0.5, cog: 20,
    };
    const vessel = {
      lat: klaffbron.lat + 0.00093, lon: klaffbron.lon + 0.0001, sog: 0.4, cog: 58,
    };
    const result = geometry.detectBridgePassage(vessel, oldVessel, klaffbron);
    expect(result.passed).toBe(false);
  });

  test('äkta passage med sidbyte detekteras fortfarande', () => {
    const oldVessel = {
      lat: klaffbron.lat + 0.0007, lon: klaffbron.lon, sog: 3.5, cog: 200,
    };
    const vessel = {
      lat: klaffbron.lat - 0.00093, lon: klaffbron.lon - 0.0001, sog: 3.5, cog: 200,
    };
    const result = geometry.detectBridgePassage(vessel, oldVessel, klaffbron);
    expect(result.passed).toBe(true);
  });

  test('U-sväng nära bron (stor kursändring, samma sida) är INTE en passage (method 5)', () => {
    // >60° kursändring + bortåtrörelse på samma sida = vändning, inte passage.
    const oldVessel = {
      lat: klaffbron.lat - 0.00135, lon: klaffbron.lon, sog: 3.0, cog: 30,
    };
    const vessel = {
      lat: klaffbron.lat - 0.00225, lon: klaffbron.lon, sog: 3.0, cog: 200,
    };
    const result = geometry.detectBridgePassage(vessel, oldVessel, klaffbron);
    expect(result.passed).toBe(false);
  });

  test('sampel PÅ brolinjen (±10 m) blockerar inte — sida oavgörbar', () => {
    // Ett sampel mitt under bron följt av tydlig bortåtrörelse är en äkta
    // passagesignatur (METHOD 1) — väntande båtar når inte in under bron.
    const oldVessel = {
      lat: klaffbron.lat, lon: klaffbron.lon, sog: 4, cog: 30,
    };
    const vessel = {
      lat: klaffbron.lat + 0.001, lon: klaffbron.lon + 0.0005, sog: 4, cog: 30,
    };
    const result = geometry.detectBridgePassage(vessel, oldVessel, klaffbron);
    expect(result.passed).toBe(true);
  });
});

describe('FEL 7b (YEMANJA II): distance_fallback kräver sidbyte', () => {
  const strids = BRIDGES.stridsbergsbron;

  test('båt som ANKOMMER till ≤50 m för att invänta öppning förklaras INTE passerad', () => {
    // YEMANJA II 13:34:45: 215→48 m söder om Strids, sog 0,7, på väg MOT
    // bron — "TARGET_BRIDGE_PASSED (method: no_passage_detected, conf 0.50)"
    // → texten föll till "Inga båtar" i själva öppningsögonblicket.
    const svc = makeRealVDS();
    const oldVessel = {
      mmsi: '257904890', lat: strids.lat - 0.00193, lon: strids.lon - 0.0002, sog: 4.3, cog: 33.7,
    };
    const vessel = {
      mmsi: '257904890',
      targetBridge: 'Stridsbergsbron',
      lat: strids.lat - 0.00043,
      lon: strids.lon - 0.00005,
      sog: 0.7,
      cog: 24.9,
    };
    expect(svc._hasPassedTargetBridge(vessel, oldVessel)).toBe(false);
  });

  test('sampel under bron + utgång på ANDRA sidan ⇒ distance_fallback slår till', () => {
    const svc = makeRealVDS();
    const oldVessel = {
      mmsi: '257904890', lat: strids.lat - 0.0004, lon: strids.lon, sog: 4.0, cog: 25,
    };
    const vessel = {
      mmsi: '257904890',
      targetBridge: 'Stridsbergsbron',
      lat: strids.lat + 0.0009,
      lon: strids.lon + 0.0001,
      sog: 4.0,
      cog: 25,
    };
    expect(svc._hasPassedTargetBridge(vessel, oldVessel)).toBe(true);
  });
});

describe('FEL 3 (YEMANJA II): gap-infererad målbropassage transiterar target', () => {
  test('applyInferredPassage på målbron ger omedelbar TARGET_TRANSITION', () => {
    // 12:53:46: Klaffbron korsad i 9-min-gap (prev 1015 m/curr 311 m —
    // utanför alla geometrimetoders gränser). Failsafen notifierade men
    // target förblev Klaffbron i 39 min.
    const svc = makeRealVDS();
    const oldVessel = {
      mmsi: '257904890', lat: 58.2753, lon: 12.2793, sog: 5.6, cog: 25,
    };
    const vessel = {
      mmsi: '257904890',
      targetBridge: 'Klaffbron',
      lat: 58.28665,
      lon: 12.28604,
      sog: 5.5,
      cog: 33.5,
      _routeDirection: 'north',
      passedBridges: [],
    };
    svc.applyInferredPassage(vessel, oldVessel, 'Klaffbron');
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(vessel.passedBridges).toContain('Klaffbron');
  });

  test('Kanalinfarten (trigger-point, ej bro) är no-op', () => {
    const svc = makeRealVDS();
    const vessel = {
      mmsi: '1', targetBridge: 'Klaffbron', lat: 58.2709, lon: 12.2728, sog: 4, cog: 30, passedBridges: [],
    };
    const oldVessel = {
      mmsi: '1', lat: 58.2650, lon: 12.2680, sog: 4, cog: 30,
    };
    expect(() => svc.applyInferredPassage(vessel, oldVessel, 'Kanalinfarten')).not.toThrow();
    expect(vessel.targetBridge).toBe('Klaffbron');
  });

  test('bro utanför hoppets lat-intervall är no-op (säkerhetskoll)', () => {
    const svc = makeRealVDS();
    const vessel = {
      mmsi: '1', targetBridge: 'Klaffbron', lat: 58.2760, lon: 12.2790, sog: 4, cog: 30, passedBridges: [],
    };
    const oldVessel = {
      mmsi: '1', lat: 58.2700, lon: 12.2730, sog: 4, cog: 30,
    };
    svc.applyInferredPassage(vessel, oldVessel, 'Klaffbron'); // Klaffbron 58.284 > båda
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel.passedBridges).toEqual([]);
  });
});

describe('FEL 1 (SY FREYJA): skipped-bridges-failsafen körs även målbrolöst', () => {
  function makeApp() {
    const app = Object.create(AISBridgeApp.prototype);
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = {
      hasGpsJumpHold: () => false,
      isNearMooringZone: () => false,
      applyInferredPassage: jest.fn(),
    };
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    return app;
  }

  test('mållös återfödd utgående båt med broar i gapet får failsafes (large-jump)', async () => {
    // SY FREYJA 12:32:14: återfödd norr om Stridsbergsbron efter tyst removal
    // — korsade Järnvägsbron OCH Stridsbergsbron i 20-min-gapet. Gamla gaten
    // `!targetBridge && !_finalTargetBridge` slukade båda notiserna.
    const app = makeApp();
    const oldVessel = { lat: 58.28919, lon: 12.2892 };
    const vessel = {
      mmsi: '211351080',
      lat: 58.29680,
      lon: 12.29913,
      sog: 4.6,
      cog: 28.9,
      targetBridge: null,
      _finalTargetBridge: null,
      _moored: false,
    };
    await app._checkSkippedBridgesFallback(vessel, oldVessel);

    const firedBridges = app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
    expect(firedBridges).toContain('Järnvägsbron');
    expect(firedBridges).toContain('Stridsbergsbron');
    // Scenario B applicerar även passagerna i VDS (fel 3-koppling)
    const inferred = app.vesselDataService.applyInferredPassage.mock.calls.map((c) => c[2]);
    expect(inferred).toEqual(expect.arrayContaining(['Järnvägsbron', 'Stridsbergsbron']));
  });

  test('förtöjd båt är undantagen (moored-gaten ersätter target-gaten)', async () => {
    const app = makeApp();
    const vessel = {
      mmsi: '1', lat: 58.29680, lon: 12.29913, sog: 4.6, cog: 28.9, targetBridge: null, _finalTargetBridge: null, _moored: true,
    };
    await app._checkSkippedBridgesFallback(vessel, { lat: 58.28919, lon: 12.2892 });
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });
});

describe('FEL 6: IMMINENT_SET_EXHAUSTED har distansgräns 500 m', () => {
  function makeApp(vessel) {
    const app = Object.create(AISBridgeApp.prototype);
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = {
      getAllVessels: () => [vessel],
      hasGpsJumpHold: () => false,
    };
    app.proximityService = {
      analyzeVesselProximity: () => ({ bridges: [], nearestBridge: null }),
    };
    app.statusService = {
      analyzeVesselStatus: () => ({
        status: 'en-route', isWaiting: false, isApproaching: false, statusChanged: false, statusReason: 't',
      }),
      calculateETA: () => 5,
    };
    return app;
  }

  const baseVessel = (distDegLat) => ({
    mmsi: '257904890',
    targetBridge: 'Klaffbron',
    lat: BRIDGES.klaffbron.lat - distDegLat,
    lon: BRIDGES.klaffbron.lon,
    sog: 5.5,
    cog: 25,
    status: 'en-route',
    etaMinutes: null,
    lastPositionUpdate: Date.now() - 7 * 60 * 1000, // inom HARD-gränsen (10 min)
    _etaExtrapolationExhausted: true,
  });

  test('1016 m (YEMANJA II-fallet) ⇒ INTE imminent — "ETA okänd" i stället för falsk strax', () => {
    const vessel = baseVessel(0.00913); // ≈1016 m söder om Klaffbron
    makeApp(vessel)._reevaluateVesselStatuses();
    expect(vessel._isImminentAtTargetBridge).toBe(false);
  });

  test('400 m ⇒ fortfarande imminent (extrapolationen sa "framme" och hon var nära)', () => {
    const vessel = baseVessel(0.0036); // ≈400 m
    makeApp(vessel)._reevaluateVesselStatuses();
    expect(vessel._isImminentAtTargetBridge).toBe(true);
  });
});

describe('FEL 4 (CLABBYDOO): exit-fallbackens stale-gard lever och mäter positionsålder', () => {
  function makeApp() {
    const app = Object.create(AISBridgeApp.prototype);
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    return app;
  }

  const nearExit = { lat: 58.270943, lon: 12.272802 }; // CLABBYDOO:s sista position, 384 m från Kanalinfarten

  test('20 min gammal position ⇒ notisen avfyras (removal-timern ÄR ~20 min)', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback({
      mmsi: '211536930',
      ...nearExit,
      lastPositionUpdate: Date.now() - 20 * 60 * 1000,
      // Helgranskning 2026-07-06 (app-6#R2-2): exit-fallbacken kräver numera
      // rörelsebevis + icke-förtöjd — CLABBYDOO var en bevisat rörlig båt.
      _hasMovementProof: true,
      _moored: false,
    });
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledWith(expect.anything(), 'Kanalinfarten');
  });

  test('förtöjd båt nära Kanalinfarten ⇒ exit-fallbacken stoppar (app-6#R2-2)', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback({
      mmsi: '211536931',
      ...nearExit,
      lastPositionUpdate: Date.now() - 5 * 60 * 1000,
      _hasMovementProof: true,
      _moored: true,
    });
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('båt utan rörelsebevis ⇒ exit-fallbacken stoppar (kajliggarklassen)', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback({
      mmsi: '211536932',
      ...nearExit,
      lastPositionUpdate: Date.now() - 5 * 60 * 1000,
      _hasMovementProof: false,
      _moored: false,
    });
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('30 min gammal position ⇒ garden stoppar (falsk-notis-risken)', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback({
      mmsi: '211536930', ...nearExit, lastPositionUpdate: Date.now() - 30 * 60 * 1000,
    });
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('saknade ålderfält ⇒ garden stoppar (var tidigare tyst genomsläppt)', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback({ mmsi: '211536930', ...nearExit });
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('vesselSnapshot vid removal bär ålderfälten (garden var död utan dem)', () => {
    const svc = makeRealVDS();
    svc.updateVessel('265999000', {
      lat: 58.2709, lon: 12.2728, sog: 4.0, cog: 205, name: 'SNAPSHOT-TEST',
    });
    let payload = null;
    svc.on('vessel:removed', (p) => {
      payload = p;
    });
    // Icke-timeout-reason hoppar över protection-zone-deferralen så
    // removal + emit sker synkront (fartyget står 145 m från Olidebron).
    svc.removeVessel('265999000', 'test-cleanup');
    expect(payload).not.toBeNull();
    expect(Number.isFinite(payload.vessel.timestamp)).toBe(true);
  });
});

describe('FEL 9 (CLABBYDOO): N7-kajvakten med 100 m avgångsmarginal', () => {
  test('första sample 67 m bortom kapseln räknas som kajstart med marginalen', () => {
    const svc = makeRealVDS();
    const first = { lat: 58.28704, lon: 12.28614 }; // CLABBYDOO:s första sample
    expect(svc.isNearMooringZone(first.lat, first.lon)).toBe(false); // utan marginal
    expect(svc.isNearMooringZone(first.lat, first.lon, 100)).toBe(true); // med marginal
  });

  test('mitt i farleden långt från kajen träffas inte ens med marginal', () => {
    const svc = makeRealVDS();
    expect(svc.isNearMooringZone(58.2920, 12.2930, 100)).toBe(false);
  });
});
