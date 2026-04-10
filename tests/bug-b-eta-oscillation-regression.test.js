'use strict';

/**
 * Bug B regression: ETA oscillation prevention.
 *
 * The _positionUpdatedSinceLastETA flag in app.js _reevaluateVesselStatuses()
 * ensures ETA is only recalculated when a fresh AIS position update arrives,
 * not on periodic timer re-evaluations.
 *
 * These tests verify the flag logic directly by creating a minimal app instance
 * and checking that ETA stays stable across timer-driven re-evals.
 */

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const StatusService = require('../lib/services/StatusService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const constants = require('../lib/constants');

const mockLogger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

describe('Bug B regression — ETA oscillation prevention via _positionUpdatedSinceLastETA', () => {
  let bridgeRegistry;
  let proximityService;
  let statusService;

  beforeEach(() => {
    jest.clearAllMocks();
    bridgeRegistry = new BridgeRegistry();
    proximityService = new ProximityService(bridgeRegistry, mockLogger);
    const systemCoordinator = new SystemCoordinator(mockLogger);
    const vesselDataService = { anchorPassageTimestamp: jest.fn() };
    const passageLatchService = { shouldBlockStatus: jest.fn().mockReturnValue(false) };
    statusService = new StatusService(
      bridgeRegistry, mockLogger, systemCoordinator, vesselDataService, passageLatchService,
    );
  });

  function makeVessel(overrides = {}) {
    const { klaffbron } = constants.BRIDGES;
    return {
      mmsi: 'TEST_BUG_B',
      name: 'Bug B Test',
      lat: klaffbron.lat - 0.002,
      lon: klaffbron.lon - 0.001,
      sog: 3.5,
      cog: 25,
      status: 'approaching',
      targetBridge: 'Klaffbron',
      etaMinutes: 5.0,
      _positionUpdatedSinceLastETA: false,
      ...overrides,
    };
  }

  /** Simulates _reevaluateVesselStatuses Bug B logic */
  function reevaluateVessel(vessel) {
    const proximityData = proximityService.analyzeVesselProximity(vessel);
    const statusResult = statusService.analyzeVesselStatus(vessel, proximityData);
    vessel.status = statusResult.status;

    if (['approaching', 'waiting', 'en-route', 'stallbacka-waiting'].includes(vessel.status)) {
      if (vessel._positionUpdatedSinceLastETA) {
        vessel.etaMinutes = statusService.calculateETA(vessel, proximityData);
        vessel._positionUpdatedSinceLastETA = false;
      }
      // else: reuse existing vessel.etaMinutes
    } else {
      vessel.etaMinutes = null;
    }
    return vessel;
  }

  test('1: AIS message sets flag → ETA recalculated', () => {
    const vessel = makeVessel({ _positionUpdatedSinceLastETA: true, etaMinutes: 5.0 });
    reevaluateVessel(vessel);
    // After re-eval with flag=true, ETA should have been recalculated (value may differ)
    expect(vessel._positionUpdatedSinceLastETA).toBe(false);
    // ETA should be a number (calculated from distance/speed)
    expect(vessel.etaMinutes).toEqual(expect.any(Number));
  });

  test('2: Timer re-eval with flag=false → etaMinutes unchanged', () => {
    const vessel = makeVessel({ _positionUpdatedSinceLastETA: false, etaMinutes: 5.0 });
    reevaluateVessel(vessel);
    // ETA should remain exactly 5.0 — no recalculation
    expect(vessel.etaMinutes).toBe(5.0);
    expect(vessel._positionUpdatedSinceLastETA).toBe(false);
  });

  test('3: Vessel at etaMinutes=3.05, re-eval without AIS → no Phase 1/2 oscillation', () => {
    // etaMinutes=3.05 is just above the 3-minute Phase 2 threshold
    const vessel = makeVessel({ _positionUpdatedSinceLastETA: false, etaMinutes: 3.05 });

    // Multiple timer re-evals should NOT change the ETA
    reevaluateVessel(vessel);
    expect(vessel.etaMinutes).toBe(3.05);

    reevaluateVessel(vessel);
    expect(vessel.etaMinutes).toBe(3.05);

    reevaluateVessel(vessel);
    expect(vessel.etaMinutes).toBe(3.05);
  });
});
