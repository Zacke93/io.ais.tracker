const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('Problematic Behavior Analysis - Edge Cases', () => {
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

  describe('Problem 1: Boats turning around near bridges', () => {
    test('CURRENT BEHAVIOR: Boat turning around at 50m from bridge gets removed', async () => {
      const mmsi = 'PROBLEM_001';
      const baseTime = Date.now();
      
      console.log('=== PROBLEM 1: Boat turning around very close to bridge ===');
      
      // Stage 1: Boat approaching bridge (80m away)
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 3.2,
        dist: 80, // Very close to bridge
        dir: 'Vänersborg',
        vessel_name: 'CLOSE TURNER',
        mmsi: mmsi,
        towards: true, // Approaching
        maxRecentSog: 3.2,
        lastActiveTime: baseTime,
      };

      let relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 1 - Approaching at 80m: ${relevantBoats.length} boats detected`);
      
      if (relevantBoats.length > 0) {
        const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
        console.log(`Bridge text: "${bridgeText}"`);
      }
      
      // Stage 2: Boat turns around but is still very close (50m away)
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime + 30000,
        sog: 2.8,
        dist: 50, // Still very close!
        dir: 'Göteborg', // Changed direction
        vessel_name: 'CLOSE TURNER',
        mmsi: mmsi,
        towards: false, // Now moving away
        maxRecentSog: 3.2,
        lastActiveTime: baseTime,
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 2 - Turned around at 50m: ${relevantBoats.length} boats detected`);
      
      if (relevantBoats.length > 0) {
        const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
        console.log(`Bridge text: "${bridgeText}"`);
      } else {
        console.log('❌ PROBLEM: Boat removed despite being only 50m from bridge!');
        console.log('   This boat might be waiting for bridge to open, not actually leaving');
      }
      
      // Stage 3: Boat now 400m away (clearly leaving)
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime + 60000,
        sog: 3.5,
        dist: 400, // Far from bridge
        dir: 'Göteborg',
        vessel_name: 'CLOSE TURNER',
        mmsi: mmsi,
        towards: false,
        maxRecentSog: 3.5,
        lastActiveTime: baseTime,
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 3 - Departed at 400m: ${relevantBoats.length} boats detected`);
      console.log('✅ This should be removed (clearly departed)');
      
      console.log('\n📋 ANALYSIS:');
      console.log('- Stage 1: Correctly detected approaching boat');
      console.log('- Stage 2: ❌ PROBLEM - Removed boat at 50m when it might be waiting');
      console.log('- Stage 3: ✅ Correctly removed boat when far away');
    });

    test('PROPOSED SOLUTION: 300m radius protection zone', async () => {
      const mmsi = 'SOLUTION_001';
      const baseTime = Date.now();
      
      console.log('\n=== PROPOSED SOLUTION: 300m radius protection ===');
      
      // Simulate improved logic
      function shouldKeepTurnaroundBoat(vessel, bridgeDistance) {
        const PROTECTION_RADIUS = 300; // meters
        const isWithinProtectionZone = bridgeDistance <= PROTECTION_RADIUS;
        const isWaiting = vessel.sog < 0.5 && vessel.maxRecentSog > 2.0;
        
        // Keep boat if within protection zone OR if waiting
        return isWithinProtectionZone || isWaiting;
      }
      
      // Test different scenarios
      const scenarios = [
        { dist: 50, sog: 2.8, desc: '50m from bridge, normal speed' },
        { dist: 250, sog: 1.2, desc: '250m from bridge, slow speed' },
        { dist: 400, sog: 3.5, desc: '400m from bridge, normal speed' },
        { dist: 150, sog: 0.3, desc: '150m from bridge, very slow (waiting)' },
      ];
      
      scenarios.forEach((scenario, index) => {
        const vessel = {
          sog: scenario.sog,
          maxRecentSog: 3.2,
          dist: scenario.dist,
          towards: false, // All are turned around
        };
        
        const shouldKeep = shouldKeepTurnaroundBoat(vessel, scenario.dist);
        console.log(`Scenario ${index + 1} - ${scenario.desc}: ${shouldKeep ? 'KEEP' : 'REMOVE'}`);
      });
      
      console.log('\n📋 PROPOSED LOGIC:');
      console.log('- Within 300m of bridge: KEEP (might be waiting)');
      console.log('- Beyond 300m: REMOVE (clearly departed)');  
      console.log('- Waiting boats (slow + recent fast): ALWAYS KEEP');
    });
  });

  describe('Problem 2: Very slow boats near bridges', () => {
    test('CURRENT BEHAVIOR: Slow boats under 0.2 knots get removed', async () => {
      const mmsi = 'PROBLEM_002';
      const baseTime = Date.now();
      
      console.log('\n=== PROBLEM 2: Very slow boats near bridges ===');
      
      // Stage 1: Boat approaching normally
      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron[mmsi] = {
        ts: baseTime,
        sog: 2.5,
        dist: 150,
        dir: 'Göteborg',
        vessel_name: 'SLOW BOAT',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.5,
        lastActiveTime: baseTime,
      };

      let relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 1 - Normal approach: ${relevantBoats.length} boats detected`);
      
      // Stage 2: Boat slows down significantly (0.1 knots) but is very close
      app._lastSeen.stridsbergsbron[mmsi] = {
        ts: baseTime + 60000,
        sog: 0.1, // Very slow - under MIN_KTS (0.2)
        dist: 40, // Very close to bridge
        dir: 'Göteborg',
        vessel_name: 'SLOW BOAT',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.5,
        lastActiveTime: baseTime,
      };

      relevantBoats = await app._findRelevantBoats();
      console.log(`Stage 2 - Very slow (0.1kn) at 40m: ${relevantBoats.length} boats detected`);
      
      if (relevantBoats.length === 0) {
        console.log('❌ PROBLEM: Boat removed despite being only 40m from bridge!');
        console.log('   This boat is probably waiting for bridge opening, not stopped');
      }
      
      // Stage 3: Check if waiting detection works
      const vessel = app._lastSeen.stridsbergsbron[mmsi];
      const isWaiting = app._isWaiting(vessel, 'stridsbergsbron');
      console.log(`Waiting detection result: ${isWaiting}`);
      
      // Test if it's the speed or waiting detection that's the issue
      console.log('\n📋 ANALYSIS:');
      console.log(`- MIN_KTS threshold: 0.2 knots`);
      console.log(`- Boat speed: ${vessel.sog} knots`);
      console.log(`- Distance to bridge: ${vessel.dist}m`);
      console.log(`- Waiting detection: ${isWaiting}`);
      console.log(`- Should be kept: ${vessel.sog >= 0.2 || isWaiting}`);
    });

    test('PROPOSED SOLUTION: Distance-based speed tolerance', async () => {
      console.log('\n=== PROPOSED SOLUTION: Distance-based speed tolerance ===');
      
      function shouldKeepSlowBoat(vessel, bridgeDistance) {
        const CLOSE_DISTANCE = 100; // meters
        const VERY_CLOSE_DISTANCE = 50; // meters
        const MIN_NORMAL_SPEED = 0.2; // knots
        const MIN_CLOSE_SPEED = 0.05; // knots (lower threshold when close)
        
        // Different speed thresholds based on distance
        if (bridgeDistance <= VERY_CLOSE_DISTANCE) {
          return vessel.sog >= MIN_CLOSE_SPEED; // Very lenient when very close
        } else if (bridgeDistance <= CLOSE_DISTANCE) {
          return vessel.sog >= MIN_CLOSE_SPEED; // Lenient when close
        } else {
          return vessel.sog >= MIN_NORMAL_SPEED; // Normal threshold when far
        }
      }
      
      const scenarios = [
        { dist: 30, sog: 0.1, desc: '30m from bridge, 0.1 knots' },
        { dist: 80, sog: 0.1, desc: '80m from bridge, 0.1 knots' },
        { dist: 150, sog: 0.1, desc: '150m from bridge, 0.1 knots' },
        { dist: 40, sog: 0.05, desc: '40m from bridge, 0.05 knots' },
        { dist: 200, sog: 0.05, desc: '200m from bridge, 0.05 knots' },
      ];
      
      scenarios.forEach((scenario, index) => {
        const shouldKeep = shouldKeepSlowBoat(scenario, scenario.dist);
        console.log(`Scenario ${index + 1} - ${scenario.desc}: ${shouldKeep ? 'KEEP' : 'REMOVE'}`);
      });
      
      console.log('\n📋 PROPOSED LOGIC:');
      console.log('- Within 50m: Keep if speed >= 0.05 knots (very lenient)');
      console.log('- Within 100m: Keep if speed >= 0.05 knots (lenient)');
      console.log('- Beyond 100m: Keep if speed >= 0.2 knots (normal)');
    });
  });

  describe('Problem 3: Combined scenarios', () => {
    test('STRESS TEST: Multiple problematic boats simultaneously', async () => {
      const baseTime = Date.now();
      
      console.log('\n=== STRESS TEST: Multiple problematic boats ===');
      
      // Boat 1: Turned around very close to bridge
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron['COMBO_001'] = {
        ts: baseTime,
        sog: 2.1,
        dist: 45, // Very close
        dir: 'Göteborg', // Turned around
        vessel_name: 'CLOSE TURNER',
        mmsi: 'COMBO_001',
        towards: false, // Moving away
        maxRecentSog: 4.2,
        lastActiveTime: baseTime - 30000,
      };

      // Boat 2: Very slow but close to bridge
      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron['COMBO_002'] = {
        ts: baseTime,
        sog: 0.1, // Under MIN_KTS
        dist: 60, // Close to bridge
        dir: 'Vänersborg',
        vessel_name: 'VERY SLOW',
        mmsi: 'COMBO_002',
        towards: true,
        maxRecentSog: 3.1,
        lastActiveTime: baseTime - 60000,
      };

      // Boat 3: Slow and turned around (double problem)
      app._lastSeen.klaffbron['COMBO_003'] = {
        ts: baseTime,
        sog: 0.15, // Under MIN_KTS
        dist: 80, // Close to bridge
        dir: 'Göteborg', // Turned around
        vessel_name: 'SLOW TURNER',
        mmsi: 'COMBO_003',
        towards: false, // Moving away
        maxRecentSog: 2.8,
        lastActiveTime: baseTime - 45000,
      };

      const relevantBoats = await app._findRelevantBoats();
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      
      console.log(`\nSTRESS TEST RESULTS:`);
      console.log(`Total problematic boats: 3`);
      console.log(`Boats detected by current system: ${relevantBoats.length}`);
      console.log(`Bridge text: "${bridgeText}"`);
      
      // Analyze each boat
      const boats = [
        { id: 'COMBO_001', name: 'CLOSE TURNER', issue: 'turned around at 45m' },
        { id: 'COMBO_002', name: 'VERY SLOW', issue: 'speed 0.1kn at 60m' },
        { id: 'COMBO_003', name: 'SLOW TURNER', issue: 'speed 0.15kn + turned around at 80m' },
      ];
      
      boats.forEach((boat, index) => {
        const detected = relevantBoats.some(rb => rb.mmsi === boat.id);
        console.log(`${boat.name} (${boat.issue}): ${detected ? 'DETECTED' : 'MISSED'}`);
      });
      
      console.log('\n📋 EXPECTED IMPROVEMENTS:');
      console.log('- CLOSE TURNER: Should be kept (within 300m protection zone)');
      console.log('- VERY SLOW: Should be kept (distance-based speed tolerance)');
      console.log('- SLOW TURNER: Should be kept (both protections apply)');
    });
  });

  describe('Proposed Implementation', () => {
    test('SOLUTION PREVIEW: Enhanced logic simulation', async () => {
      console.log('\n=== PROPOSED ENHANCED LOGIC ===');
      
      // Simulate enhanced _findRelevantBoats logic
      function enhancedBoatFiltering(vessel, bridgeDistance, bridgeId) {
        const PROTECTION_RADIUS = 300; // meters
        const CLOSE_DISTANCE = 100; // meters
        const VERY_CLOSE_DISTANCE = 50; // meters
        
        // Enhanced speed thresholds
        const MIN_NORMAL_SPEED = 0.2;
        const MIN_CLOSE_SPEED = 0.05;
        
        // Enhanced direction logic
        const isWithinProtectionZone = bridgeDistance <= PROTECTION_RADIUS;
        const isClose = bridgeDistance <= CLOSE_DISTANCE;
        const isVeryClose = bridgeDistance <= VERY_CLOSE_DISTANCE;
        
        // Speed threshold based on distance
        let speedThreshold = MIN_NORMAL_SPEED;
        if (isVeryClose) {
          speedThreshold = MIN_CLOSE_SPEED;
        } else if (isClose) {
          speedThreshold = MIN_CLOSE_SPEED;
        }
        
        // Direction logic with protection zone
        const approachingOK = vessel.towards; // Normal approaching logic
        const turnaroundOK = !vessel.towards && isWithinProtectionZone; // Protected turnaround
        const directionOK = approachingOK || turnaroundOK;
        
        // Speed logic with distance consideration
        const speedOK = vessel.sog >= speedThreshold;
        
        // Waiting logic (existing)
        const waitingOK = vessel.sog < 0.5 && vessel.maxRecentSog > 2.0 && bridgeDistance < 200;
        
        const finalDecision = directionOK && (speedOK || waitingOK);
        
        return {
          decision: finalDecision,
          reason: finalDecision ? 'KEEP' : 'REMOVE',
          factors: {
            direction: directionOK ? 'OK' : 'FAIL',
            speed: speedOK ? 'OK' : 'FAIL',
            waiting: waitingOK ? 'OK' : 'N/A',
            distance: bridgeDistance,
            speedThreshold: speedThreshold,
          }
        };
      }
      
      // Test enhanced logic on problematic scenarios
      const testCases = [
        { 
          name: 'Close Turner',
          vessel: { sog: 2.1, towards: false, maxRecentSog: 4.2 },
          distance: 45,
          expected: 'KEEP'
        },
        { 
          name: 'Very Slow',
          vessel: { sog: 0.1, towards: true, maxRecentSog: 3.1 },
          distance: 60,
          expected: 'KEEP'
        },
        { 
          name: 'Slow Turner',
          vessel: { sog: 0.15, towards: false, maxRecentSog: 2.8 },
          distance: 80,
          expected: 'KEEP'
        },
        { 
          name: 'Clearly Departed',
          vessel: { sog: 3.5, towards: false, maxRecentSog: 3.5 },
          distance: 450,
          expected: 'REMOVE'
        },
      ];
      
      console.log('\nENHANCED LOGIC TEST RESULTS:');
      testCases.forEach((testCase, index) => {
        const result = enhancedBoatFiltering(testCase.vessel, testCase.distance, 'klaffbron');
        const correct = result.decision === (testCase.expected === 'KEEP');
        
        console.log(`\n${index + 1}. ${testCase.name}:`);
        console.log(`   Expected: ${testCase.expected}, Got: ${result.reason} ${correct ? '✅' : '❌'}`);
        console.log(`   Factors: Direction=${result.factors.direction}, Speed=${result.factors.speed}, Waiting=${result.factors.waiting}`);
        console.log(`   Distance: ${result.factors.distance}m, Speed threshold: ${result.factors.speedThreshold}kn`);
      });
    });
  });
});