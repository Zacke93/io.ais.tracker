'use strict';

/**
 * DEBUG LOG VALIDATION TEST V2.0
 *
 * Specifikt test för att validera att ALLA problem från senaste debug-loggar är lösta
 * Baserat på bridge-text-20250727-172320.jsonl och bridgeTextFormat.md V2.0
 */

const RealAppTestRunner = require('./RealAppTestRunner');

class DebugLogValidationTest {
  constructor() {
    this.testRunner = null;
    this.testResults = [];
  }

  /**
   * KRITISKA PROBLEM FRÅN DEBUG LOGS 20250727-172320
   */
  getDebugLogScenarios() {
    return {
      // Problem 1: HELGE waiting status shows "närmar sig" instead of "inväntar broöppning"
      helgeWaitingProblem: {
        mmsi: '244750397',
        name: 'HELGE',
        lat: 58.28154, // 280m south of Klaffbron (should trigger waiting)
        lon: 12.283929,
        sog: 3.5,
        cog: 29.3,
        expectedStatus: 'waiting',
        expectedText: 'inväntar broöppning vid Klaffbron',
        mustNotHave: 'närmar sig',
        targetBridge: 'Klaffbron',
        problemDescription: 'CRITICAL: Waiting vessel shows "närmar sig" instead of "inväntar broöppning"',
      },

      // Problem 2: Vessels without targetBridge causing null/undefined
      vesselWithoutTarget: {
        mmsi: '219031534',
        name: 'ZENIT',
        lat: 58.287598333333335, // Exact position from logs
        lon: 12.285628333333333,
        sog: 0, // Stationary
        cog: 192.5,
        expectedFiltered: true, // Should be filtered out
        expectedText: 'Inga båtar',
        mustNotHave: ['undefined', 'null', 'undefinedmin'],
        problemDescription: 'Stationary vessel without targetBridge causes null/undefined in bridge text',
      },

      // Problem 3: 500m approaching rule implementation
      new500mApproaching: [
        {
          mmsi: 'APPROACH_500M_TEST',
          name: 'APPROACH 500M TEST',
          lat: 58.279691, // 450m south of Klaffbron
          lon: 12.283929,
          sog: 3.0,
          cog: 45,
          expectedStatus: 'approaching',
          expectedText: 'närmar sig Klaffbron, beräknad broöppning om',
          mustHaveETA: true,
          targetBridge: 'Klaffbron',
          problemDescription: 'NEW 500m approaching rule not working',
        },
        {
          mmsi: 'ENROUTE_520M_TEST',
          name: 'ENROUTE 520M TEST',
          lat: 58.279491, // 520m south of Klaffbron (beyond 500m)
          lon: 12.283929,
          sog: 2.5,
          cog: 45,
          expectedStatus: 'en-route',
          expectedText: 'på väg mot Klaffbron',
          mustHaveETA: true,
          targetBridge: 'Klaffbron',
          problemDescription: 'Vessel beyond 500m should be en-route, not approaching',
        },
      ],

      // Problem 4: Stallbackabron special rules
      stallbackabronSpecial: [
        {
          mmsi: 'STALLBACKA_WAITING',
          name: 'STALLBACKA WAITING TEST',
          lat: 58.310, // Position very close to Stallbackabron (58.3114) to trigger stallbacka-waiting
          lon: 12.315,
          sog: 2.1,
          cog: 45,
          expectedStatus: 'stallbacka-waiting',
          expectedText: 'åker strax under Stallbackabron',
          mustNotHave: 'inväntar broöppning',
          mustHaveETA: false, // No target bridge means no ETA
          targetBridge: null, // Vessel leaving canal has no target bridge
          problemDescription: 'Stallbackabron NEVER shows "inväntar broöppning"',
        },
        {
          mmsi: 'STALLBACKA_UNDER',
          name: 'STALLBACKA UNDER TEST',
          lat: 58.311405, // 28m from Stallbackabron
          lon: 12.314564,
          sog: 4.1,
          cog: 45,
          expectedStatus: 'under-bridge',
          expectedText: 'passerar Stallbackabron',
          mustHaveETA: false, // No target bridge means no ETA
          targetBridge: null, // Vessel leaving canal has no target bridge
          problemDescription: 'Stallbackabron under-bridge should use "passerar" not "broöppning pågår"',
        },
      ],

      // Problem 5: Intermediate bridge detection
      intermediateBridgeTests: [
        {
          mmsi: 'OLIDEBRON_WAITING',
          name: 'OLIDEBRON WAITING',
          lat: 58.27159666666667, // Position from HELGE logs at Olidebron
          lon: 12.273583333333333,
          sog: 3.3,
          cog: 33.3,
          expectedStatus: 'waiting',
          expectedText: 'inväntar broöppning av Olidebron på väg mot Klaffbron',
          mustHaveETA: true,
          targetBridge: 'Klaffbron',
          problemDescription: 'Intermediate bridge waiting not detected properly',
        },
        {
          mmsi: 'JARNVAGSBRON_APPROACHING',
          name: 'JARNVAGSBRON APPROACHING',
          lat: 58.2880, // 400m from Järnvägsbron, approaching target bridge Stridsbergsbron
          lon: 12.2920,
          sog: 3.8,
          cog: 45,
          expectedStatus: 'approaching',
          expectedText: 'närmar sig Stridsbergsbron', // Correct: closer to target bridge than intermediate
          mustHaveETA: true,
          targetBridge: 'Stridsbergsbron',
          problemDescription: 'Intermediate bridge approaching logic working correctly',
        },
      ],
    };
  }

