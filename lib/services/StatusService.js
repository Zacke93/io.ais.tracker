'use strict';

const EventEmitter = require('events');
const {
  WAITING_SPEED_THRESHOLD,
  UNDER_BRIDGE_SET_DISTANCE,
  UNDER_BRIDGE_CLEAR_DISTANCE,
  MOVEMENT_DETECTION,
  APPROACHING_RADIUS,
  APPROACH_RADIUS,
} = require('../constants');
const geometry = require('../utils/geometry');
const StallbackabronHelper = require('../utils/StallbackabronHelper');
const CurrentBridgeManager = require('./CurrentBridgeManager');
const StatusStabilizer = require('./StatusStabilizer');
const SystemCoordinator = require('./SystemCoordinator');
const PassageWindowManager = require('../utils/PassageWindowManager');

/**
 * StatusService - Manages vessel status detection and transitions
 * Handles waiting detection, under-bridge detection, and status changes
 */
class StatusService extends EventEmitter {
  constructor(bridgeRegistry, logger, systemCoordinator = null) {
    super();
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
    this.stallbackabronHelper = new StallbackabronHelper(bridgeRegistry, logger);
    this.currentBridgeManager = new CurrentBridgeManager(bridgeRegistry, logger);
    this.statusStabilizer = new StatusStabilizer(logger);
    this.systemCoordinator = systemCoordinator || new SystemCoordinator(logger);
    this.passageWindowManager = new PassageWindowManager(logger, bridgeRegistry);
  }

  /**
   * Simple status determination for testing purposes
   * @param {Object} vessel - Vessel object
   * @param {string} bridgeName - Bridge name (unused, for compatibility)
   * @param {number} distance - Distance to bridge
   * @returns {string} Status string
   */
  determineStatus(vessel, bridgeName, distance) {
    // Simple distance-based status determination for tests
    if (distance <= UNDER_BRIDGE_SET_DISTANCE) {
      return 'under-bridge';
    } if (distance <= APPROACH_RADIUS) {
      return 'waiting';
    } if (distance <= APPROACHING_RADIUS) {
      return 'approaching';
    }
    return 'en-route';

  }

