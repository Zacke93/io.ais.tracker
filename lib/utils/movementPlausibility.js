'use strict';

const GPSJumpAnalyzer = require('./GPSJumpAnalyzer');

/**
 * movementPlausibility — HUR LÅNGT FÅR ETT FARTYG HA FLYTTAT SIG?
 *
 * VARFÖR MODULEN FINNS (J10, helkodsgranskning runda 2, 2026-08-22):
 * Samma fråga ställs på TRE ställen. Formeln är K19:s (fältprov 10), som i sin
 * tur speglar GJ-1 i GPSJumpGateService._isVesselStable: tillåt förflyttning
 * upp till maxfart × förfluten tid × marginal, golvat mot anropsställets egen
 * historiska meter-tröskel. Ett naket avståndsvillkor mäter nämligen inte fysik
 * utan LEVERANSKADENS: vid AISHubs fix-Δ (p50 152 s, p90 570 s över
 * korpusbanken) motsvarar 300 m bara 3,9 kn vid medianen, alltså vanlig
 * kanalfart. Mätningen över korpusbankens 20 jsonl gav 1 097 av 14 530 segment
 * (7,5 %) över 300 m, av dem 100 % under 10 kn och 98,4 % fartkonsistenta —
 * noll äkta GPS-fel.
 *
 * ⚠️ ÄRLIG STATUS ÖVER ANROPSSTÄLLENA (fixomgång B, 2026-08-22 — modulens
 * första docblock påstod att den redan var delad, vilket inte var sant):
 *   1. VesselDataService._detectGPSEventProtection (K19, golv 200 m) —
 *      LEVANDE KONSUMENT. Kopian där är borttagen; det är den här modulen som
 *      körs i produktion.
 *   2. SystemCoordinator.coordinatePositionUpdate (golv 300 m) — STÅR KVAR
 *      NAKEN. OBS: exporten assessMovement har därför i dag NOLL
 *      produktionsanropare (bara enhetstestet) — den är det API den uppskjutna
 *      J10-fixen ska använda, inget som redan körs. Omkopplingen var mekaniskt riktig men avslöjade en maskerad
 *      ETA-defekt i 20260712-25h (FRAM 211864690) och är återtagen tills den
 *      är löst; hela beslutet står i kommentaren på det anropsstället.
 *   3. GPSJumpGateService._isVesselStable (GJ-1, golv 200 m) — TREDJE KOPIA.
 *      Den härleder sin tidsbas annorlunda (physicsElapsedMs räknas ut tidigare
 *      i metoden), så den behöver en variant som tar ett FÄRDIGBERÄKNAT dt,
 *      t.ex. en export allowedMovementForDt(dtMs, vessel, oldVessel, floorM).
 *      Inte gjord här: den kräver egen A/B mot facit.
 *
 * GOLVET skiljer per anropsställe och skickas därför som argument — det är just
 * den lokala tröskel som fanns före normaliseringen, och den bevarar varje
 * ställes historiska beteende. Argumentet valideras (se normalizeFloorM):
 * ett trasigt golv får göra grinden strängare, aldrig slappare.
 */

// HÄRLEDNING (oförändrad från K19/GJ-1): tillåt förflyttning upp till
// maxfart × förfluten tid × marginal. 2,0 är GJ-1:s marginal mot AIS-avrundad
// fart och kurvtagning (kortaste vägen mellan två fixar är rät linje; en båt
// som svänger tillryggalägger mer väg än avståndet mellan ändpunkterna).
const MOVEMENT_MARGIN_FACTOR = 2.0;

// Fartgolv när BÅDA samplen bär sog: 1 kn. Golvet finns för att en rapporterad
// nolla inte ska ge ett tillåtet avstånd på noll meter — AIS-fart är avrundad
// och en förtöjd båt som lossar kan röra sig innan farten hinner rapporteras.
const SPEED_FLOOR_BOTH_SOG_KN = 1;

