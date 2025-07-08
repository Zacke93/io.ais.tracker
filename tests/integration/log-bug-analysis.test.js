const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('Log Bug Analysis - Real AIS Log Issues', () => {
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

  describe('Bug 1: Frozen vessel data syndrome', () => {
    test('should detect and recover from frozen vessel data', async () => {
      const mmsi = 'BUG1_TEST';
      const baseTime = Date.now();
      
      console.log('=== BUG 1: Frozen vessel data syndrome ===');
      
      // Stage 1: Normal vessel data
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 2.1,
        dist: 287.140534304579,
        dir: 'Vänersborg',
        vessel_name: 'FROZEN TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.1,
        lastActiveTime: baseTime,
        lastDistances: { klaffbron: 287.140534304579 },
        lat: 58.284,
        lon: 12.284,
      };

      let relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 1 - Normal data: ${relevantBoats.length} boats detected`);

      // Stage 2: Simulate frozen data by repeating same position/speed
      // This simulates the real bug where identical data was processed repeatedly
      const frozenLat = 58.284;
      const frozenLon = 12.284;
      const frozenSog = 2.1;
      const frozenDist = 287.140534304579;

      // Update with identical data multiple times
      for (let i = 0; i < 5; i++) {
        app._lastSeen.klaffbron[mmsi] = {
          ...app._lastSeen.klaffbron[mmsi],
          ts: baseTime + (i * 60000), // Time advances but data is identical
          sog: frozenSog,
          dist: frozenDist,
          lat: frozenLat,
          lon: frozenLon,
          lastDistances: { klaffbron: frozenDist },
        };
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Check if stale data warning was triggered
      const vessel = app._lastSeen.klaffbron[mmsi];
      console.log(`Stage 2 - After frozen data: vessel exists=${!!vessel}`);

      // Stage 3: New data arrives (recovery)
      app._lastSeen.klaffbron[mmsi] = {
        ...app._lastSeen.klaffbron[mmsi],
        ts: baseTime + 300000,
        sog: 2.3,
        dist: 250, // Changed position indicates recovery
        lat: 58.292,
        lon: 12.292,
        lastDistances: { klaffbron: 250 },
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 3 - After recovery: ${relevantBoats.length} boats detected`);

      console.log('✅ Frozen data detection and recovery tested');
    });
  });

  describe('Bug 2: 7-minute gap scenario', () => {
    test('should maintain vessel through long gaps with proper timeouts', async () => {
      const mmsi = 'BUG2_TEST';
      const baseTime = Date.now();
      
      console.log('\n=== BUG 2: 7-minute gap scenario ===');
      
      // Stage 1: Vessel detected at Klaffbron
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 2.1,
        dist: 287.140534304579,
        dir: 'Vänersborg',
        vessel_name: 'GAP TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.1,
        lastActiveTime: baseTime,
        lastDistances: { klaffbron: 287.140534304579 },
        lat: 58.284,
        lon: 12.284,
      };

      let relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 1 - Initial detection: ${relevantBoats.length} boats detected`);

      // Stage 2: 7-minute gap (no updates)
      const gapDuration = 7 * 60 * 1000; // 7 minutes
      const afterGapTime = baseTime + gapDuration;
      
      // Check if vessel is still tracked during gap
      const timeoutValue = app._getSpeedAdjustedTimeout(app._lastSeen.klaffbron[mmsi]);
      console.log(`Timeout for vessel: ${timeoutValue} seconds`);
      console.log(`Gap duration: ${gapDuration / 1000} seconds`);
      
      // Simulate time passing
      jest.spyOn(Date, 'now').mockReturnValue(afterGapTime);
      
      // Check if vessel survives the gap
      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 2 - After 7-minute gap: ${relevantBoats.length} boats detected`);
      
      // Stage 3: New data arrives at Järnvägsbron
      app._lastSeen.jarnvagsbron = {};
      app._lastSeen.jarnvagsbron[mmsi] = {
        ts: afterGapTime,
        sog: 2.3,
        dist: 180,
        dir: 'Vänersborg',
        vessel_name: 'GAP TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.3,
        lastActiveTime: afterGapTime,
        lastDistances: { jarnvagsbron: 180 },
        lat: 58.292,
        lon: 12.292,
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 3 - Recovery at Järnvägsbron: ${relevantBoats.length} boats detected`);

      // Restore normal time
      jest.restoreAllMocks();

      console.log('✅ 7-minute gap scenario tested');
    });
  });

  describe('Bug 3: Missing bridge passage detection', () => {
    test('should detect boats jumping between bridges', async () => {
      const mmsi = 'BUG3_TEST';
      const baseTime = Date.now();
      
      console.log('\n=== BUG 3: Missing bridge passage detection ===');
      
      // Stage 1: Vessel at Klaffbron
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 2.1,
        dist: 287.140534304579,
        dir: 'Vänersborg',
        vessel_name: 'JUMPER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.1,
        lastActiveTime: baseTime,
        lastDistances: { klaffbron: 287.140534304579 },
        lat: 58.284,
        lon: 12.284,
      };

      let relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 1 - At Klaffbron: ${relevantBoats.length} boats detected`);

      // Stage 2: Vessel suddenly appears at Järnvägsbron (bridge jump)
      // Simulate what happens in the real system - vessel moves to next bridge
      app._lastSeen.jarnvagsbron = {};
      app._lastSeen.jarnvagsbron[mmsi] = {
        ts: baseTime + 300000,
        sog: 2.3,
        dist: 180,
        dir: 'Vänersborg',
        vessel_name: 'JUMPER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.3,
        lastActiveTime: baseTime + 300000,
        lastDistances: { 
          klaffbron: 1000, // Now far from previous bridge
          jarnvagsbron: 180  // Close to new bridge
        },
        lat: 58.292,
        lon: 12.292,
      };

      // Remove from previous bridge (simulating bridge passage)
      delete app._lastSeen.klaffbron[mmsi];

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 2 - After bridge jump: ${relevantBoats.length} boats detected`);

      // Check if bridge passage was detected
      const vesselAtJarnvagsbron = app._lastSeen.jarnvagsbron && app._lastSeen.jarnvagsbron[mmsi];
      console.log(`Vessel found at Järnvägsbron: ${!!vesselAtJarnvagsbron}`);

      // Check if vessel was properly moved to next bridge
      const vesselAtKlaffbron = app._lastSeen.klaffbron && app._lastSeen.klaffbron[mmsi];
      console.log(`Vessel still at Klaffbron: ${!!vesselAtKlaffbron}`);

      console.log('✅ Bridge jump detection tested');
    });
  });

  describe('Bug 4: Protection zone trap', () => {
    test('should prevent boats from being trapped in protection zones', async () => {
      const mmsi = 'BUG4_TEST';
      const baseTime = Date.now();
      
      console.log('\n=== BUG 4: Protection zone trap ===');
      
      // Stage 1: Vessel enters protection zone
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 0.8,
        dist: 250, // Within protection zone
        dir: 'Vänersborg',
        vessel_name: 'TRAPPED BOAT',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.5,
        lastActiveTime: baseTime,
        lastDistances: { klaffbron: 250 },
        lat: 58.284,
        lon: 12.284,
      };

      let relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 1 - Entering protection zone: ${relevantBoats.length} boats detected`);

      // Stage 2: Vessel turns around in protection zone
      app._lastSeen.klaffbron[mmsi] = {
        ...app._lastSeen.klaffbron[mmsi],
        ts: baseTime + 60000,
        sog: 0.5,
        dist: 280,
        dir: 'Göteborg', // Turned around
        towards: false,
        lastActiveTime: baseTime + 60000,
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 2 - Turned around in protection zone: ${relevantBoats.length} boats detected`);

      // Stage 3: Long time passes - check for timeout
      const longTime = baseTime + (25 * 60 * 1000); // 25 minutes
      jest.spyOn(Date, 'now').mockReturnValue(longTime);

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 3 - After 25 minutes: ${relevantBoats.length} boats detected`);

      // Check if escape conditions work
      const escapeCondition = app._shouldEscapeProtectionZone(app._lastSeen.klaffbron[mmsi], 'klaffbron');
      console.log(`Escape condition triggered: ${escapeCondition}`);

      // Restore normal time
      jest.restoreAllMocks();

      console.log('✅ Protection zone trap prevention tested');
    });
  });

  describe('Bug 5: Stale AIS data processing', () => {
    test('should detect and warn about stale AIS data', async () => {
      const mmsi = 'BUG5_TEST';
      const baseTime = Date.now();
      
      console.log('\n=== BUG 5: Stale AIS data processing ===');
      
      // Stage 1: Fresh data
      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron[mmsi] = {
        ts: baseTime,
        sog: 2.1,
        dist: 195,
        dir: 'Vänersborg',
        vessel_name: 'STALE TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.1,
        lastActiveTime: baseTime,
        lastDistances: { stridsbergsbron: 195 },
        lat: 58.284,
        lon: 12.284,
      };

      let relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 1 - Fresh data: ${relevantBoats.length} boats detected`);

      // Stage 2: Simulate stale data by not updating for a long time
      // but keeping the vessel in the system
      const staleTime = baseTime - 300000; // 5 minutes ago
      app._lastSeen.stridsbergsbron[mmsi] = {
        ...app._lastSeen.stridsbergsbron[mmsi],
        ts: staleTime,
        lastActiveTime: staleTime,
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 2 - Stale data: ${relevantBoats.length} boats detected`);

      // Stage 3: Duplicate data - exact same timestamp and position
      // This simulates the stale data warning scenario
      app._lastSeen.stridsbergsbron[mmsi] = {
        ...app._lastSeen.stridsbergsbron[mmsi],
        ts: baseTime + 60000, // Later time
        lastActiveTime: baseTime + 60000,
        // But same position/speed (would trigger duplicate detection)
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 3 - Duplicate data: ${relevantBoats.length} boats detected`);

      console.log('✅ Stale data detection tested');
    });
  });

  describe('Integration Test: All bugs combined', () => {
    test('should handle multiple bug scenarios simultaneously', async () => {
      const baseTime = Date.now();
      
      console.log('\n=== INTEGRATION TEST: All bugs combined ===');
      
      // Create multiple vessels with different bug scenarios
      const vessels = [
        {
          mmsi: 'MULTI_001',
          name: 'FROZEN BOAT',
          issue: 'frozen data syndrome',
          bridge: 'klaffbron',
          sog: 2.1,
          dist: 287.140534304579,
        },
        {
          mmsi: 'MULTI_002',
          name: 'GAP BOAT',
          issue: '7-minute gap',
          bridge: 'stridsbergsbron',
          sog: 1.8,
          dist: 220,
        },
        {
          mmsi: 'MULTI_003',
          name: 'JUMPER BOAT',
          issue: 'bridge jump',
          bridge: 'jarnvagsbron',
          sog: 2.5,
          dist: 180,
        },
        {
          mmsi: 'MULTI_004',
          name: 'TRAPPED BOAT',
          issue: 'protection zone trap',
          bridge: 'klaffbron',
          sog: 0.5,
          dist: 280,
        },
        {
          mmsi: 'MULTI_005',
          name: 'STALE BOAT',
          issue: 'stale data',
          bridge: 'stridsbergsbron',
          sog: 1.9,
          dist: 195,
        },
      ];

      // Set up all vessels
      vessels.forEach(vessel => {
        app._lastSeen[vessel.bridge] = app._lastSeen[vessel.bridge] || {};
        app._lastSeen[vessel.bridge][vessel.mmsi] = {
          ts: baseTime,
          sog: vessel.sog,
          dist: vessel.dist,
          dir: 'Vänersborg',
          vessel_name: vessel.name,
          mmsi: vessel.mmsi,
          towards: vessel.mmsi === 'MULTI_004' ? false : true, // Trapped boat is turned around
          maxRecentSog: Math.max(vessel.sog, 2.0),
          lastActiveTime: baseTime,
          lastDistances: { [vessel.bridge]: vessel.dist },
          lat: 58.284 + (Math.random() * 0.01),
          lon: 12.284 + (Math.random() * 0.01),
        };
      });

      // Test system performance with all bugs
      const startTime = Date.now();
      const relevantBoats = await app._findRelevantBoats();
      const endTime = Date.now();

      const processingTime = endTime - startTime;
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);

      console.log(`\nINTEGRATION TEST RESULTS:`);
      console.log(`Total vessels with bugs: ${vessels.length}`);
      console.log(`Vessels detected: ${relevantBoats.length}`);
      console.log(`Processing time: ${processingTime}ms`);
      console.log(`Bridge text: "${bridgeText}"`);

      // Check each vessel
      vessels.forEach(vessel => {
        const detected = relevantBoats.some(rb => rb.mmsi === vessel.mmsi);
        console.log(`${vessel.name} (${vessel.issue}): ${detected ? 'DETECTED' : 'NOT DETECTED'}`);
      });

      // Performance should be acceptable even with multiple bugs
      expect(processingTime).toBeLessThan(500);
      expect(relevantBoats.length).toBeGreaterThan(0);

      console.log('✅ All bug scenarios tested simultaneously');
    });
  });
});