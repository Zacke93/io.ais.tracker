#!/usr/bin/env node
'use strict';

/**
 * GOLDEN SNAPSHOT GENERATOR SCRIPT
 *
 * This script generates golden snapshots by running real app logic ONCE.
 * Run this script whenever:
 * - Setting up tests for the first time
 * - App bridge text logic changes intentionally
 * - Adding new scenarios to ScenarioLibrary
 *
 * USAGE:
 *   node tests/comprehensive/generate-snapshots.js
 *
 * OUTPUT:
 *   tests/comprehensive/golden-snapshots.json
 */

const path = require('path');
const RealAppTestRunner = require('../journey-scenarios/RealAppTestRunner');
const ScenarioLibrary = require('./ScenarioLibrary');
const GoldenSnapshotGenerator = require('./GoldenSnapshotGenerator');

async function main() {
  console.log('\n🎬 GOLDEN SNAPSHOT GENERATOR');
  console.log('='.repeat(80));
  console.log('This script will generate expected bridge text outputs by running');
  console.log('the REAL app logic. These outputs will be frozen as "golden snapshots"');
  console.log('for regression testing.');
  console.log('='.repeat(80));

  let runner;
  let exitCode = 0;

  try {
    // Validate scenarios first
    console.log('\n🔍 Validating scenarios...');
    ScenarioLibrary.validate();

    // Load all scenarios
    const scenarios = ScenarioLibrary.getAll();
    console.log(`✅ Loaded ${scenarios.length} scenarios`);

    // Initialize real app runner
    console.log('\n🚀 Initializing real app environment...');
    runner = new RealAppTestRunner();
    await runner.initializeApp();
    console.log('✅ App initialized');

    // Generate snapshots
    const generator = new GoldenSnapshotGenerator(runner);
    const snapshots = await generator.generateSnapshots(scenarios);

    // Validate snapshots
    generator.validate(snapshots);

    // Save to file
    const outputPath = path.join(__dirname, 'golden-snapshots.json');
    generator.saveToFile(snapshots, outputPath);

    console.log('\n='.repeat(80));
    console.log('✅ SUCCESS!');
    console.log('='.repeat(80));
    console.log('\nGolden snapshots have been generated and saved.');
    console.log('\nNext steps:');
    console.log('  1. Review golden-snapshots.json to ensure outputs look correct');
    console.log('  2. Commit golden-snapshots.json to git');
    console.log('  3. Run tests: npm test tests/comprehensive');
    console.log('');

  } catch (error) {
    console.error('\n❌ ERROR GENERATING SNAPSHOTS');
    console.error('='.repeat(80));
    console.error(error.message);
    console.error('\nStack trace:');
    console.error(error.stack);
    console.error('='.repeat(80));
    exitCode = 1;

  } finally {
    // Cleanup
    if (runner) {
      console.log('\n🧹 Cleaning up...');
      await runner.cleanup();
      console.log('✅ Cleanup complete');
    }
  }

  process.exit(exitCode);
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = main;
