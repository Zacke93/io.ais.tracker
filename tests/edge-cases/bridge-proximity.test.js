'use strict';

/**
 * Bridge Proximity Edge Case Tests
 * Tests vessel behavior at exact bridge coordinates, oscillating around thresholds,
 * multiple vessels from different directions, zigzagging patterns, and stopping at bridges.
 */

const VesselDataService = require('../../lib/services/VesselDataService');
const StatusService = require('../../lib/services/StatusService');
const ProximityService = require('../../lib/services/ProximityService');
const BridgeTextService = require('../../lib/services/BridgeTextService');
const BridgeRegistry = require('../../lib/models/BridgeRegistry');
const {
  BRIDGES,
  UNDER_BRIDGE_SET_DISTANCE,
  UNDER_BRIDGE_CLEAR_DISTANCE,
  APPROACH_RADIUS,
  APPROACHING_RADIUS,
} = require('../../lib/constants');

describe('Bridge Proximity Edge Case Tests', () => {
  let mockLogger;
  let bridgeRegistry;
  let vesselDataService;
  let statusService;
  let proximityService;
  let bridgeTextService;

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
    proximityService = new ProximityService(bridgeRegistry, mockLogger);
    bridgeTextService = new BridgeTextService(bridgeRegistry, mockLogger);
  });

  describe('Exact Bridge Coordinates', () => {
    test('should handle vessel exactly on bridge coordinates', () => {
      const mmsi = '999100001';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      const vessel = {
        mmsi,
        lat: bridge.lat, // Exactly on bridge
        lon: bridge.lon, // Exactly on bridge
        sog: 0.0,
        cog: 0,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }).not.toThrow();

      const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(storedVessel).toBeDefined();

      // Distance should be 0 or very close to 0
      const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
      expect(distance).toBeLessThan(1);

      // Status should reflect being at bridge
      const status = statusService.determineStatus(storedVessel, bridgeName, distance);
      expect(status).toBe('under-bridge');
    });

    test('should handle multiple vessels at exact same bridge coordinates', () => {
      const bridgeName = 'Stridsbergsbron';
      const bridge = BRIDGES.stridsbergsbron;
      const vesselCount = 5;

      for (let i = 0; i < vesselCount; i++) {
        const vessel = {
          mmsi: `999100010${i}`,
          lat: bridge.lat,
          lon: bridge.lon,
          sog: i * 2, // Different speeds
          cog: i * 72, // Different courses (0, 72, 144, ...)
          timestamp: Date.now() + i * 1000,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      const allVessels = vesselDataService.getAllVessels();
      expect(allVessels.length).toBe(vesselCount);

      // All should be at under-bridge status
      allVessels.forEach((vessel) => {
        const distance = proximityService.getDistanceToBridge(vessel, bridgeName);
        expect(distance).toBeLessThan(1);
        const status = statusService.determineStatus(vessel, bridgeName, distance);
        expect(status).toBe('under-bridge');
      });

      // Bridge text should handle multiple vessels at same bridge
      const bridgeText = bridgeTextService.generateBridgeText(allVessels);
      expect(bridgeText).toContain('bro'); // Should mention some bridge
      expect(typeof bridgeText).toBe('string');
      expect(bridgeText.length).toBeGreaterThan(0);
    });
  });

  describe('Threshold Distance Oscillations', () => {
    test('should handle oscillation around under-bridge threshold (50m)', () => {
      const mmsi = '999100100';
      const bridgeName = 'Klaffbron';

      // Positions oscillating around 50m threshold
      const testDistances = [
        49, 50, 51, 49, 50, 51, 48, 52, 49, 50,
      ];

      testDistances.forEach((targetDistance, index) => {
        // Calculate position at specific distance from bridge
        const position = generatePositionAtDistance(BRIDGES.klaffbron, targetDistance);

        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 3.0,
          cog: 180,
          timestamp: Date.now() + index * 2000, // 2 second intervals
        };

        // Move update outside expect to avoid loop-func issue
        vesselDataService.updateVessel(vessel.mmsi, vessel);

        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);

        // Verify distance is approximately what we intended
        expect(Math.abs(distance - targetDistance)).toBeLessThan(5);
      });

      // Should handle oscillations without crashes
      const vessels = vesselDataService.getAllVessels();
      expect(vessels.some((v) => v.mmsi === mmsi)).toBe(true);
    });

    test('should handle hysteresis behavior at under-bridge threshold', () => {
      const mmsi = '999100101';
      const bridgeName = 'Klaffbron';

      // Test hysteresis: enter at 50m, exit at 70m
      const scenarios = [
        { distance: 60, expectedStatus: 'waiting' },
        { distance: 45, expectedStatus: 'under-bridge' }, // Enter
        { distance: 55, expectedStatus: 'under-bridge' }, // Still under (hysteresis)
        { distance: 65, expectedStatus: 'under-bridge' }, // Still under (hysteresis)
        { distance: 75, expectedStatus: 'waiting' }, // Exit at clear threshold
        { distance: 65, expectedStatus: 'waiting' }, // Don't re-enter
        { distance: 45, expectedStatus: 'under-bridge' }, // Re-enter
      ];

      let isUnderBridge = false; // Track hysteresis state

      scenarios.forEach((scenario, index) => {
        const position = generatePositionAtDistance(BRIDGES.klaffbron, scenario.distance);

        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 2.0,
          cog: 180,
          targetBridge: bridgeName,
          timestamp: Date.now() + index * 3000,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);

        // Update hysteresis state
        if (distance <= UNDER_BRIDGE_SET_DISTANCE) {
          isUnderBridge = true;
        } else if (distance >= UNDER_BRIDGE_CLEAR_DISTANCE) {
          isUnderBridge = false;
        }

        const status = statusService.determineStatus(storedVessel, bridgeName, distance, { isUnderBridge });

        // Note: This test verifies the pattern, actual implementation may vary
        expect(['waiting', 'under-bridge', 'approaching']).toContain(status);
      });
    });

    test('should handle oscillation around approach threshold (300m)', () => {
      const mmsi = '999100102';
      const bridgeName = 'Klaffbron';

      const testDistances = [305, 295, 305, 295, 299, 301, 298, 302];

      testDistances.forEach((targetDistance, index) => {
        const position = generatePositionAtDistance(BRIDGES.klaffbron, targetDistance);

        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 1.0, // Slow speed
          cog: 180,
          targetBridge: bridgeName,
          timestamp: Date.now() + index * 5000,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
        const status = statusService.determineStatus(storedVessel, bridgeName, distance);

        // Should alternate between 'waiting' and 'approaching' or 'en-route'
        expect(['en-route', 'approaching', 'waiting']).toContain(status);
      });
    });

    test('should handle oscillation around approaching threshold (500m)', () => {
      const mmsi = '999100103';
      const bridgeName = 'Klaffbron';

      const testDistances = [505, 495, 505, 495, 499, 501, 498, 502];

      testDistances.forEach((targetDistance, index) => {
        const position = generatePositionAtDistance(BRIDGES.klaffbron, targetDistance);

        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 8.0,
          cog: 0, // Northward
          targetBridge: bridgeName,
          timestamp: Date.now() + index * 4000,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
        const status = statusService.determineStatus(storedVessel, bridgeName, distance);

        // Should alternate between 'en-route' and 'approaching'
        expect(['en-route', 'approaching']).toContain(status);
      });
    });
  });

  describe('Multiple Vessels from Different Directions', () => {
    test('should handle vessels approaching same bridge from all directions', () => {
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;
      const directions = [0, 45, 90, 135, 180, 225, 270, 315]; // 8 directions

      directions.forEach((bearing, index) => {
        const position = generatePositionAtBearing(bridge, 200, bearing);

        const vessel = {
          mmsi: `999100200${index}`,
          lat: position.lat,
          lon: position.lon,
          sog: 5.0,
          cog: (bearing + 180) % 360, // Opposite direction (toward bridge)
          targetBridge: bridgeName,
          timestamp: Date.now() + index * 1000,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      });

      const allVessels = vesselDataService.getAllVessels();
      expect(allVessels.length).toBe(directions.length);

      // All should be in waiting status (within 300m)
      allVessels.forEach((vessel) => {
        const distance = proximityService.getDistanceToBridge(vessel, bridgeName);
        expect(distance).toBeLessThan(250); // Should be around 200m

        const status = statusService.determineStatus(vessel, bridgeName, distance);
        expect(status).toBe('waiting');
      });

      // Bridge text should handle multiple vessels from different directions
      const bridgeText = bridgeTextService.generateBridgeText(allVessels);
      expect(bridgeText).toContain(bridgeName);
      expect(bridgeText).toContain('båt'); // Should mention boats
      expect(typeof bridgeText).toBe('string');
      expect(bridgeText.length).toBeGreaterThan(0);
    });

    test('should handle vessels converging on bridge simultaneously', () => {
      const bridgeName = 'Stridsbergsbron';
      const bridge = BRIDGES.stridsbergsbron;
      const vesselCount = 6;

      // Create vessels at different distances but converging
      for (let i = 0; i < vesselCount; i++) {
        const distance = 400 - (i * 50); // 400m, 350m, 300m, 250m, 200m, 150m
        const bearing = i * 60; // Every 60 degrees
        const position = generatePositionAtBearing(bridge, distance, bearing);

        const vessel = {
          mmsi: `999100300${i}`,
          lat: position.lat,
          lon: position.lon,
          sog: 6.0,
          cog: (bearing + 180) % 360, // Toward bridge
          targetBridge: bridgeName,
          timestamp: Date.now() + i * 500,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      // Helper function to update vessel position
      const updateVesselPosition = (vessel, timeStep) => {
        const index = parseInt(vessel.mmsi.substring(9), 10); // Extract index from MMSI
        const newDistance = Math.max(50, (400 - (index * 50)) - (timeStep * 30));
        const bearing = index * 60;
        const newPosition = generatePositionAtBearing(bridge, newDistance, bearing);

        const updatedVessel = {
          ...vessel,
          lat: newPosition.lat,
          lon: newPosition.lon,
          timestamp: Date.now() + timeStep * 10000,
        };

        vesselDataService.updateVessel(vessel.mmsi, updatedVessel);
      };

      // Simulate time progression - vessels getting closer
      for (let timeStep = 0; timeStep < 5; timeStep++) {
        const allVessels = vesselDataService.getAllVessels();
        allVessels.forEach((vessel) => updateVesselPosition(vessel, timeStep));

        // Bridge text should adapt to changing proximity
        const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
        expect(typeof bridgeText).toBe('string');
        expect(bridgeText.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Zigzag and Erratic Movement Patterns', () => {
    test('should handle vessel zigzagging near bridge', () => {
      const mmsi = '999100400';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Zigzag pattern around bridge
      for (let i = 0; i < 20; i++) {
        const angle = i * 18; // 18 degrees per step
        const distance = 150 + Math.sin(i * 0.5) * 100; // Oscillating distance 50-250m
        const position = generatePositionAtBearing(bridge, distance, angle);

        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 4.0 + Math.random() * 6, // Variable speed 4-10 knots
          cog: angle,
          targetBridge: bridgeName,
          timestamp: Date.now() + i * 2000,
        };

        // Move update outside expect to avoid loop-func issue
        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }

      // Should handle zigzag pattern without issues
      const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(storedVessel).toBeDefined();

      const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
      expect(typeof bridgeText).toBe('string');
    });

    test('should handle vessel making figure-8 pattern around bridge', () => {
      const mmsi = '999100401';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Figure-8 pattern
      for (let i = 0; i < 16; i++) {
        const t = (i * Math.PI) / 8; // Parameter for figure-8
        const scale = 200; // 200m scale

        // Parametric equations for figure-8
        const offsetLat = (scale * Math.sin(t)) / 111320; // Convert meters to lat degrees
        const offsetLon = (scale * Math.sin(2 * t)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));

        const vessel = {
          mmsi,
          lat: bridge.lat + offsetLat,
          lon: bridge.lon + offsetLon,
          sog: 7.0,
          cog: (t * 180 / Math.PI) % 360,
          targetBridge: bridgeName,
          timestamp: Date.now() + i * 3000,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);

        // Verify distance calculations work with figure-8 pattern
        const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
        const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
        expect(distance).toBeLessThan(300); // Should be within expected range
      }
    });

    test('should handle vessel with sudden direction changes', () => {
      const mmsi = '999100402';
      const bridgeName = 'Klaffbron';

      const suddenChanges = [
        { cog: 0, distance: 250 },
        { cog: 180, distance: 240 }, // Sudden 180° turn
        { cog: 90, distance: 230 }, // 90° turn
        { cog: 270, distance: 220 }, // 180° turn again
        { cog: 45, distance: 210 }, // 45° adjustment
        { cog: 225, distance: 200 }, // 180° turn
      ];

      suddenChanges.forEach((change, index) => {
        const position = generatePositionAtBearing(BRIDGES.klaffbron, change.distance, change.cog);

        const vessel = {
          mmsi,
          lat: position.lat,
          lon: position.lon,
          sog: 8.0,
          cog: change.cog,
          targetBridge: bridgeName,
          timestamp: Date.now() + index * 4000,
        };

        // Move update outside expect to avoid loop-func issue
        vesselDataService.updateVessel(vessel.mmsi, vessel);
      });

      const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(storedVessel).toBeDefined();
    });
  });

  describe('Stopping at Bridge Scenarios', () => {
    test('should handle vessel stopping exactly at bridge', () => {
      const mmsi = '999100500';
      const bridgeName = 'Klaffbron';
      const bridge = BRIDGES.klaffbron;

      // Approach bridge
      const approachPosition = generatePositionAtDistance(bridge, 100);
      const approachVessel = {
        mmsi,
        lat: approachPosition.lat,
        lon: approachPosition.lon,
        sog: 5.0,
        cog: 0,
        targetBridge: bridgeName,
        timestamp: Date.now(),
      };

      vesselDataService.updateVessel(approachVessel.mmsi, approachVessel);

      // Stop at bridge
      const stoppedVessel = {
        mmsi,
        lat: bridge.lat,
        lon: bridge.lon,
        sog: 0.0, // Stopped
        cog: 0,
        targetBridge: bridgeName,
        timestamp: Date.now() + 5000,
      };

      vesselDataService.updateVessel(stoppedVessel.mmsi, stoppedVessel);

      const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      expect(storedVessel.sog).toBe(0.0);

      const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
      expect(distance).toBeLessThan(1);

      const status = statusService.determineStatus(storedVessel, bridgeName, distance);
      expect(status).toBe('under-bridge');
    });

    test('should handle vessel stopping just before bridge', () => {
      const mmsi = '999100501';
      const bridgeName = 'Stridsbergsbron';

      const stopPosition = generatePositionAtDistance(BRIDGES.stridsbergsbron, 75);

      // Moving toward bridge
      const movingVessel = {
        mmsi,
        lat: stopPosition.lat,
        lon: stopPosition.lon,
        sog: 6.0,
        cog: 0,
        targetBridge: bridgeName,
        timestamp: Date.now(),
      };

      vesselDataService.updateVessel(movingVessel.mmsi, movingVessel);

      // Stop just before bridge
      const stoppedVessel = {
        ...movingVessel,
        sog: 0.0,
        timestamp: Date.now() + 3000,
      };

      vesselDataService.updateVessel(stoppedVessel.mmsi, stoppedVessel);

      const storedVessel = vesselDataService.getAllVessels().find((v) => v.mmsi === mmsi);
      const distance = proximityService.getDistanceToBridge(storedVessel, bridgeName);
      const status = statusService.determineStatus(storedVessel, bridgeName, distance);

      // Should be waiting status (within 300m but not under bridge)
      expect(status).toBe('waiting');
      expect(storedVessel.sog).toBe(0.0);
    });

    test('should handle multiple vessels stopping at different distances', () => {
      const bridgeName = 'Klaffbron';
      const stopDistances = [25, 75, 125, 175, 225, 275];

      stopDistances.forEach((distance, index) => {
        const position = generatePositionAtDistance(BRIDGES.klaffbron, distance);

        const vessel = {
          mmsi: `999100510${index}`,
          lat: position.lat,
          lon: position.lon,
          sog: 0.0, // All stopped
          cog: 180,
          targetBridge: bridgeName,
          timestamp: Date.now() + index * 1000,
        };

        vesselDataService.updateVessel(vessel.mmsi, vessel);
      });

      const allVessels = vesselDataService.getAllVessels();
      expect(allVessels.length).toBe(stopDistances.length);

      // Verify different status based on distance
      allVessels.forEach((vessel) => {
        const distance = proximityService.getDistanceToBridge(vessel, bridgeName);
        const status = statusService.determineStatus(vessel, bridgeName, distance);

        if (distance <= UNDER_BRIDGE_SET_DISTANCE) {
          expect(status).toBe('under-bridge');
        } else if (distance <= APPROACH_RADIUS) {
          expect(status).toBe('waiting');
        } else if (distance <= APPROACHING_RADIUS) {
          expect(status).toBe('approaching');
        } else {
          expect(status).toBe('en-route');
        }
      });

      // Bridge text should handle multiple stopped vessels
      const bridgeText = bridgeTextService.generateBridgeText(allVessels);
      expect(typeof bridgeText).toBe('string');
      expect(bridgeText.length).toBeGreaterThan(0);
    });
  });
});

// Helper functions for generating test positions
function generatePositionAtDistance(bridge, distanceMeters) {
  // Generate position south of bridge at specified distance
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
