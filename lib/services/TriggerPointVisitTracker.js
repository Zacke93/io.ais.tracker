'use strict';

const {
  BRIDGES, TRIGGER_POINTS, UI_CONSTANTS, AIS_CONFIG, UNDER_BRIDGE_CROSS_PROOF_JITTER_M, MOORING_DETECTION,
  BRIDGE_OPENING,
} = require('../constants');
const geometry = require('../utils/geometry');
const GPSJumpAnalyzer = require('../utils/GPSJumpAnalyzer');

const POINTS = new Map([...Object.values(BRIDGES), ...Object.values(TRIGGER_POINTS)].map((point) => [point.name, point]));
// U14 gäller broar: bara en bro har en linje att passera tillbaka över och en
// passagebokföring (lastPassedBridge/passedAt). Kanalinfarten följer besöksregeln som förut.
const BRIDGE_NAMES = new Set(Object.values(BRIDGES).map((bridge) => bridge.name));
const DEPARTED_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 2048;

// U14-revisionen (granskningen 2026-11-04): returen är bevisad först när båten
// ligger tydligt på ankomstsidan, minst RETURN_CLEAR_M från brolinjen.
// HÄRLEDNING: appen räknar två stilla fixar som ligger under
// UNDER_BRIDGE_CROSS_PROOF_JITTER_M (60 m) isär som GPS-brus. En båt som
// ligger på linjen kan alltså synas upp till halva den sträckan (30 m) åt
// vardera hållet. Stillaliggarens multipath (20–80 m) stängs dessutom ute av
// kravet att båten är under gång mot ankomstsidan (RETURN_MIN_SOG_KN och
// kursens sida).
const RETURN_CLEAR_M = UNDER_BRIDGE_CROSS_PROOF_JITTER_M / 2;
// Samma fartgräns som appens rörelsebevis (MOVEMENT_PROOF_SOG_KN, 0,5 kn).
const RETURN_MIN_SOG_KN = MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN;
// U14-revisionen 3: vid gles AIS räcker en fix PÅ linjen (inom ±10 m) bara
// när båten går i transitfart. U37 del 1 (2026-11-16): i transitfart räcker
// korsningsfixen entydigt bortom linjen också vid tät AIS. Gränsen är appens befintliga transitbevis,
// medianfarten för en äkta anflygning som ledde till passage (3,13 kn,
// BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN). En båt som bromsar in för att
// vänta vid linjen (omgranskningens svep: 0,6–1,5 kn) ligger en faktor två
// under; en båt i 3–5 kn vid linjen är igenom bron på några sekunder.
const RETURN_TRANSIT_SOG_KN = BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN;
// U14-revisionen 4 (omgranskning 2, 2026-11-07): vid gles AIS räcker EN fix
// entydigt på ankomstsidan (gles-korsning) bara när båten rör sig i nuet.
// En väntande båt vars AIS rapporterar 0,5–1 kn och slumpad kurs kunde annars
// få en falsk "har precis passerat" av ±15 m brus. Gränsen är appens egen för
// rörelse i nuet vid ett korsningsbevis: RE_CROSS i VesselDataService ("Fix
// D-tröskeln för finit fart", sog ≥ 2,0) och C2-kravet i
// _triggerBoatNearFlowForBridge (movingNow, sog ≥ 2,0). Saknas fart gäller
// RE_CROSS:s andra ben: segmentet ska vara klart bortom GPS-bruset (100 m).
const RETURN_SPARSE_MOVING_SOG_KN = 2.0;
const RETURN_SPARSE_NO_SOG_SEGMENT_M = 100;
// U37 del 1, granskningen A1: korsningssegmentet får gå högst 1,5 gånger den
// rapporterade farten plus 0,5 m/s (se crossingMatchesSpeed).
const RETURN_SEGMENT_SPEED_FACTOR = 1.5;
const RETURN_SEGMENT_SPEED_SLACK_MS = 0.5;
// Granskningens andra varv (B1): segmentet får dessutom vara högst 15 m längre
// än farten medger, oavsett tiden mellan positionerna.
const RETURN_SEGMENT_EXCESS_MAX_M = 15;
const KN_TO_MS = 0.514444;

// U46 (dirigentens beslut 2026-11-17, registerposten BN1-BOXKANT): utfärd vid
// de två ytterpunkterna. Den yttre sidan i samma tecken som
// geometry.decisiveBridgeSide (kanalaxelns projektion): norr om Stallbackabron
// (+1) och sydväst om Kanalinfarten (−1). Boxens östkant (12,32) ligger 140 m
// öster om Stallbackabron, så en nordgående båt lämnar ofta boxen 300–500 m
// norr om bron, före fullbordad-resa-latituden 58,3125 (VISTEN: sista fix
// 267 m norr i 7,6 kn; PRICKBJORN i fältet 13/11: 288 m norr i 10,1 kn).
const OUTER_SIDE = new Map([
  [BRIDGES.stallbackabron.name, 1],
  [TRIGGER_POINTS.kanalinfarten.name, -1],
]);
// Minst 50 m utåt längs kanalaxeln, samma 50 m som utfärdsregeln efter en
// belagd passage (departedAfterPassage).
const OUTWARD_MIN_GAIN_M = 50;
// Rörelse i nuet: appens gräns vid ett korsningsbevis (RE_CROSS, C2, U14:s
// gles-korsning). En båt som guppar eller ligger och väntar rör sig inte så.
const OUTWARD_MIN_SOG_KN = RETURN_SPARSE_MOVING_SOG_KN;
// Utfärden bekräftas av tystnad: nästa rena fix kommer tidigast så här långt
// efter utåtfixen (fixklockan). I minst 2 kn är båten förbi 350 m efter högst
// (350 − d)/v < 6 min om hon fortsätter utåt, och 10 min är appens gräns för
// när en position inte längre är aktuell (STALE_ETA_HARD_THRESHOLD_MS).
const OUTWARD_SILENCE_MS = UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS;

// U51 (dirigentens beslut 2026-11-17, ägarfrågan F8 alternativ (c)): en båt som
// legat förtöjd minst 2 h vid en ytterpunkt får ett nytt besök när hon lägger ut.
// Bara ytterpunkterna; i banken och fältet ligger alla förtöjningar på 2 h eller
// mer inom 350 m från en ytterpunkt vid Kanalinfarten, på den yttre sidan
// (lotskajen 70–150 m och ELFKUNGENs kaj 290 m från punktens linje).
const MOORED_DEPARTURE_POINTS = new Set([BRIDGES.stallbackabron.name, TRIGGER_POINTS.kanalinfarten.name]);
// Förtöjningsbelägget återanvänder appens förtöjningsmått: en fix är stilla när
// AIS navstatus säger förtöjd/ankrad (MOORED_NAV_STATUSES) eller farten ligger
// under STATIONARY_SOG_KN (0,3 kn), och utan fartgivare när den ligger inom
// NULL_SOG_STILL_RADIUS_M från stillhetsankaret. Alla stilla fixar ska ligga
// inom NULL_SOG_STILL_RADIUS_M (40 m) från ankaret, och 2 h är appens egen
// gräns mellan väntan och förtöjning (MAX_STATIONARY_WAIT_MS, lager 5).
const MOORED_STILL_RADIUS_M = MOORING_DETECTION.NULL_SOG_STILL_RADIUS_M;
const MOORED_MIN_MS = MOORING_DETECTION.MAX_STATIONARY_WAIT_MS;
// Glappet mellan två stilla fixar får vara högst 60 min, annars är det tystnad
// och inte ett belägg. Längsta glapp i en förtöjning vid Kanalinfarten i banken
// och fältet är 54 min (AISHub levererar en kajliggares Class B-fixar glest).
const MOORED_MAX_GAP_MS = 60 * 60 * 1000;
// Avgången är belagd när båten i transitfart är högst 50 m från punktens linje
// (eller förbi den) och har gått minst 50 m mot linjen från ankaret. Ingen
// kajplats i banken ligger närmare Kanalinfartens linje än 70 m (CAPELLA), så
// ett byte av kajplats når inte bandet; lotskajens båtar som går in i kanalen
// passerar det (PRICKBJORN 13/11: 36 m från linjen i 4,6 kn).
const MOORED_DEPARTURE_LINE_M = 50;
const MOORED_DEPARTURE_PROGRESS_M = MOORING_DETECTION.MOVEMENT_PROOF_NET_M;

/**
 * U37 del 1, granskningen A1 (2026-11-16): korsningssegmentet ska vara möjligt
 * att färdas i den rapporterade farten. En ensam GPS-utliggare 15–25 m förbi
 * linjen, som grinden släpper igenom och som passagelogiken bokför bron i,
 * flyttar fixen 45–55 m på 10 s (16–21 kn) medan farten säger 3,5–4 kn; utan
 * kravet blev den en falsk returnotis (granskarens svep: 13 falska mot basens
 * 5 på 360 banor). Marginalen 1,5 × farten + 0,5 m/s rymmer GPS-brus och en
 * båt som accelererar genom bron (F15: 61 m på 24 s = 4,9 kn mot rapporterade
 * 5,8 kn). Granskningens andra varv (B1): kvoten växer med tiden mellan
 * positionerna, så vid Class B-kadens 20–30 s rymdes en utliggare 12–20 m förbi
 * linjen (8 falska returer mot basens 0 på 960 banor). Segmentet får därför
 * också vara högst RETURN_SEGMENT_EXCESS_MAX_M (15 m) längre än farten
 * medger, oavsett kadens. Ett längre segment släpps inte direkt utan vid nästa
 * position, som på basen.
 * @param {{segmentM: number, fromFixTs: number}} crossing
 * @param {number} fixTs - korsningsfixens tid
 * @param {number} sogKn - rapporterad fart
 * @returns {boolean}
 */
