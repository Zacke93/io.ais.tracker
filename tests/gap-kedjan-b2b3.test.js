'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

/**
 * B2+B3 — Gap-kedjan (körning 2026-07-03, fynd F2/F3/F5 + F8-policy).
 *
 * ELFKUNGEN korsade FYRA broar i ett 23-min-gap men fick bara notiser för
 * en: (1) cog-gaten (north = cog ≤45°) strök hela skipped-bridges-kontrollen
 * vid cog 50,2° — kanalen svänger nordost vid Stridsbergsbron; (2) 2000 m-
 * taket dödade Klaffbron-flushen (3863 m); (3) target-protection RESTORE:ade
 * den passerade bron som målbro. DIANA missade Järnvägsbron (2057 m > taket).
 * F8 (ANVÄNDARBESLUT): bekräftad/inferrerad passage notifieras alltid —
 * distans/fart-skattningen ströp gränsbro-notiser godtyckligt.
 * SPIKEN-följdfixen: återfödda båtar begränsas till sist kända position.
 */

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
  app._lastKnownPositions = new Map();
  app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * 60 * 1000;
  return app;
}

describe('B2: scenario B använder hoppvektorn, inte cog (ELFKUNGEN)', () => {
  test('cog 50,2° (kanalsvängen) blockerar inte — alla fyra broarna flushas', async () => {
    const app = makeApp();
    // ELFKUNGEN 10:29:43: 58.27192 → 58.29610 i 23-min-gap, cog 50.2
    const oldVessel = { lat: 58.27191833333333, lon: 12.2732 };
    const vessel = {
      mmsi: '265573130',
      lat: 58.2961,
      lon: 12.29717,
      sog: 6.7,
      cog: 50.2,
      targetBridge: 'Klaffbron',
      _moored: false,
    };
    await app._checkSkippedBridgesFallback(vessel, oldVessel);

    const fired = app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
    expect(fired).toEqual(['Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron']);
    // inferredFlush-flaggan följer med (2000 m-taket ersätts av sanity-gater)
    expect(app._triggerBoatNearFlowFallback.mock.calls[0][2]).toMatchObject({ inferredFlush: true });
  });

  test('scenario B kräver ingen sog — hoppet ÄR rörelsebeviset', async () => {
    const app = makeApp();
    const oldVessel = { lat: 58.28919, lon: 12.2892 };
    const vessel = {
      mmsi: '211351080', lat: 58.2968, lon: 12.2991, sog: 0.8, cog: 30, _moored: false,
    };
    await app._checkSkippedBridgesFallback(vessel, oldVessel);
    const fired = app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
    expect(fired).toEqual(expect.arrayContaining(['Järnvägsbron', 'Stridsbergsbron']));
  });

  test('södergående flush itererar i färdriktningsordning (Strids→Jvb→Klaff)', async () => {
    const app = makeApp();
    // DIANA-klassen: 58.29501 → 58.27462 söderut
    const oldVessel = { lat: 58.29501, lon: 12.2962 };
    const vessel = {
      mmsi: '265576710', lat: 58.27462, lon: 12.2765, sog: 5.9, cog: 200, _moored: false,
    };
    await app._checkSkippedBridgesFallback(vessel, oldVessel);

    const fired = app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
    expect(fired).toEqual(['Stridsbergsbron', 'Järnvägsbron', 'Klaffbron']);
    // Inferensen (target-transitionskedjan) körs i samma ordning och FÖRE notiserna
    const inferred = app.vesselDataService.applyInferredPassage.mock.calls.map((c) => c[2]);
    expect(inferred).toEqual(['Stridsbergsbron', 'Järnvägsbron', 'Klaffbron']);
    const firstInferOrder = app.vesselDataService.applyInferredPassage.mock.invocationCallOrder[0];
    const firstNotifyOrder = app._triggerBoatNearFlowFallback.mock.invocationCallOrder[0];
    expect(firstInferOrder).toBeLessThan(firstNotifyOrder);
  });
});

