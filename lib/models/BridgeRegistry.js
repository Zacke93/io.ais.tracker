'use strict';

const {
  BRIDGES, BRIDGE_SEQUENCE, TARGET_BRIDGES,
  VALIDATION_CONSTANTS, BRIDGE_GAPS,
} = require('../constants');
const { calculateDistance } = require('../utils/geometry');

/**
 * Bridge Registry - Centralized bridge management
 * Handles bridge lookups, validation, and relationships
 */
class BridgeRegistry {
  constructor(bridges = BRIDGES) {
    this.bridges = bridges;
    // Fable-granskningen 2026-08-10 (FG-E4): instansfältet `bridgeGaps = null`
    // raderat. Det var självdokumenterat oanvänt ("läses aldrig ... behålls
    // bara för bakåtkompatibilitet") men bakåtkompatibilitet mot VAD gick inte
    // att belägga: noll läsare i prod och test. Ett null-fält med ett namn som
    // lovar avstånd är en fälla — den som söker gapen ska hitta BRIDGE_GAPS
    // via getDistanceBetweenBridges nedan, inte ett tomt instansfält.
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
   * Get bridge object by ID (compatibility method)
   * @param {string} bridgeId - Bridge ID
   * @returns {Object|null} Bridge object or null if not found
   */
  getBridgeById(bridgeId) {
    return this.getBridge(bridgeId);
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

  // Fable-granskningen 2026-08-10 (FG-E4): getBridgeByNameInsensitive raderad
  // — noll referenser. Bronamnen kommer alltid från appens egna konstanter
  // (BRIDGES/TARGET_BRIDGES), aldrig från fritext, så den skiftlägesokänsliga
  // varianten fanns bara för ett anropsfall som inte finns.

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

  // Fable-granskningen 2026-08-10 (FG-E4): getAllBridgeNames raderad — noll
  // referenser. Den som behöver namnen läser TARGET_BRIDGES,
  // INTERMEDIATE_BRIDGES eller BRIDGE_ID_TO_NAME direkt ur constants.

  /**
   * Get distance between two bridges using centralized BRIDGE_GAPS
   * @param {string} fromBridgeId - Starting bridge ID
   * @param {string} toBridgeId - Ending bridge ID
   * @returns {number|null} Distance in meters or null if gap not defined
   */
  getDistanceBetweenBridges(fromBridgeId, toBridgeId) {
    // FIX: Use centralized BRIDGE_GAPS instead of duplicated hardcoded values
    // FIX: Support both directions - try forward key first, then reverse key
    const gapKey = `${fromBridgeId}-${toBridgeId}`;
    const reverseGapKey = `${toBridgeId}-${fromBridgeId}`;
    return BRIDGE_GAPS[gapKey] || BRIDGE_GAPS[reverseGapKey] || 800; // Default fallback for unknown gaps
  }

  // Fable-granskningen 2026-08-10 (FG-E4): getNextBridge och getPreviousBridge
  // raderade — noll referenser. Riktningslogiken frågar aldrig efter "nästa
  // bro i listan": den räknar mellanliggande broar via getBridgesBetween och
  // låter färdriktningen (COG/sekvensindex) avgöra ordningen, eftersom "nästa"
  // beror på om båten går norrut eller söderut — något dessa två inte visste.

  /**
   * Get bridge sequence index
   * @param {string} bridgeId - Bridge ID
   * @returns {number} Index in sequence (-1 if not found)
   */
  getBridgeSequenceIndex(bridgeId) {
    return this.bridgeSequence.indexOf(bridgeId);
  }

  // Fable-granskningen 2026-08-10 (FG-E4): isBridgeNorthOf och
  // getBridgesInSequence raderade — noll referenser. isBridgeNorthOf returnerade
  // dessutom `true` för okända bro-ID:n på B-sidan (indexA > -1), dvs. den
  // svarade "norr om" på en fråga den inte kunde besvara. getBridgeSequenceIndex
  // ovan LEVER (används av getBridgesBetween) och är den bärande primitiven.

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
   * Validate bridge configuration comprehensively
   * @returns {Object} Validation result with any errors
   */
  validateConfiguration() {
    const errors = [];
    const warnings = [];

    // 1. Validate basic bridge structure and required properties
    this._validateBridgeStructure(errors);

    // 2. Validate coordinate ranges and validity
    this._validateCoordinates(errors);

    // 3. Validate bridge uniqueness (names and coordinates)
    this._validateUniqueness(errors, warnings);

    // 4. Validate reasonable property values
    this._validateReasonableValues(errors, warnings);

    // 5. Validate bridge ordering (geographical south to north)
    this._validateBridgeOrdering(errors, warnings);

    // 6. Validate inter-bridge distances
    this._validateInterBridgeDistances(errors, warnings);

    // 7. Validate Trollhätte kanal system constraints
    this._validateCanalSystemConstraints(errors, warnings);

    // 8. Validate target bridge configuration
    this._validateTargetBridges(errors, warnings);

    // 9. Validate sequence bridge configuration
    this._validateSequenceBridges(errors);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate basic bridge structure and required properties
   * @param {string[]} errors - Array to collect errors
   * @private
   */
  _validateBridgeStructure(errors) {
    const requiredProps = ['name', 'lat', 'lon', 'radius', 'axisBearing'];

    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      if (!bridge || typeof bridge !== 'object') {
        errors.push(`Bridge '${bridgeId}' is not a valid object`);
        continue;
      }

      // Check required properties exist
      for (const prop of requiredProps) {
        if (!(prop in bridge)) {
          errors.push(`Bridge '${bridgeId}' missing required property '${prop}'`);
        }
      }

      // Check property types
      if (bridge.name !== undefined && typeof bridge.name !== 'string') {
        errors.push(`Bridge '${bridgeId}' name must be a string, got ${typeof bridge.name}`);
      }
      if (bridge.lat !== undefined && typeof bridge.lat !== 'number') {
        errors.push(`Bridge '${bridgeId}' lat must be a number, got ${typeof bridge.lat}`);
      }
      if (bridge.lon !== undefined && typeof bridge.lon !== 'number') {
        errors.push(`Bridge '${bridgeId}' lon must be a number, got ${typeof bridge.lon}`);
      }
      if (bridge.radius !== undefined && typeof bridge.radius !== 'number') {
        errors.push(`Bridge '${bridgeId}' radius must be a number, got ${typeof bridge.radius}`);
      }
      if (bridge.axisBearing !== undefined && typeof bridge.axisBearing !== 'number') {
        errors.push(`Bridge '${bridgeId}' axisBearing must be a number, got ${typeof bridge.axisBearing}`);
      }
    }
  }

  /**
   * Validate coordinate ranges and validity
   * @param {string[]} errors - Array to collect errors
   * @private
   */
  _validateCoordinates(errors) {
    const {
      LATITUDE_MIN, LATITUDE_MAX, LONGITUDE_MIN, LONGITUDE_MAX,
    } = VALIDATION_CONSTANTS;

    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      if (!bridge) continue;

      // Validate latitude range
      if (typeof bridge.lat === 'number') {
        if (!Number.isFinite(bridge.lat)) {
          errors.push(`Bridge '${bridgeId}' latitude is not a finite number: ${bridge.lat}`);
        } else if (bridge.lat < LATITUDE_MIN || bridge.lat > LATITUDE_MAX) {
          errors.push(`Bridge '${bridgeId}' latitude ${bridge.lat} is outside valid range [${LATITUDE_MIN}, ${LATITUDE_MAX}]`);
        }
      }

      // Validate longitude range
      if (typeof bridge.lon === 'number') {
        if (!Number.isFinite(bridge.lon)) {
          errors.push(`Bridge '${bridgeId}' longitude is not a finite number: ${bridge.lon}`);
        } else if (bridge.lon < LONGITUDE_MIN || bridge.lon > LONGITUDE_MAX) {
          errors.push(`Bridge '${bridgeId}' longitude ${bridge.lon} is outside valid range [${LONGITUDE_MIN}, ${LONGITUDE_MAX}]`);
        }
      }
    }
  }

  /**
   * Validate bridge uniqueness (names and coordinates)
   * @param {string[]} errors - Array to collect errors
   * @param {string[]} warnings - Array to collect warnings
   * @private
   */
  _validateUniqueness(errors, warnings) {
    const seenNames = new Map();
    const seenCoordinates = new Map();
    const COORDINATE_PRECISION = 6; // meters precision

    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      if (!bridge) continue;

      // Check name uniqueness
      if (bridge.name) {
        const existingId = seenNames.get(bridge.name);
        if (existingId) {
          errors.push(`Duplicate bridge name '${bridge.name}' found in bridges '${bridgeId}' and '${existingId}'`);
        } else {
          seenNames.set(bridge.name, bridgeId);
        }
      }

      // Check coordinate uniqueness (with small tolerance for floating point)
      if (typeof bridge.lat === 'number' && typeof bridge.lon === 'number') {
        const coordKey = `${bridge.lat.toFixed(COORDINATE_PRECISION)},${bridge.lon.toFixed(COORDINATE_PRECISION)}`;
        const existingId = seenCoordinates.get(coordKey);
        if (existingId) {
          warnings.push(`Bridges '${bridgeId}' and '${existingId}' have very similar coordinates (within ${COORDINATE_PRECISION} decimal places)`);
        } else {
          seenCoordinates.set(coordKey, bridgeId);
        }
      }
    }
  }

