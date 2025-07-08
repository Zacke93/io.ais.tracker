const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('Unpredictable Real-World Boat Behavior Tests', () => {
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

    const mockDevice = {
      setCapabilityValue: jest.fn().mockResolvedValue(true),
      getCapabilityValue: jest.fn().mockReturnValue('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron'),
    };
    app._devices.set('test_device', mockDevice);
  });

  describe('Scenario 1: The Last-Minute Turn Around (HELENA behavior)', () => {
    test('should handle boat approaching then suddenly turning away', async () => {
      const mmsi = 'HELENA_123';
      const baseTime = Date.now();

      console.log('=== HELENA: Last-Minute Turn Around ===');
      console.log('Boat approaches Klaffbron confidently, then suddenly turns around at last second');

      // Stage 1: Confident approach towards Klaffbron
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 4.8,
        dist: 300,
        dir: 'Vänersborg', // Northbound towards bridge
        vessel_name: 'HELENA',
        mmsi,
        towards: true,
        maxRecentSog: 4.8,
      };

      let relevantBoats = await app._findRelevantBoats();
      let bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

      console.log(`Stage 1 - Approaching: ${bridgeText}`);
      expect(relevantBoats.length).toBe(1);
      expect(bridgeText).toContain('Klaffbron');

      // Stage 2: Getting closer, still confident
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime + 60000,
        sog: 4.2,
        dist: 180,
        dir: 'Vänersborg',
        vessel_name: 'HELENA',
        mmsi,
        towards: true,
        maxRecentSog: 4.8,
      };

      relevantBoats = await app._findRelevantBoats();
      bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

      console.log(`Stage 2 - Closer: ${bridgeText}`);
      expect(relevantBoats.length).toBe(1);

      // Stage 3: SUDDEN TURN AROUND - now moving away!
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime + 120000,
        sog: 5.2, // Accelerating away
        dist: 220, // Getting further
        dir: 'Göteborg', // CHANGED DIRECTION!
        vessel_name: 'HELENA',
        mmsi,
        towards: false, // Now moving away
        maxRecentSog: 5.2,
      };

      relevantBoats = await app._findRelevantBoats();
      bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

      console.log(`Stage 3 - TURNED AROUND: Boats detected: ${relevantBoats.length}`);
      console.log(`Bridge text: "${bridgeText}"`);

      // System should stop predicting bridge opening when boat turns away
      expect(relevantBoats.length).toBe(0);

      // Stage 4: Confirming departure
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime + 180000,
        sog: 4.8,
        dist: 350, // Much further away
        dir: 'Göteborg',
        vessel_name: 'HELENA',
        mmsi,
        towards: false,
        maxRecentSog: 5.2,
      };

      relevantBoats = await app._findRelevantBoats();

      console.log(`Stage 4 - Departed: Boats detected: ${relevantBoats.length}`);
      expect(relevantBoats.length).toBe(0);

      console.log('✅ System correctly handled last-minute turn around');
    });
  });

  describe('Scenario 2: The Speed Oscillator (Fishing boat behavior)', () => {
    test('should handle erratic speed changes that confuse ETA calculations', async () => {
      const mmsi = 'OSCILLATOR_456';
      const baseTime = Date.now();

      console.log('\n=== OSCILLATOR: Erratic Speed Changes ===');
      console.log('Boat with wildly changing speeds approaching bridge');

      const speedChanges = [
        {
          time: 0, speed: 6.2, dist: 400, desc: 'Fast approach',
        },
        {
          time: 30000, speed: 1.8, dist: 350, desc: 'Sudden slowdown',
        },
        {
          time: 60000, speed: 8.1, dist: 280, desc: 'Sudden acceleration',
        },
        {
          time: 90000, speed: 0.4, dist: 260, desc: 'Almost stop',
        },
        {
          time: 120000, speed: 5.5, dist: 200, desc: 'Normal speed again',
        },
        {
          time: 150000, speed: 2.2, dist: 150, desc: 'Cautious approach',
        },
      ];

      for (const [index, stage] of speedChanges.entries()) {
        app._lastSeen.stridsbergsbron = app._lastSeen.stridsbergsbron || {};
        app._lastSeen.stridsbergsbron[mmsi] = {
          ts: baseTime + stage.time,
          sog: stage.speed,
          dist: stage.dist,
          dir: 'Göteborg',
          vessel_name: 'OSCILLATOR',
          mmsi,
          towards: stage.speed > 0.5, // Only approaching if moving
          maxRecentSog: Math.max(stage.speed, 8.1), // Remember max speed
        };

        const relevantBoats = await app._findRelevantBoats();
        const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

        console.log(`\nStage ${index + 1} - ${stage.desc}:`);
        console.log(`  Speed: ${stage.speed} knots, Distance: ${stage.dist}m`);
        console.log(`  Detected: ${relevantBoats.length > 0 ? 'YES' : 'NO'}`);

        if (relevantBoats.length > 0) {
          console.log(`  ETA: ${relevantBoats[0].etaMinutes} minutes`);
          console.log(`  Bridge text: "${bridgeText}"`);

          // Verify system maintains reasonable ETAs despite speed chaos
          if (typeof relevantBoats[0].etaMinutes === 'number') {
            expect(relevantBoats[0].etaMinutes).toBeGreaterThan(0);
            expect(relevantBoats[0].etaMinutes).toBeLessThan(30);
          }
        } else {
          console.log('  System ignored due to very low speed');
        }
      }

      console.log('\n✅ System maintained stability despite erratic speed changes');
    });
  });

  describe('Scenario 3: The Ghost Ship (Signal loss and recovery)', () => {
    test('should handle boats that disappear and reappear in unexpected locations', async () => {
      const mmsi = 'GHOST_789';
      const baseTime = Date.now();

      console.log('\n=== GHOST SHIP: Signal Loss and Unexpected Recovery ===');

      // Stage 1: Normal approach to Klaffbron
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 3.8,
        dist: 250,
        dir: 'Vänersborg',
        vessel_name: 'GHOST SHIP',
        mmsi,
        towards: true,
        maxRecentSog: 3.8,
      };

      let relevantBoats = await app._findRelevantBoats();
      let bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

      console.log(`Stage 1 - Normal approach: ${bridgeText}`);
      expect(relevantBoats.length).toBe(1);

      // Stage 2: Signal loss (remove from all bridges)
      delete app._lastSeen.klaffbron[mmsi];

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 2 - Signal lost: Boats detected: ${relevantBoats.length}`);
      expect(relevantBoats.length).toBe(0);

      // Stage 3: Unexpected reappearance at DIFFERENT bridge (Stridsbergsbron)
      // This simulates boat somehow getting past Klaffbron without being detected
      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron[mmsi] = {
        ts: baseTime + 300000, // 5 minutes later
        sog: 4.1,
        dist: 180,
        dir: 'Vänersborg', // Still heading north
        vessel_name: 'GHOST SHIP',
        mmsi,
        towards: true,
        maxRecentSog: 4.1,
      };

      relevantBoats = await app._findRelevantBoats();
      bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

      console.log(`Stage 3 - Unexpected reappearance at Stridsbergsbron: ${bridgeText}`);
      expect(relevantBoats.length).toBe(1);
      expect(relevantBoats[0].targetBridge).toBe('Stridsbergsbron');

      // Stage 4: Another disappearance
      delete app._lastSeen.stridsbergsbron[mmsi];

      // Stage 5: Reappearing back at Klaffbron moving SOUTH (return journey)
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime + 600000, // 10 minutes later
        sog: 3.5,
        dist: 200,
        dir: 'Göteborg', // Now southbound
        vessel_name: 'GHOST SHIP',
        mmsi,
        towards: true,
        maxRecentSog: 4.1,
      };

      relevantBoats = await app._findRelevantBoats();
      bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

      console.log(`Stage 5 - Return journey at Klaffbron: ${bridgeText}`);
      expect(relevantBoats.length).toBe(1);
      expect(relevantBoats[0].targetBridge).toBe('Klaffbron');

      console.log('✅ System handled ghost ship appearances correctly');
    });
  });

  describe('Scenario 4: The Indecisive Captain (Multiple direction changes)', () => {
    test('should handle boat that keeps changing its mind about direction', async () => {
      const mmsi = 'INDECISIVE_012';
      const baseTime = Date.now();

      console.log('\n=== INDECISIVE CAPTAIN: Multiple Direction Changes ===');

      const directionChanges = [
        {
          time: 0, dir: 'Vänersborg', towards: true, desc: 'Initially northbound',
        },
        {
          time: 60000, dir: 'Göteborg', towards: false, desc: 'Changed mind - southbound',
        },
        {
          time: 120000, dir: 'Vänersborg', towards: true, desc: 'Changed again - northbound',
        },
        {
          time: 180000, dir: 'Göteborg', towards: false, desc: 'Southbound again',
        },
        {
          time: 240000, dir: 'Vänersborg', towards: true, desc: 'Final decision - northbound',
        },
      ];

      for (const [index, change] of directionChanges.entries()) {
        app._lastSeen.klaffbron = app._lastSeen.klaffbron || {};
        app._lastSeen.klaffbron[mmsi] = {
          ts: baseTime + change.time,
          sog: 3.2,
          dist: 220 + (index * 10), // Slightly different distances
          dir: change.dir,
          vessel_name: 'INDECISIVE',
          mmsi,
          towards: change.towards,
          maxRecentSog: 3.2,
        };

        const relevantBoats = await app._findRelevantBoats();
        const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

        console.log(`\nChange ${index + 1} - ${change.desc}:`);
        console.log(`  Direction: ${change.dir}, Towards: ${change.towards}`);
        console.log(`  Detected: ${relevantBoats.length > 0 ? 'YES' : 'NO'}`);

        if (relevantBoats.length > 0) {
          console.log(`  Bridge text: "${bridgeText}"`);
        }

        // Should only be relevant when actually approaching (towards = true)
        if (change.towards) {
          expect(relevantBoats.length).toBe(1);
        } else {
          // May or may not be detected when moving away, depending on smart logic
          console.log('  Moving away - detection depends on smart analysis');
        }
      }

      console.log('\n✅ System adapted to multiple direction changes');
    });
  });

  describe('Scenario 5: The Congestion Creator (Multiple boats chaos)', () => {
    test('should handle chaotic scenario with multiple unpredictable boats', async () => {
      const baseTime = Date.now();

      console.log('\n=== CONGESTION CHAOS: Multiple Unpredictable Boats ===');

      // Boat 1: Fast boat that suddenly stops
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron['CHAOS_001'] = {
        ts: baseTime,
        sog: 0.2, // Nearly stopped
        dist: 50, // Very close
        dir: 'Vänersborg',
        vessel_name: 'SUDDEN STOP',
        mmsi: 'CHAOS_001',
        towards: true,
        maxRecentSog: 8.5, // Was very fast before
      };

      // Boat 2: Boat oscillating between bridges
      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron['CHAOS_002'] = {
        ts: baseTime,
        sog: 4.8,
        dist: 300,
        dir: 'Göteborg',
        vessel_name: 'OSCILLATING',
        mmsi: 'CHAOS_002',
        towards: true,
        maxRecentSog: 4.8,
      };

      // Boat 3: Very slow cargo that might be waiting
      app._lastSeen.klaffbron['CHAOS_003'] = {
        ts: baseTime,
        sog: 0.8,
        dist: 400,
        dir: 'Vänersborg',
        vessel_name: 'SLOW CARGO',
        mmsi: 'CHAOS_003',
        towards: true,
        maxRecentSog: 2.1,
      };

      // Boat 4: Fast boat at wrong bridge
      app._lastSeen.olidebron = {};
      app._lastSeen.olidebron['CHAOS_004'] = {
        ts: baseTime,
        sog: 6.2,
        dist: 150,
        dir: 'Vänersborg',
        vessel_name: 'WRONG BRIDGE',
        mmsi: 'CHAOS_004',
        towards: true,
        maxRecentSog: 6.2,
      };

      const relevantBoats = await app._findRelevantBoats();
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

      console.log('\nChaos Analysis:');
      console.log('Total boats in system: 4');
      console.log(`Relevant boats detected: ${relevantBoats.length}`);
      console.log(`Generated bridge text: "${bridgeText}"`);

      relevantBoats.forEach((boat, index) => {
        console.log(`  Boat ${index + 1}: ${boat.mmsi} at ${boat.targetBridge}, ETA: ${boat.etaMinutes} min`);
      });

      // System should handle chaos gracefully
      expect(relevantBoats.length).toBeGreaterThan(0);
      expect(relevantBoats.length).toBeLessThanOrEqual(4);
      expect(bridgeText).toBeTruthy();
      expect(bridgeText.length).toBeGreaterThan(10);

      // Test system under stress - simulate rapid updates
      console.log('\nStress Test - Rapid Updates:');
      const startTime = Date.now();

      for (let i = 0; i < 10; i++) {
        // Rapidly update all boats with slight changes
        app._lastSeen.klaffbron['CHAOS_001'].sog = 0.2 + (i * 0.1);
        app._lastSeen.stridsbergsbron['CHAOS_002'].dist = 300 - (i * 10);
        app._lastSeen.klaffbron['CHAOS_003'].sog = 0.8 + (i * 0.2);
        app._lastSeen.olidebron['CHAOS_004'].dist = 150 + (i * 5);

        await app._findRelevantBoats();
      }

      const endTime = Date.now();
      const processingTime = endTime - startTime;

      console.log(`Stress test completed in ${processingTime}ms`);
      expect(processingTime).toBeLessThan(200); // Should handle rapid updates efficiently

      console.log('✅ System maintained stability under chaotic conditions');
    });
  });

  describe('Scenario 6: The AIS Glitch Simulator', () => {
    test('should handle corrupted/impossible AIS data gracefully', async () => {
      const mmsi = 'GLITCH_999';
      const baseTime = Date.now();

      console.log('\n=== AIS GLITCH: Impossible Data Scenarios ===');

      // Test 1: Impossible speed jump
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 45.7, // Impossible speed for this area
        dist: 100,
        dir: 'Vänersborg',
        vessel_name: 'SPEED DEMON',
        mmsi,
        towards: true,
        maxRecentSog: 45.7,
      };

      let relevantBoats = await app._findRelevantBoats();
      console.log(`Test 1 - Impossible speed (45.7kn): Detected ${relevantBoats.length} boats`);

      if (relevantBoats.length > 0) {
        console.log(`  ETA with impossible speed: ${relevantBoats[0].etaMinutes} minutes`);
        expect(relevantBoats[0].etaMinutes).toBeGreaterThan(0);
        expect(relevantBoats[0].etaMinutes).toBeLessThan(10);
      }

      // Test 2: Zero distance (impossible - boat AT the bridge)
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime + 30000,
        sog: 3.2,
        dist: 0, // Exactly at bridge
        dir: 'Vänersborg',
        vessel_name: 'TELEPORTER',
        mmsi,
        towards: true,
        maxRecentSog: 45.7,
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Test 2 - Zero distance: Detected ${relevantBoats.length} boats`);

      if (relevantBoats.length > 0) {
        console.log(`  ETA with zero distance: ${relevantBoats[0].etaMinutes}`);
      }

      // Test 3: Negative speed (AIS glitch)
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime + 60000,
        sog: -2.3, // Negative speed (AIS error)
        dist: 150,
        dir: 'Vänersborg',
        vessel_name: 'REVERSE TIME',
        mmsi,
        towards: true,
        maxRecentSog: 45.7,
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Test 3 - Negative speed: Detected ${relevantBoats.length} boats`);

      // Test 4: Massive distance jump (teleportation)
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime + 90000,
        sog: 4.2,
        dist: 15000, // 15km away (impossible jump)
        dir: 'Vänersborg',
        vessel_name: 'TELEPORTER',
        mmsi,
        towards: true,
        maxRecentSog: 45.7,
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Test 4 - Massive distance: Detected ${relevantBoats.length} boats`);

      console.log('✅ System handled AIS glitches without crashing');
    });
  });
});
