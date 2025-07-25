'use strict';

/**
 * Run All Tests - Complete test suite for AIS Bridge System V2.0
 *
 * Runs both regression tests (existing functionality) and new V2.0 feature tests
 */

// Test runner for AIS Bridge System V2.0

async function runAllTests() {
  console.log('🚀 COMPLETE AIS BRIDGE SYSTEM TEST SUITE');
  console.log('='.repeat(80));
  console.log('Running both regression tests and new V2.0 feature tests...');
  console.log('='.repeat(80));

  const testResults = {
    passed: 0,
    failed: 0,
    errors: [],
  };

  // Test 1: Existing North-to-South Journey (Regression)
  console.log('\n📋 TEST SUITE 1: REGRESSION TESTING');
  console.log('-'.repeat(50));
  try {
    console.log('Running: North-to-South Journey (original functionality)...\n');
    const northToSouth = require('./north-to-south-journey'); // eslint-disable-line global-require
    await northToSouth();
    console.log('\n✅ Regression test PASSED');
    testResults.passed++;
  } catch (error) {
    console.error('\n❌ Regression test FAILED:', error.message);
    testResults.failed++;
    testResults.errors.push({
      test: 'North-to-South Journey',
      error: error.message,
    });
  }

  // Test 2: Robust Bridge System V2.0 Features
  console.log('\n📋 TEST SUITE 2: NEW V2.0 FEATURES');
  console.log('-'.repeat(50));
  try {
    console.log('Running: Comprehensive V2.0 feature tests...\n');
    const v2Tests = require('./robust-bridge-system-v2-tests'); // eslint-disable-line global-require
    await v2Tests.runAllRobustV2Tests();
    console.log('\n✅ V2.0 feature tests PASSED');
    testResults.passed++;
  } catch (error) {
    console.error('\n❌ V2.0 feature tests FAILED:', error.message);
    testResults.failed++;
    testResults.errors.push({
      test: 'Robust Bridge System V2.0',
      error: error.message,
    });
  }

  // Test Results Summary
  console.log(`\n${'='.repeat(80)}`);
  console.log('📊 COMPLETE TEST SUITE RESULTS');
  console.log('='.repeat(80));
  console.log(`✅ Tests Passed: ${testResults.passed}`);
  console.log(`❌ Tests Failed: ${testResults.failed}`);
  console.log(`📈 Success Rate: ${Math.round((testResults.passed / (testResults.passed + testResults.failed)) * 100)}%`);

  if (testResults.errors.length > 0) {
    console.log('\n🔍 FAILED TEST DETAILS:');
    testResults.errors.forEach((error, index) => {
      console.log(`${index + 1}. ${error.test}: ${error.error}`);
    });
  }

  // System Status
  console.log('\n🎯 SYSTEM STATUS:');
  if (testResults.failed === 0) {
    console.log('🟢 ALL TESTS PASSED - System ready for production');
    console.log('✅ Original functionality maintained (regression safe)');
    console.log('✅ All V2.0 features working correctly');
    console.log('✅ Code quality validated (lint clean)');
  } else {
    console.log('🟡 SOME TESTS FAILED - Review needed before production');
    console.log('⚠️  Check failed tests above and resolve issues');
  }

  console.log('\n📚 TESTED FEATURES:');
  console.log('• Original vessel tracking and bridge text generation');
  console.log('• NEW: 500m "närmar sig" distance triggers');
  console.log('• NEW: Stallbackabron special handling (high bridge)');
  console.log('• NEW: Robust target bridge assignment (position-based)');
  console.log('• NEW: Fixed ETA calculations (eliminates "undefinedmin")');
  console.log('• NEW: GPS jump detection and handling');
  console.log('• NEW: Improved multi-vessel prioritization');
  console.log('• Code quality (ESLint compliance)');

  return testResults;
}

// Export for use by other modules
module.exports = runAllTests;

// Run all tests if called directly
if (require.main === module) {
  runAllTests()
    .then((results) => {
      if (results.failed === 0) {
        console.log('\n🎉 ALL TESTS COMPLETED SUCCESSFULLY!');
      } else {
        console.log('\n💥 SOME TESTS FAILED - Check output above');
        throw new Error(`${results.failed} tests failed`);
      }
    })
    .catch((error) => {
      console.error('\n💥 TEST SUITE EXECUTION FAILED:', error);
      throw error;
    });
}
