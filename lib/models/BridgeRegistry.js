'use strict';

const {
  BRIDGES, BRIDGE_SEQUENCE, TARGET_BRIDGES,
} = require('../constants');

/**
 * Bridge Registry - Centralized bridge management
 * Handles bridge lookups, validation, and relationships
 */
class BridgeRegistry {
  constructor(bridges = BRIDGES) {
    this.bridges = bridges;
    // BRIDGE_GAPS removed from constants - using direct calculation instead
    this.bridgeGaps = null; // Deprecated - will be removed
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
   * Get bridge object by name (case-sensitive)
   * @param {string} name - Bridge name
   * @returns {Object|null} Bridge object or null if not found
   */
  getBridgeByName(name) {
    const bridgeId = this.findBridgeIdByName(name);
    return bridgeId ? this.bridges[bridgeId] : null;
  }

  /**
   * Get bridge object by name (case-insensitive)
   * @param {string} name - Bridge name (any case)
   * @returns {Object|null} Bridge object or null if not found
   */
  getBridgeByNameInsensitive(name) {
    if (!name) return null;
    const lowerName = name.toLowerCase();
    for (const bridge of Object.values(this.bridges)) {
      if (bridge.name.toLowerCase() === lowerName) {
        return bridge;
      }
    }
    return null;
  }

  /**
   * Check if a bridge name is a valid target bridge
   * @param {string} bridgeName - Bridge name to check
   * @returns {boolean} True if bridge is a valid target
   */
  isValidTargetBridge(bridgeName) {
    // Case-sensitive check as TARGET_BRIDGES uses exact names
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
   * @deprecated This function uses removed BRIDGE_GAPS constant - returns fallback value
   * @param {string} fromBridgeId - Starting bridge ID
   * @param {string} toBridgeId - Ending bridge ID
   * @returns {number|null} Distance in meters or null if gap not defined
   */
  getDistanceBetweenBridges(fromBridgeId, toBridgeId) {
    // BRIDGE_GAPS has been removed - returning reasonable fallback
    // Known gaps: olide-klaff: 950m, klaff-jarnvag: 960m, jarnvag-stridsberg: 420m, stridsberg-stallbacka: 530m
    const knownGaps = {
      'olidebron-klaffbron': 950,
      'klaffbron-jarnvagsbron': 960,
      'jarnvagsbron-stridsbergsbron': 420,
      'stridsbergsbron-stallbackabron': 530,
    };
    const gapKey = `${fromBridgeId}-${toBridgeId}`;
    return knownGaps[gapKey] || 800; // Default fallback
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
   * @param {string} targetBridgeId - Target bridge ID or name
   * @returns {string[]} Array of bridge IDs that vessel will pass
   */
  getBridgesBetween(currentBridgeId, targetBridgeId) {
    // Normalize both parameters - could be either ID or name
    const normalizedCurrentId = this.normalizeToId(currentBridgeId);
    const normalizedTargetId = this.normalizeToId(targetBridgeId);

    const currentIndex = this.getBridgeSequenceIndex(normalizedCurrentId);
    const targetIndex = this.getBridgeSequenceIndex(normalizedTargetId);

    if (currentIndex === -1 || targetIndex === -1) {
      return [];
    }

    const start = Math.min(currentIndex, targetIndex);
    const end = Math.max(currentIndex, targetIndex);

    return this.bridgeSequence.slice(start, end + 1);
  }

  /**
   * Helper to normalize bridge identifier to ID
   * @param {string} bridgeIdentifier - Bridge ID or name
   * @returns {string|null} Bridge ID or null if not found
   */
  normalizeToId(bridgeIdentifier) {
    // Check if it's already a valid ID
    if (this.bridges[bridgeIdentifier]) {
      return bridgeIdentifier;
    }
    // Try to find by name
    return this.findBridgeIdByName(bridgeIdentifier);
  }

  /**
   * Helper to get bridge name from ID
   * @param {string} bridgeId - Bridge ID
   * @returns {string|null} Bridge name or null if not found
   */
  getNameById(bridgeId) {
    const bridge = this.bridges[bridgeId];
    return bridge ? bridge.name : null;
  }

  /**
   * Validate bridge configuration
   * @returns {Object} Validation result with any errors
   */
  validateConfiguration() {
    const errors = [];
    const warnings = [];

    // Check that all target bridges exist with exact case
    for (const targetBridge of this.targetBridges) {
      const foundId = this.findBridgeIdByName(targetBridge);
      if (!foundId) {
        errors.push(`Target bridge '${targetBridge}' not found in bridge configuration`);
      } else {
        // Check for exact case match
        const actualName = this.getNameById(foundId);
        if (actualName !== targetBridge) {
          warnings.push(`Target bridge case mismatch: '${targetBridge}' vs '${actualName}'`);
        }
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
      warnings,
    };
  }
}

module.exports = BridgeRegistry;
