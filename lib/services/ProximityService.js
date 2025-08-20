'use strict';

const EventEmitter = require('events');
const geometry = require('../utils/geometry');
const {
  APPROACHING_RADIUS, // 500m - for "närmar sig" status
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
   * Get distance from vessel to specific bridge
   * @param {Object} vessel - Vessel object
   * @param {string} bridgeName - Bridge name
   * @returns {number} Distance in meters
   */
  getDistanceToBridge(vessel, bridgeName) {
    const bridge = this.bridgeRegistry.getBridgeByName(bridgeName);
    if (!bridge) {
      return Infinity;
    }
    return geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
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

      // FIX: Handle null return from calculateDistance
      if (distance === null) {
        this.logger.error(`[PROXIMITY] Failed to calculate distance for vessel ${vessel.mmsi} to ${bridgeId}`);
        continue;
      }

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

      // PRIORITY FIX: If vessel is under bridge, this takes absolute priority
      if (analysis.underBridge) {
        result.underBridge = true;
        result.underBridgeName = bridge.name;
        result.zoneTransitions = [{
          bridgeId,
          bridgeName: bridge.name,
          transition: 'entered_under_bridge',
          distance,
        }];
        // Under bridge overrides all other zones - stop checking other bridges
        this.logger.debug(
          `🌉 [UNDER_BRIDGE_PRIORITY] ${vessel.mmsi}: Under ${bridge.name} (${distance.toFixed(0)}m) - stopping further checks`,
        );
        break; // Exit loop early when under bridge
      }

      // Merge other analysis results (only if not under bridge)
      if (analysis.isApproaching) {
        result.isApproaching = true;
        result.approachingBridge = { id: bridgeId, name: bridge.name, distance };
      }

      if (analysis.withinProtectionZone) {
        result.withinProtectionZone = true;
        result.protectionZoneBridge = { id: bridgeId, name: bridge.name, distance };
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

    // Build bridges array for compatibility with app.js flow triggers
    // NOTE: This must be done AFTER the loop to ensure all distances are calculated
    result.bridges = Object.entries(this.bridgeRegistry.bridges)
      .map(([id, bridge]) => ({
        id,
        name: bridge.name,
        distance: result.bridgeDistances[id],
      }))
      // Enhanced safety: filter out any undefined/NaN/null distances
      .filter((b) => b && b.distance != null && Number.isFinite(b.distance) && !Number.isNaN(b.distance))
      .sort((a, b) => a.distance - b.distance);

    // CRITICAL FIX: If NO valid bridges could be calculated, create fallback result
    if (result.bridges.length === 0) {
      this.logger.error(`[PROXIMITY] CRITICAL: No valid bridge distances calculated for vessel ${vessel.mmsi}`);
      // Set safe fallback values to prevent crashes
      result.nearestDistance = Infinity;
      result.nearestBridge = null;
      result.bridges = []; // Empty array is safe for flow triggers
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
    const isWithinRadius = distance <= APPROACHING_RADIUS; // FIX: Use 500m for approaching, not 300m
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
    // CRITICAL FIX: Validate inputs
    if (!vessel || !proximityResult) {
      this.logger.debug('⏱️ [TIMEOUT_CALC] Invalid inputs - using default timeout');
      return TIMEOUT_SETTINGS.MEDIUM_DISTANCE;
    }

    // CRITICAL FIX: Handle 'passed' status first - must keep vessel for at least 60 seconds
    if (vessel.status === 'passed') {
      // Ensure vessel is kept for at least 60 seconds for "precis passerat" messages
      const timeSincePassed = vessel.lastPassedBridgeTime ? Date.now() - vessel.lastPassedBridgeTime : 0;
      if (timeSincePassed < 60000) {
        // Keep for remaining time of the 1-minute window plus buffer
        const remainingTime = 60000 - timeSincePassed + 5000; // +5s buffer
        this.logger.debug(
          `⏱️ [PASSED_TIMEOUT] ${vessel.mmsi}: Keeping for ${(remainingTime / 1000).toFixed(0)}s more (passed ${(timeSincePassed / 1000).toFixed(0)}s ago)`,
        );
        return Math.max(remainingTime, 65000); // Minimum 65 seconds
      }
    }

    // Base timeout on distance to nearest bridge
    const distance = proximityResult.nearestDistance;
    let baseTimeout;

    // CRITICAL FIX: Validate distance is a finite number
    if (!Number.isFinite(distance) || distance < 0) {
      this.logger.debug(`⏱️ [TIMEOUT_CALC] ${vessel.mmsi}: Invalid distance (${distance}) - using medium timeout`);
      baseTimeout = TIMEOUT_SETTINGS.MEDIUM_DISTANCE;
    } else if (distance <= PROTECTION_ZONE_RADIUS) {
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
      `⏱️ [PROXIMITY_TIMEOUT] ${vessel.mmsi}: distance=${Number.isFinite(distance) ? distance.toFixed(0) : 'unknown'}m, `
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
      if (distance <= APPROACHING_RADIUS && geometry.isHeadingTowards(vessel, bridge) && vessel.sog > 0.5) {
        result.isApproaching = true;
        result.zoneTransition = 'approaching_in_protection_zone';
      } else {
        result.zoneTransition = 'entered_protection_zone';
      }
    } else if (distance <= APPROACHING_RADIUS) {
      // Check approach zone (500m) - consistent with StatusService
      if (geometry.isHeadingTowards(vessel, bridge) && vessel.sog > 0.5) {
        result.isApproaching = true;
        result.zoneTransition = 'approaching';
      }
    }

    // NOTE: bridges array is built in analyzeVesselProximity, not here
    // This method only analyzes a single bridge

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
