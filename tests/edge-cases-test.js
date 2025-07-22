'use strict';

/**
 * Edge Cases Test för nya funktioner
 * Testar gränsfall och potentiella buggar identifierade i kodanalysen
 */

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

async function testEdgeCases() {
  console.log('🔬 EDGE CASES TESTING');
  console.log('='.repeat(80));

  const runner = new RealAppTestRunner();

  try {
    await runner.initializeApp();

    // Edge Case 1: COG edge values och undefined
    console.log('\n🧭 EDGE CASE 1: COG Boundary Values');
    console.log('-'.repeat(60));

    await runner.runRealJourney('COG Edge Cases', [
      {
        description: 'COG exakt på gräns (315°) - ska ge Klaffbron',
        vessels: [
          {
            mmsi: '901901901',
            name: 'COG 315 Vessel',
            lat: 58.30,
            lon: 12.30,
            sog: 4.0,
            cog: 315, // Exakt på NORTH_MIN gräns
          },
        ],
      },
      {
        description: 'COG exakt på gräns (45°) - ska ge Klaffbron',
        vessels: [
          {
            mmsi: '902902902',
            name: 'COG 45 Vessel',
            lat: 58.29,
            lon: 12.29,
            sog: 4.0,
            cog: 45, // Exakt på NORTH_MAX gräns
          },
        ],
      },
      {
        description: 'COG undefined - ska inte krascha',
        vessels: [
          {
            mmsi: '903903903',
            name: 'No COG Vessel',
            lat: 58.31,
            lon: 12.31,
            sog: 4.0,
            // cog saknas helt
          },
        ],
      },
      {
        description: 'COG null - ska hanteras gracefully',
        vessels: [
          {
            mmsi: '904904904',
            name: 'Null COG Vessel',
            lat: 58.32,
            lon: 12.32,
            sog: 4.0,
            cog: null,
          },
        ],
      },
    ]);

    // Edge Case 2: Protection Zone gränsfall
    console.log('\n🛡️ EDGE CASE 2: Protection Zone Boundaries');
    console.log('-'.repeat(60));

    await runner.runRealJourney('Protection Zone Edges', [
      {
        description: 'Båt exakt 300m från bro - ska skyddas',
        vessels: [
          {
            mmsi: '905905905',
            name: '300m Exact Vessel',
            lat: 58.2867, // Exakt 300m från Klaffbron
            lon: 12.2867,
            sog: 0.1,
            cog: 180,
          },
        ],
      },
      {
        description: 'Båt 301m från bro - ska INTE skyddas',
        vessels: [
          {
            mmsi: '906906906',
            name: '301m Vessel',
            lat: 58.2866, // Strax över 300m från Klaffbron
            lon: 12.2866,
            sog: 0.1,
            cog: 180,
          },
        ],
      },
    ]);

    // Edge Case 3: Ankrat båt-filter edge cases
    console.log('\n⚓ EDGE CASE 3: Anchored Filter Boundaries');
    console.log('-'.repeat(60));

    await runner.runRealJourney('Anchored Filter Edges', [
      {
        description: 'SOG exakt 0.3kn - gränsvärde',
        vessels: [
          {
            mmsi: '907907907',
            name: 'SOG 0.3 Vessel',
            lat: 58.32,
            lon: 12.32,
            sog: 0.3, // Exakt på gränsen
            cog: 180,
            status: 'en-route',
            targetBridge: 'Stridsbergsbron',
          },
        ],
      },
      {
        description: 'SOG 0.31kn - ska INTE filtreras',
        vessels: [
          {
            mmsi: '908908908',
            name: 'SOG 0.31 Vessel',
            lat: 58.32,
            lon: 12.32,
            sog: 0.31, // Strax över gränsen
            cog: 180,
            status: 'en-route',
            targetBridge: 'Stridsbergsbron',
          },
        ],
      },
      {
        description: 'Båt med waiting status men långsam - ska INTE filtreras',
        vessels: [
          {
            mmsi: '909909909',
            name: 'Waiting Slow Vessel',
            lat: 58.32, // Långt från bro
            lon: 12.32,
            sog: 0.1, // Mycket långsam
            cog: 180,
            status: 'waiting', // Men har waiting status
            targetBridge: 'Stridsbergsbron',
          },
        ],
      },
    ]);

    // Edge Case 4: Passerat sista målbro edge cases
    console.log('\n🏁 EDGE CASE 4: Final Bridge Edge Cases');
    console.log('-'.repeat(60));

    await runner.runRealJourney('Final Bridge Edges', [
      {
        description: 'Båt passerat båda målbroarna - vilken är sista?',
        vessels: [
          {
            mmsi: '910910910',
            name: 'Both Bridges Vessel',
            lat: 58.30,
            lon: 12.30,
            sog: 4.0,
            cog: 0, // Norrut
            status: 'passed',
            targetBridge: 'Stridsbergsbron', // Aktuellt target
            passedBridges: ['Klaffbron', 'Stridsbergsbron'], // Passerat båda
          },
        ],
      },
      {
        description: 'Båt med tom passedBridges array - inte krascha',
        vessels: [
          {
            mmsi: '911911911',
            name: 'Empty Passed Vessel',
            lat: 58.30,
            lon: 12.30,
            sog: 4.0,
            cog: 180,
            status: 'passed',
            targetBridge: 'Klaffbron',
            passedBridges: [], // Tom array
          },
        ],
      },
      {
        description: 'Båt utan passedBridges property - ska hantera gracefully',
        vessels: [
          {
            mmsi: '912912912',
            name: 'No Passed Property Vessel',
            lat: 58.30,
            lon: 12.30,
            sog: 4.0,
            cog: 180,
            status: 'passed',
            targetBridge: 'Klaffbron',
            // passedBridges property saknas helt
          },
        ],
      },
    ]);

    // Edge Case 5: Multiple vessels edge cases
    console.log('\n👥 EDGE CASE 5: Multiple Vessels Edge Cases');
    console.log('-'.repeat(60));

    await runner.runRealJourney('Multiple Vessels Edges', [
      {
        description: 'Många båtar samtidigt - performance & memory',
        vessels: Array.from({ length: 10 }, (_, i) => ({
          mmsi: `${950 + i}${950 + i}${950 + i}`,
          name: `Mass Vessel ${i}`,
          lat: 58.30 + (i * 0.001), // Spridda positioner
          lon: 12.30 + (i * 0.001),
          sog: 3.0 + (i * 0.1),
          cog: 180,
        })),
      },
      {
        description: 'Alla båtar försvinner samtidigt - cleanup stress test',
        vessels: [], // Tom array - alla båtar ska timeout
        delaySeconds: 3,
      },
    ]);

    console.log('\n✅ All edge case tests completed successfully!');

  } catch (error) {
    console.error('❌ Edge case test failed:', error);
    throw error;
  } finally {
    await runner.cleanup();
  }
}

// Kör edge case tester om denna fil körs direkt
if (require.main === module) {
  testEdgeCases()
    .then(() => {
      console.log('\n🎉 All edge case tests completed successfully!');
      throw new Error('Test completed - exit');
    })
    .catch((error) => {
      console.error('\n💥 Edge case test suite failed:', error);
      throw error;
    });
}

module.exports = { testEdgeCases };
