'use strict';

const { PASSAGE_TIMING } = require('../constants');

/**
 * PassageWindowManager - Centralized management of passage windows and grace periods
 *
 * This manager separates display logic (what users see) from internal system logic
 * to ensure stable operation while adhering to specifications.
 */
class PassageWindowManager {
  constructor(logger, bridgeRegistry) {
    this.logger = logger;
    this.bridgeRegistry = bridgeRegistry;
  }

  /**
   * Get display window for passage-related messages (Phase 3 opening + Phase 4 passed)
   * @returns {number} Combined display window in milliseconds (150s / 2.5 min)
   */
  getDisplayWindow() {
    return PASSAGE_TIMING.PASSED_HOLD_MS;
  }

  /**
   * Get internal grace period for system logic (target bridge changes, etc.)
   * Uses speed-based logic for system stability
   * @param {Object} vessel - Vessel object with SOG
   * @returns {number} Grace period in milliseconds
   */
  getInternalGracePeriod(vessel) {
    // CRITICAL FIX: Validate vessel object and speed data
    if (!vessel || typeof vessel.sog !== 'number' || !Number.isFinite(vessel.sog)) {
      this.logger.debug(
        '⏱️ [PASSAGE_WINDOW] Invalid vessel or speed data - using default 3 min grace period',
      );
      return PASSAGE_TIMING.FAST_VESSEL_PASSED_WINDOW; // Default for system stability
    }

    const speed = Math.max(vessel.sog, 0); // Ensure non-negative

    // Internal grace periods are separate from display windows.
    // System logic needs longer windows for target bridge transitions.
    // B8-städning (2026-06-09): snabb/långsam-grenarna returnerade samma
    // konstant (avsiktligt: systemstabilitet > visningsfönster) — förenklad
    // till en gren så koden inte ger sken av fartberoende som inte finns.
    this.logger.debug(
      `⏱️ [PASSAGE_WINDOW] Vessel ${vessel?.mmsi} (${speed.toFixed(1)}kn) - using 3 min internal grace period`,
    );
    return PASSAGE_TIMING.FAST_VESSEL_PASSED_WINDOW;
  }

  /**
   * Determine if vessel should show "precis passerat" message
   * Uses display window (PASSED_HOLD_MS, 150 s / 2,5 min) for user-facing decisions
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if recently passed message should be shown
   */
  shouldShowRecentlyPassed(vessel) {
    if (!vessel?.lastPassedBridgeTime || !vessel?.lastPassedBridge) {
      return false;
    }

    const displayWindow = this.getDisplayWindow();
    const timeSincePassed = Date.now() - vessel.lastPassedBridgeTime;
    const shouldShow = timeSincePassed <= displayWindow;

    if (shouldShow) {
      this.logger.debug(
        `✅ [PASSAGE_WINDOW] Vessel ${vessel.mmsi} recently passed ${vessel.lastPassedBridge} `
        + `(${(timeSincePassed / 1000).toFixed(1)}s ago) - showing "precis passerat"`,
      );
    }

    return shouldShow;
  }

  /**
   * Check if vessel is within internal grace period (for system logic)
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if within grace period
   */
  isWithinInternalGracePeriod(vessel) {
    if (!vessel?.lastPassedBridgeTime) {
      return false;
    }

    const gracePeriod = this.getInternalGracePeriod(vessel);
    const timeSincePassed = Date.now() - vessel.lastPassedBridgeTime;

    return timeSincePassed <= gracePeriod;
  }
}

module.exports = PassageWindowManager;
