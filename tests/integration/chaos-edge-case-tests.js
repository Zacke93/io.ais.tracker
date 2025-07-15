/* eslint-disable */
'use strict';

/**
 * Chaos and Edge Case Tests - Extended Version
 * 
 * Dessa tester utforskar extrema scenarion och edge cases
 * för att hitta dolda buggar och säkerställa robust hantering.
 */

const { 
  VesselStateManager, 
  BridgeMonitor, 
  AISConnectionManager, 
  MessageGenerator, 
  ETACalculator,
  CONSTANTS 
} = require('../../app.js');

describe('Chaos Testing - Extended Extreme Scenarios', () => {
  let vesselManager;
  let bridgeMonitor;
  let messageGenerator;
  let etaCalculator;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn()
    };

    vesselManager = new VesselStateManager(mockLogger);
    
    const bridges = {
      klaffbron: {
        id: 'klaffbron',
        name: 'Klaffbron',
        lat: 58.28409551543077,
        lon: 12.283929525245636,
        radius: 300,
      },
      stridsbergsbron: {
        id: 'stridsbergsbron',
        name: 'Stridsbergsbron',
        lat: 58.293524096154634,
        lon: 12.294566425158054,
        radius: 300,
      }
    };
    
    bridgeMonitor = new BridgeMonitor(bridges, vesselManager, mockLogger);
    messageGenerator = new MessageGenerator(bridges, mockLogger);
    etaCalculator = new ETACalculator({}, mockLogger);
  });

  describe('Extreme Values and Boundary Conditions', () => {
    it('should handle MAX_SAFE_INTEGER MMSI', () => {
      const vessel = vesselManager.updateVessel(Number.MAX_SAFE_INTEGER, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'MAX MMSI'
      });

      expect(vessel).toBeDefined();
      expect(vesselManager.vessels.has(Number.MAX_SAFE_INTEGER)).toBe(true);
    });

    it('should handle coordinates at exact 90/-90 degrees', () => {
      const vessel1 = vesselManager.updateVessel(1, {
        lat: 90,
        lon: 180,
        sog: 2.0,
        cog: 0,
        name: 'NORTH POLE'
      });

      const vessel2 = vesselManager.updateVessel(2, {
        lat: -90,
        lon: -180,
        sog: 2.0,
        cog: 180,
        name: 'SOUTH POLE'
      });

      expect(vessel1.lat).toBe(90);
      expect(vessel2.lat).toBe(-90);
    });

    it('should handle COG values beyond 360 degrees', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 720, // 2 full rotations
        name: 'DOUBLE SPIN'
      });

      expect(vessel.cog).toBe(720);
    });

    it('should handle negative speeds', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: -5.0, // Negative speed
        cog: 45,
        name: 'REVERSE'
      });

      expect(vessel.sog).toBe(-5.0);
    });

    it('should handle vessel names with special characters', () => {
      const specialNames = [
        '🚢⚓️🌊', // Emojis
        '<script>alert("XSS")</script>', // XSS attempt
        'DROP TABLE vessels;--', // SQL injection
        '\u0000\u0001\u0002', // Control characters
        '﷽﷽﷽', // Arabic ligature
        '𠜎𠜱𠝹𠱓', // Chinese ideographs
        Array(10000).fill('A').join(''), // Very long name
      ];

      specialNames.forEach((name, index) => {
        const vessel = vesselManager.updateVessel(100 + index, {
          lat: 58.293,
          lon: 12.294,
          sog: 2.0,
          cog: 45,
          name: name
        });

        expect(vessel.name).toBe(name);
      });
    });
  });

  describe('Time-based Edge Cases', () => {
    it('should handle vessels with timestamps far in the future', () => {
      const futureVessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'FUTURE'
      });

      // Manually set timestamp to year 3000
      futureVessel.timestamp = new Date('3000-01-01').getTime();
      
      // System should still function
      expect(vesselManager.vessels.has(219009742)).toBe(true);
    });

    it('should handle rapid updates with microsecond intervals', async () => {
      const mmsi = 219009742;
      const updates = [];

      // Simulate 1000 updates in rapid succession
      for (let i = 0; i < 1000; i++) {
        updates.push(
          vesselManager.updateVessel(mmsi, {
            lat: 58.293 + (i * 0.00001),
            lon: 12.294 + (i * 0.00001),
            sog: 2.0 + (i * 0.01),
            cog: i % 360,
            name: 'RAPID UPDATE'
          })
        );
      }

      const lastVessel = updates[updates.length - 1];
      expect(lastVessel).toBeDefined();
      expect(vesselManager.vessels.size).toBe(1);
    });

    it('should handle clock skew scenarios', () => {
      // First update
      const vessel1 = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'TIME TRAVELER'
      });

      const originalTime = vessel1.timestamp;

      // Second update with timestamp in the past
      const vessel2 = vesselManager.updateVessel(219009742, {
        lat: 58.294,
        lon: 12.295,
        sog: 3.0,
        cog: 50,
        name: 'TIME TRAVELER'
      });

      // Manually set timestamp to past
      vessel2.timestamp = originalTime - 3600000; // 1 hour ago

      expect(vessel2).toBeDefined();
    });
  });

  describe('State Transition Chaos', () => {
    it('should handle all possible status transitions rapidly', () => {
      const mmsi = 219009742;
      const statuses = ['idle', 'en-route', 'approaching', 'waiting', 'under-bridge', 'passed'];
      
      // Try all possible transitions
      for (let from of statuses) {
        for (let to of statuses) {
          const vessel = vesselManager.updateVessel(mmsi, {
            lat: 58.293,
            lon: 12.294,
            sog: 2.0,
            cog: 45,
            name: 'STATUS CHAOS'
          });

          vessel.status = from;
          vessel.status = to;

          expect(vessel.status).toBe(to);
        }
      }
    });

    it('should handle grace miss counter overflow', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 0.1,
        cog: 45,
        name: 'GRACE OVERFLOW'
      });

      // Set grace misses to maximum
      vessel.graceMisses = Number.MAX_SAFE_INTEGER - 1;
      vessel.graceMisses++;

      expect(vessel.graceMisses).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle simultaneous bridge assignments', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'MULTI BRIDGE'
      });

      // Try to assign multiple bridges simultaneously
      vessel.nearBridge = 'klaffbron';
      vessel.targetBridge = 'stridsbergsbron';
      vessel.passedBridges = ['olidebron', 'jarnvagsbron'];

      // Then suddenly change everything
      vessel.nearBridge = 'stridsbergsbron';
      vessel.targetBridge = 'klaffbron';
      vessel.passedBridges = [];

      expect(vessel).toBeDefined();
    });
  });

  describe('Data Corruption and Recovery', () => {
    it('should survive circular references in vessel data', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'CIRCULAR'
      });

      // Create circular reference
      vessel.circular = vessel;

      // Try to update again
      const vessel2 = vesselManager.updateVessel(219009742, {
        lat: 58.294,
        lon: 12.295,
        sog: 3.0,
        cog: 50,
        name: 'CIRCULAR'
      });

      expect(vessel2).toBeDefined();
    });

    it('should handle corrupted speed history', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'CORRUPT HISTORY'
      });

      // Corrupt speed history
      vessel.speedHistory = [NaN, Infinity, -Infinity, undefined, null, 'not a number'];

      // Update should still work
      const vessel2 = vesselManager.updateVessel(219009742, {
        lat: 58.294,
        lon: 12.295,
        sog: 3.0,
        cog: 50,
        name: 'CORRUPT HISTORY'
      });

      expect(vessel2).toBeDefined();
    });

    it('should handle prototype pollution attempts', () => {
      const maliciousData = {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'PROTOTYPE POLLUTER',
        '__proto__': { isAdmin: true },
        'constructor': { prototype: { isAdmin: true } }
      };

      const vessel = vesselManager.updateVessel(219009742, maliciousData);

      // Check that prototype wasn't polluted
      expect({}.isAdmin).toBeUndefined();
      expect(vessel.isAdmin).toBeUndefined();
    });
  });

  describe('Bridge Detection Extreme Cases', () => {
    it('should handle vessel exactly between two bridges', () => {
      // Position exactly halfway between Klaffbron and Stridsbergsbron
      const midLat = (58.28409551543077 + 58.293524096154634) / 2;
      const midLon = (12.283929525245636 + 12.294566425158054) / 2;

      const vessel = vesselManager.updateVessel(219009742, {
        lat: midLat,
        lon: midLon,
        sog: 2.0,
        cog: 45,
        name: 'MIDDLE MAN'
      });

      vessel._distanceToNearest = 500; // Equidistant

      expect(vessel).toBeDefined();
    });

    it('should handle vessel inside multiple overlapping bridge radii', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.290, // Close to both bridges
        lon: 12.290,
        sog: 2.0,
        cog: 45,
        name: 'OVERLAP'
      });

      // Simulate being within range of multiple bridges
      vessel.nearBridge = 'klaffbron';
      vessel._distanceToNearest = 250;

      // Should handle gracefully
      expect(vessel.nearBridge).toBeDefined();
    });

    it('should handle rapid bridge switching', () => {
      const mmsi = 219009742;
      const bridges = ['klaffbron', 'stridsbergsbron', null];
      
      // Switch bridges 100 times rapidly
      for (let i = 0; i < 100; i++) {
        const vessel = vesselManager.updateVessel(mmsi, {
          lat: 58.290 + (i * 0.0001),
          lon: 12.290 + (i * 0.0001),
          sog: 10.0,
          cog: 45,
          name: 'BRIDGE HOPPER'
        });

        vessel.nearBridge = bridges[i % bridges.length];
        vessel.targetBridge = bridges[(i + 1) % bridges.length];
      }

      expect(vesselManager.vessels.has(mmsi)).toBe(true);
    });
  });

  describe('Message Generation Chaos', () => {
    it('should handle 1000 boats at once', () => {
      const boats = [];
      
      for (let i = 0; i < 1000; i++) {
        boats.push({
          mmsi: 219000000 + i,
          name: `VESSEL-${i}`,
          currentBridge: i % 2 ? 'Klaffbron' : 'Stridsbergsbron',
          targetBridge: i % 2 ? 'stridsbergsbron' : 'klaffbron',
          etaMinutes: Math.random() * 60,
          isWaiting: i % 10 === 0,
          confidence: ['high', 'medium', 'low'][i % 3],
          distance: Math.random() * 1000,
          distanceToCurrent: Math.random() * 300
        });
      }

      const text = messageGenerator.generateBridgeText(boats);
      
      expect(text).toBeDefined();
      expect(text.length).toBeGreaterThan(0);
    });

    it('should handle boats with all undefined fields except MMSI', () => {
      const boats = [{
        mmsi: 219009742,
        name: undefined,
        currentBridge: undefined,
        targetBridge: undefined,
        etaMinutes: undefined,
        isWaiting: undefined,
        confidence: undefined,
        distance: undefined
      }];

      const text = messageGenerator.generateBridgeText(boats);
      
      expect(text).toBeDefined();
    });

    it('should handle mixed valid and invalid boat data', () => {
      const boats = [
        { mmsi: 1, targetBridge: 'klaffbron', etaMinutes: 5 },
        null,
        undefined,
        { mmsi: 2, targetBridge: 'stridsbergsbron', etaMinutes: NaN },
        { mmsi: 3, targetBridge: 'klaffbron', etaMinutes: Infinity },
        { mmsi: 4, targetBridge: 'stridsbergsbron', etaMinutes: -10 },
        {},
        { mmsi: 5, targetBridge: 123, etaMinutes: 'five' }
      ];

      const text = messageGenerator.generateBridgeText(boats);
      
      expect(text).toBeDefined();
    });
  });

  describe('Timeout and Cleanup Chaos', () => {
    it('should handle all vessels having identical positions', () => {
      // Add 50 vessels at exact same position
      for (let i = 0; i < 50; i++) {
        vesselManager.updateVessel(219000000 + i, {
          lat: 58.293524096154634,
          lon: 12.294566425158054,
          sog: 0.0,
          cog: 0,
          name: `CLONE-${i}`
        });
      }

      expect(vesselManager.vessels.size).toBe(50);
    });

    it('should handle cleanup timer overflow', () => {
      jest.useFakeTimers();

      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 0.1,
        cog: 45,
        name: 'TIMER OVERFLOW'
      });

      // Fast forward time by maximum possible value
      jest.advanceTimersByTime(Number.MAX_SAFE_INTEGER);

      // System should still function
      expect(vesselManager.vessels.size).toBeGreaterThanOrEqual(0);

      jest.useRealTimers();
    });

    it('should handle removing vessels that dont exist', () => {
      // Try to remove 1000 non-existent vessels
      for (let i = 0; i < 1000; i++) {
        vesselManager.removeVessel(999000000 + i);
      }

      // Should not crash
      expect(vesselManager.vessels.size).toBe(0);
    });
  });

  describe('ETA Calculation Chaos', () => {
    it('should handle all edge cases for ETA calculation', () => {
      const testCases = [
        { distance: 0, speed: 0 },
        { distance: 0, speed: 100 },
        { distance: 100, speed: 0 },
        { distance: -100, speed: 10 },
        { distance: 100, speed: -10 },
        { distance: Infinity, speed: 10 },
        { distance: 100, speed: Infinity },
        { distance: NaN, speed: 10 },
        { distance: 100, speed: NaN },
        { distance: Number.MAX_VALUE, speed: Number.MIN_VALUE },
        { distance: Number.MIN_VALUE, speed: Number.MAX_VALUE }
      ];

      testCases.forEach((testCase, index) => {
        const vessel = {
          mmsi: 219000000 + index,
          targetDistance: testCase.distance,
          sog: testCase.speed,
          status: 'approaching'
        };

        const eta = etaCalculator.calculateETA(vessel, vessel.targetDistance);
        
        // Should not crash and return valid structure
        expect(eta).toBeDefined();
        expect(eta).toHaveProperty('minutes');
        expect(eta).toHaveProperty('isWaiting');
      });
    });

    it('should handle vessels with oscillating waiting status', () => {
      const vessel = {
        mmsi: 219009742,
        targetDistance: 75,
        sog: 0.5,
        status: 'waiting',
        isWaiting: true,
        maxRecentSpeed: 5.0
      };

      // Oscillate waiting status
      for (let i = 0; i < 100; i++) {
        vessel.isWaiting = i % 2 === 0;
        vessel.status = vessel.isWaiting ? 'waiting' : 'approaching';
        
        const eta = etaCalculator.calculateETA(vessel, vessel.targetDistance);
        
        expect(eta).toBeDefined();
      }
    });
  });

  describe('Concurrency and Race Conditions', () => {
    it('should handle concurrent updates to same vessel from multiple sources', async () => {
      const mmsi = 219009742;
      const promises = [];

      // Simulate 50 concurrent updates with different data
      for (let i = 0; i < 50; i++) {
        promises.push(
          new Promise((resolve) => {
            setTimeout(() => {
              const vessel = vesselManager.updateVessel(mmsi, {
                lat: 58.293 + (i * 0.001),
                lon: 12.294 + (i * 0.001),
                sog: i % 10,
                cog: i * 10,
                name: `CONCURRENT-${i}`
              });
              resolve(vessel);
            }, Math.random() * 10);
          })
        );
      }

      await Promise.all(promises);

      // Should have exactly one vessel
      expect(vesselManager.vessels.size).toBe(1);
      
      const finalVessel = vesselManager.vessels.get(mmsi);
      expect(finalVessel).toBeDefined();
    });

    it('should handle rapid add/remove cycles', async () => {
      const operations = [];

      // Rapidly add and remove vessels
      for (let i = 0; i < 100; i++) {
        const mmsi = 219000000 + (i % 10); // Reuse MMSIs
        
        operations.push(
          Promise.resolve().then(() => {
            if (i % 2 === 0) {
              vesselManager.updateVessel(mmsi, {
                lat: 58.293,
                lon: 12.294,
                sog: 2.0,
                cog: 45,
                name: `CYCLE-${i}`
              });
            } else {
              vesselManager.removeVessel(mmsi);
            }
          })
        );
      }

      await Promise.all(operations);

      // Should have consistent state
      expect(vesselManager.vessels.size).toBeGreaterThanOrEqual(0);
      expect(vesselManager.vessels.size).toBeLessThanOrEqual(10);
    });
  });

  describe('Memory and Performance Stress', () => {
    it('should handle vessels with huge data payloads', () => {
      const hugeArray = new Array(10000).fill({ data: 'payload' });
      
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'BIG DATA',
        customData: hugeArray
      });

      expect(vessel).toBeDefined();
      
      // Clean up
      vesselManager.removeVessel(219009742);
    });

    it('should handle speed history with 10000 entries', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'HISTORY OVERFLOW'
      });

      // Manually set huge speed history
      vessel.speedHistory = new Array(10000).fill(2.0);

      // Update should still work
      const vessel2 = vesselManager.updateVessel(219009742, {
        lat: 58.294,
        lon: 12.295,
        sog: 3.0,
        cog: 50,
        name: 'HISTORY OVERFLOW'
      });

      expect(vessel2).toBeDefined();
    });

    it('should survive system under extreme load', () => {
      const startMemory = process.memoryUsage().heapUsed;
      const startTime = Date.now();

      // Add 1000 vessels
      for (let i = 0; i < 1000; i++) {
        vesselManager.updateVessel(219000000 + i, {
          lat: 58.293 + (Math.random() * 0.1),
          lon: 12.294 + (Math.random() * 0.1),
          sog: Math.random() * 20,
          cog: Math.random() * 360,
          name: `LOAD-${i}`,
          speedHistory: new Array(100).fill(Math.random() * 10),
          passedBridges: ['bridge1', 'bridge2', 'bridge3']
        });
      }

      const midMemory = process.memoryUsage().heapUsed;

      // Update all vessels 10 times
      for (let j = 0; j < 10; j++) {
        for (let i = 0; i < 1000; i++) {
          vesselManager.updateVessel(219000000 + i, {
            lat: 58.293 + (Math.random() * 0.1),
            lon: 12.294 + (Math.random() * 0.1),
            sog: Math.random() * 20,
            cog: Math.random() * 360,
            name: `LOAD-${i}-${j}`
          });
        }
      }

      // Remove all vessels
      for (let i = 0; i < 1000; i++) {
        vesselManager.removeVessel(219000000 + i);
      }

      const endMemory = process.memoryUsage().heapUsed;
      const duration = Date.now() - startTime;

      // Performance assertions
      expect(duration).toBeLessThan(10000); // Should complete in less than 10 seconds
      expect(vesselManager.vessels.size).toBe(0); // All vessels removed
      
      // Memory should be somewhat recovered (not a strict requirement due to GC timing)
      const memoryGrowth = (endMemory - startMemory) / 1024 / 1024;
      expect(memoryGrowth).toBeLessThan(500); // Less than 500MB growth
    });
  });

  describe('Boundary Bridge Monitoring', () => {
    it('should handle vessel jumping between non-adjacent bridges', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.272, // Near Olidebron
        lon: 12.275,
        sog: 2.0,
        cog: 45,
        name: 'TELEPORTER'
      });

      vessel.nearBridge = 'olidebron';
      vessel.targetBridge = 'klaffbron';

      // Suddenly jump to Stallbackabron (skipping all bridges in between)
      const vessel2 = vesselManager.updateVessel(219009742, {
        lat: 58.311, // Near Stallbackabron
        lon: 12.314,
        sog: 2.0,
        cog: 45,
        name: 'TELEPORTER'
      });

      vessel2.nearBridge = 'stallbackabron';
      vessel2.targetBridge = null;

      expect(vessel2).toBeDefined();
    });

    it('should handle vessel with impossible route', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'IMPOSSIBLE'
      });

      // Set impossible route (going backwards in bridge order)
      vessel.nearBridge = 'stallbackabron';
      vessel.targetBridge = 'olidebron';
      vessel.passedBridges = ['stridsbergsbron', 'jarnvagsbron', 'klaffbron'];

      expect(vessel).toBeDefined();
    });
  });

  describe('Special Status Combinations', () => {
    it('should handle vessel with conflicting statuses', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 20.0, // Very fast
        cog: 45,
        name: 'CONFLICTED'
      });

      // Set conflicting states
      vessel.status = 'waiting'; // But moving fast
      vessel.isWaiting = true;
      vessel.speedBelowThresholdSince = Date.now();
      vessel._wasInsideTarget = true;
      vessel.targetDistance = 10; // Very close

      expect(vessel).toBeDefined();
    });

    it('should handle vessel in all states simultaneously', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 0.1,
        cog: 45,
        name: 'QUANTUM'
      });

      // Try to be in multiple states at once
      vessel.status = 'waiting';
      vessel.isWaiting = true;
      vessel.gracePeriod = true;
      vessel.graceMisses = 2;
      vessel._wasInsideTarget = true;
      vessel.speedBelowThresholdSince = Date.now() - 130000;
      vessel.waitSince = Date.now() - 60000;

      expect(vessel).toBeDefined();
    });
  });
});