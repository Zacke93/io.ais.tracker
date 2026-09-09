'use strict';

const { BRIDGE_TEXT_CONSTANTS, TARGET_BRIDGES, UI_CONSTANTS } = require('../constants');
const { isValidETA, formatETABroOpeningClause } = require('../utils/etaValidation');
const CountTextHelper = require('../utils/CountTextHelper');
const { waitingBridge } = require('../utils/bridgeQueue');

// J38 (helkodsgranskning runda 2, 2026-08-22) — SVÄLJLOGGENS STRYPNING.
// HÄRLEDNING av fönstret: utlösaren (ett kastande fält på ett fartygsobjekt) är
// per konstruktion PERSISTENT — samma fartyg kastar i varje anrop så länge det
// spåras, upp till RC7-presentationsfiltrets 25 min. generateBridgeText anropas
// från _actuallyUpdateUI vid varje koalescerad UI-uppdatering plus 30 s-watchdogen
// och 60 s-tvångsuppdateringen, dvs. 1–3 gånger per sekund i livlig trafik ⇒
// ~1 950 flersidiga stackspår i timmen. En minut är den grövsta upplösning som
// fortfarande visar felet i realtid, och den ligger på 60 s-tvångsuppdateringens
// egen kadens: varje UI-cykel som INTE är en tvångsuppdatering strypas, medan
// ett fel som består över en hel tvångscykel alltid får en ny rad. Det är samma
// medicin som B1/F13 gav StatusService (5 945 rader per 42 h dränkte äkta
// diagnos) — och det är just den diagnos H38 finns för att möjliggöra.
const SWALLOW_LOG_THROTTLE_MS = 60000;

// Taket bevakar MINNET, inte loggen: signaturen bär felets message, och ett
// message som råkar innehålla ett mmsi eller ett värde ger en ny nyckel per
// fartyg. Appen kör i månader; en obegränsad karta vore en läcka. 50 distinkta
// felsignaturer är långt bortom vad ett verkligt fel producerar (fältet har
// aldrig visat mer än en handfull samtidigt), och äldst insatt vräks först.
const SWALLOW_SIGNATURE_MAX = 50;

// Signaturen klipps så att en patologisk message (t.ex. en serialiserad
// struktur) inte kan göra kartnyckeln godtyckligt stor.
const SWALLOW_SIGNATURE_MAX_LEN = 200;

