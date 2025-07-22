'use strict';

const EventEmitter = require('events');
const geometry = require('../utils/geometry');
const {
  APPROACH_RADIUS,
  PROTECTION_ZONE_RADIUS,
  UNDER_BRIDGE_DISTANCE,
  TIMEOUT_SETTINGS,
} = require('../constants');

/**
 * ProximityService - Monitors vessel distances to bridges
 * Handles proximity detection, approach monitoring, and zone management
 */
class ProximityService extends EventEmitter {
  constructor(bridgeRegistry, logger) {
    super();
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
  }

  /**
   * Analyze vessel proximity to bridges
   * @param {Object} vessel - Vessel object
   * @returns {Object} Proximity analysis result
   */
  analyzeVesselProximity(vessel) {
    const result = {
      nearestBridge: null,
      nearestDistance: Infinity,
      bridgeDistances: {},
      isApproaching: false,
      withinProtectionZone: false,
      underBridge: false,
      zoneTransitions: [],
    };

    // Calculate distances to all bridges
    for (const [bridgeId, bridge] of Object.entries(this.bridgeRegistry.bridges)) {
      const distance = geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
      result.bridgeDistances[bridgeId] = distance;

      // Track nearest bridge
      if (distance < result.nearestDistance) {
        result.nearestDistance = distance;
        result.nearestBridge = {
          id: bridgeId,
          name: bridge.name,
          distance,
        };
      }

      // Check various zones
      const analysis = this._analyzeBridgeProximity(vessel, bridgeId, bridge, distance);

      // Merge analysis results
      if (analysis.isApproaching) {
        result.isApproaching = true;
        result.approachingBridge = { id: bridgeId, name: bridge.name, distance };
      }

      if (analysis.withinProtectionZone) {
        result.withinProtectionZone = true;
        result.protectionZoneBridge = { id: bridgeId, name: bridge.name, distance };
      }

      if (analysis.underBridge) {
        result.underBridge = true;
        result.underBridgeName = bridge.name;
      }

      // Collect zone transitions
      if (analysis.zoneTransition) {
        result.zoneTransitions.push({
          bridgeId,
          bridgeName: bridge.name,
          transition: analysis.zoneTransition,
          distance,
        });
      }
    }

    // Log proximity analysis
    this._logProximityAnalysis(vessel, result);

    return result;
  }

  /**
   * Check if vessel is approaching a specific bridge
   * @param {Object} vessel - Vessel object
   * @param {string} bridgeId - Bridge ID
   * @returns {boolean} True if approaching
   */
  isApproaching(vessel, bridgeId) {
    const bridge = this.bridgeRegistry.getBridge(bridgeId);
    if (!bridge) return false;

    const distance = geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
    const isWithinRadius = distance <= APPROACH_RADIUS;
    const isHeadingTowards = geometry.isHeadingTowards(vessel, bridge);

    return isWithinRadius && isHeadingTowards && vessel.sog > 0.5;
  }

  /**
   * Check if vessel is within protection zone of any bridge
   * @param {Object} vessel - Vessel object
   * @returns {Object|null} Protection zone info or null
   */
  getProtectionZoneStatus(vessel) {
    for (const [bridgeId, bridge] of Object.entries(this.bridgeRegistry.bridges)) {
      const distance = geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
      if (distance <= PROTECTION_ZONE_RADIUS) {
        return {
          bridgeId,
          bridgeName: bridge.name,
          distance,
          withinZone: true,
        };
      }
    }
    return null;
  }

  /**
   * Check if vessel is under a bridge
   * @param {Object} vessel - Vessel object
   * @returns {Object|null} Under bridge info or null
   */
  getUnderBridgeStatus(vessel) {
    for (const [bridgeId, bridge] of Object.entries(this.bridgeRegistry.bridges)) {
      const distance = geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
      if (distance <= UNDER_BRIDGE_DISTANCE) {
        return {
          bridgeId,
          bridgeName: bridge.name,
          distance,
          underBridge: true,
        };
      }
    }
    return null;
  }