function crossingMatchesSpeed(crossing, fixTs, sogKn) {
  const dtS = (fixTs - crossing.fromFixTs) / 1000;
  if (!(dtS > 0) || !Number.isFinite(crossing.segmentM) || !Number.isFinite(sogKn)) return false;
  const sogMs = sogKn * KN_TO_MS;
  return crossing.segmentM / dtS <= RETURN_SEGMENT_SPEED_FACTOR * sogMs + RETURN_SEGMENT_SPEED_SLACK_MS
    && crossing.segmentM - sogMs * dtS <= RETURN_SEGMENT_EXCESS_MAX_M;
}

/**
 * U37 del 1, villkor 7d: korsningsfixen själv bevisar returen. Alla krav måste
 * hålla; tillsammans betyder de "en verklig korsning i den fart båten
 * rapporterar", och vart och ett stänger ett känt falskt släpp:
 *  - transitfart (RETURN_TRANSIT_SOG_KN, 3,13 kn): en båt som bromsar in eller
 *    väntar vid linjen (0,5–1,5 kn) släpps inte;
 *  - kursen mot ankomstsidan och vänd ruttriktning (villkor 5–6, prövas före):
 *    en båt på väg tillbaka bort från bron släpps inte;
 *  - korsningen noterad i just den här fixen och det är första fixen på
 *    ankomstsidan: en senare fix bevisar med 7a/7b, inte med 7d;
 *  - föregående fix ENTYDIGT på bortre sidan: ett guppande över linjen inom
 *    bruset (±10 m) är ingen korsning;
 *  - fixen ENTYDIGT (över 10 m) på ankomstsidan: en båt som bromsar och
 *    stannar eller vänder 3–8 m förbi linjen, under bron, gav falska returer
 *    (motfallssvepet, 5 av 240);
 *  - bokföringen i segmentet (bookedInSegment, prövas av anroparen): passage-
 *    logikens förtida bokföring medan båten väntar räknas inte;
 *  - segmentet mot farten (crossingMatchesSpeed, högst 1,5 × farten
 *    + 0,5 m/s): en GPS-utliggare förbi linjen hoppar fortare än båten går;
 *  - taket 15 m (RETURN_SEGMENT_EXCESS_MAX_M): vid 20–30 s kadens ryms annars
 *    en utliggare 12–20 m förbi linjen inom kvoten.
 * @private
 */
function isTransitCrossingFix({
  crossing, segment, sample, side, farSign, sog, transit,
}) {
  return transit && Boolean(crossing) && crossing.arrivalFixes === 1
    && crossing.lastFixTs === sample.fixTs
    && Boolean(segment) && segment.fixTs === sample.fixTs && segment.fromDecisive
    && side === -farSign
    && crossingMatchesSpeed(crossing, sample.fixTs, sog);
}

/**
 * Färdriktningens tecken längs kanalaxeln, i samma tecken som
 * geometry.decisiveBridgeSide: norrut ökar projektionen (+1), söderut (−1).
 * Bara appens låsta ruttriktning räknas. Den vänder först på bekräftad vändning
 * (Fix D, NEW_JOURNEY eller korsningsbevis), så en båt som guppar eller ligger
 * still vid bron kan inte vända den.
 * @param {Object} vessel
 * @returns {number} +1, −1 eller 0 (okänd)
 */
function routeSign(vessel) {
  if (vessel?._routeDirection === 'north') return 1;
  if (vessel?._routeDirection === 'south') return -1;
  return 0;
}

/**
 * N6: ligger bron bakom båten? Positionens entydiga sida (`side`, ±1) är den
 * sida färdriktningen (`travelSign`) leder till, och den rapporterade kursen
 * pekar inte tillbaka mot bron. Saknas kursen (AIS 360) avgör färdriktningen
 * ensam.
 *
 * Granskningen av N6 (H1, dirigentens beslut U44): färdriktningen och kursen
 * räcker inte för en båt som DRIVER. En båt på tillfartssidan som driver bort
 * från bron i 0,8–1,5 kn (ström, manövrering i kön) har kurs bort och ofta ett
 * ruttlås som driften själv satt, men hon har inte passerat bron. Fick hon
 * bortre sidan på sin egen sida blev hennes enda passage senare ett
 * "retursläpp": två notiser för en passage (granskarens driftsvep 44 av 60
 * världar; HALIFAX i 20260708-21h). Bron räknas därför som bakom båten bara när
 * det är belagt i nuet: båten rör sig i minst RETURN_SPARSE_MOVING_SOG_KN
 * (2,0 kn, appens gräns för rörelse i nuet vid ett korsningsbevis, samma som
 * RE_CROSS och returens gles-korsning), eller föregående position låg entydigt
 * på andra sidan linjen (korsningen skedde i segmentet till den här fixen).
 * @param {Object} vessel
 * @param {Object} point - bron
 * @param {number} side - geometry.decisiveBridgeSide för positionen (±1)
 * @param {number} travelSign - färdriktningens tecken (+1 norrut, −1 söderut, 0 okänd)
 * @returns {boolean}
 */
function isBehindInTravel(vessel, point, side, travelSign) {
  if (side === 0 || travelSign !== side) return false;
  const sog = GPSJumpAnalyzer.positionSog(vessel);
  const movingNow = sog !== null && sog >= RETURN_SPARSE_MOVING_SOG_KN;
  const crossedInSegment = Boolean(vessel.lastPosition)
    && geometry.decisiveBridgeSide(vessel.lastPosition, point) === -side;
  if (!movingNow && !crossedInSegment) return false;
  const cog = Object.prototype.hasOwnProperty.call(vessel, '_rawPositionCog') ? vessel._rawPositionCog : vessel.cog;
  return geometry.courseBridgeSide(cog, point) !== -side;
}

/**
 * U14-revisionen: senaste bokföringsstämpeln för just den här bron. Den sist
 * stämplade passagen (lastPassedBridge/-Time) håller bara EN bro, och när två
 * broar bokförs i samma tick (MULTI_PASSAGE_FALLBACK, glappinferensen) skriver
 * den senare över den förra. Förankringen passedAt[bro] finns kvar per bro.
 * Stämplarna jämförs bara med varandra (bokföringens egen klocka), aldrig med
 * AIS-fixens tid.
 * @param {Object} vessel
 * @param {string} pointName
 * @returns {number|null} stämpeln, eller null om bron aldrig bokförts
 */
function bookingStamp(vessel, pointName) {
  let stamp = null;
  if (vessel?.lastPassedBridge === pointName && Number.isFinite(vessel.lastPassedBridgeTime)) {
    stamp = vessel.lastPassedBridgeTime;
  }
  const anchored = vessel?.passedAt && typeof vessel.passedAt === 'object' ? vessel.passedAt[pointName] : null;
  if (Number.isFinite(anchored) && (stamp === null || anchored > stamp)) stamp = anchored;
  return stamp;
}

/**
 * Ett notifierat besök vid en bro eller Kanalinfarten varar tills faktisk utfärd och
 * återkomst observerats. Tystnad, förtöjning och ny resa är inga utfärdsbevis.
 * Två rena fixar över 350 m bekräftar utfärd; återkomst kräver högst 300 m.
 * Ingen timer eller extern livscykel äger kartan. Appen persisterar fasbyten
 * och slutligen hela snapshoten, inklusive en ännu obekräftad utfärdsfix.
 *
 * Ett annat utfärdsbevis är positionellt: en borttagning där resan är
 * fullbordad, alltså förbi sista bron och utanför kanalens utfartslatitud
 * (closeOpenVisits, helgranskningen 2026-11-03). Elimineringen sker ~300 m
 * bortom sista punkten och reentry-blocket kastar båtens AIS i 10 min, så de
 * två utfärdsfixarna kunde aldrig observeras där. Besöket blev evigt öppet,
 * och en båt som återvände dagar senare tappade sin första notis.
 *
 * U46 (dirigentens beslut 2026-11-17): vid de två ytterpunkterna är också en
 * utåtriktad transit följd av minst 10 min tystnad en utfärd
 * (_isOutwardTransitFix). Det täcker båtar som lämnar boxen före
 * utfartslatituden (PRICKBJORN 13/11: 288 m norr om Stallbackabron i 10 kn).
 *
 * U51 (dirigentens beslut 2026-11-17): vid samma punkter släpper också en belagd
 * avgång efter minst 2 h belagd förtöjning besöket (_trackMooring,
 * _isMooredDeparture). Förtöjningen är ett undantag från "förtöjning är ingen
 * utfärd" bara när den är belagd fix för fix och följs av en avgång mot kanalen.
 *
 * U14 (användarbeslut 2026-11-04): en VERKLIG passage tillbaka över en bro
 * avslutar också besöket, så att returpassagen får en egen notis (INV-5/7, en
 * notis per passage). Besöket minns vilken sida av brolinjen den notifierade
 * passagen leder till (farSign) och när båten senast setts entydigt där
 * (farSideSeenAt). Därefter följer observe varje ren fix: när båtens signerade
 * avstånd till linjen byter tecken från bortre sidan till ankomstsidan noteras
 * en korsning, med tiden interpolerad på segmentet. Ett steg tillbaka på bortre
 * sidan stryker korsningen. Släppet sker i releaseReturnPassage och kräver att
 * appen har bokfört bron igen medan båten inte låg entydigt på bortre sidan,
 * att en korsning är noterad och båten nu ligger minst 30 m ut på ankomstsidan
 * och är under gång dit, att ruttriktningen pekar tillbaka och att notisen
 * kommer högst 10 min efter den uppskattade korsningen (U21). Bara vid gles
 * AIS, när ingen bekräftande fix hinner komma inom "precis passerat"-fönstret,
 * räcker ett segment som går från entydigt bortre sidan till entydigt
 * ankomstsidan när båten rör sig i nuet (minst 2 kn), eller till linjen när
 * båten går i transitfart. I transitfart räcker korsningsfixen entydigt
 * bortom linjen också vid tät AIS (U37 del 1). En bokföring som gjordes innan korsningssegmentet
 * började (passagelogiken bokför ibland när en väntande båt når linjen, också
 * i en fix strax bortom linjen) kräver två fixar i rad entydigt på
 * ankomstsidan under gång dit. En båt som guppar eller väntar vid bron
 * uppfyller inte beviset inom appens brusmodell, inte heller när GPS-bruset
 * ger henne falska bokföringar efter en verklig vändning.
 */