// Fartgolv när EN sida saknar sog: 5 kn (GJ-2/G-2-läxan). Ensidigt null betyder
// "intervallets fart är OKÄND", inte "stilla" — den fartgivarlösa klassen finns
// och får inte behandlas som stillaliggare.
const SPEED_FLOOR_MISSING_SOG_KN = 5;

const METERS_PER_NAUTICAL_MILE = 1852;
const MS_PER_HOUR = 3600000;

/**
 * Tidsbasen för en förflyttning: fixklockan i första hand, mottagnings-Δ som
 * fallback.
 *
 * TIDSBASVAKT (röda etappen 2026-08-22): mottagnings-Δ:n får användas ENDAST
 * när BÅDA sidorna har en tidsstämpel. Saknas den ena blir nowTs − prevTs hela
 * epoken, det tillåtna avståndet ~9·10⁹ m och grinden kan ALDRIG slå till —
 * fail-open. Utan giltig tidsbas returneras null, och anroparen faller tillbaka
 * på sitt golv, dvs. exakt beteendet före tidsnormaliseringen.
 *
 * @param {Object} vessel - nyare sampel
 * @param {Object} oldVessel - äldre sampel
 * @returns {{dtMs: number|null, source: 'fix'|'receive'|'none'}}
 */
function movementTimeBaseMs(vessel, oldVessel) {
  if (!vessel || !oldVessel) return { dtMs: null, source: 'none' };

  const fixDtMs = GPSJumpAnalyzer.fixDtMs(vessel, oldVessel);
  if (fixDtMs !== null) return { dtMs: fixDtMs, source: 'fix' };

  // Samma uttryck som K19 och _northProgressMps: lastPositionUpdate fryses för
  // en stilla båt, timestamp (mottagning) avancerar — max() tar den som senast
  // bar information.
  const nowTs = Math.max(vessel.lastPositionUpdate || 0, vessel.timestamp || 0);
  const prevTs = Math.max(oldVessel.lastPositionUpdate || 0, oldVessel.timestamp || 0);
  if (nowTs > 0 && prevTs > 0) return { dtMs: nowTs - prevTs, source: 'receive' };

  return { dtMs: null, source: 'none' };
}

// GOLVVAKT (L20, helkodsgranskning runda 3, 2026-08-22) — ett OGILTIGT golv
// ska stänga grinden, inte öppna den.
//
// FELET SOM STÄNGS: golvargumentet validerades inte. Med undefined eller NaN
// blev returvärdet Math.max(undefined, fysiskt) = NaN, och assessMovements
// jämförelse `förflyttning > NaN` är ALLTID falsk — grinden försvann TYST i
// stället för att bli strängare. Utan användbar tidsbas returnerades golvet
// orört och grinden föll öppen på samma sätt. Verifierat med nod-probe mot
// produktionsmodulen: 100 km på 1 sekund med odefinierat golv bedömdes rimlig,
// med golvet 200 orimlig. Inget statiskt nät fångar det (checkJs är av i
// jsconfig och eslint saknar jsdoc-typregler), så vakten måste stå i koden.
//
// VARFÖR 0 OCH INTE ETT VÄRDE UR MODULEN: 0 gör en felkopplad anropare
// fail-CLOSED — taket blir det RENT FYSIKALISKA (maxfart × tid × marginal),
// alltså strängast möjliga variant av samma regel, och den slår till direkt i
// stället för att tyst släppa igenom allt. Ett gissat standardgolv hade
// tvärtom gjort felet osynligt. NEGATIVA golv normaliseras av samma skäl:
// ett negativt allowedM på den tidsbaslösa vägen hade gjort VARJE förflyttning
// orimlig, alltså fail-closed men på ett värde som inte betyder något.
//
// NULL ÄR REDAN OFARLIGT och ändrar därför inget beteende här: Math.max(null, x)
// koercerar null till 0 och den tidsbaslösa vägen jämför mot `> null`, dvs.
// `> 0`. Det är undefined och NaN som öppnar grinden, och det är dem vakten
// finns för.
/** @private */
function normalizeFloorM(floorM) {
  return (Number.isFinite(floorM) && floorM >= 0) ? floorM : 0;
}

