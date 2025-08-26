'use strict';

const geometry = require('../utils/geometry');
const {
  isValidVesselCoordinates, isValidSpeed, safeDivision, isValidDistance,
} = require('../utils/etaValidation');

/**
 * ProgressiveETACalculator - Progressive route-based ETA calculation
 *
 * Addresses ROT 2: ETA-CACHING ARKITEKTUR-FEL
 * - Calculates ETA based on actual route through intermediate bridges
 * - Eliminates constant ETA values like "1h 7min" that persist for hours
 * - Uses nearestBridge + cumulative time to targetBridge instead of direct distance
 */
class ProgressiveETACalculator {
  constructor(logger, bridgeRegistry) {
    this.logger = logger;
    this.bridgeRegistry = bridgeRegistry;
  }

  /**
   * Calculate progressive ETA to target bridge via route
   * @param {Object} vessel - Vessel data
   * @param {Object} proximityData - Proximity data with nearestBridge
   * @returns {number|null} ETA in minutes or null
   */
  calculateProgressiveETA(vessel, proximityData) {
    // Robust validation with minimal logging for production efficiency
    if (!vessel || !vessel.targetBridge) {
      return null;
    }

    if (!isValidVesselCoordinates(vessel)) {
      return null;
    }

    if (!proximityData || !proximityData.nearestBridge) {
      // Fallback to direct calculation without verbose logging
      return this._calculateDirectETA(vessel);
    }

    const { nearestBridge } = proximityData;
    const { targetBridge } = vessel;

    // If vessel is already at target bridge, use direct calculation
    if (nearestBridge === targetBridge) {
      return this._calculateDirectETA(vessel);
    }

    // Calculate progressive route ETA
    return this._calculateRouteETA(vessel, nearestBridge, targetBridge, proximityData);
  }

  /**
   * Calculate ETA via route through intermediate bridges
   * @param {Object} vessel - Vessel data
   * @param {string} nearestBridge - Current nearest bridge
   * @param {string} targetBridge - Final target bridge
   * @param {Object} proximityData - Proximity data
   * @returns {number|null} ETA in minutes or null
   * @private
   */
  _calculateRouteETA(vessel, nearestBridge, targetBridge, proximityData) {
    // Get effective speed
    const effectiveSpeed = this._getEffectiveSpeed(vessel);
    if (!effectiveSpeed) {
      return null;
    }

    // Step 1: Calculate ETA to nearest bridge (next step on route)
    const etaToNearest = this._calculateETAToBridge(vessel, nearestBridge, proximityData);
    if (etaToNearest === null) {
      return this._calculateDirectETA(vessel);
    }

    // Step 2: Calculate cumulative time from nearest bridge to target bridge
    const bridgesBetween = this.bridgeRegistry.getBridgesBetween(nearestBridge, targetBridge);
    const cumulativeTime = this._calculateCumulativeTime(bridgesBetween, effectiveSpeed);

    const totalETA = etaToNearest + cumulativeTime;

    // Only log detailed route info for complex routes (debugging)
    if (bridgesBetween.length > 2) {
      this.logger.debug(
        `🧮 [PROGRESSIVE_ETA] ${vessel.mmsi}: Complex route ${nearestBridge} → ${targetBridge} `
        + `| Total: ${totalETA.toFixed(1)}min`,
      );
    }

    // Apply reasonable bounds
    return Math.min(Math.max(totalETA, 0.1), 120); // Min 0.1min, max 2 hours
  }

  /**
   * Calculate ETA to a specific bridge
   * @param {Object} vessel - Vessel data
   * @param {string} bridgeName - Bridge name
   * @param {Object} proximityData - Proximity data (optional, for nearest bridge optimization)
   * @returns {number|null} ETA in minutes or null
   * @private
   */
  _calculateETAToBridge(vessel, bridgeName, proximityData = null) {
    const effectiveSpeed = this._getEffectiveSpeed(vessel);
    if (!effectiveSpeed) {
      return null;
    }

    // Optimization: Use proximity data distance if available for nearest bridge
    let distance;
    if (proximityData && proximityData.nearestBridge === bridgeName && proximityData.nearestDistance) {
      distance = proximityData.nearestDistance;
      // Distance optimization used silently for performance
    } else {
      // Calculate distance manually
      const bridge = this.bridgeRegistry.getBridgeByName(bridgeName);
      if (!bridge) {
        this.logger.debug(`🧮 [ETA_TO_BRIDGE] ${vessel.mmsi}: Bridge '${bridgeName}' not found`);
        return null;
      }

      try {
        distance = geometry.calculateDistance(
          vessel.lat, vessel.lon,
          bridge.lat, bridge.lon,
        );

        if (!isValidDistance(distance) || distance <= 0) {
          this.logger.debug(
            `🧮 [ETA_TO_BRIDGE] ${vessel.mmsi}: Invalid distance to ${bridgeName}: ${distance}m`,
          );
          return null;
        }
      } catch (error) {
        this.logger.error(`🧮 [ETA_TO_BRIDGE] ${vessel.mmsi}: Distance calculation failed: ${error.message}`);
        return null;
      }
    }

    // Calculate time
    const speedMps = (effectiveSpeed * 1852) / 3600; // knots to m/s
    if (!Number.isFinite(speedMps) || speedMps <= 0) {
      return null;
    }

    const timeSeconds = safeDivision(distance, speedMps);
    if (timeSeconds === null) {
      return null;
    }

    const timeMinutes = safeDivision(timeSeconds, 60);
    if (timeMinutes === null || !Number.isFinite(timeMinutes) || timeMinutes <= 0) {
      return null;
    }

    return timeMinutes;
  }

