'use strict';

/**
 * StatusStabilizer - Prevents status flickering during GPS jumps and uncertain movements
 * Provides hysteresis and smoothing for vessel status transitions
 */
class StatusStabilizer {
  constructor(logger) {
    this.logger = logger;
    this.statusHistory = new Map(); // Map<mmsi, StatusHistory>
  }

  /**
   * Stabilize status transitions to prevent flickering
   * @param {string} mmsi - Vessel MMSI
   * @param {string} proposedStatus - New status proposed by StatusService
   * @param {Object} vessel - Vessel object with position data
   * @param {Object} positionAnalysis - GPS jump analysis result
   * @returns {Object} Stabilized status result
   */
  stabilizeStatus(mmsi, proposedStatus, vessel, positionAnalysis) {
    const history = this._getOrCreateHistory(mmsi);
    const currentTime = Date.now();

    // Add proposed status to history
    history.statusSequence.push({
      status: proposedStatus,
      timestamp: currentTime,
      confidence: this._calculateStatusConfidence(vessel, positionAnalysis),
      positionUncertain: positionAnalysis?.positionUncertain || false,
      gpsJump: positionAnalysis?.gpsJumpDetected || false,
    });

    // Clean old history (keep last 5 minutes)
    this._cleanHistory(history, currentTime);

    // Apply stabilization logic
    const stabilizedStatus = this._applyStabilizationLogic(mmsi, proposedStatus, history, vessel, positionAnalysis);

    this.logger.debug(
      `🎯 [STATUS_STABILIZER] ${mmsi}: ${vessel.status || 'unknown'} → ${proposedStatus} → ${stabilizedStatus.status} `
      + `(confidence: ${stabilizedStatus.confidence}, reason: ${stabilizedStatus.reason})`,
    );

    return stabilizedStatus;
  }

  /**
   * Get or create status history for vessel
   * @private
   */
  _getOrCreateHistory(mmsi) {
    if (!this.statusHistory.has(mmsi)) {
      this.statusHistory.set(mmsi, {
        statusSequence: [],
        lastStableStatus: null,
        lastStableTime: null,
        stabilizationActive: false,
      });
    }
    return this.statusHistory.get(mmsi);
  }

  /**
   * Clean old entries from status history
   * @private
   */
  _cleanHistory(history, currentTime) {
    const fiveMinutesAgo = currentTime - (5 * 60 * 1000);
    history.statusSequence = history.statusSequence.filter((entry) => entry.timestamp > fiveMinutesAgo);
  }

  /**
   * Calculate confidence in current status based on position and vessel data
   * @private
   */
  _calculateStatusConfidence(vessel, positionAnalysis) {
    let confidence = 1.0;

    // Reduce confidence for GPS jumps
    if (positionAnalysis?.gpsJumpDetected) {
      confidence *= 0.3;
    } else if (positionAnalysis?.positionUncertain) {
      confidence *= 0.7;
    }

    // Reduce confidence for very low speeds (unreliable COG)
    if (vessel.sog < 0.5) {
      confidence *= 0.8;
    }

    // Reduce confidence if vessel is far from any bridge
    if (vessel._distanceToNearest > 1000) {
      confidence *= 0.9;
    }

    return Math.max(0.1, confidence);
  }

  /**
   * Apply stabilization logic based on history and current conditions
   * @private
   */
  _applyStabilizationLogic(mmsi, proposedStatus, history, vessel, positionAnalysis) {
    const currentTime = Date.now();
    const recentEntries = history.statusSequence.slice(-3); // Last 3 status updates

    // No history - accept proposed status
    if (recentEntries.length === 0) {
      return {
        status: proposedStatus,
        confidence: 'high',
        reason: 'no_history',
        stabilized: false,
      };
    }

    const currentEntry = recentEntries[recentEntries.length - 1];
    const previousStatus = vessel.status;

    // If GPS jump detected, apply strong stabilization
    if (positionAnalysis?.gpsJumpDetected) {
      return this._handleGPSJumpStabilization(mmsi, proposedStatus, previousStatus, history, currentTime);
    }

    // If position is uncertain, apply moderate stabilization
    if (positionAnalysis?.positionUncertain) {
      return this._handleUncertainPositionStabilization(mmsi, proposedStatus, previousStatus, history);
    }

    // Check for rapid status changes (flickering)
    if (this._detectStatusFlickering(recentEntries)) {
      return this._handleStatusFlickering(mmsi, proposedStatus, previousStatus, history);
    }

    // Normal case - accept proposed status
    return {
      status: proposedStatus,
      confidence: currentEntry.confidence > 0.8 ? 'high' : 'medium',
      reason: 'normal_operation',
      stabilized: false,
    };
  }

