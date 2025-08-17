'use strict';

const EventEmitter = require('events');
const geometry = require('../utils/geometry');
const constants = require('../constants');
const GPSJumpAnalyzer = require('../utils/GPSJumpAnalyzer');
const SystemCoordinator = require('./SystemCoordinator');
const PassageWindowManager = require('../utils/PassageWindowManager');

const { UI_CONSTANTS } = constants;

/**
 * VesselDataService - Pure data management for vessels
 * Handles vessel storage, updates, and lifecycle without business logic
 */
class VesselDataService extends EventEmitter {
  constructor(logger, bridgeRegistry) {
    super();
    this.logger = logger;
    this.bridgeRegistry = bridgeRegistry;
    this.vessels = new Map(); // Map<mmsi, VesselData>
    this.bridgeVessels = new Map(); // Map<bridgeId, Set<mmsi>>
    this.cleanupTimers = new Map(); // Map<mmsi, timeoutId>
    this.gpsJumpAnalyzer = new GPSJumpAnalyzer(logger);
    this.systemCoordinator = new SystemCoordinator(logger);
    this.passageWindowManager = new PassageWindowManager(logger, bridgeRegistry);

    // FIX: Add operation locks to prevent concurrent updates/removes
    this.operationLocks = new Map(); // Map<mmsi, Promise>

    // ENHANCED: Target bridge protection tracking
    this.targetBridgeProtection = new Map(); // Map<mmsi, ProtectionData>
    this.protectionTimers = new Map(); // Map<mmsi, timeoutId>
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

    // Create vessel data object
    const vessel = this._createVesselObject(mmsi, data, oldVessel);

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
        }
      } else {
        this.logger.debug(`🚫 [TARGET_REJECTED] ${mmsi}: New vessel rejected for target bridge`);
      }
    } else if (!isNewVessel && vessel.targetBridge) {
      // ENHANCED: Check for passage first, then apply protection if no passage detected
      const hasPassedCurrentTarget = this._hasPassedTargetBridge(vessel, oldVessel);

      if (hasPassedCurrentTarget) {
        // PASSAGE DETECTED: Override protection and allow transition
        this.logger.log(
          `🎯 [PASSAGE_OVERRIDE] ${vessel.mmsi}: Passage detected - allowing transition despite protection`,
        );
        this._handleTargetBridgeTransition(vessel, oldVessel);
      } else {
        // Check and apply target bridge protection for non-passage situations
        const protectionActive = this._checkTargetBridgeProtection(vessel, oldVessel);

        // Existing vessel: Handle target bridge transitions and protection
        if (!protectionActive) {
          this._handleTargetBridgeTransition(vessel, oldVessel);

          // CRITICAL: Check if vessel has become anchored/stationary after having target bridge
          // BUT: Respect protection zone - vessels within 300m of any bridge should keep their target
          const protectionZoneCheck = this._isInProtectionZone(vessel);

          if (!this._shouldAssignTargetBridge(vessel, oldVessel) && !protectionZoneCheck.isProtected) {
            // Vessel has become anchored AND is outside protection zone
            this.logger.log(
              `🔄 [TARGET_CHANGE] ${vessel.mmsi}: "${vessel.targetBridge}" → "none" `
              + `| Reason: ANCHORED/SLOW | Position: ${vessel.lat.toFixed(6)},${vessel.lon.toFixed(6)} `
              + `| Speed: ${vessel.sog}kn`,
            );
            vessel.targetBridge = null;
          } else if (!this._shouldAssignTargetBridge(vessel, oldVessel) && protectionZoneCheck.isProtected) {
            // Keep target bridge despite low speed - vessel is in protection zone
            this.logger.debug(
              `🛡️ [PROTECTION_ZONE_SAVE] ${vessel.mmsi}: Keeping target bridge "${vessel.targetBridge}" despite low speed `
              + `(${vessel.sog}kn) - vessel within protection zone of ${protectionZoneCheck.bridge} (${protectionZoneCheck.distance}m)`,
            );
          }
        } else {
          // Still handle intermediate bridge passages even when protection is active
          this._handleIntermediateBridgePassage(vessel, oldVessel);
          this.logger.debug(
            `🛡️ [TARGET_PROTECTION_ACTIVE] ${vessel.mmsi}: Target bridge protection preventing transitions`,
          );
        }
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
      }
    }

    // Store vessel
    this.vessels.set(mmsi, vessel);

    // ENHANCED: Log passage tracking status for audit purposes
    if (!isNewVessel && (vessel.lastPassedBridge || (vessel.passedBridges && vessel.passedBridges.length > 0))) {
      this._logPassageTrackingStatus(vessel);
    }

    // Emit events
    if (isNewVessel) {
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
    const vessel = this.vessels.get(mmsi);
    if (!vessel) {
      return;
    }

    // Clean up SystemCoordinator state
    this.systemCoordinator.removeVessel(mmsi);

    // 300m Protection Zone: Check if vessel is within protection zone of any bridge
    if (reason === 'timeout') {
      const { PROTECTION_ZONE_RADIUS } = constants;

      // CRITICAL FIX: Check for stale/frozen GPS data before applying protection
      const lastMoveTime = vessel.lastPositionChange || vessel.timestamp || Date.now();
      const speed = vessel.sog || 0;
      // Different timeouts based on vessel movement
      const staleTimeout = speed < 0.5
        ? UI_CONSTANTS.STALE_DATA_TIMEOUT_STATIONARY_MS // 15 minutes for stationary vessels
        : UI_CONSTANTS.STALE_DATA_TIMEOUT_MOVING_MS; // 5 minutes for moving vessels

      const timeSinceLastMove = Date.now() - lastMoveTime;

      if (timeSinceLastMove > staleTimeout) {
        this.logger.log(
          `🗑️ [STALE_DATA] Force removing vessel ${mmsi} - no movement for ${(timeSinceLastMove / 60000).toFixed(0)} minutes (speed: ${speed.toFixed(1)}kn)`,
        );
        // Continue with removal despite protection zone
      } else {
        // Only apply protection zone if vessel data is not stale
        for (const bridge of Object.values(this.bridgeRegistry.bridges)) {
          const distance = geometry.calculateDistance(
            vessel.lat,
            vessel.lon,
            bridge.lat,
            bridge.lon,
          );

          if (distance <= PROTECTION_ZONE_RADIUS) {
            this.logger.log(
              `⚠️ [PROTECTION_ZONE] Preventing removal of vessel ${mmsi} - within ${distance.toFixed(
                0,
              )}m of ${bridge.name} (reason: ${reason})`,
            );
            // Reschedule with longer timeout instead of removing
            this.scheduleCleanup(mmsi, UI_CONSTANTS.CLEANUP_EXTENSION_MS); // 10 minutes
            return;
          }
        }
      }
    }

    // Clear cleanup timer
    this._clearCleanupTimer(mmsi);

    // IMPROVEMENT: Clean up vessel state before removal to prevent memory leaks
    this._cleanupVesselState(vessel);

    // Remove from collections
    this.vessels.delete(mmsi);
    this._removeFromBridgeAssociations(mmsi);

    this.emit('vessel:removed', { mmsi, vessel, reason });
    this.logger.debug(`🗑️ [VESSEL_DATA] Vessel removed: ${mmsi} (${reason})`);
  }

  /**
   * Clean up vessel state properties to prevent memory leaks
   * @private
   * @param {Object} vessel - Vessel object to clean
   */
  _cleanupVesselState(vessel) {
    if (!vessel) return;

    // Clean up hysteresis state
    delete vessel._underBridgeLatched;
    delete vessel._lastTargetBridgeForHysteresis;

    // Clean up timing states
    vessel.waitSince = null;
    vessel.speedBelowThresholdSince = null;
    vessel.lastPositionChange = null;

    // Clean up passage states
    vessel.currentBridge = null;
    vessel.distanceToCurrent = null;

    this.logger.debug(`🧹 [STATE_CLEANUP] Cleaned up state for vessel ${vessel.mmsi}`);
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
    const allVessels = Array.from(this.vessels.values());
    const filteredVessels = allVessels.filter((vessel) => {
      // CRITICAL FIX: ALWAYS require valid targetBridge - eliminates "okänd målbro" messages
      const hasTargetBridge = vessel.targetBridge
        && this.bridgeRegistry.isValidTargetBridge(vessel.targetBridge);

      if (!hasTargetBridge) {
        this.logger.debug(
          `❌ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: No valid targetBridge - excluding from bridge text `
          + `(targetBridge=${vessel.targetBridge}, currentBridge=${vessel.currentBridge}, status=${vessel.status})`,
        );
        return false;
      }

      // Note: targetBridge validation already done above in hasTargetBridge check

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
      const reason = `target=${vessel.targetBridge}`;
      this.logger.debug(`✅ [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Included in bridge text (${vessel.status}, ${reason})`);
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
    // Atomic operation to prevent race condition
    // Clear any existing timer first (atomic with new timer set)
    const existingTimer = this.cleanupTimers.get(mmsi);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      // Double-check vessel still exists before removal
      if (this.vessels.has(mmsi)) {
        this.removeVessel(mmsi, 'timeout');
      }
      // Clean up timer reference after execution
      this.cleanupTimers.delete(mmsi);
    }, timeout);

    this.cleanupTimers.set(mmsi, timer);
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
    // Clear all cleanup timers with existence check
    for (const [mmsi, timer] of this.cleanupTimers.entries()) {
      if (timer) {
        clearTimeout(timer);
        this.logger.debug(`🧹 [TIMER_CLEANUP] Cleared cleanup timer for ${mmsi}`);
      }
    }
    this.cleanupTimers.clear();

    // ENHANCED: Clear protection timers with existence check
    for (const [mmsi, timer] of this.protectionTimers.entries()) {
      if (timer) {
        clearTimeout(timer);
        this.logger.debug(`🧹 [TIMER_CLEANUP] Cleared protection timer for ${mmsi}`);
      }
    }
    this.protectionTimers.clear();
    this.targetBridgeProtection.clear();
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
    if ((!vessel.cog || !Number.isFinite(vessel.cog)) && nearestDistance > 300) {
      this.logger.debug(
        `🚫 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Invalid course (${vessel.cog}°) and far from bridges (${nearestDistance.toFixed(0)}m) - likely stationary/anchored`,
      );
      return false;
    }
    if ((!vessel.cog || vessel.cog === 0) && nearestDistance <= 300) {
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
    if (speed < 0.3) {
      this.logger.debug(
        `🚫 [BRIDGE_TEXT_FILTER] ${vessel.mmsi}: Too slow for bridge text (${speed}kn < 0.3kn)`,
      );
      return false;
    }

    return true;
  }

  /**
   * Calculate target bridge based on vessel position and direction
   * @private
   */
  _calculateTargetBridge(vessel) {
    const { COG_DIRECTIONS } = constants;

    // CRITICAL FIX: Validate vessel position data
    if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
      this.logger.debug(`⚠️ [TARGET_ASSIGNMENT] ${vessel.mmsi}: Invalid position data - lat=${vessel.lat}, lon=${vessel.lon}`);
      return null;
    }

    // CRITICAL FIX: Validate COG is in valid range
    if (!Number.isFinite(vessel.cog) || vessel.cog < 0 || vessel.cog >= 360) {
      this.logger.debug(`⚠️ [TARGET_ASSIGNMENT] ${vessel.mmsi}: Invalid COG (${vessel.cog}) - cannot determine direction`);
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

    if (isNorthbound) {
      // Check if vessel is leaving canal northbound (north of Stridsbergsbron)
      if (vessel.lat > stridsbergsbronLat) {
        this.logger.debug(
          `🚪 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Norrut, norr om Stridsbergsbron → lämnar kanalen, ingen målbro`,
        );
        return null; // No target bridge - vessel leaving canal
      }

      // Norrut: Vilken målbro träffas FÖRST baserat på position?
      if (vessel.lat < klaffbronLat) {
        // Söder om Klaffbron → Klaffbron är första målbro
        this.logger.debug(
          `🎯 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Norrut, söder om Klaffbron → Klaffbron först`,
        );
        return 'Klaffbron';
      }
      // Between Klaffbron and Stridsbergsbron → Stridsbergsbron är första (och enda) målbro
      this.logger.debug(
        `🎯 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Norrut, mellan broarna → Stridsbergsbron`,
      );
      return 'Stridsbergsbron';
    }

    // Check if vessel is leaving canal southbound (south of Klaffbron)
    if (vessel.lat < klaffbronLat) {
      this.logger.debug(
        `🚪 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, söder om Klaffbron → lämnar kanalen, ingen målbro`,
      );
      return null; // No target bridge - vessel leaving canal
    }

    // Söderutt: Vilken målbro träffas FÖRST baserat på position?
    if (vessel.lat > stridsbergsbronLat) {
      // Norr om Stridsbergsbron → Stridsbergsbron är första målbro
      this.logger.debug(
        `🎯 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, norr om Stridsbergsbron → Stridsbergsbron först`,
      );
      return 'Stridsbergsbron';
    }
    // Between Stridsbergsbron and Klaffbron → Klaffbron är första (och enda) målbro
    this.logger.debug(
      `🎯 [TARGET_ASSIGNMENT] ${vessel.mmsi}: Söderut, mellan broarna → Klaffbron`,
    );
    return 'Klaffbron';
  }

  /**
   * Handle target bridge transitions (ENHANCED: Now separate from passage detection)
   * @private
   */
  _handleTargetBridgeTransition(vessel, oldVessel) {
    // ENHANCED: This method now assumes passage has already been detected
    // Check once more to be safe, but this should normally be true
    const hasPassedCurrentTarget = this._hasPassedTargetBridge(
      vessel,
      oldVessel,
    );

    this.logger.debug(
      `🔍 [TARGET_TRANSITION] ${vessel.mmsi}: hasPassedCurrentTarget=${hasPassedCurrentTarget}, targetBridge=${vessel.targetBridge}`,
    );

    if (hasPassedCurrentTarget) {
      // CRITICAL FIX: Don't change targetBridge if vessel is still very close to current target (≤200m)
      const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
      if (targetBridge) {
        const distanceToCurrentTarget = geometry.calculateDistance(
          vessel.lat, vessel.lon,
          targetBridge.lat, targetBridge.lon,
        );

        this.logger.debug(
          `🔍 [TARGET_DEBUG] ${vessel.mmsi}: Distance to ${vessel.targetBridge}: ${distanceToCurrentTarget.toFixed(0)}m`,
        );

        if (distanceToCurrentTarget <= 200) { // Still very close to current target bridge
          // Use PassageWindowManager for smart internal grace period
          const gracePeriod = this.passageWindowManager.getInternalGracePeriod(vessel);
          const recentlyPassed = vessel.lastPassedBridge === vessel.targetBridge
                                && vessel.lastPassedBridgeTime
                                && (Date.now() - vessel.lastPassedBridgeTime < gracePeriod);

          if (!recentlyPassed) {
            this.logger.debug(
              `🛡️ [TARGET_TRANSITION_BLOCKED] ${vessel.mmsi}: Blocking targetBridge change while ${distanceToCurrentTarget.toFixed(0)}m from ${vessel.targetBridge}`,
            );
            return; // Don't change targetBridge yet
          }
        }
      }

      const nextTargetBridge = this._calculateNextTargetBridge(vessel);
      if (nextTargetBridge && nextTargetBridge !== vessel.targetBridge) {
        this.logger.log(
          `🎯 [TARGET_TRANSITION] ${vessel.mmsi}: Passed ${vessel.targetBridge} → ${nextTargetBridge}`,
        );
        vessel.targetBridge = nextTargetBridge;
        // ENHANCED: Mark as recently passed for bridge text - ALWAYS RECORD TARGET BRIDGE PASSAGES
        vessel.lastPassedBridgeTime = Date.now();
        vessel.lastPassedBridge = oldVessel.targetBridge;
        this.logger.log(
          `📝 [TARGET_PASSAGE_RECORDED] ${vessel.mmsi}: Recorded passage of target bridge ${oldVessel.targetBridge}`,
        );
      } else if (!nextTargetBridge) {
        // No more target bridges in this direction - vessel should be removed after passage timeout
        this.logger.log(
          `🏁 [TARGET_END] ${vessel.mmsi}: Passed final target bridge ${vessel.targetBridge} - marking for removal`,
        );
        vessel.targetBridge = null;
        vessel.lastPassedBridgeTime = Date.now();
        vessel.lastPassedBridge = oldVessel.targetBridge;
        this.logger.log(
          `📝 [FINAL_TARGET_PASSAGE_RECORDED] ${vessel.mmsi}: Recorded passage of final target bridge ${oldVessel.targetBridge}`,
        );
      }
    } else {
      // Check if vessel passed any intermediate bridge
      this._handleIntermediateBridgePassage(vessel, oldVessel);
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

    return {
      mmsi,
      lat: validatedPosition.lat,
      lon: validatedPosition.lon,
      sog: data.sog,
      cog: data.cog,
      dirString: data.dirString || 'unknown',
      timestamp: Date.now(),
      name: data.name || 'Unknown',

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

      // GPS jump analysis data (NEW)
      _positionAnalysis: positionData.analysis || null,
      _gpsJumpDetected: positionData.jumpDetected || false,
      _positionUncertain: positionData.positionUncertain || false,
    };
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
  }

  /**
   * Check if vessel has passed its current target bridge
   * @private
   */
  _hasPassedTargetBridge(vessel, oldVessel) {
    if (!vessel.targetBridge || !oldVessel) {
      return false;
    }

    const targetBridge = this.bridgeRegistry.getBridgeByName(
      vessel.targetBridge,
    );
    if (!targetBridge) {
      return false;
    }

    // USE ENHANCED PASSAGE DETECTION: Utilize the comprehensive detectBridgePassage function
    const passageResult = geometry.detectBridgePassage(vessel, oldVessel, targetBridge);

    if (passageResult.passed) {
      this.logger.log(
        `🎯 [TARGET_BRIDGE_PASSED] ${vessel.mmsi}: Passed target bridge ${vessel.targetBridge} `
        + `(method: ${passageResult.method}, confidence: ${passageResult.confidence.toFixed(2)})`,
      );

      // Log details for debugging
      if (passageResult.details) {
        this.logger.debug(
          `🔍 [PASSAGE_DETAILS] ${vessel.mmsi}: ${JSON.stringify(passageResult.details)}`,
        );
      }

      return true;
    }

    // FALLBACK: Legacy tracking for compatibility
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

    // Track if vessel has EVER been very close to the target bridge
    if ((previousDistance <= 100 || currentDistance <= 100)
        && (!oldVessel._wasCloseToTarget || oldVessel._wasCloseToTarget !== vessel.targetBridge)) {
      vessel._wasCloseToTarget = vessel.targetBridge;
      const closeDistance = Math.min(previousDistance, currentDistance);
      this.logger.debug(
        `🎯 [CLOSE_TO_TARGET] ${vessel.mmsi}: Marking as close to ${vessel.targetBridge} (${closeDistance.toFixed(0)}m)`,
      );
    }

    // DEBUG: Log why passage was not detected
    this.logger.debug(
      `🔍 [NO_PASSAGE] ${vessel.mmsi} -> ${vessel.targetBridge}: `
      + `prev=${previousDistance.toFixed(0)}m, curr=${currentDistance.toFixed(0)}m, `
      + `method=${passageResult.method}`,
    );

    return false;
  }

  /**
   * Calculate next target bridge based on vessel direction
   * @private
   */
  _calculateNextTargetBridge(vessel) {
    const { COG_DIRECTIONS } = constants;

    const isNorthbound = vessel.cog >= COG_DIRECTIONS.NORTH_MIN
      || vessel.cog <= COG_DIRECTIONS.NORTH_MAX;
    const currentTarget = vessel.targetBridge;

    if (isNorthbound) {
      // Norrut: Klaffbron → Stridsbergsbron → null
      if (currentTarget === 'Klaffbron') {
        return 'Stridsbergsbron';
      }
      // Stridsbergsbron is final target bridge northbound
      return null;
    }
    // Söderut: Stridsbergsbron → Klaffbron → null
    if (currentTarget === 'Stridsbergsbron') {
      return 'Klaffbron';
    }
    // Klaffbron is final target bridge southbound
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
        // but respect target bridge passage priority for ETA calculations
        const timeSinceLastPassed = vessel.lastPassedBridgeTime ? Date.now() - vessel.lastPassedBridgeTime : Infinity;
        const isLastPassedTargetBridge = vessel.lastPassedBridge === 'Klaffbron' || vessel.lastPassedBridge === 'Stridsbergsbron';

        if (!isLastPassedTargetBridge || timeSinceLastPassed > 60000) { // 1 minute grace period
          vessel.lastPassedBridgeTime = Date.now();
          vessel.lastPassedBridge = bridge.name;
          passagesRecorded++;
          this.logger.log(
            `📝 [INTERMEDIATE_PASSAGE_RECORDED] ${vessel.mmsi}: Recorded passage of intermediate bridge ${bridge.name} `
            + `(was lastPassed: ${oldVessel.lastPassedBridge || 'none'})`,
          );
        } else {
          this.logger.log(
            `⚠️ [INTERMEDIATE_PASSAGE_SKIPPED] ${vessel.mmsi}: Intermediate bridge ${bridge.name} passage detected but NOT recorded `
            + `(recent target bridge passage: ${vessel.lastPassedBridge}, ${Math.round(timeSinceLastPassed / 1000)}s ago)`,
          );
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
    // USE ENHANCED PASSAGE DETECTION: Utilize the comprehensive detectBridgePassage function
    const passageResult = geometry.detectBridgePassage(vessel, oldVessel, bridge);

    if (passageResult.passed) {
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

    // Determine if protection should be activated
    const shouldActivateProtection = isInProtectionZone || gpsEventActive
      || maneuverActive || recentPassageActive;

    if (shouldActivateProtection && !protection.isActive) {
      // Activate protection
      protection = {
        isActive: true,
        reason: this._getProtectionReason(isInProtectionZone, gpsEventActive, maneuverActive, recentPassageActive),
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
  _getProtectionReason(isInZone, gpsEvent, maneuver, recentPassage) {
    const reasons = [];
    if (isInZone) reasons.push('proximity');
    if (gpsEvent) reasons.push('gps-event');
    if (maneuver) reasons.push('maneuver');
    if (recentPassage) reasons.push('recent-passage');
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

    // Deactivate if far from target and no GPS events
    if (protection.distanceToTarget > 500
        && !protection.gpsEventDetected
        && !protection.maneuverDetected
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
   * Check if vessel is within protection zone of any bridge
   * @private
   * @param {Object} vessel - Vessel object
   * @returns {Object} Protection zone status with details
   */
  _isInProtectionZone(vessel) {
    const { PROTECTION_ZONE_RADIUS } = constants;

    for (const bridge of Object.values(this.bridgeRegistry.bridges)) {
      const distance = geometry.calculateDistance(
        vessel.lat,
        vessel.lon,
        bridge.lat,
        bridge.lon,
      );

      if (distance <= PROTECTION_ZONE_RADIUS) {
        return {
          isProtected: true,
          bridge: bridge.name,
          distance: distance.toFixed(0),
        };
      }
    }

    return { isProtected: false };
  }
}

module.exports = VesselDataService;
