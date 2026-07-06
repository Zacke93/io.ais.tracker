'use strict';

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES } = require('../lib/constants');

describe('VesselDataService — re-entry prevention after completed journey (Bug 3)', () => {
  let vesselDataService;
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };
  const bridgeRegistry = new BridgeRegistry();

  // Minimal systemCoordinator mock
  const systemCoordinator = {
    removeVessel: jest.fn(),
    statusStabilizer: { removeVessel: jest.fn() },
    analyzePosition: jest.fn().mockReturnValue(null),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    vesselDataService = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
  });

  afterEach(() => {
    vesselDataService.clearAllTimers();
    delete global.__TEST_MODE__;
  });

  const MMSI = '265999100';
  const OTHER_MMSI = '265999200';

  // Helper: simulate a vessel that has been tracked
  function addTestVessel(mmsi, overrides = {}) {
    const vessel = {
      mmsi,
      lat: BRIDGES.klaffbron.lat,
      lon: BRIDGES.klaffbron.lon,
      sog: 4,
      cog: 200,
      name: 'TEST VESSEL',
      targetBridge: 'Klaffbron',
      _routeDirection: 'south',
      lastPositionUpdate: Date.now(),
      timestamp: Date.now(),
      ...overrides,
    };
    vesselDataService.vessels.set(mmsi, vessel);
    return vessel;
  }

  // --- Test 1: Completed journey + new AIS < 10 min → no target ---
  test('vessel with recently completed journey is blocked from target assignment within 10 min', () => {
    // Add and remove vessel with journey-completed reason
    addTestVessel(MMSI);
    vesselDataService.removeVessel(MMSI, 'journey-completed');

    // Verify completed journey is recorded
    expect(vesselDataService._completedJourneys.has(MMSI)).toBe(true);

    // Now _shouldAssignTargetBridge should return false
    const newVessel = {
      mmsi: MMSI,
      lat: BRIDGES.stridsbergsbron.lat - 0.003,
      lon: BRIDGES.stridsbergsbron.lon,
      sog: 3,
      cog: 200,
    };
    const shouldAssign = vesselDataService._shouldAssignTargetBridge(newVessel, null);
    expect(shouldAssign).toBe(false);
  });

  // --- Test 2: Completed journey + new AIS > 10 min → new target OK ---
  test('vessel is allowed new target assignment after 10 min cooldown expires', () => {
    addTestVessel(MMSI);
    vesselDataService.removeVessel(MMSI, 'passed-final-bridge');

    // Simulate 11 minutes elapsed
    const record = vesselDataService._completedJourneys.get(MMSI);
    record.completedAt = Date.now() - (11 * 60 * 1000);

    const newVessel = {
      mmsi: MMSI,
      lat: BRIDGES.stridsbergsbron.lat - 0.003,
      lon: BRIDGES.stridsbergsbron.lon,
      sog: 4,
      cog: 200,
    };
    const shouldAssign = vesselDataService._shouldAssignTargetBridge(newVessel, null);
    // Helgranskning 2026-07-06 (t-lifecycle#2): assertera RESULTATET —
    // shouldAssign beräknades men prövades aldrig. REENTRY_BLOCK-loggen får
    // heller inte förekomma (cooldownen har löpt ut).
    expect(shouldAssign).toBe(true);
    const reentryBlocked = logger.debug.mock.calls
      .some(([msg]) => typeof msg === 'string' && msg.includes('REENTRY_BLOCK'));
    expect(reentryBlocked).toBe(false);
    // Verify the completed journey record was cleaned up
    expect(vesselDataService._completedJourneys.has(MMSI)).toBe(false);
  });

  // --- Test 3: Different MMSI works normally ---
  test('other MMSI is not affected by completed journey of different vessel', () => {
    addTestVessel(MMSI);
    vesselDataService.removeVessel(MMSI, 'journey-completed');

    // Different vessel should not be blocked
    const otherVessel = {
      mmsi: OTHER_MMSI,
      lat: BRIDGES.stridsbergsbron.lat - 0.003,
      lon: BRIDGES.stridsbergsbron.lon,
      sog: 4,
      cog: 200,
    };
    // Should not be blocked by re-entry prevention for different MMSI
    expect(vesselDataService._completedJourneys.has(OTHER_MMSI)).toBe(false);
    const result = vesselDataService._shouldAssignTargetBridge(otherVessel, null);
    // Helgranskning 2026-07-06 (t-lifecycle#1): assertera resultatet OCH att
    // re-entry-blocket specifikt inte var orsaken — tidigare kastades result
    // och samma _completedJourneys-assertion upprepades två gånger.
    expect(result).toBe(true);
    const reentryBlocked = logger.debug.mock.calls
      .some(([msg]) => typeof msg === 'string' && msg.includes(`REENTRY_BLOCK] ${OTHER_MMSI}`));
    expect(reentryBlocked).toBe(false);
  });

  // --- Test 4: Cleanup of completed records after 15 min ---
  test('completed journey records are cleaned up after 15 minutes', () => {
    addTestVessel(MMSI);
    vesselDataService.removeVessel(MMSI, 'journey-completed');

    // Simulate record that is 16 minutes old
    const record = vesselDataService._completedJourneys.get(MMSI);
    record.completedAt = Date.now() - (16 * 60 * 1000);

    // Trigger cleanup validation
    vesselDataService._validateCleanupIntegrity();

    // Record should be cleaned up
    expect(vesselDataService._completedJourneys.has(MMSI)).toBe(false);
  });

  // --- Test 5: Regular timeout removal does NOT record completed journey ---
  test('regular timeout removal does not record completed journey', () => {
    addTestVessel(MMSI, {
      lat: BRIDGES.stallbackabron.lat + 0.01, // far from all bridges
      lon: BRIDGES.stallbackabron.lon,
    });
    vesselDataService.removeVessel(MMSI, 'timeout');

    // Should NOT have a completed journey record
    expect(vesselDataService._completedJourneys.has(MMSI)).toBe(false);
  });
});