class TriggerPointVisitTracker {
  constructor({ logger = null, now = () => Date.now() } = {}) {
    this._logger = logger;
    this._now = now;
    this._entries = new Map();
  }

  _key(mmsi, pointName = 'Kanalinfarten') {
    if ((typeof mmsi !== 'string' && typeof mmsi !== 'number') || !POINTS.has(pointName)) return null;
    const id = String(mmsi);
    return /^\d{9}$/.test(id) ? `${id}:${pointName}` : null;
  }

  _sample(vessel, point) {
    if (!point || !vessel || vessel._gpsJumpDetected || vessel._positionUncertain) return null;
    const distance = geometry.calculateDistance(vessel.lat, vessel.lon, point.lat, point.lon);
    if (!Number.isFinite(distance)) return null;
    const positionTs = Math.max(
      Number.isFinite(vessel.timestamp) ? vessel.timestamp : 0,
      Number.isFinite(vessel.lastPositionUpdate) ? vessel.lastPositionUpdate : 0,
    );
    const now = this._now();
    const futureMargin = AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS;
    if (positionTs <= 0 || now - positionTs > UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS
        || positionTs - now > futureMargin) return null;
    const fixTs = Number.isFinite(vessel.fixTs) ? vessel.fixTs : positionTs;
    if (fixTs < 0 || fixTs - now > futureMargin || now - fixTs > AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS) return null;
    if (vessel.fixFeed === 'aishub'
        && (!Number.isFinite(vessel.fixTs) || now - fixTs > AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS)) return null;
    return { distance, fixTs, positionTs };
  }

  holds(mmsi, pointName = 'Kanalinfarten') {
    const key = this._key(mmsi, pointName);
    return key !== null && this._entries.has(key);
  }

  _crossedPoint(entry, vessel, sample, point) {
    // Samma sex timmars historik som appens lastKnown-baserade passage-
    // fallback. Ankaret var rent/färskt när det observerades, men ska inte
    // förväxlas med aktuell AIS-hälsa. ELFKUNGENs 43 min radiogap slutar
    // 302 m bort; båda ändpunkterna är utanför, segmentet går 103 m från
    // punkten. Radien för själva återkomsten är fortfarande exakt 300 m.
    if (!Number.isFinite(entry.lastPositionTs)
        || this._now() - entry.lastPositionTs > DEPARTED_RETENTION_MS
        || !Number.isFinite(entry.lastLat) || !Number.isFinite(entry.lastLon)
        || sample.distance <= point.radius
        || (entry.lastLat - point.lat) * (vessel.lat - point.lat) >= 0) return false;
    const previousDistance = geometry.calculateDistance(entry.lastLat, entry.lastLon, point.lat, point.lon);
    return Number.isFinite(previousDistance) && previousDistance > point.radius
      && geometry.distancePointToSegmentM(
        point.lat, point.lon, entry.lastLat, entry.lastLon, vessel.lat, vessel.lon,
      ) <= point.radius;
  }

  observe(vessel, pointName = 'Kanalinfarten') {
    const point = POINTS.get(pointName);
    const key = this._key(vessel?.mmsi, pointName);
    const entry = key === null ? null : this._entries.get(key);
    const sample = entry && this._sample(vessel, point);
    if (!sample || sample.fixTs <= entry.lastFixTs) return { changed: false, reentered: false };
    // U14: kadensen mäts på appens egen klocka, alltså när fixarna faktiskt
    // når appen. AISHub levererar en gång per poll även när fixarnas egna
    // tider ligger tätare. Efter en omstart saknas förra leveranstiden, och då
    // gäller fixklockan.
    const observedAt = this._now();
    const deliveryGapMs = Number.isFinite(entry.lastObservedAt)
      ? observedAt - entry.lastObservedAt : sample.fixTs - entry.lastFixTs;
    entry.lastObservedAt = observedAt;
    const previousFix = { lat: entry.lastLat, lon: entry.lastLon, fixTs: entry.lastFixTs };
    // U46: ett utåtbevis följt av minst OUTWARD_SILENCE_MS tystnad, när första
    // fixen därefter visar att båten varit borta (_isReturnAfterSilence), är en
    // observerad utfärd. Återkomsten prövas sedan med dagens regel nedan.
    const previousOutwardFixTs = entry.outwardFixTs ?? null;
    let outwardExit = false;
    if (entry.exitedAt === null && previousOutwardFixTs !== null
        && sample.fixTs - previousOutwardFixTs >= OUTWARD_SILENCE_MS
        && this._isReturnAfterSilence(vessel, point, pointName, sample)) {
      entry.outsideFixTs = previousOutwardFixTs;
      entry.exitedAt = Math.max(observedAt, entry.startedAt);
      outwardExit = true;
      // Fältprovet ska kunna se när regeln verkar (ingen notis skickas här).
      this._info(`[TRIGGER_POINT_VISIT_OUTWARD_EXIT] ${vessel.mmsi}: ${pointName} lämnad utåt `
        + `(tyst ${Math.round((sample.fixTs - previousOutwardFixTs) / 60000)} min efter utåtfixen, nu `
        + `${Math.round(sample.distance)} m) — besöket avslutat, återkomst inom ${point.radius} m ger ny notis`);
    }
    // U51: en belagd avgång efter en belagd förtöjning är ett nytt besök.
    if (entry.exitedAt === null && this._isMooredDeparture(entry, vessel, point, pointName, sample)) {
      this._info(`[TRIGGER_POINT_VISIT_MOORED_DEPARTURE] ${vessel.mmsi}: ${pointName} — förtöjd `
        + `${Math.round((entry.moorLastTs - entry.moorSince) / 60000)} min, nu ${Math.round(sample.distance)} m från punkten `
        + `i ${GPSJumpAnalyzer.positionSog(vessel)} kn mot linjen — besöket avslutat, avgången får egen notis`);
      this._entries.delete(key);
      return { changed: true, reentered: true };
    }
    const outward = entry.exitedAt === null && this._isOutwardTransitFix(entry, vessel, point, pointName, sample);
    const crossedPoint = (entry.exitedAt !== null || entry.outsideFixTs !== null)
      && this._crossedPoint(entry, vessel, sample, point);
    // Efter en belagd passage räcker två tydliga positioner på bortre sidan:
    // båda utanför området, den senare även utanför hysteresen och minst
    // 50 m längre bort. Då tappas inte en verklig retur efter gles AIS.
    const previousDistance = geometry.calculateDistance(entry.lastLat, entry.lastLon, point.lat, point.lon);
    const departedAfterPassage = entry.exitedAt === null
      && vessel.passedBridges?.includes(pointName)
      && sample.fixTs - entry.lastFixTs <= UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS
      && sample.distance > point.radius + 50 && previousDistance > point.radius
      && sample.distance >= previousDistance + 50
      && geometry.isDecisivelyOppositeBridgeSide(
        { lat: entry.arrivalLat, lon: entry.arrivalLon }, { lat: entry.lastLat, lon: entry.lastLon }, point,
      )
      && geometry.isDecisivelyOppositeBridgeSide(
        { lat: entry.arrivalLat, lon: entry.arrivalLon }, vessel, point,
      );
    entry.lastFixTs = sample.fixTs;
    entry.lastLat = vessel.lat;
    entry.lastLon = vessel.lon;
    entry.lastPositionTs = sample.positionTs;
    // U51: föregående fixs fart (avgångsbeviset kräver rörelse i två fixar).
    entry.lastSog = GPSJumpAnalyzer.positionSog(vessel);
    // U46: beviset gäller bara den senaste rena fixen. Varje ny fix sätter
    // eller stryker det, så en båt som hörs igen i zonen (lägger till, vänder,
    // guppar) inom tystnadsgränsen behåller sitt besök.
    entry.outwardFixTs = outward ? sample.fixTs : null;
    const outwardChanged = outwardExit || entry.outwardFixTs !== previousOutwardFixTs;
    const moorChanged = entry.exitedAt === null && this._trackMooring(entry, vessel, pointName, sample);
    // U14: minns senaste rena fixen entydigt på bortre sidan. Positionen räcker
    // som bevis för att båten kom igenom: utpassagen kan ha skett i ett AIS-glapp
    // som appen aldrig bokförde (ELFKUNGEN vid Stallbackabron 13/7). Släppet
    // kräver ändå appens egen bokföring av returen. Första gången är ett fasbyte
    // som sparas; senare uppdateringar följer med nästa snapshot.
    let farSideNoted = false;
    if (entry.exitedAt === null && entry.farSign && BRIDGE_NAMES.has(pointName)) {
      farSideNoted = this._trackReturn(entry, vessel, point, pointName, sample, previousFix, deliveryGapMs);
    }
    // Andra rena utanförfixen kan samtidigt bevisa återkomst genom zonen.
    // ELFKUNGEN vid Stallbackabron: 450 m norr → 1752 m söder. Att först
    // bara markera utfärd skulle blockera den redan observerade returen.
    if (crossedPoint) {
      this._entries.delete(key);
      return { changed: true, reentered: true };
    }
    if (departedAfterPassage) {
      entry.outsideFixTs = sample.fixTs;
      entry.exitedAt = this._now();
      entry.outwardFixTs = null;
      return { changed: true, reentered: false };
    }
    if (entry.exitedAt !== null) {
      if (sample.distance <= point.radius) {
        this._entries.delete(key);
        return { changed: true, reentered: true };
      }
      if (this._now() - entry.exitedAt > DEPARTED_RETENTION_MS) {
        this._entries.delete(key);
        return { changed: true, reentered: false };
      }
    } else if (sample.distance > point.radius + 50) {
      if (entry.outsideFixTs !== null) {
        entry.exitedAt = this._now();
        entry.outwardFixTs = null;
        return { changed: true, reentered: false };
      }
      entry.outsideFixTs = sample.fixTs;
      return { changed: true, reentered: false };
    } else if (entry.outsideFixTs !== null) {
      entry.outsideFixTs = null;
      return { changed: true, reentered: false };
    }
    return { changed: farSideNoted || outwardChanged || moorChanged, reentered: false };
  }

