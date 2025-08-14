'use strict';

const { STALLBACKABRON_SPECIAL } = require('../constants');

/**
 * StallbackabronHelper - Centralized logic for Stallbackabron special rules
 *
 * From bridgeTextFormat.md:
 * - NEVER shows "inväntar broöppning"
 * - Uses "åker strax under" instead of "inväntar broöppning"
 * - Uses "passerar" instead of "broöppning pågår"
 * - ALWAYS shows ETA to target bridge, even for under-bridge/passed status
 */
class StallbackabronHelper {
  constructor(bridgeRegistry, logger) {
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
    this.bridgeName = STALLBACKABRON_SPECIAL.BRIDGE_NAME;
  }

  /**
   * Check if a bridge is Stallbackabron
   * @param {string} bridgeName - Bridge name to check
   * @returns {boolean} True if this is Stallbackabron
   */
  isStallbackabron(bridgeName) {
    return bridgeName === this.bridgeName;
  }

  /**
   * Check if vessel should show Stallbackabron special waiting status
   * This replaces "inväntar broöppning" with "åker strax under"
   * @param {Object} vessel - Vessel object
   * @param {Object} proximityData - Proximity analysis data
   * @returns {boolean} True if vessel should show special waiting status
   */
  shouldShowSpecialWaiting(vessel, proximityData) {
    if (!this.isStallbackabron(vessel.currentBridge)) {
      return false;
    }

    // Check if vessel is within approach radius of Stallbackabron
    const stallbackabron = this.bridgeRegistry.getBridgeByName(this.bridgeName);
    if (!stallbackabron) {
      this.logger.error(`⚠️ [STALLBACKA_HELPER] ${this.bridgeName} not found in registry`);
      return false;
    }

    const distance = proximityData?.bridgeDistances?.stallbackabron;
    if (distance && distance <= 300) { // APPROACH_RADIUS
      this.logger.debug(
        `🌉 [STALLBACKA_SPECIAL] ${vessel.mmsi}: Special waiting at ${this.bridgeName} (${distance.toFixed(0)}m)`,
      );
      return true;
    }

    return false;
  }

  /**
   * Get the appropriate message type for Stallbackabron vessel
   * @param {Object} vessel - Vessel object
   * @param {number} distance - Distance to Stallbackabron in meters
   * @returns {string} Message type: 'approaching', 'special-waiting', 'under-bridge', 'passed'
   */
  getMessageType(vessel, distance) {
    if (distance <= 50) { // UNDER_BRIDGE_DISTANCE
      return 'under-bridge';
    } if (distance <= 300) { // APPROACH_RADIUS
      return 'special-waiting'; // "åker strax under" instead of "inväntar broöppning"
    } if (distance <= 500) { // APPROACHING_RADIUS
      return 'approaching';
    }
    return 'en-route';
  }

  /**
   * Generate Stallbackabron-specific message
   * @param {Object} vessel - Vessel object
   * @param {string} messageType - Message type from getMessageType()
   * @param {string} etaText - Formatted ETA text (always includes ETA to target bridge)
   * @param {number} count - Number of vessels (for multi-vessel messages)
   * @returns {string} Stallbackabron-specific message
   */
  generateMessage(vessel, messageType, etaText = null, count = 1) {
    const targetBridge = vessel.targetBridge || 'okänd målbro';
    const etaSuffix = etaText ? `, beräknad broöppning ${etaText}` : '';

    const countText = count === 1 ? 'En båt' : `${count} båtar`;

    switch (messageType) {
      case 'approaching':
        return `${countText} närmar sig ${this.bridgeName} på väg mot ${targetBridge}${etaSuffix}`;

      case 'special-waiting':
        // SPECIAL: "åker strax under" instead of "inväntar broöppning"
        return `${countText} åker strax under ${this.bridgeName} på väg mot ${targetBridge}${etaSuffix}`;

      case 'under-bridge':
        // SPECIAL: "passerar" instead of "broöppning pågår"
        return `${countText} passerar ${this.bridgeName} på väg mot ${targetBridge}${etaSuffix}`;

      case 'passed':
        return `${countText} har precis passerat ${this.bridgeName} på väg mot ${targetBridge}${etaSuffix}`;

      default:
        this.logger.log(`⚠️ [STALLBACKA_HELPER] Unknown message type: ${messageType}`);
        return `${countText} vid ${this.bridgeName} på väg mot ${targetBridge}${etaSuffix}`;
    }
  }

  /**
   * Check if vessel status should be overridden for Stallbackabron
   * @param {Object} vessel - Vessel object
   * @param {string} standardStatus - Standard status that would be assigned
   * @returns {string} Status to use (may be special stallbacka status)
   */
  getOverrideStatus(vessel, standardStatus) {
    if (!this.isStallbackabron(vessel.currentBridge)) {
      return standardStatus;
    }

    // Override "waiting" status with special Stallbackabron status
    if (standardStatus === 'waiting') {
      this.logger.debug(
        `🌉 [STALLBACKA_STATUS] ${vessel.mmsi}: Overriding 'waiting' with 'stallbacka-waiting'`,
      );
      return 'stallbacka-waiting';
    }

    return standardStatus;
  }

  /**
   * Check if vessel should never show standard "inväntar broöppning" message
   * @param {Object} vessel - Vessel object
   * @param {string} bridgeName - Bridge being checked
   * @returns {boolean} True if should block standard waiting message
   */
  shouldBlockStandardWaiting(vessel, bridgeName) {
    return this.isStallbackabron(bridgeName) && STALLBACKABRON_SPECIAL.NEVER_SHOW_WAITING;
  }

  /**
   * Get bridge object for Stallbackabron
   * @returns {Object|null} Stallbackabron bridge object or null if not found
   */
  getBridge() {
    return this.bridgeRegistry.getBridgeByName(this.bridgeName);
  }
}

module.exports = StallbackabronHelper;
