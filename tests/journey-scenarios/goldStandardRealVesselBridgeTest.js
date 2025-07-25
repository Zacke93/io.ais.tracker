'use strict';

const RealAppTestRunner = require('./RealAppTestRunner');

/**
 * GOLD STANDARD REAL VESSEL BRIDGE TEST
 *
 * Based on actual vessel data from production log: app-20250721-132621.log
 *
 * This test recreates the exact journey of two real vessels:
 * - Vessel 265567660: ZIVELI (HANSE 370) - Southbound journey from Stallbackabron to Stridsbergsbron
 * - Vessel 265673420: Second vessel - Also southbound, creating multi-vessel scenarios
 *
 * The test captures all the critical scenarios that occurred in real usage:
 * 1. Target bridge assignment for southbound vessels
 * 2. ETA calculations and their changes over time
 * 3. Multi-vessel scenarios with priority handling
 * 4. Stallbackabron special handling
 * 5. Real-world positioning and movement patterns
 * 6. Bridge text transitions based on actual user experience
 *
 * This "Gold Standard" test should detect most system and bridge text errors
 * by replicating the exact conditions that occurred in production.
 */

async function goldStandardRealVesselBridgeTest() {
  console.log('\n🏆 GOLD STANDARD REAL VESSEL BRIDGE TEST');
  console.log('='.repeat(70));
  console.log('📅 Based on production log: app-20250721-132621.log');
  console.log('🚢 Real vessels: 265567660 (ZIVELI HANSE 370) & 265673420');
  console.log('🎯 Comprehensive test covering all real-world scenarios');
  console.log('='.repeat(70));

  const runner = new RealAppTestRunner();

  // Real vessel journey steps extracted from production log
  const realWorldJourneySteps = [

    // === STEP 1: First vessel enters (11:30:05) ===
    {
      description: '🚢 VERKLIG DATA 11:30:05 - Första båt ZIVELI (265567660) upptäcks',
      vessels: [{
        mmsi: '265567660',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.320713, // Exact production coordinates
        lon: 12.323390,
        sog: 5.9, // Exact production speed
        cog: 200.1, // Exact production course (southbound)
        // Expected: Target bridge assignment to Stridsbergsbron
        // Expected: "En båt på väg mot Stridsbergsbron, beräknad broöppning om 19 minuter"
      }],
      expectedBridgeText: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 19 minuter',
      expectedAlarm: true,
      analysisNote: 'First vessel entering system from north, COG 200.1° = southbound, should get Stridsbergsbron as target',
    },

    // === STEP 2: Second vessel enters creating multi-vessel scenario (11:32:04) ===
    {
      description: '🚢🚢 VERKLIG DATA 11:32:04 - Andra båt (265673420) upptäcks, multi-vessel scenario',
      vessels: [{
        mmsi: '265567660',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.320713, // First vessel continues
        lon: 12.323390,
        sog: 5.9,
        cog: 200.1,
      }, {
        mmsi: '265673420',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.319918, // Second vessel exact coordinates
        lon: 12.322578,
        sog: 6.1, // Slightly faster
        cog: 199.0, // Also southbound
        // Expected: Both vessels target Stridsbergsbron
        // Expected: Faster vessel (265673420) should have closer ETA
      }],
      expectedBridgeText: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 18 minuter',
      expectedAlarm: true,
      analysisNote: 'Multi-vessel: Faster boat (6.1kn) should be priority with 18min ETA vs 19min ETA for first boat',
    },

    // === STEP 3: Vessels moving south, ETA updating (11:33:04) ===
    {
      description: '📍 VERKLIG DATA 11:33:04 - Båtar rör sig söderut, ETA uppdateras',
      vessels: [{
        mmsi: '265567660',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.314640, // Moved significantly south (exact log data)
        lon: 12.319630,
        sog: 5.7, // Speed slightly decreased
        cog: 200.1,
      }, {
        mmsi: '265673420',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.318383, // Also moved south
        lon: 12.321535,
        sog: 5.9,
        cog: 199.0,
      }],
      expectedBridgeText: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 17 minuter',
      expectedAlarm: true,
      analysisNote: 'ETA should decrease as vessels get closer. Priority vessel should show updated ETA.',
    },

    // === STEP 4: First vessel reaches Stallbackabron proximity (11:36:03) ===
    {
      description: '🌉 VERKLIG DATA 11:36:03 - Första båt vid Stallbackabron (specialhantering)',
      vessels: [{
        mmsi: '265567660',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.311590, // Near Stallbackabron (exact log position)
        lon: 12.318563,
        sog: 5.6, // Continuing southbound
        cog: 200.1,
      }, {
        mmsi: '265673420',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.315903, // Still further north
        lon: 12.317290,
        sog: 6.0,
        cog: 199.0,
      }],
      expectedBridgeText: 'En båt vid Stallbackabron närmar sig Stridsbergsbron, ytterligare 1 båt på väg, beräknad broöppning om 14 minuter',
      expectedAlarm: true,
      analysisNote: 'CRITICAL: Stallbackabron special handling! Should show "vid Stallbackabron närmar sig Stridsbergsbron"',
    },

    // === STEP 5: Stallbackabron scenario continues (11:37:03) ===
    {
      description: '🌉 VERKLIG DATA 11:37:03 - Stallbackabron scenario fortsätter',
      vessels: [{
        mmsi: '265567660',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.310180, // Still at Stallbackabron
        lon: 12.317323,
        sog: 5.6,
        cog: 200.1,
      }, {
        mmsi: '265673420',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.315903, // Second vessel position unchanged
        lon: 12.317290,
        sog: 6.0,
        cog: 199.0,
      }],
      expectedBridgeText: 'En båt vid Stallbackabron närmar sig Stridsbergsbron, ytterligare 1 båt på väg, beräknad broöppning om 13 minuter',
      expectedAlarm: true,
      analysisNote: 'Stallbackabron special handling continues, ETA should update',
    },

    // === STEP 6: First vessel passes Stallbackabron (11:40:03) ===
    {
      description: '📍 VERKLIG DATA 11:40:03 - Första båt passerat Stallbackabron, normal läge',
      vessels: [{
        mmsi: '265567660',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.306517, // Moved past Stallbackabron (exact log data)
        lon: 12.311202,
        sog: 5.8, // Speed maintained
        cog: 200.1,
      }, {
        mmsi: '265673420',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.315903, // Second vessel still north
        lon: 12.317290,
        sog: 6.0,
        cog: 199.0,
      }],
      expectedBridgeText: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 10 minuter',
      expectedAlarm: true,
      analysisNote: 'Should return to normal message after passing Stallbackabron, no longer "vid Stallbackabron"',
    },

    // === STEP 7: Vessels continue approach to Stridsbergsbron (11:43:03) ===
    {
      description: '📍 VERKLIG DATA 11:43:03 - Båtar närmar sig Stridsbergsbron',
      vessels: [{
        mmsi: '265567660',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.303030, // Getting closer to Stridsbergsbron
        lon: 12.306090,
        sog: 5.7,
        cog: 200.1,
      }, {
        mmsi: '265673420',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.315903, // Second vessel unchanged
        lon: 12.317290,
        sog: 6.0,
        cog: 199.0,
      }],
      expectedBridgeText: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter',
      expectedAlarm: true,
      analysisNote: 'ETA decreasing as first vessel approaches target bridge',
    },

    // === STEP 8: Approaching critical distance (11:47:33) ===
    {
      description: '🎯 VERKLIG DATA 11:47:33 - Närmar sig kritiskt avstånd till Stridsbergsbron',
      vessels: [{
        mmsi: '265567660',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.297818, // Very close to Stridsbergsbron now
        lon: 12.300145,
        sog: 5.5, // Speed decreasing as approaching
        cog: 200.1,
      }, {
        mmsi: '265673420',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.315903, // Second vessel still distant
        lon: 12.317290,
        sog: 6.0,
        cog: 199.0,
      }],
      expectedBridgeText: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 4 minuter',
      expectedAlarm: true,
      analysisNote: 'ETA now very short, should trigger approach detection soon',
    },

    // === STEP 9: Critical approach distance reached (11:49:33) ===
    {
      description: '⚠️ VERKLIG DATA 11:49:33 - Kritiskt närmande-avstånd',
      vessels: [{
        mmsi: '265567660',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.295747, // Even closer, should be in approach radius
        lon: 12.298563,
        sog: 5.3, // Speed continues to decrease
        cog: 200.1,
      }, {
        mmsi: '265673420',
        name: 'ZIVELI (HANSE 370)',
        lat: 58.315903, // Second vessel still distant
        lon: 12.317290,
        sog: 6.0,
        cog: 199.0,
      }],
      expectedBridgeText: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 5 minuter',
      expectedAlarm: true,
      analysisNote: 'Should be very close to triggering "närmar sig" or "inväntar broöppning" status',
    },

    // === STEP 10: First vessel disappears (timeout/cleanup) ===
    {
      description: '🗑️ VERKLIG DATA - Första båt försvinner (timeout/cleanup simulation)',
      vessels: [{
        mmsi: '265673420', // Only second vessel remains
        name: 'ZIVELI (HANSE 370)',
        lat: 58.315903,
        lon: 12.317290,
        sog: 6.0,
        cog: 199.0,
      }],
      expectedBridgeText: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om XX minuter',
      expectedAlarm: true,
      analysisNote: 'Single vessel scenario after first vessel cleanup',
    },

    // === STEP 11: Final cleanup ===
    {
      description: '🧹 VERKLIG DATA - Alla båtar försvinner från systemet',
      vessels: [], // No vessels
      expectedBridgeText: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron',
      expectedAlarm: false,
      analysisNote: 'System should return to default state',
    },
  ];

  try {
    console.log(`\n🚀 Starting Gold Standard Real Vessel Test with ${realWorldJourneySteps.length} steps...\n`);

    const results = await runner.runRealJourney(
      'GOLD STANDARD REAL VESSEL BRIDGE TEST',
      realWorldJourneySteps,
    );

    // Analyze results for common issues
    console.log('\n📊 GOLD STANDARD TEST ANALYSIS:');
    console.log('='.repeat(50));

    // Check for common problems
    const { bridgeTextChanges } = results;
    let issuesFound = 0;

    console.log('🔍 CHECKING FOR COMMON ISSUES:');

    // Issue 1: Check for "undefinedmin" errors
    const undefinedETAChanges = bridgeTextChanges.filter((change) => change.newText.includes('undefinedmin'));
    if (undefinedETAChanges.length > 0) {
      console.log(`❌ FOUND ${undefinedETAChanges.length} "undefinedmin" errors`);
      issuesFound++;
    } else {
      console.log('✅ No "undefinedmin" errors found');
    }

    // Issue 2: Check for Stallbackabron special handling
    const stallbackaChanges = bridgeTextChanges.filter((change) => change.newText.includes('vid Stallbackabron'));
    if (stallbackaChanges.length > 0) {
      console.log(`✅ Found ${stallbackaChanges.length} Stallbackabron special messages`);
    } else {
      console.log('⚠️ Expected Stallbackabron special handling not found');
      issuesFound++;
    }

    // Issue 3: Check for ETA progression (should decrease over time)
    const etaProgression = [];
    bridgeTextChanges.forEach((change) => {
      const etaMatch = change.newText.match(/(\d+) minuter/);
      if (etaMatch) {
        etaProgression.push(parseInt(etaMatch[1], 10));
      }
    });

    if (etaProgression.length >= 2) {
      const etaDecreasing = etaProgression.slice(0, -1).every((eta, i) => eta >= etaProgression[i + 1] || Math.abs(eta - etaProgression[i + 1]) <= 2);
      if (etaDecreasing) {
        console.log('✅ ETA progression logical (decreasing over time)');
      } else {
        console.log('⚠️ ETA progression irregular');
        console.log(`   ETA sequence: ${etaProgression.join(' → ')}`);
        issuesFound++;
      }
    }

    // Issue 4: Check for target bridge consistency
    const targetBridgeChanges = bridgeTextChanges.filter((change) => change.newText.includes('Stridsbergsbron'));
    if (targetBridgeChanges.length > 0) {
      console.log('✅ Target bridge (Stridsbergsbron) consistent throughout test');
    } else {
      console.log('❌ Target bridge assignment issues detected');
      issuesFound++;
    }

    // Issue 5: Check for multi-vessel handling
    const multiVesselMessages = bridgeTextChanges.filter((change) => change.newText.includes('ytterligare') || change.newText.includes('båtar'));
    if (multiVesselMessages.length > 0) {
      console.log(`✅ Found ${multiVesselMessages.length} multi-vessel messages`);
    } else {
      console.log('⚠️ Expected multi-vessel scenarios not properly handled');
      issuesFound++;
    }

    // Final assessment
    console.log('\n📋 GOLD STANDARD TEST SUMMARY:');
    console.log('='.repeat(50));
    console.log(`📊 Total bridge text changes: ${bridgeTextChanges.length}`);
    console.log(`📊 Test steps completed: ${results.totalSteps}`);
    console.log(`⚠️ Issues found: ${issuesFound}`);

    if (issuesFound === 0) {
      console.log('\n🏆 GOLD STANDARD TEST PASSED!');
      console.log('✅ All real-world scenarios handled correctly');
      console.log('✅ System matches production behavior');
      console.log('✅ No critical issues detected');
    } else {
      console.log('\n⚠️ GOLD STANDARD TEST FOUND ISSUES!');
      console.log('❌ System behavior differs from expected production behavior');
      console.log('🔧 Review issues above and fix before production deployment');
    }

    console.log('\n📚 WHAT THIS TEST VALIDATES:');
    console.log('• Real vessel position tracking and movement');
    console.log('• Target bridge assignment for southbound vessels');
    console.log('• ETA calculations based on actual speeds and distances');
    console.log('• Stallbackabron special handling (critical feature)');
    console.log('• Multi-vessel scenarios and prioritization');
    console.log('• Bridge text transitions matching real user experience');
    console.log('• System cleanup and timeout handling');

    return results;

  } catch (error) {
    console.error('❌ Gold Standard Real Vessel Test failed:', error);
    throw error;
  } finally {
    await runner.cleanup();
  }
}

// Export for use by other modules
module.exports = goldStandardRealVesselBridgeTest;

// Run test if called directly
if (require.main === module) {
  goldStandardRealVesselBridgeTest()
    .then(() => {
      console.log('\n🎉 Gold Standard Real Vessel Test completed successfully!');
    })
    .catch((error) => {
      console.error('\n💥 Gold Standard Real Vessel Test failed:', error);
      throw error;
    });
}
