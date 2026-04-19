'use strict';

const { BRIDGE_TEXT_CONSTANTS, TARGET_BRIDGES } = require('../constants');
const { isValidETA } = require('../utils/etaValidation');
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
    const etaClause = this._formatETAAsBroOpening(lead ? lead.etaMinutes : null);
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
  _formatETAAsBroOpening(etaMinutes) {
    if (!isValidETA(etaMinutes)) {
      return 'beräknad broöppning strax';
    }
    if (etaMinutes < 1) {
      return 'beräknad broöppning strax';
    }
    const rounded = Math.round(etaMinutes);
    if (rounded <= 0) {
      return 'beräknad broöppning strax';
    }
    // Bug #11 fix: ETA above 30 min is user-hostile and almost always produced
    // by a slow/stationary vessel where distance/speed yields absurd values
    // (60, 80, 106 minutes observed in replay logs). Fall back to a qualitative
    // phrase instead of showing a misleading minute count.
    if (rounded > 30) {
      return 'inväntar broöppning';
    }
    if (rounded === 1) {
      return 'beräknad broöppning om 1 minut';
    }
    return `beräknad broöppning om ${rounded} minuter`;
  }
}

module.exports = BridgeTextService;