  /**
   * Analyze and update vessel status
   * @param {Object} vessel - Vessel object
   * @param {Object} proximityData - Proximity analysis data
   * @param {Object} positionAnalysis - GPS jump analysis result (optional)
   * @returns {Object} Status analysis result
   */
  analyzeVesselStatus(vessel, proximityData, positionAnalysis = null) {
    // CRITICAL FIX: Validate inputs to prevent race conditions
    if (!vessel || !vessel.mmsi || !proximityData) {
      this.logger.debug('⚠️ [STATUS_ANALYSIS] Invalid inputs for status analysis');
      return {
        status: 'unknown',
        isWaiting: false,
        isApproaching: false,
        statusChanged: false,
        statusReason: 'invalid_input',
        etaMinutes: null,
      };
    }

    const previousStatus = vessel.status || 'unknown';

    // BUGFIX: Update currentBridge tracking first (with error handling)
    try {
      this.currentBridgeManager.updateCurrentBridge(vessel, proximityData);
    } catch (error) {
      this.logger.error(`[STATUS_ANALYSIS] Error updating current bridge for ${vessel.mmsi}:`, error.message);
    }

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
      this.logger.debug(`✅ [STATUS_WAITING] ${vessel.mmsi}: Setting waiting status at ${vessel.targetBridge || 'unknown bridge'}`);
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
      this.logger.debug(`🟡 [STATUS_APPROACHING] ${vessel.mmsi}: Setting approaching status`);
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

    // Apply status stabilization if position analysis indicates uncertainty
    if (positionAnalysis && (positionAnalysis.gpsJumpDetected || positionAnalysis.positionUncertain)) {
      const stabilizedResult = this.statusStabilizer.stabilizeStatus(
        vessel.mmsi, result.status, vessel, positionAnalysis,
      );

      // ENHANCED: Coordinate with SystemCoordinator for enhanced stabilization
      const coordinatedResult = this.systemCoordinator.coordinateStatusStabilization(
        vessel.mmsi, stabilizedResult, positionAnalysis,
      );

      if (coordinatedResult.stabilized || coordinatedResult.extendedStabilization) {
        this.logger.debug(
          `🛡️ [STATUS_STABILIZED] ${vessel.mmsi}: ${result.status} → ${coordinatedResult.status} `
          + `(${coordinatedResult.reason}, coordinated: ${coordinatedResult.coordinationApplied})`,
        );
        result.status = coordinatedResult.status;
        result.statusReason = coordinatedResult.reason;
        result.stabilized = true;
        result.stabilizationConfidence = coordinatedResult.confidence;
        result.coordinationApplied = coordinatedResult.coordinationApplied;
        result.bridgeTextDebounced = coordinatedResult.bridgeTextDebounced;
      }
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
        stabilized: result.stabilized || false,
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

    // CRITICAL FIX: Validate vessel has valid position data
    if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
      this.logger.debug(`⏰ [ETA_CALC] ${vessel.mmsi}: Invalid position data - returning null`);
      return null;
    }

    // Use minimum speed threshold to avoid division by zero and unrealistic ETAs
    // FIX: Always use fallback speed for vessels waiting at intermediate bridges
    // This ensures ETA is shown even when stationary, as per Bridge Text Format spec
    const actualSpeed = Number.isFinite(vessel.sog) ? vessel.sog : 0;
    // FIX: Ensure effectiveSpeed is always a valid number
    const effectiveSpeed = Math.max(actualSpeed, 0.5); // Minimum 0.5 knots fallback

    // Extra safety check for NaN/Infinity
    if (!Number.isFinite(effectiveSpeed) || effectiveSpeed <= 0) {
      this.logger.error(`[ETA_CALC] Invalid effective speed: ${effectiveSpeed} for vessel ${vessel.mmsi}`);
      return null;
    }

    // Log when using fallback speed for low-speed vessels
    if (actualSpeed <= 0.3) {
      this.logger.debug(
        `⏰ [ETA_FALLBACK] ${vessel.mmsi}: Using fallback speed (actual: ${actualSpeed.toFixed(1)}kn, using: ${effectiveSpeed}kn) for ETA calculation to ${vessel.targetBridge}`,
      );
      // Continue with calculation using effectiveSpeed instead of returning null
      // This ensures "beräknad broöppning om X minuter" appears for vessels waiting at intermediate bridges
    }

    const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
    if (!targetBridge) {
      this.logger.log(`⏰ [ETA_CALC] ${vessel.mmsi}: Target bridge '${vessel.targetBridge}' not found - returning null`);
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
        this.logger.log(`⏰ [ETA_CALC] ${vessel.mmsi}: Invalid distance calculation (${distance}m) - returning null`);
        return null;
      }
    } catch (error) {
      this.logger.error(`⏰ [ETA_CALC] ${vessel.mmsi}: Distance calculation failed:`, error.message);
      // Propagate error information for better debugging
      this.emit('eta-calculation-error', {
        mmsi: vessel.mmsi,
        error: error.message,
        targetBridge: vessel.targetBridge,
      });
      return null;
    }

    // Convert speed from knots to m/s and calculate time with robust math
    const speedMps = (effectiveSpeed * 1852) / 3600;
    const timeSeconds = distance / speedMps;
    const timeMinutes = timeSeconds / 60;

    // Validate time calculation
    if (!Number.isFinite(timeMinutes) || timeMinutes <= 0) {
      this.logger.log(`⏰ [ETA_CALC] ${vessel.mmsi}: Invalid time calculation (${timeMinutes}min) - returning null`);
      return null;
    }

