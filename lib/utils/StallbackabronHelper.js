'use strict';

const { STALLBACKABRON_SPECIAL, STATUS_HYSTERESIS } = require('../constants');
const geometry = require('./geometry');
const CountTextHelper = require('./CountTextHelper');

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
  _hasRecordedPassage(vessel) {
    return !!(vessel
      && (vessel._stallbackaPassedRegistered
        || vessel.lastPassedBridge === this.bridgeName
        || (Array.isArray(vessel.passedBridges) && vessel.passedBridges.includes(this.bridgeName))));
  }

  _markStallbackaPassed(vessel) {
    if (!vessel) return;
    vessel._stallbackaPassedRegistered = true;
    vessel._stallbackaWasUnder = false;
    if (!vessel.passedBridges) {
      vessel.passedBridges = [];
    }
    if (!vessel.passedBridges.includes(this.bridgeName)) {
      vessel.passedBridges.push(this.bridgeName);
    }
    vessel.lastPassedBridge = this.bridgeName;
    if (!vessel.lastPassedBridgeTime) {
      vessel.lastPassedBridgeTime = Date.now();
    }
  }

  _resetStallbackaFlagsIfFarAway(vessel, distance) {
    if (!vessel) return;
    const clearThreshold = STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE || 320;
    if (distance > clearThreshold) {
      vessel._stallbackaWasUnder = false;
      vessel._stallbackaPassedRegistered = false;
    }
  }

  getMessageType(vessel, distance) {
    const clearThreshold = STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE || 320;

    if (
      vessel
      && vessel._syntheticUnderBridgeBridgeName === this.bridgeName
      && vessel._syntheticUnderBridgeUntil
      && vessel._syntheticUnderBridgeUntil > Date.now()
    ) {
      vessel._stallbackaWasUnder = true;
      vessel._stallbackaPassedRegistered = false;
      return 'under-bridge';
    }

    if (distance <= 50) { // UNDER_BRIDGE_DISTANCE
      if (vessel) {
        vessel._stallbackaWasUnder = true;
        vessel._stallbackaPassedRegistered = false;
      }
      return 'under-bridge';
    }

    const stallbacka = this.bridgeRegistry.getBridgeByName(this.bridgeName);
    const bearingFromBridge = (stallbacka && Number.isFinite(vessel?.lat) && Number.isFinite(vessel?.lon))
      ? geometry.calculateBearing(stallbacka.lat, stallbacka.lon, vessel.lat, vessel.lon)
      : null;
    const isSouthOfBridge = bearingFromBridge !== null && bearingFromBridge > 135 && bearingFromBridge < 315;
    const movingSouth = typeof vessel?.cog === 'number' && vessel.cog > 135 && vessel.cog < 315;

    const wasUnder = vessel?._stallbackaWasUnder === true;
    if ((wasUnder || this._hasRecordedPassage(vessel) || isSouthOfBridge)
      && distance > 50 && distance <= clearThreshold && movingSouth) {
      this._markStallbackaPassed(vessel);
      return 'passed';
    }

    this._resetStallbackaFlagsIfFarAway(vessel, distance);

    if (distance <= 300) { // APPROACH_RADIUS
      return 'special-waiting'; // "åker strax under" instead of "inväntar broöppning"
    } if (distance <= 500) { // APPROACHING_RADIUS
      return 'approaching';
    }
    return 'en-route';
  }

  /**
   * Generate Stallbackabron-specific message
   * ENHANCED: Now handles all scenarios including multi-vessel cases
   * @param {Object} vessel - Vessel object
   * @param {string} messageType - Message type from getMessageType()
   * @param {string} etaText - Formatted ETA text (always includes ETA to target bridge)
   * @param {Object} options - Additional options
   * @param {number} options.count - Total number of vessels (default: 1)
   * @param {number} options.additionalCount - Number of additional vessels (for "ytterligare X båtar")
   * @param {boolean} options.hasValidTarget - Whether vessel has valid target bridge different from Stallbacka
   * @returns {string|null} Stallbackabron-specific message, or null if no valid target for certain cases
   */
  generateMessage(vessel, messageType, etaText = null, options = {}) {
    const {
      count = 1,
      additionalCount = 0,
      hasValidTarget = this._hasValidTargetBridge(vessel),
    } = options;

    const targetBridge = vessel.targetBridge || 'okänd målbro';
    const etaSuffix = etaText ? `, beräknad broöppning ${etaText}` : '';

    // Use shared helper for Swedish count text (no duplication)
    const getCountText = (num, lowercase = false) => CountTextHelper.getCountText(num, { lowercase });

    // Build additional vessels text for multi-vessel scenarios (correct Swedish style)
    const additionalText = CountTextHelper.buildAdditionalText(additionalCount);

    // For messages without valid target bridge (vessel leaving canal or target = Stallbacka)
    const withoutTarget = {
      approaching: `${getCountText(count)} båt${count > 1 ? 'ar' : ''} närmar sig ${this.bridgeName}${additionalText}`,
      'special-waiting': `${getCountText(count)} båt${count > 1 ? 'ar' : ''} åker strax under ${this.bridgeName}${additionalText}`,
      'under-bridge': `${getCountText(count)} båt${count > 1 ? 'ar' : ''} passerar ${this.bridgeName}${additionalText}`,
      passed: `${getCountText(count)} båt${count > 1 ? 'ar' : ''} har precis passerat ${this.bridgeName}${additionalText}`,
    };

    // For messages with valid target bridge
    const withTarget = {
      approaching: `${getCountText(count)} båt${count > 1 ? 'ar' : ''} närmar sig ${this.bridgeName} på väg mot ${targetBridge}${additionalText}${etaSuffix}`,
      'special-waiting': `${getCountText(count)} båt${count > 1 ? 'ar' : ''} åker strax under ${this.bridgeName} på väg mot ${targetBridge}${additionalText}${etaSuffix}`,
      'under-bridge': `${getCountText(count)} båt${count > 1 ? 'ar' : ''} passerar ${this.bridgeName} på väg mot ${targetBridge}${additionalText}${etaSuffix}`,
      passed: `${getCountText(count)} båt${count > 1 ? 'ar' : ''} har precis passerat ${this.bridgeName} på väg mot ${targetBridge}${additionalText}${etaSuffix}`,
      // CODEX FIX: Add explicit 'en-route' handling
      'en-route': `${getCountText(count)} båt${count > 1 ? 'ar' : ''} på väg mot ${targetBridge} via ${this.bridgeName}${etaSuffix}`,
    };

    // Choose appropriate message based on target validity
    const messages = hasValidTarget ? withTarget : withoutTarget;
    const message = messages[messageType];

    if (!message) {
      // CODEX FIX: Use logger.warn instead of logger.log for unknown types
      this.logger.warn(`⚠️ [STALLBACKA_HELPER] Unknown message type: ${messageType}`);
      return hasValidTarget
        ? `${getCountText(count)} båt${count > 1 ? 'ar' : ''} vid ${this.bridgeName} på väg mot ${targetBridge}${additionalText}${etaSuffix}`
        : `${getCountText(count)} båt${count > 1 ? 'ar' : ''} vid ${this.bridgeName}${additionalText}`;
    }

    return message;
  }

  /**
   * Check if vessel has valid target bridge (different from Stallbackabron)
   * @private
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if vessel has valid different target bridge
   */
  _hasValidTargetBridge(vessel) {
    return vessel.targetBridge
      && vessel.targetBridge !== this.bridgeName
      && this.bridgeRegistry.isValidTargetBridge
      && this.bridgeRegistry.isValidTargetBridge(vessel.targetBridge);
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
