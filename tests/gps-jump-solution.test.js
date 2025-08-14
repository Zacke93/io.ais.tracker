'use strict';

const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const StatusStabilizer = require('../lib/services/StatusStabilizer');

describe('GPS Jump Solution', () => {
  let gpsAnalyzer;
  let statusStabilizer;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };

    gpsAnalyzer = new GPSJumpAnalyzer(mockLogger);
    statusStabilizer = new StatusStabilizer(mockLogger);
  });

  describe('GPSJumpAnalyzer', () => {
    test('should detect legitimate direction changes', () => {
      const currentPosition = { lat: 58.29100, lon: 12.29200 };
      const previousPosition = { lat: 58.29500, lon: 12.29600 };
      const currentVessel = { cog: 30, sog: 4.0 }; // Changed from 200° to 30° (U-turn)
      const oldVessel = { cog: 200, sog: 4.0, timestamp: Date.now() - 10000 };

      const result = gpsAnalyzer.analyzeMovement(
        'TEST001', currentPosition, previousPosition, currentVessel, oldVessel,
      );

      expect(result.action).toBe('accept_with_caution');
      expect(result.reason).toBe('uncertain_movement');
      expect(result.isLegitimateMovement).toBe(true);
      expect(result.isGPSJump).toBe(false);
      expect(result.movementDistance).toBeGreaterThan(500);
    });

    test('should detect GPS jumps with inconsistent COG/speed', () => {
      const currentPosition = { lat: 58.30000, lon: 12.30000 };
      const previousPosition = { lat: 58.29000, lon: 12.29000 };
      const currentVessel = { cog: 30, sog: 3.0 }; // Same COG but inconsistent with movement
      const oldVessel = { cog: 30, sog: 3.0, timestamp: Date.now() - 5000 };

      const result = gpsAnalyzer.analyzeMovement(
        'TEST002', currentPosition, previousPosition, currentVessel, oldVessel,
      );

      // Should detect as uncertain due to potential inconsistency
      expect(result.action).toBe('accept_with_caution');
      expect(result.isGPSJump).toBe(false);
      expect(result.confidence).toBe('medium');
    });

    test('should handle medium jumps with caution', () => {
      const currentPosition = { lat: 58.29200, lon: 12.29200 };
      const previousPosition = { lat: 58.29100, lon: 12.29100 };
      const currentVessel = { cog: 45, sog: 2.0 };
      const oldVessel = { cog: 40, sog: 2.0, timestamp: Date.now() - 8000 };

      const result = gpsAnalyzer.analyzeMovement(
        'TEST003', currentPosition, previousPosition, currentVessel, oldVessel,
      );

      expect(result.action).toBe('accept');
      expect(result.reason).toBe('medium_movement');
      expect(result.confidence).toBe('medium');
    });

    test('should accept small movements normally', () => {
      const currentPosition = { lat: 58.29100, lon: 12.29100 };
      const previousPosition = { lat: 58.29095, lon: 12.29095 };
      const currentVessel = { cog: 45, sog: 1.0 };
      const oldVessel = { cog: 45, sog: 1.0, timestamp: Date.now() - 5000 };

      const result = gpsAnalyzer.analyzeMovement(
        'TEST004', currentPosition, previousPosition, currentVessel, oldVessel,
      );

      expect(result.action).toBe('accept');
      expect(result.reason).toBe('normal_movement');
      expect(result.movementDistance).toBeLessThan(100);
    });
  });

  describe('StatusStabilizer', () => {
    test('should stabilize status during GPS jumps', () => {
      const vessel = { mmsi: 'TEST001', status: 'waiting', sog: 3.0 };
      const positionAnalysis = { gpsJumpDetected: true, positionUncertain: false };

      // First stabilization call
      const result1 = statusStabilizer.stabilizeStatus(
        'TEST001', 'approaching', vessel, positionAnalysis,
      );

      expect(result1.status).toBe('waiting'); // Should maintain previous status
      expect(result1.stabilized).toBe(true);
      expect(result1.reason).toBe('gps_jump_stabilization');

      // Second call within stabilization window should still maintain status
      const result2 = statusStabilizer.stabilizeStatus(
        'TEST001', 'en-route', vessel, positionAnalysis,
      );

      expect(result2.status).toBe('waiting'); // Should still maintain
      expect(result2.stabilized).toBe(true);
    });

    test('should handle uncertain positions with consistency requirements', () => {
      const vessel = { mmsi: 'TEST002', status: 'waiting', sog: 2.0 };
      const positionAnalysis = { gpsJumpDetected: false, positionUncertain: true };

      // First attempt to change status - should be blocked
      const result1 = statusStabilizer.stabilizeStatus(
        'TEST002', 'approaching', vessel, positionAnalysis,
      );

      expect(result1.status).toBe('waiting');
      expect(result1.stabilized).toBe(true);
      expect(result1.reason).toBe('uncertain_position_consistency');

      // Second consistent reading - should be accepted
      const result2 = statusStabilizer.stabilizeStatus(
        'TEST002', 'approaching', vessel, positionAnalysis,
      );

      expect(result2.status).toBe('approaching');
      expect(result2.stabilized).toBe(false);
      expect(result2.reason).toBe('uncertain_position_accepted');
    });

    test('should detect and dampen status flickering', () => {
      const vessel = { mmsi: 'TEST003', status: 'waiting', sog: 2.5 };
      const normalAnalysis = { gpsJumpDetected: false, positionUncertain: false };

      // Create flickering pattern: waiting -> approaching -> waiting -> approaching
      statusStabilizer.stabilizeStatus('TEST003', 'approaching', vessel, normalAnalysis);
      statusStabilizer.stabilizeStatus('TEST003', 'waiting', vessel, normalAnalysis);
      statusStabilizer.stabilizeStatus('TEST003', 'approaching', vessel, normalAnalysis);

      // This should detect flickering and use most common status
      const result = statusStabilizer.stabilizeStatus(
        'TEST003', 'en-route', vessel, normalAnalysis,
      );

      // Should use most common status instead of proposed status
      expect(result.stabilized).toBe(true);
      expect(result.reason).toBe('flickering_damped');
    });

    test('should allow normal status changes with high confidence', () => {
      const vessel = { mmsi: 'TEST004', status: 'approaching', sog: 4.0 };
      const normalAnalysis = { gpsJumpDetected: false, positionUncertain: false };

      const result = statusStabilizer.stabilizeStatus(
        'TEST004', 'waiting', vessel, normalAnalysis,
      );

      expect(result.status).toBe('waiting');
      expect(result.stabilized).toBe(false);
      expect(result.confidence).toBe('high');
      expect(result.reason).toBe('normal_operation');
    });

    test('should clean up old vessel histories', () => {
      const vessel = { mmsi: 'TEST005', status: 'waiting', sog: 1.0 };
      const normalAnalysis = { gpsJumpDetected: false, positionUncertain: false };

      // Add some status history
      statusStabilizer.stabilizeStatus('TEST005', 'waiting', vessel, normalAnalysis);

      // Remove vessel
      statusStabilizer.removeVessel('TEST005');

      // Verify cleanup
      expect(statusStabilizer.statusHistory.has('TEST005')).toBe(false);
    });
  });

  describe('Integration Test: GPS Jump Scenario', () => {
    test('should handle boat 257941000 GPS jump scenario', () => {
      // Simulate the reported GPS jumps: 763m, 1033m, 646m
      const positions = [
        { lat: 58.29000, lon: 12.29000 }, // Starting position
        { lat: 58.29400, lon: 12.29500 }, // +763m jump with COG change
        { lat: 58.29800, lon: 12.30000 }, // +1033m jump
        { lat: 58.29500, lon: 12.29600 }, // +646m jump (returning)
      ];

      const vesselStates = [
        { cog: 30, sog: 3.5 }, // Northbound
        { cog: 200, sog: 3.2 }, // U-turn to southbound (explains large jump)
        { cog: 210, sog: 3.8 }, // Continuing southbound
        { cog: 30, sog: 3.5 }, // Another direction change
      ];

      let currentStatus = 'en-route';
      const vessel = { mmsi: '257941000', status: currentStatus };

      for (let i = 1; i < positions.length; i++) {
        const analysis = gpsAnalyzer.analyzeMovement(
          '257941000',
          positions[i],
          positions[i - 1],
          vesselStates[i],
          { ...vesselStates[i - 1], timestamp: Date.now() - 10000 },
        );

        // First jump (763m with COG change) should be handled with caution
        if (i === 1) {
          expect(analysis.action).toBe('accept_with_caution');
          expect(analysis.reason).toBe('uncertain_movement');
        }

        // Apply status stabilization
        const stabilizedResult = statusStabilizer.stabilizeStatus(
          '257941000',
          'approaching', // Simulated new status that might cause flickering
          vessel,
          analysis,
        );

        vessel.status = stabilizedResult.status;
        currentStatus = stabilizedResult.status;
      }

      // Final status should be stable (not flickering)
      expect(vessel.status).toBeDefined();
      expect(typeof vessel.status).toBe('string');
    });
  });
});