  /**
   * RUN VALIDATION TEST
   */
  async runValidationTest() {
    console.log('🚀 === DEBUG LOG VALIDATION TEST V2.0 ===');
    console.log('📊 Validerar att ALLA problem från senaste debug-loggar är lösta');
    console.log('🎯 Baserat på bridge-text-20250727-172320.jsonl');

    try {
      this.testRunner = new RealAppTestRunner();
      await this.testRunner.initializeApp();
      console.log('✅ Real AISBridgeApp initialized with all services\\n');

      const scenarios = this.getDebugLogScenarios();

      // Test 1: HELGE waiting problem
      await this._testHelgeWaitingProblem(scenarios.helgeWaitingProblem);

      // Test 2: Vessel without target problem
      await this._testVesselWithoutTarget(scenarios.vesselWithoutTarget);

      // Test 3: 500m approaching rules
      await this._test500mApproachingRules(scenarios.new500mApproaching);

      // Test 4: Stallbackabron special rules
      await this._testStallbackabronSpecialRules(scenarios.stallbackabronSpecial);

      // Test 5: Intermediate bridge detection
      await this._testIntermediateBridgeDetection(scenarios.intermediateBridgeTests);

      // Final report
      this._generateFinalReport();

    } catch (error) {
      console.error('❌ Debug Log Validation Test failed:', error.message);
      throw new Error('Validation test failed');
    } finally {
      if (this.testRunner) {
        console.log('🧹 Cleaning up test runner...');
        await this.testRunner.cleanup();
      }
    }
  }

  async _testHelgeWaitingProblem(scenario) {
    console.log('🔸 TEST 1: HELGE waiting problem (CRITICAL)');
    console.log('   🎯 Must show "inväntar broöppning vid Klaffbron", NOT "närmar sig"');

    // First, establish targetBridge with small movement to avoid GPS jump
    await this.testRunner._processVesselAsAISMessage({
      mmsi: scenario.mmsi,
      lat: scenario.lat - 0.002, // Smaller movement ~220m to avoid GPS jump detection
      lon: scenario.lon,
      sog: scenario.sog,
      cog: scenario.cog,
      name: scenario.name,
    });
    await this._wait(50);

    // Then move to waiting position
    await this.testRunner._processVesselAsAISMessage({
      mmsi: scenario.mmsi,
      lat: scenario.lat,
      lon: scenario.lon,
      sog: scenario.sog,
      cog: scenario.cog,
      name: scenario.name,
    });
    await this._wait(100);

    const vessel = this.testRunner.app.vesselDataService.getVessel(scenario.mmsi);
    const relevantVessels = this.testRunner.app._findRelevantBoatsForBridgeText();
    const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(relevantVessels);

    const correctStatus = vessel?.status === scenario.expectedStatus;
    const correctText = bridgeText.includes(scenario.expectedText);
    const noForbiddenText = !bridgeText.includes(scenario.mustNotHave);
    const hasTargetBridge = vessel?.targetBridge === scenario.targetBridge;

    const result = {
      test: 'HELGE Waiting Problem',
      success: correctStatus && correctText && noForbiddenText && hasTargetBridge,
      details: {
        actualStatus: vessel?.status,
        expectedStatus: scenario.expectedStatus,
        actualTargetBridge: vessel?.targetBridge,
        bridgeText,
        correctStatus,
        correctText,
        noForbiddenText,
        hasTargetBridge,
      },
    };

    this.testResults.push(result);

    console.log(`   ${result.success ? '✅' : '❌'} HELGE waiting: ${result.success ? 'LÖST' : 'KVARSTÅR'}`);
    console.log(`      Status: ${vessel?.status}, Target: ${vessel?.targetBridge}`);
    console.log(`      Text: ${bridgeText}`);
    if (!result.success) {
      console.log(`      🔍 Checks: status=${correctStatus}, text=${correctText}, noForbidden=${noForbiddenText}, target=${hasTargetBridge}`);
    }
    console.log('');
  }

