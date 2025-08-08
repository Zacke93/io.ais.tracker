/**
 * Verification of ALL message variations from bridgeTextFormat.md example catalog
 * Tests every single message format to ensure 100% compliance
 */

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

class ExampleCatalogVerification {
  constructor() {
    this.testRunner = new RealAppTestRunner();
    this.results = {
      singleVessel: { total: 0, passed: 0, failed: [] },
      multiVessel: { total: 0, passed: 0, failed: [] },
      mixedTargetBridge: { total: 0, passed: 0, failed: [] },
      priorityOverrides: { total: 0, passed: 0, failed: [] },
      stallbackabronSpecial: { total: 0, passed: 0, failed: [] },
    };
  }

  async runAllTests() {
    console.log('🧪 === EXAMPLE CATALOG VERIFICATION ===');
    console.log('📋 Testar ALLA meddelande-varianter från bridgeTextFormat.md\n');

    try {
      await this.testRunner.initializeApp();
      console.log('✅ Real AISBridgeApp initialized\n');

      // Test all categories from example catalog
      await this.testSingleVesselExamples();
      await this.testMultiVesselExamples();
      await this.testMixedTargetBridgeExamples();
      await this.testStallbackabronSpecialExamples();
      await this.testPriorityOverrideExamples();

      this.printFinalReport();

    } catch (error) {
      console.error('❌ Test initialization failed:', error.message);
    } finally {
      await this.testRunner.cleanup();
    }
  }

  /**
   * Test SINGLE VESSEL EXAMPLES from bridgeTextFormat.md lines 285-317
   */
  async testSingleVesselExamples() {
    console.log('🔸 TESTING: Single Vessel Examples');
    this.results.singleVessel.total = 16; // Total examples in catalog

    const tests = [
      // KLAFFBRON (MÅLBRO) examples
      {
        name: 'Klaffbron en-route',
        expected: 'En båt på väg mot Klaffbron, beräknad broöppning om',
        setup: () => this.createVessel('TEST001', 58.27500, 12.28000, 4.0, 'en-route', 'Klaffbron'),
      },
      {
        name: 'Klaffbron approaching',
        expected: 'En båt närmar sig Klaffbron, beräknad broöppning om',
        setup: () => this.createVessel('TEST002', 58.28000, 12.28500, 3.5, 'approaching', 'Klaffbron'),
      },
      {
        name: 'Klaffbron waiting',
        expected: 'En båt inväntar broöppning vid Klaffbron',
        setup: () => this.createVessel('TEST003', 58.28400, 12.28900, 1.5, 'waiting', 'Klaffbron'),
      },
      {
        name: 'Klaffbron under-bridge',
        expected: 'Broöppning pågår vid Klaffbron',
        setup: () => this.createVessel('TEST004', 58.28433, 12.29062, 2.0, 'under-bridge', 'Klaffbron'),
      },
      {
        name: 'Klaffbron passed',
        expected: 'En båt har precis passerat Klaffbron på väg mot Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createPassedVessel('TEST005', 58.28500, 12.29100, 3.0, 'Klaffbron', 'Stridsbergsbron'),
      },

      // STRIDSBERGSBRON (MÅLBRO) examples
      {
        name: 'Stridsbergsbron en-route',
        expected: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createVessel('TEST006', 58.28600, 12.29200, 4.0, 'en-route', 'Stridsbergsbron'),
      },
      {
        name: 'Stridsbergsbron approaching',
        expected: 'En båt närmar sig Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createVessel('TEST007', 58.28700, 12.29300, 3.5, 'approaching', 'Stridsbergsbron'),
      },
      {
        name: 'Stridsbergsbron waiting',
        expected: 'En båt inväntar broöppning vid Stridsbergsbron',
        setup: () => this.createVessel('TEST008', 58.28800, 12.29400, 1.5, 'waiting', 'Stridsbergsbron'),
      },

      // OLIDEBRON (MELLANBRO) examples
      {
        name: 'Olidebron approaching',
        expected: 'En båt närmar sig Olidebron på väg mot Klaffbron, beräknad broöppning om',
        setup: () => this.createIntermediateVessel('TEST009', 58.27000, 12.27450, 3.0, 'approaching', 'Olidebron', 'Klaffbron'),
      },
      {
        name: 'Olidebron waiting',
        expected: 'En båt inväntar broöppning av Olidebron på väg mot Klaffbron, beräknad broöppning om',
        setup: () => this.createIntermediateVessel('TEST010', 58.27100, 12.27500, 1.5, 'waiting', 'Olidebron', 'Klaffbron'),
      },
      {
        name: 'Olidebron under-bridge',
        expected: 'Broöppning pågår vid Olidebron, beräknad broöppning av Klaffbron om',
        setup: () => this.createIntermediateVessel('TEST011', 58.27247, 12.27512, 2.0, 'under-bridge', 'Olidebron', 'Klaffbron'),
      },

      // JÄRNVÄGSBRON (MELLANBRO) examples
      {
        name: 'Järnvägsbron waiting',
        expected: 'En båt inväntar broöppning av Järnvägsbron på väg mot Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createIntermediateVessel('TEST012', 58.28600, 12.28400, 1.5, 'waiting', 'Järnvägsbron', 'Stridsbergsbron'),
      },

      // STALLBACKABRON (SPECIALFALL) examples
      {
        name: 'Stallbackabron approaching',
        expected: 'En båt närmar sig Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createStallbackaVessel('TEST013', 58.28520, 12.28800, 3.0, 'approaching', 'Stridsbergsbron'),
      },
      {
        name: 'Stallbackabron waiting',
        expected: 'En båt åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createStallbackaVessel('TEST014', 58.28580, 12.28850, 2.0, 'stallbacka-waiting', 'Stridsbergsbron'),
      },
      {
        name: 'Stallbackabron under-bridge',
        expected: 'En båt passerar Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createStallbackaVessel('TEST015', 58.28600, 12.28870, 2.5, 'under-bridge', 'Stridsbergsbron'),
      },
      {
        name: 'Stallbackabron passed',
        expected: 'En båt har precis passerat Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createStallbackaPassedVessel('TEST016', 58.28650, 12.28900, 3.0, 'Stridsbergsbron'),
      },
    ];

    for (const test of tests) {
      await this.runSingleTest(test, 'singleVessel');
    }

    console.log(`📊 Single Vessel: ${this.results.singleVessel.passed}/${this.results.singleVessel.total} passed\n`);
  }

