'use strict';

/**
 * Extreme Values Edge Case Tests
 * Tests the system's behavior with extreme coordinate values, speeds, courses,
 * and invalid numerical inputs to identify potential crashes or unexpected behavior.
 */

const VesselDataService = require('../../lib/services/VesselDataService');
const ProximityService = require('../../lib/services/ProximityService');
const StatusService = require('../../lib/services/StatusService');
const BridgeTextService = require('../../lib/services/BridgeTextService');
const BridgeRegistry = require('../../lib/models/BridgeRegistry');
const { BRIDGES, VALIDATION_CONSTANTS } = require('../../lib/constants');
const { calculateDistance, calculateBearing } = require('../../lib/utils/geometry');

describe('Extreme Values Edge Case Tests', () => {
  let mockLogger;
  let bridgeRegistry;
  let vesselDataService;
  let proximityService;
  let statusService;
  let bridgeTextService;

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    // Initialize services
    bridgeRegistry = new BridgeRegistry(mockLogger);
    vesselDataService = new VesselDataService(mockLogger, bridgeRegistry);
    proximityService = new ProximityService();
    statusService = new StatusService();
    bridgeTextService = new BridgeTextService(bridgeRegistry, mockLogger);
  });

  describe('Extreme Coordinate Values', () => {
    test('should handle North Pole coordinates', () => {
      const extremeVessel = {
        mmsi: '999000001',
        lat: 90.0, // North Pole
        lon: 0.0,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(extremeVessel.mmsi, extremeVessel);
      }).not.toThrow();

      // Check distance calculation doesn't crash
      const distance = calculateDistance(90.0, 0.0, BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon);
      expect(distance).toBeGreaterThan(0);
      expect(Number.isFinite(distance)).toBe(true);
    });

    test('should handle South Pole coordinates', () => {
      const extremeVessel = {
        mmsi: '999000002',
        lat: -90.0, // South Pole
        lon: 0.0,
        sog: 3.0,
        cog: 0,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(extremeVessel.mmsi, extremeVessel);
      }).not.toThrow();

      const distance = calculateDistance(-90.0, 0.0, BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon);
      expect(distance).toBeGreaterThan(0);
      expect(Number.isFinite(distance)).toBe(true);
    });

    test('should handle International Date Line crossing', () => {
      const dateLineVessels = [
        {
          mmsi: '999000003',
          lat: 58.284095, // Near Klaffbron latitude
          lon: 179.999999, // Just before date line
          sog: 10.0,
          cog: 90, // Eastward
          timestamp: Date.now(),
        },
        {
          mmsi: '999000004',
          lat: 58.284095,
          lon: -179.999999, // Just after date line
          sog: 10.0,
          cog: 270, // Westward
          timestamp: Date.now(),
        },
      ];

      dateLineVessels.forEach((vessel) => {
        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });

      // Test distance calculation across date line
      const distance = calculateDistance(
        0, 179.999999,
        0, -179.999999,
      );
      expect(Number.isFinite(distance)).toBe(true);
    });

    test('should handle extreme longitude values', () => {
      const extremeLongitudes = [-180.0, -179.999999, 179.999999, 180.0];

      extremeLongitudes.forEach((lon, index) => {
        const vessel = {
          mmsi: `999000010${index}`,
          lat: 58.284095,
          lon,
          sog: 5.0,
          cog: 180,
          timestamp: Date.now(),
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });
    });

    test('should handle coordinates very close to bridges', () => {
      // Vessel exactly at bridge coordinates
      const exactBridgeVessel = {
        mmsi: '999000020',
        lat: BRIDGES.klaffbron.lat,
        lon: BRIDGES.klaffbron.lon,
        sog: 0.0,
        cog: 0,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(exactBridgeVessel.mmsi, exactBridgeVessel);
      }).not.toThrow();

      const distance = calculateDistance(
        exactBridgeVessel.lat, exactBridgeVessel.lon,
        BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon,
      );
      expect(distance).toBeLessThan(1); // Should be very close to 0
    });
  });

  describe('Extreme Speed Values', () => {
    test('should handle zero speed', () => {
      const stationaryVessel = {
        mmsi: '999000100',
        lat: 58.284095,
        lon: 12.283929,
        sog: 0.0,
        cog: 0,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(stationaryVessel.mmsi, stationaryVessel);
      }).not.toThrow();

      // Stationary vessels should be handled properly
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '999000100');
      expect(vessel).toBeDefined();
    });

    test('should handle extremely high speeds', () => {
      const fastVessel = {
        mmsi: '999000101',
        lat: 58.284095,
        lon: 12.283929,
        sog: 150.0, // Unrealistically fast
        cog: 180,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(fastVessel.mmsi, fastVessel);
      }).not.toThrow();

      // System should accept but handle extreme speeds
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '999000101');
      if (vessel) {
        expect(vessel.sog).toBe(150.0);
      }
    });

    test('should handle negative speeds', () => {
      const negativeSpeedVessel = {
        mmsi: '999000102',
        lat: 58.284095,
        lon: 12.283929,
        sog: -5.0, // Invalid negative speed
        cog: 180,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(negativeSpeedVessel.mmsi, negativeSpeedVessel);
      }).not.toThrow();

      // System should handle negative speeds gracefully
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '999000102');
      // May or may not be stored depending on validation
    });

    test('should handle fractional speeds', () => {
      const fractionalSpeeds = [0.001, 0.1, 0.999, 99.999];

      fractionalSpeeds.forEach((speed, index) => {
        const vessel = {
          mmsi: `999000110${index}`,
          lat: 58.284095,
          lon: 12.283929,
          sog: speed,
          cog: 180,
          timestamp: Date.now(),
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });
    });
  });

  describe('Extreme Course Over Ground (COG) Values', () => {
    test('should handle edge COG values', () => {
      const extremeCOGs = [0.0, 0.1, 359.9, 360.0, 361.0, -1.0];

      extremeCOGs.forEach((cog, index) => {
        const vessel = {
          mmsi: `999000200${index}`,
          lat: 58.284095,
          lon: 12.283929,
          sog: 5.0,
          cog,
          timestamp: Date.now(),
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });
    });

    test('should handle extremely large COG values', () => {
      const vessel = {
        mmsi: '999000210',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 720.0, // Two full rotations
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }).not.toThrow();
    });

    test('should handle fractional COG values', () => {
      const fractionalCOGs = [0.0001, 179.9999, 180.0001, 359.9999];

      fractionalCOGs.forEach((cog, index) => {
        const vessel = {
          mmsi: `999000220${index}`,
          lat: 58.284095,
          lon: 12.283929,
          sog: 5.0,
          cog,
          timestamp: Date.now(),
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });
    });
  });

  describe('Invalid Numerical Values', () => {
    test('should handle NaN values gracefully', () => {
      const nanVessel = {
        mmsi: '999000300',
        lat: NaN,
        lon: NaN,
        sog: NaN,
        cog: NaN,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(nanVessel.mmsi, nanVessel);
      }).not.toThrow();

      // Should handle invalid vessel (may store but mark as invalid)
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '999000300');
      if (vessel) {
        // NaN values should be converted to null for safety
        expect(vessel.lat).toBe(null);
        expect(vessel.lon).toBe(null);
      }
    });

    test('should handle Infinity values', () => {
      const infinityVessel = {
        mmsi: '999000301',
        lat: Infinity,
        lon: -Infinity,
        sog: Infinity,
        cog: -Infinity,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(infinityVessel.mmsi, infinityVessel);
      }).not.toThrow();

      // Should handle infinite values (may store but mark as invalid)
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '999000301');
      if (vessel) {
        // Infinity values should be converted to null for safety
        expect(vessel.lat).toBe(null);
        expect(vessel.lon).toBe(null);
      }
    });

    test('should handle null/undefined values', () => {
      const invalidVessels = [
        {
          mmsi: '999000310',
          lat: null,
          lon: 12.283929,
          sog: 5.0,
          cog: 180,
          timestamp: Date.now(),
        },
        {
          mmsi: '999000311',
          lat: 58.284095,
          lon: undefined,
          sog: 5.0,
          cog: 180,
          timestamp: Date.now(),
        },
        {
          mmsi: '999000312',
          lat: 58.284095,
          lon: 12.283929,
          sog: null,
          cog: 180,
          timestamp: Date.now(),
        },
      ];

      invalidVessels.forEach((vessel) => {
        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();

        // Should handle null/undefined critical values (may store but preserve null values)
        const vessels = vesselDataService.getAllVessels();
        const storedVessel = vessels.find((v) => v.mmsi === vessel.mmsi);
        if (storedVessel) {
          // If stored, null values should be preserved or handled gracefully
          expect(storedVessel.mmsi).toBe(vessel.mmsi);
        }
      });
    });

    test('should handle very large MMSI values', () => {
      const largeMMSI = '999999999999'; // Beyond typical MMSI range
      const vessel = {
        mmsi: largeMMSI,
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }).not.toThrow();

      // Should handle large MMSI values
      const vessels = vesselDataService.getAllVessels();
      const storedVessel = vessels.find((v) => v.mmsi === largeMMSI);
      expect(storedVessel).toBeDefined();
    });
  });

  describe('Extreme ETA Values', () => {
    beforeEach(() => {
      // Add a vessel near a bridge for ETA testing
      const vessel = {
        mmsi: '999000400',
        lat: 58.282095, // South of Klaffbron
        lon: 12.283929,
        sog: 5.0,
        cog: 0, // Northward
        targetBridge: 'Klaffbron',
        timestamp: Date.now(),
      };
      vesselDataService.updateVessel(vessel.mmsi, vessel);
    });

    test('should handle extremely large ETA values', () => {
      // Modify vessel to have very slow speed for large ETA
      const vessel = {
        mmsi: '999000400',
        lat: 58.200000, // Very far south
        lon: 12.283929,
        sog: 0.001, // Extremely slow
        cog: 0,
        targetBridge: 'Klaffbron',
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(vessel.mmsi, vessel);
        const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
      }).not.toThrow();
    });

    test('should handle zero speed ETA calculations', () => {
      const vessel = {
        mmsi: '999000401',
        lat: 58.282095,
        lon: 12.283929,
        sog: 0.0, // Stopped
        cog: 0,
        targetBridge: 'Klaffbron',
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(vessel.mmsi, vessel);
        const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
      }).not.toThrow();

      // ETA should be handled gracefully for stopped vessels
      const vessels = vesselDataService.getAllVessels();
      const storedVessel = vessels.find((v) => v.mmsi === '999000401');
      expect(storedVessel).toBeDefined();
    });
  });

  describe('Timestamp Edge Cases', () => {
    test('should handle very old timestamps', () => {
      const oldVessel = {
        mmsi: '999000500',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: 0, // Unix epoch
      };

      expect(() => {
        vesselDataService.updateVessel(oldVessel.mmsi, oldVessel);
      }).not.toThrow();
    });

    test('should handle future timestamps', () => {
      const futureVessel = {
        mmsi: '999000501',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now() + (365 * 24 * 60 * 60 * 1000), // One year in future
      };

      expect(() => {
        vesselDataService.updateVessel(futureVessel.mmsi, futureVessel);
      }).not.toThrow();
    });

    test('should handle negative timestamps', () => {
      const negativeTimestampVessel = {
        mmsi: '999000502',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: -1000000, // Before Unix epoch
      };

      expect(() => {
        vesselDataService.updateVessel(negativeTimestampVessel.mmsi, negativeTimestampVessel);
      }).not.toThrow();
    });
  });

  describe('Distance Calculation Edge Cases', () => {
    test('should handle identical coordinates', () => {
      const distance = calculateDistance(
        58.284095, 12.283929,
        58.284095, 12.283929,
      );
      expect(distance).toBe(0);
    });

    test('should handle maximum Earth distance', () => {
      // Antipodal points (maximum distance on Earth)
      const distance = calculateDistance(0, 0, 0, 180);
      expect(distance).toBeGreaterThan(19000); // Approximately half Earth's circumference
      expect(Number.isFinite(distance)).toBe(true);
    });

    test('should handle very small coordinate differences', () => {
      const distance = calculateDistance(
        58.284095000000, 12.283929000000,
        58.284095000001, 12.283929000001,
      );
      expect(distance).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(distance)).toBe(true);
    });
  });

  describe('Memory and Performance Edge Cases', () => {
    test('should handle rapid vessel updates without memory leaks', () => {
      const mmsi = '999000600';

      // Rapid updates with same MMSI
      for (let i = 0; i < 1000; i++) {
        const vessel = {
          mmsi,
          lat: 58.284095 + (Math.random() - 0.5) * 0.01,
          lon: 12.283929 + (Math.random() - 0.5) * 0.01,
          sog: Math.random() * 20,
          cog: Math.random() * 360,
          timestamp: Date.now() + i,
        };

        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      }

      // Should only have one vessel stored
      expect(vesselDataService.getAllVessels().length).toBe(1);
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === mmsi);
      expect(vessel).toBeDefined();
    });

    test('should handle large coordinate precision values', () => {
      const vessel = {
        mmsi: '999000601',
        lat: 58.28409551543077123456789, // Very high precision
        lon: 12.28392952524563612345678,
        sog: 5.123456789012345,
        cog: 180.123456789012345,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(vessel.mmsi, vessel);
      }).not.toThrow();

      const vessels = vesselDataService.getAllVessels();
      const storedVessel = vessels.find((v) => v.mmsi === '999000601');
      expect(storedVessel).toBeDefined();
      if (storedVessel) {
        expect(Number.isFinite(storedVessel.lat)).toBe(true);
        expect(Number.isFinite(storedVessel.lon)).toBe(true);
      }
    });
  });
});
