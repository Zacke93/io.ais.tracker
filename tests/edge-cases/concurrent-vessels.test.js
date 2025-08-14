'use strict';

/**
 * Concurrent Vessels Edge Case Tests
 * Tests system behavior with many simultaneous vessels, identical positions/MMSI,
 * rapid additions/removals, and memory usage under heavy load.
 */

const VesselDataService = require('../../lib/services/VesselDataService');
const StatusService = require('../../lib/services/StatusService');
const BridgeTextService = require('../../lib/services/BridgeTextService');
const BridgeRegistry = require('../../lib/models/BridgeRegistry');
const ProximityService = require('../../lib/services/ProximityService');
const { BRIDGES } = require('../../lib/constants');

describe('Concurrent Vessels Edge Case Tests', () => {
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

  describe('High Volume Concurrent Vessels', () => {
    test('should handle 50+ vessels simultaneously', () => {
      const vesselCount = 75;
      const startTime = Date.now();

      // Add many vessels
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `900000000${i}`,
          lat: 58.284095 + (Math.random() - 0.5) * 0.1, // Random positions around Klaffbron
          lon: 12.283929 + (Math.random() - 0.5) * 0.1,
          sog: Math.random() * 20,
          cog: Math.random() * 360,
          timestamp: Date.now() + i,
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      }

      const allVessels = vesselDataService.getAllVessels();
      expect(allVessels.length).toBe(vesselCount);

      // Test bridge text generation with many vessels
      expect(() => {
        const bridgeText = bridgeTextService.generateBridgeText(allVessels);
        expect(typeof bridgeText).toBe('string');
      }).not.toThrow();

      const processingTime = Date.now() - startTime;
      expect(processingTime).toBeLessThan(5000); // Should complete within 5 seconds
    });

    test('should handle 100+ vessels with performance tracking', () => {
      const vesselCount = 150;
      const performanceMetrics = {
        addTime: 0,
        updateTime: 0,
        bridgeTextTime: 0,
        memoryBefore: process.memoryUsage(),
      };

      // Add vessels
      const addStart = Date.now();
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `800000000${i}`,
          lat: 58.284095 + (Math.random() - 0.5) * 0.2,
          lon: 12.283929 + (Math.random() - 0.5) * 0.2,
          sog: Math.random() * 30,
          cog: Math.random() * 360,
          timestamp: Date.now(),
        };
        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }
      performanceMetrics.addTime = Date.now() - addStart;

      // Update all vessels
      const updateStart = Date.now();
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `800000000${i}`,
          lat: 58.284095 + (Math.random() - 0.5) * 0.2,
          lon: 12.283929 + (Math.random() - 0.5) * 0.2,
          sog: Math.random() * 30,
          cog: Math.random() * 360,
          timestamp: Date.now() + 1000,
        };
        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }
      performanceMetrics.updateTime = Date.now() - updateStart;

      // Generate bridge text
      const bridgeTextStart = Date.now();
      const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
      performanceMetrics.bridgeTextTime = Date.now() - bridgeTextStart;

      performanceMetrics.memoryAfter = process.memoryUsage();

      // Performance assertions
      expect(performanceMetrics.addTime).toBeLessThan(3000); // 3 seconds for adding
      expect(performanceMetrics.updateTime).toBeLessThan(3000); // 3 seconds for updating
      expect(performanceMetrics.bridgeTextTime).toBeLessThan(1000); // 1 second for bridge text

      // Memory usage should not grow excessively
      const memoryGrowth = performanceMetrics.memoryAfter.heapUsed - performanceMetrics.memoryBefore.heapUsed;
      expect(memoryGrowth).toBeLessThan(100 * 1024 * 1024); // Less than 100MB growth

      expect(vesselDataService.getAllVessels().length).toBe(vesselCount);
      expect(typeof bridgeText).toBe('string');
    });

    test('should handle vessel burst loading', () => {
      // Simulate receiving many vessels in rapid succession (like initial AIS load)
      const burstSize = 200;
      const vessels = [];

      // Prepare vessels
      for (let i = 0; i < burstSize; i++) {
        vessels.push({
          mmsi: `700000000${i}`,
          lat: 58.284095 + (Math.random() - 0.5) * 0.5, // Wider area
          lon: 12.283929 + (Math.random() - 0.5) * 0.5,
          sog: Math.random() * 25,
          cog: Math.random() * 360,
          timestamp: Date.now() + Math.random() * 1000,
        });
      }

      // Add all vessels rapidly
      const startTime = Date.now();
      expect(() => {
        vessels.forEach((vessel) => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        });
      }).not.toThrow();

      const processingTime = Date.now() - startTime;
      expect(processingTime).toBeLessThan(10000); // Should handle burst within 10 seconds
      expect(vesselDataService.getAllVessels().length).toBe(burstSize);
    });
  });

  describe('Identical Position Scenarios', () => {
    test('should handle multiple vessels at exactly same position', () => {
      const sharedPosition = {
        lat: BRIDGES.klaffbron.lat,
        lon: BRIDGES.klaffbron.lon,
      };

      const vesselCount = 10;
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `600000000${i}`,
          lat: sharedPosition.lat,
          lon: sharedPosition.lon,
          sog: 5.0 + i, // Different speeds
          cog: i * 36, // Different courses (0, 36, 72, ...)
          timestamp: Date.now() + i * 100,
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      }

      expect(vesselDataService.getAllVessels().length).toBe(vesselCount);

      // All vessels should have same distance to bridge (0)
      const allVessels = vesselDataService.getAllVessels();
      allVessels.forEach((vessel) => {
        const distance = proximityService.getDistanceToBridge(vessel, 'Klaffbron');
        expect(distance).toBeLessThan(1); // Very close to 0
      });

      // Bridge text should handle multiple vessels at same location
      const bridgeText = bridgeTextService.generateBridgeText(allVessels);
      expect(typeof bridgeText).toBe('string');
      expect(bridgeText.length).toBeGreaterThan(0);
    });

    test('should handle vessels oscillating around same position', () => {
      const basePosition = {
        lat: 58.293524, // Near Stridsbergsbron
        lon: 12.294566,
      };

      const mmsi = '600000100';

      // Simulate vessel oscillating around position
      for (let i = 0; i < 20; i++) {
        const vessel = {
          mmsi,
          lat: basePosition.lat + Math.sin(i * 0.5) * 0.0001, // Small oscillation
          lon: basePosition.lon + Math.cos(i * 0.5) * 0.0001,
          sog: 2.0 + Math.random(),
          cog: (i * 18) % 360, // Rotating course
          timestamp: Date.now() + i * 1000,
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      }

      // Should still only have one vessel stored
      expect(vesselDataService.getAllVessels().length).toBe(1);
      const vessels = vesselDataService.getAllVessels();
      expect(vessels.find((v) => v.mmsi === mmsi)).toBeDefined();
    });
  });

  describe('Duplicate MMSI Scenarios', () => {
    test('should handle identical MMSI values (collision scenario)', () => {
      const duplicateMMSI = '123456789';

      // First vessel
      const vessel1 = {
        mmsi: duplicateMMSI,
        lat: 58.284095,
        lon: 12.283929,
        sog: 10.0,
        cog: 0,
        timestamp: Date.now(),
      };

      // Second vessel with same MMSI but different position
      const vessel2 = {
        mmsi: duplicateMMSI,
        lat: 58.293524,
        lon: 12.294566,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now() + 1000, // Later timestamp
      };

      vesselDataService.updateVessel(vessel1.mmsi, vessel1);
      vesselDataService.updateVessel(vessel2.mmsi, vessel2);

      // Should only have one vessel (later timestamp overwrites)
      expect(vesselDataService.getAllVessels().length).toBe(1);

      const vessels = vesselDataService.getAllVessels();
      const storedVessel = vessels.find((v) => v.mmsi === duplicateMMSI);
      expect(storedVessel.lat).toBe(vessel2.lat);
      expect(storedVessel.lon).toBe(vessel2.lon);
    });

    test('should handle rapid MMSI collisions', () => {
      const duplicateMMSI = '987654321';
      const updateCount = 50;

      // Rapid updates with same MMSI from different positions
      for (let i = 0; i < updateCount; i++) {
        const vessel = {
          mmsi: duplicateMMSI,
          lat: 58.284095 + (Math.random() - 0.5) * 0.1,
          lon: 12.283929 + (Math.random() - 0.5) * 0.1,
          sog: Math.random() * 20,
          cog: Math.random() * 360,
          timestamp: Date.now() + i * 100,
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      }

      // Should still only have one vessel
      expect(vesselDataService.getAllVessels().length).toBe(1);
      const vessels = vesselDataService.getAllVessels();
      expect(vessels.find((v) => v.mmsi === duplicateMMSI)).toBeDefined();
    });
  });

  describe('Rapid Vessel Operations', () => {
    test('should handle rapid addition and removal', () => {
      const operationCount = 100;
      const mmsiBase = '500000000';

      // Rapid additions
      for (let i = 0; i < operationCount; i++) {
        const vessel = {
          mmsi: mmsiBase + i,
          lat: 58.284095 + (Math.random() - 0.5) * 0.1,
          lon: 12.283929 + (Math.random() - 0.5) * 0.1,
          sog: Math.random() * 20,
          cog: Math.random() * 360,
          timestamp: Date.now(),
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      }

      expect(vesselDataService.getAllVessels().length).toBe(operationCount);

      // Rapid removals
      for (let i = 0; i < operationCount; i += 2) { // Remove every other vessel
        expect(() => {
          vesselDataService.removeVessel(mmsiBase + i, 'force'); // Use force to bypass protection
        }).not.toThrow();
      }

      // Some vessels may remain due to protection zones - allow some variance
      const remainingVessels = vesselDataService.getAllVessels().length;
      expect(remainingVessels).toBeGreaterThanOrEqual(operationCount / 2 - 5);
      expect(remainingVessels).toBeLessThanOrEqual(operationCount);
    });

    test('should handle concurrent add/update/remove operations', () => {
      const mmsiBase = '400000000';
      const cycleCount = 50;

      for (let cycle = 0; cycle < cycleCount; cycle++) {
        const mmsi = mmsiBase + cycle;

        // Add vessel
        let vessel = {
          mmsi,
          lat: 58.284095,
          lon: 12.283929,
          sog: 5.0,
          cog: 0,
          timestamp: Date.now(),
        };
        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Update vessel
        vessel = {
          mmsi,
          lat: 58.284095 + 0.001,
          lon: 12.283929 + 0.001,
          sog: 10.0,
          cog: 90,
          timestamp: Date.now() + 1000,
        };
        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Remove some vessels
        if (cycle % 3 === 0) {
          vesselDataService.removeVessel(mmsi);
        }
      }

      // Should have vessels remaining (those not removed)
      const remainingCount = Math.floor(cycleCount * 2 / 3);
      expect(vesselDataService.getAllVessels().length).toBeGreaterThanOrEqual(remainingCount - 5); // Allow some variance
    });
  });

  describe('Memory Stress Testing', () => {
    test('should not accumulate memory with repeated updates', () => {
      const mmsi = '300000000';
      const updateCycles = 1000;

      const initialMemory = process.memoryUsage().heapUsed;

      // Many updates for same vessel
      for (let i = 0; i < updateCycles; i++) {
        const vessel = {
          mmsi,
          lat: 58.284095 + Math.sin(i * 0.1) * 0.001,
          lon: 12.283929 + Math.cos(i * 0.1) * 0.001,
          sog: 5.0 + Math.random(),
          cog: (i * 3.6) % 360,
          timestamp: Date.now() + i,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Force garbage collection periodically if available
        if (i % 100 === 0 && global.gc) {
          global.gc();
        }
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;

      // Should only have one vessel despite many updates
      expect(vesselDataService.getAllVessels().length).toBe(1);

      // Memory growth should be minimal (less than 10MB for repeated updates)
      expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024);
    });

    test('should handle memory stress with many different vessels', () => {
      const vesselCount = 500;
      const mmsiBase = '200000000';

      const initialMemory = process.memoryUsage();

      // Add many vessels
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: mmsiBase + i,
          lat: 58.284095 + (Math.random() - 0.5) * 0.3,
          lon: 12.283929 + (Math.random() - 0.5) * 0.3,
          sog: Math.random() * 30,
          cog: Math.random() * 360,
          timestamp: Date.now(),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      const afterAddMemory = process.memoryUsage();

      // Remove all vessels with force to bypass protection
      for (let i = 0; i < vesselCount; i++) {
        vesselDataService.removeVessel(mmsiBase + i, 'force');
      }

      // Clear timers to help with cleanup
      if (typeof vesselDataService.clearAllTimers === 'function') {
        vesselDataService.clearAllTimers();
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage();

      // Some vessels may remain due to protection logic - allow variance
      const remainingVessels = vesselDataService.getAllVessels().length;
      expect(remainingVessels).toBeLessThanOrEqual(5); // Allow a few to remain

      // Memory should be mostly freed after removal
      const netMemoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
      expect(netMemoryGrowth).toBeLessThan(50 * 1024 * 1024); // Less than 50MB permanent growth
    });
  });

  describe('Bridge Text with Many Vessels', () => {
    test('should generate coherent bridge text with 50+ vessels', () => {
      const vesselCount = 75;

      // Add vessels near different bridges
      for (let i = 0; i < vesselCount; i++) {
        const bridges = Object.keys(BRIDGES);
        const bridgeKey = bridges[i % bridges.length];
        const bridge = BRIDGES[bridgeKey];

        const vessel = {
          mmsi: `100000000${i}`,
          lat: bridge.lat + (Math.random() - 0.5) * 0.01, // Near each bridge
          lon: bridge.lon + (Math.random() - 0.5) * 0.01,
          sog: Math.random() * 15,
          cog: Math.random() * 360,
          timestamp: Date.now() + i,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      const allVessels = vesselDataService.getAllVessels();
      expect(allVessels.length).toBe(vesselCount);

      // Bridge text generation should handle many vessels
      expect(() => {
        const bridgeText = bridgeTextService.generateBridgeText(allVessels);
        expect(typeof bridgeText).toBe('string');
        expect(bridgeText.length).toBeGreaterThan(0);
      }).not.toThrow();
    });

    test('should handle many vessels at same bridge', () => {
      const vesselCount = 25;
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Add many vessels near same bridge
      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `50000000${i}`,
          lat: bridge.lat + (Math.random() - 0.5) * 0.002, // Very close to bridge
          lon: bridge.lon + (Math.random() - 0.5) * 0.002,
          sog: Math.random() * 10,
          cog: Math.random() * 360,
          targetBridge: bridgeName,
          timestamp: Date.now() + i,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());

      // Should mention the bridge and handle multiple vessels
      expect(bridgeText).toContain(bridgeName);
      expect(typeof bridgeText).toBe('string');
      expect(bridgeText.length).toBeGreaterThan(10);
    });
  });
});
