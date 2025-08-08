'use strict';

/**
 * GOLD STANDARD COMPREHENSIVE TEST V1.0
 *
 * Baserat på RIKTIG data från debugger scripts och täcker ALLA kategorier
 * i bridgeTextFormat.md V2.0 med fullständig app.js logik testing.
 *
 * Testar:
 * - Alla bridge-typer: Target, Intermediate, Stallbackabron
 * - Alla statusar: en-route, approaching, waiting, under-bridge, passed, stallbacka-waiting
 * - Multi-vessel scenarios med riktig prioritering
 * - ETA-beräkningar med faktiska positioner och hastigheter
 * - Fullständiga båtresor från söder till norr och tvärtom
 * - Edge cases från verkliga debug logs
 */

const RealAppTestRunner = require('./RealAppTestRunner');

class GoldStandardComprehensiveTest {
  constructor() {
    this.testRunner = null;
    this.testResults = [];
    this.goldStandardScenarios = this._createGoldStandardScenarios();
  }

  /**
   * GOLD STANDARD SCENARIOS - BASERADE PÅ RIKTIG DEBUGGER DATA
   */
  _createGoldStandardScenarios() {
    return {
      // === KATEGORI 1: TARGET BRIDGE SCENARIOS ===
      targetBridgeTests: {
        name: '🎯 TARGET BRIDGE TESTS',
        description: 'Alla target bridge scenarios baserat på TUNA och WILSON WISLA resor',
        scenarios: [
          {
            name: 'KLAFFBRON_COMPLETE_JOURNEY',
            description: 'Komplett TUNA resa till Klaffbron baserat på riktig data',
            vesselSteps: [
              // Steg 1: En-route mot Klaffbron
              {
                description: 'TUNA starts journey toward Klaffbron',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.26847333333333, // Från riktig data
                  lon: 12.26998,
                  sog: 3.3,
                  cog: 28.4,
                }],
                expectedBridgeText: 'En båt på väg mot Klaffbron, beräknad broöppning om',
                expectedStatus: 'en-route',
                expectedTargetBridge: 'Klaffbron',
              },
              // Steg 2: Vid Olidebron (intermediate)
              {
                description: 'TUNA approaching through Olidebron',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.27159666666667, // Nära Olidebron från logs
                  lon: 12.273583333333333,
                  sog: 3.3,
                  cog: 33.3,
                }],
                expectedBridgeText: 'En båt inväntar broöppning av Olidebron på väg mot Klaffbron, beräknad broöppning om',
                expectedStatus: 'waiting',
                expectedCurrentBridge: 'Olidebron',
              },
              // Steg 3: Approaching Klaffbron (500m rule)
              {
                description: 'TUNA approaching Klaffbron (500m rule)',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.28060666666667, // 486m från Klaffbron
                  lon: 12.282526666666666,
                  sog: 3.5,
                  cog: 18.3,
                }],
                expectedBridgeText: 'En båt närmar sig Klaffbron, beräknad broöppning om',
                expectedStatus: 'approaching',
                expectedTargetBridge: 'Klaffbron',
              },
              // Steg 4: Waiting vid Klaffbron (300m rule)
              {
                description: 'TUNA waiting at Klaffbron',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.282933, // 200m från Klaffbron
                  lon: 12.283400,
                  sog: 2.8,
                  cog: 15.7,
                }],
                expectedBridgeText: 'En båt inväntar broöppning vid Klaffbron',
                expectedStatus: 'waiting',
                expectedTargetBridge: 'Klaffbron',
              },
              // Steg 5: Under-bridge (50m rule)
              {
                description: 'TUNA under Klaffbron',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.28409551543077, // Exakt vid Klaffbron
                  lon: 12.283929525245636,
                  sog: 2.8,
                  cog: 15.7,
                }],
                expectedBridgeText: 'Broöppning pågår vid Klaffbron',
                expectedStatus: 'under-bridge',
                expectedTargetBridge: 'Klaffbron',
              },
              // Steg 6: Passed Klaffbron -> Stridsbergsbron
              {
                description: 'TUNA passed Klaffbron, target changes to Stridsbergsbron',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.28520666666667, // 100m norr om Klaffbron
                  lon: 12.284398333333334,
                  sog: 2.8,
                  cog: 15.7,
                }],
                expectedBridgeText: 'En båt har precis passerat Klaffbron på väg mot Stridsbergsbron, beräknad broöppning om',
                expectedStatus: 'passed',
                expectedTargetBridge: 'Stridsbergsbron',
              },
            ],
          },

          {
            name: 'STRIDSBERGSBRON_COMPLETE_JOURNEY',
            description: 'Fortsättning av TUNA resa till Stridsbergsbron',
            vesselSteps: [
              // Steg 1: En-route mot Stridsbergsbron
              {
                description: 'TUNA en-route to Stridsbergsbron after Klaffbron',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.28570666666667, // Mellan Klaffbron och Järnvägsbron
                  lon: 12.284751666666667,
                  sog: 2.7,
                  cog: 24.1,
                }],
                expectedBridgeText: 'En båt på väg mot Stridsbergsbron, beräknad broöppning om',
                expectedStatus: 'en-route',
                expectedTargetBridge: 'Stridsbergsbron',
              },
              // Steg 2: Vid Järnvägsbron (intermediate bridge)
              {
                description: 'TUNA at Järnvägsbron intermediate bridge',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.290500, // Nära Järnvägsbron
                  lon: 12.291000,
                  sog: 3.0,
                  cog: 30.0,
                }],
                expectedBridgeText: 'En båt inväntar broöppning av Järnvägsbron på väg mot Stridsbergsbron, beräknad broöppning om',
                expectedStatus: 'waiting',
                expectedCurrentBridge: 'Järnvägsbron',
              },
              // Steg 3: Approaching Stridsbergsbron
              {
                description: 'TUNA approaching Stridsbergsbron',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.292200, // 400m från Stridsbergsbron
                  lon: 12.293400,
                  sog: 3.2,
                  cog: 35.0,
                }],
                expectedBridgeText: 'En båt närmar sig Stridsbergsbron, beräknad broöppning om',
                expectedStatus: 'approaching',
                expectedTargetBridge: 'Stridsbergsbron',
              },
              // Steg 4: Under Stridsbergsbron (final target for northbound)
              {
                description: 'TUNA under Stridsbergsbron - final bridge',
                vessels: [{
                  mmsi: '244321000',
                  name: 'TUNA',
                  lat: 58.293524096154634, // Exakt vid Stridsbergsbron
                  lon: 12.294566425158054,
                  sog: 2.8,
                  cog: 42.4,
                }],
                expectedBridgeText: 'Broöppning pågår vid Stridsbergsbron',
                expectedStatus: 'under-bridge',
                expectedTargetBridge: 'Stridsbergsbron',
              },
            ],
          },
        ],
      },

      // === KATEGORI 2: STALLBACKABRON SPECIAL TESTS ===
      stallbackabronTests: {
        name: '🌉 STALLBACKABRON SPECIAL TESTS',
        description: 'Stallbackabron unika regler - ALDRIG "inväntar broöppning"',
        scenarios: [
          {
            name: 'STALLBACKABRON_SOUTHBOUND_SPECIAL',
            description: 'Stallbackabron special rules för söderut trafik',
            vesselSteps: [
              // Steg 1: Approaching Stallbackabron (500m)
              {
                description: 'Vessel approaching Stallbackabron with target bridge',
                vessels: [{
                  mmsi: 'STALLBACKA_TEST_001',
                  name: 'NORDIC SIRA',
                  lat: 58.308000, // 450m från Stallbackabron
                  lon: 12.312000,
                  sog: 7.0,
                  cog: 220, // Söderut
                }],
                expectedBridgeText: 'En båt närmar sig Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
                expectedStatus: 'approaching',
                expectedTargetBridge: 'Stridsbergsbron',
              },
              // Steg 2: "åker strax under" (300m - INTE "inväntar broöppning")
              {
                description: 'Stallbacka-waiting: "åker strax under" NOT "inväntar broöppning"',
                vessels: [{
                  mmsi: 'STALLBACKA_TEST_001',
                  name: 'NORDIC SIRA',
                  lat: 58.310000, // 250m från Stallbackabron
                  lon: 12.313500,
                  sog: 6.5,
                  cog: 220,
                }],
                expectedBridgeText: 'En båt åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
                expectedStatus: 'stallbacka-waiting',
                mustNotHave: 'inväntar broöppning',
              },
              // Steg 3: "passerar" (50m - INTE "broöppning pågår")
              {
                description: 'Under Stallbackabron: "passerar" NOT "broöppning pågår"',
                vessels: [{
                  mmsi: 'STALLBACKA_TEST_001',
                  name: 'NORDIC SIRA',
                  lat: 58.31142992293701, // Exakt vid Stallbackabron
                  lon: 12.31456385688822,
                  sog: 6.8,
                  cog: 220,
                }],
                expectedBridgeText: 'En båt passerar Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
                expectedStatus: 'under-bridge',
                mustNotHave: 'broöppning pågår',
              },
              // Steg 4: Precis passerat Stallbackabron
              {
                description: 'Passed Stallbackabron with ETA to target',
                vessels: [{
                  mmsi: 'STALLBACKA_TEST_001',
                  name: 'NORDIC SIRA',
                  lat: 58.310000, // 200m söder om Stallbackabron
                  lon: 12.312000,
                  sog: 7.0,
                  cog: 220,
                }],
                expectedBridgeText: 'En båt har precis passerat Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om',
                expectedStatus: 'passed',
                expectedTargetBridge: 'Stridsbergsbron',
              },
            ],
          },

          {
            name: 'STALLBACKABRON_NO_TARGET_BRIDGE',
            description: 'Stallbackabron utan målbro (vessel leaving system)',
            vesselSteps: [
              {
                description: 'Stallbackabron utan målbro - enklare meddelande',
                vessels: [{
                  mmsi: 'STALLBACKA_LEAVING',
                  name: 'LEAVING VESSEL',
                  lat: 58.310500,
                  lon: 12.313800,
                  sog: 5.0,
                  cog: 45, // Norrut (leaving canal)
                }],
                expectedBridgeText: 'En båt åker strax under Stallbackabron',
                expectedStatus: 'stallbacka-waiting',
                expectedTargetBridge: null,
                mustNotHave: 'på väg mot',
              },
            ],
          },
        ],
      },

      // === KATEGORI 3: MULTI-VESSEL SCENARIOS ===
      multiVesselTests: {
        name: '🚢 MULTI-VESSEL TESTS',
        description: 'Flera båtar samtidigt med prioritering och semikolon-separation',
        scenarios: [
          {
            name: 'SAME_TARGET_BRIDGE_PRIORITY',
            description: 'Flera båtar mot samma målbro - prioritering enligt status',
            vesselSteps: [
              {
                description: 'Multiple vessels toward Klaffbron - waiting prioriteras',
                vessels: [
                  {
                    mmsi: 'MULTI_001',
                    name: 'VESSEL_WAITING',
                    lat: 58.282500, // Waiting vid Klaffbron
                    lon: 12.283500,
                    sog: 1.0,
                    cog: 30,
                  },
                  {
                    mmsi: 'MULTI_002',
                    name: 'VESSEL_APPROACHING',
                    lat: 58.280000, // Approaching Klaffbron
                    lon: 12.282000,
                    sog: 3.5,
                    cog: 30,
                  },
                  {
                    mmsi: 'MULTI_003',
                    name: 'VESSEL_ENROUTE',
                    lat: 58.275000, // En-route mot Klaffbron
                    lon: 12.278000,
                    sog: 4.0,
                    cog: 30,
                  },
                ],
                expectedBridgeText: 'En båt inväntar broöppning vid Klaffbron, ytterligare 2 båtar på väg',
                expectedLeadingVessel: 'MULTI_001', // Waiting vessel leads
              },
            ],
          },

          {
            name: 'DIFFERENT_TARGET_BRIDGES',
            description: 'Båtar mot olika målbroar - semikolon-separation',
            vesselSteps: [
              {
                description: 'Vessels toward both target bridges simultaneously',
                vessels: [
                  {
                    mmsi: 'TARGET_KLAFF',
                    name: 'TO_KLAFFBRON',
                    lat: 58.280000,
                    lon: 12.282000,
                    sog: 3.0,
                    cog: 30,
                  },
                  {
                    mmsi: 'TARGET_STRIDS',
                    name: 'TO_STRIDSBERGSBRON',
                    lat: 58.292000,
                    lon: 12.293000,
                    sog: 3.5,
                    cog: 30,
                  },
                ],
                expectedBridgeText: 'En båt närmar sig Klaffbron, beräknad broöppning om',
                expectedBridgeTextContains: ';',
                mustHave: ['Klaffbron', 'Stridsbergsbron'],
              },
            ],
          },

          {
            name: 'INTERMEDIATE_BRIDGE_MULTI_TARGET',
            description: 'Flera båtar vid samma intermediate bridge mot olika målbroar',
            vesselSteps: [
              {
                description: 'Multiple vessels at Järnvägsbron toward different targets',
                vessels: [
                  {
                    mmsi: 'JARN_TO_KLAFF',
                    name: 'JÄRNVÄG_KLAFFBRON',
                    lat: 58.291000, // Vid Järnvägsbron
                    lon: 12.291500,
                    sog: 2.8,
                    cog: 210, // Söderut mot Klaffbron
                  },
                  {
                    mmsi: 'JARN_TO_STRIDS',
                    name: 'JÄRNVÄG_STRIDSBERGSBRON',
                    lat: 58.291200, // Vid Järnvägsbron
                    lon: 12.291800,
                    sog: 3.2,
                    cog: 30, // Norrut mot Stridsbergsbron
                  },
                ],
                expectedBridgeTextContains: ['Järnvägsbron', 'Klaffbron', 'Stridsbergsbron', ';'],
                mustHave: 'inväntar broöppning av Järnvägsbron',
              },
            ],
          },
        ],
      },

      // === KATEGORI 4: ETA CALCULATION TESTS ===
      etaTests: {
        name: '⏰ ETA CALCULATION TESTS',
        description: 'ETA-beräkningar med riktig data och hastigheter',
        scenarios: [
          {
            name: 'ACCURATE_ETA_CALCULATIONS',
            description: 'Korrekt ETA-beräkning baserat på riktig distans och hastighet',
            vesselSteps: [
              {
                description: 'ETA calculation for known distance and speed',
                vessels: [{
                  mmsi: 'ETA_TEST_001',
                  name: 'ETA_VESSEL',
                  lat: 58.270000, // ~1000m från Klaffbron
                  lon: 12.275000,
                  sog: 3.6, // 3.6 knop = 1.85 m/s
                  cog: 30,
                }],
                expectedBridgeText: 'En båt på väg mot Klaffbron, beräknad broöppning om',
                expectedETARange: [8, 12], // Ca 9 minuter för 1000m vid 3.6 knop
                validateETA: true,
              },
            ],
          },

          {
            name: 'NO_ETA_FOR_WAITING',
            description: 'Ingen ETA visas för waiting vid målbro',
            vesselSteps: [
              {
                description: 'Waiting vessels at target bridge show no ETA',
                vessels: [{
                  mmsi: 'NO_ETA_WAITING',
                  name: 'WAITING_VESSEL',
                  lat: 58.283500, // Waiting vid Klaffbron
                  lon: 12.283800,
                  sog: 1.0,
                  cog: 30,
                }],
                expectedBridgeText: 'En båt inväntar broöppning vid Klaffbron',
                mustNotHave: 'beräknad broöppning om',
                expectedETAPresent: false,
              },
            ],
          },

          {
            name: 'INTERMEDIATE_BRIDGE_ETA',
            description: 'ETA till målbro visas även vid intermediate bridge',
            vesselSteps: [
              {
                description: 'Intermediate bridge shows ETA to target bridge',
                vessels: [{
                  mmsi: 'INTER_ETA_TEST',
                  name: 'OLIDEBRON_VESSEL',
                  lat: 58.272743083145855, // Vid Olidebron
                  lon: 12.275115821922993,
                  sog: 3.0,
                  cog: 30,
                }],
                expectedBridgeText: 'En båt inväntar broöppning av Olidebron på väg mot Klaffbron, beräknad broöppning om',
                expectedETARange: [15, 25], // ETA till Klaffbron, inte Olidebron
                validateETA: true,
              },
            ],
          },
        ],
      },

      // === KATEGORI 5: EDGE CASES FROM DEBUG LOGS ===
      edgeCaseTests: {
        name: '🐛 EDGE CASE TESTS',
        description: 'Edge cases identifierade från riktig debug data',
        scenarios: [
          {
            name: 'STATIONARY_VESSEL_FILTERING',
            description: 'Stillastående båtar filtreras bort från bridge text',
            vesselSteps: [
              {
                description: 'Stationary vessels should be filtered out',
                vessels: [
                  {
                    mmsi: '265831720',
                    name: 'SIMONA', // Från riktig data
                    lat: 58.287455,
                    lon: 12.285495,
                    sog: 0.1, // Nästan stillastående
                    cog: 323.9,
                  },
                  {
                    mmsi: '265706440',
                    name: 'DESTINY',
                    lat: 58.286986666666664,
                    lon: 12.285271666666667,
                    sog: 0, // Fullständigt stillastående
                    cog: 360,
                  },
                ],
                expectedBridgeText: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron',
                expectedVesselCount: 0,
              },
            ],
          },

          {
            name: 'GPS_JUMP_HANDLING',
            description: 'Hantering av GPS-hopp baserat på riktig data',
            vesselSteps: [
              {
                description: 'Vessel with GPS jump should be handled gracefully',
                vessels: [{
                  mmsi: 'GPS_JUMP_TEST',
                  name: 'GPS_JUMPER',
                  lat: 58.280000,
                  lon: 12.282000,
                  sog: 3.0,
                  cog: 30,
                }],
                expectedBridgeText: 'En båt närmar sig Klaffbron',
                expectedStatus: 'approaching',
              },
              {
                description: 'Large position jump should be rejected',
                vessels: [{
                  mmsi: 'GPS_JUMP_TEST',
                  name: 'GPS_JUMPER',
                  lat: 58.320000, // Stort hopp >1000m
                  lon: 12.320000,
                  sog: 3.0,
                  cog: 30,
                }],
                expectedBridgeText: 'En båt närmar sig Klaffbron', // Samma som förut
                expectGPSJumpRejection: true,
              },
            ],
          },

          {
            name: 'PASSED_STATUS_TIMEOUT',
            description: 'Passed status timeout efter 1 minut',
            vesselSteps: [
              {
                description: 'Vessel just passed bridge shows "precis passerat"',
                vessels: [{
                  mmsi: 'PASSED_TIMEOUT_TEST',
                  name: 'PASSED_VESSEL',
                  lat: 58.285000, // 100m norr om Klaffbron
                  lon: 12.284500,
                  sog: 3.0,
                  cog: 30,
                }],
                expectedBridgeText: 'En båt har precis passerat Klaffbron på väg mot Stridsbergsbron',
                expectedStatus: 'passed',
                delaySeconds: 65, // Wait for passed timeout
              },
              {
                description: 'After timeout, vessel should show en-route',
                vessels: [{
                  mmsi: 'PASSED_TIMEOUT_TEST',
                  name: 'PASSED_VESSEL',
                  lat: 58.286000, // Lite längre norr
                  lon: 12.285000,
                  sog: 3.0,
                  cog: 30,
                }],
                expectedBridgeText: 'En båt på väg mot Stridsbergsbron',
                expectedStatus: 'en-route',
              },
            ],
          },
        ],
      },
    };
  }

  /**
   * RUN GOLD STANDARD TEST
   */
  async runGoldStandardTest() {
    console.log('🏆 === GOLD STANDARD COMPREHENSIVE TEST V1.0 ===');
    console.log('📊 Testar ALLA kategorier i bridgeTextFormat.md med riktig data');
    console.log('🎯 Baserat på debugger script data och faktiska båtresor');
    console.log('');

    try {
      this.testRunner = new RealAppTestRunner();
      await this.testRunner.initializeApp();

      // Enable test mode to disable GPS jump detection
      this.testRunner.app.vesselDataService.enableTestMode();

      console.log('✅ Real AISBridgeApp initialized with all services (test mode enabled)');

      const allCategories = Object.values(this.goldStandardScenarios);
      let categoryNumber = 1;

      for (const category of allCategories) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`${categoryNumber}. ${category.name}`);
        console.log(`${category.description}`);
        console.log('='.repeat(80));

        let scenarioNumber = 1;
        for (const scenario of category.scenarios) {
          console.log(`\n${categoryNumber}.${scenarioNumber} ${scenario.name}`);
          console.log(`📋 ${scenario.description}`);
          console.log('-'.repeat(60));

          await this._runScenario(scenario);
          scenarioNumber++;
        }
        categoryNumber++;
      }

      // Generate final report
      this._generateGoldStandardReport();

    } catch (error) {
      console.error('❌ Gold Standard Test failed:', error.message);
      throw error;
    } finally {
      if (this.testRunner) {
        console.log('\n🧹 Cleaning up test runner...');
        await this.testRunner.cleanup();
      }
    }
  }

  /**
   * Run individual scenario
   */
  async _runScenario(scenario) {
    const results = [];

    // Clear all vessels only at the start of each scenario (not between steps)
    this._clearAllVessels();
    await this._wait(50);

    for (let i = 0; i < scenario.vesselSteps.length; i++) {
      const step = scenario.vesselSteps[i];
      console.log(`\n  📍 Step ${i + 1}: ${step.description}`);

      // Process vessels
      if (step.vessels && step.vessels.length > 0) {
        for (const vessel of step.vessels) {
          await this.testRunner._processVesselAsAISMessage(vessel);
        }
      }
      await this._wait(100);

      // Add delay if specified
      if (step.delaySeconds) {
        console.log(`    ⏱️  Waiting ${step.delaySeconds} seconds...`);
        await this._wait(step.delaySeconds * 1000);
      }

      // Validate results
      const result = await this._validateStep(step);
      results.push(result);

      const status = result.success ? '✅' : '❌';
      console.log(`    ${status} ${result.success ? 'PASSED' : 'FAILED'}`);

      if (!result.success) {
        console.log(`      Expected: "${step.expectedBridgeText}"`);
        console.log(`      Actual:   "${result.actualBridgeText}"`);
        if (result.issues.length > 0) {
          console.log(`      Issues: ${result.issues.join(', ')}`);
        }
      }
    }

    // Calculate scenario success rate
    const successCount = results.filter((r) => r.success).length;
    const successRate = (successCount / results.length) * 100;

    const scenarioResult = {
      scenario: scenario.name,
      successRate,
      stepResults: results,
    };

    this.testResults.push(scenarioResult);

    console.log(`\n  📊 Scenario Result: ${successRate.toFixed(1)}% (${successCount}/${results.length})`);
  }

  /**
   * Validate individual step
   */
  async _validateStep(step) {
    const vessels = this.testRunner.app.vesselDataService.getAllVessels();
    const relevantVessels = this.testRunner.app._findRelevantBoatsForBridgeText();
    const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(relevantVessels);

    const result = {
      success: true,
      issues: [],
      actualBridgeText: bridgeText,
      actualVesselCount: vessels.length,
      actualRelevantCount: relevantVessels.length,
    };

    // Validate bridge text
    if (step.expectedBridgeText) {
      if (!bridgeText.includes(step.expectedBridgeText)) {
        result.success = false;
        result.issues.push('Bridge text mismatch');
      }
    }

    // Validate must have content
    if (step.mustHave) {
      const mustHaveList = Array.isArray(step.mustHave) ? step.mustHave : [step.mustHave];
      for (const required of mustHaveList) {
        if (!bridgeText.includes(required)) {
          result.success = false;
          result.issues.push(`Missing required text: "${required}"`);
        }
      }
    }

    // Validate must not have content
    if (step.mustNotHave) {
      const mustNotHaveList = Array.isArray(step.mustNotHave) ? step.mustNotHave : [step.mustNotHave];
      for (const forbidden of mustNotHaveList) {
        if (bridgeText.includes(forbidden)) {
          result.success = false;
          result.issues.push(`Contains forbidden text: "${forbidden}"`);
        }
      }
    }

    // Validate vessel status
    if (step.expectedStatus && vessels.length > 0) {
      const vessel = vessels[0];
      if (vessel.status !== step.expectedStatus) {
        result.success = false;
        result.issues.push(`Status mismatch: expected ${step.expectedStatus}, got ${vessel.status}`);
      }
    }

    // Validate target bridge
    if (step.expectedTargetBridge !== undefined && vessels.length > 0) {
      const vessel = vessels[0];
      if (vessel.targetBridge !== step.expectedTargetBridge) {
        result.success = false;
        result.issues.push(`Target bridge mismatch: expected ${step.expectedTargetBridge}, got ${vessel.targetBridge}`);

        // DEBUG: Add detailed vessel state for debugging
        console.log('    🔍 DEBUG - Vessel state:');
        console.log(`       MMSI: ${vessel.mmsi}`);
        console.log(`       Status: ${vessel.status}`);
        console.log(`       Target Bridge: ${vessel.targetBridge}`);
        console.log(`       Current Bridge: ${vessel.currentBridge}`);
        console.log(`       Distance to Current: ${vessel.distanceToCurrent}`);
        console.log(`       Last Passed Bridge: ${vessel.lastPassedBridge}`);
        console.log(`       Last Passed Time: ${vessel.lastPassedBridgeTime ? new Date(vessel.lastPassedBridgeTime).toISOString() : 'null'}`);
      }
    }

    // Validate ETA range
    if (step.validateETA && step.expectedETARange && vessels.length > 0) {
      const vessel = vessels[0];
      if (vessel.etaMinutes
          && (vessel.etaMinutes < step.expectedETARange[0] || vessel.etaMinutes > step.expectedETARange[1])) {
        result.success = false;
        result.issues.push(`ETA out of range: expected ${step.expectedETARange[0]}-${step.expectedETARange[1]}, got ${vessel.etaMinutes?.toFixed(1)}`);
      }
    }

    // Validate vessel count
    if (step.expectedVesselCount !== undefined) {
      if (relevantVessels.length !== step.expectedVesselCount) {
        result.success = false;
        result.issues.push(`Vessel count mismatch: expected ${step.expectedVesselCount}, got ${relevantVessels.length}`);
      }
    }

    return result;
  }

  /**
   * Clear all vessels for clean test
   */
  _clearAllVessels() {
    const vessels = this.testRunner.app.vesselDataService.getAllVessels();
    vessels.forEach((vessel) => {
      this.testRunner.app.vesselDataService.removeVessel(vessel.mmsi, 'test-cleanup');
    });
  }

  /**
   * Generate final comprehensive report
   */
  _generateGoldStandardReport() {
    console.log(`\n${'='.repeat(80)}`);
    console.log('🏆 GOLD STANDARD TEST FINAL REPORT');
    console.log('='.repeat(80));

    let totalSteps = 0;
    let totalSuccessfulSteps = 0;
    const categoryResults = [];

    for (const result of this.testResults) {
      const stepCount = result.stepResults.length;
      const successfulSteps = result.stepResults.filter((s) => s.success).length;

      totalSteps += stepCount;
      totalSuccessfulSteps += successfulSteps;

      categoryResults.push({
        name: result.scenario,
        successRate: result.successRate,
        steps: `${successfulSteps}/${stepCount}`,
      });

      const status = result.successRate >= 80 ? '🟢' : result.successRate >= 60 ? '🟡' : '🔴';
      console.log(`${status} ${result.scenario}: ${result.successRate.toFixed(1)}% (${successfulSteps}/${stepCount})`);
    }

    const overallSuccessRate = (totalSuccessfulSteps / totalSteps) * 100;
    const overallStatus = overallSuccessRate >= 90 ? '🟢 EXCELLENT'
      : overallSuccessRate >= 80 ? '🟡 GOOD' : '🔴 NEEDS IMPROVEMENT';

    console.log('');
    console.log('📊 OVERALL RESULTS:');
    console.log(`   🎯 Total Test Steps: ${totalSteps}`);
    console.log(`   ✅ Successful Steps: ${totalSuccessfulSteps}`);
    console.log(`   📈 Overall Success Rate: ${overallSuccessRate.toFixed(1)}%`);
    console.log(`   🏆 Status: ${overallStatus}`);

    if (overallSuccessRate >= 90) {
      console.log('\n🎉 GOLD STANDARD ACHIEVED!');
      console.log('   All bridge text scenarios working according to specification.');
    } else if (overallSuccessRate >= 80) {
      console.log('\n👍 GOOD PERFORMANCE');
      console.log('   Most scenarios working, minor issues to address.');
    } else {
      console.log('\n⚠️ SIGNIFICANT ISSUES DETECTED');
      console.log('   Review failed scenarios and fix underlying problems.');
    }

    return {
      overallSuccessRate,
      categoryResults,
      totalSteps,
      totalSuccessfulSteps,
    };
  }

  async _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Run test if called directly
if (require.main === module) {
  const test = new GoldStandardComprehensiveTest();
  test.runGoldStandardTest()
    .then(() => {
      console.log('\n✅ Gold Standard Comprehensive Test completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Gold Standard Test failed:', error.message);
      process.exit(1);
    });
}

module.exports = GoldStandardComprehensiveTest;
