'use strict';

const {
  BRIDGE_TEXT_CONSTANTS, BRIDGE_SEQUENCE, TARGET_BRIDGES, INTERMEDIATE_BRIDGES,
  PASSAGE_TIMING, COG_DIRECTIONS,
} = require('../constants');
const ETAFormatter = require('../utils/ETAFormatter');
const { isValidETA, formatETA } = require('../utils/etaValidation');
const CountTextHelper = require('../utils/CountTextHelper');

// 1 knot = 1852m / 60s ≈ 30.867 m/min
const KNOTS_TO_M_PER_MIN = 30.867;
const PHASE2_HYSTERESIS_MS = 90000; // 90s — how long Phase 2 "sticks" to prevent oscillation

/**
 * BridgeTextService - 4-phase bridge text generation
 *
 * Phase 1 (Approach):  ETA > 3 min  → distance + ETA text
 * Phase 2 (Imminent):  ETA ≤ 3 min  → waiting / "passerar strax" (Stallbacka)
 * Phase 3 (Opening):   _bridgeOpeningUntil > now (30s) → "Broöppning pågår" / "passerar" (Stallbacka)
 * Phase 4 (Passed):    After opening window, 30s → "precis passerat"
 */
class BridgeTextService {
  constructor(bridgeRegistry, logger, systemCoordinator = null, vesselDataService = null, passageLatchService = null) {
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
    this.etaFormatter = new ETAFormatter(bridgeRegistry, logger);
    this.systemCoordinator = systemCoordinator;
    this.vesselDataService = vesselDataService;
    this._phase3Shown = new Map(); // mmsi → { bridge, time } — tracks Phase 3 displays
    this._phase2Shown = new Map(); // mmsi → { bridge, time } — hysteresis for Phase 2
    this._phase4Shown = new Map(); // mmsi → { bridge, time } — "at least once" guarantee for Phase 4
  }

  /** Remove phase tracking entries for a vessel (call on vessel removal) */
  clearVesselPhaseTracking(mmsi) {
    if (mmsi) {
      this._phase2Shown.delete(mmsi);
      this._phase3Shown.delete(mmsi);
      this._phase4Shown.delete(mmsi);
    }
  }

  /** Clear all phase tracking state */
  resetPhaseTracking() {
    this._phase2Shown.clear();
    this._phase3Shown.clear();
    this._phase4Shown.clear();
  }

  /** Delegate to CountTextHelper */
  getCountText(count) {
    return CountTextHelper.getCountText(count);
  }

  /**
   * Generate bridge text from vessel data — pure function.
   * @param {Object[]} vessels - Array of relevant vessel objects
   * @returns {string} Human-readable bridge status message
   */
  generateBridgeText(vessels) {
    try {
      // --- 1. Filter out GPS-hold vessels ---
      if (this.vesselDataService && vessels && vessels.length > 0) {
        vessels = vessels.filter(
          (v) => v && v.mmsi && !this.vesselDataService.hasGpsJumpHold(v.mmsi),
        );
      }

      // --- 2. No vessels → default ---
      if (!vessels || vessels.length === 0) {
        return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      }

      // --- 3. Keep only vessels with mmsi + name ---
      const valid = vessels.filter((v) => v && v.mmsi && v.name);
      if (valid.length === 0) {
        return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      }

      // --- 4. Group by direction ---
      const northbound = [];
      const southbound = [];

      for (const v of valid) {
        const dir = this._getDirection(v);
        if (dir === 'north') {
          northbound.push(v);
        } else if (dir === 'south') {
          southbound.push(v);
        }
        // Vessels with unknown direction are silently dropped
      }

      if (northbound.length === 0 && southbound.length === 0) {
        return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      }

      // --- 5. Generate one phrase per direction ---
      const phrases = [];
      const northPhrase = this._generateDirectionPhrase(northbound, 'north');
      if (northPhrase) phrases.push(northPhrase);

      const southPhrase = this._generateDirectionPhrase(southbound, 'south');
      if (southPhrase) phrases.push(southPhrase);

      if (phrases.length === 0) {
        return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      }

      return phrases.join('; ');
    } catch (error) {
      this.logger.error('❌ [BRIDGE_TEXT] Error generating bridge text:', error.message);
      return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
    }
  }