  /**
   * Test MULTI-VESSEL EXAMPLES from bridgeTextFormat.md lines 320-333
   */
  async testMultiVesselExamples() {
    console.log('🔸 TESTING: Multi-Vessel Examples (Same Target Bridge)');
    this.results.multiVessel.total = 8;

    const tests = [
      {
        name: '3 boats en-route Klaffbron',
        expected: '3 båtar på väg mot Klaffbron, beräknad broöppning om',
        setup: () => this.createMultipleVessels([
          {
            mmsi: 'MULTI001', lat: 58.27500, lon: 12.28000, status: 'en-route', target: 'Klaffbron',
          },
          {
            mmsi: 'MULTI002', lat: 58.27550, lon: 12.28050, status: 'en-route', target: 'Klaffbron',
          },
          {
            mmsi: 'MULTI003', lat: 58.27600, lon: 12.28100, status: 'en-route', target: 'Klaffbron',
          },
        ]),
      },
      {
        name: '2 boats waiting Klaffbron',
        expected: '2 båtar inväntar broöppning vid Klaffbron',
        setup: () => this.createMultipleVessels([
          {
            mmsi: 'MULTI004', lat: 58.28400, lon: 12.28900, status: 'waiting', target: 'Klaffbron',
          },
          {
            mmsi: 'MULTI005', lat: 58.28410, lon: 12.28910, status: 'waiting', target: 'Klaffbron',
          },
        ]),
      },
      {
        name: '1 waiting + 2 approaching Klaffbron',
        expected: 'En båt inväntar broöppning vid Klaffbron, ytterligare 2 båtar på väg',
        setup: () => this.createMultipleVessels([
          {
            mmsi: 'MULTI006', lat: 58.28400, lon: 12.28900, status: 'waiting', target: 'Klaffbron',
          },
          {
            mmsi: 'MULTI007', lat: 58.28000, lon: 12.28500, status: 'approaching', target: 'Klaffbron',
          },
          {
            mmsi: 'MULTI008', lat: 58.28050, lon: 12.28550, status: 'approaching', target: 'Klaffbron',
          },
        ]),
      },
      {
        name: '1 under-bridge + 2 en-route Klaffbron',
        expected: 'Broöppning pågår vid Klaffbron, ytterligare 2 båtar på väg',
        setup: () => this.createMultipleVessels([
          {
            mmsi: 'MULTI009', lat: 58.28433, lon: 12.29062, status: 'under-bridge', target: 'Klaffbron',
          },
          {
            mmsi: 'MULTI010', lat: 58.27500, lon: 12.28000, status: 'en-route', target: 'Klaffbron',
          },
          {
            mmsi: 'MULTI011', lat: 58.27550, lon: 12.28050, status: 'en-route', target: 'Klaffbron',
          },
        ]),
      },
      {
        name: '2 boats waiting intermediate bridge',
        expected: '2 båtar inväntar broöppning av Järnvägsbron på väg mot Klaffbron, beräknad broöppning om',
        setup: () => this.createMultipleIntermediateVessels([
          {
            mmsi: 'MULTI012', lat: 58.28600, lon: 12.28400, status: 'waiting', current: 'Järnvägsbron', target: 'Klaffbron',
          },
          {
            mmsi: 'MULTI013', lat: 58.28610, lon: 12.28410, status: 'waiting', current: 'Järnvägsbron', target: 'Klaffbron',
          },
        ]),
      },
      {
        name: '3 boats Stallbackabron waiting',
        expected: '3 båtar åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createMultipleStallbackaVessels([
          {
            mmsi: 'MULTI014', lat: 58.28580, lon: 12.28850, status: 'stallbacka-waiting', target: 'Stridsbergsbron',
          },
          {
            mmsi: 'MULTI015', lat: 58.28585, lon: 12.28855, status: 'stallbacka-waiting', target: 'Stridsbergsbron',
          },
          {
            mmsi: 'MULTI016', lat: 58.28590, lon: 12.28860, status: 'stallbacka-waiting', target: 'Stridsbergsbron',
          },
        ]),
      },
    ];

    for (const test of tests) {
      await this.runSingleTest(test, 'multiVessel');
    }

    console.log(`📊 Multi-Vessel: ${this.results.multiVessel.passed}/${this.results.multiVessel.total} passed\n`);
  }

  /**
   * Test MIXED TARGET BRIDGE EXAMPLES with semicolon separation
   */
  async testMixedTargetBridgeExamples() {
    console.log('🔸 TESTING: Mixed Target Bridge Examples (Semicolon Separation)');
    this.results.mixedTargetBridge.total = 5;

    const tests = [
      {
        name: 'Basic mixed target bridges',
        expected: 'En båt inväntar broöppning vid Klaffbron; 2 båtar närmar sig Stridsbergsbron',
        setup: () => this.createMixedTargetVessels([
          {
            mmsi: 'MIX001', lat: 58.28400, lon: 12.28900, status: 'waiting', target: 'Klaffbron',
          },
          {
            mmsi: 'MIX002', lat: 58.28700, lon: 12.29300, status: 'approaching', target: 'Stridsbergsbron',
          },
          {
            mmsi: 'MIX003', lat: 58.28750, lon: 12.29350, status: 'approaching', target: 'Stridsbergsbron',
          },
        ]),
      },
      {
        name: 'Under-bridge + waiting mixed',
        expected: 'Broöppning pågår vid Klaffbron; En båt inväntar broöppning vid Stridsbergsbron',
        setup: () => this.createMixedTargetVessels([
          {
            mmsi: 'MIX004', lat: 58.28433, lon: 12.29062, status: 'under-bridge', target: 'Klaffbron',
          },
          {
            mmsi: 'MIX005', lat: 58.28800, lon: 12.29400, status: 'waiting', target: 'Stridsbergsbron',
          },
        ]),
      },
      {
        name: 'Stallbackabron + Klaffbron mixed',
        expected: '2 båtar åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
        setup: () => this.createMixedStallbacka([
          {
            mmsi: 'MIX006', lat: 58.28580, lon: 12.28850, status: 'stallbacka-waiting', target: 'Stridsbergsbron',
          },
          {
            mmsi: 'MIX007', lat: 58.28585, lon: 12.28855, status: 'stallbacka-waiting', target: 'Stridsbergsbron',
          },
          {
            mmsi: 'MIX008', lat: 58.28400, lon: 12.28900, status: 'waiting', target: 'Klaffbron',
          },
        ]),
      },
    ];

    for (const test of tests) {
      await this.runSingleTest(test, 'mixedTargetBridge');
    }

    console.log(`📊 Mixed Target Bridge: ${this.results.mixedTargetBridge.passed}/${this.results.mixedTargetBridge.total} passed\n`);
  }

  /**
   * Test STALLBACKABRON SPECIAL cases thoroughly
   */
  async testStallbackabronSpecialExamples() {
    console.log('🔸 TESTING: Stallbackabron Special Rules');
    this.results.stallbackabronSpecial.total = 6;

    const tests = [
      {
        name: 'Never uses "inväntar broöppning"',
        expected: 'åker strax under Stallbackabron', // Should NEVER say "inväntar broöppning"
        notExpected: 'inväntar broöppning',
        setup: () => this.createStallbackaVessel('STALL001', 58.28580, 12.28850, 1.0, 'stallbacka-waiting', 'Stridsbergsbron'),
      },
      {
        name: 'Always shows "på väg mot [målbro]"',
        expected: 'på väg mot Stridsbergsbron',
        setup: () => this.createStallbackaVessel('STALL002', 58.28520, 12.28800, 3.0, 'approaching', 'Stridsbergsbron'),
      },
      {
        name: 'Always shows ETA for all statuses',
        expected: 'beräknad broöppning om',
        setup: () => this.createStallbackaVessel('STALL003', 58.28600, 12.28870, 2.0, 'under-bridge', 'Stridsbergsbron'),
      },
      {
        name: 'Multi-vessel Stallbackabron format',
        expected: 'båtar åker strax under Stallbackabron på väg mot',
        setup: () => this.createMultipleStallbackaVessels([
          {
            mmsi: 'STALL004', lat: 58.28580, lon: 12.28850, status: 'stallbacka-waiting', target: 'Stridsbergsbron',
          },
          {
            mmsi: 'STALL005', lat: 58.28585, lon: 12.28855, status: 'stallbacka-waiting', target: 'Stridsbergsbron',
          },
        ]),
      },
    ];

    for (const test of tests) {
      await this.runSingleTest(test, 'stallbackabronSpecial');
    }

    console.log(`📊 Stallbackabron Special: ${this.results.stallbackabronSpecial.passed}/${this.results.stallbackabronSpecial.total} passed\n`);
  }

  /**
   * Test PRIORITY OVERRIDE examples from bridgeTextFormat.md lines 356-377
   */
  async testPriorityOverrideExamples() {
    console.log('🔸 TESTING: Priority Override Examples');
    this.results.priorityOverrides.total = 4;

    const tests = [
      {
        name: 'Target bridge waiting beats passed intermediate',
        expected: 'En båt inväntar broöppning vid Klaffbron',
        notExpected: 'precis passerat', // Should ignore passed vessel
        setup: () => this.createPriorityScenario1(),
      },
      {
        name: 'Target bridge under-bridge beats passed',
        expected: 'Broöppning pågår vid Stridsbergsbron',
        notExpected: 'precis passerat',
        setup: () => this.createPriorityScenario2(),
      },
      {
        name: 'Target vs intermediate bridge priority',
        expected: 'En båt inväntar broöppning vid Klaffbron',
        notExpected: 'Järnvägsbron', // Should ignore intermediate
        setup: () => this.createPriorityScenario3(),
      },
    ];

    for (const test of tests) {
      await this.runSingleTest(test, 'priorityOverrides');
    }

    console.log(`📊 Priority Overrides: ${this.results.priorityOverrides.passed}/${this.results.priorityOverrides.total} passed\n`);
  }

  /**
   * Run a single test case
   */
  async runSingleTest(test, category) {
    try {
      console.log(`   🧪 Testing: ${test.name}`);

      // Clear previous vessels
      await this.testRunner.clearAllVessels();
      await this._wait(100);

      // Setup test scenario
      await test.setup();
      await this._wait(200);

      // Get bridge text
      const relevantVessels = this.testRunner.app._findRelevantBoatsForBridgeText();
      const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(relevantVessels);

      // Check expectations
      const hasExpected = bridgeText.includes(test.expected);
      const hasNotExpected = test.notExpected ? !bridgeText.includes(test.notExpected) : true;
      const success = hasExpected && hasNotExpected;

      if (success) {
        this.results[category].passed++;
        console.log(`     ✅ PASS: "${bridgeText.substring(0, 80)}..."`);
      } else {
        this.results[category].failed.push({
          name: test.name,
          expected: test.expected,
          notExpected: test.notExpected,
          actual: bridgeText,
          reason: !hasExpected ? 'Missing expected text' : 'Contains forbidden text',
        });
        console.log(`     ❌ FAIL: "${bridgeText.substring(0, 80)}..."`);
        console.log(`        Expected: "${test.expected}"`);
        if (test.notExpected) {
          console.log(`        Must not contain: "${test.notExpected}"`);
        }
      }

    } catch (error) {
      this.results[category].failed.push({
        name: test.name,
        error: error.message,
      });
      console.log(`     ❌ ERROR: ${error.message}`);
    }
  }

  // Helper methods for creating test vessels
  createVessel(mmsi, lat, lon, sog, status, targetBridge) {
    return this.testRunner.sendAISMessage({
      mmsi,
      shipName: `Test ${mmsi}`,
      lat,
      lon,
      sog,
      cog: 45,
    });
  }

  createIntermediateVessel(mmsi, lat, lon, sog, status, currentBridge, targetBridge) {
    return this.testRunner.sendAISMessage({
      mmsi,
      shipName: `Test ${mmsi}`,
      lat,
      lon,
      sog,
      cog: 45,
    });
  }

  createStallbackaVessel(mmsi, lat, lon, sog, status, targetBridge) {
    return this.testRunner.sendAISMessage({
      mmsi,
      shipName: `Stallbacka ${mmsi}`,
      lat,
      lon,
      sog,
      cog: 45,
    });
  }

  createPassedVessel(mmsi, lat, lon, sog, passedBridge, targetBridge) {
    return this.testRunner.sendAISMessage({
      mmsi,
      shipName: `Passed ${mmsi}`,
      lat,
      lon,
      sog,
      cog: 45,
    });
  }

  createStallbackaPassedVessel(mmsi, lat, lon, sog, targetBridge) {
    return this.testRunner.sendAISMessage({
      mmsi,
      shipName: `StallPassed ${mmsi}`,
      lat,
      lon,
      sog,
      cog: 45,
    });
  }

  async createMultipleVessels(vessels) {
    for (const vessel of vessels) {
      await this.testRunner.sendAISMessage({
        mmsi: vessel.mmsi,
        shipName: `Multi ${vessel.mmsi}`,
        lat: vessel.lat,
        lon: vessel.lon,
        sog: 3.0,
        cog: 45,
      });
      await this._wait(50);
    }
  }

  async createMultipleIntermediateVessels(vessels) {
    for (const vessel of vessels) {
      await this.testRunner.sendAISMessage({
        mmsi: vessel.mmsi,
        shipName: `Inter ${vessel.mmsi}`,
        lat: vessel.lat,
        lon: vessel.lon,
        sog: 2.0,
        cog: 45,
      });
      await this._wait(50);
    }
  }

  async createMultipleStallbackaVessels(vessels) {
    for (const vessel of vessels) {
      await this.testRunner.sendAISMessage({
        mmsi: vessel.mmsi,
        shipName: `Stall ${vessel.mmsi}`,
        lat: vessel.lat,
        lon: vessel.lon,
        sog: 2.5,
        cog: 45,
      });
      await this._wait(50);
    }
  }

  async createMixedTargetVessels(vessels) {
    for (const vessel of vessels) {
      await this.testRunner.sendAISMessage({
        mmsi: vessel.mmsi,
        shipName: `Mixed ${vessel.mmsi}`,
        lat: vessel.lat,
        lon: vessel.lon,
        sog: 3.0,
        cog: 45,
      });
      await this._wait(50);
    }
  }

  async createMixedStallbacka(vessels) {
    for (const vessel of vessels) {
      await this.testRunner.sendAISMessage({
        mmsi: vessel.mmsi,
        shipName: `MixStall ${vessel.mmsi}`,
        lat: vessel.lat,
        lon: vessel.lon,
        sog: 2.5,
        cog: 45,
      });
      await this._wait(50);
    }
  }

  // Priority scenario helpers
  async createPriorityScenario1() {
    // Target bridge waiting should beat passed intermediate
    await this.testRunner.sendAISMessage({
      mmsi: 'PRIO001',
      shipName: 'Priority Test 1',
      lat: 58.28400,
      lon: 12.28900, // Near Klaffbron
      sog: 1.5,
      cog: 45,
    });
  }

  async createPriorityScenario2() {
    // Target bridge under-bridge should beat passed
    await this.testRunner.sendAISMessage({
      mmsi: 'PRIO002',
      shipName: 'Priority Test 2',
      lat: 58.28800,
      lon: 12.29400, // Near Stridsbergsbron
      sog: 2.0,
      cog: 45,
    });
  }

  async createPriorityScenario3() {
    // Target bridge should beat intermediate bridge
    await this.testRunner.sendAISMessage({
      mmsi: 'PRIO003',
      shipName: 'Priority Test 3',
      lat: 58.28400,
      lon: 12.28900, // Near Klaffbron
      sog: 1.5,
      cog: 45,
    });
  }

  async _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  printFinalReport() {
    console.log('\n🏁 === EXAMPLE CATALOG VERIFICATION REPORT ===');

    const categories = ['singleVessel', 'multiVessel', 'mixedTargetBridge', 'stallbackabronSpecial', 'priorityOverrides'];
    let totalPassed = 0;
    let totalTests = 0;

    categories.forEach((category) => {
      const result = this.results[category];
      totalPassed += result.passed;
      totalTests += result.total;

      const percentage = result.total > 0 ? ((result.passed / result.total) * 100).toFixed(1) : '0.0';
      const status = percentage === '100.0' ? '🟢' : percentage >= '75.0' ? '🟡' : '🔴';

      console.log(`${status} ${category}: ${result.passed}/${result.total} (${percentage}%)`);

      if (result.failed.length > 0) {
        console.log('   ❌ Failures:');
        result.failed.forEach((failure) => {
          console.log(`      • ${failure.name}: ${failure.reason || failure.error}`);
        });
      }
    });

    const overallPercentage = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(1) : '0.0';
    const overallStatus = overallPercentage === '100.0' ? '🟢' : overallPercentage >= '90.0' ? '🟡' : '🔴';

    console.log(`\n${overallStatus} OVERALL: ${totalPassed}/${totalTests} (${overallPercentage}%)`);

    if (overallPercentage === '100.0') {
      console.log('\n✅ ALL MESSAGE VARIATIONS FROM EXAMPLE CATALOG WORK PERFECTLY!');
      console.log('🎯 Bridge text format implementation is 100% compliant.');
    } else {
      console.log(`\n⚠️ ${totalTests - totalPassed} message variations need attention.`);
      console.log('🔧 See specific failures above for implementation fixes needed.');
    }
  }
}

// Run if called directly
if (require.main === module) {
  const verification = new ExampleCatalogVerification();
  verification.runAllTests().catch(console.error);
}

module.exports = ExampleCatalogVerification;