  /**
   * U51: är fixen stilla enligt appens förtöjningsmått?
   * @private
   */
  _isStillFix(entry, vessel) {
    if (MOORING_DETECTION.MOORED_NAV_STATUSES.includes(vessel.navStatus)) return true;
    const sog = GPSJumpAnalyzer.positionSog(vessel);
    if (sog !== null) return sog < MOORING_DETECTION.STATIONARY_SOG_KN;
    return Number.isFinite(entry.moorLat)
      && geometry.calculateDistance(vessel.lat, vessel.lon, entry.moorLat, entry.moorLon) <= MOORED_STILL_RADIUS_M;
  }

  /**
   * U51: följer förtöjningsbelägget fix för fix. En stilla fix inom
   * MOORED_STILL_RADIUS_M från ankaret och högst MOORED_MAX_GAP_MS efter förra
   * stilla fixen förlänger förtöjningen; annars börjar ett nytt ankare där.
   * När förtöjningen spänner MOORED_MIN_MS (2 h) är den belagd (moorProven),
   * och det står kvar till avgången eller besökets slut: en ensam fix i fart,
   * ett byte av kajplats eller en tystnad river inte ett belagt belägg, men
   * bara en avgång över linjen (_isMooredDeparture) släpper besöket. Före
   * beviset nollställer en fix i rörelse eller utanför radien ankaret.
   * Ankarets sida av punktens linje måste vara entydig. Fälten sparas.
   * @returns {boolean} true när beviset just blev belagt (ett fasbyte)
   * @private
   */
  _trackMooring(entry, vessel, pointName, sample) {
    if (!MOORED_DEPARTURE_POINTS.has(pointName)) return false;
    const point = POINTS.get(pointName);
    const still = this._isStillFix(entry, vessel);
    const near = Number.isFinite(entry.moorLat)
      && geometry.calculateDistance(vessel.lat, vessel.lon, entry.moorLat, entry.moorLon) <= MOORED_STILL_RADIUS_M;
    if (entry.moorProven) {
      // Belägget står kvar; förtöjningens senaste stilla fix följs för loggen.
      if (still && near) entry.moorLastTs = sample.fixTs;
      return false;
    }
    if (still && near && sample.fixTs - entry.moorLastTs <= MOORED_MAX_GAP_MS) {
      entry.moorLastTs = sample.fixTs;
      if (entry.moorLastTs - entry.moorSince >= MOORED_MIN_MS) {
        entry.moorProven = true;
        return true;
      }
      return false;
    }
    const decisive = geometry.decisiveBridgeSide(vessel, point) !== 0;
    entry.moorLat = still && decisive ? vessel.lat : null;
    entry.moorLon = still && decisive ? vessel.lon : null;
    entry.moorSince = still && decisive ? sample.fixTs : null;
    entry.moorLastTs = still && decisive ? sample.fixTs : null;
    return false;
  }

  /**
   * U51: en belagd avgång efter en belagd förtöjning (moorProven). Alla krav:
   *  - båten är högst MOORED_DEPARTURE_LINE_M (50 m) från punktens linje på
   *    ankarets sida, eller på linjen, eller förbi den, och har gått minst
   *    MOORED_DEPARTURE_PROGRESS_M (50 m) mot linjen från ankaret (vid
   *    Kanalinfarten: hon har lämnat kajerna på den yttre sidan och är på väg
   *    in i kanalen; ingen kajplats ligger inom 50 m från linjen);
   *  - hon rör sig i nuet: minst 2,0 kn, föregående fix minst
   *    MOVEMENT_PROOF_SOG_KN (0,5 kn), och kursen pekar inte tillbaka mot
   *    ankarets sida;
   *  - segmentet från föregående fix är högst 10 min (U21: ingen notis för en
   *    avgång som bara antas ur ett glapp) och går att färdas i farten.
   * En båt som byter kajplats på samma sida, guppar eller ger en ensam
   * brusposition släpps inte. En sydgående kajstartare som går ut ur kanalen
   * rör sig bort från linjen (FP8 står orörd).
   * @private
   */
  _isMooredDeparture(entry, vessel, point, pointName, sample) {
    if (!MOORED_DEPARTURE_POINTS.has(pointName) || !entry.moorProven || !Number.isFinite(entry.moorLat)) return false;
    const anchor = { lat: entry.moorLat, lon: entry.moorLon };
    const anchorSide = geometry.decisiveBridgeSide(anchor, point);
    if (anchorSide === 0) return false;
    const along = anchorSide * geometry.bridgeLineOffsetM(vessel, point);
    const anchorAlong = anchorSide * geometry.bridgeLineOffsetM(anchor, point);
    if (!(along <= MOORED_DEPARTURE_LINE_M) || !(anchorAlong - along >= MOORED_DEPARTURE_PROGRESS_M)) return false;
    const sog = GPSJumpAnalyzer.positionSog(vessel);
    if (sog === null || sog < OUTWARD_MIN_SOG_KN) return false;
    const cog = Object.prototype.hasOwnProperty.call(vessel, '_rawPositionCog') ? vessel._rawPositionCog : vessel.cog;
    if (geometry.courseBridgeSide(cog, point) === anchorSide) return false;
    if (!(Number.isFinite(entry.lastSog) && entry.lastSog >= MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN)) return false;
    const dtMs = sample.fixTs - entry.lastFixTs;
    if (!(dtMs > 0) || dtMs > UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS) return false;
    const segmentM = geometry.calculateDistance(entry.lastLat, entry.lastLon, vessel.lat, vessel.lon);
    return Number.isFinite(segmentM)
      && segmentM / (dtMs / 1000) <= RETURN_SEGMENT_SPEED_FACTOR * sog * KN_TO_MS + RETURN_SEGMENT_SPEED_SLACK_MS;
  }

  /**
   * U46: visar första fixen efter tystnaden att båten har varit borta? Hon ska
   * synas utanför zonen (över radien + 50 m, samma hysteres som utfärdsregeln),
   * eller vara tillbaka på den inre sidan, eller vara på väg inåt i nuet (minst
   * OUTWARD_MIN_SOG_KN och kursen mot den inre sidan). En båt som hörs igen
   * stilla eller långsam på den yttre sidan inom zonen har inte lämnat den: hon
   * gick ut förbi punkten, lade till eller stannade, och AIS var tyst
   * (ELFKUNGEN vid kajen hade glapp på upp till 45 min). Då står besöket kvar.
   * @private
   */
  _isReturnAfterSilence(vessel, point, pointName, sample) {
    const outerSign = OUTER_SIDE.get(pointName);
    if (sample.distance > point.radius + 50) return true;
    if (geometry.decisiveBridgeSide(vessel, point) === -outerSign) return true;
    const sog = GPSJumpAnalyzer.positionSog(vessel);
    const cog = Object.prototype.hasOwnProperty.call(vessel, '_rawPositionCog') ? vessel._rawPositionCog : vessel.cog;
    return sog !== null && sog >= OUTWARD_MIN_SOG_KN && geometry.courseBridgeSide(cog, point) === -outerSign;
  }

