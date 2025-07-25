'use strict';

/**
 * Complex Multi-Vessel Journey Test
 * Tests 4 boats approaching both target bridges (Klaffbron & Stridsbergsbron)
 * with different speeds, statuses, and interactions
 */

const RealAppTestRunner = require('./RealAppTestRunner');

async function complexMultiVesselJourney() {
  console.log('🚢 COMPLEX MULTI-VESSEL JOURNEY TEST');
  console.log('Testing 4 boats approaching both target bridges with various scenarios');
  console.log('='.repeat(80));

  const runner = new RealAppTestRunner();

  try {
    await runner.initializeApp();

    await runner.runRealJourney('Complex Multi-Vessel Scenario', [
      {
        description: 'Initial: 4 båtar från olika håll närmar sig båda målbroarna',
        vessels: [
          {
            mmsi: '111111111',
            name: 'Northern Express',
            lat: 58.310, // North of Stridsbergsbron, heading south
            lon: 12.310,
            sog: 6.5, // Fast vessel
            cog: 180, // Southbound -> should get Klaffbron as target (encounters it first)
          },
          {
            mmsi: '222222222',
            name: 'Southern Cruiser',
            lat: 58.270, // South of Klaffbron, heading north
            lon: 12.270,
            sog: 4.2, // Medium speed
            cog: 0, // Northbound -> should get Stridsbergsbron as target (encounters it first)
          },
          {
            mmsi: '333333333',
            name: 'Swift Cargo',
            lat: 58.315, // Far north, heading south
            lon: 12.315,
            sog: 8.1, // Very fast
            cog: 180, // Southbound -> should get Klaffbron as target (encounters it first)
          },
          {
            mmsi: '444444444',
            name: 'Leisure Yacht',
            lat: 58.265, // Far south, heading north
            lon: 12.265,
            sog: 2.8, // Slow vessel
            cog: 0, // Northbound -> should get Stridsbergsbron as target (encounters it first)
          },
        ],
      },
      {
        description: 'Scenario: Swift Cargo når Klaffbron först (≤300m), Southern Cruiser när Stridsbergsbron',
        vessels: [
          {
            mmsi: '111111111',
            name: 'Northern Express',
            lat: 58.300, // Approaching Klaffbron from north
            lon: 12.300,
            sog: 6.5,
            cog: 180,
          },
          {
            mmsi: '222222222',
            name: 'Southern Cruiser',
            lat: 58.2925, // At Stridsbergsbron (≤300m) - should trigger "inväntar broöppning"
            lon: 12.2935,
            sog: 1.2, // Slowing down
            cog: 0,
          },
          {
            mmsi: '333333333',
            name: 'Swift Cargo',
            lat: 58.2835, // At Klaffbron (≤300m) - should trigger "inväntar broöppning"
            lon: 12.2835,
            sog: 0.5, // Slowing down
            cog: 180,
          },
          {
            mmsi: '444444444',
            name: 'Leisure Yacht',
            lat: 58.280, // Still approaching Stridsbergsbron
            lon: 12.280,
            sog: 2.8,
            cog: 0,
          },
        ],
      },
      {
        description: 'Scenario: Southern Cruiser når också sitt målområde vid Klaffbron (≤300m)',
        vessels: [
          {
            mmsi: '111111111',
            name: 'Northern Express',
            lat: 58.295, // Getting very close to Stridsbergsbron
            lon: 12.296,
            sog: 6.5,
            cog: 180,
          },
          {
            mmsi: '222222222',
            name: 'Southern Cruiser',
            lat: 58.2835, // At Klaffbron (≤300m) - should trigger "inväntar broöppning"
            lon: 12.2835,
            sog: 1.2, // Slowing down
            cog: 0,
          },
          {
            mmsi: '333333333',
            name: 'Swift Cargo',
            lat: 58.2935, // Still waiting at Stridsbergsbron
            lon: 12.2945,
            sog: 0.2, // Almost stopped
            cog: 180,
          },
          {
            mmsi: '444444444',
            name: 'Leisure Yacht',
            lat: 58.283, // Approaching Klaffbron
            lon: 12.283,
            sog: 2.8,
            cog: 0,
          },
        ],
      },
      {
        description: 'Scenario: Swift Cargo passerar under Stridsbergsbron (≤50m) - "Broöppning pågår"',
        vessels: [
          {
            mmsi: '111111111',
            name: 'Northern Express',
            lat: 58.2938, // Very close to Stridsbergsbron, might also trigger waiting
            lon: 12.2948,
            sog: 2.1, // Slowing down as it approaches
            cog: 180,
          },
          {
            mmsi: '222222222',
            name: 'Southern Cruiser',
            lat: 58.2835, // Still waiting at Klaffbron
            lon: 12.2835,
            sog: 0.8,
            cog: 0,
          },
          {
            mmsi: '333333333',
            name: 'Swift Cargo',
            lat: 58.2932, // Under Stridsbergsbron (≤50m) - should trigger "Broöppning pågår"
            lon: 12.2942,
            sog: 3.5, // Moving through bridge opening
            cog: 180,
          },
          {
            mmsi: '444444444',
            name: 'Leisure Yacht',
            lat: 58.2838, // Also getting close to Klaffbron
            lon: 12.2838,
            sog: 2.8,
            cog: 0,
          },
        ],
      },
      {
        description: 'Scenario: Swift Cargo precis passerat, 3 båtar väntar vid båda broarna',
        vessels: [
          {
            mmsi: '111111111',
            name: 'Northern Express',
            lat: 58.2935, // Now at Stridsbergsbron waiting area
            lon: 12.2945,
            sog: 0.3, // Waiting for bridge opening
            cog: 180,
          },
          {
            mmsi: '222222222',
            name: 'Southern Cruiser',
            lat: 58.2838, // Still at Klaffbron
            lon: 12.2838,
            sog: 0.5,
            cog: 0,
          },
          {
            mmsi: '333333333',
            name: 'Swift Cargo',
            lat: 58.2915, // Just passed Stridsbergsbron - should show "precis passerat" (highest priority)
            lon: 12.2925,
            sog: 4.2, // Continuing journey
            cog: 180,
          },
          {
            mmsi: '444444444',
            name: 'Leisure Yacht',
            lat: 58.2835, // Now also at Klaffbron waiting area
            lon: 12.2835,
            sog: 1.1,
            cog: 0,
          },
        ],
      },
      {
        description: 'Scenario: Southern Cruiser passerar under Klaffbron, andra båtar fortsätter vänta',
        vessels: [
          {
            mmsi: '111111111',
            name: 'Northern Express',
            lat: 58.2932, // Under Stridsbergsbron now
            lon: 12.2942,
            sog: 3.8, // Moving through
            cog: 180,
          },
          {
            mmsi: '222222222',
            name: 'Southern Cruiser',
            lat: 58.2842, // Under Klaffbron (≤50m)
            lon: 12.2842,
            sog: 4.1, // Moving through bridge opening
            cog: 0,
          },
          {
            mmsi: '333333333',
            name: 'Swift Cargo',
            lat: 58.288, // Continuing south after passing Stridsbergsbron
            lon: 12.288,
            sog: 5.5,
            cog: 180,
          },
          {
            mmsi: '444444444',
            name: 'Leisure Yacht',
            lat: 58.2838, // Still waiting at Klaffbron
            lon: 12.2838,
            sog: 0.8,
            cog: 0,
          },
        ],
      },
      {
        description: 'Final: Båtar har passerat, några fortsätter mot nästa målbro',
        vessels: [
          {
            mmsi: '111111111',
            name: 'Northern Express',
            lat: 58.288, // Passed Stridsbergsbron, heading toward Klaffbron (next target)
            lon: 12.288,
            sog: 6.2,
            cog: 180,
          },
          {
            mmsi: '222222222',
            name: 'Southern Cruiser',
            lat: 58.290, // Passed Klaffbron, heading toward Stridsbergsbron (next target)
            lon: 12.290,
            sog: 4.5,
            cog: 0,
          },
          {
            mmsi: '333333333',
            name: 'Swift Cargo',
            lat: 58.280, // Continuing south toward Klaffbron (next target)
            lon: 12.280,
            sog: 7.1,
            cog: 180,
          },
          {
            mmsi: '444444444',
            name: 'Leisure Yacht',
            lat: 58.287, // Just passed Klaffbron
            lon: 12.287,
            sog: 3.2,
            cog: 0,
          },
        ],
      },
      {
        description: 'Cleanup: Alla båtar lämnar området',
        vessels: [], // Empty array triggers cleanup
        delaySeconds: 2,
      },
    ]);

    console.log('\n✅ Complex multi-vessel journey completed successfully!');

  } catch (error) {
    console.error('❌ Complex multi-vessel journey failed:', error);
    throw error;
  } finally {
    await runner.cleanup();
  }
}

// Kör testet om denna fil körs direkt
if (require.main === module) {
  complexMultiVesselJourney()
    .then(() => {
      console.log('\n🎉 Complex multi-vessel journey test completed successfully!');
      throw new Error('Test completed - exit');
    })
    .catch((error) => {
      console.error('\n💥 Complex multi-vessel journey test failed:', error);
      throw error;
    });
}

module.exports = { complexMultiVesselJourney };
