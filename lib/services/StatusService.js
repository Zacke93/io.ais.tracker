'use strict';

const EventEmitter = require('events');
const {
  WAITING_SPEED_THRESHOLD,
  WAITING_TIME_THRESHOLD,
  UNDER_BRIDGE_DISTANCE,
  MOVEMENT_DETECTION,
} = require('../constants');
const geometry = require('../utils/geometry');

/**
 * StatusService - Manages vessel status detection and transitions
 * Handles waiting detection, under-bridge detection, and status changes
 */
class StatusService extends EventEmitter {
  constructor(bridgeRegistry, logger) {
    super();
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
  }

  /**
   * Analyze and update vessel status
   * @param {Object} vessel - Vessel object
   * @param {Object} proximityData - Proximity analysis data
   * @returns {Object} Status analysis result
   */
  analyzeVesselStatus(vessel, proximityData) {
    const previousStatus = vessel.status;
    const result = {
      status: previousStatus,
      isWaiting: vessel.isWaiting || false,
      isApproaching: vessel.isApproaching || false,
      statusChanged: false,
      statusReason: null,
      etaMinutes: vessel.etaMinutes,
    };

    // Priority 1: Under bridge detection (highest priority)
    if (this._isUnderBridge(vessel, proximityData)) {
      result.status = 'under-bridge';
      result.isWaiting = false;
      result.isApproaching = false;
      result.etaMinutes = 0;
      result.statusReason = 'vessel_under_bridge';
    } else if (this._isWaiting(vessel, proximityData)) {
      // Priority 2: Waiting detection
      result.status = 'waiting';
      result.isWaiting = true;
      result.isApproaching = false;
      result.statusReason = 'vessel_waiting_at_bridge';
    } else if (this._isApproaching(vessel, proximityData)) {
      // Priority 3: Approaching detection
      result.status = 'approaching';
      result.isWaiting = false;
      result.isApproaching = true;
      result.statusReason = 'vessel_approaching_bridge';
    } else if (this._hasRecentlyPassed(vessel)) {
      // Priority 4: Recently passed
      result.status = 'passed';
      result.isWaiting = false;
      result.isApproaching = false;
      result.statusReason = 'vessel_recently_passed';
    } else {
      // Default: En route
      result.status = 'en-route';
      result.isWaiting = false;
      result.isApproaching = false;
      result.statusReason = 'vessel_en_route';
    }

    // Check for status change
    if (result.status !== previousStatus) {
      result.statusChanged = true;
      this.logger.debug(
        `🔄 [STATUS_CHANGE] ${vessel.mmsi}: ${previousStatus} → ${result.status} (${result.statusReason})`,
      );

      this.emit('status:changed', {
        vessel,
        oldStatus: previousStatus,
        newStatus: result.status,
        reason: result.statusReason,
      });
    }

    // Update waiting timer management
    this._updateWaitingTimer(vessel, result);

    return result;
  }

  /**
   * Check if vessel is stationary
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if stationary
   */
  isStationary(vessel) {
    // Method 1: Check if position hasn't changed significantly
    if (vessel.lastPositionChange) {
      const timeSinceMove = Date.now() - vessel.lastPositionChange;
      if (timeSinceMove > MOVEMENT_DETECTION.STATIONARY_TIME_THRESHOLD) {
        return true;
      }
    }

    // Method 2: Check speed threshold
    if (vessel.sog <= MOVEMENT_DETECTION.STATIONARY_SPEED_THRESHOLD) {
      return true;
    }

    return false;
  }

  /**
   * Get vessel movement characteristics
   * @param {Object} vessel - Vessel object
   * @returns {Object} Movement analysis
   */
  analyzeMovement(vessel) {
    const analysis = {
      isStationary: this.isStationary(vessel),
      movementPattern: 'normal',
      speedTrend: 'stable',
      hasRecentMovement: false,
    };

    // Analyze speed history if available
    if (vessel.speedHistory && vessel.speedHistory.length > 1) {
      const recentSpeeds = vessel.speedHistory.slice(-3);
      const avgSpeed = recentSpeeds.reduce((sum, entry) => sum + entry.speed, 0) / recentSpeeds.length;

      if (avgSpeed < MOVEMENT_DETECTION.STATIONARY_SPEED_THRESHOLD) {
        analysis.movementPattern = 'stationary';
      } else if (avgSpeed > 5.0) {
        analysis.movementPattern = 'fast';
      } else {
        analysis.movementPattern = 'normal';
      }

      // Determine speed trend
      if (recentSpeeds.length >= 2) {
        const firstSpeed = recentSpeeds[0].speed;
        const lastSpeed = recentSpeeds[recentSpeeds.length - 1].speed;
        const speedChange = lastSpeed - firstSpeed;

        if (speedChange > 1.0) {
          analysis.speedTrend = 'increasing';
        } else if (speedChange < -1.0) {
          analysis.speedTrend = 'decreasing';
        }
      }
    }

    // Check for recent movement
    if (vessel.lastPositionChange) {
      const timeSinceMove = Date.now() - vessel.lastPositionChange;
      analysis.hasRecentMovement = timeSinceMove < 60000; // Less than 1 minute
    }

    return analysis;
  }

