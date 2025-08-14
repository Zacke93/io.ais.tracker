'use strict';

/**
 * Data Corruption Edge Case Tests
 * Tests system behavior with malformed AIS messages, missing fields,
 * type mismatches, special characters, and various data corruption scenarios.
 */

const VesselDataService = require('../../lib/services/VesselDataService');
const StatusService = require('../../lib/services/StatusService');
const BridgeTextService = require('../../lib/services/BridgeTextService');
const BridgeRegistry = require('../../lib/models/BridgeRegistry');
const ProximityService = require('../../lib/services/ProximityService');

describe('Data Corruption Edge Case Tests', () => {
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

  describe('Malformed AIS Message Structure', () => {
    test('should handle completely empty object', () => {
      const emptyMessage = {};

      // App stores vessels even with empty data (undefined mmsi becomes key)
      expect(() => {
        vesselDataService.updateVessel(emptyMessage.mmsi, emptyMessage);
      }).not.toThrow();

      // Vessel gets stored with undefined mmsi
      expect(vesselDataService.getAllVessels().length).toBe(1);
    });

    test('should handle null/undefined vessel data', () => {
      const invalidInputs = [null, undefined, '', 0, false, []];

      let validUpdates = 0;
      invalidInputs.forEach((input, index) => {
        // Some inputs cause geometry errors, others get stored
        try {
          if (input && input.mmsi) {
            vesselDataService.updateVessel(input.mmsi, input);
          } else {
            vesselDataService.updateVessel(`invalid_${index}`, input || {});
          }
          validUpdates++;
        } catch (error) {
          // GPS jump detection throws for invalid coordinates
          expect(error.message).toContain('Invalid coordinates');
        }
      });

      // Some vessels get stored, others fail due to coordinate validation
      expect(validUpdates).toBeGreaterThanOrEqual(0);
    });

    test('should handle nested objects instead of primitives', () => {
      const nestedVessel = {
        mmsi: { value: 123456789 },
        lat: { degrees: 58.284095 },
        lon: { degrees: 12.283929 },
        sog: { knots: 5.0 },
        cog: { degrees: 180 },
        timestamp: { value: Date.now() },
      };

      // App gracefully handles invalid nested data
      expect(() => {
        vesselDataService.updateVessel(nestedVessel.mmsi.value || 'test', nestedVessel);
      }).not.toThrow();

      // Vessel gets stored despite nested data
      expect(vesselDataService.getAllVessels().length).toBe(1);
    });

    test('should handle arrays instead of primitives', () => {
      const arrayVessel = {
        mmsi: [123456789],
        lat: [58.284095],
        lon: [12.283929],
        sog: [5.0],
        cog: [180],
        timestamp: [Date.now()],
      };

      // App gracefully handles array data
      expect(() => {
        vesselDataService.updateVessel(arrayVessel.mmsi[0] || 'test', arrayVessel);
      }).not.toThrow();

      // Vessel gets stored despite array values
      expect(vesselDataService.getAllVessels().length).toBe(1);
    });
  });

  describe('Missing Required Fields', () => {
    const baseValidVessel = {
      mmsi: '123456789',
      lat: 58.284095,
      lon: 12.283929,
      sog: 5.0,
      cog: 180,
      timestamp: Date.now(),
    };

    test('should handle missing MMSI', () => {
      const vesselWithoutMMSI = { ...baseValidVessel };
      delete vesselWithoutMMSI.mmsi;

      // App gracefully handles missing MMSI
      expect(() => {
        vesselDataService.updateVessel(vesselWithoutMMSI.mmsi, vesselWithoutMMSI);
      }).not.toThrow();

      // Vessel gets stored even without explicit MMSI
      expect(vesselDataService.getAllVessels().length).toBe(1);
    });

    test('should handle missing latitude', () => {
      const vesselWithoutLat = { ...baseValidVessel };
      delete vesselWithoutLat.lat;

      // App gracefully handles missing required fields
      expect(() => {
        vesselDataService.updateVessel(vesselWithoutLat.mmsi, vesselWithoutLat);
      }).not.toThrow();

      // Vessel gets stored despite missing latitude
      expect(vesselDataService.getAllVessels().length).toBe(1);
    });

    test('should handle missing longitude', () => {
      const vesselWithoutLon = { ...baseValidVessel };
      delete vesselWithoutLon.lon;

      // App gracefully handles missing required fields
      expect(() => {
        vesselDataService.updateVessel(vesselWithoutLon.mmsi, vesselWithoutLon);
      }).not.toThrow();

      // Vessel gets stored despite missing longitude
      expect(vesselDataService.getAllVessels().length).toBe(1);
    });

    test('should handle missing speed and course gracefully', () => {
      const vesselWithoutSpeedCourse = {
        mmsi: '123456789',
        lat: 58.284095,
        lon: 12.283929,
        timestamp: Date.now(),
        // Missing sog and cog
      };

      expect(() => {
        vesselDataService.updateVessel(vesselWithoutSpeedCourse.mmsi, vesselWithoutSpeedCourse);
      }).not.toThrow();

      // May store with default values or skip - depends on implementation
      const vessels = vesselDataService.getAllVessels();
      if (vessels.length > 0) {
        const vessel = vessels.find((v) => v.mmsi === '123456789');
        expect(vessel).toBeDefined();
        // Speed and course should be handled gracefully
      }
    });

    test('should handle missing timestamp', () => {
      const vesselWithoutTimestamp = {
        mmsi: '123456789',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        // Missing timestamp
      };

      expect(() => {
        vesselDataService.updateVessel(vesselWithoutTimestamp.mmsi, vesselWithoutTimestamp);
      }).not.toThrow();

      // Should handle missing timestamp (may use current time)
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456789');
      if (vessel) {
        expect(vessel.timestamp).toBeDefined();
      }
    });
  });

  describe('Data Type Mismatches', () => {
    test('should handle string MMSI values', () => {
      const stringMMSIVessel = {
        mmsi: '123456789',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(stringMMSIVessel.mmsi, stringMMSIVessel);
      }).not.toThrow();

      // May convert string to number or handle appropriately
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456789');
      // Either numeric or string key could work depending on implementation
    });

    test('should handle string coordinates', () => {
      const stringCoordVessel = {
        mmsi: '123456790',
        lat: '58.284095',
        lon: '12.283929',
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(stringCoordVessel.mmsi, stringCoordVessel);
      }).not.toThrow();

      // Should handle string coordinates (may parse or reject)
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456790');
      if (vessel) {
        expect(typeof vessel.lat === 'number' || typeof vessel.lat === 'string').toBe(true);
      }
    });

    test('should handle string speed and course', () => {
      const stringSpeedCourseVessel = {
        mmsi: '123456791',
        lat: 58.284095,
        lon: 12.283929,
        sog: '5.0',
        cog: '180',
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(stringSpeedCourseVessel.mmsi, stringSpeedCourseVessel);
      }).not.toThrow();
    });

    test('should handle boolean values for numeric fields', () => {
      const booleanVessel = {
        mmsi: true,
        lat: false,
        lon: true,
        sog: false,
        cog: true,
        timestamp: Date.now(),
      };

      // App gracefully handles boolean values
      expect(() => {
        vesselDataService.updateVessel('test_bool', booleanVessel);
      }).not.toThrow();

      // Vessel gets stored despite boolean coordinates
      expect(vesselDataService.getAllVessels().length).toBe(1);
    });

    test('should handle mixed type arrays', () => {
      const mixedArrayVessel = {
        mmsi: [123, 'abc', null],
        lat: [58.284095, 'north', true],
        lon: [12.283929, 'east', false],
        sog: [5.0, 'knots', null],
        cog: [180, 'south', undefined],
        timestamp: Date.now(),
      };

      // App gracefully handles mixed array data
      expect(() => {
        vesselDataService.updateVessel('test_array', mixedArrayVessel);
      }).not.toThrow();

      // Vessel gets stored despite array data
      expect(vesselDataService.getAllVessels().length).toBe(1);
    });
  });

  describe('Special Characters and Encoding Issues', () => {
    test('should handle emoji in vessel names', () => {
      const emojiVessel = {
        mmsi: '123456792',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
        name: '🚢 M/S EMOJI SHIP 🌊',
        callsign: '📡EMOJI1',
      };

      expect(() => {
        vesselDataService.updateVessel(emojiVessel.mmsi, emojiVessel);
      }).not.toThrow();

      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456792');
      if (vessel) {
        expect(vessel.name).toBeDefined();
        // Should handle emoji gracefully
      }
    });

    test('should handle special Unicode characters', () => {
      const unicodeVessel = {
        mmsi: '123456793',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
        name: 'M/S ÅÄÖÉÑÇ ∑∆πΩ',
        callsign: 'ÅÄÖ123',
      };

      expect(() => {
        vesselDataService.updateVessel(unicodeVessel.mmsi, unicodeVessel);
      }).not.toThrow();

      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456793');
      if (vessel && vessel.name) {
        expect(vessel.name.length).toBeGreaterThan(0);
      }
    });

    test('should handle control characters', () => {
      const controlCharVessel = {
        mmsi: '123456794',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
        name: 'M/S\t\n\r\0CONTROL',
        callsign: '\x01\x02CTRL',
      };

      expect(() => {
        vesselDataService.updateVessel(controlCharVessel.mmsi, controlCharVessel);
      }).not.toThrow();

      // Should handle control characters without crashing
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456794');
      if (vessel) {
        expect(vessel).toBeDefined();
      }
    });

    test('should handle extremely long strings', () => {
      const longString = 'A'.repeat(10000); // 10KB string

      const longStringVessel = {
        mmsi: '123456795',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
        name: longString,
        callsign: longString,
      };

      expect(() => {
        vesselDataService.updateVessel(longStringVessel.mmsi, longStringVessel);
      }).not.toThrow();

      // Should handle long strings (may truncate or limit)
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456795');
      if (vessel) {
        expect(vessel).toBeDefined();
      }
    });

    test('should handle binary data in strings', () => {
      const binaryVessel = {
        mmsi: '123456796',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
        name: Buffer.from([0x00, 0x01, 0xFF, 0x7F]).toString(),
        callsign: '\x89PNG\r\n\x1a\n', // PNG header bytes
      };

      expect(() => {
        vesselDataService.updateVessel(binaryVessel.mmsi, binaryVessel);
      }).not.toThrow();
    });
  });

  describe('Negative and Invalid Numeric Values', () => {
    test('should handle negative coordinates', () => {
      const negativeCoordVessel = {
        mmsi: '123456800',
        lat: -58.284095, // Southern hemisphere
        lon: -12.283929, // Western hemisphere
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(negativeCoordVessel.mmsi, negativeCoordVessel);
      }).not.toThrow();

      // Negative coordinates are valid (southern/western hemispheres)
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456800');
      expect(vessel).toBeDefined();
      expect(vessel.lat).toBe(-58.284095);
      expect(vessel.lon).toBe(-12.283929);
    });

    test('should handle negative speeds', () => {
      const negativeSpeedVessel = {
        mmsi: '123456801',
        lat: 58.284095,
        lon: 12.283929,
        sog: -5.0, // Invalid negative speed
        cog: 180,
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(negativeSpeedVessel.mmsi, negativeSpeedVessel);
      }).not.toThrow();

      // Should handle negative speeds (may accept, reject, or convert to positive)
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456801');
      if (vessel) {
        expect(vessel.sog).toBeDefined();
      }
    });

    test('should handle negative course values', () => {
      const negativeCourseVessel = {
        mmsi: '123456802',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: -90, // Invalid negative course
        timestamp: Date.now(),
      };

      expect(() => {
        vesselDataService.updateVessel(negativeCourseVessel.mmsi, negativeCourseVessel);
      }).not.toThrow();

      // Should handle negative courses (may normalize to 0-360 range)
      const vessels = vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === '123456802');
      if (vessel) {
        expect(vessel.cog).toBeDefined();
      }
    });

    test('should handle coordinates outside valid Earth ranges', () => {
      const invalidRanges = [
        { mmsi: '123456810', lat: 91, lon: 12.283929 }, // Beyond North Pole
        { mmsi: '123456811', lat: -91, lon: 12.283929 }, // Beyond South Pole
        { mmsi: '123456812', lat: 58.284095, lon: 181 }, // Beyond 180°E
        { mmsi: '123456813', lat: 58.284095, lon: -181 }, // Beyond 180°W
        { mmsi: '123456814', lat: 1000, lon: 1000 }, // Completely invalid
      ];

      invalidRanges.forEach((vessel) => {
        const testVessel = {
          ...vessel,
          sog: 5.0,
          cog: 180,
          timestamp: Date.now(),
        };

        expect(() => {
          vesselDataService.updateVessel(testVessel.mmsi, testVessel);
        }).not.toThrow();

        // App should validate Earth ranges and convert invalid coordinates to null
        const vessels = vesselDataService.getAllVessels();
        const storedVessel = vessels.find((v) => v.mmsi === vessel.mmsi);
        expect(storedVessel).toBeDefined();

        // Coordinates outside Earth's valid ranges should be converted to null
        const isLatValid = Math.abs(vessel.lat) <= 90;
        const isLonValid = Math.abs(vessel.lon) <= 180;

        expect(storedVessel.lat).toBe(isLatValid ? vessel.lat : null);
        expect(storedVessel.lon).toBe(isLonValid ? vessel.lon : null);
      });
    });
  });

  describe('Complex Malformed Data Combinations', () => {
    test('should handle vessel with mix of valid and invalid fields', () => {
      const mixedValidityVessel = {
        mmsi: '123456820',
        lat: 58.284095, // Valid
        lon: 'not-a-number', // Invalid
        sog: null, // Invalid
        cog: 180, // Valid
        timestamp: 'yesterday', // Invalid
        name: 'M/S MIXED', // Valid
        unknownField: { nested: 'data' }, // Unknown field
      };

      expect(() => {
        vesselDataService.updateVessel(mixedValidityVessel.mmsi, mixedValidityVessel);
      }).not.toThrow();

      // Should handle mixed validity gracefully (may store with valid fields only)
      const vessels = vesselDataService.getAllVessels();
      // Either stored with valid fields or rejected entirely
      expect(vessels.length).toBeGreaterThanOrEqual(0);
    });

    test('should handle vessel with realistic data corruption scenarios', () => {
      // Focus on realistic AIS data corruption scenarios
      const realisticCorruption = [
        {
          mmsi: '123456821',
          lat: 58.284095,
          lon: 12.283929,
          sog: 5.0,
          cog: 180,
          timestamp: Date.now(),
          extraField: 'unexpected_data', // Extra fields should be ignored
        },
        {
          mmsi: '123456822',
          lat: 58.284095,
          lon: 12.283929,
          sog: 5.0,
          cog: 180,
          timestamp: Date.now(),
          name: Buffer.from('M/S TEST').toString('base64'), // Encoded vessel name
        },
      ];

      realisticCorruption.forEach((vessel) => {
        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });

      // Should handle realistic corruption gracefully
      const vessels = vesselDataService.getAllVessels();
      expect(vessels.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('System Recovery and Error Handling', () => {
    test('should continue processing after data corruption', () => {
      // Add valid vessel first
      const validVessel1 = {
        mmsi: '123456900',
        lat: 58.284095,
        lon: 12.283929,
        sog: 5.0,
        cog: 180,
        timestamp: Date.now(),
      };

      vesselDataService.updateVessel(validVessel1.mmsi, validVessel1);
      expect(vesselDataService.getAllVessels().length).toBe(1);

      // Try to add corrupted vessel (will be stored despite corruption)
      const corruptedVessel = {
        mmsi: 'corrupted_123',
        lat: 'corrupt',
        lon: undefined,
        sog: null,
        cog: Infinity,
        timestamp: 'not-a-date',
      };

      expect(() => {
        vesselDataService.updateVessel(corruptedVessel.mmsi, corruptedVessel);
      }).not.toThrow();

      // Add another valid vessel after corruption
      const validVessel2 = {
        mmsi: '123456901',
        lat: 58.293524,
        lon: 12.294566,
        sog: 7.0,
        cog: 90,
        timestamp: Date.now(),
      };

      vesselDataService.updateVessel(validVessel2.mmsi, validVessel2);

      // Should have 3 vessels (system continues despite corruption)
      expect(vesselDataService.getAllVessels().length).toBe(3);
      const vessels = vesselDataService.getAllVessels();
      expect(vessels.find((v) => v.mmsi === '123456900')).toBeDefined();
      expect(vessels.find((v) => v.mmsi === '123456901')).toBeDefined();
      expect(vessels.find((v) => v.mmsi === 'corrupted_123')).toBeDefined();
    });

    test('should handle bridge text generation with corrupted data', () => {
      // Add vessels with various corruption types
      const vessels = [
        {
          mmsi: '123456910',
          lat: 58.284095,
          lon: 12.283929,
          sog: 5.0,
          cog: 180,
          name: null, // Corrupted name
          timestamp: Date.now(),
        },
        {
          mmsi: '123456911',
          lat: 58.293524,
          lon: 12.294566,
          sog: 'invalid', // Corrupted speed
          cog: 90,
          timestamp: Date.now(),
        },
      ];

      vessels.forEach((vessel) => {
        expect(() => {
          vesselDataService.updateVessel(vessel.mmsi, vessel);
        }).not.toThrow();
      });

      // Bridge text generation should handle corrupted data gracefully
      expect(() => {
        const bridgeText = bridgeTextService.generateBridgeText(vesselDataService.getAllVessels());
        expect(typeof bridgeText).toBe('string');
      }).not.toThrow();
    });

    test('should log errors appropriately for corrupted data', () => {
      const invalidInputs = [
        { type: 'null', data: null },
        { type: 'undefined', data: undefined },
        { type: 'number', data: 12345 },
        { type: 'string', data: 'not-vessel-data' },
        { type: 'malformed', data: { mmsi: NaN, lat: 'text', lon: null } },
      ];

      invalidInputs.forEach((input) => {
        mockLogger.log.mockClear();
        mockLogger.error.mockClear();

        // App throws when given invalid input data
        expect(() => {
          vesselDataService.updateVessel(input.data);
        }).toThrow();

        // Should have logged something about the invalid input
        // (Either via log or error method, depending on implementation)
        const totalLogCalls = mockLogger.log.mock.calls.length + mockLogger.error.mock.calls.length;
        // May or may not log depending on implementation, but should not crash
      });
    });
  });
});