  // ===========================================================================
  // Direction + bridge helpers (pure, no state)
  // ===========================================================================

  /**
   * Determine vessel direction from route hints or COG.
   * @param {Object} vessel
   * @returns {'north'|'south'|null}
   */
  _getDirection(vessel) {
    if (!vessel) return null;

    // During passage-transition, prioritize COG over potentially stale _routeDirection
    if (this._isJustPassed(vessel) && Number.isFinite(vessel.cog)) {
      const nb = vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX;
      return nb ? 'north' : 'south';
    }

    if (typeof vessel._routeDirection === 'string') {
      return vessel._routeDirection.startsWith('north') ? 'north' : 'south';
    }
    if (typeof vessel._finalTargetDirection === 'string') {
      return vessel._finalTargetDirection.startsWith('north') ? 'north' : 'south';
    }
    if (Number.isFinite(vessel.cog)) {
      const nb = vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX;
      return nb ? 'north' : 'south';
    }
    if (vessel.targetBridge === 'Stridsbergsbron') return 'north';
    if (vessel.targetBridge === 'Klaffbron') return 'south';
    return null;
  }

  _isTargetBridge(name) {
    return TARGET_BRIDGES.includes(name);
  }

  _isIntermediateBridge(name) {
    return INTERMEDIATE_BRIDGES.includes(name);
  }

  static _isStallbackabron(name) {
    return name === 'Stallbackabron';
  }

  /**
   * Check if there is an unpassed intermediate bridge between vessel and target.
   * Prevents premature Phase 2 for target when intermediate bridges are pending.
   */
  _hasUnpassedIntermediateBefore(vessel, target, direction) {
    if (!vessel || !target) return false;
    const targetIdx = BRIDGE_SEQUENCE.indexOf(
      BRIDGE_SEQUENCE.find((id) => {
        const name = this.bridgeRegistry.getBridgeById(id)?.name;
        return name === target;
      }),
    );
    if (targetIdx === -1) return false;

    const step = direction === 'north' ? 1 : -1;
    // Walk from the bridge BEFORE the target (in travel direction) back toward the vessel
    let idx = targetIdx - step;
    while (idx >= 0 && idx < BRIDGE_SEQUENCE.length) {
      const bridgeId = BRIDGE_SEQUENCE[idx];
      const name = this.bridgeRegistry.getBridgeById(bridgeId)?.name;
      if (!name) { idx -= step; continue; }
      // Stop if we hit the last passed bridge or a previously passed bridge
      if (vessel.lastPassedBridge === name) break;
      if (vessel.passedBridges && vessel.passedBridges.includes(name)) { idx -= step; continue; }
      // Found an unpassed intermediate bridge between vessel and target
      if (INTERMEDIATE_BRIDGES.includes(name)) return true;
      idx -= step;
    }
    return false;
  }

  /**
   * Get next target bridge after a given bridge, in the given direction.
   * @param {string} lastPassedBridge - Bridge name (e.g. 'Olidebron')
   * @param {string|number} courseOrDirection - 'north'/'south' or COG degrees
   * @returns {string|null}
   */
  getNextBridgeAfter(lastPassedBridge, courseOrDirection) {
    if (!lastPassedBridge) return null;

    const bridgeIndex = BRIDGE_SEQUENCE.indexOf(lastPassedBridge.toLowerCase());
    if (bridgeIndex === -1) {
      // Try by name → id lookup
      const id = this.bridgeRegistry.findBridgeIdByName(lastPassedBridge);
      if (!id) return null;
      return this.getNextBridgeAfter(id, courseOrDirection);
    }

    let isNorthbound;
    if (typeof courseOrDirection === 'string') {
      const n = courseOrDirection.toLowerCase();
      if (n.startsWith('north')) isNorthbound = true;
      else if (n.startsWith('south')) isNorthbound = false;
    } else if (Number.isFinite(courseOrDirection)) {
      isNorthbound = courseOrDirection >= 315 || courseOrDirection <= 45;
    }
    if (typeof isNorthbound !== 'boolean') return null;

    const step = isNorthbound ? 1 : -1;
    let idx = bridgeIndex + step;
    while (idx >= 0 && idx < BRIDGE_SEQUENCE.length) {
      const nextId = BRIDGE_SEQUENCE[idx];
      const name = this.bridgeRegistry.getBridgeById(nextId)?.name;
      if (name && TARGET_BRIDGES.includes(name)) return name;
      idx += step;
    }
    return null;
  }

