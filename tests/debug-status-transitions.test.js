'use strict';

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

describe('🔍 DEBUG Status Transitions', () => {
  let runner;

  beforeAll(async () => {
    runner = new RealAppTestRunner();
    await runner.initializeApp();
  });

  afterAll(async () => {
    if (runner) {
      await runner.cleanup();
    }
  });

  test('Debug status detection at different distances', async () => {
    console.log('\n🔍 DEBUG STATUS TRANSITIONS');
    console.log('================================================================================');
    console.log('Expected: >500m=en-route, 300-500m=approaching, <300m=waiting, <50m=under-bridge');
    console.log('================================================================================\n');

    // Test different distances from Klaffbron
    const testPositions = [
      {
        distance: '600m', lat: 58.2785, lon: 12.2775, expected: 'en-route',
      },
      {
        distance: '450m', lat: 58.2805, lon: 12.2795, expected: 'approaching',
      },
      {
        distance: '350m', lat: 58.2815, lon: 12.2805, expected: 'approaching',
      },
      {
        distance: '250m', lat: 58.2825, lon: 12.2815, expected: 'waiting',
      },
      {
        distance: '150m', lat: 58.2835, lon: 12.2825, expected: 'waiting',
      },
      {
        distance: '40m', lat: 58.2841, lon: 12.2833, expected: 'under-bridge',
      },
    ];

    for (let i = 0; i < testPositions.length; i++) {
      const pos = testPositions[i];

      console.log(`\n📍 TEST ${i + 1}: ${pos.distance} from Klaffbron (expected: ${pos.expected})`);
      console.log('--------------------------------------------------');

      // Clear any existing vessel
      if (i > 0) {
        runner.app.vesselDataService.removeVessel(999999);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      await runner._processVesselAsAISMessage({
        mmsi: 999999,
        name: 'Debug Vessel',
        lat: pos.lat,
        lon: pos.lon,
        speed: 5.0,
        cog: 25,
        timestamp: Date.now(),
      });

      const vessels = runner.app.vesselDataService.getAllVessels();
      const vessel = vessels.find((v) => v.mmsi === 999999);

      if (vessel) {
        console.log(`   🚢 Vessel Status: ${vessel.status}`);
        console.log(`   🎯 Target Bridge: ${vessel.targetBridge || 'none'}`);
        console.log(`   🌉 Current Bridge: ${vessel.currentBridge || 'none'}`);
        console.log(`   📏 Distance: ${vessel.distanceToTarget ? `${Math.round(vessel.distanceToTarget)}m` : 'unknown'}`);

        if (vessel.status !== pos.expected) {
          console.log(`   ❌ MISMATCH: Expected ${pos.expected}, got ${vessel.status}`);
        } else {
          console.log(`   ✅ CORRECT: Status matches expected ${pos.expected}`);
        }
      } else {
        console.log('   ❌ ERROR: No vessel found after processing');
      }

      const bridgeText = runner.app._lastBridgeText || 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
      console.log(`   📢 Bridge Text: "${bridgeText}"`);

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Test Stallbackabron special case
    console.log('\n📍 SPECIAL TEST: Stallbackabron at 250m (expected: stallbacka-waiting)');
    console.log('--------------------------------------------------');

    runner.app.vesselDataService.removeVessel(999999);
    await new Promise((resolve) => setTimeout(resolve, 500));

    await runner._processVesselAsAISMessage({
      mmsi: 999998,
      name: 'Stallbacka Debug Vessel',
      lat: 58.3225, // ~250m from Stallbackabron
      lon: 12.3275,
      speed: 5.0,
      cog: 25, // Southbound toward Stridsbergsbron
      timestamp: Date.now(),
    });

    const stallbackaVessels = runner.app.vesselDataService.getAllVessels();
    const stallbackaVessel = stallbackaVessels.find((v) => v.mmsi === 999998);

    if (stallbackaVessel) {
      console.log(`   🚢 Vessel Status: ${stallbackaVessel.status}`);
      console.log(`   🎯 Target Bridge: ${stallbackaVessel.targetBridge || 'none'}`);
      console.log(`   🌉 Current Bridge: ${stallbackaVessel.currentBridge || 'none'}`);

      if (stallbackaVessel.status === 'stallbacka-waiting') {
        console.log('   ✅ CORRECT: Stallbackabron special status detected');
      } else {
        console.log(`   ❌ WRONG: Expected stallbacka-waiting, got ${stallbackaVessel.status}`);
      }
    }

    const stallbackaBridgeText = runner.app._lastBridgeText || 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
    console.log(`   📢 Bridge Text: "${stallbackaBridgeText}"`);

    console.log('\n✅ DEBUG TEST COMPLETED');

  }, 60000);
});
