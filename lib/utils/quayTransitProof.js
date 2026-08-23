'use strict';

const geometry = require('./geometry');

/**
 * quayTransitProof — RÄCKER ETT ENSAMT FARTVÄRDE SOM TRANSITBEVIS?
 *
 * VARFÖR MODULEN FINNS (M2, helkodsgranskning RUNDA 4, 2026-08-23):
 * Kajgrinden vid målbroarna har ett enkelsampel-undantag: EN fix på eller över
 * den uppmätta medianfarten för en äkta anflygning
 * (BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN = 3,13 kn) räknas som avgångsbevis
 * i sig, därför att kajerna vid målbroarna ligger 200–400 m från bron och hela
 * förloppet avgång→passage tar ~5 minuter — att fördröja en fix kostar där
 * hela varningen. Undantaget läste dock ETT RÅTT sog-värde och inget annat.
 *
 * FELMODEN ÄR RÅDATAVERIFIERAD: CARAT (211452170) i korpus 20260804-both-21h
 * låg kajstilla vid Klaffbron och rapporterade 2026-08-05T03:54:04Z ETT sampel
 * på 7,4 kn. Positionen hade då flyttat sig 52,2 m sedan föregående fix 69 s
 * tidigare — implicerat 1,47 knop. Det brusiga värdet öppnade hela skyddet och
 * gav en bridge_opening_soon 2 h 58 min före hennes verkliga passage (06:52:36).
 *
 * VAD MODULEN GÖR: den prövar det ensamma fartvärdet mot fartygets EGEN
 * positionsförflyttning. Rapporterad fart som är GROVT oförenlig med den
 * implicerade farten mellan två färska fixar är inte ett transitbevis.
 *
 * FAIL-OPEN ÄR EN HÅRD REGEL. Saknas föregående fix, är den för gammal, eller
 * går dt/geometri inte att mäta, svarar modulen `corroborated: true` — dvs.
 * kortslutningen BEHÅLLS. Skälet är mätt: 265726650 (2026-07-02) fick sin
 * ÄKTA öppningsvarning på ETT ENDA sampel över tröskeln, med 70 minuters
 * glapp till föregående fix och 14 m netto. Med en tystnad på 70 minuter säger
 * positionsdeltat ingenting om vad båten gjorde däremellan (hon kan ha gått ut
 * och kommit tillbaka), så där finns ingen inkonsistens att påstå.
 *
 * ═══ STABILT API (delas med tests/replay-validation/runOpeningGates.js) ═══
 * Grindfilen ärvde samma defekt: den hårdkodar UNDERWAY_SOLO_SOG_KN = 3,13 och
 * klassar en kandidat som rörlig på maxSog, vilket gjorde replay:openings
 * strukturellt blind för felmoden. Grinden ska spegla PRECIS den här modulen —
 * därför är API:t fruset och avsiktligt beroendefritt (bara ./geometry):
 *
 *   isCorroboratedTransit({ sogKn, prevFix, curFix }) -> boolean
 *     true  = det ensamma sog-värdet får bära beviset (kortslutning tillåten)
 *     false = rapporterad fart motsägs av fartygets egen förflyttning
 *
 *   explainTransitCorroboration({ sogKn, prevFix, curFix }) -> {
 *     corroborated, reason, dtMs, netM, impliedKn, prevAgeMs }
 *     Samma beslut plus mätvärdena, för loggrader och grindutskrifter.
 *     `reason` ∈ 'no_speed' | 'no_prev_fix' | 'prev_fix_stale' | 'no_dt'
 *               | 'no_geometry' | 'consistent' | 'speed_uncorroborated'.
 *
 *   prevFix/curFix = { lat, lon, ts, fixTs, feed } där
 *     ts    = MOTTAGNINGSTID (domän M, app.js: vessel.timestamp),
 *     fixTs = FIXTID (domän F, app.js: vessel.fixTs) — valfri,
 *     feed  = källa ('aisstream'/'aishub') — valfri, se dt-regeln nedan.
 *   Anroparen får utelämna fixTs/feed; då används enbart mottagningsklockan.
 *
 * Konstanterna nedan exporteras också (MAX_PREV_FIX_AGE_MS, MISMATCH_FACTOR
 * och KN_TO_MPS), så grinden aldrig kan hårdkoda en egen kopia som glider isär
 * (exakt den defekt M2 beskriver).
 */

