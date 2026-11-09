'use strict';

/**
 * =============================================================================
 * BridgeOpeningService — BRO-CENTRERADE ÖPPNINGSVARNINGAR (etapp 6, 2026-08-03)
 * =============================================================================
 *
 * SYFTE
 * boat_near-lagret är REAKTIVT: notisen kräver ett AIS-fix inne i 300 m-zonen.
 * Tystnar båten på slutsträckan (eller landar fixet för sent) uteblir notisen,
 * och användaren står vid en öppen bro utan förvarning. Det här lagret är
 * PROAKTIVT och HELT ADDITIVT — det rör varken boat_near, bridge_text eller
 * något befintligt facit.
 *
 * TRE MEKANISMER
 *  a) BRO-CENTRERADE ÖPPNINGSHÄNDELSER. Evidens ackumuleras per MÅLBRO
 *     (Klaffbron och Stridsbergsbron; Stallbackabron öppnar aldrig). EN
 *     varning per förestående öppning — en sändande båt i en konvoj täcker
 *     sina radiotysta grannar. Nattens facit: öppningen 06:11:51 tog
 *     JUNO + SALTYX i EN öppning, och JUNO:s data ensam räckte.
 *     U9 (användarbeslut 2026-08-09, byggt i P7 2026-08-10): täckningen skulle
 *     gälla HELA den avfyrade, o-passerade händelsen — inte bara konvojfönstret
 *     — men VILLKORAT: förfaller en täckt båts EGEN deadline medan händelsen
 *     ännu är o-passerad avfyras en individuell räddningsvarning. Se
 *     _bindLooseArms (breda täckningen) och _rescueCoveredArms (ventilen).
 *     🛑 MEKANIKEN ÄR AVSTÄNGD I DRIFT (BRIDGE_OPENING.U9_RESCUE_COVERAGE =
 *     false): mätningen över 18 korpusar visade att den SPLITTRAR äkta
 *     konvojer i stället för att slå ihop dem (>1-räknaren 80 → 81,
 *     varningar 364 → 369, ovarnade 26 → 25). Härledningen och rådatabevisen
 *     står vid konstanten. Utan flaggan är beteendet exakt baslinjens.
 *  b) DEADLINE-MOTORN ("äggklockan"). Per beväpnad båt beräknas TIDIGAST
 *     MÖJLIGA ankomst pessimistiskt (avstånd / BRIDGE_OPENING.
 *     DEADLINE_MAX_SPEED_KN, mätt från FIXETS tid). Varningen avfyras SENAST
 *     vid tidigast_ankomst − WARNING_LEAD_MS, även i total radiotystnad.
 *     LÖFTET GÄLLER TYSTNAD, INTE MOTSÄGELSE (C7b, 2026-08-09): har vi LÄST ett
 *     färskt fix som armen inte kunde ta emot — därför att appen släppt
 *     målbron — är ankaret inte längre det senaste vi vet, och deadlinen
 *     pausas tills armen kan uppdateras igen. Se _hasUnappliedObservation.
 *  c) TIDIG BEVÄPNING, SEN AVFYRNING. Bevisinsamlingen börjar redan vid
 *     ARM_MAX_DISTANCE_M (2500 m), inte vid 300 m. Tystnad kan ALDRIG
 *     avväpna — bara motbevis (förtöjningsevidens långt ut, U-sväng,
 *     kajvobbel) eller fullbordad passage. Avfyrningen sker så sent
 *     garantin tillåter, vilket minimerar falsklarmen.
 *
 * PRODUKTPRINCIP (uttalad av användaren): en MISSAD öppning är värre än ett
 * falsklarm. Accepterad falsklarmsklass är en båt som stannar eller vänder
 * EFTER sista fixen mitt i en beväpnad anflygning. INTE accepterad är
 * kajliggare/kajvobblare som aldrig gör en riktig avgång. Ett stopp NÄRA bron
 * är normalfallet för en öppning (båten VÄNTAR på att bron ska öppna) och får
 * aldrig avväpna.
 *
 * DEADLINE OCH WATCHDOG
 * Appen aktiverar en gemensam timer för nästa deadline. Nya observationer
 * räknar om den; 30 s-watchdogen är reserv. tick() är idempotent och timern
 * städas vid destroy. Enhetstester kan välja manuell tick via konstruktorn.
 *
 * REN SERVICE
 * Ingen Homey-import; allt injiceras via konstruktorn. Replay och jest kör
 * exakt samma kod som produktionen.
 *
 * INGA NYA VESSEL-FÄLT (medvetet val, fältlist-fällans 14:e potentiella offer)
 * Armarna lever i servicens egen Map, inte på fartygsobjektet. Det ger tre
 * saker gratis: (1) ingen risk att _createVesselObject-fältlistan glömmer dem,
 * (2) armen överlever att fartyget TAS BORT ur VesselDataService (timeout mitt
 * i tystnaden — exakt det fall deadline-motorn finns för), och (3) inget nytt
 * tillstånd att persistera. Servicen LÄSER befintliga fält (targetBridge,
 * _hasMovementProof, _moored, _stationarySince, _routeDirection,
 * _finalTargetDirection, passedAt, etaMinutes) och bygger ingen parallell
 * sanning om dem. (_stationarySince tillkom med C9 2026-08-09 — samma
 * stillhetsklocka som kajzonslagret och 2h-backstopen redan konsumerar.)
 *
 * INGEN PERSISTENS ÖVER OMSTART (v1, dokumenterat val)
 * Armar återskapas inte efter en appomstart. boat_near-lagret är oförändrad
 * fallback, och en omstart följs alltid av färska fix som återbeväpnar.
 */

const {
  BRIDGES,
  BRIDGE_SEQUENCE,
  BRIDGE_ID_TO_NAME,
  BRIDGE_NAME_TO_ID,
  TARGET_BRIDGES,
  BRIDGE_OPENING,
  PASSAGE_TIMING,
  UI_CONSTANTS,
  AIS_CONFIG,
  STATUS_HYSTERESIS,
  UNDER_BRIDGE_SET_DISTANCE,
  MIN_PASSAGE_ROUTE_SPEED_KNOTS,
} = require('../constants');
const geometry = require('../utils/geometry');
const GPSJumpAnalyzer = require('../utils/GPSJumpAnalyzer');
const { waitingBridge, beforeBridge, hasFreshPosition } = require('../utils/bridgeQueue');

// Knop → m/s. Samma faktor som resten av kodbasen (1 kn = 1852/3600 m/s).
const KNOTS_TO_MS = 0.514444;

// B2d (etapp 7 fas B, 2026-08-08) — ÅLDERSGRÄNSEN FÖR ETA-TOKENEN.
// INGEN ny konstant: exakt samma tröskel som brotexten redan använder för att
// sluta lita på en ETA (UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS, 10 min ⇒
// "ETA okänd"). Öppningskortet fick aldrig samma doktrin och lovade därför
// ankomsttider ur fix som brotexten sedan länge hade gett upp om. Fallbacken är
// hängslen mot en tom import: utan den blir jämförelsen `x > undefined` = false
// och grinden vore TYST avstängd — precis den klass fältprovet fällde.
const STALE_ETA_HARD_MS = (UI_CONSTANTS && UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS)
  || 10 * 60 * 1000;
const STALE_ETA_SOFT_MS = UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS;

// K20a-redo (fältprov 10, fynd K20) — BATCHFÖNSTRET: hur nära i tid två
// observationer måste ligga för att höra till SAMMA pollsvep.
//
// HÄRLEDNING, tre led:
//  (1) AISHubClient sprider en pollbatch med AIS_CONFIG.AISHUB.EMIT_SPREAD_MS
//      (150 ms) mellan posterna — det är den enda kadens som kan ge två
//      observationer med bråkdelar av en sekund emellan.
//  (2) DUBBLA spridningen, inte spridningen själv: varje post i batchen når
//      inte observeVessel (dedup, fusionsavslag, utanför bboxen), och en enda
//      överhoppad post gör luckan 2 × 150 ms. Fler överhoppade i rad ger en
//      längre lucka och grinden blir då tyst — den felar alltså åt det håll
//      som lämnar beteendet oförändrat.
//  (3) MÄTT SEPARATION över samtliga 18 korpusar + fältkorpusen (14 409 luckor
//      mellan på varandra följande sampel): 3 883 av 7 324 AISHub-luckor
//      (53 %) ligger under 300 ms — det ÄR batchstrukturen — mot 20 av 7 085
//      aisstream-luckor (0,28 %). Gränsen skiljer poll från ström utan att
//      servicen behöver veta vilken källa fixet kom ifrån, och den ligger
//      217 gånger under pollperioden (65 s) så den kan aldrig spänna två
//      poller.
// Fallbacken är hängslen mot en tom import: utan den blev talet NaN och varje
// jämförelse false — grinden vore TYST avstängd, precis den klass fältprovet
// fällde på STALE_ETA_HARD_MS ovan.
const BATCH_SETTLE_MS = 2 * ((AIS_CONFIG && AIS_CONFIG.AISHUB
  && AIS_CONFIG.AISHUB.EMIT_SPREAD_MS) || 150);

// K-familjen (rättningskampanjen 2026-11-04) — "I RÖRELSE" för kursgrinden i
// _coverageVerdict. INGEN ny kalibrering: samma 2 kn som filen redan använder
// som rörelsegräns (_sharesMovingConvoy och movingFallbackMs i _refreshArm) och
// samma tal som Fix D:s korsningsbevis i VesselDataService (reCrossMoving). Under
// gränsen är cog brus för en båt som ligger och väntar, och grinden tiger.
const MOVING_SOG_KN = 2;

const NOOP = () => {};

