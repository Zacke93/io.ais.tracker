'use strict';

const EventEmitter = require('events');
const {
  WAITING_SPEED_THRESHOLD,
  UNDER_BRIDGE_SET_DISTANCE,
  UNDER_BRIDGE_CLEAR_DISTANCE,
  MOVEMENT_DETECTION,
  APPROACHING_RADIUS,
  APPROACH_RADIUS,
  PROTECTION_ZONE_RADIUS,
  STATUS_HYSTERESIS,
} = require('../constants');
const geometry = require('../utils/geometry');
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
  constructor(bridgeRegistry, logger, systemCoordinator, vesselDataService = null, passageLatchService = null) {
    super();
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
    this.systemCoordinator = systemCoordinator;
    this.passageLatchService = passageLatchService;
    this.vesselDataService = vesselDataService;
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
    const bridgeOpeningActive = Boolean(
      vessel._bridgeOpeningUntil && vessel._bridgeOpeningUntil > Date.now(),
    );

    // FIX U: För nära bro-par (Järnvägsbron↔Stridsbergsbron), tvinga waiting-status
    // FÖRE under-bridge check för att garantera fas-sekvensen: passed → waiting → under-bridge
    // GUARD: Skippa FIX U om Phase 3 (broöppning) är aktiv — låt passage-bron visas först
    const forceWaiting = vessel._forceWaitingAtBridge;
    if (forceWaiting && Date.now() < forceWaiting.until && !bridgeOpeningActive) {
      const forcedBridgeName = forceWaiting.bridge;
      const forcedBridge = this.bridgeRegistry.getBridgeByName(forcedBridgeName);

      if (forcedBridge) {
        const distanceToForcedBridge = geometry.calculateDistance(
          vessel.lat, vessel.lon, forcedBridge.lat, forcedBridge.lon,
        );

        // Om vi är inom 500m av den tvingade bron, visa waiting
        if (distanceToForcedBridge !== null && distanceToForcedBridge <= 500) {
          this.logger.debug(
            `✅ [FIX_U_FORCE_WAITING] ${vessel.mmsi}: Forcing waiting at ${forcedBridgeName} `
            + `(${distanceToForcedBridge.toFixed(0)}m away, triggered by ${forceWaiting.triggeredBy})`,
          );

          // Sätt currentBridge och distanceToCurrent för korrekt textgenerering
          vessel.currentBridge = forcedBridgeName;
          vessel.distanceToCurrent = distanceToForcedBridge;

          // Sätt _lastWaitingShownAt så att nästa uppdatering tillåter under-bridge
          if (!vessel._lastWaitingShownAt) vessel._lastWaitingShownAt = {};
          vessel._lastWaitingShownAt[forcedBridgeName] = Date.now();

          // Rensa force-flaggan efter användning
          vessel._forceWaitingAtBridge = null;

          // Uppdatera waiting timer
          this._updateWaitingTimer(vessel, { status: 'waiting' });

          // Returnera waiting-status direkt
          return {
            status: 'waiting',
            isWaiting: true,
            isApproaching: false,
            statusChanged: previousStatus !== 'waiting',
            statusReason: 'FIX_U_forced_waiting_close_bridge_pair',
            etaMinutes: vessel.etaMinutes,
          };
        }
      }
    }

    // FIX U: Rensa utgången force-waiting flagga
    if (vessel._forceWaitingAtBridge && Date.now() >= vessel._forceWaitingAtBridge.until) {
      this.logger.debug(
        `🔄 [FIX_U_EXPIRED] ${vessel.mmsi}: Force waiting expired for ${vessel._forceWaitingAtBridge.bridge}`,
      );
      vessel._forceWaitingAtBridge = null;
    }

    const underBridgeActive = this._isUnderBridge(vessel, proximityData);

    if (underBridgeActive) {
      // Priority 1: Under bridge detection
      result.status = 'under-bridge';
      result.isWaiting = false;
      result.isApproaching = false;
      // E-F8 (2026-07-01): 0.1 i stället för 0 — isValidETA kräver >0, så en
      // kvarhängande nolla (frusen position >10 min under bron där
      // omberäkningen skippas) renderades annars som "ETA okänd" i exakt
      // det ögonblick båten är under målbron.
      //
      // 2026-07-02b (teleport-scenariot): 0.1:an gäller BARA när bron under
      // kölen ÄR målbron. Efter en måltransition är "under bron" den NYSS
      // PASSERADE bron — 0.1 läckte då in i NYA målbrons klausul och texten
      // visade "på väg mot Stridsbergsbron, strax" i transitionsticken
      // (1,4 km från Strids). Under en annan bro än målbron styr ordinarie
      // ETA mot målet.
      const underBridgeName = vessel._bridgeOpeningBridgeName || vessel.currentBridge || null;
      if (!vessel.targetBridge || !underBridgeName || underBridgeName === vessel.targetBridge) {
        result.etaMinutes = 0.1;
      } else {
        result.etaMinutes = vessel.etaMinutes;
      }
      result.statusReason = 'vessel_under_bridge';
    } else if (hasRecentlyPassed && !bridgeOpeningActive) {
      // Recently passed has next priority (after under-bridge)
      result.status = 'passed';
      result.isWaiting = false;
      result.isApproaching = false;
      result.statusReason = 'vessel_recently_passed';
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

      // FIX H: Sätt currentBridge även för en-route om nära mellanbro
      // Detta säkerställer att BridgeTextService kan generera "närmar sig [mellanbro]" korrekt
      // även om status är en-route pga hysteresis-gränser
      const { nearestBridge, nearestDistance } = proximityData;
      if (nearestBridge && nearestBridge.name && Number.isFinite(nearestDistance)) {
        const INTERMEDIATE_BRIDGES = ['Olidebron', 'Järnvägsbron', 'Stallbackabron'];
        if (INTERMEDIATE_BRIDGES.includes(nearestBridge.name) && nearestDistance <= 600
            && !(Array.isArray(vessel.passedBridges) && vessel.passedBridges.includes(nearestBridge.name))) {
          // Sätt currentBridge även i en-route läge för att möjliggöra "närmar sig"
          vessel.currentBridge = nearestBridge.name;
          vessel.distanceToCurrent = nearestDistance;
          this.logger.debug(
            `🔄 [EN_ROUTE_CURRENT_BRIDGE] ${vessel.mmsi}: Set currentBridge=${nearestBridge.name} (${nearestDistance.toFixed(0)}m) while en-route`,
          );
        }
      }
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
      // FIX G: Debounce snabba status-ändringar (förhindra oscillation)
      const lastStatusChangeTime = vessel._lastStatusChangeTime || 0;
      const timeSinceLastChange = Date.now() - lastStatusChangeTime;
      const MIN_STATUS_CHANGE_INTERVAL = 5000; // 5 sekunder

      if (timeSinceLastChange < MIN_STATUS_CHANGE_INTERVAL && previousStatus !== 'unknown') {
        this.logger.debug(
          `🛡️ [STATUS_DEBOUNCE] ${vessel.mmsi}: Ignoring rapid status change ${previousStatus} → ${result.status} (${timeSinceLastChange}ms < ${MIN_STATUS_CHANGE_INTERVAL}ms)`,
        );
        result.status = previousStatus; // Behåll tidigare status
        result.statusChanged = false;
      } else {
        vessel._lastStatusChangeTime = Date.now();
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
    const now = Date.now();
    if (vessel._bridgeOpeningUntil) {
      if (vessel._bridgeOpeningUntil > now) {
        const syntheticBridge = vessel._bridgeOpeningBridgeName || vessel.currentBridge || vessel.targetBridge;

        // Distance safety valve: if vessel has moved far from the opening bridge,
        // clear the window early to prevent stale under-bridge state.
        if (syntheticBridge && Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
          const openingBridgeData = this.bridgeRegistry.getBridgeByName(syntheticBridge);
          if (openingBridgeData && Number.isFinite(openingBridgeData.lat)) {
            const distToOpening = geometry.calculateDistance(
              vessel.lat, vessel.lon, openingBridgeData.lat, openingBridgeData.lon,
            );
            if (distToOpening > PROTECTION_ZONE_RADIUS) {
              this.logger.debug(
                `🔄 [BRIDGE_OPENING_CLEAR] ${vessel.mmsi}: Clearing stale bridge opening for ${syntheticBridge} `
                + `(vessel ${Math.round(distToOpening)}m away, >${PROTECTION_ZONE_RADIUS}m threshold)`,
              );
              vessel._bridgeOpeningUntil = null;
              vessel._bridgeOpeningBridgeName = null;
              vessel._bridgeOpeningLogged = null;
              vessel._underBridgeLatched = false;
              // Fall through to physical distance checks below
            }
          }
        }
      }

      // Re-check: window may have been cleared by distance valve above or by time expiry
      if (vessel._bridgeOpeningUntil && vessel._bridgeOpeningUntil > now) {
        const syntheticBridge = vessel._bridgeOpeningBridgeName || vessel.currentBridge || vessel.targetBridge;
        if (syntheticBridge && vessel.currentBridge !== syntheticBridge) {
          vessel.currentBridge = syntheticBridge;
        }
        vessel._underBridgeLatched = true;
        if (!vessel._bridgeOpeningLogged || now - vessel._bridgeOpeningLogged > 1000) {
          this.logger.debug(
            `🕒 [BRIDGE_OPENING] ${vessel.mmsi}: Holding under-bridge state for ${syntheticBridge} `
            + `(${((vessel._bridgeOpeningUntil - now) / 1000).toFixed(1)}s remaining)`,
          );
          vessel._bridgeOpeningLogged = now;
        }
        return true;
      }

      if (vessel._bridgeOpeningUntil && vessel._bridgeOpeningUntil <= now) {
        vessel._bridgeOpeningUntil = null;
        vessel._bridgeOpeningBridgeName = null;
        vessel._bridgeOpeningLogged = null;
      }
    }

    // Get previous under-bridge state for hysteresis
    const wasUnderBridge = vessel._underBridgeLatched || false;

    // HYSTERESIS CORRUPTION FIX: Check for reset conditions
    const hysteresisWasReset = this._checkHysteresisResetConditions(vessel);

    // Bug #5 fix: under-bridge state must have a hard time limit. Observed in
    // production: "strax" stuck for 1+ hour when a vessel anchors within
    // under-bridge distance but the passage detector never fires (e.g.
    // GPS jitter straddling the bridge line). After 10 minutes in under-bridge
    // state with no movement, force-clear the latch so the vessel re-evaluates
    // via normal status logic (and eventually ages out via STALE_AIS).
    //
    // Review fix (bug_006 follow-up): returning false after force-clear is
    // critical. If we fall through, INTERMEDIATE_UNDER/TARGET_UNDER below use
    // the SET threshold (≤50m) because effectiveWasUnderBridge is now false,
    // which immediately re-sets the latch for any anchored vessel within 50m
    // — making the timeout a no-op. Returning false forces the vessel to
    // re-acquire via normal distance checks on the NEXT AIS tick with a
    // fresh timestamp, breaking the loop.
    if (wasUnderBridge && !hysteresisWasReset) {
      if (!vessel._underBridgeSince) {
        vessel._underBridgeSince = now;
      } else {
        // B5 (körning 2026-07-03, F7/VALEN): räkna "fast under bron"-tid
        // endast över FÄRSKA positioner. Under ett AIS-gap växte väggtiden
        // och timeouten force-clearade latchen mitt i en pågående målbro-
        // transit — texten föll till "Inga båtar" fast båten var kvar (VALEN
        // 17:03, gap 16:53→17:06 under Järnvägsbron).
        // Produktionsredo-granskningen (2026-07-03): första formeln
        // återanvände den redan förskjutna basen — varje omapplicering DROG
        // AV positionens ålder från ackumulerad tid, så en gles-sändande
        // ankrad båt (Class B ankrad = 3-min-intervall > färskhetsgränsen)
        // närmade sig noll och Bug #5-force-clearen avfyrades ALDRIG.
        // Rätt frysning: fånga ackumulerad tid EN gång vid gap-start
        // (_underBridgeFrozenAccMs — i fältlistan!) och håll basen mot den;
        // färsk position släpper frysen och ackumuleringen fortsätter.
        const UNDER_BRIDGE_FRESH_MS = 2 * 60 * 1000;
        // F4-E (fältprov 4, 2026-07-09): färskhet mäts mot senast BEKRÄFTADE
        // positionsrapport (max(timestamp, lastPositionUpdate)) — en ankrad
        // SÄNDANDE båt under bron är B5:s designade force-clear-fall, men
        // positionsändringsklockan frös henne som "gap" och stuck-tiden
        // ackumulerade aldrig. Tyst transponder fryser båda klockorna ⇒
        // gap-skyddet består.
        const lastConfirmedMs = Math.max(vessel.timestamp || 0, vessel.lastPositionUpdate || 0);
        const posAgeMs = lastConfirmedMs > 0 ? now - lastConfirmedMs : Infinity;
        if (posAgeMs > UNDER_BRIDGE_FRESH_MS) {
          if (!Number.isFinite(vessel._underBridgeFrozenAccMs)) {
            vessel._underBridgeFrozenAccMs = Math.max(
              0,
              (vessel.lastPositionUpdate || now) - vessel._underBridgeSince,
            );
          }
          vessel._underBridgeSince = now - vessel._underBridgeFrozenAccMs;
        } else {
          vessel._underBridgeFrozenAccMs = null;
        }
        const underBridgeDurationMs = now - vessel._underBridgeSince;
        const UNDER_BRIDGE_MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes
        if (underBridgeDurationMs > UNDER_BRIDGE_MAX_DURATION_MS) {
          this.logger.log(
            `⏰ [UNDER_BRIDGE_TIMEOUT] ${vessel.mmsi}: Stuck under `
            + `${vessel.currentBridge || vessel.targetBridge} for `
            + `${Math.round(underBridgeDurationMs / 60000)}min — force-clearing latch`,
          );
          vessel._underBridgeLatched = false;
          vessel._underBridgeSince = null;
          return false;
        }
      }
    } else if (!wasUnderBridge) {
      // Clear the timestamp when we leave under-bridge state naturally
      vessel._underBridgeSince = null;
    }

    // If hysteresis was reset, we should not use the previous wasUnderBridge state
    const effectiveWasUnderBridge = hysteresisWasReset ? false : (vessel._underBridgeLatched || false);

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
        // FIX O: För nära bro-par (Järnvägsbron↔Stridsbergsbron), kräv att "inväntar" visats
        // innan under-bridge tillåts. Detta säkerställer fullständig fas-sekvens.
        const CLOSE_BRIDGE_PAIRS = {
          Järnvägsbron: 'Stridsbergsbron',
          Stridsbergsbron: 'Järnvägsbron',
        };
        const pairedBridge = CLOSE_BRIDGE_PAIRS[vessel.currentBridge];
        if (pairedBridge && vessel.lastPassedBridge === pairedBridge && vessel.lastPassedBridgeTime) {
          const timeSincePass = now - vessel.lastPassedBridgeTime;
          const MIN_WAITING_DISPLAY_MS = 5000; // 5 sekunder för "inväntar" att visas

          // Kolla om vi har visat "inväntar" vid denna bro sedan vi passerade parad bro
          const hasShownWaiting = vessel._lastWaitingShownAt?.[vessel.currentBridge]
            && vessel._lastWaitingShownAt[vessel.currentBridge] > vessel.lastPassedBridgeTime;

          if (!hasShownWaiting && timeSincePass < MIN_WAITING_DISPLAY_MS + 15000) {
            // Blockera under-bridge för att tillåta "inväntar" att visas
            this.logger.debug(
              `🔄 [FIX_O_WAITING_REQUIRED] ${vessel.mmsi}: Blocking under-bridge at ${vessel.currentBridge} - `
              + `"inväntar" not yet shown since passing ${pairedBridge} (${timeSincePass}ms ago)`,
            );
            return false;
          }
        }

        if (!vessel._underBridgeLatched) {
          // Review fix (bug_006 follow-up): anchor the timer alongside the
          // latch-set so the 10-min countdown starts on the first under-bridge
          // cycle, not one AIS cycle later.
          vessel._underBridgeSince = now;
          // Produktionsredo (2026-07-03): spara ingångspositionen så clear-
          // grenen kan skilja äkta korsning (sidbyte) från kö-drift ut ur
          // zonen på SAMMA sida — ovillkorlig ankring blockerade den äkta
          // passagen via 3-min-guarden.
          vessel._underBridgeEntryLat = vessel.lat;
          vessel._underBridgeEntryLon = vessel.lon;
          // Helgranskning 2026-07-06 (status-2#2): ny episod börjar med ren
          // frysackumulator — clear-vägarna nollade den inte, så en åter-latch
          // under pågående stale-fönster ärvde gammal tid → force-clear i förtid.
          vessel._underBridgeFrozenAccMs = null;
        }
        vessel._underBridgeLatched = true;
        // ZONE TRANSITION CAPTURE: Record critical under-bridge transition
        this._recordZoneTransition(vessel, 'under-bridge', vessel.distanceToCurrent, vessel.currentBridge);
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
        if (!vessel._underBridgeLatched) {
          // Review fix (bug_006 follow-up): see comment at INTERMEDIATE_UNDER.
          vessel._underBridgeSince = now;
          vessel._underBridgeEntryLat = vessel.lat;
          vessel._underBridgeEntryLon = vessel.lon;
          // Helgranskning 2026-07-06 (status-2#2): se INTERMEDIATE_UNDER.
          vessel._underBridgeFrozenAccMs = null;
        }
        vessel._underBridgeLatched = true;
        // FIX 1: Sätt currentBridge för målbroar (som för mellanbroar)
        // BridgeTextService kräver currentBridge och distanceToCurrent för att generera "Broöppning pågår"
        vessel.currentBridge = vessel.targetBridge;
        vessel.distanceToCurrent = targetDistance;
        // ZONE TRANSITION CAPTURE: Record critical under-bridge transition for target
        this._recordZoneTransition(vessel, 'under-bridge', targetDistance, vessel.targetBridge);
        this.logger.debug(`🎯 [TARGET_UNDER] ${vessel.mmsi}: ${targetDistance.toFixed(0)}m from target -> under-bridge (currentBridge set)`);
        return true;
      }
    }

    // Clear latch if no longer under any bridge
    if (effectiveWasUnderBridge) {
      vessel._underBridgeLatched = false;
      this.logger.debug(`🌉 [UNDER_BRIDGE_CLEAR] ${vessel.mmsi}: No longer under bridge (cleared at >=${UNDER_BRIDGE_CLEAR_DISTANCE}m)`);

      // PASSAGE ANCHORING: Record crossing timestamp for deduplication.
      // Produktionsredo (2026-07-03): ankra ENDAST vid verkligt sidbyte —
      // en köande båt som kröp in i zonen och driftade UT PÅ SAMMA SIDA
      // fick annars en falsk passage-ankring som (via 3-min-guarden)
      // blockerade registreringen av den äkta passagen strax efteråt.
      // Utan känd ingångsposition ankras som förut (bevarat beteende).
      if (this.vesselDataService && (vessel.currentBridge || vessel.targetBridge)) {
        const bridgeForAnchoring = vessel.currentBridge || vessel.targetBridge;
        const bridgeObj = this.bridgeRegistry
          && typeof this.bridgeRegistry.getBridgeByName === 'function'
          ? this.bridgeRegistry.getBridgeByName(bridgeForAnchoring)
          : null;
        // FÄLTPROV 2026-07-07 (EKEN 20:07): currentBridge hade precis
        // nollställts av CURRENT_BRIDGE_PASSED (Olidebron) → fallbacken
        // ankrade TARGET-bron Klaffbron 1181 m bort som "korsad". Latent
        // farligt: vid efterföljande AIS-tystnad kunde falska ankaret ge en
        // falsk passage-inferred, eller (äkta passage inom 3 min) blockera
        // den äkta registreringen. Ankra ALDRIG en bro som är bortom
        // clear-zonen — en verklig under-bro-exit sker per definition nära
        // brolinjen (~70 m + GPS-marginal).
        const distToAnchorBridge = bridgeObj
          && Number.isFinite(bridgeObj.lat) && Number.isFinite(bridgeObj.lon)
          ? geometry.calculateDistance(vessel.lat, vessel.lon, bridgeObj.lat, bridgeObj.lon)
          : null;
        const ANCHOR_MAX_DISTANCE_M = 150; // clear-zonen 70 m + GPS-/gleshetsmarginal
        if (Number.isFinite(distToAnchorBridge) && distToAnchorBridge > ANCHOR_MAX_DISTANCE_M) {
          this.logger.debug(
            `🚫 [ANCHOR_SKIP_FAR] ${vessel.mmsi}: not anchoring ${bridgeForAnchoring} — `
            + `${Math.round(distToAnchorBridge)}m away (> ${ANCHOR_MAX_DISTANCE_M}m; fallback picked wrong bridge)`,
          );
          vessel._underBridgeEntryLat = null;
          vessel._underBridgeEntryLon = null;
          return false;
        }
        const hasEntry = Number.isFinite(vessel._underBridgeEntryLat)
          && Number.isFinite(vessel._underBridgeEntryLon);
        const sideChanged = !hasEntry || !bridgeObj
          || geometry.hasChangedBridgeSide(
            { lat: vessel._underBridgeEntryLat, lon: vessel._underBridgeEntryLon },
            { lat: vessel.lat, lon: vessel.lon },
            bridgeObj,
          );
        if (sideChanged) {
          // ENCAPSULATION FIX: Use public method instead of private _anchorPassageTimestamp
          this.vesselDataService.anchorPassageTimestamp(vessel, bridgeForAnchoring, Date.now());
        } else {
          this.logger.debug(
            `🚫 [UNDER_BRIDGE_NO_CROSS] ${vessel.mmsi}: Left ${bridgeForAnchoring} zone on the SAME side `
            + '— skipping passage anchoring (queue drift, not a crossing)',
          );
        }
      }
      vessel._underBridgeEntryLat = null;
      vessel._underBridgeEntryLon = null;
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

    // Reset on target bridge changes — EN gång per faktisk förändring
    // (X→Y, X→null, null→Y). undefined = aldrig spårad (första passet).
    const lastTargetBridge = vessel._lastTargetBridgeForHysteresis;
    if (lastTargetBridge !== undefined
        && (lastTargetBridge || vessel.targetBridge)
        && vessel.targetBridge !== lastTargetBridge) {
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
      // Review fix (bug_006 follow-up): _underBridgeSince must be cleared
      // alongside the latch; otherwise the 10-min timer would continue to
      // run against the pre-reset timestamp and fire prematurely on re-entry.
      vessel._underBridgeSince = null;
      this.logger.debug(`🔄 [HYSTERESIS_RESET] ${mmsi}: ${resetReason} - resetting latch`);
    }

    // Update tracking properties (ALWAYS, even after reset).
    // Fältprov 3 (2026-07-08): targetBridge-spårningen måste följa med till
    // null — annars står gamla bron kvar som baslinje efter TARGET_END/
    // reversal och "changed from X to null" retriggar VARJE statuspass
    // (77 identiska resets för SOLANDE), vilket dessutom nollar en legitim
    // under-bridge-latch för MÅLLÖSA båtar (ELFKUNGEN@Stallbackabron:
    // hysteresen var i praktiken död post-target). En reset per faktisk
    // förändring är avsikten.
    vessel._lastTargetBridgeForHysteresis = vessel.targetBridge || null;
    if (vessel.currentBridge) {
      vessel._lastCurrentBridgeForHysteresis = vessel.currentBridge;
    }

    return resetReason !== null; // Return true if reset was applied
  }

  /**
   * Check if vessel is waiting (ENHANCED: Zone hysteresis + transition capture)
   * @private
   */
  _isWaiting(vessel, proximityData) {
    // STALLBACKABRON SPECIAL RULE: NEVER "waiting" status for Stallbackabron
    // This prevents "inväntar broöppning" messages for high bridge
    if (this._isAtStallbackabron(vessel, proximityData)) {
      this.logger.debug(`🌉 [WAITING_CHECK] ${vessel.mmsi}: At Stallbackabron - no waiting status`);
      return false; // Stallbackabron uses special "åker strax under" logic instead
    }

    // ENHANCED RULE: Zone hysteresis for 300m waiting zone (280m/320m thresholds)
    // This triggers "En båt inväntar broöppning vid X" message with stability
    const targetDistance = this._getDistanceToTargetBridge(vessel);
    const targetDistanceStr = targetDistance !== null ? `${targetDistance.toFixed(0)}` : 'N/A';

    if (targetDistance !== null) {
      // ZONE HYSTERESIS: Use different thresholds based on current status
      const currentlyWaiting = vessel.status === 'waiting';
      const waitingThreshold = currentlyWaiting
        ? STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE // 320m to clear
        : STATUS_HYSTERESIS.WAITING_SET_DISTANCE; // 280m to set

      this.logger.debug(
        `🔍 [WAITING_CHECK_HYSTERESIS] ${vessel.mmsi}: Target distance = ${targetDistanceStr}m `
        + `to ${vessel.targetBridge || 'none'}, threshold = ${waitingThreshold}m `
        + `(currently waiting: ${currentlyWaiting})`,
      );

      if (targetDistance <= waitingThreshold) {
        // FIX I.1: Blockera waiting vid nära bro-par för att säkerställa "precis passerat" visas
        // Järnvägsbron och Stridsbergsbron är bara ~420m isär
        const CLOSE_BRIDGE_PAIRS = {
          Järnvägsbron: 'Stridsbergsbron',
          Stridsbergsbron: 'Järnvägsbron',
        };
        const MIN_PASSED_DISPLAY_MS = 15000; // 15 sekunder för "precis passerat"

        const pairedBridge = CLOSE_BRIDGE_PAIRS[vessel.lastPassedBridge];
        if (pairedBridge === vessel.targetBridge && vessel.lastPassedBridgeTime) {
          const timeSincePass = Date.now() - vessel.lastPassedBridgeTime;
          if (timeSincePass < MIN_PASSED_DISPLAY_MS) {
            this.logger.debug(
              `🔄 [CLOSE_BRIDGE_PAIR] ${vessel.mmsi}: Recently passed ${vessel.lastPassedBridge} (${timeSincePass}ms ago), `
              + `blocking waiting at ${vessel.targetBridge} to allow "precis passerat" display`,
            );
            return false;
          }
        }

        // BUGFIX: Förhindra återgång till waiting vid samma bro som precis passerats
        if (this._hasRecentlyPassed(vessel) && vessel.lastPassedBridge === vessel.targetBridge) {
          this.logger.debug(`🚫 [WAITING_BLOCKED] ${vessel.mmsi}: Recently passed target bridge ${vessel.targetBridge}, blocking waiting status`);
          return false;
        }

        if (this.passageWindowManager.isWithinInternalGracePeriod(vessel)
            && vessel.lastPassedBridge === vessel.targetBridge) {
          this.logger.debug(`🚫 [WAITING_GRACE_BLOCKED] ${vessel.mmsi}: Within internal grace after passing ${vessel.targetBridge}, blocking waiting status`);
          return false;
        }

        if (this._isInPassageCooldown(vessel, vessel.targetBridge)) {
          this.logger.debug(`🚫 [WAITING_COOLDOWN] ${vessel.mmsi}: Cooldown active for ${vessel.targetBridge}, blocking waiting status`);
          return false;
        }

        // PASSAGE-LATCH: Check if this status should be blocked due to recent passage
        if (this.passageLatchService && this.passageLatchService.shouldBlockStatus(vessel.mmsi.toString(), vessel.targetBridge, 'waiting', vessel.cog)) {
          this.logger.debug(`🔒 [PASSAGE_LATCH_BLOCKED] ${vessel.mmsi}: Waiting status blocked for ${vessel.targetBridge} due to recent passage`);
          return false;
        }

        // ZONE TRANSITION CAPTURE: Record zone transition for critical status prioritization
        this._recordZoneTransition(vessel, 'waiting', targetDistance);

        const action = currentlyWaiting ? 'maintaining' : 'setting';
        this.logger.debug(
          `✅ [WAITING_TARGET_HYSTERESIS] ${vessel.mmsi}: ${targetDistance.toFixed(0)}m from `
          + `target bridge "${vessel.targetBridge}" (threshold=${waitingThreshold}m) -> ${action} waiting status`,
        );

        // FIX O: Spåra när "inväntar" visades vid denna bro
        if (!vessel._lastWaitingShownAt) vessel._lastWaitingShownAt = {};
        vessel._lastWaitingShownAt[vessel.targetBridge] = Date.now();

        return true;
      }
    }

    // ENHANCED: Also check if vessel is within hysteresis zone from any INTERMEDIATE bridge
    // This enables "inväntar broöppning av [intermediate bridge]" messages with stability
    const currentlyWaitingIntermediate = vessel.status === 'waiting' && vessel.currentBridge && vessel.currentBridge !== vessel.targetBridge;
    const intermediateWaitingThreshold = currentlyWaitingIntermediate
      ? STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE // 320m to clear
      : STATUS_HYSTERESIS.WAITING_SET_DISTANCE; // 280m to set

    if (proximityData.nearestDistance <= intermediateWaitingThreshold) {
      // Get the nearest bridge name to determine if it's an intermediate bridge
      const { nearestBridge } = proximityData;
      if (nearestBridge && nearestBridge.name && nearestBridge.name !== vessel.targetBridge) {
        // Near an intermediate bridge, not the target bridge
        const bridgeName = nearestBridge.name;
        const isIntermediateBridge = ['Olidebron', 'Järnvägsbron'].includes(bridgeName);
        if (isIntermediateBridge) {
          // FIX I.1: Blockera waiting vid nära bro-par för mellanbroar
          // Stridsbergsbron → Järnvägsbron (söderut)
          const CLOSE_BRIDGE_PAIRS = {
            Stridsbergsbron: 'Järnvägsbron',
            Järnvägsbron: 'Stridsbergsbron', // För konsistens (även om detta är target bridge)
          };
          const MIN_PASSED_DISPLAY_MS = 15000; // 15 sekunder för "precis passerat"

          const pairedBridge = CLOSE_BRIDGE_PAIRS[vessel.lastPassedBridge];
          if (pairedBridge === bridgeName && vessel.lastPassedBridgeTime) {
            const timeSincePass = Date.now() - vessel.lastPassedBridgeTime;
            if (timeSincePass < MIN_PASSED_DISPLAY_MS) {
              this.logger.debug(
                `🔄 [CLOSE_BRIDGE_PAIR_INTERMEDIATE] ${vessel.mmsi}: Recently passed ${vessel.lastPassedBridge} (${timeSincePass}ms ago), `
                + `blocking waiting at ${bridgeName} to allow "precis passerat" display`,
              );
              return false;
            }
          }

          // BUGFIX: Förhindra återgång till waiting vid samma intermediate bro som precis passerats
          if (this._hasRecentlyPassed(vessel) && vessel.lastPassedBridge === bridgeName) {
            this.logger.debug(`🚫 [WAITING_BLOCKED] ${vessel.mmsi}: Recently passed intermediate bridge ${bridgeName}, blocking waiting status`);
            return false;
          }

          if (this.passageWindowManager.isWithinInternalGracePeriod(vessel)
              && (vessel.lastPassedBridge === bridgeName || vessel.lastPassedBridge === vessel.currentBridge)) {
            this.logger.debug(`🚫 [WAITING_GRACE_BLOCKED] ${vessel.mmsi}: Within internal grace after passing ${vessel.lastPassedBridge}, blocking waiting status for ${bridgeName}`);
            return false;
          }

          if (this._isInPassageCooldown(vessel, bridgeName)) {
            this.logger.debug(`🚫 [WAITING_COOLDOWN] ${vessel.mmsi}: Cooldown active for ${bridgeName}, blocking waiting status`);
            return false;
          }

          if (this.passageLatchService
              && this.passageLatchService.shouldBlockStatus(vessel.mmsi.toString(), bridgeName, 'waiting', vessel.cog)) {
            this.logger.debug(`🔒 [PASSAGE_LATCH_BLOCKED] ${vessel.mmsi}: Waiting status blocked for intermediate ${bridgeName} due to latch`);
            return false;
          }

          // ZONE TRANSITION CAPTURE: Record zone transition for intermediate bridge
          this._recordZoneTransition(vessel, 'waiting', proximityData.nearestDistance, bridgeName);

          const action = currentlyWaitingIntermediate ? 'maintaining' : 'setting';
          this.logger.debug(
            `⚡ [INTERMEDIATE_WAITING_HYSTERESIS] ${vessel.mmsi}: ${proximityData.nearestDistance.toFixed(0)}m `
            + `from intermediate bridge "${bridgeName}" (threshold=${intermediateWaitingThreshold}m) -> ${action} waiting status`,
          );

          // CRITICAL: Set currentBridge for BridgeTextService to detect intermediate bridge waiting
          vessel.currentBridge = bridgeName;
          vessel.distanceToCurrent = proximityData.nearestDistance;

          // FIX O: Spåra när "inväntar" visades vid denna mellanbro
          if (!vessel._lastWaitingShownAt) vessel._lastWaitingShownAt = {};
          vessel._lastWaitingShownAt[bridgeName] = Date.now();

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

      if (this._hasRecentlyPassed(vessel) && vessel.lastPassedBridge === vessel.targetBridge) {
        this.logger.debug(`🚫 [APPROACHING_BLOCKED] ${vessel.mmsi}: Recently passed target bridge ${vessel.targetBridge}, blocking approaching status`);
        return false;
      }

      if (this.passageWindowManager.isWithinInternalGracePeriod(vessel)
          && vessel.lastPassedBridge === vessel.targetBridge) {
        this.logger.debug(`🚫 [APPROACHING_GRACE_BLOCKED] ${vessel.mmsi}: Within internal grace after passing ${vessel.targetBridge}, blocking approaching status`);
        return false;
      }

      if (this._isInPassageCooldown(vessel, vessel.targetBridge)) {
        this.logger.debug(`🚫 [APPROACHING_COOLDOWN] ${vessel.mmsi}: Cooldown active for ${vessel.targetBridge}, blocking approaching status`);
        return false;
      }

      if (this.passageLatchService
          && this.passageLatchService.shouldBlockStatus(vessel.mmsi.toString(), vessel.targetBridge, 'approaching', vessel.cog)) {
        this.logger.debug(`🔒 [PASSAGE_LATCH_BLOCKED] ${vessel.mmsi}: Approaching status blocked for target ${vessel.targetBridge}`);
        return false;
      }

      if (targetDistance <= approachThreshold && targetDistance > APPROACH_RADIUS) {
        const action = currentlyApproaching ? 'maintaining' : 'setting';
        this.logger.debug(
          `🟡 [APPROACHING_TARGET_HYSTERESIS] ${vessel.mmsi}: ${targetDistance.toFixed(0)}m from `
          + `target bridge "${vessel.targetBridge}" (threshold=${approachThreshold}m) -> ${action} approaching status`,
        );
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
          if (this._hasRecentlyPassed(vessel)
              && (vessel.lastPassedBridge === bridgeName || vessel.lastPassedBridge === vessel.currentBridge)) {
            this.logger.debug(`🚫 [APPROACHING_BLOCKED] ${vessel.mmsi}: Recently passed ${bridgeName}, blocking approaching status`);
            return false;
          }

          if (this.passageWindowManager.isWithinInternalGracePeriod(vessel)
              && (vessel.lastPassedBridge === bridgeName || vessel.lastPassedBridge === vessel.currentBridge)) {
            this.logger.debug(`🚫 [APPROACHING_GRACE_BLOCKED] ${vessel.mmsi}: Within internal grace after passing ${vessel.lastPassedBridge}, blocking approaching for ${bridgeName}`);
            return false;
          }

          if (this._isInPassageCooldown(vessel, bridgeName)) {
            this.logger.debug(`🚫 [APPROACHING_COOLDOWN] ${vessel.mmsi}: Cooldown active for ${bridgeName}, blocking approaching status`);
            return false;
          }

          if (this.passageLatchService
              && this.passageLatchService.shouldBlockStatus(vessel.mmsi.toString(), bridgeName, 'approaching', vessel.cog)) {
            this.logger.debug(`🔒 [PASSAGE_LATCH_BLOCKED] ${vessel.mmsi}: Approaching status blocked for intermediate ${bridgeName}`);
            return false;
          }

          const action = currentlyApproaching ? 'maintaining' : 'setting';
          this.logger.debug(
            `🟡 [APPROACHING_INTERMEDIATE_HYSTERESIS] ${vessel.mmsi}: ${proximityData.nearestDistance.toFixed(0)}m from `
            + `intermediate bridge "${bridgeName}" (threshold=${approachThreshold}m) -> ${action} approaching status`,
          );

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
          this.logger.debug(
            `🌉 [STALLBACKA_APPROACHING_HYSTERESIS] ${vessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from `
            + `"Stallbackabron" (threshold=${stallbackaApproachThreshold}m) -> ${action} approaching status`,
          );

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

    // FIX B: Synkat med BridgeTextService PASSED_WINDOW_MS (180s)
    // This must match BridgeTextService._hasRecentlyPassed() for consistency
    const timeSincePass = Date.now() - vessel.lastPassedBridgeTime;
    const passedWindow = 180 * 1000; // 180 seconds - synkat med BridgeTextService PASSED_WINDOW_MS

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

    // Helgranskning 2026-07-06: sog kan vara null (Class B "ej tillgänglig",
    // dokumenterat legitimt). Jämförelsen null <= 0.2 är avsiktligt kvar
    // (okänd fart ⇒ konservativt "kan vänta"), men loggargumentet evalueras
    // ALLTID (även med debug av) — null.toFixed(2) kastade TypeError och
    // slängde hela tickens statusresultat. Formatera defensivt.
    const sogLabel = Number.isFinite(vessel.sog) ? `${vessel.sog.toFixed(2)}kn` : 'okänd fart';
    if (vessel.sog <= WAITING_SPEED_THRESHOLD) {
      // Vessel is moving slowly
      if (!vessel.speedBelowThresholdSince) {
        vessel.speedBelowThresholdSince = now;
        this.logger.debug(
          `🕐 [WAITING_TIMER] ${vessel.mmsi}: Started waiting timer (speed: ${sogLabel})`,
        );
      }
    } else if (vessel.speedBelowThresholdSince) {
      // Vessel is moving fast enough - reset timer
      vessel.speedBelowThresholdSince = null;
      this.logger.debug(
        `🏃 [WAITING_TIMER] ${vessel.mmsi}: Reset waiting timer (speed: ${sogLabel})`,
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
   * Check if vessel should show "åker strax under" for Stallbackabron (ENHANCED: Zone hysteresis)
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

    // ENHANCED: Zone hysteresis for Stallbackabron waiting zone (280m/320m thresholds)
    // STALLBACKABRON SPECIAL RULE: triggers "åker strax under" instead of "inväntar broöppning"
    const currentlyStallbackaWaiting = vessel.status === 'stallbacka-waiting';
    const stallbackaThreshold = currentlyStallbackaWaiting
      ? STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE // 320m to clear
      : STATUS_HYSTERESIS.WAITING_SET_DISTANCE; // 280m to set

    if (distanceToStallbacka <= stallbackaThreshold) {
      // PASSAGE-LATCH: Check if stallbacka-waiting should be blocked due to recent passage
      if (this.passageLatchService && this.passageLatchService.shouldBlockStatus(vessel.mmsi.toString(), 'Stallbackabron', 'stallbacka-waiting', vessel.cog)) {
        this.logger.debug(`🔒 [PASSAGE_LATCH_BLOCKED] ${vessel.mmsi}: Stallbacka-waiting status blocked for Stallbackabron due to recent passage`);
        return false;
      }

      // ZONE TRANSITION CAPTURE: Record critical transition for Stallbackabron
      this._recordZoneTransition(vessel, 'stallbacka-waiting', distanceToStallbacka, 'Stallbackabron');

      const action = currentlyStallbackaWaiting ? 'maintaining' : 'setting';
      this.logger.debug(
        `🌉 [STALLBACKA_SPECIAL_HYSTERESIS] ${vessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from `
        + `Stallbackabron (threshold=${stallbackaThreshold}m) -> ${action} "åker strax under" `
        + '(INTERMEDIATE BRIDGE, no under-bridge status)',
      );
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
   * Record zone transition for transition capture system
   * @private
   */
  _recordZoneTransition(vessel, status, distance, bridgeName = null) {
    const now = Date.now();
    const transitionKey = `${status}_${bridgeName || vessel.targetBridge || 'unknown'}`;

    // Initialize transition tracking if needed
    if (!vessel._zoneTransitions) {
      vessel._zoneTransitions = new Map();
    }

    // Check if this is a critical transition (stallbacka-waiting, under-bridge)
    const isCriticalTransition = status === 'stallbacka-waiting' || status === 'under-bridge';

    // Record the transition with timestamp and priority
    vessel._zoneTransitions.set(transitionKey, {
      status,
      bridgeName: bridgeName || vessel.targetBridge,
      distance: distance.toFixed(1),
      timestamp: now,
      isCritical: isCriticalTransition,
      priority: this._getTransitionPriority(status),
    });

    // TRANSITION CAPTURE: Hold critical transitions for UI stability.
    // Fältprov 3 (2026-07-08, SELENE 02:30–02:33): timerdrivna statuspass
    // återfångade holden var 30:e sekund från SAMMA frusna position — den
    // nivåtriggade zonanalysen ser "entered_under_bridge" i varje pass.
    // Förnya bara när positionen avancerat sedan senaste capturen: färsk
    // AIS förnyar som förut, stale data fångar EN gång och holden löper ut
    // enligt sin egen livslängd i stället för att förlängas i evighet.
    if (isCriticalTransition) {
      const capturedBridge = bridgeName || vessel.targetBridge;
      const posTs = Number.isFinite(vessel.lastPositionUpdate) ? vessel.lastPositionUpdate : vessel.timestamp;
      const samePositionAsLastCapture = Number.isFinite(posTs)
        && vessel._criticalTransitionCapturedPosTs === posTs
        && vessel._criticalTransitionHoldBridge === capturedBridge;
      if (!samePositionAsLastCapture) {
        vessel._criticalTransitionHoldUntil = now + STATUS_HYSTERESIS.CRITICAL_TRANSITION_HOLD_MS;
        vessel._criticalTransitionCapturedPosTs = Number.isFinite(posTs) ? posTs : null;
        vessel._criticalTransitionHoldBridge = capturedBridge;
        this.logger.debug(
          `🔥 [ZONE_TRANSITION_CAPTURE] ${vessel.mmsi}: Captured critical transition to ${status} at `
          + `${capturedBridge} (hold until ${new Date(vessel._criticalTransitionHoldUntil).toLocaleTimeString()})`,
        );
      }
    }

    // Cleanup old transitions (keep only recent ones)
    const transitionCutoff = now - (STATUS_HYSTERESIS.ZONE_TRANSITION_GRACE_MS * 2);
    for (const [key, transition] of vessel._zoneTransitions.entries()) {
      if (transition.timestamp < transitionCutoff) {
        vessel._zoneTransitions.delete(key);
      }
    }
  }

  /**
   * Get transition priority for zone transition capture
   * @private
   */
  _getTransitionPriority(status) {
    const priorities = {
      'under-bridge': 100, // Highest priority - bridge opening in progress
      'stallbacka-waiting': 90, // Very high priority - åker strax under
      waiting: 80, // High priority - inväntar broöppning
      approaching: 70, // Medium priority - närmar sig
      'en-route': 60, // Lower priority - på väg mot
      passed: 50, // Lowest priority - precis passerat
    };

    return priorities[status] || 0;
  }

  /**
   * Check if vessel has active critical transition hold
   * Used by UI system to prioritize critical status changes
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if vessel has active critical transition
   */
  hasActiveCriticalTransition(vessel) {
    if (!vessel._criticalTransitionHoldUntil) {
      return false;
    }

    const now = Date.now();
    const isActive = now < vessel._criticalTransitionHoldUntil;

    if (!isActive && vessel._criticalTransitionHoldUntil) {
      // Clear expired hold
      delete vessel._criticalTransitionHoldUntil;
      this.logger.debug(`🔄 [ZONE_TRANSITION_EXPIRED] ${vessel.mmsi}: Critical transition hold expired`);
    }

    return isActive;
  }

  /**
   * Get the highest priority active zone transition for vessel
   * Used by UI system for transition prioritization
   * @param {Object} vessel - Vessel object
   * @returns {Object|null} Transition data or null
   */
  getHighestPriorityTransition(vessel) {
    if (!vessel._zoneTransitions || vessel._zoneTransitions.size === 0) {
      return null;
    }

    const now = Date.now();
    const graceCutoff = now - STATUS_HYSTERESIS.ZONE_TRANSITION_GRACE_MS;

    let highestTransition = null;
    let highestPriority = -1;

    for (const transition of vessel._zoneTransitions.values()) {
      // Only consider recent transitions
      if (transition.timestamp >= graceCutoff && transition.priority > highestPriority) {
        highestTransition = transition;
        highestPriority = transition.priority;
      }
    }

    return highestTransition;
  }

  /**
   * Check if vessel should be protected from target bridge changes due to zone hysteresis
   * Integrates with VesselDataService 300m Protection Zone
   * @param {Object} vessel - Vessel object
   * @param {Object} proximityData - Proximity analysis data
   * @returns {Object} Protection analysis result
   */
  analyzeZoneProtectionNeeds(vessel, proximityData) {
    const protectionAnalysis = {
      needsProtection: false,
      reason: null,
      priority: 0,
      bridgeName: null,
      distance: null,
      hysteresisActive: false,
    };

    // Check for active critical transition holds
    if (this.hasActiveCriticalTransition(vessel)) {
      protectionAnalysis.needsProtection = true;
      protectionAnalysis.reason = 'critical_transition_hold';
      protectionAnalysis.priority = 100;
      protectionAnalysis.hysteresisActive = true;

      const transition = this.getHighestPriorityTransition(vessel);
      if (transition) {
        protectionAnalysis.bridgeName = transition.bridgeName;
        protectionAnalysis.distance = parseFloat(transition.distance);
      }

      return protectionAnalysis;
    }

    // Check for vessels in waiting zone hysteresis (280m-320m)
    const targetDistance = this._getDistanceToTargetBridge(vessel);
    if (targetDistance !== null && targetDistance <= STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE) {
      // Vessel is in or near waiting zone - needs enhanced protection
      protectionAnalysis.needsProtection = true;
      protectionAnalysis.reason = 'waiting_zone_hysteresis';
      protectionAnalysis.priority = 80;
      protectionAnalysis.bridgeName = vessel.targetBridge;
      protectionAnalysis.distance = targetDistance;
      protectionAnalysis.hysteresisActive = vessel.status === 'waiting';

      return protectionAnalysis;
    }

    // Check for vessels in approaching zone hysteresis (450m-550m)
    if (targetDistance !== null && targetDistance <= STATUS_HYSTERESIS.APPROACHING_CLEAR_DISTANCE) {
      protectionAnalysis.needsProtection = true;
      protectionAnalysis.reason = 'approaching_zone_hysteresis';
      protectionAnalysis.priority = 70;
      protectionAnalysis.bridgeName = vessel.targetBridge;
      protectionAnalysis.distance = targetDistance;
      protectionAnalysis.hysteresisActive = vessel.status === 'approaching';

      return protectionAnalysis;
    }

    // Check for vessels near intermediate bridges with hysteresis
    if (proximityData && proximityData.nearestDistance <= STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE) {
      const { nearestBridge } = proximityData;
      if (nearestBridge && nearestBridge.name) {
        protectionAnalysis.needsProtection = true;
        protectionAnalysis.reason = 'intermediate_bridge_hysteresis';
        protectionAnalysis.priority = 75;
        protectionAnalysis.bridgeName = nearestBridge.name;
        protectionAnalysis.distance = proximityData.nearestDistance;
        protectionAnalysis.hysteresisActive = vessel.currentBridge === nearestBridge.name;

        return protectionAnalysis;
      }
    }

    return protectionAnalysis;
  }

  /**
   * Determine if a passage cooldown is active for the vessel/bridge combination.
   * @private
   */
  _isInPassageCooldown(vessel, bridgeName) {
    if (!vessel || !bridgeName || !vessel._passageCooldowns) {
      return false;
    }

    const expiry = vessel._passageCooldowns[bridgeName];
    if (!expiry) {
      return false;
    }

    if (expiry <= Date.now()) {
      delete vessel._passageCooldowns[bridgeName];
      return false;
    }

    return true;
  }

  /**
   * Clear ETA history for vessel (integration with ETA Monotoni-skydd)
   * Called when vessel is removed or target bridge changes
   * @param {string} mmsi - Vessel MMSI
   * @param {string} reason - Reason for clearing
   */
  clearVesselETAHistory(mmsi, reason = 'unknown') {
    if (this.progressiveETACalculator && typeof this.progressiveETACalculator.clearVesselETAHistory === 'function') {
      this.progressiveETACalculator.clearVesselETAHistory(mmsi, reason);
    }
  }

  /**
   * Get ETA processing statistics (integration with ETA Monotoni-skydd)
   * @returns {Object} ETA processing statistics
   */
  getETAProcessingStats() {
    if (this.progressiveETACalculator && typeof this.progressiveETACalculator.getETAProcessingStats === 'function') {
      return this.progressiveETACalculator.getETAProcessingStats();
    }
    return { error: 'ETA calculator not available' };
  }

  /**
   * Calculate distance between two points in meters
   * @private
   */

  /**
   * Helgranskning 2026-07-06 (app-9#1): StatusService äger (via
   * ProgressiveETACalculator-konstruktorn) produktions-setInterval:et för
   * ETA-historikstädningen — utan destroy läckte intervallet vid varje
   * onUninit/onInit-cykel (Homey kan återanvända processen). Anropas från
   * appens destroy-kedja i onUninit.
   */
  destroy() {
    if (this.progressiveETACalculator && typeof this.progressiveETACalculator.destroy === 'function') {
      this.progressiveETACalculator.destroy();
    }
  }
}

module.exports = StatusService;