  // ===========================================================================
  // ETA helpers (delegating to ETAFormatter)
  // ===========================================================================

  /**
   * Get formatted ETA string for a vessel toward its target bridge.
   * Bug B fix: prefer vessel.etaMinutes (EMA-smoothed from AIS updates)
   * over recalculating from distance/speed to prevent oscillation.
   * @param {Object} vessel
   * @param {string} targetBridge
   * @returns {string|null} e.g. "om 5 minuter"
   */
  _getETA(vessel, targetBridge) {
    // Bug B fix: prefer EMA-smoothed etaMinutes when available
    if (isValidETA(vessel.etaMinutes)) {
      return formatETA(vessel.etaMinutes);
    }
    // Fall back to ETAFormatter calculation only if etaMinutes unavailable
    if (!targetBridge) {
      return this.etaFormatter.formatETAWithContext(vessel, {
        allowWaiting: true,
        contextName: 'STATELESS',
      });
    }
    return this.etaFormatter.formatETAWithContext(vessel, {
      allowWaiting: true,
      calculateIfMissing: true,
      targetBridge,
      contextName: 'STATELESS',
    });
  }

  /**
   * Get raw ETA in minutes for phase threshold checks.
   * @param {Object} vessel
   * @returns {number|null}
   */
  _getETAMinutes(vessel) {
    if (isValidETA(vessel.etaMinutes)) {
      return vessel.etaMinutes;
    }
    // Fallback: calculate from distance to current bridge and speed
    // Guard: don't use distance to a bridge the vessel just passed (distance is behind, not ahead)
    const dist = vessel.distanceToCurrent;
    if (Number.isFinite(dist) && Number.isFinite(vessel.sog) && vessel.sog > 0.3
        && vessel.currentBridge !== vessel.lastPassedBridge) {

      return dist / (vessel.sog * KNOTS_TO_M_PER_MIN);
    }
    return null;
  }

  // ===========================================================================
  // Phase detection helpers
  // ===========================================================================

  /**
   * Check if vessel is in bridge opening phase (Phase 3).
   * @param {Object} vessel
   * @returns {boolean}
   */
  _isBridgeOpening(vessel) {
    // Standard: time window still active
    if (vessel._bridgeOpeningUntil && vessel._bridgeOpeningUntil > Date.now()) {
      return true;
    }
    // "At least once" guarantee: Phase 3 text never shown but passage was recent
    if (vessel._bridgeOpeningBridgeName && vessel._bridgeOpeningTextShown === false) {
      const passedAge = vessel.lastPassedBridgeTime
        ? Date.now() - vessel.lastPassedBridgeTime : Infinity;
      return passedAge < PASSAGE_TIMING.PASSED_HOLD_MS;
    }
    return false;
  }

  /**
   * Check if vessel has recently passed a bridge (combined 60s window: Phase 3 + Phase 4).
   * @param {Object} vessel
   * @returns {boolean}
   */
  _isJustPassed(vessel) {
    if (!vessel.lastPassedBridge || !vessel.lastPassedBridgeTime) return false;
    const elapsed = Date.now() - vessel.lastPassedBridgeTime;
    return elapsed <= PASSAGE_TIMING.PASSED_HOLD_MS;
  }

  // ===========================================================================
  // Core text generation — 4-phase model
  // ===========================================================================

