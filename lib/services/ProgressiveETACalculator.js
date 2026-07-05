'use strict';

const geometry = require('../utils/geometry');
const {
  WAITING_STATUS_MAX_ETA_MINUTES,
  MIN_PASSAGE_ROUTE_SPEED_KNOTS,
} = require('../constants');
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
    this._emaAlpha = 0.4; // Smoothing factor (0 = no change, 1 = no smoothing) - FIX 5: increased from 0.3
    this._maxHistoryLength = 10; // Maximum ETA history entries per vessel
    this._monotonicThresholdPercent = 0.5; // 50% - maximum allowed backward regression
    this._outlierThresholdMultiple = 2.5; // 2.5x previous ETA is considered outlier

    // FIX 5: Speed averaging buffer per vessel (reduces ETA jitter from speed fluctuations)
    this._speedBuffers = new Map(); // Map<mmsi, number[]>
    this._speedBufferSize = 3; // Average over last 3 readings

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
      // Fix 3a: Normalisera bridge-identifierare till lowercase IDs.
      // nearestBridge är ett objekt med .id (lowercase), men vessel.targetBridge
      // är en sträng med mixed case (t.ex. 'Stridsbergsbron'). Utan normalisering
      // matchar 'stridsbergsbron' aldrig 'Stridsbergsbron' → direct_at_target dead code.
      const rawNearestId = this._extractBridgeIdentifier(proximityData?.nearestBridge);
      const rawTargetId = this._extractBridgeIdentifier(vessel.targetBridge);
      const nearestBridgeId = rawNearestId
        ? (this.bridgeRegistry.normalizeToId(rawNearestId) || rawNearestId) : null;
      const targetBridgeId = rawTargetId
        ? (this.bridgeRegistry.normalizeToId(rawTargetId) || rawTargetId) : null;
      let calculationMethod;
      if (!proximityData || !nearestBridgeId) {
        calculationMethod = 'direct_fallback';
      } else if (nearestBridgeId === targetBridgeId) {
        calculationMethod = 'direct_at_target';
      } else {
        calculationMethod = 'progressive_route';
      }

      // Fix 3b: Om fartyget just passerat nearest bridge, använd direkt-beräkning.
      // Förhindrar att route-kalkylen räknar bakåt till den passerade bron och
      // sedan framåt (ger uppblåst ETA, t.ex. 2→22 min).
      if (calculationMethod === 'progressive_route' && vessel.lastPassedBridge) {
        const lastPassedId = this.bridgeRegistry.normalizeToId(vessel.lastPassedBridge);
        if (lastPassedId && lastPassedId === nearestBridgeId) {
          this.logger.debug(
            `🔀 [ETA_POST_PASSAGE] ${vessel.mmsi}: Nearest bridge ${nearestBridgeId} was just passed `
            + `→ using direct calculation to ${targetBridgeId}`,
          );
          calculationMethod = 'direct_fallback';
        }
      }

      this.logger.debug(`📊 [ETA_METHOD] ${vessel.mmsi}: Using ${calculationMethod} calculation`);

      if (!proximityData || !nearestBridgeId) {
        // Fallback to direct calculation
        rawETA = this._calculateDirectETA(vessel);
      } else if (nearestBridgeId === targetBridgeId) {
        rawETA = this._calculateDirectETA(vessel);
      } else if (calculationMethod === 'direct_fallback') {
        // Fix 3b: Post-passage direct calculation
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
      let bridge;
      if (targetBridgeId) {
        bridge = this.bridgeRegistry.getBridge(targetBridgeId)
          || (targetBridgeName ? this.bridgeRegistry.getBridgeByName(targetBridgeName) : null);
      } else if (targetBridgeName) {
        bridge = this.bridgeRegistry.getBridgeByName(targetBridgeName);
      } else {
        bridge = null;
      }
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

    // FIX 5: Use averaged speed to reduce ETA jitter from speed fluctuations
    const avgSpeed = this._getAveragedSpeed(vessel, actualSpeed);
    const baseSpeed = Math.max(avgSpeed, 0.5); // Minimum 0.5 knots fallback

    // E-F5 (2026-07-01): "recent" måste vara TIDSBEGRÄNSAT — lastPassedBridge
    // sätts vid första bropassagen och består resten av resan, så 2,5 kn-
    // golvet gällde annars hela post-passage-benet: en båt som genuint kör
    // 1,5 kn mot nästa målbro (3 km) fick systematiskt ~40 % för optimistisk
    // ETA i över en timme. 15 min täcker det korta ben golvet designades för.
    const PASSAGE_CONTEXT_MAX_AGE_MS = 15 * 60 * 1000;
    const recentPassageStamp = Boolean(vessel.lastPassedBridge)
      && Number.isFinite(vessel.lastPassedBridgeTime)
      && (Date.now() - vessel.lastPassedBridgeTime) < PASSAGE_CONTEXT_MAX_AGE_MS;
    // Städat 2026-07-05: tidigare lästes även vessel.pendingPassedAnnouncement/
    // pendingTargetBridge/pendingPassed här — fält som ALDRIG skrivs någonstans
    // (VDS skriver underscore-varianter som aldrig läses; passagevägen sätter
    // dessutom alltid lastPassedBridge+lastPassedBridgeTime, så stämpeln ovan
    // täcker avsikten). De döda termerna är borttagna på båda sidor.
    const hasRecentPassageContext = vessel.status === 'passed'
      || recentPassageStamp;

    // Bug #3 fix + Review fix M3: the passage speed-floor (2.5kn) exists to
    // avoid absurdly long ETA on short legs when a vessel briefly slows while
    // passing a bridge. It MUST NOT be applied to vessels that are genuinely
    // stationary, otherwise ghost vessels anchored near a bridge produce a
    // deterministic ETA of ~15 minutes every minute, forever.
    //
    // Definition of "genuinely stationary": avgSpeed < 0.8kn AND all buffered
    // samples < 1.0kn. With a warm buffer (>=2 samples) this prevents a
    // single 0kn reading from a maneuvering vessel (entering a lock, brief
    // current stop) from dropping the floor — that caused false flips to
    // "inväntar broöppning" in narrow canals.
    //
    // NOTE: on a fresh/cleared buffer (e.g. just after targetBridge change
    // wipes _speedBuffers via clearVesselETAHistory), a single slow sample
    // is sufficient to mark the vessel stationary. This is intentional —
    // waiting for two samples would re-introduce the ghost-vessel symptom
    // (deterministic ~15-min ETA every cycle) for post-passage stationary
    // vessels. The cost is at most one cycle of an under-floor speed before
    // the next AIS update either grows the buffer (silencing the floor drop
    // if the vessel is moving) or confirms the stationary state.
    const buffer = this._speedBuffers.get(vessel.mmsi) || [];
    const allBufferedSlow = buffer.length > 0 && buffer.every((s) => s < 1.0);
    const vesselIsMoving = avgSpeed > 0.8 || !allBufferedSlow;
    const minRouteSpeed = (hasRecentPassageContext && vesselIsMoving)
      ? MIN_PASSAGE_ROUTE_SPEED_KNOTS
      : 0.5;
    const effectiveSpeed = Math.max(baseSpeed, minRouteSpeed);

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
   * FIX 5: Get averaged speed over last N readings to reduce ETA jitter
   * @param {Object} vessel - Vessel with mmsi
   * @param {number} currentSog - Current SOG reading
   * @returns {number} Averaged speed
   * @private
   */
  _getAveragedSpeed(vessel, currentSog) {
    if (!vessel || !vessel.mmsi) return currentSog;

    const { mmsi } = vessel;
    if (!this._speedBuffers.has(mmsi)) {
      this._speedBuffers.set(mmsi, []);
    }

    const buffer = this._speedBuffers.get(mmsi);

    // Multipush-fix (2026-06-13, helkodsgranskningen): denna getter anropas
    // 2× per kalkyl (rutt-ben + målben) och kalkylen körs 2× per meddelande
    // (meddelande- + snapshot-vägen) → upp till 4 identiska pushar fyllde
    // hela 3-slots-bufferten med SAMMA avläsning, vilket dödade snittet och
    // slog ut "warm buffer"-skyddet för fartgolvet. Pusha endast när
    // avläsningen kommer från ett NYTT AIS-sample (nycklat på sampel-ts).
    if (!this._speedBufferSampleKeys) this._speedBufferSampleKeys = new Map();
    // E-F9 (2026-07-01): nyckla på sampeldatans IDENTITET (position+fart+kurs)
    // i stället för vessel.timestamp — den är Date.now() vid objektbygget
    // (bearbetningstid), så dubbelt levererade identiska AIS-frames fick NYA
    // nycklar och dubbelpushades (halverad buffertdiversitet), medan hand-
    // byggda testobjekt utan timestamp gav konstant nyckel som svalde allt.
    const sampleKey = `${vessel.lat}:${vessel.lon}:${vessel.sog}:${vessel.cog}`;
    if (this._speedBufferSampleKeys.get(mmsi) !== sampleKey) {
      this._speedBufferSampleKeys.set(mmsi, sampleKey);
      buffer.push(currentSog);
    }

    // Keep only the last N readings
    while (buffer.length > this._speedBufferSize) {
      buffer.shift();
    }

    // Return average of buffer
    if (buffer.length === 0) return currentSog;
    const sum = buffer.reduce((acc, s) => acc + s, 0);
    return sum / buffer.length;
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

    // EMA-staleness-fix (2026-06-13, helkodsgranskningen): efter ett AIS-glapp
    // > 3 min är historiken en GLAPP-GAMMAL baslinje — EMA:n (alpha 0.4) och
    // positive-jump-limiten saknade staleness-gate (till skillnad från
    // monotoni-/clamp-/outlier-skydden) och drog första färska ETA:n 60 %
    // mot förgapsvärdet. Behandla glappet som ny baslinje: töm historiken
    // så alla skyddssteg uniformt ser "första beräkningen" och rå-ETA:n
    // går igenom orörd (RC4-publicerings-clampen tar fortfarande hand om
    // användarupplevd förändringstakt).
    if (history.length > 0 && now - history[history.length - 1].timestamp > 180000) {
      this.logger.debug(
        `🕳️ [ETA_GAP_RESET] ${mmsi}: ${Math.round((now - history[history.length - 1].timestamp) / 1000)}s `
        + 'since last calculation — clearing stale ETA history (fresh baseline)',
      );
      history.length = 0;
      // Helkodsgranskning 2026-07-01 (F1): töm även hastighetsbufferten —
      // posterna saknar tidsstämplar, så förgapsfarter medlades annars in i
      // första post-gap-ETA:n (och kunde hålla vesselIsMoving=true för en båt
      // som stannat under gappet) precis när alla skydd är avstängda.
      this._speedBuffers.delete(vessel.mmsi);
      if (this._speedBufferSampleKeys) this._speedBufferSampleKeys.delete(vessel.mmsi);
    }

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

      if (regressionPercent > this._monotonicThresholdPercent && timeDelta < 180000) { // Within 3 minutes (was 1 min)
        protectedETA = Math.max(expectedETA, protectedETA * 0.8); // Allow max 20% regression
        this.logger.debug(`🛡️ [ETA_MONOTONIC] ${mmsi}: Protected against ${regressionPercent.toFixed(1)}% regression (${rawETA.toFixed(1)}min → ${protectedETA.toFixed(1)}min)`);
      }

      // Bug #6 fix + Review fix M1: absolute ETA-jump clamp for near-stationary
      // vessels where SOG noise produces huge ETA swings (observed
      // "64→82→106→80→49" in 2 min at SOG ~0.2kn).
      //
      // IMPORTANT: gate on vessel.sog < 1.0kn so we don't suppress legitimate
      // large ETA drops on moving vessels (e.g. course correction that brings
      // a closer bridge onto the route). On moving vessels the existing
      // percent-based monotonic protection and EMA smoothing are sufficient.
      const absoluteJump = Math.abs(protectedETA - lastEntry.processedETA);
      const nearStationary = Number.isFinite(vessel.sog) && vessel.sog < 1.0;
      if (absoluteJump > 10 && timeDelta < 120000 && nearStationary) {
        // Direction is guaranteed ±1 since absoluteJump > 10 → values differ.
        // Math.sign fallback to 1 is pure paranoia for NaN edge cases.
        const direction = Math.sign(protectedETA - lastEntry.processedETA) || 1;
        const clampedETA = lastEntry.processedETA + direction * 3;
        // Review fix L4 note: Math.max(0.1, …) may truncate a -0.5 to 0.1,
        // making the effective change -2.4min instead of -3min when previous
        // ETA was near zero. Harmless because any value <1 is rendered "strax".
        this.logger.debug(
          `🛡️ [ETA_ABSOLUTE_CLAMP] ${mmsi}: |ΔETA|=${absoluteJump.toFixed(1)}min `
          + `in ${(timeDelta / 1000).toFixed(1)}s at SOG=${vessel.sog}kn → `
          + `clamping ${protectedETA.toFixed(1)}min → ${clampedETA.toFixed(1)}min`,
        );
        protectedETA = Math.max(0.1, clampedETA);
      }

      // Fix 4: milder absolute-jump clamp for moving vessels.
      // Production observation (2026-04-23 17:55): ETA jumped 20→26→29→20→12
      // for a moving vessel within 60s due to sparse AIS + fluctuating SOG.
      // Existing percent-based monotonic protection didn't catch this because
      // the swings were both directions. Apply a higher threshold (15 min vs
      // 10 min) and milder cap (±5 min vs ±3 min) so legitimate transitions
      // pass through but extreme swings are dampened.
      const isMoving = Number.isFinite(vessel.sog) && vessel.sog >= 1.0;
      if (absoluteJump > 15 && timeDelta < 120000 && isMoving) {
        const direction = Math.sign(protectedETA - lastEntry.processedETA) || 1;
        const clampedETA = lastEntry.processedETA + direction * 5;
        this.logger.debug(
          `🛡️ [ETA_MOVING_CLAMP] ${mmsi}: |ΔETA|=${absoluteJump.toFixed(1)}min `
          + `at SOG=${vessel.sog}kn → clamp ${protectedETA.toFixed(1)} → ${clampedETA.toFixed(1)}`,
        );
        protectedETA = Math.max(0.1, clampedETA);
      }

      // BUG 4 FIX: For actively approaching vessels (SOG > 2, distance decreasing),
      // limit ETA increase to max +1 min per cycle to prevent spikes.
      // E-F4 (2026-07-01): tillåt +1 min/cykel (som growth-capen) i stället
      // för HÅRD frysning — en äkta fartminskning (7→3 kn, fortfarande
      // approaching) fick annars ETA:n att fastfrysa på det gamla värdet i
      // flera minuter tills rå-ETA:n naturligt sjönk under det frysta.
      if (vessel.sog > 2 && distanceToTarget !== null && lastEntry.distanceToTarget !== null
          && distanceToTarget < lastEntry.distanceToTarget) {
        const etaIncrease = protectedETA - lastEntry.processedETA;
        if (etaIncrease > 1) {
          protectedETA = lastEntry.processedETA + 1;
          this.logger.debug(`🛡️ [ETA_APPROACH_LIMIT] ${mmsi}: Clamping ETA increase to +1/cycle for approaching vessel (was +${etaIncrease.toFixed(1)}min)`);
        }
      }

      // Fix 3: cap monotonic ETA growth for stationary vessels.
      // Observed in production (2026-04-22 09:36-09:43): vessel stops or
      // turns away → ETA crawls upward 21→27→30→32→35 minutes without
      // bound (existing approach-limit only handles vessels approaching
      // with SOG>2). Cap further growth to +1 min/cycle when:
      //   - 3+ consecutive samples have NOT decreased
      //   - vessel is genuinely stationary (sog < 0.8)
      //   - new ETA would grow further
      // Effect: ETA plateaus at a stable value, user is not misled by an
      // ever-growing number that suggests the boat is "getting further away".
      //
      // Anomali 8 fix (2026-05-06): ändrade strict > till ≥ (non-decreasing)
      // så ETA-platåer räknas som growth-mönster. PRICKBJORN 05-05 05:54-06:01
      // hade sekvens 7→8→9→9→11 där 9→9 platån "återställde" monotonic-flaggan
      // och 9→11→15-hopp gick okappade. Med ≥ fångas plateaus + tillväxt
      // konsekvent → cap aktiveras för verkliga "ETA driftar uppåt"-mönster.
      if (history.length >= 3) {
        const lastThree = history.slice(-3);
        const nonDecreasingGrowth = lastThree.every((entry, i) => {
          if (i === 0) return true;
          return entry.processedETA >= lastThree[i - 1].processedETA;
        });
        const hasAnyGrowth = lastThree[lastThree.length - 1].processedETA
          > lastThree[0].processedETA;
        const isStationary = Number.isFinite(vessel.sog) && vessel.sog < 0.8;
        if (nonDecreasingGrowth && hasAnyGrowth && isStationary
            && protectedETA > lastEntry.processedETA) {
          const cappedETA = lastEntry.processedETA + 1;
          this.logger.debug(
            `🛡️ [ETA_GROWTH_CAP] ${mmsi}: stationary monotonic growth → `
            + `cap ${protectedETA.toFixed(1)} → ${cappedETA.toFixed(1)} min/cycle`,
          );
          protectedETA = cappedETA;
        }
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

    if (
      history.length > 0
      && (vessel.status === 'waiting' || vessel.status === 'stallbacka-waiting')
    ) {
      const lastProcessedETA = history[history.length - 1].processedETA;
      if (smoothedETA > lastProcessedETA) {
        this.logger.debug(
          `🛑 [ETA_WAIT_CLAMP] ${mmsi}: Preventing ETA increase while waiting `
          + `(${lastProcessedETA.toFixed(1)} → ${smoothedETA.toFixed(1)}min)`,
        );
        smoothedETA = lastProcessedETA;
      }
    }

    // STEP 4: LIMIT POSITIVE JUMPS
    let adjustedETA = this._applyPositiveJumpLimit(vessel, smoothedETA, history);

    // STEP 5: APPLY IDLE DECAY FOR WAITING/QUEUED VESSELS
    adjustedETA = this._applyIdleDecay(vessel, adjustedETA, history, now, distanceToTarget);

    // E-F6 (2026-07-01): WAIT-cap + slutbounds appliceras FÖRE historiken —
    // historiken ska lagra det värde användaren faktiskt får. Tidigare
    // lagrades det OKAPPADE värdet, så outlier-/EMA-skydden försvarade en
    // intern baslinje (t.ex. 19,4 min) medan användaren såg 12 → när båten
    // sedan lade av STEG den publicerade ETA:n i stället för att sjunka.
    if (
      (vessel.status === 'waiting' || vessel.status === 'stallbacka-waiting')
      && Number.isFinite(adjustedETA)
      && adjustedETA > WAITING_STATUS_MAX_ETA_MINUTES
    ) {
      this.logger.debug(
        `🛑 [ETA_WAIT_CAP] ${mmsi}: Clamping waiting ETA `
        + `(${adjustedETA.toFixed(1)} → ${WAITING_STATUS_MAX_ETA_MINUTES}min)`,
      );
      adjustedETA = WAITING_STATUS_MAX_ETA_MINUTES;
    }
    adjustedETA = Math.min(Math.max(adjustedETA, 0.1), 120); // Final bounds: 0.1min to 2 hours

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

    return adjustedETA;
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

    // F74: cap the UPWARD contribution. rawETA was flagged as an outlier; if it
    // is a spike above the last accepted ETA, the 30% blend would slowly drag
    // the baseline up and re-inject the spike over successive ticks. Clamp so a
    // fallback can only hold or LOWER the ETA (conservativeETA already decays
    // with elapsed time), never raise it above the last processed value.
    const cappedETA = Math.min(blendedETA, lastEntry.processedETA);

    this.logger.debug(`🔄 [ETA_FALLBACK] ${vessel.mmsi}: blend cons=${conservativeETA.toFixed(1)} raw=${rawETA.toFixed(1)} → ${blendedETA.toFixed(1)} (cap ${cappedETA.toFixed(1)})min`);

    return cappedETA;
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

    // E-F7 (2026-07-01): golva decayn DISTANSBASERAT — en båt som håller
    // position i approaching-ringen (0,6–0,7 kn station-keeping) fick annars
    // ETA:n nertvingad till 0,5 → "beräknad broöppning strax" som aldrig
    // släppte, 400 m från bron. Golvet = restid vid rask kanalfart (4 kn);
    // under det får decayn aldrig lova. (<300 m tar Fix H-imminent över.)
    let decayFloor = 0.5;
    if (Number.isFinite(currentDistance) && currentDistance > 0) {
      const briskMPerMin = 4 * 0.5144 * 60; // ≈123 m/min
      decayFloor = Math.max(0.5, Math.min(12, currentDistance / briskMPerMin));
    }
    const decayedETA = Math.max(decayFloor, lastEntry.processedETA - expectedDecay);
    if (decayedETA < eta) {
      this.logger.debug(
        `⏳ [ETA_IDLE_DECAY] ${vessel.mmsi}: Forcing idle decay (${lastEntry.processedETA.toFixed(1)} → ${decayedETA.toFixed(1)}min, floor ${decayFloor.toFixed(1)})`,
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

    // FIX 5: Clean up speed buffers for vessels no longer in ETA history
    for (const mmsi of this._speedBuffers.keys()) {
      if (!this._etaHistory.has(mmsi)) {
        this._speedBuffers.delete(mmsi);
        if (this._speedBufferSampleKeys) this._speedBufferSampleKeys.delete(mmsi);
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
    // FIX 5: Also clear speed buffer for this vessel
    this._speedBuffers.delete(mmsi);
    if (this._speedBufferSampleKeys) this._speedBufferSampleKeys.delete(mmsi);
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