  /**
   * Find the nearest bridge to a vessel
   * @param {Object} vessel - Vessel object
   * @returns {Object|null} Nearest bridge info
   */
  findNearestBridge(vessel) {
    return geometry.findNearestBridge(vessel, this.bridgeRegistry.bridges);
  }

  /**
   * Calculate timeout based on vessel proximity and characteristics
   * @param {Object} vessel - Vessel object
   * @param {Object} proximityResult - Result from analyzeVesselProximity
   * @returns {number} Timeout in milliseconds
   */
  calculateProximityTimeout(vessel, proximityResult) {

    // Base timeout on distance to nearest bridge
    const distance = proximityResult.nearestDistance;
    let baseTimeout;

    if (distance <= PROTECTION_ZONE_RADIUS) {
      baseTimeout = TIMEOUT_SETTINGS.NEAR_BRIDGE; // 20 minutes
    } else if (distance <= 600) {
      baseTimeout = TIMEOUT_SETTINGS.MEDIUM_DISTANCE; // 10 minutes
    } else {
      baseTimeout = TIMEOUT_SETTINGS.FAR_DISTANCE; // 2 minutes
    }

    // Adjust for vessel characteristics
    if (vessel.status === 'waiting') {
      baseTimeout = Math.max(baseTimeout, TIMEOUT_SETTINGS.WAITING_VESSEL_MIN);
    }

    if (vessel.sog > 4.0) {
      baseTimeout = Math.max(baseTimeout, TIMEOUT_SETTINGS.FAST_VESSEL_MIN);
    }

    this.logger.debug(
      `⏱️ [PROXIMITY_TIMEOUT] ${vessel.mmsi}: distance=${distance.toFixed(0)}m, `
      + `speed=${vessel.sog}kn, status=${vessel.status}, timeout=${(baseTimeout / 60000).toFixed(1)}min`,
    );

    return baseTimeout;
  }

  /**
   * Analyze proximity to a specific bridge
   * @private
   */
  _analyzeBridgeProximity(vessel, bridgeId, bridge, distance) {
    const result = {
      isApproaching: false,
      withinProtectionZone: false,
      underBridge: false,
      zoneTransition: null,
    };

    // Check under bridge (highest priority)
    if (distance <= UNDER_BRIDGE_DISTANCE) {
      result.underBridge = true;
      result.zoneTransition = 'entered_under_bridge';
    } else if (distance <= PROTECTION_ZONE_RADIUS) {
      // Check protection zone
      result.withinProtectionZone = true;

      // Check if approaching within protection zone
      if (distance <= APPROACH_RADIUS && geometry.isHeadingTowards(vessel, bridge) && vessel.sog > 0.5) {
        result.isApproaching = true;
        result.zoneTransition = 'approaching_in_protection_zone';
      } else {
        result.zoneTransition = 'entered_protection_zone';
      }
    } else if (distance <= APPROACH_RADIUS) {
      // Check approach zone
      if (geometry.isHeadingTowards(vessel, bridge) && vessel.sog > 0.5) {
        result.isApproaching = true;
        result.zoneTransition = 'approaching';
      }
    }

    return result;
  }

  /**
   * Log proximity analysis details
   * @private
   */
  _logProximityAnalysis(vessel, result) {
    this.logger.debug(`🎯 [PROXIMITY_ANALYSIS] ${vessel.mmsi}:`, {
      nearestBridge: result.nearestBridge?.name,
      nearestDistance: `${result.nearestDistance.toFixed(0)}m`,
      isApproaching: result.isApproaching,
      withinProtectionZone: result.withinProtectionZone,
      underBridge: result.underBridge,
      zoneTransitions: result.zoneTransitions.length,
      speed: `${vessel.sog?.toFixed(1)}kn`,
      course: `${vessel.cog?.toFixed(0)}°`,
    });

    // Log zone transitions
    for (const transition of result.zoneTransitions) {
      this.logger.debug(
        `🔄 [ZONE_TRANSITION] ${vessel.mmsi}: ${transition.transition} at ${transition.bridgeName} `
        + `(${transition.distance.toFixed(0)}m)`,
      );
    }
  }
}

module.exports = ProximityService;