  /**
   * Generate ONE phrase for a direction group.
   * @param {Object[]} vessels - Vessels going the same direction
   * @param {'north'|'south'} direction
   * @returns {string|null}
   */
  _generateDirectionPhrase(vessels, direction) {
    if (!vessels || vessels.length === 0) return null;

    // Sort by priority: under-bridge (closest) first, then by distance ascending
    const sorted = [...vessels].sort((a, b) => {
      const pa = this._vesselPriority(a);
      const pb = this._vesselPriority(b);
      if (pa !== pb) return pa - pb;
      return (a.distanceToCurrent || a.distance || 9999)
        - (b.distanceToCurrent || b.distance || 9999);
    });

    const lead = sorted[0];
    const additionalCount = sorted.length - 1;

    // Determine the bridge + distance for the lead vessel
    const bridgeName = this._resolveBridge(lead);
    const dist = this._resolveDistance(lead, bridgeName);
    const targetBridge = this._resolveTargetBridge(lead, bridgeName, direction);
    const eta = this._getETA(lead, targetBridge);
    const etaMinutes = this._getETAMinutes(lead);

    // --- Phase 3: Bridge opening (30s window from passage detection OR physically under bridge <50m) ---
    const isPhase3 = this._isBridgeOpening(lead) || (dist !== null && dist < 50 && bridgeName);
    if (isPhase3) {
      const openingBridge = this._isBridgeOpening(lead)
        ? (lead._bridgeOpeningBridgeName || bridgeName || lead.lastPassedBridge)
        : bridgeName;
      lead._bridgeOpeningTextShown = true; // G4: mark Phase 3 as shown
      lead._bridgeOpeningBridgeName = openingBridge; // G4/G5: track which bridge
      if (lead.mmsi) this._phase3Shown.set(lead.mmsi, { bridge: openingBridge, time: Date.now() });
      if (BridgeTextService._isStallbackabron(openingBridge)) {
        return this._buildStallbackaPasserar(openingBridge, targetBridge, eta, additionalCount);
      }
      return this._buildUnderBridge(openingBridge, targetBridge, eta, additionalCount);
    }

    // --- Phase 2 (Stallbackabron special): ETA to current bridge ≤ 3 min ---
    // etaMinutes = ETA to TARGET bridge, not to Stallbackabron.
    // Calculate local ETA to Stallbackabron using distance and SOG.
    if (bridgeName && BridgeTextService._isStallbackabron(bridgeName) && dist !== null && lead.sog > 0.3) {

      const etaToCurrentMinutes = dist / (lead.sog * KNOTS_TO_M_PER_MIN);
      if (etaToCurrentMinutes <= BRIDGE_TEXT_CONSTANTS.IMMINENT_ETA_THRESHOLD_MINUTES) {
        return this._buildStallbackaImminent(bridgeName, targetBridge, eta, additionalCount);
      }
    }

    // --- Phase 2 (intermediate opening bridge, not Stallbacka): local ETA ≤ 3 min ---
    // Guard: don't show "inväntar" for a bridge the vessel has already passed/opened
    const phase3Entry = lead.mmsi ? this._phase3Shown.get(lead.mmsi) : null;
    const phase3RecentForBridge = phase3Entry
      && phase3Entry.bridge === bridgeName
      && (Date.now() - phase3Entry.time) < PASSAGE_TIMING.PASSED_HOLD_MS;
    const alreadyPassedIntermediate = lead.lastPassedBridge === bridgeName
      || (lead.passedBridges && lead.passedBridges.includes(bridgeName))
      || phase3RecentForBridge;
    if (bridgeName && this._isIntermediateBridge(bridgeName)
        && !BridgeTextService._isStallbackabron(bridgeName)
        && !alreadyPassedIntermediate
        && dist !== null && lead.sog > 0.3) {

      const etaToCurrentMinutes = dist / (lead.sog * KNOTS_TO_M_PER_MIN);
      if (etaToCurrentMinutes <= BRIDGE_TEXT_CONSTANTS.IMMINENT_ETA_THRESHOLD_MINUTES) {
        return this._buildWaitingAtBridge(bridgeName, additionalCount, targetBridge, eta);
      }
    }

    // G5b: Stationary near intermediate bridge (sog ≤ 0.5, dist < 150m)
    const isStationaryNearIntermediate = bridgeName
      && this._isIntermediateBridge(bridgeName)
      && !BridgeTextService._isStallbackabron(bridgeName)
      && !alreadyPassedIntermediate
      && dist !== null && dist < 150 && lead.sog <= 0.5;
    if (isStationaryNearIntermediate) {
      return this._buildWaitingAtBridge(bridgeName, additionalCount, targetBridge, eta);
    }

    // --- Phase 4: Just passed (within hold window OR completed journey) ---
    // "At least once" guarantee: Phase 4 always displays at least one time before yielding
    // to Phase 2/3 for the next bridge. After being shown, yields immediately at close bridge pairs.

    // Fix 4: Rensa stale Phase 4-poster när lastPassedBridge har avancerat.
    // Förhindrar att "precis passerat [gammal bro]" visas efter att en nyare bro passerats.
    if (lead.mmsi && lead.lastPassedBridge) {
      const existingPhase4 = this._phase4Shown.get(lead.mmsi);
      if (existingPhase4 && existingPhase4.bridge !== lead.lastPassedBridge) {
        this._phase4Shown.delete(lead.mmsi);
      }
    }

    const phase4Entry = lead.mmsi ? this._phase4Shown.get(lead.mmsi) : null;
    const phase4ShownForCurrentBridge = phase4Entry
      && phase4Entry.bridge === lead.lastPassedBridge;
    const nearNextTarget = bridgeName && this._isTargetBridge(bridgeName)
      && bridgeName !== lead.lastPassedBridge && dist !== null && dist < 300;
    // Near next target AND already shown → yield. Not yet shown → keep active.
    const effectiveJustPassed = nearNextTarget
      ? (phase4ShownForCurrentBridge ? false : this._isJustPassed(lead))
      : this._isJustPassed(lead);
    const completedJourney = lead.lastPassedBridge && !targetBridge;
    const nearTargetBridge = bridgeName && this._isTargetBridge(bridgeName)
      && bridgeName !== lead.lastPassedBridge
      && dist !== null && dist < 150 && lead.sog > 0.3;
    if ((effectiveJustPassed || completedJourney) && !this._isBridgeOpening(lead) && !nearTargetBridge) {
      const passedBridge = lead.lastPassedBridge;
      const nextTarget = targetBridge
        || this.getNextBridgeAfter(passedBridge, direction);
      if (lead.mmsi) this._phase4Shown.set(lead.mmsi, { bridge: passedBridge, time: Date.now() });
      return this._buildPassed(passedBridge, nextTarget, eta, additionalCount);
    }

    // --- Phase 2: Imminent (ETA ≤ 3 min OR stationary near target bridge) ---
    const targetETA = isValidETA(lead.etaMinutes) ? lead.etaMinutes : null;
    const isImminentETA = targetETA !== null && targetETA <= BRIDGE_TEXT_CONSTANTS.IMMINENT_ETA_THRESHOLD_MINUTES;
    const isStationaryNearTarget = dist !== null && dist < 150 && lead.sog <= 0.5
      && bridgeName && this._isTargetBridge(bridgeName);
    const isLocalImminentTarget = targetETA === null
      && bridgeName && this._isTargetBridge(bridgeName)
      && bridgeName !== lead.lastPassedBridge
      && dist !== null && lead.sog > 0.3
      && (dist / (lead.sog * KNOTS_TO_M_PER_MIN)) <= BRIDGE_TEXT_CONSTANTS.IMMINENT_ETA_THRESHOLD_MINUTES;

    // J1: Hysteresis — if Phase 2 was recently shown, keep it to prevent oscillation
    const phase2Entry = lead.mmsi ? this._phase2Shown.get(lead.mmsi) : null;
    const phase2Recent = phase2Entry
      && (Date.now() - phase2Entry.time) < PHASE2_HYSTERESIS_MS
      && !this._isBridgeOpening(lead);

    // Guard: don't show Phase 2 for target if an unpassed intermediate bridge lies between vessel and target
    const hasUnpassedIntermediate = targetBridge
      && bridgeName !== targetBridge
      && this._hasUnpassedIntermediateBefore(lead, targetBridge, direction);

    if ((isImminentETA || isStationaryNearTarget || isLocalImminentTarget || phase2Recent)
        && !hasUnpassedIntermediate) {
      if (BridgeTextService._isStallbackabron(bridgeName)) {
        if (lead.mmsi) this._phase2Shown.set(lead.mmsi, { bridge: bridgeName, time: Date.now() });
        return this._buildStallbackaImminent(bridgeName, targetBridge, eta, additionalCount);
      }
      // Waiting at target bridge — use the target bridge for the text
      const waitBridge = (bridgeName && this._isTargetBridge(bridgeName))
        ? bridgeName
        : (phase2Recent && !(isImminentETA || isStationaryNearTarget || isLocalImminentTarget)
          ? phase2Entry.bridge
          : targetBridge);
      if (waitBridge) {
        if (lead.mmsi) this._phase2Shown.set(lead.mmsi, { bridge: waitBridge, time: Date.now() });
        // For target bridges: show "på väg mot [next target]" for directionality
        const waitTarget = (this._isTargetBridge(waitBridge) && waitBridge === targetBridge)
          ? this.getNextBridgeAfter(waitBridge, direction)
          : targetBridge;
        return this._buildWaitingAtBridge(waitBridge, additionalCount, waitTarget, eta);
      }
    }

    // --- Phase 1: Approach (default — ETA > 3 min or no ETA) ---

    // Close (<500m) — show distance
    if (dist !== null && dist < 500 && bridgeName) {
      const roundedDist = Math.round(dist);
      if (BridgeTextService._isStallbackabron(bridgeName)) {
        return this._buildStallbackaNear(bridgeName, roundedDist, targetBridge, eta, additionalCount);
      }
      return this._buildNear(bridgeName, roundedDist, targetBridge, eta, additionalCount);
    }

    // Far (≥500m) — "på väg mot"
    if (targetBridge) {
      return this._buildEnRoute(targetBridge, eta, additionalCount);
    }

    // Fallback: use whatever bridge info we have
    if (bridgeName && dist !== null) {
      const roundedDist = Math.round(dist);
      return this._buildNear(bridgeName, roundedDist, targetBridge, eta, additionalCount);
    }

    return null;
  }