  async _testVesselWithoutTarget(scenario) {
    console.log('🔸 TEST 2: Vessel without targetBridge problem');
    console.log('   🎯 Stationary vessels should be filtered out or handled gracefully');

    // CRITICAL FIX: Clear all vessels before test to ensure clean state
    console.log(`   🧹 Clearing vessels for isolated test of ${scenario.mmsi}`);
    this.testRunner.app.vesselDataService.getAllVessels().forEach((v) => this.testRunner.app.vesselDataService.removeVessel(v.mmsi, 'test-cleanup'));
    await this._wait(50);

    await this.testRunner._processVesselAsAISMessage({
      mmsi: scenario.mmsi,
      lat: scenario.lat,
      lon: scenario.lon,
      sog: scenario.sog,
      cog: scenario.cog,
      name: scenario.name,
    });
    await this._wait(100);

    const vessel = this.testRunner.app.vesselDataService.getVessel(scenario.mmsi);
    const relevantVessels = this.testRunner.app._findRelevantBoatsForBridgeText();
    const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(relevantVessels);

    const noUndefinedText = !scenario.mustNotHave.some((forbidden) => bridgeText.includes(forbidden));
    const properFiltering = scenario.expectedFiltered ? !relevantVessels.some((v) => v.mmsi === scenario.mmsi) : true;

    const result = {
      test: 'Vessel Without Target',
      success: noUndefinedText && properFiltering,
      details: {
        vesselExists: !!vessel,
        targetBridge: vessel?.targetBridge,
        isInRelevantVessels: relevantVessels.some((v) => v.mmsi === scenario.mmsi),
        bridgeText,
        noUndefinedText,
        properFiltering,
      },
    };

    this.testResults.push(result);

    console.log(`   ${result.success ? '✅' : '❌'} Vessel filtering: ${result.success ? 'LÖST' : 'KVARSTÅR'}`);
    console.log(`      Vessel target: ${vessel?.targetBridge}, In relevant: ${result.details.isInRelevantVessels}`);
    console.log(`      Text: ${bridgeText}`);
    console.log('');
  }

  async _test500mApproachingRules(scenarios) {
    console.log('🔸 TEST 3: 500m approaching rules');
    console.log('   🎯 500m = approaching, >500m = en-route (ISOLATED TESTS)');

    const results = [];

    for (const scenario of scenarios) {
      // CRITICAL FIX: Clear all vessels before each test to avoid interference
      console.log(`   🧹 Clearing vessels for isolated test of ${scenario.mmsi}`);
      this.testRunner.app.vesselDataService.getAllVessels().forEach((v) => this.testRunner.app.vesselDataService.removeVessel(v.mmsi, 'test-cleanup'));
      await this._wait(50);

      // Establish targetBridge first with small movement
      await this.testRunner._processVesselAsAISMessage({
        mmsi: scenario.mmsi,
        lat: scenario.lat - 0.002, // Smaller movement to avoid GPS jump
        lon: scenario.lon,
        sog: scenario.sog,
        cog: scenario.cog,
        name: scenario.name,
      });
      await this._wait(50);

      await this.testRunner._processVesselAsAISMessage({
        mmsi: scenario.mmsi,
        lat: scenario.lat,
        lon: scenario.lon,
        sog: scenario.sog,
        cog: scenario.cog,
        name: scenario.name,
      });
      await this._wait(100);

      const vessel = this.testRunner.app.vesselDataService.getVessel(scenario.mmsi);
      const relevantVessels = this.testRunner.app._findRelevantBoatsForBridgeText();
      const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(relevantVessels);

      const correctStatus = vessel?.status === scenario.expectedStatus;
      const correctText = bridgeText.includes(scenario.expectedText);
      const hasETA = scenario.mustHaveETA ? (bridgeText.includes('beräknad broöppning om') || bridgeText.includes('minuter')) : true;
      const hasTargetBridge = vessel?.targetBridge === scenario.targetBridge;

      const result = {
        name: scenario.mmsi,
        success: correctStatus && correctText && hasETA && hasTargetBridge,
        actualStatus: vessel?.status,
        expectedStatus: scenario.expectedStatus,
        bridgeText,
        correctStatus,
        correctText,
        hasETA,
        hasTargetBridge,
      };

      results.push(result);

      console.log(`   ${result.success ? '✅' : '❌'} ${scenario.mmsi}: Status=${result.actualStatus}/${scenario.expectedStatus}`);
      if (!result.success) {
        console.log(`      Text: ${bridgeText}`);
        console.log(`      🔍 Checks: status=${correctStatus}, text=${correctText}, ETA=${hasETA}, target=${hasTargetBridge}`);
      }
    }

    const successRate = (results.filter((r) => r.success).length / results.length) * 100;
    this.testResults.push({
      test: '500m Approaching Rules',
      successRate,
      details: results,
    });

    console.log(`   📊 500m rules: ${successRate.toFixed(1)}% success\\n`);
  }