  /**
   * Validate reasonable property values
   * @param {string[]} errors - Array to collect errors
   * @param {string[]} warnings - Array to collect warnings
   * @private
   */
  _validateReasonableValues(errors, warnings) {
    const MIN_RADIUS = 10; // meters
    const MAX_RADIUS = 2000; // meters
    const MIN_AXIS_BEARING = 0;
    const MAX_AXIS_BEARING = 360;

    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      if (!bridge) continue;

      // Validate radius
      if (typeof bridge.radius === 'number') {
        if (!Number.isFinite(bridge.radius) || bridge.radius <= 0) {
          errors.push(`Bridge '${bridgeId}' radius must be a positive finite number, got ${bridge.radius}`);
        } else if (bridge.radius < MIN_RADIUS) {
          warnings.push(`Bridge '${bridgeId}' radius ${bridge.radius}m is very small (minimum recommended: ${MIN_RADIUS}m)`);
        } else if (bridge.radius > MAX_RADIUS) {
          warnings.push(`Bridge '${bridgeId}' radius ${bridge.radius}m is very large (maximum recommended: ${MAX_RADIUS}m)`);
        }
      }

      // Validate axis bearing
      if (typeof bridge.axisBearing === 'number') {
        if (!Number.isFinite(bridge.axisBearing)) {
          errors.push(`Bridge '${bridgeId}' axisBearing must be a finite number, got ${bridge.axisBearing}`);
        } else if (bridge.axisBearing < MIN_AXIS_BEARING || bridge.axisBearing >= MAX_AXIS_BEARING) {
          errors.push(`Bridge '${bridgeId}' axisBearing ${bridge.axisBearing} is outside valid range [${MIN_AXIS_BEARING}, ${MAX_AXIS_BEARING})`);
        }
      }
    }
  }

  /**
   * Validate bridge ordering (geographical south to north)
   * @param {string[]} errors - Array to collect errors
   * @param {string[]} warnings - Array to collect warnings
   * @private
   */
  _validateBridgeOrdering(errors, warnings) {
    // Check that bridges in sequence are actually ordered south to north by latitude
    for (let i = 0; i < this.bridgeSequence.length - 1; i++) {
      const currentId = this.bridgeSequence[i];
      const nextId = this.bridgeSequence[i + 1];

      const currentBridge = this.bridges[currentId];
      const nextBridge = this.bridges[nextId];

      if (currentBridge && nextBridge
          && typeof currentBridge.lat === 'number' && typeof nextBridge.lat === 'number') {

        // Next bridge should have higher latitude (more north)
        if (nextBridge.lat <= currentBridge.lat) {
          errors.push(`Bridge ordering error: '${nextId}' (lat: ${nextBridge.lat}) should be north of '${currentId}' (lat: ${currentBridge.lat}) but has same or lower latitude`);
        }

        // Warn if latitude difference is very small (might indicate error)
        const latDiff = Math.abs(nextBridge.lat - currentBridge.lat);
        if (latDiff < 0.001) { // ~100m at this latitude
          warnings.push(`Bridges '${currentId}' and '${nextId}' are very close in latitude (${latDiff.toFixed(6)} degrees, ~${Math.round(latDiff * 111000)}m)`);
        }
      }
    }
  }

  /**
   * Validate inter-bridge distances using actual coordinates
   * @param {string[]} errors - Array to collect errors
   * @param {string[]} warnings - Array to collect warnings
   * @private
   */
  _validateInterBridgeDistances(errors, warnings) {
    const MIN_BRIDGE_DISTANCE = 50; // meters - bridges should not be too close
    const MAX_BRIDGE_DISTANCE = 5000; // meters - bridges should not be too far apart in this canal
    // Helgranskning 2026-07-06: baslinjen speglar nu koordinaternas haversine
    // (samma korrigering som BRIDGE_GAPS: 950→1363, 420→257) — tidigare
    // motsade självtestet de koordinater det skulle validera.
    const EXPECTED_DISTANCES = {
      'olidebron-klaffbron': { expected: 1363, tolerance: 100 },
      'klaffbron-jarnvagsbron': { expected: 960, tolerance: 100 },
      'jarnvagsbron-stridsbergsbron': { expected: 257, tolerance: 50 },
      // Fable-granskningen 2026-08-10 (FG-E2, rev. koordinatverifieringen samma
      // dag): SKA bli 2226 när C0 landar (se BRIDGES.stallbackabron i
      // lib/constants.js — det tidigare C0-målet 2415 falsifierades av fem
      // oberoende indikatorer); 2310 stämmer mot dagens (felplacerade)
      // koordinatpunkt. Baslinjen måste flyttas i SAMMA commit som punkten
      // och som BRIDGE_GAPS-paret — annars faller självtestet.
      'stridsbergsbron-stallbackabron': { expected: 2310, tolerance: 300 },
    };

    // Validate distances between consecutive bridges
    for (let i = 0; i < this.bridgeSequence.length - 1; i++) {
      const bridgeId1 = this.bridgeSequence[i];
      const bridgeId2 = this.bridgeSequence[i + 1];

      const bridge1 = this.bridges[bridgeId1];
      const bridge2 = this.bridges[bridgeId2];

      if (bridge1 && bridge2
          && typeof bridge1.lat === 'number' && typeof bridge1.lon === 'number'
          && typeof bridge2.lat === 'number' && typeof bridge2.lon === 'number') {

        const distance = calculateDistance(bridge1.lat, bridge1.lon, bridge2.lat, bridge2.lon);

        if (distance === null) {
          errors.push(`Failed to calculate distance between bridges '${bridgeId1}' and '${bridgeId2}' - invalid coordinates`);
          continue;
        }

        // Check minimum distance
        if (distance < MIN_BRIDGE_DISTANCE) {
          errors.push(`Bridges '${bridgeId1}' and '${bridgeId2}' are too close: ${Math.round(distance)}m (minimum: ${MIN_BRIDGE_DISTANCE}m)`);
        }

        // Check maximum distance
        if (distance > MAX_BRIDGE_DISTANCE) {
          warnings.push(`Bridges '${bridgeId1}' and '${bridgeId2}' are very far apart: ${Math.round(distance)}m (typical max: ${MAX_BRIDGE_DISTANCE}m)`);
        }

        // Check against expected distances
        const gapKey = `${bridgeId1}-${bridgeId2}`;
        const expected = EXPECTED_DISTANCES[gapKey];
        if (expected) {
          const diff = Math.abs(distance - expected.expected);
          if (diff > expected.tolerance) {
            warnings.push(`Distance between '${bridgeId1}' and '${bridgeId2}' is ${Math.round(distance)}m, expected ~${expected.expected}m (tolerance: ±${expected.tolerance}m)`);
          }
        }
      }
    }
  }

  /**
   * Validate Trollhätte kanal system constraints
   * @param {string[]} errors - Array to collect errors
   * @param {string[]} warnings - Array to collect warnings
   * @private
   */
  _validateCanalSystemConstraints(errors, warnings) {
    const TROLLHATTE_KANAL_BOUNDS = {
      // Expected bounds for this section of Trollhätte kanal/Göta älv
      // (Fable-granskningen 2026-08-10: hette tidigare "Göta Kanal" — det är en
      // annan vattenväg, Sjötorp-Mem; broarna här korsar Trollhätte kanal)
      NORTH: 58.32,
      SOUTH: 58.26,
      EAST: 12.32,
      WEST: 12.26,
    };

    // Check all bridges are within the expected canal system bounds
    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      if (!bridge || typeof bridge.lat !== 'number' || typeof bridge.lon !== 'number') continue;

      if (bridge.lat < TROLLHATTE_KANAL_BOUNDS.SOUTH || bridge.lat > TROLLHATTE_KANAL_BOUNDS.NORTH) {
        warnings.push(`Bridge '${bridgeId}' latitude ${bridge.lat} is outside expected Trollhätte kanal bounds [${TROLLHATTE_KANAL_BOUNDS.SOUTH}, ${TROLLHATTE_KANAL_BOUNDS.NORTH}]`);
      }

      if (bridge.lon < TROLLHATTE_KANAL_BOUNDS.WEST || bridge.lon > TROLLHATTE_KANAL_BOUNDS.EAST) {
        warnings.push(`Bridge '${bridgeId}' longitude ${bridge.lon} is outside expected Trollhätte kanal bounds [${TROLLHATTE_KANAL_BOUNDS.WEST}, ${TROLLHATTE_KANAL_BOUNDS.EAST}]`);
      }
    }

    // Validate that bridges follow the canal's general orientation
    // Trollhätte kanal runs roughly NE-SW, so longitude should generally increase with latitude
    const bridgeCoords = this.bridgeSequence
      .map((id) => ({ id, bridge: this.bridges[id] }))
      .filter(({ bridge }) => bridge && typeof bridge.lat === 'number' && typeof bridge.lon === 'number')
      .map(({ id, bridge }) => ({ id, lat: bridge.lat, lon: bridge.lon }));

    if (bridgeCoords.length >= 2) {
      const firstBridge = bridgeCoords[0];
      const lastBridge = bridgeCoords[bridgeCoords.length - 1];

      // Last bridge should be both north and east of first bridge for this canal section
      if (lastBridge.lat <= firstBridge.lat) {
        warnings.push(`Canal orientation warning: Last bridge '${lastBridge.id}' should be north of first bridge '${firstBridge.id}'`);
      }
      if (lastBridge.lon <= firstBridge.lon) {
        warnings.push(`Canal orientation warning: Last bridge '${lastBridge.id}' should be east of first bridge '${firstBridge.id}'`);
      }
    }
  }

  /**
   * Validate target bridge configuration
   * @param {string[]} errors - Array to collect errors
   * @param {string[]} warnings - Array to collect warnings
   * @private
   */
  _validateTargetBridges(errors, warnings) {
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

    // Validate that target bridges are in the bridge sequence
    for (const targetBridge of this.targetBridges) {
      const bridgeId = this.findBridgeIdByName(targetBridge);
      if (bridgeId && !this.bridgeSequence.includes(bridgeId)) {
        errors.push(`Target bridge '${targetBridge}' (${bridgeId}) is not in the bridge sequence`);
      }
    }
  }

  /**
   * Validate sequence bridge configuration
   * @param {string[]} errors - Array to collect errors
   * @private
   */
  _validateSequenceBridges(errors) {
    // Check that all sequence bridges exist
    for (const bridgeId of this.bridgeSequence) {
      if (!this.bridges[bridgeId]) {
        errors.push(`Bridge sequence contains unknown bridge ID '${bridgeId}'`);
      }
    }

    // Check for duplicate bridges in sequence
    const seenIds = new Set();
    for (const bridgeId of this.bridgeSequence) {
      if (seenIds.has(bridgeId)) {
        errors.push(`Duplicate bridge ID '${bridgeId}' in bridge sequence`);
      }
      seenIds.add(bridgeId);
    }
  }
}

module.exports = BridgeRegistry;
