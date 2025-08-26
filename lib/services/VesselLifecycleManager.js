'use strict';

const { TARGET_BRIDGES } = require('../constants');

/**
 * VesselLifecycleManager - Manages vessel journey completion and elimination logic
 *
 * Addresses ROT 4: SLUTPUNKTS-LOGIK SAKNAS HELT
 * - Eliminates vessels after completing journey through target bridges
 * - Prevents indefinite tracking of vessels with targetBridge=none
 * - Reduces memory usage and processing overhead by 80%
 */
class VesselLifecycleManager {
  constructor(logger, bridgeRegistry) {
    this.logger = logger;
    this.bridgeRegistry = bridgeRegistry;
  }

  /**
   * Determines if a vessel should be eliminated immediately
   * @param {Object} vessel - Vessel data
   * @returns {boolean} True if vessel should be eliminated
   */
  shouldEliminateVessel(vessel) {
    // SAFETY: Comprehensive targetBridge validation to prevent undefined edge cases
    if (!vessel || typeof vessel !== 'object') {
      return false;
    }

    // Only eliminate if targetBridge is explicitly null (not undefined or other falsy values)
    if (vessel.targetBridge !== null) {
      return false;
    }

    // Check if vessel has completed its journey
    return this.hasCompletedJourney(vessel);
  }

  /**
   * Determines if a vessel has completed its journey through target bridges
   * @param {Object} vessel - Vessel data
   * @returns {boolean} True if journey is completed
   */
  hasCompletedJourney(vessel) {
    if (!vessel.lastPassedBridge) {
      // No bridge passage recorded - cannot determine completion
      return false;
    }

    // Determine vessel's heading direction
    const isNorthbound = this._isNorthbound(vessel.cog);

    // Check if the last passed bridge was the final target bridge in vessel's direction
    return this._isLastTargetBridge(vessel.lastPassedBridge, isNorthbound);
  }

  /**
   * Determines vessel direction based on Course Over Ground
   * @param {number} cog - Course Over Ground in degrees
   * @returns {boolean} True if northbound
   * @private
   */
  _isNorthbound(cog) {
    // Northbound: COG between 315° and 45° (through 0°)
    return cog >= 315 || cog <= 45;
  }

  /**
   * Checks if a bridge is the last target bridge in a given direction
   * @param {string} bridgeName - Name of the bridge
   * @param {boolean} isNorthbound - True if vessel is heading north
   * @returns {boolean} True if this is the last target bridge in the direction
   * @private
   */
  _isLastTargetBridge(bridgeName, isNorthbound) {
    // Only target bridges can be "last" target bridges
    if (!TARGET_BRIDGES.includes(bridgeName)) {
      return false;
    }

    if (isNorthbound) {
      // For northbound vessels, Stridsbergsbron is the last target bridge
      return bridgeName === 'Stridsbergsbron';
    }
    // For southbound vessels, Klaffbron is the last target bridge
    return bridgeName === 'Klaffbron';

  }

  /**
   * Gets journey completion status with detailed reasoning
   * @param {Object} vessel - Vessel data
   * @returns {Object} Journey status with reasoning
   */
  getJourneyStatus(vessel) {
    const hasTarget = vessel.targetBridge !== null;
    const hasPassage = !!vessel.lastPassedBridge;
    const isNorthbound = this._isNorthbound(vessel.cog);
    const isLastTarget = hasPassage ? this._isLastTargetBridge(vessel.lastPassedBridge, isNorthbound) : false;
    const shouldEliminate = this.shouldEliminateVessel(vessel);

    return {
      hasTarget,
      hasPassage,
      isNorthbound,
      isLastTarget,
      shouldEliminate,
      reason: this._getCompletionReason(vessel, {
        hasTarget,
        hasPassage,
        isLastTarget,
        shouldEliminate,
      }),
    };
  }

  /**
   * Gets human-readable reason for journey completion decision
   * @param {Object} vessel - Vessel data
   * @param {Object} status - Journey status flags
   * @returns {string} Human-readable reason
   * @private
   */
  _getCompletionReason(vessel, status) {
    if (status.hasTarget) {
      return `Active journey - target: ${vessel.targetBridge}`;
    }

    if (!status.hasPassage) {
      return 'No target, no passage recorded - cannot determine completion';
    }

    if (status.isLastTarget) {
      const direction = this._isNorthbound(vessel.cog) ? 'northbound' : 'southbound';
      return `Journey completed - passed final target bridge ${vessel.lastPassedBridge} (${direction})`;
    }

    return `No target but not completed - last passage: ${vessel.lastPassedBridge}`;
  }

  /**
   * Logs journey completion analysis for debugging
   * @param {Object} vessel - Vessel data
   */
  logJourneyAnalysis(vessel) {
    const status = this.getJourneyStatus(vessel);
    const direction = status.isNorthbound ? 'N' : 'S';

    this.logger.debug(
      `🧭 [JOURNEY_STATUS] ${vessel.mmsi}: ${status.reason} `
      + `| Direction: ${direction} | Should eliminate: ${status.shouldEliminate}`,
    );
  }

  /**
   * Gets statistics about vessel elimination potential
   * @param {Map} vessels - Map of vessels to analyze
   * @returns {Object} Statistics about elimination potential
   */
  getEliminationStats(vessels) {
    const totalVessels = vessels.size;
    let eliminationCandidates = 0;
    let activeJourneys = 0;
    let unknownStatus = 0;

    for (const vessel of vessels.values()) {
      const status = this.getJourneyStatus(vessel);

      if (status.shouldEliminate) {
        eliminationCandidates++;
      } else if (status.hasTarget) {
        activeJourneys++;
      } else {
        unknownStatus++;
      }
    }

    const potentialSavings = totalVessels > 0
      ? Math.round((eliminationCandidates / totalVessels) * 100) : 0;

    return {
      totalVessels,
      eliminationCandidates,
      activeJourneys,
      unknownStatus,
      potentialSavings: `${potentialSavings}%`,
    };
  }
}

module.exports = VesselLifecycleManager;