  /**
   * U46 (dirigentens beslut 2026-11-17, alternativ (a) ur helgranskningen
   * 2026-11-03, beslutspunkt 2): är den här rena fixen en utåtriktad transit
   * vid en ytterpunkt? Alla krav måste hålla:
   *  - punkten är Kanalinfarten eller Stallbackabron (OUTER_SIDE);
   *  - fixen ligger ENTYDIGT (över 10 m) på den yttre sidan;
   *  - båten har gått minst OUTWARD_MIN_GAIN_M (50 m) utåt längs kanalaxeln
   *    (geometry.bridgeLineOffsetM) sedan besökets föregående rena fix, så att
   *    avståndet från punkten ökar på den yttre sidan;
   *  - båten rör sig i nuet: rapporterad fart minst OUTWARD_MIN_SOG_KN
   *    (2,0 kn) och en kurs som inte pekar inåt (saknas kursen avgör farten);
   *  - segmentet från föregående fix är högst STALE_ETA_HARD_THRESHOLD_MS och
   *    går att färdas i farten (högst 1,5 × farten + 0,5 m/s, samma kvot som
   *    U37:s crossingMatchesSpeed), så att en ensam GPS-utliggare utåt inte
   *    räknas.
   * Beviset stänger inget själv. observe stänger besöket först när nästa rena
   * fix kommer minst OUTWARD_SILENCE_MS (10 min) senare och visar att båten
   * varit borta (_isReturnAfterSilence); hörs båten tidigare, eller stilla på
   * den yttre sidan i zonen, gäller dagens regler för den fixen. Det skiljer en båt som lämnat boxen
   * (VISTEN, S/V REBEL, PRICKBJORN) från en som går ut förbi punkten och
   * lägger till eller vänder inom zonen (ELFKUNGEN vid sin kaj 297–305 m
   * sydväst om Kanalinfarten: nästa fix 66–84 s efter utåtparet).
   * @private
   */
  _isOutwardTransitFix(entry, vessel, point, pointName, sample) {
    const outerSign = OUTER_SIDE.get(pointName);
    if (!outerSign || !Number.isFinite(entry.lastLat) || !Number.isFinite(entry.lastLon)
        || geometry.decisiveBridgeSide(vessel, point) !== outerSign) return false;
    // Utåt längs kanalaxeln: en båt som korsar Stallbackabron mellan två fixar
    // (164 m söder → 171 m norr) har knappt ökat avståndet till punkten men
    // gått 335 m utåt.
    const gainM = outerSign * (geometry.bridgeLineOffsetM(vessel, point)
      - geometry.bridgeLineOffsetM({ lat: entry.lastLat, lon: entry.lastLon }, point));
    if (!(gainM >= OUTWARD_MIN_GAIN_M)) return false;
    const sog = GPSJumpAnalyzer.positionSog(vessel);
    if (sog === null || sog < OUTWARD_MIN_SOG_KN) return false;
    const cog = Object.prototype.hasOwnProperty.call(vessel, '_rawPositionCog') ? vessel._rawPositionCog : vessel.cog;
    if (geometry.courseBridgeSide(cog, point) === -outerSign) return false;
    const dtMs = sample.fixTs - entry.lastFixTs;
    if (!(dtMs > 0) || dtMs > UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS) return false;
    const segmentM = geometry.calculateDistance(entry.lastLat, entry.lastLon, vessel.lat, vessel.lon);
    return Number.isFinite(segmentM)
      && segmentM / (dtMs / 1000) <= RETURN_SEGMENT_SPEED_FACTOR * sog * KN_TO_MS + RETURN_SEGMENT_SPEED_SLACK_MS;
  }

  /**
   * U14: en bokföringsstämpel som är nyare än allt som absorberats på bortre
   * sidan blir returens bokföring. Fixen den först sågs i (fixklockan) avgör
   * senare om bokföringen hör till korsningssegmentet. Stämplarna jämförs bara
   * med varandra, aldrig med AIS-fixens tid.
   * @private
   */
  _captureReturnBooking(entry, stamp, fixTs) {
    if (!Number.isFinite(stamp) || stamp - this._now() > AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS
        || (Number.isFinite(entry.farSideBooking) && stamp <= entry.farSideBooking)
        || (Number.isFinite(entry.returnBookedAt) && stamp <= entry.returnBookedAt)) return;
    entry.returnBookedAt = stamp;
    entry.returnBookedFixTs = fixTs;
  }

  /**
   * U14-revisionen 4: en bokföring i en fix entydigt på bortre sidan. Den
   * absorberas (hör till den notifierade passagen eller en tidigare resa) med
   * ett undantag: när båten redan har setts på bortre sidan, ruttriktningen
   * pekar tillbaka (vändningen är bekräftad) och fixen ligger inom
   * RETURN_CLEAR_M från linjen. Då är det passagelogikens förtida bokföring av
   * returen medan båten väntar vid linjen (omgranskning 2:s P1-retur:
   * bokföringen 06:11 på 13,8 m, den verkliga korsningen 06:25). Passagelogiken
   * bokför inte igen vid den verkliga korsningen, så en absorberad bokföring
   * gav en missad returnotis (INV-5). Den behålls i stället som returens
   * bokföring. Eftersom den gjordes före korsningssegmentet kan den bara
   * släppas med beviset ankomstsidan-två-fixar: en noterad korsning och två
   * fixar i rad entydigt på ankomstsidan under gång dit, den senare minst
   * RETURN_CLEAR_M ut.
   * @private
   */
  _noteFarSideBooking(entry, vessel, stamp, fixTs, farOffsetM, firstTime) {
    if (!firstTime && routeSign(vessel) === -entry.farSign && farOffsetM < RETURN_CLEAR_M) {
      this._captureReturnBooking(entry, stamp, fixTs);
    }
    this._absorbFarSideBooking(entry, stamp, fixTs, farOffsetM);
  }

  /**
   * U14: en bokföring som först syns i en fix entydigt på bortre sidan hör till
   * den notifierade passagen eller till en tidigare resa och absorberas. En
   * returbokföring som redan fångats står kvar: passagelogiken bokför ibland
   * returen redan när en väntande båt når linjen, och bokför den inte igen när
   * hon senare verkligen korsar.
   * @private
   */
  _absorbFarSideBooking(entry, stamp, fixTs, farOffsetM) {
    if (!Number.isFinite(stamp)) return;
    if (Number.isFinite(entry.returnBookedAt) && stamp <= entry.returnBookedAt) return;
    if (Number.isFinite(entry.farSideBooking) && stamp <= entry.farSideBooking) return;
    entry.farSideBooking = stamp;
    // Var den absorberade bokföringen först syntes. Ligger fixen inom
    // RETURN_CLEAR_M från linjen och är den startfix för korsningssegmentet
    // (nästa rena fix ligger på ankomstsidan), hör bokföringen ändå till
    // returen: passagelogiken bokför ibland en fix före linjen.
    entry.farSideBookingFixTs = fixTs;
    entry.farSideBookingOffsetM = farOffsetM;
  }

  /**
   * U14-revisionen 4: en fix på ankomstsidan sammanfattad för beviset
   * ankomstsidan-två-fixar. `decisive`: över 10 m ut (appens G-1-mått).
   * `underway`: samma fart- och kurskrav som släppet ställer på den aktuella
   * fixen (minst RETURN_MIN_SOG_KN och kurs mot ankomstsidan; saknas ett värde
   * i AIS-rapporten prövas bara det andra).
   * @private
   */
  _arrivalFixState(vessel, point, farSign) {
    const sog = GPSJumpAnalyzer.positionSog(vessel);
    const cog = Object.prototype.hasOwnProperty.call(vessel, '_rawPositionCog') ? vessel._rawPositionCog : vessel.cog;
    const cogKnown = Number.isFinite(cog) && cog >= 0 && cog < 360;
    return {
      decisive: geometry.decisiveBridgeSide(vessel, point) === -farSign,
      underway: (sog === null || sog >= RETURN_MIN_SOG_KN)
        && (!cogKnown || geometry.courseBridgeSide(cog, point) === -farSign),
    };
  }

  /**
   * U14-revisionen 3 (omgranskningen 2026-11-05): följer en ren fix i ett öppet
   * brobesök. Appens passagelogik bokför fixen INNAN kroken körs, så en
   * bokföring i en fix entydigt på bortre sidan absorberas här
   * (farSideBooking) och kan aldrig räknas som retur.
   *
   * KORSNINGEN. Med offset = farSign × bridgeLineOffsetM (positivt på bortre
   * sidan) noteras en korsning när föregående rena fix hade offset > 0 och den
   * här har offset ≤ 0. Tiden interpoleras på segmentet, på fixklockan, som
   * gt-passages gör (dirigentens beslut om U21: "korsningen interpoleras på
   * glappsegmentet"). Varje följande fix på ankomstsidan räknas
   * (arrivalFixes). En fix med offset > 0 stryker korsningen: båten är
   * tillbaka vid eller bortom linjen, och en senare korsning får ny tid.
   * @returns {boolean} true första gången båten setts på bortre sidan
   * @private
   */
  _trackReturn(entry, vessel, point, pointName, sample, previousFix, deliveryGapMs) {
    const stamp = bookingStamp(vessel, pointName);
    const offset = entry.farSign * geometry.bridgeLineOffsetM(vessel, point);
    // Fixens eget segment: varifrån det började och hur lång kadensen var.
    // Det avgör om en bokföring vid linjen får avgöras direkt (gles AIS).
    entry.segment = {
      fromFixTs: previousFix.fixTs,
      fromDecisive: geometry.decisiveBridgeSide(previousFix, point) === entry.farSign,
      gapMs: deliveryGapMs,
      fixTs: sample.fixTs,
    };
    if (geometry.decisiveBridgeSide(vessel, point) === entry.farSign) {
      const firstTime = entry.farSideSeenAt === null;
      this._noteFarSideBooking(entry, vessel, stamp, sample.fixTs, offset, firstTime);
      entry.farSideSeenAt = this._now();
      entry.crossing = null;
      return firstTime;
    }
    if (entry.farSideSeenAt === null) return false;
    this._captureReturnBooking(entry, stamp, sample.fixTs);
    if (!Number.isFinite(offset)) return false;
    if (offset > 0) {
      entry.crossing = null;
      return false;
    }
    const fixState = this._arrivalFixState(vessel, point, entry.farSign);
    if (entry.crossing) {
      entry.crossing.arrivalFixes += 1;
      // U37 del 2: tystnaden kring korsningen räknas fram till notisens fix.
      if (Number.isFinite(deliveryGapMs)) {
        entry.crossing.maxGapMs = Math.max(entry.crossing.maxGapMs ?? 0, deliveryGapMs);
      }
      entry.crossing.lastFixTs = sample.fixTs;
      entry.crossing.previousArrival = entry.crossing.lastArrival;
      entry.crossing.lastArrival = fixState;
      return false;
    }
    const previousOffset = entry.farSign * geometry.bridgeLineOffsetM(previousFix, point);
    if (!(previousOffset > 0) || !Number.isFinite(previousFix.fixTs)) return false;
    const span = Math.max(0, sample.fixTs - previousFix.fixTs);
    entry.crossing = {
      atMs: previousFix.fixTs + span * (previousOffset / (previousOffset - offset)),
      fromFixTs: previousFix.fixTs,
      gapMs: deliveryGapMs,
      // U37 del 2: längsta leveransintervallet från fixen före korsningen
      // till den senaste fixen på ankomstsidan (notisformens tystnad).
      maxGapMs: deliveryGapMs,
      // Korsningssegmentets längd längs kanalaxeln (för AIS utan fart).
      segmentM: previousOffset - offset,
      // U37 del 2 (granskningen A3): första fixen på ankomstsidan. Korsningen
      // kan inte ha skett efter den.
      firstArrivalFixTs: sample.fixTs,
      arrivalFixes: 1,
      lastFixTs: sample.fixTs,
      // Förra och senaste fixen på ankomstsidan (entydig sida, under gång).
      previousArrival: null,
      lastArrival: fixState,
    };
    return false;
  }

