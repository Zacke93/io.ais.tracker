'use strict';

const EventEmitter = require('events');

/**
 * SystemCoordinator - Coordinates between GPS analysis, status stabilization, and user experience
 * Ensures smooth operation when GPS events occur and prevents rapid status/text changes
 */
class SystemCoordinator extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;

    // Coordination state tracking
    this.vesselCoordinationState = new Map(); // Map<mmsi, CoordinationState>
    this.bridgeTextDebounce = new Map(); // Map<bridgeId, DebounceData>
    this.globalSystemState = {
      unstableGPSCount: 0,
      lastStabilityEvent: null,
      coordinationActive: false,
    };

    // Configuration
    this.config = {
      bridgeTextDebounceMs: 2000, // 2 seconds
      gpsEventCooldownMs: 5000, // 5 seconds
      maxConcurrentGPSEvents: 3,
      stabilizationCoordinationMs: 10000, // 10 seconds
    };
  }

  /**
   * Coordinate vessel position update with GPS analysis and stabilization
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} gpsAnalysis - GPS jump analysis result
   * @param {Object} vessel - Vessel data
   * @param {Object} oldVessel - Previous vessel data
   * @returns {Object} Coordination recommendation
   */
  coordinatePositionUpdate(mmsi, gpsAnalysis, vessel, oldVessel) {
    const coordinationState = this._getOrCreateCoordinationState(mmsi);
    const currentTime = Date.now();

    // Update coordination state with GPS analysis
    coordinationState.lastGPSAnalysis = gpsAnalysis;
    coordinationState.lastUpdateTime = currentTime;

    const recommendation = {
      shouldProceed: true,
      shouldActivateProtection: false,
      shouldDebounceText: false,
      stabilizationLevel: 'normal',
      reason: 'normal_operation',
      coordinationActive: false,
    };

    // Handle GPS jump events
    if (gpsAnalysis.isGPSJump) {
      this._handleGPSJumpEvent(mmsi, coordinationState, recommendation, currentTime);
    } else if (gpsAnalysis.action === 'accept_with_caution') {
      this._handleUncertainPosition(mmsi, coordinationState, recommendation, currentTime);
    } else if (gpsAnalysis.movementDistance > 300) {
      this._handleLargeMovement(mmsi, coordinationState, recommendation, currentTime);
    }

    // Check for system-wide instability
    this._assessSystemStability(recommendation, currentTime);

    // Update global coordination state
    this._updateGlobalCoordinationState(gpsAnalysis, currentTime);

    this.logger.debug(
      `🎮 [COORDINATION] ${mmsi}: ${recommendation.reason} `
      + `(proceed: ${recommendation.shouldProceed}, protection: ${recommendation.shouldActivateProtection}, `
      + `debounce: ${recommendation.shouldDebounceText}, level: ${recommendation.stabilizationLevel})`,
    );

    return recommendation;
  }

  /**
   * Coordinate status stabilization with protection systems
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} statusResult - Status analysis result
   * @param {Object} positionAnalysis - Position analysis data
   * @returns {Object} Enhanced stabilization recommendation
   */
  coordinateStatusStabilization(mmsi, statusResult, positionAnalysis) {
    const coordinationState = this._getOrCreateCoordinationState(mmsi);
    const currentTime = Date.now();

    const enhancedResult = {
      ...statusResult,
      coordinationApplied: false,
      extendedStabilization: false,
      bridgeTextDebounced: false,
    };

    // Apply enhanced stabilization during active coordination
    if (coordinationState.coordinationActive) {
      this._applyEnhancedStabilization(mmsi, coordinationState, enhancedResult, currentTime);
    }

    // Check if bridge text should be debounced
    if (statusResult.statusChanged || statusResult.stabilized) {
      const shouldDebounce = this._shouldDebounceBridgeText(mmsi, coordinationState, currentTime);
      if (shouldDebounce) {
        enhancedResult.bridgeTextDebounced = true;
        this._activateBridgeTextDebounce(mmsi, currentTime);
      }
    }

    return enhancedResult;
  }

  /**
   * Check if bridge text updates should be debounced
   * @param {Array} vessels - Current vessels
   * @returns {Object} Debounce recommendation
   */
  shouldDebounceBridgeText(vessels) {
    const currentTime = Date.now();
    let activeDebounces = 0;
    let maxRemainingTime = 0;

    // Check for active debounces
    for (const [mmsi, debounceData] of this.bridgeTextDebounce.entries()) {
      const remaining = debounceData.endTime - currentTime;
      if (remaining > 0) {
        activeDebounces++;
        maxRemainingTime = Math.max(maxRemainingTime, remaining);
      } else {
        this.bridgeTextDebounce.delete(mmsi);
      }
    }

    // Check for vessels in coordination (with null safety)
    const vesselsInCoordination = vessels.filter((vessel) => {
      if (!vessel || !vessel.mmsi) return false; // SAFETY: Skip null/invalid vessels
      const state = this.vesselCoordinationState.get(vessel.mmsi);
      return state?.coordinationActive;
    });

    const shouldDebounce = activeDebounces > 0 || vesselsInCoordination.length > 0
                          || this.globalSystemState.coordinationActive;

    return {
      shouldDebounce,
      remainingTime: maxRemainingTime,
      activeDebounces,
      vesselsInCoordination: vesselsInCoordination.length,
      reason: shouldDebounce ? this._getDebounceReason(activeDebounces, vesselsInCoordination.length) : 'no_debounce_needed',
    };
  }

  /**
   * Handle GPS jump event with enhanced coordination
   * @private
   */
  _handleGPSJumpEvent(mmsi, coordinationState, recommendation, currentTime) {
    this.globalSystemState.unstableGPSCount++;

    // Activate strong coordination for GPS jumps
    coordinationState.coordinationActive = true;
    coordinationState.coordinationStartTime = currentTime;
    coordinationState.coordinationType = 'gps_jump';

    recommendation.shouldActivateProtection = true;
    recommendation.shouldDebounceText = true;
    recommendation.stabilizationLevel = 'enhanced';
    recommendation.reason = 'gps_jump_coordination';
    recommendation.coordinationActive = true;

    this.logger.log(
      `🚨 [GPS_JUMP_COORDINATION] ${mmsi}: Activating enhanced coordination for GPS jump `
      + `(distance: ${coordinationState.lastGPSAnalysis?.movementDistance?.toFixed(0)}m)`,
    );

    // Emit coordination event
    this.emit('coordination:gps_jump', {
      mmsi,
      distance: coordinationState.lastGPSAnalysis?.movementDistance,
      coordinationDuration: this.config.stabilizationCoordinationMs,
    });
  }

  /**
   * Handle uncertain position with moderate coordination
   * @private
   */
  _handleUncertainPosition(mmsi, coordinationState, recommendation, currentTime) {
    coordinationState.coordinationActive = true;
    coordinationState.coordinationStartTime = currentTime;
    coordinationState.coordinationType = 'uncertain_position';

    recommendation.shouldActivateProtection = true;
    recommendation.shouldDebounceText = true;
    recommendation.stabilizationLevel = 'moderate';
    recommendation.reason = 'uncertain_position_coordination';
    recommendation.coordinationActive = true;

    this.logger.debug(
      `⚠️ [UNCERTAIN_COORDINATION] ${mmsi}: Activating moderate coordination for uncertain position`,
    );
  }

  /**
   * Handle large movement with light coordination
   * @private
   */
  _handleLargeMovement(mmsi, coordinationState, recommendation, currentTime) {
    // For large but legitimate movements, apply light coordination
    coordinationState.coordinationActive = true;
    coordinationState.coordinationStartTime = currentTime;
    coordinationState.coordinationType = 'large_movement';

    recommendation.shouldDebounceText = true;
    recommendation.stabilizationLevel = 'light';
    recommendation.reason = 'large_movement_coordination';
    recommendation.coordinationActive = true;

    this.logger.debug(
      `🔄 [LARGE_MOVEMENT_COORDINATION] ${mmsi}: Applying light coordination for large movement `
      + `(${coordinationState.lastGPSAnalysis?.movementDistance?.toFixed(0)}m)`,
    );
  }

  /**
   * Apply enhanced stabilization during coordination
   * @private
   */
  _applyEnhancedStabilization(mmsi, coordinationState, enhancedResult, currentTime) {
    const coordinationDuration = currentTime - coordinationState.coordinationStartTime;
    const remainingTime = this.config.stabilizationCoordinationMs - coordinationDuration;

    if (remainingTime > 0) {
      enhancedResult.extendedStabilization = true;
      enhancedResult.coordinationApplied = true;

      this.logger.debug(
        `🛡️ [ENHANCED_STABILIZATION] ${mmsi}: Extended stabilization active `
        + `(${coordinationState.coordinationType}, remaining: ${(remainingTime / 1000).toFixed(1)}s)`,
      );
    } else {
      // End coordination period
      coordinationState.coordinationActive = false;
      this.logger.debug(`✅ [COORDINATION_END] ${mmsi}: Coordination period ended`);
    }
  }

  /**
   * Check if bridge text should be debounced for specific vessel
   * @private
   */
  _shouldDebounceBridgeText(mmsi, coordinationState, currentTime) {
    // Always debounce during active coordination
    if (coordinationState.coordinationActive) {
      return true;
    }

    // Check for recent GPS events
    const timeSinceLastGPS = currentTime - (coordinationState.lastGPSEventTime || 0);
    if (timeSinceLastGPS < this.config.gpsEventCooldownMs) {
      return true;
    }

    // Check global system stability
    if (this.globalSystemState.coordinationActive) {
      return true;
    }

    return false;
  }

  /**
   * Activate bridge text debounce
   * @private
   */
  _activateBridgeTextDebounce(mmsi, currentTime) {
    // Check for existing debounce and clear any associated timer
    const existing = this.bridgeTextDebounce.get(mmsi);
    if (existing && existing.timer) {
      clearTimeout(existing.timer);
    }

    // Create new debounce entry with auto-cleanup timer
    const debounceData = {
      startTime: currentTime,
      endTime: currentTime + this.config.bridgeTextDebounceMs,
      reason: 'coordination_active',
      timer: null,
    };

    // Set auto-cleanup timer to prevent memory leak
    debounceData.timer = setTimeout(() => {
      // Clean up after debounce period
      if (this.bridgeTextDebounce.get(mmsi) === debounceData) {
        this.bridgeTextDebounce.delete(mmsi);
      }
    }, this.config.bridgeTextDebounceMs);

    // Atomic set operation
    this.bridgeTextDebounce.set(mmsi, debounceData);

    this.logger.debug(
      `⏸️ [BRIDGE_TEXT_DEBOUNCE] ${mmsi}: Debouncing bridge text updates for ${this.config.bridgeTextDebounceMs}ms`,
    );
  }

  /**
   * Assess overall system stability
   * @private
   */
  _assessSystemStability(recommendation, currentTime) {
    const unstableThreshold = this.config.maxConcurrentGPSEvents;

    if (this.globalSystemState.unstableGPSCount >= unstableThreshold) {
      recommendation.stabilizationLevel = 'system_wide';
      recommendation.shouldDebounceText = true;

      this.globalSystemState.coordinationActive = true;
      this.globalSystemState.lastStabilityEvent = currentTime;

      this.logger.log(
        '🌊 [SYSTEM_STABILITY] System-wide coordination activated '
        + `(${this.globalSystemState.unstableGPSCount} concurrent GPS events)`,
      );
    }
  }

  /**
   * Update global coordination state
   * @private
   */
  _updateGlobalCoordinationState(gpsAnalysis, currentTime) {
    // Decay unstable GPS count over time
    const timeSinceLastEvent = currentTime - (this.globalSystemState.lastStabilityEvent || currentTime);
    if (timeSinceLastEvent > this.config.gpsEventCooldownMs) {
      this.globalSystemState.unstableGPSCount = Math.max(0, this.globalSystemState.unstableGPSCount - 1);

      if (this.globalSystemState.unstableGPSCount === 0) {
        this.globalSystemState.coordinationActive = false;
      }
    }
  }

  /**
   * Get or create coordination state for vessel
   * @private
   */
  _getOrCreateCoordinationState(mmsi) {
    if (!this.vesselCoordinationState.has(mmsi)) {
      this.vesselCoordinationState.set(mmsi, {
        coordinationActive: false,
        coordinationStartTime: null,
        coordinationType: null,
        lastGPSAnalysis: null,
        lastGPSEventTime: null,
        lastUpdateTime: null,
        stabilizationHistory: [],
      });
    }
    return this.vesselCoordinationState.get(mmsi);
  }

  /**
   * Get debounce reason
   * @private
   */
  _getDebounceReason(activeDebounces, vesselsInCoordination) {
    if (activeDebounces > 0 && vesselsInCoordination > 0) {
      return 'active_debounces_and_coordination';
    }
    if (activeDebounces > 0) {
      return 'active_debounces';
    }
    if (vesselsInCoordination > 0) {
      return 'vessels_in_coordination';
    }
    if (this.globalSystemState.coordinationActive) {
      return 'system_wide_coordination';
    }
    return 'unknown';
  }

  /**
   * Clean up old coordination state
   */
  cleanup() {
    const currentTime = Date.now();
    const oneHourAgo = currentTime - (60 * 60 * 1000);

    // Clean vessel coordination state
    for (const [mmsi, state] of this.vesselCoordinationState.entries()) {
      if (!state.lastUpdateTime || state.lastUpdateTime < oneHourAgo) {
        // Clear any active timers before deleting
        if (state.protectionTimer) {
          clearTimeout(state.protectionTimer);
        }
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer);
        }
        this.vesselCoordinationState.delete(mmsi);
      }
    }

    // Clean bridge text debounces and clear associated timers
    for (const [mmsi, debounceData] of this.bridgeTextDebounce.entries()) {
      if (debounceData.endTime < currentTime) {
        if (debounceData.timer) {
          clearTimeout(debounceData.timer);
        }
        this.bridgeTextDebounce.delete(mmsi);
      }
    }

    this.logger.debug('🧹 [COORDINATION_CLEANUP] Cleaned old coordination state and timers');
  }

  /**
   * Remove vessel from coordination tracking
   */
  removeVessel(mmsi) {
    this.vesselCoordinationState.delete(mmsi);
    this.bridgeTextDebounce.delete(mmsi);
  }

  /**
   * Get coordination status for debugging
   */
  getCoordinationStatus() {
    return {
      globalState: { ...this.globalSystemState },
      activeCoordinations: this.vesselCoordinationState.size,
      activeDebounces: this.bridgeTextDebounce.size,
      config: { ...this.config },
    };
  }
}

module.exports = SystemCoordinator;
