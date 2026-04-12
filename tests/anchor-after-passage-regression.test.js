'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES } = require('../lib/constants');

/**
 * Regression tests for the "HMS ARCTURUS anchor bug" (2026-03-28).
 *
 * Two military vessels passed Klaffbron and anchored ~220m north of the bridge
 * for 12 hours. Bridge text was stuck showing "inväntar broöppning vid Klaffbron"
 * and "ETA 21 minuter" for the entire duration.
 *
 * Root causes:
 *   Fix A: Confirmed passage was deferred by protection zone, creating a
 *          _pendingTarget that never resolved because the vessel stopped.
 *   Fix B: ACCELERATED pathway re-assigned Klaffbron as target to a vessel
 *          that already passed it (passedBridges not checked).
 */
describe('Anchor after passage regression (HMS ARCTURUS bug)', () => {
  let vesselDataService;
  let mockNow;
  const realDateNow = Date.now;

  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 2, 28, 18, 0, 0).getTime();
    Date.now = () => mockNow;

    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    vesselDataService = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
    vesselDataService.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    vesselDataService.clearAllTimers();
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  const MMSI = '265591620';

  // Position 220m north of Klaffbron (where HMS ARCTURUS anchored)
  const ANCHOR_POS = { lat: 58.2859, lon: 12.2856 };

  // -------------------------------------------------------------------
  // Fix A: Confirmed passage → immediate transition
  // -------------------------------------------------------------------

  test('Fix A: vessel that passed target bridge gets immediate transition even within protection zone', () => {
    // Simulate northbound approach to Klaffbron via several AIS updates
    const aisUpdates = [
      // Approaching Klaffbron from ~500m south
      {
        lat: 58.27960, lon: 12.28150, sog: 5.9, cog: 17,
      },
      // ~350m from Klaffbron
      {
        lat: 58.28100, lon: 12.28280, sog: 6.0, cog: 17,
      },
      // ~170m from Klaffbron (within protection zone)
      {
        lat: 58.28260, lon: 12.28356, sog: 6.0, cog: 10,
      },
      // ~21m from Klaffbron (just passing)
      {
        lat: 58.28428, lon: 12.28404, sog: 6.1, cog: 8,
      },
      // Just past Klaffbron (~200m north, within protection zone)
      {
        lat: 58.28586, lon: 12.28538, sog: 0.9, cog: 154,
      },
    ];

    let vessel;
    for (let i = 0; i < aisUpdates.length; i++) {
      mockNow += 67 * 1000; // ~67 seconds between updates
      vessel = vesselDataService.updateVessel(MMSI, {
        ...aisUpdates[i],
        name: 'HMS ARCTURUS',
      });
    }

    // After passing Klaffbron and stopping just north:
    // The target should have transitioned to Stridsbergsbron (next northbound target)
    // NOT stayed as Klaffbron or been deferred to a _pendingTarget
    expect(vessel.passedBridges).toContain('Klaffbron');
    expect(vessel.targetBridge).not.toBe('Klaffbron');
    // Target should be Stridsbergsbron or null (if detected as final), not Klaffbron
    if (vessel.targetBridge) {
      expect(vessel.targetBridge).toBe('Stridsbergsbron');
    }
    expect(vessel._pendingTarget).toBeNull();
  });

  // -------------------------------------------------------------------
  // Fix B: Stationary post-passage vessel blocked from target assignment
  // -------------------------------------------------------------------

  test('Fix B: stationary vessel with passedBridges should NOT get new target via ACCELERATED', () => {
    // Vessel that has passed Klaffbron and is now anchored at SOG=0
    const newVessel = {
      mmsi: MMSI,
      lat: ANCHOR_POS.lat,
      lon: ANCHOR_POS.lon,
      sog: 0,
      cog: 72,
      passedBridges: ['Olidebron', 'Klaffbron'],
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 300000,
    };

    const shouldAssign = vesselDataService._shouldAssignTargetBridge(newVessel, null);
    expect(shouldAssign).toBe(false);
  });

  test('Fix B: slowly drifting post-passage vessel (SOG=0.2) also blocked', () => {
    const newVessel = {
      mmsi: MMSI,
      lat: ANCHOR_POS.lat,
      lon: ANCHOR_POS.lon,
      sog: 0.2,
      cog: 72,
      passedBridges: ['Olidebron'],
      lastPassedBridge: 'Olidebron',
    };

    const shouldAssign = vesselDataService._shouldAssignTargetBridge(newVessel, null);
    expect(shouldAssign).toBe(false);
  });

  // -------------------------------------------------------------------
  // Regression guard: legitimate waiting vessel must NOT be blocked
  // -------------------------------------------------------------------

  test('Regression guard: vessel waiting at first bridge (empty passedBridges) SHOULD get target', () => {
    // Vessel approaching Klaffbron for the first time, stopped nearby waiting for opening
    const newVessel = {
      mmsi: MMSI,
      lat: BRIDGES.klaffbron.lat - 0.001, // ~110m south
      lon: BRIDGES.klaffbron.lon,
      sog: 0,
      cog: 15,
      passedBridges: [], // No bridges passed yet
    };

    const shouldAssign = vesselDataService._shouldAssignTargetBridge(newVessel, null);
    // Should be allowed - this is a legitimate waiting vessel
    expect(shouldAssign).toBe(true);
  });

  test('Regression guard: vessel with passedBridges but moving (SOG=3) SHOULD get target', () => {
    // Vessel that passed Olidebron and is actively heading to Klaffbron
    const newVessel = {
      mmsi: MMSI,
      lat: BRIDGES.klaffbron.lat - 0.003,
      lon: BRIDGES.klaffbron.lon - 0.002,
      sog: 3,
      cog: 25,
      passedBridges: ['Olidebron'],
      lastPassedBridge: 'Olidebron',
    };

    const shouldAssign = vesselDataService._shouldAssignTargetBridge(newVessel, null);
    // Should be allowed - vessel is actively moving
    expect(shouldAssign).toBe(true);
  });

  test('Fix B: vessel at SOG=0.3 (boundary) with passedBridges is still blocked', () => {
    const newVessel = {
      mmsi: MMSI,
      lat: ANCHOR_POS.lat,
      lon: ANCHOR_POS.lon,
      sog: 0.29, // Just under threshold
      cog: 72,
      passedBridges: ['Klaffbron'],
    };

    expect(vesselDataService._shouldAssignTargetBridge(newVessel, null)).toBe(false);
  });

  test('Fix B: vessel at SOG=0.31 (above boundary) with passedBridges is allowed', () => {
    const newVessel = {
      mmsi: MMSI,
      lat: ANCHOR_POS.lat,
      lon: ANCHOR_POS.lon,
      sog: 0.31, // Just above threshold
      cog: 25,
      passedBridges: ['Klaffbron'],
    };

    // Should be allowed — vessel is moving enough to potentially be transiting
    const shouldAssign = vesselDataService._shouldAssignTargetBridge(newVessel, null);
    expect(shouldAssign).toBe(true);
  });
});
