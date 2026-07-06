'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const StatusService = require('../lib/services/StatusService');
const { BRIDGES } = require('../lib/constants');

/**
 * B4+B5+B6 — bridge_text-livscykeln (körning 2026-07-03, fynd F4/F7/F9/F10).
 *
 * B4: "strax" på uttömd extrapolering är tidsbegränsad (90 s) — ZWERK/PHILULA
 *     stod med fruset "strax" + antalsflimmer i 2–5 min på stale data.
 * B5: under-bridge-timeouten räknar bara FÄRSK tid — VALEN:s latch force-
 *     clearades mitt i ett AIS-gap under målbrotransit ⇒ falskt "Inga båtar".
 * B6: TARGET_END nollställer ETA-serien + imminent-flaggan (PHILULA), och
 *     BridgeTextService vägrar "strax" för en target som redan passerats.
 */

describe('B4: IMMINENT_SET_EXHAUSTED håller max 90 s (F10)', () => {
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

  const baseVessel = (exhaustedAgeMs) => ({
    mmsi: '244100668',
    targetBridge: 'Klaffbron',
    lat: BRIDGES.klaffbron.lat - 0.0028, // ≈312 m söder (ZWERK-fallet)
    lon: BRIDGES.klaffbron.lon,
    sog: 4.0,
    cog: 25,
    status: 'en-route',
    etaMinutes: null,
    lastPositionUpdate: Date.now() - 6 * 60 * 1000, // inom HARD-gränsen
    _etaExtrapolationExhausted: true,
    _etaExhaustedAtMs: Date.now() - exhaustedAgeMs,
  });

  test('60 s efter uttömning ⇒ fortfarande imminent ("hon borde vara framme nu")', () => {
    const vessel = baseVessel(60 * 1000);
    makeApp(vessel)._reevaluateVesselStatuses();
    expect(vessel._isImminentAtTargetBridge).toBe(true);
  });

  test('120 s efter uttömning ⇒ INTE imminent — degraderar till "ETA okänd" (ZWERK stod 2–5 min)', () => {
    const vessel = baseVessel(120 * 1000);
    makeApp(vessel)._reevaluateVesselStatuses();
    expect(vessel._isImminentAtTargetBridge).toBe(false);
  });

  test('fältlistan bevarar _etaExhaustedAtMs över meddelandeuppdateringar (5:e offret-vakt)', () => {
    global.__TEST_MODE__ = true;
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null, debug: jest.fn(), log: jest.fn(), error: jest.fn(),
    };
    try {
      const first = svc.updateVessel('265000009', {
        lat: 58.2790, lon: 12.2810, sog: 4.0, cog: 30, name: 'TEST',
      });
      const stamp = Date.now() - 30 * 1000;
      first._etaExhaustedAtMs = stamp;
      const second = svc.updateVessel('265000009', {
        lat: 58.2795, lon: 12.2815, sog: 4.0, cog: 30, name: 'TEST',
      });
      expect(second._etaExhaustedAtMs).toBe(stamp);
    } finally {
      svc.clearAllTimers();
      delete global.__TEST_MODE__;
    }
  });
});

describe('B5: under-bridge-timeouten fryser under AIS-gap (F7/VALEN)', () => {
  function makeStatusService() {
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    return new StatusService(new BridgeRegistry(), logger, new SystemCoordinator(logger));
  }

  const underBridgeVessel = (overrides) => ({
    mmsi: '265741640',
    targetBridge: 'Klaffbron',
    currentBridge: 'Järnvägsbron',
    distanceToCurrent: 30,
    lat: BRIDGES.jarnvagsbron.lat,
    lon: BRIDGES.jarnvagsbron.lon,
    sog: 3.0,
    cog: 200,
    _underBridgeLatched: true,
    _underBridgeSince: Date.now() - 12 * 60 * 1000, // 12 min väggtid (> 10-min-taket)
    ...overrides,
  });

  test('gap pågår (position 8 min gammal) ⇒ ingen force-clear, latchen består', () => {
    const svc = makeStatusService();
    const vessel = underBridgeVessel({
      lastPositionUpdate: Date.now() - 8 * 60 * 1000,
    });
    const result = svc._isUnderBridge(vessel, { bridges: [], nearestBridge: null });
    expect(result).toBe(true);
    expect(vessel._underBridgeLatched).toBe(true);
  });

  test('färsk position + 12 min stillhet ⇒ force-clear (Bug #5-fallet intakt)', () => {
    const svc = makeStatusService();
    const vessel = underBridgeVessel({
      lastPositionUpdate: Date.now() - 10 * 1000, // färsk AIS
    });
    const result = svc._isUnderBridge(vessel, { bridges: [], nearestBridge: null });
    expect(result).toBe(false);
    expect(vessel._underBridgeLatched).toBe(false);
  });
});

describe('B6: TARGET_END nollställer ETA-serien + imminent (F9/PHILULA)', () => {
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

  test('slutmålspassage (Stridsbergsbron norrut) rensar strax-tillståndet', () => {
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null, debug: jest.fn(), log: jest.fn(), error: jest.fn(),
    };
    liveServices.push(svc);

    const vessel = svc.updateVessel('211597910', {
      lat: BRIDGES.stridsbergsbron.lat - 0.0006, lon: BRIDGES.stridsbergsbron.lon, sog: 5.0, cog: 25, name: 'PHILULA',
    });
    vessel.targetBridge = 'Stridsbergsbron';
    vessel._routeDirection = 'north';
    vessel._isImminentAtTargetBridge = true;
    vessel.etaMinutes = 0.5;
    vessel._etaExtrapolationExhausted = true;
    vessel._etaExhaustedAtMs = Date.now();

    const oldVessel = { ...vessel };
    vessel.lat = BRIDGES.stridsbergsbron.lat + 0.0009; // norr om bron
    svc._handleTargetBridgeTransition(vessel, oldVessel, { confirmedPassage: true });

    expect(vessel.targetBridge).toBeNull();
    expect(vessel._finalTargetBridge).toBe('Stridsbergsbron');
    expect(vessel._isImminentAtTargetBridge).toBe(false);
    expect(vessel.etaMinutes).toBeNull();
    expect(vessel._etaExtrapolationExhausted).toBe(false);
    expect(vessel._etaExhaustedAtMs).toBeNull();
  });

  test('BridgeTextService: imminent-flagga för redan passerad target driver INTE "strax"', () => {
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const BridgeTextService = require('../lib/services/BridgeTextService');
    // Helgranskning 2026-07-06 (t-bridge-text#3): argumenten var omkastade
    // mot signaturen (bridgeRegistry, logger, ...) — testet råkade passera
    // ändå men prövade tjänsten med logger som registry.
    const bts = new BridgeTextService(new BridgeRegistry(), logger);

    const lingering = {
      mmsi: '211597910',
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Klaffbron', 'Stridsbergsbron'], // passagen registrerad
      _isImminentAtTargetBridge: true, // kvarhängande flagga
      etaMinutes: null,
    };
    const phrase = bts._buildGroupPhrase([lingering], 'Stridsbergsbron');
    expect(phrase).not.toContain('strax');
    expect(phrase).toContain('Stridsbergsbron');

    const legit = {
      mmsi: '265000001',
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Klaffbron'],
      _isImminentAtTargetBridge: true,
      etaMinutes: null,
    };
    expect(bts._buildGroupPhrase([legit], 'Stridsbergsbron')).toContain('strax');
  });
});