/**
 * Hur långt fartyget rimligen KAN ha förflyttat sig mellan två sampel.
 *
 * @param {Object} vessel - nyare sampel (sog/fixTs/fixFeed/timestamp)
 * @param {Object} oldVessel - äldre sampel
 * @param {number} floorM - anropsställets egen tröskel; returvärdet
 *   understiger den ALDRIG, så grinden kan bara bli strängare, aldrig slappare.
 *   Ett golv som inte är ett finit icke-negativt tal behandlas som 0 (se
 *   normalizeFloorM) — fail-CLOSED, inte fail-open.
 * @returns {{allowedM: number, dtMs: number|null, dtSource: string, speedFloorKn: number|null}}
 */
function allowedMovement(vessel, oldVessel, floorM) {
  const floor = normalizeFloorM(floorM);
  const { dtMs, source } = movementTimeBaseMs(vessel, oldVessel);

  // `dtMs > 0` är ekvivalent med golvet för icke-positiva dt (Math.max mot
  // golvet ger golvet i båda fallen). Villkoret står kvar som avsikt OCH som
  // skydd om golvet någon gång sänks: ett negativt dt skulle annars ge ett
  // NEGATIVT tillåtet avstånd, alltså en grind som alltid slår till.
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    return {
      allowedM: floor, dtMs, dtSource: source, speedFloorKn: null,
    };
  }

  const oldSog = Number.isFinite(oldVessel.sog) ? oldVessel.sog : null;
  const newSog = Number.isFinite(vessel.sog) ? vessel.sog : null;
  const knownMaxSog = Math.max(oldSog ?? 0, newSog ?? 0);
  const speedFloorKn = (oldSog === null || newSog === null)
    ? Math.max(knownMaxSog, SPEED_FLOOR_MISSING_SOG_KN)
    : Math.max(knownMaxSog, SPEED_FLOOR_BOTH_SOG_KN);

  const physicalM = speedFloorKn * METERS_PER_NAUTICAL_MILE
    * (dtMs / MS_PER_HOUR) * MOVEMENT_MARGIN_FACTOR;

  return {
    allowedM: Math.max(floor, physicalM), dtMs, dtSource: source, speedFloorKn,
  };
}

/**
 * Är förflyttningen fysikaliskt orimlig (dvs. ett GPS-fel snarare än fart)?
 *
 * @param {number} movementDistanceM - uppmätt förflyttning i meter
 * @param {Object} vessel - nyare sampel
 * @param {Object} oldVessel - äldre sampel
 * @param {number} floorM - anropsställets egen tröskel; ogiltiga värden
 *   normaliseras till 0 av allowedMovement (L20 — fail-CLOSED). Utan den
 *   vakten blev allowedM NaN och den här jämförelsen alltid falsk, dvs. en
 *   grind som TYST slutade finnas.
 * @returns {{implausible: boolean, allowedM: number, dtMs: number|null, dtSource: string, speedFloorKn: number|null}}
 */
function assessMovement(movementDistanceM, vessel, oldVessel, floorM) {
  const assessment = allowedMovement(vessel, oldVessel, floorM);
  return {
    ...assessment,
    implausible: Number.isFinite(movementDistanceM) && movementDistanceM > assessment.allowedM,
  };
}

module.exports = {
  allowedMovement,
  assessMovement,
  movementTimeBaseMs,
  MOVEMENT_MARGIN_FACTOR,
  SPEED_FLOOR_BOTH_SOG_KN,
  SPEED_FLOOR_MISSING_SOG_KN,
};
