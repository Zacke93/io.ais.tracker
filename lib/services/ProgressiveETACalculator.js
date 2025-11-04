'use strict';

const geometry = require('../utils/geometry');
const {
  isValidVesselCoordinates, isValidSpeed, safeDivision, isValidDistance,
} = require('../utils/etaValidation');

/**
 * ProgressiveETACalculator - Progressive route-based ETA calculation
 *
 * ENHANCED V2.0: ETA Monotoni-skydd + EMA Smoothing
 * - Calculates ETA based on actual route through intermediate bridges
 * - MONOTONIC PROTECTION: Prevents unreasonable ETA regressions (7min → 1min → 10min)
 * - EMA SMOOTHING: Exponential moving average for stable ETA transitions
 * - OUTLIER DETECTION: Filters suspicious ETA jumps and GPS-related anomalies
 */
class ProgressiveETACalculator {
  constructor(logger, bridgeRegistry) {
    this.logger = logger;
    this.bridgeRegistry = bridgeRegistry;

    // ETA MONOTONI-SKYDD: History tracking per vessel
    this._etaHistory = new Map(); // Map<mmsi, ETAHistoryEntry[]>

    // EMA SMOOTHING: Configuration
    this._emaAlpha = 0.3; // Smoothing factor (0 = no change, 1 = no smoothing)
    this._maxHistoryLength = 10; // Maximum ETA history entries per vessel
    this._monotonicThresholdPercent = 0.5; // 50% - maximum allowed backward regression
    this._outlierThresholdMultiple = 2.5; // 2.5x previous ETA is considered outlier

    // Cleanup timer for ETA history (disabled in test mode to avoid lingering timers)
    if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
      this._historyCleanupTimer = null;
      this.logger.debug('🧪 [ETA_CALCULATOR_V2] Test mode detected - skipping history cleanup timer');
    } else {
      this._historyCleanupTimer = setInterval(() => {
        this._cleanupOldETAHistory();
      }, 5 * 60 * 1000); // Every 5 minutes
    }