describe('B2: inferredFlush ersätter 2000 m-taket med sanity-gater (DIANA/ELFKUNGEN)', () => {
  function makeFallbackApp() {
    const app = Object.create(AISBridgeApp.prototype);
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app._boatNearTrigger = { trigger: jest.fn() };
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._knownVesselNames = new Map();
    app._VESSEL_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    app._triggerBoatNearFlowForBridge = jest.fn().mockResolvedValue(undefined);
    return app;
  }

  const farVessel = (dist) => ({
    mmsi: '265576710',
    name: 'DIANA',
    // ~2057 m söder om Järnvägsbron (58.29164): 0.0185° lat ≈ 2057 m
    lat: 58.29164 - (dist / 111320),
    lon: 12.292025,
    sog: 5.9,
    cog: 200,
    lastPositionUpdate: Date.now(),
    maxRecentSpeed: 6.0,
  });

  test('utan inferredFlush: 2057 m blockeras av 2000 m-taket', async () => {
    const app = makeFallbackApp();
    await app._triggerBoatNearFlowFallback(farVessel(2057), 'Järnvägsbron', { detectionTs: Date.now() });
    expect(app._triggerBoatNearFlowForBridge).not.toHaveBeenCalled();
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('FALLBACK_TRIGGER_TOO_FAR'))).toBe(true);
  });

  test('med inferredFlush: 2057 m avfyras (verklig passage i gapet)', async () => {
    const app = makeFallbackApp();
    await app._triggerBoatNearFlowFallback(farVessel(2057), 'Järnvägsbron', {
      detectionTs: Date.now(), inferredFlush: true,
    });
    expect(app._triggerBoatNearFlowForBridge).toHaveBeenCalledTimes(1);
  });

  test('inferredFlush: 10 km-sanity blockerar spökhopp', async () => {
    const app = makeFallbackApp();
    await app._triggerBoatNearFlowFallback(farVessel(10500), 'Järnvägsbron', {
      detectionTs: Date.now(), inferredFlush: true,
    });
    expect(app._triggerBoatNearFlowForBridge).not.toHaveBeenCalled();
  });

  test('inferredFlush: gammal position (>2 min) blockerar', async () => {
    const app = makeFallbackApp();
    const vessel = farVessel(2057);
    vessel.lastPositionUpdate = Date.now() - 3 * 60 * 1000;
    await app._triggerBoatNearFlowFallback(vessel, 'Järnvägsbron', {
      detectionTs: Date.now(), inferredFlush: true,
    });
    expect(app._triggerBoatNearFlowForBridge).not.toHaveBeenCalled();
  });
});

describe('F8: scenario A notifierar bekräftad födelseinferens (PHILULA/DIAMOND)', () => {
  test('ny båt innanför Kanalinfarten får notisen även när distans/fart-skattningen är >300 s', async () => {
    const app = makeApp();
    // PHILULA-klassen: född ~800 m norr om Kanalinfarten i 3 kn — gamla
    // skattningen (800/1,54 ≈ 519 s > 300) ströp notisen.
    const vessel = {
      mmsi: '211597910',
      lat: 58.2752,
      lon: 12.2778,
      sog: 3.0,
      cog: 41.7,
      _firstSeenLat: 58.2752,
      _firstSeenLon: 12.2778,
      _moored: false,
    };
    await app._checkSkippedBridgesFallback(vessel, null);

    const { calls } = app._triggerBoatNearFlowFallback.mock;
    const kanalCall = calls.find((c) => c[1] === 'Kanalinfarten');
    expect(kanalCall).toBeTruthy();
    // detectionTs skickas med — den kända-tid-grenen ersätter skattningen
    expect(Number.isFinite(kanalCall[2].detectionTs)).toBe(true);
    // Födelseinferens är INTE inferredFlush (2000 m-taket ska bestå för antaganden)
    expect(kanalCall[2].inferredFlush).toBeUndefined();
  });
});

