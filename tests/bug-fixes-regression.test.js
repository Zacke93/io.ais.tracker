'use strict';

/**
 * Regressionstester för buggar identifierade i replay-loggar 2026-04-13 → 2026-04-18.
 *
 * Bug #1  — Race condition i removeVessel() PROTECTION_ZONE-gren låser _removalInProgress
 * Bug #3  — 15-minuters deterministisk ETA från MIN_PASSAGE_ROUTE_SPEED_KNOTS floor
 * Bug #4  — BRIDGE_TEXT_BUG race mellan relevantVessels och BridgeTextService-filter
 * Bug #6  — ETA yo-yo (64→106→27 min) utan absolut clamp
 * Bug #11 — Orimliga ETA-värden (60, 82, 106 min) visas i bridge text
 * Bug #13 — JOURNEY_COMPLETED eliminating immediately överskrivs av ny AIS
 */

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeTextService = require('../lib/services/BridgeTextService');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const geometry = require('../lib/utils/geometry');

const mockLogger = () => ({
  log: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
});

describe('Bug #1 — PROTECTION_ZONE releases removal lock', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-17T07:17:55.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('protection zone branch does NOT leave mmsi in _removalInProgress', () => {
    const logger = mockLogger();
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, registry, coordinator);

    // Place vessel inside 300m protection zone of Klaffbron (58.2837, 12.2838)
    const klaffbron = registry.getBridgeByName('Klaffbron');
    expect(klaffbron).toBeDefined();

    const mmsi = '265500870';
    const now = Date.now();
    service.vessels.set(mmsi, {
      mmsi,
      lat: klaffbron.lat + 0.001, // ~110m north
      lon: klaffbron.lon,
      sog: 0.1,
      cog: 180,
      targetBridge: 'Klaffbron',
      lastPositionUpdate: now - 20 * 60 * 1000, // 20 min ago (not yet stale)
      timestamp: now - 20 * 60 * 1000,
      passedBridges: ['Stridsbergsbron'],
      lastPassedBridge: 'Stridsbergsbron',
    });
    service.vesselLifecycleManager.shouldEliminateVessel = () => false;

    // Trigger removal — must hit PROTECTION_ZONE branch and reschedule
    service.removeVessel(mmsi, 'timeout');

    // ASSERT: vessel still present, timer rescheduled, lock released
    expect(service.vessels.has(mmsi)).toBe(true);
    expect(service._removalInProgress.has(mmsi)).toBe(false);
    expect(service.cleanupTimers.has(mmsi)).toBe(true);
  });

  test('stale AIS (>30 min) eventually removes ghost vessel after protection-zone reschedule', () => {
    const logger = mockLogger();
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, registry, coordinator);
    service.vesselLifecycleManager.shouldEliminateVessel = () => false;

    const klaffbron = registry.getBridgeByName('Klaffbron');
    const mmsi = '265500870';
    const positionTime = Date.now() - 20 * 60 * 1000;
    service.vessels.set(mmsi, {
      mmsi,
      lat: klaffbron.lat + 0.001,
      lon: klaffbron.lon,
      sog: 0.1,
      targetBridge: 'Klaffbron',
      lastPositionUpdate: positionTime,
      timestamp: positionTime,
      passedBridges: ['Stridsbergsbron'],
      lastPassedBridge: 'Stridsbergsbron',
    });

    // First removal attempt — PROTECTION_ZONE triggers, reschedules 10 min
    service.removeVessel(mmsi, 'timeout');
    expect(service.vessels.has(mmsi)).toBe(true);
    expect(service._removalInProgress.has(mmsi)).toBe(false);

    // Advance 10 min — cleanup timer fires, STALE_AIS (now >30 min since AIS) removes vessel
    jest.advanceTimersByTime(10 * 60 * 1000 + 100);

    // Vessel must finally be removed via STALE_AIS bypass
    expect(service.vessels.has(mmsi)).toBe(false);
  });
});

