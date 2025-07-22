'use strict';

const {
  BRIDGES, BRIDGE_GAPS, BRIDGE_SEQUENCE, TARGET_BRIDGES,
} = require('../constants');

/**
 * Bridge Registry - Centralized bridge management
 * Handles bridge lookups, validation, and relationships
 */
class BridgeRegistry {
  constructor(bridges = BRIDGES) {
    this.bridges = bridges;
    this.bridgeGaps = BRIDGE_GAPS;
    this.bridgeSequence = BRIDGE_SEQUENCE;
    this.targetBridges = TARGET_BRIDGES;
  }

  /**
   * Find bridge by name
   * @param {string} name - Bridge name
   * @returns {string|null} Bridge ID or null if not found
   */
  findBridgeIdByName(name) {
    for (const [id, bridge] of Object.entries(this.bridges)) {
      if (bridge.name === name) {
        return id;
      }
    }
    return null;
  }

  /**
   * Get bridge object by ID
   * @param {string} bridgeId - Bridge ID
   * @returns {Object|null} Bridge object or null if not found
   */
  getBridge(bridgeId) {
    return this.bridges[bridgeId] || null;
  }

  /**
   * Get bridge object by name
   * @param {string} name - Bridge name
   * @returns {Object|null} Bridge object or null if not found
   */
  getBridgeByName(name) {
    const bridgeId = this.findBridgeIdByName(name);
    return bridgeId ? this.bridges[bridgeId] : null;
  }

  /**
   * Check if a bridge name is a valid target bridge
   * @param {string} bridgeName - Bridge name to check
   * @returns {boolean} True if bridge is a valid target
   */
  isValidTargetBridge(bridgeName) {
    return this.targetBridges.includes(bridgeName);
  }

  /**
   * Get all bridge IDs
   * @returns {string[]} Array of bridge IDs
   */
  getAllBridgeIds() {
    return Object.keys(this.bridges);
  }

  /**
   * Get all bridge names
   * @returns {string[]} Array of bridge names
   */
  getAllBridgeNames() {
    return Object.values(this.bridges).map((bridge) => bridge.name);
  }

  /**
   * Get distance between two bridges
   * @param {string} fromBridgeId - Starting bridge ID
   * @param {string} toBridgeId - Ending bridge ID
   * @returns {number|null} Distance in meters or null if gap not defined
   */
  getDistanceBetweenBridges(fromBridgeId, toBridgeId) {
    const gapKey = `${fromBridgeId}-${toBridgeId}`;
    return this.bridgeGaps[gapKey] || null;
  }

  /**
   * Get the next bridge in sequence
   * @param {string} currentBridgeId - Current bridge ID
   * @returns {string|null} Next bridge ID or null if at end
   */
  getNextBridge(currentBridgeId) {
    const currentIndex = this.bridgeSequence.indexOf(currentBridgeId);
    if (currentIndex === -1 || currentIndex === this.bridgeSequence.length - 1) {
      return null;
    }
    return this.bridgeSequence[currentIndex + 1];
  }

  /**
   * Get the previous bridge in sequence
   * @param {string} currentBridgeId - Current bridge ID
   * @returns {string|null} Previous bridge ID or null if at start
   */
  getPreviousBridge(currentBridgeId) {
    const currentIndex = this.bridgeSequence.indexOf(currentBridgeId);
    if (currentIndex <= 0) {
      return null;
    }
    return this.bridgeSequence[currentIndex - 1];
  }

  /**
   * Get bridge sequence index
   * @param {string} bridgeId - Bridge ID
   * @returns {number} Index in sequence (-1 if not found)
   */
  getBridgeSequenceIndex(bridgeId) {
    return this.bridgeSequence.indexOf(bridgeId);
  }

  /**
   * Check if bridge A is north of bridge B
   * @param {string} bridgeAId - Bridge A ID
   * @param {string} bridgeBId - Bridge B ID
   * @returns {boolean} True if A is north of B
   */
  isBridgeNorthOf(bridgeAId, bridgeBId) {
    const indexA = this.getBridgeSequenceIndex(bridgeAId);
    const indexB = this.getBridgeSequenceIndex(bridgeBId);
    return indexA > indexB;
  }

  /**
   * Get bridges in order from south to north
   * @returns {Array} Array of bridge objects with IDs
   */
  getBridgesInSequence() {
    return this.bridgeSequence.map((bridgeId) => {
      const bridge = this.bridges[bridgeId];
      return {
        id: bridgeId,
        name: bridge.name,
        lat: bridge.lat,
        lon: bridge.lon,
        radius: bridge.radius,
      };
    });
  }

  /**
   * Find bridges that a vessel might pass between current and target
   * @param {string} currentBridgeId - Current bridge ID
   * @param {string} targetBridgeId - Target bridge ID
   * @returns {string[]} Array of bridge IDs that vessel will pass
   */
  getBridgesBetween(currentBridgeId, targetBridgeId) {
    const currentIndex = this.getBridgeSequenceIndex(currentBridgeId);
    const targetIndex = this.getBridgeSequenceIndex(this.findBridgeIdByName(targetBridgeId));

    if (currentIndex === -1 || targetIndex === -1) {
      return [];
    }

    const start = Math.min(currentIndex, targetIndex);
    const end = Math.max(currentIndex, targetIndex);

    return this.bridgeSequence.slice(start, end + 1);
  }

  /**
   * Validate bridge configuration
   * @returns {Object} Validation result with any errors
   */
  validateConfiguration() {
    const errors = [];

    // Check that all target bridges exist
    for (const targetBridge of this.targetBridges) {
      if (!this.findBridgeIdByName(targetBridge)) {
        errors.push(`Target bridge '${targetBridge}' not found in bridge configuration`);
      }
    }

    // Check that all sequence bridges exist
    for (const bridgeId of this.bridgeSequence) {
      if (!this.bridges[bridgeId]) {
        errors.push(`Bridge sequence contains unknown bridge ID '${bridgeId}'`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

module.exports = BridgeRegistry;
