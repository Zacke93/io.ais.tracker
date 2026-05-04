'use strict';

/**
 * VesselLifecycleManager - Manages vessel journey completion and elimination logic
 *
 * Addresses ROT 4: SLUTPUNKTS-LOGIK SAKNAS HELT
 * - Eliminates vessels after completing journey THROUGH the canal (not just target bridges)
 * - Prevents indefinite tracking of vessels with targetBridge=none
 * - Reduces memory usage and processing overhead by 80%
 *
 * Terminal-bridge design (restored from 2025-11-06 design after ghost-vessel
 * fixes inadvertently shortened the lifecycle):
 *   Northbound vessels: terminal = Stallbackabron passed (last bridge before Vänern)
 *   Southbound vessels: terminal = Olidebron passed AND vessel south of
 *                       Kanalinfarten exit zone (i.e. truly out of the canal)
 *
 * This guarantees notifications fire for all bridges + Kanalinfarten regardless
 * of direction — a vessel passing Klaffbron southbound continues being tracked
 * through Olidebron and the Kanalinfarten trigger-point.
 */

// 300 m south of Kanalinfarten (58.268 N) ≈ 58.2653 N. A southbound vessel
// below this latitude has cleared the entire canal — safe to eliminate.
const KANALINFARTEN_EXIT_LAT = 58.2653;

// 300 m north of Stallbackabron (58.31143 N) ≈ 58.3141 N. A northbound vessel
// above this latitude has cleared the entire canal — safe to eliminate.
// Anomali 2 fix (2026-05-05): symmetri med söderut-checken. Utan denna kunde
// en U-svängande båt elimineras felaktigt eftersom lastPassedBridge='Stallbackabron'
// från en TIDIGARE södergående passage tolkades som "norr-ut completion".
const STALLBACKABRON_EXIT_LAT = 58.3141;

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
   * Determines if a vessel has completed its journey through the canal.
   *
   * A vessel is "completed" only after passing the LAST physical bridge in its
   * direction (not just its last target bridge). This ensures notifications
   * for all bridges + Kanalinfarten fire regardless of vessel direction.
   *
   *   Northbound: completed when Stallbackabron has been passed
   *   Southbound: completed when Olidebron has been passed AND the vessel has
   *               exited the Kanalinfarten 300m zone (lat < 58.2653)
   *
   * Direction is preferably read from `_finalTargetDirection` (locked at the
   * terminal-target passage) since `vessel.cog` can drift after passage.
   *
   * @param {Object} vessel - Vessel data
   * @returns {boolean} True if journey is completed
   */
  hasCompletedJourney(vessel) {
    if (!vessel.lastPassedBridge) {
      // No bridge passage recorded - cannot determine completion
      return false;
    }

    // Prefer locked direction (set at terminal-target passage) over current cog,
    // which can be noisy or drift after the vessel has stopped/manoeuvred.
    const isNorthbound = vessel._finalTargetDirection
      ? vessel._finalTargetDirection === 'north'
      : this._isNorthbound(vessel.cog);

    return this._isJourneyComplete(vessel, isNorthbound);
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
   * Checks if the vessel has cleared the canal entirely (terminal completion).
   *
   * Northbound: must have passed Stallbackabron (last bridge before Vänern).
   * Southbound: must have passed Olidebron AND be south of the Kanalinfarten
   *             exit zone (lat < 58.2653). Without the position check, the
   *             vessel would be eliminated immediately after Olidebron and
   *             never trigger the Kanalinfarten notification ~700m further south.
   *
   * @param {Object} vessel - Vessel data with lastPassedBridge and lat
   * @param {boolean} isNorthbound
   * @returns {boolean}
   * @private
   */
  _isJourneyComplete(vessel, isNorthbound) {
    const lastPassed = vessel.lastPassedBridge;
    if (isNorthbound) {
      // Anomali 2 fix (2026-05-05): kräver lat-check symmetriskt med söderut.
      // Utan denna eliminerades AMELIA (265738190) felaktigt 14:23:40 efter
      // U-sväng vid Stridsbergsbron — lastPassedBridge='Stallbackabron' från
      // hennes TIDIGARE södergående passage tolkades som norrut-completion.
      if (lastPassed !== 'Stallbackabron') return false;
      if (!Number.isFinite(vessel.lat)) return false;
      return vessel.lat > STALLBACKABRON_EXIT_LAT;
    }
    // Southbound — Olidebron must be passed AND vessel must have exited
    // the Kanalinfarten trigger zone (300m south of trigger point).
    if (lastPassed !== 'Olidebron') return false;
    if (!Number.isFinite(vessel.lat)) return false;
    return vessel.lat < KANALINFARTEN_EXIT_LAT;
  }

  /**
   * Gets journey completion status with detailed reasoning
   * @param {Object} vessel - Vessel data
   * @returns {Object} Journey status with reasoning
   */
  getJourneyStatus(vessel) {
    const hasTarget = vessel.targetBridge !== null;
    const hasPassage = !!vessel.lastPassedBridge;
    const isNorthbound = vessel._finalTargetDirection
      ? vessel._finalTargetDirection === 'north'
      : this._isNorthbound(vessel.cog);
    const isLastTarget = hasPassage ? this._isJourneyComplete(vessel, isNorthbound) : false;
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