  /**
   * U14 (användarbeslut 2026-11-04), revision 3 efter omgranskningen
   * 2026-11-05: avslutar ett öppet brobesök när båten BEVISLIGEN har passerat
   * tillbaka över bron. Appen anropar metoden där notisbeslutet fattas
   * (huvudvägen och failsafen, med PASSAGE_TRIGGER_GRACE_MS som
   * bokföringsgräns, så att notisen får passerad form) och en gång i slutet av
   * varje fix (_confirmReturnPassages, utan bokföringsgräns). Alla villkor
   * krävs:
   *  1. besöket har sett båten entydigt på bortre sidan (farSideSeenAt);
   *  2. appen har bokfört bron (lastPassedBridge eller passedAt[bro]) efter
   *     den observationen, i en fix där båten inte låg entydigt på bortre
   *     sidan, och bokföringen är yngre än maxBookingAgeMs;
   *  3. observe har noterat en korsning från bortre sidan till ankomstsidan,
   *     och den här fixen ligger fortfarande på ankomstsidan (undantaget är
   *     7c:s linjefix i transitfart);
   *  4. notisen kommer högst maxLatenessMs efter den interpolerade
   *     korsningen (U21, dirigentens beslut 2026-11-05: ingen sen notis för
   *     en returpassage under ett långt AIS-avbrott). Korsningstiden ligger på
   *     fixklockan och notisens på appens klocka; dröjsmålet räknar alltså
   *     med att AIS-flödet levererar fixen sent;
   *  5. ruttriktningen pekar tillbaka, bort från bortre sidan;
   *  6. båten är under gång mot ankomstsidan: rapporterad fart minst
   *     RETURN_MIN_SOG_KN och rapporterad kurs mot ankomstsidan (saknas ett
   *     värde i AIS-rapporten prövas bara det andra);
   *  7. positionen bevisar passagen, på ett av fyra sätt:
   *     a. båten ligger minst RETURN_CLEAR_M (30 m) ut på ankomstsidan och
   *        bokföringen hör till korsningssegmentet (gjord i segmentets
   *        startfix eller senare);
   *     b. båten ligger minst RETURN_CLEAR_M ut och har legat ENTYDIGT på
   *        ankomstsidan två fixar i rad, under gång dit även i den förra
   *        (revision 4). Bokföringen kan då vara äldre, till exempel en
   *        bokföring när en väntande båt nådde linjen;
   *     c. gles AIS (segmentets leveransintervall över sparseFixGapMs), så
   *        ingen bekräftande fix hinner komma inom notisens tidsfönster: i
   *        bokföringsticken räcker ett segment från ENTYDIGT bortre sidan
   *        till ENTYDIGT ankomstsidan (över 10 m från linjen, appens
   *        G-1-mått) när båten rör sig i nuet (RETURN_SPARSE_MOVING_SOG_KN,
   *        2,0 kn; utan fart ett segment på minst 100 m, revision 4), eller
   *        till linjen (inom ±10 m) när båten går i transitfart
   *        (RETURN_TRANSIT_SOG_KN, 3,13 kn);
   *     d. U37 del 1 (dirigentens beslut 2026-11-16, ägarens fråga F25): vid
   *        VILKEN kadens som helst räcker korsningsfixen själv när båten går i
   *        transitfart (RETURN_TRANSIT_SOG_KN) mot ankomstsidan: korsningen är
   *        noterad i just den här fixen, fixen ligger ENTYDIGT (över 10 m) på
   *        ankomstsidan, föregående fix låg ENTYDIGT på bortre sidan, det är
   *        första fixen på ankomstsidan, bokföringen hör till segmentet och
   *        korsningssegmentet går att färdas i farten (högst 1,5 × farten
   *        + 0,5 m/s och högst 15 m längre än farten medger; en GPS-utliggare
   *        förbi linjen gav annars falska returer). Alla krav står samlade i
   *        isTransitCrossingFix.
   *        Nattjaktens F15: LINNEA 2 korsade Klaffbron söderut i 5,8 kn, fixen
   *        9 s senare låg 26 m ut (segment 24 s), och nästa fix kom först
   *        421 s senare; notisen kom 7 min sent. En fix PÅ linjen (inom
   *        ±10 m) släpps bara vid gles kadens (c): motfallssvepet (en båt som
   *        bromsar från 6,5 till 3,25 kn mot linjen och stannar eller vänder
   *        3–8 m förbi den) gav annars 5 falska returer på 240 banor. Vid tät
   *        kadens avgör nästa fix.
   *     Vid tät kadens väntar en bokföring vid linjen alltså på nästa fix när
   *     båten inte går i transitfart, och vid gles kadens gör den det när
   *     båten inte rör sig i nuet.
   *     Det är där en båt som bromsar in och stannar vid bron skiljs från en
   *     som passerar (omgranskningen 2026-11-05: förra revisionens villkor
   *     godtog en gles fix inom 10 m på bortre sidan i vilken fart som helst;
   *     omgranskning 2, 2026-11-07: en väntande båt vars AIS rapporterar
   *     0,5–1 kn fick en falsk notis av ±15 m brus via gles-korsning).
   * BRUSMODELLEN. Kraven a och b (minst RETURN_CLEAR_M ut) gör att en båt som
   * i själva verket ligger kvar på bortre sidan bara kan släppas av ett brus
   * på över 30 m längs kanalaxeln, alltså utanför appens egen brusmodell
   * (två stilla fixar under UNDER_BRIDGE_CROSS_PROOF_JITTER_M = 60 m isär är
   * brus). Krav c förutsätter rörelse i nuet. Brus utanför modellen är en
   * känd gräns (docs/ARCHITECTURE.md, U14).
   * En bokföring som görs medan båten ligger på bortre sidan absorberas och
   * kan aldrig senare räknas som retur, utom passagelogikens förtida
   * returbokföring vid linjen efter en bekräftad vändning
   * (_noteFarSideBooking), som bara släpps med krav b. Positionen måste klara samma
   * renhetskrav som observe (_sample) och får inte vara äldre än besökets
   * senaste fix. Ett stängt besök (exitedAt) rörs inte; där gäller
   * återkomstregeln.
   * @param {Object} vessel - fartyget med tickens passagebokföring
   * @param {string} pointName - brons namn
   * @param {{maxBookingAgeMs: number, maxLatenessMs: number, sparseFixGapMs: number,
   *   dryRun?: boolean}} limits - med dryRun prövas släppet utan att besöket avslutas
   * @returns {{farSign: number, bookedAt: number, evidence: string, crossedAt: number,
   *   crossingGapMs: number, silenceMs: number, latenessMs: number, fixTs: number,
   *   offsetM: number, sogKn: (number|null), segmentStartTs: number, firstArrivalTs: number}|null}
   *   besöket som avslutades (firstArrivalTs: första fixen på ankomstsidan)
   *   (U37 del 2: silenceMs är längsta leveransintervallet från fixen före
   *   korsningen till den här fixen; fixTs, offsetM och sogKn beskriver
   *   släppfixen för notisformen)
   */
  releaseReturnPassage(vessel, pointName, {
    maxBookingAgeMs, maxLatenessMs, sparseFixGapMs, dryRun = false,
  } = {}) {
    const point = POINTS.get(pointName);
    const key = this._key(vessel?.mmsi, pointName);
    const entry = key === null ? null : this._entries.get(key);
    if (!entry || entry.exitedAt !== null || !BRIDGE_NAMES.has(pointName) || !entry.farSign) return null;
    const sample = this._sample(vessel, point);
    if (!sample || sample.fixTs < entry.lastFixTs) return null;
    const now = this._now();
    const stamp = bookingStamp(vessel, pointName);
    if (geometry.decisiveBridgeSide(vessel, point) === entry.farSign) {
      // En ny bokföring i en fix på bortre sidan: ingen retur nu (en förtida
      // returbokföring vid linjen behålls, se _noteFarSideBooking).
      this._noteFarSideBooking(entry, vessel, stamp, sample.fixTs,
        entry.farSign * geometry.bridgeLineOffsetM(vessel, point), !Number.isFinite(entry.farSideSeenAt));
      return null;
    }
    if (!Number.isFinite(entry.farSideSeenAt)) return null;
    // En bokföring efter observe i samma tick (glappinferensen i
    // _checkSkippedBridgesFallback) hör till den här fixen.
    this._captureReturnBooking(entry, stamp, entry.lastFixTs);
    if (entry.lastFixTs !== sample.fixTs) return null;
    const { segment } = entry;
    const crossing = entry.crossing && entry.crossing.lastFixTs === sample.fixTs ? entry.crossing : null;
    const side = geometry.decisiveBridgeSide(vessel, point);
    // Gles kadens: segmentet till den här fixen började entydigt på bortre
    // sidan och var längre än sparseFixGapMs, så ingen bekräftande fix hinner
    // komma inom notisens tidsfönster.
    const sparseSegment = Boolean(segment) && segment.fixTs === sample.fixTs && segment.fromDecisive
      && segment.gapMs > sparseFixGapMs;
    // Utan noterad korsning finns bara ett fall kvar: en gles fix på linjen
    // (inom ±10 m, fortfarande på bortre sidan) i transitfart (villkor 7c).
    if (!crossing && !(sparseSegment && side === 0)) return null;
    const segmentStartTs = crossing ? crossing.fromFixTs : segment.fromFixTs;
    // Returens bokföring: den som fångats utanför bortre sidan, eller en
    // absorberad bokföring i korsningssegmentets startfix nära linjen.
    let bookedAt = entry.returnBookedAt;
    let bookedInSegment = Number.isFinite(bookedAt) && Number.isFinite(entry.returnBookedFixTs)
      && entry.returnBookedFixTs >= segmentStartTs;
    if (!bookedInSegment && Number.isFinite(entry.farSideBooking)
        && entry.farSideBookingFixTs === segmentStartTs
        && entry.farSideBookingOffsetM < RETURN_CLEAR_M
        && !(Number.isFinite(bookedAt) && bookedAt > entry.farSideBooking)) {
      bookedAt = entry.farSideBooking;
      bookedInSegment = true;
    }
    if (!Number.isFinite(bookedAt) || !(now - bookedAt < maxBookingAgeMs)) return null;
    // En linjefix i transitfart är igenom bron inom sekunder: korsningen
    // räknas till fixens egen tid.
    const crossedAt = crossing ? crossing.atMs : sample.fixTs;
    const crossingGapMs = crossing ? crossing.gapMs : segment.gapMs;
    // U37 del 2: tystnaden kring korsningen, fram till den här fixen.
    const silenceMs = crossing && Number.isFinite(crossing.maxGapMs) ? crossing.maxGapMs : crossingGapMs;
    const latenessMs = now - crossedAt;
    if (!(latenessMs <= maxLatenessMs)) return null;
    if (routeSign(vessel) !== -entry.farSign) return null;
    const sog = GPSJumpAnalyzer.positionSog(vessel);
    if (sog !== null && sog < RETURN_MIN_SOG_KN) return null;
    const cog = Object.prototype.hasOwnProperty.call(vessel, '_rawPositionCog') ? vessel._rawPositionCog : vessel.cog;
    if (Number.isFinite(cog) && cog >= 0 && cog < 360
        && geometry.courseBridgeSide(cog, point) !== -entry.farSign) return null;
    const clear = entry.farSign * geometry.bridgeLineOffsetM(vessel, point) <= -RETURN_CLEAR_M;
    const transit = sog !== null && sog >= RETURN_TRANSIT_SOG_KN;
    // Revision 4: två fixar i rad räcker bara när båda ligger ENTYDIGT på
    // ankomstsidan och båten var under gång dit även i den förra (omgranskning
    // 2:s förslag). En väntande båt vars brus ger en kort utflykt över linjen
    // har slumpad kurs och ligger sällan två fixar i rad över 10 m ut.
    const previousArrival = crossing ? crossing.previousArrival : null;
    const twoArrivalFixes = Boolean(crossing) && crossing.arrivalFixes >= 2
      && Boolean(previousArrival) && previousArrival.decisive && previousArrival.underway;
    // Revision 4: en gles fix entydigt på ankomstsidan kräver rörelse i nuet.
    const sparseMoving = sog !== null
      ? sog >= RETURN_SPARSE_MOVING_SOG_KN
      : Boolean(crossing) && crossing.segmentM >= RETURN_SPARSE_NO_SOG_SEGMENT_M;
    let evidence = null;
    if (crossing && clear && bookedInSegment) {
      evidence = 'ankomstsidan';
    } else if (crossing && clear && twoArrivalFixes) {
      evidence = 'ankomstsidan-två-fixar';
    } else if (bookedInSegment && sparseSegment && (!crossing || crossing.arrivalFixes === 1)
        && ((side === -entry.farSign && sparseMoving) || (side === 0 && transit))) {
      evidence = side === 0 ? 'gles-linje-transit' : 'gles-korsning';
    } else if (bookedInSegment && isTransitCrossingFix({
      crossing, segment, sample, side, farSign: entry.farSign, sog, transit,
    })) {
      // U37 del 1 (villkor 7d, se isTransitCrossingFix): korsningsfixen i
      // transitfart, också vid tät kadens; längre ut än RETURN_CLEAR_M gäller
      // redan 7a.
      evidence = 'linje-transit';
    }
    if (!evidence) return null;
    // Revision 4: en torrkörning (failsafen prövar sina egna spärrar först)
    // lämnar besöket orört. Bokföringsstämplarna ovan noteras ändå; de är
    // desamma som det riktiga släppet i samma tick noterar.
    if (!dryRun) this._entries.delete(key);
    return {
      farSign: entry.farSign,
      bookedAt,
      evidence,
      crossedAt,
      crossingGapMs,
      silenceMs,
      latenessMs,
      // U37 del 2: släppfixen, för notisformens skattning av när båten
      // korsade (avståndet bortom linjen delat med farten).
      fixTs: sample.fixTs,
      offsetM: Math.abs(geometry.bridgeLineOffsetM(vessel, point)),
      sogKn: sog,
      segmentStartTs,
      firstArrivalTs: crossing && Number.isFinite(crossing.firstArrivalFixTs) ? crossing.firstArrivalFixTs : sample.fixTs,
    };
  }

