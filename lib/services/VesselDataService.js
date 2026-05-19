'use strict';

const EventEmitter = require('events');
const geometry = require('../utils/geometry');
const constants = require('../constants');
const GPSJumpAnalyzer = require('../utils/GPSJumpAnalyzer');
const PassageWindowManager = require('../utils/PassageWindowManager');
const VesselLifecycleManager = require('./VesselLifecycleManager');

const { UI_CONSTANTS } = constants;

/**
 * VesselDataService - Pure data management for vessels
 * Handles vessel storage, updates, and lifecycle without business logic
 */
class VesselDataService extends EventEmitter {
  constructor(logger, bridgeRegistry, systemCoordinator) {
    super();
    this.logger = logger;
    // Provide app reference for cross-service access when 'logger' is the app instance
    this.app = logger && typeof logger === 'object' ? logger : null;
    this.bridgeRegistry = bridgeRegistry;
    this.systemCoordinator = systemCoordinator;
    this.vessels = new Map(); // Map<mmsi, VesselData>
    this.bridgeVessels = new Map(); // Map<bridgeId, Set<mmsi>>
    this.cleanupTimers = new Map(); // Map<mmsi, timeoutId>
    this._cleanupExpiryTimes = new Map(); // BUG 6: Track when timers expire
    this.gpsJumpAnalyzer = new GPSJumpAnalyzer(logger);
    this.passageWindowManager = new PassageWindowManager(logger, bridgeRegistry);
    this.vesselLifecycleManager = new VesselLifecycleManager(logger, bridgeRegistry);

    // Validate required dependencies
    if (!systemCoordinator) {
      throw new Error('SystemCoordinator is required for VesselDataService');
    }

    // FIX: Add operation locks to prevent concurrent updates/removes
    this.operationLocks = new Map(); // Map<mmsi, Promise>

    // ENHANCED: Target bridge protection tracking
    this.targetBridgeProtection = new Map(); // Map<mmsi, ProtectionData>
    this.protectionTimers = new Map(); // Map<mmsi, timeoutId>

    // RACE CONDITION FIX: Track vessels being removed to prevent concurrent operations
    this._removalInProgress = new Set(); // Set<mmsi>

    // Bug #13: track vessels that have fired JOURNEY_COMPLETED and are waiting
    // for their 100ms elimination timer to fire. New AIS messages must not
    // extend these timers back to 10+ minutes.
    this._eliminationPending = new Set(); // Set<mmsi>

    // MEMORY LEAK PREVENTION: Add monitoring and periodic cleanup validation
    this._memoryLeakStats = {
      totalVesselsCreated: 0,
      totalVesselsRemoved: 0,
      cleanupErrors: 0,
      lastCleanupValidation: Date.now(),
    };

    // PASSAGE DUPLICATION FIX: Track processed passages to prevent duplicates
    this.processedPassages = new Set(); // Set<passageId>
    this.gpsJumpHolds = new Map(); // Map<mmsi, holdUntilTimestamp>

    // FIX U: Passage detection cache to prevent multiple detections per AIS update
    // Cache is valid for 500ms to deduplicate calls within same update cycle
    this._passageDetectionCache = new Map(); // Map<mmsi:bridge, {timestamp, result}>

    // BUG 3 FIX: Track completed journeys to prevent re-entry within cooldown period
    this._completedJourneys = new Map(); // Map<mmsi, { completedAt, direction }>

    // LOG NOISE CONTROL: debounce and repeat counters for common filter logs
    this._logDebounce = new Map(); // Map<key, timestamp>
    this._logRepeatCount = new Map(); // Map<key, count>

    // MEMORY LEAK PREVENTION: Periodic cleanup validation (every 10 minutes)
    if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
      this._cleanupValidationTimer = null;
      this.logger.debug('🧪 [VESSEL_DATA] Test mode detected - skipping cleanup validation timer');
    } else {
      this._cleanupValidationTimer = setInterval(() => {
        this._validateCleanupIntegrity();
      }, 10 * 60 * 1000); // 10 minutes
    }
  }

  /**
   * Update or create a vessel
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} data - AIS data
   * @returns {Object|null} Updated vessel object or null if filtered out
   */
  updateVessel(mmsi, data) {
    // Note: Simplified synchronous locking not needed for JavaScript single-threaded model
    // Race conditions mainly occur with async operations and timers
    const oldVessel = this.vessels.get(mmsi);
    const isNewVessel = !oldVessel;

    // Fix 2: Blockera re-entry för fartyg med nyligen avslutad resa.
    // Förhindrar remove→recreate-cykel som orsakar "Inga båtar"-flash i UI.
    // Utan detta återskapas fartyget av varje ny AIS-uppdatering efter removal,
    // och _onVesselRemoved hinner sätta default-meddelandet mellan cyklerna.
    if (isNewVessel && this._completedJourneys?.has(mmsi)) {
      const completed = this._completedJourneys.get(mmsi);
      const elapsed = Date.now() - completed.completedAt;
      const REENTRY_COOLDOWN_MS = 10 * 60 * 1000;
      if (elapsed < REENTRY_COOLDOWN_MS) {
        this.logger.debug(
          `🚫 [VESSEL_REENTRY_BLOCK] ${mmsi}: Ignoring AIS — journey completed `
          + `${Math.round(elapsed / 1000)}s ago`,
        );
        return null;
      }
    }

    // Create vessel data object
    const vessel = this._createVesselObject(mmsi, data, oldVessel);

    // FIXED: Apply SystemCoordinator coordination results
    const positionData = vessel._positionData; // GPS analysis data is stored during vessel creation
    if (positionData?.coordination) {
      this._applyCoordinationResults(mmsi, vessel, oldVessel, positionData.coordination);
    }

    // BUG D fix (2026-04-27): U-sväng-detektion. När en båt vänder ≥90° mot
    // sin låsta _routeDirection och är långt från sin nuvarande target → nullify
    // target så normal logik räknar om i samma eller nästa update.
    // FRIDA 09:21:20: norrgående vid Stallbackabron men target=Stridsbergsbron
    // (söder-mål) → eligibility-filter blockerade Stallbackabron-trigger.
    // Skydd mot wobble: kräver dist > 500m (inte nära target) och vessel.cog finite.
    // Anomali 5 (2026-05-05): kräv sog ≥ 2.0 knot för att Fix D ska aktivera.
    // AERANDIR 2026-04-28 17:11–17:13: zigzaggade söder→norr→söder vid sog 1.1–1.8kn
    // pga COG-noise från drift. Min Fix D nullade target på falskt U-sväng-signal,
    // bridge text visade "Inga båtar" i 90 sekunder mellan ny target-tilldelning.
    // Vid riktiga U-svängar har båten mätbar fart i nya riktningen — wobble vid
    // låg fart är inte verklig riktningsändring.
    const FIX_D_MIN_SOG = 2.0;
    if (!isNewVessel
        && vessel.targetBridge
        && oldVessel
        && Number.isFinite(vessel.cog)
        && Number.isFinite(vessel.sog)
        && vessel.sog >= FIX_D_MIN_SOG
        && vessel._routeDirection
        && Number.isFinite(vessel.lat)
        && Number.isFinite(vessel.lon)) {
      const cogIsNorth = vessel.cog >= constants.COG_DIRECTIONS.NORTH_MIN
        || vessel.cog <= constants.COG_DIRECTIONS.NORTH_MAX;
      const cogIsSouth = vessel.cog >= 135 && vessel.cog <= 225;
      const lockedNorth = vessel._routeDirection === 'north';
      const reversed = (cogIsNorth && !lockedNorth) || (cogIsSouth && lockedNorth);

      if (reversed) {
        const targetBridgeObj = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
        if (targetBridgeObj
            && Number.isFinite(targetBridgeObj.lat)
            && Number.isFinite(targetBridgeObj.lon)) {
          const distToTarget = geometry.calculateDistance(
            vessel.lat, vessel.lon,
            targetBridgeObj.lat, targetBridgeObj.lon,
          );
          // Fix D refinement (2026-04-28): tre orthogonala recalc-trigger så
          // U-svängar mellan närliggande broar (Stridsbergsbron ↔ Järnvägsbron
          // är bara ~210m isär) också fångas, inte bara FRIDA-typen där dist
          // till target är stor.
          //   1. distToTarget > 500m → klassisk FRIDA-fall (vänder vid Vänern)
          //   2. target redan i passedBridges → båten har gått förbi den i gamla
          //      riktningen (säkerhetsnät)
          //   3. targetIsBehindVessel → cogen pekar bort från target. Räddar
          //      Stridsbergsbron-Järnvägsbron-fallet där en båt vänder söderut
          //      strax efter Stridsbergsbron-passage med dist till target=200m.
          const newDirIsNorth = cogIsNorth;
          const targetIsActuallyNorthOfVessel = targetBridgeObj.lat > vessel.lat;
          const targetIsBehindVessel = newDirIsNorth !== targetIsActuallyNorthOfVessel;
          const alreadyPassedTarget = Array.isArray(vessel.passedBridges)
            && vessel.passedBridges.includes(vessel.targetBridge);

          const shouldRecalc = (Number.isFinite(distToTarget) && distToTarget > 500)
            || alreadyPassedTarget
            || targetIsBehindVessel;

          if (shouldRecalc) {
            const newDir = cogIsNorth ? 'north' : 'south';
            let reason;
            if (Number.isFinite(distToTarget) && distToTarget > 500) {
              reason = `dist=${Math.round(distToTarget)}m > 500`;
            } else if (alreadyPassedTarget) {
              reason = 'target already in passedBridges';
            } else {
              reason = 'target behind vessel';
            }
            this.logger.log(
              `🔄 [TARGET_RECALC] ${vessel.mmsi}: Direction reversed `
              + `(${vessel._routeDirection} → ${newDir}, ${reason}), `
              + `clearing target ${vessel.targetBridge} — recalculation will run via normal flow`,
            );
            vessel.targetBridge = null;
            this._lockRouteDirection(vessel, newDir);
          }
        }
      }
    }

    // Handle target bridge assignment and transitions
    if (isNewVessel && !vessel.targetBridge) {
      this.logger.debug(`🔍 [TARGET_CHECK] ${mmsi}: Checking if new vessel should get target bridge (${vessel.sog}kn, ${vessel.cog}°)`);
      if (this._shouldAssignTargetBridge(vessel, oldVessel)) {
        // New vessel: Calculate initial target bridge only if vessel appears to be moving
        vessel.targetBridge = this._calculateTargetBridge(vessel);
        if (vessel.targetBridge) {
          this.logger.debug(
            `🎯 [TARGET_BRIDGE_NEW] Assigned ${vessel.targetBridge} to new vessel ${mmsi} (${vessel.sog}kn)`,
          );
          const direction = (Number.isFinite(vessel.cog)
            && (vessel.cog >= constants.COG_DIRECTIONS.NORTH_MIN
              || vessel.cog <= constants.COG_DIRECTIONS.NORTH_MAX)) ? 'north' : 'south';
          this._lockRouteDirection(vessel, direction);
        }
      } else {
        this.logger.debug(`🚫 [TARGET_REJECTED] ${mmsi}: New vessel rejected for target bridge`);
      }
    } else if (!isNewVessel && vessel.targetBridge) {
      // ENHANCED: Check for passage and pending transitions, then apply protection if needed
      const hasPassedCurrentTarget = this._hasPassedTargetBridge(vessel, oldVessel);
      const hasPendingTransition = Boolean(
        vessel._pendingTarget && vessel._pendingTarget.source === vessel.targetBridge,
      );
      let transitionHandled = false;

      if (hasPassedCurrentTarget || hasPendingTransition) {
        if (hasPassedCurrentTarget) {
          this.logger.log(
            `🎯 [PASSAGE_OVERRIDE] ${vessel.mmsi}: Passage detected - allowing transition despite protection`,
          );
        } else {
          this.logger.debug(
            `⏳ [PENDING_TRANSITION] ${vessel.mmsi}: Resolving pending target transition for ${vessel.targetBridge}`,
          );
        }
        this._handleTargetBridgeTransition(vessel, oldVessel);
        transitionHandled = true;
      }

      const protectionActive = this._checkTargetBridgeProtection(vessel, oldVessel);

      if (!protectionActive) {
        if (!transitionHandled) {
          this._handleTargetBridgeTransition(vessel, oldVessel);
          transitionHandled = true;
        }

        // CRITICAL: Check if vessel has become anchored/stationary after having target bridge
        // BUT: Respect protection zone - vessels within 300m of any bridge should keep their target
        const protectionZoneCheck = this._isInProtectionZone(vessel);

        const targetAssignmentResult = this._shouldAssignTargetBridge(vessel, oldVessel);
        if (!targetAssignmentResult && !protectionZoneCheck.isProtected) {
          // Apply grace period to prevent quick target removals
          const graceKey = `${vessel.mmsi}:${vessel.targetBridge}`;
          const now = Date.now();
          const TARGET_REMOVAL_GRACE_PERIOD = 60000; // 60 seconds grace period

          if (!this._targetRemovalGrace) {
            this._targetRemovalGrace = new Map();
          }

          if (!this._targetRemovalGrace.has(graceKey)) {
            // First time failing validation - start grace period
            this._targetRemovalGrace.set(graceKey, now);
            this.logger.debug(
              `⏳ [TARGET_GRACE] ${vessel.mmsi}: Starting 60s grace period for target "${vessel.targetBridge}" `
              + `| Speed: ${vessel.sog}kn | Position: ${vessel.lat.toFixed(6)},${vessel.lon.toFixed(6)}`,
            );
          } else {
            const graceStartTime = this._targetRemovalGrace.get(graceKey);
            const graceElapsed = now - graceStartTime;

            if (graceElapsed > TARGET_REMOVAL_GRACE_PERIOD) {
              // Grace period expired - remove target with specific reason
              const reason = this._getTargetRemovalReason(vessel, oldVessel);
              this.logger.log(
                `🔄 [TARGET_CHANGE] ${vessel.mmsi}: "${vessel.targetBridge}" → "none" `
                + `| Reason: ${reason} | Position: ${vessel.lat.toFixed(6)},${vessel.lon.toFixed(6)} `
                + `| Speed: ${vessel.sog}kn | Grace period: ${(graceElapsed / 1000).toFixed(0)}s`,
              );
              vessel.targetBridge = null;
              this._targetRemovalGrace.delete(graceKey);
            } else {
              // Still in grace period
              const remaining = Math.ceil((TARGET_REMOVAL_GRACE_PERIOD - graceElapsed) / 1000);
              this.logger.debug(
                `⏳ [TARGET_GRACE] ${vessel.mmsi}: Grace period active for "${vessel.targetBridge}" (${remaining}s remaining)`,
              );
            }
          }
        } else if (!this._shouldAssignTargetBridge(vessel, oldVessel) && protectionZoneCheck.isProtected) {
          // Keep target bridge despite low speed - vessel is in protection zone
          this.logger.debug(
            `🛡️ [PROTECTION_ZONE_SAVE] ${vessel.mmsi}: Keeping target bridge "${vessel.targetBridge}" despite low speed `
            + `(${vessel.sog}kn) - vessel within protection zone of ${protectionZoneCheck.bridge} (${protectionZoneCheck.distance}m)`,
          );
        }
      } else {
        // Always check intermediate passages — even when target transition was handled.
        // Target and intermediate passages are independent (dedup guards in the method prevent duplicates).
        this._handleIntermediateBridgePassage(vessel, oldVessel);
        this.logger.debug(
          `🛡️ [TARGET_PROTECTION_ACTIVE] ${vessel.mmsi}: Target bridge protection preventing transitions`,
        );
      }
    } else if (!isNewVessel && !vessel.targetBridge && this._shouldAssignTargetBridge(vessel, oldVessel)) {
      // Handle existing vessel without target bridge that now qualifies (e.g., accelerated from anchor)
      const newTargetBridge = this._calculateTargetBridge(vessel);
      if (newTargetBridge) {
        const bridge = this.bridgeRegistry.getBridgeByName(newTargetBridge);
        if (!bridge || !Number.isFinite(bridge.lat) || !Number.isFinite(bridge.lon)) {
          this.logger.error(`[ERROR] Bridge ${newTargetBridge} not found or has invalid coordinates`);
          return vessel;
        }
        const newTargetDistance = geometry.calculateDistance(
          vessel.lat, vessel.lon,
          bridge.lat,
          bridge.lon,
        );

        this.logger.log(
          `🔄 [TARGET_CHANGE] ${mmsi}: "none" → "${newTargetBridge}" `
          + `| Reason: ACCELERATED | Position: ${vessel.lat.toFixed(6)},${vessel.lon.toFixed(6)} `
          + `| Distance to target: ${newTargetDistance.toFixed(0)}m | Speed: ${vessel.sog}kn`,
        );
        vessel.targetBridge = newTargetBridge;
        const direction = (Number.isFinite(vessel.cog)
          && (vessel.cog >= constants.COG_DIRECTIONS.NORTH_MIN
            || vessel.cog <= constants.COG_DIRECTIONS.NORTH_MAX)) ? 'north' : 'south';
        this._lockRouteDirection(vessel, direction);
      }
    }

    // Anomali 11 (2026-05-12): Post-TARGET_END intermediate-passage detection.
    // När vessel har passerat sista målbron (_finalTargetBridge satt, targetBridge=null),
    // fortsätter den genom kvarvarande intermediate-broar (Stallbackabron norrut,
    // Olidebron söderut). Innan denna fix anropades _handleIntermediateBridgePassage
    // bara via target-grenarna ovan, så passage av kvarvarande broar med AIS-gap missades.
    // Verifierat 2026-05-08: 244750397 + 265552060 missade Stallbackabron-notis.
    // Dedup via vessel.passedBridges skyddar mot dubblett-detektering.
    if (!isNewVessel
        && !vessel.targetBridge
        && vessel._finalTargetBridge
        && oldVessel) {
      this._handleIntermediateBridgePassage(vessel, oldVessel);
    }

    // Store vessel
    this.vessels.set(mmsi, vessel);

    // ENHANCED: Log passage tracking status for audit purposes
    if (!isNewVessel && (vessel.lastPassedBridge || (vessel.passedBridges && vessel.passedBridges.length > 0))) {
      this._logPassageTrackingStatus(vessel);
    }

    // Emit events
    if (isNewVessel) {
      this._memoryLeakStats.totalVesselsCreated++;
      this.emit('vessel:entered', { mmsi, vessel });
      this.logger.debug(`🆕 [VESSEL_DATA] New vessel entered: ${mmsi}`);
    } else {
      this.emit('vessel:updated', { mmsi, vessel, oldVessel });
      this.logger.debug(`📝 [VESSEL_DATA] Vessel updated: ${mmsi}`);
    }

    return vessel;
  }

  /**
   * Remove a vessel
   * @param {string} mmsi - Vessel MMSI
   * @param {string} reason - Reason for removal
   */
  removeVessel(mmsi, reason = 'timeout') {
    // RACE CONDITION FIX: Check if vessel is already being removed
    if (this._removalInProgress && this._removalInProgress.has(mmsi)) {
      this.logger.debug(`🔒 [RACE_PROTECTION] Vessel ${mmsi} already being removed - skipping concurrent removal`);
      return;
    }

    const vessel = this.vessels.get(mmsi);
    if (!vessel) {
      // MEMORY LEAK FIX: Even if vessel doesn't exist, clean up any external state
      this._performEmergencyCleanup(mmsi);
      return;
    }

    // RACE CONDITION FIX: Mark vessel as being removed to prevent concurrent operations
    if (!this._removalInProgress) {
      this._removalInProgress = new Set();
    }
    this._removalInProgress.add(mmsi);

    // MEMORY LEAK FIX: SystemCoordinator cleanup moved to _cleanupVesselState for comprehensive cleanup
    // (No longer called here to avoid double cleanup)

    // 300m Protection Zone: Check if vessel is within protection zone of any bridge
    if (reason === 'timeout') {
      const { PROTECTION_ZONE_RADIUS } = constants;

      // PHASE 2 FIX: Check for stale AIS data using lastPositionUpdate tracking
      // Fix 1: Fallback 0 (epoch) istället för Date.now() — om varken lastPositionUpdate
      // eller timestamp finns är vessel-data korrupt och ska behandlas som stale.
      // Med Date.now() triggar stale-checken aldrig → oändlig protection zone-loop.
      const lastAISUpdate = vessel.lastPositionUpdate || vessel.timestamp || 0;
      const STALE_AIS_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes fixed timeout for stale AIS

      const timeSinceLastAIS = Date.now() - lastAISUpdate;

      if (timeSinceLastAIS >= STALE_AIS_TIMEOUT_MS) {
        this.logger.log(
          `🗑️ [STALE_AIS] Force removing vessel ${mmsi} - no position update for ${(timeSinceLastAIS / 60000).toFixed(0)} minutes (AIS likely stopped)`,
        );
        // Continue with removal despite protection zone - dead AIS data
      } else {
        // Bug F3 fix: skip protection zone for vessels that completed their journey
        const journeyCompleted = !vessel.targetBridge && vessel.passedBridges?.length > 0;
        if (journeyCompleted) {
          this.logger.log(`🏁 [COMPLETED_BYPASS] Vessel ${mmsi} completed journey - skipping protection zone`);
          // Fall through to removal
        } else {
          // Only apply protection zone if vessel data is not stale
          for (const bridge of Object.values(this.bridgeRegistry.bridges)) {
            const distance = geometry.calculateDistance(
              vessel.lat,
              vessel.lon,
              bridge.lat,
              bridge.lon,
            );

            // Bug F1 fix: null-guard — calculateDistance can return null for invalid coords
            if (distance !== null && distance <= PROTECTION_ZONE_RADIUS) {
              this.logger.log(
                `⚠️ [PROTECTION_ZONE] Preventing removal of vessel ${mmsi} - within ${distance.toFixed(
                  0,
                )}m of ${bridge.name} (reason: ${reason})`,
              );
              // Bug #1 fix: release removal lock BEFORE scheduleCleanup so the
              // RACE_PROTECTION guard in scheduleCleanup does not silently drop
              // the reschedule. This early-return path never reaches the
              // try/finally block below that normally clears the lock.
              if (this._removalInProgress) {
                this._removalInProgress.delete(mmsi);
              }
              // Review fix C1: also clear _eliminationPending here. Without this,
              // a vessel whose targetBridge was re-assigned by a new AIS message
              // between JOURNEY_COMPLETED and the 100ms timer firing would stay
              // trapped in _eliminationPending forever, causing all future
              // scheduleCleanup calls to short-circuit — the vessel would never
              // be removed. This re-introduces the ghost-vessel bug via a
              // different path.
              if (this._eliminationPending) {
                this._eliminationPending.delete(mmsi);
              }
              // Reschedule with longer timeout instead of removing
              this.scheduleCleanup(mmsi, UI_CONSTANTS.CLEANUP_EXTENSION_MS); // 10 minutes
              return;
            }
          }
        }
      }
    }

    // BUG 3 FIX: Record completed journey before cleanup nullifies vessel data
    // Bug E fix: also record completion for timeout-removed vessels that finished their journey
    const isJourneyComplete = reason === 'passed-final-bridge' || reason === 'journey-completed';
    const isCompletedTimeout = reason === 'timeout'
      && !vessel.targetBridge
      && vessel.passedBridges?.length > 0;
    if (isJourneyComplete || isCompletedTimeout) {
      const direction = vessel._routeDirection || vessel._finalTargetDirection || null;
      this._completedJourneys.set(mmsi, { completedAt: Date.now(), direction });
      this.logger.debug(`🏁 [COMPLETED_JOURNEY] ${mmsi}: Recorded completed journey (direction: ${direction}, reason: ${reason})`);
    }

    // Anomali 10/11-bugfix (2026-05-18): bevara snapshot FÖRE _cleanupVesselState
    // nollar fälten. Tidigare emit:ades minimal stub { mmsi, reason } vilket gjorde
    // att Anomali 10 (_triggerExitPointFallback) aldrig kunde köra eftersom vessel.lat,
    // vessel._finalTargetDirection m.fl. var undefined. Snapshot kopierar bara primitives
    // + arrays — inga referenser till data som rensas i _cleanupVesselState.
    const vesselSnapshot = {
      mmsi,
      reason,
      lat: vessel.lat,
      lon: vessel.lon,
      sog: vessel.sog,
      cog: vessel.cog,
      targetBridge: vessel.targetBridge,
      currentBridge: vessel.currentBridge,
      shipName: vessel.shipName,
      _routeDirection: vessel._routeDirection,
      _finalTargetBridge: vessel._finalTargetBridge,
      _finalTargetDirection: vessel._finalTargetDirection,
      lastPassedBridge: vessel.lastPassedBridge,
      lastPassedBridgeTime: vessel.lastPassedBridgeTime,
      passedBridges: Array.isArray(vessel.passedBridges) ? [...vessel.passedBridges] : [],
    };

    try {
      // MEMORY LEAK FIX: Comprehensive vessel state cleanup (includes timer cleanup)
      this._cleanupVesselState(vessel);

      // RACE CONDITION FIX: Remove from collections atomically
      this.vessels.delete(mmsi);
      this._removeFromBridgeAssociations(mmsi);

      // MEMORY LEAK FIX: Additional emergency cleanup to ensure nothing is missed
      this._performEmergencyCleanup(mmsi);

      // MEMORY LEAK STATS: Track vessel removal
      this._memoryLeakStats.totalVesselsRemoved++;

      // RACE CONDITION FIX: Emit event AFTER all cleanup is complete.
      // Skicka snapshot (inte cleanup:ad vessel) så listeners ser pre-cleanup state.
      this.emit('vessel:removed', { mmsi, vessel: vesselSnapshot, reason });
      this.logger.debug(`🗑️ [VESSEL_DATA] Vessel removed with comprehensive cleanup: ${mmsi} (${reason})`);
    } catch (cleanupError) {
      this.logger.error(`[REMOVAL_ERROR] Error during vessel removal for ${mmsi}:`, cleanupError.message);
      // Even if cleanup fails, try emergency cleanup
      try {
        this._performEmergencyCleanup(mmsi);
        this.vessels.delete(mmsi);
        this._removeFromBridgeAssociations(mmsi);
      } catch (emergencyError) {
        this.logger.error(`[EMERGENCY_CLEANUP_ERROR] Emergency cleanup failed for ${mmsi}:`, emergencyError.message);
      }
    } finally {
      // RACE CONDITION FIX: Always clear removal lock, even if removal fails
      if (this._removalInProgress) {
        this._removalInProgress.delete(mmsi);
      }
      // Bug #13 fix: clear elimination flag so the mmsi doesn't remain in
      // _eliminationPending indefinitely after removal completes.
      if (this._eliminationPending) {
        this._eliminationPending.delete(mmsi);
      }
    }
  }

  /**
   * Clean up vessel state properties to prevent memory leaks
   * COMPREHENSIVE MEMORY LEAK FIX: Clean ALL vessel properties and external service state
   * @private
   * @param {Object} vessel - Vessel object to clean
   */
  _cleanupVesselState(vessel) {
    if (!vessel) return;

    const { mmsi } = vessel;
    this.logger.debug(`🧹 [COMPREHENSIVE_CLEANUP] Starting complete cleanup for vessel ${mmsi}`);

    // MEMORY LEAK FIX: Clear all external service state first
    try {
      // Clean up SystemCoordinator state
      if (this.systemCoordinator && typeof this.systemCoordinator.removeVessel === 'function') {
        this.systemCoordinator.removeVessel(mmsi);
      }

      // Clean up StatusStabilizer state (if available through systemCoordinator or other services)
      if (this.systemCoordinator && this.systemCoordinator.statusStabilizer
          && typeof this.systemCoordinator.statusStabilizer.removeVessel === 'function') {
        this.systemCoordinator.statusStabilizer.removeVessel(mmsi);
      }

      // Clean up PassageWindowManager state
      if (this.passageWindowManager && typeof this.passageWindowManager.removeVessel === 'function') {
        this.passageWindowManager.removeVessel(mmsi);
      }
    } catch (error) {
      this.logger.error(`[CLEANUP_ERROR] Error cleaning external service state for ${mmsi}:`, error.message);
    }

    // MEMORY LEAK FIX: Clear ALL timer references for this vessel
    try {
      // Clear cleanup timer
      this._clearCleanupTimer(mmsi);

      // Clear protection timer
      this._clearProtectionTimer(mmsi);

      // Remove from protection state
      this.targetBridgeProtection.delete(mmsi);

      // Remove from operation locks
      if (this.operationLocks && this.operationLocks.has(mmsi)) {
        this.operationLocks.delete(mmsi);
      }

      // Clean up target removal grace entries
      if (this._targetRemovalGrace && this._targetRemovalGrace.size > 0) {
        for (const key of this._targetRemovalGrace.keys()) {
          if (key.startsWith(`${mmsi}:`)) {
            this._targetRemovalGrace.delete(key);
          }
        }
      }
    } catch (error) {
      this.logger.error(`[CLEANUP_ERROR] Error clearing timers for ${mmsi}:`, error.message);
    }

    // MEMORY LEAK FIX: Clean up ALL vessel object properties to break circular references
    try {
      // Core vessel data (set to null to break references)
      vessel.mmsi = null;
      vessel.lat = null;
      vessel.lon = null;
      vessel.sog = null;
      vessel.cog = null;
      vessel.dirString = null;
      vessel.timestamp = null;
      vessel.name = null;

      // Position tracking properties
      vessel.lastPosition = null;
      vessel.lastPositionChange = null;

      // Status and bridge information
      vessel.status = null;
      vessel.targetBridge = null;
      vessel.nearBridge = null;
      vessel.currentBridge = null;
      vessel.distanceToCurrent = null;

      // Movement and tracking properties
      vessel.lastActiveTime = null;

      // Speed tracking properties (arrays and complex objects)
      if (vessel.speedHistory && Array.isArray(vessel.speedHistory)) {
        vessel.speedHistory.length = 0; // Clear array contents
      }
      vessel.speedHistory = null;
      vessel.maxRecentSpeed = null;

      // Status flags
      vessel.isApproaching = null;
      vessel.isWaiting = null;

      // Bridge passage tracking
      if (vessel.passedBridges && Array.isArray(vessel.passedBridges)) {
        vessel.passedBridges.length = 0; // Clear array contents
      }
      vessel.passedBridges = null;
      vessel.lastPassedBridgeTime = null;
      vessel.lastPassedBridge = null;

      // Timing and detection properties
      vessel.etaMinutes = null;
      vessel.waitSince = null;
      vessel.speedBelowThresholdSince = null;

      // Diagnostic information
      vessel.graceMisses = null;
      vessel._distanceToNearest = null;
      vessel._lastSeen = null;

      // Additional tracking properties
      vessel.towards = null;
      vessel.gracePeriod = null;
      vessel._targetAssignmentAttempts = null;
      vessel._wasCloseToTarget = null;
      vessel.confidence = null;

      // GPS jump analysis data - FIXED: Comprehensive cleanup
      if (vessel._positionAnalysis && typeof vessel._positionAnalysis === 'object') {
        // Clear nested object properties
        Object.keys(vessel._positionAnalysis).forEach((key) => {
          vessel._positionAnalysis[key] = null;
        });
      }
      vessel._positionAnalysis = null;
      vessel._gpsJumpDetected = null;
      vessel._positionUncertain = null;
      vessel._positionData = null; // Clear stored position data including coordination
      vessel._coordinationActive = null;
      vessel._coordinationReason = null;
      vessel._stabilizationLevel = null;

      // Hysteresis state (StatusService properties)
      delete vessel._underBridgeLatched;
      delete vessel._lastTargetBridgeForHysteresis;
      delete vessel._lastCurrentBridgeForHysteresis;

      // Passage anchoring cleanup
      delete vessel.passedAt;

      // MEMORY LEAK FIX: Clear any remaining properties that might have been added dynamically
      const remainingProps = Object.keys(vessel).filter((key) => vessel[key] !== null && vessel[key] !== undefined);
      if (remainingProps.length > 0) {
        this.logger.debug(`🧹 [DYNAMIC_CLEANUP] Clearing ${remainingProps.length} remaining properties: ${remainingProps.join(', ')}`);
        remainingProps.forEach((prop) => {
          try {
            if (typeof vessel[prop] === 'object' && vessel[prop] !== null) {
              // For complex objects, try to clear their contents
              if (Array.isArray(vessel[prop])) {
                vessel[prop].length = 0;
              } else if (typeof vessel[prop] === 'object') {
                Object.keys(vessel[prop]).forEach((subKey) => {
                  vessel[prop][subKey] = null;
                });
              }
            }
            vessel[prop] = null;
          } catch (cleanupError) {
            this.logger.debug(`[CLEANUP_WARNING] Could not clean property ${prop}:`, cleanupError.message);
            // Continue with other properties even if one fails
          }
        });
      }

    } catch (error) {
      this.logger.error(`[CLEANUP_ERROR] Error clearing vessel properties for ${mmsi}:`, error.message);
    }

    this.logger.debug(`🧹 [COMPREHENSIVE_CLEANUP] Completed comprehensive cleanup for vessel ${mmsi}`);
  }

  /**
   * Emergency cleanup for cases where vessel object might not exist but external state remains
   * MEMORY LEAK PREVENTION: Ensures no external service state is left behind
   * @private
   * @param {string} mmsi - Vessel MMSI
   */
  _performEmergencyCleanup(mmsi) {
    if (!mmsi) return;

    this.logger.debug(`🚨 [EMERGENCY_CLEANUP] Performing emergency cleanup for ${mmsi}`);

    try {
      // Clear all timer references for this MMSI (even if vessel object is gone)
      this._clearCleanupTimer(mmsi);
      this._clearProtectionTimer(mmsi);

      // Remove from all tracking maps
      this.targetBridgeProtection.delete(mmsi);

      if (this.operationLocks && this.operationLocks.has(mmsi)) {
        this.operationLocks.delete(mmsi);
      }

      // Clean up external service state
      if (this.systemCoordinator && typeof this.systemCoordinator.removeVessel === 'function') {
        this.systemCoordinator.removeVessel(mmsi);
      }

      if (this.passageWindowManager && typeof this.passageWindowManager.removeVessel === 'function') {
        this.passageWindowManager.removeVessel(mmsi);
      }

      // Remove from bridge associations
      this._removeFromBridgeAssociations(mmsi);

    } catch (error) {
      this.logger.error(`[EMERGENCY_CLEANUP_ERROR] Failed to perform emergency cleanup for ${mmsi}:`, error.message);
    }
  }

  /**
   * Validate cleanup integrity and detect potential memory leaks
   * MEMORY LEAK PREVENTION: Monitors for inconsistencies between different data structures
   * @private
   */
  _validateCleanupIntegrity() {
    const now = Date.now();
    this._memoryLeakStats.lastCleanupValidation = now;

    try {
      const vesselCount = this.vessels.size;
      const cleanupTimerCount = this.cleanupTimers.size;
      const protectionCount = this.targetBridgeProtection.size;
      const protectionTimerCount = this.protectionTimers.size;
      const operationLockCount = this.operationLocks ? this.operationLocks.size : 0;

      // Calculate bridge associations
      let totalBridgeAssociations = 0;
      for (const vesselSet of this.bridgeVessels.values()) {
        totalBridgeAssociations += vesselSet.size;
      }

      this.logger.debug(
        `🔍 [CLEANUP_VALIDATION] Vessels: ${vesselCount}, CleanupTimers: ${cleanupTimerCount}, `
        + `Protection: ${protectionCount}, ProtectionTimers: ${protectionTimerCount}, `
        + `OperationLocks: ${operationLockCount}, BridgeAssociations: ${totalBridgeAssociations}`,
      );

      // Detect potential memory leaks
      const issues = [];

      // Check for orphaned timers (timers without corresponding vessels)
      for (const mmsi of this.cleanupTimers.keys()) {
        if (!this.vessels.has(mmsi)) {
          issues.push(`Orphaned cleanup timer for ${mmsi}`);
        }
      }

      for (const mmsi of this.protectionTimers.keys()) {
        if (!this.vessels.has(mmsi)) {
          issues.push(`Orphaned protection timer for ${mmsi}`);
        }
      }

      // Check for orphaned protection state
      for (const mmsi of this.targetBridgeProtection.keys()) {
        if (!this.vessels.has(mmsi)) {
          issues.push(`Orphaned protection state for ${mmsi}`);
        }
      }

      // Check for excessive data structure sizes (potential memory leak indicators)
      const MAX_REASONABLE_SIZE = 1000; // Adjust based on expected usage
      if (cleanupTimerCount > MAX_REASONABLE_SIZE) {
        issues.push(`Excessive cleanup timers: ${cleanupTimerCount}`);
      }
      if (protectionCount > MAX_REASONABLE_SIZE) {
        issues.push(`Excessive protection states: ${protectionCount}`);
      }

      // Report issues and attempt auto-cleanup
      if (issues.length > 0) {
        this.logger.error(`🚨 [MEMORY_LEAK_DETECTED] Found ${issues.length} potential memory leaks:`);
        issues.forEach((issue) => this.logger.error(`  - ${issue}`));

        // Attempt automatic cleanup of orphaned resources
        this._performOrphanedResourceCleanup();
        this._memoryLeakStats.cleanupErrors += issues.length;
      } else {
        this.logger.debug('✅ [CLEANUP_VALIDATION] No memory leaks detected - all systems clean');
      }

      // BUG 3 FIX: Clean up expired completed journey records (>15 min)
      if (this._completedJourneys && this._completedJourneys.size > 0) {
        const COMPLETED_JOURNEY_TTL_MS = 15 * 60 * 1000;
        let cleanedJourneys = 0;
        for (const [mmsi, record] of this._completedJourneys.entries()) {
          if (now - record.completedAt > COMPLETED_JOURNEY_TTL_MS) {
            this._completedJourneys.delete(mmsi);
            cleanedJourneys++;
          }
        }
        if (cleanedJourneys > 0) {
          this.logger.debug(`🧹 [COMPLETED_JOURNEY_CLEANUP] Cleaned ${cleanedJourneys} expired journey records`);
        }
      }

      // Log statistics
      const netVessels = this._memoryLeakStats.totalVesselsCreated - this._memoryLeakStats.totalVesselsRemoved;
      this.logger.debug(
        `📊 [MEMORY_STATS] Created: ${this._memoryLeakStats.totalVesselsCreated}, `
        + `Removed: ${this._memoryLeakStats.totalVesselsRemoved}, Net: ${netVessels}, `
        + `Errors: ${this._memoryLeakStats.cleanupErrors}`,
      );

    } catch (validationError) {
      this.logger.error('[VALIDATION_ERROR] Failed to validate cleanup integrity:', validationError.message);
    }
  }

  /**
   * Clean up orphaned resources that were detected during validation
   * MEMORY LEAK PREVENTION: Removes resources that don't have corresponding vessel objects
   * @private
   */
  _performOrphanedResourceCleanup() {
    let cleaned = 0;

    try {
      // Clean orphaned cleanup timers
      for (const [mmsi, timer] of this.cleanupTimers.entries()) {
        if (!this.vessels.has(mmsi)) {
          clearTimeout(timer);
          this.cleanupTimers.delete(mmsi);
          cleaned++;
          this.logger.debug(`🧹 [ORPHAN_CLEANUP] Removed orphaned cleanup timer for ${mmsi}`);
        }
      }

      // Clean orphaned protection timers
      for (const [mmsi, timer] of this.protectionTimers.entries()) {
        if (!this.vessels.has(mmsi)) {
          clearTimeout(timer);
          this.protectionTimers.delete(mmsi);
          cleaned++;
          this.logger.debug(`🧹 [ORPHAN_CLEANUP] Removed orphaned protection timer for ${mmsi}`);
        }
      }

      // Clean orphaned protection state
      for (const mmsi of this.targetBridgeProtection.keys()) {
        if (!this.vessels.has(mmsi)) {
          this.targetBridgeProtection.delete(mmsi);
          cleaned++;
          this.logger.debug(`🧹 [ORPHAN_CLEANUP] Removed orphaned protection state for ${mmsi}`);
        }
      }

      // Clean orphaned operation locks
      if (this.operationLocks) {
        for (const mmsi of this.operationLocks.keys()) {
          if (!this.vessels.has(mmsi)) {
            this.operationLocks.delete(mmsi);
            cleaned++;
            this.logger.debug(`🧹 [ORPHAN_CLEANUP] Removed orphaned operation lock for ${mmsi}`);
          }
        }
      }

      if (cleaned > 0) {
        this.logger.log(`🧹 [ORPHAN_CLEANUP] Cleaned up ${cleaned} orphaned resources`);
      }

    } catch (cleanupError) {
      this.logger.error('[ORPHAN_CLEANUP_ERROR] Failed to clean orphaned resources:', cleanupError.message);
    }
  }

  /**
   * Get vessel by MMSI
   * @param {string} mmsi - Vessel MMSI
   * @returns {Object|null} Vessel object or null
   */
  getVessel(mmsi) {
    return this.vessels.get(mmsi) || null;
  }

  /**
   * Get all vessels
   * @returns {Object[]} Array of all vessel objects
   */
  getAllVessels() {
    // SAFETY: Handle null/undefined vessels Map
    if (!this.vessels || typeof this.vessels.values !== 'function') {
      this.logger.error('[VESSEL_DATA] vessels Map is null/invalid, returning empty array');
      return [];
    }
    return Array.from(this.vessels.values());
  }

  /**
   * Get vessels by target bridge
   * @param {string} bridgeName - Target bridge name
   * @returns {Object[]} Array of vessels targeting this bridge
   */
  getVesselsByTargetBridge(bridgeName) {
    return Array.from(this.vessels.values()).filter(
      (vessel) => vessel.targetBridge === bridgeName,
    );
  }

  /**
   * Get vessels near a bridge
   * @param {string} bridgeId - Bridge ID
   * @returns {Object[]} Array of vessels near this bridge
   */
  getVesselsNearBridge(bridgeId) {
    const vesselSet = this.bridgeVessels.get(bridgeId);
    if (!vesselSet) {
      return [];
    }
    return Array.from(vesselSet)
      .map((mmsi) => this.vessels.get(mmsi))
      .filter(Boolean);
  }

  /**
   * Get vessels suitable for bridge text generation
   * @returns {Object[]} Array of relevant vessels
   */
  getVesselsForBridgeText() {
    // SAFETY: Handle null/undefined vessels Map
    if (!this.vessels || typeof this.vessels.values !== 'function') {
      this.logger.error('[VESSEL_DATA] vessels Map is null/invalid in getVesselsForBridgeText, returning empty array');
      return [];
    }
    const allVessels = Array.from(this.vessels.values());
    const filteredVessels = allVessels.filter((vessel) => {
      // Check if vessel has valid target bridge (primary filtering)
      const hasTargetBridge = vessel.targetBridge
        && this.bridgeRegistry.isValidTargetBridge(vessel.targetBridge);

      // CRITICAL BUG FIX: Check if vessel is near Stallbackabron regardless of targetBridge
      const isNearStallbackabron = this._isVesselNearStallbackabron(vessel);

      // Include vessel if either:
      // 1. Has valid target bridge (Klaffbron/Stridsbergsbron)
      // 2. Is near Stallbackabron with relevant status (special case)
      // BUG 11 FIX: Behåll fartyg i "precis passerat"-fönstret även utan targetBridge.
      // Efter terminal-passage (Klaffbron) sätts targetBridge till null, men fartyget
      // ska fortfarande visas med "precis passerat"-text i 180 sekunder.
      const inRecentPassageWindow = vessel.lastPassedBridgeTime
        && (Date.now() - vessel.lastPassedBridgeTime) < 180000; // JUST_PASSED_WINDOW

      if (!hasTargetBridge && !isNearStallbackabron && !inRecentPassageWindow) {
        // Reduce repeated noise for the same MMSI
        const nameOrBlank = vessel.name ? `/${vessel.name}` : '';
        const key = `noTarget:${vessel.mmsi}`;
        const now = Date.now();
        const last = this._logDebounce.get(key) || 0;
        if (now - last > 180000) { // 3 minutes window
          const repeats = this._logRepeatCount.get(key) || 0;
          this.logger.debug(
            `❌ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}${nameOrBlank}: No valid targetBridge and not near Stallbackabron - excluding from bridge text `
            + `(repeats suppressed: ${repeats}) (targetBridge=${vessel.targetBridge}, currentBridge=${vessel.currentBridge}, status=${vessel.status})`,
          );
          this._logDebounce.set(key, now);
          this._logRepeatCount.set(key, 0);
        } else {
          this._logRepeatCount.set(key, (this._logRepeatCount.get(key) || 0) + 1);
        }
        return false;
      }

      // Filter out likely anchored boats using same strict logic as target bridge assignment
      if (!this._isVesselSuitableForBridgeText(vessel)) {
        this.logger.debug(`❌ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Not suitable for bridge text (anchored/slow)`);
        return false;
      }

      // Must have status that matters for bridge text (FIXED: Added stallbacka-waiting)
      const relevantStatuses = [
        'approaching',
        'waiting',
        'under-bridge',
        'passed',
        'en-route',
        'stallbacka-waiting', // CRITICAL ADD: Missing status for Stallbackabron
      ];

      const isRelevant = relevantStatuses.includes(vessel.status);
      if (!isRelevant) {
        this.logger.debug(`❌ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Irrelevant status: ${vessel.status}`);
        return false;
      }

      // Log what made this vessel eligible
      let reason;
      if (hasTargetBridge) {
        reason = `target=${vessel.targetBridge}`;
      } else if (isNearStallbackabron) {
        reason = 'near Stallbackabron';
      } else {
        reason = 'unknown'; // Should not happen due to filtering above
      }

      this.logger.debug(`✅ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}${vessel.name ? `/${vessel.name}` : ''}: Included in bridge text (${vessel.status}, ${reason})`);
      return true;
    });

    this.logger.debug(`📊 [BRIDGE_TEXT_FILTER] Filtered ${filteredVessels.length}/${allVessels.length} vessels for bridge text`);
    return filteredVessels;
  }

  /**
   * Schedule cleanup for vessel
   * @param {string} mmsi - Vessel MMSI
   * @param {number} timeout - Timeout in milliseconds
   */
  scheduleCleanup(mmsi, timeout) {
    // RACE CONDITION FIX: Check if vessel is being removed
    if (this._removalInProgress && this._removalInProgress.has(mmsi)) {
      this.logger.debug(`🔒 [RACE_PROTECTION] Vessel ${mmsi} being removed - skipping cleanup schedule`);
      return;
    }

    // FIX 2: JOURNEY COMPLETION LOGIC - Check if vessel should be eliminated immediately
    const vessel = this.vessels.get(mmsi);
    if (vessel && this.vesselLifecycleManager.shouldEliminateVessel(vessel)) {
      // Anomali 4 fix (2026-05-05): logga JOURNEY_COMPLETED bara FÖRSTA gången.
      // Tidigare loggade vi varje gång scheduleCleanup anropades med shouldEliminate=true,
      // vilket gav 5+ identiska loggar för samma vessel inom kort tid (PRICKBJORN
      // 04-29 07:26-07:41 fyra ggr, AMELIA 04-30 14:23-14:42 fyra ggr). Faktisk
      // elimination skedde bara EN gång — resten var logg-spam som maskerade
      // verklig vessel-aktivitet.
      const alreadyPending = this._eliminationPending?.has(mmsi);
      if (!alreadyPending) {
        const journeyStatus = this.vesselLifecycleManager.getJourneyStatus(vessel);
        this.logger.log(
          `🎯 [JOURNEY_COMPLETED] Vessel ${mmsi} eliminating immediately: ${journeyStatus.reason}`,
        );
      } else {
        this.logger.debug(
          `🔁 [JOURNEY_COMPLETED_DUP] ${mmsi}: re-evaluation while elimination already pending`,
        );
      }
      timeout = 100; // 100ms immediate elimination instead of long timeout
      // Bug #13 fix: mark this vessel as pending elimination so subsequent
      // scheduleCleanup calls (triggered by new AIS samples that arrive before
      // the 100ms timer fires) cannot overwrite the tiny timeout with a long
      // proximity-based timeout. Without this flag every new AIS message
      // extends the life of an "eliminated" vessel by another 10+ minutes,
      // which was observed as "JOURNEY_COMPLETED eliminating immediately"
      // repeating every minute for 18 minutes before actual removal.
      if (!this._eliminationPending) this._eliminationPending = new Set();
      this._eliminationPending.add(mmsi);
    } else if (vessel && this._eliminationPending?.has(mmsi) && timeout >= 1000) {
      // Bug #13 fix + Review fix L2: vessel is already queued for elimination;
      // ignore any reschedule with ≥1s timeout. Changed from strict `>` to
      // `>=` for defense-in-depth: a caller passing exactly 1000ms would
      // otherwise bypass this guard and rely on the later `newExpiry < existingExpiry`
      // check as the only barrier.
      this.logger.debug(
        `🛡️ [ELIMINATION_PROTECTION] ${mmsi}: Ignoring ${Math.round(timeout / 1000)}s reschedule — elimination already pending`,
      );
      return;
    } else if (vessel && this.passageWindowManager.shouldShowRecentlyPassed(vessel)) {
      // FIX 3: BUSINESS-AWARE LIFECYCLE - Extend timeout during "precis passerat" window
      // CRITICAL: This protection must never SHORTEN an existing longer timeout, otherwise
      // boats can get removed mid-journey during gles AIS (causing bridge text "hopping").
      const displayWindow = this.passageWindowManager.getDisplayWindow();
      const timeRemaining = Math.max(displayWindow - (Date.now() - vessel.lastPassedBridgeTime), 0);
      const extendedTimeout = Math.max(timeout, timeRemaining + 5000, 60000); // Keep/extend, never shorten

      if (extendedTimeout !== timeout) {
        this.logger.log(
          `🛡️ [PASSAGE_PROTECTION] Vessel ${mmsi} in "precis passerat" window for ${vessel.lastPassedBridge} `
          + `- extending timeout to ${Math.round(extendedTimeout / 1000)}s (was ${Math.round(timeout / 1000)}s)`,
        );
      } else {
        this.logger.debug(
          `🛡️ [PASSAGE_PROTECTION] Vessel ${mmsi} in "precis passerat" window for ${vessel.lastPassedBridge} `
          + `- keeping timeout at ${Math.round(timeout / 1000)}s`,
        );
      }
      timeout = extendedTimeout;
    } else if (vessel && this.passageWindowManager.isWithinInternalGracePeriod(vessel)) {
      // FIX 3: BUSINESS-AWARE LIFECYCLE - Respect internal grace period for system stability
      const gracePeriod = this.passageWindowManager.getInternalGracePeriod(vessel);
      const timeRemaining = gracePeriod - (Date.now() - vessel.lastPassedBridgeTime);
      const gracefulTimeout = Math.max(timeRemaining + 2000, timeout); // Grace period + 2s buffer

      this.logger.debug(
        `⏳ [GRACE_PROTECTION] Vessel ${mmsi} in grace period for ${vessel.lastPassedBridge} `
        + `- extending timeout to ${Math.round(gracefulTimeout / 1000)}s`,
      );
      timeout = gracefulTimeout;
    }

    // BUG 6 FIX: Refuse to shorten existing timer — prevents premature removal
    const existingExpiry = this._cleanupExpiryTimes.get(mmsi);
    const newExpiry = Date.now() + timeout;
    if (existingExpiry && newExpiry < existingExpiry) {
      this.logger.debug(
        `🛡️ [TIMER_PROTECTION] ${mmsi}: Refusing to shorten timer `
        + `(existing expires in ${Math.round((existingExpiry - Date.now()) / 1000)}s, `
        + `new would be ${Math.round(timeout / 1000)}s)`,
      );
      return; // Keep existing longer timer
    }

    // Clear existing timer if we're extending
    const existingTimer = this.cleanupTimers.get(mmsi);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      // RACE CONDITION FIX: Double-check vessel exists and not being removed
      if (this.vessels.has(mmsi) && !(this._removalInProgress && this._removalInProgress.has(mmsi))) {
        this.removeVessel(mmsi, 'timeout');
      }
      // Clean up timer reference after execution
      this.cleanupTimers.delete(mmsi);
      this._cleanupExpiryTimes.delete(mmsi);
    }, timeout);

    this.cleanupTimers.set(mmsi, timer);
    this._cleanupExpiryTimes.set(mmsi, newExpiry);
  }

  /**
   * Clear cleanup timer for vessel
   * @param {string} mmsi - Vessel MMSI
   */
  clearCleanup(mmsi) {
    this._clearCleanupTimer(mmsi);
  }

  /**
   * Clear all cleanup timers (for testing/shutdown)
   */
  clearAllTimers() {
    // MEMORY LEAK FIX: Comprehensive timer cleanup with error handling
    let clearedCleanupTimers = 0;
    let clearedProtectionTimers = 0;

    // Clear all cleanup timers with existence check and error handling
    for (const [mmsi, timer] of this.cleanupTimers.entries()) {
      try {
        if (timer) {
          clearTimeout(timer);
          clearedCleanupTimers++;
          this.logger.debug(`🧹 [TIMER_CLEANUP] Cleared cleanup timer for ${mmsi}`);
        }
      } catch (error) {
        this.logger.error(`[TIMER_CLEANUP_ERROR] Failed to clear cleanup timer for ${mmsi}:`, error.message);
      }
    }
    this.cleanupTimers.clear();
    this._cleanupExpiryTimes.clear();

    // ENHANCED: Clear protection timers with existence check and error handling
    for (const [mmsi, timer] of this.protectionTimers.entries()) {
      try {
        if (timer) {
          clearTimeout(timer);
          clearedProtectionTimers++;
          this.logger.debug(`🧹 [TIMER_CLEANUP] Cleared protection timer for ${mmsi}`);
        }
      } catch (error) {
        this.logger.error(`[TIMER_CLEANUP_ERROR] Failed to clear protection timer for ${mmsi}:`, error.message);
      }
    }
    this.protectionTimers.clear();
    this.targetBridgeProtection.clear();

    // MEMORY LEAK FIX: Clear operation locks
    if (this.operationLocks) {
      this.operationLocks.clear();
    }

    // RACE CONDITION FIX: Clear removal tracking
    if (this._removalInProgress) {
      this._removalInProgress.clear();
    }

    // Review fix L1: also clear elimination tracking to prevent stale mmsis
    // leaking into the set across service restart/reset.
    if (this._eliminationPending) {
      this._eliminationPending.clear();
    }

    // MEMORY LEAK PREVENTION: Clear validation timer
    if (this._cleanupValidationTimer) {
      clearInterval(this._cleanupValidationTimer);
      this._cleanupValidationTimer = null;
      this.logger.debug('🧹 [TIMER_CLEANUP] Cleared cleanup validation timer');
    }

    this.logger.log(`🧹 [COMPREHENSIVE_TIMER_CLEANUP] Cleared ${clearedCleanupTimers} cleanup timers and ${clearedProtectionTimers} protection timers`);
  }

  /**
   * Shutdown the VesselDataService and clean up all resources
   * MEMORY LEAK PREVENTION: Ensures complete cleanup when service is shut down
   */
  shutdown() {
    this.logger.log(`🔴 [SHUTDOWN] Shutting down VesselDataService with ${this.vessels.size} vessels`);

    try {
      // Clear all timers first
      this.clearAllTimers();

      // Remove all vessels with comprehensive cleanup
      const vesselMMSIs = Array.from(this.vessels.keys());
      for (const mmsi of vesselMMSIs) {
        this.removeVessel(mmsi, 'shutdown');
      }

      // Clear all remaining data structures
      this.vessels.clear();
      this.bridgeVessels.clear();
      this.cleanupTimers.clear();
      this.protectionTimers.clear();
      this.targetBridgeProtection.clear();

      if (this.operationLocks) {
        this.operationLocks.clear();
      }

      if (this._removalInProgress) {
        this._removalInProgress.clear();
      }

      // Final validation and cleanup
      this._performOrphanedResourceCleanup();

      // Log final statistics
      this.logger.log(
        `📊 [SHUTDOWN_STATS] Total created: ${this._memoryLeakStats.totalVesselsCreated}, `
        + `Total removed: ${this._memoryLeakStats.totalVesselsRemoved}, `
        + `Cleanup errors: ${this._memoryLeakStats.cleanupErrors}`,
      );

      this.logger.log('✅ [SHUTDOWN] VesselDataService shutdown completed successfully');

    } catch (shutdownError) {
      this.logger.error('[SHUTDOWN_ERROR] Error during VesselDataService shutdown:', shutdownError.message);
    }
  }

  /**
   * Get vessel count
   * @returns {number} Number of tracked vessels
   */
  getVesselCount() {
    return this.vessels.size;
  }

  /**
   * Determine if vessel should be assigned a target bridge
   * @private
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if vessel should get target bridge
   */
  _shouldAssignTargetBridge(vessel, oldVessel = null) {
    // First validate vessel has valid coordinates
    if (!vessel || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
      this.logger.debug('🚫 [TARGET_ASSIGNMENT] Invalid vessel coordinates, cannot assign target bridge');
      return false;
    }

    // BUG 3 FIX: Block target assignment for recently completed journeys (10 min cooldown)
    if (this._completedJourneys && this._completedJourneys.has(vessel.mmsi)) {
      const completed = this._completedJourneys.get(vessel.mmsi);
      const elapsed = Date.now() - completed.completedAt;
      const REENTRY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
      if (elapsed < REENTRY_COOLDOWN_MS) {
        this.logger.debug(
          `🚫 [REENTRY_BLOCK] ${vessel.mmsi}: Recently completed journey ${Math.round(elapsed / 1000)}s ago - blocking target assignment`,
        );
        return false;
      }
      // Cooldown expired, remove from completed journeys
      this._completedJourneys.delete(vessel.mmsi);
    }

    // FIX B: Blockera target-tilldelning för fartyg som redan passerat broar och nu är stationära.
    // Skiljer "väntar på första broöppningen" (passedBridges tom, t.ex. fartyg som saktar in
    // vid Klaffbron) från "ankrat efter passage" (passedBridges har poster, t.ex. HMS ARCTURUS
    // som passerade Klaffbron och ankrade 220m norr om bron i 12 timmar).
    // Utan denna fix kan ACCELERATED-logiken (rad 209+) re-tilldela en bro som redan passerats.
    if (vessel.passedBridges && vessel.passedBridges.length > 0
        && Number(vessel.sog) < 0.3) {
      this.logger.debug(
        `🚫 [ANCHOR_BLOCK] ${vessel.mmsi}: Has passed [${vessel.passedBridges.join(', ')}] `
        + `and is stationary (${vessel.sog}kn) - blocking target assignment`,
      );
      return false;
    }

    // FIXED: Check GPS state - reject assignment during GPS instability
    if (vessel._gpsJumpDetected) {
      this.logger.debug(`🚫 [TARGET_ASSIGNMENT] ${vessel.mmsi}: GPS jump detected - rejecting target assignment`);
      return false;
    }

    if (vessel._positionUncertain) {
      this.logger.debug(`🚫 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Position uncertain - rejecting target assignment`);
      return false;
    }

    const speed = Number(vessel.sog);

    // TWO-READINGS VALIDATION: Check if vessel is actually moving toward a target
    // Only apply this validation for existing vessels with a target bridge
    if (oldVessel && oldVessel.targetBridge && oldVessel.lat && oldVessel.lon) {
      const targetBridge = this.bridgeRegistry.getBridgeByName(oldVessel.targetBridge);
      if (targetBridge && targetBridge.lat && targetBridge.lon) {
        const previousDistance = geometry.calculateDistance(
          oldVessel.lat, oldVessel.lon,
          targetBridge.lat, targetBridge.lon,
        );
        const currentDistance = geometry.calculateDistance(
          vessel.lat, vessel.lon,
          targetBridge.lat, targetBridge.lon,
        );
        const distanceChange = previousDistance - currentDistance; // Positive = approaching

        // Check if vessel is approaching the target bridge
        const isApproaching = distanceChange > 0;

        this.logger.debug(
          `📏 [2-READINGS] ${vessel.mmsi}: Distance to ${oldVessel.targetBridge}: `
          + `${previousDistance.toFixed(0)}m → ${currentDistance.toFixed(0)}m `
          + `(${distanceChange > 0 ? '-' : '+'}${Math.abs(distanceChange).toFixed(0)}m), approaching=${isApproaching}`,
        );

        if (!isApproaching && currentDistance > 300) {
          this.logger.debug(
            `🚫 [2-READINGS] ${vessel.mmsi}: Not approaching target bridge ${oldVessel.targetBridge} - `
            + `distance increasing by ${Math.abs(distanceChange).toFixed(0)}m`,
          );
          return false;
        }

        // Require minimum distance change to prevent anchored boats from getting/keeping target bridges
        if (Math.abs(distanceChange) < constants.MIN_APPROACH_DISTANCE && currentDistance > 300) {
          this.logger.debug(
            `🚫 [2-READINGS] ${vessel.mmsi}: Insufficient approach movement to ${oldVessel.targetBridge} - `
            + `only ${Math.abs(distanceChange).toFixed(0)}m change (min ${constants.MIN_APPROACH_DISTANCE}m required)`,
          );
          return false;
        }
      }
    }

    // Calculate distance to nearest bridge for speed validation
    let nearestDistance = Infinity;
    let nearestBridge = null;
    for (const bridge of Object.values(this.bridgeRegistry.bridges)) {
      // Skip bridges without valid coordinates
      if (!bridge || !Number.isFinite(bridge.lat) || !Number.isFinite(bridge.lon)) {
        continue;
      }

      const distance = geometry.calculateDistance(
        vessel.lat, vessel.lon,
        bridge.lat, bridge.lon,
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestBridge = bridge.name;
      }
    }

    // DISTANCE-BASED SPEED REQUIREMENTS:
    // - Far from bridges (>500m): Must have ≥0.7kn (prevent anchored boats far away)
    // - Approaching bridges (300-500m): Must have ≥0.1kn (allow slow boats preparing for bridge)
    // - Near bridges (<300m): Can be 0.0kn (boats waiting for bridge opening - legitimate stop)

    let minSpeed;
    let context;

    if (nearestDistance > 500) {
      minSpeed = 0.7;
      context = 'far from bridges';

      if (speed <= minSpeed) {
        this.logger.debug(
          `🚫 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Too slow for target bridge (${speed}kn ≤ ${minSpeed}kn, ${nearestDistance.toFixed(0)}m ${context}) - likely anchored`,
        );
        return false;
      }
    } else if (nearestDistance > 300) {
      minSpeed = 0.1;
      context = 'approaching bridge';

      if (speed <= minSpeed) {
        this.logger.debug(
          `🚫 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Too slow for target bridge (${speed}kn ≤ ${minSpeed}kn, ${nearestDistance.toFixed(0)}m ${context}) - likely anchored`,
        );
        return false;
      }
    } else {
      // Near bridges (<300m): Allow any speed including 0.0kn (waiting for bridge opening)
      context = 'near bridge (may be waiting)';
      this.logger.debug(
        `🛡️ [PROTECTION_ACTIVE] ${vessel.mmsi}: ${nearestDistance.toFixed(0)}m from ${nearestBridge} (≤300m) - protected from speed requirements`,
      );
    }

    // COURSE VALIDATION: Course should be reasonable (not undefined)
    // BUT: Allow boats near bridges to have no course (they may be waiting stationary)
    if ((vessel.cog == null || !Number.isFinite(vessel.cog)) && nearestDistance > 300) {
      this.logger.debug(
        `🚫 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Invalid course (${vessel.cog}°) and far from bridges (${nearestDistance.toFixed(0)}m) - likely stationary/anchored`,
      );
      return false;
    }
    if (vessel.cog == null && nearestDistance <= 300) {
      this.logger.debug(
        `⚠️ [TARGET_ASSIGNMENT] ${vessel.mmsi}: No course but near bridge (${nearestDistance.toFixed(0)}m) - allowing as may be waiting`,
      );
    }

    this.logger.debug(
      `✅ [TARGET_ASSIGNMENT] ${vessel.mmsi}: Qualifies for target bridge `
      + `(${speed}kn, ${nearestDistance.toFixed(0)}m from ${nearestBridge}, ${vessel.cog}°)`,
    );
    return true;
  }

  /**
   * Check if vessel is suitable for bridge text
   * @private
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if vessel should appear in bridge text
   */
  _isVesselSuitableForBridgeText(vessel) {
    // CRITICAL FIX: Validate vessel object first
    if (!vessel || !vessel.mmsi) {
      this.logger.debug('🚫 [BRIDGE_TEXT_FILTER] Invalid vessel object');
      return false;
    }

    const speed = Number(vessel.sog);

    // CRITICAL FIX: Validate speed is a finite number
    if (!Number.isFinite(speed)) {
      this.logger.debug(`🚫 [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Invalid speed value (${vessel.sog})`);
      return false;
    }

    // More lenient requirements for bridge text than target assignment
    // CRITICAL FIX: Allow waiting vessels regardless of speed
    const isWaitingVessel = ['waiting', 'stallbacka-waiting', 'under-bridge'].includes(vessel.status);
    const isRecentlyPassed = vessel.status === 'passed'
      && this.passageWindowManager && this.passageWindowManager.shouldShowRecentlyPassed(vessel);

    // FIX 4: Förhindra default-blink - direktkontroll av lastPassedBridgeTime
    // Behåll fartyg i passage-fönster även om status ändrats för snabbt
    const inPassageTimeWindow = vessel.lastPassedBridgeTime
      && (Date.now() - vessel.lastPassedBridgeTime) < 120000; // 2 minuter

    // FIX 4: Behåll också fartyg som har targetBridge satt (pågående resa)
    const hasActiveJourney = Boolean(vessel.targetBridge);

    if (speed < 0.3 && !isWaitingVessel && !isRecentlyPassed && !inPassageTimeWindow && !hasActiveJourney) {
      this.logger.debug(
        `🚫 [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Too slow for bridge text (${speed}kn < 0.3kn)`,
      );
      return false;
    }
    if (inPassageTimeWindow && speed < 0.3) {
      this.logger.debug(
        `✅ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Allowing slow vessel in passage time window (${speed}kn)`,
      );
    }
    if (hasActiveJourney && speed < 0.3 && !isWaitingVessel && !isRecentlyPassed) {
      this.logger.debug(
        `✅ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Allowing slow vessel with active journey to ${vessel.targetBridge}`,
      );
    }
    if (isWaitingVessel && speed < 0.3) {
      this.logger.debug(
        `✅ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Allowing slow waiting vessel (${speed}kn, status: ${vessel.status})`,
      );
    }
    if (isRecentlyPassed && speed < 0.3) {
      this.logger.debug(
        `✅ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Allowing slow recently passed vessel (${speed}kn, status: ${vessel.status})`,
      );
    }

    return true;
  }

  /**
   * Calculate target bridge based on vessel position and direction
   * @private
   */
  _calculateTargetBridge(vessel) {
    const { COG_DIRECTIONS, AIS_CONFIG } = constants;

    // CRITICAL FIX: Validate vessel position data
    if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
      this.logger.debug(`⚠️ [TARGET_ASSIGNMENT] ${vessel.mmsi}: Invalid position data - lat=${vessel.lat}, lon=${vessel.lon}`);
      return null;
    }

    // CRITICAL FIX: Check if vessel is within canal system bounds
    const { BOUNDING_BOX } = AIS_CONFIG;
    if (vessel.lat < BOUNDING_BOX.SOUTH || vessel.lat > BOUNDING_BOX.NORTH
        || vessel.lon < BOUNDING_BOX.WEST || vessel.lon > BOUNDING_BOX.EAST) {
      this.logger.debug(
        `🚪 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Outside canal bounds `
        + `(lat=${vessel.lat.toFixed(6)}, lon=${vessel.lon.toFixed(6)}) - no target bridge assigned`,
      );
      return null;
    }

    // CRITICAL FIX: Validate COG is in valid range
    if (!Number.isFinite(vessel.cog) || vessel.cog < 0 || vessel.cog >= 360) {
      this.logger.debug(`⚠️ [TARGET_ASSIGNMENT] ${vessel.mmsi}: Invalid COG (${vessel.cog}) - cannot determine direction`);
      return null;
    }

    // Anomali 16 (2026-05-19): skippa target-tilldelning vid osäker direction OCH låg sog.
    // Verifierat 2026-05-19 10:40: DAPHNE (219022098) dök upp sog=0.6 kn cog=73.2° (öst,
    // varken N/S). Tilldelades direction=southbound + target=Klaffbron + ETA=79min — alla
    // felaktiga. Hon var ankrad och åkte sedan norrut. För ankrade vessels utan tydlig
    // riktning är target-tilldelning gissning. Vänta tills hon rör sig med tydlig cog.
    {
      const cogIsNorth = vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX;
      const cogIsSouth = vessel.cog >= 135 && vessel.cog <= 225;
      const cogIsUncertain = !cogIsNorth && !cogIsSouth;
      const sogIsLow = Number.isFinite(vessel.sog) && vessel.sog < 1.5;
      if (cogIsUncertain && sogIsLow) {
        this.logger.debug(
          `🚫 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Skipping target — osäker direction `
          + `(cog=${vessel.cog.toFixed(1)}°, sog=${vessel.sog} kn). Väntar på tydlig rörelse.`,
        );
        return null;
      }
    }

    // FIX Z: Southbound vessels that have passed Klaffbron are leaving the canal
    // They should NOT get Stridsbergsbron as a new target
    if (vessel._finalTargetDirection === 'south'
        && vessel.passedBridges?.includes('Klaffbron')) {
      this.logger.debug(
        `🚪 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, passerat Klaffbron → lämnar kanalen, ingen målbro`,
      );
      return null;
    }

    // Determine vessel direction
    const isNorthbound = vessel.cog >= COG_DIRECTIONS.NORTH_MIN
      || vessel.cog <= COG_DIRECTIONS.NORTH_MAX;

    // Get bridge positions from registry for consistency
    const klaffbron = this.bridgeRegistry.getBridgeByName('Klaffbron');
    const stridsbergsbron = this.bridgeRegistry.getBridgeByName('Stridsbergsbron');

    if (!klaffbron || !stridsbergsbron) {
      this.logger.error('🚨 [TARGET_ASSIGNMENT] Critical: Target bridges not found in registry');
      return null;
    }

    // CRITICAL FIX: Validate bridge coordinates
    if (!Number.isFinite(klaffbron.lat) || !Number.isFinite(stridsbergsbron.lat)) {
      this.logger.error('🚨 [TARGET_ASSIGNMENT] Critical: Invalid bridge coordinates in registry');
      return null;
    }

    const klaffbronLat = klaffbron.lat;
    const stridsbergsbronLat = stridsbergsbron.lat;

    // ENHANCED: Additional proximity check for protection zone validation
    // If vessel is very close to any bridge, ensure target assignment considers this
    const distanceToKlaffbron = geometry.calculateDistance(
      vessel.lat, vessel.lon, klaffbron.lat, klaffbron.lon,
    );
    const distanceToStridsberg = geometry.calculateDistance(
      vessel.lat, vessel.lon, stridsbergsbron.lat, stridsbergsbron.lon,
    );

    // Log proximity for debugging
    this.logger.debug(
      `📍 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Distances - Klaffbron: ${distanceToKlaffbron.toFixed(0)}m, Stridsbergsbron: ${distanceToStridsberg.toFixed(0)}m`,
    );

    // ROOT FIX: Kontrollera passedBridges — tilldela ALDRIG en bro som redan passerats.
    // Utan detta kan target regrediera till t.ex. Klaffbron efter att fartyget passerat den.
    const passed = vessel.passedBridges || [];

    if (isNorthbound) {
      // ENHANCED: Check if vessel is leaving canal northbound (north of Stridsbergsbron)
      if (vessel.lat > stridsbergsbronLat + 0.001) { // Small buffer to prevent edge cases
        this.logger.debug(
          `🚪 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Norrut, norr om Stridsbergsbron → lämnar kanalen, ingen målbro`,
        );
        return null; // No target bridge - vessel leaving canal
      }

      // ENHANCED: Norrut - Which target bridge is encountered FIRST based on position?
      if (vessel.lat < klaffbronLat) {
        if (passed.includes('Klaffbron')) {
          this.logger.debug(
            `🛡️ [TARGET_ASSIGNMENT] ${vessel.mmsi}: Norrut, söder om Klaffbron men redan passerat → Stridsbergsbron`,
          );
          return passed.includes('Stridsbergsbron') ? null : 'Stridsbergsbron';
        }
        this.logger.debug(
          `🎯 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Norrut, söder om Klaffbron → Klaffbron först`,
        );
        return 'Klaffbron';
      } if (vessel.lat >= klaffbronLat && vessel.lat <= stridsbergsbronLat) {
        if (passed.includes('Stridsbergsbron')) {
          this.logger.debug(
            `🛡️ [TARGET_ASSIGNMENT] ${vessel.mmsi}: Norrut, mellan broarna men redan passerat Stridsbergsbron → ingen målbro`,
          );
          return null;
        }
        this.logger.debug(
          `🎯 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Norrut, mellan broarna → Stridsbergsbron`,
        );
        return 'Stridsbergsbron';
      }
      // North of Stridsbergsbron but within bounds → leaving canal
      this.logger.debug(
        `🚪 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Norrut, norr om Stridsbergsbron (inom gränser) → lämnar kanalen`,
      );
      return null;

    }

    // ENHANCED: Check if vessel is leaving canal southbound (south of Klaffbron)
    if (vessel.lat < klaffbronLat - 0.001) { // Small buffer to prevent edge cases
      this.logger.debug(
        `🚪 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, söder om Klaffbron → lämnar kanalen, ingen målbro`,
      );
      return null; // No target bridge - vessel leaving canal
    }

    // ENHANCED: Söderut - Which target bridge is encountered FIRST based on position?
    if (vessel.lat > stridsbergsbronLat) {
      if (passed.includes('Stridsbergsbron')) {
        this.logger.debug(
          `🛡️ [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, norr om Stridsbergsbron men redan passerat → Klaffbron`,
        );
        return passed.includes('Klaffbron') ? null : 'Klaffbron';
      }
      this.logger.debug(
        `🎯 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, norr om Stridsbergsbron → Stridsbergsbron först`,
      );
      return 'Stridsbergsbron';
    } if (vessel.lat >= klaffbronLat && vessel.lat <= stridsbergsbronLat) {
      if (passed.includes('Klaffbron')) {
        this.logger.debug(
          `🛡️ [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, mellan broarna men redan passerat Klaffbron → ingen målbro`,
        );
        return null;
      }
      this.logger.debug(
        `🎯 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, mellan broarna → Klaffbron`,
      );
      return 'Klaffbron';
    }
    // South of Klaffbron but within bounds → leaving canal
    this.logger.debug(
      `🚪 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, söder om Klaffbron (inom gränser) → lämnar kanalen`,
    );
    return null;

  }

  /**
   * Handle target bridge transitions (ENHANCED: Now separate from passage detection)
   * @private
   */
  _handleTargetBridgeTransition(vessel, oldVessel) {
    if (!oldVessel) {
      return;
    }

    // Resolve deferred transitions captured while within protection zone
    if (vessel._pendingTarget && vessel._pendingTarget.source === vessel.targetBridge) {
      const currentBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
      if (!currentBridge) {
        vessel._pendingTarget = null;
      } else {
        const distanceToCurrentTarget = geometry.calculateDistance(
          vessel.lat,
          vessel.lon,
          currentBridge.lat,
          currentBridge.lon,
        );
        const elapsed = Date.now() - (vessel._pendingTarget.since || Date.now());
        const gracePeriod = this.passageWindowManager.getInternalGracePeriod(vessel);

        if (distanceToCurrentTarget > constants.PROTECTION_ZONE_RADIUS || elapsed > gracePeriod) {
          this.logger.debug(
            `✅ [TARGET_PENDING_RESOLVED] ${vessel.mmsi}: Distance ${distanceToCurrentTarget.toFixed(0)}m, `
            + `elapsed ${(elapsed / 1000).toFixed(1)}s → completing transition to `
            + `${vessel._pendingTarget.next || 'none'}`,
          );
          const pendingNext = vessel._pendingTarget.next || null;
          vessel._pendingTarget = null;
          this._applyTargetTransition(vessel, oldVessel, pendingNext);
          return;
        }

        this.logger.debug(
          `⏳ [TARGET_PENDING] ${vessel.mmsi}: Still within protection zone `
          + `(${distanceToCurrentTarget.toFixed(0)}m) → waiting to switch to `
          + `${vessel._pendingTarget.next || 'none'}`,
        );
      }
    } else if (vessel._pendingTarget && vessel._pendingTarget.source !== vessel.targetBridge) {
      // Target changed externally - clear stale pending transition
      vessel._pendingTarget = null;
    }

    // ENHANCED: This method now assumes passage has already been detected
    // Check once more to be safe, but this should normally be true
    const hasPassedCurrentTarget = this._hasPassedTargetBridge(
      vessel,
      oldVessel,
    );
    const hasPendingTransitionActive = Boolean(
      vessel._pendingTarget && vessel._pendingTarget.source === vessel.targetBridge,
    );

    this.logger.debug(
      `🔍 [TARGET_TRANSITION] ${vessel.mmsi}: hasPassedCurrentTarget=${hasPassedCurrentTarget}, targetBridge=${vessel.targetBridge}`,
    );

    if (!hasPassedCurrentTarget && !hasPendingTransitionActive) {
      // Check if vessel passed any intermediate bridge
      this._handleIntermediateBridgePassage(vessel, oldVessel);
      return;
    }

    // FIX A: Bekräftad passage → omedelbar transition.
    // När _hasPassedTargetBridge() returnerar true har passagen redan validerats genom
    // detectBridgePassage(), route order validator och GPS jump gate. Protection zone
    // (rad 1645) är designad för att skydda mot FALSKA target-ändringar, inte för att
    // blockera BEKRÄFTADE passager. Utan denna fix skapas en _pendingTarget som aldrig
    // resolvas om fartyget stannar inom 300m (t.ex. ankrar efter passage).
    if (hasPassedCurrentTarget) {
      const nextTarget = this._calculateNextTargetBridge(vessel) || null;
      vessel._pendingTarget = null;
      this.logger.log(
        `🎯 [PASSAGE_IMMEDIATE] ${vessel.mmsi}: Confirmed passage of ${vessel.targetBridge} `
        + `→ immediate transition to ${nextTarget || 'none'} (bypassing protection zone deferral)`,
      );
      this._applyTargetTransition(vessel, oldVessel, nextTarget);
      return;
    }

    const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
    const nextTargetBridge = this._calculateNextTargetBridge(vessel) || null;

    if (targetBridge) {
      const distanceToCurrentTarget = geometry.calculateDistance(
        vessel.lat,
        vessel.lon,
        targetBridge.lat,
        targetBridge.lon,
      );

      this.logger.debug(
        `🔍 [TARGET_DEBUG] ${vessel.mmsi}: Distance to ${vessel.targetBridge}: ${distanceToCurrentTarget.toFixed(0)}m`,
      );

      if (distanceToCurrentTarget <= constants.PROTECTION_ZONE_RADIUS) {
        const gracePeriod = this.passageWindowManager.getInternalGracePeriod(vessel);
        const recentlyPassed = vessel.lastPassedBridge === vessel.targetBridge
          && vessel.lastPassedBridgeTime
          && (Date.now() - vessel.lastPassedBridgeTime < gracePeriod);

        if (!recentlyPassed) {
          const alreadyMarked = vessel.lastPassedBridge === vessel.targetBridge && vessel.lastPassedBridgeTime;
          if (!alreadyMarked) {
            const passageTimestamp = Date.now();
            vessel.lastPassedBridge = vessel.targetBridge;
            vessel.lastPassedBridgeTime = passageTimestamp;

            // FIX U: För nära bro-par, sätt force-waiting för nästa bro
            this._setForceWaitingForCloseBridgePair(vessel, vessel.targetBridge);

            this.logger.debug(
              `🛡️ [TARGET_TRANSITION_BLOCKED] ${vessel.mmsi}: Blocking targetBridge change while `
              + `${distanceToCurrentTarget.toFixed(0)}m from ${vessel.targetBridge} `
              + `(within ${constants.PROTECTION_ZONE_RADIUS}m protection zone), `
              + 'setting recently passed latch (one-shot)',
            );
          }
        }

        const pendingNext = nextTargetBridge;
        if (!vessel._pendingTarget || vessel._pendingTarget.source !== vessel.targetBridge) {
          vessel._pendingTarget = {
            source: vessel.targetBridge,
            next: pendingNext,
            since: Date.now(),
          };
          this.logger.debug(
            `⏱️ [TARGET_TRANSITION_PENDING] ${vessel.mmsi}: Will switch from ${vessel.targetBridge} `
            + `to ${pendingNext || 'none'} once outside protection zone`,
          );
        } else if (vessel._pendingTarget.next !== pendingNext) {
          vessel._pendingTarget.next = pendingNext;
          vessel._pendingTarget.since = Date.now();
          this.logger.debug(
            `🔄 [TARGET_PENDING_UPDATE] ${vessel.mmsi}: Updating pending transition to ${pendingNext || 'none'}`,
          );
        }

        return;
      }
    }

    const pendingNext = vessel._pendingTarget ? (vessel._pendingTarget.next || null) : nextTargetBridge;
    vessel._pendingTarget = null;
    this._applyTargetTransition(vessel, oldVessel, pendingNext);
  }

  /**
   * Finalize a target bridge transition (including final target removal)
   * @private
   * @param {Object} vessel - Updated vessel object
   * @param {Object} oldVessel - Previous vessel state
   * @param {string|null} nextTargetBridge - Next target bridge or null if final
   */
  _applyTargetTransition(vessel, oldVessel, nextTargetBridge) {
    const previousTarget = oldVessel?.targetBridge || vessel.targetBridge;
    if (!previousTarget) {
      return;
    }

    const normalizedNext = nextTargetBridge && nextTargetBridge !== previousTarget
      ? nextTargetBridge
      : null;
    const isTransitionToNext = Boolean(normalizedNext);

    const passageTimestamp = Date.now();
    this._generatePassageId(vessel.mmsi, previousTarget, passageTimestamp);

    if (isTransitionToNext) {
      this.logger.log(
        `🎯 [TARGET_TRANSITION] ${vessel.mmsi}: Passed ${previousTarget} → ${normalizedNext}`,
      );
      vessel.targetBridge = normalizedNext;
      vessel._finalTargetBridge = null;
      vessel._finalTargetDirection = null;
      const direction = normalizedNext === 'Stridsbergsbron' ? 'north' : 'south';
      this._lockRouteDirection(vessel, direction);
      const protection = this.targetBridgeProtection?.get(vessel.mmsi?.toString?.() || vessel.mmsi);
      if (protection && protection.isActive) {
        protection.targetBridge = normalizedNext;
        protection.reason = 'target_transition';
        protection.startTime = Date.now();
        this.targetBridgeProtection.set(vessel.mmsi?.toString?.() || vessel.mmsi, protection);
      }
    } else {
      const direction = previousTarget === 'Stridsbergsbron' ? 'north' : 'south';
      const remainingZone = direction === 'north'
        ? 'Stallbackabron'
        : 'Olidebron + Kanalinfarten';
      this.logger.log(
        `🏁 [TARGET_END] ${vessel.mmsi}: Final target ${previousTarget} passed — `
        + `continuing to track through ${remainingZone}`,
      );
      vessel.targetBridge = null;
      this._lockRouteDirection(vessel, direction);
      vessel._finalTargetBridge = previousTarget;
      vessel._finalTargetDirection = direction;
    }

    if (this._anchorPassageTimestamp(vessel, previousTarget, passageTimestamp)) {
      const passageId = this._generatePassageId(vessel.mmsi, previousTarget, vessel);

      if (!this._isPassageAlreadyProcessed(passageId)) {
        const alreadySetByBlockedTransition = vessel.lastPassedBridge === previousTarget
          && vessel.lastPassedBridgeTime
          && (Date.now() - vessel.lastPassedBridgeTime) < 120000; // 2 min grace period

        const alreadyRecorded = vessel.lastPassedBridge === previousTarget && vessel.lastPassedBridgeTime;

        if (!alreadySetByBlockedTransition && !alreadyRecorded) {
          vessel.lastPassedBridgeTime = passageTimestamp;
          vessel.lastPassedBridge = previousTarget;

          // FIX U: För nära bro-par, sätt force-waiting för nästa bro
          this._setForceWaitingForCloseBridgePair(vessel, previousTarget);

          this.logger.debug(`🆔 [PASSAGE_ID] ${vessel.mmsi}: Recorded unique passage ${passageId}`);
        } else {
          this.logger.debug(`🔄 [PASSAGE_ALREADY_SET] ${vessel.mmsi}: Passage already marked by blocked transition logic`);
        }

        this._markPassageProcessed(passageId);
      } else {
        this.logger.debug(`🚫 [PASSAGE_DUPLICATE] ${vessel.mmsi}: Skipping duplicate passage ${passageId}`);
      }
    }

    if (isTransitionToNext) {
      this.logger.log(
        `📝 [TARGET_PASSAGE_RECORDED] ${vessel.mmsi}: Recorded passage of target bridge ${previousTarget}`,
      );
    } else {
      this.logger.log(
        `📝 [FINAL_TARGET_PASSAGE_RECORDED] ${vessel.mmsi}: Recorded passage of final target bridge ${previousTarget}`,
      );
    }

    // Anomali 15 (2026-05-18): Inferred Järnvägsbron-passage vid Klaffbron/Stridsbergsbron-
    // transition eller TARGET_END. Järnvägsbron (58.291) ligger geografiskt MELLAN Klaffbron
    // (58.284) och Stridsbergsbron (58.293) — bara 222m söder om Stridsbergsbron. För
    // långsamma vessels i sidled av kanalen kan trajectory_based_passage missa Järnvägsbron
    // (verifierat 2026-05-18: 231915000 KOLLAND sog=0.3 missade Järnvägsbron). När en target
    // bridge på andra sidan av Järnvägsbron passeras har vesseln GEOMETRISKT MÅST passerat
    // Järnvägsbron. Sätt lastPassedBridge så Fix C i _onVesselUpdated utlöser fallback.
    const isJarnvagsbronBetween = (previousTarget === 'Klaffbron' && (normalizedNext === 'Stridsbergsbron' || !isTransitionToNext))
      || (previousTarget === 'Stridsbergsbron' && (normalizedNext === 'Klaffbron' || !isTransitionToNext));
    if (isJarnvagsbronBetween && !(vessel.passedBridges?.includes('Järnvägsbron'))) {
      if (!Array.isArray(vessel.passedBridges)) vessel.passedBridges = [];
      vessel.passedBridges.push('Järnvägsbron');
      vessel.lastPassedBridge = 'Järnvägsbron';
      vessel.lastPassedBridgeTime = Date.now();
      this.logger.log(
        `🌉 [INFERRED_PASSAGE] ${vessel.mmsi}: Inferred Järnvägsbron passage `
        + `(geometric necessity at ${isTransitionToNext ? `${previousTarget} → ${normalizedNext}` : `TARGET_END ${previousTarget}`})`,
      );
    }
  }

  /**
   * Create vessel object from AIS data
   * @private
   */
  _createVesselObject(mmsi, data, oldVessel) {
    // Validate and sanitize coordinates (handle strings and invalid values)
    let { lat } = data;
    let { lon } = data;

    // Convert strings to numbers if possible
    if (typeof lat === 'string') {
      lat = parseFloat(lat);
    }
    if (typeof lon === 'string') {
      lon = parseFloat(lon);
    }

    // Validate coordinates are within valid Earth ranges
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
      lat = null;
    }
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
      lon = null;
    }

    // Calculate position tracking with GPS-jump detection
    const currentPosition = { lat, lon };
    const previousPosition = oldVessel
      ? { lat: oldVessel.lat, lon: oldVessel.lon }
      : null;

    // Handle GPS-jump detection and position validation
    const positionData = this._handleGPSJumpDetection(
      mmsi,
      currentPosition,
      previousPosition,
      oldVessel,
      data, // Pass current AIS data for COG/SOG analysis
    );
    const validatedPosition = positionData.position;
    const positionChangeTime = positionData.changeTime;

    const vessel = {
      mmsi,
      lat: validatedPosition.lat,
      lon: validatedPosition.lon,
      sog: data.sog,
      cog: data.cog,
      dirString: data.dirString || 'unknown',
      timestamp: Date.now(),
      name: data.name || 'Unknown',

      // PHASE 2 FIX: Track last position update for stale AIS detection
      // Only update timestamp if position actually changed (not just AIS update)
      lastPositionUpdate: positionChangeTime === (oldVessel?.lastPositionChange || Date.now())
        ? (oldVessel?.lastPositionUpdate || Date.now()) // Position didn't change - keep old timestamp
        : Date.now(), // Position changed - update timestamp

      // Position tracking for movement detection
      lastPosition: previousPosition,
      lastPositionChange: positionChangeTime,

      // Status and bridge information
      status: oldVessel?.status || 'en-route',
      targetBridge: oldVessel?.targetBridge || null,
      nearBridge: oldVessel?.nearBridge || null,

      // Movement and tracking
      lastActiveTime:
        data.sog > 2.0 ? Date.now() : oldVessel?.lastActiveTime || Date.now(),

      // Speed tracking
      speedHistory: this._updateSpeedHistory(oldVessel?.speedHistory, data.sog),
      maxRecentSpeed: this._calculateMaxRecentSpeed(oldVessel, data.sog),

      // Status flags
      isApproaching: oldVessel?.isApproaching || false,
      isWaiting: oldVessel?.isWaiting || false,

      // Bridge passage tracking
      passedBridges: oldVessel?.passedBridges || [],
      lastPassedBridgeTime: oldVessel?.lastPassedBridgeTime || null,
      lastPassedBridge: oldVessel?.lastPassedBridge || null,
      _finalTargetBridge: oldVessel?._finalTargetBridge || null,
      _finalTargetDirection: oldVessel?._finalTargetDirection || null,

      // Timing and detection
      etaMinutes: oldVessel?.etaMinutes || null,
      waitSince: oldVessel?.waitSince || null,
      speedBelowThresholdSince: oldVessel?.speedBelowThresholdSince || null,

      // Diagnostic information
      graceMisses: oldVessel?.graceMisses || 0,
      _distanceToNearest: oldVessel?._distanceToNearest || 9999,
      _lastSeen: Date.now(),

      // Additional properties for enhanced tracking
      towards: data.towards || null,
      gracePeriod: false,
      _targetAssignmentAttempts: oldVessel?._targetAssignmentAttempts || 0,
      _wasCloseToTarget: oldVessel?._wasCloseToTarget || null,
      confidence: oldVessel?.confidence || 'medium',

      // GPS jump analysis data (NEW) - FIXED SYNCHRONIZATION
      _positionAnalysis: positionData.analysis || null,
      _gpsJumpDetected: positionData.gpsJumpDetected || positionData.jumpDetected || false,
      _positionUncertain: positionData.positionUncertain || false,
      _positionData: positionData, // Store full position data including coordination
      _pendingTarget: oldVessel?._pendingTarget || null,

      // FIX U: Bevara force-waiting flaggor mellan AIS-uppdateringar
      // Utan detta försvinner flaggan vid nästa AIS-uppdatering (60s senare)
      _forceWaitingAtBridge: oldVessel?._forceWaitingAtBridge || null,
      _lastWaitingShownAt: oldVessel?._lastWaitingShownAt || null,

      // Bridge opening state (Phase 3 window) — must survive AIS cycles
      _bridgeOpeningUntil: oldVessel?._bridgeOpeningUntil || null,
      _bridgeOpeningBridgeName: oldVessel?._bridgeOpeningBridgeName || null,
      _bridgeOpeningTextShown: oldVessel?._bridgeOpeningTextShown ?? null, // ?? because tri-state: null/false/true
      _bridgeOpeningLogged: oldVessel?._bridgeOpeningLogged || null,

      // Hysteresis and direction state
      _underBridgeLatched: oldVessel?._underBridgeLatched || false,
      // Review fix C2: Bug #5 (under-bridge timeout) reads/writes _underBridgeSince
      // as the entry timestamp for the latch. Without preserving it across AIS
      // updates (which rebuild the vessel object every ~60s), the 10-min timer
      // restarts on every position report → Bug #5 fix never fires in prod.
      _underBridgeSince: oldVessel?._underBridgeSince || null,
      _routeDirection: oldVessel?._routeDirection || null,
      _routeDirectionLockUntil: oldVessel?._routeDirectionLockUntil || null,
    };

    return vessel;
  }

  /**
   * Apply SystemCoordinator coordination results to vessel processing
   * @private
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} vessel - Current vessel data
   * @param {Object} oldVessel - Previous vessel data
   * @param {Object} coordination - Coordination results from SystemCoordinator
   */
  _applyCoordinationResults(mmsi, vessel, oldVessel, coordination) {
    if (!coordination) return;

    // Apply GPS event protection if recommended
    if (coordination.shouldActivateProtection) {
      // Ensure target bridge protection exists for this vessel
      if (!this.targetBridgeProtection.has(mmsi)) {
        this.targetBridgeProtection.set(mmsi, {
          isActive: false,
          reason: '',
          startTime: null,
          targetBridge: null,
          confidence: 1.0,
          gpsEventDetected: false,
          closeToTarget: false,
          maneuverDetected: false,
        });
      }

      const protection = this.targetBridgeProtection.get(mmsi);
      protection.coordinationActive = true;
      protection.coordinationReason = coordination.reason;
      protection.gpsEventDetected = coordination.reason.includes('gps');

      this.logger.debug(
        `🎮 [COORDINATION_APPLIED] ${mmsi}: Activating protection due to coordination (${coordination.reason})`,
      );
    }

    // Set stabilization level for status processing
    if (coordination.stabilizationLevel) {
      vessel._stabilizationLevel = coordination.stabilizationLevel;
    }

    // Apply coordination flags
    vessel._coordinationActive = coordination.coordinationActive || false;
    vessel._coordinationReason = coordination.reason;

    // FIXED: Reset GPS flags when coordination resolves the issues
    if (!coordination.coordinationActive && oldVessel) {
      // Clear resolved GPS flags if coordination is no longer active
      if (oldVessel._gpsJumpDetected && !vessel._gpsJumpDetected) {
        this.logger.debug(`✅ [GPS_RESOLVED] ${mmsi}: GPS jump issue resolved`);
      }
      if (oldVessel._positionUncertain && !vessel._positionUncertain) {
        this.logger.debug(`✅ [GPS_RESOLVED] ${mmsi}: Position uncertainty resolved`);
      }
    }

    // Log coordination application
    if (coordination.coordinationActive) {
      this.logger.debug(
        `🎮 [COORDINATION_ACTIVE] ${mmsi}: Coordination active - ${coordination.reason} `
        + `(protection: ${coordination.shouldActivateProtection}, debounce: ${coordination.shouldDebounceText}, `
        + `level: ${coordination.stabilizationLevel})`,
      );
    }
  }

  /**
   * Update speed history
   * @private
   */
  _updateSpeedHistory(oldHistory, currentSpeed) {
    const history = oldHistory || [];
    const now = Date.now();

    // Add current speed with timestamp
    history.push({ speed: currentSpeed, timestamp: now });

    // Keep only last 10 entries or entries from last 5 minutes
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    return history
      .filter((entry) => entry.timestamp > fiveMinutesAgo)
      .slice(-10);
  }

  /**
   * Calculate maximum recent speed
   * @private
   */
  _calculateMaxRecentSpeed(oldVessel, currentSpeed) {
    if (!oldVessel) {
      return currentSpeed;
    }

    const recentSpeeds = this._updateSpeedHistory(
      oldVessel.speedHistory,
      currentSpeed,
    );
    return Math.max(...recentSpeeds.map((entry) => entry.speed));
  }

  /**
   * Clear cleanup timer
   * @private
   */
  _clearCleanupTimer(mmsi) {
    const timer = this.cleanupTimers.get(mmsi);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(mmsi);
    }
    this._cleanupExpiryTimes.delete(mmsi);
    // Review fix L1: clearing the cleanup timer means there's no pending
    // elimination for this mmsi, so drop the flag too to keep sets consistent.
    if (this._eliminationPending) {
      this._eliminationPending.delete(mmsi);
    }
  }

  /**
   * Check if vessel has passed its current target bridge
   * @private
   */
  _hasPassedTargetBridge(vessel, oldVessel) {
    if (!vessel.targetBridge || !oldVessel) {
      return false;
    }

    // FIX U: Check passage detection cache to prevent duplicate detections
    const cacheKey = `${vessel.mmsi}:${vessel.targetBridge}`;
    const now = Date.now();
    const cached = this._passageDetectionCache.get(cacheKey);

    if (cached && (now - cached.timestamp) < 500) {
      // Cache still valid - return cached result without reprocessing
      if (cached.result) {
        this.logger.debug(
          `🔄 [PASSAGE_CACHE_HIT] ${vessel.mmsi}: Using cached passage result for ${vessel.targetBridge} (${now - cached.timestamp}ms old)`,
        );
      }
      return cached.result;
    }

    const targetBridge = this.bridgeRegistry.getBridgeByName(
      vessel.targetBridge,
    );
    if (!targetBridge) {
      // Cache negative result
      this._passageDetectionCache.set(cacheKey, { timestamp: now, result: false });
      return false;
    }

    // GPS-JUMP GATING: Check if passage detection should be blocked
    if (this.app.gpsJumpGateService
        && this.app.gpsJumpGateService.shouldBlockPassageDetection(vessel.mmsi.toString(), vessel, targetBridge.name)) {

      // USE ENHANCED PASSAGE DETECTION: But register as candidate instead of confirming
      const passageResult = geometry.detectBridgePassage(vessel, oldVessel, targetBridge);

      if (passageResult.passed) {
        // Register as candidate for later confirmation
        this.app.gpsJumpGateService.registerCandidatePassage(
          vessel.mmsi.toString(),
          targetBridge.name,
          passageResult,
          vessel,
        );

        this.logger.debug(`🛡️ [GPS_GATE] ${vessel.mmsi}: Passage of ${vessel.targetBridge} registered as candidate (gated)`);
      }

      // FIX U: Cache negative result
      this._passageDetectionCache.set(cacheKey, { timestamp: now, result: false });
      return false; // Blocked by gating
    }

    // USE ENHANCED PASSAGE DETECTION: Normal passage detection when not gated
    const passageResult = geometry.detectBridgePassage(vessel, oldVessel, targetBridge);

    // Pre-calculate distances for fallback and logging
    const currentDistance = geometry.calculateDistance(
      vessel.lat,
      vessel.lon,
      targetBridge.lat,
      targetBridge.lon,
    );
    const previousDistance = geometry.calculateDistance(
      oldVessel.lat,
      oldVessel.lon,
      targetBridge.lat,
      targetBridge.lon,
    );

    // FALLBACK: If we have datapoints within the span, force passage even if the line-cross missed
    if (!passageResult.passed
        && (currentDistance <= constants.UNDER_BRIDGE_SET_DISTANCE
          || previousDistance <= constants.UNDER_BRIDGE_SET_DISTANCE)) {
      passageResult.passed = true;
      passageResult.method = passageResult.method || 'distance_fallback';
      passageResult.confidence = Math.max(0.5, passageResult.confidence || 0.5);
      passageResult.details = {
        ...(passageResult.details || {}),
        previousDistance,
        currentDistance,
        fallback: true,
      };
    }

    if (passageResult.passed) {
      // ROUTE ORDER VALIDATION: Check if this passage order makes sense
      if (this.app.routeOrderValidator) {
        const validationResult = this.app.routeOrderValidator.validatePassageOrder(
          vessel.mmsi.toString(),
          targetBridge.name,
          vessel,
        );

        if (!validationResult.valid) {
          this.logger.debug(`🚫 [ROUTE_ORDER] ${vessel.mmsi}: Passage of ${vessel.targetBridge} blocked - ${validationResult.reason} (confidence: ${validationResult.confidence})`);
          // FIX U: Cache negative result
          this._passageDetectionCache.set(cacheKey, { timestamp: now, result: false });
          return false; // Block passage due to invalid order
        }
      }
      this.logger.log(
        `🎯 [TARGET_BRIDGE_PASSED] ${vessel.mmsi}: Passed target bridge ${vessel.targetBridge} `
        + `(method: ${passageResult.method}, confidence: ${passageResult.confidence.toFixed(2)})`,
      );

      // Bug #10 observability + Review fix L3: make low-confidence passages
      // searchable in logs at WARN level (matches the ⚠️ prefix). When
      // confidence ≤ 0.50 combined with near-zero SOG, the passage is a
      // distance_fallback for a vessel stopped under the bridge — the passage
      // is valid but the vessel will immediately become a ghost candidate
      // unless Bug #1/#3 fixes are in place.
      if (passageResult.confidence <= 0.5 && Number.isFinite(vessel.sog) && vessel.sog < 0.5) {
        const warnFn = typeof this.logger.warn === 'function'
          ? this.logger.warn.bind(this.logger)
          : this.logger.log.bind(this.logger);
        warnFn(
          `⚠️ [PASSAGE_LOWCONF_STATIONARY] ${vessel.mmsi}: Accepted passage of `
          + `${vessel.targetBridge} with confidence ${passageResult.confidence.toFixed(2)} `
          + `at SOG ${vessel.sog}kn — vessel will be monitored for ghost behavior`,
        );
      }

      // Mark pending "precis passerat" announcement so UI always shows it
      vessel._pendingPassedAnnouncement = targetBridge.name;

      // Log details for debugging
      if (passageResult.details) {
        this.logger.debug(
          `🔍 [PASSAGE_DETAILS] ${vessel.mmsi}: ${JSON.stringify(passageResult.details)}`,
        );
      }

      // PASSAGE-LATCH: Register passage to prevent temporal paradoxes
      if (this.app.passageLatchService) {
        const direction = this._safeDetermineDirection(vessel.cog);
        this.app.passageLatchService.registerPassage(
          vessel.mmsi.toString(),
          vessel.targetBridge,
          direction,
        );
      }

      // ROUTE ORDER VALIDATOR: Register confirmed passage
      if (this.app.routeOrderValidator) {
        this.app.routeOrderValidator.registerPassage(
          vessel.mmsi.toString(),
          vessel.targetBridge,
          vessel,
        );
      }

      const passageTimestamp = Date.now();
      vessel.lastPassedBridge = vessel.targetBridge;
      vessel.lastPassedBridgeTime = passageTimestamp;

      // FIX U: För nära bro-par, sätt force-waiting för nästa bro
      this._setForceWaitingForCloseBridgePair(vessel, vessel.targetBridge);

      if (!vessel.passedBridges) {
        vessel.passedBridges = [];
      }
      if (!vessel.passedBridges.includes(vessel.targetBridge)) {
        vessel.passedBridges.push(vessel.targetBridge);
        this.logger.debug(
          `📋 [PASSED_BRIDGES_UPDATED] ${vessel.mmsi}: Added ${vessel.targetBridge} to passedBridges list. Current: [${vessel.passedBridges.join(', ')}]`,
        );
      }

      this._activateBridgeOpening(vessel, targetBridge.name, oldVessel, passageResult);

      // Mark pending target transition so it can finalize once outside protection zone
      vessel._pendingTarget = {
        source: vessel.targetBridge,
        next: this._calculateNextTargetBridge(vessel) || null,
        since: Date.now(),
      };

      // FIX U: Cache positive result
      this._passageDetectionCache.set(cacheKey, { timestamp: now, result: true });
      return true;
    }

    // FALLBACK: Legacy tracking for compatibility
    // Track if vessel has EVER been very close to the target bridge
    if ((previousDistance <= 100 || currentDistance <= 100)
        && (!oldVessel._wasCloseToTarget || oldVessel._wasCloseToTarget !== vessel.targetBridge)) {
      vessel._wasCloseToTarget = vessel.targetBridge;
      const closeDistance = Math.min(previousDistance, currentDistance);
      this.logger.debug(
        `🎯 [CLOSE_TO_TARGET] ${vessel.mmsi}: Marking as close to ${vessel.targetBridge} (${closeDistance.toFixed(0)}m)`,
      );
    }

    // DEBUG: Log why passage was not detected - include trajectory details for debugging
    const trajectoryDetails = passageResult.details || {};
    this.logger.debug(
      `${`🔍 [NO_PASSAGE] ${vessel.mmsi} -> ${vessel.targetBridge}: `
      + `prev=${previousDistance.toFixed(0)}m, curr=${currentDistance.toFixed(0)}m, `
      + `method=${passageResult.method}`}${
        trajectoryDetails.trajectoryDistance !== undefined
          ? `, trajectoryDist=${trajectoryDetails.trajectoryDistance.toFixed(0)}m` : ''
      }${trajectoryDetails.lineCrossResult !== undefined
        ? `, lineCross=${trajectoryDetails.lineCrossResult}` : ''}`,
    );

    // IMPORTANT: Log at higher level when vessel is CLOSE to bridge but passage not detected
    // This helps debug cases where Stridsbergsbron/Järnvägsbron passage is missed
    if (currentDistance <= 300 || previousDistance <= 300) {
      this.logger.log(
        `⚠️ [NEAR_MISS_PASSAGE] ${vessel.mmsi}: Near ${vessel.targetBridge} but no passage detected | `
        + `prev=${previousDistance.toFixed(0)}m, curr=${currentDistance.toFixed(0)}m | `
        + `method=${passageResult.method} | `
        + `details=${JSON.stringify(trajectoryDetails)}`,
      );
    }

    // FIX U: Cache negative result
    this._passageDetectionCache.set(cacheKey, { timestamp: now, result: false });
    return false;
  }

  /**
   * Calculate next target bridge based on vessel direction
   * @private
   */
  _calculateNextTargetBridge(vessel) {
    const { COG_DIRECTIONS } = constants;

    // ENHANCED: Validate input parameters
    if (!vessel.targetBridge) {
      this.logger.debug(`⚠️ [NEXT_TARGET] ${vessel.mmsi}: No current target bridge - cannot calculate next`);
      return null;
    }

    if (!Number.isFinite(vessel.cog)) {
      this.logger.debug(`⚠️ [NEXT_TARGET] ${vessel.mmsi}: Invalid COG (${vessel.cog}) - cannot determine next target`);
      return null;
    }

    let isNorthbound = vessel.cog >= COG_DIRECTIONS.NORTH_MIN
      || vessel.cog <= COG_DIRECTIONS.NORTH_MAX;

    // FIX R: Prioritera _finalTargetDirection för korrekt riktning efter passage
    // Detta säkerställer att efter att ha passerat slutmål, returneras null istället för fel bro
    if (vessel._finalTargetDirection) {
      isNorthbound = vessel._finalTargetDirection === 'north';
      this.logger.debug(
        `🧭 [NEXT_TARGET_FINAL] ${vessel.mmsi}: Using finalTargetDirection=${vessel._finalTargetDirection}`,
      );
    } else if (vessel._routeDirection) {
      isNorthbound = vessel._routeDirection === 'north';
      this.logger.debug(
        `🧭 [NEXT_TARGET_ROUTE] ${vessel.mmsi}: Using route direction ${vessel._routeDirection}`,
      );
    }

    const currentTarget = vessel.targetBridge;

    this.logger.debug(
      `🧭 [NEXT_TARGET] ${vessel.mmsi}: Direction=${isNorthbound ? 'Norrut' : 'Söderut'}, Current=${currentTarget}`,
    );

    if (isNorthbound) {
      // Norrut: Klaffbron → Stridsbergsbron → null
      if (currentTarget === 'Klaffbron') {
        this.logger.debug(`🎯 [NEXT_TARGET] ${vessel.mmsi}: Norrut Klaffbron → Stridsbergsbron`);
        return 'Stridsbergsbron';
      }
      // Stridsbergsbron is final target bridge northbound
      this.logger.debug(`🏁 [NEXT_TARGET] ${vessel.mmsi}: Norrut Stridsbergsbron → final (null)`);
      return null;
    }
    // Söderut: Stridsbergsbron → Klaffbron → null
    if (currentTarget === 'Stridsbergsbron') {
      this.logger.debug(`🎯 [NEXT_TARGET] ${vessel.mmsi}: Söderut Stridsbergsbron → Klaffbron`);
      return 'Klaffbron';
    }
    // Klaffbron is final target bridge southbound
    this.logger.debug(`🏁 [NEXT_TARGET] ${vessel.mmsi}: Söderut Klaffbron → final (null)`);
    return null;
  }

  /**
   * Handle GPS-jump detection and position validation (ENHANCED: Direction change aware)
   * @private
   */
  _handleGPSJumpDetection(mmsi, currentPosition, previousPosition, oldVessel, currentAISData) {
    const { MOVEMENT_DETECTION } = constants;

    // Validate current position has valid coordinates
    if (!currentPosition || !Number.isFinite(currentPosition.lat) || !Number.isFinite(currentPosition.lon)) {
      // Return previous position if available, otherwise return invalid position
      return {
        position: previousPosition || { lat: null, lon: null },
        changeTime: oldVessel?.lastPositionChange || Date.now(),
        jumpDetected: false,
        analysis: { reason: 'invalid_coordinates' },
      };
    }

    // TESTING: Skip GPS jump detection for test vessels
    // Convert MMSI to string for comparison (handles both string and number inputs)
    const mmsiStr = String(mmsi);
    if (mmsiStr && mmsiStr.includes('265CONTROL')) {
      this.logger.debug(
        `🧪 [TEST_MODE] Skipping GPS jump detection for test vessel ${mmsiStr}`,
      );
      return {
        position: currentPosition,
        changeTime: Date.now(),
        jumpDetected: false,
        analysis: { reason: 'test_mode' },
      };
    }

    // For new vessels, no previous position to compare
    if (!oldVessel || !previousPosition || !Number.isFinite(previousPosition.lat) || !Number.isFinite(previousPosition.lon)) {
      return {
        position: currentPosition,
        changeTime: Date.now(),
        jumpDetected: false,
        analysis: { reason: 'no_previous_data' },
      };
    }

    // Use new sophisticated GPS jump analyzer
    const currentVessel = {
      cog: currentAISData?.cog || oldVessel?.cog,
      sog: currentAISData?.sog || oldVessel?.sog,
      timestamp: Date.now(),
    };

    const analysis = this.gpsJumpAnalyzer.analyzeMovement(
      mmsi, currentPosition, previousPosition, currentVessel, oldVessel,
    );

    // ENHANCED: Coordinate with SystemCoordinator for improved handling
    const coordination = this.systemCoordinator.coordinatePositionUpdate(
      mmsi, analysis, currentVessel, oldVessel,
    );

    // Determine position change time based on movement
    let positionChangeTime = Date.now();
    if (analysis.movementDistance <= MOVEMENT_DETECTION.MINIMUM_MOVEMENT) {
      // Very small movement - don't update change time
      positionChangeTime = oldVessel.lastPositionChange || Date.now();
    }

    // Handle different analysis results
    let finalPosition = currentPosition;
    const statusFlags = {};

    switch (analysis.action) {
      case 'gps_jump_detected':
        // GPS jump detected - apply smoothing or position filtering
        finalPosition = this._handleDetectedGPSJump(mmsi, currentPosition, previousPosition, analysis);
        statusFlags.gpsJumpDetected = true;
        statusFlags.positionFiltered = finalPosition !== currentPosition;
        break;

      case 'accept_with_caution':
        // Accept but mark as uncertain for status stability
        finalPosition = currentPosition;
        statusFlags.positionUncertain = true;
        this.logger.log(
          `⚠️ [GPS_UNCERTAIN] ${mmsi}: Uncertain movement ${analysis.movementDistance.toFixed(0)}m - `
          + `confidence: ${analysis.confidence} (${analysis.reason})`,
        );
        break;

      case 'accept':
        // Normal acceptance
        finalPosition = currentPosition;
        if (analysis.movementDistance > 500) {
          this.logger.log(
            `✅ [LEGITIMATE_MOVEMENT] ${mmsi}: Large legitimate movement ${analysis.movementDistance.toFixed(0)}m - `
            + `${analysis.reason}`,
          );
        }
        break;

      default:
        // Fallback to current position
        finalPosition = currentPosition;
        break;
    }

    this.logger.debug(
      `📍 [POSITION_TRACKING] ${mmsi}: movement ${analysis.movementDistance.toFixed(1)}m, `
      + `action: ${analysis.action}, updating change time: ${
        analysis.movementDistance > MOVEMENT_DETECTION.MINIMUM_MOVEMENT ? 'YES' : 'NO'
      }`,
    );

    return {
      position: finalPosition,
      changeTime: positionChangeTime,
      jumpDetected: analysis.isGPSJump,
      jumpDistance: analysis.movementDistance,
      analysis,
      coordination,
      ...statusFlags,
    };
  }

  /**
   * Handle detected GPS jump with position smoothing or filtering
   * @private
   */
  _handleDetectedGPSJump(mmsi, currentPosition, previousPosition, analysis) {
    // For now, still accept current position but with heavy logging
    // In future versions, could implement position smoothing or restoration
    this.logger.error(
      `🚨 [GPS_JUMP_DETECTED] ${mmsi}: GPS jump ${analysis.movementDistance.toFixed(0)}m - `
      + `accepting with status stability protection (confidence: ${analysis.confidence})`,
    );

    return currentPosition; // For now, still accept new position
  }

  /**
   * Handle passage of intermediate bridges (non-target bridges) - ENHANCED TRACKING
   * @private
   */
  _handleIntermediateBridgePassage(vessel, oldVessel) {
    if (!oldVessel) return;

    // Check all bridges to see if vessel passed any intermediate bridge
    const allBridgeIds = this.bridgeRegistry.getAllBridgeIds();
    const allBridges = allBridgeIds.map((id) => {
      const bridge = this.bridgeRegistry.getBridge(id);
      return {
        id,
        name: bridge.name,
        ...bridge,
      };
    });

    let passagesDetected = 0;
    let passagesRecorded = 0;

    for (const bridge of allBridges) {
      // Skip if this is the target bridge (already handled above)
      if (bridge.name === vessel.targetBridge) continue;
      // Skip bridges already passed — prevents re-detection after anchor guard expires
      if (vessel.passedBridges && vessel.passedBridges.includes(bridge.name)) continue;

      const hasPassedThisBridge = this._hasPassedBridge(
        vessel,
        oldVessel,
        bridge,
      );

      if (hasPassedThisBridge) {
        passagesDetected++;
        this.logger.log(
          `🌉 [INTERMEDIATE_PASSAGE_DETECTED] ${vessel.mmsi}: Detected passage of intermediate bridge ${bridge.name}`,
        );

        // ENHANCED PASSAGE RECORDING: Always record intermediate bridge passages
        const passageTimestamp = Date.now();

        // Anchor the intermediate passage timestamp if not already done
        if (this._anchorPassageTimestamp(vessel, bridge.name, passageTimestamp)) {
          const passageId = this._generatePassageId(vessel.mmsi, bridge.name, vessel);

          if (!this._isPassageAlreadyProcessed(passageId)) {
            vessel.lastPassedBridgeTime = passageTimestamp;
            vessel.lastPassedBridge = bridge.name;

            // FIX U: För nära bro-par, sätt force-waiting för nästa bro
            this._setForceWaitingForCloseBridgePair(vessel, bridge.name);

            this._markPassageProcessed(passageId);
            passagesRecorded++;
            this.logger.log(
              `📝 [INTERMEDIATE_PASSAGE_RECORDED] ${vessel.mmsi}: Recorded passage of intermediate bridge ${bridge.name} `
              + `(was lastPassed: ${oldVessel.lastPassedBridge || 'none'})`,
            );
            this.logger.debug(`🆔 [INTERMEDIATE_PASSAGE_ID] ${vessel.mmsi}: Recorded unique intermediate passage ${passageId}`);
          } else {
            this.logger.debug(`🚫 [INTERMEDIATE_PASSAGE_DUPLICATE] ${vessel.mmsi}: Skipping duplicate intermediate passage ${passageId}`);
          }
        }

        // ALWAYS add to passed bridges list for comprehensive tracking
        if (!vessel.passedBridges) vessel.passedBridges = [];
        if (!vessel.passedBridges.includes(bridge.name)) {
          vessel.passedBridges.push(bridge.name);
          this.logger.debug(
            `📋 [PASSED_BRIDGES_UPDATED] ${vessel.mmsi}: Added ${bridge.name} to passedBridges list. Current: [${vessel.passedBridges.join(', ')}]`,
          );
        }

        break; // Only handle one bridge passage per update
      }
    }

    // Summary logging for passage tracking audit
    if (passagesDetected > 0) {
      this.logger.log(
        `📊 [PASSAGE_TRACKING_SUMMARY] ${vessel.mmsi}: Detected ${passagesDetected} passage(s), recorded ${passagesRecorded} `
        + `(currentLastPassed: ${vessel.lastPassedBridge || 'none'})`,
      );
    }
  }

  /**
   * Check if vessel has passed a specific bridge (ENHANCED: Uses comprehensive detection)
   * @private
   */
  _hasPassedBridge(vessel, oldVessel, bridge) {
    // GPS-JUMP GATING: Check if passage detection should be blocked for intermediate bridge
    if (this.app.gpsJumpGateService
        && this.app.gpsJumpGateService.shouldBlockPassageDetection(vessel.mmsi.toString(), vessel, bridge.name)) {

      // USE ENHANCED PASSAGE DETECTION: But register as candidate instead of confirming
      const passageResult = geometry.detectBridgePassage(vessel, oldVessel, bridge);

      if (passageResult.passed) {
        // Register as candidate for later confirmation
        this.app.gpsJumpGateService.registerCandidatePassage(
          vessel.mmsi.toString(),
          bridge.name,
          passageResult,
          vessel,
        );

        this.logger.debug(`🛡️ [GPS_GATE] ${vessel.mmsi}: Passage of ${bridge.name} registered as candidate (gated)`);
      }

      return false; // Blocked by gating
    }

    // USE ENHANCED PASSAGE DETECTION: Normal detection when not gated
    const passageResult = geometry.detectBridgePassage(vessel, oldVessel, bridge);

    if (passageResult.passed) {
      // ROUTE ORDER VALIDATION: Check if this passage order makes sense for intermediate bridge
      if (this.app.routeOrderValidator) {
        const validationResult = this.app.routeOrderValidator.validatePassageOrder(
          vessel.mmsi.toString(),
          bridge.name,
          vessel,
        );

        if (!validationResult.valid) {
          this.logger.debug(`🚫 [ROUTE_ORDER] ${vessel.mmsi}: Passage of ${bridge.name} blocked - ${validationResult.reason} (confidence: ${validationResult.confidence})`);
          return false; // Block passage due to invalid order
        }
      }

      this.logger.log(
        `🌉 [BRIDGE_PASSED] ${vessel.mmsi}: Passed bridge ${bridge.name} `
        + `(method: ${passageResult.method}, confidence: ${passageResult.confidence.toFixed(2)})`,
      );

      // Log details for debugging
      if (passageResult.details) {
        this.logger.debug(
          `🔍 [PASSAGE_DETAILS] ${vessel.mmsi}: ${JSON.stringify(passageResult.details)}`,
        );
      }

      // PASSAGE-LATCH: Register passage for intermediate bridges too
      if (this.app.passageLatchService) {
        const direction = this._safeDetermineDirection(vessel.cog);
        this.app.passageLatchService.registerPassage(
          vessel.mmsi.toString(),
          bridge.name,
          direction,
        );
      }

      // ROUTE ORDER VALIDATOR: Register confirmed intermediate bridge passage
      if (this.app.routeOrderValidator) {
        this.app.routeOrderValidator.registerPassage(
          vessel.mmsi.toString(),
          bridge.name,
          vessel,
        );
      }

      this._activateBridgeOpening(vessel, bridge.name, oldVessel, passageResult);

      return true;
    }

    // DEBUG: Log why passage was not detected (only if vessel was reasonably close)
    const currentDistance = geometry.calculateDistance(
      vessel.lat,
      vessel.lon,
      bridge.lat,
      bridge.lon,
    );
    const previousDistance = geometry.calculateDistance(
      oldVessel.lat,
      oldVessel.lon,
      bridge.lat,
      bridge.lon,
    );

    // Only log detailed debug if vessel was close to bridge
    if (Math.min(currentDistance, previousDistance) <= 300) {
      this.logger.debug(
        `🔍 [NO_PASSAGE] ${vessel.mmsi} -> ${bridge.name}: `
        + `prev=${previousDistance.toFixed(0)}m, curr=${currentDistance.toFixed(0)}m, `
        + `method=${passageResult.method}`,
      );
    }

    return false;
  }

  /**
   * Activate bridge opening window when passage is detected.
   * Sets _bridgeOpeningUntil for Phase 3 display (30s "Broöppning pågår").
   * @private
   */
  _activateBridgeOpening(vessel, bridgeName, oldVessel, passageResult = null) {
    const duration = constants.PASSAGE_TIMING?.BRIDGE_OPENING_DURATION;
    if (!vessel || !bridgeName || !Number.isFinite(duration) || duration <= 0) {
      return;
    }

    this._markPendingUnderBridge(vessel, bridgeName);

    // Bug C fix: bridge-aware latch — only block if SAME bridge is already latched
    const oldBridge = oldVessel?.currentBridge;
    const blockedBySameBridge = (oldVessel?._underBridgeLatched && oldBridge === bridgeName)
      || (oldVessel?.status === 'under-bridge' && oldBridge === bridgeName)
      || (vessel._underBridgeLatched && vessel.currentBridge === bridgeName);
    if (blockedBySameBridge) {
      return;
    }

    const now = Date.now();
    if (vessel._bridgeOpeningUntil && vessel._bridgeOpeningUntil > now) {
      vessel._bridgeOpeningUntil = now + duration;
      vessel._bridgeOpeningBridgeName = bridgeName;
      this.logger.debug(
        `🕒 [BRIDGE_OPENING] ${vessel.mmsi}: Extended bridge opening for ${bridgeName} `
        + `(${((vessel._bridgeOpeningUntil - now) / 1000).toFixed(1)}s)`,
      );
      return;
    }

    // J3/K2: Guard — don't re-activate if recently completed for the same bridge
    // Uses _bridgeOpeningUntil (not lastPassedBridge) since lastPassedBridge may not
    // be updated yet when called from _hasPassedBridge
    if (vessel._bridgeOpeningBridgeName === bridgeName
        && vessel._bridgeOpeningUntil
        && (now - vessel._bridgeOpeningUntil) < constants.PASSAGE_TIMING.PASSED_HOLD_MS) {
      this.logger.debug(
        `[BRIDGE_OPENING] ${vessel.mmsi}: Skipped re-activation for ${bridgeName} — recently completed`,
      );
      return;
    }

    let minDistance = Infinity;
    const details = passageResult?.details || {};
    if (Number.isFinite(details.previousDistance)) {
      minDistance = Math.min(minDistance, details.previousDistance);
    }
    if (Number.isFinite(details.currentDistance)) {
      minDistance = Math.min(minDistance, details.currentDistance);
    }
    if (Number.isFinite(oldVessel?.distanceToCurrent)) {
      minDistance = Math.min(minDistance, oldVessel.distanceToCurrent);
    }
    if (Number.isFinite(vessel?.distanceToCurrent)) {
      minDistance = Math.min(minDistance, vessel.distanceToCurrent);
    }

    // Allow bridge opening if passage just confirmed (passageResult !== null),
    // even if vessel is physically within 50m. AIS sampling can miss the window.
    if (minDistance <= constants.UNDER_BRIDGE_SET_DISTANCE && !passageResult) {
      return;
    }

    vessel._bridgeOpeningUntil = now + duration;
    vessel._bridgeOpeningBridgeName = bridgeName;
    vessel._bridgeOpeningTextShown = false;
    vessel._bridgeOpeningLogged = null;
    this.logger.debug(
      `🕒 [BRIDGE_OPENING] ${vessel.mmsi}: Activated bridge opening for ${bridgeName} `
      + `(${(duration / 1000).toFixed(1)}s, method=${passageResult?.method || 'unknown'})`,
    );

    // Passage cooldown prevents double detection — use INTERMEDIATE_PASSAGE_COOLDOWN_MS
    // for all bridges (PASSED_HOLD_MS is now the display-only hold time)
    const cooldownDuration = constants.INTERMEDIATE_PASSAGE_COOLDOWN_MS;
    if (cooldownDuration && cooldownDuration > 0) {
      this._setPassageCooldown(vessel, bridgeName, cooldownDuration);
    }
  }

  /**
   * Track that we still need to announce "Broöppning pågår" before "precis passerat".
   * @private
   */
  _markPendingUnderBridge(vessel, bridgeName) {
    if (!vessel || !bridgeName) {
      return;
    }
    const now = Date.now();
    vessel._pendingUnderBridgeBridgeName = bridgeName;
    vessel._pendingUnderBridgeSetAt = now;
    if (!vessel.currentBridge || vessel.currentBridge === bridgeName) {
      vessel.currentBridge = bridgeName;
      const syntheticDistance = constants.UNDER_BRIDGE_SET_DISTANCE * 0.6;
      if (!Number.isFinite(vessel.distanceToCurrent)
          || vessel.distanceToCurrent > constants.UNDER_BRIDGE_SET_DISTANCE) {
        vessel.distanceToCurrent = syntheticDistance;
      }
    }
  }

  /**
   * Lock vessel route direction for a short period to avoid oscillations.
   * @private
   */
  _lockRouteDirection(vessel, direction, lockMs = constants.ROUTE_DIRECTION_LOCK_MS) {
    if (!vessel || !direction) {
      return;
    }

    vessel._routeDirection = direction;

    if (!Number.isFinite(lockMs) || lockMs <= 0) {
      vessel._routeDirectionLockUntil = null;
      return;
    }

    vessel._routeDirectionLockUntil = Date.now() + lockMs;
    this.logger.debug(
      `🧭 [ROUTE_DIRECTION_LOCK] ${vessel.mmsi}: Locked direction ${direction} for ${(lockMs / 1000).toFixed(0)}s`,
    );
  }

  /**
   * Apply passage cooldown to defer waiting/approaching states after a passage.
   * @private
   */
  _setPassageCooldown(vessel, bridgeName, durationMs) {
    if (!vessel || !bridgeName || !Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }

    if (!vessel._passageCooldowns) {
      vessel._passageCooldowns = Object.create(null);
    }

    const expiresAt = Date.now() + durationMs;
    vessel._passageCooldowns[bridgeName] = expiresAt;
    this.logger.debug(
      `🛡️ [PASSAGE_COOLDOWN] ${vessel.mmsi}: Cooldown for ${bridgeName} set to ${(durationMs / 1000).toFixed(0)}s`,
    );
  }

  /**
   * Log vessel passage tracking status (for audit purposes)
   * @param {Object} vessel - Vessel object
   * @private
   */
  _logPassageTrackingStatus(vessel) {
    const hasPassageData = vessel.lastPassedBridge || (vessel.passedBridges && vessel.passedBridges.length > 0);

    if (hasPassageData) {
      const timeSincePassage = vessel.lastPassedBridgeTime ? Math.round((Date.now() - vessel.lastPassedBridgeTime) / 1000) : 'unknown';
      this.logger.debug(
        `📋 [PASSAGE_AUDIT] ${vessel.mmsi}: lastPassedBridge=${vessel.lastPassedBridge || 'none'}, `
        + `timeSince=${timeSincePassage}s, passedBridges=[${(vessel.passedBridges || []).join(', ')}], `
        + `targetBridge=${vessel.targetBridge || 'none'}`,
      );
    }
  }

  /**
   * Remove vessel from all bridge associations
   * @private
   */
  _removeFromBridgeAssociations(mmsi) {
    for (const vesselSet of this.bridgeVessels.values()) {
      vesselSet.delete(mmsi);
    }
  }

  /**
   * ENHANCED: Check and apply target bridge protection
   * Prevents target bridge changes during GPS events, maneuvers, and close approaches
   * @private
   * @param {Object} vessel - Current vessel data
   * @param {Object} oldVessel - Previous vessel data
   * @returns {boolean} True if protection is active (blocks target bridge changes)
   */
  _checkTargetBridgeProtection(vessel, oldVessel) {
    if (!vessel.targetBridge || !oldVessel) {
      return false;
    }

    const { mmsi } = vessel;
    const currentTime = Date.now();

    // Get current protection state
    let protection = this.targetBridgeProtection.get(mmsi) || {
      isActive: false,
      reason: null,
      startTime: null,
      targetBridge: null,
      confidence: 1.0,
      gpsEventDetected: false,
      closeToTarget: false,
      maneuverDetected: false,
    };

    // Calculate distance to current target bridge
    const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
    const distanceToTarget = targetBridge ? geometry.calculateDistance(
      vessel.lat, vessel.lon, targetBridge.lat, targetBridge.lon,
    ) : 9999;

    // PROTECTION CONDITION 1: Distance-based protection (300m zone)
    const isInProtectionZone = distanceToTarget <= 300;

    // PROTECTION CONDITION 2: GPS event protection
    const gpsEventActive = this._detectGPSEventProtection(vessel, oldVessel);

    // PROTECTION CONDITION 3: Maneuver detection protection
    const maneuverActive = this._detectManeuverProtection(vessel, oldVessel);

    // PROTECTION CONDITION 4: Recent passage protection (60s after passing a bridge)
    const recentPassageActive = vessel.lastPassedBridgeTime
      && (currentTime - vessel.lastPassedBridgeTime) < 60000;

    // PROTECTION CONDITION 5: FIXED - Coordination state protection
    const coordinationActive = vessel._coordinationActive || protection.coordinationActive;

    // Determine if protection should be activated
    const shouldActivateProtection = isInProtectionZone || gpsEventActive
      || maneuverActive || recentPassageActive || coordinationActive;

    if (shouldActivateProtection && !protection.isActive) {
      // Activate protection
      protection = {
        isActive: true,
        reason: this._getProtectionReason(isInProtectionZone, gpsEventActive, maneuverActive, recentPassageActive, coordinationActive),
        startTime: currentTime,
        targetBridge: vessel.targetBridge,
        confidence: this._calculateProtectionConfidence(vessel, oldVessel),
        gpsEventDetected: gpsEventActive,
        closeToTarget: isInProtectionZone,
        maneuverDetected: maneuverActive,
        distanceToTarget,
      };

      this.targetBridgeProtection.set(mmsi, protection);
      this._scheduleProtectionTimeout(mmsi);

      this.logger.log(
        `🛡️ [TARGET_PROTECTION_ACTIVATED] ${mmsi}: Protecting target bridge ${vessel.targetBridge} `
        + `(${protection.reason}, distance: ${distanceToTarget.toFixed(0)}m, confidence: ${protection.confidence.toFixed(2)})`,
      );

    } else if (protection.isActive) {
      // Update existing protection
      protection.distanceToTarget = distanceToTarget;
      protection.closeToTarget = isInProtectionZone;
      protection.gpsEventDetected = gpsEventActive;
      protection.maneuverDetected = maneuverActive;
      protection.coordinationActive = coordinationActive;

      // Check if protection should be deactivated
      const shouldDeactivate = this._shouldDeactivateProtection(protection, vessel, currentTime);

      if (shouldDeactivate) {
        this._deactivateProtection(mmsi, protection.reason);
        return false;
      }

      // Update vessel's target bridge to protected value if it was changed
      if (vessel.targetBridge !== protection.targetBridge) {
        this.logger.log(
          `🛡️ [TARGET_PROTECTION_RESTORE] ${mmsi}: Restoring target bridge from `
          + `${vessel.targetBridge} to ${protection.targetBridge} (protection active)`,
        );
        vessel.targetBridge = protection.targetBridge;
      }
    }

    return protection.isActive;
  }

  /**
   * ENHANCED: Detect GPS event requiring protection
   * @private
   */
  _detectGPSEventProtection(vessel, oldVessel) {
    // Check for GPS jump detected by analyzer
    if (vessel._gpsJumpDetected) {
      return true;
    }

    // Check for position uncertainty
    if (vessel._positionUncertain) {
      return true;
    }

    // Check for large movement that might be GPS error
    const movementDistance = geometry.calculateDistance(
      oldVessel.lat, oldVessel.lon,
      vessel.lat, vessel.lon,
    );

    if (movementDistance > 200) { // Large movement requiring caution
      return true;
    }

    return false;
  }

  /**
   * ENHANCED: Detect maneuver requiring protection
   * @private
   */
  _detectManeuverProtection(vessel, oldVessel) {
    // Large COG change indicating maneuver
    if (Number.isFinite(vessel.cog) && Number.isFinite(oldVessel.cog)) {
      let cogChange = Math.abs(vessel.cog - oldVessel.cog);
      if (cogChange > 180) {
        cogChange = 360 - cogChange;
      }

      if (cogChange > 45) { // Significant direction change
        return true;
      }
    }

    // Rapid speed change indicating maneuver
    const speedChange = Math.abs((vessel.sog || 0) - (oldVessel.sog || 0));
    if (speedChange > 2.0) { // Significant speed change
      return true;
    }

    return false;
  }

  /**
   * ENHANCED: Get protection reason for logging
   * @private
   */
  _getProtectionReason(isInZone, gpsEvent, maneuver, recentPassage, coordination) {
    const reasons = [];
    if (isInZone) reasons.push('proximity');
    if (gpsEvent) reasons.push('gps-event');
    if (maneuver) reasons.push('maneuver');
    if (recentPassage) reasons.push('recent-passage');
    if (coordination) reasons.push('coordination');
    return reasons.join('+');
  }

  /**
   * ENHANCED: Calculate protection confidence
   * @private
   */
  _calculateProtectionConfidence(vessel, oldVessel) {
    let confidence = 1.0;

    // Reduce confidence for GPS events
    if (vessel._gpsJumpDetected) {
      confidence *= 0.7;
    }
    if (vessel._positionUncertain) {
      confidence *= 0.8;
    }

    // Increase confidence for proximity
    const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
    if (targetBridge) {
      const distance = geometry.calculateDistance(
        vessel.lat, vessel.lon, targetBridge.lat, targetBridge.lon,
      );
      if (distance <= 100) {
        confidence = Math.min(1.0, confidence + 0.2);
      }
    }

    return confidence;
  }

  /**
   * ENHANCED: Check if protection should be deactivated
   * @private
   */
  _shouldDeactivateProtection(protection, vessel, currentTime) {
    const protectionDuration = currentTime - protection.startTime;
    const maxProtectionTime = 300000; // 5 minutes maximum protection

    // Deactivate if maximum time exceeded
    if (protectionDuration > maxProtectionTime) {
      return true;
    }

    // Deactivate if far from target and no GPS events or coordination
    if (protection.distanceToTarget > 500
        && !protection.gpsEventDetected
        && !protection.maneuverDetected
        && !protection.coordinationActive
        && protectionDuration > 60000) { // 1 minute minimum for distance-based
      return true;
    }

    // Deactivate if GPS events resolved and sufficient time passed
    if (protection.gpsEventDetected
        && !vessel._gpsJumpDetected
        && !vessel._positionUncertain
        && protectionDuration > 30000) { // 30 seconds for GPS events
      return true;
    }

    // FIXED: Deactivate if coordination is no longer active and sufficient time passed
    if (protection.coordinationActive
        && !vessel._coordinationActive
        && protectionDuration > 15000) { // 15 seconds for coordination
      return true;
    }

    return false;
  }

  /**
   * ENHANCED: Deactivate protection
   * @private
   */
  _deactivateProtection(mmsi, reason) {
    const protection = this.targetBridgeProtection.get(mmsi);
    if (protection) {
      const duration = Date.now() - protection.startTime;
      this.logger.log(
        `🛡️ [TARGET_PROTECTION_DEACTIVATED] ${mmsi}: Protection ended after ${(duration / 1000).toFixed(1)}s `
        + `(reason: ${reason})`,
      );

      this.targetBridgeProtection.delete(mmsi);
      this._clearProtectionTimer(mmsi);
    }
  }

  /**
   * ENHANCED: Schedule protection timeout
   * @private
   */
  _scheduleProtectionTimeout(mmsi) {
    this._clearProtectionTimer(mmsi);

    const timer = setTimeout(() => {
      this._deactivateProtection(mmsi, 'timeout');
    }, 300000); // 5 minutes maximum protection

    this.protectionTimers.set(mmsi, timer);
  }

  /**
   * ENHANCED: Clear protection timer
   * @private
   */
  _clearProtectionTimer(mmsi) {
    const timer = this.protectionTimers.get(mmsi);
    if (timer) {
      clearTimeout(timer);
      this.protectionTimers.delete(mmsi);
    }
  }

  /**
   * Check if vessel is near Stallbackabron bridge for bridge text inclusion
   * @private
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if vessel is near Stallbackabron with relevant status
   */
  _isVesselNearStallbackabron(vessel) {
    // Validate vessel object and coordinates
    if (!vessel || !vessel.mmsi || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
      return false;
    }

    // Get Stallbackabron bridge from registry
    const stallbackabron = this.bridgeRegistry.getBridgeByName('Stallbackabron');
    if (!stallbackabron || !Number.isFinite(stallbackabron.lat) || !Number.isFinite(stallbackabron.lon)) {
      this.logger.debug(`⚠️ [STALLBACKABRON_CHECK] ${vessel.mmsi}: Stallbackabron not found in registry`);
      return false;
    }

    // Calculate distance to Stallbackabron
    const distance = geometry.calculateDistance(
      vessel.lat, vessel.lon,
      stallbackabron.lat, stallbackabron.lon,
    );

    // Check if distance calculation failed
    if (!Number.isFinite(distance)) {
      this.logger.debug(`⚠️ [STALLBACKABRON_CHECK] ${vessel.mmsi}: Failed to calculate distance to Stallbackabron`);
      return false;
    }

    // STALLBACKABRON SPECIAL RULES: Include vessel if:
    // 1. Within approaching radius (500m) AND has relevant status
    // 2. Has stallbacka-waiting status (special Stallbackabron status)
    // 3. Is under-bridge at Stallbackabron (though this should be rare)
    const isWithinApproachingRadius = distance <= constants.APPROACHING_RADIUS; // 500m
    const hasStallbackaStatus = vessel.status === 'stallbacka-waiting';
    const isUnderStallbackabron = vessel.status === 'under-bridge' && vessel.currentBridge === 'Stallbackabron';

    // Check if vessel has relevant status for bridge text
    const relevantStatuses = [
      'approaching', // <500m from Stallbackabron
      'stallbacka-waiting', // <300m from Stallbackabron (special status)
      'under-bridge', // <50m from Stallbackabron (rare but possible)
      'passed', // Recently passed Stallbackabron
    ];
    const hasRelevantStatus = relevantStatuses.includes(vessel.status);

    // CRITICAL: Only include if near Stallbackabron AND has relevant status AND has valid target bridge
    // FIX: Exclude vessels without targetBridge (leaving the canal system)
    const shouldInclude = (isWithinApproachingRadius || hasStallbackaStatus || isUnderStallbackabron) && hasRelevantStatus && vessel.targetBridge != null;

    if (shouldInclude) {
      this.logger.debug(
        `✅ [STALLBACKABRON_NEAR] ${vessel.mmsi}: Near Stallbackabron (${distance.toFixed(0)}m, status=${vessel.status}, target=${vessel.targetBridge}) - including in bridge text`,
      );
    } else if (isWithinApproachingRadius) {
      let reason = 'unknown';
      if (!hasRelevantStatus) {
        reason = `irrelevant status (${vessel.status})`;
      } else if (!vessel.targetBridge) {
        reason = 'no target bridge (leaving canal)';
      }
      this.logger.debug(
        `❌ [STALLBACKABRON_EXCLUDED] ${vessel.mmsi}: Near Stallbackabron (${distance.toFixed(0)}m) but ${reason}`,
      );
    }

    return shouldInclude;
  }

  /**
   * Get specific reason for target bridge removal (instead of generic ANCHORED/SLOW)
   * @private
   * @param {Object} vessel - Current vessel object
   * @param {Object} oldVessel - Previous vessel object
   * @returns {string} Specific reason for removal
   */
  _getTargetRemovalReason(vessel, oldVessel) {
    const windowMs = constants.PASSAGE_CLEAR_WINDOW_MS * 2; // Allow extra buffer after passage
    const now = Date.now();
    const wasRecentPassage = (bridgeName, time) => (
      bridgeName
      && Number.isFinite(time)
      && (now - time) < windowMs
    );

    if (oldVessel?.targetBridge) {
      if (wasRecentPassage(vessel.lastPassedBridge, vessel.lastPassedBridgeTime)
        && vessel.lastPassedBridge === oldVessel.targetBridge) {
        return 'RECENT_PASSAGE_PROTECTED';
      }

      if (wasRecentPassage(oldVessel.lastPassedBridge, oldVessel.lastPassedBridgeTime)
        && oldVessel.lastPassedBridge === oldVessel.targetBridge) {
        return 'RECENT_PASSAGE_PROTECTED';
      }
    }

    // Check GPS state
    if (vessel._gpsJumpDetected) {
      return 'GPS_JUMP';
    }
    if (vessel._positionUncertain) {
      return 'GPS_UNCERTAIN';
    }

    // Check speed
    const speed = Number(vessel.sog);
    if (!Number.isFinite(speed) || speed < 0.5) {
      return speed === 0 ? 'STOPPED' : 'LOW_SPEED';
    }

    // Check course
    if (!Number.isFinite(vessel.cog) || vessel.cog < 0 || vessel.cog >= 360) {
      return 'INVALID_COURSE';
    }

    // Check approach direction (if we have previous position)
    if (oldVessel && oldVessel.targetBridge && oldVessel.lat && oldVessel.lon) {
      const targetBridge = this.bridgeRegistry.getBridgeByName(oldVessel.targetBridge);
      if (targetBridge && targetBridge.lat && targetBridge.lon) {
        const previousDistance = geometry.calculateDistance(
          oldVessel.lat, oldVessel.lon,
          targetBridge.lat, targetBridge.lon,
        );
        const currentDistance = geometry.calculateDistance(
          vessel.lat, vessel.lon,
          targetBridge.lat, targetBridge.lon,
        );
        const distanceChange = previousDistance - currentDistance;

        if (distanceChange < 0 && currentDistance > 300) {
          return 'MOVING_AWAY';
        }
        if (Math.abs(distanceChange) < constants.MIN_APPROACH_DISTANCE && currentDistance > 300) {
          return 'INSUFFICIENT_MOVEMENT';
        }
      }
    }

    // Check if outside bounds
    if (!this._isWithinCanalBounds(vessel)) {
      return 'OUTSIDE_BOUNDS';
    }

    // Generic fallback
    return 'ANCHORED';
  }

  /**
   * Check if vessel is within Göta Kanal geographical bounds
   * Uses AIS_CONFIG.BOUNDING_BOX for consistent bounds checking
   * @private
   * @param {Object} vessel - Vessel object with lat/lon coordinates
   * @returns {boolean} True if vessel is within canal bounds
   */
  _isWithinCanalBounds(vessel) {
    // Validate vessel has coordinates
    if (!vessel || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
      return false;
    }

    const { BOUNDING_BOX } = constants.AIS_CONFIG;

    // Check if coordinates are within bounds
    const withinBounds = vessel.lat >= BOUNDING_BOX.SOUTH
      && vessel.lat <= BOUNDING_BOX.NORTH
      && vessel.lon >= BOUNDING_BOX.WEST
      && vessel.lon <= BOUNDING_BOX.EAST;

    if (!withinBounds) {
      this.logger.debug(
        `🚪 [BOUNDS_CHECK] ${vessel.mmsi}: Outside canal bounds `
        + `(lat=${vessel.lat.toFixed(6)}, lon=${vessel.lon.toFixed(6)})`,
      );
    }

    return withinBounds;
  }

  /**
   * Check if vessel is within protection zone of any bridge
   * @private
   * @param {Object} vessel - Vessel object
   * @returns {Object} Protection zone status with details
   */
  _isInProtectionZone(vessel) {
    const { PROTECTION_ZONE_RADIUS } = constants;

    // FIXED: During GPS instability, be more conservative with protection zones
    let protectionRadius = PROTECTION_ZONE_RADIUS;
    if (vessel._gpsJumpDetected || vessel._positionUncertain) {
      protectionRadius = Math.max(PROTECTION_ZONE_RADIUS, 500); // Expand protection during GPS issues
      this.logger.debug(
        `🛡️ [PROTECTION_ZONE] ${vessel.mmsi}: GPS instability detected - expanding protection radius to ${protectionRadius}m`,
      );
    }

    for (const bridge of Object.values(this.bridgeRegistry.bridges)) {
      const distance = geometry.calculateDistance(
        vessel.lat,
        vessel.lon,
        bridge.lat,
        bridge.lon,
      );

      if (distance <= protectionRadius) {
        return {
          isProtected: true,
          bridge: bridge.name,
          distance: distance.toFixed(0),
        };
      }
    }

    return { isProtected: false };
  }

  /**
   * Generate unique passage ID anchored to actual crossing event
   * @param {string} mmsi - Vessel MMSI
   * @param {string} bridgeName - Bridge name
   * @param {Object} vessel - Vessel object to check for anchored timestamp
   * @returns {string} Unique passage ID
   */
  _generatePassageId(mmsi, bridgeName, vessel) {
    // Use anchored crossing timestamp if available (from under-bridge exit)
    if (vessel.passedAt && vessel.passedAt[bridgeName]) {
      const crossingTimestamp = vessel.passedAt[bridgeName];
      return `${mmsi}-${bridgeName}-${Math.floor(crossingTimestamp / 1000)}`;
    }

    // Fallback for non-crossing events (should rarely happen)
    return `${mmsi}-${bridgeName}-${Math.floor(Date.now() / 1000)}`;
  }

  /**
   * Anchor passage timestamp to prevent duplicate passage detection
   * @param {Object} vessel - Vessel object
   * @param {string} bridgeName - Bridge name
   * @param {number} crossingTimestamp - Timestamp of passage
   * @returns {boolean} True if timestamp was anchored, false if already anchored
   * @public - Used by StatusService for passage deduplication
   */
  anchorPassageTimestamp(vessel, bridgeName, crossingTimestamp) {
    return this._anchorPassageTimestamp(vessel, bridgeName, crossingTimestamp);
  }

  /**
   * Check if passage has already been processed
   * @param {string} passageId - Unique passage ID
   * @returns {boolean} True if already processed
   */
  _isPassageAlreadyProcessed(passageId) {
    return this.processedPassages.has(passageId);
  }

  /**
   * Mark passage as processed
   * @param {string} passageId - Unique passage ID
   */
  _markPassageProcessed(passageId) {
    this.processedPassages.add(passageId);

    // Cleanup old passages (older than 5 minutes)
    setTimeout(() => {
      this.processedPassages.delete(passageId);
    }, 5 * 60 * 1000);
  }

  /**
   * Record anchored crossing timestamp for passage deduplication
   * @param {Object} vessel - Vessel object
   * @param {string} bridgeName - Bridge name
   * @param {number} crossingTimestamp - Actual crossing timestamp
   */
  _anchorPassageTimestamp(vessel, bridgeName, crossingTimestamp) {
    if (!vessel.passedAt) vessel.passedAt = {};

    // Check for reverse re-cross guard
    const existingTimestamp = vessel.passedAt[bridgeName];
    if (existingTimestamp) {
      const timeSinceLast = crossingTimestamp - existingTimestamp;
      if (timeSinceLast < 3 * 60 * 1000) { // 3 minute guard
        this.logger.debug(`🚫 [REVERSE_RECRROSS_GUARD] ${vessel.mmsi}: Ignoring potential bounce at ${bridgeName} (${(timeSinceLast / 1000).toFixed(0)}s since last)`);
        return false;
      }
    }

    vessel.passedAt[bridgeName] = crossingTimestamp;
    this.logger.debug(`⚓ [ANCHOR_PASSAGE] ${vessel.mmsi}: Anchored ${bridgeName} crossing at ${new Date(crossingTimestamp).toISOString()}`);
    return true;
  }

  /**
   * FIX U: Set force-waiting flag for close bridge pairs (Järnvägsbron ↔ Stridsbergsbron)
   * This ensures the "inväntar broöppning" phase is shown before "Broöppning pågår"
   * even when AIS updates skip the normal waiting zone distance.
   * @private
   * @param {Object} vessel - Vessel object
   * @param {string} passedBridgeName - Name of the bridge that was just passed
   */
  _setForceWaitingForCloseBridgePair(vessel, passedBridgeName) {
    const CLOSE_BRIDGE_PAIRS = {
      Stridsbergsbron: 'Järnvägsbron',
      Järnvägsbron: 'Stridsbergsbron',
    };

    const pairedBridge = CLOSE_BRIDGE_PAIRS[passedBridgeName];
    if (pairedBridge) {
      vessel._forceWaitingAtBridge = {
        bridge: pairedBridge,
        until: Date.now() + 90000, // 90 sekunder (täcker 1-2 AIS-cykler)
        triggeredBy: passedBridgeName,
      };
      this.logger.debug(
        `🔄 [FIX_U_SET] ${vessel.mmsi}: Force waiting at ${pairedBridge} after passing ${passedBridgeName}`,
      );
    }
  }

  /**
   * Set GPS jump hold for vessel
   * @param {string} mmsi - Vessel MMSI
   * @param {number} holdDurationMs - Hold duration in milliseconds
   */
  setGpsJumpHold(mmsi, holdDurationMs = 2000) {
    const holdUntil = Date.now() + holdDurationMs;
    this.gpsJumpHolds.set(mmsi, holdUntil);
    this.logger.debug(`🛡️ [GPS_JUMP_HOLD] ${mmsi}: Bridge text publishing held for ${holdDurationMs}ms`);

    // Auto-clear hold
    setTimeout(() => {
      this.gpsJumpHolds.delete(mmsi);
      this.logger.debug(`✅ [GPS_JUMP_HOLD_CLEAR] ${mmsi}: Bridge text publishing resumed`);
    }, holdDurationMs);
  }

  /**
   * Check if vessel has active GPS jump hold
   * @param {string} mmsi - Vessel MMSI
   * @returns {boolean} True if hold is active
   */
  hasGpsJumpHold(mmsi) {
    const holdUntil = this.gpsJumpHolds.get(mmsi);
    if (!holdUntil) return false;

    if (Date.now() > holdUntil) {
      this.gpsJumpHolds.delete(mmsi);
      return false;
    }

    return true;
  }

  /**
   * Determine direction based on COG
   * @private
   */
  _determineDirection(cog) {
    if (typeof cog !== 'number' || !Number.isFinite(cog)) {
      return null;
    }

    // Normalisera COG till [0, 360)
    const normalizedCog = ((cog % 360) + 360) % 360;

    // Norrut: 315° till 45° (via 360°/0°)
    if (normalizedCog >= 315 || normalizedCog <= 45) {
      return 'north';
    }

    // Söderut: 135° till 225°
    if (normalizedCog >= 135 && normalizedCog <= 225) {
      return 'south';
    }

    // Oklart - mellan norrut och söderut
    return null;
  }

  /**
   * Safe wrapper for direction resolution to avoid runtime errors
   * if prototype method is missing in packaged builds.
   * @private
   */
  _safeDetermineDirection(cog) {
    try {
      if (this && typeof this._determineDirection === 'function') {
        return this._determineDirection(cog);
      }
    } catch (e) {
      // Fallback below
    }

    if (typeof cog !== 'number' || !Number.isFinite(cog)) {
      return null;
    }

    const normalizedCog = ((cog % 360) + 360) % 360;
    if (normalizedCog >= 315 || normalizedCog <= 45) return 'north';
    if (normalizedCog >= 135 && normalizedCog <= 225) return 'south';
    return null;
  }
}

module.exports = VesselDataService;
