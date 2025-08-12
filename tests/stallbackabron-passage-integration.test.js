'use strict';

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const BridgeTextService = require('../lib/services/BridgeTextService');
const { BRIDGES } = require('../lib/constants');

describe('Stallbackabron Passage Detection Integration', () => {
  let vesselDataService;
  let bridgeTextService;
  let bridgeRegistry;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      log: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };

    bridgeRegistry = new BridgeRegistry(BRIDGES, mockLogger);
    vesselDataService = new VesselDataService(mockLogger, bridgeRegistry);
    bridgeTextService = new BridgeTextService(bridgeRegistry, mockLogger);
  });

  describe('Boat 257941000 Stallbackabron Passage Scenario', () => {
    test('should detect passage and generate "precis passerat" message', async () => {
      const mmsi = '257941000';
      
      // Simulate the GPS jump scenario that previously failed
      const initialVessel = {
        mmsi,
        lat: 58.31000,
        lon: 12.31300,
        cog: 200,
        sog: 3.8,
        targetBridge: null // Simulate boat without initial target
      };

      // First update - boat approaching Stallbackabron
      vesselDataService.updateVessel(mmsi, initialVessel);
      let vessel = vesselDataService.getVessel(mmsi);
      expect(vessel).toBeTruthy();

      // Second update - 763m jump near bridge center
      const update1 = {
        lat: 58.31140,
        lon: 12.31456,
        cog: 210,
        sog: 3.8
      };

      vesselDataService.updateVessel(mmsi, update1);
      vessel = vesselDataService.getVessel(mmsi);

      // Third update - 1033m jump past bridge with direction change  
      const update2 = {
        lat: 58.31280,
        lon: 12.31612,
        cog: 30, // Major direction change indicating U-turn/maneuvering
        sog: 3.5
      };

      vesselDataService.updateVessel(mmsi, update2);
      vessel = vesselDataService.getVessel(mmsi);

      // Critical checks:
      // 1. Passage should be detected
      expect(vessel.lastPassedBridge).toBe('Stallbackabron');
      expect(vessel.lastPassedBridgeTime).toBeTruthy();
      
      // 2. "Precis passerat" should be triggered
      const timeSincePassed = Date.now() - vessel.lastPassedBridgeTime;
      expect(timeSincePassed).toBeLessThan(5000); // Should be very recent

      // 3. Bridge text should show "precis passerat"
      const vessels = vesselDataService.getAllVessels();
      const bridgeText = bridgeTextService.generateBridgeText(vessels);
      
      expect(bridgeText).toContain('har precis passerat Stallbackabron');
    });
  });

  describe('Enhanced vs Legacy Detection Comparison', () => {
    test('should work better than legacy method for maneuvering boats', () => {
      const mmsi = '123456789';
      
      // Create a scenario that would fail with legacy detection
      // but should work with enhanced detection
      const vessel1 = {
        mmsi,
        lat: 58.31080,
        lon: 12.31380,
        cog: 45,
        sog: 4.0,
        targetBridge: null
      };

      vesselDataService.updateVessel(mmsi, vessel1);
      let vessel = vesselDataService.getVessel(mmsi);

      // Large movement with direction change - would fail legacy <50m requirement
      const vessel2 = {
        lat: 58.31160,
        lon: 12.31520, // ~140m from bridge center - too far for legacy
        cog: 230, // Significant direction change
        sog: 3.8
      };

      vesselDataService.updateVessel(mmsi, vessel2);
      vessel = vesselDataService.getVessel(mmsi);

      // Enhanced detection should still work
      expect(vessel.lastPassedBridge).toBe('Stallbackabron');
      expect(vessel.lastPassedBridgeTime).toBeTruthy();
    });
  });

  describe('Multi-Bridge Journey with Enhanced Detection', () => {
    test('should handle complete journey from Stridsbergsbron to Klaffbron', () => {
      const mmsi = '987654321';
      
      // Start north of Stridsbergsbron, heading south
      let vessel = {
        mmsi,
        lat: 58.294000, // North of Stridsbergsbron
        lon: 12.295000,
        cog: 180,
        sog: 4.2,
        targetBridge: 'Stridsbergsbron'
      };

      vesselDataService.updateVessel(mmsi, vessel);
      vessel = vesselDataService.getVessel(mmsi);
      expect(vessel.targetBridge).toBe('Stridsbergsbron');

      // Pass Stridsbergsbron with enhanced detection
      const passStridsbergsbron = {
        lat: 58.293000, // South of Stridsbergsbron
        lon: 12.294000,
        cog: 180,
        sog: 4.0
      };

      vesselDataService.updateVessel(mmsi, passStridsbergsbron);
      vessel = vesselDataService.getVessel(mmsi);

      // Should detect passage and switch to next target
      expect(vessel.lastPassedBridge).toBe('Stridsbergsbron');
      expect(vessel.targetBridge).toBe('Klaffbron');

      // Continue to Klaffbron
      const approachKlaffbron = {
        lat: 58.284500,
        lon: 12.284500,
        cog: 180,
        sog: 3.8
      };

      vesselDataService.updateVessel(mmsi, approachKlaffbron);
      vessel = vesselDataService.getVessel(mmsi);

      // Pass Klaffbron
      const passKlaffbron = {
        lat: 58.283500,
        lon: 12.283500,
        cog: 180,
        sog: 3.5
      };

      vesselDataService.updateVessel(mmsi, passKlaffbron);
      vessel = vesselDataService.getVessel(mmsi);

      // Should detect final passage
      expect(vessel.lastPassedBridge).toBe('Klaffbron');
      expect(vessel.targetBridge).toBeNull(); // No more target bridges southbound
    });
  });

  describe('Bridge Text Integration', () => {
    test('should generate correct "precis passerat" text for all bridge types', () => {
      const vessels = [
        {
          mmsi: '111111111',
          status: 'passed',
          lastPassedBridge: 'Stallbackabron',
          lastPassedBridgeTime: Date.now() - 30000, // 30 seconds ago
          targetBridge: 'Stridsbergsbron',
          etaMinutes: 5
        },
        {
          mmsi: '222222222', 
          status: 'passed',
          lastPassedBridge: 'Klaffbron',
          lastPassedBridgeTime: Date.now() - 45000, // 45 seconds ago
          targetBridge: null,
          etaMinutes: null
        }
      ];

      const bridgeText = bridgeTextService.generateBridgeText(vessels);
      
      // Should handle both intermediate bridge (Stallbackabron) and target bridge (Klaffbron)
      expect(bridgeText).toBeTruthy();
      expect(bridgeText.length).toBeGreaterThan(0);
      
      // Should contain "precis passerat" for at least one vessel
      expect(bridgeText).toContain('precis passerat');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle missing position data gracefully', () => {
      const mmsi = '999999999';
      
      const invalidVessel = {
        mmsi,
        lat: NaN,
        lon: 12.314,
        cog: 45,
        sog: 3.0
      };

      // Should not crash
      expect(() => {
        vesselDataService.updateVessel(mmsi, invalidVessel);
      }).not.toThrow();

      const vessel = vesselDataService.getVessel(mmsi);
      // Should either be null or have no lastPassedBridge
      if (vessel) {
        expect(vessel.lastPassedBridge).toBeFalsy();
      }
    });

    test('should handle rapid position updates', () => {
      const mmsi = '888888888';
      
      // Rapid sequence of updates simulating high-frequency AIS data
      const updates = [
        { lat: 58.31100, lon: 12.31400, cog: 45, sog: 4.0 },
        { lat: 58.31120, lon: 12.31420, cog: 46, sog: 4.1 }, // Small movement
        { lat: 58.31140, lon: 12.31440, cog: 47, sog: 4.0 }, // Approaching bridge
        { lat: 58.31160, lon: 12.31480, cog: 48, sog: 3.9 }, // Past bridge
        { lat: 58.31180, lon: 12.31520, cog: 50, sog: 3.8 }  // Clearly past
      ];

      vesselDataService.updateVessel(mmsi, updates[0]);

      for (let i = 1; i < updates.length; i++) {
        vesselDataService.updateVessel(mmsi, updates[i]);
      }

      let vessel = vesselDataService.getVessel(mmsi);
      
      // Should detect passage despite rapid updates
      expect(vessel.lastPassedBridge).toBe('Stallbackabron');
    });
  });
});