  /**
   * Priority score: lower = more important (shown first).
   * Under-bridge → 0, close → 1, far → 2, passed → 3.
   */
  _vesselPriority(vessel) {
    const dist = vessel.distanceToCurrent ?? vessel.distance ?? 9999;
    if (dist < 50) return 0;
    if (this._isJustPassed(vessel)) return 3;
    if (dist < 500) return 1;
    return 2;
  }

  /**
   * Resolve which bridge to use for text (currentBridge preferred).
   */
  _resolveBridge(vessel) {
    return vessel.currentBridge || null;
  }

  /**
   * Resolve the distance to the relevant bridge.
   */
  _resolveDistance(vessel, bridgeName) {
    if (bridgeName && Number.isFinite(vessel.distanceToCurrent)) {
      return vessel.distanceToCurrent;
    }
    if (Number.isFinite(vessel.distance)) {
      return vessel.distance;
    }
    return null;
  }

  /**
   * Resolve the target bridge for text generation.
   * Bug A fix: fallback derives target from currentBridge + direction
   * instead of hardcoding terminal bridge.
   */
  _resolveTargetBridge(vessel, bridgeName, direction) {
    // If just passed target bridge, derive next target via bridge order
    if (this._isJustPassed(vessel) && vessel.targetBridge === vessel.lastPassedBridge) {
      return this.getNextBridgeAfter(vessel.lastPassedBridge, direction);
    }

    // Handle targetBridge=null/"none" during passage-transition
    if (this._isJustPassed(vessel) && (!vessel.targetBridge || vessel.targetBridge === 'none')) {
      return this.getNextBridgeAfter(vessel.lastPassedBridge, direction);
    }

    // If the current bridge IS a target bridge (and not already passed)
    if (bridgeName && this._isTargetBridge(bridgeName)) {
      const hasPassedThisBridge = vessel.passedBridges && vessel.passedBridges.includes(bridgeName);
      const isLastPassed = vessel.lastPassedBridge === bridgeName;
      if (!hasPassedThisBridge && !isLastPassed) {
        return bridgeName;
      }
    }

    // Use vessel's assigned target bridge if valid
    if (vessel.targetBridge && this._isTargetBridge(vessel.targetBridge)) {
      const hasPassedTarget = vessel.passedBridges && vessel.passedBridges.includes(vessel.targetBridge);
      const isLastPassed = vessel.lastPassedBridge === vessel.targetBridge;
      if (!hasPassedTarget && !isLastPassed) {
        return vessel.targetBridge;
      }
    }

    // Derive from lastPassedBridge
    if (vessel.lastPassedBridge) {
      const nextAfterPassed = this.getNextBridgeAfter(vessel.lastPassedBridge, direction);
      if (nextAfterPassed) return nextAfterPassed;
    }

    // Bug A fix: derive from currentBridge position in bridge sequence
    if (bridgeName) {
      const bridgeId = this.bridgeRegistry.findBridgeIdByName(bridgeName);
      if (bridgeId) {
        const nextTarget = this.getNextBridgeAfter(bridgeId, direction);
        if (nextTarget) return nextTarget;
      }
    }

    // Bug A fix: position-based fallback — find nearest bridge, derive next target
    if (Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
      let nearestId = null;
      let nearestDistSq = Infinity;
      for (const [id, b] of Object.entries(this.bridgeRegistry.bridges)) {
        if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) continue;
        const dlat = vessel.lat - b.lat;
        const dlon = vessel.lon - b.lon;
        const distSq = dlat * dlat + dlon * dlon;
        if (distSq < nearestDistSq) {
          nearestDistSq = distSq;
          nearestId = id;
        }
      }
      if (nearestId) {
        const nextTarget = this.getNextBridgeAfter(nearestId, direction);
        if (nextTarget) return nextTarget;
      }
    }