  /**
   * Calculate ETA to target bridge
   * @param {Object} vessel - Vessel object
   * @param {Object} proximityData - Proximity data
   * @returns {number|null} ETA in minutes or null
   */
  calculateETA(vessel, proximityData) {
    if (!vessel.targetBridge || vessel.sog <= 0.5) {
      return null;
    }

    const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
    if (!targetBridge) {
      return null;
    }

    const distance = geometry.calculateDistance(
      vessel.lat, vessel.lon,
      targetBridge.lat, targetBridge.lon,
    );

    // Convert speed from knots to m/s and calculate time
    const speedMps = (vessel.sog * 1852) / 3600;
    const timeSeconds = distance / speedMps;
    const timeMinutes = timeSeconds / 60;

    // Add some buffer time for realistic ETA
    const bufferedETA = timeMinutes * 1.1; // Add 10% buffer

    this.logger.debug(
      `⏰ [ETA_CALC] ${vessel.mmsi}: distance=${distance.toFixed(0)}m, `
      + `speed=${vessel.sog.toFixed(1)}kn, ETA=${bufferedETA.toFixed(1)}min`,
    );

    return bufferedETA;
  }

  /**
   * Check if vessel is under a bridge
   * @private
   */
  _isUnderBridge(vessel, proximityData) {
    return proximityData.underBridge
           || proximityData.nearestDistance <= UNDER_BRIDGE_DISTANCE;
  }

  /**
   * Check if vessel is waiting
   * @private
   */
  _isWaiting(vessel, proximityData) {
    // Must be within protection zone and moving slowly
    if (!proximityData.withinProtectionZone) {
      return false;
    }

    // Speed must be below threshold
    if (vessel.sog > WAITING_SPEED_THRESHOLD) {
      return false;
    }

    // Check if vessel has been slow for long enough
    if (vessel.speedBelowThresholdSince) {
      const waitingTime = Date.now() - vessel.speedBelowThresholdSince;
      return waitingTime >= WAITING_TIME_THRESHOLD;
    }

    return false;
  }

  /**
   * Check if vessel is approaching
   * @private
   */
  _isApproaching(vessel, proximityData) {
    return proximityData.isApproaching && vessel.sog > 0.5;
  }

  /**
   * Check if vessel has recently passed a bridge
   * @private
   */
  _hasRecentlyPassed(vessel) {
    if (!vessel.lastPassedBridgeTime) {
      return false;
    }

    // NEW RULE: "Precis passerat" visas i exakt 1 minut efter passage
    const timeSincePassed = Date.now() - vessel.lastPassedBridgeTime;
    const oneMinute = 60 * 1000; // 60 seconds in milliseconds

    return timeSincePassed < oneMinute;
  }

  /**
   * Update waiting timer for vessel
   * @private
   */
  _updateWaitingTimer(vessel, statusResult) {
    const now = Date.now();

    if (vessel.sog <= WAITING_SPEED_THRESHOLD) {
      // Vessel is moving slowly
      if (!vessel.speedBelowThresholdSince) {
        vessel.speedBelowThresholdSince = now;
        this.logger.debug(
          `🕐 [WAITING_TIMER] ${vessel.mmsi}: Started waiting timer (speed: ${vessel.sog.toFixed(2)}kn)`,
        );
      }
    } else if (vessel.speedBelowThresholdSince) {
      // Vessel is moving fast enough - reset timer
      vessel.speedBelowThresholdSince = null;
      this.logger.debug(
        `🏃 [WAITING_TIMER] ${vessel.mmsi}: Reset waiting timer (speed: ${vessel.sog.toFixed(2)}kn)`,
      );
    }

    // Set waitSince for waiting vessels
    if (statusResult.status === 'waiting' && !vessel.waitSince) {
      vessel.waitSince = now;
    } else if (statusResult.status !== 'waiting' && vessel.waitSince) {
      vessel.waitSince = null;
    }
  }

  /**
   * Calculate passage window (simplified version)
   * @private
   */
  _calculatePassageWindow(vessel) {
    const speed = vessel.sog || 3;
    return speed > 5 ? 120000 : 60000; // 2min fast, 1min slow
  }
}

module.exports = StatusService;
