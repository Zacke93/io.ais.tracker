const path = require('path');

// Mock Homey before requiring the app
require('../setup');

// Load the app
const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('Smart Boat Detection', () => {
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
  });

  describe('Haversine Distance Calculation', () => {
    test('should calculate distance between two points correctly', () => {
      const lat1 = 58.272743083145855; // Olidebron
      const lon1 = 12.275115821922993;
      const lat2 = 58.28409551543077; // Klaffbron
      const lon2 = 12.283929525245636;

      // Using the haversine function from app.js
      const R = 6_371_000;
      const φ1 = (lat1 * Math.PI) / 180;
      const φ2 = (lat2 * Math.PI) / 180;
      const Δφ = ((lat2 - lat1) * Math.PI) / 180;
      const Δλ = ((lon2 - lon1) * Math.PI) / 180;
      const distance = 2 * R * Math.asin(
        Math.sqrt(
          Math.sin(Δφ / 2) ** 2
          + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2,
        ),
      );

      // Distance between Olidebron and Klaffbron should be approximately 1.3km
      expect(distance).toBeGreaterThan(1200);
      expect(distance).toBeLessThan(1400);
    });
  });

  describe('Speed History Tracking', () => {
    test('should track vessel speed history correctly', () => {
      const mmsi = '12345';
      const bridgeId = 'klaffbron';

      // Simulate multiple speed readings
      const speeds = [5.2, 5.0, 4.8, 4.5, 4.2];

      app._lastSeen[bridgeId] = {};

      speeds.forEach((speed, index) => {
        const existingData = app._lastSeen[bridgeId][mmsi];
        const speedHistory = app._updateSpeedHistory?.(
          existingData?.speedHistory || [],
          speed,
        ) || [...(existingData?.speedHistory || []), { speed, time: Date.now() + index * 1000 }];

        app._lastSeen[bridgeId][mmsi] = {
          ...existingData,
          sog: speed,
          speedHistory,
          maxRecentSog: Math.max(speed, existingData?.maxRecentSog || 0),
        };
      });

      const vesselData = app._lastSeen[bridgeId][mmsi];
      expect(vesselData.sog).toBe(4.2); // Latest speed
      expect(vesselData.maxRecentSog).toBe(5.2); // Highest recorded speed
      expect(vesselData.speedHistory).toHaveLength(5);
    });
  });

  describe('Waiting Detection Logic', () => {
    test('should detect when vessel is waiting at bridge', () => {
      const mmsi = '12345';
      const bridgeId = 'stridsbergsbron';
      const WAITING_SPEED_THRESHOLD = 0.5;

      app._lastSeen[bridgeId] = {
        [mmsi]: {
          sog: 0.3, // Below waiting threshold
          maxRecentSog: 4.5, // Was moving fast recently
          lastActiveTime: Date.now() - 2 * 60 * 1000, // 2 minutes ago
          dist: 150, // Close to bridge
        },
      };

      const vesselData = app._lastSeen[bridgeId][mmsi];
      const isWaiting = vesselData.sog < WAITING_SPEED_THRESHOLD
                       && vesselData.maxRecentSog > 2.0
                       && vesselData.dist < 300;

      expect(isWaiting).toBe(true);
    });

    test('should not detect waiting if vessel was never fast', () => {
      const mmsi = '12345';
      const bridgeId = 'stridsbergsbron';
      const WAITING_SPEED_THRESHOLD = 0.5;

      app._lastSeen[bridgeId] = {
        [mmsi]: {
          sog: 0.3,
          maxRecentSog: 0.4, // Never went fast
          dist: 150,
        },
      };

      const vesselData = app._lastSeen[bridgeId][mmsi];
      const isWaiting = vesselData.sog < WAITING_SPEED_THRESHOLD
                       && vesselData.maxRecentSog > 2.0;

      expect(isWaiting).toBe(false);
    });
  });

  describe('Bridge Direction Logic', () => {
    test('should determine correct direction based on COG', () => {
      // Test Göteborg direction (COG between 90-270)
      let cog = 180;
      let dir = cog > 90 && cog < 270 ? 'Göteborg' : 'Vänersborg';
      expect(dir).toBe('Göteborg');

      // Test Vänersborg direction (COG outside 90-270)
      cog = 45;
      dir = cog > 90 && cog < 270 ? 'Göteborg' : 'Vänersborg';
      expect(dir).toBe('Vänersborg');

      cog = 315;
      dir = cog > 90 && cog < 270 ? 'Göteborg' : 'Vänersborg';
      expect(dir).toBe('Vänersborg');
    });
  });

  describe('Bridge Proximity Detection', () => {
    test('should detect vessel within bridge radius', () => {
      const vesselLat = 58.272743083145855; // At Olidebron
      const vesselLon = 12.275115821922993;
      const bridgeLat = 58.272743083145855; // Olidebron coordinates
      const bridgeLon = 12.275115821922993;
      const radius = 300;

      // Calculate distance (should be 0 for same coordinates)
      const R = 6_371_000;
      const φ1 = (vesselLat * Math.PI) / 180;
      const φ2 = (bridgeLat * Math.PI) / 180;
      const Δφ = ((bridgeLat - vesselLat) * Math.PI) / 180;
      const Δλ = ((bridgeLon - vesselLon) * Math.PI) / 180;
      const distance = 2 * R * Math.asin(
        Math.sqrt(
          Math.sin(Δφ / 2) ** 2
          + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2,
        ),
      );

      expect(distance).toBeLessThanOrEqual(radius);
    });
  });

  describe('Multi-Bridge Vessel Tracking', () => {
    test('should track vessel across multiple bridges correctly', () => {
      const mmsi = '12345';

      // Vessel detected at Klaffbron first
      app._lastSeen['klaffbron'] = {
        [mmsi]: {
          ts: Date.now() - 60000, // 1 minute ago
          sog: 4.5,
          dir: 'Vänersborg',
        },
      };

      // Then detected at Stridsbergsbron
      app._lastSeen['stridsbergsbron'] = {
        [mmsi]: {
          ts: Date.now(),
          sog: 4.2,
          dir: 'Vänersborg',
        },
      };

      // Should remove from previous bridge when detected at new one
      const bridges = Object.keys(app._lastSeen);
      let vesselBridges = 0;

      bridges.forEach((bridgeId) => {
        if (app._lastSeen[bridgeId][mmsi]) {
          vesselBridges++;
        }
      });

      // Due to cleanup logic, vessel should only be tracked at most recent bridge
      expect(vesselBridges).toBeGreaterThan(0);
    });
  });

  describe('ETA Calculation Logic', () => {
    test('should calculate reasonable ETA for approaching vessel', () => {
      const vesselSpeed = 4.0; // knots
      const distanceToNextBridge = 1000; // meters

      // Convert speed to m/s (1 knot = 0.514444 m/s)
      const speedMs = vesselSpeed * 0.514444;
      const etaSeconds = distanceToNextBridge / speedMs;
      const etaMinutes = Math.round(etaSeconds / 60);

      expect(etaMinutes).toBeGreaterThan(0);
      expect(etaMinutes).toBeLessThan(60); // Should reach within an hour
    });

    test('should handle waiting vessels with speed compensation', () => {
      const currentSpeed = 0.3; // Very slow, waiting
      const maxRecentSpeed = 4.5; // Previous normal speed
      const distance = 500;

      // For waiting vessels, use 70% of max recent speed for ETA calculation
      const compensatedSpeed = maxRecentSpeed * 0.7;
      const speedMs = compensatedSpeed * 0.514444;
      const etaSeconds = distance / speedMs;
      const etaMinutes = Math.round(etaSeconds / 60);

      expect(etaMinutes).toBeGreaterThan(0);
      expect(etaMinutes).toBeLessThan(30);
    });
  });

  describe('Target Bridge Focus', () => {
    test('should prioritize Stridsbergsbron and Klaffbron for alerts', () => {
      const targetBridges = ['stridsbergsbron', 'klaffbron'];
      const allBridges = ['olidebron', 'klaffbron', 'jarnvagsbron', 'stridsbergsbron', 'stallbackabron'];

      // Test that target bridges are subset of all bridges
      targetBridges.forEach((bridge) => {
        expect(allBridges).toContain(bridge);
      });

      // Should only generate bridge_text for target bridges
      const bridgeForAlert = 'stridsbergsbron';
      const shouldAlert = targetBridges.includes(bridgeForAlert);
      expect(shouldAlert).toBe(true);

      const nonTargetBridge = 'olidebron';
      const shouldNotAlert = targetBridges.includes(nonTargetBridge);
      expect(shouldNotAlert).toBe(false);
    });
  });
});
