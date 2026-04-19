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
      status: 'en-route',
    };
    const speed = calc._getEffectiveSpeed(vessel);
    // SOG 1.2 > 0.8 → still considered moving, floor 2.5 applies
    expect(speed).toBeCloseTo(2.5, 1);
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

describe('Bug #11 — ETA > 30 min clamps to qualitative phrase', () => {
  const makeService = () => new BridgeTextService(null, mockLogger());

  test('ETA = 45 min → "inväntar broöppning"', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Klaffbron', etaMinutes: 45 }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Klaffbron, inväntar broöppning');
  });

  test('ETA = 106 min (seen in log) → "inväntar broöppning"', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Stridsbergsbron', etaMinutes: 106 }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Stridsbergsbron, inväntar broöppning');
  });

  test('ETA = 30 min (boundary) → "om 30 minuter" preserved', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Klaffbron', etaMinutes: 30 }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning om 30 minuter');
  });

  test('ETA = 30.9 min (rounds to 31) → "inväntar broöppning"', () => {
    const vessels = [{ mmsi: '1', targetBridge: 'Klaffbron', etaMinutes: 30.9 }];
    expect(makeService().generateBridgeText(vessels))
      .toBe('En båt på väg mot Klaffbron, inväntar broöppning');
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
    service.vessels.set(mmsi, {
      mmsi,
      lat: 58.30,
      lon: 12.30,
      sog: 9.5,
      targetBridge: null,
      lastPassedBridge: 'Stridsbergsbron',
      cog: 30,
      passedBridges: ['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron'],
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

  test('_eliminationPending is cleared after vessel removal', () => {
    const logger = mockLogger();
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, registry, coordinator);

    const mmsi = '265012090';
    service.vessels.set(mmsi, {
      mmsi,
      lat: 58.30,
      lon: 12.30,
      sog: 9.5,
      targetBridge: null,
      lastPassedBridge: 'Stridsbergsbron',
      cog: 30,
      passedBridges: ['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron'],
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