  /**
   * Handle stabilization during GPS jumps
   * @private
   */
  _handleGPSJumpStabilization(mmsi, proposedStatus, previousStatus, history, currentTime) {
    // For GPS jumps, maintain previous status for short period unless very confident in new status
    if (previousStatus && proposedStatus !== previousStatus) {
      // Start or extend stabilization period
      if (!history.stabilizationActive) {
        history.stabilizationActive = true;
        history.stabilizationStartTime = currentTime;
        history.lastStableStatus = previousStatus;
      }

      // Maintain stabilization for 30 seconds after GPS jump
      const stabilizationDuration = 30 * 1000;
      if (currentTime - history.stabilizationStartTime < stabilizationDuration) {
        this.logger.debug(
          `🛡️ [GPS_JUMP_STABILIZATION] ${mmsi}: Maintaining status '${previousStatus}' during GPS jump `
          + `(proposed: '${proposedStatus}', remaining: ${((stabilizationDuration - (currentTime - history.stabilizationStartTime)) / 1000).toFixed(0)}s)`,
        );

        return {
          status: previousStatus,
          confidence: 'medium',
          reason: 'gps_jump_stabilization',
          stabilized: true,
          stabilizationRemaining: stabilizationDuration - (currentTime - history.stabilizationStartTime),
        };
      }

      // End stabilization period
      history.stabilizationActive = false;
    }

    return {
      status: proposedStatus,
      confidence: 'low',
      reason: 'gps_jump_resolved',
      stabilized: false,
    };
  }

  /**
   * Handle stabilization during uncertain position updates
   * @private
   */
  _handleUncertainPositionStabilization(mmsi, proposedStatus, previousStatus, history) {
    // For uncertain positions, require consistency before changing status
    if (previousStatus && proposedStatus !== previousStatus) {
      const recentSimilar = history.statusSequence.slice(-2).filter((entry) => entry.status === proposedStatus);

      if (recentSimilar.length < 2) {
        this.logger.debug(
          `🔄 [UNCERTAIN_POSITION_STABILIZATION] ${mmsi}: Requiring consistency for status change `
          + `'${previousStatus}' → '${proposedStatus}' (need 2 consistent readings)`,
        );

        return {
          status: previousStatus,
          confidence: 'medium',
          reason: 'uncertain_position_consistency',
          stabilized: true,
        };
      }
    }

    return {
      status: proposedStatus,
      confidence: 'medium',
      reason: 'uncertain_position_accepted',
      stabilized: false,
    };
  }

  /**
   * Detect rapid status changes indicating flickering
   * @private
   */
  _detectStatusFlickering(recentEntries) {
    if (recentEntries.length < 3) return false;

    // Check if status has changed back and forth within recent entries
    const statuses = recentEntries.map((entry) => entry.status);
    const uniqueStatuses = [...new Set(statuses)];

    // If we have 2+ different statuses in last 3 entries, it might be flickering
    return uniqueStatuses.length >= 2 && statuses.length >= 3;
  }

  /**
   * Handle status flickering with damping
   * @private
   */
  _handleStatusFlickering(mmsi, proposedStatus, previousStatus, history) {
    // Find most stable/consistent status in recent history
    const statusCounts = {};
    history.statusSequence.slice(-5).forEach((entry) => {
      statusCounts[entry.status] = (statusCounts[entry.status] || 0) + 1;
    });

    const mostCommonStatus = Object.entries(statusCounts)
      .sort(([, a], [, b]) => b - a)[0]?.[0] || proposedStatus;

    if (mostCommonStatus !== proposedStatus) {
      this.logger.debug(
        `🔄 [FLICKERING_DAMPING] ${mmsi}: Dampening status flickering `
        + `(proposed: '${proposedStatus}', using most common: '${mostCommonStatus}')`,
      );

      return {
        status: mostCommonStatus,
        confidence: 'medium',
        reason: 'flickering_damped',
        stabilized: true,
      };
    }

    return {
      status: proposedStatus,
      confidence: 'medium',
      reason: 'flickering_resolved',
      stabilized: false,
    };
  }

  /**
   * Clean up old vessel histories to prevent memory leaks
   */
  cleanup() {
    const currentTime = Date.now();
    const oneHourAgo = currentTime - (60 * 60 * 1000);

    for (const [mmsi, history] of this.statusHistory.entries()) {
      if (history.statusSequence.length === 0
          || history.statusSequence[history.statusSequence.length - 1].timestamp < oneHourAgo) {
        this.statusHistory.delete(mmsi);
      }
    }
  }

  /**
   * Remove specific vessel from history (when vessel is removed)
   */
  removeVessel(mmsi) {
    this.statusHistory.delete(mmsi);
  }
}

module.exports = StatusStabilizer;
