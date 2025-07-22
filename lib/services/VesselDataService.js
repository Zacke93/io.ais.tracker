'use strict';

const EventEmitter = require('events');
const { MOVEMENT_DETECTION } = require('../constants');
const geometry = require('../utils/geometry');

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
  }

  /**
   * Update or create a vessel
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} data - AIS data
   * @returns {Object|null} Updated vessel object or null if filtered out
   */
  updateVessel(mmsi, data) {
    const oldVessel = this.vessels.get(mmsi);
    const isNewVessel = !oldVessel;

    // Create vessel data object
    const vessel = this._createVesselObject(mmsi, data, oldVessel);

    // Immediate target bridge assignment for new vessels (if moving)
    if (isNewVessel && !vessel.targetBridge && vessel.sog > 0.3) {
      vessel.targetBridge = this._calculateTargetBridge(vessel);
      if (vessel.targetBridge) {
        this.logger.debug(
          `🎯 [TARGET_BRIDGE_IMMEDIATE] Assigned ${vessel.targetBridge} to new vessel ${mmsi} (${vessel.sog}kn)`,
        );
      }
    }

    // Store vessel
    this.vessels.set(mmsi, vessel);

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

    // 300m Protection Zone: Check if vessel is within protection zone of any bridge
    if (reason === 'timeout') {
      const geometry = require('../utils/geometry'); // eslint-disable-line global-require
      const { PROTECTION_ZONE_RADIUS } = require('../constants'); // eslint-disable-line global-require

      for (const bridge of Object.values(this.bridgeRegistry.bridges)) {
        const distance = geometry.calculateDistance(
          vessel.lat, vessel.lon,
          bridge.lat, bridge.lon,
        );

        if (distance <= PROTECTION_ZONE_RADIUS) {
          this.logger.warn(
            `⚠️ [PROTECTION_ZONE] Preventing removal of vessel ${mmsi} - within ${distance.toFixed(0)}m of ${bridge.name} (reason: ${reason})`,
          );
          // Reschedule with longer timeout instead of removing
          this.scheduleCleanup(mmsi, 600000); // 10 minutes
          return;
        }
      }
    }

    // Clear cleanup timer
    this._clearCleanupTimer(mmsi);

    // Remove from collections
    this.vessels.delete(mmsi);
    this._removeFromBridgeAssociations(mmsi);

    this.emit('vessel:removed', { mmsi, vessel, reason });
    this.logger.debug(`🗑️ [VESSEL_DATA] Vessel removed: ${mmsi} (${reason})`);
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
    return Array.from(this.vessels.values())
      .filter((vessel) => vessel.targetBridge === bridgeName);
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
    return Array.from(vesselSet).map((mmsi) => this.vessels.get(mmsi)).filter(Boolean);
  }

  /**
   * Get vessels suitable for bridge text generation
   * @returns {Object[]} Array of relevant vessels
   */
  getVesselsForBridgeText() {
    return Array.from(this.vessels.values()).filter((vessel) => {
      // Must have target bridge
      if (!vessel.targetBridge) {
        return false;
      }

      // Must be targeting a valid bridge
      if (!this.bridgeRegistry.isValidTargetBridge(vessel.targetBridge)) {
        return false;
      }

      // Filter out likely anchored boats (slow speed + far from bridges)
      const { APPROACH_RADIUS } = require('../constants'); // eslint-disable-line global-require
      const distanceToNearest = vessel._distanceToNearest || 9999;

      if (vessel.sog <= 0.3 && distanceToNearest > APPROACH_RADIUS) {
        this.logger.debug(
          `🚫 [ANCHORED_FILTER] Skipping likely anchored vessel ${vessel.mmsi} from bridge text - ${vessel.sog}kn, ${distanceToNearest.toFixed(0)}m from nearest bridge`,
        );
        return false;
      }

      // Must have status that matters for bridge text
      const relevantStatuses = ['approaching', 'waiting', 'under-bridge', 'passed'];
      return relevantStatuses.includes(vessel.status);
    });
  }

  /**
   * Associate vessel with bridge
   * @param {string} mmsi - Vessel MMSI
   * @param {string} bridgeId - Bridge ID
   */
  associateVesselWithBridge(mmsi, bridgeId) {
    if (!this.bridgeVessels.has(bridgeId)) {
      this.bridgeVessels.set(bridgeId, new Set());
    }
    this.bridgeVessels.get(bridgeId).add(mmsi);
  }

  /**
   * Remove vessel from bridge association
   * @param {string} mmsi - Vessel MMSI
   * @param {string} bridgeId - Bridge ID (optional - removes from all if not specified)
   */
  removeVesselFromBridge(mmsi, bridgeId = null) {
    if (bridgeId) {
      const vesselSet = this.bridgeVessels.get(bridgeId);
      if (vesselSet) {
        vesselSet.delete(mmsi);
      }
    } else {
      this._removeFromBridgeAssociations(mmsi);
    }
  }

  /**
   * Schedule cleanup for vessel
   * @param {string} mmsi - Vessel MMSI
   * @param {number} timeout - Timeout in milliseconds
   */
  scheduleCleanup(mmsi, timeout) {
    this._clearCleanupTimer(mmsi);

    const timer = setTimeout(() => {
      this.removeVessel(mmsi, 'timeout');
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
   * Get vessel count
   * @returns {number} Number of tracked vessels
   */
  getVesselCount() {
    return this.vessels.size;
  }

  /**
   * Calculate target bridge based on vessel COG
   * @private
   */
  _calculateTargetBridge(vessel) {
    const { COG_DIRECTIONS } = require('../constants'); // eslint-disable-line global-require

    // FIXED: Assign target bridge based on which target bridge vessel will encounter FIRST
    // Bridge order (south to north): Klaffbron → Stridsbergsbron
    if (vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX) {
      // Northbound (from south): Will encounter Klaffbron first
      return 'Klaffbron';
    }

    // Southbound (from north): Will encounter Stridsbergsbron first
    return 'Stridsbergsbron';
  }

  /**
   * Create vessel object from AIS data
   * @private
   */
  _createVesselObject(mmsi, data, oldVessel) {
    // Calculate position tracking
    const currentPosition = { lat: data.lat, lon: data.lon };
    const previousPosition = oldVessel ? { lat: oldVessel.lat, lon: oldVessel.lon } : null;

    // Determine if vessel has moved significantly
    let positionChangeTime = Date.now();
    if (oldVessel && previousPosition) {
      const actualMovement = geometry.calculateDistance(
        previousPosition.lat, previousPosition.lon,
        currentPosition.lat, currentPosition.lon,
      );

      // Only update position change time if movement is significant
      if (actualMovement <= MOVEMENT_DETECTION.MINIMUM_MOVEMENT) {
        positionChangeTime = oldVessel.lastPositionChange || Date.now();
      }

      this.logger.debug(
        `📍 [POSITION_TRACKING] ${mmsi}: movement ${actualMovement.toFixed(1)}m, `
        + `updating change time: ${actualMovement > MOVEMENT_DETECTION.MINIMUM_MOVEMENT ? 'YES' : 'NO'}`,
      );
    }

    return {
      mmsi,
      lat: data.lat,
      lon: data.lon,
      sog: data.sog,
      cog: data.cog,
      dirString: data.dirString || 'unknown',
      timestamp: Date.now(),
      name: data.name || 'Unknown',

      // Status and bridge information
      status: oldVessel?.status || 'en-route',
      targetBridge: oldVessel?.targetBridge || null,
      nearBridge: oldVessel?.nearBridge || null,

      // Movement and tracking
      lastPosition: previousPosition,
      lastPositionChange: positionChangeTime,
      lastActiveTime: data.sog > 2.0 ? Date.now() : oldVessel?.lastActiveTime || Date.now(),

      // Speed tracking
      speedHistory: this._updateSpeedHistory(oldVessel?.speedHistory, data.sog),
      maxRecentSpeed: this._calculateMaxRecentSpeed(oldVessel, data.sog),

      // Status flags
      isApproaching: oldVessel?.isApproaching || false,
      isWaiting: oldVessel?.isWaiting || false,

      // Bridge passage tracking
      passedBridges: oldVessel?.passedBridges || [],
      lastPassedBridgeTime: oldVessel?.lastPassedBridgeTime || null,

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
      confidence: oldVessel?.confidence || 'medium',
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

    const recentSpeeds = this._updateSpeedHistory(oldVessel.speedHistory, currentSpeed);
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
   * Remove vessel from all bridge associations
   * @private
   */
  _removeFromBridgeAssociations(mmsi) {
    for (const vesselSet of this.bridgeVessels.values()) {
      vesselSet.delete(mmsi);
    }
  }
}

module.exports = VesselDataService;
