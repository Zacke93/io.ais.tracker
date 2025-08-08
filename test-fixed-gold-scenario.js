'use strict';

/**
 * Test just the KLAFFBRON_COMPLETE_JOURNEY scenario with fixed vessel state
 */

const GoldStandardComprehensiveTest = require('./tests/journey-scenarios/gold-standard-comprehensive-test');

async function testFixedScenario() {
  console.log('🔍 Testing fixed KLAFFBRON_COMPLETE_JOURNEY scenario');

  const test = new GoldStandardComprehensiveTest();
  test.testRunner = test.testRunner || await (async () => {
    const RealAppTestRunner = require('./tests/journey-scenarios/RealAppTestRunner');
    const runner = new RealAppTestRunner();
    await runner.initializeApp();
    runner.app.vesselDataService.enableTestMode(); // Disable GPS jump detection
    return runner;
  })();

  // Get the specific scenario to test
  const scenario = test.goldStandardScenarios.targetBridgeTests.scenarios[0]; // KLAFFBRON_COMPLETE_JOURNEY

  console.log(`\n📋 Testing: ${scenario.name} - ${scenario.description}`);

  await test._runScenario(scenario);

  await test.testRunner.cleanup();
}

testFixedScenario().catch(console.error);
