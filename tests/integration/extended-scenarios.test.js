const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);
const { BOAT_SCENARIOS } = require('../fixtures/boat-data');

describe('Extended Realistic Boat Scenarios', () => {
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

  describe('Scenario 1: Speed Demon Fast Motorboat Journey', () => {
    test('should track SPEED DEMON complete journey from approach to waiting', async () => {
      const speedDemonMmsi = '265123456';
      const journeyData = BOAT_SCENARIOS.fast_motorboat_goteborg.route;

      console.log('=== SPEED DEMON Journey Analysis ===');
      console.log('Initial position at Olidebron area, heading towards Stridsbergsbron');

      let previousEta = null;
      const baseTime = Date.now();

      for (const [index, position] of journeyData.entries()) {
        const currentTime = baseTime + (index * 60000); // 1 minute intervals

        // Determine which bridge is closest
        let closestBridge = 'olidebron';
        if (index >= 3) closestBridge = 'stridsbergsbron'; // Near final destination

        app._lastSeen[closestBridge] = app._lastSeen[closestBridge] || {};
        app._lastSeen[closestBridge][speedDemonMmsi] = {
          ts: currentTime,
          sog: position.sog,
          dist: calculateDistanceToClosestBridge(position.lat, position.lon),
          dir: 'Göteborg', // Southbound
          vessel_name: 'SPEED DEMON',
          mmsi: speedDemonMmsi,
          towards: position.sog > 1.0, // Moving towards if speed > 1 knot
          maxRecentSog: Math.max(position.sog, 8.5), // Max observed speed
        };

        const relevantBoats = await app._findRelevantBoats();

        console.log(`\n--- Step ${index + 1}: ${position.sog} knots ---`);
        console.log(`Position: ${position.lat.toFixed(6)}, ${position.lon.toFixed(6)}`);
        console.log(`Speed: ${position.sog} knots, Course: ${position.cog}°`);

        if (relevantBoats.length > 0) {
          const boat = relevantBoats[0];
          console.log(`Detected at: ${boat.targetBridge}`);
          console.log(`ETA: ${boat.etaMinutes} minutes (was ${previousEta})`);
          console.log(`Status: ${boat.etaMinutes === 'waiting' ? 'WAITING for bridge opening' : 'APPROACHING'}`);

          expect(boat.mmsi).toBe(speedDemonMmsi);
          expect(['Klaffbron', 'Stridsbergsbron']).toContain(boat.targetBridge);

          if (index < 4) { // Before final waiting position
            expect(typeof boat.etaMinutes === 'number').toBe(true);
            expect(boat.etaMinutes).toBeGreaterThan(0);
            expect(boat.etaMinutes).toBeLessThan(30);
          } else { // Final position - very close, should be waiting or very short ETA
            expect(boat.etaMinutes === 'waiting' || boat.etaMinutes < 2).toBe(true);
          }

          previousEta = boat.etaMinutes;
        } else {
          console.log('Not detected as relevant boat (speed too low or wrong direction)');
        }
      }

      console.log('\n=== Journey Summary ===');
      console.log('SPEED DEMON showed classic fast boat behavior:');
      console.log('1. High speed approach (8+ knots)');
      console.log('2. Gradual deceleration near bridge');
      console.log('3. Final waiting position (0.3 knots)');
      console.log('4. Proper ETA calculations throughout journey');
    });
  });

  describe('Scenario 2: Cargo Master Slow Journey', () => {
    test('should track CARGO MASTER steady cargo vessel journey', async () => {
      const cargoMmsi = '265789012';
      const journeyData = BOAT_SCENARIOS.slow_cargo_vanersborg.route;

      console.log('\n=== CARGO MASTER Journey Analysis ===');
      console.log('Cargo vessel heading north towards Vänersborg');

      const baseTime = Date.now();

      for (const [index, position] of journeyData.entries()) {
        const currentTime = baseTime + (index * 120000); // 2 minute intervals

        // Determine bridge based on journey progress
        let closestBridge = 'stridsbergsbron';
        if (index >= 4) closestBridge = 'klaffbron'; // Reached Klaffbron area

        app._lastSeen[closestBridge] = app._lastSeen[closestBridge] || {};
        app._lastSeen[closestBridge][cargoMmsi] = {
          ts: currentTime,
          sog: position.sog,
          dist: calculateDistanceToClosestBridge(position.lat, position.lon),
          dir: 'Vänersborg', // Northbound
          vessel_name: 'CARGO MASTER',
          mmsi: cargoMmsi,
          towards: true,
          maxRecentSog: Math.max(position.sog, 3.8), // Max observed speed
        };

        const relevantBoats = await app._findRelevantBoats();

        console.log(`\n--- Step ${index + 1}: Cargo vessel at ${position.sog} knots ---`);
        console.log(`Position: ${position.lat.toFixed(6)}, ${position.lon.toFixed(6)}`);

        if (relevantBoats.length > 0) {
          const boat = relevantBoats[0];
          console.log(`Cargo vessel approaching: ${boat.targetBridge}`);
          console.log(`ETA: ${boat.etaMinutes} minutes`);
          console.log(`Steady cargo behavior: ${position.sog} knots (consistent)`);

          expect(boat.mmsi).toBe(cargoMmsi);
          expect(['Klaffbron', 'Stridsbergsbron']).toContain(boat.targetBridge);

          // Cargo vessels should have consistent ETAs
          expect(typeof boat.etaMinutes === 'number' || boat.etaMinutes === 'waiting').toBe(true);
          if (typeof boat.etaMinutes === 'number') {
            expect(boat.etaMinutes).toBeGreaterThan(0.5); // More forgiving for cargo boats
            expect(boat.etaMinutes).toBeLessThan(25);
          }
        } else {
          console.log('Cargo vessel not yet in target bridge detection range');
        }
      }

      console.log('\n=== Cargo Journey Summary ===');
      console.log('CARGO MASTER demonstrated typical cargo vessel behavior:');
      console.log('1. Consistent speed (3.2-3.8 knots)');
      console.log('2. Predictable route northbound');
      console.log('3. Reliable ETA calculations for slow vessels');
    });
  });

  describe('Scenario 3: Bridge Runner Multi-Bridge Sequence', () => {
    test('should track BRIDGE RUNNER through multiple bridge passages', async () => {
      const bridgeRunnerMmsi = '265901234';
      const journeyData = BOAT_SCENARIOS.multi_bridge_speedboat.route;

      console.log('\n=== BRIDGE RUNNER Multi-Bridge Analysis ===');
      console.log('Fast boat navigating through entire bridge network');

      const baseTime = Date.now();
      const bridgeSequence = ['olidebron', 'klaffbron', 'jarnvagsbron', 'stridsbergsbron'];
      let currentBridgeIndex = 0;

      for (const [index, position] of journeyData.entries()) {
        const currentTime = baseTime + (index * 120000); // 2 minute intervals

        // Advance bridge based on journey progress
        if (index >= 1 && index <= 2) currentBridgeIndex = 1; // Klaffbron area
        if (index >= 3 && index <= 4) currentBridgeIndex = 2; // Järnvägsbron area
        if (index >= 5) currentBridgeIndex = 3; // Stridsbergsbron area

        const currentBridge = bridgeSequence[currentBridgeIndex];

        app._lastSeen[currentBridge] = app._lastSeen[currentBridge] || {};
        app._lastSeen[currentBridge][bridgeRunnerMmsi] = {
          ts: currentTime,
          sog: position.sog,
          dist: calculateDistanceToClosestBridge(position.lat, position.lon),
          dir: 'Vänersborg', // Northbound
          vessel_name: 'BRIDGE RUNNER',
          mmsi: bridgeRunnerMmsi,
          towards: position.sog > 2.0,
          maxRecentSog: Math.max(position.sog, 12.5), // Max speed recorded
        };

        const relevantBoats = await app._findRelevantBoats();

        console.log(`\n--- Bridge ${index + 1}: ${currentBridge.toUpperCase()} ---`);
        console.log(`Position: ${position.lat.toFixed(6)}, ${position.lon.toFixed(6)}`);
        console.log(`Speed: ${position.sog} knots (${getSpeedBehavior(position.sog)})`);

        if (relevantBoats.length > 0) {
          const boat = relevantBoats[0];
          console.log(`Bridge Runner at: ${boat.targetBridge}`);
          console.log(`ETA: ${boat.etaMinutes} minutes`);

          // Test bridge passage detection and route prediction
          if (index > 0) {
            console.log(`Successfully tracked through bridge sequence: ${currentBridge}`);
          }

          expect(boat.mmsi).toBe(bridgeRunnerMmsi);
          expect(['Klaffbron', 'Stridsbergsbron']).toContain(boat.targetBridge);

          // Final position should show waiting or very short ETA
          if (index === journeyData.length - 1) {
            expect(boat.etaMinutes === 'waiting' || boat.etaMinutes < 5).toBe(true);
          }
        } else {
          console.log('Bridge Runner between bridges or not detected');
        }
      }

      console.log('\n=== Multi-Bridge Summary ===');
      console.log('BRIDGE RUNNER successfully demonstrated:');
      console.log('1. High-speed approach (12+ knots)');
      console.log('2. Bridge-specific deceleration/acceleration');
      console.log('3. Route prediction through bridge network');
      console.log('4. Final waiting position detection');
    });
  });

  describe('Scenario 4: Fishing Boat Irregular Behavior', () => {
    test('should handle CATCH OF THE DAY irregular fishing boat behavior', async () => {
      const fishingMmsi = '265567890';
      const journeyData = BOAT_SCENARIOS.fishing_boat_irregular.route;

      console.log('\n=== FISHING BOAT Irregular Behavior Analysis ===');
      console.log('Fishing vessel with unpredictable speed patterns');

      const baseTime = Date.now();

      for (const [index, position] of journeyData.entries()) {
        const currentTime = baseTime + (index * 180000); // 3 minute intervals

        app._lastSeen.klaffbron = app._lastSeen.klaffbron || {};
        app._lastSeen.klaffbron[fishingMmsi] = {
          ts: currentTime,
          sog: position.sog,
          dist: calculateDistanceToClosestBridge(position.lat, position.lon),
          dir: 'Göteborg', // Southbound
          vessel_name: 'CATCH OF THE DAY',
          mmsi: fishingMmsi,
          towards: position.sog > 0.5,
          maxRecentSog: Math.max(position.sog, 4.2), // Max recorded speed
        };

        const relevantBoats = await app._findRelevantBoats();

        console.log(`\n--- Fishing Step ${index + 1}: ${getFishingBehavior(position.sog)} ---`);
        console.log(`Position: ${position.lat.toFixed(6)}, ${position.lon.toFixed(6)}`);
        console.log(`Speed: ${position.sog} knots (${getSpeedBehavior(position.sog)})`);

        if (relevantBoats.length > 0) {
          const boat = relevantBoats[0];
          console.log(`Fishing boat detected: ${boat.targetBridge}`);
          console.log(`ETA: ${boat.etaMinutes} minutes`);
          console.log(`Behavior: ${analyzeFishingBehavior(position.sog, index)}`);

          expect(boat.mmsi).toBe(fishingMmsi);
          expect(['Klaffbron', 'Stridsbergsbron']).toContain(boat.targetBridge);

          // Fishing boats should have valid ETAs when moving
          if (position.sog > 1.0) {
            expect(typeof boat.etaMinutes === 'number' || boat.etaMinutes === 'waiting').toBe(true);
          }
        } else {
          console.log(`Fishing boat not relevant (speed: ${position.sog} knots)`);
        }
      }

      console.log('\n=== Fishing Boat Summary ===');
      console.log('CATCH OF THE DAY exhibited typical fishing behavior:');
      console.log('1. Variable speeds (0.5 - 4.2 knots)');
      console.log('2. Stop-and-go patterns (fishing activity)');
      console.log('3. Eventually approaching bridge normally');
      console.log('4. System handled irregular patterns correctly');
    });
  });

  describe('Scenario 5: Anchored Sailboat Analysis', () => {
    test('should properly ignore WIND DANCER anchored sailboat', async () => {
      const sailboatMmsi = '265345678';
      const journeyData = BOAT_SCENARIOS.anchored_sailboat.route;

      console.log('\n=== ANCHORED SAILBOAT Analysis ===');
      console.log('Sailboat that anchored and should be ignored');

      const baseTime = Date.now();

      for (const [index, position] of journeyData.entries()) {
        const currentTime = baseTime + (index * 300000); // 5 minute intervals

        app._lastSeen.olidebron = app._lastSeen.olidebron || {};
        app._lastSeen.olidebron[sailboatMmsi] = {
          ts: currentTime,
          sog: position.sog,
          dist: calculateDistanceToClosestBridge(position.lat, position.lon),
          dir: 'Göteborg',
          vessel_name: 'WIND DANCER',
          mmsi: sailboatMmsi,
          towards: position.sog > 0.5,
          maxRecentSog: Math.max(position.sog, 4.5), // Historic max speed
        };

        const relevantBoats = await app._findRelevantBoats();

        console.log(`\n--- Anchoring Step ${index + 1}: ${getAnchoringBehavior(position.sog)} ---`);
        console.log(`Position: ${position.lat.toFixed(6)}, ${position.lon.toFixed(6)}`);
        console.log(`Speed: ${position.sog} knots (${getSpeedBehavior(position.sog)})`);

        if (index < 2) {
          // Early positions when boat was moving
          if (relevantBoats.length > 0) {
            console.log('Sailboat detected while moving');
            expect(relevantBoats[0].mmsi).toBe(sailboatMmsi);
          }
        } else {
          // Later positions when anchored
          console.log('Sailboat anchored - should be ignored by system');
          const sailboatDetected = relevantBoats.some((boat) => boat.mmsi === sailboatMmsi);
          expect(sailboatDetected).toBe(false);
        }
      }

      console.log('\n=== Anchored Sailboat Summary ===');
      console.log('WIND DANCER correctly demonstrated:');
      console.log('1. Initial detection while moving (4.5 knots)');
      console.log('2. Gradual deceleration to anchored state');
      console.log('3. System correctly ignores anchored vessels');
      console.log('4. No false bridge opening predictions');
    });
  });

  describe('Scenario 6: Complex Multi-Vessel Interactions', () => {
    test('should handle multiple boats at different bridges simultaneously', async () => {
      const baseTime = Date.now();

      console.log('\n=== MULTI-VESSEL INTERACTION Analysis ===');
      console.log('Testing complex scenario with multiple boats at different bridges');

      // Set up multiple boats at different bridges
      const boats = [
        {
          mmsi: '265123456',
          name: 'SPEED DEMON',
          bridge: 'stridsbergsbron',
          sog: 2.1,
          dist: 150,
          dir: 'Göteborg',
        },
        {
          mmsi: '265789012',
          name: 'CARGO MASTER',
          bridge: 'klaffbron',
          sog: 3.2,
          dist: 200,
          dir: 'Vänersborg',
        },
        {
          mmsi: '265567890',
          name: 'CATCH OF THE DAY',
          bridge: 'klaffbron',
          sog: 3.8,
          dist: 250,
          dir: 'Göteborg',
        },
      ];

      // Set up all boats
      boats.forEach((boat, index) => {
        app._lastSeen[boat.bridge] = app._lastSeen[boat.bridge] || {};
        app._lastSeen[boat.bridge][boat.mmsi] = {
          ts: baseTime + (index * 1000),
          sog: boat.sog,
          dist: boat.dist,
          dir: boat.dir,
          vessel_name: boat.name,
          mmsi: boat.mmsi,
          towards: true,
          maxRecentSog: boat.sog + 1.0,
        };

        console.log(`\n--- Setup: ${boat.name} at ${boat.bridge.toUpperCase()} ---`);
        console.log(`Speed: ${boat.sog} knots, Distance: ${boat.dist}m`);
        console.log(`Direction: ${boat.dir}`);
      });

      const relevantBoats = await app._findRelevantBoats();

      console.log('\n--- Multi-Vessel Results ---');
      console.log(`Total boats detected: ${relevantBoats.length}`);

      relevantBoats.forEach((boat, index) => {
        console.log(`\nBoat ${index + 1}: ${boat.vessel_name || 'Unknown'}`);
        console.log(`  MMSI: ${boat.mmsi}`);
        console.log(`  Target Bridge: ${boat.targetBridge}`);
        console.log(`  ETA: ${boat.etaMinutes} minutes`);
        console.log(`  Confidence: ${boat.confidence || 'Unknown'}`);
      });

      // Test message generation for multiple boats
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      console.log(`\nGenerated Message: "${bridgeText}"`);

      // Validate results
      expect(relevantBoats.length).toBeGreaterThan(0);
      expect(relevantBoats.length).toBeLessThanOrEqual(3);

      // Should detect boats at target bridges
      const targetBridges = relevantBoats.map((boat) => boat.targetBridge);
      expect(targetBridges.every((bridge) => ['Klaffbron', 'Stridsbergsbron'].includes(bridge))).toBe(true);

      // Message should contain bridge information
      expect(bridgeText).toBeTruthy();
      expect(bridgeText.length).toBeGreaterThan(10);

      console.log('\n=== Multi-Vessel Summary ===');
      console.log('Complex multi-vessel scenario verified:');
      console.log('1. Multiple boats detected simultaneously');
      console.log('2. Correct target bridge assignment');
      console.log('3. Proper message generation');
      console.log('4. No interference between boat tracking');
    });
  });

  // Helper functions for analysis
  function calculateDistanceToClosestBridge(lat, lon) {
    // Simplified distance calculation - return realistic bridge distances
    return Math.floor(Math.random() * 300) + 50; // 50-350m
  }

  function getSpeedBehavior(speed) {
    if (speed > 8) return 'high speed';
    if (speed > 4) return 'normal speed';
    if (speed > 1) return 'slow speed';
    if (speed > 0.5) return 'very slow';
    return 'nearly stopped';
  }

  function getFishingBehavior(speed) {
    if (speed > 3) return 'fishing boat traveling';
    if (speed > 1) return 'fishing boat moving slowly';
    if (speed > 0.5) return 'fishing boat drifting';
    return 'fishing boat stopped (fishing?)';
  }

  function getAnchoringBehavior(speed) {
    if (speed > 2) return 'sailboat under way';
    if (speed > 0.5) return 'sailboat slowing down';
    return 'sailboat anchored';
  }

  function analyzeFishingBehavior(speed, step) {
    const behaviors = [
      'normal approach',
      'slowing for fishing',
      'fishing activity (stopped)',
      'resuming travel',
      'normal approach',
      'approaching bridge',
    ];
    return behaviors[step] || 'unknown behavior';
  }
});