class BridgeOpeningService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.logger] - { log, error, debug } (app-instansen i drift)
   * @param {Function} [options.onWarning] - callback(payload) vid avfyrning
   * @param {Function} [options.onCoverage] - callback({mmsi,bridge,eventId,t,
   *   reason,originalDueMs}) varje gång ett fartyg blir TÄCKT av en
   *   öppningsvarning: 'fired' när varningen gick ut med båten som medlem,
   *   'absorbed' när hon anslöt till en redan avfyrad öppning (konvojen).
   *   `originalDueMs` är armens frysta ursprungsdeadline (se _arm) — den gör
   *   H-4:s mätserie "sista påminnelse per fysisk öppning" räknebar per
   *   fartyg. Diagnostik för O1-klassificeringen — påverkar ingen produktlogik.
   * @param {Object} [options.bridges] - BRIDGES-registret (namn/lat/lon)
   * @param {string[]} [options.targetBridges] - öppningsbara broar
   * @param {Function} [options.getDirection] - (vessel) => 'northbound'|'southbound'|'unknown'
   * @param {Function} [options.isQuayWobbler] - (vessel) => boolean (V1-kajbokföringen)
   * @param {Function} [options.hasArmingMovementEvidence] - (vessel) => boolean
   *   (C6:s beväpningsbevis i VesselDataService — "≥2 obs ELLER en enda RIMLIG
   *   obs", klistrande bokföring). SAKNAS predikatet ställs INGET nytt krav, så
   *   varje befintlig anropare som bygger servicen utan optionen beter sig
   *   exakt som förut. Se _canArm.
   * @param {Function} [options.getVesselName] - (mmsi) => string|null (persistenta
   *   namncachen). B1-användarbeslutet 2026-07-03: aisstreams platshållare
   *   "Unknown" är INTE ett namn och får aldrig nå en token — exakt samma
   *   kedja som boat_near använder (knownName || cache || 'Okänd båt').
   * @param {Function} [options.now] - klockkälla (test/replay)
   * @param {Object} [options.config] - överskrivning av BRIDGE_OPENING (endast test)
   */
  constructor(options = {}) {
    const opts = options || {};
    this.logger = opts.logger || {
      log: NOOP, error: NOOP, debug: NOOP,
    };
    this._onWarning = typeof opts.onWarning === 'function' ? opts.onWarning : null;
    // Kortets delmängd får bara läsa frysta skalärvärden från avfyrningen.
    // WeakMap håller varken payloaden eller en levande arm kvar efteråt.
    this._warningSnapshots = new WeakMap();
    this._onCoverage = typeof opts.onCoverage === 'function' ? opts.onCoverage : null;
    this._getDirection = typeof opts.getDirection === 'function' ? opts.getDirection : null;
    this._isQuayWobbler = typeof opts.isQuayWobbler === 'function' ? opts.isQuayWobbler : null;
    // J22 (helkodsgranskning runda 2, 2026-08-22): C6:s beväpningsbevis
    // hasArmingMovementEvidence var MÄTT och dokumenterat men hade NOLL
    // konsumenter — grinden var skriven och aldrig frågad. Injiceras i exakt
    // samma stil som isQuayWobbler ovan: appen äger bokföringen, servicen
    // bygger ingen parallell sanning.
    this._hasArmingMovementEvidence = typeof opts.hasArmingMovementEvidence === 'function'
      ? opts.hasArmingMovementEvidence
      : null;
    this._getVesselName = typeof opts.getVesselName === 'function' ? opts.getVesselName : null;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.config = { ...BRIDGE_OPENING, ...(opts.config || {}) };

    // Namn → koordinat för de öppningsbara broarna. Stallbackabron kan aldrig
    // hamna här (den är ingen målbro) — bron öppnar aldrig.
    const bridgeRegistry = opts.bridges || BRIDGES;
    const targets = Array.isArray(opts.targetBridges) && opts.targetBridges.length
      ? opts.targetBridges
      : TARGET_BRIDGES;
    this._targetBridges = new Map();
    for (const bridge of Object.values(bridgeRegistry || {})) {
      if (!bridge || !bridge.name || !targets.includes(bridge.name)) continue;
      if (!Number.isFinite(bridge.lat) || !Number.isFinite(bridge.lon)) continue;
      this._targetBridges.set(bridge.name, { name: bridge.name, lat: bridge.lat, lon: bridge.lon });
    }

    /** @type {Map<string, Object>} armKey ('mmsi::Bro') → arm */
    this._arms = new Map();
    /**
     * @type {Map<string, Object[]>} broNamn → LISTA av öppningshändelser.
     * En bro kan ha flera FÖRESTÅENDE öppningar samtidigt (en snabb båt 800 m
     * ut och en långsam 2400 m ut är två skilda öppningar, ~20 min isär).
     * Med en enda händelse per bro band den snabba båten den långsamma till
     * sin varning och den långsammas öppning blev ALDRIG varnad — den värsta
     * klassen enligt produktprincipen. Listan är kort per konstruktion:
     * händelser utan medlemmar städas i varje utvärdering.
     */
    this._events = new Map();
    /**
     * U15 (B02) — RETURMINNET: armKey ('mmsi::Bro') → { at, eventId } för
     * båtens SENASTE bokförda passage av bron (se _recordPassage). Minnet är
     * frikopplat från händelselistan (omgranskningen 2026-11-05): returresan
     * känns igen även när hennes egen gamla händelse redan städats, så länge
     * någon levande händelse beskriver öppningen hon passerade. Posten städas i
     * _prunePassageMemory.
     */
    this._passageMemory = new Map();

    this._eventSeq = 0;
    // F09: BEARBETNINGSORDNING för hållna fix och avfyrningar (se
    // _fixAfterWarning). Klocktiden räcker inte: i ett AIS-svep kan ett fix
    // och en avfyrning bära samma millisekund, och "efter varningen" betyder
    // då "bearbetat efter avfyrningen" (opening-confirmed-waiting-eta låser
    // det för AKIRA-regeln).
    this._orderSeq = 0;
    this._warningCount = 0;
    this._destroyed = false;
    this._scheduleDeadlines = opts.scheduleDeadlines === true;
    this._deadlineTimer = null;
    this._scheduledDeadline = null;
    // K20a-redo: tidpunkten för FÖREGÅENDE observation (vilket fartyg som
    // helst) och luckan fram till den PÅGÅENDE. Enda konsument är
    // batchdetektorn i _leadIsUnsettled — ligger två observationer närmare än
    // BATCH_SETTLE_MS är ett pollsvep under tillämpning. Rena tidsmått på
    // servicen, inga nya fartygsfält. Infinity = "ingen föregående
    // observation", dvs. aldrig en batch (första meddelandet efter start).
    this._prevObservationAt = null;
    this._observationGapMs = Infinity;

    this.logger.debug(
      `🌉 [BRIDGE_OPENING] Service initierad (${this._targetBridges.size} målbroar, `
      + `arm ≤${this.config.ARM_MAX_DISTANCE_M} m, v_max ${this.config.DEADLINE_MAX_SPEED_KN} kn, `
      + `lead ${Math.round(this.config.WARNING_LEAD_MS / 1000)} s)`,
    );
  }

  // ===========================================================================
  // PUBLIKT API
  // ===========================================================================

  /**
   * Observera ett uppdaterat fartyg. Anropas från app.js på varje
   * positionsuppdatering EFTER att status/målbro satts. Beväpnar, uppdaterar
   * och avväpnar; utvärderar sedan berörda broar (avfyrning via 'fix').
   * @param {Object} vessel - Fartygsobjekt
   */
  observeVessel(vessel) {
    if (this._destroyed || !vessel || vessel.mmsi === null || vessel.mmsi === undefined) return;
    // Ett redan underkänt positionshopp bevisar varken passage, ny målbro
    // eller ändrad ankomsttid. Bevara den senaste betrodda anflygningen och
    // dess deadline tills en ren fix kommer, precis som vid AIS-tystnad.
    // Generell försiktighet efter ett rimligt långt glapp är inte samma
    // sak: använd passage-/notisvägens uttryckliga krav på bekräftelse.
    if (GPSJumpAnalyzer.needsPassageConfirmation(vessel)) return;
    const mmsi = String(vessel.mmsi);
    const now = this._now();
    const touched = new Set();
    // K20a-redo: LÄS föregående observationstid och skriv den nya FÖRE
    // utvärderingen nedan — batchdetektorn måste se avståndet till förra
    // meddelandet, inte till det här. Se BATCH_SETTLE_MS och _leadIsUnsettled.
    const prevObservationAt = this._prevObservationAt;
    this._prevObservationAt = now;
    this._observationGapMs = Number.isFinite(prevObservationAt)
      ? now - prevObservationAt : Infinity;

    // 1) MOTBEVIS-SVEPET över alla armar fartyget håller. Körs FÖRE
    //    beväpningen, och de broar som avväpnats spärras för återbeväpning i
    //    SAMMA meddelande: annars hade U-svängen i steg 1 direkt skapat en ny
    //    (ovarnad) arm i steg 2 och motbeviset varit verkningslöst. Nästa fix
    //    får beväpna igen — en båt som verkligen vänt och kommer tillbaka ska
    //    kunna göra en ny anflygning.
    const disarmedNow = new Set();
    for (const arm of this._armsForVessel(mmsi)) {
      // Avståndet mäts mot ARMENS bro ur DETTA meddelande — inte ur armens
      // förra observation. En båt som just kommit innanför väntzonen får
      // annars sitt motbevis prövat mot ett inaktuellt avstånd.
      const armBridge = this._targetBridges.get(arm.bridge);
      const currentDistance = armBridge ? this._distanceTo(vessel, armBridge) : null;
      const reason = this._disarmEvidence(arm, vessel, currentDistance);
      if (reason) {
        touched.add(arm.bridge);
        disarmedNow.add(arm.bridge);
        // Korsningstiden interpoleras mellan armens senaste fix FÖRE bron och
        // det här fixet BORTOM den (F01, glappregistreringen). Bokföringstiden
        // `now` kan ligga ett helt AIS-avbrott efter den verkliga korsningen.
        // Låg armens senaste TILLÄMPADE läge redan bortom bron (fixet bortom
        // bron kom t.ex. utan riktning) finns inget fix före bron att
        // interpolera från; fixets tid är då en säker övre gräns, samma som
        // notePassage och passagedomen använder (_crossingUpperBound).
        if (reason === 'passage') {
          this._recordPassage(arm.bridge, arm, now,
            this._crossingEstimate(arm, vessel, currentDistance, now)
              ?? this._crossingUpperBound(arm, now));
        }
        this._disarm(arm, reason, now);
      }
    }

    // 1b) FRYST ARM — MARKERA EN OBSERVATION SOM INTE KAN TILLÄMPAS (C7b/F-4,
    //     etapp 7 fas C, 2026-08-09). Har fartyget INGEN målbro returnerar
    //     _bridgesToArm() en tom lista, och loopen nedan hoppas över: armen
    //     uppdateras aldrig mer och blir för deadline-motorn OMÖJLIG att skilja
    //     från en tyst båt — trots att vi just LÄST ett färskt fix från henne.
    //     Vi bokför därför observationen på armen. Den avväpnar ingenting
    //     (tappad målbro är per filens doktrin aldrig motbevis); den gör bara
    //     att avfyrningen kan skilja TYSTNAD (deadline-motorns hela existens-
    //     berättigande) från MOTSÄGELSE. Se _hasUnappliedObservation.
    const armBridges = this._bridgesToArm(vessel);
    if (armBridges.length === 0) {
      for (const arm of this._armsForVessel(mmsi)) arm.lastObservedAt = now;
    }

    // 2) BEVÄPNING / UPPDATERING mot fartygets målbro OCH — om den ligger
    //    inom horisonten — nästa målbro i samma färdriktning.
    for (const bridgeName of armBridges) {
      if (disarmedNow.has(bridgeName)) continue;
      const bridge = this._targetBridges.get(bridgeName);
      if (!bridge) continue;
      const distance = this._distanceTo(vessel, bridge);
      const key = `${mmsi}::${bridgeName}`;
      const existing = this._arms.get(key);
      if (existing) {
        // Tystnad avväpnar aldrig; en NY observation uppdaterar armen.
        // (Hysteresreleasen ligger i motbevis-svepet ovan, så den prövas även
        //  när fartyget TAPPAT sin målbro och den här loopen är tom.)
        this._refreshArm(existing, vessel, distance, now);
        touched.add(bridgeName);
      } else if (this._canArm(vessel, distance, bridgeName)) {
        this._arm(vessel, bridge, distance, now);
        touched.add(bridgeName);
      }
    }

    // 3) Utvärdera berörda broar. Ett fix som gör deadline passerad avfyrar
    //    direkt — vi behöver inte vänta på nästa tick.
    for (const name of touched) this._evaluateBridge(name, 'fix', now, mmsi);
    this._scheduleNextDeadline();
  }

  /**
   * Deadline-utvärdering. Anropas från app.js befintliga 30 s-watchdog.
   * Idempotent och snabb: O(antal beväpnade båtar).
   */
  tick() {
    if (this._destroyed) return;
    const now = this._now();
    this._pruneStaleArms(now);
    // Utvärdera ALLA målbroar — även de utan armar, så tomma händelser städas.
    for (const bridgeName of this._targetBridges.keys()) {
      this._evaluateBridge(bridgeName, 'deadline', now);
    }
    this._scheduleNextDeadline();
  }

  // En gemensam timer för närmaste deadline. Den ombokas efter färsk AIS,
  // passage och avväpning; watchdogens fas avgör därmed inte vilket fix
  // som råkar vinna vid en gräns. Watchdogen finns kvar som reserv/städning.
  _scheduleNextDeadline() {
    if (!this._scheduleDeadlines || this._destroyed) return;
    const now = this._now();
    let due = Infinity;
    for (const arm of this._arms.values()) {
      // Konvojtäckningens slut är också en deadline. En absorberad arm
      // hoppas annars över nedan och släpps först av nästa watchdog/fix.
      // _releaseStrandedArms kräver now > coverUntilMs: boka första hela
      // millisekunden efter gränsen och behåll det befintliga fönstret.
      // En arm som släppvägen redan HÅLLIT efter täckningsslutet bokas inte
      // igen: hållskälen (läge vid bron, kurs bort, fryst arm) kan bara hävas
      // av ett nytt fix, och ett nytt fix utvärderar bron ändå. Utan villkoret
      // bokade timern now + 1 i varje varv — en evig nolltidsloop.
      if (arm.absorbedAt !== null && Number.isFinite(arm.coverUntilMs)
          && !(Number.isFinite(arm.recoverHeldAt) && arm.recoverHeldAt >= arm.coverUntilMs)) {
        due = Math.min(due, Math.max(now + 1, Math.floor(arm.coverUntilMs) + 1));
      }
      // U24 (M7, varv 2, familj B): en absorberad arm i en avfyrad händelse
      // utan passage släpps på sin egen deadline när villkoren i
      // _ownDeadlineVerdict håller. Boka den, så att släppet inte väntar på
      // nästa watchdog och beror på tickens fas.
      const ownWake = this._ownDeadlineWakeMs(arm, now);
      if (ownWake !== null) due = Math.min(due, ownWake);
      if (arm.warnedAt !== null || this._hasUnappliedObservation(arm) || !Number.isFinite(arm.fireDueMs)) continue;
      if (this._blockedByEarlierBridge(arm, now)) {
        due = Math.min(due, Math.ceil(arm.earlierBridgeUntilMs));
        continue;
      }
      const event = this._eventsAt(arm.bridge).find((e) => e.id === arm.eventId);
      if (!event || event.firedAt !== null || event.lastPassageAt !== null) continue;
      // Redan förfallen efter fix-utvärdering innebär batch-grinden:
      // ge resten av samma AIS-svep dess befintliga 300 ms att bli klart.
      due = Math.min(due, arm.fireDueMs <= now ? now + BATCH_SETTLE_MS : Math.ceil(arm.fireDueMs));
    }
    if (this._scheduledDeadline === due && this._deadlineTimer) return;
    if (this._deadlineTimer) clearTimeout(this._deadlineTimer);
    this._deadlineTimer = null;
    this._scheduledDeadline = due;
    if (!Number.isFinite(due)) return;
    this._deadlineTimer = setTimeout(() => {
      this._deadlineTimer = null;
      this._scheduledDeadline = null;
      if (this._destroyed) return;
      try {
        this.tick();
      } catch (error) {
        this.logger.error('[BRIDGE_OPENING] Deadline-utvärdering misslyckades:', error.message || error);
      }
    }, Math.max(1, due - now));
    this._deadlineTimer.unref?.();
  }

  /**
   * Registrerad målbropassage. Fullbordad passage är det starkaste motbeviset:
   * armen släpps och öppningshändelsen går in i konvoj-cooldown.
   * @param {string|number} mmsi
   * @param {string} bridgeName
   */
  notePassage(mmsi, bridgeName) {
    if (this._destroyed || mmsi === null || mmsi === undefined || !bridgeName) return;
    if (!this._targetBridges.has(bridgeName)) return;
    const now = this._now();
    const arm = this._arms.get(`${String(mmsi)}::${bridgeName}`);
    // K-familjen (F01): en levande arm här betyder att observeVessel inte
    // själv såg passagen (t.ex. tidig retur på ett GPS-flaggat fix). Låg
    // hennes senaste tillämpade läge redan bortom bron är fixets tid en säker
    // övre gräns för korsningen; annars bokföringen (se _crossingUpperBound).
    this._recordPassage(bridgeName, arm, now, arm ? this._crossingUpperBound(arm, now) : null);
    if (arm) this._disarm(arm, 'passage', now);
    // K20a-grindens BATCHLED ÄR EXPLICIT INERT HÄR (granskningen 2026-08-21).
    // Utvärderingen nedan är passage-driven, men skickas som 'fix' — och
    // _leadIsUnsettled läser this._observationGapMs, ett mått som BARA
    // observeVessel skriver. Under ett pollsvep bär det ≤300 ms, så grinden
    // trodde att ett svep pågick fast beslutet drevs av en passagebokföring.
    // I dag är det oåtkomligt (led (3) kräver lead.lastSeenAt === now, och den
    // enda arm som kunde ha det är den passerande — som just avväpnats och
    // därför inte är medlem), men grinden vilade då på en sammanträffande
    // tidsstämpel i stället för ett skrivet villkor. Infinity betyder "ingen
    // föregående observation att vänta in", vilket är sant: nästa observeVessel
    // räknar om måttet ur _prevObservationAt, som inte rörs här.
    this._observationGapMs = Infinity;
    this._evaluateBridge(bridgeName, 'fix', now);
    this._scheduleNextDeadline();
  }

  /**
   * Fartyget har tagits bort ur systemet. VIKTIGT: borttagning är INTE
   * motbevis — en båt som timeout:as mitt i tystnaden är exakt det fall
   * deadline-motorn finns för. Armen behålls tills ARM_STALE_TTL_MS löper ut.
   * Metoden finns för symmetri/diagnostik och för att kunna släppa armar
   * explicit vid journey-reset.
   * @param {string|number} mmsi
   * @param {string} [reason]
   * @param {boolean} [force] - true ⇒ släpp armarna nu (endast journey-reset)
   */
  removeVessel(mmsi, reason = 'removed', force = false) {
    if (this._destroyed || mmsi === null || mmsi === undefined) return;
    if (!force) return; // tystnad/timeout avväpnar aldrig
    const now = this._now();
    const bridges = new Set();
    for (const arm of this._armsForVessel(String(mmsi))) {
      bridges.add(arm.bridge);
      this._disarm(arm, reason, now);
    }
    for (const name of bridges) this._evaluateBridge(name, 'remove', now);
    this._scheduleNextDeadline();
  }

  /**
   * Appen signalerar ett uttryckligt SDK-fel. Ursprungsmedlemmarna får
   * ingen ny automatisk chans för samma händelse. Båtar som anslöt medan
   * anropet väntade har däremot aldrig fått någon konvojvarning och måste
   * kunna få sin första varning. Ett redan passerat fartyg saknar arm här.
   */
  noteWarningDeliveryFailure(eventId) {
    if (this._destroyed) return;
    for (const [bridgeName, events] of this._events) {
      const event = events.find((entry) => entry.id === eventId);
      if (!event || event.deliveryUnavailable) continue;
      event.deliveryUnavailable = true;
      let released = false;
      for (const arm of this._arms.values()) {
        if (arm.eventId !== event.id || arm.absorbedAt === null) continue;
        arm.releasedFrom.add(event.id);
        arm.warnedAt = null;
        arm.absorbedAt = null;
        arm.coverUntilMs = null;
        arm.coveredBeyondWindow = false;
        arm.eventId = null;
        released = true;
      }
      // Ny bedömning bara för tillkomna, ovarnade båtar; de gamla medlemmarnas
      // warnedAt står kvar och kan inte skapa en omlarmsloop.
      if (released) this._evaluateBridge(bridgeName, 'delivery-failed', this._now());
      this._scheduleNextDeadline();
      return;
    }
  }

  // Appen har sett både ett kajstopp och en ny avgång. Den gamla
  // ankomstens varning får inte blockera den nya, även om ett kort just
  // undertrycktes innan båten hunnit lämna själva kajzonen.
  restartArrival(mmsi, bridgeName) {
    if (this._destroyed) return;
    const arm = this._arms.get(`${String(mmsi)}::${bridgeName}`);
    if (!arm) return;
    if (arm.eventId) arm.releasedFrom.add(arm.eventId);
    arm.eventId = null;
    arm.warnedAt = null;
    arm.absorbedAt = null;
    arm.coverUntilMs = null;
    arm.coveredBeyondWindow = false;
    arm.armedAt = this._now();
    arm.eligibleAt = this._now();
    arm.originalDueMs = null;
    // Nästa positionshanterare kan ligga efter en annan båts fortsättning
    // i samma AIS-batch. Gamla kajfixen får varken varna eller absorberas.
    arm.pendingArrivalObservation = true;
  }

  /**
   * Diagnostik för [FUSION_HEALTH]-liknande rapportering och tester.
   * @returns {Object}
   */
  getStats() {
    const arms = [...this._arms.values()];
    const armedByBridge = {};
    for (const bridgeName of this._targetBridges.keys()) armedByBridge[bridgeName] = 0;
    for (const arm of arms) armedByBridge[arm.bridge] = (armedByBridge[arm.bridge] || 0) + 1;
    const allEvents = [...this._events.values()].flat();
    return {
      armed: arms.length,
      armedByBridge,
      warned: arms.filter((a) => a.warnedAt !== null).length,
      openEvents: allEvents.length,
      firedEvents: allEvents.filter((e) => e.firedAt !== null).length,
      warningsFired: this._warningCount,
    };
  }

  /**
   * Släpp allt tillstånd. Servicen äger inga timers — destroy() finns för
   * onUninit-symmetri och för omstartstestet (O4).
   */
  destroy() {
    if (this._deadlineTimer) clearTimeout(this._deadlineTimer);
    this._deadlineTimer = null;
    this._scheduledDeadline = null;
    this._arms.clear();
    this._events.clear();
    this._passageMemory.clear();
    this._destroyed = true;
    this.logger.debug('🌉 [BRIDGE_OPENING] Service nedstängd');
  }

  // ===========================================================================
  // BEVÄPNING
  // ===========================================================================

  /**
   * Vilka målbroar ska det här fixet beväpna mot?
   *
   * Alltid fartygets egen targetBridge. DÄRUTÖVER nästa målbro i samma
   * färdriktning, när ARM_NEXT_TARGET är på: målbrokedjan bryts annars av
   * TYSTNAD. En båt som passerar Klaffbron norrut och sedan tystnar hinner
   * aldrig få ett enda fix med targetBridge = Stridsbergsbron, och den
   * öppningen blir ovarnad trots att båten var väl observerad hela vägen
   * fram. Mätt över korpusarna följs 95 av 119 kedjade målbropassager (79,8 %)
   * av nästa målbros passage inom 45 min, med mediantransit 780 s.
   *
   * Broarna ligger 1217 m isär (BRIDGE_GAPS klaff–järnväg 960 + järnväg–strids
   * 257), alltså väl inom beväpningshorisonten på 2500 m: den bortre armen
   * bygger på ett RIKTIGT fix med RIKTIG geometri — ingen syntetisk position
   * skapas, och deadlinen räknas på det faktiska avståndet.
   * @private
   */
  _bridgesToArm(vessel) {
    const target = typeof vessel.targetBridge === 'string'
      && this._targetBridges.has(vessel.targetBridge) ? vessel.targetBridge : null;
    if (!target) return [];
    if (this.config.ARM_NEXT_TARGET !== true) return [target];
    const next = this._nextTargetAhead(target, this._routeDirection(vessel));
    return next ? [target, next] : [target];
  }

  /**
   * Nästa öppningsbara bro EFTER `bridgeName` i riktningen `direction`.
   * Härleds ur BRIDGE_SEQUENCE + målbrolistan — ingen egen brotabell.
   * @private
   */
  _nextTargetAhead(bridgeName, direction) {
    if (direction !== 'north' && direction !== 'south') return null;
    const idx = BRIDGE_SEQUENCE.indexOf(BRIDGE_NAME_TO_ID[bridgeName]);
    if (idx < 0) return null;
    const step = direction === 'north' ? 1 : -1;
    for (let i = idx + step; i >= 0 && i < BRIDGE_SEQUENCE.length; i += step) {
      const name = BRIDGE_ID_TO_NAME[BRIDGE_SEQUENCE[i]];
      if (name && this._targetBridges.has(name)) return name;
    }
    return null;
  }

  _earlierBridgeAhead(vessel, bridgeName, distance) {
    const waiting = waitingBridge(vessel);
    if (waiting && waiting !== bridgeName) return waiting;
    if (distance <= STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE) return null;
    const direction = this._routeDirection(vessel);
    const index = BRIDGE_SEQUENCE.indexOf(BRIDGE_NAME_TO_ID[bridgeName]);
    const step = direction === 'north' ? -1 : 1;
    if (index < 0 || !['north', 'south'].includes(direction)) return null;
    for (let i = index + step; i >= 0 && i < BRIDGE_SEQUENCE.length; i += step) {
      const bridge = BRIDGES[BRIDGE_SEQUENCE[i]];
      if (!bridge || bridge.name === 'Stallbackabron' || vessel.passedBridges?.includes(bridge.name)) continue;
      const approach = vessel._bridgeQueueApproaches?.[bridge.name];
      if ((!approach || approach.direction !== direction) && !vessel.passedBridges?.length) continue;
      if (beforeBridge(vessel, bridge, direction)) return bridge.name;
    }
    return null;
  }

  _blockedByEarlierBridge(arm, now) {
    return arm.earlierBridge && now < arm.earlierBridgeUntilMs;
  }

  /**
   * Bokför mottagningsintervallet för ett tillämpat fix (_refreshArm): tiden
   * sedan armens förra fix, högst EARLIER_BRIDGE_CADENCE_WINDOW intervall.
   * Det är armens kadens för _silentHoldLimitMs. Ett fix i samma millisekund
   * som det förra ger inget intervall.
   * @private
   * @param {Object} arm
   * @param {number} now - mottagningstiden (ms)
   */
  _noteFixCadence(arm, now) {
    if (Number.isFinite(arm.cadenceSeenAt) && now > arm.cadenceSeenAt) {
      arm.fixIntervalsMs.push(now - arm.cadenceSeenAt);
      if (arm.fixIntervalsMs.length > this.config.EARLIER_BRIDGE_CADENCE_WINDOW) arm.fixIntervalsMs.shift();
    }
    arm.cadenceSeenAt = now;
  }

  /**
   * SPÄRREN I TYSTNAD (familj D, varv 2, 2026-11-09; buggjägarens värld 263).
   *
   * Spärren vid en tidigare bro håller en båt i rörelse till restiden i
   * NUVARANDE fart minus WARNING_LEAD_MS och ersätter då 10-knopsdeadlinen
   * (_refreshArm). Den infördes mot för tidiga varningar för båtar som sedan
   * väntar vid den tidigare bron (a8d7b76). En båt som kryper fram mot
   * Järnvägsbron och tar upp farten efter bron äter därför ledtiden. Hörs hon
   * som vanligt syns accelerationen i nästa fix, och varje fix ankrar om
   * spärren. Tystnar hon finns inget nytt fix: BRISEN (värld 263) hördes var
   * 65–69:e sekund, tystnade 272 s 459 m före Stridsbergsbron (202 m före
   * Järnvägsbron) i 2,1 kn, korsade i 4,2 kn och fick varningen 44 s före.
   *
   * REGELN. Har appen inte hört henne på EARLIER_BRIDGE_SILENCE_FACTOR gånger
   * hennes längsta mottagningsintervall bland de senaste
   * (EARLIER_BRIDGE_CADENCE_WINDOW), och minst EARLIER_BRIDGE_MIN_SILENCE_MS,
   * räknas restiden i hennes fart fram till den tidigare bron och i minst
   * EARLIER_BRIDGE_BEYOND_KN därefter. Spärren får då som längst gälla till
   * det senaste av tre tider: tystnadsgränsen, den restiden minus
   * WARNING_LEAD_MS och tiden hon i sin egen fart behöver fram till den
   * tidigare bron. Returvärdet räknas från ankaret, som spärrens övriga
   * gränser i _refreshArm; den kortaste gränsen vinner. Tystnaden räknas i
   * mottagningstid (`now`), eftersom det är där appen hör henne eller inte.
   *
   * FÖRE BRON. Före den tidigare bron kan hon stanna och vänta, och det är det
   * spärren skyddar mot. En kö som börjar under tystnaden ger ingen ny rad,
   * och i tystnad går inbromsning inte att skilja från acceleration (värld 29:
   * 269 s glapp före en kö på 10 min; värld 263: 272 s glapp före
   * acceleration). Fältet säger att farten före Järnvägsbron är låg (median
   * 2,3 kn) och efter den hög (median 5,1 kn). Fram till bron räknas därför
   * hennes uppmätta fart, och bara sträckan efter den på rask fart. Medan hon
   * i den farten ännu inte har nått bron slutar spärren aldrig tidigare än
   * förut. Utan det villkoret släpptes spärren för Stridsbergsbron cirka 55 s
   * innan hon i egen fart nådde Järnvägsbron (257 m i 4 kn är 125 s, mot
   * WARNING_LEAD_MS 180 s), och en båt som stannade i kön där varnades 22 min
   * före korsningen (omgranskningen av familj D, värld 1511 med en poll till).
   * Ett golv på hela sträckan (TYST-GOLV, förkastat i granskningen) varnade
   * 9–13 min för tidigt före köer vid Järnvägsbron.
   *
   * TYSTNADSGRÄNSEN är minst EARLIER_BRIDGE_MIN_SILENCE_MS (210 s). Klass B
   * sänder var 180:e sekund under 2 kn, och via AISHub (poll var 65–70 s) tas
   * den takten emot efter två eller tre pollar, 130–210 s. En båt som bromsar
   * in och därför hörs mer sällan läses då inte som tyst.
   *
   * RESTFÖNSTRET. Kommer första fixet i kön först efter tystnadsgränsen
   * (minst 210 s) och efter att hon i egen fart skulle ha nått den tidigare
   * bron, men före c14938f:s gräns (restiden i hennes fart minus
   * WARNING_LEAD_MS, högst STALE_ETA_SOFT_MS), kan varningen gå före
   * köfixet där c14938f väntade ut kön. För Stridsbergsbron, 257 m efter
   * Järnvägsbron, kräver det fart under 257 m / 180 s = 2,8 kn, och
   * fönstret är högst 257 m / sog − 180 s brett: 70 s i 2,0 kn, 58 s i 2,1
   * kn och 20 s i 2,5 kn. I granskarens kögrid (84 fall, glapp 195–230 s)
   * gäller det 3 fall, alla med glapp 230 s och 2,0–2,1 kn.
   *
   * VAKTEN. Leder kursen i sista fixet bort från bron (_courseAway), eller
   * väntar en vändning på bekräftelse (`_fixDPendingReversal`), ges ingen
   * sådan släppning: ett antagande om rask fart mot bron vore då fel håll
   * (värld 1089: LINNEA vände i tystnaden). Spärren gäller då som förut, och
   * en planerad varning går som förut (U19).
   *
   * VAD SOM INTE BERÖRS: en båt som hörs som vanligt (nästa fix ankrar om
   * spärren före gränsen), en kö som var bekräftad i senaste fixet och en båt
   * under 2 kn (femminutersgränsen gäller som förut), en båt i rask fart eller
   * fortare (restiden blir då inte kortare än den vanliga), och en arm med
   * färre än två intervall. Efter `restartArrival` behålls kadensen, så nästa
   * fix sätter `originalDueMs` med en spärr som regeln kan ha kortat (bara
   * mätinstrumentet, ingen beslutsväg). Mätt (DESIGN.md, familj D): banken
   * (24 korpusar, med och utan monitoring), replay:openings och
   * replay:synthetic är bitlika med c14938f; i buggjägarens 2 000
   * standardvärldar kommer 9 varningar tidigare (median 20 s, högst 47 s),
   * ingen före en kö som c14938f väntade ut, och 263 varnas 70 s före
   * korsningen.
   *
   * @private
   * @param {Object} arm
   * @param {Object} vessel
   * @param {number} dist - avstånd till armens bro (m)
   * @param {number} anchor - fixets ankare (ms)
   * @param {number} now - mottagningstiden (ms)
   * @param {boolean} moving - spärrens rörelsegren (sog ≥ 2 kn, ingen bekräftad kö)
   * @returns {number} spärrens längsta tid från ankaret (ms), eller Infinity
   */
  _silentHoldLimitMs(arm, vessel, dist, anchor, now, moving) {
    if (!arm.earlierBridge || !moving || arm.fixIntervalsMs.length < 2) return Infinity;
    if (vessel._fixDPendingReversal || this._courseAway(arm, this._targetBridges.get(arm.bridge))) return Infinity;
    const gateMs = Math.max(
      this.config.EARLIER_BRIDGE_SILENCE_FACTOR * Math.max(...arm.fixIntervalsMs),
      this.config.EARLIER_BRIDGE_MIN_SILENCE_MS,
    );
    const silenceMs = (now - anchor) + gateMs;
    // Restiden: hennes fart fram till den tidigare bron, minst rask fart efter den.
    const earlier = BRIDGES[BRIDGE_NAME_TO_ID[arm.earlierBridge]];
    const toEarlierM = earlier
      ? Math.min(dist, geometry.calculateDistance(vessel.lat, vessel.lon, earlier.lat, earlier.lon))
      : dist;
    const beyondKn = Math.max(vessel.sog, this.config.EARLIER_BRIDGE_BEYOND_KN);
    const toEarlierMs = (toEarlierM / (vessel.sog * KNOTS_TO_MS)) * 1000;
    const travelMs = toEarlierMs + ((dist - toEarlierM) / (beyondKn * KNOTS_TO_MS)) * 1000;
    // Aldrig innan hon i sin egen fart har nått den tidigare bron: där kan hon stanna.
    return Math.max(silenceMs, travelMs - this.config.WARNING_LEAD_MS, toEarlierMs);
  }

  /**
   * F09 (bankkortet i 20260710-13h, 2026-11-04) — "HÖLLS VID EN TIDIGARE BRO"
   * AVGÖRS AV BÅTENS EGNA FIX, INTE AV NÄR UTVÄRDERINGEN KÖRS.
   *
   * Regeln från a8d7b76 (AKIRA-fallet, quay-departure-continuation.test.js):
   * en varning som gick medan båten hölls vid en tidigare bro täcker inte
   * hennes senare ankomst. Förut släpptes ALLA avfyrade händelser vid VARJE
   * utvärdering där spärren gällde. Om en halvminutstick hann landa mellan
   * varningen och fixet där hon lämnade kön avgjorde därför utfallet:
   * PILOT 761 varnade för Klaffbron 05:44:09 (reservvarning, eta okänd) och
   * VIRGO 265552100 lämnade kön vid Olidebron 05:44:17. I basen kom ingen tick
   * emellan och VIRGO absorberades. I fasvarianten δ −11,52 s landade en tick
   * 2 s efter varningen, och VIRGO fick en egen varning 05:44:29 för samma
   * öppning (rådata: båda korsade Klaffbron norrut 05:48:59 och 05:50:20).
   *
   * REGELN. Om en varning W släpps för en hållen båt avgörs av hennes data,
   * aldrig av när en tick råkar komma: vid hennes FÖRSTA EGNA FIX EFTER W,
   * eller i ögonblicket då spärren löper ut i tystnad (deadlinetimern bokar
   * det). W släpps när något av följande gäller:
   *  (1) ett eget fix efter W visade henne hållen (`heldSeenOrder`, se
   *      _fixAfterWarning: spärren gällde efter fixet);
   *  (2) hennes nästa fix kom mer än en tick efter W medan spärren från förra
   *      fixet fortfarande gällde (`firedAt + TICK_INTERVAL_MS <
   *      heldThroughMs`). heldThroughMs skrivs BARA av hennes egna fix
   *      (_noteHoldEnd i _refreshArm), aldrig av klockan;
   *  (3) spärren löpte ut i radiotystnad, utan att något fix visat att hon
   *      lämnat kön, och W gick före spärrens slut (`_silentHoldEnd`). Då är
   *      det senaste vi vet att hon stod kvar, och reservvarningen när
   *      spärren släpper står kvar (värld 2: NORDVIND tystnade i kön och
   *      spärren löpte ut 22 s efter WILMAs varning). Slutet är spärrens egen
   *      tid ur hennes fix.
   * Mellan W och hennes nästa fix släpps W därför aldrig, vare sig en tick
   * eller en annan båts fix kommer emellan.
   *
   * KONVOJUNDANTAGET (`keep`, en hållen båt i rörelse tätt bakom W:s ledare)
   * är oförändrat från 7699cbe: det prövas vid varje utvärdering på de
   * senaste positionerna, och en given konvojtäckning består
   * (`keepMovingConvoy`). Det släpp som kortet gällde väntar nu på hennes fix,
   * så hennes fix kan visa konvojen (granskarens sond f09-konvojfas: samma
   * utfall i alla faser). KVAR STÅR att undantaget prövas vid den första
   * utvärderingen efter W: är den en tick före hennes nästa fix avgör hennes
   * fix från före W (sonden f09-konvojtick, lika i 7699cbe). Två
   * fasoberoende varianter mättes och förkastades. Att bestämma konvojen när
   * W går ut gav en miss i buggjägarens värld 276 (JOLLY absorberades i
   * CORDELIAs varning på ett äldre fix, kröp fram och korsade vid en egen
   * öppning 9 min senare; täckningen bestod trots hennes nästa fix). Att
   * vänta på hennes nästa fix bröt den låsta gemensamma brokön
   * (opening-shared-queue-convoy, LIV/JOHANNA 2026-09-27) och gav ZWERK en
   * andra varning i 20260702-19h. Att stänga vägen kräver att en given
   * konvojtäckning kan omprövas mot hennes nästa fix (K-familjens omprövning
   * av medlemskapet), inte att beslutsögonblicket flyttas.
   *
   * Tiden i (2) är motorns egen upplösning: den gamla regeln prövades vid
   * nästa halvminutstick, alltså högst 30 s efter varningen. Kvar blir bara
   * fallet där hennes EGET fix visar att hon lämnade kön inom en tick efter
   * W. Då avgör hennes färska prognos (_belongsToEvent), som för vilken båt
   * som helst. Spärrar medan hon var absorberad i en annan händelse räknas
   * också: villkoren läser bara hennes fix, och prövas när hon åter är ovarnad.
   *
   * VAD SOM VAR FASBEROENDE I FÖRSTA VERSIONEN (granskningen 2026-11-04 och
   * K2:s sonder efteråt):
   *  - (2) jämfördes med klockan så länge spärren gällde. Varje utvärdering
   *    mer än 30 s efter W släppte W innan hennes fix hann visa en tät konvoj.
   *    20260710-13h: PILOT 761 fick Klaffbronvarningen 11:54:15 i stället för
   *    12:09:08 vid 6 av 45 faser;
   *  - (1) krävde att spärren gällde VID utvärderingen (`blocked &&
   *    lastSeenAt >= firedAt`). I ett AIS-svep där hennes fix kommer före
   *    ledarens i samma millisekund avgjorde då nästa tick om fixet räknades
   *    (sonden f09-sammams). Det fanns redan i 7699cbe.
   * Nu läser (1)–(3) bara värden som hennes fix och avfyrningen skriver.
   * @private
   * @param {Object} arm - ovarnad arm
   * @param {Object[]} events - händelserna vid armens bro
   * @param {Object|null} keep - händelse som inte släpps (positionsbelagd konvojvärd)
   * @param {number} now
   */
  _releaseWarningsWhileHeld(arm, events, keep, now) {
    const heldThrough = Number.isFinite(arm.heldThroughMs) ? arm.heldThroughMs : -Infinity;
    const silentEnd = this._silentHoldEnd(arm, now);
    for (const event of events) {
      if (event.firedAt === null || event === keep) continue;
      const seenHeldAfter = this._fixAfterWarning(arm.heldSeenOrder, event);
      const heldTickAfter = event.firedAt + this.config.TICK_INTERVAL_MS < heldThrough;
      const heldIntoSilence = event.firedAt < silentEnd;
      if (seenHeldAfter || heldTickAfter || heldIntoSilence) arm.releasedFrom.add(event.id);
    }
  }

  /**
   * Tillämpades fixet med ordningsnummer `fixOrder` EFTER att händelsen
   * avfyrade? Jämför bearbetningsordning (`_orderSeq`), inte klocktid. Båda
   * värdena skrivs bara när hennes fix tillämpas och när händelsen avfyrar,
   * så samma fråga får samma svar vid varje utvärdering: en tick kan aldrig
   * ändra det. Inom samma millisekund räknas ett fix som efter varningen bara
   * om det bearbetades efter avfyrningen (opening-confirmed-waiting-eta låser
   * det för AKIRA-regeln).
   * @private
   * @param {number|null} fixOrder - `heldSeenOrder`
   * @param {Object} event
   * @returns {boolean}
   */
  _fixAfterWarning(fixOrder, event) {
    return Number.isFinite(fixOrder) && Number.isFinite(event.firedOrder) && fixOrder > event.firedOrder;
  }

  /**
   * Gällde armens senaste spärr efter fixet som satte den? En spärr som
   * redan var slut när fixet tillämpades har aldrig hållit henne.
   * @private
   */
  _holdInEffect(arm) {
    return !!arm.earlierBridge && Number.isFinite(arm.earlierBridgeUntilMs)
      && Number.isFinite(arm.lastSeenAt) && arm.earlierBridgeUntilMs > arm.lastSeenAt;
  }

  /**
   * Bokför hur armens FÖRRA spärr slutade, i det ögonblick ett nytt eget fix
   * tillämpas (anropas av _refreshArm innan fixet skriver över `lastSeenAt`
   * och spärren). Gällde spärren fortfarande vid fixet hölls hon fram till
   * fixet ⇒ `heldThroughMs = fixTime`. Hade den redan löpt ut löpte den ut i
   * tystnad ⇒ `silentHoldEndMs`. Det är de enda två skrivställena, så båda
   * värdena är tider ur hennes egna fix och aldrig en utvärderings klocka.
   * @private
   * @param {Object} arm
   * @param {number} fixTime - tiden då det nya fixet tillämpas
   */
  _noteHoldEnd(arm, fixTime) {
    if (!this._holdInEffect(arm)) return;
    if (fixTime < arm.earlierBridgeUntilMs) {
      arm.heldThroughMs = Math.max(Number.isFinite(arm.heldThroughMs) ? arm.heldThroughMs : -Infinity, fixTime);
    } else {
      arm.silentHoldEndMs = Math.max(
        Number.isFinite(arm.silentHoldEndMs) ? arm.silentHoldEndMs : -Infinity,
        arm.earlierBridgeUntilMs,
      );
    }
  }

  /**
   * Slutet på senaste spärr som löpte ut i radiotystnad (ingen fix tog bort
   * den): pågående utlöpt spärr ⇒ `earlierBridgeUntilMs`; en tidigare sådan
   * spärr sparas i `silentHoldEndMs` av _noteHoldEnd. `now` avgör bara OM den
   * pågående spärren har löpt ut; värdet är spärrens egen sluttid.
   * @private
   */
  _silentHoldEnd(arm, now) {
    const current = this._holdInEffect(arm) && now >= arm.earlierBridgeUntilMs
      ? arm.earlierBridgeUntilMs : -Infinity;
    return Math.max(Number.isFinite(arm.silentHoldEndMs) ? arm.silentHoldEndMs : -Infinity, current);
  }

  _sharesMovingConvoy(arm, event, arms, now) {
    // En prognos kan inte förena båtar på varsin sida av en tidigare bro.
    // Undantaget kräver färska positioner som visar en tät, pågående konvoj.
    const moving = (member) => Number.isFinite(member.sog) && member.sog >= 2
      && !member.waitingAtBridge && !this._hasUnappliedObservation(member)
      && Number.isFinite(member.rawAnchorMs) && member.rawAnchorMs <= now
      && now - member.rawAnchorMs <= STALE_ETA_SOFT_MS;
    if (!event || event.deliveryUnavailable || event.firedAt === null
        || now - event.firedAt > STALE_ETA_SOFT_MS || !moving(arm)) return false;
    return arms.some((lead) => {
      if (lead === arm || lead.eventId !== event.id || lead.warnedAt === null
          || lead.absorbedAt !== null || !moving(lead)
          || !arm.routeDirection || lead.routeDirection !== arm.routeDirection) return false;
      // Jämför positionerna vid samma tid, högst en minuts förskjutning.
      // Därmed blir ordningen inom ett pollsvep inte ett falskt konvojglapp.
      if (Math.abs(arm.rawAnchorMs - lead.rawAnchorMs) > 60000) return false;
      const at = Math.max(arm.rawAnchorMs, lead.rawAnchorMs);
      const distanceAt = (member) => member.distanceM
        - ((at - member.rawAnchorMs) / 1000) * member.sog * KNOTS_TO_MS;
      return Math.abs(distanceAt(arm) - distanceAt(lead))
        <= STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE;
    });
  }

  _sharesEarlierQueue(arm, arms, now) {
    // LIV/JOHANNA 2026-09-27: en redan belagd konvoj stannade tillsammans
    // vid Järnvägsbron. LIV fick väntbevis, medan JOHANNAs 1,2 kn fortfarande
    // saknade väntetikett trots bara några meters positionsskillnad.
    // Samma tidigare bro, låg fart och färska närliggande positioner kan
    // bevara given täckning; detta får aldrig skapa en ny konvojkoppling.
    return arms.some((lead) => lead !== arm && lead.eventId === arm.eventId
      && lead.warnedAt !== null && lead.absorbedAt === null
      && !this._hasUnappliedObservation(lead)
      && arm.routeDirection && lead.routeDirection === arm.routeDirection
      && lead.earlierBridge === arm.waitingAtBridge
      && (lead.waitingAtBridge === arm.waitingAtBridge
        || (Number.isFinite(lead.sog) && lead.sog < 2))
      && Number.isFinite(lead.rawAnchorMs) && lead.rawAnchorMs <= now
      && now - lead.rawAnchorMs <= STALE_ETA_SOFT_MS
      && Number.isFinite(arm.distanceM) && Number.isFinite(lead.distanceM)
      && Math.abs(arm.distanceM - lead.distanceM) <= STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE);
  }

  /**
   * Ligger bron BAKOM fartyget i hennes färdriktning?
   *
   * Farleden är monotont nord-sydlig (BRIDGE_SEQUENCE:s latituder är strikt
   * stigande Olidebron→Stallbackabron), så "bakom" = fartyget är NORR om bron
   * på nordlig kurs, eller SÖDER om den på sydlig. Okänd ruttriktning ⇒ false
   * (fail-open, produktprincipen).
   *
   * Predikatet är REN GEOMETRI och kräver INGEN registrerad passage — och det
   * är hela poängen. Vid gap-flush ankras målbropassagen i en SENARE del av
   * samma meddelande än _observeBridgeOpening körs, så `passedAt` är ännu tom
   * när armen skapas: ELFKUNGEN 2026-07-03 beväpnades mot Stridsbergsbron
   * 414 m NORR om bron på nordlig kurs och fick sin "öppnar snart"-varning i
   * exakt samma millisekund som passagen bokfördes 51 loggrader senare.
   *
   * Ett TIDSFÖNSTER hade varit fel: soakens U-svängare passerar Klaffbron
   * norrut, vänder och passerar samma bro söderut 13 min senare — returresan
   * är en HELT äkta öppning som måste varnas, och den fångas rätt här (bron
   * ligger då FRAMFÖR henne igen).
   * @private
   */
  _bridgeIsBehind(vessel, bridgeName) {
    const bridge = this._targetBridges.get(bridgeName);
    if (!bridge || !Number.isFinite(vessel.lat)) return false;
    const dir = this._routeDirection(vessel);
    if (dir === 'north') return vessel.lat > bridge.lat;
    if (dir === 'south') return vessel.lat < bridge.lat;
    return false;
  }

  /**
   * Får fartyget beväpnas? Grindarna ÅTERANVÄNDER appens befintliga bevis —
   * ingen ny rörelse-/förtöjningsdetektering byggs här.
   * @private
   */
  _canArm(vessel, distance, bridgeName) {
    if (!Number.isFinite(distance) || distance > this.config.ARM_MAX_DISTANCE_M) return false;

    // BRON LIGGER BAKOM — aldrig en FÖRESTÅENDE öppning. Grinden gäller bara
    // FÖRSTA beväpningen; en redan beväpnad båt släpps av sitt eget motbevis,
    // så GPS-jitter kring bron kan aldrig avväpna en väntande båt här.
    if (bridgeName && this._bridgeIsBehind(vessel, bridgeName)) return false;

    // Förtöjd båt beväpnas aldrig (5-lagersdetekteringen från 2026-06-10).
    if (vessel._moored === true) return false;

    // C9 (etapp 7 fas C, 2026-08-09) — SPEGELN AV DISARM-BEN 3b, och den är
    // OBLIGATORISK, inte kosmetisk. Utan den blir stillhetsavväpningen
    // självförstörande: motbevis-svepet släpper armen på fix N (steg 1 spärrar
    // återbeväpning i SAMMA meddelande), men på fix N+1 finns ingen arm att
    // pröva motbeviset mot — hon beväpnas på nytt, och en NY arm har ett
    // FÄRSKT ankare vars deadline (d/10 kn − 180 s) förfaller innan nästa fix
    // hinner avväpna igen vid AISHubs kadens. Resultatet hade blivit FLER
    // fantomvarningar, inte färre. Samma golv och samma bevis som ben 3b: en
    // väntande båt innanför DISARM_MOORED_MIN_DISTANCE_M rörs aldrig.
    if (Number.isFinite(distance)
        && distance > this.config.DISARM_MOORED_MIN_DISTANCE_M
        && this._hasStillnessEvidence(vessel)) {
      return false;
    }

    // RÖRELSEBEVIS. En båt som aldrig setts röra sig är ingen anflygning —
    // den är en kajliggare. dig11:s rena avståndsmotor (utan den här grinden)
    // hade beväpnat SALTYX på ett sog=0-fix 383 m från Klaffbron och fyrat
    // direkt; i bandet 300–400 m ligger 49 anflygningsepisoder UTAN passage
    // (dig2), dvs. rena kajliggare. Priset är nattens tysta kajavgångar
    // (NANNA, SALTYX) som får klassas som "tyst-från-start"-missar —
    // SALTYX täcks ändå av konvojen med JUNO.
    if (vessel._hasMovementProof !== true) return false;

    // J22 (helkodsgranskning runda 2, 2026-08-22) — C6:s BEVÄPNINGSBEVIS,
    // äntligen inkopplat. _hasMovementProof ovan godtar ETT enda sampel; C6:s
    // predikat kräver ≥2 observationer ELLER en enda RIMLIG (klistrande
    // bokföring, så ett senare sog=0 inte öppnar hålet igen). Skillnaden är
    // UPPMÄTT 2026-08-09, inte antagen: predikatet tar bort exakt 3
    // rådataverifierade enkelsampelsfantomer som fyrade på fryst position
    // (211488728 × 2 i korpus 20260804-17h, 218023240 × 1 i 20260713-41h;
    // 323 → 320 varningar) och NOLL äkta förvarningar. Det HÅRDARE
    // _hasCorroboratedMovement hade i stället kostat 22 av 323 ÄKTA
    // förvarningar — därför just det här predikatet och inget annat.
    // BAKÅTKOMPATIBELT: saknas predikatet (ingen injektion) ställs inget nytt
    // krav, så befintliga anropare som bygger servicen utan optionen är orörda.
    if (this._hasArmingMovementEvidence
        && this._hasArmingMovementEvidence(vessel) !== true) {
      return false;
    }

    // V1-KAJBOKFÖRINGEN (A/B-natten 2026-08-03). En båt med färsk kajstabil
    // historik som ännu inte korroborerat sin avgång är en kajvobblare —
    // PRICKBJORN-klassen. Predikatet injiceras av app.js (samma bokföring som
    // boat_near-grinden läser); ingen parallell sanning byggs här.
    if (this._isQuayWobbler && this._isQuayWobbler(vessel) === true) return false;

    return true;
  }

  /** @private */
  _arm(vessel, bridge, distance, now) {
    if (this._arms.size >= this.config.MAX_ARMS) this._pruneOldestArm();
    const mmsi = String(vessel.mmsi);
    const arm = {
      key: `${mmsi}::${bridge.name}`,
      mmsi,
      bridge: bridge.name,
      armedAt: now,
      lastSeenAt: now,
      // Riktningen VID BEVÄPNING — U-svängsmotbeviset jämför mot den.
      armDirection: this._routeDirection(vessel),
      routeDirection: this._routeDirection(vessel),
      name: this._vesselName(vessel),
      distanceM: null,
      sog: null,
      cog: null,
      etaMinutes: null,
      waitingAtBridge: null,
      // K-familjen (KRAV PÅ ETT NYTT FÖRSÖK, ARCHITECTURE.md §H29/H30): armen
      // bär sitt SENAST TILLÄMPADE läge. Släppvägen (_coverageVerdict) måste
      // kunna pröva om bron ligger bakom båten, om hon låg under bron och om
      // kursen leder bort — utan läget gick ingen av grindarna att skriva.
      // Skrivs bara av _refreshArm, i samma takt som lastSeenAt.
      lat: null,
      lon: null,
      // Var det senast tillämpade fixet GPS-rent och färskt? Bakkantsgrinden
      // får bara släppa på en prognos som vilar på ett sådant fix.
      lastFixClean: false,
      // Hållen täckning: när och varför släppvägen senast höll armen kvar efter
      // täckningsslut. Endast för loggdedup och schemaläggning — ingen fysik.
      // Gäller bara den täckning hållet prövades mot: nollställs vid varje ny
      // absorption (_bindLooseArms) och vid släppet (_releaseCoveredArm), så
      // att en arm som tappat täckningen på en annan väg (restartArrival,
      // leveransfel, spärren vid en tidigare bro, räddningsventilen) och
      // absorberas igen får sin nya täckningsgräns bokad av schemaläggaren.
      recoverHeldAt: null,
      recoverHoldReason: null,
      // Händelsen som korsningsankarets golv (_anchorFloorHost) absorberade
      // armen i, annars null. Bakkanten mäter en golvhållen arm mot
      // täckningsslutet, inte mot U2-fönstret kring korsningen: hon ligger per
      // konstruktion bortom det fönstret. Skrivs vid varje ny absorption.
      anchorFloorEventId: null,
      anchorMs: now,
      // RÅANKARET — fixets tid FÖRE klampningen i _refreshArm. Enda syftet är
      // mätning (fixAgeMs i payloaden); ingen fysik läser det. Se _refreshArm.
      rawAnchorMs: null,
      fireDueMs: Infinity,
      // ARMENS URSPRUNGLIGA DEADLINE (A8(iii), mätinstrument — ingen
      // beslutsväg). Fryses EN gång direkt efter första _refreshArm nedan och
      // skrivs sedan aldrig om: varken av nya fix, av konvojabsorption eller av
      // _releaseStrandedArms. fireDueMs vandrar med varje fix och den
      // rapporterade dueMs binds dessutom om mot eligibleAt vid varje
      // händelseknytning — utan en fryst referens går det inte att skilja "vi
      // fyrade sent" från "deadlinen flyttades under oss".
      originalDueMs: null,
      expectedArrivalMs: null,
      // FYSIKANKOMSTEN (varv 2, familj B, M5): ankare + avstånd / fart ur
      // senaste tillämpade fix, eller null när farten inte är mätbar
      // (≤ MINIMUM_VIABLE_SPEED). Läses bara av släppvägen (_coverageVerdict);
      // ETA-texten, eta-tokenen och deadlinen läser den inte (U22).
      physicsArrivalMs: null,
      // Antal NYA fix I FÖLJD med krypfart (MINIMUM_VIABLE_SPEED < sog <
      // MIN_PASSAGE_ROUTE_SPEED_KNOTS); ett fix är nytt när dess tid gått
      // framåt. Nollas av varje annat nytt fix. crawlFromCruise: det här
      // krypfixet kom direkt efter ett fix i marschfart (prevFixSog ≥
      // MIN_PASSAGE_ROUTE_SPEED_KNOTS). Se _crawlArrivalMs.
      crawlFixes: 0,
      crawlFromCruise: false,
      prevFixSog: null,
      warnedAt: null,
      eventId: null,
      // Sattes warnedAt av en KONVOJABSORPTION (armen anslöt till en redan
      // avfyrad öppning) — och i så fall hur länge den täckningen gäller.
      // Se _releaseStrandedArms.
      absorbedAt: null,
      coverUntilMs: null,
      // U9 (användarbeslut 2026-08-09) — TÄCKT BORTOM KONVOJFÖNSTRET.
      // true endast när absorptionen skedde via U9:s breda täckning, dvs. när
      // armen INTE uppfyller _belongsToEvent men ändå bands till en avfyrad,
      // o-passerad händelse. Bara sådana armar prövas av räddningsventilen —
      // en arm som ryms i konvojfönstret ÄR den öppningen och ska aldrig få en
      // andra varning. Se _rescueCoveredArms.
      coveredBeyondWindow: false,
      // U9-DEDUPEN: händelser armen redan fått en räddningsvarning ur. EN per
      // (båt, händelse) — utan spärren kunde hon absorberas av samma händelse
      // igen (kriteriet är ju fortfarande uppfyllt) och räddas om och om igen.
      rescuedFrom: new Set(),
      // När armen blev valbar för sin NUVARANDE händelse. Avfyrningen kan
      // aldrig ske före max(fireDueMs, eligibleAt) — grinden mäter mot den
      // summan, annars såg en arm vars deadline redan förfallit vid
      // beväpningen (eller vid ett konvojsläpp) ut som en försenad avfyrning.
      eligibleAt: now,
      // C7b/F-4: senaste fix vi LÄST från fartyget medan armen inte kunde
      // uppdateras (målbron släppt). null = det har aldrig hänt. Jämförs mot
      // lastSeenAt, som bara _refreshArm skriver. Se _hasUnappliedObservation.
      lastObservedAt: null,
      // Händelser armen redan SLÄPPTS från. Utan spärren knöts hon direkt in
      // i samma avfyrade händelse igen (konvojkriteriet är ju fortfarande
      // uppfyllt), släpptes nästa utvärdering, och snurrade — hon fick aldrig
      // sin egen öppning.
      releasedFrom: new Set(),
      // F09: när armen enligt sina egna fix senast hölls vid en tidigare bro
      // (se _noteHoldEnd och _silentHoldEnd). null = aldrig.
      heldThroughMs: null,
      silentHoldEndMs: null,
      // F09: bearbetningsordningen (`_orderSeq`) för senaste egna fix som
      // visade henne hållen vid en tidigare bro. Se _fixAfterWarning.
      heldSeenOrder: null,
      // Spärren i tystnad (familj D, varv 2): mottagningstiden för armens
      // senaste tillämpade fix och de senaste mottagningsintervallen (ms,
      // högst EARLIER_BRIDGE_CADENCE_WINDOW). Se _noteFixCadence och
      // _silentHoldLimitMs.
      cadenceSeenAt: null,
      fixIntervalsMs: [],
      // U15 (B02): båtens senaste bokförda passage av den här bron ur
      // returminnet när armen skapades ({ at, eventId }), eller null. Satt ⇒
      // armen är en RETURRESA, och _releaseReturnCoverage spärrar de
      // händelser som beskriver öppningen hon redan passerat.
      returnAfterPassage: null,
    };
    this._refreshArm(arm, vessel, distance, now);
    arm.returnAfterPassage = this._ownPassage(arm);
    // Frys ursprungsdeadlinen — EN gång, här. _refreshArm får aldrig röra den
    // (den anropas om vid varje nytt fix), och absorption/släpp rör bara
    // eligibleAt/warnedAt. Är avståndet oanvändbart förblir fireDueMs Infinity
    // och referensen null; payloaden bär då null, precis som dueMs gör.
    arm.originalDueMs = Number.isFinite(arm.fireDueMs) ? arm.fireDueMs : null;
    this._arms.set(arm.key, arm);
    this.logger.debug(
      `🎯 [OPENING_ARM] ${mmsi} (${arm.name || 'okänt namn'}): beväpnad mot ${bridge.name} `
      + `d=${Math.round(distance)} m sog=${Number.isFinite(vessel.sog) ? vessel.sog : 'null'} `
      + `dir=${arm.armDirection || 'unknown'} deadline om ${this._secondsUntil(arm.fireDueMs, now)} s`,
    );
    return arm;
  }

  /**
   * U15 (användarbeslut 2026-11-04, kort B02) — RETURRESAN ÄR EN EGEN ÖPPNING.
   *
   * En ny arm är alltid en ny anflygning: den förra armen avväpnades när
   * båten passerade (observeVessel steg 1 eller notePassage). _arm frågar
   * därför returminnet (`_passageMemory`, skrivs i _recordPassage) om hon
   * redan passerat bron. Svaret sparas på armen som `returnAfterPassage`, och
   * _releaseReturnCoverage spärrar sedan de händelser som beskriver öppningen
   * hon redan passerat.
   *
   * MINNET ÄR FRIKOPPLAT FRÅN HÄNDELSELISTAN (omgranskningen 2026-11-05).
   * Förut lästes passagen ur hennes egen gamla händelse. Den städas i
   * _evaluateBridge steg 2 ett konvojfönster efter passagen, medan en annan
   * händelse för samma öppning kan leva längre. Runt den kanten avgjorde
   * tickens fas om returen kändes igen, och efter den absorberades returen
   * alltid i den andra händelsen (granskarens sond b02-936-kant: 0 av 30
   * faser vid returarm 728 s, 15 av 30 vid 745 s, 30 av 30 från 762 s).
   * @private
   * @param {Object} arm - den nya armen
   * @returns {{at: number, eventId: (string|null)}|null} senaste bokförda passage vid bron
   */
  _ownPassage(arm) {
    const passage = this._passageMemory.get(arm.key);
    return passage && Number.isFinite(passage.at) ? passage : null;
  }

  /**
   * Städa returminnet vid en bro (anropas av _evaluateBridge efter steg 2,
   * med den städade händelselistan). En post behövs så länge den kan ändra
   * ett värdval:
   *  - ett konvojfönster efter passagen, eftersom en händelse som ännu inte
   *    fått sin första passage kan få den inom fönstret (villkor (b) i
   *    _describesPassedOpening);
   *  - därefter så länge någon levande händelse beskriver öppningen hon
   *    passerade. Efter fönstret kan en ny händelse uppfylla villkoren bara
   *    om dess prognos redan ligger i det förflutna (en försenad båt).
   * En arm som redan skapats bär sin egen kopia (`returnAfterPassage`), så
   * städningen påverkar bara en returarm som skapas senare.
   * @private
   * @param {string} bridgeName
   * @param {Object[]} events - levande händelser vid bron
   * @param {number} now
   */
  _prunePassageMemory(bridgeName, events, now) {
    const suffix = `::${bridgeName}`;
    for (const [key, passage] of this._passageMemory) {
      if (!key.endsWith(suffix)) continue;
      if (now - (Number.isFinite(passage.registeredAt) ? passage.registeredAt : passage.at)
        <= this.config.CONVOY_WINDOW_MS) continue;
      if (events.some((event) => this._describesPassedOpening(event, passage))) continue;
      this._passageMemory.delete(key);
    }
  }

  /**
   * Beskriver händelsen ÖPPNINGEN SOM BÅTEN REDAN PASSERAT? (U15, B02.)
   * Bara en avfyrad händelse kan absorbera, så bara en sådan prövas. En
   * oavfyrad händelse hon ansluter till varnar för henne som medlem, och det
   * är en egen varning för returen.
   *
   * Händelsens öppning är dess referensankomst: den första verkliga passagen
   * när den finns (_recordPassage), annars prognosen när varningen gick ut
   * (_fire). Två passager är SAMMA öppning när de ligger inom
   * CONVOY_WINDOW_MS (dig9, se konstanten), och det är samma mått som
   * _belongsToEvent använder. Villkoren:
   *  (a) hon passerade själv bron i händelsen (`eventId` i minnet);
   *  (b) händelsens referensankomst ligger inom CONVOY_WINDOW_MS från hennes
   *      passage. Det täcker värld 936 (ALVA:s Klaffbron#5 och XENIA:s #6,
   *      korsningarna 74 s isär) och spegelbilden där en annan båts varning
   *      går EFTER hennes passage men gäller samma öppning (granskningen
   *      2026-11-04). Villkoret prövas om i varje utvärdering, så det gäller
   *      också när referensen byts mot den verkliga passagen efter att
   *      returarmen skapats;
   *  (c) referensankomsten saknas och varningen gick ut vid eller före hennes
   *      passage. Då går öppningen inte att placera, och den mest sannolika
   *      är den hon passerade. Missad öppning är värre än falsklarm, så den
   *      får inte täcka returen.
   * Allt annat får täcka returen som vanligt, OAVSETT när varningen gick ut:
   * en varning för en senare öppning (referensen mer än ett konvojfönster
   * från hennes passage) som returen hinner med är nästa öppning (U2), och
   * en egen varning vore en andrapåminnelse. Förut avgjorde varningens tid
   * relativt hennes passage, så utfallet hängde på en knivsegg
   * (omgranskningen 2026-11-05, sonden b02-senare-oppning).
   * @private
   * @param {Object} event
   * @param {{at: number, eventId: (string|null)}} passage - hennes senaste passage
   * @returns {boolean}
   */
  _describesPassedOpening(event, passage) {
    if (event.firedAt === null) return false;
    if (passage.eventId !== null && event.id === passage.eventId) return true;
    const reference = event.firstPassageAt !== null ? event.firstPassageAt : event.referenceArrivalMs;
    if (Number.isFinite(reference)) {
      return Math.abs(reference - passage.at) <= this.config.CONVOY_WINDOW_MS;
    }
    return event.firedAt <= (Number.isFinite(passage.registeredAt) ? passage.registeredAt : passage.at);
  }

  /**
   * U15 — RETURRESANS GAMLA TÄCKNING SPÄRRAS (anropas för varje arm i
   * _bindLooseArms, före värdvalet, i varje utvärdering).
   *
   * Händelser som beskriver öppningen hon redan passerat
   * (_describesPassedOpening) läggs i armens `releasedFrom`, som alla värdval
   * redan respekterar — inte ens inom konvojfönstret, där händelsen annars
   * lever kvar för båtar som kommer efter (U2: "båtar som anländer efter
   * passagen är nästa öppning"). Är hon redan absorberad i en sådan händelse
   * släpps absorptionen, och hon binds om som lös i samma utvärdering.
   *
   * RÅDATABEVIS (minsta repro B02, värld 1273, R0): VEGA 265441711 varnades
   * för Stridsbergsbron#3 08:24:49, korsade norrut 08:26:57, vände 881 m
   * norr om bron, absorberades i sin egen #3 08:32:35 och korsade söderut
   * 08:35:55 utan egen varning.
   *
   * INGET LEDTIDSGOLV (dirigentens beslut 2026-11-05 om U15). Förut stod den
   * gamla täckningen kvar när förväntad ankomst låg närmare än
   * 2 × TICK_INTERVAL_MS. Nu får returen sin egen varning även då, precis som
   * vilken annan sent beväpnad anflygning som helst: _bindLooseArms och
   * avfyrningen behandlar henne som en vanlig lös arm. Upptäcks returen
   * först efter korsningen (värld 227, ZELDA beväpnad 13 m före bron 9 s
   * efter sin verkliga returkorsning) kommer varningen efter korsningen. Det
   * är riktningslogikens kända gräns (U18: två positioner innan en vändning
   * tros), inte konvojens, och den kostar ingen öppning: den gamla
   * täckningen gällde en annan öppning.
   *
   * VAD SOM INTE PÅVERKAS: andra båtar (spärren gäller bara hennes arm), en
   * båt som vänder FÖRE bron eller ligger och väntar (ingen passage ⇒ ingen
   * returarm; U2 "inga andrapåminnelser"), och en arm som redan varnats som
   * medlem i en händelse efter passagen (returen har då sin egen varning).
   * @private
   * @param {Object} arm
   * @param {Object[]} events - händelserna vid armens bro
   */
  _releaseReturnCoverage(arm, events) {
    const passage = arm.returnAfterPassage;
    if (passage === null) return;
    if (arm.warnedAt !== null && arm.absorbedAt === null) return;
    const passedOpening = events.filter((event) => !arm.releasedFrom.has(event.id)
      && this._describesPassedOpening(event, passage));
    if (passedOpening.length === 0) return;
    for (const event of passedOpening) arm.releasedFrom.add(event.id);
    const absorbedIn = arm.absorbedAt !== null && passedOpening.some((event) => event.id === arm.eventId)
      ? arm.eventId : null;
    if (absorbedIn !== null) {
      arm.warnedAt = null;
      arm.absorbedAt = null;
      arm.coverUntilMs = null;
      arm.coveredBeyondWindow = false;
      arm.eventId = null;
    }
    this.logger.debug(
      `↩️ [OPENING_RETURN] ${arm.mmsi} (${arm.name || 'okänt namn'}): ${arm.bridge} — returresa efter `
      + `passagen ${new Date(passage.at).toISOString()}; ${passedOpening.map((event) => event.id).join(', ')} `
      + `täcker inte returen (U15)${absorbedIn !== null ? `, släpps ur ${absorbedIn}` : ''}`,
    );
  }

  /**
   * Uppdatera armens fysik ur ett NYTT fix.
   *
   * KLOCKDOMÄNDOKTRINEN (ARCHITECTURE §mux): avståndet MÄTTES vid fixets tid,
   * inte vid mottagningen. En AISHub-fix kan levereras upp till ~220 s efter
   * emissionen (nattens p90 = 62 s) — ankras deadlinen i mottagningstiden blir
   * den optimistisk med exakt den leveranslaggen och garantin spricker.
   * Ankaret är därför min(fixTs, timestamp): den TIDIGASTE av de två, vilket
   * alltid är det pessimistiska valet.
   * @private
   */
  _refreshArm(arm, vessel, distance, now) {
    if (arm.pendingArrivalObservation && (!Number.isFinite(distance)
        || vessel._gpsJumpDetected || vessel._positionUncertain
        || !hasFreshPosition(vessel, now))) return;
    const dist = Number.isFinite(distance) ? distance : arm.distanceM;
    if (!Number.isFinite(dist)) return;

    const fixTs = Number.isFinite(vessel.fixTs) ? vessel.fixTs : null;
    const recvTs = Number.isFinite(vessel.timestamp) ? vessel.timestamp : now;
    let anchor = fixTs !== null ? Math.min(fixTs, recvTs) : recvTs;
    // MÄTPUNKTEN sparas FÖRE klampningen nedan (B2d-instrumentet). anchorMs
    // duger inte som åldersmått: den klampas till MAX_FIX_ANCHOR_AGE_MS och
    // underrapporterar därmed exakt i den klass mätningen finns för — ett fix
    // 854 s gammalt syns som 720 s. Rå tid, ingen fysik.
    const rawAnchor = anchor;
    // Skydd mot skräpklocka ÅT BÅDA HÅLL. Ett ankare i FRAMTIDEN vore
    // optimistiskt (deadlinen skjuts fram). Ett orimligt GAMMALT ankare gör
    // både deadlinen och ankomstprognosen godtyckligt gamla — varningen fyras
    // omedelbart och eta_minutes blir en siffra ur en annan tid. Golvet är
    // MAX_FIX_ANCHOR_AGE_MS, satt till fusionens egen åldersgrind: ett fix
    // äldre än så kan inte ha nått hit på laglig väg, så klampningen kan per
    // konstruktion aldrig äta en verklig leveranslagg (nattens p90 = 62 s).
    if (!Number.isFinite(anchor) || anchor > now) anchor = now;
    else if (now - anchor > this.config.MAX_FIX_ANCHOR_AGE_MS) {
      anchor = now - this.config.MAX_FIX_ANCHOR_AGE_MS;
    }

    // F09: spara slutet på armens förra spärr vid en tidigare bro innan det
    // här fixet skriver över lastSeenAt och spärren nedan — som avslutad av
    // ett eget fix (heldThroughMs) eller utlöpt i tystnad (silentHoldEndMs).
    this._noteHoldEnd(arm, now);
    arm.pendingArrivalObservation = false;
    arm.lastSeenAt = now;
    arm.anchorMs = anchor;
    // Förra fixets tid, för krypräknaren nedan (nya fix, inte upprepningar).
    const prevFixMs = arm.rawAnchorMs;
    arm.rawAnchorMs = Number.isFinite(rawAnchor) ? rawAnchor : null;
    arm.distanceM = dist;
    arm.lat = Number.isFinite(vessel.lat) ? vessel.lat : null;
    arm.lon = Number.isFinite(vessel.lon) ? vessel.lon : null;
    arm.lastFixClean = !vessel._gpsJumpDetected && !vessel._positionUncertain
      && hasFreshPosition(vessel, now);
    arm.sog = Number.isFinite(vessel.sog) ? vessel.sog : null;
    arm.cog = Number.isFinite(vessel.cog) ? vessel.cog : null;
    // Samma kö- och stillhetsbevis som brotexten; statusnamnet räcker inte.
    // Spara beslutet från detta fix, utan referens till ett senare städat objekt.
    arm.waitingAtBridge = waitingBridge(vessel);
    // Låst ruttriktning kan komma FÖRST efter beväpningen (appen låser den när
    // beviset finns) — armen bär alltid den senaste kända.
    arm.routeDirection = this._routeDirection(vessel) || arm.routeDirection || null;
    // U-SVÄNGSMOTBEVISETS REFERENS. Beväpningen kan ske innan appen låst
    // ruttriktningen; armDirection blev då null FÖR ALLTID och _disarmEvidence
    // kunde aldrig se en U-sväng (ett av bara tre motbevis var tyst avstängt).
    // Referensen låses därför vid FÖRSTA kända riktningen — och skrivs sedan
    // aldrig om, annars hade U-svängen skrivit över sitt eget motbevis.
    if (!arm.armDirection && arm.routeDirection) arm.armDirection = arm.routeDirection;
    arm.name = this._vesselName(vessel) || arm.name;

    // ETA:N TILLHÖR EN BESTÄMD BRO. vessel.etaMinutes är per definition ETA
    // till fartygets EGEN targetBridge (ProgressiveETACalculator nollställer
    // den vid varje målbrobyte). Kedjearmen (ARM_NEXT_TARGET) pekar på NÄSTA
    // målbro och får därför ALDRIG ärva den siffran: gjorde den det blev
    // eta_minutes-tokenen fysikaliskt omöjlig (1855 m "om 4 minuter" = 15 kn)
    // och avfyrningen sköts ~10 min för tidigt, vilket dessutom förgiftade
    // konvojgrupperingens referensankomst. Kedjearmen räknar i stället på sitt
    // EGET avstånd — samma modell och samma fart som den närmare armen, alltså
    // konsistent med appens ETA i uniform fart.
    const etaBelongsToArm = typeof vessel.targetBridge === 'string'
      && vessel.targetBridge === arm.bridge;
    arm.etaMinutes = etaBelongsToArm
      && Number.isFinite(vessel.etaMinutes) && vessel.etaMinutes >= 0
      ? vessel.etaMinutes : null;

    // (1) DEADLINE — pessimistisk: tidigast möjliga ankomst minus ledtid.
    const vMax = this.config.DEADLINE_MAX_SPEED_KN * KNOTS_TO_MS; // m/s
    const earliestArrivalMs = anchor + (dist / vMax) * 1000;
    const deadlineMs = earliestArrivalMs - this.config.WARNING_LEAD_MS;

    // (2) FÖRVÄNTAD ankomst — används både för snabbbåts-grenen och för
    //     eta_minutes-tokenen. EN klockdomän: båda grenarna ankras i FIXETS
    //     tid, inte i mottagningstiden. Appens ETA är räknad ur fixets
    //     position och hör alltså hemma i fixets tidsdomän; ankrades den i
    //     `now` blev prognosen systematiskt optimistisk med hela
    //     leveranslaggen (och fältet bar två klockdomäner beroende på gren).
    const speedKn = Number.isFinite(arm.sog) && arm.sog > PASSAGE_TIMING.MINIMUM_VIABLE_SPEED
      ? arm.sog : PASSAGE_TIMING.DEFAULT_VESSEL_SPEED;
    arm.expectedArrivalMs = arm.etaMinutes !== null
      ? anchor + arm.etaMinutes * 60000
      : anchor + (dist / (speedKn * KNOTS_TO_MS)) * 1000;
    // (2b) FYSIKANKOMSTEN (varv 2, familj B, M5) — armens EGEN fysik,
    //      avstånd genom fart ur samma fix och i samma klockdomän. Appens ETA
    //      räknar efter en passage med minst MIN_PASSAGE_ROUTE_SPEED_KNOTS
    //      (ProgressiveETACalculator) och håller emot hopp uppåt, så för en
    //      krypare ligger expectedArrivalMs minuter för tidigt (värld 790:
    //      230 m i 0,9 kn, appen 3 min, fysiken 6,4 min). Bara släppvägen
    //      läser fältet (se _coverageVerdict); deadlinen, eta-tokenen och
    //      ETA-texten är oförändrade (U22).
    arm.physicsArrivalMs = Number.isFinite(arm.sog) && arm.sog > PASSAGE_TIMING.MINIMUM_VIABLE_SPEED
      ? anchor + (dist / (arm.sog * KNOTS_TO_MS)) * 1000 : null;
    // KRYPRÄKNAREN (se _crawlArrivalMs) räknar NYA fix: bara när fixets tid
    // har gått framåt. En upprepad leverans av samma fix (aisstream-
    // multiplexern filtrerar inte dubbletter) räknas inte en gång till
    // (granskningens prob D4).
    const newFix = !Number.isFinite(prevFixMs)
      || (Number.isFinite(arm.rawAnchorMs) && arm.rawAnchorMs > prevFixMs);
    if (newFix) {
      const crawl = Number.isFinite(arm.physicsArrivalMs) && arm.sog < MIN_PASSAGE_ROUTE_SPEED_KNOTS;
      arm.crawlFromCruise = crawl && Number.isFinite(arm.prevFixSog)
        && arm.prevFixSog >= MIN_PASSAGE_ROUTE_SPEED_KNOTS;
      arm.crawlFixes = crawl ? (arm.crawlFixes || 0) + 1 : 0;
      arm.prevFixSog = Number.isFinite(arm.sog) ? arm.sog : null;
    }
    const etaFireMs = arm.expectedArrivalMs - this.config.FIRE_EXPECTED_ETA_MS;

    arm.earliestArrivalMs = earliestArrivalMs;
    arm.fireDueMs = Math.min(deadlineMs, etaFireMs);
    // Färska positioner före en annan öppningsbar bro kan inte lova nästa
    // öppning. Bevakningen ligger kvar; när båten når slutsträckan eller
    // lämnar en bekräftad kö räknas deadlinen om ur den nya positionen.
    // Vid radiotystnad släpps spärren vid samma femminutersgräns som en
    // osäker ETA. Det är en reservvarning, inte ett påstående om passage.
    arm.earlierBridge = this._earlierBridgeAhead(vessel, arm.bridge, dist);
    // Under pågående gång måste även reservvägen hinna före ankomsten.
    // En bekräftad kö har däremot ingen meningsfull restid att räkna ned.
    const moving = Number.isFinite(vessel.sog) && vessel.sog >= 2 && !arm.waitingAtBridge;
    const movingFallbackMs = moving
      ? Math.max(0, (dist / (vessel.sog * KNOTS_TO_MS)) * 1000 - this.config.WARNING_LEAD_MS)
      : STALE_ETA_SOFT_MS;
    // Reservvägen räknar på den senaste farten. Tystnar båten längre än
    // hennes vanliga kadens räknas sträckan efter den tidigare bron på rask
    // fart (värld 263); fram till bron gäller hennes fart, och spärren släpps
    // inte innan hon i den farten har nått bron, eftersom hon kan stanna där.
    // Kadensen bokförs vid varje fix, även utan tidigare bro.
    this._noteFixCadence(arm, now);
    const silentLimitMs = this._silentHoldLimitMs(arm, vessel, dist, anchor, now, moving);
    arm.earlierBridgeUntilMs = arm.earlierBridge
      ? anchor + Math.min(STALE_ETA_SOFT_MS, movingFallbackMs, silentLimitMs) : null;
    if (arm.earlierBridge) arm.fireDueMs = Math.max(arm.fireDueMs, arm.earlierBridgeUntilMs);
    // F09: visade fixet henne hållen vid en tidigare bro (spärren gäller
    // efter fixet)? Bokför fixets plats i bearbetningsordningen. Se
    // _fixAfterWarning och _releaseWarningsWhileHeld.
    if (this._holdInEffect(arm)) arm.heldSeenOrder = ++this._orderSeq;
    if (arm.originalDueMs === null) arm.originalDueMs = arm.fireDueMs;

    // En ny ren prognos kan lämna det fönster som den skickade varningen
    // byggde på. SISUs senare fix flyttade ankomsten från 10:10 till 09:58,
    // men den gamla prognosen absorberade ändå ELFKUNGEN och tystade hans
    // deadline. Pröva samma konvojfönster även mot detta nya underlag.
    // Bara NYA medlemmar begränsas: givna täckningar och fönstrets gamla
    // början består. En liten ETA-rörelse inom samma fönster är inget
    // sådant motbevis, och en faktisk passage har alltid företräde.
    const event = arm.eventId && this._eventsAt(arm.bridge).find((e) => e.id === arm.eventId);
    if (event && event.firedAt !== null && event.firstPassageAt === null
        && arm.warnedAt !== null && arm.absorbedAt === null
        && !vessel._gpsJumpDetected && !vessel._positionUncertain
        && hasFreshPosition(vessel, now) && arm.rawAnchorMs > event.firedAt
        && Number.isFinite(arm.expectedArrivalMs)
        && Number.isFinite(event.referenceArrivalMs)
        && event.referenceArrivalMs - arm.expectedArrivalMs > this.config.CONVOY_WINDOW_MS) {
      event.newMemberArrivalLimitMs = Math.min(
        event.newMemberArrivalLimitMs ?? Infinity,
        arm.expectedArrivalMs + this.config.CONVOY_WINDOW_MS,
      );
    }
  }

  // ===========================================================================
  // AVVÄPNING — endast MOTBEVIS
  // ===========================================================================

  /**
   * Finns motbevis mot armen? Tystnad, tappad målbro och borttagning räknas
   * ALDRIG som motbevis.
   * @private
   * @param {Object} arm
   * @param {Object} vessel
   * @param {number|null} currentDistance - avstånd till ARMENS bro i DETTA fix
   * @returns {string|null} skäl, eller null
   */
  _disarmEvidence(arm, vessel, currentDistance) {
    // (1) FULLBORDAD PASSAGE. passedAt-ankaret är appens exakta passagetid;
    //     bara passager som skett EFTER beväpningen räknas (en gammal post
    //     från en tidigare resa får inte avväpna en ny anflygning).
    //     BEN (2) nedan är geometriskt och fångar den BAKÅTDATERADE passagen:
    //     vid gap-flush ankras korsningen i det förflutna, ibland före
    //     armedAt, och tidsbenet blir då aldrig sant. Ligger bron bakom
    //     fartyget OCH har en registrerad passage är anflygningen slut.
    const passedAt = vessel.passedAt && vessel.passedAt[arm.bridge];
    if (Number.isFinite(passedAt) && passedAt > arm.armedAt) return 'passage';

    // (1b) U-SVÄNG — PRÖVAS FÖRE DET GEOMETRISKA BENET (C7, etapp 7 fas C,
    //      2026-08-09). Riktningsreversalen ägs av appens Fix D-debounce och
    //      korsningsbeviset (_routeDirection/_finalTargetDirection); vi läser
    //      bara resultatet — ingen egen U-svängsdetektering.
    //
    //      BENORDNINGEN ÄR INTE KOSMETIK. Båda benen läser SAMMA aktuella
    //      riktning, och när den har vänt pekar "bakom" åt andra hållet: en båt
    //      som armades norrut SÖDER om bron, vände och nu räknas som sydgående
    //      ligger per definition söder om bron ⇒ _bridgeIsBehind blir sann utan
    //      att hon någonsin korsat. Med det gamla benordningen returnerades
    //      'passage', och observeVessel bokförde då en FALSK målbropassage på
    //      hennes öppningshändelse (_recordPassage): händelsen blev låst för
    //      alltid — avfyrspärren i _evaluateBridge steg 4, värdvägran i steg 3
    //      och spent-städningen i steg 2 hänger alla på lastPassageAt.
    //
    //      OMORDNINGEN KAN INTE DÖLJA EN ÄKTA PASSAGE. Efter en verklig
    //      korsning ligger bron bakom fartyget i den OFÖRÄNDRADE riktningen,
    //      och då är U-svängsvillkoret (dir !== armDirection) falskt — benet
    //      nedan äger fallet precis som förut. Skulle riktningen dessutom ha
    //      vänt EFTER en verklig passage är bron per samma geometri inte längre
    //      "bakom" i den nya riktningen, så det gamla benet var ändå tyst där;
    //      den registrerade passagen fångas i så fall av tidsbenet ovan.
    //      Den enda gren som byter etikett är alltså exakt den felklassade.
    const dir = this._routeDirection(vessel);
    if (arm.armDirection && dir && dir !== arm.armDirection) return 'uturn';

    // (2) GEOMETRISKT BEN, utan krav på registrerad passage: appen ankrar
    // målbropassagen i en SENARE del av samma meddelande än öppningslagret
    // körs (och ibland via ett svep som aldrig når notePassage), så tidsbenet
    // ovan kan vara blint. Ligger bron bakom fartyget i hennes färdriktning
    // ÄR anflygningen över. En VÄNTANDE båt kan aldrig träffas: hon ligger per
    // definition på anflygningssidan (218023240 @ Stridsbergsbron 2026-07-14
    // 13:20 — 924 m på fel sida, arm kvar, varning 19 s efter passagen).
    if (this._bridgeIsBehind(vessel, arm.bridge)) return 'passage';

    // (2b) HYSTERESRELEASE. Låg tidigare i beväpningsloopen och prövades då
    //      BARA för broar i _bridgesToArm — en arm vars fartyg tappade sin
    //      målbro (targetBridge = null) uppdaterades aldrig mer och fyrade
    //      till slut på ett fryst avstånd, flera kilometer fel. Avståndet
    //      här är räknat ur DETTA fix mot ARMENS bro.
    if (Number.isFinite(currentDistance)
        && currentDistance > this.config.ARM_RELEASE_DISTANCE_M) {
      return 'out_of_range';
    }

    // (3) FÖRTÖJNINGSEVIDENS LÅNGT UT. Innanför DISARM_MOORED_MIN_DISTANCE_M
    //     är ett stopp normalfallet för en öppning (båten VÄNTAR) och får
    //     aldrig avväpna — dig10: 28 av 45 stopp ≥5 min som ÄNDÅ följdes av
    //     passage låg under 600 m, och bandet 600–800 m är tomt.
    //     C9 (etapp 7 fas C, 2026-08-09): TVÅ bevisvägar bakom SAMMA golv —
    //     appens `_moored`-klassning, och LÅNGVARIG OBSERVERAD STILLHET för de
    //     tre fjärdedelar av trafiken som aldrig sänder navstatus. Se
    //     _hasStillnessEvidence för härledningen av tiden.
    const distance = Number.isFinite(currentDistance) ? currentDistance : arm.distanceM;
    const beyondFloor = Number.isFinite(distance)
      && distance > this.config.DISARM_MOORED_MIN_DISTANCE_M;
    if (beyondFloor && vessel._moored === true) return 'moored';
    // STILLHETSBENET GÄLLER BARA OVARNADE ARMAR — mätt villkor, inte försiktig-
    // het. `warnedAt` är den enda plats där "den här öppningen är redan varnad"
    // lever, och den dör med armen. Utan villkoret blev C9 en DUBBLETTFABRIK:
    // en varnad båt som väntar länge (230167390 @ Klaffbron 2026-07-10, varnad
    // 11:03:17 på 1373 m, still 30 min, passage 11:49:37) fick sin arm släppt,
    // beväpnades om vid avgången och fyrade en ANDRA varning 11:35:04 för
    // SAMMA öppning — ett brott mot U2 ("strikt en varning per öppning,
    // avgränsad av första faktiska passagen"). Mätt över de 18 korpusarna:
    // +5 varningar utan villkoret, 0 med. Den arm som ännu INTE varnat bär
    // ingen sådan täckning och är exakt den som kan hinna fyra en fantom.
    if (beyondFloor && arm.warnedAt === null && this._hasStillnessEvidence(vessel)) return 'still';

    return null;
  }

  /**
   * STILLHET ÖVER TID som förtöjningsbevis (C9, etapp 7 fas C, 2026-08-09).
   *
   * VARFÖR: förtöjningsdetekteringens starkaste lager är navstatus 1/5 — men
   * 42h-fältprovet mätte att 22 av 29 fartyg (76 %) saknar navStatus i SAMTLIGA
   * sampel, och i de 15 aisstream-inspelade korpusarna saknas fältet hos 100 %
   * av fartygen. Detekteringen vilar alltså nästan helt på ett fält tre
   * fjärdedelar av trafiken inte skickar; utfallet syns direkt i avväpnings-
   * statistiken (fältet: 2 av 51 avväpningar via moored-benet mot 13 via ren
   * TTL — korpus #18 i replay: 2 moored, 14 stale). För en båt utan navstatus
   * och utanför en känd MOORING_ZONE är MOORING_DETECTION.MAX_STATIONARY_WAIT_MS
   * (2 h) den ENDA vägen till `_moored`, och 2 h är längre än hela armens
   * livslängd.
   *
   * VI BYGGER INGEN PARALLELL SANNING (filens doktrin, se huvudet): klockan
   * `_stationarySince` ägs av VesselDataService._updateMooringEvidence och är
   * exakt samma klocka som kajzonslagret och 2h-backstopen konsumerar. Den
   * matas av BÅDE finit-sog-vägen och den positionshärledda null-sog-vägen, så
   * fartgivarlösa båtar (den klass som fällt fyra tidigare granskningsrundor)
   * täcks utan särfall. Servicen LÄSER den — inget nytt vessel-fält, inget nytt
   * tillstånd i armen.
   *
   * TIDEN = ARM_STALE_TTL_MS (30 min), inget nytt tal. Härledningen är en
   * ordningsrelation, inte en kalibrering: armen får redan i dag leva högst
   * ARM_STALE_TTL_MS UTAN observation — dvs. på ren FRÅNVARO av evidens.
   * Observerad stillhet är strikt STARKARE motbevis än tystnad (vi ser att hon
   * inte närmar sig, i stället för att inte veta), så samma tid är per
   * konstruktion ett konservativt tak: stillhetsbenet kan aldrig släppa en arm
   * tidigare än tystnadsbenet redan gör. Marginalen mot dig10 är stor —
   * mätningens 45 "stopp ≥5 min som ändå följdes av passage" ligger en faktor 6
   * under gränsen, och 28 av dem dessutom innanför 600 m-golvet.
   *
   * GOLVET ÄGER (anropsplatserna): predikatet prövas ALDRIG innanför
   * DISARM_MOORED_MIN_DISTANCE_M. En båt som ligger still 200 m från bron
   * VÄNTAR på öppning; en som ligger still 800 m bort gör det inte. Det är
   * väntarskyddet och det rörs inte.
   *
   * ÅTERKOMSTEN ÄR INTE GRATIS — RÄTTAT 2026-08-23 (helkodsgranskning RUNDA 5).
   * Stycket löd tidigare: "klockan nollställs av ETT sampel ≥
   * MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN (0,5 kn), så en båt som lägger ut
   * beväpnas igen på sitt FÖRSTA rörelsefix ... Avväpningen kostar alltså ingen
   * förvarning så länge hon rapporterar en enda gång efter avgången." Det var
   * sant när C9 skrevs, blev falskt med C9b/M1 och blev MER falskt med N7.
   *
   * DEN SANNA REGELN (VesselDataService._updateMooringEvidence tillsammans med
   * _stillnessJitterHolds) — klockan `_stationarySince`:
   *  • sog ≥ 0,5 kn nollar den ENDAST om jitterhållet säger nej. Hållet säger
   *    JA (klockan BEHÅLLS) när stillhetsankaret är minst ARM_STALE_TTL_MS
   *    (30 min) gammalt, positionen inte är GPS-flaggad och nettot FRÅN ANKARET
   *    är under MOORING_DETECTION.MOVEMENT_PROOF_NET_M (50 m). Ankaret bär
   *    sedan M1 VISTELSENS ålder, inte klockans, så mognaden är verkligt
   *    uppnåelig även för en brusig fartgivare.
   *  • 0,3–0,49 kn nollar den först efter TVÅ konsekutiva prov — och sedan N7
   *    (RUNDA 5) prövas även det paret mot samma jitterhåll.
   *  • sog < 0,3 kn är stillhet och sog=null är okänt; ingetdera nollar något.
   *
   * KONSEKVENSEN ÄR MÄTBAR, INTE REDAKTIONELL. En båt som lägger ut LÅNGSAMT
   * från ett moget ankare rör sig ca 12 m/min vid 0,4 kn och ca 31 m/min vid
   * 1 kn, så de 50 metrarna tar ungefär 1,5–4 minuter. Under hela den tiden
   * svarar `_hasStillnessEvidence` fortfarande sant och AVVÄPNINGEN BESTÅR —
   * längre än det gamla stycket lovade. Först när nettot passerar 50 m (eller
   * båten flyttar sig tydligt på en GPS-ren position) faller hållet och klockan
   * nollas; DÅ, och först då, är ombeväpningen ett enda fix bort.
   *
   * ÖPPET, INGEN KODÄNDRING I RUNDA 5: ombeväpningen har inget EGET
   * rörelsevillkor — den ärver stillhetsklockans, och klockan är numera
   * avsiktligt trög. Trögheten är rätt för FÖRTÖJNINGSKLASSNING (den ska tåla
   * kajvobbel) men följer inte automatiskt att den är rätt för att åter armera
   * en deadline. Ett eget villkor på det här benet — t.ex. bevisad
   * nettoförflyttning från ankaret, eller ett par sammanhängande rörelsesampel
   * — skulle skilja de två frågorna åt. Kostnaden är OMÄTT: ingen
   * förvarningsförlust är observerad i korpusarna, men mätnoten nedan visar
   * också att hela benet har noll observerbar verkan där, så korpusarna kan
   * inte falsifiera risken. Mät i fält innan något ändras.
   * @private
   * @param {Object} vessel
   * @returns {boolean}
   */
  // ⚠️ MÄTT BEGRÄNSNING (dirigentens QC 2026-08-09) — LÄS FÖRE NÄSTA ÄNDRING.
  // Grinden har NOLL observerbar verkan i hela korpussamlingen (~320 h):
  // 'stale'-hinken är identisk med och utan C9 (105 avväpningar i båda), och
  // den enda 'still'-avväpningen (219031446 ANDREA @ Klaffbron, armad 2 996 s)
  // följs av OMBEVÄPNING 68 s senare ⇒ 0 notiser, 0 öppningsvarningar och
  // 0 brotexter skiljer. Två skäl, båda mätta:
  //  (1) Klassen förutsätter att fartyget FORTSÄTTER rapportera medan det
  //      ligger stilla. Fältet gör det (13 av 51 avväpningar gick via ren TTL
  //      i 42h-provet), men i korpusarna TYSTNAR motsvarande fartyg — då äger
  //      ARM_STALE_TTL_MS avväpningen innan stillhetsklockan hinner fram.
  //  (2) `_stationarySince` nollades av VesselDataService redan vid sog ≥ 0,5 kn
  //      NÄR NOTEN SKREVS, och KAJVOBBEL överskrider det: VIRGO (265552100)
  //      hade 4 av 19 kajsampel på 0,5 / 2,1 / 2,9 kn, så hennes klocka
  //      nollställdes fyra gånger och 30-minutersgrinden nåddes aldrig.
  //      ⚠️ HISTORISKT SEDAN 2026-08-10: precis den mekanismen ÄR vad C9b:s
  //      jitterhåll åtgärdade, och M1 (runda 4) + N7 (runda 5) gjorde hållet
  //      verksamt också för brusiga givare respektive för gråzonen 0,3–0,49 kn.
  //      VIRGO-fallet håller alltså inte längre klockan tillbaka. Noten står
  //      kvar som HÄRLEDNING till varför C9-benet mätte noll i korpusarna, inte
  //      som beskrivning av dagens beteende — den gällande regeln står i det
  //      rättade stycket ovan.
  // KONSEKVENS: C9 löser INTE kajvobbel-fantomklassen, och den låser därmed
  // inte upp C0 (Stallbacka-koordinaten) som planen antog. Den fixen behöver
  // ett eget lager som tål jitter över 0,5 kn — t.ex. rörelse mätt som
  // NETTOFÖRFLYTTNING över ett fönster i stället för momentan sog.
  // C9 behålls ändå: mekaniken är enhetstestad, den är kirurgisk, och fältets
  // 13 TTL-avväpningar visar att klassen finns i drift. Nästa fältdygn är dess
  // första riktiga prov.
  _hasStillnessEvidence(vessel) {
    const since = vessel ? vessel._stationarySince : null;
    if (!Number.isFinite(since)) return false;
    return this._now() - since >= this.config.ARM_STALE_TTL_MS;
  }

  /**
   * FRYST ARM: finns ett LÄST fix som armen inte kunde ta emot? (C7b/F-4,
   * etapp 7 fas C, 2026-08-09.)
   *
   * DEADLINE-MOTORNS LÖFTE GÄLLER TYSTNAD, INTE MOTSÄGELSE. Filhuvudets
   * mekanism (b): "Varningen avfyras SENAST vid tidigast_ankomst −
   * WARNING_LEAD_MS, även i total radiotystnad." Det löftet vilar på att det
   * SENASTE VI VET om båten är det ankaret. Tappar hon sin målbro returnerar
   * _bridgesToArm() [] och armens fysik fryser — men fixen fortsätter komma in
   * och passerar rakt igenom motbevis-svepet. Armen fyrar då på ett ankare som
   * NYARE observationer redan har motsagt.
   *
   * RÅDATABEVIS (korpus #18, ELFKUNGEN/265573130, fältrapportens F-4):
   *   11:34:26  d=2085 m  sog=2,9  cog=44,4   → beväpnad mot Klaffbron, dir=north
   *   11:35:33  d=2097 m  sog=2,0  cog=207,3  → vänder (avståndet växer)
   *   11:37:49  d=2191 m  sog=1,3  cog=240,7  → SISTA fix med målbro; armen fryser här
   *   11:38:56  d=2222 m  sog=0,9  cog=236,8  → appen släpper målbron (MOVING_AWAY)
   *   11:41:57  VARNING "Klaffbron öppnar snart, eta 25 min" på det frysta d=2191
   *   11:42:22  sog=0 — förtöjd 2 261 m från bron, låg kvar resten av korpusen
   * Facit (A2) har ingen Klaffbron-passage efter 10:38:34 ⇒ ren fantom.
   *
   * SUSPENSION, INTE AVVÄPNING. Armen lever vidare: släpper vi henne här hade
   * en båt som verkligen vänder om och kommer tillbaka behövt beväpnas från noll
   * (och 'tappad målbro' är per filens doktrin aldrig motbevis). Så snart appen
   * ger henne målbron igen kör _refreshArm, lastSeenAt går om lastObservedAt och
   * deadlinen lever direkt — med FÄRSK fysik, vilket är hela poängen.
   *
   * VARFÖR INTE BARA UPPDATERA DEN FRYSTA ARMEN: prövat och mätt. Med fixet
   * 11:38:56 (d=2222, sog=0,9) flyttas deadlinen till 11:43:08 och med varje
   * följande stilleståndsfix till ~4,3 min efter fixet — medan fixgapen är
   * 3,3–8,9 min. Fantomen hade fyrat ändå, ~9 min senare. Att uppdatera botar
   * alltså inte, den senarelägger.
   *
   * VARFÖR INTE "avståndet växer" (receding): EMPIRISKT FÄLLT. MISTRAL låg still
   * och väntade 1 092 m från Klaffbron med växande avstånd två fix i rad — av
   * 1,5 m GPS-vobbel — och regeln hade avväpnat en ÄKTA anflygning 15 min före
   * passagen. Samma predikat är dessutom exakt appens `MOVING_AWAY`
   * (VesselDataService: `distanceChange < 0 && currentDistance > 300`), dvs.
   * inget nytt bevis utan samma fällda test i annan dräkt.
   *
   * MÄTT OMFATTNING (18 korpusar, ~318 h): fyra armar har fått sin målbro
   * släppt medan de var beväpnade — FRAM/Stridsbergsbron (STOPPED), CARAT
   * /Klaffbron ×2 (MOVING_AWAY, återtog målbron och passerade) och ELFKUNGEN
   * ovan. De tre första hade REDAN varnat, och en varnad arm kan per
   * konstruktion inte fyra igen, så grinden rör dem inte. Verkan är alltså
   * exakt −1 varning, och den varningen är rådataverifierad fantom.
   *
   * ⚠️ KÄND RESTRISK, medvetet tagen: en båt som verkligen är på väg, får sin
   * målbro släppt (t.ex. via GPS-grindarna) och DÄREFTER tystnar, förlorar sin
   * deadline-varning. Den kombinationen förekommer inte i korpusarna, och de
   * observerade målbrosläppen sker alla efter att appen sett båten stanna eller
   * vända. Nästa fältdygn är grindens riktiga prov — se O2:s fantomhink.
   *
   * ⚠️ ANDRA RESTRISKEN (funnen i granskningen 2026-08-09, UPPMÄTT VERKAN NOLL):
   * suspensionen kan även frysa en KEDJEARM (ARM_NEXT_TARGET). När målbron
   * släpps helt markeras ALLA fartygets armar med `lastObservedAt`, men
   * `_hasUnappliedObservation` jämför PER ARM mot `lastSeenAt`. Återkommer
   * målbron medan ruttriktningen är okänd returnerar `_bridgesToArm` bara
   * närbron ⇒ kedjearmen får aldrig sitt `_refreshArm` och förblir suspenderad
   * tills `_pruneStaleArms` avväpnar den ARM_STALE_TTL_MS efter dess SISTA
   * refresh. Kombinationen förekommer inte i någon av de 18 korpusarna
   * (~319,5 h) — den står här för att nästa läsare ska känna igen symptomet
   * (en kedjearm som dör på 'stale' utan att ha uppdaterats) i fält.
   * @private
   */
  _hasUnappliedObservation(arm) {
    return arm.pendingArrivalObservation === true
      || (Number.isFinite(arm.lastObservedAt) && arm.lastObservedAt > arm.lastSeenAt);
  }

  /** @private */
  _disarm(arm, reason, now) {
    if (!this._arms.has(arm.key)) return;
    this._arms.delete(arm.key);
    this.logger.debug(
      `🔓 [OPENING_DISARM] ${arm.mmsi} (${arm.name || 'okänt namn'}): ${arm.bridge} avväpnad — ${reason} `
      + `(d=${Number.isFinite(arm.distanceM) ? Math.round(arm.distanceM) : '?'} m, `
      + `${arm.warnedAt ? 'varning redan skickad' : 'ingen varning skickades'}, `
      + `armad ${Math.round((now - arm.armedAt) / 1000)} s)`,
    );
  }

  /** @private */
  _pruneStaleArms(now) {
    const ttl = this.config.ARM_STALE_TTL_MS;
    for (const arm of [...this._arms.values()]) {
      if (now - arm.lastSeenAt > ttl) this._disarm(arm, 'stale', now);
    }
  }

  /** @private */
  _pruneOldestArm() {
    let oldest = null;
    for (const arm of this._arms.values()) {
      if (!oldest || arm.lastSeenAt < oldest.lastSeenAt) oldest = arm;
    }
    if (oldest) {
      this._arms.delete(oldest.key);
      this.logger.debug(`🔓 [OPENING_DISARM] ${oldest.mmsi}: ${oldest.bridge} släppt (MAX_ARMS-tak)`);
    }
  }

  // ===========================================================================
  // ÖPPNINGSHÄNDELSER
  // ===========================================================================

  /** Alla (levande) öppningshändelser vid en bro. @private */
  _eventsAt(bridgeName) {
    return this._events.get(bridgeName) || [];
  }

  /**
   * Utvärdera en målbro: släpp strandade armar, städa uttjänta händelser, knyt
   * lösa armar till RÄTT öppning, avfyra de som förfallit.
   * @private
   */
  _evaluateBridge(bridgeName, firedBy, now, observedMmsi = null) {
    const arms = [...this._arms.values()].filter((a) => a.bridge === bridgeName);
    let events = this._eventsAt(bridgeName);

    // --- (1) Släpp danglande händelse-id:n --------------------------------
    const liveIds = new Set(events.map((e) => e.id));
    for (const arm of arms) {
      if (arm.eventId !== null && !liveIds.has(arm.eventId)) arm.eventId = null;
    }

    // --- (1b) SLÄPP STRANDADE KONVOJARMAR ---------------------------------
    this._releaseStrandedArms(arms, events, now);

    // --- (1c) SLÄPP ARMAR UR EN HÄNDELSE SOM FÅTT SIN PASSAGE -------------
    this._releasePassedEventArms(arms, events, now);

    // --- (2) Städa händelser som gjort sitt -------------------------------
    const memberCount = (e) => arms.reduce((n, a) => (a.eventId === e.id ? n + 1 : n), 0);
    events = events.filter((e) => {
      const spent = e.firedAt !== null || e.lastPassageAt !== null;
      const closeAfter = Math.max(e.firedAt || 0, e.lastPassageAt || 0)
        + this.config.CONVOY_WINDOW_MS;
      const keep = memberCount(e) > 0 || (spent && now < closeAfter);
      if (!keep) {
        for (const arm of arms) if (arm.eventId === e.id) arm.eventId = null;
      }
      return keep;
    });
    // U15 (B02): returminnet lever så länge en levande händelse beskriver
    // öppningen båten passerade, inte så länge hennes egen händelse lever.
    this._prunePassageMemory(bridgeName, events, now);

    // --- (3) Knyt lösa armar till RÄTT öppning ----------------------------
    events = this._bindLooseArms(arms, events, bridgeName, now, observedMmsi);

    // --- (3b) U9: RÄDDNINGSVENTILEN --------------------------------------
    // Kör EFTER bindningen så att en arm som absorberas när hennes egen
    // deadline redan förfallit räddas i SAMMA utvärdering — täckningen får
    // aldrig kosta en enda tick av förvarning. Släpptes någon arm binds hon om
    // direkt (hon är lös nu) och kan avfyra i steg 4 nedan.
    if (this._rescueCoveredArms(arms, events, now)) {
      events = this._bindLooseArms(arms, events, bridgeName, now, observedMmsi);
    }

    this._storeEvents(bridgeName, events, now);

    // --- (4) Avfyrning -----------------------------------------------------
    // En händelse avfyrar EN gång, och ALDRIG efter att någon medlem passerat
    // (det vore en varning om en öppning som redan skett — WARN-invarianten).
    for (const event of events) {
      if (event.firedAt !== null || event.lastPassageAt !== null) continue;
      // FRYSTA ARMAR ÄR INTE MEDLEMMAR (C7b/F-4). De får varken avfyra på en
      // fysik appen redan motsagt, styra kortets LEDANDE båt (lead = närmast
      // bron — ett fryst avstånd kan mycket väl vara det minsta), räknas i
      // vessel_count eller ta emot täckning i warnedAt. De behåller sin plats i
      // händelsen (eventId) och återinträder automatiskt så snart ett fix åter
      // kan tillämpas. Se _hasUnappliedObservation.
      const members = arms.filter((a) => a.eventId === event.id
        && !this._hasUnappliedObservation(a) && !this._blockedByEarlierBridge(a, now));
      if (members.length === 0) continue;
      const unwarned = members.filter((a) => a.warnedAt === null);
      if (unwarned.length === 0) continue;
      const due = unwarned.filter((a) => Number.isFinite(a.fireDueMs) && a.fireDueMs <= now);
      if (due.length === 0) continue;
      // K20a-redo (fältprov 10): ledarvalet får inte avgöras mitt i ett halvt
      // tillämpat pollsvep. Se _leadIsUnsettled — grinden SKJUTER UPP, den
      // avfyrar aldrig bort något, och taket är ett tick.
      if (this._leadIsUnsettled(event, members, due, firedBy, now)) continue;
      this._fire(event, members, due, firedBy, now);
    }
  }

  /**
   * KNYT LÖSA ARMAR TILL RÄTT ÖPPNING (steg 3 i _evaluateBridge).
   *
   * PER ARM, INTE PER KLUMP. Tidigare knöts ALLA lösa armar villkorslöst in i
   * den enda händelsen så länge den ännu inte avfyrat, och dig9:s
   * konvojkriterium prövades bara mot en redan avfyrad händelse. Följden var
   * exakt produktprincipens värsta fall: en snabb båt 800 m ut (ankomst om
   * 4 min) drog med sig en långsam båt 2400 m ut (ankomst om 26 min) in i SIN
   * varning, satte warnedAt på henne — och den långsammas öppning blev ALDRIG
   * varnad. Nu prövas varje arm för sig, och en arm som inte hör till någon
   * befintlig öppning får en EGEN händelse.
   *
   * ENDAST OVARNADE armar knyts. En arm som redan fått sin varning och sedan
   * förlorat sin händelse blir FÖRÄLDRALÖS och lämnas utanför: knöts den in i
   * nästa händelse drog hon med sig sin egen passage dit, och passagen spärrade
   * då avfyrningen för en HELT ANNAN båts öppning (ELFKUNGEN @Klaffbron
   * 2026-07-08 10:20 blockerades av SOLANDE:s passage 10:06:42).
   *
   * METODEN ÄR IDEMPOTENT och anropas två gånger per utvärdering (före och
   * efter räddningsventilen): en arm som redan har eventId hoppas över, så det
   * andra varvet rör bara de armar ventilen just gjort lösa.
   * @private
   * @returns {Object[]} händelselistan (kan ha växt med nyseedade händelser)
   */
  _bindLooseArms(arms, events, bridgeName, now, observedMmsi = null) {
    for (const arm of arms) {
      if (arm.pendingArrivalObservation) continue;
      // U15 (B02): returresans gamla täckning spärras före varje värdval,
      // även konvojvärdens nedan. Se _releaseReturnCoverage.
      this._releaseReturnCoverage(arm, events);
      const blocked = this._blockedByEarlierBridge(arm, now);
      const convoyHost = blocked && events.find((event) => !arm.releasedFrom.has(event.id)
        && this._sharesMovingConvoy(arm, event, arms, now));
      const freshOtherQueue = arm.waitingAtBridge && arm.waitingAtBridge !== bridgeName
        && !this._hasUnappliedObservation(arm) && Number.isFinite(arm.rawAnchorMs)
        && arm.rawAnchorMs <= now && now - arm.rawAnchorMs <= STALE_ETA_SOFT_MS
        && arm.mmsi === observedMmsi;
      // Positionsbevisad täckning lever enligt det vanliga konvojfönstret.
      // En ny egen fix kan bevisa en separat kö. Ledarens senare avgång får
      // däremot inte återanvända följarens GAMLA väntfix som nytt motbevis:
      // deras samtidiga avgångar kan levereras i varsin del av AIS-batchen.
      const keepMovingConvoy = arm.eventId !== null
        && arm.movingConvoyEventId === arm.eventId
        && (!freshOtherQueue || this._sharesEarlierQueue(arm, arms, now));
      if (arm.absorbedAt !== null && blocked && convoyHost?.id !== arm.eventId && !keepMovingConvoy) {
        // Nytt positionsbevis skiljer båten från en tidigare konvoj. Hon
        // fick inget eget kort; hennes första varning ska fortfarande gå.
        if (arm.eventId) arm.releasedFrom.add(arm.eventId);
        arm.warnedAt = null;
        arm.absorbedAt = null;
        arm.coverUntilMs = null;
        arm.coveredBeyondWindow = false;
        arm.eventId = null;
      }
      if (arm.warnedAt === null && blocked) {
        // En varning som gick medan denna båt hölls vid en tidigare bro
        // täcker inte automatiskt hennes senare ankomst. F09: släppet avgörs
        // av hennes egna fix (se _releaseWarningsWhileHeld), inte av om en
        // halvminutstick råkade landa medan hon hölls.
        this._releaseWarningsWhileHeld(arm, events, convoyHost || null, now);
        arm.eventId = null;
        if (!convoyHost) continue;
      }
      if (arm.warnedAt === null && !blocked) this._releaseWarningsWhileHeld(arm, events, null, now);
      // En fryst medlem ingick inte i kortets payload. När hennes fix kan
      // användas igen får ett undertryckt/misslyckat event inte hålla henne
      // kvar som ovarnad medlem i en redan förbrukad händelse.
      if (arm.eventId !== null && arm.warnedAt === null
          && events.some((event) => event.id === arm.eventId && event.deliveryUnavailable)) {
        arm.releasedFrom.add(arm.eventId);
        arm.eventId = null;
      }
      if (arm.eventId !== null || arm.warnedAt !== null) continue;
      // Bara en AVFYRAD händelse kan ABSORBERA (dess varning är det som täcker
      // den nya båten). En händelse som fått en passage utan att någonsin
      // avfyra är förbrukad och får inte hålla nya armar som gisslan.
      // F09: medan spärren gäller täcker bara konvojvärden (positionsbelagd)
      // henne med en avfyrad varning. Övriga avfyrade händelser släpps eller
      // behålls först vid hennes nästa fix (_releaseWarningsWhileHeld); förut
      // släpptes de här vid varje spärrad utvärdering, så värdmängden i den
      // spärrade grenen är densamma som före rättningen.
      const host = convoyHost && this._belongsToEvent(arm, convoyHost)
        ? convoyHost
        : events.find((e) => !e.deliveryUnavailable && !arm.releasedFrom.has(e.id)
          && this._belongsToEvent(arm, e)
          && (blocked
            ? e.firedAt === null && e.lastPassageAt === null
            : e.firedAt !== null || e.lastPassageAt === null));
      // U9 (användarbeslut 2026-08-09) — C8:s BREDA TÄCKNING, återinförd.
      // U2 säger att en öppningshändelse lever tills FÖRSTA FAKTISKA PASSAGEN
      // och att alla väntande båtar tillhör den. Konvojfönstret (dig9) är en
      // PROGNOS-klustring och kan inte uttrycka det: en båt vars förväntade
      // ankomst ligger 12 minuter efter referensen fick en egen händelse och
      // därmed en andra varning för en bro som ännu inte hunnit öppna en enda
      // gång. Här knyts hon i stället till den avfyrade, o-passerade händelsen
      // — hon är TÄCKT. Priset (C8-mätningen: sex ovarnade öppningar) betalas
      // av räddningsventilen i _rescueCoveredArms, inte av en bredare gissning.
      //
      // GARANTIN GÅR FÖRE TÄCKNINGEN, OCH DEN PRÖVAS HÄR. En arm vars EGEN
      // deadline redan förfallit får aldrig bred täckning: ventilen hade
      // öppnat i samma utvärdering, så täckningen vore ren rundgång. Villkoret
      // är inte kosmetiskt — utan det absorberades en NYSS RÄDDAD arm av en
      // ANNAN avfyrad händelse på återbindningen (mätt: HEY JOE/211881090 @
      // Klaffbron 2026-07-14, räddad ur Klaffbron#18 och omedelbart absorberad
      // av Klaffbron#21, 132 loggrader senare räddad igen). Studsen är
      // ändlig (`releasedFrom` + `rescuedFrom` spärrar varje händelse en gång)
      // men den kan tappa varningen helt om ledtidsgolvet hinner stänga
      // ventilen på vägen. Med villkoret seedar hon i stället sin egen
      // händelse direkt och avfyrar i steg 4.
      //
      // 🛑 FLAGGAN ÄR AV I DRIFT (BRIDGE_OPENING.U9_RESCUE_COVERAGE = false).
      // Mätningen falsifierade premissen: den breda täckningen suger in BÅDA
      // medlemmarna i en äkta konvoj i en äldre avfyrad händelse, ingen av dem
      // seedar den gemensamma händelsen, och ventilen släpper dem sedan var för
      // sig vid sina individuella deadlines — fem konvojer splittrades, >1-
      // räknaren gick 80 → 81 och varningarna 364 → 369. Se härledningen vid
      // konstanten. Koden står kvar hel och enhetstestad (sviten kör den PÅ via
      // `config`), så ett användarbeslut kan aktivera den med en rad.
      const guaranteeIntact = Number.isFinite(arm.earliestArrivalMs)
        && now < arm.earliestArrivalMs - this.config.WARNING_LEAD_MS;
      const wideHost = (host || !guaranteeIntact || this.config.U9_RESCUE_COVERAGE !== true)
        ? null
        : events.find((e) => !e.deliveryUnavailable && !arm.releasedFrom.has(e.id)
          && e.firedAt !== null && e.lastPassageAt === null && (!blocked || e === convoyHost));
      // K-familjen: korsningsankarets ledtidsgolv (se _anchorFloorHost). K2/F09: inte
      // för en arm som hålls vid en tidigare bro (bara konvojvärden får absorbera).
      const floorHost = host || wideHost || blocked ? null : this._anchorFloorHost(arm, events, now);
      const bound = host || wideHost || floorHost;
      if (!bound) {
        const fresh = this._openEvent(bridgeName, now, arm);
        events.push(fresh);
        arm.eventId = fresh.id;
        arm.eligibleAt = now;
        continue;
      }
      arm.eventId = bound.id;
      arm.eligibleAt = now;
      if (bound.firedAt !== null) {
        // Absorberad av en redan avfyrad varning ⇒ räknas som varnad, så den
        // aldrig kan seeda en andra varning för samma öppning ("en sändande
        // båt i konvoj täcker sina radiotysta grannar"). Täckningen är dock
        // TIDSBEGRÄNSAD — se _releaseStrandedArms — och för U9:s breda
        // täckning dessutom villkorad av räddningsventilen.
        arm.warnedAt = bound.firedAt;
        arm.absorbedAt = now;
        arm.movingConvoyEventId = bound === convoyHost ? bound.id : null;
        arm.coveredBeyondWindow = wideHost !== null;
        // En ny absorption börjar utan hållskäl: hållet gällde en tidigare
        // täckning (schemaläggaren och loggdedupen läser fälten).
        arm.recoverHeldAt = null;
        arm.recoverHoldReason = null;
        // TÄCKNINGSSLUTET RÄKNAS FRÅN BOKFÖRINGEN, som före K-rättningen
        // (revision 3, U13): efter första passagen är referensen när passagen
        // blev KÄND, före den prognosen. Det är när en TYST båt får sin
        // säkerhetsvarning (U17), och banken kan inte visa när den borde komma.
        // Medlemskapet (_belongsToEvent) och bakkanten mäts mot korsningen.
        arm.anchorFloorEventId = floorHost ? floorHost.id : null;
        const coverRef = Number.isFinite(bound.firstPassageRegisteredAt)
          ? bound.firstPassageRegisteredAt : bound.referenceArrivalMs;
        arm.coverUntilMs = Math.max(
          bound.firedAt,
          Number.isFinite(coverRef) ? coverRef : 0,
        ) + this.config.CONVOY_WINDOW_MS;
        this.logger.debug(
          `🌉 [BRIDGE_OPENING] ${arm.mmsi} (${arm.name || 'okänt namn'}): absorberad av öppning `
          + `${bound.id} vid ${bridgeName} (${arm.coveredBeyondWindow ? 'U9-täckt bortom konvojfönstret' : 'konvoj'}`
          + `, täckt t.o.m. ${new Date(arm.coverUntilMs).toISOString()})`,
        );
        this._emitCoverage(arm, bound, 'absorbed', now);
      }
    }
    return events;
  }

  /**
   * KORSNINGSANKARETS LEDTIDSGOLV (K-familjen, granskningen 2026-11-04).
   *
   * Korsningsankaret (F01, _recordPassage) flyttar en händelses referens-
   * ankomst från bokföringen till den interpolerade korsningen. En båt som
   * anländer mer än CONVOY_WINDOW_MS efter KORSNINGEN hör därmed inte längre
   * till öppningen, och hon får en egen händelse och en egen varning (U2).
   * Det är hela poängen när varningen kan göra nytta (ULLA i värld 1900 fick
   * ~5 min). Men upptäcks hon först vid bron hade den egna varningen kommit
   * med under två tick kvar till ankomsten — och i praktiken efter
   * korsningen. Buggjägarens värld 227: ZELDA beväpnades för returen 13 m
   * före Stridsbergsbron, 10 s EFTER sin verkliga korsning; utan golvet gav
   * ankaret ett nytt T3-utslag (varning efter sann passage) där 7699cbe inte
   * varnade alls.
   *
   * GOLVET. När en egen händelse BARA beror på ankaret — armen hade hört till
   * en avfyrad händelse mätt mot händelsens BOKFÖRING (firstPassageRegisteredAt,
   * referensen före K-rättningen) men inte mot korsningen — och hennes
   * förväntade ankomst ligger närmare än 2 × TICK_INTERVAL_MS, står täckningen
   * kvar som före rättningen: hon absorberas (täckningen räknas som alltid
   * från bokföringen), och bakkanten mäter henne mot täckningsslutet i stället
   * för mot U2-fönstret kring korsningen (anchorFloorEventId). Samma golv och
   * samma utfall som räddningsventilen
   * (_rescueCoveredArms: "stängs ventilen av golvet står den ursprungliga
   * täckningen kvar"). Skälet är också detsamma:
   * O1 räknar ledtiden mot den SENASTE täckande varningen, så en varning
   * under golvet hade ersatt en fullgod konvojtäckning med en värdelös
   * ledtid (LEDTIDSGOLV-brott, runOpeningGates.js).
   *
   * BARA PÅ ETT FÄRSKT FIX: armen ska ha tillämpat ett rent fix i just den här
   * utvärderingen (lastSeenAt === now, lastFixClean, inte fryst). För en tyst
   * arm säger prognosen inget om när hon kommer, och ett golv där hade varit
   * KRAV (3):s ledtidsgolv, som är mätt och avvisat (U13) och som U17 inte
   * godtar (säkerhetsvarningen för en tyst båt behålls). Gäller inte heller en
   * händelse vars gamla täckning redan har löpt ut (då hade hon släppts direkt).
   * @private
   * @param {Object} arm - lös, ovarnad arm utan värd
   * @param {Object[]} events - brons händelser
   * @param {number} now
   * @returns {Object|null} händelsen som täcker henne enligt bokföringen, eller null
   */
  _anchorFloorHost(arm, events, now) {
    if (arm.lastSeenAt !== now || !arm.lastFixClean || this._hasUnappliedObservation(arm)) return null;
    if (!Number.isFinite(arm.expectedArrivalMs)) return null;
    const remainingMs = arm.expectedArrivalMs - now;
    if (remainingMs >= 2 * this.config.TICK_INTERVAL_MS) return null;
    const W = this.config.CONVOY_WINDOW_MS;
    const host = events.find((e) => !e.deliveryUnavailable && !arm.releasedFrom.has(e.id)
      && e.firedAt !== null && Number.isFinite(e.firstPassageRegisteredAt)
      && Number.isFinite(e.firstPassageAt) && e.firstPassageAt < e.firstPassageRegisteredAt
      && now <= Math.max(e.firedAt, e.firstPassageRegisteredAt) + W
      && Math.abs(arm.expectedArrivalMs - e.firstPassageRegisteredAt) <= W);
    if (!host) return null;
    this.logger.debug(
      `⛔ [OPENING_ANCHOR_FLOOR] ${arm.mmsi} (${arm.name || 'okänt namn'}): ${arm.bridge} — en egen `
      + `händelse berodde bara på korsningsankaret (${host.id}: korsning `
      + `${new Date(host.firstPassageAt).toISOString()}, bokförd `
      + `${new Date(host.firstPassageRegisteredAt).toISOString()}) och hade gett `
      + `${Math.round(remainingMs / 1000)} s till förväntad ankomst (golv `
      + `${Math.round((2 * this.config.TICK_INTERVAL_MS) / 1000)} s); täckningen räknad från bokföringen `
      + 'står kvar',
    );
    return host;
  }

  /**
   * U9 — RÄDDNINGSVENTILEN (användarbeslut 2026-08-09: "garantin står, U2
   * mjukas").
   *
   * PROBLEMET SOM FÄLLDE C8. U2:s täckningsmekanism och deadline-garantin är
   * ömsesidigt oförenliga så länge täckningen är ovillkorlig: garantin räknas
   * PER ARM (`earliestArrival − WARNING_LEAD_MS`, avfyrningsfönster ≤ ett par
   * tick) och förfaller MEDAN båten är täckt. C8 mättes fullt ut och kostade
   * sex ovarnade öppningar (26 → 32) samt O1-täckning 332/333 → 329/333 —
   * pelare 3:s hela syfte är att varna FÖRE öppningar, så den bytesaffären
   * återkallades.
   *
   * VENTILEN. Täckningen består, men den är inte längre ovillkorlig. Förfaller
   * en täckt båts EGEN deadline medan händelsen fortfarande är O-PASSERAD, och
   * ligger hennes ankomst EFTER den avfyrade varningens prognosfönster, så är
   * hon bevisligen inte den öppning som varnades — och hon får sin egen
   * varning. Tre villkor, var för sig nödvändiga:
   *
   *  (1) BARA U9-TÄCKTA ARMAR (`coveredBeyondWindow`). En arm som ryms i
   *      konvojfönstret ÄR den varnade öppningen; att varna om henne vore en
   *      andrapåminnelse, precis det U2 förbjuder. Den tidsbegränsade
   *      täckningen för sådana armar ägs av _releaseStrandedArms och rörs inte.
   *  (2) HÄNDELSEN MÅSTE VARA O-PASSERAD. Har öppningen redan skett är det inte
   *      längre samma öppning, och _releaseStrandedArms/_releasePassedEventArms
   *      äger det förloppet. Ventilen ska inte konkurrera med dem.
   *  (3) ANKOMSTEN LÅG EFTER PROGNOSFÖNSTRET NÄR TÄCKNINGEN GAVS. Det ÄR
   *      `coveredBeyondWindow`: flaggan sätts i _bindLooseArms exakt när
   *      _belongsToEvent sa nej, dvs. när hennes förväntade ankomst låg utanför
   *      max(varningens tid, referensankomsten) + CONVOY_WINDOW_MS.
   *
   *      ⚠️ VILLKORET PRÖVAS VID BINDNINGEN, ALDRIG LIVE — och det är MÄTT, inte
   *      valt. Första varianten prövade om `expectedArrivalMs > coverUntilMs`
   *      vid varje tick. `coverUntilMs` är fryst vid absorptionen medan
   *      ankomstprognosen vandrar med varje nytt fix, så en båt som närmade sig
   *      gled IN i ett fönster hon aldrig tillhört — och ventilen stängdes tyst
   *      för exakt de fartyg den finns för. Utfall i korpus 20260713-41h:
   *      Stridsbergsbron#7 avfyrade med LAMANTIJN som ledare (eta 78 min!) och
   *      absorberade sedan JOY (265051050), SEEBAER III (211327190) och
   *      IL PUNTO (211171100). Bara IL PUNTO, vars prognos stannade bortom
   *      09:22:13, räddades; JOY och SEEBAER III passerade ovarnade — 40 min
   *      efter att LAMANTIJN öppnat bron och den stängt igen. O1 föll 332/333 →
   *      330/333. Med bindningstidsvillkoret räddas alla tre.
   *
   * TIDEN: INGA NYA KONSTANTER. Deadlinen är garantins egen
   * (`earliestArrivalMs − WARNING_LEAD_MS`), inte armens `fireDueMs`.
   * fireDueMs är min(deadline, förväntad ankomst − FIRE_EXPECTED_ETA_MS) och
   * är alltså ≤ deadlinen; att använda den hade fått ventilen att öppna innan
   * GARANTIN var i fara, vilket är fler kort utan att rädda en enda öppning.
   *
   * GOLVET 60 s = 2 × TICK_INTERVAL_MS, samma tal som öppningsgrindens
   * `leadHardFloorMs` (runOpeningGates.js): under två tick är en varning
   * funktionellt värdelös — det är den grövsta upplösning en tick-driven motor
   * kan lova. Golvet mäts mot den FÖRVÄNTADE ankomsten, inte mot den
   * pessimistiska: `earliestArrivalMs` är ett 10-knopsgolv som för en tyst båt
   * ligger minuter i det förflutna utan att hon kommit fram, och ett golv där
   * hade stängt ventilen just för de långsamma och tysta som garantin finns
   * för. `expectedArrivalMs` är däremot samma storhet O1 mäter ledtiden mot och
   * samma som kortets eta_minutes visar. Att den ÖVRE kanten finns alls är
   * mätbar nödvändighet: O1 räknar ledtiden mot den SENASTE täckande varningen,
   * så en räddning som landar under golvet hade ERSATT en fullgod
   * konvojtäckning med en värdelös ledtid och skapat ett LEDTIDSGOLV-brott där
   * baslinjen inte har något. Stängs ventilen av golvet står den ursprungliga
   * täckningen kvar — samma utfall som C8 — och tillfället loggas så att
   * klassen är räknebar i fält.
   * MÄTT UTFALL (18 korpusar, ~319,5 h, P7 2026-08-10) — ventilen GÖR sitt
   * jobb: O1-täckningen står kvar på 332/333 och 0-räknaren går 26 → 25, dvs.
   * C8:s sex förlorade öppningar uppstår aldrig. Men den breda täckningen den
   * skyddar visade sig kosta mer än den ger (>1-räknaren 80 → 81, varningar
   * 364 → 369, fem splittrade konvojer), och därför står hela mekaniken
   * avstängd bakom BRIDGE_OPENING.U9_RESCUE_COVERAGE. Ventilen är alltså
   * korrekt och verifierad — det är premissen den skyddar som föll.
   * @private
   * @returns {boolean} true om minst en arm släpptes (⇒ bind om)
   */
  _rescueCoveredArms(arms, events, now) {
    let released = false;
    for (const arm of arms) {
      if (arm.coveredBeyondWindow !== true || arm.absorbedAt === null) continue;
      if (arm.eventId === null) continue;
      const host = events.find((e) => e.id === arm.eventId);
      if (!host || host.firedAt === null || host.lastPassageAt !== null) continue;
      if (arm.rescuedFrom.has(host.id)) continue;
      if (!Number.isFinite(arm.earliestArrivalMs) || !Number.isFinite(arm.expectedArrivalMs)) continue;
      const dueMs = arm.earliestArrivalMs - this.config.WARNING_LEAD_MS;
      if (now < dueMs) continue;
      const remainingMs = arm.expectedArrivalMs - now;
      if (remainingMs < 2 * this.config.TICK_INTERVAL_MS) {
        this.logger.debug(
          `⛔ [OPENING_RESCUE] ${arm.mmsi} (${arm.name || 'okänt namn'}): ${arm.bridge} — `
          + `räddningen STÄNGD av ledtidsgolvet (${Math.round(remainingMs / 1000)} s kvar till `
          + `förväntad ankomst, golv ${Math.round((2 * this.config.TICK_INTERVAL_MS) / 1000)} s); `
          + `täckningen från ${host.id} står kvar`,
        );
        continue;
      }
      this.logger.debug(
        `🛟 [OPENING_RESCUE] ${arm.mmsi} (${arm.name || 'okänt namn'}): ${arm.bridge} — egen deadline `
        + `förföll ${Math.round((now - dueMs) / 1000)} s sedan medan ${host.id} ännu är o-passerad, `
        + 'och ankomsten låg utanför varningens prognosfönster '
        + `(${Number.isFinite(arm.coverUntilMs) ? new Date(arm.coverUntilMs).toISOString() : 'okänt'}) `
        + 'när täckningen gavs — släpps som EGEN öppning '
        + `(d=${Number.isFinite(arm.distanceM) ? Math.round(arm.distanceM) : '?'} m, `
        + `förväntad ankomst ${new Date(arm.expectedArrivalMs).toISOString()})`,
      );
      arm.rescuedFrom.add(host.id);
      arm.releasedFrom.add(host.id);
      arm.warnedAt = null;
      arm.absorbedAt = null;
      arm.coverUntilMs = null;
      arm.coveredBeyondWindow = false;
      arm.eventId = null;
      released = true;
    }
    return released;
  }

  /**
   * Skriv tillbaka händelselistan, med tak mot patologisk tillväxt.
   * @private
   */
  _storeEvents(bridgeName, events, now) {
    let list = events;
    if (list.length > this.config.MAX_EVENTS_PER_BRIDGE) {
      // Fable-granskningen 2026-08-10 (FG-D6): kommentaren lovade tidigare
      // "släpp de äldsta FÖRBRUKADE först; händelser med väntande armar sist"
      // — det gör koden inte. Sorteringen ser ENBART på openedAt: de nyaste
      // behålls oavsett armstatus, så en gammal händelse med väntande armar kan
      // släppas. Det är ofarligt men fungerar så här: armar vars eventId pekar
      // på en släppt händelse nollställs i _evaluateBridge steg (1)
      // (danglande id) och seedas om som lösa armar i steg (3) vid nästa
      // utvärdering.
      list = [...list].sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, this.config.MAX_EVENTS_PER_BRIDGE);
      this.logger.debug(
        `🌉 [BRIDGE_OPENING] ${bridgeName}: händelsetaket nått vid ${now} — äldsta släppta`,
      );
    }
    if (list.length === 0) this._events.delete(bridgeName);
    else this._events.set(bridgeName, list);
  }

  /**
   * KONVOJTÄCKNINGEN ÄR TIDSBEGRÄNSAD, INTE EVIG.
   *
   * En absorberad arm fick warnedAt satt permanent, och medlemskapet prövades
   * EN gång — på en PROGNOS. Visade sig prognosen fel kunde armen aldrig mer
   * seeda en egen varning: mätt över korpusarna passerade absorberade båtar
   * upp till 67 minuter efter "sin" varning, långt efter att den öppningen
   * stängt (211690580 @ Klaffbron 2026-07-10: varning 10:42:47, passage
   * 11:44:04, med två andra båtars passager emellan). Det är precis den
   * missade öppning hela lagret finns för att förhindra.
   *
   * Täckningen gäller därför bara den öppning armen knöts till: när
   * referensankomsten + CONVOY_WINDOW_MS (dig9:s egen definition av "samma
   * öppning") passerat och armen FORTFARANDE är beväpnad, prövas hon som lös
   * och kan få en egen händelse — och därmed en egen varning för sin egen
   * öppning.
   *
   * K-FAMILJEN (rättningskampanjen 2026-11-04, kort F02, F03, F11, F14, F17,
   * F20, F22, F23 och F01:s r2). Släppet skedde förut på REN TID: armen släpptes
   * i samma utvärdering som täckningen löpte ut, bands om och avfyrade på sin
   * ärvda, sedan länge förfallna deadline. Två fel följde, båda mätta i
   * buggjägarens världar:
   *  (a) BAKKANTEN (F02, F17, F22, F01:s r2). Medlemskapet omprövades bara vid
   *      täckningsslutet. En båt vars FÄRSKA prognos efter händelsens första
   *      passage redan låg bortom täckningen var nästa öppning (U2), men fick
   *      sin varning först vid täckningsslutet — 6–54 s före korsningen, eller
   *      efter den. Nu släpps hon på det fix där prognosen visar det, och hennes
   *      deadline räknas ur samma färska fix (KRAV 4).
   *  (b) TYSTNADEN SOM PASSAGE (F03, F14, F20). Släppet utgick från att "kvar
   *      beväpnad" betyder "inte passerad". För en båt som senast sågs under
   *      bron eller på väg bort är det fel. Grindarna nedan (KRAV 1 och 3)
   *      håller kvar täckningen i de fallen tills nästa fix avgör.
   *
   * VAD SOM MEDVETET INTE ÄR GRINDAR (mätt, se _coverageVerdict): färskhets-
   * kravet mot firstPassageAt, en åldersgräns på fixet och ledtidsgolvet 60 s
   * tog i korpusbanken bort RECOVER-varningar som öppningsgrinden O1 räknar
   * som täckning för passager i AIS-glapp, där rådatan inte kan ordna varning
   * och korsning. U13 kräver då att vi antar regression. Klassen "tyst båt vars
   * prognos låg inom täckningen" (F11, F23) står därför kvar, och ägaren har
   * beslutat att den ska stå kvar (U17, 2026-11-04: säkerhetsvarningen behålls,
   * ingen öppning får missas) — se docs/ARCHITECTURE.md §H29/H30.
   *
   * Gäller ENDAST absorberade armar. En arm som var medlem när varningen gick
   * ut räknades i vessel_count och ÄR varnad; att varna om henne hade varit
   * en dubblett, inte en räddad öppning.
   * @private
   * @param {Object[]} arms - brons armar
   * @param {Object[]} events - brons levande händelser
   * @param {number} now
   */
  _releaseStrandedArms(arms, events, now) {
    for (const arm of arms) {
      if (arm.absorbedAt === null || !Number.isFinite(arm.coverUntilMs)) continue;
      const event = events.find((e) => e.id === arm.eventId) || null;
      const verdict = this._coverageVerdict(arm, event, now);
      if (verdict.kind === 'covered') continue;
      if (verdict.kind === 'passage') {
        // KRAV (1): bron ligger bakom senaste läget — anflygningen är slut.
        // Samma utfall som observeVessel:s geometriska ben: bokför och avväpna.
        // Korsningen skedde före det fixet; dess tid är en övre gräns.
        this._recordPassage(arm.bridge, arm, now, this._crossingUpperBound(arm, now));
        this._disarm(arm, 'passage', now);
        continue;
      }
      if (verdict.kind === 'hold') {
        if (arm.recoverHoldReason !== verdict.reason) {
          this.logger.debug(
            `⏸️ [OPENING_RECOVER_HOLD] ${arm.mmsi} (${arm.name || 'okänt namn'}): ${arm.bridge} `
            + `(${arm.eventId}) täckt t.o.m. ${new Date(arm.coverUntilMs).toISOString()} — `
            + `släpps inte: ${verdict.reason}; nästa fix avgör`,
          );
        }
        arm.recoverHoldReason = verdict.reason;
        arm.recoverHeldAt = now;
        continue;
      }
      this._releaseCoveredArm(arm, verdict.kind, now, verdict.reason);
    }
  }

  /**
   * SLÄPPVÄGENS DOM för en absorberad arm (K-familjen, 2026-11-04).
   *
   * Utfall: 'covered' (täckningen gäller), 'bakkant' (släpp nu — färsk prognos
   * bortom täckningen), 'täckningsslut' (släpp — täckningen har löpt ut),
   * 'hold' (täckningen har löpt ut men ett läge talar emot släpp; nästa fix
   * avgör) eller 'passage' (bron ligger bakom senaste läget).
   *
   * BAKKANTEN, före täckningsslut. Släpp när ALLA gäller:
   *  - händelsen har fått sin första passage (öppningen har skett, och
   *    täckningen är ankrad i den — K14), och armen har tillämpat ett fix
   *    EFTER den skattade KORSNINGEN (firstPassageAt, KRAV (2)). Före första
   *    passagen är fönstret en prognos om ledaren, och en väntande ledare gör
   *    att följaren fortfarande hör till samma öppning (U2);
   *    FÄRSKHETEN MOT KORSNINGEN, INTE MOT BOKFÖRINGEN (varv 2, familj B,
   *    M4). Ett fix efter korsningen visar henne före bron när öppningen redan
   *    skett, och det är vad KRAV (2) frågar efter. Bokförs ledarens passage
   *    sent (hon var tyst över bron) och tystnar följaren mellan korsningen
   *    och bokföringen, fick bakkanten förut aldrig döma: följaren släpptes
   *    först vid täckningsslutet, efter sin egen korsning (buggjägarens
   *    världar 1094 och 1476). Saknas skattningen är firstPassageAt
   *    bokföringstiden (_recordPassage), och villkoret är detsamma som förut.
   *    KOSTNAD (granskningens prob B1): en följare vars prognos ur fixet
   *    mellan korsningen och bokföringen ligger strax efter fönstret, men som
   *    sedan korsar inom det, släpps och varnas en andra gång. Det följer av
   *    KRAV (2) och bakkantens envägsdom; var hon i stället tyst ända till
   *    täckningsslutet, varnades hon förut efter sin passage (prob B2).
   *    Släppet vid TÄCKNINGSSLUTET rörs inte: där är färskhet mätt och avvisad
   *    (U17, se nedan). Före första passagen dömer i stället
   *    _ownDeadlineVerdict (U24, M7, C-IV väg b): hennes egen deadline;
   *  - fixet var GPS-rent och färskt, och armen är inte fryst (C7b);
   *  - armens förväntade ankomst ur det fixet ligger EFTER fönstrets slut:
   *    det som kommer först av täckningsslutet coverUntilMs och U2-fönstret
   *    kring den verkliga passagen, max(firedAt, firstPassageAt) +
   *    CONVOY_WINDOW_MS. Samma medlemsfråga som _belongsToEvent ställde vid
   *    bindningen, nu mot den öppning som faktiskt skedde. Täckningsslutet
   *    räknas från bokföringen (revision 3) och ligger därför oftast efter
   *    U2-fönstret; att också ta täckningsslutet med gör att en båt vars
   *    prognos ligger mellan ett tidigare täckningsslut (K14 förlänger aldrig)
   *    och U2-fönstrets slut släpps på sitt fix i stället för vid
   *    täckningsslutet med en förfallen deadline. En golvhållen arm
   *    (anchorFloorEventId) mäts bara mot täckningsslutet;
   *  - kursen leder inte bort från bron (se _courseAway).
   * MÄTT OCH AVVISAT: att jämföra ENBART mot U2-fönstret när ledaren passerat
   * senare än sin prognos. Båtarna mellan täckningsslutet och fönstrets slut
   * hölls då kvar till täckningsslutet och varnades efter sin korsning
   * (buggjägarens klustervärldar 56, 119, 685 och 1643; standardprofilen 6
   * fler kandidatutslag). PRISET för att jämföra mot täckningsslutet:
   * snabbvärld 295 (R0), där HAVSORN släpps på 0,8 s marginal 96 m från bron
   * och varnas 28 s före sin korsning, fast korsningen ligger inom
   * U2-fönstret efter DAGNY — en andrapåminnelse som bryter mot U2. Motorn
   * registrerar den som KÄND_ÖPPEN U2-VS-DEADLINE. Grinden "släpp bara när den
   * färska deadlinen ligger framåt" tog bort värld 295 men gav 5 nya utslag
   * (omgranskningens variant B1, världarna 56, 119, 122 och 251).
   * Prognosen är den som kortets eta_minutes, O1 och konvojfönstret redan
   * använder (expectedArrivalMs). Undantaget är krypfarten under ETA-kedjans
   * passagegolv: där gäller den senare av prognosen och armens fysik (varv 2,
   * M5, se _crawlArrivalMs). Domen bär det som jämfördes (arrivalMs,
   * physicsArrivalMs och windowEndMs), så att harnessen kan bokföra det. Mätt i korpusbanken
   * (485 h): bakkanten flyttar en varning. PRINCESS LIZYMAR (20260713-41h,
   * 219029305) släpps på fixet 08:33:22 vars färska prognos 08:39:52,4 låg
   * 1,5 s efter U2-fönstrets slut 08:39:50,9 (NORDIC SOLAs korsning
   * 08:29:50,9 + 600 s) och varnas 08:34:13,9 med 6 min ledtid. Utan bakkanten
   * hade hon varnats vid täckningsslutet 08:40:41,2 (bokföringen + 600 s, eta 0),
   * som på 7699cbe. Rådatans korsning är 08:42:13 (fönstret 08:36:22–08:47:21).
   * Bakkanten stänger F22, F02, F17 och F01:s r2.
   *
   * TÄCKNINGSSLUT. Släpp, utom när:
   *  (1)  bron ligger BAKOM armens senaste läge ⇒ 'passage' (KRAV 1: avväpna,
   *       släpp inte). Nås när riktningen saknades i det fix som lade henne
   *       bortom bron (observeVessel:s geometriska ben är då tyst), medan armen
   *       behållit sin riktning från beväpningen. Korsningen bokförs på fixets
   *       tid, inte på nu (se _crossingUpperBound);
   *  (1b) armen är fryst (_hasUnappliedObservation): ett nyare fix har lästs
   *       men inte kunnat tillämpas, och fysiken vore redan motsagd (C7b).
   *       Ingen varning skiljer sig — en fryst arm är ingen medlem och kan
   *       inte avfyra — men utan hållet släpptes hon och seedade en egen
   *       händelse på ett motsagt läge, som andra lösa armar sedan kunde
   *       bindas till. Hållet varar till första tillämpade fix;
   *  (3)  ankomstfysiken saknas (expectedArrivalMs eller earliestArrivalMs
   *       inte finit; KRAV 3:s första led). MEDVETNA HÄNGSLEN: _canArm kräver
   *       ett finit avstånd och _refreshArm skriver alltid båda tiderna, så
   *       ingen arm i drift når hit; grenen prövas direkt i enhetstestet;
   *  (1c) båten låg UNDER BRON vid senaste fixet — inom UNDER_BRIDGE_SET_DISTANCE
   *       på anflygningssidan, i rörelse (≥ MINIMUM_VIABLE_SPEED) — och hennes
   *       förväntade ankomst låg inom täckningen. Då har hon med all sannolikhet
   *       passerat med öppningen; en ny varning vore en varning efter passagen
   *       (F20: 25 m före linjen i 7 kn, tyst 273 s, varnad 268 s efter
   *       korsningen). Väntande båtar ligger på köplatserna 56–307 m före bron
   *       (BUGGJAKT §4.4) och rörs inte. Avståndet är appens egen gräns för
   *       statusen under bron;
   *  (1d) kursen leder bort från bron (_courseAway; F14: cog 32,8° för en
   *       sydgående båt 705 m norr om Klaffbron efter en obekräftad U-sväng).
   * Ett håll skjuter upp släppet till nästa fix, och visar det en anflygning
   * släpps hon på det fixet. En båt som tystnar för gott i ett hållet läge
   * får däremot ingen räddningsvarning (avsikten med KRAV 1). Mätt i
   * korpusbanken: grindarna (1)–(1d) håller ingen RECOVER som släpptes förut —
   * noll ändrade varningar.
   *
   * U17 (ägarbeslut 2026-11-04): säkerhetsvarningen för en TYST båt vars
   * senaste position sa att hon skulle hinna igenom den gemensamma öppningen
   * BEHÅLLS (F11/F23-klassen, ett falsklarm av samma slag som
   * AVBRUTEN_APPROACH). Grindarna ovan gäller lägen som säger mer än en
   * prognos: bron bakom henne, appens egen under-bron-gräns eller en kurs
   * bort. MÄTT OCH AVVISAT (ARCHITECTURE.md KRAV (2) och golvet i KRAV (3)):
   * färskhet mot firstPassageAt, en åldersgräns på fixet (STALE_ETA_HARD_MS)
   * och ledtidsgolvet 2 × TICK_INTERVAL_MS tog i banken bort 5–16 RECOVER-
   * varningar, och O1 (appserien) fick 3–4 OKLASSADE missar: passager som
   * appen bokförde efter ett AIS-glapp och där rådatafacit bara ger ett
   * inferrerat korsningsfönster (TIDPUNKT_OKÄND).
   *
   * DOMENS FÄLT (varv 2, familj B; buggjägarens harness bokför dem). Alltid
   * `kind`; `reason` vid 'bakkant' och 'hold'. När bakkanten hann jämföra en
   * ankomst med fönstrets slut bär domen dessutom `arrivalMs` (det som
   * jämfördes, se _crawlArrivalMs), `physicsArrivalMs` (armens fysik, eller
   * null) och `windowEndMs`. De tre saknas när domen avgjordes tidigare (inget
   * färskt eller rent fix efter passagen, eller täckningen har löpt ut). Efter
   * passagen bär en dom 'covered' `gate: 'bakom'` (och inga av de tre) när bron
   * ligger bakom hennes senaste läge. Före första passagen (U24,
   * _ownDeadlineVerdict) bär domen de tre NÄR UNDERLAGET FINNS (en avfyrad
   * händelse med referensankomst; annars en bar 'covered') och dessutom
   * `ownDeadlineMs` (garantins deadline, eller null); `arrivalMs` är då den
   * TIDIGARE av prognosen och fysiken, `windowEndMs` referensankomsten +
   * CONVOY_WINDOW_MS, och en dom 'covered' bär `gate`: villkoret som höll henne
   * kvar ('bakom', 'orent', 'ingen-fysik', 'en-prognos', 'inom-fönstret', 'kö',
   * 'deadline', 'täckningsslut-i-tid', 'golv' eller 'kurs').
   * @private
   * @param {Object} arm - absorberad arm
   * @param {Object|null} event - armens händelse
   * @param {number} now
   * @returns {{kind: string, reason?: string, arrivalMs?: (number|null),
   *   physicsArrivalMs?: (number|null), windowEndMs?: number,
   *   ownDeadlineMs?: (number|null), gate?: string}} dom
   */
  _coverageVerdict(arm, event, now) {
    const bridge = this._targetBridges.get(arm.bridge);
    if (now <= arm.coverUntilMs) {
      const passageKnown = !!event && event.firstPassageAt !== null
        && Number.isFinite(event.firstPassageRegisteredAt);
      // U24 (M7): före första passagen avgör hennes egen deadline (C-IV
      // väg b, se _ownDeadlineVerdict).
      if (!passageKnown) return this._ownDeadlineVerdict(arm, event, bridge, now);
      // KRAV (2): ett fix efter den SKATTADE korsningen (M4, se docblocket).
      if (!(arm.lastSeenAt > event.firstPassageAt)) return { kind: 'covered' };
      if (!arm.lastFixClean || this._hasUnappliedObservation(arm)) return { kind: 'covered' };
      // KRAV (1): ligger bron redan bakom hennes senaste läge (fixet saknade
      // riktning, så observeVessel bokförde ingen passage) släpps hon inte;
      // täckningsslutets passagedom avväpnar henne (granskningen av varv 2).
      if (this._bridgeBehindArm(arm, bridge)) return { kind: 'covered', gate: 'bakom' };
      // Mot det som slutar FÖRST av täckningen och U2-fönstret kring den
      // verkliga passagen (se docblocket). En golvhållen arm mäts bara mot
      // täckningen: golvet absorberade henne just för att hon låg bortom
      // U2-fönstret med under två tick kvar (_anchorFloorHost).
      const windowEnd = arm.anchorFloorEventId === event.id ? arm.coverUntilMs
        : Math.min(arm.coverUntilMs, Math.max(Number.isFinite(event.firedAt) ? event.firedAt : 0,
          event.firstPassageAt) + this.config.CONVOY_WINDOW_MS);
      // KRYPAREN (M5): under ETA-kedjans passagegolv gäller den senare av
      // appens prognos och armens fysik (se docblocket).
      const arrivalMs = this._crawlArrivalMs(arm);
      const basis = { arrivalMs, physicsArrivalMs: arm.physicsArrivalMs, windowEndMs: windowEnd };
      if (!Number.isFinite(arrivalMs) || arrivalMs <= windowEnd) return { kind: 'covered', ...basis };
      if (this._courseAway(arm, bridge)) return { kind: 'covered', ...basis };
      return {
        kind: 'bakkant',
        reason: `färsk prognos ${new Date(arrivalMs).toISOString()} ligger efter fönstrets slut `
          + `${new Date(windowEnd).toISOString()}`,
        ...basis,
      };
    }
    if (this._bridgeBehindArm(arm, bridge)) return { kind: 'passage' };
    if (this._hasUnappliedObservation(arm)) return { kind: 'hold', reason: 'fryst arm (olästa fix)' };
    if (!Number.isFinite(arm.expectedArrivalMs) || !Number.isFinite(arm.earliestArrivalMs)) {
      return { kind: 'hold', reason: 'ingen ankomstfysik' };
    }
    if (Number.isFinite(arm.distanceM) && arm.distanceM <= UNDER_BRIDGE_SET_DISTANCE
        && Number.isFinite(arm.sog) && arm.sog >= PASSAGE_TIMING.MINIMUM_VIABLE_SPEED
        && arm.expectedArrivalMs <= arm.coverUntilMs) {
      return {
        kind: 'hold',
        reason: `under bron vid senaste fixet (${Math.round(arm.distanceM)} m, ${arm.sog} kn) med ankomst inom täckningen`,
      };
    }
    if (this._courseAway(arm, bridge)) return { kind: 'hold', reason: 'kursen leder bort från bron' };
    return { kind: 'täckningsslut' };
  }

  /**
   * EGEN DEADLINE FÖRE FÖRSTA PASSAGEN (ägarbeslut U24, 2026-11-09; varv 2,
   * familj B, M7; C-IV väg b).
   *
   * U24: "Inför ändringen" (rättningskampanjen varv 2, KAMPANJ2.md). Ägaren
   * valde den smala varianten nedan och godtar kostnaden att en köande konvoj
   * ibland får en extra varning (buggjägarens värld 143, se MÄTT). Stilla
   * köande båtar (värld 1139) omfattas inte; för dem gäller täckningsslutet
   * som förut. U9:s breda täckning (BRIDGE_OPENING.U9_RESCUE_COVERAGE) är
   * fortfarande avstängd: U24 ändrar bara släppet, inte vilka som täcks.
   *
   * Ägarens val i C-IV (2026-08-09, docs/etapp7-plan-2026-08-08.md): "Garantin
   * står fast, U2 mjukas upp. Tillåt en andra varning när en medlems egen
   * deadline annars skulle förfalla." Förut hade en absorberad arm i en
   * avfyrad händelse UTAN bokförd passage bara en utgång: täckningsslutet. Där
   * släpptes hon och varnades på en sedan länge förfallen deadline
   * (buggjägarens värld 979: XENIA varnades 50 s före korsningen, medan
   * ledaren FREJA väntade i kö i 37 min; ursprunglig deadline 08:48:36).
   *
   * SMAL VARIANT (inte U9:s breda täckning). Släpp med domen 'bakkant' när ALLA
   * gäller:
   *  (0) bron ligger inte bakom hennes senaste läge (KRAV (1),
   *      _bridgeBehindArm). Ett fix bortom bron utan riktning bokför ingen
   *      passage; utan grinden släpptes och varnades hon efter passagen
   *      (granskningens prob A1 och A1b). Täckningsslutets passagedom
   *      avväpnar henne i stället;
   *  (a) fixet var GPS-rent och armen är inte fryst, som för bakkanten efter
   *      passagen;
   *  (b) både appens prognos och armens fysik (physicsArrivalMs, som kräver
   *      mätbar fart) ligger efter händelsens fönsterslut, referensankomsten +
   *      CONVOY_WINDOW_MS: hon hör inte till den öppning som varnades
   *      (_belongsToEvent på hennes senaste fix, sen sida). En båt som ligger
   *      still har ingen fysik och släpps aldrig här. Appens prognos måste
   *      finnas (etaMinutes, grinden 'en-prognos'): utan den är
   *      expectedArrivalMs samma fysik, och ett enda fix med en fartdipp
   *      släppte en följare som korsade inom fönstret (prob A4 och A4c);
   *  (c) hon köar inte: ingen köflagga (waitingAtBridge) och utanför väntzonen
   *      (STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE, samma zon som köbeviset i
   *      bridgeQueue). U9 splittrade äkta konvojer som väntade tillsammans vid
   *      bron (JOY och SEEBAER III 2026-07-14); utan villkoret släpptes HERA II
   *      239 m från bron i 1,2 kn ur samma kö som LYS (20260707-14h);
   *  (d) hennes egen deadline har passerat: garantins, earliestArrivalMs −
   *      WARNING_LEAD_MS, som räddningsventilen (_rescueCoveredArms);
   *  (e) täckningsslutet kommer för sent för henne: coverUntilMs ligger efter
   *      den tidigare av prognosen och fysiken minus WARNING_LEAD_MS. Ger
   *      täckningsslutet (U17) henne ledtiden ändå, står utfallet kvar. Utan
   *      villkoret flyttade den låsta raden 20260804-both-21h LAURIERBORG
   *      07:36:41 → 07:33:39, där båda varningarna ligger minuter före
   *      korsningen (U13);
   *  (f) minst två tick kvar till förväntad ankomst (ledtidsgolvet, samma som
   *      räddningsventilen och korsningsankarets golv);
   *  (g) kursen leder inte bort från bron (_courseAway).
   * Schemaläggaren väcker släppvägen på hennes deadline (_ownDeadlineWakeMs),
   * så att släppet inte beror på halvminutstickens fas.
   *
   * MÄTT (familj B, varv 2): värld 979 och F02-representanten BORTA (egen
   * varning 08:51:55, 330 s före korsningen); värld 41 varnas 12:16:52, 7,4 min
   * före korsningen, i stället för 2 s efter. Korpusbanken: lika många
   * varningar som förut (431 i replay:all:s 24 korpusar; runOpeningGates räknar
   * 437 med nattens fusionskörning), ingen låst rad flyttas; en olåst
   * fantomvarning (20260525 JOSEPHINE,
   * AVBRUTEN_APPROACH) går 10:01:20 i stället för 10:06:05. KOSTNADEN SOM U24
   * GODTAR (quick, värld 143): RUNA släpps 11:14:52 medan ledaren och CORDELIA
   * köar, CORDELIA absorberas sedan i RUNAs händelse i stället för att bilda en
   * gemensam med henne, och varnas vid dess täckningsslut på ett 21 min gammalt
   * fix, fast hon korsar 353 s efter RUNA. Värld 1139 (stilla i kö) står kvar:
   * en båt som ligger still släpps aldrig här.
   * @private
   * @param {Object} arm - absorberad arm
   * @param {Object|null} event - armens händelse (avfyrad, utan passage)
   * @param {Object|undefined} bridge
   * @param {number} now
   * @returns {Object} dom, se _coverageVerdict
   */
  _ownDeadlineVerdict(arm, event, bridge, now) {
    const basis = this._ownDeadlineBasis(arm, event);
    if (!basis) return { kind: 'covered' };
    const gate = this._ownDeadlineGate(arm, bridge, basis, now);
    if (gate) return { kind: 'covered', gate, ...basis };
    return {
      kind: 'bakkant',
      reason: `egen deadline ${new Date(basis.ownDeadlineMs).toISOString()} förföll före händelsens första `
        + `passage; prognos ${new Date(arm.expectedArrivalMs).toISOString()} och fysik `
        + `${new Date(arm.physicsArrivalMs).toISOString()} ligger efter fönstrets slut `
        + `${new Date(basis.windowEndMs).toISOString()}`,
      ...basis,
    };
  }

  /**
   * Underlaget för M7-domen, eller null när händelsen inte är avfyrad, redan
   * har en passage eller saknar referensankomst. `arrivalMs` är den TIDIGARE
   * av appens prognos och armens fysik (null utan fysik): villkor (b) kräver
   * att båda ligger efter fönstrets slut.
   * @private
   */
  _ownDeadlineBasis(arm, event) {
    if (!event || event.firedAt === null || event.firstPassageAt !== null
        || !Number.isFinite(event.referenceArrivalMs)) return null;
    return {
      arrivalMs: Number.isFinite(arm.expectedArrivalMs) && Number.isFinite(arm.physicsArrivalMs)
        ? Math.min(arm.expectedArrivalMs, arm.physicsArrivalMs) : null,
      physicsArrivalMs: arm.physicsArrivalMs,
      windowEndMs: event.referenceArrivalMs + this.config.CONVOY_WINDOW_MS,
      ownDeadlineMs: Number.isFinite(arm.earliestArrivalMs)
        ? arm.earliestArrivalMs - this.config.WARNING_LEAD_MS : null,
    };
  }

  /**
   * Vilket villkor i _ownDeadlineVerdict håller armen kvar? null = släpp.
   * Namnen bärs i domens `gate` (se _coverageVerdict).
   * @private
   */
  _ownDeadlineGate(arm, bridge, basis, now) {
    if (this._bridgeBehindArm(arm, bridge)) return 'bakom';
    if (!arm.lastFixClean || this._hasUnappliedObservation(arm)) return 'orent';
    if (!Number.isFinite(basis.arrivalMs)) return 'ingen-fysik';
    if (arm.etaMinutes === null) return 'en-prognos';
    if (basis.arrivalMs <= basis.windowEndMs) return 'inom-fönstret';
    if (arm.waitingAtBridge || !Number.isFinite(arm.distanceM)
        || arm.distanceM <= STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE) return 'kö';
    if (!Number.isFinite(basis.ownDeadlineMs) || now < basis.ownDeadlineMs) return 'deadline';
    if (arm.coverUntilMs <= basis.arrivalMs - this.config.WARNING_LEAD_MS) return 'täckningsslut-i-tid';
    if (arm.expectedArrivalMs - now < 2 * this.config.TICK_INTERVAL_MS) return 'golv';
    if (this._courseAway(arm, bridge)) return 'kurs';
    return null;
  }

  /**
   * När ska schemaläggaren väcka släppvägen för M7? Hennes egen deadline, om
   * den ligger framåt och före täckningsslutet och om alla övriga villkor
   * håller på det fix hon har; annars null. Villkoren utom tiden ändras bara
   * med ett nytt fix, och ett nytt fix utvärderar bron ändå, så ingen
   * nolltidsloop kan uppstå.
   * @private
   * @param {Object} arm
   * @param {number} now
   * @returns {number|null}
   */
  _ownDeadlineWakeMs(arm, now) {
    if (arm.absorbedAt === null || !Number.isFinite(arm.coverUntilMs) || arm.eventId === null) return null;
    const event = this._eventsAt(arm.bridge).find((e) => e.id === arm.eventId) || null;
    const basis = this._ownDeadlineBasis(arm, event);
    if (!basis || !(basis.ownDeadlineMs > now) || basis.ownDeadlineMs > arm.coverUntilMs) return null;
    const wake = Math.ceil(basis.ownDeadlineMs);
    return this._ownDeadlineGate(arm, this._targetBridges.get(arm.bridge), basis, wake) === null ? wake : null;
  }

  /**
   * BAKKANTENS ANKOMST för en krypare (varv 2, familj B, M5).
   *
   * Under ETA-kedjans passagegolv (MIN_PASSAGE_ROUTE_SPEED_KNOTS, 2,5 kn) är
   * det den SENARE av appens prognos (expectedArrivalMs) och armens fysik
   * (physicsArrivalMs, avstånd genom fart ur samma fix), från det andra nya
   * krypfixet i följd eller direkt efter marschfart, och utan köflagga (se
   * KÖLÄMNAREN). Över golvet, utan mätbar fart, på ett första krypfix efter
   * stillhet eller i bekräftad kö är det appens prognos som förut.
   *
   * VARFÖR. Efter en passage räknar ETA-kedjan med minst 2,5 kn
   * (ProgressiveETACalculator, minRouteSpeed) och håller emot hopp uppåt
   * (outlierskyddet). För en båt i 0,9–1,3 kn ligger prognosen därför minuter
   * före fysiken, INOM U2-fönstret, och bakkanten släppte henne inte. Hon
   * släpptes först vid täckningsslutet och varnades på en sedan länge
   * förfallen deadline (värld 790: 47 s före korsningen; värld 1794, F08:
   * 20 s efter). Golvet binder bara under 2,5 kn; över det räknar kedjan på
   * farten, och appens prognos är den som kortets eta_minutes, O1 och
   * konvojfönstret redan använder.
   *
   * MÄTT OCH AVVISAT: fysiken utan fartgräns. Den fällde 7 test i
   * opening-convoy-release-scheduling.test.js, vars fixturer har sog 3 och
   * eta 1,5 min vid 300 m. Inget i banken visar att appens prognos över golvet
   * är för tidig, så gränsen följer golvet.
   *
   * KÖLÄMNAREN (granskningen av varv 2, prob C4, C4b och C4c). En båt som
   * köat nära bron och startar efter ledarens passage rapporterar en
   * momentan låg fart på sitt första rörelsefix. Fysiken ur det fixet lade
   * henne efter fönstret, hon släpptes och varnades igen fast hon korsade
   * inom det. Därför gäller fysiken bara (1) när armen saknar köflaggan
   * (waitingAtBridge, appens bekräftade väntan) och (2) från det ANDRA
   * nya krypfixet i följd (crawlFixes, räknas i _refreshArm), UTOM när
   * krypet börjar direkt efter ett fix i marschfart (crawlFromCruise, förra
   * fixet ≥ MIN_PASSAGE_ROUTE_SPEED_KNOTS). En kölämnare kommer från
   * stillhet, en krypare som saktat in kommer från marschfart: den senare
   * släpps på sitt första krypfix (omgranskningen: annars föll M5 tillbaka
   * till c14938f:s sena varning vid gles kadens, prob D3, och vid fart som
   * pendlar runt golvet, D2). Ett fix räknas bara när dess tid gått framåt,
   * så en upprepad leverans av kölämnarens första rörelsefix ger inget
   * andra krypfix (prob D4).
   *
   * Bara släppvägen läser värdet. Deadlinen, eta-tokenen och ETA-texten är
   * oförändrade (U22).
   * @private
   * @param {Object} arm
   * @returns {number|null} ankomsten som bakkanten jämför med fönstrets slut
   */
  _crawlArrivalMs(arm) {
    if (!Number.isFinite(arm.expectedArrivalMs)) return null;
    if (Number.isFinite(arm.physicsArrivalMs) && (arm.crawlFixes >= 2 || arm.crawlFromCruise)
        && !arm.waitingAtBridge) {
      return Math.max(arm.expectedArrivalMs, arm.physicsArrivalMs);
    }
    return arm.expectedArrivalMs;
  }

  /**
   * Ligger bron BAKOM armens senaste tillämpade läge? KRAV (1)
   * (ARCHITECTURE.md §H29/H30). Samma uttryck som släppvägens passagedom: ett
   * fix bortom bron UTAN riktning bokför ingen passage i observeVessel
   * (_bridgeIsBehind läser fartygets riktning), men armen behåller sin
   * riktning från beväpningen. Läses av passagedomen vid täckningsslutet och
   * av grinden 'bakom' i bakkanten och i U24-släppet (granskningen av varv 2,
   * prob A1 och A1b: utan grinden släpptes och varnades en båt som redan
   * passerat).
   * @private
   * @param {Object} arm
   * @param {Object|undefined} bridge
   * @returns {boolean}
   */
  _bridgeBehindArm(arm, bridge) {
    const dir = arm.routeDirection;
    return !!bridge && Number.isFinite(arm.lat)
      && ((dir === 'north' && arm.lat > bridge.lat) || (dir === 'south' && arm.lat < bridge.lat));
  }

  /**
   * Leder armens senaste kurs BORT från bron? (K-familjen, F14.)
   *
   * Bara för en båt i rörelse (sog ≥ MOVING_SOG_KN) utanför väntzonen
   * (> STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE): i kön är cog brus, och
   * MISTRAL-läxan (_hasUnappliedObservation) visar att "avståndet växer" inte
   * duger som bevis för en väntande båt. Grinden AVVÄPNAR aldrig — U-svängen
   * ägs av appens Fix D-debounce — den bara skjuter upp ett släpp till nästa
   * fix, som antingen bekräftar vändningen eller visar en anflygning igen.
   * @private
   * @param {Object} arm
   * @param {Object|undefined} bridge
   * @returns {boolean}
   */
  _courseAway(arm, bridge) {
    if (!bridge || !Number.isFinite(arm.lat) || !Number.isFinite(arm.lon)) return false;
    if (!Number.isFinite(arm.cog) || !Number.isFinite(arm.sog) || arm.sog < MOVING_SOG_KN) return false;
    if (!Number.isFinite(arm.distanceM) || arm.distanceM <= STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE) return false;
    const bearing = geometry.calculateBearing(arm.lat, arm.lon, bridge.lat, bridge.lon);
    return geometry.normalizeAngleDiff(arm.cog, bearing) > 90;
  }

  /**
   * Släpp en absorberad arm som lös (bakkant eller täckningsslut). Samma
   * nollställning som förut; `releasedFrom` hindrar att hon knyts tillbaka in i
   * samma händelse på nästa rad.
   * @private
   */
  _releaseCoveredArm(arm, kind, now, detail = '') {
    this.logger.debug(
      `🔁 [OPENING_RECOVER] ${arm.mmsi} (${arm.name || 'okänt namn'}): konvojtäckningen vid ${arm.bridge} `
      + `${kind === 'bakkant' ? 'gäller inte längre' : 'löpte ut'} (${arm.eventId}) men båten är kvar beväpnad d=`
      + `${Number.isFinite(arm.distanceM) ? Math.round(arm.distanceM) : '?'} m — prövas som EGEN öppning`
      + `${detail ? ` (${kind}: ${detail})` : ''}`,
    );
    if (arm.eventId !== null) arm.releasedFrom.add(arm.eventId);
    arm.warnedAt = null;
    arm.absorbedAt = null;
    arm.coverUntilMs = null;
    // U9: flaggan följer täckningen och måste dö med den. En kvarlämnad
    // flagga hade låtit räddningsventilen pröva en arm som inte längre är
    // täckt av någonting.
    arm.coveredBeyondWindow = false;
    arm.eventId = null;
    arm.recoverHeldAt = null;
    arm.recoverHoldReason = null;
  }

  /**
   * PASSAGEN AVSLUTAR HÄNDELSEN — INTE DE ANDRA BÅTARNAS ANFLYGNING.
   * (C7 punkt ii, etapp 7 fas C, 2026-08-09.)
   *
   * U2 (användarens ord): "en öppningshändelse lever tills FÖRSTA FAKTISKA
   * PASSAGEN … båtar som anländer EFTER passagen är nästa öppning." Koden
   * genomförde första halvan men inte den andra: när en medlem passerade sattes
   * `lastPassageAt`, och därefter var händelsen permanent död i TRE kedjor —
   * spent-städningen (steg 2), värdvägran (steg 3: `e.lastPassageAt === null`)
   * och avfyrspärren (steg 4). Övriga medlemmar satt kvar med `eventId` pekande
   * på liket: de kunde varken avfyra i den händelsen (spärren), knytas till en
   * annan (steg 3 rör bara armar med `eventId === null`) eller seeda en egen.
   * De var alltså gisslan hos en öppning som redan hade skett — vilket är exakt
   * det motsatta av vad U2 säger att de är.
   *
   * VILKA SOM SLÄPPS: bara OVARNADE medlemmar. En arm som var medlem när
   * varningen gick ut, eller som absorberades av en avfyrad händelse, bär redan
   * sin täckning i `warnedAt`; att släppa henne vore en andrapåminnelse (U2:
   * "Inga andrapåminnelser") och inte en räddad öppning. Den tidsbegränsade
   * täckningen för absorberade armar ägs av _releaseStrandedArms och rörs inte.
   *
   * ICKE-PASSERADE FÖLJER AV KONSTRUKTIONEN: en arm vars EGET fartyg passerade
   * avväpnas i samma anrop som passagen bokförs (observeVessel steg 1 respektive
   * notePassage), så den finns inte kvar i `arms` när vi kommer hit. Vi behöver
   * alltså ingen egen passagekontroll — och ska inte bygga en, eftersom servicen
   * inte håller några fartygsreferenser.
   *
   * SAMMA MÖNSTER SOM _releaseStrandedArms: `releasedFrom` hindrar att armen
   * knyts tillbaka in i samma händelse på nästa rad (konvojkriteriet är ju
   * fortfarande uppfyllt), och `eventId = null` gör henne lös så att steg 3 kan
   * ge henne en EGEN händelse — och därmed en egen varning för sin egen
   * öppning. Steg 3:s värdregel gör dessutom att ingen NY arm kan knytas till
   * den passerade händelsen, så listan kan inte fyllas på igen.
   * @private
   */
  _releasePassedEventArms(arms, events, now) {
    for (const event of events) {
      if (event.lastPassageAt === null) continue;
      for (const arm of arms) {
        if (arm.eventId !== event.id || arm.warnedAt !== null) continue;
        this.logger.debug(
          `🔁 [OPENING_REOPEN] ${arm.mmsi} (${arm.name || 'okänt namn'}): ${arm.bridge}-öppningen `
          + `${event.id} fick sin passage utan att varna henne (d=`
          + `${Number.isFinite(arm.distanceM) ? Math.round(arm.distanceM) : '?'} m, armad `
          + `${Math.round((now - arm.armedAt) / 1000)} s) — släpps som EGEN öppning`,
        );
        arm.releasedFrom.add(event.id);
        arm.eventId = null;
      }
    }
  }

  /**
   * Tillhör armen samma öppning som händelsen? dig9 klustrar PASSAGER inom
   * CONVOY_WINDOW_MS — vi speglar det på förväntad ankomst.
   * @private
   */
  _belongsToEvent(arm, event) {
    if (!Number.isFinite(event.referenceArrivalMs)) return true;
    if (!Number.isFinite(arm.expectedArrivalMs)) return true;
    if (event.firstPassageAt === null && Number.isFinite(event.newMemberArrivalLimitMs)
        && arm.expectedArrivalMs > event.newMemberArrivalLimitMs) return false;
    return Math.abs(arm.expectedArrivalMs - event.referenceArrivalMs)
      <= this.config.CONVOY_WINDOW_MS;
  }

  /**
   * Bokför en målbropassage på den öppna händelsen — men BARA när det
   * passerande fartyget faktiskt är medlem i den. En passage av en båt som
   * hör till en annan (eller ingen) öppning säger ingenting om den här
   * händelsen och får inte spärra dess avfyrning.
   *
   * K-FAMILJEN, F01 (glappregistreringen, 2026-11-04): `now` är tiden då appen
   * FICK VETA om passagen, inte då den skedde. Efter ett AIS-avbrott ligger de
   * ett helt avbrott isär (värld 1900: ORION korsade 09:13:46 och bokfördes
   * 09:26:22), och ett fönster räknat från bokföringen svalde nästa öppning:
   * ULLA beväpnades 09:26:23, absorberades och korsade 09:31:35 — 1069 s efter
   * ORIONs verkliga korsning — utan egen varning. I korpusbanken ligger
   * bokföringen median 109 s och p90 625 s efter den interpolerade korsningen.
   * firstPassageAt och referensankomsten ankras därför i `crossedAtMs` när
   * anroparen kan skatta den (se _crossingEstimate och _crossingUpperBound),
   * annars som förut i `now`. Det styr MEDLEMSKAPET (_belongsToEvent) och
   * bakkanten (_coverageVerdict). Bokföringstiden `now` gäller fortfarande för
   * lastPassageAt (avfyrspärren och händelsestädningen gäller när passagen blev
   * KÄND) och för täckningsslutet (firstPassageRegisteredAt, revision 3): en
   * tyst båts säkerhetsvarning (U17) kommer som på 7699cbe.
   * @private
   * @param {string} bridgeName
   * @param {Object|undefined} arm
   * @param {number} now - bokföringstid
   * @param {number|null} [crossedAtMs] - interpolerad korsningstid (≤ now)
   */
  _recordPassage(bridgeName, arm, now, crossedAtMs = null) {
    if (!arm) return;
    const crossedAt = Number.isFinite(crossedAtMs) && crossedAtMs <= now ? crossedAtMs : now;
    const event = arm.eventId === null ? null
      : this._eventsAt(bridgeName).find((e) => e.id === arm.eventId) || null;
    // U15 (B02): RETURMINNET. Hennes NÄSTA anflygning mot samma bro är en ny
    // öppning (se _ownPassage och _releaseReturnCoverage). Bokförs för varje
    // beväpnad båt, även utan levande händelse, och oberoende av
    // händelsestädningen. Samma tid som firstPassageAt nedan, så villkor (b) i
    // _describesPassedOpening jämför passager i samma tidsdomän. En ARMLÖS
    // passage bokförs inte, som i resten av öppningslagret (app.js
    // _observeBridgeOpening, J14: medlemskravet är ett val).
    this._passageMemory.set(arm.key, { at: crossedAt, registeredAt: now, eventId: event ? event.id : null });
    if (!event) return;
    event.lastPassageAt = now;
    // Referensankomsten blir den FÖRSTA faktiska passagetiden — konvojfönstret
    // mäts mot den (dig9 klustrar passager, inte prognoser). Den skjuts INTE
    // fram av varje ny passage: gjorde den det gled absorptionsfönstret
    // framåt i all oändlighet och en efterföljande, helt separat öppning kunde
    // sväljas av samma händelse (ASPEN→ELFKUNGEN @ Klaffbron 2026-07-14).
    if (event.firstPassageAt === null) {
      event.firstPassageAt = crossedAt;
      event.firstPassageRegisteredAt = now;
      event.referenceArrivalMs = crossedAt;
      if (crossedAt < now) {
        this.logger.debug(
          `🌉 [OPENING_PASSAGE_TIME] ${arm.mmsi} (${arm.name || 'okänt namn'}): ${event.id} — korsningen `
          + `${new Date(crossedAt).toISOString()} skattad, ${Math.round((now - crossedAt) / 1000)} s `
          + 'före bokföringen; medlemskapet och bakkanten mäts mot korsningen',
        );
      }
      // K14 (fältprov 10, 2026-08-19): referensankomsten räknas om här — men
      // de ABSORBERADE armarnas coverUntilMs gjorde det inte, och det är den
      // och bara den som styr RECOVER-vägen (_releaseStrandedArms). Täckningen
      // rebaseras på BOKFÖRINGEN, som före K-rättningen (se _bindLooseArms):
      // korsningen styr medlemskapet och bakkanten, inte när en tyst båt släpps.
      this._rebaseConvoyCoverage(event, now);
    }
  }

  /**
   * INTERPOLERAD KORSNINGSTID för en passage som observeVessel just upptäckt
   * (K-familjen, F01). Linjär interpolation längs avståndet mellan armens
   * senaste TILLÄMPADE fix (före bron) och det aktuella fixet (bortom bron):
   *     t = t_före + (t_efter − t_före) · d_före / (d_före + d_efter)
   * Samma princip som rådatafacit (makeGtPassages) använder för punktkorsningar.
   * Fixtiderna är fixens egna (min(fixTs, timestamp), klockdomänsdoktrinen i
   * _refreshArm), inte mottagningstiden.
   *
   * Returnerar null — och anroparen faller tillbaka på _crossingUpperBound och
   * sist på bokföringstiden — när underlaget inte bär: okänd riktning, ett fix
   * som inte låg på var sin sida om bron, en fryst arm eller orimliga tider.
   * Bokföringstiden är ALLTID för sen, och ett för sent ankare låter fönstret
   * svälja nästa öppning — den värsta klassen enligt produktprincipen.
   *
   * VÄNTAN FÖRE BRON (revision 3, dirigentens beslut 2026-11-05). Den räta
   * linjen antar jämn fart över hela intervallet. Visar fixet före bron en
   * stilla eller köande båt (waitingAtBridge, eller sog under
   * MINIMUM_VIABLE_SPEED) stämmer det inte: hon låg kvar en del av intervallet
   * och korsade senare. Ett för tidigt ankare låter fönstret sluta före den
   * verkliga öppningens slut, och en båt som enligt U2 hör till samma öppning
   * får en andra varning. Då gäller max(rät linje, bakåtskattning ur fixet
   * efter bron i dess fart) — se koden nedan för motiveringen av varje led.
   *
   * FRYST ARM (_hasUnappliedObservation) — medvetet bokföringstiden, som före
   * rättningen. Armen har läst fix som den inte kunde tillämpa, typiskt för att
   * appen släppte målbron (kajstopp, osäker tilldelning). Hennes senaste
   * TILLÄMPADE fix är då inte nödvändigtvis det senaste före bron, och
   * intervallet kan rymma ett stopp som interpolationen inte ser och därför
   * lägger korsningen mitt i. Mätt i korpusbanken: noll ändrade varningar med
   * eller utan vakten; enhetstestet låser valet.
   * Gäller VARJE passage med fix på var sin sida om bron, inte bara AIS-glapp:
   * U2 räknar fönstret från passagen, och en variant som bara interpolerade
   * glapp över STALE_ETA_SOFT_MS lämnade fler missade öppningar i buggjägarens
   * standardvärldar (ARCHITECTURE.md §H29/H30, K-familjen).
   * @private
   * @param {Object} arm - armen FÖRE avväpningen (bär senaste fixet före bron)
   * @param {Object} vessel - aktuellt fix
   * @param {number|null} currentDistance - avstånd till armens bro i detta fix
   * @param {number} now
   * @returns {number|null} korsningstid (ms) eller null
   */
  _crossingEstimate(arm, vessel, currentDistance, now) {
    const fixTs = Number.isFinite(vessel.fixTs) ? vessel.fixTs : null;
    const recvTs = Number.isFinite(vessel.timestamp) ? vessel.timestamp : now;
    let tAfter = fixTs !== null ? Math.min(fixTs, recvTs) : recvTs;
    if (!Number.isFinite(tAfter) || tAfter > now) tAfter = now;
    const tBefore = arm.rawAnchorMs;
    const dBefore = arm.distanceM;
    if (!Number.isFinite(tBefore) || !Number.isFinite(dBefore) || !Number.isFinite(currentDistance)) return null;
    if (tBefore >= tAfter || this._hasUnappliedObservation(arm)) return null;
    const bridge = this._targetBridges.get(arm.bridge);
    if (!bridge || !Number.isFinite(arm.lat) || !Number.isFinite(vessel.lat)) return null;
    const dir = arm.routeDirection;
    const behind = (lat) => {
      if (dir === 'north') return lat > bridge.lat;
      if (dir === 'south') return lat < bridge.lat;
      return null;
    };
    if (behind(arm.lat) !== false || behind(vessel.lat) !== true) return null;
    const total = dBefore + currentDistance;
    if (!(total > 0)) return null;
    const linear = tBefore + (tAfter - tBefore) * (dBefore / total);
    // VÄNTAN FÖRE BRON (omgranskningen 2026-11-05, dirigentens beslut inför
    // revision 3). Visar fixet före bron en stilla eller köande båt, har hon
    // stått still en del av intervallet och sedan accelererat. Hennes väg är då
    // konvex i tiden, och korsningen ligger aldrig före den räta linjen ovan —
    // den lade den i stället mitt i väntan (25h: MALUCA 08:19:40 mot IDUN och
    // NICOLINE ur samma kö 08:24:32 och 08:25:16). Skatta i stället bakåt ur
    // fixet efter bron i det fixets egen fart, men aldrig före den räta linjen:
    // ligger bakåtskattningen före den har båten saktat in efter bron, och då
    // bär farten inte skattningen. Utan mätbar fart efter bron
    // (≤ MINIMUM_VIABLE_SPEED) gäller den räta linjen. Mätt mot sanningen i
    // snabbprofilens 32 väntefall: median −101 s och värst −780 s med linjen,
    // median −1 s och spann −90…+30 s med den här regeln.
    const sogBefore = arm.sog;
    const waitedBefore = !!arm.waitingAtBridge
      || (Number.isFinite(sogBefore) && sogBefore < PASSAGE_TIMING.MINIMUM_VIABLE_SPEED);
    if (waitedBefore && Number.isFinite(vessel.sog)
        && vessel.sog > PASSAGE_TIMING.MINIMUM_VIABLE_SPEED) {
      const backward = tAfter - (currentDistance / (vessel.sog * KNOTS_TO_MS)) * 1000;
      return Math.min(tAfter, Math.max(linear, backward));
    }
    return linear;
  }

  /**
   * KORSNINGENS ÖVRE GRÄNS UR ARMENS EGET LÄGE (K-familjen, granskningen
   * 2026-11-04). För de två vägar som bokför en passage utan att ha fixet efter
   * korsningen framför sig: släppvägens passagedom (_coverageVerdict
   * 'passage') och notePassage (appen bokförde passagen men observeVessel såg
   * den inte, t.ex. vid tidig retur på ett GPS-flaggat fix).
   *
   * Ligger armens senaste TILLÄMPADE läge redan bortom bron, skedde korsningen
   * före det fixet. Fixets tid är då en säker övre gräns — aldrig tidigare än
   * den verkliga korsningen, alltid tidigare än bokföringen — och används.
   *
   * Annars null, och bokföringstiden gäller som före rättningen. MÄTT OCH
   * AVVISAT: att projicera korsningen ur armens senaste fix FÖRE bron (hennes
   * prognos, klämd till [fixets tid, now]). En båt som väntar efter sitt
   * senaste fix korsar långt senare än prognosen, och då startar fönstret för
   * tidigt: i opening-updated-host-forecast.test.js ("senare faktisk passage
   * ersätter prognosbegränsningen") passerade ledaren 13 min efter sin senaste
   * prognos, och följaren som kom 5 min efter den verkliga passagen fick en
   * andra varning för samma öppning (U2). I korpusbanken ändrade
   * projektionen ingen varning. Utan ett fix bortom bron finns ingen säker
   * skattning; interpolationen i observeVessel (_crossingEstimate) kräver ett.
   * @private
   * @param {Object} arm - levande arm (före avväpningen)
   * @param {number} now - bokföringstid
   * @returns {number|null} korsningens övre gräns (ms) eller null
   */
  _crossingUpperBound(arm, now) {
    const fixMs = arm.rawAnchorMs;
    if (!Number.isFinite(fixMs) || fixMs > now) return null;
    const bridge = this._targetBridges.get(arm.bridge);
    const dir = arm.routeDirection;
    const beyond = bridge && Number.isFinite(arm.lat)
      && ((dir === 'north' && arm.lat > bridge.lat) || (dir === 'south' && arm.lat < bridge.lat));
    return beyond ? fixMs : null;
  }

  /**
   * K14 — TÄCKNINGEN ANKRAS I DEN VERKLIGA PASSAGEN, INTE I LEDARENS PROGNOS.
   * (Fältprov 10, 2026-08-19; syntesens enda nya punkt i konvojfamiljen.)
   *
   * MEKANISMEN FÖRE. En absorberad arm får `coverUntilMs = max(värdens
   * firedAt, värdens referenceArrivalMs) + CONVOY_WINDOW_MS` en gång, vid
   * absorptionen (_bindLooseArms:1071-1075). `referenceArrivalMs` är då en
   * PROGNOS — min över medlemmarnas `expectedArrivalMs` när varningen gick ut
   * — och den räknades aldrig om när öppningen bevisligen SKEDDE. Fältet:
   * Klaffbron#6 avfyrade 15:47:09,414 med NAVENs prognos 15:57:32,649 ⇒
   * DAPHNE (absorberad 15:52:11,993) var täckt t.o.m. 16:07:32,649. NAVENs
   * FAKTISKA passage bokfördes 15:56:43,021 — 49,6 s före prognosen — men
   * DAPHNE släpptes ändå först 16:07:39,671 (OPENING_RECOVER, d=263 m).
   *
   * MEKANISMEN EFTER. Konvojfönstret är dig9:s klustring av PASSAGER
   * (CONVOY_WINDOW_MS, se härledningen vid konstanten) och ARCHITECTURE.md
   * §öppningshändelser säger att händelsen lever till FÖRSTA FAKTISKA
   * PASSAGEN. Så snart den tiden finns är den ett sannare ankare än prognosen,
   * och täckningen rebaseras på `max(firedAt, <när första passagen bokfördes>)
   * + CONVOY_WINDOW_MS`. firedAt-ledet är oförändrat från originalformeln:
   * täckningen får aldrig sluta före varningen den vilar på.
   *
   * ⚠️ ENKELRIKTAD — TÄCKNINGEN FÅR BARA KORTAS, ALDRIG FÖRLÄNGAS. Prognosen
   * är systematiskt optimistisk (C14: TONGA 1392 m/3 kn ⇒ 13 min mot 45 min
   * verkligt), så en rak ombasering hade i normalfallet FÖRLÄNGT täckningen
   * med den optimismen. En längre täckning är längre gisslantid för en
   * o-varnad båt och kan bara TA BORT varningar — exakt den bytesaffär C8
   * mättes på och återkallades för (sex ovarnade öppningar, 26 → 32).
   * Produktprincipen ("en MISSAD öppning är värre än ett falsklarm") avgör
   * alltså riktningen: rebasera NED, aldrig upp. En kortning kan bara lägga
   * TILL varningar.
   *
   * GOLVET FÖLJER AV KONSTRUKTIONEN: anroparen (_recordPassage) skickar
   * bokföringstiden `now`, så det nya värdet är alltid `now + CONVOY_WINDOW_MS`
   * eller senare. En rebasering kan därför aldrig släppa en arm i samma anrop.
   * K-familjens korsningstid (F01) styr medlemskapet och bakkanten, inte
   * täckningsslutet; en variant som rebaserade på korsningen flyttade en låst
   * rad som rådatan bara bedömer som likvärdig (20260712-25h, U13; K-familjens
   * alternativ A).
   * @private
   */
  _rebaseConvoyCoverage(event, firstPassageAt) {
    const rebased = Math.max(
      Number.isFinite(event.firedAt) ? event.firedAt : 0,
      firstPassageAt,
    ) + this.config.CONVOY_WINDOW_MS;
    for (const arm of this._arms.values()) {
      // eventId bär brons namn (`${bridgeName}#${seq}`) och är därför unikt
      // över broarna — ingen extra brofiltrering behövs.
      if (arm.eventId !== event.id) continue;
      if (arm.absorbedAt === null || !Number.isFinite(arm.coverUntilMs)) continue;
      if (rebased >= arm.coverUntilMs) continue; // aldrig FÖRLÄNGA (se doktrinen ovan)
      const before = arm.coverUntilMs;
      arm.coverUntilMs = rebased;
      this.logger.debug(
        `🌉 [OPENING_COVER_REBASE] ${arm.mmsi} (${arm.name || 'okänt namn'}): `
        + `${event.id} fick sin verkliga passage — täckningen kortas från `
        + `${new Date(before).toISOString()} till ${new Date(rebased).toISOString()} `
        + `(${Math.round((before - rebased) / 1000)} s tidigare)`,
      );
    }
  }

  /**
   * Öppna en ny öppningshändelse. REFERENSANKOMSTEN sätts av den arm som
   * seedar händelsen — utan den vore konvojkriteriet vakuöst (en händelse med
   * referens null släpper in vad som helst, vilket var precis hur den snabba
   * båten kunde svälja den långsamma).
   * @private
   */
  _openEvent(bridgeName, now, seedArm = null) {
    this._eventSeq += 1;
    const event = {
      id: `${bridgeName}#${this._eventSeq}`,
      bridge: bridgeName,
      openedAt: now,
      firedAt: null,
      // F09: avfyrningens plats i bearbetningsordningen (se _fixAfterWarning).
      firedOrder: null,
      lastPassageAt: null,
      firstPassageAt: null,
      // När appen BOKFÖRDE den första passagen. firstPassageAt är den
      // interpolerade korsningstiden och kan ligga ett AIS-avbrott tidigare.
      // Täckningsslutet räknas från bokföringen (_rebaseConvoyCoverage,
      // _bindLooseArms) och korsningsankarets golv läser den
      // (_anchorFloorHost). Bakkantens färskhet mäts sedan varv 2 (M4) mot
      // korsningen, inte mot bokföringen. Se _coverageVerdict.
      firstPassageRegisteredAt: null,
      newMemberArrivalLimitMs: null,
      referenceArrivalMs: seedArm && Number.isFinite(seedArm.expectedArrivalMs)
        ? seedArm.expectedArrivalMs : null,
    };
    this.logger.debug(
      `🌉 [BRIDGE_OPENING] Öppningshändelse ${event.id} öppnad vid ${bridgeName}`
      + `${seedArm ? ` (seed ${seedArm.mmsi}, förväntad ankomst ${
        Number.isFinite(event.referenceArrivalMs)
          ? new Date(event.referenceArrivalMs).toISOString() : 'okänd'})` : ''}`,
    );
    return event;
  }

  /**
   * LEDANDE BÅT = den närmast bron, på armens RÅA mätvärde.
   *
   * ⛔ INGEN PROJEKTION. K20a prövades 2026-08-21 som `distanceM − sog·ålder`
   * och FÖRSÄMRADE ledarvalet 2 av 2 gånger i låst korpusdata (20260525
   * Stridsbergsbron#7: MARIANNE → JOSEPHINE fast MARIANNE korsade 12,3 s först;
   * 20260804-both-21h Klaffbron#27: BLADE → ELFKUNGEN fast ELFKUNGEN
   * U-svängde vid Olidebron och aldrig nådde Klaffbron). Modellen saknade
   * närmandeterm och krediterade dessutom en TYST arm maximal framdrift.
   * Den är återkallad; ledarvalet är och förblir rått avstånd.
   *
   * Metoden finns för att `_fire` och `_leadIsUnsettled` MÅSTE räkna fram
   * exakt samma ledare — två kopior av samma reduce hade kunnat glida isär och
   * grinden nedan hade då skjutit upp fel avfyrningar.
   * @private
   * @returns {Object|null}
   */
  _leadOf(members) {
    return members.reduce(
      (best, a) => (best === null || (a.distanceM ?? Infinity) < (best.distanceM ?? Infinity) ? a : best),
      null,
    );
  }

  /**
   * K20a-REDO — LEDARVALET FÅR INTE AVGÖRAS AV ETT HALVT TILLÄMPAT POLLSVEP.
   * (Fältprov 10, fynd K20, 2026-08-19. Ersätter den återkallade projektionen.)
   *
   * DEFEKTEN, i rådata. AISHubClient sprider en pollbatch med
   * AIS_CONFIG.AISHUB.EMIT_SPREAD_MS = 150 ms mellan meddelandena, och varje
   * meddelande utvärderar sin bro direkt (observeVessel steg 3, firedBy
   * 'fix'). Fältet 2026-08-19: BALTIC JONGLEUR levererades 09:12:06.719 (fix
   * 09:11:47) och TONGA 09:12:06.868 (fix 09:11:47) — SAMMA poll, 149 ms isär.
   * Avfyrningen landade i luckan mellan raderna. Då jämfördes BJ:s
   * NYSS UPPDATERADE 1277 m mot TONGA:s 79,7 s gamla 1308 m, och kortet
   * utsåg BJ till ledande båt (riktning northbound, eta 11). TONGA:s egen rad
   * 149 ms senare gav 1165 m — hon var i verkligheten NÄRMAST, och fältloggens
   * eget utfall (TONGA/southbound/eta 8) bekräftar det.
   *
   * SNEDVRIDNINGEN ÄR SYSTEMATISK, inte slumpmässig. Ett avstånd MINSKAR med
   * tiden, så en arm vars fix är en pollperiod gammal bär ett för STORT
   * avstånd. Den arm som just utlöst utvärderingen har per definition ålder 0
   * och är den enda som inte betalar den straffavgiften — alltså vinner den
   * triggande båten ledarskapet oftare än hon förtjänar.
   *
   * GRINDEN. Skjut upp avfyrningen när ALLA fyra gäller:
   *   (1) utvärderingen är fix-utlöst (en tick har ingen färsk arm alls, och
   *       villkoret gör taket nedan BEVISBART — se GARANTIN),
   *   (2) ETT POLLSVEP PÅGÅR — förra observationen kom för mindre än
   *       BATCH_SETTLE_MS sedan (se härledningen vid konstanten). Utan det
   *       ledet hade grinden slagit till även i ren aisstream-trafik, där en
   *       tyst arm inte har någon rad på väg och uppskjutet därför inte kan
   *       tillföra ny information — bara flytta avfyrningen.
   *       ⚠️ MÅTTET TILLHÖR observeVessel: `_observationGapMs` skrivs BARA där.
   *       notePassage skickar också firedBy 'fix' men är passage-driven, och
   *       sätter därför måttet till Infinity före sin utvärdering — ledet är
   *       EXPLICIT inert på den vägen, inte inert av en sammanträffande
   *       tidsstämpel (granskningen 2026-08-21),
   *   (3) den arm som skulle bli LEDANDE uppdaterades av just det här
   *       meddelandet, och
   *   (4) hon är INTE bland de förfallna — varningen går alltså ut för NÅGON
   *       ANNANS deadline, och hennes färska position är bara den som råkade
   *       komma först i svepet.
   * Är hon själv förfallen är avfyrningen HENNES och hennes färska fix det
   * bästa vi har; då fyras det direkt som förut.
   *
   * EN ENSAM MEDLEM KAN ALDRIG SKJUTAS UPP, och det behöver inget eget villkor:
   * `due` är per konstruktion en delmängd av `members`, så med en enda medlem
   * är ledaren antingen förfallen — och då stoppar (4) — eller inte förfallen,
   * och då är `due` tom och _fire nås aldrig. (Ett explicit
   * `members.length < 2` vore en gren ingen mutation kan fälla; klassen låses i
   * stället av ett beteendetest, tests/k20a-ledarval.test.js "ENSAM MEDLEM".)
   *
   * VARFÖR INGEN MODELL. Grinden ändrar bara NÄR jämförelsen görs, aldrig VAD
   * som jämförs: när avfyrningen väl sker jämförs råa armavstånd precis som på
   * HEAD. Den kan därför per konstruktion inte utse en båt som går bort från
   * bron (K20a:s felklass).
   *
   * GARANTIN HÅLLER. Ingenting avfyras bort — händelsen står kvar orörd
   * (firedAt = null) och prövas igen vid NÄSTA utvärdering: nästa meddelande i
   * samma batch (150 ms) eller senast nästa deadline-tick. Uppskjutet är
   * alltså aldrig längre än ETT tick = BRIDGE_OPENING.TICK_INTERVAL_MS (30 s),
   * och villkor (1) gör taket ABSOLUT: på en tick är ingen arm färsk, så
   * grinden är alltid inert där. Filens tickdoktrin räknar redan med den
   * marginalen — WARNING_LEAD_MS (180 s) är SEX tickar, så ±1 tick kan aldrig
   * äta förvarningen.
   *
   * HÖRNFALLET, ÄRLIGT REDOVISAT (granskningen 2026-08-21): uppskjutet kan
   * förlora en varning i EXAKT ett fall — om en medlems målbropassage hinner
   * registreras inne i fönstret. Avfyrspärren i _evaluateBridge steg (4) är
   * `event.firedAt !== null || event.lastPassageAt !== null`, så händelsen blir
   * då permanent blockerad. Det är RÄTT beteende: en varning efter passagen
   * vore en varning om en öppning som redan skett, och WARN-invarianten fäller
   * den ändå. Empiriskt noll — sprängradiemätningen nedan visar 367 avfyrningar
   * i båda träden, 0 tillkomna och 0 borttagna.
   *
   * ⚠️ ATT AVFYRNINGEN SEDAN KAN LANDA SENARE ÄN ETT TICK ÄR INTE UPPSKJUTET.
   * Fältfallet fyrade 09:12:44,920 i stället för 09:12:06,719 — 38 s — men
   * bara 0,15 s av dem är grindens. Resten är att TONGA:s egen rad i samma
   * batch flyttade HENNES deadline framåt: med det färska fixet (09:11:47,
   * 1165 m) ligger deadlinen på 09:12:33,5, medan avfyrningen 09:12:06,7
   * vilade på ett 80 s gammalt fix vars deadline hade förfallit. Grinden lät
   * alltså den färskare fysiken gälla i stället för den föråldrade — och
   * varningen gick ändå ut 7,1 min före hennes förväntade ankomst.
   *
   * MÄTT SPRÄNGRADIE (isolerat träd mot git HEAD, probe över samtliga 18
   * korpusar + fältkorpusen, 367 avfyrningar i BÅDA träden — 0 tillkomna,
   * 0 borttagna): exakt TVÅ avfyrningar rör sig.
   *   • fält Stridsbergsbron#2: ledande BALTIC JONGLEUR/northbound →
   *     TONGA/southbound — det ledarbyte fyndet handlar om, och samma utfall
   *     som fältloggens egen rad.
   *   • 20260804-both-21h Stridsbergsbron#28: avfyras 150 ms senare (nästa
   *     post i samma batch). Ledande BLADE, riktning northbound, eta 14,
   *     vessel_count 3 och avstånd 1495 m är IDENTISKA före/efter.
   * De två fall K20a-projektionen fördärvade rörs INTE alls och behåller sina
   * rådataverifierat rätta ledare: 20260525 Stridsbergsbron#7 (MARIANNE) föll
   * på villkor (2) — ren aisstream-trafik, närmaste grannobservation ligger
   * över 8 s bort, alltså inget pollsvep — och 20260804-both-21h Klaffbron#27
   * (BLADE) på villkor (1), den avfyrades av en tick. runOpeningGates är
   * byte-identisk mot HEAD och npm run replay:all ger 17/17 låsta korpusar
   * mot facit.
   * @private
   * @returns {boolean} true ⇒ hoppa över avfyrningen den här utvärderingen
   */
  _leadIsUnsettled(event, members, due, firedBy, now) {
    if (firedBy !== 'fix') return false;
    if (!(this._observationGapMs <= BATCH_SETTLE_MS)) return false;
    const lead = this._leadOf(members);
    if (!lead || lead.lastSeenAt !== now) return false;
    if (due.includes(lead)) return false;
    const oldest = members.reduce(
      (max, a) => Math.max(max, Number.isFinite(a.rawAnchorMs) ? now - a.rawAnchorMs : 0),
      0,
    );
    this.logger.debug(
      `🕰️ [OPENING_BATCH_SETTLE] ${event.id}: avfyrningen skjuts till nästa utvärdering — `
      + `ledande ${lead.name || lead.mmsi} (d=${Math.round(lead.distanceM)} m) uppdaterades i `
      + 'DETTA meddelande men är inte förfallen; förfallna: '
      + `${due.map((a) => a.name || a.mmsi).join(', ')}; äldsta medlemsfix ${Math.round(oldest / 1000)} s; `
      + `lucka till förra observationen ${Math.round(this._observationGapMs)} ms (≤${BATCH_SETTLE_MS})`,
    );
    return true;
  }

  /** Samma ledarval och minutbevis för hela kortet och dess nya medlemmar. */
  _warningLeadInfo(members, now) {
    // LEDANDE BÅT = den närmast bron (rått armavstånd, se _leadOf). Tokenens
    // eta_minutes är hennes FÖRVÄNTADE ankomst (inte den pessimistiska
    // deadline-fysiken).
    const lead = this._leadOf(members);

    // B2d-INSTRUMENTET (fältprovet 42 h, 2026-08-08): hur GAMMALT var det fix
    // varningen faktiskt vilar på? Mäts på LEDANDE båten — det är hennes
    // avstånd och ETA kortet visar användaren. Åldern räknas mot RÅANKARET (se
    // _refreshArm) och vid AVFYRNINGEN, inte vid fixet: deadline-grenen kan
    // fyra långt efter det fix prognosen bygger på. Golvet 0 speglar
    // _refreshArms egen behandling av framtida ankare — en negativ "ålder" är
    // klockskev, inte ålder.
    const fixAgeMs = lead && Number.isFinite(lead.rawAnchorMs)
      ? Math.max(0, now - lead.rawAnchorMs) : null;

    // B2d-GRINDEN (fas B). Ett gammalt fix kan inte bära en ankomstsiffra.
    // Fältet: Klaffbron#32 (2026-08-07T13:46:58.924Z) lovade "om 1 minut" på
    // d=1209 m byggt på ett 854 s gammalt fix — det implicerar 39 knop. Mätt
    // över alla 17 korpusar + #18 träffar grinden 21 av 365 varningar, och
    // INGEN av dem hade en token inom ±3 min av rådatafacit: 12 var
    // verifierbart fel (17 av 21 sa "om 0 minuter" när sanningen låg 4–162 min
    // bort) och 9 gällde en ankomst som aldrig skedde. -1 ("okänd") är alltså
    // strikt ärligare än varje siffra grenen kunde producera.
    //
    // ⚠️ ENDAST TOKENEN. `expectedArrivalMs` (och därmed fireDueMs,
    // referenceArrivalMs och konvojgrupperingen) rörs INTE — de styr NÄR
    // varningen går ut och vilka båtar som delar öppning, och en ändring där
    // flyttar hela öppningsfacit. Varningen fyras precis som förut; det är bara
    // löftet om ankomsttiden som tystnar.
    //
    // null-ledet är hängslen: en arm utan råankare har heller ingen
    // ankomstprognos (samma tidiga return i _refreshArm sätter båda), så det
    // kan i dag inte inträffa med en siffra i handen. Riktningen är ändå den
    // rätta — en ålder som inte kan bevisas färsk ska aldrig bli en siffra.
    const etaTokenStale = fixAgeMs === null || fixAgeMs > STALE_ETA_HARD_MS;
    // JEANNELLE: 575 s gammalt fix på 703 m gav noll sedan prognosen löpt
    // ut tre minuter tidigare. Efter samma mjukgräns som brotexten använder
    // får förbrukad tid bli okänd; färska nollor och positiva ETA står kvar.
    const etaTokenExpired = fixAgeMs > STALE_ETA_SOFT_MS
      && Number.isFinite(lead?.expectedArrivalMs) && lead.expectedArrivalMs < now;
    // KNIGHT: väntan vid mellanbron gör också nästa öppningstid okänd.
    // Motorns 3-knopsreserv får styra deadlines, men är inget minutlöfte i kö.
    const etaTokenWaiting = !!lead?.waitingAtBridge;
    // En tyst båt före en tidigare bro saknar passagebevis, men det är inte
    // bevis för att hon väntar. Håll isär orsakerna även i fältdiagnostiken.
    const etaTokenEarlierBridge = !!lead?.earlierBridge && fixAgeMs >= STALE_ETA_SOFT_MS;
    const etaMinutes = etaTokenStale || etaTokenExpired || etaTokenWaiting || etaTokenEarlierBridge
      ? null : this._expectedEtaMinutes(lead, now);

    return {
      lead, fixAgeMs, etaTokenExpired, etaTokenWaiting, etaTokenEarlierBridge, etaMinutes,
    };
  }

  /**
   * Välj bara kortets presentation; händelsen och dess deadlines är orörda.
   * Underlaget är en fryst kopia från _fire, aldrig senare arm-/VDS-tillstånd.
   * Äldre direkta payloads saknar mätvärden för övriga båtar: ETA och avstånd
   * blir då okända, medan namn kan slås upp av appens vanliga namncache.
   */
  selectWarningMembers(payload, mmsis) {
    const wanted = new Set(mmsis.map(String));
    const frame = this._warningSnapshots.get(payload);
    const members = frame
      ? frame.members.filter((member) => wanted.has(String(member.mmsi)))
      : mmsis.map((mmsi) => {
        const direction = Object.prototype.hasOwnProperty.call(payload.memberDirections || {}, mmsi)
          ? payload.memberDirections[mmsi] : null;
        return {
          mmsi: String(mmsi),
          routeDirection: direction === 'northbound' ? 'north' : null,
          armDirection: direction === 'southbound' ? 'south' : null,
        };
      });
    const { lead, fixAgeMs, etaMinutes } = this._warningLeadInfo(members, frame ? frame.now : payload.t);
    return {
      ...payload,
      direction: lead ? this._directionString(lead) : 'unknown',
      eventDirection: this._eventDirection(members),
      memberDirections: this._memberDirections(members),
      etaMinutes,
      vesselCount: members.length,
      leadVessel: (lead && lead.name) || null,
      leadMmsi: lead ? lead.mmsi : null,
      mmsis: members.map((member) => member.mmsi),
      distanceM: lead && Number.isFinite(lead.distanceM) ? Math.round(lead.distanceM) : null,
      fixAgeMs,
    };
  }

  /** @private */
  _fire(event, members, due, firedBy, now) {
    const snapshot = Object.freeze(members.map((arm) => Object.freeze({
      mmsi: arm.mmsi,
      name: arm.name,
      distanceM: arm.distanceM,
      rawAnchorMs: arm.rawAnchorMs,
      expectedArrivalMs: arm.expectedArrivalMs,
      waitingAtBridge: arm.waitingAtBridge,
      earlierBridge: arm.earlierBridge,
      routeDirection: arm.routeDirection,
      armDirection: arm.armDirection,
      cog: arm.cog,
      sog: arm.sog,
    })));
    const {
      lead, fixAgeMs, etaTokenExpired, etaTokenWaiting, etaTokenEarlierBridge, etaMinutes,
    } = this._warningLeadInfo(snapshot, now);

    event.firedAt = now;
    event.firedOrder = ++this._orderSeq;
    event.referenceArrivalMs = members.reduce(
      (min, a) => (Number.isFinite(a.expectedArrivalMs) && a.expectedArrivalMs < min
        ? a.expectedArrivalMs : min),
      Infinity,
    );
    if (!Number.isFinite(event.referenceArrivalMs)) event.referenceArrivalMs = null;
    for (const arm of members) {
      if (arm.warnedAt === null) {
        arm.warnedAt = now;
        this._emitCoverage(arm, event, 'fired', now);
      }
    }
    this._warningCount += 1;

    // K13b: mäts på MEDLEMSMÄNGDEN (samma lista som vesselCount och mmsis),
    // inte på ledaren. En blandriktad öppning loggas så att klassen blir
    // räknebar i fält — den var helt osynlig i fältprov 10.
    const eventDirection = this._eventDirection(members);
    if (eventDirection === 'mixed') {
      this.logger.debug(
        `🧭 [OPENING_MIXED_DIR] ${event.id}: öppningen täcker MÖTANDE båtar `
        + `(${members.length} medlemmar) — kortets direction blir 'båda' `
        + '(HÄNDELSENS riktning); ledarens egen riktning är '
        + `${lead ? this._directionString(lead) : 'unknown'} och används bara när `
        + 'eventDirection är null. S11 (2026-08-23): den persistenta '
        + 'dedup-nyckeln bro|mmsi|riktning bärs numera av memberDirections '
        + 'per medlem, med ledarens riktning som fallback',
      );
    }

    const payload = {
      t: now,
      eventId: event.id,
      bridge: event.bridge,
      direction: lead ? this._directionString(lead) : 'unknown',
      // K13b: HÄNDELSENS riktning vid sidan av ledarens (se _eventDirection).
      // SAMMA VOKABULÄR som `direction` ovan ('northbound'/'southbound'), plus
      // 'mixed' för mötande medlemmar och null för ingen uppgift — så att de
      // två riktningsfälten kan jämföras med `===`.
      // ⚠️ ADDITIVT I PAYLOADEN, INTE I KORTET (förtydligat 2026-08-21):
      // `direction` ovan är oförändrad som FÄLT — men app.js
      // (_onBridgeOpeningWarning) bygger numera kortets token ur
      // `eventDirection ?? direction`, så en 'mixed'
      // händelse visar 'båda' för användaren och ledarens riktning används
      // bara som fallback när eventDirection är null.
      // S11 (2026-08-23): den PERSISTENTA dedup-nyckeln (bro|mmsi|riktning)
      // bärs INTE LÄNGRE av ledarens riktning för samtliga medlemmar — se
      // `memberDirections` nedan. Ledarens token är fortfarande fallbacken när
      // en medlem saknar egen uppgift, och nyckeln står medvetet kvar på
      // interna ord.
      eventDirection,
      // S11 (systerställesrundan 2026-08-23): MEDLEMMARNAS EGNA RIKTNINGAR.
      //
      // VARFÖR FÄLTET FINNS: app.js bygger öppningsvarningens PERSISTENTA
      // dedupnyckel som bro|mmsi|riktning och stämplade den med `direction`
      // ovan — LEDARENS token — för SAMTLIGA medlemmar. Ledaren är närmaste
      // båt, så i en mötande konvoj fick minst en medlem en nyckel som
      // motsäger hennes egen låsta ruttriktning. Riktningsledet finns just
      // för att en U-svängares RETURPASSAGE ska kunna varnas; pekar det åt
      // fel håll ger det både MISSAD dedup (ledarbyte efter omstart ⇒ andra
      // kort för samma öppning) och FALSK dedup (medlemmens äkta returresa
      // tystas). Mätt i facit: 6 mixed-poster av 286 avfyrningar (2,1 %).
      //
      // KÄLLAN ÄR EXAKT `_eventDirection`s: den LÅSTA ruttriktningen
      // (`routeDirection || armDirection`), översatt till samma vokabulär som
      // `direction`/`eventDirection` ('northbound'/'southbound') och null när
      // medlemmen inte hunnit låsa någon riktning. INGEN parallell
      // COG-tolkning byggs här — en medlem utan låst riktning har ingen egen
      // uppgift, och app.js faller då tillbaka på ledarens token, dvs. exakt
      // dagens nyckel.
      //
      // RENT ADDITIVT: `direction`, `eventDirection`, `mmsis` och
      // `vesselCount` är byte-identiska. Nycklarna är MMSI som STRÄNG, samma
      // form som app.js `warnMembers` redan normaliserar till.
      memberDirections: this._memberDirections(members),
      etaMinutes,
      vesselCount: members.length,
      // B1 (användarbeslut 2026-07-03): namnet är antingen ett RIKTIGT namn
      // eller null — aldrig aisstreams platshållare "Unknown". app.js gör den
      // sista översättningen till 'Okänd båt', precis som för boat_near.
      leadVessel: (lead && lead.name) || null,
      leadMmsi: lead ? lead.mmsi : null,
      firedBy: firedBy === 'deadline' ? 'deadline' : 'fix',
      mmsis: members.map((a) => a.mmsi),
      distanceM: lead && Number.isFinite(lead.distanceM) ? Math.round(lead.distanceM) : null,
      // "AVFYRA SÅ SENT SOM GARANTIN TILLÅTER" är ett mätbart kontrakt: den
      // tidigaste tidpunkt varningen KUNDE ha gått ut, dvs. min över de
      // förfallna armarna av max(deadline, medlemskapets start). Grinden kan
      // då pröva att avfyrningen ligger i [dueMs, dueMs + ett tick] — en
      // regression som fyrar för tidigt ELLER som tappar tick-anropet syns
      // direkt. Utan eligibleAt-ledet hade en arm vars deadline redan
      // förfallit när hon beväpnades (eller släpptes ur en konvoj) sett ut
      // som en 15 minuter försenad avfyrning.
      dueMs: due.reduce((min, a) => {
        const earliest = Math.max(a.fireDueMs, Number.isFinite(a.eligibleAt) ? a.eligibleAt : 0);
        return earliest < min ? earliest : min;
      }, Infinity),
      // A8(iii) — SAMMA reduktion, men på den FRYSTA ursprungsdeadlinen
      // (armens fireDueMs vid beväpningen, se _arm). `dueMs` ovan är ombunden
      // två gånger: dels av att fireDueMs räknas om vid varje nytt fix, dels av
      // max()-ledet mot eligibleAt som sätts om vid varje händelseknytning
      // (nyseedning, absorption, konvojsläpp). Serien behövs för H-4:s
      // sista-påminnelse-mått per fysisk öppning: t − dueMs mäter tick-
      // rastreringen, t − originalDueMs mäter hur långt varningen vandrat från
      // den deadline anflygningen ursprungligen lovade. min över SAMMA armar
      // som dueMs, så posterna är jämförbara par för par. Talet får bli
      // NEGATIVT — ett närmare fix flyttar deadlinen bakåt, och just den
      // förskjutningen är vad mätningen vill se. RENT INSTRUMENT.
      originalDueMs: due.reduce(
        (min, a) => (Number.isFinite(a.originalDueMs) && a.originalDueMs < min
          ? a.originalDueMs : min),
        Infinity,
      ),
      // S13 (systerställesrundan 2026-08-23): ARMENS FÖRVÄNTADE ANKOMSTTID.
      //
      // VARFÖR: app.js bildar öppningspostens utgång (omstartsskyddet) ur
      // konvojfönstret plus ETA-TOKENEN. Tokenet är ett DISPLAYvärde och
      // underskattar systematiskt — det är null/-1 så snart B2d-grinden dömer
      // fixet gammalt (> STALE_ETA_HARD_MS), och det är dessutom bara
      // LEDARENS ögonblicksprognos. Mätt över alla 20 korpusar: av 288
      // varningar med passage inom 120 min hade 127 (44,1 %) ett skydd kortare
      // än den verkliga ledtiden; oskyddad svans median 10,2 min, max 67,2 min.
      // Skadan är omstartsspecifik (en levande session filtrerar bort armar
      // med warnedAt satt), och kartan är enda vakten efter en omstart.
      //
      // MAX, INTE MIN: posten skrivs med EN gemensam utgång för samtliga
      // medlemmar (skrivloopen i app.js), så skyddet måste räcka för den
      // medlem som anländer SIST — ett min-värde (= event.referenceArrivalMs)
      // hade lämnat eftersläntrarna precis lika oskyddade som i dag. Taket
      // OPENING_PERSIST_MAX_MS i app.js bär fortfarande den yttre gränsen.
      //
      // BYTE-IDENTISK I DET FRISKA ENFALLET: när fixet är färskt är
      // etaMinutes ≈ (lead.expectedArrivalMs − now)/60000, så dagens uttryck
      // och det nya sammanfaller på avrundningen när (Math.round, ≤ 30 s).
      // Fältet är RENT INSTRUMENT här — det styr ingenting i servicen.
      expectedArrivalMs: members.reduce(
        (max, a) => (Number.isFinite(a.expectedArrivalMs) && a.expectedArrivalMs > max
          ? a.expectedArrivalMs : max),
        -Infinity,
      ),
      // B2d: fixets ålder vid avfyrningen (se härledningen ovan). Fältet är
      // instrumentet BAKOM grinden — en läsare av loggen eller harnessen kan
      // alltid se VARFÖR eta_minutes blev -1, och en framtida regression som
      // släpper igenom gamla fix syns i serien innan en användare hinner se
      // den. 2 av 36 fältavfyrade varningar vilade på fix äldre än 10 min.
      fixAgeMs,
    };
    if (!Number.isFinite(payload.dueMs)) payload.dueMs = null;
    if (!Number.isFinite(payload.originalDueMs)) payload.originalDueMs = null;
    // Samma null-som-okänt-konvention som dueMs/originalDueMs: har INGEN
    // medlem en ankomstprognos bär payloaden null och app.js faller tillbaka
    // på dagens uttryck.
    if (!Number.isFinite(payload.expectedArrivalMs)) payload.expectedArrivalMs = null;

    const tag = payload.firedBy === 'deadline' ? '⏰ [OPENING_DEADLINE]' : '🌉 [BRIDGE_OPENING]';
    // ETA-DELEN SKILJER PÅ "ingen prognos" och "prognos förkastad som gammal"
    // (B2d). Utan den skillnaden går det inte att avgöra ur ett fältdygn om
    // grinden arbetade eller om ankomstmodellen tystnade av andra skäl.
    let etaReason = '';
    if (fixAgeMs !== null && fixAgeMs > STALE_ETA_HARD_MS) {
      etaReason = ` (fix ${Math.round(fixAgeMs / 1000)} s > ${Math.round(STALE_ETA_HARD_MS / 1000)} s)`;
    } else if (etaTokenExpired) {
      etaReason = ` (prognos förbrukad, fix ${Math.round(fixAgeMs / 1000)} s)`;
    } else if (etaTokenWaiting) {
      etaReason = ` (bekräftad väntan vid ${lead.waitingAtBridge})`;
    } else if (etaTokenEarlierBridge) {
      etaReason = ` (passage av ${lead.earlierBridge} obekräftad, fix ${Math.round(fixAgeMs / 1000)} s)`;
    }
    const etaText = etaMinutes !== null ? `${etaMinutes} min` : `okänd${etaReason}`;
    this.logger.log(
      `${tag} ${event.bridge}: öppningsvarning (${payload.vesselCount} båt(ar), ledande `
      + `${payload.leadVessel || 'okänt namn'} d=${payload.distanceM} m, eta=${etaText}, `
      + `${payload.direction}, utlöst av ${payload.firedBy}, `
      + `${due.length}/${members.length} förfallna)`,
    );

    if (!this._onWarning) return;
    this._warningSnapshots.set(payload, Object.freeze({ members: snapshot, now }));
    try {
      const result = this._onWarning(payload);
      // Tidigare varnade medlemmar ska behålla sitt engångsskydd, men ett
      // undertryckt kort är ingen levererad konvojvarning för NYA båtar.
      if (result?.suppressed === 'same-arrival' || result?.suppressed === 'delivery-unavailable') {
        event.deliveryUnavailable = true;
      }
    } catch (error) {
      event.deliveryUnavailable = true;
      // Svälj-fällan: en kastande callback får inte döda tick-loopen, men den
      // får inte heller försvinna tyst.
      this.logger.error(
        `[BRIDGE_OPENING] Öppningsvarning för ${event.bridge} kastade:`,
        (error && error.message) || error,
      );
    }
  }

  // ===========================================================================
  // HJÄLPARE
  // ===========================================================================

  /**
   * Diagnostiksignal: fartyget är nu täckt av en öppningsvarning. Används av
   * replay-harnessen för att skilja "varnad via egen avfyrning" från "varnad
   * via konvoj" i O1-klassificeringen. Får aldrig påverka produktlogiken.
   * @private
   */
  _emitCoverage(arm, event, reason, now) {
    if (!this._onCoverage) return;
    try {
      this._onCoverage({
        mmsi: arm.mmsi,
        bridge: arm.bridge,
        eventId: event.id,
        t: now,
        reason,
        // A8(iii): armens FRYSTA ursprungsdeadline (se _arm). Payloadens
        // originalDueMs är ett minimum över de förfallna armarna; här är den
        // per fartyg, vilket är vad H-4-mätserien behöver för att räkna
        // täckningen (fired vs absorbed) mot rätt referens.
        originalDueMs: Number.isFinite(arm.originalDueMs) ? arm.originalDueMs : null,
      });
    } catch (error) {
      this.logger.error('[BRIDGE_OPENING] onCoverage kastade:', (error && error.message) || error);
    }
  }

  /** @private */
  _armsForVessel(mmsi) {
    const out = [];
    for (const arm of this._arms.values()) {
      if (arm.mmsi === mmsi) out.push(arm);
    }
    return out;
  }

  /** @private */
  _distanceTo(vessel, bridge) {
    if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) return null;
    const d = geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
    return Number.isFinite(d) ? d : null;
  }

  /**
   * Ruttriktningen som appen låst den — ingen egen COG-tolkning.
   * @private
   * @returns {'north'|'south'|null}
   */
  _routeDirection(vessel) {
    const dir = vessel._finalTargetDirection || vessel._routeDirection;
    return dir === 'north' || dir === 'south' ? dir : null;
  }

  /**
   * Riktningstoken i boat_near-stil. app.js injicerar sin egen
   * _getDirectionString (samma semantik som boat_near-tokenen); utan
   * injektion används endast den LÅSTA ruttriktningen — vi bygger ingen
   * parallell COG-bandtolkning.
   * @private
   */
  _directionString(arm) {
    const routeDir = arm.routeDirection || arm.armDirection;
    if (this._getDirection) {
      try {
        // Samma fältnamn som app.js _getDirectionString läser, så dess
        // COG-fallback fungerar identiskt för öppningstokenen och boat_near.
        const s = this._getDirection({
          mmsi: arm.mmsi,
          _routeDirection: routeDir,
          _finalTargetDirection: null,
          cog: arm.cog,
          sog: arm.sog,
        });
        if (s === 'northbound' || s === 'southbound' || s === 'unknown') return s;
      } catch (error) {
        this.logger.error('[BRIDGE_OPENING] getDirection kastade:', (error && error.message) || error);
      }
    }
    if (routeDir === 'north') return 'northbound';
    if (routeDir === 'south') return 'southbound';
    return 'unknown';
  }

  /**
   * eta_minutes-tokenen: FÖRVÄNTAD (ej pessimistisk) återstående tid vid
   * AVFYRNINGEN. Räknas ur den frysta ankomstprognosen minus nuvarande tid —
   * inte ur arm.etaMinutes rakt av — eftersom deadline-grenen kan avfyra
   * flera minuter efter det fix prognosen byggde på. Ett rakt återbruk hade
   * gett "om 4 minuter" när fem redan gått.
   *
   * FÄRSKHETEN PRÖVAS AV ANROPAREN, inte här (B2d-grinden i _fire): den här
   * metoden räknar om tiden, den kan inte veta om FIXET är värt att räkna på.
   * @private
   */
  _expectedEtaMinutes(arm, now) {
    if (!arm || !Number.isFinite(arm.expectedArrivalMs)) return null;
    return Math.max(0, Math.round((arm.expectedArrivalMs - now) / 60000));
  }

  /**
   * K13b — HÄNDELSENS riktning, inte ledarens. (Fältprov 10, 2026-08-19.)
   *
   * `payload.direction` är och förblir LEDANDE BÅTENS token (facit nycklas på
   * den: opening-distribution.json räknar `bro:riktning` per varning). Men en
   * öppning kan täcka båtar som möts: Stridsbergsbron#2 avfyrade 09:12:03 med
   * TVÅ medlemmar — BALTIC JONGLEUR (dir = north) och TONGA (dir = south) —
   * och kortet påstod `southbound` om en händelse som var båda. Fältet gav
   * ingen läsare något sätt att se det.
   *
   * SAMMA VOKABULÄR SOM `payload.direction` (dirigentbeslut 2026-08-21). Fälten
   * heter båda "riktning" och ligger i samma objekt; om det ena talade
   * north/south och det andra northbound/southbound kunde de aldrig jämföras
   * med `===` och varje läsare hade fått bygga en egen översättning. Därför
   * lämnar den här metoden alltid appens token, aldrig armens interna kod.
   *
   * Fältet är RENT ADDITIVT och beskriver medlemsmängden:
   *   'northbound' / 'southbound' — alla medlemmar med känd riktning är eniga
   *   'mixed'                     — minst två medlemmar går åt olika håll
   *   null                        — INGEN UPPGIFT: ingen medlem har en låst
   *                                 riktning (samma null-som-okänt-konvention
   *                                 som payloadens övriga fält: etaMinutes,
   *                                 distanceM, leadVessel, dueMs,
   *                                 memberDirections, expectedArrivalMs)
   *
   * ⚠️ null ÄR INTE 'unknown'. `direction` faller tillbaka på strängen
   * 'unknown' därför att facitnyckeln alltid måste vara en sträng; händelsens
   * riktning saknar facitnyckel och följer i stället payloadens null-konvention
   * för "vi vet inte". En läsare som vill ha en riktning när eventDirection är
   * null ska falla tillbaka på `direction`.
   *
   * KÄLLAN ÄR appens LÅSTA ruttriktning (`routeDirection || armDirection`) —
   * ingen parallell COG-tolkning byggs här. Det är en SMALARE källa än
   * `_directionString`, som dessutom har en COG-fallback via det injicerade
   * `_getDirection`: en händelse där ingen medlem hunnit låsa ruttriktning kan
   * därför ha `direction: 'southbound'` (ur COG) men `eventDirection: null`.
   * Det är avsiktligt — enighet mellan medlemmar ska vila på det låsta beslutet,
   * inte på ett ögonblicks kurs. Medlemmar utan låst riktning räknas varken som
   * enighet eller oenighet; de saknar helt enkelt röst.
   *
   * MÄTT 2026-08-22 (gula batch 2, fixrundan): 0 av 440 medlemsplatser i 367
   * avfyrningar över 18 korpusar + fältdygnet 19/8 saknade låst riktning —
   * "röstlösa medlemmar" har alltså NOLL observerade fall, och ingen COG-fallback
   * byggs här förrän ett fältfall kräver det (den skulle flytta poster i
   * opening-distribution.json för en tom klass). OBS: orsaken är INTE att
   * _bridgesToArm kräver låst ruttriktning (den kräver bara targetBridge) —
   * siffran är empirisk, inte strukturell.
   * @private
   * @returns {'northbound'|'southbound'|'mixed'|null}
   */
  _eventDirection(members) {
    let seen = null;
    for (const arm of members) {
      const dir = arm.routeDirection || arm.armDirection;
      if (dir !== 'north' && dir !== 'south') continue;
      if (seen === null) seen = dir;
      else if (seen !== dir) return 'mixed';
    }
    if (seen === 'north') return 'northbound';
    if (seen === 'south') return 'southbound';
    return null;
  }

  /**
   * S11 (systerställesrundan 2026-08-23) — MEDLEMMARNAS EGNA RIKTNINGAR, per
   * MMSI, för app.js persistenta dedupnyckel bro|mmsi|riktning.
   *
   * SAMMA KÄLLA OCH SAMMA VOKABULÄR SOM `_eventDirection` (en enda sanning om
   * vad "medlemmens riktning" betyder): den LÅSTA ruttriktningen
   * `routeDirection || armDirection`, aldrig en COG-tolkning. En medlem utan
   * låst riktning får null — "ingen uppgift", precis som `_eventDirection`
   * låter henne sakna röst — och app.js faller då tillbaka på ledarens token,
   * vilket ger EXAKT dagens nyckel för den medlemmen.
   *
   * Nycklarna är MMSI som STRÄNG: app.js normaliserar redan `payload.mmsis`
   * med String() innan nyckeln byggs, så en numerisk nyckel här hade tyst
   * missat varje uppslag.
   *
   * DUBBLETTER: `members` är en armlista där varje arm är ett fartyg, men
   * skulle två armar dela mmsi vinner den SISTA — samma ordning som
   * `mmsis`-listan bär, och utan praktisk betydelse eftersom båda armarna då
   * beskriver samma båt.
   * @private
   * @returns {Object<string, 'northbound'|'southbound'|null>}
   */
  _memberDirections(members) {
    const out = {};
    for (const arm of members) {
      if (arm.mmsi === null || arm.mmsi === undefined) continue;
      const dir = arm.routeDirection || arm.armDirection;
      let token = null;
      if (dir === 'north') token = 'northbound';
      else if (dir === 'south') token = 'southbound';
      out[String(arm.mmsi)] = token;
    }
    return out;
  }

  /**
   * B1-KONTRAKTET (användarbeslut 2026-07-03), samma kedja som boat_near:
   * ett riktigt namn ur fixet, annars den PERSISTENTA namncachen, annars
   * null (app.js översätter till 'Okänd båt'). Strängen "Unknown" är
   * aisstreams platshållare — INTE ett namn — och får aldrig nå en token.
   * Returnerar null i stället för platshållaren, vilket också gör att
   * `arm.name = this._vesselName(v) || arm.name` inte kan DEGRADERA ett redan
   * känt namn när ett senare fix saknar det.
   * @private
   * @returns {string|null}
   */
  _vesselName(vessel) {
    const raw = typeof vessel.name === 'string' ? vessel.name.trim() : '';
    if (raw && raw !== 'Unknown') return raw;
    if (this._getVesselName && vessel.mmsi !== null && vessel.mmsi !== undefined) {
      try {
        const cached = this._getVesselName(String(vessel.mmsi));
        if (typeof cached === 'string' && cached.trim() && cached.trim() !== 'Unknown') {
          return cached.trim();
        }
      } catch (error) {
        this.logger.error('[BRIDGE_OPENING] getVesselName kastade:', (error && error.message) || error);
      }
    }
    return null;
  }

  /** @private */
  _secondsUntil(ms, now) {
    if (!Number.isFinite(ms)) return '∞';
    return Math.round((ms - now) / 1000);
  }
}

module.exports = BridgeOpeningService;
