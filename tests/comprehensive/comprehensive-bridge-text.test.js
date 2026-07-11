'use strict';

/**
 * COMPREHENSIVE BRIDGE TEXT TEST SUITE
 *
 * This test suite validates ALL bridge text scenarios using:
 * - Real app logic (via RealAppTestRunner) - NO mock logic
 * - Golden snapshots (pre-generated expected outputs)
 * - 20 curated scenarios covering all critical paths
 * - Sequential execution (no parallelism to avoid race conditions)
 * - Fail-fast on first mismatch with detailed diff
 *
 * TEST COVERAGE:
 * - Core Journeys (4): Complete canal passages N→S and S→N
 * - Status Transitions (6): Critical state changes and boundaries
 * - Multi-Vessel (5): 2-5 boats in various configurations
 * - Edge Cases (5): Boundary conditions and special scenarios
 *
 * TOTAL: 20 scenarios covering 53 individual waypoints
 */

const fs = require('fs');
const path = require('path');
const RealAppTestRunner = require('../journey-scenarios/RealAppTestRunner');
const ScenarioLibrary = require('./ScenarioLibrary');
const JourneyTestRunner = require('./JourneyTestRunner');

describe('🎬 COMPREHENSIVE BRIDGE TEXT TEST SUITE', () => {
  let realAppRunner;
  let journeyRunner;
  let scenarios;
  let goldenSnapshots;

  beforeAll(async () => {
    console.log(`\n${'='.repeat(80)}`);
    console.log('🎯 COMPREHENSIVE BRIDGE TEXT TEST SUITE');
    console.log(`${'='.repeat(80)}`);
    console.log('Testing bridge text generation with REAL app logic');
    console.log('All scenarios use golden snapshots for expected outputs');
    console.log(`${'='.repeat(80)}\n`);

    // Validate scenarios
    console.log('🔍 Validating scenarios...');
    ScenarioLibrary.validate();

    // Load curated scenarios
    scenarios = ScenarioLibrary.getAll();
    console.log(`✅ Loaded ${scenarios.length} scenarios\n`);

    // Load golden snapshots
    const snapshotPath = path.join(__dirname, 'golden-snapshots.json');

    if (!fs.existsSync(snapshotPath)) {
      throw new Error(
        '\n❌ Golden snapshots not found!\n\n'
        + 'Please generate golden snapshots first by running:\n'
        + '  node tests/comprehensive/generate-snapshots.js\n',
      );
    }

    goldenSnapshots = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    console.log(`📸 Loaded golden snapshots for ${Object.keys(goldenSnapshots).length} scenarios\n`);

    // Verify all scenarios have snapshots
    for (const scenario of scenarios) {
      if (!goldenSnapshots[scenario.name]) {
        throw new Error(
          `Missing golden snapshot for scenario: "${scenario.name}"\n`
          + 'Please regenerate golden snapshots.',
        );
      }
    }

    // Initialize real app runner
    console.log('🚀 Initializing real app environment...');
    realAppRunner = new RealAppTestRunner();
    await realAppRunner.initializeApp();
    console.log('✅ App initialized\n');

    // Initialize journey runner
    journeyRunner = new JourneyTestRunner(realAppRunner);

    console.log(`${'='.repeat(80)}`);
    console.log('🎬 STARTING TESTS');
    console.log(`${'='.repeat(80)}\n`);
  }, 60000); // 60s timeout for initialization

  afterAll(async () => {
    console.log(`\n${'='.repeat(80)}`);
    console.log('🧹 Cleaning up...');
    await realAppRunner?.cleanup();
    console.log('✅ Cleanup complete');
    console.log(`${'='.repeat(80)}\n`);
  });

  // IMPORTANT: Run tests sequentially, not in parallel
  // Using for-loop instead of test.each to ensure sequential execution
  // This prevents RealAppTestRunner from being called concurrently

  describe('🌉 Core Journeys (Complete Canal Passages)', () => {
    const coreJourneys = ScenarioLibrary.getAll().filter((s) => s.name.startsWith('Journey'));

    for (const scenario of coreJourneys) {
      test(scenario.name, async () => {
        const snapshot = goldenSnapshots[scenario.name];
        await journeyRunner.runJourney(scenario, snapshot);
      }, 30000); // 30s timeout per journey
    }
  });

  describe('🔄 Status Transitions (Critical State Changes)', () => {
    const transitionPrefixes = [
      'Transition',
      'Stallbackabron',
      'Intermediate bridge',
    ];
    const transitions = ScenarioLibrary.getAll().filter(
      (s) => transitionPrefixes.some((prefix) => s.name.startsWith(prefix)),
    );

    for (const scenario of transitions) {
      test(scenario.name, async () => {
        const snapshot = goldenSnapshots[scenario.name];
        await journeyRunner.runJourney(scenario, snapshot);
      }, 30000);
    }
  });

  describe('🚢 Multi-Vessel Scenarios (2-5 Boats)', () => {
    const multiVessel = ScenarioLibrary.getAll().filter((s) => s.name.startsWith('Multi'));

    for (const scenario of multiVessel) {
      test(scenario.name, async () => {
        const snapshot = goldenSnapshots[scenario.name];
        await journeyRunner.runJourney(scenario, snapshot);
      }, 30000);
    }
  });

  describe('⚠️ Edge Cases (Boundary Conditions)', () => {
    const edgeCases = ScenarioLibrary.getAll().filter((s) => s.name.startsWith('Edge'));

    for (const scenario of edgeCases) {
      test(scenario.name, async () => {
        const snapshot = goldenSnapshots[scenario.name];
        await journeyRunner.runJourney(scenario, snapshot);
      }, 30000);
    }
  });

  // Summary test to report total coverage
  test('📊 Test suite summary', () => {
    const totalScenarios = scenarios.length;
    const totalWaypoints = scenarios.reduce((sum, s) => sum + s.waypoints.length, 0);
    const totalUpdates = journeyRunner.getUpdateCount();

    console.log(`\n${'='.repeat(80)}`);
    console.log('📊 TEST SUITE SUMMARY');
    console.log(`${'='.repeat(80)}`);
    console.log(`✅ Total scenarios tested: ${totalScenarios}`);
    console.log(`✅ Total waypoints validated: ${totalWaypoints}`);
    console.log(`✅ Total bridge text updates: ${totalUpdates}`);
    console.log(`${'='.repeat(80)}\n`);

    // ChatGPT-granskning 2 (CG2-20, 2026-07-11): assertera bara på tillstånd
    // testet själv härleder (scenarios via beforeAll). totalUpdates muteras av
    // SYSKONTESTERNA (runJourney-räknaren) — en assertion på den gjorde sviten
    // ordningsberoende (skulle falla under `jest --randomize` när
    // sammanfattningen råkar köras först). Räknaren behålls som informativ
    // loggrad ovan; scenariernas faktiska täckning bevisas av golden-
    // snapshot-jämförelserna i respektive test.
    expect(totalScenarios).toBeGreaterThan(0);
    expect(totalWaypoints).toBeGreaterThan(0);
  });
});
