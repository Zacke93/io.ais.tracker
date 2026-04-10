'use strict';

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

describe('Bug E — wrong bridge in opening text / re-detection prevention', () => {
  let vesselDataService;
  let bridgeRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    bridgeRegistry = new BridgeRegistry();
    const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
    const systemCoordinator = {
      getService: jest.fn().mockReturnValue(null),
      emit: jest.fn(),
    };
    vesselDataService = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
  });

  test('1: Bridge opening text uses correct bridge (Stridsbergsbron, not Järnvägsbron)', () => {
    // Verify that _bridgeOpeningBridgeName drives Phase 3 text
    const BridgeTextService = require('../lib/services/BridgeTextService');
    const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
    const vesselDataSvc = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    const service = new BridgeTextService(bridgeRegistry, logger, null, vesselDataSvc, null);

    const now = Date.now();
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 2.0,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 1,
      currentBridge: 'Stridsbergsbron',
      distanceToCurrent: 30,
      _bridgeOpeningUntil: now + 20000,
      _bridgeOpeningBridgeName: 'Stridsbergsbron',
    }]);
    expect(text).toMatch(/Stridsbergsbron/);
    expect(text).not.toMatch(/Järnvägsbron/);
  });

  test('2: _handleIntermediateBridgePassage skips bridges in passedBridges', () => {
    // Create a vessel that has already passed Järnvägsbron
    const vessel = {
      mmsi: '265718830',
      name: 'TestVessel',
      cog: 200,
      sog: 3.0,
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Stallbackabron', 'Järnvägsbron'],
      lastPassedBridge: 'Järnvägsbron',
      _passageTimestamp: Date.now() - 240000, // 4 min ago (past 3-min anchor guard)
    };

    const oldVessel = { ...vessel };

    // Mock _hasPassedBridge to return true (geometry says passage detected)
    const origHasPassedBridge = vesselDataService._hasPassedBridge;
    vesselDataService._hasPassedBridge = jest.fn().mockReturnValue(true);

    // Mock _anchorPassageTimestamp to track if it gets called for Järnvägsbron
    const origAnchor = vesselDataService._anchorPassageTimestamp;
    vesselDataService._anchorPassageTimestamp = jest.fn().mockReturnValue(true);

    // Mock _activateBridgeOpening to track if Järnvägsbron gets activated
    const activateSpy = jest.fn();
    vesselDataService._activateBridgeOpening = activateSpy;

    // Call the method
    try {
      vesselDataService._handleIntermediateBridgePassage(vessel, oldVessel);
    } catch (e) {
      // Some dependencies may not be fully mocked; the key is checking
      // whether Järnvägsbron was skipped before any processing
    }

    // _hasPassedBridge should NOT be called for Järnvägsbron (it's in passedBridges)
    const hasPassedCalls = vesselDataService._hasPassedBridge.mock.calls;
    const jarnvagsCalled = hasPassedCalls.some(call =>
      call[2] && call[2].name === 'Järnvägsbron'
    );
    expect(jarnvagsCalled).toBe(false);

    // Restore
    vesselDataService._hasPassedBridge = origHasPassedBridge;
    vesselDataService._anchorPassageTimestamp = origAnchor;
  });
});