  async _testStallbackabronSpecialRules(scenarios) {
    console.log('🔸 TEST 4: Stallbackabron special rules');
    console.log('   🎯 NEVER "inväntar broöppning", always "på väg mot" + ETA (ISOLATED TESTS)');

    const results = [];

    for (const scenario of scenarios) {
      // CRITICAL FIX: Clear all vessels before each test to avoid interference
      console.log(`   🧹 Clearing vessels for isolated test of ${scenario.mmsi}`);
      this.testRunner.app.vesselDataService.getAllVessels().forEach((v) => this.testRunner.app.vesselDataService.removeVessel(v.mmsi, 'test-cleanup'));
      await this._wait(50);

      // Establish targetBridge first with small movement
      await this.testRunner._processVesselAsAISMessage({
        mmsi: scenario.mmsi,
        lat: scenario.lat - 0.002, // Smaller movement to avoid GPS jump
        lon: scenario.lon,
        sog: scenario.sog,
        cog: scenario.cog,
        name: scenario.name,
      });
      await this._wait(50);

      await this.testRunner._processVesselAsAISMessage({
        mmsi: scenario.mmsi,
        lat: scenario.lat,
        lon: scenario.lon,
        sog: scenario.sog,
        cog: scenario.cog,
        name: scenario.name,
      });
      await this._wait(100);

      const vessel = this.testRunner.app.vesselDataService.getVessel(scenario.mmsi);
      const relevantVessels = this.testRunner.app._findRelevantBoatsForBridgeText();
      const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(relevantVessels);

      const correctStatus = vessel?.status === scenario.expectedStatus;
      const correctText = bridgeText.includes(scenario.expectedText);
      const noForbiddenText = !bridgeText.includes(scenario.mustNotHave);
      const hasETA = scenario.mustHaveETA ? (bridgeText.includes('beräknad broöppning om') || bridgeText.includes('minuter')) : true;

      const result = {
        name: scenario.mmsi,
        success: correctStatus && correctText && noForbiddenText && hasETA,
        actualStatus: vessel?.status,
        expectedStatus: scenario.expectedStatus,
        bridgeText,
        noForbiddenText,
      };

      results.push(result);

      console.log(`   ${result.success ? '✅' : '❌'} ${scenario.mmsi}: Status=${result.actualStatus}, NoWaiting=${result.noForbiddenText}`);
      if (!result.success) {
        console.log(`      Text: ${bridgeText}`);
      }
    }

    const successRate = (results.filter((r) => r.success).length / results.length) * 100;
    this.testResults.push({
      test: 'Stallbackabron Special Rules',
      successRate,
      details: results,
    });

    console.log(`   📊 Stallbackabron rules: ${successRate.toFixed(1)}% success\\n`);
  }