  /**
   * U14-revisionen: broarna där fartyget har ett öppet besök som en retur kan
   * avsluta. Appen prövar dem i slutet av varje fix (_confirmReturnPassages).
   * @param {string|number} mmsi
   * @returns {string[]} brornas namn
   */
  openBridgeVisits(mmsi) {
    const id = String(mmsi);
    if (!/^\d{9}$/.test(id)) return [];
    const names = [];
    for (const [key, entry] of this._entries) {
      const [entryId, pointName] = key.split(':');
      if (entryId === id && entry.exitedAt === null && entry.farSign && BRIDGE_NAMES.has(pointName)) {
        names.push(pointName);
      }
    }
    return names;
  }

  /**
   * Reserveras före async Flow-anrop; null innebär att ingen ny post ägs.
   * En historisk passage-fallback långt utanför området bevisar ingen
   * pågående vistelse där. Den behåller appens äldre passage-dedup.
   *
   * U14: `passageBehind` säger att notisen gäller en passage som redan skett
   * (passerad form). Då ligger ankomstpositionen på bortre sidan. Annars ligger
   * den passage notisen gäller framför båten, och bortre sidan är den motsatta.
   * Ligger ankomsten på linjen (±10 m) går passagen i ruttriktningen. Brons
   * bokföringar fram till notisen hör till den notifierade passagen eller till
   * tidigare resor och kan aldrig räknas som retur (farSideBooking).
   *
   * N6 (granskningen av N2, sidofyndet vid Järnvägsbron): en förvarning kan gå
   * ut på en position som redan ligger entydigt bortom linjen i ruttriktningen
   * (glesa positioner, en båt som syns först efter bron). Bron ligger då bakom
   * båten, och den bortre sidan är den sida hon ligger på, inte den motsatta.
   * Förut vändes besöket: en senare brusposition på andra sidan gav en sen falsk
   * "har precis passerat", och en verklig retur över bron gav ingen notis
   * (granskarens svep: 48 av 48 banor vid 120 s kadens). Bortre sidan tas därför
   * ur notisens färdriktning (`travelSign`: ruttlåset, annars kursen, samma
   * riktning som notisen själv bär) när positionen ligger på den sidan, utom
   * när kursen pekar tillbaka mot bron (ett ruttlås som ännu inte hunnit vända
   * efter en U-sväng). Besöket noterar inte bortre sidan som sedd förrän nästa rena fix
   * ligger där (observe): en väntande båt vars förvarning gick ut på en
   * brusposition bortom linjen ska inte kunna få ett retursläpp.
   * @param {Object} vessel
   * @param {string} [pointName]
   * @param {{passageBehind?: boolean, travelSign?: number}} [options] - travelSign:
   *   notisens färdriktning (+1 norrut, −1 söderut, 0 okänd); utan värde gäller
   *   ruttlåset
   */
  reserve(vessel, pointName = 'Kanalinfarten', { passageBehind = false, travelSign = routeSign(vessel) } = {}) {
    const point = POINTS.get(pointName);
    const key = this._key(vessel?.mmsi, pointName);
    const sample = key !== null && this._sample(vessel, point);
    if (!sample || sample.distance > point.radius + 50 || this._entries.has(key)) return null;
    this._pruneDeparted();
    this._makeRoom();
    let farSign = 0;
    let farSideSeenAt = null;
    let farSideBooking = null;
    if (BRIDGE_NAMES.has(pointName)) {
      const arrivalSide = geometry.decisiveBridgeSide(vessel, point);
      if (arrivalSide === 0) farSign = routeSign(vessel);
      else if (passageBehind || isBehindInTravel(vessel, point, arrivalSide, travelSign)) farSign = arrivalSide;
      else farSign = -arrivalSide;
      if (passageBehind && arrivalSide !== 0) farSideSeenAt = this._now();
      farSideBooking = bookingStamp(vessel, pointName);
    }
    const entry = {
      startedAt: this._now(),
      lastFixTs: sample.fixTs,
      outsideFixTs: null,
      exitedAt: null,
      lastLat: vessel.lat,
      lastLon: vessel.lon,
      lastPositionTs: sample.positionTs,
      arrivalLat: vessel.lat,
      arrivalLon: vessel.lon,
      farSign,
      farSideSeenAt,
      // Bokföringsstämplarna, korsningen och leveransklockan hör till
      // fartygsobjektets livstid och sparas inte.
      farSideBooking,
      farSideBookingFixTs: null,
      farSideBookingOffsetM: null,
      returnBookedAt: null,
      returnBookedFixTs: null,
      crossing: null,
      segment: null,
      lastObservedAt: this._now(),
      // U46: senaste rena fixens utåtbevis vid en ytterpunkt (sparas).
      outwardFixTs: null,
      // U51: förtöjningsbelägget (sparas) och föregående fixs fart.
      lastSog: GPSJumpAnalyzer.positionSog(vessel),
      moorLat: null,
      moorLon: null,
      moorSince: null,
      moorLastTs: null,
      moorProven: false,
    };
    this._entries.set(key, entry);
    return entry;
  }