/**
 * BridgeTextService — rörelse och bekräftad väntan per målbro.
 *
 * Köer visas utan minutprognos vid den verkliga väntbron, även Olidebron
 * och Järnvägsbron. Båtar under gång får en separat klausul med målbrons ETA.
 * Samma båt räknas en gång. Tjänsten har inga egna fas- eller vänttimers.
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
    // J38: svälj-loggens strypning. Map<signatur, {senast, undertryckta}>.
    // Detta är DIAGNOSTIKTILLSTÅND, inte texttillstånd: klassens kontrakt
    // ("output är en ren funktion av indata") rör returvärdet, som är
    // oförändrat. Kartan läses aldrig av någon textväg.
    this._svaljLoggTider = new Map();
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
  generateBridgeText(vessels, { includeGpsHeld = false } = {}) {
    try {
      if (!Array.isArray(vessels) || vessels.length === 0) {
        return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      }

      const filtered = vessels.filter((v) => {
        if (!v || !v.mmsi) return false;
        // Appen kan redan ha ersatt en hållen båt med dess tidigare publicerade underlag.
        if (!includeGpsHeld && this.vesselDataService
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
          const moving = [];
          const queues = new Map();
          for (const vessel of group) {
            const bridge = waitingBridge(vessel);
            if (!bridge) moving.push(vessel);
            else queues.set(bridge, (queues.get(bridge) || 0) + 1);
          }
          // Varje båt räknas en gång. En faktisk kö får inga minuter,
          // medan andra båtar med samma mål fortfarande har sin prognos.
          for (const [bridge, count] of queues) {
            const onward = bridge === target ? '' : ` på väg mot ${target}`;
            phrases.push(`${this.getCountText(count)} ${count === 1 ? 'båt' : 'båtar'} väntar vid ${bridge}${onward}`);
          }
          if (moving.length) phrases.push(this._buildGroupPhrase(moving, target));
        }
      }

      if (phrases.length === 0) {
        return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      }

      return phrases.join('; ');
    } catch (error) {
      // H38 (helkodsgranskning runda 1, 2026-08-22) — SVÄLJ-FÄLLAN.
      // Catchen gör ett INTERNT fel till det aktivt falska "Inga båtar":
      // count-validatorn kan aldrig fyra (DEFAULT bär noll räkneord),
      // alarm_generic släcks och de tre DEFAULT-vakterna täcker inte fallet —
      // EN båt med ett kastande fält raderar alltså tre friska båtar ur
      // texten. UTFALLET BEHÅLLS medvetet (app.js äger hold-logiken en nivå
      // upp och en ändrad returväg vore facitpåverkande), men felet får inte
      // vara tyst: raden bär nu VILKA fartyg som var i spel, felets typ och
      // stacken (J38: vid signaturens FÖRSTA förekomst), så fällan går att se
      // i en fältlogg i stället för att yttra sig som en oförklarlig
      // "Inga båtar".
      this._logSwallowedError(error, vessels);
      return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
    }
  }

  /**
   * H38: logga ett SVALT textfel så svälj-fällan syns i fält.
   *
   * J38 (runda 2): STRYPT. Utlösaren är per konstruktion persistent och
   * anropsvägen är den hetaste i appen (varje koalescerad UI-uppdatering plus
   * två watchdogar) — ostrypt gav H38:s rad ~1 950 flersidiga stackspår i
   * timmen och dränkte precis den diagnos den finns för. Högst en rad per
   * minut och felsignatur; stacken bara vid första förekomsten; antalet
   * undertryckta räknas och skrivs på nästa rad som släpps igenom.
   *
   * FÅR ALDRIG KASTA. Fältet som just kastade kan vara vilket som helst av
   * fartygets — även mmsi — så varje läsning är egenskyddad. Kastade den här
   * loggningen skulle undantaget gå vidare till anroparen och ändra precis
   * det beteende metoden finns för att bevara.
   * @private
   * @param {Error} error
   * @param {Object[]} vessels - anropets indata (kan innehålla vad som helst)
   */
  _logSwallowedError(error, vessels) {
    if (!this.logger || typeof this.logger.error !== 'function') return;
    const LOGGADE_MMSI_MAX = 10; // en grupp är sällan större; taket skyddar raden
    let vilka = 'okänd lista';
    try {
      if (Array.isArray(vessels)) {
        const ids = vessels.slice(0, LOGGADE_MMSI_MAX).map((v) => {
          try {
            return String((v && v.mmsi) || '?');
          } catch (fältfel) {
            return '?(kastande mmsi)';
          }
        });
        const fler = vessels.length > LOGGADE_MMSI_MAX
          ? `,+${vessels.length - LOGGADE_MMSI_MAX}` : '';
        vilka = `${vessels.length} st: ${ids.join(',')}${fler}`;
      }
    } catch (listfel) {
      vilka = 'oläsbar lista';
    }
    let orsak = 'okänt fel';
    let stack = '';
    try {
      orsak = `${(error && error.name) || 'Error'}: ${(error && error.message) || String(error)}`;
      stack = (error && error.stack) ? ` | stack=${error.stack}` : '';
    } catch (felfel) {
      orsak = 'ounderrättbart fel';
    }

    // J38: STRYPNINGEN. Signaturen är felets IDENTITET (name + message) — inte
    // fartyget: ett kastande fält ger samma fel för varje fartyg som bär det,
    // och det är felet vi vill se en gång, inte listan. `vilka` skrivs ändå ut
    // på varje rad som släpps igenom, så kopplingen till fartygen finns kvar.
    let farSlappasIgenom = true;
    let undertryckta = 0;
    let forstaForekomsten = true;
    try {
      const signatur = orsak.slice(0, SWALLOW_SIGNATURE_MAX_LEN);
      const nu = Date.now();
      const post = this._svaljLoggTider instanceof Map
        ? this._svaljLoggTider.get(signatur) : null;
      if (post) {
        forstaForekomsten = false;
        if (nu - post.senast < SWALLOW_LOG_THROTTLE_MS) {
          post.undertryckta += 1;
          farSlappasIgenom = false;
        } else {
          undertryckta = post.undertryckta;
          post.undertryckta = 0;
          post.senast = nu;
        }
      } else if (this._svaljLoggTider instanceof Map) {
        // Vräk äldst insatt när taket nås. Map bevarar insättningsordning och
        // en uppdatering av en befintlig nyckel flyttar den INTE, så den
        // första nyckeln är den som setts längst tillbaka.
        if (this._svaljLoggTider.size >= SWALLOW_SIGNATURE_MAX) {
          const aldst = this._svaljLoggTider.keys().next().value;
          this._svaljLoggTider.delete(aldst);
        }
        this._svaljLoggTider.set(signatur, { senast: nu, undertryckta: 0 });
      }
    } catch (strypfel) {
      // Strypningen får aldrig kosta en diagnos: faller den, loggar vi.
      farSlappasIgenom = true;
    }
    if (!farSlappasIgenom) return;

    // Stacken bara vid FÖRSTA förekomsten av en signatur — det är den som bär
    // informationen. Följande rader skulle bara upprepa samma flersidiga spår.
    const stackDel = forstaForekomsten ? stack : '';
    const undertryckDel = undertryckta > 0 ? ` undertryckta=${undertryckta}` : '';
    try {
      this.logger.error(
        `❌ [BRIDGE_TEXT_SWALLOWED] Textgenereringen kastade — faller till "${BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE}" `
        + `trots att båtar fanns i indatan. fartyg=[${vilka}] orsak=${orsak}${undertryckDel}${stackDel}`,
      );
    } catch (loggfel) {
      // MEDVETEN no-op och den ENDA i filen: en logger som själv kastar får
      // inte fälla brotexten. Det finns ingen andra kanal att rapportera i —
      // att kasta vidare härifrån skulle göra loggningen farligare än det
      // fel den beskriver.
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
    // FP9-hjälparen (flyttad hit 2026-08-09 för C11 — den delas nu av BÅDA
    // "strax"-drivande vägarna: imminent-flaggan och under-målbron-dominansen.
    // Samma gräns, samma klocka som app-lagrets `_lastConfirmedPositionMs`).
    // lastHeard === 0 ⇒ testfixturer utan tidsstämplar behandlas som färska
    // (annars hade varje enhetstest utan timestamp tappat "strax").
    const staleHardMs = (UI_CONSTANTS && UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS) || 10 * 60 * 1000;
    const hasFreshPosition = (v) => {
      const lastHeard = Math.max(v.timestamp || 0, v.lastPositionUpdate || 0);
      return lastHeard > 0 ? (Date.now() - lastHeard) <= staleHardMs : true;
    };
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
    // C11/U1 (etapp 7, 2026-08-09): imminent-flaggan får aldrig KONSUMERAS av
    // en båt vars position är äldre än STALE_ETA_HARD. Flaggan sätts redan i
    // dag bakom samma färskhetsgrind (app.js _reevaluateVesselStatuses:
    // `dataIsFreshEnough`, samma klocka `_lastConfirmedPositionMs`), så gaten
    // här är en KONSUMTIONSSPÄRR i djupled — inte en ny regel. Den behövs
    // därför att omvärderingsloopens per-fartygs-catch (app.js ~:5311) hoppar
    // över nollställningen om proximity-analysen kastar för ett fartyg: då
    // överlever förra tickets `true` och kunde driva "strax" för en tyst båt.
    // MÄTNOT (18 korpusar, ~320 h): 0 av 10 087 imminent-konsumtioner hade
    // stale position — gaten är alltså LATENT, inte en verkanshöjare. Den
    // användarsynliga U1-effekten ligger i staleDisplayLimit-trappan (C11b),
    // som styr om båten över huvud taget renderas.
    const anyImminent = vessels.some((v) => v && v._isImminentAtTargetBridge === true
      && !isZombie(v) && hasFreshPosition(v));
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
    // FP9 (2026-07-18, FREE WILLY 12:55–13:00, SEEBAER III 09:04): under-
    // SJÄLVA-målbron-dominansen saknade färskhetskrav — en båt vars status
    // frusit som under-bridge (18 m resp. 33 m, position 600–784 s gammal)
    // tvingade "strax" i 9–13 min trots att imminent-flaggan (med åldersgate
    // >600 s) och ETA:n (HARD-nollad @600 s) sedan länge degraderats — båten
    // hade i verkligheten redan passerat. Samma STALE_ETA_HARD-gräns här:
    // efter 10 min utan bekräftad position faller klausulen till lead-ETA:n
    // ("ETA okänd" — ärligt). NATHALIE 2-hörnfallet (färsk data under
    // målbron) berörs inte. (Hjälparen är definierad ovan sedan C11.)
    const anyUnderTargetBridge = vessels.some((v) => v && !isZombie(v)
      && v.status === 'under-bridge' && v.currentBridge === targetBridge
      && hasFreshPosition(v));
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