    this.logger.debug('🧮 [ETA_CALCULATOR_V2] Enhanced ETA calculator initialized with monotonic protection and EMA smoothing');
  }

  /**
   * Calculate progressive ETA to target bridge via route
   * ENHANCED: With monotonic protection and EMA smoothing
   * @param {Object} vessel - Vessel data
   * @param {Object} proximityData - Proximity data with nearestBridge
   * @returns {number|null} ETA in minutes or null
   */
  calculateProgressiveETA(vessel, proximityData) {
    try {
      // Robust validation with enhanced logging for debugging
      if (!vessel || !vessel.targetBridge || !vessel.mmsi) {
        this.logger.debug(
          `⚠️ [ETA_VALIDATION] ${vessel?.mmsi || 'unknown'}: Invalid vessel data - `
          + `vessel=${!!vessel}, targetBridge=${vessel?.targetBridge}, mmsi=${vessel?.mmsi}`,
        );
        return null;
      }

      if (!isValidVesselCoordinates(vessel)) {
        this.logger.debug(
          `⚠️ [ETA_COORDINATES] ${vessel.mmsi}: Invalid coordinates - `
          + `lat=${vessel.lat}, lon=${vessel.lon}`,
        );
        return null;
      }

      this.logger.debug(
        `⏰ [ETA_START] ${vessel.mmsi}: Calculating ETA to ${vessel.targetBridge} `
        + `(nearest: ${proximityData?.nearestBridge || 'none'})`,
      );

      // STEP 1: Calculate raw ETA using existing logic
      let rawETA;
      const nearestBridgeId = this._extractBridgeIdentifier(proximityData?.nearestBridge);
      const targetBridgeId = this._extractBridgeIdentifier(vessel.targetBridge);
      const calculationMethod = !proximityData || !nearestBridgeId
        ? 'direct_fallback'
        : nearestBridgeId === targetBridgeId
          ? 'direct_at_target'
          : 'progressive_route';

      this.logger.debug(`📊 [ETA_METHOD] ${vessel.mmsi}: Using ${calculationMethod} calculation`);

      if (!proximityData || !nearestBridgeId) {
        // Fallback to direct calculation
        rawETA = this._calculateDirectETA(vessel);
      } else if (nearestBridgeId === targetBridgeId) {
        rawETA = this._calculateDirectETA(vessel);
      } else {
        // Calculate progressive route ETA
        rawETA = this._calculateRouteETA(vessel, nearestBridgeId, targetBridgeId, proximityData);
      }

      if (rawETA === null) {
        this.logger.debug(`❌ [ETA_FAILED] ${vessel.mmsi}: Raw ETA calculation failed`);
        return null;
      }

      this.logger.debug(`📊 [ETA_RAW] ${vessel.mmsi}: Raw ETA = ${rawETA.toFixed(1)}min`);

      // STEP 2: Apply enhanced ETA processing (monotonic protection + EMA smoothing)
      const processedETA = this._processETAWithProtection(vessel, rawETA, proximityData);

      if (processedETA !== null) {
        this.logger.debug(
          `✅ [ETA_FINAL] ${vessel.mmsi}: Final ETA = ${processedETA.toFixed(1)}min `
          + `(method: ${calculationMethod})`,
        );
      } else {
        this.logger.debug(`❌ [ETA_PROCESSING] ${vessel.mmsi}: ETA processing failed`);
      }

      return processedETA;

    } catch (error) {
      this.logger.error(
        `💥 [ETA_CRITICAL_ERROR] ${vessel?.mmsi || 'unknown'}: ETA calculation crashed: ${error.message}`,
      );
      this.logger.debug(`💥 [ETA_ERROR_STACK] ${vessel?.mmsi || 'unknown'}: ${error.stack}`);
      return null; // Fail gracefully
    }
  }

  /**
   * Extract a normalized bridge identifier (handles objects returned by ProximityService)
   * @param {string|Object|null} bridge - Bridge reference
   * @returns {string|null} Normalized bridge ID or null
   * @private
   */
  _extractBridgeIdentifier(bridge) {
    if (!bridge) return null;
    if (typeof bridge === 'string') {
      return bridge;
    }
    if (typeof bridge === 'object') {
      return bridge.id || bridge.name || null;
    }
    return null;
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
    const nearestBridgeId = this._extractBridgeIdentifier(nearestBridge);
    const targetBridgeId = this._extractBridgeIdentifier(targetBridge);
    if (!nearestBridgeId || !targetBridgeId) {
      return null;
    }

    // Get effective speed
    const effectiveSpeed = this._getEffectiveSpeed(vessel);
    if (!effectiveSpeed) {
      return null;
    }

    // Step 1: Calculate ETA to nearest bridge (next step on route)
    const etaToNearest = this._calculateETAToBridge(vessel, nearestBridgeId, proximityData);
    if (etaToNearest === null) {
      return this._calculateDirectETA(vessel);
    }

    // Step 2: Calculate cumulative time from nearest bridge to target bridge
    const bridgesBetween = this.bridgeRegistry.getBridgesBetween(nearestBridgeId, targetBridgeId);
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

    const targetBridgeId = this._extractBridgeIdentifier(bridgeName);
    const targetBridgeName = typeof bridgeName === 'string' ? bridgeName : this.bridgeRegistry.getNameById(targetBridgeId);

    // Optimization: Use proximity data distance if available for nearest bridge
    let distance;
    const nearestBridgeId = this._extractBridgeIdentifier(proximityData?.nearestBridge);
    if (nearestBridgeId && targetBridgeId && nearestBridgeId === targetBridgeId && proximityData?.nearestDistance) {
      distance = proximityData.nearestDistance;
      // Distance optimization used silently for performance
    } else {
      // Calculate distance manually
      const bridge = targetBridgeId
        ? this.bridgeRegistry.getBridge(targetBridgeId) || (targetBridgeName ? this.bridgeRegistry.getBridgeByName(targetBridgeName) : null)
        : (targetBridgeName ? this.bridgeRegistry.getBridgeByName(targetBridgeName) : null);
      if (!bridge) {
        this.logger.debug(`🧮 [ETA_TO_BRIDGE] ${vessel.mmsi}: Bridge '${targetBridgeName || bridgeName}' not found`);
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

  /**
   * ENHANCED: Process ETA with monotonic protection and EMA smoothing
   * @param {Object} vessel - Vessel data
   * @param {number} rawETA - Raw calculated ETA in minutes
   * @param {Object} proximityData - Proximity data for context
   * @returns {number} Processed ETA with protection and smoothing
   * @private
   */
  _processETAWithProtection(vessel, rawETA, proximityData) {
    const mmsi = vessel.mmsi.toString();

    // Get ETA history for this vessel
    let history = this._etaHistory.get(mmsi);
    if (!history) {
      history = [];
      this._etaHistory.set(mmsi, history);
    }

    const now = Date.now();
    const distanceToTarget = this._getDistanceToTarget(vessel);

    // STEP 1: OUTLIER DETECTION - Check if rawETA is suspicious
    const suspiciousETA = this._isETAOutlier(rawETA, history, vessel);
    if (suspiciousETA.isOutlier) {
      this.logger.debug(`🚨 [ETA_OUTLIER] ${mmsi}: Suspicious ETA ${rawETA.toFixed(1)}min detected (${suspiciousETA.reason}) - applying protection`);

      // Use previous ETA with gradual adjustment if available
      const fallbackETA = this._getFallbackETA(rawETA, history, vessel);
      if (fallbackETA !== null) {
        rawETA = fallbackETA;
        this.logger.debug(`📊 [ETA_FALLBACK] ${mmsi}: Using fallback ETA ${rawETA.toFixed(1)}min`);
      }
    }

    // STEP 2: MONOTONIC PROTECTION - Prevent unreasonable backwards progression
    let protectedETA = rawETA;
    if (history.length > 0) {
      const lastEntry = history[history.length - 1];
      const timeDelta = now - lastEntry.timestamp;
      const expectedProgress = timeDelta / (1000 * 60); // Minutes that should have passed

      // Expected ETA should be previous ETA minus elapsed time (plus small buffer)
      const expectedETA = Math.max(0.1, lastEntry.processedETA - expectedProgress + 0.5);

      // Check if current ETA is unreasonably backwards
      const regressionAmount = protectedETA - expectedETA;
      const regressionPercent = expectedETA > 0 ? regressionAmount / expectedETA : 0;

      if (regressionPercent > this._monotonicThresholdPercent && timeDelta < 60000) { // Within 1 minute
        protectedETA = Math.max(expectedETA, protectedETA * 0.8); // Allow max 20% regression
        this.logger.debug(`🛡️ [ETA_MONOTONIC] ${mmsi}: Protected against ${regressionPercent.toFixed(1)}% regression (${rawETA.toFixed(1)}min → ${protectedETA.toFixed(1)}min)`);
      }
    }

    // STEP 3: EMA SMOOTHING - Apply exponential moving average
    let smoothedETA = protectedETA;
    if (history.length > 0) {
      const lastProcessedETA = history[history.length - 1].processedETA;
      // EMA formula: new_value = alpha * current + (1 - alpha) * previous
      smoothedETA = this._emaAlpha * protectedETA + (1 - this._emaAlpha) * lastProcessedETA;

      const smoothingApplied = Math.abs(smoothedETA - protectedETA) > 0.1;
      if (smoothingApplied) {
        this.logger.debug(`🎛️ [ETA_SMOOTHING] ${mmsi}: EMA smoothing applied (raw: ${protectedETA.toFixed(1)}min → smooth: ${smoothedETA.toFixed(1)}min)`);
      }
    }

    // STEP 4: LIMIT POSITIVE JUMPS
    let adjustedETA = this._applyPositiveJumpLimit(vessel, smoothedETA, history);

    // STEP 5: APPLY IDLE DECAY FOR WAITING/QUEUED VESSELS
    adjustedETA = this._applyIdleDecay(vessel, adjustedETA, history, now, distanceToTarget);

    // STEP 6: RECORD HISTORY - Store this calculation for future reference
    this._recordETAHistory(mmsi, {
      rawETA,
      protectedETA,
      processedETA: adjustedETA,
      timestamp: now,
      targetBridge: vessel.targetBridge,
      nearestBridge: proximityData?.nearestBridge || null,
      vesselSpeed: vessel.sog || 0,
      distance: proximityData?.nearestDistance || null,
      distanceToTarget,
      vesselStatus: vessel.status || 'unknown',
    });

    return Math.min(Math.max(adjustedETA, 0.1), 120); // Final bounds: 0.1min to 2 hours
  }

  /**
   * Check if ETA is an outlier that should be filtered
   * @param {number} eta - Raw ETA value
   * @param {Array} history - ETA history for vessel
   * @param {Object} vessel - Vessel data
   * @returns {Object} Outlier analysis result
   * @private
   */
  _isETAOutlier(eta, history, vessel) {
    if (history.length === 0) {
      return { isOutlier: false, reason: 'no_history' };
    }

    const lastEntry = history[history.length - 1];
    const timeDelta = Date.now() - lastEntry.timestamp;

    // Check for dramatic ETA jumps (e.g., 7min → 1min)
    const etaRatio = lastEntry.processedETA > 0 ? eta / lastEntry.processedETA : 1;
    if (etaRatio < (1 / this._outlierThresholdMultiple) && timeDelta < 30000) { // Within 30 seconds
      return { isOutlier: true, reason: `dramatic_decrease_${etaRatio.toFixed(2)}x` };
    }

    // Check for unreasonable ETA spikes (e.g., 1min → 10min)
    if (etaRatio > this._outlierThresholdMultiple && timeDelta < 30000) {
      return { isOutlier: true, reason: `dramatic_increase_${etaRatio.toFixed(2)}x` };
    }

    // Check for GPS-related anomalies (detect if vessel has likely GPS issue)
    const hasGPSIssue = vessel.lastCoordinationLevel === 'enhanced'
                        || vessel.lastCoordinationLevel === 'system_wide'
                        || vessel._underBridgeLatched; // Under bridge can cause GPS issues

    if (hasGPSIssue && Math.abs(etaRatio - 1) > 0.5) { // 50% change during GPS issues
      return { isOutlier: true, reason: 'gps_coordination_active' };
    }

    return { isOutlier: false, reason: 'normal_variation' };
  }

  /**
   * Get fallback ETA when outlier is detected
   * @param {number} rawETA - Raw ETA that was detected as outlier
   * @param {Array} history - ETA history
   * @param {Object} vessel - Vessel data
   * @returns {number|null} Fallback ETA or null
   * @private
   */
  _getFallbackETA(rawETA, history, vessel) {
    if (history.length === 0) {
      return null;
    }

    const lastEntry = history[history.length - 1];
    const timeDelta = (Date.now() - lastEntry.timestamp) / (1000 * 60); // Minutes elapsed

    // Calculate conservative fallback: last ETA minus elapsed time
    const conservativeETA = Math.max(0.5, lastEntry.processedETA - timeDelta);

    // Blend with raw ETA (70% conservative, 30% raw) to avoid complete rejection
    const blendedETA = 0.7 * conservativeETA + 0.3 * rawETA;

    this.logger.debug(`🔄 [ETA_FALLBACK] ${vessel.mmsi}: Blending conservative ${conservativeETA.toFixed(1)}min with raw ${rawETA.toFixed(1)}min → ${blendedETA.toFixed(1)}min`);

    return blendedETA;
  }

  /**
   * Prevent excessively large positive ETA jumps when data toggles.
   * @private
   */
  _applyPositiveJumpLimit(vessel, eta, history) {
    if (history.length === 0) {
      return eta;
    }

    const lastEntry = history[history.length - 1];
    const increase = eta - lastEntry.processedETA;
    if (increase <= 0) {
      return eta;
    }

    const maxIncrease = Math.max(5, lastEntry.processedETA * 0.25);
    if (increase > maxIncrease) {
      const limitedETA = lastEntry.processedETA + maxIncrease;
      this.logger.debug(
        `🧱 [ETA_POSITIVE_LIMIT] ${vessel.mmsi}: Limiting jump ${increase.toFixed(1)}min → ${maxIncrease.toFixed(1)}min `
        + `(prev=${lastEntry.processedETA.toFixed(1)}min, new=${eta.toFixed(1)}min)`,
      );
      return limitedETA;
    }

    return eta;
  }

  /**
   * Apply idle decay so waiting vessels gradually reduce ETA even utan rörelse.
   * @private
   */
  _applyIdleDecay(vessel, eta, history, now, currentDistance) {
    if (history.length === 0) {
      return eta;
    }

    const lastEntry = history[history.length - 1];
    const timeDeltaMinutes = (now - lastEntry.timestamp) / (1000 * 60);
    if (timeDeltaMinutes <= 0.5) {
      return eta;
    }

    const status = vessel.status || lastEntry.vesselStatus || 'unknown';
    const isIdleState = status === 'waiting' || status === 'approaching';
    if (!isIdleState) {
      return eta;
    }

    if (Number.isFinite(lastEntry.distanceToTarget) && Number.isFinite(currentDistance)) {
      const distanceChange = currentDistance - lastEntry.distanceToTarget;
      if (distanceChange < -20) {
        // Vessel is actually getting closer quickly, no decay adjustment needed
        return eta;
      }
    }

    const expectedDecay = Math.min(timeDeltaMinutes, 3); // Expect up to 3 min drop per cycle
    const actualDecay = lastEntry.processedETA - eta;

    if (actualDecay >= expectedDecay * 0.6) {
      return eta;
    }

    const decayedETA = Math.max(0.5, lastEntry.processedETA - expectedDecay);
    if (decayedETA < eta) {
      this.logger.debug(
        `⏳ [ETA_IDLE_DECAY] ${vessel.mmsi}: Forcing idle decay (${lastEntry.processedETA.toFixed(1)} → ${decayedETA.toFixed(1)}min)`,
      );
      return decayedETA;
    }

    return eta;
  }

  /**
   * Calculate direct distance from vessel to target bridge.
   * @private
   */
  _getDistanceToTarget(vessel) {
    try {
      if (!vessel || !vessel.targetBridge) {
        return null;
      }
      const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
      if (!targetBridge || !Number.isFinite(targetBridge.lat) || !Number.isFinite(targetBridge.lon)) {
        return null;
      }
      if (!isValidVesselCoordinates(vessel)) {
        return null;
      }
      return geometry.calculateDistance(
        vessel.lat,
        vessel.lon,
        targetBridge.lat,
        targetBridge.lon,
      );
    } catch (error) {
      this.logger.debug(`⚠️ [ETA_DISTANCE] ${vessel?.mmsi || 'unknown'}: Failed to calculate distance to target - ${error.message}`);
      return null;
    }
  }

  /**
   * Record ETA history entry for vessel
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} entry - History entry data
   * @private
   */
  _recordETAHistory(mmsi, entry) {
    let history = this._etaHistory.get(mmsi);
    if (!history) {
      history = [];
      this._etaHistory.set(mmsi, history);
    }

    history.push(entry);

    // Limit history length
    if (history.length > this._maxHistoryLength) {
      history.shift(); // Remove oldest entry
    }
  }

  /**
   * Cleanup old ETA history entries
   * @private
   */
  _cleanupOldETAHistory() {
    const cutoffTime = Date.now() - (30 * 60 * 1000); // 30 minutes ago
    let cleanedVessels = 0;

    for (const [mmsi, history] of this._etaHistory.entries()) {
      // Remove old entries
      const validEntries = history.filter((entry) => entry.timestamp > cutoffTime);

      if (validEntries.length === 0) {
        this._etaHistory.delete(mmsi);
        cleanedVessels++;
      } else if (validEntries.length !== history.length) {
        this._etaHistory.set(mmsi, validEntries);
      }
    }

    if (cleanedVessels > 0) {
      this.logger.debug(`🧹 [ETA_HISTORY_CLEANUP] Cleaned history for ${cleanedVessels} vessels`);
    }
  }

  /**
   * Get ETA processing statistics
   * @returns {Object} Processing statistics
   */
  getETAProcessingStats() {
    let totalEntries = 0;
    let vesselsWithHistory = 0;
    let oldestEntry = Date.now();
    let newestEntry = 0;

    for (const [, history] of this._etaHistory.entries()) {
      if (history.length > 0) {
        vesselsWithHistory++;
        totalEntries += history.length;

        const historyOldest = Math.min(...history.map((e) => e.timestamp));
        const historyNewest = Math.max(...history.map((e) => e.timestamp));

        oldestEntry = Math.min(oldestEntry, historyOldest);
        newestEntry = Math.max(newestEntry, historyNewest);
      }
    }

    return {
      vesselsWithHistory,
      totalHistoryEntries: totalEntries,
      averageEntriesPerVessel: vesselsWithHistory > 0 ? (totalEntries / vesselsWithHistory).toFixed(1) : 0,
      historyAgeSpan: newestEntry > oldestEntry ? Math.round((newestEntry - oldestEntry) / (1000 * 60)) : 0, // minutes
      emaAlpha: this._emaAlpha,
      monotonicThreshold: this._monotonicThresholdPercent,
    };
  }

  /**
   * Clear ETA history for specific vessel (used when vessel is removed or target bridge changes)
   * @param {string} mmsi - Vessel MMSI
   * @param {string} reason - Reason for clearing
   */
  clearVesselETAHistory(mmsi, reason = 'unknown') {
    const hadHistory = this._etaHistory.has(mmsi);
    if (hadHistory) {
      const entryCount = this._etaHistory.get(mmsi).length;
      this._etaHistory.delete(mmsi);
      this.logger.debug(`🗑️ [ETA_HISTORY_CLEAR] ${mmsi}: Cleared ${entryCount} ETA history entries (reason: ${reason})`);
    }
  }

  /**
   * Cleanup resources
   */
  destroy() {
    if (this._historyCleanupTimer) {
      clearInterval(this._historyCleanupTimer);
      this._historyCleanupTimer = null;
    }

    this._etaHistory.clear();
    this.logger.debug('🧮 [ETA_CALCULATOR_V2] Enhanced ETA calculator destroyed');
  }
}

module.exports = ProgressiveETACalculator;
