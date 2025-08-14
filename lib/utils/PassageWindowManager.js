'use strict';

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
   * Get display window for "precis passerat" messages
   * @returns {number} Always returns 60000ms (1 minute) per specification
   */
  getDisplayWindow() {
    return 60000; // Always 1 minute for user display
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
        '⏱️ [PASSAGE_WINDOW] Invalid vessel or speed data - using default 1 min grace period',
      );
      return 60000; // Default to 1 minute
    }

    const speed = Math.max(vessel.sog, 0); // Ensure non-negative

    // Smart speed-based logic for internal operations
    // Fast boats need more time before target bridge changes
    if (speed > 5) {
      this.logger.debug(
        `⏱️ [PASSAGE_WINDOW] Fast vessel ${vessel?.mmsi} (${speed.toFixed(1)}kn) - using 2 min internal grace period`,
      );
      return 120000; // 2 minutes for fast boats
    }
    this.logger.debug(
      `⏱️ [PASSAGE_WINDOW] Slow vessel ${vessel?.mmsi} (${speed.toFixed(1)}kn) - using 1 min internal grace period`,
    );
    return 60000; // 1 minute for slow boats

  }

  /**
   * Calculate dynamic passage window based on bridge distances
   * Advanced calculation for intelligent timing
   * @param {Object} vessel - Vessel object
   * @param {string} fromBridge - Bridge just passed
   * @param {string} toBridge - Target bridge
   * @returns {number} Dynamic window in milliseconds
   */
  getDynamicPassageWindow(vessel, fromBridge, toBridge) {
    try {
      // CRITICAL FIX: Validate vessel and speed data
      if (!vessel || !Number.isFinite(vessel.sog) || vessel.sog < 0) {
        this.logger.debug(
          '⚠️ [PASSAGE_WINDOW] Invalid vessel speed data - using fallback',
        );
        return this.getInternalGracePeriod(vessel);
      }

      const speed = Math.max(vessel.sog, 0.5); // Minimum 0.5kn to avoid division by zero

      if (!fromBridge || !toBridge || typeof fromBridge !== 'string' || typeof toBridge !== 'string') {
        // Fallback to internal grace period
        return this.getInternalGracePeriod(vessel);
      }

      // Convert bridge names to IDs for consistent lookup
      const fromBridgeId = this.bridgeRegistry?.findBridgeIdByName?.(fromBridge);
      const toBridgeId = this.bridgeRegistry?.findBridgeIdByName?.(toBridge);

      if (!fromBridgeId || !toBridgeId) {
        this.logger.debug(
          `⚠️ [PASSAGE_WINDOW] Could not find bridge IDs - from: ${fromBridge}/${fromBridgeId}, to: ${toBridge}/${toBridgeId} - using fallback`,
        );
        return this.getInternalGracePeriod(vessel);
      }

      // Get distance between bridges
      const gap = this.bridgeRegistry?.getDistanceBetweenBridges?.(fromBridgeId, toBridgeId) || 800;

      // Calculate realistic travel time + safety margin
      const speedMps = (speed * 1852) / 3600; // Convert knots to m/s
      const travelTimeMs = (gap / speedMps) * 1000; // Travel time in milliseconds
      const timeWindow = travelTimeMs * 1.5; // Add 50% safety margin

      // Enforce reasonable bounds: minimum 90s (1.5min), maximum 300s (5min)
      const boundedWindow = Math.min(Math.max(timeWindow, 90000), 300000);

      this.logger.debug(
        `🕒 [PASSAGE_WINDOW] Dynamic calculation for ${vessel?.mmsi}: ${fromBridge}-${toBridge} gap=${gap}m, `
        + `speed=${speed.toFixed(1)}kn, window=${(boundedWindow / 1000).toFixed(1)}s`,
      );

      return boundedWindow;
    } catch (error) {
      this.logger.error(
        `⚠️ [PASSAGE_WINDOW] Dynamic calculation failed for ${vessel?.mmsi}:`,
        error.message,
      );
      return this.getInternalGracePeriod(vessel);
    }
  }

  /**
   * Determine if vessel should show "precis passerat" message
   * Uses display window (60s) for user-facing decisions
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