  /**
   * Stänger fartygets öppna besök på appens positionsbevis för utfärd.
   * Posten behåller sin historik och följer sedan samma regler som en
   * observerad utfärd: återkomst inom 300 m frigör en ny notis, annars
   * gallras posten efter sex timmar. Redan stängda besök rörs inte.
   * @returns {string[]} punkterna vars besök stängdes
   */
  closeOpenVisits(mmsi) {
    const id = String(mmsi);
    if (!/^\d{9}$/.test(id)) return [];
    const now = this._now();
    const closed = [];
    for (const [key, entry] of this._entries) {
      const [entryId, pointName] = key.split(':');
      if (entryId !== id || entry.exitedAt !== null) continue;
      // Samma invarianter som loadSnapshot kräver: utfärdsfixen ligger inte
      // efter senaste fixen och utfärden inte före besökets start.
      entry.outsideFixTs = entry.outsideFixTs ?? entry.lastFixTs;
      entry.exitedAt = Math.max(now, entry.startedAt);
      entry.outwardFixTs = null;
      closed.push(pointName);
    }
    return closed;
  }

  rollback(mmsi, entry, pointName = 'Kanalinfarten') {
    const key = this._key(mmsi, pointName);
    if (!entry || key === null || this._entries.get(key) !== entry) return false;
    return this._entries.delete(key);
  }

  _pruneDeparted() {
    const now = this._now();
    for (const [key, entry] of this._entries) {
      if (entry.exitedAt !== null && now - entry.exitedAt > DEPARTED_RETENTION_MS) this._entries.delete(key);
    }
  }

  _info(message) {
    const log = this._logger?.log;
    if (typeof log === 'function') log.call(this._logger, message);
  }

  _warn(message) {
    const log = this._logger?.warn || this._logger?.log;
    if (typeof log === 'function') log.call(this._logger, `[TRIGGER_POINT_VISIT_CAP] ${message}`);
  }

  _makeRoom() {
    if (this._entries.size < MAX_ENTRIES) return;
    let oldest = null;
    for (const pair of this._entries) {
      const entry = pair[1];
      if (!oldest
          || (entry.exitedAt !== null && oldest[1].exitedAt === null)
          || ((entry.exitedAt !== null) === (oldest[1].exitedAt !== null)
            && (entry.exitedAt ?? entry.startedAt) < (oldest[1].exitedAt ?? oldest[1].startedAt))) oldest = pair;
    }
    this._entries.delete(oldest[0]);
    if (oldest[1].exitedAt === null) {
      // Säkerhetstaket går före obegränsad minnestillväxt. Endast när ALLA
      // 2048 poster saknar utfärdsbevis förloras skyddet för äldsta besöket;
      // det kan ge en ny notis efter återkomst, och får därför aldrig döljas.
      this._warn(`2048 aktiva besök: äldsta posten ${oldest[0]} släppt; dubbleringsskyddet för den båten förloras`);
    }
  }

  exportSnapshot() {
    this._pruneDeparted();
    const entries = {};
    for (const [key, entry] of this._entries) {
      const copy = { ...entry };
      // U14: bokföringsstämplarna, korsningen och leveransklockan gäller bara
      // det levande fartygsobjektet. Efter en omstart är alla nya bokföringar
      // per definition senare än observationen på bortre sidan, och en
      // korsning måste noteras på nytt ur den sparade sista fixen.
      delete copy.farSideBooking;
      delete copy.farSideBookingFixTs;
      delete copy.farSideBookingOffsetM;
      delete copy.returnBookedAt;
      delete copy.returnBookedFixTs;
      delete copy.crossing;
      delete copy.segment;
      delete copy.lastObservedAt;
      entries[key] = copy;
    }
    return { version: 2, entries };
  }

  loadSnapshot(snapshot) {
    this._entries.clear();
    if (!snapshot || ![1, 2].includes(snapshot.version) || !snapshot.entries
        || typeof snapshot.entries !== 'object' || Array.isArray(snapshot.entries)) return 0;
    const now = this._now();
    const latestAllowed = now + AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS;
    const validTime = (value) => Number.isFinite(value) && value >= 0 && value <= latestAllowed;
    let examined = 0;
    // Även läsningen har ett tak: en skadad inställning får inte bygga en
    // tillfällig Object.entries-array eller en obegränsad genomgång.
    // eslint-disable-next-line no-restricted-syntax
    for (const storedKey in snapshot.entries) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.entries, storedKey)) continue;
      if (examined >= MAX_ENTRIES) {
        this._warn('snapshot innehåller fler än 2048 poster; överskjutande poster läses inte');
        break;
      }
      examined++;
      // V1 sparade verkliga Kanalinfartsbesök under bara MMSI. Migrationen
      // behåller dem där; ingen gammal tidsstämpel blir ny brohistorik.
      const parts = snapshot.version === 1 ? [storedKey, 'Kanalinfarten'] : storedKey.split(':');
      const key = parts.length === 2 ? this._key(parts[0], parts[1]) : null;
      const point = POINTS.get(parts[1]);
      const entry = snapshot.entries[storedKey];
      if (key === null || !entry || typeof entry !== 'object' || Array.isArray(entry)
          || !validTime(entry.startedAt) || !validTime(entry.lastFixTs)
          || (entry.outsideFixTs !== null && (!validTime(entry.outsideFixTs) || entry.outsideFixTs > entry.lastFixTs))
          || (entry.exitedAt !== null && (!validTime(entry.exitedAt) || entry.exitedAt < entry.startedAt
            || entry.outsideFixTs === null))) continue;
      // Äldre version-1-poster utan koordinater får behålla sitt besök men
      // kan inte bevisa ett segment förrän en riktig ny position observerats.
      const hasPosition = entry.lastLat != null || entry.lastLon != null || entry.lastPositionTs != null;
      if (hasPosition && (!validTime(entry.lastPositionTs)
          || !Number.isFinite(geometry.calculateDistance(entry.lastLat, entry.lastLon, point.lat, point.lon)))) continue;
      if (entry.exitedAt !== null && now - entry.exitedAt > DEPARTED_RETENTION_MS) continue;
      const hasArrival = Number.isFinite(geometry.calculateDistance(entry.arrivalLat, entry.arrivalLon, point.lat, point.lon));
      // U14-fälten är frivilliga. Äldre poster och skadade värden ger inget
      // returpassagesläpp, alltså samma beteende som före U14.
      const farSign = BRIDGE_NAMES.has(parts[1]) && (entry.farSign === 1 || entry.farSign === -1)
        ? entry.farSign : 0;
      const farSideSeenAt = farSign !== 0 && validTime(entry.farSideSeenAt) && entry.farSideSeenAt >= entry.startedAt
        ? entry.farSideSeenAt : null;
      // U46: utåtbeviset gäller bara ett öppet besök vid en ytterpunkt och
      // bara besökets senaste fix. Äldre poster och skadade värden saknar det.
      const outwardFixTs = OUTER_SIDE.has(parts[1]) && entry.exitedAt === null
        && validTime(entry.outwardFixTs) && entry.outwardFixTs === entry.lastFixTs
        ? entry.outwardFixTs : null;
      // U51: förtöjningsbelägget gäller bara ett öppet besök vid en ytterpunkt.
      // Ankaret ska vara en giltig position och tiderna ordnade och inte senare
      // än besökets senaste fix; annars börjar belägget om från noll (ingen
      // avgång kan släppas förrän en ny förtöjning är belagd).
      const moorOk = MOORED_DEPARTURE_POINTS.has(parts[1]) && entry.exitedAt === null
        && Number.isFinite(geometry.calculateDistance(entry.moorLat, entry.moorLon, point.lat, point.lon))
        && validTime(entry.moorSince) && validTime(entry.moorLastTs)
        && entry.moorSince <= entry.moorLastTs && entry.moorLastTs <= entry.lastFixTs;
      const moorProven = moorOk && entry.moorProven === true && entry.moorLastTs - entry.moorSince >= MOORED_MIN_MS;
      this._entries.set(key, {
        startedAt: entry.startedAt,
        lastFixTs: entry.lastFixTs,
        outsideFixTs: entry.outsideFixTs,
        exitedAt: entry.exitedAt,
        lastLat: hasPosition ? entry.lastLat : null,
        lastLon: hasPosition ? entry.lastLon : null,
        lastPositionTs: hasPosition ? entry.lastPositionTs : null,
        arrivalLat: hasArrival ? entry.arrivalLat : null,
        arrivalLon: hasArrival ? entry.arrivalLon : null,
        farSign,
        farSideSeenAt,
        farSideBooking: null,
        farSideBookingFixTs: null,
        farSideBookingOffsetM: null,
        returnBookedAt: null,
        returnBookedFixTs: null,
        crossing: null,
        segment: null,
        lastObservedAt: null,
        outwardFixTs,
        lastSog: Number.isFinite(entry.lastSog) && entry.lastSog >= 0 ? entry.lastSog : null,
        moorLat: moorOk ? entry.moorLat : null,
        moorLon: moorOk ? entry.moorLon : null,
        moorSince: moorOk ? entry.moorSince : null,
        moorLastTs: moorOk ? entry.moorLastTs : null,
        moorProven,
      });
    }
    return this._entries.size;
  }
}

module.exports = TriggerPointVisitTracker;