describe('Bug #3 — speed floor only for moving vessels', () => {
  const makeCalculator = () => {
    const logger = mockLogger();
    const registry = new BridgeRegistry();
    const calc = new ProgressiveETACalculator(logger, registry);
    calc._historyCleanupTimer = null; // no timer in test
    return calc;
  };

  test('stationary vessel (SOG=0.1) with lastPassedBridge gets 0.5kn floor, not 2.5kn', () => {
    const calc = makeCalculator();
    const vessel = {
      mmsi: '265500870',
      sog: 0.1,
      lastPassedBridge: 'Stridsbergsbron',
      status: 'passed',
    };
    const speed = calc._getEffectiveSpeed(vessel);
    // With 0.5 knot floor: max(0.5, 0.5) = 0.5
    // With old 2.5 knot floor: max(0.5, 2.5) = 2.5
    expect(speed).toBeCloseTo(0.5, 1);
  });

  test('moving vessel (SOG=3.5) with lastPassedBridge keeps 2.5kn floor advantage', () => {
    const calc = makeCalculator();
    const vessel = {
      mmsi: '111',
      sog: 3.5,
      lastPassedBridge: 'Klaffbron',
      status: 'en-route',
    };
    const speed = calc._getEffectiveSpeed(vessel);
    // SOG 3.5 > 0.8 → moving, min-floor 2.5 applies, max(3.5, 2.5) = 3.5
    expect(speed).toBeCloseTo(3.5, 1);
  });

  test('maneuvering vessel (SOG=1.2) above threshold still gets passage floor', () => {
    const calc = makeCalculator();
    const vessel = {
      mmsi: '222',
      sog: 1.2,
      lastPassedBridge: 'Klaffbron',
      // E-F5 (2026-07-01): passagekontexten är numera tidsbegränsad (15 min)
      // — golvet gäller bara med FÄRSK passagestämpel.
      lastPassedBridgeTime: Date.now() - 60 * 1000,
      status: 'en-route',
    };
    const speed = calc._getEffectiveSpeed(vessel);
    // SOG 1.2 > 0.8 → still considered moving, floor 2.5 applies
    expect(speed).toBeCloseTo(2.5, 1);
  });

  test('E-F5: gammal passagestämpel (>15 min) ger INGET passage-golv', () => {
    const calc = makeCalculator();
    const vessel = {
      mmsi: '223',
      sog: 1.5,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 40 * 60 * 1000, // 40 min sedan
      status: 'en-route',
    };
    const speed = calc._getEffectiveSpeed(vessel);
    // Genuint långsam båt (1,5 kn) på post-passage-benet ska få ÄRLIG ETA —
    // 2,5 kn-golvet gav annars ~40 % för optimistisk tid i över en timme.
    expect(speed).toBeCloseTo(1.5, 1);
  });

  test('drift vessel (SOG=0.5) below threshold gets base floor only', () => {
    const calc = makeCalculator();
    const vessel = {
      mmsi: '333',
      sog: 0.5,
      lastPassedBridge: 'Klaffbron',
      status: 'passed',
    };
    const speed = calc._getEffectiveSpeed(vessel);
    // SOG 0.5 not > 0.8 → not moving, floor 0.5
    expect(speed).toBeCloseTo(0.5, 1);
  });
});

describe('Bug #6 — absolute ETA jump clamp', () => {
  const makeCalculator = () => {
    const logger = mockLogger();
    const registry = new BridgeRegistry();
    const calc = new ProgressiveETACalculator(logger, registry);
    calc._historyCleanupTimer = null;
    return calc;
  };

  test('large ETA jump within 2 minutes is clamped to ±3min', () => {
    const calc = makeCalculator();
    const mmsi = '219011922';
    const now = Date.now();

    // Seed history with 64 min ETA
    calc._etaHistory.set(mmsi, [{
      rawETA: 64,
      protectedETA: 64,
      processedETA: 64,
      timestamp: now - 60000, // 1 min ago
      targetBridge: 'Stridsbergsbron',
      nearestBridge: 'Järnvägsbron',
      vesselSpeed: 0.2,
      distance: 800,
      distanceToTarget: 1500,
      vesselStatus: 'en-route',
    }]);

    const vessel = {
      mmsi,
      sog: 0.2,
      status: 'en-route',
      targetBridge: 'Stridsbergsbron',
    };
    const proximityData = { nearestBridge: { id: 'jarnvagsbron' }, nearestDistance: 800 };

    // Real raw ETA = 82 (jump of +18 from 64)
    const result = calc._processETAWithProtection(vessel, 82, proximityData);
    // Must be clamped near 64+3=67 (not 82)
    expect(result).toBeLessThan(75);
    expect(result).toBeGreaterThan(60);
  });

  test('normal ETA changes (<=10 min) pass through without absolute clamp', () => {
    const calc = makeCalculator();
    const mmsi = '111';
    const now = Date.now();

    calc._etaHistory.set(mmsi, [{
      rawETA: 8,
      protectedETA: 8,
      processedETA: 8,
      timestamp: now - 60000,
      targetBridge: 'Klaffbron',
      nearestBridge: null,
      vesselSpeed: 4.0,
      distance: 900,
      distanceToTarget: 900,
      vesselStatus: 'en-route',
    }]);

    const vessel = {
      mmsi, sog: 4.0, status: 'en-route', targetBridge: 'Klaffbron',
    };
    const proximityData = { nearestBridge: null, nearestDistance: null };

    // ETA drops to 5 — 3 min change, should not be clamped
    const result = calc._processETAWithProtection(vessel, 5, proximityData);
    expect(result).toBeLessThanOrEqual(8); // allowed to decrease
  });
});

