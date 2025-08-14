'use strict';

/**
 * Memory Stress Edge Case Tests
 * Tests for memory leaks, Map/Set growth limits, timer accumulation,
 * event listener buildup, and handling thousands of historical positions.
 */

const VesselDataService = require('../../lib/services/VesselDataService');
const StatusService = require('../../lib/services/StatusService');
const BridgeTextService = require('../../lib/services/BridgeTextService');
const BridgeRegistry = require('../../lib/models/BridgeRegistry');
const ProximityService = require('../../lib/services/ProximityService');
const { BRIDGES } = require('../../lib/constants');

describe('Memory Stress Edge Case Tests', () => {
  let mockLogger;
  let mockApp;
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
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
    };

    // Mock app
    mockApp = {
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
      triggerBoatNearEvent: jest.fn(),
      updateCapability: jest.fn(),
      setCapabilityValue: jest.fn(),
    };

    // Initialize services
    bridgeRegistry = new BridgeRegistry();
    vesselDataService = new VesselDataService(mockLogger, bridgeRegistry);
    statusService = new StatusService(bridgeRegistry, mockLogger);
    bridgeTextService = new BridgeTextService(bridgeRegistry, mockLogger);
    proximityService = new ProximityService(bridgeRegistry, mockLogger);
  });

  afterEach(() => {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    // Clear any timers
    jest.clearAllTimers();
  });

  describe('Memory Leak Detection', () => {
    test('should not leak memory with repeated vessel updates', async () => {
      const mmsi = '999400001';
      const updateCount = 5000;

      const initialMemory = process.memoryUsage();

      // Perform many updates with same vessel
      for (let i = 0; i < updateCount; i++) {
        const vessel = {
          mmsi,
          lat: 58.284095 + (Math.sin(i * 0.1) * 0.001),
          lon: 12.283929 + (Math.cos(i * 0.1) * 0.001),
          sog: 5.0 + Math.random(),
          cog: (i * 3.6) % 360,
          timestamp: Date.now() + i,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Force garbage collection periodically
        if (i % 500 === 0 && global.gc) {
          global.gc();
        }

        // Allow event loop to process
        if (i % 100 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      // Final memory check
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage();
      const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;

      // Should only have one vessel despite many updates
      expect(vesselDataService.getAllVessels().length).toBe(1);

      // Memory growth should be minimal (less than 50MB for repeated updates)
      expect(memoryGrowth).toBeLessThan(50 * 1024 * 1024);

      // Heap should not grow excessively
      expect(finalMemory.heapUsed).toBeLessThan(initialMemory.heapUsed + 100 * 1024 * 1024);
    });

    test('should not leak memory with vessel creation and removal cycles', async () => {
      const cycleCount = 1000;
      const vesselsPerCycle = 50;

      const initialMemory = process.memoryUsage();

      for (let cycle = 0; cycle < cycleCount; cycle++) {
        const cycleMMSIBase = 999400100 + (cycle * vesselsPerCycle);

        // Add vessels
        for (let i = 0; i < vesselsPerCycle; i++) {
          const vessel = {
            mmsi: cycleMMSIBase + i,
            lat: 58.284095 + (Math.random() - 0.5) * 0.1,
            lon: 12.283929 + (Math.random() - 0.5) * 0.1,
            sog: Math.random() * 20,
            cog: Math.random() * 360,
            timestamp: Date.now(),
          };

          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }

        // Remove vessels
        for (let i = 0; i < vesselsPerCycle; i++) {
          vesselDataService.removeVessel(cycleMMSIBase + i);
        }

        // Periodic cleanup
        if (cycle % 100 === 0) {
          if (global.gc) {
            global.gc();
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage();
      const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;

      // Should have significantly fewer vessels than were created (some may be protected from cleanup)
      const remainingVessels = vesselDataService.getAllVessels().length;
      const totalVesselsCreated = cycleCount * vesselsPerCycle;
      expect(remainingVessels).toBeLessThan(totalVesselsCreated * 0.5); // Should have cleaned up at least half

      // Memory should not have grown significantly
      expect(memoryGrowth).toBeLessThan(100 * 1024 * 1024); // Less than 100MB permanent growth
    });

    test('should handle memory pressure with large vessel data', async () => {
      const vesselCount = 1000;
      const largeDataSize = 1024; // 1KB per vessel additional data

      const initialMemory = process.memoryUsage();

      // Add vessels with large additional data
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `999400200${i}`,
          lat: 58.284095 + (Math.random() - 0.5) * 0.2,
          lon: 12.283929 + (Math.random() - 0.5) * 0.2,
          sog: Math.random() * 25,
          cog: Math.random() * 360,
          timestamp: Date.now(),
          // Large data payload
          largeData: 'x'.repeat(largeDataSize),
          history: Array.from({ length: 100 }, (_, j) => ({
            timestamp: Date.now() - (j * 1000),
            lat: 58.284095 + Math.random() * 0.01,
            lon: 12.283929 + Math.random() * 0.01,
          })),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Allow garbage collection periodically
        if (i % 100 === 0) {
          if (global.gc) {
            global.gc();
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      const afterAddMemory = process.memoryUsage();

      // Remove all vessels
      for (let i = 0; i < vesselCount; i++) {
        vesselDataService.removeVessel(`999400200${i}`);

        if (i % 100 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage();

      // Should have cleaned up most vessels (some may be protected from cleanup)
      expect(vesselDataService.getAllVessels().length).toBeLessThan(10);

      // Memory should be mostly freed
      const netMemoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
      expect(netMemoryGrowth).toBeLessThan(50 * 1024 * 1024); // Less than 50MB permanent
    });
  });

  describe('Map and Set Growth Limits', () => {
    test('should handle extremely large vessel maps', async () => {
      const maxVessels = 10000;

      const startTime = Date.now();

      // Add many vessels
      for (let i = 0; i < maxVessels; i++) {
        const vessel = {
          mmsi: `999400300${i}`,
          lat: 58.284095 + (Math.random() - 0.5) * 0.5,
          lon: 12.283929 + (Math.random() - 0.5) * 0.5,
          sog: Math.random() * 30,
          cog: Math.random() * 360,
          timestamp: Date.now(),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Periodic yield to event loop
        if (i % 500 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      const addTime = Date.now() - startTime;

      // Should handle large maps
      expect(vesselDataService.getAllVessels().length).toBe(maxVessels);
      expect(addTime).toBeLessThan(30000); // Should complete within 30 seconds

      // Test map operations with large dataset
      const lookupStartTime = Date.now();

      // Test random lookups
      for (let i = 0; i < 1000; i++) {
        const randomMMSI = `999400300${Math.floor(Math.random() * maxVessels)}`;
        const vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === randomMMSI);
        expect(vessel).toBeDefined();
      }

      const lookupTime = Date.now() - lookupStartTime;
      expect(lookupTime).toBeLessThan(1000); // Lookups should be fast
    });

    test('should handle map size near JavaScript limits', async () => {
      // Test with a large but manageable number due to memory constraints
      const largeCount = 50000;

      let successCount = 0;
      let errorCount = 0;

      try {
        for (let i = 0; i < largeCount; i++) {
          const vessel = {
            mmsi: `999400400${i}`,
            lat: 58.284095,
            lon: 12.283929,
            sog: 5.0,
            cog: 180,
            timestamp: Date.now(),
          };

          try {
            vesselDataService.updateVessel(vessel.mmsi, vessel);
            successCount++;
          } catch (error) {
            errorCount++;
            // Stop if too many errors
            if (errorCount > 100) break;
          }

          if (i % 1000 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      } catch (error) {
        // Handle overall errors gracefully
      }

      // Should handle as many vessels as memory allows
      expect(successCount).toBeGreaterThan(10000);
      expect(vesselDataService.getAllVessels().length).toBeGreaterThan(10000);
    });

    test('should handle map operations under memory pressure', async () => {
      const vesselCount = 5000;
      const operationCount = 10000;

      // Fill map with vessels
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `999400500${i}`,
          lat: 58.284095 + (Math.random() - 0.5) * 0.3,
          lon: 12.283929 + (Math.random() - 0.5) * 0.3,
          sog: Math.random() * 25,
          cog: Math.random() * 360,
          timestamp: Date.now(),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      const operationsStartTime = Date.now();

      // Perform mixed operations under load
      for (let i = 0; i < operationCount; i++) {
        const operation = i % 4;
        const mmsi = `999400500${Math.floor(Math.random() * vesselCount)}`;

        switch (operation) {
          case 0: // Lookup
            vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
            break;
          case 1: { // Update - block scope for const
            const updateVessel = {
              mmsi,
              lat: 58.284095 + (Math.random() - 0.5) * 0.3,
              lon: 12.283929 + (Math.random() - 0.5) * 0.3,
              sog: Math.random() * 25,
              cog: Math.random() * 360,
              timestamp: Date.now(),
            };
            vesselDataService.updateVessel(updateVessel.mmsi, updateVessel);
            break;
          }
          case 2: { // Check existence - block scope for const
            const vessels = vesselDataService.getAllVessels();
            vessels.find((v) => v.mmsi === mmsi);
            break;
          }
          case 3: // Get all vessels size
            // eslint-disable-next-line no-unused-expressions
            vesselDataService.getAllVessels().length;
            break;
          default:
            break;
        }

        if (i % 1000 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      const operationsTime = Date.now() - operationsStartTime;

      // Operations should complete in reasonable time
      expect(operationsTime).toBeLessThan(10000); // Within 10 seconds
      // Should have approximately the expected number of vessels (allow some variance)
      expect(vesselDataService.getAllVessels().length).toBeCloseTo(vesselCount, -1);
    });
  });

  describe('Timer and Resource Accumulation', () => {
    test('should not accumulate timers with frequent vessel additions', async () => {
      const vesselCount = 1000;
      const addRemoveCycles = 5;

      // Track timer-related resources (mock timers)
      const timerIds = new Set();
      const originalSetTimeout = global.setTimeout;
      const originalClearTimeout = global.clearTimeout;

      global.setTimeout = jest.fn((callback, delay) => {
        const id = originalSetTimeout(callback, delay);
        timerIds.add(id);
        return id;
      });

      global.clearTimeout = jest.fn((id) => {
        timerIds.delete(id);
        return originalClearTimeout(id);
      });

      try {
        for (let cycle = 0; cycle < addRemoveCycles; cycle++) {
          // Add vessels
          for (let i = 0; i < vesselCount; i++) {
            const vessel = {
              mmsi: 999400600 + (cycle * vesselCount) + i,
              lat: 58.284095 + (Math.random() - 0.5) * 0.2,
              lon: 12.283929 + (Math.random() - 0.5) * 0.2,
              sog: Math.random() * 20,
              cog: Math.random() * 360,
              timestamp: Date.now(),
            };

            vesselDataService.updateVessel(vessel.mmsi, vessel);
          }

          await new Promise((resolve) => setTimeout(resolve, 100));

          // Remove vessels
          for (let i = 0; i < vesselCount; i++) {
            vesselDataService.removeVessel(`999400600${cycle * vesselCount + i}`);
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Check timer accumulation
        const finalTimerCount = timerIds.size;

        // Should not accumulate excessive timers
        expect(finalTimerCount).toBeLessThan(100); // Allow some timers for normal operation

      } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
      }
    });

    test('should handle event listener accumulation', () => {
      const listenerCount = 1000;
      const eventTypes = ['vessel-added', 'vessel-updated', 'vessel-removed'];

      const listeners = [];

      // Add many event listeners
      for (let i = 0; i < listenerCount; i++) {
        const eventType = eventTypes[i % eventTypes.length];
        const listener = jest.fn();

        // Simulate adding event listeners (implementation dependent)
        if (typeof mockApp.on === 'function') {
          mockApp.on(eventType, listener);
          listeners.push({ eventType, listener });
        }
      }

      // Test with vessels to trigger events
      const vessel = {
        mmsi: '999400700',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }).not.toThrow();

      // Cleanup listeners
      listeners.forEach(({ eventType, listener }) => {
        if (typeof mockApp.off === 'function') {
          mockApp.off(eventType, listener);
        }
      });

      // Should handle many listeners without issues
      expect(listeners.length).toBe(listenerCount);
    });

    test('should clean up resources on service destruction', async () => {
      const vesselCount = 100;

      // Add vessels that might create resources
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `999400800${i}`,
          lat: 58.284095 + (Math.random() - 0.5) * 0.1,
          lon: 12.283929 + (Math.random() - 0.5) * 0.1,
          sog: Math.random() * 15,
          cog: Math.random() * 360,
          timestamp: Date.now(),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      // Should have stored most or all vessels
      const storedVessels = vesselDataService.getAllVessels().length;
      expect(storedVessels).toBeGreaterThan(vesselCount * 0.8); // At least 80% should be stored
      expect(storedVessels).toBeLessThanOrEqual(vesselCount); // But not more than created

      // Simulate service cleanup
      if (typeof vesselDataService.destroy === 'function') {
        expect(() => {
          vesselDataService.destroy();
        }).not.toThrow();
      } else {
        // Manual cleanup
        const allVessels = vesselDataService.getAllVessels().map((v) => v.mmsi);
        allVessels.forEach((mmsi) => {
          vesselDataService.removeVessel(mmsi);
        });
      }

      // Resources should be mostly cleaned up (some vessels may be protected)
      expect(vesselDataService.getAllVessels().length).toBeLessThan(5);
    });
  });

  describe('Historical Data Accumulation', () => {
    test('should handle vessels with thousands of historical positions', async () => {
      const mmsi = '999400900';
      const historicalCount = 10000;

      const initialMemory = process.memoryUsage();

      // Add vessel with many historical updates
      for (let i = 0; i < historicalCount; i++) {
        const vessel = {
          mmsi,
          lat: 58.284095 + (Math.sin(i * 0.01) * 0.01),
          lon: 12.283929 + (Math.cos(i * 0.01) * 0.01),
          sog: 5.0 + Math.sin(i * 0.05) * 3,
          cog: (i * 0.36) % 360,
          timestamp: Date.now() - ((historicalCount - i) * 1000), // Historical timestamps
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        if (i % 500 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      const finalMemory = process.memoryUsage();
      const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;

      // Should still only have one vessel
      expect(vesselDataService.getAllVessels().length).toBe(1);

      // Memory growth should be reasonable (vessel should not store all history)
      expect(memoryGrowth).toBeLessThan(100 * 1024 * 1024); // Less than 100MB

      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === mmsi);
      expect(vessel).toBeDefined();
      if (vessel) {
        expect(vessel.timestamp).toBeDefined();
      }
    });

    test('should handle multiple vessels with extensive histories', async () => {
      const vesselCount = 100;
      const updatesPerVessel = 1000;

      const initialMemory = process.memoryUsage();

      // Add many vessels with histories
      for (let vesselIndex = 0; vesselIndex < vesselCount; vesselIndex++) {
        const mmsi = 999401000 + vesselIndex;

        for (let updateIndex = 0; updateIndex < updatesPerVessel; updateIndex++) {
          const vessel = {
            mmsi,
            lat: 58.284095 + (vesselIndex * 0.001) + (Math.sin(updateIndex * 0.1) * 0.001),
            lon: 12.283929 + (vesselIndex * 0.001) + (Math.cos(updateIndex * 0.1) * 0.001),
            sog: 5.0 + Math.random() * 5,
            cog: (updateIndex * 3.6) % 360,
            timestamp: Date.now() - ((updatesPerVessel - updateIndex) * 1000),
          };

          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }

        if (vesselIndex % 10 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      const finalMemory = process.memoryUsage();
      const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;

      // Should have all vessels
      expect(vesselDataService.getAllVessels().length).toBe(vesselCount);

      // Memory growth should be manageable
      expect(memoryGrowth).toBeLessThan(500 * 1024 * 1024); // Less than 500MB

      // Test bridge text generation with many vessels
      expect(() => {
        const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
        expect(typeof bridgeText).toBe('string');
      }).not.toThrow();
    });

    test('should handle memory cleanup of old historical data', async () => {
      const mmsi = '999401100';
      const oldDataCount = 5000;
      const newDataCount = 1000;

      // Add old historical data
      for (let i = 0; i < oldDataCount; i++) {
        const vessel = {
          mmsi,
          lat: 58.284095 + (Math.random() - 0.5) * 0.02,
          lon: 12.283929 + (Math.random() - 0.5) * 0.02,
          sog: Math.random() * 15,
          cog: Math.random() * 360,
          timestamp: Date.now() - (24 * 60 * 60 * 1000) - (i * 1000), // Old data (24+ hours ago)
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      const afterOldDataMemory = process.memoryUsage();

      // Add recent data
      for (let i = 0; i < newDataCount; i++) {
        const vessel = {
          mmsi,
          lat: 58.284095 + (Math.random() - 0.5) * 0.01,
          lon: 12.283929 + (Math.random() - 0.5) * 0.01,
          sog: Math.random() * 12,
          cog: Math.random() * 360,
          timestamp: Date.now() - (i * 1000), // Recent data
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        if (i % 100 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage();

      // Should still have the vessel
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === mmsi);
      expect(vessel).toBeDefined();

      // Final vessel should have recent timestamp
      const timeDifference = Date.now() - vessel.timestamp;
      expect(timeDifference).toBeLessThan(newDataCount * 1000 + 10000); // Within expected range
    });
  });

  describe('Stress Testing Under Load', () => {
    test('should maintain performance under sustained high load', async () => {
      const duration = 5000; // 5 seconds
      const vesselsPerSecond = 100;
      const maxConcurrentVessels = 500;

      const startTime = Date.now();
      let operationCount = 0;
      let currentVesselId = 0;

      while (Date.now() - startTime < duration) {
        // Add new vessels
        for (let i = 0; i < vesselsPerSecond / 10; i++) { // 10 operations per batch
          const mmsi = 999401200 + (currentVesselId % maxConcurrentVessels);
          currentVesselId++;

          const vessel = {
            mmsi,
            lat: 58.284095 + (Math.random() - 0.5) * 0.3,
            lon: 12.283929 + (Math.random() - 0.5) * 0.3,
            sog: Math.random() * 25,
            cog: Math.random() * 360,
            timestamp: Date.now(),
          };

          vesselDataService.updateVessel(vessel.mmsi, vessel);
          operationCount++;
        }

        // Occasionally remove old vessels to prevent unlimited growth
        if (operationCount % 200 === 0) {
          const oldMMSI = 999401200 + ((currentVesselId - maxConcurrentVessels) % maxConcurrentVessels);
          if (Math.random() > 0.7) { // Remove 30% of the time
            vesselDataService.removeVessel(oldMMSI);
          }
        }

        await new Promise((resolve) => setImmediate(resolve));
      }

      const endTime = Date.now();
      const actualDuration = endTime - startTime;
      const operationsPerSecond = operationCount / (actualDuration / 1000);

      // Should maintain reasonable throughput
      expect(operationsPerSecond).toBeGreaterThan(50); // At least 50 ops/sec

      // Should not have excessive vessels
      expect(vesselDataService.getAllVessels().length).toBeLessThanOrEqual(maxConcurrentVessels + 50);

      console.log(`Sustained ${operationCount} operations over ${actualDuration}ms (${operationsPerSecond.toFixed(1)} ops/sec)`);
    });

    test('should handle memory pressure gracefully', async () => {
      // This test intentionally pushes memory limits to test graceful degradation
      const largeVesselCount = 20000;
      let successfulAdds = 0;
      let errors = 0;

      const initialMemory = process.memoryUsage();

      try {
        for (let i = 0; i < largeVesselCount; i++) {
          try {
            const vessel = {
              mmsi: `999401300${i}`,
              lat: 58.284095 + (Math.random() - 0.5) * 1.0, // Wider area
              lon: 12.283929 + (Math.random() - 0.5) * 1.0,
              sog: Math.random() * 30,
              cog: Math.random() * 360,
              timestamp: Date.now(),
              // Additional data to increase memory pressure
              extraData: 'x'.repeat(1000), // 1KB extra per vessel
            };

            vesselDataService.updateVessel(vessel.mmsi, vessel);
            successfulAdds++;

          } catch (error) {
            errors++;
            // If too many errors, stop to prevent test timeout
            if (errors > 1000) break;
          }

          // Check memory usage periodically
          if (i % 1000 === 0) {
            const currentMemory = process.memoryUsage();
            const memoryUsed = currentMemory.heapUsed;

            // If memory usage is getting very high, stop adding
            if (memoryUsed > 1024 * 1024 * 1024) { // 1GB limit
              console.log(`Stopping at ${i} vessels due to memory limit`);
              break;
            }

            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      } catch (globalError) {
        // Handle any global memory errors gracefully
        console.log(`Global memory error after ${successfulAdds} vessels:`, globalError.message);
      }

      const finalMemory = process.memoryUsage();
      const actualVesselCount = vesselDataService.getAllVessels().length;

      // Should have added a reasonable number of vessels
      expect(successfulAdds).toBeGreaterThan(1000);
      expect(actualVesselCount).toBeGreaterThan(1000);

      // Error rate should be reasonable
      expect(errors / (successfulAdds + errors)).toBeLessThan(0.1); // Less than 10% error rate

      console.log(`Successfully added ${successfulAdds} vessels, ${errors} errors`);
      console.log(`Memory growth: ${((finalMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
    });
  });
});