    return null;
  }

  // ===========================================================================
  // Message builders
  // ===========================================================================

  _buildAdditional(count) {
    return CountTextHelper.buildAdditionalText(count);
  }

  /**
   * Phase 1: "En båt på väg mot [target], beräknad broöppning [eta]"
   */
  _buildEnRoute(targetBridge, eta, additionalCount) {
    const etaSuffix = eta ? `, ETA ${eta}` : '';
    const additional = this._buildAdditional(additionalCount);
    return `En båt på väg mot ${targetBridge}${etaSuffix}${additional}`;
  }

  /**
   * Phase 1: "En båt [dist]m från [bro], beräknad broöppning [eta]"
   * For target bridges: bridge IS the target, no "på väg mot".
   * For intermediate bridges: include "på väg mot [target]".
   */
  _buildNear(bridgeName, dist, targetBridge, eta, additionalCount) {
    let etaSuffix = '';
    if (eta) {
      etaSuffix = `, ETA ${eta}`;
    } else if (this._isTargetBridge(bridgeName) && dist < 100) {
      etaSuffix = ', ETA strax';
    }
    const additional = this._buildAdditional(additionalCount);

    if (this._isTargetBridge(bridgeName)) {
      return `En båt ${dist}m från ${bridgeName}${etaSuffix}${additional}`;
    }
    // Intermediate bridge → include "på väg mot [target]"
    if (targetBridge && targetBridge !== bridgeName) {
      return `En båt ${dist}m från ${bridgeName} på väg mot ${targetBridge}${etaSuffix}${additional}`;
    }
    return `En båt ${dist}m från ${bridgeName}${etaSuffix}${additional}`;
  }

  /**
   * Phase 3: "Broöppning pågår vid [bro]" with optional target info.
   * For target bridges: no target suffix. For intermediate: includes "på väg mot [target]".
   */
  _buildUnderBridge(bridgeName, targetBridge, eta, additionalCount) {
    const additional = this._buildAdditional(additionalCount);

    if (this._isTargetBridge(bridgeName)) {
      return `Broöppning pågår vid ${bridgeName}${additional}`;
    }
    // Intermediate bridge
    if (targetBridge && targetBridge !== bridgeName) {
      const etaSuffix = eta ? `, ETA ${eta}` : '';
      return `Broöppning pågår vid ${bridgeName} på väg mot ${targetBridge}${etaSuffix}${additional}`;
    }
    return `Broöppning pågår vid ${bridgeName}${additional}`;
  }

  /**
   * Phase 2: "Båt inväntar broöppning vid [bro]"
   * Multiple boats: "Båt inväntar broöppning vid [bro], ytterligare N båtar på väg"
   */
  _buildWaitingAtBridge(bridgeName, additionalCount, targetBridge = null, eta = null) {
    const additional = this._buildAdditional(additionalCount);
    if (targetBridge && targetBridge !== bridgeName) {
      const etaSuffix = eta ? `, ETA ${eta}` : '';
      return `Båt inväntar broöppning vid ${bridgeName} på väg mot ${targetBridge}${etaSuffix}${additional}`;
    }
    return `Båt inväntar broöppning vid ${bridgeName}${additional}`;
  }

  /**
   * Phase 2 (Stallbackabron): "En båt passerar strax Stallbackabron"
   */
  _buildStallbackaImminent(bridgeName, targetBridge, eta, additionalCount) {
    const additional = this._buildAdditional(additionalCount);
    if (targetBridge && targetBridge !== bridgeName) {
      const etaSuffix = eta ? `, ETA ${eta}` : '';
      return `En båt passerar strax ${bridgeName} på väg mot ${targetBridge}${etaSuffix}${additional}`;
    }
    return `En båt passerar strax ${bridgeName}${additional}`;
  }

  /**
   * Phase 4: "En båt har precis passerat [bro] på väg mot [target]"
   */
  _buildPassed(passedBridge, targetBridge, eta, additionalCount) {
    const additional = this._buildAdditional(additionalCount);
    if (targetBridge) {
      const etaSuffix = eta ? `, ETA ${eta}` : '';
      return `En båt har precis passerat ${passedBridge} på väg mot ${targetBridge}${etaSuffix}${additional}`;
    }
    return `En båt har precis passerat ${passedBridge}${additional}`;
  }

  /**
   * Phase 3 (Stallbackabron <50m): "En båt passerar Stallbackabron"
   * No "vid [targetBridge]" in ETA text.
   */
  _buildStallbackaPasserar(bridgeName, targetBridge, eta, additionalCount) {
    const additional = this._buildAdditional(additionalCount);
    if (targetBridge && targetBridge !== bridgeName) {
      const etaSuffix = eta ? `, ETA ${eta}` : '';
      return `En båt passerar ${bridgeName} på väg mot ${targetBridge}${etaSuffix}${additional}`;
    }
    return `En båt passerar ${bridgeName}${additional}`;
  }

  /**
   * Phase 1 (Stallbackabron <500m): "En båt [dist]m från Stallbackabron på väg mot [target], ETA [eta]"
   * No "vid [targetBridge]" in ETA text.
   */
  _buildStallbackaNear(bridgeName, dist, targetBridge, eta, additionalCount) {
    const etaSuffix = eta ? `, ETA ${eta}` : '';
    const additional = this._buildAdditional(additionalCount);
    if (targetBridge && targetBridge !== bridgeName) {
      return `En båt ${dist}m från ${bridgeName} på väg mot ${targetBridge}${etaSuffix}${additional}`;
    }
    return `En båt ${dist}m från ${bridgeName}${etaSuffix}${additional}`;
  }
}

module.exports = BridgeTextService;