describe('F2-följdfix: återfödd båt begränsas till sist kända position (SPIKEN)', () => {
  test('ankrad norr om Strids → återfödd i rörelse → INGA portinferens-notiser', async () => {
    const app = makeApp();
    // SPIKEN låg vid 58.29803 (norr om Stridsbergsbron), removades, återföds
    // 58.30310 i rörelse. Porten-antagandet gav falska Jvb+Strids-notiser.
    app._lastKnownPositions.set('231898000', { lat: 58.29803, lon: 12.2985, t: Date.now() - 40 * 60 * 1000 });
    const vessel = {
      mmsi: '231898000',
      lat: 58.30310,
      lon: 12.3040,
      sog: 4.5,
      cog: 25,
      _firstSeenLat: 58.30310,
      _firstSeenLon: 12.3040,
      _moored: false,
    };
    await app._checkSkippedBridgesFallback(vessel, null);
    // Fönstret [58.29803, 58.30310] innehåller inga broar → inga notiser
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('äkta gap-korsning överlever: broar MELLAN sist kända och nuvarande flushas', async () => {
    const app = makeApp();
    // SY FREYJA: sist känd 58.28919 (söder om Jvb), återfödd 58.2968 (norr om
    // Strids) → Jvb+Strids korsades bevisligen; Klaffbron (söder om sist
    // kända) ska INTE gissas.
    app._lastKnownPositions.set('211351080', { lat: 58.28919, lon: 12.2892, t: Date.now() - 20 * 60 * 1000 });
    const vessel = {
      mmsi: '211351080',
      lat: 58.2968,
      lon: 12.2991,
      sog: 4.6,
      cog: 28.9,
      _firstSeenLat: 58.2968,
      _firstSeenLon: 12.2991,
      _moored: false,
    };
    await app._checkSkippedBridgesFallback(vessel, null);
    const fired = app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
    expect(fired).toEqual(['Järnvägsbron', 'Stridsbergsbron']);
    expect(fired).not.toContain('Klaffbron');
  });

  test('utgången sist-känd-position (>6 h) faller tillbaka till porten-antagandet', async () => {
    const app = makeApp();
    app._lastKnownPositions.set('265000001', { lat: 58.30, lon: 12.30, t: Date.now() - 7 * 60 * 60 * 1000 });
    const vessel = {
      mmsi: '265000001',
      lat: 58.2715,
      lon: 12.2745,
      sog: 5.0,
      cog: 30,
      _firstSeenLat: 58.2715,
      _firstSeenLon: 12.2745,
      _moored: false,
    };
    await app._checkSkippedBridgesFallback(vessel, null);
    const fired = app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
    expect(fired).toContain('Kanalinfarten'); // porten-inferens åter aktiv
    expect(app._lastKnownPositions.has('265000001')).toBe(false); // utgången post städad
  });
});

describe('B3: protection släpps vid inferrerad/bekräftad passage (F3)', () => {
  let liveServices;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    liveServices = [];
  });

  afterEach(() => {
    for (const svc of liveServices) {
      try {
        svc.clearAllTimers();
      } catch (_) { /* tomt */ }
    }
    delete global.__TEST_MODE__;
  });

  function makeVds() {
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
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

  test('applyInferredPassage på målbron deaktiverar protection (ingen RESTORE av passerad bro)', () => {
    const svc = makeVds();
    const vessel = svc.updateVessel('265573130', {
      lat: 58.27192, lon: 12.2732, sog: 6.5, cog: 30, name: 'ELFKUNGEN',
    });
    vessel.targetBridge = 'Klaffbron';
    vessel._routeDirection = 'north';
    svc.targetBridgeProtection.set('265573130', {
      isActive: true,
      reason: 'gps-event',
      startTime: Date.now() - 30 * 1000,
      targetBridge: 'Klaffbron',
      confidence: 1.0,
      gpsEventDetected: true,
      closeToTarget: false,
      maneuverDetected: false,
      distanceToTarget: 1622,
    });

    const oldVessel = { lat: 58.27192, lon: 12.2732 };
    vessel.lat = 58.2961;
    vessel.lon = 12.29717;
    svc.applyInferredPassage(vessel, oldVessel, 'Klaffbron');

    expect(svc.targetBridgeProtection.has('265573130')).toBe(false);
    expect(vessel.passedBridges).toContain('Klaffbron');
    expect(vessel.targetBridge).not.toBe('Klaffbron');
  });

  test('_shouldDeactivateProtection: skydd av redan passerad bro släpps', () => {
    const svc = makeVds();
    const protection = {
      isActive: true,
      reason: 'gps-event',
      startTime: Date.now() - 10 * 1000,
      targetBridge: 'Klaffbron',
      gpsEventDetected: true,
      coordinationActive: false,
      maneuverDetected: false,
      distanceToTarget: 400,
    };
    const vessel = { passedBridges: ['Olidebron', 'Klaffbron'], _gpsJumpDetected: true };
    expect(svc._shouldDeactivateProtection(protection, vessel, Date.now())).toBe(true);

    const vesselNotPassed = { passedBridges: ['Olidebron'], _gpsJumpDetected: true };
    expect(svc._shouldDeactivateProtection(protection, vesselNotPassed, Date.now())).toBe(false);
  });
});
