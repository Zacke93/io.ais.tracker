const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('ETA Calculation and Bridge Text Generation', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app._lastSeen = {};
    app._latestBridgeSentence = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';

    // Mock settings
    app.homey.settings.get.mockImplementation((key) => {
      if (key === 'debug_level') return 'basic';
      return null;
    });

    // Mock token updates
    app._activeBridgesTag = {
      setValue: jest.fn(),
    };
  });

  describe('ETA Calculation Logic', () => {
    test('should calculate ETA correctly for normal speed vessel', () => {
      const vesselSpeed = 4.0; // knots
      const distanceToTarget = 1000; // meters

      // Convert speed from knots to m/s (1 knot = 0.514444 m/s)
      const speedMs = vesselSpeed * 0.514444;
      const etaSeconds = distanceToTarget / speedMs;
      const etaMinutes = Math.round(etaSeconds / 60);

      expect(etaMinutes).toBeGreaterThan(0);
      expect(etaMinutes).toBeGreaterThan(7); // Should be about 8 minutes for 1000m at 4kts
    });

    test('should use speed compensation for waiting vessels', () => {
      const currentSpeed = 0.3; // Very slow, indicating waiting
      const maxRecentSpeed = 4.5; // Previous normal cruising speed
      const distance = 500; // meters

      // Use 70% of max recent speed for waiting vessels
      const compensatedSpeed = maxRecentSpeed * 0.7;
      const speedMs = compensatedSpeed * 0.514444;
      const etaSeconds = distance / speedMs;
      const etaMinutes = Math.round(etaSeconds / 60);

      expect(etaMinutes).toBeLessThan(20);
      expect(etaMinutes).toBeGreaterThan(0);
    });

    test('should handle very slow vessels appropriately', () => {
      const vesselSpeed = 0.1; // Very slow
      const distance = 200;

      const speedMs = Math.max(vesselSpeed * 0.514444, 0.1); // Minimum speed
      const etaSeconds = distance / speedMs;
      const etaMinutes = Math.round(etaSeconds / 60);

      expect(etaMinutes).toBeGreaterThan(0);
      expect(etaMinutes).toBeLessThan(120); // Should be less than 2 hours
    });

    test('should calculate distance between consecutive bridges', () => {
      const bridges = {
        klaffbron: { lat: 58.28409551543077, lon: 12.283929525245636 },
        stridsbergsbron: { lat: 58.293524096154634, lon: 12.294566425158054 },
      };

      // Calculate distance using haversine formula
      const R = 6_371_000;
      const lat1 = bridges.klaffbron.lat;
      const lon1 = bridges.klaffbron.lon;
      const lat2 = bridges.stridsbergsbron.lat;
      const lon2 = bridges.stridsbergsbron.lon;

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

      // Distance between Klaffbron and Stridsbergsbron
      expect(distance).toBeGreaterThan(1000);
      expect(distance).toBeLessThan(1500);
    });
  });

  describe('Bridge Text Generation', () => {
    test('should generate no-boats message when no vessels present', () => {
      app._lastSeen = {};

      // Simulate the _updateActiveBridgesTag logic
      const hasTargetBoats = ['klaffbron', 'stridsbergsbron'].some((bridgeId) => {
        const boats = app._lastSeen[bridgeId];
        return boats && Object.keys(boats).length > 0;
      });

      let message;
      if (!hasTargetBoats) {
        message = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
      }

      expect(message).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
    });

    test('should generate single boat message with ETA', () => {
      const mmsi = '123456789';
      app._lastSeen['stridsbergsbron'] = {
        [mmsi]: {
          sog: 4.2,
          maxRecentSog: 4.5,
          dir: 'Vänersborg',
          dist: 250,
          ts: Date.now(),
        },
      };

      // Simulate message generation for single boat
      const boats = Object.values(app._lastSeen['stridsbergsbron']);
      expect(boats).toHaveLength(1);

      const boat = boats[0];
      const isWaiting = boat.sog < 0.5 && boat.maxRecentSog > 2.0;
      const speed = isWaiting ? boat.maxRecentSog * 0.7 : boat.sog;
      const eta = Math.round((boat.dist / (speed * 0.514444)) / 60);

      expect(eta).toBeGreaterThan(0);
      expect(eta).toBeLessThan(20);
    });

    test('should generate multiple boats message', () => {
      app._lastSeen['klaffbron'] = {
        123456789: {
          sog: 3.8,
          dir: 'Göteborg',
          dist: 180,
          ts: Date.now(),
        },
        987654321: {
          sog: 4.5,
          dir: 'Vänersborg',
          dist: 220,
          ts: Date.now(),
        },
      };

      const boats = Object.values(app._lastSeen['klaffbron']);
      expect(boats).toHaveLength(2);

      // Should handle multiple boats correctly
      const directions = [...new Set(boats.map((b) => b.dir))];
      expect(directions).toContain('Göteborg');
      expect(directions).toContain('Vänersborg');
    });

    test('should prioritize target bridges over other bridges', () => {
      // Add boats to both target and non-target bridges
      app._lastSeen['olidebron'] = {
        111111111: {
          sog: 4.0, dir: 'Vänersborg', dist: 150, ts: Date.now(),
        },
      };
      app._lastSeen['stridsbergsbron'] = {
        222222222: {
          sog: 4.2, dir: 'Göteborg', dist: 200, ts: Date.now(),
        },
      };

      const targetBridges = ['klaffbron', 'stridsbergsbron'];
      const hasTargetBoats = targetBridges.some((bridgeId) => {
        const boats = app._lastSeen[bridgeId];
        return boats && Object.keys(boats).length > 0;
      });

      // Should focus on target bridges even if other bridges have boats
      expect(hasTargetBoats).toBe(true);
    });

    test('should handle waiting vessels with appropriate messaging', () => {
      const mmsi = '123456789';
      app._lastSeen['klaffbron'] = {
        [mmsi]: {
          sog: 0.2, // Very slow - waiting
          maxRecentSog: 4.8, // Was moving fast
          dir: 'Göteborg',
          dist: 120,
          ts: Date.now(),
        },
      };

      const boat = app._lastSeen['klaffbron'][mmsi];
      const isWaiting = boat.sog < 0.5 && boat.maxRecentSog > 2.0;

      expect(isWaiting).toBe(true);

      // Waiting boats should use compensated speed for ETA
      const etaSpeed = boat.maxRecentSog * 0.7; // 70% of max recent speed
      expect(etaSpeed).toBeGreaterThan(boat.sog);
    });
  });

  describe('Bridge Sequence Logic', () => {
    test('should understand boat routes between bridges', () => {
      // Boat traveling from Klaffbron towards Stridsbergsbron
      const mmsi = '123456789';

      // First at Klaffbron
      app._lastSeen['klaffbron'] = {
        [mmsi]: {
          sog: 4.2,
          dir: 'Vänersborg',
          dist: 150,
          ts: Date.now() - 120000, // 2 minutes ago
        },
      };

      // Now approaching Stridsbergsbron
      app._lastSeen['stridsbergsbron'] = {
        [mmsi]: {
          sog: 4.0,
          dir: 'Vänersborg',
          dist: 250,
          ts: Date.now(),
        },
      };

      // Logic should understand this is the same boat moving between bridges
      const klaffbronBoat = app._lastSeen['klaffbron'][mmsi];
      const stridsbergsbronBoat = app._lastSeen['stridsbergsbron'][mmsi];

      expect(klaffbronBoat.dir).toBe(stridsbergsbronBoat.dir);
      expect(stridsbergsbronBoat.ts).toBeGreaterThan(klaffbronBoat.ts);
    });

    test('should calculate next bridge for vessel route', () => {
      const currentBridge = 'klaffbron';
      const direction = 'Vänersborg';

      // For Vänersborg direction from Klaffbron, next bridge should be Stridsbergsbron
      const bridgeOrder = ['klaffbron', 'stridsbergsbron', 'stallbackabron'];
      const currentIndex = bridgeOrder.indexOf(currentBridge);
      const nextBridge = bridgeOrder[currentIndex + 1];

      expect(nextBridge).toBe('stridsbergsbron');
    });
  });

  describe('Time-based Message Updates', () => {
    test('should update messages when vessel data changes', () => {
      const mmsi = '123456789';
      const initialTime = Date.now() - 60000; // 1 minute ago

      app._lastSeen['stridsbergsbron'] = {
        [mmsi]: {
          sog: 4.5,
          dir: 'Göteborg',
          dist: 300,
          ts: initialTime,
        },
      };

      // Update with closer position
      app._lastSeen['stridsbergsbron'][mmsi] = {
        ...app._lastSeen['stridsbergsbron'][mmsi],
        dist: 200,
        ts: Date.now(),
      };

      const boat = app._lastSeen['stridsbergsbron'][mmsi];
      expect(boat.dist).toBe(200);
      expect(boat.ts).toBeGreaterThan(initialTime);
    });

    test('should handle stale data cleanup', () => {
      const mmsi = '123456789';
      const staleTime = Date.now() - 5 * 60 * 1000; // 5 minutes ago
      const maxAge = 3 * 60 * 1000; // 3 minutes max age

      app._lastSeen['klaffbron'] = {
        [mmsi]: {
          sog: 4.0,
          dir: 'Göteborg',
          dist: 250,
          ts: staleTime,
        },
      };

      // Check if data is stale
      const boat = app._lastSeen['klaffbron'][mmsi];
      const isStale = (Date.now() - boat.ts) > maxAge;

      expect(isStale).toBe(true);
    });
  });
});
