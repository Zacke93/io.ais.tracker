'use strict';

const EventEmitter = require('events');
const {
  WAITING_SPEED_THRESHOLD,
  UNDER_BRIDGE_SET_DISTANCE,
  UNDER_BRIDGE_CLEAR_DISTANCE,
  MOVEMENT_DETECTION,
  APPROACHING_RADIUS,
  APPROACH_RADIUS,
  STATUS_HYSTERESIS,
} = require('../constants');
const geometry = require('../utils/geometry');
const StallbackabronHelper = require('../utils/StallbackabronHelper');
// ETA validation functions moved to ProgressiveETACalculator
const CurrentBridgeManager = require('./CurrentBridgeManager');
const StatusStabilizer = require('./StatusStabilizer');
const PassageWindowManager = require('../utils/PassageWindowManager');
const ProgressiveETACalculator = require('./ProgressiveETACalculator');

/**
 * StatusService - Manages vessel status detection and transitions
 * Handles waiting detection, under-bridge detection, and status changes
 */
class StatusService extends EventEmitter {
  constructor(bridgeRegistry, logger, systemCoordinator, vesselDataService = null) {
    super();
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
    this.systemCoordinator = systemCoordinator;
    this.vesselDataService = vesselDataService;
    this.stallbackabronHelper = new StallbackabronHelper(bridgeRegistry, logger);
    this.currentBridgeManager = new CurrentBridgeManager(bridgeRegistry, logger);
    this.statusStabilizer = new StatusStabilizer(logger);
    this.passageWindowManager = new PassageWindowManager(logger, bridgeRegistry);
    this.progressiveETACalculator = new ProgressiveETACalculator(logger, bridgeRegistry);

    // Validate required dependencies
    if (!systemCoordinator) {
      throw new Error('SystemCoordinator is required for StatusService');
    }
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

    // HYSTERESIS CORRUPTION FIX: Reset state on GPS jumps before processing
    if (positionAnalysis?.gpsJumpDetected
        || (positionAnalysis?.analysis?.isGPSJump && positionAnalysis.analysis.movementDistance > 500)) {
      vessel._underBridgeLatched = false;
      this.logger.debug(`🔄 [HYSTERESIS_RESET] ${vessel.mmsi}: GPS jump detected (${positionAnalysis.analysis?.movementDistance?.toFixed(0) || 'unknown'}m) - resetting latch`);
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
   * Calculate ETA to target bridge (FIX 4: PROGRESSIVE ROUTE-BASED ETA)
   * @param {Object} vessel - Vessel object
   * @param {Object} proximityData - Proximity data
   * @returns {number|null} ETA in minutes or null
   */
  calculateETA(vessel, proximityData) {
    // FIX 4: Use ProgressiveETACalculator instead of direct distance calculation
    const progressiveETA = this.progressiveETACalculator.calculateProgressiveETA(vessel, proximityData);

    if (progressiveETA !== null) {
      this.logger.debug(
        `⏰ [ETA_CALC_V2] ${vessel.mmsi}: Progressive ETA to ${vessel.targetBridge} = ${progressiveETA.toFixed(1)}min`,
      );
      return progressiveETA;
    }

    // Fallback: If progressive calculation fails, log warning and return null
    this.logger.debug(
      `⏰ [ETA_CALC_V2] ${vessel.mmsi}: Progressive ETA calculation failed - returning null`,
    );
    return null;
  }

  /**
   * Check if vessel is under a bridge (with hysteresis)
   * @private
   */
  _isUnderBridge(vessel, proximityData) {
    // Get previous under-bridge state for hysteresis
    const wasUnderBridge = vessel._underBridgeLatched || false;

    // HYSTERESIS CORRUPTION FIX: Check for reset conditions
    const hysteresisWasReset = this._checkHysteresisResetConditions(vessel);

    // If hysteresis was reset, we should not use the previous wasUnderBridge state
    const effectiveWasUnderBridge = hysteresisWasReset ? false : wasUnderBridge;

    // STALLBACKABRON SPECIAL: Skip Stallbackabron in under-bridge detection
    // Stallbackabron should NEVER use "under-bridge" status according to bridgeTextFormat.md
    // It uses special "stallbacka-waiting" (<300m) and special message formatting instead
    // This is handled separately in _isStallbackabraBridgeWaiting method

    // INTERMEDIATE BRIDGE CHECK: If vessel has currentBridge set and is very close to it
    // BUT skip Stallbackabron - it uses special status instead of under-bridge
    if (vessel.currentBridge && vessel.currentBridge !== 'Stallbackabron' && Number.isFinite(vessel.distanceToCurrent)) {
      const intermediateUnder = effectiveWasUnderBridge
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
      const targetUnder = effectiveWasUnderBridge
        ? targetDistance < UNDER_BRIDGE_CLEAR_DISTANCE // Clear at 70m
        : targetDistance <= UNDER_BRIDGE_SET_DISTANCE; // Set at 50m

      if (targetUnder) {
        vessel._underBridgeLatched = true;
        this.logger.debug(`🎯 [TARGET_UNDER] ${vessel.mmsi}: ${targetDistance.toFixed(0)}m from target -> under-bridge`);
        return true;
      }
    }

    // Clear latch if no longer under any bridge
    if (effectiveWasUnderBridge) {
      vessel._underBridgeLatched = false;
      this.logger.debug(`🌉 [UNDER_BRIDGE_CLEAR] ${vessel.mmsi}: No longer under bridge (cleared at >=${UNDER_BRIDGE_CLEAR_DISTANCE}m)`);

      // PASSAGE ANCHORING: Record crossing timestamp for deduplication
      if (this.vesselDataService && (vessel.currentBridge || vessel.targetBridge)) {
        const bridgeForAnchoring = vessel.currentBridge || vessel.targetBridge;
        this.vesselDataService._anchorPassageTimestamp(vessel, bridgeForAnchoring, Date.now());
      }
    }

    return false;
  }

  /**
   * Check and apply hysteresis reset conditions to prevent state corruption
   * @private
   */
  _checkHysteresisResetConditions(vessel) {
    const { mmsi } = vessel;
    let resetReason = null;

    // Reset on target bridge changes
    const lastTargetBridge = vessel._lastTargetBridgeForHysteresis;
    if (lastTargetBridge && vessel.targetBridge !== lastTargetBridge) {
      resetReason = `Target bridge changed from ${lastTargetBridge} to ${vessel.targetBridge}`;
    } else if (vessel._lastCurrentBridgeForHysteresis
               && vessel.currentBridge !== vessel._lastCurrentBridgeForHysteresis
               && vessel.currentBridge && vessel._lastCurrentBridgeForHysteresis) {
      // Reset on significant current bridge changes (new logic)
      // Only reset if both bridges are valid (not null) to avoid false triggers
      resetReason = `Current bridge changed from ${vessel._lastCurrentBridgeForHysteresis} to ${vessel.currentBridge}`;
    } else if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
      // Reset on position validation failure
      resetReason = 'Invalid vessel position data';
    }

    // Apply reset if any condition triggered
    if (resetReason) {
      vessel._underBridgeLatched = false;
      this.logger.debug(`🔄 [HYSTERESIS_RESET] ${mmsi}: ${resetReason} - resetting latch`);
    }

    // Update tracking properties (ALWAYS, even after reset)
    if (vessel.targetBridge) {
      vessel._lastTargetBridgeForHysteresis = vessel.targetBridge;
    }
    if (vessel.currentBridge) {
      vessel._lastCurrentBridgeForHysteresis = vessel.currentBridge;
    }

    return resetReason !== null; // Return true if reset was applied
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
    // NEW RULE: ≤500m from ANY bridge triggers "approaching" status with HYSTERESIS
    // This enables "En båt närmar sig [bro]" messages according to bridgeTextFormat.md
    // HYSTERESIS: 450m activates, 550m deactivates to reduce UI pendling

    // Priority 1: Check distance to TARGET BRIDGE first with HYSTERESIS
    const targetDistance = this._getDistanceToTargetBridge(vessel);
    if (targetDistance !== null) {
      const currentlyApproaching = vessel.status === 'approaching';

      // HYSTERESIS: Use different thresholds based on current status
      const approachThreshold = currentlyApproaching
        ? STATUS_HYSTERESIS.APPROACHING_CLEAR_DISTANCE // 550m to clear
        : STATUS_HYSTERESIS.APPROACHING_SET_DISTANCE; // 450m to set

      if (targetDistance <= approachThreshold && targetDistance > APPROACH_RADIUS) {
        const action = currentlyApproaching ? 'maintaining' : 'setting';
        this.logger.debug(`🟡 [APPROACHING_TARGET_HYSTERESIS] ${vessel.mmsi}: ${targetDistance.toFixed(0)}m from target bridge "${vessel.targetBridge}" (threshold=${approachThreshold}m) -> ${action} approaching status`);
        return true;
      }
    }

    // Priority 2: Check distance to INTERMEDIATE bridges with HYSTERESIS
    // NOTE: No speed check needed here - VesselDataService already filters anchored boats
    // by removing targetBridge from vessels with <0.5kn at 300-500m distance
    const currentlyApproaching = vessel.status === 'approaching';
    const approachThreshold = currentlyApproaching
      ? STATUS_HYSTERESIS.APPROACHING_CLEAR_DISTANCE // 550m to clear
      : STATUS_HYSTERESIS.APPROACHING_SET_DISTANCE; // 450m to set

    if (proximityData.nearestDistance <= approachThreshold && proximityData.nearestDistance > APPROACH_RADIUS) {
      const { nearestBridge } = proximityData;
      if (nearestBridge && nearestBridge.name) {
        const bridgeName = nearestBridge.name;
        // Check if this is an intermediate bridge or Stallbackabron
        const isIntermediateBridge = ['Olidebron', 'Järnvägsbron', 'Stallbackabron'].includes(bridgeName);
        if (isIntermediateBridge) {
          const action = currentlyApproaching ? 'maintaining' : 'setting';
          this.logger.debug(`🟡 [APPROACHING_INTERMEDIATE_HYSTERESIS] ${vessel.mmsi}: ${proximityData.nearestDistance.toFixed(0)}m from intermediate bridge "${bridgeName}" (threshold=${approachThreshold}m) -> ${action} approaching status`);

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

      // CRITICAL FIX: Handle null/invalid distance calculation gracefully with HYSTERESIS
      // ENHANCED: Also check if vessel is actually approaching (distance decreasing or course toward bridge)
      if (distanceToStallbacka !== null && Number.isFinite(distanceToStallbacka)) {
        const stallbackaApproachThreshold = currentlyApproaching
          ? STATUS_HYSTERESIS.APPROACHING_CLEAR_DISTANCE // 550m to clear
          : STATUS_HYSTERESIS.APPROACHING_SET_DISTANCE; // 450m to set

        if (distanceToStallbacka <= stallbackaApproachThreshold && distanceToStallbacka > APPROACH_RADIUS
            && vessel.sog > 0.5 && this._isActuallyApproaching(vessel, stallbackabron, distanceToStallbacka)) {
          const action = currentlyApproaching ? 'maintaining' : 'setting';
          this.logger.debug(`🌉 [STALLBACKA_APPROACHING_HYSTERESIS] ${vessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from "Stallbackabron" (threshold=${stallbackaApproachThreshold}m) -> ${action} approaching status`);

          // Set currentBridge for proper Stallbackabron detection
          vessel.currentBridge = 'Stallbackabron';
          vessel.distanceToCurrent = distanceToStallbacka;

          return true;
        }
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
   * Centralized check for whether vessel should trigger "precis passerat" updates
   * Used to prevent duplicate bridge text publishing at source
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if vessel should trigger precis passerat updates
   */
  shouldTriggerPrecisPasseratUpdates(vessel) {
    // Only trigger for vessels with "passed" status
    if (vessel.status !== 'passed') {
      return false;
    }

    // Respect the passage window
    if (!this._hasRecentlyPassed(vessel)) {
      return false;
    }

    return true;
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

    // CRITICAL FIX: Handle null/invalid distance calculation gracefully
    if (distanceToStallbacka === null || !Number.isFinite(distanceToStallbacka)) {
      return false;
    }

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

    // CRITICAL FIX: Handle null/invalid distance calculation gracefully
    if (distanceToStallbacka === null || !Number.isFinite(distanceToStallbacka)) {
      this.logger.debug(`🌉 [STALLBACKA_INVALID_DISTANCE] ${vessel.mmsi}: Invalid distance calculation to Stallbackabron - no stallbacka-waiting status`);
      return false;
    }

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
   * Check if vessel is actually approaching a bridge (not just within range)
   * Validates that vessel is moving toward bridge or distance is decreasing
   * @private
   * @param {Object} vessel - Vessel object with lat, lon, cog, previousPosition
   * @param {Object} bridge - Bridge object with lat, lon
   * @param {number} currentDistance - Current distance to bridge in meters
   * @returns {boolean} True if vessel is genuinely approaching
   */
  _isActuallyApproaching(vessel, bridge, currentDistance) {
    try {
      // Method 1: Check if course is roughly toward the bridge
      if (Number.isFinite(vessel.cog) && vessel.cog >= 0 && vessel.cog < 360) {
        const bearingToBridge = geometry.calculateBearing(
          vessel.lat, vessel.lon,
          bridge.lat, bridge.lon,
        );

        if (bearingToBridge !== null && Number.isFinite(bearingToBridge)) {
          // Calculate course difference (handle wrap-around)
          let courseDiff = Math.abs(vessel.cog - bearingToBridge);
          if (courseDiff > 180) courseDiff = 360 - courseDiff;

          // Consider "approaching" if course is within 90 degrees of bridge bearing
          const isCoursedToward = courseDiff <= 90;

          this.logger.debug(
            `🧭 [APPROACH_CHECK] ${vessel.mmsi}: COG=${vessel.cog.toFixed(1)}°, bearing=${bearingToBridge.toFixed(1)}°, diff=${courseDiff.toFixed(1)}°, toward=${isCoursedToward}`,
          );

          if (isCoursedToward) {
            return true;
          }
        }
      }

      // Method 2: Check if distance is decreasing (if we have previous position)
      if (vessel.previousPosition && vessel.previousPosition.lat && vessel.previousPosition.lon) {
        const previousDistance = geometry.calculateDistance(
          vessel.previousPosition.lat, vessel.previousPosition.lon,
          bridge.lat, bridge.lon,
        );

        if (previousDistance !== null && Number.isFinite(previousDistance)) {
          const distanceChange = currentDistance - previousDistance;
          const isCloser = distanceChange < -5; // At least 5m closer

          this.logger.debug(
            `📏 [DISTANCE_CHECK] ${vessel.mmsi}: prev=${previousDistance.toFixed(0)}m, curr=${currentDistance.toFixed(0)}m, change=${distanceChange.toFixed(1)}m, closer=${isCloser}`,
          );

          if (isCloser) {
            return true;
          }
        }
      }

      // Method 3: Fallback - if vessel is moving at reasonable speed, assume approaching
      // This handles cases where we lack good course/position history
      if (Number.isFinite(vessel.sog) && vessel.sog > 2.0) {
        this.logger.debug(
          `⚡ [SPEED_FALLBACK] ${vessel.mmsi}: Speed ${vessel.sog.toFixed(1)}kn > 2kn, assuming approaching`,
        );
        return true;
      }

      this.logger.debug(
        `❌ [NOT_APPROACHING] ${vessel.mmsi}: No evidence of approaching - course unclear, distance not decreasing, speed low`,
      );
      return false;

    } catch (error) {
      this.logger.debug(`⚠️ [APPROACH_CHECK_ERROR] ${vessel.mmsi}: Error checking approach: ${error.message}`);
      // On error, be conservative and allow approaching (avoids blocking legitimate vessels)
      return true;
    }
  }

  /**
   * Calculate distance between two points in meters
   * @private
   */
}

module.exports = StatusService;
