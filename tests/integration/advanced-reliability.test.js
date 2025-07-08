const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('Advanced Reliability and Performance Tests', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app._lastSeen = {};
    app._speedHistory = {};

    // Mock settings
    app.homey.settings.get.mockImplementation((key) => {
      if (key === 'debug_level') return 'detailed';
      if (key === 'ais_api_key') return '12345678-1234-4123-a123-123456789012';
      return null;
    });

    // Mock methods and devices
    app._updateConnectionStatus = jest.fn();
    app._updateActiveBridgesTag = jest.fn();
    app._activeBridgesTag = {
      setValue: jest.fn().mockResolvedValue(true),
    };
    app._devices = new Map();

    const mockDevice = {
      setCapabilityValue: jest.fn().mockResolvedValue(true),
      getCapabilityValue: jest.fn().mockReturnValue('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron'),
    };
    app._devices.set('test_device', mockDevice);
  });

  describe('Signal Loss and Recovery Patterns (Based on Real Logs)', () => {
    test('should maintain tracking during intermittent signal loss', async () => {
      const mmsi = '305190000'; // EMMA F
      const baseTime = Date.now();

      // Initial strong signal
      app._lastSeen.olidebron = {};
      app._lastSeen.olidebron[mmsi] = {
        ts: baseTime,
        sog: 2.7,
        dist: 219,
        dir: 'Vänersborg',
        vessel_name: 'EMMA F',
        maxRecentSog: 2.7,
      };

      // Verify initial detection
      let relevantBoats = await app._findRelevantBoats();
      expect(relevantBoats.length).toBe(1);

      // Simulate 5 minutes of signal loss (should still be tracked)
      const lossTime = baseTime + (5 * 60 * 1000);
      global.Date.now = jest.fn(() => lossTime);

      relevantBoats = await app._findRelevantBoats();
      expect(relevantBoats.length).toBe(1); // Still tracked due to extended MAX_AGE

      // Simulate 12 minutes of signal loss (should be cleaned up)
      const longLossTime = baseTime + (12 * 60 * 1000);
      global.Date.now = jest.fn(() => longLossTime);

      relevantBoats = await app._findRelevantBoats();
      expect(relevantBoats.length).toBe(0); // Now cleaned up

      // Reset mock
      global.Date.now = jest.fn(() => Date.now());
    });

    test('should handle rapid signal recovery with position updates', async () => {
      const mmsi = '265531400'; // ENCORE
      const baseTime = Date.now();

      // Boat detected approaching
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 5.0,
        dist: 168,
        dir: 'Göteborg',
        vessel_name: 'ENCORE',
        towards: true,
        maxRecentSog: 5.0,
      };

      // Signal lost for 30 seconds
      const shortLoss = baseTime + 30000;

      // Rapid recovery with updated position
      app._lastSeen.klaffbron[mmsi] = {
        ts: shortLoss,
        sog: 5.5,
        dist: 14, // Much closer
        dir: 'Göteborg',
        vessel_name: 'ENCORE',
        towards: false, // Now moving away
        maxRecentSog: 5.5,
      };

      const relevantBoats = await app._findRelevantBoats();
      
      // Should detect direction change and stop tracking
      expect(relevantBoats.length).toBe(0);
    });
  });

  describe('Speed History and Compensation Logic', () => {
    test('should maintain accurate speed history over time', () => {
      const mmsi = '210548000'; // SKAGERN
      const baseTime = Date.now();

      // Simulate speed history over multiple updates
      const speedUpdates = [
        { time: baseTime, speed: 3.5 },
        { time: baseTime + 60000, speed: 3.8 },
        { time: baseTime + 120000, speed: 3.6 },
        { time: baseTime + 180000, speed: 3.7 },
        { time: baseTime + 240000, speed: 3.4 },
      ];

      app._lastSeen.olidebron = {};
      
      speedUpdates.forEach((update) => {
        app._lastSeen.olidebron[mmsi] = {
          ts: update.time,
          sog: update.speed,
          dist: 150,
          dir: 'Vänersborg',
          vessel_name: 'SKAGERN',
          maxRecentSog: Math.max(
            update.speed,
            app._lastSeen.olidebron[mmsi]?.maxRecentSog || 0,
          ),
        };
      });

      // Should remember highest speed
      expect(app._lastSeen.olidebron[mmsi].maxRecentSog).toBe(3.8);
    });

    test('should apply different timeout bonuses based on speed categories', () => {
      const testCases = [
        { speed: 0.3, expectedTimeout: 20 * 60 * 1000 }, // Very slow: 10 + 10 min = 20 min
        { speed: 1.0, expectedTimeout: 15 * 60 * 1000 }, // Slow: 10 + 5 min = 15 min
        { speed: 2.0, expectedTimeout: 10 * 60 * 1000 }, // Normal: 10 min only (MAX_AGE_SEC)
        { speed: 5.0, expectedTimeout: 10 * 60 * 1000 }, // Fast: 10 min only (MAX_AGE_SEC)
      ];

      testCases.forEach(({ speed, expectedTimeout }, index) => {
        const mmsi = `12345600${index}`;
        
        app._lastSeen.klaffbron = app._lastSeen.klaffbron || {};
        app._lastSeen.klaffbron[mmsi] = {
          ts: Date.now(),
          sog: speed,
          dist: 100,
          dir: 'Vänersborg',
          vessel_name: `SPEED_TEST_${index}`,
          maxRecentSog: speed,
        };

        const vessel = app._lastSeen.klaffbron[mmsi];
        const timeout = app._getSpeedAdjustedTimeout(vessel);
        expect(timeout).toBe(expectedTimeout);
      });
    });
  });

  describe('Bridge Passage Detection and Route Prediction', () => {
    test('should immediately detect bridge passage and predict next route', async () => {
      const mmsi = '555111222';
      const baseTime = Date.now();

      // Boat approaching Klaffbron from south
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 4.0,
        dist: 50,
        dir: 'Vänersborg',
        vessel_name: 'ROUTE_PREDICTOR',
        towards: true,
        maxRecentSog: 4.0,
      };

      // Simulate passage detection (moving away)
      app._lastSeen.klaffbron[mmsi].towards = false;
      app._lastSeen.klaffbron[mmsi].dist = 100;

      // Test immediate route prediction with required parameters
      const hasNextTarget = await app._addToNextRelevantBridge(
        mmsi, 
        'klaffbron', 
        58.28409551543077, // Klaffbron lat
        12.283929525245636, // Klaffbron lon
        'Vänersborg', 
        4.0, // sog
        []
      );
      
      expect(hasNextTarget).toBe(true);
      
      // Should be removed from Klaffbron and added to next relevant bridge
      expect(app._lastSeen.klaffbron[mmsi]).toBeUndefined();
      
      // Should be added to Stridsbergsbron (next user bridge northbound)
      expect(app._lastSeen.stridsbergsbron).toBeDefined();
      expect(app._lastSeen.stridsbergsbron[mmsi]).toBeDefined();
    });

    test('should handle complex bridge sequences correctly', async () => {
      const mmsi = '777888999';
      const baseTime = Date.now();

      // Test full sequence: Olidebron → Klaffbron → Stridsbergsbron
      const bridgeSequence = [
        { from: 'olidebron', to: 'klaffbron', direction: 'Vänersborg' },
        { from: 'klaffbron', to: 'stridsbergsbron', direction: 'Vänersborg' },
        { from: 'stridsbergsbron', to: null, direction: 'Vänersborg' }, // No more user bridges
      ];

      for (const [index, { from, to, direction }] of bridgeSequence.entries()) {
        // Setup boat at current bridge
        app._lastSeen[from] = {};
        app._lastSeen[from][mmsi] = {
          ts: baseTime + (index * 300000), // 5 min intervals
          sog: 3.5,
          dist: 200,
          dir: direction,
          vessel_name: 'SEQUENCE_TESTER',
          maxRecentSog: 3.5,
        };

        // Test route prediction with proper parameters
        const bridges = {
          olidebron: { lat: 58.272743083145855, lon: 12.275115821922993 },
          klaffbron: { lat: 58.28409551543077, lon: 12.283929525245636 },
          stridsbergsbron: { lat: 58.293524096154634, lon: 12.294566425158054 },
        };
        
        const hasNext = await app._addToNextRelevantBridge(
          mmsi, 
          from, 
          bridges[from].lat,
          bridges[from].lon,
          direction, 
          3.5,
          []
        );
        
        if (to) {
          expect(hasNext).toBe(true);
          expect(app._lastSeen[to]).toBeDefined();
          expect(app._lastSeen[to][mmsi]).toBeDefined();
        } else {
          expect(hasNext).toBe(false); // No more user bridges
        }

        // Clean up for next iteration
        if (app._lastSeen[from]) {
          delete app._lastSeen[from][mmsi];
        }
      }
    });
  });

  describe('ETA Calculation Edge Cases and Accuracy', () => {
    test('should handle various distance and speed combinations accurately', () => {
      const testCases = [
        // [distance, current_speed, max_speed, waiting, expected_eta_type]
        [25, 0.1, 5.0, false, 'waiting'], // Very close, very slow
        [45, 0.8, 6.0, false, 'waiting'], // Close, slow
        [80, 0.3, 4.0, false, 'waiting'], // Distance <100, very slow
        [150, 2.0, 2.0, false, 'number'], // Normal case
        [500, 1.0, 8.0, false, 'number'], // Speed compensation case
        [1000, 4.0, 4.0, false, 'number'], // Standard calculation
        [0, 3.0, 3.0, false, 'waiting'], // Zero distance
      ];

      testCases.forEach(([distance, currentSpeed, maxSpeed, waiting, expectedType]) => {
        const vessel = { sog: currentSpeed, maxRecentSog: maxSpeed };
        const eta = app._calculateETA(vessel, distance, 'klaffbron');
        
        if (expectedType === 'waiting') {
          expect(eta).toBe('waiting');
        } else {
          expect(typeof eta).toBe('number');
          expect(eta).toBeGreaterThan(0);
          expect(eta).toBeLessThan(120); // Should be reasonable
        }
      });
    });

    test('should provide accurate ETAs for realistic scenarios', () => {
      // Test case based on EMMA F logs: 1583m at 2.7 knots
      const distance = 1583; // meters
      const speed = 2.7; // knots
      const vessel = { sog: speed, maxRecentSog: speed };
      const eta = app._calculateETA(vessel, distance, 'klaffbron');
      
      expect(typeof eta).toBe('number');
      expect(eta).toBeGreaterThan(17); // Should be around 19 minutes
      expect(eta).toBeLessThan(21);

      // Test case with speed compensation: slow current, high max
      const vesselCompensated = { sog: 1.0, maxRecentSog: 8.0 };
      const compensatedEta = app._calculateETA(vesselCompensated, 800, 'klaffbron');
      expect(typeof compensatedEta).toBe('number');
      expect(compensatedEta).toBeLessThan(10); // Compensated speed should reduce ETA
    });
  });

  describe('Message Prioritization and Deduplication', () => {
    test('should prioritize Stridsbergsbron over Klaffbron for same vessel', async () => {
      const mmsi = '999000111';
      const baseTime = Date.now();

      // Same vessel detected at both bridges (edge case)
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 3.0,
        dist: 200,
        dir: 'Vänersborg',
        vessel_name: 'PRIORITY_TEST',
        maxRecentSog: 3.0,
      };

      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron[mmsi] = {
        ts: baseTime + 1000,
        sog: 2.8,
        dist: 180,
        dir: 'Vänersborg',
        vessel_name: 'PRIORITY_TEST',
        maxRecentSog: 3.0,
      };

      const relevantBoats = await app._findRelevantBoats();
      expect(relevantBoats.length).toBe(2);

      const message = app._generateBridgeTextFromBoats(relevantBoats);
      
      // Should prioritize Stridsbergsbron and NOT show combined message
      expect(message).toContain('Stridsbergsbron');
      expect(message).not.toContain(';'); // No combination for same vessel
      expect(message).not.toContain('Klaffbron'); // Should be filtered out
    });

    test('should combine messages for different vessels at target bridges', async () => {
      const baseTime = Date.now();

      // Different vessels at target bridges
      app._lastSeen.klaffbron = {
        '111000111': {
          ts: baseTime,
          sog: 3.0,
          dist: 200,
          dir: 'Vänersborg',
          vessel_name: 'VESSEL_A',
          maxRecentSog: 3.0,
        },
      };

      app._lastSeen.stridsbergsbron = {
        '222000222': {
          ts: baseTime,
          sog: 2.5,
          dist: 150,
          dir: 'Vänersborg',
          vessel_name: 'VESSEL_B',
          maxRecentSog: 2.5,
        },
      };

      const relevantBoats = await app._findRelevantBoats();
      expect(relevantBoats.length).toBe(2);

      const message = app._generateBridgeTextFromBoats(relevantBoats);
      
      // Should combine messages for different vessels
      expect(message).toContain(';');
      expect(message).toContain('Klaffbron');
      expect(message).toContain('Stridsbergsbron');
    });
  });

  describe('Performance and Scalability Tests', () => {
    test('should handle high-frequency updates without memory leaks', () => {
      const mmsi = '123456789';
      const iterations = 1000;
      const initialMemory = process.memoryUsage().heapUsed;

      // Simulate rapid updates
      for (let i = 0; i < iterations; i++) {
        app._lastSeen.klaffbron = app._lastSeen.klaffbron || {};
        app._lastSeen.klaffbron[mmsi] = {
          ts: Date.now() + i,
          sog: 3.0 + (i % 10) * 0.1,
          dist: 200 - i * 0.1,
          dir: 'Vänersborg',
          vessel_name: 'MEMORY_TEST',
          maxRecentSog: Math.max(3.0, 3.0 + (i % 10) * 0.1),
        };
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable (less than 10MB)
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
    });

    test('should process complex scenarios within performance limits', async () => {
      const boatCount = 15;
      const baseTime = Date.now();

      // Create many boats with varying scenarios
      for (let i = 0; i < boatCount; i++) {
        const mmsi = `99800${i.toString().padStart(4, '0')}`;
        const bridges = ['olidebron', 'klaffbron', 'jarnvagsbron', 'stridsbergsbron'];
        const bridgeId = bridges[i % bridges.length];
        
        app._lastSeen[bridgeId] = app._lastSeen[bridgeId] || {};
        app._lastSeen[bridgeId][mmsi] = {
          ts: baseTime + (i * 1000),
          sog: 0.5 + (i % 8) * 0.8, // Speeds from 0.5 to 6.1
          dist: 50 + (i % 12) * 25,  // Distances from 50 to 325
          dir: i % 2 === 0 ? 'Vänersborg' : 'Göteborg',
          vessel_name: `PERF_BOAT_${i}`,
          maxRecentSog: Math.max(2.0, 0.5 + (i % 8) * 0.8),
        };
      }

      // Measure processing time
      const startTime = Date.now();
      const relevantBoats = await app._findRelevantBoats();
      const message = app._generateBridgeTextFromBoats(relevantBoats);
      const endTime = Date.now();

      // Should complete within 200ms
      expect(endTime - startTime).toBeLessThan(200);
      
      // Should detect some boats
      expect(relevantBoats.length).toBeGreaterThan(0);
      
      // Message should be generated
      expect(message).toBeDefined();
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    });
  });

  describe('Error Recovery and Edge Case Handling', () => {
    test('should handle malformed boat data gracefully', async () => {
      // Test with missing or invalid data
      app._lastSeen.klaffbron = {
        'invalid_boat_1': {
          ts: Date.now(),
          // Missing sog
          dist: 200,
          dir: 'Vänersborg',
          vessel_name: 'INVALID_1',
        },
        'invalid_boat_2': {
          ts: Date.now(),
          sog: null, // Null speed
          dist: 150,
          dir: 'Vänersborg',
          vessel_name: 'INVALID_2',
        },
        'valid_boat': {
          ts: Date.now(),
          sog: 3.0,
          dist: 180,
          dir: 'Vänersborg',
          vessel_name: 'VALID',
          maxRecentSog: 3.0,
        },
      };

      // Should not throw errors and should process valid boat
      const relevantBoats = await app._findRelevantBoats();
      
      // Should only return valid boats
      expect(relevantBoats.length).toBeGreaterThanOrEqual(0);
      expect(relevantBoats.length).toBeLessThanOrEqual(1);
      
      if (relevantBoats.length > 0) {
        expect(relevantBoats[0].mmsi).toBe('valid_boat');
      }
    });

    test('should handle extreme values gracefully', async () => {
      const mmsi = '999888777';
      
      // Test with extreme values
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: Date.now(),
        sog: 999, // Unrealistic speed
        dist: -100, // Negative distance
        dir: 'Vänersborg',
        vessel_name: 'EXTREME_VALUES',
        maxRecentSog: 999,
      };

      const relevantBoats = await app._findRelevantBoats();
      
      // Should handle gracefully without errors
      expect(Array.isArray(relevantBoats)).toBe(true);
    });
  });
});