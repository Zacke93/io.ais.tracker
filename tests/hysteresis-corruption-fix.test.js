'use strict';

const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

// Mock logger
const mockLogger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

describe('Hysteresis State Corruption Fixes', () => {
  let statusService;
  let bridgeRegistry;
  let systemCoordinator;

  beforeEach(() => {
    jest.clearAllMocks();
    bridgeRegistry = new BridgeRegistry();
    systemCoordinator = new SystemCoordinator(mockLogger);
    statusService = new StatusService(bridgeRegistry, mockLogger, systemCoordinator);
  });

  describe('GPS Jump Hysteresis Reset', () => {
    test('should reset hysteresis state on GPS jump detection', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Klaffbron',
        _underBridgeLatched: true,
        _lastTargetBridgeForHysteresis: 'Klaffbron',
      };

      const proximityData = {
        closestBridge: { name: 'Klaffbron', distance: 45 },
      };

      // Simulate GPS jump detection
      const positionAnalysis = {
        gpsJumpDetected: true,
        analysis: {
          isGPSJump: true,
          movementDistance: 750, // >500m GPS jump
        },
      };

      // Analyze status with GPS jump
      const result = statusService.analyzeVesselStatus(vessel, proximityData, positionAnalysis);

      // Hysteresis state should be reset due to GPS jump
      expect(vessel._underBridgeLatched).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[HYSTERESIS_RESET] TEST123: GPS jump detected (750m) - resetting latch'),
      );
    });

    test('should not reset hysteresis state on small movements', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron',
        distanceToCurrent: 45, // Within hysteresis zone
        _underBridgeLatched: true,
        _lastTargetBridgeForHysteresis: 'Klaffbron',
      };

      const proximityData = {
        nearestBridge: { name: 'Klaffbron', distance: 45 },
        nearestDistance: 45,
      };

      // Simulate normal movement (not GPS jump)
      const positionAnalysis = {
        gpsJumpDetected: false,
        analysis: {
          isGPSJump: false,
          movementDistance: 50, // Small movement
        },
      };

      // Mock distance calculation
      statusService._getDistanceToTargetBridge = jest.fn().mockReturnValue(45);

      statusService.analyzeVesselStatus(vessel, proximityData, positionAnalysis);

      // Hysteresis state should NOT be reset
      expect(vessel._underBridgeLatched).toBe(true);
    });
  });

  describe('Target Bridge Change Hysteresis Reset', () => {
    test('should reset hysteresis state when target bridge changes', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Stridsbergsbron', // Changed from Klaffbron
        _underBridgeLatched: true,
        _lastTargetBridgeForHysteresis: 'Klaffbron', // Previous target
      };

      const proximityData = {
        nearestBridge: { name: 'Stridsbergsbron', distance: 200 }, // Far from nearest bridge
        nearestDistance: 200,
      };

      // Mock distance calculation to return far enough to not trigger under-bridge
      statusService._getDistanceToTargetBridge = jest.fn().mockReturnValue(200);

      statusService.analyzeVesselStatus(vessel, proximityData);

      // Hysteresis state should be reset due to target bridge change and stay reset
      expect(vessel._underBridgeLatched).toBe(false);
      expect(vessel._lastTargetBridgeForHysteresis).toBe('Stridsbergsbron');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[HYSTERESIS_RESET] TEST123: Target bridge changed from Klaffbron to Stridsbergsbron - resetting latch'),
      );
    });

    test('should not reset hysteresis state when target bridge stays same', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron',
        distanceToCurrent: 45, // Within hysteresis zone
        _underBridgeLatched: true,
        _lastTargetBridgeForHysteresis: 'Klaffbron',
      };

      const proximityData = {
        nearestBridge: { name: 'Klaffbron', distance: 45 },
        nearestDistance: 45,
      };

      // Mock distance calculation
      statusService._getDistanceToTargetBridge = jest.fn().mockReturnValue(45);

      statusService.analyzeVesselStatus(vessel, proximityData);

      // Hysteresis state should NOT be reset
      expect(vessel._underBridgeLatched).toBe(true);
    });
  });

  describe('Current Bridge Change Hysteresis Reset', () => {
    test('should reset hysteresis state when current bridge changes significantly', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Stridsbergsbron',
        currentBridge: 'Järnvägsbron', // Changed from Olidebron
        distanceToCurrent: 200, // Far from current bridge
        _underBridgeLatched: true,
        _lastCurrentBridgeForHysteresis: 'Olidebron', // Previous current
      };

      const proximityData = {
        nearestBridge: { name: 'Järnvägsbron', distance: 200 }, // Far from nearest bridge
        nearestDistance: 200,
      };

      // Mock distance calculation to return far enough to not trigger under-bridge
      statusService._getDistanceToTargetBridge = jest.fn().mockReturnValue(200);

      statusService.analyzeVesselStatus(vessel, proximityData);

      // Hysteresis state should be reset due to current bridge change and stay reset
      expect(vessel._underBridgeLatched).toBe(false);
      expect(vessel._lastCurrentBridgeForHysteresis).toBe('Järnvägsbron');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[HYSTERESIS_RESET] TEST123: Current bridge changed from Olidebron to Järnvägsbron - resetting latch'),
      );
    });

    test('should not reset when current bridge changes from/to null', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron', // New current bridge
        distanceToCurrent: 45, // Within hysteresis zone
        _underBridgeLatched: true,
        _lastCurrentBridgeForHysteresis: null, // Was null
      };

      const proximityData = {
        nearestBridge: { name: 'Klaffbron', distance: 45 },
        nearestDistance: 45,
      };

      // Mock distance calculation
      statusService._getDistanceToTargetBridge = jest.fn().mockReturnValue(45);

      statusService.analyzeVesselStatus(vessel, proximityData);

      // Hysteresis state should NOT be reset (null transition)
      expect(vessel._underBridgeLatched).toBe(true);
    });
  });

  describe('Position Validation Hysteresis Reset', () => {
    test('should reset hysteresis state on invalid position data', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: NaN, // Invalid position
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Klaffbron',
        _underBridgeLatched: true,
        _lastTargetBridgeForHysteresis: 'Klaffbron',
      };

      const proximityData = {
        closestBridge: { name: 'Klaffbron', distance: 45 },
      };

      statusService.analyzeVesselStatus(vessel, proximityData);

      // Hysteresis state should be reset due to invalid position
      expect(vessel._underBridgeLatched).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[HYSTERESIS_RESET] TEST123: Invalid vessel position data - resetting latch'),
      );
    });

    test('should not reset hysteresis state on valid position data', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron',
        distanceToCurrent: 45, // Within hysteresis zone
        _underBridgeLatched: true,
        _lastTargetBridgeForHysteresis: 'Klaffbron',
      };

      const proximityData = {
        nearestBridge: { name: 'Klaffbron', distance: 45 },
        nearestDistance: 45,
      };

      // Mock distance calculation
      statusService._getDistanceToTargetBridge = jest.fn().mockReturnValue(45);

      statusService.analyzeVesselStatus(vessel, proximityData);

      // Hysteresis state should NOT be reset (valid position)
      expect(vessel._underBridgeLatched).toBe(true);
    });
  });

  describe('Multiple Condition Hysteresis Reset', () => {
    test('should reset hysteresis state when multiple conditions trigger simultaneously', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Stridsbergsbron', // Changed bridge
        currentBridge: 'Järnvägsbron', // Changed current bridge
        _underBridgeLatched: true,
        _lastTargetBridgeForHysteresis: 'Klaffbron', // Previous target
        _lastCurrentBridgeForHysteresis: 'Olidebron', // Previous current
      };

      const proximityData = {
        closestBridge: { name: 'Stridsbergsbron', distance: 45 },
      };

      const positionAnalysis = {
        gpsJumpDetected: true,
        analysis: {
          isGPSJump: true,
          movementDistance: 600, // GPS jump too
        },
      };

      statusService.analyzeVesselStatus(vessel, proximityData, positionAnalysis);

      // Hysteresis state should be reset
      expect(vessel._underBridgeLatched).toBe(false);

      // Should log GPS jump first (first condition checked)
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[HYSTERESIS_RESET] TEST123: GPS jump detected (600m) - resetting latch'),
      );
    });
  });

  describe('Hysteresis Preservation', () => {
    test('should preserve hysteresis functionality for normal under-bridge detection', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'waiting',
        targetBridge: 'Klaffbron',
        distanceToCurrent: 45, // Within set distance
        currentBridge: 'Klaffbron',
        _underBridgeLatched: false, // Not previously latched
        _lastTargetBridgeForHysteresis: 'Klaffbron',
      };

      const proximityData = {
        closestBridge: { name: 'Klaffbron', distance: 45 },
      };

      // Mock the distance calculation
      statusService._getDistanceToTargetBridge = jest.fn().mockReturnValue(45);

      const result = statusService.analyzeVesselStatus(vessel, proximityData);

      // Should transition to under-bridge and latch state
      expect(result.status).toBe('under-bridge');
      expect(vessel._underBridgeLatched).toBe(true);
    });

    test('should maintain hysteresis state at clear distance threshold', () => {
      const vessel = {
        mmsi: 'TEST123',
        lat: 57.70,
        lon: 11.90,
        status: 'under-bridge',
        targetBridge: 'Klaffbron',
        distanceToCurrent: 65, // Between set (50m) and clear (70m)
        currentBridge: 'Klaffbron',
        _underBridgeLatched: true, // Previously latched
        _lastTargetBridgeForHysteresis: 'Klaffbron',
      };

      const proximityData = {
        closestBridge: { name: 'Klaffbron', distance: 65 },
      };

      // Mock the distance calculation
      statusService._getDistanceToTargetBridge = jest.fn().mockReturnValue(65);

      const result = statusService.analyzeVesselStatus(vessel, proximityData);

      // Should maintain under-bridge status due to hysteresis
      expect(result.status).toBe('under-bridge');
      expect(vessel._underBridgeLatched).toBe(true);
    });
  });
});
