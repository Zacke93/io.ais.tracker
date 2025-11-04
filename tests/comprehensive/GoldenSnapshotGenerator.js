'use strict';

const fs = require('fs');
const path = require('path');

/**
 * GoldenSnapshotGenerator - Creates frozen expected outputs by running real app logic
 *
 * PURPOSE:
 * - Generate expected bridge text by running ACTUAL app logic (not hardcoded strings)
 * - Freeze these outputs as "golden snapshots" for regression testing
 * - Eliminates double maintenance (updating both app logic AND test expectations)
 *
 * USAGE:
 * 1. Run generate-snapshots.js script ONCE to create golden-snapshots.json
 * 2. Commit golden-snapshots.json to git
 * 3. Tests compare against these frozen snapshots
 * 4. If app logic changes intentionally, regenerate snapshots
 */
class GoldenSnapshotGenerator {
  constructor(realAppRunner) {
    this.runner = realAppRunner;
  }

  /**
   * Generate golden snapshots for all scenarios
   * @param {Array} scenarios - Scenarios from ScenarioLibrary
   * @returns {Object} Map of scenario name → waypoint snapshots
   */
  async generateSnapshots(scenarios) {
    console.log('\n📸 GENERATING GOLDEN SNAPSHOTS');
    console.log('='.repeat(80));
    console.log(`Processing ${scenarios.length} scenarios...`);
    console.log('This may take a few minutes...\n');

    const snapshots = {};
    let totalWaypoints = 0;

    for (const scenario of scenarios) {
      console.log(`📸 ${scenario.name}`);

      const waypointSnapshots = [];

      for (const waypoint of scenario.waypoints) {
        totalWaypoints++;

        // Run REAL app logic to get bridge text
        const bridgeText = await this.runner.generateBridgeTextFromVessels(waypoint.vessels);

        // Freeze this output
        waypointSnapshots.push({
          step: waypoint.step,
          description: waypoint.description,
          expectedText: bridgeText,
        });

        // Progress indicator
        process.stdout.write('.');
      }

      process.stdout.write(' ✓\n');

      snapshots[scenario.name] = waypointSnapshots;
    }

    console.log('\n='.repeat(80));
    console.log(`✅ Generated ${totalWaypoints} waypoint snapshots across ${scenarios.length} scenarios`);

    return snapshots;
  }

  /**
   * Save snapshots to file
   * @param {Object} snapshots - Generated snapshots
   * @param {string} outputPath - Path to save snapshots
   */
  saveToFile(snapshots, outputPath) {
    const dir = path.dirname(outputPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write snapshots with pretty formatting
    fs.writeFileSync(
      outputPath,
      JSON.stringify(snapshots, null, 2),
      'utf8',
    );

    console.log(`💾 Snapshots saved to: ${outputPath}`);
    console.log(`📊 File size: ${this._formatBytes(fs.statSync(outputPath).size)}`);
  }

  /**
   * Format bytes for human-readable output
   * @private
   */
  _formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Validate snapshots (sanity check)
   * @param {Object} snapshots - Generated snapshots
   */
  validate(snapshots) {
    console.log('\n🔍 Validating snapshots...');

    let totalSnapshots = 0;
    const bridgeTextPatterns = [];

    for (const [scenarioName, waypointSnapshots] of Object.entries(snapshots)) {
      if (!Array.isArray(waypointSnapshots)) {
        throw new Error(`Invalid snapshot for scenario "${scenarioName}": not an array`);
      }

      for (const snapshot of waypointSnapshots) {
        totalSnapshots++;

        // Validate structure
        if (!snapshot.step || !snapshot.description || snapshot.expectedText === undefined) {
          throw new Error(
            `Invalid snapshot in scenario "${scenarioName}": ` +
            `missing required fields (step, description, expectedText)`,
          );
        }

        // Validate bridge text is string
        if (typeof snapshot.expectedText !== 'string') {
          throw new Error(
            `Invalid snapshot in scenario "${scenarioName}" step ${snapshot.step}: ` +
            `expectedText must be string, got ${typeof snapshot.expectedText}`,
          );
        }

        // Collect unique bridge texts
        if (!bridgeTextPatterns.includes(snapshot.expectedText)) {
          bridgeTextPatterns.push(snapshot.expectedText);
        }
      }
    }

    console.log(`✅ Validated ${totalSnapshots} snapshots`);
    console.log(`📋 Found ${bridgeTextPatterns.length} unique bridge text patterns`);
    console.log('\n🎯 Sample bridge texts:');
    bridgeTextPatterns.slice(0, 5).forEach((text, i) => {
      console.log(`  ${i + 1}. "${text}"`);
    });
    if (bridgeTextPatterns.length > 5) {
      console.log(`  ... and ${bridgeTextPatterns.length - 5} more`);
    }
  }
}

module.exports = GoldenSnapshotGenerator;
