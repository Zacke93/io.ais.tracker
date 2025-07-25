'use strict';

/**
 * Simple Target Bridge Assignment Test
 * Tests that boats get correct target bridges based on COG
 */

const RealAppTestRunner = require('./RealAppTestRunner');

async function targetBridgeTest() {
  console.log('🎯 TARGET BRIDGE ASSIGNMENT TEST');
  console.log('Testing that boats get correct target bridges based on COG');
  console.log('='.repeat(80));

  const runner = new RealAppTestRunner();

  try {
    await runner.initializeApp();

    await runner.runRealJourney('Target Bridge Assignment Test', [
      {
        description: 'Test 1: Båt från norr (COG 180°) ska få Klaffbron som target',
        vessels: [
          {
            mmsi: '111111111',
            name: 'North to South',
            lat: 58.320, // Far north of all bridges
            lon: 12.320,
            sog: 5.0,
            cog: 180, // Southbound -> should get Klaffbron (encounters it first)
          },
        ],
      },
      {
        description: 'Test 2: Båt från söder (COG 0°) ska få Stridsbergsbron som target',
        vessels: [
          {
            mmsi: '222222222',
            name: 'South to North',
            lat: 58.260, // Far south of all bridges
            lon: 12.260,
            sog: 4.0,
            cog: 0, // Northbound -> should get Stridsbergsbron (encounters it first)
          },
        ],
      },
      {
        description: 'Test 3: Båt vid Klaffbron med waiting status (≤300m)',
        vessels: [
          {
            mmsi: '333333333',
            name: 'At Klaffbron',
            lat: 58.284, // At Klaffbron exactly
            lon: 12.284,
            sog: 0.5,
            cog: 180, // Southbound, Klaffbron should be target
          },
        ],
      },
      {
        description: 'Test 4: Båt vid Stridsbergsbron med waiting status (≤300m)',
        vessels: [
          {
            mmsi: '444444444',
            name: 'At Stridsbergsbron',
            lat: 58.294, // At Stridsbergsbron exactly
            lon: 12.295,
            sog: 0.5,
            cog: 0, // Northbound, Stridsbergsbron should be target
          },
        ],
      },
      {
        description: 'Cleanup all boats',
        vessels: [],
        delaySeconds: 1,
      },
    ]);

    console.log('\n✅ Target bridge assignment test completed!');

  } catch (error) {
    console.error('❌ Target bridge assignment test failed:', error);
    throw error;
  } finally {
    await runner.cleanup();
  }
}

// Kör testet om denna fil körs direkt
if (require.main === module) {
  targetBridgeTest()
    .then(() => {
      console.log('\n🎉 Target bridge assignment test completed successfully!');
      throw new Error('Test completed - exit');
    })
    .catch((error) => {
      console.error('\n💥 Target bridge assignment test failed:', error);
      throw error;
    });
}

module.exports = { targetBridgeTest };
