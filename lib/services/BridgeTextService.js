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
 * ETA clause (SSOT: formatETABroOpeningClause i etaValidation — LITA PÅ KODEN,
 * inte på gamla kommentarer; BT-F10 2026-07-01 rättade denna doc):
 *   - Invalid / null / NaN          → "ETA okänd"
 *   - < 3 min ELLER imminent-flagga → "beräknad broöppning strax"
 *   - ≥ 3 min                       → "beräknad broöppning om N minuter"
 *     (extrapolerad → "om cirka N minuter")
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
    // Variant-1 is stateless; retained for API stability with the app.js
    // caller (vessel-removal-städningen som anropar clearVesselPhaseTracking).
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
    // B6 (körning 2026-07-03, F9) + produktionsredo-granskningen: en båt
    // vars target redan ligger i passedBridges är i zombie-tillstånd —
    // passagen har skett men transitionen har inte hunnit köra. Dess
    // kvarhängande imminent-flagga OCH nedräknings-ETA hör till en passage
    // som redan hänt: den får varken driva "strax" (imminent-vägen) eller
    // bli lead och driva "strax" via etaMinutes<3-grenen. Räknas i antalet
    // (båten finns fysiskt) men styr inte ETA-klausulen.
    const isZombie = (v) => v && v.targetBridge && Array.isArray(v.passedBridges)
      && v.passedBridges.includes(v.targetBridge);
    const etaEligible = vessels.filter((v) => !isZombie(v));
    const lead = this._selectLeadVessel(etaEligible.length > 0 ? etaEligible : vessels);
    const leadIsZombie = isZombie(lead);
    const count = vessels.length;
    const countWord = CountTextHelper.getCountText(count);
    const boatWord = count === 1 ? 'båt' : 'båtar';
    // F45: imminent gäller HELA gruppen — om någon båt är inom 300m från
    // målbron är broöppning imminent, även om den båten inte är "lead" (lägst
    // ETA). Extrapolated behålls från lead eftersom det kvalificerar just den
    // visade siffran (lead:ens ETA), medan imminent ersätter siffran helt.
    // F4-G PRÖVAD OCH ÅTERKALLAD (fältprov 4, 2026-07-09): att låta status
    // under-bridge dominera gruppens klausul ("strax") gav korpusbelagda
    // fatala ETA-sågtänder (korpus #9/#10: strax↔9–11 min-oscillationer) —
    // under-bridge-statusen växlar med latch-cyklerna och är FLAPPIGARE än
    // imminent-flaggan (som bär hysteres + åldersgater). NATHALIE 2-fallet
    // (15:32:41, "om 12 minuter" i 1 s medan hon var under Klaffbron) är
    // accepterad enssekundskosmetik; F4-E:s bekräftade-position-klocka gör
    // dessutom imminent-flaggan stabil för stillaliggande väntare, vilket
    // adresserar den större 08:43-klassen (strax→9 min-hopp).
    const anyImminent = vessels.some((v) => v && v._isImminentAtTargetBridge === true
      && !isZombie(v));
    // F4-M SLUTDOM (fältprov 4b, 2026-07-09, FULLSTÄNDIG rotorsakning):
    // NATHALIE 2-"glimten" (15:32:41 "om 12 minuter" → :42 "strax") var en
    // FELDIAGNOS — loggen visar att hon vid :41 var under JÄRNVÄGSBRON
    // (mellanbron) och 993 m från målbron Klaffbron: texten var SANN i varje
    // sekund; sekundskiftet var ett färskt sample som ärligt avslöjade att
    // den tysta sändaren hunnit fram. Tre hold-varianter som försökte dölja
    // skiftet fälldes följdriktigt av korpusfacit (de maskerade sanna
    // degraderings-/ledarbyten). Enda vägen till "strax tidigare" vore att
    // GISSA positionen bortom datat — klassen som korpushistoriken förbjudit
    // (HAJH-LAIF: strax @433 m, verklig öppning 25 min senare).
    //
    // Det VATTENTÄTA hörnfallet täcks däremot: en båt fysiskt under SJÄLVA
    // MÅLBRON (currentBridge === targetBridge) är per definition "broöppning
    // pågår" — klausulen får aldrig visa minuter då. (Skild från den fällda
    // F4-G-varianten som lät under-MELLANBRO tvinga strax — det var
    // sågtandskällan i korpusarna.)
    const anyUnderTargetBridge = vessels.some((v) => v && !isZombie(v)
      && v.status === 'under-bridge' && v.currentBridge === targetBridge);
    const etaClause = this._formatETAAsBroOpening(
      lead && !leadIsZombie ? lead.etaMinutes : null,
      lead && !leadIsZombie ? lead._etaIsExtrapolated === true : false,
      anyImminent || anyUnderTargetBridge,
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
    // Review fix H2: delegate to shared helper (SSOT för klausulen tvärs
    // BridgeTextService, fallbacktext och Flow tokens). OBS (R2 2026-07-11):
    // 30-min-clampen som kommentaren nämnde är BORTTAGEN sedan dess —
    // visningsklampar är facit-fällda; beräkningsvärdet äger.
    // Fix G (2026-04-28): extrapolated-flag bär igenom så "cirka N minuter"
    // visas vid 5–10 min stale data.
    // Fix H (2026-04-28): imminent-flag tvingar "strax" när vessel inom 300m
    // från målbro, oavsett ETA. Säkerställer konsekvent strax-fas även för
    // stillastående båtar och Class A 30s-tick som hoppar över ETA<3-zonen.
    return formatETABroOpeningClause(etaMinutes, { extrapolated, imminent });
  }
}

module.exports = BridgeTextService;
