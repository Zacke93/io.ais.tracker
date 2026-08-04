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
 *  b) DEADLINE-MOTORN ("äggklockan"). Per beväpnad båt beräknas TIDIGAST
 *     MÖJLIGA ankomst pessimistiskt (avstånd / BRIDGE_OPENING.
 *     DEADLINE_MAX_SPEED_KN, mätt från FIXETS tid). Varningen avfyras SENAST
 *     vid tidigast_ankomst − WARNING_LEAD_MS, även i total radiotystnad.
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
 * _hasMovementProof, _moored, _routeDirection, _finalTargetDirection,
 * passedAt, etaMinutes) och bygger ingen parallell sanning om dem.
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
} = require('../constants');
const geometry = require('../utils/geometry');

// Knop → m/s. Samma faktor som resten av kodbasen (1 kn = 1852/3600 m/s).
const KNOTS_TO_MS = 0.514444;

const NOOP = () => {};

class BridgeOpeningService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.logger] - { log, error, debug } (app-instansen i drift)
   * @param {Function} [options.onWarning] - callback(payload) vid avfyrning
   * @param {Function} [options.onCoverage] - callback({mmsi,bridge,eventId,t,reason})
   *   varje gång ett fartyg blir TÄCKT av en öppningsvarning: 'fired' när
   *   varningen gick ut med båten som medlem, 'absorbed' när hon anslöt till
   *   en redan avfyrad öppning (konvojen). Diagnostik för O1-klassificeringen
   *   — påverkar ingen produktlogik.
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

    // 2) BEVÄPNING / UPPDATERING mot fartygets målbro OCH — om den ligger
    //    inom horisonten — nästa målbro i samma färdriktning.
    for (const bridgeName of this._bridgesToArm(vessel)) {
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
      fireDueMs: Infinity,
      expectedArrivalMs: null,
      warnedAt: null,
      eventId: null,
      // Sattes warnedAt av en KONVOJABSORPTION (armen anslöt till en redan
      // avfyrad öppning) — och i så fall hur länge den täckningen gäller.
      // Se _releaseStrandedArms.
      absorbedAt: null,
      coverUntilMs: null,
      // När armen blev valbar för sin NUVARANDE händelse. Avfyrningen kan
      // aldrig ske före max(fireDueMs, eligibleAt) — grinden mäter mot den
      // summan, annars såg en arm vars deadline redan förfallit vid
      // beväpningen (eller vid ett konvojsläpp) ut som en försenad avfyrning.
      eligibleAt: now,
      // Händelser armen redan SLÄPPTS från. Utan spärren knöts hon direkt in
      // i samma avfyrade händelse igen (konvojkriteriet är ju fortfarande
      // uppfyllt), släpptes nästa utvärdering, och snurrade — hon fick aldrig
      // sin egen öppning.
      releasedFrom: new Set(),
    };
    this._refreshArm(arm, vessel, distance, now);
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
    //     ANDRA BENET är geometriskt och fångar den BAKÅTDATERADE passagen:
    //     vid gap-flush ankras korsningen i det förflutna, ibland före
    //     armedAt, och tidsbenet blir då aldrig sant. Ligger bron bakom
    //     fartyget OCH har en registrerad passage är anflygningen slut.
    const passedAt = vessel.passedAt && vessel.passedAt[arm.bridge];
    if (Number.isFinite(passedAt) && passedAt > arm.armedAt) return 'passage';
    // GEOMETRISKT BEN, utan krav på registrerad passage: appen ankrar
    // målbropassagen i en SENARE del av samma meddelande än öppningslagret
    // körs (och ibland via ett svep som aldrig når notePassage), så tidsbenet
    // ovan kan vara blint. Ligger bron bakom fartyget i hennes färdriktning
    // ÄR anflygningen över. En VÄNTANDE båt kan aldrig träffas: hon ligger per
    // definition på anflygningssidan (218023240 @ Stridsbergsbron 2026-07-14
    // 13:20 — 924 m på fel sida, arm kvar, varning 19 s efter passagen).
    if (this._bridgeIsBehind(vessel, arm.bridge)) return 'passage';

    // (1b) HYSTERESRELEASE. Låg tidigare i beväpningsloopen och prövades då
    //      BARA för broar i _bridgesToArm — en arm vars fartyg tappade sin
    //      målbro (targetBridge = null) uppdaterades aldrig mer och fyrade
    //      till slut på ett fryst avstånd, flera kilometer fel. Avståndet
    //      här är räknat ur DETTA fix mot ARMENS bro.
    if (Number.isFinite(currentDistance)
        && currentDistance > this.config.ARM_RELEASE_DISTANCE_M) {
      return 'out_of_range';
    }

    // (2) U-SVÄNG. Riktningsreversalen ägs av appens Fix D-debounce och
    //     korsningsbeviset (_routeDirection/_finalTargetDirection). Vi läser
    //     bara resultatet — ingen egen U-svängsdetektering.
    const dir = this._routeDirection(vessel);
    if (arm.armDirection && dir && dir !== arm.armDirection) return 'uturn';

    // (3) FÖRTÖJNINGSEVIDENS LÅNGT UT. Innanför DISARM_MOORED_MIN_DISTANCE_M
    //     är ett stopp normalfallet för en öppning (båten VÄNTAR) och får
    //     aldrig avväpna — dig10: 28 av 45 stopp ≥5 min som ÄNDÅ följdes av
    //     passage låg under 600 m, och bandet 600–800 m är tomt.
    const distance = Number.isFinite(currentDistance) ? currentDistance : arm.distanceM;
    if (vessel._moored === true
        && Number.isFinite(distance)
        && distance > this.config.DISARM_MOORED_MIN_DISTANCE_M) {
      return 'moored';
    }

    return null;
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
    // PER ARM, INTE PER KLUMP. Tidigare knöts ALLA lösa armar villkorslöst in
    // i den enda händelsen så länge den ännu inte avfyrat, och dig9:s
    // konvojkriterium prövades bara mot en redan avfyrad händelse. Följden var
    // exakt produktprincipens värsta fall: en snabb båt 800 m ut (ankomst om
    // 4 min) drog med sig en långsam båt 2400 m ut (ankomst om 26 min) in i
    // SIN varning, satte warnedAt på henne — och den långsammas öppning blev
    // ALDRIG varnad. Nu prövas varje arm för sig, och en arm som inte hör till
    // någon befintlig öppning får en EGEN händelse.
    //
    // ENDAST OVARNADE armar knyts. En arm som redan fått sin varning och sedan
    // förlorat sin händelse blir FÖRÄLDRALÖS och lämnas utanför: knöts den in
    // i nästa händelse drog hon med sig sin egen passage dit, och passagen
    // spärrade då avfyrningen för en HELT ANNAN båts öppning (ELFKUNGEN
    // @Klaffbron 2026-07-08 10:20 blockerades av SOLANDE:s passage 10:06:42).
    for (const arm of arms) {
      if (arm.eventId !== null || arm.warnedAt !== null) continue;
      // Bara en AVFYRAD händelse kan ABSORBERA (dess varning är det som täcker
      // den nya båten). En händelse som fått en passage utan att någonsin
      // avfyra är förbrukad och får inte hålla nya armar som gisslan.
      const host = events.find((e) => !arm.releasedFrom.has(e.id)
        && this._belongsToEvent(arm, e)
        && (e.firedAt !== null || e.lastPassageAt === null));
      if (!host) {
        const fresh = this._openEvent(bridgeName, now, arm);
        events.push(fresh);
        arm.eventId = fresh.id;
        arm.eligibleAt = now;
        continue;
      }
      arm.eventId = host.id;
      arm.eligibleAt = now;
      if (host.firedAt !== null) {
        // Absorberad av en redan avfyrad varning ⇒ räknas som varnad, så den
        // aldrig kan seeda en andra varning för samma öppning ("en sändande
        // båt i konvoj täcker sina radiotysta grannar"). Täckningen är dock
        // TIDSBEGRÄNSAD — se _releaseStrandedArms.
        arm.warnedAt = host.firedAt;
        arm.absorbedAt = now;
        arm.coverUntilMs = Math.max(
          host.firedAt,
          Number.isFinite(host.referenceArrivalMs) ? host.referenceArrivalMs : 0,
        ) + this.config.CONVOY_WINDOW_MS;
        this.logger.debug(
          `🌉 [BRIDGE_OPENING] ${arm.mmsi} (${arm.name || 'okänt namn'}): absorberad av öppning `
          + `${host.id} vid ${bridgeName} (konvoj, täckt t.o.m. ${new Date(arm.coverUntilMs).toISOString()})`,
        );
        this._emitCoverage(arm, host, 'absorbed', now);
      }
    }

    this._storeEvents(bridgeName, events, now);

    // --- (4) Avfyrning -----------------------------------------------------
    // En händelse avfyrar EN gång, och ALDRIG efter att någon medlem passerat
    // (det vore en varning om en öppning som redan skett — WARN-invarianten).
    for (const event of events) {
      if (event.firedAt !== null || event.lastPassageAt !== null) continue;
      const members = arms.filter((a) => a.eventId === event.id);
      if (members.length === 0) continue;
      const unwarned = members.filter((a) => a.warnedAt === null);
      if (unwarned.length === 0) continue;
      const due = unwarned.filter((a) => Number.isFinite(a.fireDueMs) && a.fireDueMs <= now);
      if (due.length === 0) continue;
      this._fire(event, members, due, firedBy, now);
    }
  }

  /**
   * Skriv tillbaka händelselistan, med tak mot patologisk tillväxt.
   * @private
   */
  _storeEvents(bridgeName, events, now) {
    let list = events;
    if (list.length > this.config.MAX_EVENTS_PER_BRIDGE) {
      // Släpp de äldsta FÖRBRUKADE först; händelser med väntande armar sist.
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
      arm.eventId = null;
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
    const etaMinutes = this._expectedEtaMinutes(lead, now);

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

    const payload = {
      t: now,
      eventId: event.id,
      bridge: event.bridge,
      direction: lead ? this._directionString(lead) : 'unknown',
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
    };
    if (!Number.isFinite(payload.dueMs)) payload.dueMs = null;

    const tag = payload.firedBy === 'deadline' ? '⏰ [OPENING_DEADLINE]' : '🌉 [BRIDGE_OPENING]';
    this.logger.log(
      `${tag} ${event.bridge}: öppningsvarning (${payload.vesselCount} båt(ar), ledande `
      + `${payload.leadVessel || 'okänt namn'} d=${payload.distanceM} m, eta=${etaMinutes === null ? 'okänd' : `${etaMinutes} min`}, `
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
        mmsi: arm.mmsi, bridge: arm.bridge, eventId: event.id, t: now, reason,
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
   * @private
   */
  _expectedEtaMinutes(arm, now) {
    if (!arm || !Number.isFinite(arm.expectedArrivalMs)) return null;
    return Math.max(0, Math.round((arm.expectedArrivalMs - now) / 60000));
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