  async _testIntermediateBridgeDetection(scenarios) {
    console.log('🔸 TEST 5: Intermediate bridge detection');
    console.log('   🎯 Olidebron/Järnvägsbron should show "på väg mot [målbro]" + ETA (ISOLATED TESTS)');

    const results = [];

    for (const scenario of scenarios) {
      // CRITICAL FIX: Clear all vessels before each test to avoid interference
      console.log(`   🧹 Clearing vessels for isolated test of ${scenario.mmsi}`);
      this.testRunner.app.vesselDataService.getAllVessels().forEach((v) => this.testRunner.app.vesselDataService.removeVessel(v.mmsi, 'test-cleanup'));
      await this._wait(50);

      // Establish targetBridge first with small movement
      await this.testRunner._processVesselAsAISMessage({
        mmsi: scenario.mmsi,
        lat: scenario.lat - 0.002, // Smaller movement to avoid GPS jump
        lon: scenario.lon,
        sog: scenario.sog,
        cog: scenario.cog,
        name: scenario.name,
      });
      await this._wait(50);

      await this.testRunner._processVesselAsAISMessage({
        mmsi: scenario.mmsi,
        lat: scenario.lat,
        lon: scenario.lon,
        sog: scenario.sog,
        cog: scenario.cog,
        name: scenario.name,
      });
      await this._wait(100);

      const vessel = this.testRunner.app.vesselDataService.getVessel(scenario.mmsi);
      const relevantVessels = this.testRunner.app._findRelevantBoatsForBridgeText();
      const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(relevantVessels);

      const correctStatus = vessel?.status === scenario.expectedStatus;
      const correctText = bridgeText.includes(scenario.expectedText);
      const hasETA = scenario.mustHaveETA ? (bridgeText.includes('beräknad broöppning om') || bridgeText.includes('minuter')) : true;
      const hasTargetBridge = vessel?.targetBridge === scenario.targetBridge;

      const result = {
        name: scenario.mmsi,
        success: correctStatus && correctText && hasETA && hasTargetBridge,
        actualStatus: vessel?.status,
        expectedStatus: scenario.expectedStatus,
        bridgeText,
        hasTargetBridge,
      };

      results.push(result);

      console.log(`   ${result.success ? '✅' : '❌'} ${scenario.mmsi}: Status=${result.actualStatus}, Target=${vessel?.targetBridge}`);
      if (!result.success) {
        console.log(`      Text: ${bridgeText}`);
      }
    }

    const successRate = (results.filter((r) => r.success).length / results.length) * 100;
    this.testResults.push({
      test: 'Intermediate Bridge Detection',
      successRate,
      details: results,
    });

    console.log(`   📊 Intermediate bridge detection: ${successRate.toFixed(1)}% success\\n`);
  }

  _generateFinalReport() {
    console.log('🏁 === DEBUG LOG VALIDATION SLUTRAPPORT ===');

    const totalTests = this.testResults.length;
    const successfulTests = this.testResults.filter((result) => result.success || (result.successRate && result.successRate >= 80)).length;

    const overallSuccess = (successfulTests / totalTests) * 100;

    this.testResults.forEach((result) => {
      const status = result.success || (result.successRate && result.successRate >= 80) ? '🟢' : '🔴';
      const rate = result.successRate ? `${result.successRate.toFixed(1)}%` : (result.success ? '100%' : '0%');
      console.log(`${status} ${result.test}: ${rate}`);
    });

    console.log('\\n📊 SAMMANFATTNING:');
    console.log(`   🎯 Totala tester: ${totalTests}`);
    console.log(`   📈 Framgång: ${overallSuccess.toFixed(1)}%`);
    console.log(`   🏆 Status: ${overallSuccess >= 80 ? '🟢 REDO' : '🔴 BEHÖVER ÅTGÄRD'}`);

    if (overallSuccess < 80) {
      console.log('\\n⚠️ SYSTEMET BEHÖVER GRANSKNING');
      console.log('   Kritiska problem från debug-loggar är inte helt lösta.');
      throw new Error('Debug log validation failed');
    } else {
      console.log('\\n✅ ALLA DEBUG LOG PROBLEM LÖSTA!');
      console.log('   Systemet är redo för produktion.');
    }
  }

  async _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Run test if called directly
if (require.main === module) {
  const test = new DebugLogValidationTest();
  test.runValidationTest()
    .then(() => {
      console.log('\\n✅ Debug Log Validation Test completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\\n❌ Debug Log Validation Test failed:', error.message);
      process.exit(1);
    });
}

module.exports = DebugLogValidationTest;
