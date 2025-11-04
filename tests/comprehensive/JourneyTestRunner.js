'use strict';

/**
 * JourneyTestRunner - Visual journey test execution with emoji output
 *
 * PURPOSE:
 * - Executes test journeys sequentially (no parallel execution)
 * - Provides clear, concise, chronological console output
 * - Fails fast on first mismatch with detailed diff
 * - Uses emoji indicators for quick visual scanning
 *
 * EMOJI LEGEND:
 * ⚪ No vessels (default message)
 * 🟢 Under-bridge (opening in progress)
 * 🟡 Waiting (awaiting opening)
 * 🔵 Just passed (recently passed bridge)
 * 🟠 Approaching (getting close)
 * 🟣 Stallbackabron special messages
 * 🎯 Other scenarios
 */
class JourneyTestRunner {
  constructor(realAppRunner) {
    this.testRunner = realAppRunner;
    this.updateCounter = 0;
  }

  /**
   * Run a complete journey scenario
   * @param {Object} scenario - Scenario from ScenarioLibrary
   * @param {Array} goldenSnapshot - Expected outputs for this scenario
   */
  async runJourney(scenario, goldenSnapshot) {
    console.log(`\nScenario: ${scenario.name}`);

    // IMPORTANT: Sequential execution (no Promise.all)
    // This ensures RealAppTestRunner is not called in parallel
    for (const waypoint of scenario.waypoints) {
      this.updateCounter++;

      // Run real app logic
      const actualText = await this.testRunner.generateBridgeTextFromVessels(waypoint.vessels);

      // Get frozen expected text from golden snapshot
      const snapshotMatch = goldenSnapshot.find((s) => s.step === waypoint.step);

      if (!snapshotMatch) {
        throw new Error(
          `\n❌ SNAPSHOT ERROR: No golden snapshot found for step ${waypoint.step}\n` +
          `Scenario: ${scenario.name}\n` +
          `Description: ${waypoint.description}`,
        );
      }

      const expectedText = snapshotMatch.expectedText;

      // Concise visual output with emoji and nearest bridge info
      const emoji = this._getEmoji(actualText);
      const nearest = this.testRunner.getCurrentNearestBridgeInfo?.() || {};
      const nearestLabel = nearest.name
        ? `${nearest.name}${nearest.distance != null ? ` ${nearest.distance}m` : ''}`
        : 'n/a';
      console.log(`${emoji} Update #${this.updateCounter}: "${actualText}" (Nearest: ${nearestLabel})`);

      // Fail fast on mismatch
      if (actualText !== expectedText) {
        this._throwMismatchError(scenario, waypoint, expectedText, actualText);
      }
    }

    console.log(`  ✓ Completed (${scenario.waypoints.length} updates)\n`);
  }

  /**
   * Get emoji indicator for bridge text
   * @private
   * @param {string} text - Bridge text message
   * @returns {string} Emoji character
   */
  _getEmoji(text) {
    if (text.includes('Inga båtar')) return '⚪';
    if (text.includes('Broöppning pågår')) return '🟢';
    if (text.includes('inväntar broöppning')) return '🟡';
    if (text.includes('har precis passerat')) return '🔵';
    if (text.includes('närmar sig')) return '🟠';
    if (text.includes('passerar Stallbacka') || text.includes('åker strax under')) return '🟣';
    return '🎯';
  }

  /**
   * Throw detailed mismatch error
   * @private
   */
  _throwMismatchError(scenario, waypoint, expected, actual) {
    // Calculate diff for better visualization
    const diff = this._calculateDiff(expected, actual);

    throw new Error(
      `\n${'='.repeat(80)}\n` +
      `❌ BRIDGE TEXT MISMATCH\n` +
      `${'='.repeat(80)}\n\n` +
      `Scenario: ${scenario.name}\n` +
      `Step: ${waypoint.step}\n` +
      `Description: ${waypoint.description}\n\n` +
      `Expected:\n  "${expected}"\n\n` +
      `Got:\n  "${actual}"\n\n` +
      `Diff:\n${diff}\n\n` +
      `Vessel state:\n${JSON.stringify(waypoint.vessels, null, 2)}\n` +
      `${'='.repeat(80)}`,
    );
  }

  /**
   * Calculate simple character-level diff
   * @private
   */
  _calculateDiff(expected, actual) {
    const maxLen = Math.max(expected.length, actual.length);
    const lines = [];

    lines.push('  Expected: ' + expected);
    lines.push('  Actual:   ' + actual);
    lines.push('  Diff:     ' + this._createDiffLine(expected, actual));

    return lines.join('\n');
  }

  /**
   * Create diff indicator line
   * @private
   */
  _createDiffLine(expected, actual) {
    let diff = '';
    const maxLen = Math.max(expected.length, actual.length);

    for (let i = 0; i < maxLen; i++) {
      if (expected[i] !== actual[i]) {
        diff += '^';
      } else {
        diff += ' ';
      }
    }

    return diff;
  }

  /**
   * Reset update counter
   */
  reset() {
    this.updateCounter = 0;
  }

  /**
   * Get current update count
   */
  getUpdateCount() {
    return this.updateCounter;
  }
}

module.exports = JourneyTestRunner;
