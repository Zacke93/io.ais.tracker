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
    // B5-fix (2026-06-09): calculateDistance returnerar null vid ogiltiga
    // koordinater och null <= X är true i JS → falsk närhet. Infinity är det
    // säkra "vet ej"-värdet för alla avståndsjämförelser.
    const distance = geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
    return Number.isFinite(distance) ? distance : Infinity;
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
      // Fable-granskningen 2026-07-10b (GEO-3): break:en bröt invarianten
      // "bridges/bridgeDistances innehåller ALLA broar" (kommentaren nedan
      // lovar det) — en båt under Järnvägsbron saknade Stridsbergsbron
      // (257 m bort, inom 300 m-flowzonen) i bridgeDistances. Dagens
      // konsumenter har fallbacks, men nästa ärver fällan. Fortsätt samla
      // avstånd; under-bridge-prioriteten (första träffen vinner, övriga
      // zonanalyser hoppas över) bevaras via flaggan.
      if (analysis.underBridge && !result.underBridge) {
        result.underBridge = true;
        result.underBridgeName = bridge.name;
        result.zoneTransitions = [{
          bridgeId,
          bridgeName: bridge.name,
          transition: 'entered_under_bridge',
          distance,
        }];
        this.logger.debug(
          `🌉 [UNDER_BRIDGE_PRIORITY] ${vessel.mmsi}: Under ${bridge.name} (${distance.toFixed(0)}m) - zone analysis stops, distances continue`,
        );
        continue; // avstånd insamlade ovan; ingen zon-merge för denna bro
      }
      if (result.underBridge) {
        continue; // under-bridge äger zonresultatet — samla bara avstånd
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

  // Helgranskning 2026-07-06 (proximity-stabilizer#1/#2): de oanvända
  // metoderna getProtectionZoneStatus/getUnderBridgeStatus raderades — de
  // saknade B5-finitguarden (null <= X är true) och var latenta fällor för
  // framtida anropare. Ingen produktions- eller testkod refererade dem.
  // Fable-granskningen 2026-07-10b (GEO-1): isApproaching raderad av samma
  // skäl — död (noll anropare; StatusService har egen _isApproaching) och
  // med ovillkorlig isHeadingTowards-evaluering som KASTAR vid icke-finita
  // koordinater (calculateBearing throw:ar, till skillnad från
  // calculateDistance som returnerar null).

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

    // RC8-fix (2026-06-11): fartyg med AKTIV RESA (targetBridge satt) får inte
    // raderas mitt i normala leveransglapp. 19h-prodloggen: 219013101 togs bort
    // av 10-min-timern (300–600 m-zonen) under ett 15-min Klass B-glapp →
    // texten ljög "Inga båtar" i 5 min och båten återskapades som NY (journey-
    // state nollad). Observerade leveransglapp i samma logg: 10–18 min under
    // frisk anslutning. Minimum 30 min för aktiva resor — text-ÄRLIGHETEN
    // sköts separat (stale-exklusion vid 10 min i getVesselsForBridgeText,
    // RC7), så användaren ser aldrig den gamla datan; fartyget överlever bara
    // INTERNT så dedupe/failsafes/journey-kontinuitet bevaras.
    if (vessel.targetBridge) {
      baseTimeout = Math.max(baseTimeout, TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
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
    // SAFETY FIX: Robust formatting to prevent Infinity.toFixed() crashes
    const distanceText = Number.isFinite(result.nearestDistance)
      ? `${result.nearestDistance.toFixed(0)}m`
      : 'unknown';

    this.logger.debug(`🎯 [PROXIMITY_ANALYSIS] ${vessel.mmsi}:`, {
      nearestBridge: result.nearestBridge?.name,
      nearestDistance: distanceText,
      isApproaching: result.isApproaching,
      withinProtectionZone: result.withinProtectionZone,
      underBridge: result.underBridge,
      zoneTransitions: result.zoneTransitions.length,
      speed: Number.isFinite(vessel.sog) ? `${vessel.sog.toFixed(1)}kn` : 'okänd',
      // Fältprov 6 (2026-07-11): cog=null (AIS 360°) renderades som
      // 'undefined°' (217 rader i en körning) — optional chaining på null
      // ger undefined i template-literalen.
      course: Number.isFinite(vessel.cog) ? `${vessel.cog.toFixed(0)}°` : 'okänd',
    });

    // Log zone transitions
    // Fältprov 6 (2026-07-11, ELFKUNGEN): zoneTransition är en TILLSTÅNDS-
    // beskrivning som återberäknas varje analys — en frusen båt i skydds-
    // zonen loggade 'entered_protection_zone' 82 gånger i följd. Dedupa
    // ENDAST loggraden per mmsi+bro (result-strukturen är orörd — andra
    // konsumenter påverkas inte); logga igen först när transitionen ändras.
    if (!this._lastLoggedZoneTransition) this._lastLoggedZoneTransition = new Map();
    if (this._lastLoggedZoneTransition.size > 500) this._lastLoggedZoneTransition.clear(); // mmsi-churn-backstop
    for (const transition of result.zoneTransitions) {
      const dedupeKey = `${vessel.mmsi}:${transition.bridgeName}`;
      if (this._lastLoggedZoneTransition.get(dedupeKey) === transition.transition) continue;
      this._lastLoggedZoneTransition.set(dedupeKey, transition.transition);

      // SAFETY FIX: Robust distance formatting for transitions too
      const transitionDistanceText = Number.isFinite(transition.distance)
        ? `${transition.distance.toFixed(0)}m`
        : 'unknown';

      this.logger.debug(
        `🔄 [ZONE_TRANSITION] ${vessel.mmsi}: ${transition.transition} at ${transition.bridgeName} `
        + `(${transitionDistanceText})`,
      );
    }
  }
}

module.exports = ProximityService;