    // CRITICAL FIX: Add realistic buffer time and enforce reasonable bounds
    // Buffer should be more reasonable for short distances
    const bufferMultiplier = timeMinutes < 10 ? 1.2 : 1.1; // 20% buffer for <10min, 10% for longer
    const bufferedETA = Math.min(timeMinutes * bufferMultiplier, 120); // Max 2 hours
    const finalETA = Math.max(bufferedETA, 0.1); // Minimum 0.1 minutes (6 seconds)

    this.logger.debug(
      `⏰ [ETA_CALC] ${vessel.mmsi}: distance=${distance.toFixed(0)}m, `
      + `speed=${effectiveSpeed.toFixed(1)}kn, ETA=${finalETA.toFixed(1)}min`,
    );

    return finalETA;
  }

  /**
   * Check if vessel is under a bridge (with hysteresis)
   * @private
   */
  _isUnderBridge(vessel, proximityData) {
    // Get previous under-bridge state for hysteresis
    const wasUnderBridge = vessel._underBridgeLatched || false;

    // STALLBACKABRON SPECIAL: Skip Stallbackabron in under-bridge detection
    // Stallbackabron should NEVER use "under-bridge" status according to bridgeTextFormat.md
    // It uses special "stallbacka-waiting" (<300m) and special message formatting instead
    // This is handled separately in _isStallbackabraBridgeWaiting method

    // CRITICAL FIX: Reset hysteresis latch when target bridge changes
    // FIX: Use safer property access to avoid corruption
    const lastTargetBridge = vessel._lastTargetBridgeForHysteresis;
    if (lastTargetBridge && vessel.targetBridge !== lastTargetBridge) {
      vessel._underBridgeLatched = false;
      this.logger.debug(`🔄 [HYSTERESIS_RESET] ${vessel.mmsi}: Target bridge changed from ${lastTargetBridge} to ${vessel.targetBridge} - resetting latch`);
    }
    // Only update if targetBridge is valid
    if (vessel.targetBridge) {
      vessel._lastTargetBridgeForHysteresis = vessel.targetBridge;
    }

    // INTERMEDIATE BRIDGE CHECK: If vessel has currentBridge set and is very close to it
    // BUT skip Stallbackabron - it uses special status instead of under-bridge
    if (vessel.currentBridge && vessel.currentBridge !== 'Stallbackabron' && Number.isFinite(vessel.distanceToCurrent)) {
      const intermediateUnder = wasUnderBridge
        ? vessel.distanceToCurrent < UNDER_BRIDGE_CLEAR_DISTANCE // Clear at 70m
        : vessel.distanceToCurrent <= UNDER_BRIDGE_SET_DISTANCE; // Set at 50m

      if (intermediateUnder) {
        vessel._underBridgeLatched = true;
        this.logger.debug(`🌉 [INTERMEDIATE_UNDER] ${vessel.mmsi}: ${vessel.distanceToCurrent.toFixed(0)}m from ${vessel.currentBridge} -> under-bridge`);
        return true;
      }
    }

    // Check distance to TARGET BRIDGE with hysteresis
    const targetDistance = this._getDistanceToTargetBridge(vessel);
    if (targetDistance !== null && Number.isFinite(targetDistance)) {
      const targetUnder = wasUnderBridge
        ? targetDistance < UNDER_BRIDGE_CLEAR_DISTANCE // Clear at 70m
        : targetDistance <= UNDER_BRIDGE_SET_DISTANCE; // Set at 50m

      if (targetUnder) {
        vessel._underBridgeLatched = true;
        this.logger.debug(`🎯 [TARGET_UNDER] ${vessel.mmsi}: ${targetDistance.toFixed(0)}m from target -> under-bridge`);
        return true;
      }
    }

    // Clear latch if no longer under any bridge
    if (wasUnderBridge) {
      vessel._underBridgeLatched = false;
      this.logger.debug(`🌉 [UNDER_BRIDGE_CLEAR] ${vessel.mmsi}: No longer under bridge (cleared at >=${UNDER_BRIDGE_CLEAR_DISTANCE}m)`);
    }

    return false;
  }

  /**
   * Check if vessel is waiting (NEW: Stallbackabron special handling)
   * @private
   */
  _isWaiting(vessel, proximityData) {
    // STALLBACKABRON SPECIAL RULE: NEVER "waiting" status for Stallbackabron
    // This prevents "inväntar broöppning" messages for high bridge
    if (this._isAtStallbackabron(vessel, proximityData)) {
      this.logger.debug(`🌉 [WAITING_CHECK] ${vessel.mmsi}: At Stallbackabron - no waiting status`);
      return false; // Stallbackabron uses special "åker strax under" logic instead
    }

    // FIXED RULE: ≤300m from TARGET BRIDGE triggers "waiting" status
    // This triggers "En båt inväntar broöppning vid X" message
    const targetDistance = this._getDistanceToTargetBridge(vessel);
    const targetDistanceStr = targetDistance !== null ? `${targetDistance.toFixed(0)}` : 'N/A';
    this.logger.debug(`🔍 [WAITING_CHECK] ${vessel.mmsi}: Target distance = ${targetDistanceStr}m to ${vessel.targetBridge || 'none'}, threshold = ${APPROACH_RADIUS}m`);

    if (targetDistance !== null && targetDistance <= APPROACH_RADIUS) {
      // BUGFIX: Förhindra återgång till waiting vid samma bro som precis passerats
      if (this._hasRecentlyPassed(vessel) && vessel.lastPassedBridge === vessel.targetBridge) {
        this.logger.debug(`🚫 [WAITING_BLOCKED] ${vessel.mmsi}: Recently passed target bridge ${vessel.targetBridge}, blocking waiting status`);
        return false;
      }
      this.logger.debug(`✅ [WAITING_TRUE] ${vessel.mmsi}: Within ${targetDistance.toFixed(0)}m of target bridge ${vessel.targetBridge} -> waiting status`);
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
          // BUGFIX: Förhindra återgång till waiting vid samma intermediate bro som precis passerats
          if (this._hasRecentlyPassed(vessel) && vessel.lastPassedBridge === bridgeName) {
            this.logger.debug(`🚫 [WAITING_BLOCKED] ${vessel.mmsi}: Recently passed intermediate bridge ${bridgeName}, blocking waiting status`);
            return false;
          }

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
    // NEW RULE: ≤500m from ANY bridge triggers "approaching" status
    // This enables "En båt närmar sig [bro]" messages according to bridgeTextFormat.md

    // Priority 1: Check distance to TARGET BRIDGE first (500m rule)
    const targetDistance = this._getDistanceToTargetBridge(vessel);
    if (targetDistance !== null && targetDistance <= APPROACHING_RADIUS && targetDistance > APPROACH_RADIUS) {
      this.logger.debug(`🟡 [APPROACHING_TARGET] ${vessel.mmsi}: ${targetDistance.toFixed(0)}m from target bridge "${vessel.targetBridge}" -> approaching status`);
      return true;
    }

    // Priority 2: Check distance to INTERMEDIATE bridges (500m rule)
    // NOTE: No speed check needed here - VesselDataService already filters anchored boats
    // by removing targetBridge from vessels with <0.5kn at 300-500m distance
    if (proximityData.nearestDistance <= APPROACHING_RADIUS && proximityData.nearestDistance > APPROACH_RADIUS) {
      const { nearestBridge } = proximityData;
      if (nearestBridge && nearestBridge.name) {
        const bridgeName = nearestBridge.name;
        // Check if this is an intermediate bridge or Stallbackabron
        const isIntermediateBridge = ['Olidebron', 'Järnvägsbron', 'Stallbackabron'].includes(bridgeName);
        if (isIntermediateBridge) {
          this.logger.debug(`🟡 [APPROACHING_INTERMEDIATE] ${vessel.mmsi}: ${proximityData.nearestDistance.toFixed(0)}m from intermediate bridge "${bridgeName}" -> approaching status`);

          // Set currentBridge for proper intermediate bridge detection
          vessel.currentBridge = bridgeName;
          vessel.distanceToCurrent = proximityData.nearestDistance;

          return true;
        }
      }
    }

    // STALLBACKABRON SPECIAL: Check if vessel is approaching Stallbackabron (500m rule) - FALLBACK
    const stallbackabron = this.bridgeRegistry.getBridgeByName('Stallbackabron');
    if (stallbackabron) {
      const distanceToStallbacka = geometry.calculateDistance(
        vessel.lat, vessel.lon,
        stallbackabron.lat, stallbackabron.lon,
      );
      if (distanceToStallbacka <= APPROACHING_RADIUS && distanceToStallbacka > APPROACH_RADIUS && vessel.sog > 0.5) {
        this.logger.debug(`🌉 [STALLBACKA_APPROACHING] ${vessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from "Stallbackabron" -> approaching status`);

        // Set currentBridge for proper Stallbackabron detection
        vessel.currentBridge = 'Stallbackabron';
        vessel.distanceToCurrent = distanceToStallbacka;

        return true;
      }
    }

    return false;
  }

  /**
   * Check if vessel has recently passed a bridge
   * @private
   */
  _hasRecentlyPassed(vessel) {
    if (!vessel.lastPassedBridgeTime) {
      return false;
    }

    // SPEC-SYNCED: "precis passerat" hold window = 60 seconds
    // This must match BridgeTextService._hasRecentlyPassed() for consistency
    const timeSincePass = Date.now() - vessel.lastPassedBridgeTime;
    const passedWindow = 60 * 1000; // 60 seconds as per bridgeTextFormat.md specification

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
   * @deprecated Use PassageWindowManager instead
   */
  _calculatePassageWindow(vessel) {
    // Use PassageWindowManager for internal grace period
    return this.passageWindowManager.getInternalGracePeriod(vessel);
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

    return geometry.calculateDistance(
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
    const stallbackabron = this.bridgeRegistry.getBridgeByName('Stallbackabron');
    if (!stallbackabron) {
      return false;
    }

    const distanceToStallbacka = geometry.calculateDistance(
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
    const stallbackabron = this.bridgeRegistry.getBridgeByName('Stallbackabron');
    if (!stallbackabron) {
      return false;
    }

    // CRITICAL FIX: Don't go back to stallbacka-waiting if vessel has already passed Stallbackabron
    if (vessel.passedBridges && vessel.passedBridges.includes('Stallbackabron')) {
      this.logger.debug(`🌉 [STALLBACKA_PASSED] ${vessel.mmsi}: Already passed Stallbackabron - no stallbacka-waiting status`);
      return false;
    }

    const distanceToStallbacka = geometry.calculateDistance(
      vessel.lat, vessel.lon,
      stallbackabron.lat, stallbackabron.lon,
    );

    // STALLBACKABRON SPECIAL RULE: <300m triggers "åker strax under" instead of "inväntar broöppning"
    // UPDATED: Also handle <50m vessels (they should NOT get under-bridge status)
    // This applies to ANY vessel passing through Stallbackabron (always intermediate bridge)
    const isWithinStallbackaRange = distanceToStallbacka <= APPROACH_RADIUS;

    if (isWithinStallbackaRange) {
      this.logger.debug(`🌉 [STALLBACKA_SPECIAL] ${vessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from Stallbackabron -> "åker strax under" (INTERMEDIATE BRIDGE, no under-bridge status)`);
      return true;
    }

    return false;
  }

  /**
   * Calculate distance between two points in meters
   * @private
   */
}

module.exports = StatusService;
