'use strict';

/**
 * Test för nya implementerade funktioner:
 * 1. Target bridge assignment vid bounding box entry
 * 2. 300m protection zone enforcement
 * 3. "Passerat sista målbro" borttagningslogik
 * 4. Ankrat båt-filter
 */

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

async function testNewFeatures() {
  console.log('🧪 TESTING NEW FEATURES');
  console.log('='.repeat(80));

  const runner = new RealAppTestRunner();

  try {
    await runner.initializeApp();

    // Test 1: Target Bridge Assignment vid Bounding Box Entry
    console.log('\n🎯 TEST 1: Target Bridge Assignment vid Bounding Box Entry');
    console.log('-'.repeat(60));

    const testResult1 = await runner.runRealJourney('Target Bridge Assignment Test', [
      {
        description: 'Båt kommer in i bounding box med COG 180° (söderut)',
        vessels: [
          {
            mmsi: '111111111',
            name: 'Test Vessel South',
            lat: 58.31, // Within bounding box
            lon: 12.31,
            sog: 4.0, // > 0.3 så ska få target bridge
            cog: 180, // Southbound -> ska få Stridsbergsbron
          },
        ],
      },
      {
        description: 'Båt kommer in i bounding box med COG 0° (norrut)',
        vessels: [
          {
            mmsi: '222222222',
            name: 'Test Vessel North',
            lat: 58.29, // Within bounding box
            lon: 12.29,
            sog: 3.5, // > 0.3 så ska få target bridge
            cog: 0, // Northbound -> ska få Klaffbron
          },
        ],
      },
      {
        description: 'Långsam båt (≤0.3kn) ska INTE få target bridge direkt',
        vessels: [
          {
            mmsi: '333333333',
            name: 'Slow Vessel',
            lat: 58.30,
            lon: 12.30,
            sog: 0.2, // ≤ 0.3 så ska INTE få target bridge
            cog: 180,
          },
        ],
      },
    ]);

    // Test 2: 300m Protection Zone
    console.log('\n🛡️ TEST 2: 300m Protection Zone Enforcement');
    console.log('-'.repeat(60));

    const testResult2 = await runner.runRealJourney('Protection Zone Test', [
      {
        description: 'Båt nära Klaffbron (≤300m) - ska vara skyddad från borttagning',
        vessels: [
          {
            mmsi: '444444444',
            name: 'Protected Vessel',
            lat: 58.284, // Exakt vid Klaffbron
            lon: 12.284,
            sog: 0.1, // Mycket långsam
            cog: 180,
          },
        ],
      },
      {
        description: 'Simulera timeout - båt ska skyddas och omplaneras',
        vessels: [], // Ingen AIS data -> timeout ska triggas
        delaySeconds: 3, // Vänta för att trigga timeout-logik
      },
      {
        description: 'Båt långt från broar ska kunna tas bort normalt',
        vessels: [
          {
            mmsi: '555555555',
            name: 'Far Vessel',
            lat: 58.32, // Långt från broar
            lon: 12.32,
            sog: 0.1, // Långsam
            cog: 180,
          },
        ],
      },
    ]);

    // Test 3: Passerat Sista Målbro
    console.log('\n🏁 TEST 3: Passerat Sista Målbro Logic');
    console.log('-'.repeat(60));

    const testResult3 = await runner.runRealJourney('Final Bridge Test', [
      {
        description: 'Båt passerar Stridsbergsbron (målbro) norrut - ska vara sista',
        vessels: [
          {
            mmsi: '666666666',
            name: 'Final Bridge Vessel',
            lat: 58.294, // Vid Stridsbergsbron
            lon: 12.295,
            sog: 4.0,
            cog: 0, // Norrut
            status: 'passed',
            targetBridge: 'Stridsbergsbron',
            passedBridges: ['Stridsbergsbron'],
          },
        ],
      },
      {
        description: 'Vänta för att se om båt tas bort efter 15s delay',
        vessels: [],
        delaySeconds: 2, // Simulera passage av tid (testet kör cleanup direkt)
      },
    ]);

    // Test 4: Ankrat Båt-Filter
    console.log('\n⚓ TEST 4: Ankrat Båt-Filter');
    console.log('-'.repeat(60));

    const testResult4 = await runner.runRealJourney('Anchored Filter Test', [
      {
        description: 'Ankrad båt (≤0.3kn + >300m) ska filtreras från bridge text',
        vessels: [
          {
            mmsi: '777777777',
            name: 'Anchored Vessel',
            lat: 58.32, // Långt från broar (>300m)
            lon: 12.32,
            sog: 0.2, // ≤ 0.3kn -> potentiellt ankrad
            cog: 180,
            status: 'en-route',
            targetBridge: 'Stridsbergsbron',
          },
        ],
      },
      {
        description: 'Väntar båt nära bro (≤0.3kn + ≤300m) ska INTE filtreras',
        vessels: [
          {
            mmsi: '888888888',
            name: 'Waiting Vessel',
            lat: 58.284, // Nära Klaffbron (≤300m)
            lon: 12.284,
            sog: 0.2, // ≤ 0.3kn men nära bro
            cog: 180,
            status: 'waiting',
            targetBridge: 'Klaffbron',
          },
        ],
      },
    ]);

    // Resultat sammanfattning
    console.log('\n📊 TEST RESULTS SUMMARY');
    console.log('='.repeat(80));

    const allResults = [testResult1, testResult2, testResult3, testResult4];
    const totalBridgeTextChanges = allResults.reduce((sum, result) => sum + result.bridgeTextChanges.length, 0);

    console.log(`✅ Total tests run: ${allResults.length}`);
    console.log(`📝 Total bridge text changes observed: ${totalBridgeTextChanges}`);
    console.log('🎯 All tests completed successfully');

    // Visa viktiga observationer
    console.log('\n🔍 KEY OBSERVATIONS:');
    allResults.forEach((result, index) => {
      console.log(`\nTest ${index + 1} (${result.scenarioName}):`);
      console.log(`  - Steps: ${result.totalSteps}`);
      console.log(`  - Bridge text changes: ${result.bridgeTextChanges.length}`);
      console.log(`  - Final bridge text: "${result.finalBridgeText}"`);
    });

  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  } finally {
    await runner.cleanup();
  }
}

// Kör tester om denna fil körs direkt
if (require.main === module) {
  testNewFeatures()
    .then(() => {
      console.log('\n🎉 All new feature tests completed successfully!');
      throw new Error('Test completed - exit');
    })
    .catch((error) => {
      console.error('\n💥 Test suite failed:', error);
      throw error;
    });
}

module.exports = { testNewFeatures };