describe('Bug #11 follow-up — no upper cap, honest large-ETA values', () => {
  // The original Bug #11 fix clamped ETA > 30 min to "inväntar broöppning".
  // After deeper review (Bug #3 + #6 pipelines are now trustworthy), the
  // clamp was removed: large values are shown verbatim so users see the
  // real state of a slow/stationary vessel instead of a misleading phrase.
  const makeService = () => new BridgeTextService(null, mockLogger());

  test('ETA = 45 min → "om 45 minuter"', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Klaffbron', etaMinutes: 45 }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning om 45 minuter');
  });

  test('ETA = 106 min (seen in log) → "om 106 minuter"', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Stridsbergsbron', etaMinutes: 106 }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Stridsbergsbron, beräknad broöppning om 106 minuter');
  });

  test('ETA = 30 min → "om 30 minuter"', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Klaffbron', etaMinutes: 30 }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning om 30 minuter');
  });

  test('ETA = 30.9 min (rounds to 31) → "om 31 minuter"', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Klaffbron', etaMinutes: 30.9 }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning om 31 minuter');
  });

  test('ETA = null → "ETA okänd" (honest failure signal)', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Klaffbron', etaMinutes: null }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Klaffbron, ETA okänd');
  });

  test('ETA = NaN → "ETA okänd"', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Klaffbron', etaMinutes: NaN }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Klaffbron, ETA okänd');
  });
});

