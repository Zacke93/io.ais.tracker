'use strict';

const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const StatusStabilizer = require('../lib/services/StatusStabilizer');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

describe('SystemCoordinator Integration Tests', () => {
  let coordinator;
  let logger;
  let bridgeRegistry;

  beforeEach(() => {
    logger = {
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    bridgeRegistry = new BridgeRegistry(logger);
    coordinator = new SystemCoordinator(logger);
  });

  describe('GPS Jump Coordination', () => {
    test('should activate enhanced coordination for GPS jumps', () => {
      const mmsi = '257941000';
      const gpsAnalysis = {
        isGPSJump: true,
        movementDistance: 800,
        action: 'gps_jump_detected',
        reason: 'likely_gps_error',
      };
      const vessel = { mmsi, lat: 59.3293, lon: 18.0686 };
      const oldVessel = { mmsi, lat: 59.3285, lon: 18.0678 };

      const coordination = coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, vessel, oldVessel);

      expect(coordination.shouldActivateProtection).toBe(true);
      expect(coordination.shouldDebounceText).toBe(true);
      expect(coordination.stabilizationLevel).toBe('enhanced');
      expect(coordination.reason).toBe('gps_jump_coordination');
      expect(coordination.coordinationActive).toBe(true);
    });

    test('should apply moderate coordination for uncertain positions', () => {
      const mmsi = '257941000';
      const gpsAnalysis = {
        isGPSJump: false,
        movementDistance: 400,
        action: 'accept_with_caution',
        reason: 'uncertain_movement',
      };
      const vessel = { mmsi, lat: 59.3293, lon: 18.0686 };
      const oldVessel = { mmsi, lat: 59.3289, lon: 18.0682 };

      const coordination = coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, vessel, oldVessel);

      expect(coordination.shouldActivateProtection).toBe(true);
      expect(coordination.shouldDebounceText).toBe(true);
      expect(coordination.stabilizationLevel).toBe('moderate');
      expect(coordination.reason).toBe('uncertain_position_coordination');
    });

    test('should apply light coordination for large legitimate movements', () => {
      const mmsi = '257941000';
      const gpsAnalysis = {
        isGPSJump: false,
        movementDistance: 350,
        action: 'accept',
        reason: 'legitimate_direction_change',
      };
      const vessel = { mmsi, lat: 59.3293, lon: 18.0686 };
      const oldVessel = { mmsi, lat: 59.3286, lon: 18.0679 };

      const coordination = coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, vessel, oldVessel);

      expect(coordination.shouldDebounceText).toBe(true);
      expect(coordination.stabilizationLevel).toBe('light');
      expect(coordination.reason).toBe('large_movement_coordination');
    });
  });

  describe('Status Stabilization Coordination', () => {
    test('should enhance stabilization during active coordination', () => {
      const mmsi = '257941000';
      
      // First activate coordination with GPS jump
      const gpsAnalysis = {
        isGPSJump: true,
        movementDistance: 600,
        action: 'gps_jump_detected',
      };
      const vessel = { mmsi, status: 'waiting' };
      const oldVessel = { mmsi, status: 'en-route' };
      
      coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, vessel, oldVessel);

      // Then test status stabilization
      const statusResult = {
        status: 'approaching',
        stabilized: true,
        reason: 'gps_jump_stabilization',
        confidence: 'medium',
      };
      const positionAnalysis = { gpsJumpDetected: true };

      const coordinatedResult = coordinator.coordinateStatusStabilization(mmsi, statusResult, positionAnalysis);

      expect(coordinatedResult.extendedStabilization).toBe(true);
      expect(coordinatedResult.coordinationApplied).toBe(true);
      expect(coordinatedResult.bridgeTextDebounced).toBe(true);
    });

    test('should end coordination after timeout period', async () => {
      const mmsi = '257941000';
      
      // Activate coordination
      const gpsAnalysis = { isGPSJump: true, movementDistance: 600 };
      const vessel = { mmsi };
      const oldVessel = { mmsi };
      
      coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, vessel, oldVessel);

      // Mock time passage
      const coordinationState = coordinator.vesselCoordinationState.get(mmsi);
      coordinationState.coordinationStartTime = Date.now() - 15000; // 15 seconds ago

      const statusResult = { status: 'waiting', stabilized: false };
      const coordinatedResult = coordinator.coordinateStatusStabilization(mmsi, statusResult, {});

      expect(coordinatedResult.extendedStabilization).toBe(false);
      expect(coordinatedResult.coordinationApplied).toBe(false);
    });
  });

  describe('Bridge Text Debouncing', () => {
    test('should debounce bridge text during active coordination', () => {
      const mmsi = '257941000';
      const vessels = [{ mmsi, targetBridge: 'Klaffbron' }];

      // Activate coordination
      const gpsAnalysis = { isGPSJump: true, movementDistance: 500 };
      coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, vessels[0], {});

      const debounceCheck = coordinator.shouldDebounceBridgeText(vessels);

      expect(debounceCheck.shouldDebounce).toBe(true);
      expect(debounceCheck.vesselsInCoordination).toBe(1);
      expect(debounceCheck.reason).toContain('coordination');
    });

    test('should not debounce when no coordination is active', () => {
      const vessels = [{ mmsi: '257941000', targetBridge: 'Klaffbron' }];

      const debounceCheck = coordinator.shouldDebounceBridgeText(vessels);

      expect(debounceCheck.shouldDebounce).toBe(false);
      expect(debounceCheck.reason).toBe('no_debounce_needed');
    });

    test('should debounce during system-wide instability', () => {
      // Trigger multiple GPS events to cause system instability
      for (let i = 0; i < 4; i++) {
        const mmsi = `25794100${i}`;
        const gpsAnalysis = { isGPSJump: true, movementDistance: 600 };
        coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, { mmsi }, {});
      }

      const vessels = [{ mmsi: '257941999', targetBridge: 'Klaffbron' }];
      const debounceCheck = coordinator.shouldDebounceBridgeText(vessels);

      expect(debounceCheck.shouldDebounce).toBe(true);
      expect(coordinator.globalSystemState.coordinationActive).toBe(true);
    });
  });

  describe('Real Scenario Integration - Boat 257941000', () => {
    test('should handle U-turn maneuver with coordination', () => {
      const mmsi = '257941000';
      
      // Simulate U-turn scenario - large movement with direction change
      const startPosition = { lat: 59.3293, lon: 18.0686 };
      const afterUturn = { lat: 59.3285, lon: 18.0678 };
      
      const vessel = {
        mmsi,
        ...afterUturn,
        cog: 225, // Southwest after U-turn
        sog: 4.2,
        targetBridge: 'Klaffbron',
        status: 'waiting',
      };
      
      const oldVessel = {
        mmsi,
        ...startPosition,
        cog: 45, // Northeast before U-turn
        sog: 4.8,
        targetBridge: 'Klaffbron',
        status: 'approaching',
      };

      // This should be identified as legitimate movement due to COG change
      const gpsAnalysis = {
        isGPSJump: false,
        movementDistance: 350,
        action: 'accept',
        reason: 'legitimate_direction_change',
        analysis: {
          cogChange: 180, // 180-degree turn
          bearingConsistency: { isConsistent: true },
          speedConsistency: { isConsistent: true },
        },
      };

      const coordination = coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, vessel, oldVessel);

      // Should apply light coordination for large but legitimate movement
      expect(coordination.shouldProceed).toBe(true);
      expect(coordination.shouldDebounceText).toBe(true);
      expect(coordination.stabilizationLevel).toBe('light');
      expect(coordination.reason).toBe('large_movement_coordination');

      // Test status stabilization
      const statusResult = {
        status: 'waiting',
        statusChanged: true,
        stabilized: false,
      };

      const coordinatedStatus = coordinator.coordinateStatusStabilization(mmsi, statusResult, gpsAnalysis);
      
      // Should debounce bridge text updates during maneuver
      expect(coordinatedStatus.bridgeTextDebounced).toBe(true);
    });

    test('should handle GPS jump with proper protection', () => {
      const mmsi = '257941000';
      
      const vessel = {
        mmsi,
        lat: 59.3300, // Jumped position
        lon: 18.0700,
        cog: 45,
        sog: 4.2,
        targetBridge: 'Klaffbron',
        status: 'waiting',
      };
      
      const oldVessel = {
        mmsi,
        lat: 59.3293, // Original position
        lon: 18.0686,
        cog: 45,
        sog: 4.8,
        targetBridge: 'Klaffbron',
        status: 'waiting',
      };

      const gpsAnalysis = {
        isGPSJump: true,
        movementDistance: 800,
        action: 'gps_jump_detected',
        reason: 'likely_gps_error',
      };

      const coordination = coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, vessel, oldVessel);

      // Should activate strong protection
      expect(coordination.shouldActivateProtection).toBe(true);
      expect(coordination.shouldDebounceText).toBe(true);
      expect(coordination.stabilizationLevel).toBe('enhanced');
      expect(coordination.coordinationActive).toBe(true);

      // Status should maintain previous state during GPS jump
      const statusResult = {
        status: 'approaching', // New proposed status
        statusChanged: true,
      };

      const coordinatedStatus = coordinator.coordinateStatusStabilization(mmsi, statusResult, gpsAnalysis);
      
      expect(coordinatedStatus.bridgeTextDebounced).toBe(true);
      expect(coordinatedStatus.extendedStabilization).toBe(true);
    });
  });

  describe('Cleanup and Memory Management', () => {
    test('should clean up old coordination state', () => {
      const mmsi = '257941000';
      
      // Add coordination state
      const gpsAnalysis = { isGPSJump: true, movementDistance: 500 };
      coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, { mmsi }, {});
      
      expect(coordinator.vesselCoordinationState.has(mmsi)).toBe(true);
      
      // Mock old timestamp
      const state = coordinator.vesselCoordinationState.get(mmsi);
      state.lastUpdateTime = Date.now() - (2 * 60 * 60 * 1000); // 2 hours ago
      
      coordinator.cleanup();
      
      expect(coordinator.vesselCoordinationState.has(mmsi)).toBe(false);
    });

    test('should remove vessel coordination state on vessel removal', () => {
      const mmsi = '257941000';
      
      // Add coordination state
      const gpsAnalysis = { isGPSJump: true, movementDistance: 500 };
      coordinator.coordinatePositionUpdate(mmsi, gpsAnalysis, { mmsi }, {});
      
      expect(coordinator.vesselCoordinationState.has(mmsi)).toBe(true);
      
      coordinator.removeVessel(mmsi);
      
      expect(coordinator.vesselCoordinationState.has(mmsi)).toBe(false);
    });
  });

  describe('Configuration and Status', () => {
    test('should provide coordination status for debugging', () => {
      const status = coordinator.getCoordinationStatus();
      
      expect(status).toHaveProperty('globalState');
      expect(status).toHaveProperty('activeCoordinations');
      expect(status).toHaveProperty('activeDebounces');
      expect(status).toHaveProperty('config');
      expect(status.config).toHaveProperty('bridgeTextDebounceMs');
      expect(status.config).toHaveProperty('gpsEventCooldownMs');
    });
  });
});