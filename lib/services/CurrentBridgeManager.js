'use strict';

const { APPROACH_RADIUS, STATUS_HYSTERESIS } = require('../constants');

/**
 * CurrentBridgeManager - Robust tracking of vessel's current bridge
 * Solves the currentBridge "stuck" bug by providing automatic updates
 */
class CurrentBridgeManager {
  constructor(bridgeRegistry, logger) {
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;

    // Hysteresis values for stability (prevent flapping)
    this.SET_DISTANCE = APPROACH_RADIUS; // 300m - when to set currentBridge
    this.CLEAR_DISTANCE = APPROACH_RADIUS * 1.5; // 450m - when to clear currentBridge
  }

  /**
   * Update vessel's currentBridge based on proximity data
   * @param {Object} vessel - Vessel object to update
   * @param {Object} proximityData - Proximity analysis result
   */
  updateCurrentBridge(vessel, proximityData) {
    const oldCurrentBridge = vessel.currentBridge;
    const nearest = proximityData.nearestBridge;

    // CRITICAL FIX: Clear currentBridge if vessel has passed this bridge
    // This prevents "ghost waiting" where vessel appears to wait at already-passed bridge
    if (vessel.currentBridge
        && vessel.lastPassedBridge === vessel.currentBridge
        && vessel.distanceToCurrent > 50) {
      this.logger.debug(
        `🚢✅ [CURRENT_BRIDGE_PASSED] ${vessel.mmsi}: Clearing ${vessel.currentBridge} (passed bridge, now ${vessel.distanceToCurrent?.toFixed(0)}m away)`,
      );
      vessel.currentBridge = null;
      vessel.distanceToCurrent = null;
      return; // Exit early after clearing passed bridge
    }

    // Rule 1: Set currentBridge if vessel is close to a bridge
    if (nearest && nearest.distance <= this.SET_DISTANCE) {
      vessel.currentBridge = nearest.name;
      vessel.distanceToCurrent = nearest.distance;

      if (oldCurrentBridge !== vessel.currentBridge) {
        this.logger.debug(
          `🔄 [CURRENT_BRIDGE_SET] ${vessel.mmsi}: ${oldCurrentBridge || 'null'} -> ${vessel.currentBridge} (${nearest.distance.toFixed(0)}m)`,
        );
      }
    } else if (vessel.currentBridge && vessel.distanceToCurrent > this.CLEAR_DISTANCE) {
    // Rule 2: Clear currentBridge if vessel has moved far away (hysteresis)
      this.logger.debug(
        `🔄 [CURRENT_BRIDGE_CLEAR] ${vessel.mmsi}: ${vessel.currentBridge} -> null (${vessel.distanceToCurrent.toFixed(0)}m > ${this.CLEAR_DISTANCE}m)`,
      );

      vessel.currentBridge = null;
      vessel.distanceToCurrent = null;
    } else if (vessel.currentBridge && nearest && nearest.name === vessel.currentBridge) {
    // Rule 3: Update distance if currentBridge is still set
      vessel.distanceToCurrent = nearest.distance;
    }

    // Validation: Ensure consistency
    this._validateCurrentBridgeState(vessel, proximityData);
  }

  /**
   * Validate that currentBridge state is consistent
   * @private
   */
  _validateCurrentBridgeState(vessel, proximityData) {
    // CRITICAL FIX: If currentBridge is set but distanceToCurrent is missing or invalid,
    // try to calculate it from proximityData
    if (vessel.currentBridge && (!vessel.distanceToCurrent || vessel.distanceToCurrent === 0)) {
      // Find bridge ID from bridge name (currentBridge stores name, bridgeDistances uses ID)
      let bridgeId = null;
      for (const [id, bridge] of Object.entries(this.bridgeRegistry.bridges)) {
        if (bridge.name === vessel.currentBridge) {
          bridgeId = id;
          break;
        }
      }

      // Try to find the distance from proximityData using bridge ID
      if (bridgeId && proximityData.bridgeDistances && proximityData.bridgeDistances[bridgeId]) {
        vessel.distanceToCurrent = proximityData.bridgeDistances[bridgeId];
        this.logger.debug(
          `🔧 [CURRENT_BRIDGE_FIX] ${vessel.mmsi}: Fixed distanceToCurrent=${vessel.distanceToCurrent?.toFixed(0)}m for ${vessel.currentBridge} (${bridgeId})`,
        );
        return; // Fixed, no error needed
      }

      // If still problematic, log the issue
      if (vessel.distanceToCurrent > this.CLEAR_DISTANCE) {
        this.logger.debug(
          `⚠️ [CURRENT_BRIDGE_INCONSISTENT] ${vessel.mmsi}: currentBridge=${vessel.currentBridge} but distanceToCurrent=${vessel.distanceToCurrent}`,
        );
      }
    }
  }
}

module.exports = CurrentBridgeManager;
