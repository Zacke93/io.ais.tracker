'use strict';

const { BRIDGE_TEXT_CONSTANTS, TARGET_BRIDGES } = require('../constants');
const { isValidETA, formatETABroOpeningClause } = require('../utils/etaValidation');
const CountTextHelper = require('../utils/CountTextHelper');

/**
 * BridgeTextService — Variant-1 (single-phrase model)
 *
 * Produces one phrase per target bridge group. Only Klaffbron and Stridsbergsbron
 * are mentioned in the text; intermediate bridges (Olidebron, Järnvägsbron,
 * Stallbackabron) are never referenced. Output is a pure function of the input
 * vessels array — no internal state, no phase tracking, no timers.
 *
 * Format per group:
 *   "[CountWord] [båt|båtar] på väg mot [targetBridge], [etaClause]"
 *
 * ETA clause:
 *   - Invalid / null / NaN / <1 min → "beräknad broöppning strax"
 *   - 1 min (after rounding)        → "beräknad broöppning om 1 minut"
 *   - ≥2 min                        → "beräknad broöppning om N minuter"
 *
 * Multi-target separator: "; " (Klaffbron phrase always precedes Stridsbergsbron).
 * Empty / invalid input: DEFAULT_MESSAGE from constants.
 */
class BridgeTextService {
  constructor(bridgeRegistry, logger, systemCoordinator = null, vesselDataService = null, passageLatchService = null) {
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
    this.systemCoordinator = systemCoordinator;
    this.vesselDataService = vesselDataService;
    this.passageLatchService = passageLatchService;
  }

  /**
   * No-op for backwards compatibility with legacy phase-tracking callers.
   * @param {string} _mmsi
   */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  clearVesselPhaseTracking(_mmsi) {
    // Variant-1 is stateless; retained for API stability with app.js:597.
  }

  /**
   * No-op for backwards compatibility.
   */
  // eslint-disable-next-line class-methods-use-this
  resetPhaseTracking() {
    // Variant-1 is stateless; retained for API stability with RealAppTestRunner.
  }

  /**
   * Delegate to CountTextHelper for Swedish count words.
   * @param {number} count
   * @returns {string}
   */
  // eslint-disable-next-line class-methods-use-this
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
      if (!Array.isArray(vessels) || vessels.length === 0) {
        return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      }

      const filtered = vessels.filter((v) => {
        if (!v || !v.mmsi) return false;
        if (this.vesselDataService
            && typeof this.vesselDataService.hasGpsJumpHold === 'function'
            && this.vesselDataService.hasGpsJumpHold(v.mmsi)) {
          return false;
        }
        return TARGET_BRIDGES.includes(v.targetBridge);
      });

      if (filtered.length === 0) {
        return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      }

      const groups = new Map();
      for (const target of TARGET_BRIDGES) {
        groups.set(target, []);
      }
      for (const v of filtered) {
        groups.get(v.targetBridge).push(v);
      }

      const phrases = [];
      for (const target of TARGET_BRIDGES) {
        const group = groups.get(target);
        if (group && group.length > 0) {
          phrases.push(this._buildGroupPhrase(group, target));
        }
      }

      if (phrases.length === 0) {
        return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      }

      return phrases.join('; ');
    } catch (error) {
      if (this.logger && typeof this.logger.error === 'function') {
        this.logger.error('❌ [BRIDGE_TEXT] Error generating bridge text:', error.message);
      }
      return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
    }
  }

  /**
   * Build the text phrase for one target-bridge group.
   * @private
   * @param {Object[]} vessels - Non-empty group of vessels sharing targetBridge
   * @param {string} targetBridge
   * @returns {string}
   */
  _buildGroupPhrase(vessels, targetBridge) {
    const lead = this._selectLeadVessel(vessels);
    const count = vessels.length;
    const countWord = CountTextHelper.getCountText(count);
    const boatWord = count === 1 ? 'båt' : 'båtar';
    // F45: imminent gäller HELA gruppen — om någon båt är inom 300m från
    // målbron är broöppning imminent, även om den båten inte är "lead" (lägst
    // ETA). Extrapolated behålls från lead eftersom det kvalificerar just den
    // visade siffran (lead:ens ETA), medan imminent ersätter siffran helt.
    const anyImminent = vessels.some((v) => v && v._isImminentAtTargetBridge === true);
    const etaClause = this._formatETAAsBroOpening(
      lead ? lead.etaMinutes : null,
      lead ? lead._etaIsExtrapolated === true : false,
      anyImminent,
    );
    return `${countWord} ${boatWord} på väg mot ${targetBridge}, ${etaClause}`;
  }

  /**
   * Choose the vessel representing the group — lowest valid ETA preferred,
   * then lowest distanceToCurrent, finally fall back to the first vessel.
   * @private
   * @param {Object[]} vessels
   * @returns {Object|null}
   */
  // eslint-disable-next-line class-methods-use-this
  _selectLeadVessel(vessels) {
    if (!Array.isArray(vessels) || vessels.length === 0) return null;

    const withValidETA = vessels.filter((v) => isValidETA(v && v.etaMinutes));
    if (withValidETA.length > 0) {
      return withValidETA.reduce((a, b) => (a.etaMinutes <= b.etaMinutes ? a : b));
    }

    const withDistance = vessels.filter((v) => v && Number.isFinite(v.distanceToCurrent));
    if (withDistance.length > 0) {
      return withDistance.reduce((a, b) => (a.distanceToCurrent <= b.distanceToCurrent ? a : b));
    }

    return vessels[0];
  }

  /**
   * Format ETA as a "beräknad broöppning ..." clause.
   * @private
   * @param {number|null|undefined} etaMinutes
   * @returns {string}
   */
  // eslint-disable-next-line class-methods-use-this
  _formatETAAsBroOpening(etaMinutes, extrapolated = false, imminent = false) {
    // Review fix H2: delegate to shared helper so the 30-min clamp is SSOT
    // across BridgeTextService, fallback text, Flow tokens, ETAFormatter.
    // Fix G (2026-04-28): extrapolated-flag bär igenom så "cirka N minuter"
    // visas vid 5–10 min stale data.
    // Fix H (2026-04-28): imminent-flag tvingar "strax" när vessel inom 300m
    // från målbro, oavsett ETA. Säkerställer konsekvent strax-fas även för
    // stillastående båtar och Class A 30s-tick som hoppar över ETA<3-zonen.
    return formatETABroOpeningClause(etaMinutes, { extrapolated, imminent });
  }
}

module.exports = BridgeTextService;