  /**
   * Calculate cumulative travel time through bridge sequence
   * @param {string[]} bridgeSequence - Array of bridge IDs in order
   * @param {number} effectiveSpeed - Effective speed in knots
   * @returns {number} Cumulative time in minutes
   * @private
   */
  _calculateCumulativeTime(bridgeSequence, effectiveSpeed) {
    if (!bridgeSequence || bridgeSequence.length < 2) {
      return 0; // No intermediate bridges
    }

    const speedMps = (effectiveSpeed * 1852) / 3600; // knots to m/s
    let totalTime = 0;

    // Calculate time for each gap in the sequence
    for (let i = 0; i < bridgeSequence.length - 1; i++) {
      const fromBridgeId = bridgeSequence[i];
      const toBridgeId = bridgeSequence[i + 1];

      // Get distance between consecutive bridges
      const distance = this.bridgeRegistry.getDistanceBetweenBridges(fromBridgeId, toBridgeId);

      if (distance && distance > 0) {
        const timeSeconds = distance / speedMps;
        const timeMinutes = timeSeconds / 60;
        totalTime += timeMinutes;

        // Cumulative gap calculation - logged only for debugging complex routes
      }
    }

    return totalTime;
  }

  /**
   * Fallback to direct ETA calculation (original method)
   * @param {Object} vessel - Vessel data
   * @returns {number|null} ETA in minutes or null
   * @private
   */
  _calculateDirectETA(vessel) {
    const effectiveSpeed = this._getEffectiveSpeed(vessel);
    if (!effectiveSpeed) {
      return null;
    }

    const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
    if (!targetBridge) {
      return null;
    }

    try {
      const distance = geometry.calculateDistance(
        vessel.lat, vessel.lon,
        targetBridge.lat, targetBridge.lon,
      );

      if (!isValidDistance(distance) || distance <= 0) {
        return null;
      }

      const speedMps = (effectiveSpeed * 1852) / 3600;
      const timeSeconds = safeDivision(distance, speedMps);
      const timeMinutes = safeDivision(timeSeconds, 60);

      if (timeMinutes === null || !Number.isFinite(timeMinutes) || timeMinutes <= 0) {
        return null;
      }

      // Direct ETA calculation completed silently for performance

      return Math.min(Math.max(timeMinutes, 0.1), 120);
    } catch (error) {
      this.logger.error(`🧮 [DIRECT_ETA] ${vessel.mmsi}: Calculation failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get effective speed with fallback logic
   * @param {Object} vessel - Vessel data
   * @returns {number|null} Effective speed in knots or null
   * @private
   */
  _getEffectiveSpeed(vessel) {
    const actualSpeed = Number.isFinite(vessel.sog) ? vessel.sog : 0;
    const effectiveSpeed = Math.max(actualSpeed, 0.5); // Minimum 0.5 knots fallback

    if (!isValidSpeed(effectiveSpeed) || effectiveSpeed <= 0) {
      this.logger.error(`🧮 [SPEED_ERROR] Invalid effective speed: ${effectiveSpeed} for vessel ${vessel.mmsi}`);
      return null;
    }

    if (actualSpeed <= 0.3) {
      this.logger.debug(
        `🧮 [SPEED_FALLBACK] ${vessel.mmsi}: Using fallback speed `
        + `(actual: ${actualSpeed.toFixed(1)}kn, using: ${effectiveSpeed}kn)`,
      );
    }

    return effectiveSpeed;
  }

  /**
   * Get statistics about ETA calculation performance
   * @param {Array} vessels - Array of vessels to analyze
   * @returns {Object} Performance statistics
   */
  getCalculationStats(vessels) {
    let progressiveCalculations = 0;
    let directCalculations = 0;
    const failedCalculations = 0;

    for (const vessel of vessels) {
      if (!vessel.targetBridge) continue;

      // This is just for stats - would need proximityData in real usage
      const hasNearestBridge = vessel.nearestBridge && vessel.nearestBridge !== vessel.targetBridge;

      if (hasNearestBridge) {
        progressiveCalculations++;
      } else {
        directCalculations++;
      }
    }

    return {
      progressiveCalculations,
      directCalculations,
      failedCalculations,
      totalCalculations: progressiveCalculations + directCalculations + failedCalculations,
      progressivePercentage: vessels.length > 0
        ? Math.round((progressiveCalculations / vessels.length) * 100) : 0,
    };
  }
}

module.exports = ProgressiveETACalculator;
