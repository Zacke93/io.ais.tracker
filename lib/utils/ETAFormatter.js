'use strict';

const {
  isValidETA, formatETA,
  isValidVesselCoordinates, isValidSpeed, safeDivision, isValidDistance,
} = require('./etaValidation');
const geometry = require('./geometry');

/**
 * ETAFormatter - Unified ETA formatting and calculation
 * Consolidates _formatETA and _formatPassedETA into single formatter
 *
 * REFACTORING: Eliminates duplication between two ETA functions
 * BEFORE: _formatETA (16 lines) + _formatPassedETA (87 lines) = 103 lines with overlap
 * AFTER: Single unified formatter (~90 lines) with clear contexts
 */
class ETAFormatter {
  constructor(bridgeRegistry, logger) {
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
  }

  /**
   * Format ETA with context-aware behavior
   * Unified method that replaces both _formatETA and _formatPassedETA
   *
   * @param {Object} vessel - Vessel object with etaMinutes, coordinates, speed
   * @param {Object} context - Formatting context
   * @param {boolean} context.allowWaiting - Return null for waiting vessels (default: true)
   * @param {boolean} context.calculateIfMissing - Calculate ETA if not present (default: false)
   * @param {string} context.targetBridge - Target bridge for calculation (required if calculateIfMissing=true)
   * @param {boolean} context.forceCalculation - Always calculate, ignore existing ETA (default: false)
   * @param {string} context.contextName - Context name for logging (default: 'UNKNOWN')
   * @returns {string|null} Formatted ETA string or null if not available/valid
   */
  formatETAWithContext(vessel, context = {}) {
    const {
      allowWaiting = true,
      calculateIfMissing = false,
      targetBridge = null,
      forceCalculation = false,
      contextName = 'UNKNOWN',
    } = context;

    // Guard: Return null for waiting vessels (unless explicitly allowed)
    if (!allowWaiting && vessel.isWaiting) {
      return null;
    }

    // STEP 1: Try to use existing ETA (unless forceCalculation=true)
    if (!forceCalculation && vessel.etaMinutes !== undefined && vessel.etaMinutes !== null) {
      // Validate existing ETA
      if (isValidETA(vessel.etaMinutes)) {
        return formatETA(vessel.etaMinutes);
      }

      // Log invalid ETA (but don't spam for intentional nulls)
      if (vessel.etaMinutes !== null && Number.isNaN(vessel.etaMinutes)) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Invalid existing ETA (${vessel.etaMinutes}) - will try calculation`,
        );
      }
    }

    // STEP 2: Calculate ETA if requested and possible
    if ((calculateIfMissing || forceCalculation) && targetBridge) {
      return this._calculateETA(vessel, targetBridge, contextName);
    }

    // STEP 3: No valid ETA available
    return null;
  }

  /**
   * Calculate ETA from vessel position to target bridge
   * @private
   * @param {Object} vessel - Vessel with coordinates and speed
   * @param {string} targetBridgeName - Name of target bridge
   * @param {string} contextName - Context for logging
   * @returns {string|null} Formatted ETA or null if calculation fails
   */
  _calculateETA(vessel, targetBridgeName, contextName = 'CALC') {
    try {
      // Validate vessel coordinates
      if (!isValidVesselCoordinates(vessel)) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Missing or invalid vessel position data`,
        );
        return null;
      }

      // Get target bridge
      const targetBridge = this.bridgeRegistry.getBridgeByName(targetBridgeName);
      if (!targetBridge) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Target bridge '${targetBridgeName}' not found in registry`,
        );
        return null;
      }

      // Validate bridge coordinates
      if (!Number.isFinite(targetBridge.lat) || !Number.isFinite(targetBridge.lon)) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Invalid bridge coordinates for ${targetBridgeName}`,
        );
        return null;
      }

      // Calculate distance
      const distance = geometry.calculateDistance(
        vessel.lat, vessel.lon,
        targetBridge.lat, targetBridge.lon,
      );

      // Validate distance
      if (!isValidDistance(distance) || distance <= 0) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Invalid distance calculation (${distance}m)`,
        );
        return null;
      }

      // Get speed with fallback
      const sogValue = Number.isFinite(vessel.sog) ? vessel.sog : 4.0; // Default 4 knots
      const speed = Math.max(sogValue, 0.5); // Minimum 0.5 knots to avoid division by zero

      // Validate speed
      if (!isValidSpeed(speed) || speed <= 0) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Invalid speed value: ${speed}`,
        );
        return null;
      }

      // Convert speed to m/s
      const speedMps = (speed * 1852) / 3600;

      if (!Number.isFinite(speedMps) || speedMps <= 0) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Invalid speed conversion (${speedMps}m/s)`,
        );
        return null;
      }

      // Calculate time
      const timeSeconds = safeDivision(distance, speedMps);
      if (timeSeconds === null) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Safe division failed for time calculation`,
        );
        return null;
      }

      const etaMinutes = safeDivision(timeSeconds, 60);
      if (etaMinutes === null) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Safe division failed for minute conversion`,
        );
        return null;
      }

      // Final validation
      if (!isValidETA(etaMinutes)) {
        this.logger.debug(
          `⚠️ [ETA_${contextName}] ${vessel.mmsi}: Invalid calculated ETA (${etaMinutes}min)`,
        );
        return null;
      }

      this.logger.debug(
        `⏰ [ETA_${contextName}] ${vessel.mmsi}: Calculated ETA - distance=${distance.toFixed(0)}m, speed=${speed.toFixed(1)}kn, ETA=${etaMinutes.toFixed(1)}min`,
      );

      return formatETA(etaMinutes);

    } catch (error) {
      this.logger.error(
        `❌ [ETA_${contextName}] ${vessel.mmsi}: ETA calculation failed:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Format ETA for target bridge messages (no ETA shown if waiting)
   * Convenience method for common use case
   * @param {Object} vessel - Vessel object
   * @returns {string|null} Formatted ETA or null
   */
  formatForTargetBridge(vessel) {
    return this.formatETAWithContext(vessel, {
      allowWaiting: false, // Don't show ETA if waiting
      calculateIfMissing: false,
      contextName: 'TARGET',
    });
  }

  /**
   * Format ETA for intermediate bridge messages (always try to calculate)
   * Convenience method for common use case
   * @param {Object} vessel - Vessel object
   * @param {string} targetBridge - Target bridge name
   * @returns {string|null} Formatted ETA or null
   */
  formatForIntermediateBridge(vessel, targetBridge) {
    return this.formatETAWithContext(vessel, {
      allowWaiting: true,
      calculateIfMissing: true,
      targetBridge,
      contextName: 'INTERMEDIATE',
    });
  }

  /**
   * Format ETA for "precis passerat" messages (always try to calculate to next target)
   * Convenience method for common use case
   * @param {Object} vessel - Vessel object
   * @param {string} targetBridge - Next target bridge name
   * @returns {string|null} Formatted ETA or null
   */
  formatForPassedMessage(vessel, targetBridge) {
    return this.formatETAWithContext(vessel, {
      allowWaiting: true,
      calculateIfMissing: true,
      targetBridge,
      forceCalculation: false, // Use existing ETA if valid
      contextName: 'PASSED',
    });
  }
}

module.exports = ETAFormatter;