// FÄRSKHETSKRAVET på föregående fix. 4 minuter, härlett två oberoende vägar
// som möts på samma tal:
//  (1) KADENS. Positionsdeltat är bara ett mått på FARTEN om intervallet är
//      ETT rapportglapp, inte en tystnad. I 'both'-läget (där felfallet
//      inträffade) var kajliggarnas VÄRSTA uppmätta glapp 3,5 min
//      (QUAY_DEPARTURE_GATE.MEMORY_MS:s egen mätning på nattkorpusen), medan
//      solo-aisstream rutinmässigt hade 15–120 min. 4 min täcker alltså hela
//      den mätbara kadensen med marginal och utesluter tystnadsklassen
//      (265726650:s 70 min).
//  (2) GEOMETRI. Vid medianfarten för en äkta anflygning (3,13 kn = 1,61 m/s)
//      tillryggaläggs 386 m på 4 minuter — mer än hela kaj→bro-sträckan vid
//      målbroarna (200–400 m). Bortom det kan ett fartyg ha lämnat kajen,
//      nått bron och kommit tillbaka mellan två fixar, och deltat mellan
//      ändpunkterna säger då ingenting om vad som hände däremellan.
const MAX_PREV_FIX_AGE_MS = 4 * 60 * 1000;

// HUR GROV måste oförenligheten vara? Faktor 4 = 2 × 2,0, där 2,0 är
// movementPlausibility.MOVEMENT_MARGIN_FACTOR — appens redan MÄTTA marginal
// mot AIS-avrundad fart och kurvtagning (kortaste vägen mellan två fixar är en
// rät linje; en båt som svänger går längre än kordan). Vi kräver alltså att
// den rapporterade farten överstiger även en DUBBELT så generös tolkning av
// förflyttningen innan vi vägrar kortslutningen. Talet är inte importerat utan
// utskrivet, för att modulen ska vara beroendefri åt grindfilen — höjs
// MOVEMENT_MARGIN_FACTOR ska den här härledningen prövas om.
// Mätt utfall: CARAT-fallet ger kvoten 7,4/1,47 = 5,0 och fälls med marginal;
// AKIRA-klassens kajvobbel (1,1 kn) når aldrig ens 3,13-tröskeln.
const MISMATCH_FACTOR = 4;

// KNOP → METER PER SEKUND. Talet är app.js egen omräkning (samma 0,5144 som
// rörelse- och passagegrindarna där), inte SI-definitionens 0,514444 — och det
// är AVSIKTLIGT: den implicerade farten här ska jämföras med samma skala som
// produktionen mäter i. Exporteras (M2-SSOT, 4c) därför att grindfilen hade
// hunnit skriva en EGEN kopia med 0,514444: två sidor som ska spegla PRECIS
// samma regel räknade om knop olika. Skillnaden är 0,009 % och hade noll
// uppmätt utslag — men det är exakt den glidning modulen finns för att stänga.
const KN_TO_MPS = 0.5144;

/** @private */
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Alla användbara tidsseparationer mellan två fixar, i millisekunder.
 *
 * FIXKLOCKAN används bara inom SAMMA källa. Det är exakt GPSJumpAnalyzer.
 * fixDtMs:s egen regel: två källors fixTs är visserligen båda emissionsnära,
 * men korskälleseparationen bär hubbens pollfördröjning och kan både krympa
 * och vidga fönstret godtyckligt. Saknar anroparen feed-fält behandlas
 * fixklockan som osäker och utelämnas.
 * @private
 * @returns {number[]} positiva separationer (kan vara tom)
 */
