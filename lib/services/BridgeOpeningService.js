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
 * TICK-DRIVEN, INTE setTimeout-PER-BÅT
 * tick() anropas från app.js BEFINTLIGA 30 s-watchdog. Metoden är idempotent
 * (två anrop i samma millisekund ger samma resultat som ett) och O(antal
 * beväpnade båtar). Skälen är replay-determinism (harnessens klocka stegas i
 * 30-sekunderschunkar) och timerhygien — servicen äger INGA egna timers.
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
} = require('../constants');
const geometry = require('../utils/geometry');

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
    this._onCoverage = typeof opts.onCoverage === 'function' ? opts.onCoverage : null;
    this._getDirection = typeof opts.getDirection === 'function' ? opts.getDirection : null;
    this._isQuayWobbler = typeof opts.isQuayWobbler === 'function' ? opts.isQuayWobbler : null;
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

    this._eventSeq = 0;
    this._warningCount = 0;
    this._destroyed = false;

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
    const mmsi = String(vessel.mmsi);
    const now = this._now();
    const touched = new Set();

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
        if (reason === 'passage') this._recordPassage(arm.bridge, arm, now);
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
    for (const name of touched) this._evaluateBridge(name, 'fix', now);
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
    this._recordPassage(bridgeName, arm, now);
    if (arm) this._disarm(arm, 'passage', now);
    this._evaluateBridge(bridgeName, 'fix', now);
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
    this._arms.clear();
    this._events.clear();
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
    };
    this._refreshArm(arm, vessel, distance, now);
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

    arm.lastSeenAt = now;
    arm.anchorMs = anchor;
    arm.rawAnchorMs = Number.isFinite(rawAnchor) ? rawAnchor : null;
    arm.distanceM = dist;
    arm.sog = Number.isFinite(vessel.sog) ? vessel.sog : null;
    arm.cog = Number.isFinite(vessel.cog) ? vessel.cog : null;
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
    const etaFireMs = arm.expectedArrivalMs - this.config.FIRE_EXPECTED_ETA_MS;

    arm.earliestArrivalMs = earliestArrivalMs;
    arm.fireDueMs = Math.min(deadlineMs, etaFireMs);
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
   * ÅTERKOMSTEN ÄR GRATIS: klockan nollställs av ETT sampel ≥
   * MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN (0,5 kn), så en båt som lägger ut
   * beväpnas igen på sitt FÖRSTA rörelsefix — med ett färskt ankare och full
   * deadline-täckning. Avväpningen kostar alltså ingen förvarning så länge hon
   * rapporterar en enda gång efter avgången.
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
  //  (2) `_stationarySince` nollas av VesselDataService redan vid sog ≥ 0,5 kn,
  //      och KAJVOBBEL överskrider det: VIRGO (265552100) hade 4 av 19
  //      kajsampel på 0,5 / 2,1 / 2,9 kn, så hennes klocka nollställdes fyra
  //      gånger och 30-minutersgrinden nåddes aldrig.
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
    return Number.isFinite(arm.lastObservedAt) && arm.lastObservedAt > arm.lastSeenAt;
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
  _evaluateBridge(bridgeName, firedBy, now) {
    const arms = [...this._arms.values()].filter((a) => a.bridge === bridgeName);
    let events = this._eventsAt(bridgeName);

    // --- (1) Släpp danglande händelse-id:n --------------------------------
    const liveIds = new Set(events.map((e) => e.id));
    for (const arm of arms) {
      if (arm.eventId !== null && !liveIds.has(arm.eventId)) arm.eventId = null;
    }

    // --- (1b) SLÄPP STRANDADE KONVOJARMAR ---------------------------------
    this._releaseStrandedArms(arms, now);

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

    // --- (3) Knyt lösa armar till RÄTT öppning ----------------------------
    events = this._bindLooseArms(arms, events, bridgeName, now);

    // --- (3b) U9: RÄDDNINGSVENTILEN --------------------------------------
    // Kör EFTER bindningen så att en arm som absorberas när hennes egen
    // deadline redan förfallit räddas i SAMMA utvärdering — täckningen får
    // aldrig kosta en enda tick av förvarning. Släpptes någon arm binds hon om
    // direkt (hon är lös nu) och kan avfyra i steg 4 nedan.
    if (this._rescueCoveredArms(arms, events, now)) {
      events = this._bindLooseArms(arms, events, bridgeName, now);
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
        && !this._hasUnappliedObservation(a));
      if (members.length === 0) continue;
      const unwarned = members.filter((a) => a.warnedAt === null);
      if (unwarned.length === 0) continue;
      const due = unwarned.filter((a) => Number.isFinite(a.fireDueMs) && a.fireDueMs <= now);
      if (due.length === 0) continue;
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
  _bindLooseArms(arms, events, bridgeName, now) {
    for (const arm of arms) {
      if (arm.eventId !== null || arm.warnedAt !== null) continue;
      // Bara en AVFYRAD händelse kan ABSORBERA (dess varning är det som täcker
      // den nya båten). En händelse som fått en passage utan att någonsin
      // avfyra är förbrukad och får inte hålla nya armar som gisslan.
      const host = events.find((e) => !arm.releasedFrom.has(e.id)
        && this._belongsToEvent(arm, e)
        && (e.firedAt !== null || e.lastPassageAt === null));
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
        : events.find((e) => !arm.releasedFrom.has(e.id)
          && e.firedAt !== null && e.lastPassageAt === null);
      const bound = host || wideHost;
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
        arm.coveredBeyondWindow = wideHost !== null;
        arm.coverUntilMs = Math.max(
          bound.firedAt,
          Number.isFinite(bound.referenceArrivalMs) ? bound.referenceArrivalMs : 0,
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
   * öppning") passerat och armen FORTFARANDE är beväpnad, har öppningen
   * bevisligen gått utan henne. Armen släpps då tillbaka som lös och får en
   * egen händelse — och därmed en egen varning för sin egen öppning.
   *
   * Gäller ENDAST absorberade armar. En arm som var medlem när varningen gick
   * ut räknades i vessel_count och ÄR varnad; att varna om henne hade varit
   * en dubblett, inte en räddad öppning.
   * @private
   */
  _releaseStrandedArms(arms, now) {
    for (const arm of arms) {
      if (arm.absorbedAt === null || !Number.isFinite(arm.coverUntilMs)) continue;
      if (now <= arm.coverUntilMs) continue;
      this.logger.debug(
        `🔁 [OPENING_RECOVER] ${arm.mmsi} (${arm.name || 'okänt namn'}): konvojtäckningen vid ${arm.bridge} `
        + `löpte ut (${arm.eventId}) men båten är kvar beväpnad d=`
        + `${Number.isFinite(arm.distanceM) ? Math.round(arm.distanceM) : '?'} m — `
        + 'prövas som EGEN öppning',
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
    }
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
    return Math.abs(arm.expectedArrivalMs - event.referenceArrivalMs)
      <= this.config.CONVOY_WINDOW_MS;
  }

  /**
   * Bokför en målbropassage på den öppna händelsen — men BARA när det
   * passerande fartyget faktiskt är medlem i den. En passage av en båt som
   * hör till en annan (eller ingen) öppning säger ingenting om den här
   * händelsen och får inte spärra dess avfyrning.
   * @private
   */
  _recordPassage(bridgeName, arm, now) {
    if (!arm || arm.eventId === null) return;
    const event = this._eventsAt(bridgeName).find((e) => e.id === arm.eventId);
    if (!event) return;
    event.lastPassageAt = now;
    // Referensankomsten blir den FÖRSTA faktiska passagetiden — konvojfönstret
    // mäts mot den (dig9 klustrar passager, inte prognoser). Den skjuts INTE
    // fram av varje ny passage: gjorde den det gled absorptionsfönstret
    // framåt i all oändlighet och en efterföljande, helt separat öppning kunde
    // sväljas av samma händelse (ASPEN→ELFKUNGEN @ Klaffbron 2026-07-14).
    if (event.firstPassageAt === null) {
      event.firstPassageAt = now;
      event.referenceArrivalMs = now;
      // K14 (fältprov 10, 2026-08-19): referensankomsten räknas om här — men
      // de ABSORBERADE armarnas coverUntilMs gjorde det inte, och det är den
      // och bara den som styr RECOVER-vägen (_releaseStrandedArms:1251-1252).
      this._rebaseConvoyCoverage(event, now);
    }
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
   * och täckningen rebaseras på `max(firedAt, firstPassageAt) +
   * CONVOY_WINDOW_MS`. firedAt-ledet är oförändrat från originalformeln:
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
   * GOLVET FÖLJER AV KONSTRUKTIONEN: `firstPassageAt === now`, så det nya
   * värdet är alltid `now + CONVOY_WINDOW_MS` eller senare. En rebasering kan
   * därför aldrig släppa en arm i samma anrop — varje täckt båt behåller ett
   * HELT konvojfönster räknat från den verkliga öppningen.
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
      lastPassageAt: null,
      firstPassageAt: null,
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

  /** @private */
  _fire(event, members, due, firedBy, now) {
    // LEDANDE BÅT = den närmast bron. Tokenens eta_minutes är hennes
    // FÖRVÄNTADE ankomst (inte den pessimistiska deadline-fysiken).
    const lead = members.reduce(
      (best, a) => (best === null || (a.distanceM ?? Infinity) < (best.distanceM ?? Infinity) ? a : best),
      null,
    );

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
    const etaMinutes = etaTokenStale ? null : this._expectedEtaMinutes(lead, now);

    event.firedAt = now;
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
        + `(${members.length} medlemmar) — kortets direction är ledarens `
        + `(${lead ? this._directionString(lead) : 'unknown'}), händelsens är 'mixed'`,
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
      // två riktningsfälten kan jämföras med `===`. Rent additivt: `direction`
      // ovan är oförändrad, och app.js äger översättningen av 'mixed' till en
      // användartext.
      eventDirection,
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
      // B2d: fixets ålder vid avfyrningen (se härledningen ovan). Fältet är
      // instrumentet BAKOM grinden — en läsare av loggen eller harnessen kan
      // alltid se VARFÖR eta_minutes blev -1, och en framtida regression som
      // släpper igenom gamla fix syns i serien innan en användare hinner se
      // den. 2 av 36 fältavfyrade varningar vilade på fix äldre än 10 min.
      fixAgeMs,
    };
    if (!Number.isFinite(payload.dueMs)) payload.dueMs = null;
    if (!Number.isFinite(payload.originalDueMs)) payload.originalDueMs = null;

    const tag = payload.firedBy === 'deadline' ? '⏰ [OPENING_DEADLINE]' : '🌉 [BRIDGE_OPENING]';
    // ETA-DELEN SKILJER PÅ "ingen prognos" och "prognos förkastad som gammal"
    // (B2d). Utan den skillnaden går det inte att avgöra ur ett fältdygn om
    // grinden arbetade eller om ankomstmodellen tystnade av andra skäl.
    const etaText = etaMinutes !== null ? `${etaMinutes} min`
      : `okänd${fixAgeMs !== null && fixAgeMs > STALE_ETA_HARD_MS
        ? ` (fix ${Math.round(fixAgeMs / 1000)} s > ${Math.round(STALE_ETA_HARD_MS / 1000)} s)` : ''}`;
    this.logger.log(
      `${tag} ${event.bridge}: öppningsvarning (${payload.vesselCount} båt(ar), ledande `
      + `${payload.leadVessel || 'okänt namn'} d=${payload.distanceM} m, eta=${etaText}, `
      + `${payload.direction}, utlöst av ${payload.firedBy}, `
      + `${due.length}/${members.length} förfallna)`,
    );

    if (!this._onWarning) return;
    try {
      this._onWarning(payload);
    } catch (error) {
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
   *                                 distanceM, leadVessel, dueMs)
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