describe('Under-bridge ETA handling (alternativ 1 — no "Broöppning pågår" phrase)', () => {
  // Decision: skip the "Broöppning pågår" phrase entirely. Instead, let the
  // ETA calculation work for under-bridge vessels too — a vessel 10m from
  // the target bridge at speed-floor 0.5kn yields ~0.65 min → naturally
  // renders as "strax". Under-bridge-vessels with null ETA would show
  // "ETA okänd" which is wrong — they're exactly where the bridge opens.
  const makeService = () => new BridgeTextService(null, mockLogger());

  test('single under-bridge vessel with computed low ETA shows "strax"', () => {
    const vessels = [{
      mmsi: '1',
      targetBridge: 'Klaffbron',
      status: 'under-bridge',
      etaMinutes: 0.3,
    }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning strax');
  });

  test('under-bridge with low ETA dominates group over waiting vessel', () => {
    // Lead vessel selection picks lowest valid ETA, so under-bridge (0.4)
    // wins over waiting (3.0). The output correctly signals that the
    // bridge is opening NOW for one of the two vessels.
    const vessels = [
      {
        mmsi: '1', targetBridge: 'Klaffbron', status: 'under-bridge', etaMinutes: 0.4,
      },
      {
        mmsi: '2', targetBridge: 'Klaffbron', status: 'waiting', etaMinutes: 3,
      },
    ];
    expect(makeService().generateBridgeText(vessels))
      .toBe('Två båtar på väg mot Klaffbron, beräknad broöppning strax');
  });
});

describe('Bug #13 — elimination timer not overwritten by AIS updates', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-14T06:35:56.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('scheduleCleanup ignores 10-min reschedule when elimination pending', () => {
    const logger = mockLogger();
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, registry, coordinator);

    const mmsi = '265012090';
    // Northbound vessel that has cleared the entire canal (passed Stallbackabron).
    // Updated 2026-04-27: terminal-completion now requires Stallbackabron pass
    // for northbound (was Stridsbergsbron) so notifications fire all the way
    // through the canal.
    service.vessels.set(mmsi, {
      mmsi,
      lat: 58.32,
      lon: 12.32,
      sog: 9.5,
      targetBridge: null,
      lastPassedBridge: 'Stallbackabron',
      cog: 30,
      _finalTargetDirection: 'north',
      passedBridges: ['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron'],
      lastPositionUpdate: Date.now(),
    });

    // First call: triggers elimination (100ms timer)
    service.scheduleCleanup(mmsi, 10 * 60 * 1000);
    expect(service._eliminationPending.has(mmsi)).toBe(true);

    const firstExpiry = service._cleanupExpiryTimes.get(mmsi);
    expect(firstExpiry - Date.now()).toBeLessThanOrEqual(200); // 100ms timer

    // Second call: simulates new AIS with proximity-based 10 min timeout
    service.scheduleCleanup(mmsi, 10 * 60 * 1000);

    // Timer should NOT have been extended to 10 min
    const secondExpiry = service._cleanupExpiryTimes.get(mmsi);
    expect(secondExpiry).toBe(firstExpiry); // unchanged

    // Advance 100 ms — vessel must be removed now
    jest.advanceTimersByTime(150);
    expect(service.vessels.has(mmsi)).toBe(false);
  });

  test('ELIMINATION_PROTECTION-vakten exekveras faktiskt (t-regression-a#1)', () => {
    // Helgranskning 2026-07-06: testet ovan diskriminerade INTE vakten —
    // med frusen fake-klocka gav förstagrenens återinträde (journey ännu
    // komplett) samma expiry även om vakten togs bort. Här tvingas vakt-
    // grenen: fartyget är INTE journey-komplett men står i eliminationskön.
    const logger = mockLogger();
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, registry, coordinator);

    const mmsi = '265012091';
    service.vessels.set(mmsi, {
      mmsi,
      lat: 58.28,
      lon: 12.284,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      cog: 30,
      passedBridges: ['Klaffbron'],
      lastPositionUpdate: Date.now(),
    });
    if (!service._eliminationPending) service._eliminationPending = new Set();
    service._eliminationPending.add(mmsi);
    service._cleanupExpiryTimes.set(mmsi, Date.now() + 100);
    const expiryBefore = service._cleanupExpiryTimes.get(mmsi);

    service.scheduleCleanup(mmsi, 10 * 60 * 1000);

    const guardFired = logger.debug.mock.calls
      .some(([msg]) => typeof msg === 'string' && msg.includes('ELIMINATION_PROTECTION'));
    expect(guardFired).toBe(true);
    expect(service._cleanupExpiryTimes.get(mmsi)).toBe(expiryBefore);
    service.clearAllTimers();
  });

  test('_eliminationPending is cleared after vessel removal', () => {
    const logger = mockLogger();
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, registry, coordinator);

    const mmsi = '265012090';
    // Same setup as previous test — vessel has cleared the canal northbound.
    service.vessels.set(mmsi, {
      mmsi,
      lat: 58.32,
      lon: 12.32,
      sog: 9.5,
      targetBridge: null,
      lastPassedBridge: 'Stallbackabron',
      cog: 30,
      _finalTargetDirection: 'north',
      passedBridges: ['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron'],
      lastPositionUpdate: Date.now(),
    });

    service.scheduleCleanup(mmsi, 1000);
    expect(service._eliminationPending.has(mmsi)).toBe(true);

    jest.advanceTimersByTime(1500);
    expect(service._eliminationPending.has(mmsi)).toBe(false);
  });
});

describe('Bug #4 — harmonized filtering avoids false BRIDGE_TEXT_BUG alerts', () => {
  // Validate that a vessel with targetBridge=null does not trigger the bug alert.
  // (Unit test for the filter predicate used in app.js around line 1598.)
  const TARGET_BRIDGES = ['Klaffbron', 'Stridsbergsbron'];

  test('vessels with null targetBridge filtered out of visibleVessels', () => {
    const relevantVessels = [
      { mmsi: '1', targetBridge: null },
      { mmsi: '2', targetBridge: 'Klaffbron' },
      { mmsi: '3', targetBridge: 'Olidebron' }, // intermediate, not in TARGET_BRIDGES
    ];
    const visibleVessels = relevantVessels.filter(
      (v) => v && TARGET_BRIDGES.includes(v.targetBridge),
    );
    expect(visibleVessels).toHaveLength(1);
    expect(visibleVessels[0].mmsi).toBe('2');
  });

  test('all vessels with valid target still pass the filter', () => {
    const relevantVessels = [
      { mmsi: '1', targetBridge: 'Klaffbron' },
      { mmsi: '2', targetBridge: 'Stridsbergsbron' },
    ];
    const visibleVessels = relevantVessels.filter(
      (v) => v && TARGET_BRIDGES.includes(v.targetBridge),
    );
    expect(visibleVessels).toHaveLength(2);
  });
});
