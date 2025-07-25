'use strict';

const EventEmitter = require('events');
const {
  WAITING_SPEED_THRESHOLD,
  UNDER_BRIDGE_DISTANCE,
  MOVEMENT_DETECTION,
  APPROACHING_RADIUS,
  APPROACH_RADIUS,
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

    // Priority 0: Recently passed detection (HIGHEST priority with limited override)
    const hasRecentlyPassed = this._hasRecentlyPassed(vessel);

    if (hasRecentlyPassed) {
      // Recently passed has highest priority
      result.status = 'passed';
      result.isWaiting = false;
      result.isApproaching = false;
      result.statusReason = 'vessel_recently_passed';
    } else if (this._isUnderBridge(vessel, proximityData)) {
      // Priority 1: Under bridge detection
      result.status = 'under-bridge';
      result.isWaiting = false;
      result.isApproaching = false;
      result.etaMinutes = 0;
      result.statusReason = 'vessel_under_bridge';
    } else if (this._isWaiting(vessel, proximityData)) {
      // Priority 2: Waiting detection (only if not recently passed)
      result.status = 'waiting';
      result.isWaiting = true;
      result.isApproaching = false;
      result.statusReason = 'vessel_waiting_at_bridge';
    } else if (this._isStallbackabraBridgeWaiting(vessel, proximityData)) {
      // Priority 3: Stallbackabron special "åker strax under" status
      result.status = 'stallbacka-waiting';
      result.isWaiting = false; // Special handling, not regular waiting
      result.isApproaching = false;
      result.statusReason = 'vessel_approaching_stallbacka_under_bridge';
    } else if (this._isApproaching(vessel, proximityData)) {
      // Priority 4: Approaching detection
      result.status = 'approaching';
      result.isWaiting = false;
      result.isApproaching = true;
      result.statusReason = 'vessel_approaching_bridge';
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
   * Calculate ETA to target bridge (ROBUST V2.0 - eliminates 'undefinedmin')
   * @param {Object} vessel - Vessel object
   * @param {Object} proximityData - Proximity data
   * @returns {number|null} ETA in minutes or null
   */
  calculateETA(vessel, proximityData) {
    // Robust validation with detailed logging
    if (!vessel || !vessel.targetBridge) {
      this.logger.debug(`⏰ [ETA_CALC] ${vessel?.mmsi || 'unknown'}: No target bridge - returning null`);
      return null;
    }

    // Use minimum speed threshold to avoid division by zero and unrealistic ETAs
    const effectiveSpeed = Math.max(vessel.sog || 0, 0.5); // Minimum 0.5 knots
    if (vessel.sog <= 0.3) {
      this.logger.debug(`⏰ [ETA_CALC] ${vessel.mmsi}: Speed too low (${vessel.sog}kn) - returning null`);
      return null;
    }

    const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
    if (!targetBridge) {
      this.logger.warn(`⏰ [ETA_CALC] ${vessel.mmsi}: Target bridge '${vessel.targetBridge}' not found - returning null`);
      return null;
    }

    // Calculate distance with error handling
    let distance;
    try {
      distance = geometry.calculateDistance(
        vessel.lat, vessel.lon,
        targetBridge.lat, targetBridge.lon,
      );

      // Validate distance calculation
      if (!Number.isFinite(distance) || distance <= 0) {
        this.logger.warn(`⏰ [ETA_CALC] ${vessel.mmsi}: Invalid distance calculation (${distance}m) - returning null`);
        return null;
      }
    } catch (error) {
      this.logger.error(`⏰ [ETA_CALC] ${vessel.mmsi}: Distance calculation failed:`, error.message);
      return null;
    }

    // Convert speed from knots to m/s and calculate time with robust math
    const speedMps = (effectiveSpeed * 1852) / 3600;
    const timeSeconds = distance / speedMps;
    const timeMinutes = timeSeconds / 60;

    // Validate time calculation
    if (!Number.isFinite(timeMinutes) || timeMinutes <= 0) {
      this.logger.warn(`⏰ [ETA_CALC] ${vessel.mmsi}: Invalid time calculation (${timeMinutes}min) - returning null`);
      return null;
    }

    // Add realistic buffer time and enforce reasonable bounds
    const bufferedETA = Math.min(timeMinutes * 1.1, 120); // Max 2 hours, 10% buffer
    const finalETA = Math.max(bufferedETA, 0.1); // Minimum 0.1 minutes (6 seconds)

    this.logger.debug(
      `⏰ [ETA_CALC] ${vessel.mmsi}: distance=${distance.toFixed(0)}m, `
      + `speed=${effectiveSpeed.toFixed(1)}kn, ETA=${finalETA.toFixed(1)}min`,
    );

    return finalETA;
  }

  /**
   * Check if vessel is under a bridge
   * @private
   */
  _isUnderBridge(vessel, proximityData) {
    // STALLBACKABRON SPECIAL: Check if vessel is under Stallbackabron bridge specifically
    const stallbackabron = this.bridgeRegistry.getBridge('stallbackabron');
    if (stallbackabron) {
      const distanceToStallbacka = this._calculateDistance(
        vessel.lat, vessel.lon,
        stallbackabron.lat, stallbackabron.lon,
      );
      if (distanceToStallbacka <= UNDER_BRIDGE_DISTANCE) {
        this.logger.debug(`🌉 [STALLBACKA_UNDER] ${vessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from Stallbackabron -> under-bridge status`);
        return true;
      }
    }

    // INTERMEDIATE BRIDGE CHECK: If vessel has currentBridge set and is very close to it
    if (vessel.currentBridge && vessel.distanceToCurrent <= UNDER_BRIDGE_DISTANCE) {
      this.logger.debug(`🌉 [INTERMEDIATE_UNDER] ${vessel.mmsi}: ${vessel.distanceToCurrent.toFixed(0)}m from intermediate bridge ${vessel.currentBridge} -> under-bridge status`);
      return true;
    }

    // Check distance to TARGET BRIDGE, not nearest bridge
    const targetDistance = this._getDistanceToTargetBridge(vessel);
    if (targetDistance !== null) {
      return targetDistance <= UNDER_BRIDGE_DISTANCE;
    }
    // Fallback to original logic if no target bridge
    return proximityData.underBridge
           || proximityData.nearestDistance <= UNDER_BRIDGE_DISTANCE;
  }

  /**
   * Check if vessel is waiting (NEW: Stallbackabron special handling)
   * @private
   */
  _isWaiting(vessel, proximityData) {
    // STALLBACKABRON SPECIAL RULE: NEVER "waiting" status for Stallbackabron
    // This prevents "inväntar broöppning" messages for high bridge
    if (this._isAtStallbackabron(vessel, proximityData)) {
      return false; // Stallbackabron uses special "åker strax under" logic instead
    }

    // FIXED RULE: ≤300m from TARGET BRIDGE triggers "waiting" status
    // This triggers "En båt inväntar broöppning vid X" message
    const targetDistance = this._getDistanceToTargetBridge(vessel);
    if (targetDistance !== null && targetDistance <= APPROACH_RADIUS) {
      return true;
    }

    // NEW: Also check if vessel is ≤300m from any INTERMEDIATE bridge
    // This enables "inväntar broöppning av [intermediate bridge]" messages
    if (proximityData.nearestDistance <= APPROACH_RADIUS) {
      // Get the nearest bridge name to determine if it's an intermediate bridge
      const { nearestBridge } = proximityData;
      if (nearestBridge && nearestBridge.name && nearestBridge.name !== vessel.targetBridge) {
        // Near an intermediate bridge, not the target bridge
        const bridgeName = nearestBridge.name;
        const isIntermediateBridge = ['Olidebron', 'Järnvägsbron'].includes(bridgeName);
        if (isIntermediateBridge) {
          this.logger.debug(`⚡ [INTERMEDIATE_WAITING] ${vessel.mmsi}: Waiting at intermediate bridge ${bridgeName} (${proximityData.nearestDistance.toFixed(0)}m)`);

          // CRITICAL: Set currentBridge for BridgeTextService to detect intermediate bridge waiting
          vessel.currentBridge = bridgeName;
          vessel.distanceToCurrent = proximityData.nearestDistance;

          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if vessel is approaching (NEW: 500m rule)
   * @private
   */
  _isApproaching(vessel, proximityData) {
    // STALLBACKABRON SPECIAL: Check if vessel is approaching Stallbackabron (500m rule)
    const stallbackabron = this.bridgeRegistry.getBridge('stallbackabron');
    if (stallbackabron) {
      const distanceToStallbacka = this._calculateDistance(
        vessel.lat, vessel.lon,
        stallbackabron.lat, stallbackabron.lon,
      );
      if (distanceToStallbacka <= APPROACHING_RADIUS && distanceToStallbacka > APPROACH_RADIUS && vessel.sog > 0.5) {
        this.logger.debug(`🌉 [STALLBACKA_APPROACHING] ${vessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from Stallbackabron -> approaching status`);
        return true;
      }
    }

    // NEW RULE: Use 500m APPROACHING_RADIUS for "närmar sig" messages
    // Check distance to TARGET BRIDGE first, fallback to nearest
    const targetDistance = this._getDistanceToTargetBridge(vessel);
    if (targetDistance !== null) {
      // Use target bridge distance for approaching detection
      return targetDistance <= APPROACHING_RADIUS && targetDistance > APPROACH_RADIUS && vessel.sog > 0.5;
    }

    // Fallback to original logic if no target bridge
    return proximityData.nearestDistance <= APPROACHING_RADIUS
           && proximityData.nearestDistance > APPROACH_RADIUS
           && vessel.sog > 0.5;
  }

  /**
   * Check if vessel has recently passed a bridge
   * @private
   */
  _hasRecentlyPassed(vessel) {
    if (!vessel.lastPassedBridgeTime) {
      return false;
    }

    // "precis passerat" hold window (1 minute as specified in CLAUDE.md)
    const timeSincePass = Date.now() - vessel.lastPassedBridgeTime;
    const passedWindow = 1 * 60 * 1000; // 1 minute timeout as per specification

    return timeSincePass <= passedWindow;
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

  /**
   * Get distance to target bridge for status calculations
   * @private
   */
  _getDistanceToTargetBridge(vessel) {
    if (!vessel.targetBridge) {
      return null;
    }

    const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
    if (!targetBridge) {
      return null;
    }

    return this._calculateDistance(
      vessel.lat, vessel.lon,
      targetBridge.lat, targetBridge.lon,
    );
  }

  /**
   * Check if vessel is at Stallbackabron (NEW: Special bridge handling)
   * @private
   */
  _isAtStallbackabron(vessel, proximityData) {
    // Check if vessel is near Stallbackabron specifically
    const stallbackabron = this.bridgeRegistry.getBridge('stallbackabron');
    if (!stallbackabron) {
      return false;
    }

    const distanceToStallbacka = this._calculateDistance(
      vessel.lat, vessel.lon,
      stallbackabron.lat, stallbackabron.lon,
    );

    // Consider vessel "at Stallbackabron" if within approaching radius (500m)
    return distanceToStallbacka <= APPROACHING_RADIUS;
  }

  /**
   * Check if vessel should show "åker strax under" for Stallbackabron (INTERMEDIATE BRIDGE ONLY)
   * Stallbackabron is ALWAYS intermediate bridge, NEVER target bridge
   * @private
   */
  _isStallbackabraBridgeWaiting(vessel, proximityData) {
    const stallbackabron = this.bridgeRegistry.getBridge('stallbackabron');
    if (!stallbackabron) {
      return false;
    }

    // CRITICAL FIX: Don't go back to stallbacka-waiting if vessel has already passed Stallbackabron
    if (vessel.passedBridges && vessel.passedBridges.includes('Stallbackabron')) {
      this.logger.debug(`🌉 [STALLBACKA_PASSED] ${vessel.mmsi}: Already passed Stallbackabron - no stallbacka-waiting status`);
      return false;
    }

    const distanceToStallbacka = this._calculateDistance(
      vessel.lat, vessel.lon,
      stallbackabron.lat, stallbackabron.lon,
    );

    // STALLBACKABRON SPECIAL RULE: <300m triggers "åker strax under" instead of "inväntar broöppning"
    // This applies to ANY vessel passing through Stallbackabron (always intermediate bridge)
    const isWithinWaitingDistance = distanceToStallbacka <= APPROACH_RADIUS && distanceToStallbacka > UNDER_BRIDGE_DISTANCE;

    if (isWithinWaitingDistance) {
      this.logger.debug(`🌉 [STALLBACKA_SPECIAL] ${vessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from Stallbackabron -> "åker strax under" (INTERMEDIATE BRIDGE)`);
      return true;
    }

    return false;
  }

  /**
   * Calculate distance between two points in meters
   * @private
   */
  _calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
              + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180))
              * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}

module.exports = StatusService;
