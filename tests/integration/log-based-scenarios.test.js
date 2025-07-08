const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('Log-Based Realistic AIS Scenarios', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app._lastSeen = {};
    app._speedHistory = {};

    // Mock settings
    app.homey.settings.get.mockImplementation((key) => {
      if (key === 'debug_level') return 'basic';
      if (key === 'ais_api_key') return '12345678-1234-4123-a123-123456789012';
      return null;
    });

    // Mock methods
    app._updateConnectionStatus = jest.fn();
    app._updateActiveBridgesTag = jest.fn();
    app._activeBridgesTag = {
      setValue: jest.fn().mockResolvedValue(true),
    };
    app._devices = new Map();

    // Mock device for testing
    const mockDevice = {
      setCapabilityValue: jest.fn().mockResolvedValue(true),
      getCapabilityValue: jest.fn().mockReturnValue('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron'),
    };
    app._devices.set('test_device', mockDevice);
  });

  describe('EMMA F Journey Simulation (Based on 2025-07-08 10:08 logs)', () => {
    test('should track EMMA F journey from Olidebron to Klaffbron with proper ETA', async () => {
      const emmaMmsi = '305190000';
      const journeyData = [
        // Initial detection at Olidebron
        { distance: 219, speed: 2.7, timeOffset: 0 },
        // 60 seconds later - closer to Olidebron
        { distance: 137, speed: 2.6, timeOffset: 60000 },
        // Continue approaching Klaffbron
        { distance: 80, speed: 2.5, timeOffset: 120000 },
        // Very close to Olidebron
        { distance: 45, speed: 2.3, timeOffset: 180000 },
        // Past Olidebron, heading to Klaffbron
        { distance: 1400, speed: 2.4, timeOffset: 240000, bridge: 'klaffbron' },
      ];

      let lastEta = null;
      const baseTime = Date.now();

      for (const [index, data] of journeyData.entries()) {
        const currentTime = baseTime + data.timeOffset;
        const bridgeId = data.bridge || 'olidebron';

        // Simulate AIS message processing
        app._lastSeen[bridgeId] = app._lastSeen[bridgeId] || {};
        app._lastSeen[bridgeId][emmaMmsi] = {
          ts: currentTime,
          sog: data.speed,
          dist: data.distance,
          dir: 'Vänersborg',
          vessel_name: 'EMMA F',
          mmsi: emmaMmsi,
          towards: true,
          maxRecentSog: Math.max(data.speed, app._lastSeen[bridgeId][emmaMmsi]?.maxRecentSog || 0),
        };

        // Test relevant boat detection
        const relevantBoats = await app._findRelevantBoats();
        
        if (index < 4) { // Before reaching Klaffbron area
          expect(relevantBoats.length).toBe(1);
          expect(relevantBoats[0].mmsi).toBe(emmaMmsi);
          expect(relevantBoats[0].targetBridge).toBe('Klaffbron');
          
          // ETA should be reasonable (10-20 minutes)
          expect(relevantBoats[0].etaMinutes).toBeGreaterThan(8);
          expect(relevantBoats[0].etaMinutes).toBeLessThan(25);

          // ETA should generally decrease over time
          if (lastEta !== null && index > 1) {
            expect(relevantBoats[0].etaMinutes).toBeLessThanOrEqual(lastEta + 2); // Allow some variation
          }
          lastEta = relevantBoats[0].etaMinutes;
        }
      }

      // Verify speed compensation logic
      const finalBoatData = app._lastSeen.klaffbron ? app._lastSeen.klaffbron[emmaMmsi] : null;
      if (finalBoatData) {
        expect(finalBoatData.maxRecentSog).toBeGreaterThan(2.0); // Should have reasonable max speed
      }
    });

    test('should handle EMMA F signal loss and recovery gracefully', async () => {
      const emmaMmsi = '305190000';
      const baseTime = Date.now();

      // Initial strong signal
      app._lastSeen.olidebron = {};
      app._lastSeen.olidebron[emmaMmsi] = {
        ts: baseTime,
        sog: 2.7,
        dist: 200,
        dir: 'Vänersborg',
        vessel_name: 'EMMA F',
        mmsi: emmaMmsi,
        towards: true,
        maxRecentSog: 2.7,
      };

      // Simulate 8 minutes of signal loss (within new tolerance)
      const signalLossTime = baseTime + (8 * 60 * 1000);
      
      // Check that boat is still considered active during grace period
      const relevantBoatsDuringLoss = await app._findRelevantBoats();
      expect(relevantBoatsDuringLoss.length).toBe(1);

      // Simulate signal recovery after 9 minutes
      const recoveryTime = baseTime + (9 * 60 * 1000);
      app._lastSeen.olidebron[emmaMmsi].ts = recoveryTime;
      app._lastSeen.olidebron[emmaMmsi].dist = 150; // Closer
      app._lastSeen.olidebron[emmaMmsi].sog = 2.5;

      const relevantBoatsAfterRecovery = await app._findRelevantBoats();
      expect(relevantBoatsAfterRecovery.length).toBe(1);
      expect(relevantBoatsAfterRecovery[0].mmsi).toBe(emmaMmsi);
    });
  });

  describe('ENCORE Journey Simulation (Based on 2025-07-08 08:42 logs)', () => {
    test('should track ENCORE fast approach and bridge passage', async () => {
      const encoreMmsi = '265531400';
      const journeyData = [
        // Fast approach to Klaffbron
        { distance: 168, speed: 5.0, timeOffset: 0, towards: true },
        // Very close - about to pass
        { distance: 14, speed: 5.5, timeOffset: 60000, towards: false },
        // Past the bridge, moving away
        { distance: 213, speed: 6.1, timeOffset: 120000, towards: false },
      ];

      const baseTime = Date.now();

      for (const [index, data] of journeyData.entries()) {
        const currentTime = baseTime + data.timeOffset;

        app._lastSeen.klaffbron = app._lastSeen.klaffbron || {};
        app._lastSeen.klaffbron[encoreMmsi] = {
          ts: currentTime,
          sog: data.speed,
          dist: data.distance,
          dir: 'Göteborg',
          vessel_name: 'ENCORE',
          mmsi: encoreMmsi,
          towards: data.towards,
          maxRecentSog: Math.max(data.speed, app._lastSeen.klaffbron[encoreMmsi]?.maxRecentSog || 0),
        };

        const relevantBoats = await app._findRelevantBoats();

        if (index === 0) {
          // Approaching - should be detected
          expect(relevantBoats.length).toBe(1);
          expect(relevantBoats[0].mmsi).toBe(encoreMmsi);
          expect(relevantBoats[0].eta).toBeLessThan(3); // Very close
        } else {
          // Moving away - should not be detected (due to direction and low confidence)
          expect(relevantBoats.length).toBe(0);
        }
      }
    });

    test('should demonstrate immediate bridge passage detection', async () => {
      const encoreMmsi = '265531400';
      const baseTime = Date.now();

      // Boat approaching Klaffbron
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[encoreMmsi] = {
        ts: baseTime,
        sog: speed,
        mmsi: mmsi,
        towards: true,
        dist: 50, // Very close
        dir: 'Göteborg',
        vessel_name: 'ENCORE',
        towards: true,
        maxRecentSog: 5.0,
      };

      // Detect passage (boat moves away)
      app._lastSeen.klaffbron[encoreMmsi].towards = false;
      app._lastSeen.klaffbron[encoreMmsi].dist = 100;
      app._lastSeen.klaffbron[encoreMmsi].ts = baseTime + 30000;

      // Test immediate route prediction logic (should detect Stridsbergsbron as next target)
      const hasNextTarget = await app._addToNextRelevantBridge(encoreMmsi, 'klaffbron', 'Göteborg');
      
      // Should identify Stridsbergsbron as next target for northbound boats
      expect(hasNextTarget).toBe(true);
      
      // Should NOT be in original bridge after passage
      expect(app._lastSeen.klaffbron[encoreMmsi]).toBeUndefined();
    });
  });

  describe('SKAGERN Journey Simulation (Based on 2025-07-07 20:39 logs)', () => {
    test('should track SKAGERN steady cargo journey with consistent speed', async () => {
      const skagernMmsi = '210548000';
      const journeyData = [
        // Initial detection at Olidebron
        { distance: 206, speed: 3.5, timeOffset: 0 },
        // 60 seconds later - progressing steadily
        { distance: 91, speed: 3.8, timeOffset: 60000 },
        // Continue towards Klaffbron
        { distance: 50, speed: 3.6, timeOffset: 120000 },
        // Past Olidebron, targeting Klaffbron
        { distance: 1200, speed: 3.7, timeOffset: 180000, bridge: 'klaffbron' },
      ];

      const baseTime = Date.now();

      for (const [index, data] of journeyData.entries()) {
        const currentTime = baseTime + data.timeOffset;
        const bridgeId = data.bridge || 'olidebron';

        app._lastSeen[bridgeId] = app._lastSeen[bridgeId] || {};
        app._lastSeen[bridgeId][skagernMmsi] = {
          ts: currentTime,
          sog: data.speed,
          dist: data.distance,
          dir: 'Vänersborg',
          vessel_name: 'SKAGERN',
          mmsi: skagernMmsi,
          towards: true,
          maxRecentSog: Math.max(data.speed, app._lastSeen[bridgeId][skagernMmsi]?.maxRecentSog || 0),
        };

        const relevantBoats = await app._findRelevantBoats();
        
        if (relevantBoats.length > 0) {
          const boat = relevantBoats[0];
          expect(boat.mmsi).toBe(skagernMmsi);
          expect(boat.targetBridge).toBe('Klaffbron');
          
          // Speed should be consistent (cargo boat behavior)
          expect(data.speed).toBeGreaterThan(3.0);
          expect(data.speed).toBeLessThan(4.0);
          
          // ETA should be reasonable for cargo boat
          expect(boat.etaMinutes).toBeGreaterThan(5);
          expect(boat.etaMinutes).toBeLessThan(20);
        }
      }
    });
  });

  describe('Speed Compensation and Timeout Logic Tests', () => {
    test('should apply correct speed compensation for slow boats', () => {
      const slowBoatMmsi = '123456789';
      const baseTime = Date.now();

      // Very slow boat (under 0.5 knots - should get maximum bonus)
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[slowBoatMmsi] = {
        ts: baseTime,
        sog: 0.3, // Very slow
        dist: 100,
        dir: 'Vänersborg',
        vessel_name: 'SLOW VESSEL',
        maxRecentSog: 0.3,
      };

      // Test timeout calculation
      const vessel = app._lastSeen.klaffbron[slowBoatMmsi];
      const individualTimeout = app._getSpeedAdjustedTimeout(vessel);
      
      // Should get maximum bonus: 10min base + 10min very slow bonus = 20min
      expect(individualTimeout).toBe(20 * 60 * 1000);
    });

    test('should apply medium speed compensation for medium slow boats', () => {
      const mediumSlowMmsi = '123456790';
      const baseTime = Date.now();

      // Medium slow boat (0.5-1.5 knots - should get medium bonus)
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mediumSlowMmsi] = {
        ts: baseTime,
        sog: 1.2, // Medium slow
        dist: 150,
        dir: 'Vänersborg',
        vessel_name: 'MEDIUM VESSEL',
        maxRecentSog: 1.2,
      };

      const vessel = app._lastSeen.klaffbron[mediumSlowMmsi];
      const individualTimeout = app._getSpeedAdjustedTimeout(vessel);
      
      // Should get medium bonus: 10min base + 5min slow bonus = 15min
      expect(individualTimeout).toBe(15 * 60 * 1000);
    });

    test('should use minimum timeout for fast boats', () => {
      const fastBoatMmsi = '123456791';
      const baseTime = Date.now();

      // Fast boat (over 1.5 knots - minimum timeout only)
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[fastBoatMmsi] = {
        ts: baseTime,
        sog: 5.0, // Fast
        dist: 200,
        dir: 'Vänersborg',
        vessel_name: 'FAST VESSEL',
        maxRecentSog: 5.0,
      };

      const vessel = app._lastSeen.klaffbron[fastBoatMmsi];
      const individualTimeout = app._getSpeedAdjustedTimeout(vessel);
      
      // Should get base timeout: 10min base only (MAX_AGE_SEC)
      expect(individualTimeout).toBe(10 * 60 * 1000);
    });
  });

  describe('Complex Multi-Bridge Sequence Tests', () => {
    test('should handle boat sequence through multiple bridges with proper tracking', async () => {
      const complexMmsi = '555666777';
      const baseTime = Date.now();

      // Stage 1: Approaching Olidebron
      app._lastSeen.olidebron = {};
      app._lastSeen.olidebron[complexMmsi] = {
        ts: baseTime,
        sog: speed,
        mmsi: mmsi,
        towards: true,
        dist: 280,
        dir: 'Vänersborg',
        vessel_name: 'COMPLEX ROUTE',
        maxRecentSog: 4.0,
      };

      let relevantBoats = await app._findRelevantBoats();
      expect(relevantBoats.length).toBe(1);
      expect(relevantBoats[0].targetBridge).toBe('Klaffbron');

      // Stage 2: Past Olidebron, added to Klaffbron
      delete app._lastSeen.olidebron[complexMmsi];
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[complexMmsi] = {
        ts: baseTime + 300000, // 5 minutes later
        sog: speed,
        mmsi: mmsi,
        towards: true,
        dist: 250,
        dir: 'Vänersborg',
        vessel_name: 'COMPLEX ROUTE',
        maxRecentSog: 4.0,
      };

      relevantBoats = await app._findRelevantBoats();
      expect(relevantBoats.length).toBe(1);
      expect(relevantBoats[0].targetBridge).toBe('Klaffbron');

      // Stage 3: Past Klaffbron, added to Stridsbergsbron
      delete app._lastSeen.klaffbron[complexMmsi];
      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron[complexMmsi] = {
        ts: baseTime + 600000, // 10 minutes later
        sog: speed,
        mmsi: mmsi,
        towards: true,
        dist: 200,
        dir: 'Vänersborg',
        vessel_name: 'COMPLEX ROUTE',
        maxRecentSog: 4.0,
      };

      relevantBoats = await app._findRelevantBoats();
      expect(relevantBoats.length).toBe(1);
      expect(relevantBoats[0].targetBridge).toBe('Stridsbergsbron');
    });

    test('should handle dual-bridge triggering prevention', async () => {
      const sameMmsi = '888999000';
      const baseTime = Date.now();

      // Simulate same boat appearing at both target bridges (system bug scenario)
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[sameMmsi] = {
        ts: baseTime,
        sog: speed,
        mmsi: mmsi,
        towards: true,
        dist: 200,
        dir: 'Vänersborg',
        vessel_name: 'DUAL TRIGGER',
        maxRecentSog: 3.0,
      };

      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron[sameMmsi] = {
        ts: baseTime + 1000, // 1 second later
        sog: speed,
        mmsi: mmsi,
        towards: true,
        dist: 180,
        dir: 'Vänersborg',
        vessel_name: 'DUAL TRIGGER',
        maxRecentSog: 3.0,
      };

      const relevantBoats = await app._findRelevantBoats();
      
      // Should detect both but message generation should prioritize
      expect(relevantBoats.length).toBe(2);
      
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      
      // Should NOT contain combined message for same vessel
      expect(bridgeText).not.toContain(';');
      expect(bridgeText).toContain('Stridsbergsbron'); // Should prioritize Stridsbergsbron
    });
  });

  describe('Realistic ETA Calculation Tests', () => {
    test('should return waiting status for very close slow boats', () => {
      const waitingMmsi = '777888999';
      
      // Boat very close with very slow speed
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[waitingMmsi] = {
        ts: Date.now(),
        sog: 0.2, // Very slow
        dist: 30, // Very close
        dir: 'Vänersborg',
        vessel_name: 'WAITING BOAT',
        maxRecentSog: 4.5, // Had higher speed before
      };

      const vessel = { sog: 0.2, maxRecentSog: 4.5 };
      const eta = app._calculateETA(vessel, 30, 'klaffbron');
      expect(eta).toBe('waiting');
    });

    test('should use speed compensation for realistic ETAs', () => {
      const compensatedMmsi = '111222333';
      
      // Boat close with low current speed but high recent speed
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[compensatedMmsi] = {
        ts: Date.now(),
        sog: 1.0, // Current slow speed
        dist: 800, // 800m away
        dir: 'Vänersborg',
        vessel_name: 'SPEED COMPENSATED',
        maxRecentSog: 8.0, // Had much higher speed
      };

      const vessel = { sog: 1.0, maxRecentSog: 8.0 };
      const eta = app._calculateETA(vessel, 800, 'klaffbron');
      
      // Should use compensated speed (70% of 8.0 = 5.6 knots)
      // 800m at 5.6 knots ≈ 4.6 minutes
      expect(typeof eta === 'number').toBe(true);
      expect(eta).toBeGreaterThan(3);
      expect(eta).toBeLessThan(7);
    });

    test('should handle edge cases in ETA calculation', () => {
      // Zero distance
      expect(app._calculateETA({ sog: 5.0, maxRecentSog: 5.0 }, 0, 'klaffbron')).toBe('waiting');
      
      // Zero speed and zero max speed
      expect(app._calculateETA({ sog: 0, maxRecentSog: 0 }, 100, 'klaffbron')).toBe('waiting');
      
      // Negative distance (should not happen but handle gracefully) - should return Infinity for invalid input
      expect(app._calculateETA({ sog: 3.0, maxRecentSog: 3.0 }, -50, 'klaffbron')).toBe(Infinity);
      
      // Very high speed (unrealistic)
      const highSpeedEta = app._calculateETA({ sog: 50.0, maxRecentSog: 50.0 }, 1000, 'klaffbron');
      expect(typeof highSpeedEta === 'number').toBe(true);
      expect(highSpeedEta).toBeLessThan(3);
    });
  });

  describe('Stress Test - Multiple Boats Simultaneously', () => {
    test('should handle 7+ boats simultaneously without performance issues', async () => {
      const boatCount = 8;
      const baseTime = Date.now();
      const boats = [];

      // Create multiple boats at different bridges
      for (let i = 0; i < boatCount; i++) {
        const mmsi = `99900${i.toString().padStart(4, '0')}`;
        const bridges = ['olidebron', 'klaffbron', 'stridsbergsbron'];
        const bridgeId = bridges[i % bridges.length];
        const speed = 1.5 + (i * 0.5); // Varying speeds
        const distance = 100 + (i * 50); // Varying distances

        boats.push({ mmsi, bridgeId, speed, distance });

        app._lastSeen[bridgeId] = app._lastSeen[bridgeId] || {};
        app._lastSeen[bridgeId][mmsi] = {
          ts: baseTime + (i * 1000), // Slight time offsets
          sog: speed,
          dist: distance,
          dir: i % 2 === 0 ? 'Vänersborg' : 'Göteborg',
          vessel_name: `STRESS_BOAT_${i}`,
          maxRecentSog: speed + 1.0,
        };
      }

      // Measure performance
      const startTime = Date.now();
      const relevantBoats = await app._findRelevantBoats();
      const endTime = Date.now();

      // Should complete within reasonable time
      expect(endTime - startTime).toBeLessThan(100); // 100ms max

      // Should detect multiple boats
      expect(relevantBoats.length).toBeGreaterThan(0);
      expect(relevantBoats.length).toBeLessThanOrEqual(boatCount);

      // All detected boats should have valid data
      relevantBoats.forEach((boat) => {
        expect(boat.mmsi).toBeDefined();
        expect(boat.targetBridge).toBeDefined();
        expect(boat.eta).toBeDefined();
        expect(['Klaffbron', 'Stridsbergsbron']).toContain(boat.targetBridge);
      });
    });
  });

  describe('Message Generation Under Complex Scenarios', () => {
    test('should generate appropriate messages for different boat combinations', async () => {
      const baseTime = Date.now();

      // Scenario 1: Single boat at Klaffbron
      app._lastSeen.klaffbron = {
        '111000111': {
          ts: baseTime,
          sog: speed,
        mmsi: mmsi,
        towards: true,
          dist: 200,
          dir: 'Vänersborg',
          vessel_name: 'SINGLE BOAT',
          maxRecentSog: 3.0,
        },
      };

      let relevantBoats = await app._findRelevantBoats();
      let message = app._generateBridgeTextFromBoats(relevantBoats);
      expect(message).toContain('Klaffbron');
      expect(message).toContain('minuter');

      // Scenario 2: Different boats at both target bridges
      app._lastSeen.stridsbergsbron = {
        '222000222': {
          ts: baseTime,
          sog: speed,
        mmsi: mmsi,
        towards: true,
          dist: 150,
          dir: 'Vänersborg',
          vessel_name: 'SECOND BOAT',
          maxRecentSog: 2.5,
        },
      };

      relevantBoats = await app._findRelevantBoats();
      message = app._generateBridgeTextFromBoats(relevantBoats);
      
      // Should generate combined message for different boats
      expect(message).toContain(';');
      expect(message).toContain('Klaffbron');
      expect(message).toContain('Stridsbergsbron');

      // Scenario 3: Waiting boat (should show waiting status)
      app._lastSeen.klaffbron['111000111'].sog = 0.1;
      app._lastSeen.klaffbron['111000111'].dist = 25;

      relevantBoats = await app._findRelevantBoats();
      message = app._generateBridgeTextFromBoats(relevantBoats);
      expect(message).toContain('väntar');
    });
  });
});