function separationsMs(prevFix, curFix) {
  const out = [];
  const recvDt = (Number.isFinite(prevFix.ts) && Number.isFinite(curFix.ts))
    ? curFix.ts - prevFix.ts : null;
  if (Number.isFinite(recvDt) && recvDt > 0) out.push(recvDt);
  const sameFeed = !prevFix.feed || !curFix.feed || prevFix.feed === curFix.feed;
  const fixDt = (sameFeed && Number.isFinite(prevFix.fixTs) && Number.isFinite(curFix.fixTs))
    ? curFix.fixTs - prevFix.fixTs : null;
  if (Number.isFinite(fixDt) && fixDt > 0) out.push(fixDt);
  return out;
}

/**
 * Full utvärdering med mätvärden — se modulens docblock för API-kontraktet.
 * @param {Object} input
 * @param {number} input.sogKn - rapporterad fart i det ensamma samplet
 * @param {Object|null} input.prevFix - {lat, lon, ts, fixTs?, feed?}
 * @param {Object|null} input.curFix - {lat, lon, ts, fixTs?, feed?}
 * @returns {{corroborated: boolean, reason: string, dtMs: number|null,
 *   netM: number|null, impliedKn: number|null, prevAgeMs: number|null}}
 */
function explainTransitCorroboration(input) {
  const base = {
    corroborated: true, reason: 'no_prev_fix', dtMs: null, netM: null, impliedKn: null, prevAgeMs: null,
  };
  const sogKn = input ? finiteOrNull(input.sogKn) : null;
  // Ingen rapporterad fart = inget påstående att korroborera. Anroparen ska
  // aldrig nå hit (kortslutningen kräver finit sog), men svaret måste vara
  // STRIKT: utan fart finns inget enkelsampel-bevis.
  if (sogKn === null) return { ...base, corroborated: false, reason: 'no_speed' };

  const prevFix = input.prevFix || null;
  const curFix = input.curFix || null;
  if (!prevFix || !curFix) return base;

  const seps = separationsMs(prevFix, curFix);
  if (seps.length === 0) return { ...base, reason: 'no_dt' };
  // ÅLDERN mäts på den STÖRSTA separationen och FARTEN på den MINSTA. Båda
  // valen pekar åt fail-open: en stor ålder gör föregående fix "för gammal"
  // (kortslutningen behålls), och en liten dt ger den HÖGSTA implicerade
  // farten, alltså den mest generösa tolkningen av båtens förflyttning.
  const prevAgeMs = Math.max(...seps);
  const dtMs = Math.min(...seps);
  if (prevAgeMs > MAX_PREV_FIX_AGE_MS) {
    return {
      ...base, reason: 'prev_fix_stale', dtMs, prevAgeMs,
    };
  }

  const netM = geometry.calculateDistance(prevFix.lat, prevFix.lon, curFix.lat, curFix.lon);
  if (!Number.isFinite(netM)) {
    return {
      ...base, reason: 'no_geometry', dtMs, prevAgeMs,
    };
  }
  const impliedKn = (netM / (dtMs / 1000)) / KN_TO_MPS;
  const corroborated = impliedKn * MISMATCH_FACTOR >= sogKn;
  return {
    corroborated,
    reason: corroborated ? 'consistent' : 'speed_uncorroborated',
    dtMs,
    netM,
    impliedKn,
    prevAgeMs,
  };
}

/**
 * Får det ensamma sog-värdet bära transitbeviset? Tunn omslagare kring
 * explainTransitCorroboration — se modulens docblock.
 * @param {Object} input - {sogKn, prevFix, curFix}
 * @returns {boolean} true = kortslutning tillåten (fail-open vid omätbart)
 */
function isCorroboratedTransit(input) {
  return explainTransitCorroboration(input).corroborated;
}

module.exports = {
  isCorroboratedTransit,
  explainTransitCorroboration,
  MAX_PREV_FIX_AGE_MS,
  MISMATCH_FACTOR,
  KN_TO_MPS,
};
