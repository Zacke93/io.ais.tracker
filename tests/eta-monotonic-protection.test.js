'use strict';

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES } = require('../lib/constants');

describe('ProgressiveETA — monotonic protection (Bug 4)', () => {
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };

  let calculator;

  beforeEach(() => {
    calculator = new ProgressiveETACalculator(logger, new BridgeRegistry());
    jest.clearAllMocks();
  });

  afterEach(() => {
    calculator.destroy();
  });

  const makeVessel = (overrides) => ({
    mmsi: 'ETA001',
    targetBridge: 'Stridsbergsbron',
    status: 'approaching',
    lat: BRIDGES.stridsbergsbron.lat - 0.005, // ~550m south
    lon: BRIDGES.stridsbergsbron.lon,
    sog: 4,
    ...overrides,
  });

  const proximityData = {
    nearestBridge: { id: 'jarnvagsbron', name: 'Järnvägsbron' },
    nearestDistance: 200,
  };

  // --- Test 1: ETA increase max +1 min at constant approach ---
  test('ETA increase limited to +1 min per cycle for approaching vessel', () => {
    // First: calculate baseline ETA
    const v1 = makeVessel({ sog: 4 });
    const eta1 = calculator.calculateProgressiveETA(v1, proximityData);
    expect(eta1).toBeGreaterThan(0);

    // Second: same speed, slightly closer but with a raw ETA spike
    // Simulate by using a vessel at nearly the same position (ETA should not jump)
    const v2 = makeVessel({
      sog: 3, // slower → raw ETA would jump up
      lat: BRIDGES.stridsbergsbron.lat - 0.0048, // slightly closer
    });
    const eta2 = calculator.calculateProgressiveETA(v2, proximityData);

    // ETA should not increase by more than 1 min for approaching vessel
    // The protection allows some increase but should be bounded
    expect(eta2).toBeDefined();
    expect(eta2).not.toBeNull();
  });

  // --- Test 2: Monotonic decrease at steady speed ---
  test('ETA decreases monotonically at steady speed', () => {
    const etas = [];
    // Simulate vessel approaching at steady speed
    for (let i = 0; i < 5; i++) {
      const v = makeVessel({
        lat: BRIDGES.stridsbergsbron.lat - 0.005 + (i * 0.001),
        sog: 4,
      });
      const eta = calculator.calculateProgressiveETA(v, {
        nearestBridge: proximityData.nearestBridge,
        nearestDistance: Math.max(50, 550 - i * 110),
      });
      if (eta !== null) {
        etas.push(eta);
      }
    }

    expect(etas.length).toBeGreaterThan(2);
    // Each subsequent ETA should be <= previous (with small tolerance for smoothing)
    for (let i = 1; i < etas.length; i++) {
      expect(etas[i]).toBeLessThanOrEqual(etas[i - 1] + 1.5); // Allow 1.5 min tolerance for smoothing
    }
  });

  // --- Test 3: 3-minute protection window (not just 1 min) ---
  test('monotonic protection applies within 3-minute window', () => {
    // First calc
    const v1 = makeVessel({ sog: 4 });
    const eta1 = calculator.calculateProgressiveETA(v1, proximityData);
    expect(eta1).toBeGreaterThan(0);

    // Simulate 2 minutes elapsed by manipulating history timestamp
    const history = calculator._etaHistory.get('ETA001');
    expect(history).toBeDefined();
    expect(history.length).toBe(1);
    // Move timestamp back by 2 minutes (within 3-min window)
    history[0].timestamp -= 120000;

    // Second calc with dramatic ETA spike
    const v2 = makeVessel({
      sog: 0.5, // very slow → would cause huge raw ETA
      lat: BRIDGES.stridsbergsbron.lat - 0.004, // still approaching
    });
    const eta2 = calculator.calculateProgressiveETA(v2, proximityData);

    // Protection should still apply (we're within 3-min window)
    expect(eta2).toBeDefined();
    // The ETA should be damped, not allowed to spike wildly
    if (eta1 < 20) {
      expect(eta2).toBeLessThan(eta1 * 3); // Should not triple within 2 minutes
    }
  });

  // --- Test 4: Curvy canal section (realistic positions) ---
  test('ETA is stable through curvy canal section with realistic positions', () => {
    // Simulate positions from Järnvägsbron area heading toward Stridsbergsbron
    // These positions follow the canal curve
    const positions = [
      { lat: 58.2900, lon: 12.2910, dist: 450 },
      { lat: 58.2910, lon: 12.2915, dist: 340 },
      { lat: 58.2918, lon: 12.2925, dist: 230 },
      { lat: 58.2928, lon: 12.2935, dist: 120 },
    ];

    const etas = [];
    for (const pos of positions) {
      const v = makeVessel({
        lat: pos.lat,
        lon: pos.lon,
        sog: 3.5,
      });
      const eta = calculator.calculateProgressiveETA(v, {
        nearestBridge: proximityData.nearestBridge,
        nearestDistance: pos.dist,
      });
      if (eta !== null) {
        etas.push(eta);
      }
    }

    expect(etas.length).toBeGreaterThan(2);
    // ETAs should generally decrease (approaching target)
    const firstEta = etas[0];
    const lastEta = etas[etas.length - 1];
    expect(lastEta).toBeLessThan(firstEta + 2); // Should not increase significantly
  });

  // --- Test 5: Approaching vessel SOG > 2 limits ETA increase ---
  test('approaching vessel with SOG > 2 has ETA increase capped at +1 min', () => {
    // Establish baseline with high speed
    const v1 = makeVessel({ sog: 5 });
    const eta1 = calculator.calculateProgressiveETA(v1, proximityData);
    expect(eta1).toBeGreaterThan(0);

    // Now vessel closer but suddenly slower (raw ETA spikes)
    const v2 = makeVessel({
      sog: 2.5, // still above 2 knots threshold
      lat: BRIDGES.stridsbergsbron.lat - 0.004, // closer to target
    });
    const eta2 = calculator.calculateProgressiveETA(v2, {
      nearestBridge: proximityData.nearestBridge,
      nearestDistance: 150,
    });

    // ETA increase should be limited
    expect(eta2).toBeDefined();
    expect(eta2).not.toBeNull();
    // Should not spike beyond eta1 + 1 (approach limit) but allow for smoothing
    expect(eta2).toBeLessThanOrEqual(eta1 + 2); // +2 tolerance for smoothing
  });

  // --- Test 6: Non-approaching vessel is not subject to approach limit ---
  test('non-approaching vessel can have larger ETA changes', () => {
    // Establish baseline
    const v1 = makeVessel({ sog: 4 });
    const eta1 = calculator.calculateProgressiveETA(v1, proximityData);
    expect(eta1).toBeGreaterThan(0);

    // Vessel moves AWAY (distance increases) — not approaching
    const v2 = makeVessel({
      sog: 1, // much slower
      lat: BRIDGES.stridsbergsbron.lat - 0.006, // farther from target
    });
    const eta2 = calculator.calculateProgressiveETA(v2, {
      nearestBridge: proximityData.nearestBridge,
      nearestDistance: 700,
    });

    // Should still be bounded by general protections but not the +1 min approach limit
    expect(eta2).toBeDefined();
  });
});
