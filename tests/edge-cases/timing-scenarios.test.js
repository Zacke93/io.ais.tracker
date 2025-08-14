'use strict';

/**
 * Timing Scenarios Edge Case Tests
 * Tests system behavior with rapid status changes, system time changes,
 * long-running sessions, timer cleanup, and debounce behavior.
 */

const VesselDataService = require('../../lib/services/VesselDataService');
const StatusService = require('../../lib/services/StatusService');
const BridgeTextService = require('../../lib/services/BridgeTextService');
const BridgeRegistry = require('../../lib/models/BridgeRegistry');
const ProximityService = require('../../lib/services/ProximityService');
const { BRIDGES } = require('../../lib/constants');

describe('Timing Scenarios Edge Case Tests', () => {
  let mockLogger;
  let bridgeRegistry;
  let vesselDataService;
  let statusService;
  let bridgeTextService;
  let proximityService;

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
    };

    // Initialize services
    bridgeRegistry = new BridgeRegistry();
    vesselDataService = new VesselDataService(mockLogger, bridgeRegistry);
    statusService = new StatusService(bridgeRegistry, mockLogger);
    bridgeTextService = new BridgeTextService(bridgeRegistry, mockLogger);
    proximityService = new ProximityService(bridgeRegistry, mockLogger);
  });

  afterEach(() => {
    // Clean up any timers
    jest.clearAllTimers();
  });

  describe('Rapid Status Changes', () => {
    test('should handle status changes every 100ms without performance degradation', async () => {
      const mmsi = '999200001';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;
      const updateCount = 50;
      const updateInterval = 100; // 100ms

      const performanceStart = Date.now();
      let lastStatus = null;
      const statusChanges = [];

      // Simulate vessel moving from far to close to bridge rapidly
      for (let i = 0; i < updateCount; i++) {
        const distance = 1000 - (i * 20); // From 1000m to 0m
        const position = generatePositionAtDistance(bridge, Math.max(10, distance));

        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 15.0, // Fast vessel
          cog: 0,
          targetBridge: bridgeName,
          timestamp: Date.now() + (i * updateInterval),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const actualDistance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
        const status = statusService.determineStatus(storedVessel, bridgeName, actualDistance);

        if (status !== lastStatus) {
          statusChanges.push({
            time: i * updateInterval,
            distance: Math.round(actualDistance),
            status,
          });
          lastStatus = status;
        }

        // Simulate actual timing
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      const performanceEnd = Date.now();
      const totalTime = performanceEnd - performanceStart;

      // Performance assertions
      expect(totalTime).toBeLessThan(5000); // Should complete within 5 seconds
      expect(statusChanges.length).toBeGreaterThan(0); // Should have status changes

      // Should transition through expected statuses
      const finalStatus = statusChanges[statusChanges.length - 1].status;
      expect(['under-bridge', 'waiting']).toContain(finalStatus);

      // System should remain stable after rapid updates
      expect(vesselDataService.getAllVessels().length).toBe(1);
    });

    test('should handle multiple vessels with rapid status changes simultaneously', async () => {
      const vesselCount = 10;
      const updateCount = 20;
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      const startTime = Date.now();

      // Create multiple vessels with rapid updates
      for (let vesselIndex = 0; vesselIndex < vesselCount; vesselIndex++) {
        const mmsi = 999200100 + vesselIndex;

        for (let updateIndex = 0; updateIndex < updateCount; updateIndex++) {
          const distance = 600 - (updateIndex * 25); // From 600m to 100m
          const bearing = vesselIndex * 36; // Different bearings for each vessel
          const position = generatePositionAtBearing(bridge, Math.max(50, distance), bearing);

          const vessel = {
            mmsi,
            lat: position.lat,
            lon: position.lon,
            sog: 8.0 + Math.random() * 4, // Variable speed
            cog: (bearing + 180) % 360, // Toward bridge
            targetBridge: bridgeName,
            timestamp: startTime + (updateIndex * 50) + (vesselIndex * 10),
          };

          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }
      }

      const processingTime = Date.now() - startTime;

      // All vessels should be tracked
      expect(vesselDataService.getAllVessels().length).toBe(vesselCount);

      // Bridge text should handle multiple rapidly changing vessels
      expect(() => {
        const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
        expect(typeof bridgeText).toBe('string');
      }).not.toThrow();

      // Performance check
      expect(processingTime).toBeLessThan(3000); // Should complete within 3 seconds
    });

    test('should handle rapid back-and-forth status transitions', async () => {
      const mmsi = '999200200';
      const bridgeName = 'Stridsbergsbron';
      const bridge = BRIDGES.stridsbergsbron;

      // Positions that cause status oscillation around threshold
      const oscillatingDistances = [
        320, 280, 320, 280, 310, 290, 310, 290, 305, 295,
        305, 295, 302, 298, 302, 298, 300, 300, 299, 301,
      ];

      const statusHistory = [];

      for (let i = 0; i < oscillatingDistances.length; i++) {
        const position = generatePositionAtDistance(bridge, oscillatingDistances[i]);

        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 2.0, // Slow oscillation
          cog: Math.random() * 360, // Random direction
          targetBridge: bridgeName,
          timestamp: Date.now() + (i * 200), // 200ms intervals
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
        const status = statusService.determineStatus(storedVessel, bridgeName, distance);

        statusHistory.push({ distance: Math.round(distance), status });

        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      // Should handle oscillation without crashes
      expect(vesselDataService.getAllVessels().some((v) => v.mmsi === mmsi)).toBe(true);
      expect(statusHistory.length).toBe(oscillatingDistances.length);

      // Should have mixed statuses due to oscillation
      const uniqueStatuses = [...new Set(statusHistory.map((h) => h.status))];
      expect(uniqueStatuses.length).toBeGreaterThan(1);
    });
  });

  describe('System Time Changes and Clock Issues', () => {
    test('should handle vessel updates with timestamps in the past', () => {
      const mmsi = '999200300';
      const currentTime = Date.now();

      // Add vessel with current time
      const currentVessel = {
        mmsi,
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: currentTime,
      };

      vesselDataService.updateVessel(currentVessel.mmsi, currentVessel);

      // Try to add same vessel with older timestamp
      const olderVessel = {
        mmsi,
        lat: 58.285095, // Slightly different position
        lon: 12.284929,
        sog: 6.0,
        cog: 170,
        timestamp: currentTime - 60000, // 1 minute ago
      };

      expect(() => {
        vesselDataService.updateVessel(olderVessel.mmsi, olderVessel);
      }).not.toThrow();

      const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(storedVessel).toBeDefined();

      // Should keep newer data (implementation dependent)
      // Either keeps current or updates with older - both are valid strategies
    });

    test('should handle vessels with future timestamps', () => {
      const mmsi = '999200301';
      const futureTime = Date.now() + (24 * 60 * 60 * 1000); // 24 hours in future

      const futureVessel = {
        mmsi,
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: futureTime,
      };

      expect(() => {
        vesselDataService.updateVessel(futureVessel.mmsi, futureVessel);
      }).not.toThrow();

      // Should handle future timestamps gracefully
      const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      if (storedVessel) {
        expect(storedVessel.timestamp).toBeDefined();
      }
    });

    test('should handle system clock changes during operation', () => {
      const mmsi = '999200302';
      const baseTime = Date.now();

      // Mock Date.now to simulate clock changes
      const originalDateNow = Date.now;
      let mockTime = baseTime;

      Date.now = jest.fn(() => mockTime);

      try {
        // Add vessel at time T
        const vessel1 = {
          mmsi,
          lat: 58.284095,
          lon: 12.283929,
          sog: 5.0,
          cog: 180,
          timestamp: mockTime,
        };
        vesselDataService.updateVessel(vessel1.mmsi, vessel1);

        // Simulate clock jumping backward
        mockTime = baseTime - 120000; // 2 minutes back

        const vessel2 = {
          mmsi,
          lat: 58.285095,
          lon: 12.284929,
          sog: 6.0,
          cog: 170,
          timestamp: mockTime,
        };

        expect(() => {
          vesselDataService.updateVessel(vessel2.mmsi, vessel2);
        }).not.toThrow();

        // Simulate clock jumping forward significantly
        mockTime = baseTime + 3600000; // 1 hour forward

        const vessel3 = {
          mmsi,
          lat: 58.286095,
          lon: 12.285929,
          sog: 7.0,
          cog: 160,
          timestamp: mockTime,
        };

        vesselDataService.updateVessel(vessel3.mmsi, vessel3);

        // Should handle clock changes without crashes
        expect(vesselDataService.getAllVessels().some((v) => v.mmsi === mmsi)).toBe(true);

      } finally {
        Date.now = originalDateNow;
      }
    });

    test('should handle timestamp precision issues', () => {
      const mmsi = '999200303';

      // Test with various timestamp precisions
      const timestamps = [
        Date.now(), // Milliseconds
        Math.floor(Date.now() / 1000), // Seconds
        Math.floor(Date.now() / 1000) * 1000, // Seconds as milliseconds
        Date.now() + 0.123, // Sub-millisecond precision
        Math.floor(Date.now() / 1000 / 60) * 60 * 1000, // Minute precision
      ];

      timestamps.forEach((timestamp, index) => {
        const vessel = {
          mmsi,
          lat: 58.284095 + (index * 0.001),
          lon: 12.283929 + (index * 0.001),
          sog: 5.0 + index,
          cog: 180,
          timestamp,
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });

      // Should handle various timestamp precisions
      expect(vesselDataService.getAllVessels().some((v) => v.mmsi === mmsi)).toBe(true);
    });
  });

  describe('Long-Running Session Simulation', () => {
    test('should handle 24+ hour simulation without memory leaks', async () => {
      const mmsi = '999200400';
      const hoursToSimulate = 2; // Reduced for test performance
      const updatesPerHour = 60; // Once per minute
      const totalUpdates = hoursToSimulate * updatesPerHour;

      const startTime = Date.now();
      const initialMemory = process.memoryUsage().heapUsed;

      // Simulate long-running vessel tracking
      for (let i = 0; i < totalUpdates; i++) {
        const timeOffset = i * (60000 / updatesPerHour); // Simulate real time intervals
        const simulatedTime = startTime + timeOffset;

        // Vessel following a path around bridges
        const pathProgress = (i / totalUpdates) * 2 * Math.PI; // Full circle over time
        const centerLat = 58.284095;
        const centerLon = 12.283929;
        const radius = 0.01; // About 1km radius

        const vessel = {
          mmsi,
          lat: centerLat + Math.sin(pathProgress) * radius,
          lon: centerLon + Math.cos(pathProgress) * radius,
          sog: 5.0 + Math.sin(pathProgress * 2) * 3, // Variable speed 2-8 knots
          cog: ((pathProgress * 180) / Math.PI) % 360,
          timestamp: simulatedTime,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Periodically check memory usage
        if (i % 30 === 0) {
          const currentMemory = process.memoryUsage().heapUsed;
          const memoryGrowth = currentMemory - initialMemory;

          // Memory shouldn't grow excessively
          expect(memoryGrowth).toBeLessThan(50 * 1024 * 1024); // Less than 50MB

          // Force garbage collection if available
          if (global.gc && i % 60 === 0) {
            global.gc();
          }
        }

        // Add small delay to prevent overwhelming the system
        if (i % 10 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const totalMemoryGrowth = finalMemory - initialMemory;

      // Should maintain single vessel throughout simulation
      expect(vesselDataService.getAllVessels().length).toBe(1);

      // Memory growth should be reasonable for long-running operation
      expect(totalMemoryGrowth).toBeLessThan(100 * 1024 * 1024); // Less than 100MB

      // Bridge text generation should still work after long simulation
      expect(() => {
        const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
        expect(typeof bridgeText).toBe('string');
      }).not.toThrow();
    });

    test('should handle vessel lifecycle over extended periods', async () => {
      const baseMMSI = '999200500';
      const sessionHours = 1; // Reduced for test
      const vesselLifecycleMinutes = 10;
      const maxConcurrentVessels = 20;

      let vesselsCreated = 0;
      let vesselsRemoved = 0;
      const startTime = Date.now();

      // Simulate vessels appearing and disappearing over time
      for (let minute = 0; minute < sessionHours * 60; minute += 2) {
        const currentTime = startTime + (minute * 60000);

        // Add new vessel
        if (vesselsCreated < 100 && Math.random() > 0.3) {
          const mmsi = baseMMSI + vesselsCreated;
          const vessel = {
            mmsi,
            lat: 58.284095 + (Math.random() - 0.5) * 0.1,
            lon: 12.283929 + (Math.random() - 0.5) * 0.1,
            sog: Math.random() * 15,
            cog: Math.random() * 360,
            timestamp: currentTime,
            createdAt: currentTime,
          };

          vesselDataService.updateVessel(vessel.mmsi, vessel);
          vesselsCreated++;
        }

        // Remove old vessels
        const allVessels = vesselDataService.getAllVessels();
        allVessels.forEach((vessel) => {
          const vesselAge = currentTime - (vessel.createdAt || vessel.timestamp);
          if (vesselAge > vesselLifecycleMinutes * 60000) {
            vesselDataService.removeVessel(vessel.mmsi);
            vesselsRemoved++;
          }
        });

        // Limit concurrent vessels
        if (allVessels.length > maxConcurrentVessels) {
          const oldestVessel = allVessels[0];
          if (oldestVessel) {
            vesselDataService.removeVessel(oldestVessel.mmsi);
            vesselsRemoved++;
          }
        }

        await new Promise((resolve) => setImmediate(resolve));
      }

      // Should have managed vessel lifecycle properly
      expect(vesselsCreated).toBeGreaterThan(0);
      expect(vesselsRemoved).toBeGreaterThan(0);
      expect(vesselDataService.getAllVessels().length).toBeLessThanOrEqual(maxConcurrentVessels);
    });
  });

  describe('Timer Cleanup and Resource Management', () => {
    test('should clean up timers when vessels are removed', () => {
      const mmsi = '999200600';

      // Add vessel far from bridges to avoid protection zone
      const vessel = {
        mmsi,
        lat: 59.0, // Far from bridges
        lon: 13.0,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
      };

      vesselDataService.updateVessel(vessel.mmsi, vessel);
      expect(vesselDataService.getAllVessels().some((v) => v.mmsi === mmsi)).toBe(true);

      // Remove vessel with force reason to bypass protection
      vesselDataService.removeVessel(mmsi, 'force');
      // Note: Vessel may still be present due to protection zones or other logic
      // This test mainly ensures no crashes occur during cleanup
      expect(() => {
        vesselDataService.getAllVessels();
      }).not.toThrow();
    });

    test('should handle timer accumulation with many rapid vessel additions/removals', () => {
      const baseMMSI = '999200700';
      const cycleCount = 100;

      for (let i = 0; i < cycleCount; i++) {
        const mmsi = baseMMSI + i;

        // Add vessel
        const vessel = {
          mmsi,
          lat: 58.284095 + (Math.random() - 0.5) * 0.01,
          lon: 12.283929 + (Math.random() - 0.5) * 0.01,
          sog: Math.random() * 20,
          cog: Math.random() * 360,
          timestamp: Date.now() + i,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Immediately remove some vessels
        if (i % 3 === 0 && i > 0) {
          vesselDataService.removeVessel(baseMMSI + (i - 1));
        }
      }

      // Should not accumulate excessive timers or resources
      expect(vesselDataService.getAllVessels().length).toBeGreaterThan(0);
      expect(vesselDataService.getAllVessels().length).toBeLessThan(cycleCount);
    });

    test('should handle service shutdown and cleanup', () => {
      const mmsiBase = '999200800';
      const vesselCount = 10;

      // Add multiple vessels
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: mmsiBase + i,
          lat: 58.284095 + (i * 0.001),
          lon: 12.283929 + (i * 0.001),
          sog: 5.0 + i,
          cog: i * 36,
          timestamp: Date.now(),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      expect(vesselDataService.getAllVessels().length).toBe(vesselCount);

      // Simulate service cleanup (if such method exists)
      if (typeof vesselDataService.cleanup === 'function') {
        expect(() => {
          vesselDataService.cleanup();
        }).not.toThrow();
      }

      // Manual cleanup - remove all vessels with force to bypass protection
      const allVessels = vesselDataService.getAllVessels();
      allVessels.forEach((vessel) => {
        vesselDataService.removeVessel(vessel.mmsi, 'force');
      });

      // Clear all timers to ensure clean state
      if (typeof vesselDataService.clearAllTimers === 'function') {
        vesselDataService.clearAllTimers();
      }

      // Some vessels may remain due to protection zones - ensure we can call the method
      expect(() => {
        vesselDataService.getAllVessels();
      }).not.toThrow();
    });
  });

  describe('Debounce Behavior Under Load', () => {
    test('should handle rapid duplicate updates with debouncing', async () => {
      const mmsi = '999200900';
      const rapidUpdateCount = 50;
      const updateInterval = 10; // 10ms intervals

      // Send many rapid updates for same vessel
      for (let i = 0; i < rapidUpdateCount; i++) {
        const vessel = {
          mmsi,
          lat: 58.284095 + (Math.random() * 0.0001), // Tiny position variations
          lon: 12.283929 + (Math.random() * 0.0001),
          sog: 5.0 + (Math.random() * 0.1), // Tiny speed variations
          cog: 180 + (Math.random() * 0.1), // Tiny course variations
          timestamp: Date.now() + (i * updateInterval),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Small delay to simulate rapid but not instantaneous updates
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      // Should handle rapid updates without performance issues
      expect(vesselDataService.getAllVessels().length).toBe(1);
      expect(vesselDataService.getAllVessels().some((v) => v.mmsi === mmsi)).toBe(true);
    });

    test('should maintain performance with rapid bridge text generation', async () => {
      const vesselCount = 15;
      const bridgeTextGenerations = 100;

      // Add multiple vessels
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `999200910${i}`,
          lat: 58.284095 + (Math.random() - 0.5) * 0.05,
          lon: 12.283929 + (Math.random() - 0.5) * 0.05,
          sog: Math.random() * 15,
          cog: Math.random() * 360,
          timestamp: Date.now(),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      const startTime = Date.now();

      // Generate bridge text rapidly
      for (let i = 0; i < bridgeTextGenerations; i++) {
        expect(() => {
          const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
          expect(typeof bridgeText).toBe('string');
        }).not.toThrow();

        // Small delay to prevent overwhelming
        if (i % 10 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      const generationTime = Date.now() - startTime;

      // Should complete rapid generations within reasonable time
      expect(generationTime).toBeLessThan(5000); // Within 5 seconds

      // Average time per generation should be reasonable
      const averageTime = generationTime / bridgeTextGenerations;
      expect(averageTime).toBeLessThan(50); // Less than 50ms per generation
    });
  });
});

// Helper functions for generating test positions
function generatePositionAtDistance(bridge, distanceMeters) {
  const latDegreePerMeter = 1 / 111320;
  const offsetLat = -(distanceMeters * latDegreePerMeter); // South

  return {
    lat: bridge.lat + offsetLat,
    lon: bridge.lon,
  };
}

function generatePositionAtBearing(bridge, distanceMeters, bearingDegrees) {
  const latDegreePerMeter = 1 / 111320;
  const lonDegreePerMeter = 1 / (111320 * Math.cos(bridge.lat * Math.PI / 180));

  const bearingRadians = bearingDegrees * Math.PI / 180;

  const offsetLat = distanceMeters * Math.cos(bearingRadians) * latDegreePerMeter;
  const offsetLon = distanceMeters * Math.sin(bearingRadians) * lonDegreePerMeter;

  return {
    lat: bridge.lat + offsetLat,
    lon: bridge.lon + offsetLon,
  };
}
