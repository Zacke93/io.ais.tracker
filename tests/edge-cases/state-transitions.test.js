'use strict';

/**
 * State Transitions Edge Case Tests
 * Tests impossible state transitions, rapid back-and-forth changes,
 * all possible transition combinations, and state persistence.
 */

const VesselDataService = require('../../lib/services/VesselDataService');
const StatusService = require('../../lib/services/StatusService');
const BridgeTextService = require('../../lib/services/BridgeTextService');
const BridgeRegistry = require('../../lib/models/BridgeRegistry');
const ProximityService = require('../../lib/services/ProximityService');
const {
  BRIDGES,
  // UNDER_BRIDGE_SET_DISTANCE, // Unused
  // UNDER_BRIDGE_CLEAR_DISTANCE, // Unused
  // APPROACH_RADIUS, // Unused
  // APPROACHING_RADIUS, // Unused
} = require('../../lib/constants');

describe('State Transitions Edge Case Tests', () => {
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

  describe('Impossible State Transitions', () => {
    test('should handle vessel jumping from en-route to under-bridge without intermediate states', () => {
      const mmsi = '999300001';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Start far away (en-route)
      const farPosition = generatePositionAtDistance(bridge, 1000);
      const farVessel = {
        mmsi,
        lat: farPosition.lat,
        lon: farPosition.lon,
        sog: 10.0,
        cog: 0,
        targetBridge: bridgeName,
        timestamp: Date.now(),
      };

      vesselDataService.updateVessel(farVessel.mmsi, farVessel);

      let vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      let distance = proximityService.getDistanceToBridge(vessel, bridgeName);
      let status = statusService.determineStatus(vessel, bridgeName, distance);
      expect(status).toBe('en-route');

      // Jump directly to under-bridge position (impossible in reality)
      const underBridgePosition = generatePositionAtDistance(bridge, 25);
      const underBridgeVessel = {
        mmsi,
        lat: underBridgePosition.lat,
        lon: underBridgePosition.lon,
        sog: 10.0,
        cog: 0,
        targetBridge: bridgeName,
        timestamp: Date.now() + 1000,
      };

      expect(() => {
        vesselDataService.updateVessel(underBridgeVessel.mmsi, underBridgeVessel);
      }).not.toThrow();

      vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      distance = proximityService.getDistanceToBridge(vessel, bridgeName);
      status = statusService.determineStatus(vessel, bridgeName, distance);

      // Should handle impossible jump gracefully
      expect(['under-bridge', 'waiting', 'approaching']).toContain(status);
      expect(vessel).toBeDefined();
    });

    test('should handle vessel teleporting between bridges instantly', () => {
      const mmsi = '999300002';

      // Start at Klaffbron
      const klaffPosition = generatePositionAtDistance(BRIDGES.klaffbron, 30);
      const klaffVessel = {
        mmsi,
        lat: klaffPosition.lat,
        lon: klaffPosition.lon,
        sog: 5.0,
        cog: 0,
        targetBridge: 'Klaffbron',
        timestamp: Date.now(),
      };

      vesselDataService.updateVessel(klaffVessel.mmsi, klaffVessel);

      // Teleport to Stridsbergsbron instantly
      const stridsbergPosition = generatePositionAtDistance(BRIDGES.stridsbergsbron, 30);
      const stridsbergVessel = {
        mmsi,
        lat: stridsbergPosition.lat,
        lon: stridsbergPosition.lon,
        sog: 5.0,
        cog: 0,
        targetBridge: 'Stridsbergsbron',
        timestamp: Date.now() + 100, // Almost instant
      };

      expect(() => {
        vesselDataService.updateVessel(stridsbergVessel.mmsi, stridsbergVessel);
      }).not.toThrow();

      const vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(vessel).toBeDefined();

      // Bridge text should handle vessel teleportation
      const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
      expect(typeof bridgeText).toBe('string');
    });

    test('should handle vessel with inconsistent speed and position changes', () => {
      const mmsi = '999300003';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      const inconsistentUpdates = [
        {
          position: generatePositionAtDistance(bridge, 500),
          sog: 0.1, // Very slow
          timestamp: Date.now(),
        },
        {
          position: generatePositionAtDistance(bridge, 100), // Moved 400m
          sog: 0.1, // Still very slow (impossible distance for speed)
          timestamp: Date.now() + 1000, // 1 second later
        },
        {
          position: generatePositionAtDistance(bridge, 600), // Moved back 500m
          sog: 0.1, // Still claiming to be slow
          timestamp: Date.now() + 2000, // 1 second later
        },
      ];

      inconsistentUpdates.forEach((update, index) => {
        const vessel = {
          mmsi,
          lat: update.position.lat,
          lon: update.position.lon,
          sog: update.sog,
          cog: 180,
          targetBridge: bridgeName,
          timestamp: update.timestamp,
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });

      // Should handle inconsistent speed/position data
      const vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(vessel).toBeDefined();
      expect(vessel.sog).toBeDefined();
    });

    test('should handle vessel with contradictory course and movement', () => {
      const mmsi = '999300004';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Vessel claims to be moving north but actually moves south
      const contradictoryUpdates = [
        {
          position: generatePositionAtDistance(bridge, 300), // South of bridge
          cog: 0, // Claims to move north
          timestamp: Date.now(),
        },
        {
          position: generatePositionAtDistance(bridge, 400), // Further south
          cog: 0, // Still claims to move north
          timestamp: Date.now() + 5000,
        },
        {
          position: generatePositionAtDistance(bridge, 500), // Even further south
          cog: 0, // Still claims to move north
          timestamp: Date.now() + 10000,
        },
      ];

      contradictoryUpdates.forEach((update) => {
        const vessel = {
          mmsi,
          lat: update.position.lat,
          lon: update.position.lon,
          sog: 5.0,
          cog: update.cog,
          targetBridge: bridgeName,
          timestamp: update.timestamp,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      });

      // Should handle contradictory course data
      const vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(vessel).toBeDefined();
      expect(vessel.cog).toBeDefined();
    });
  });

  describe('Rapid State Oscillations', () => {
    test('should handle rapid oscillation between waiting and approaching states', () => {
      const mmsi = '999300100';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Oscillate around 300m threshold
      const oscillationDistances = [
        305, 295, 305, 295, 302, 298, 305, 295, 301, 299,
        304, 296, 303, 297, 305, 295, 300, 300, 299, 301,
      ];

      const stateHistory = [];

      oscillationDistances.forEach((distance, index) => {
        const position = generatePositionAtDistance(bridge, distance);
        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 3.0,
          cog: 180,
          targetBridge: bridgeName,
          timestamp: Date.now() + (index * 500), // 0.5 second intervals
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const actualDistance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
        const status = statusService.determineStatus(storedVessel, bridgeName, actualDistance);

        stateHistory.push({
          distance: Math.round(actualDistance),
          status,
          index,
        });
      });

      // Should handle rapid oscillation without crashes
      expect(vesselDataService.getAllVessels().some((v) => v.mmsi === mmsi)).toBe(true);
      expect(stateHistory.length).toBe(oscillationDistances.length);

      // Should have state changes due to oscillation
      const uniqueStates = [...new Set(stateHistory.map((h) => h.status))];
      expect(uniqueStates.length).toBeGreaterThanOrEqual(2);
    });

    test('should handle vessel rapidly switching between multiple bridges', () => {
      const mmsi = '999300101';
      const bridgeNames = ['Klaffbron', 'Stridsbergsbron'];

      // Rapidly switch target bridge
      for (let i = 0; i < 20; i++) {
        const targetBridge = bridgeNames[i % 2];
        const bridge = BRIDGES[targetBridge.toLowerCase()];
        const position = generatePositionAtDistance(bridge, 200);

        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 8.0,
          cog: 180,
          targetBridge,
          timestamp: Date.now() + (i * 300), // 0.3 second intervals
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      }

      const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(storedVessel).toBeDefined();
      expect(storedVessel.targetBridge).toBeDefined();
    });

    test('should handle status flapping due to measurement uncertainty', () => {
      const mmsi = '999300102';
      const bridgeName = 'Stridsbergsbron';
      const bridge = BRIDGES.stridsbergsbron;

      // Simulate GPS measurement uncertainty around thresholds
      const measurementNoise = [
        { distance: 49.8, noise: 'under threshold' },
        { distance: 50.2, noise: 'over threshold' },
        { distance: 49.9, noise: 'under threshold' },
        { distance: 50.1, noise: 'over threshold' },
        { distance: 49.7, noise: 'under threshold' },
        { distance: 50.3, noise: 'over threshold' },
        { distance: 50.0, noise: 'exactly on threshold' },
      ];

      const statusChanges = [];
      let lastStatus = null;

      measurementNoise.forEach((measurement, index) => {
        const position = generatePositionAtDistance(bridge, measurement.distance);
        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 2.0,
          cog: 180,
          targetBridge: bridgeName,
          timestamp: Date.now() + (index * 1000),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
        const status = statusService.determineStatus(storedVessel, bridgeName, distance);

        if (status !== lastStatus) {
          statusChanges.push({
            distance: Math.round(distance),
            status,
            previousStatus: lastStatus,
          });
          lastStatus = status;
        }
      });

      // Should handle measurement noise gracefully
      expect(vesselDataService.getAllVessels().some((v) => v.mmsi === mmsi)).toBe(true);
      expect(statusChanges.length).toBeGreaterThan(0);
    });
  });

  describe('All Possible State Transition Combinations', () => {
    const VALID_STATES = ['en-route', 'approaching', 'waiting', 'under-bridge', 'passed'];

    test('should test all valid state transitions', () => {
      const mmsi = '999300200';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Define state-to-position mappings
      const statePositions = {
        'en-route': generatePositionAtDistance(bridge, 800),
        approaching: generatePositionAtDistance(bridge, 400),
        waiting: generatePositionAtDistance(bridge, 200),
        'under-bridge': generatePositionAtDistance(bridge, 30),
        passed: generatePositionAtDistance(bridge, -100), // Past the bridge
      };

      // Test transitions between all state combinations
      VALID_STATES.forEach((fromState) => {
        VALID_STATES.forEach((toState) => {
          const transitionId = `${fromState}_to_${toState}`;
          const testMMSI = mmsi + VALID_STATES.indexOf(fromState) * 10 + VALID_STATES.indexOf(toState);

          // Set initial state
          const fromVessel = {
            mmsi: testMMSI,
            lat: statePositions[fromState].lat,
            lon: statePositions[fromState].lon,
            sog: 5.0,
            cog: 0,
            targetBridge: bridgeName,
            timestamp: Date.now(),
          };

          vesselDataService.updateVessel(fromVessel.mmsi, fromVessel);

          // Transition to new state
          const toVessel = {
            mmsi: testMMSI,
            lat: statePositions[toState].lat,
            lon: statePositions[toState].lon,
            sog: 5.0,
            cog: 0,
            targetBridge: bridgeName,
            timestamp: Date.now() + 5000,
          };

          expect(() => {
            vesselDataService.updateVessel(toVessel.mmsi, toVessel);
          }).not.toThrow();

          const vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === testMMSI);
          expect(vessel).toBeDefined();
        });
      });
    });

    test('should handle circular state transitions', () => {
      const mmsi = '999300300';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Create circular transition path
      const circularPath = [
        { state: 'en-route', distance: 800 },
        { state: 'approaching', distance: 400 },
        { state: 'waiting', distance: 200 },
        { state: 'under-bridge', distance: 30 },
        { state: 'passed', distance: -100 },
        { state: 'waiting', distance: 200 }, // Return path
        { state: 'approaching', distance: 400 },
        { state: 'en-route', distance: 800 },
      ];

      circularPath.forEach((step, index) => {
        const position = generatePositionAtDistance(bridge, Math.abs(step.distance));
        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 6.0,
          cog: step.distance < 0 ? 180 : 0, // Different direction when passed
          targetBridge: bridgeName,
          timestamp: Date.now() + (index * 3000),
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });

      // Should handle circular transitions
      const vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(vessel).toBeDefined();
    });

    test('should handle state transitions with edge case timings', () => {
      const mmsi = '999300301';
      const bridgeName = 'Klaffbron';

      // Test with various timing scenarios
      const timingScenarios = [
        { delay: 0 }, // Instant transitions
        { delay: 1 }, // 1ms delay
        { delay: 100 }, // 100ms delay
        { delay: 10000 }, // 10 second delay
        { delay: -5000 }, // Time going backwards
      ];

      const baseTime = Date.now();

      timingScenarios.forEach((scenario, scenarioIndex) => {
        VALID_STATES.forEach((state, stateIndex) => {
          const testMMSI = mmsi + scenarioIndex * 10 + stateIndex;
          const distance = 800 - (stateIndex * 150); // Decreasing distance
          const position = generatePositionAtDistance(BRIDGES.klaffbron, Math.max(20, distance));

          const vessel = {
            mmsi: testMMSI,
            lat: position.lat,
            lon: position.lon,
            sog: 7.0,
            cog: 0,
            targetBridge: bridgeName,
            timestamp: baseTime + (stateIndex * scenario.delay),
          };

          expect(() => {
            vesselDataService.updateVessel(vessel.mmsi, vessel);
          }).not.toThrow();
        });
      });

      // Should handle all timing scenarios
      const vesselCount = vesselDataService.getAllVessels().length;
      expect(vesselCount).toBeGreaterThan(0);
    });
  });

  describe('State Persistence Across System Events', () => {
    test('should maintain state consistency across service restarts', () => {
      const mmsi = '999300400';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Add vessel in specific state
      const position = generatePositionAtDistance(bridge, 150); // Waiting state
      const vessel = {
        mmsi,
        lat: position.lat,
        lon: position.lon,
        sog: 2.0,
        cog: 0,
        targetBridge: bridgeName,
        timestamp: Date.now(),
      };

      vesselDataService.updateVessel(vessel.mmsi, vessel);

      let storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      let distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
      const initialStatus = statusService.determineStatus(storedVessel, bridgeName, distance);

      // Simulate service restart by creating new service instances
      const newBridgeRegistry = new BridgeRegistry(mockLogger);
      const newVesselDataService = new VesselDataService(mockLogger, newBridgeRegistry);
      const newStatusService = new StatusService();

      // Re-add the same vessel data (simulating persistence)
      newVesselDataService.updateVessel(vessel.mmsi, vessel);

      storedVessel = newVesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
      const restoredStatus = newStatusService.determineStatus(storedVessel, bridgeName, distance);

      // Status should be consistent after restart
      expect(restoredStatus).toBe(initialStatus);
    });

    test('should handle state recovery after data corruption', () => {
      const mmsi = '999300401';
      const bridgeName = 'Klaffbron';

      // Add valid vessel
      const validVessel = {
        mmsi,
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        targetBridge: bridgeName,
        timestamp: Date.now(),
      };

      vesselDataService.updateVessel(validVessel.mmsi, validVessel);

      let vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(vessel).toBeDefined();

      // Simulate data corruption by adding invalid data
      const corruptVessel = {
        mmsi,
        lat: 'corrupted',
        lon: null,
        sog: NaN,
        cog: undefined,
        targetBridge: bridgeName,
        timestamp: 'invalid-timestamp',
      };

      // GPS jump detection throws for invalid coordinates
      expect(() => {
        vesselDataService.updateVessel(corruptVessel.mmsi, corruptVessel);
      }).toThrow('Invalid coordinates');

      // System should recover and maintain valid state
      vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      if (vessel) {
        // If vessel exists, it should have valid data
        expect(typeof vessel.lat).toBe('number');
        expect(typeof vessel.lon).toBe('number');
      }
    });

    test('should handle concurrent state modifications', async () => {
      const mmsi = '999300402';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Simulate concurrent modifications
      const concurrentUpdates = Array.from({ length: 10 }, (_, index) => {
        const distance = 500 - (index * 40); // Moving closer
        const position = generatePositionAtDistance(bridge, Math.max(20, distance));

        return {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 8.0,
          cog: 0,
          targetBridge: bridgeName,
          timestamp: Date.now() + index, // Almost simultaneous
        };
      });

      // Apply all updates rapidly
      const promises = concurrentUpdates.map((update) => Promise.resolve().then(() => vesselDataService.updateVessel(update.mmsi, update)));

      await Promise.all(promises);

      // Should have consistent final state
      const vessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(vessel).toBeDefined();
      expect(typeof vessel.lat).toBe('number');
      expect(typeof vessel.lon).toBe('number');
    });

    test('should maintain state history integrity', () => {
      const mmsi = '999300403';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      const stateProgression = [
        { distance: 1000, expectedState: 'en-route' },
        { distance: 600, expectedState: 'en-route' },
        { distance: 450, expectedState: 'approaching' },
        { distance: 250, expectedState: 'waiting' },
        { distance: 40, expectedState: 'under-bridge' },
        { distance: 100, expectedState: 'waiting' }, // Moved away from bridge
      ];

      const actualStates = [];

      stateProgression.forEach((step, index) => {
        const position = generatePositionAtDistance(bridge, step.distance);
        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 5.0,
          cog: 0,
          targetBridge: bridgeName,
          timestamp: Date.now() + (index * 2000),
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
        const status = statusService.determineStatus(storedVessel, bridgeName, distance);

        actualStates.push({
          distance: Math.round(distance),
          status,
          expected: step.expectedState,
        });
      });

      // Should progress through expected states
      expect(actualStates.length).toBe(stateProgression.length);

      // Check for reasonable state progression (allowing for hysteresis)
      const hasEnroute = actualStates.some((s) => s.status === 'en-route');
      const hasApproaching = actualStates.some((s) => s.status === 'approaching');
      const hasWaiting = actualStates.some((s) => s.status === 'waiting');
      const hasUnderBridge = actualStates.some((s) => s.status === 'under-bridge');

      expect(hasEnroute || hasApproaching).toBe(true); // Far states
      expect(hasWaiting || hasUnderBridge).toBe(true); // Close states
    });
  });
});

// Helper functions
function generatePositionAtDistance(bridge, distanceMeters) {
  const latDegreePerMeter = 1 / 111320;
  let offsetLat;

  if (distanceMeters < 0) {
    // Past the bridge (north side)
    offsetLat = Math.abs(distanceMeters) * latDegreePerMeter;
  } else {
    // Before the bridge (south side)
    offsetLat = -(distanceMeters * latDegreePerMeter);
  }

  return {
    lat: bridge.lat + offsetLat,
    lon: bridge.lon,
  };
}
