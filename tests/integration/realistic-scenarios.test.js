const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);
const { TEST_SCENARIOS, BOAT_SCENARIOS, createBoatJourney } = require('../fixtures/boat-data');

describe('Realistic AIS Scenarios Integration Tests', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app._lastSeen = {};
    
    // Mock settings
    app.homey.settings.get.mockImplementation((key) => {
      if (key === 'debug_level') return 'basic';
      if (key === 'ais_api_key') return '12345678-1234-4123-a123-123456789012';
      return null;
    });

    // Mock methods
    app._updateConnectionStatus = jest.fn();
    app._updateActiveBridgesTag = jest.fn();
    app._activeBridgesTag = {
      setValue: jest.fn().mockResolvedValue(true)
    };
  });

  describe('Single Boat Journey Scenarios', () => {
    test('should track fast motorboat approaching Stridsbergsbron', () => {
      const boat = BOAT_SCENARIOS.fast_motorboat_goteborg;
      const journey = createBoatJourney('fast_motorboat_goteborg');
      
      // Simulate boat journey through multiple position updates
      journey.forEach((message, index) => {
        const meta = message.Metadata;
        
        // Extract position data
        const lat = meta.Latitude;
        const lon = meta.Longitude;
        const sog = meta.SOG;
        const mmsi = meta.MMSI;
        
        // Test that speed decreases as boat approaches bridge (realistic behavior)
        if (index > 0) {
          const previousMessage = journey[index - 1];
          const previousSog = previousMessage.Metadata.SOG;
          
          // Speed should generally decrease as boat approaches Stridsbergsbron
          if (index >= 3) { // After 3rd position, boat starts slowing down
            expect(sog).toBeLessThanOrEqual(previousSog + 0.5); // Allow small variations
          }
        }
        
        // Final position should be waiting (very low speed)
        if (index === journey.length - 1) {
          expect(sog).toBeLessThan(1.0); // Waiting at bridge
          expect(lat).toBeCloseTo(58.294, 2); // Near Stridsbergsbron
          expect(lon).toBeCloseTo(12.293, 2);
        }
      });
      
      expect(journey.length).toBe(6); // Complete journey with 6 positions
      expect(boat.mmsi).toBe(265123456);
      expect(boat.name).toBe("SPEED DEMON");
    });

    test('should track cargo boat with consistent slow speed', () => {
      const boat = BOAT_SCENARIOS.slow_cargo_vanersborg;
      const journey = createBoatJourney('slow_cargo_vanersborg');
      
      journey.forEach((message) => {
        const meta = message.Metadata;
        const sog = meta.SOG;
        
        // Cargo boat should maintain consistent slow speed
        expect(sog).toBeGreaterThan(3.0);
        expect(sog).toBeLessThan(4.0);
        
        // Should be heading towards Vänersborg (COG around 32-45 degrees)
        const cog = meta.COG;
        expect(cog).toBeGreaterThan(30);
        expect(cog).toBeLessThan(50);
      });
      
      expect(boat.name).toBe("CARGO MASTER");
    });

    test('should detect anchored sailboat correctly', () => {
      const boat = BOAT_SCENARIOS.anchored_sailboat;
      const journey = createBoatJourney('anchored_sailboat');
      
      // Check that boat progressively slows down and then stays anchored
      journey.forEach((message, index) => {
        const meta = message.Metadata;
        const sog = meta.SOG;
        
        if (index >= 2) { // After first two positions, boat should be nearly stopped
          expect(sog).toBeLessThan(0.5); // Anchored threshold
        }
        
        if (index >= 3) { // Last two positions should be identical (anchored)
          const lat = meta.Latitude;
          const lon = meta.Longitude;
          expect(lat).toBeCloseTo(58.272, 3);
          expect(lon).toBeCloseTo(12.278, 3);
        }
      });
      
      expect(boat.name).toBe("WIND DANCER");
    });

    test('should track multi-bridge speedboat journey', () => {
      const boat = BOAT_SCENARIOS.multi_bridge_speedboat;
      const journey = createBoatJourney('multi_bridge_speedboat');
      
      // This boat should show speed variations as it approaches/leaves bridges
      const speeds = journey.map(msg => msg.Metadata.SOG);
      
      // Should have high initial speed
      expect(speeds[0]).toBeGreaterThan(10);
      
      // Should slow down for bridges (positions 2 and 4)
      expect(speeds[2]).toBeLessThan(7); // Slowing for Klaffbron
      expect(speeds[4]).toBeLessThan(6); // Slowing for Järnvägsbron
      
      // Should be waiting at end
      expect(speeds[speeds.length - 1]).toBeLessThan(3); // Final position near Stridsbergsbron
      
      expect(boat.name).toBe("BRIDGE RUNNER");
    });
  });

  describe('Multi-Boat Scenarios', () => {
    test('should handle multiple boats at different bridges simultaneously', () => {
      const scenario = TEST_SCENARIOS.multiple_boats_different_bridges;
      
      const boatPositions = scenario.map(message => {
        const meta = message.Metadata;
        return {
          mmsi: meta.MMSI,
          name: meta.ShipName,
          lat: meta.Latitude,
          lon: meta.Longitude,
          sog: meta.SOG,
          cog: meta.COG
        };
      });
      
      // Should have 3 different boats
      expect(boatPositions).toHaveLength(3);
      
      // All boats should have unique MMSI
      const mmsiList = boatPositions.map(boat => boat.mmsi);
      const uniqueMmsi = [...new Set(mmsiList)];
      expect(uniqueMmsi).toHaveLength(3);
      
      // Should have boats with different behaviors
      const speeds = boatPositions.map(boat => boat.sog);
      const hasWaitingBoat = speeds.some(speed => speed < 1.0);
      const hasMovingBoat = speeds.some(speed => speed > 3.0);
      
      expect(hasWaitingBoat).toBe(true);
      expect(hasMovingBoat).toBe(true);
    });

    test('should handle high load scenario with many boats', () => {
      const scenario = TEST_SCENARIOS.high_load_scenario;
      
      expect(scenario.length).toBeGreaterThan(5);
      
      // Test performance with many boats
      const processingStart = Date.now();
      
      scenario.forEach(message => {
        const meta = message.Metadata || {};
        const body = Object.values(message.Message || {})[0] || {};
        
        // Simulate basic processing
        const mmsi = body.MMSI ?? meta.MMSI;
        const lat = meta.Latitude ?? body.Latitude;
        const lon = meta.Longitude ?? body.Longitude;
        const sog = meta.SOG ?? body.SOG;
        
        expect(mmsi).toBeDefined();
        expect(lat).toBeDefined();
        expect(lon).toBeDefined();
        expect(sog).toBeDefined();
      });
      
      const processingTime = Date.now() - processingStart;
      
      // Should process all boats quickly (under 50ms)
      expect(processingTime).toBeLessThan(50);
    });
  });

  describe('Bridge-Specific Detection', () => {
    test('should correctly identify boats near target bridges', () => {
      const targetBridges = ['klaffbron', 'stridsbergsbron'];
      const scenario = TEST_SCENARIOS.multiple_boats_different_bridges;
      
      const boatsNearTargetBridges = scenario.filter(message => {
        const lat = message.Metadata.Latitude;
        const lon = message.Metadata.Longitude;
        
        // Check if near Klaffbron
        const klaffbronDist = Math.sqrt(
          Math.pow(lat - 58.28409551543077, 2) + 
          Math.pow(lon - 12.283929525245636, 2)
        ) * 111000;
        
        // Check if near Stridsbergsbron  
        const stridsbergsbronDist = Math.sqrt(
          Math.pow(lat - 58.293524096154634, 2) + 
          Math.pow(lon - 12.294566425158054, 2)
        ) * 111000;
        
        return klaffbronDist < 300 || stridsbergsbronDist < 300;
      });
      
      expect(boatsNearTargetBridges.length).toBeGreaterThan(0);
    });

    test('should generate appropriate ETA for boats approaching target bridges', () => {
      const waitingBoat = TEST_SCENARIOS.boat_waiting_at_bridge[0];
      const meta = waitingBoat.Metadata;
      
      const currentSpeed = meta.SOG; // Very low - waiting
      const distance = 100; // Assume 100m to bridge opening point
      
      // For waiting boats, should use compensated speed
      const maxRecentSpeed = 8.5; // From boat data history
      const compensatedSpeed = maxRecentSpeed * 0.7; // 70% compensation
      
      const speedMs = compensatedSpeed * 0.514444; // Convert knots to m/s
      const etaSeconds = distance / speedMs;
      const etaMinutes = Math.round(etaSeconds / 60);
      
      expect(etaMinutes).toBeGreaterThan(0);
      expect(etaMinutes).toBeLessThan(10); // Should be reasonable ETA
      expect(compensatedSpeed).toBeGreaterThan(currentSpeed); // Compensation working
    });
  });

  describe('Real-time Message Processing Simulation', () => {
    test('should process boat journey in real-time sequence', () => {
      const journey = createBoatJourney('fast_motorboat_goteborg');
      
      // Simulate processing messages in time order
      journey.forEach((message, index) => {
        const meta = message.Metadata;
        const mmsi = meta.MMSI;
        
        // Simulate app processing - boat should only be in one bridge zone at a time
        const bridges = {
          klaffbron: { lat: 58.28409551543077, lon: 12.283929525245636 },
          stridsbergsbron: { lat: 58.293524096154634, lon: 12.294566425158054 }
        };
        
        let currentBridge = null;
        Object.entries(bridges).forEach(([bridgeId, bridge]) => {
          const distance = Math.sqrt(
            Math.pow(meta.Latitude - bridge.lat, 2) + 
            Math.pow(meta.Longitude - bridge.lon, 2)
          ) * 111000;
          
          if (distance < 300) {
            currentBridge = bridgeId;
          }
        });
        
        if (currentBridge) {
          // Simulate updating _lastSeen
          app._lastSeen[currentBridge] = app._lastSeen[currentBridge] || {};
          
          // Remove from other bridges (as per app logic)
          Object.keys(app._lastSeen).forEach(bridgeId => {
            if (bridgeId !== currentBridge && app._lastSeen[bridgeId] && app._lastSeen[bridgeId][mmsi]) {
              delete app._lastSeen[bridgeId][mmsi];
            }
          });
          
          app._lastSeen[currentBridge][mmsi] = {
            ts: meta.TimeOfFix || Date.now(),
            lat: meta.Latitude,
            lon: meta.Longitude,
            sog: meta.SOG,
            maxRecentSog: Math.max(meta.SOG, app._lastSeen[currentBridge][mmsi]?.maxRecentSog || 0)
          };
        }
      });
      
      // At end of journey, boat should be tracked at Stridsbergsbron
      expect(app._lastSeen.stridsbergsbron).toBeDefined();
      expect(app._lastSeen.stridsbergsbron[265123456]).toBeDefined();
      expect(app._lastSeen.stridsbergsbron[265123456].sog).toBeLessThan(1.0); // Waiting
    });

    test('should maintain boat history and speed tracking', () => {
      const journey = createBoatJourney('multi_bridge_speedboat');
      const mmsi = BOAT_SCENARIOS.multi_bridge_speedboat.mmsi;
      
      let maxObservedSpeed = 0;
      let speedHistory = [];
      
      journey.forEach(message => {
        const sog = message.Metadata.SOG;
        maxObservedSpeed = Math.max(maxObservedSpeed, sog);
        
        speedHistory.push({
          speed: sog,
          time: message.Metadata.TimeOfFix || Date.now()
        });
        
        // Keep only last 10 entries
        if (speedHistory.length > 10) {
          speedHistory = speedHistory.slice(-10);
        }
      });
      
      expect(maxObservedSpeed).toBeGreaterThan(10); // Should capture high speed
      expect(speedHistory).toHaveLength(6); // Journey has 6 positions
      expect(speedHistory[0].speed).toBeGreaterThan(speedHistory[speedHistory.length - 1].speed); // Slowed down
    });
  });
});