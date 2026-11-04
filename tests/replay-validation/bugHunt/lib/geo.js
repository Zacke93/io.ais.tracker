'use strict';

/**
 * Farledsgeometri för sanningsspåret (BUGGJAKT.md §4.1).
 *
 * Polylinjen och de frusna brostationerna är EXAKT rådatafacitets
 * (makeGtPassages.buildFairway och BRIDGE_STATIONS), så att världens s-värden
 * och facit mäter längs samma linje. pointAt(s, l) är inversen till
 * projectFix: för en punkt på linjen eller med sidoffset l ger
 * project(pointAt(s, l)) tillbaka s och |l|.
 *
 * Notispunkterna (fem broar och Kanalinfarten) tas ur produktens konstanter,
 * eftersom det är där appen faktiskt utlöser notiser. Inga produktbeslut
 * kopieras här, bara koordinater och radier.
 */

const gt = require('../../makeGtPassages');
const C = require('../../../../lib/constants');
const { calculateDistance } = require('../../../../lib/utils/geometry');
const { fromPairs } = require('./rng');

const M_PER_DEG_LAT = 111320;
const FW = gt.buildFairway();

/** Brostationer längs farleden med produktens koordinater. */
const STATIONS = gt.BRIDGE_STATIONS.map((b) => ({
  id: b.id, name: b.name, s: b.s, lat: C.BRIDGES[b.id].lat, lon: C.BRIDGES[b.id].lon,
}));
const stationByName = fromPairs(STATIONS.map((b) => [b.name, b]));

/** Kanalinfarten (triggerpunkt med radie), frusen i rådatafacit. */
const K = gt.KANALINFARTEN;
const S_K = gt.projectFix(FW, K.lat, K.lon).s; // ≈ 296 m

/** Målbroarna (produktens lista). */
const TARGETS = [...C.TARGET_BRIDGES];

/**
 * Notispunkterna i appens mening: fem broar och Kanalinfarten.
 * @type {{name:string, lat:number, lon:number, radiusM:number, s:number}[]}
 */
const NOTICE_POINTS = [
  {
    name: K.name, lat: K.lat, lon: K.lon, radiusM: C.TRIGGER_POINTS.kanalinfarten.radius, s: S_K,
  },
  ...STATIONS.map((b) => ({
    name: b.name, lat: b.lat, lon: b.lon, radiusM: C.BRIDGES[b.id].radius, s: b.s,
  })),
];
const noticePointByName = fromPairs(NOTICE_POINTS.map((p) => [p.name, p]));

// Segmentkonstanter beräknas en gång (samma uttryck som tidigare per anrop,
// alltså bitlika resultat) och segmentet hittas med binärsökning.
const LEG_END = FW.legs.map((leg) => leg.cum + leg.len);
const LEG_K = FW.legs.map((leg) => {
  const mLon = M_PER_DEG_LAT * Math.cos(leg.a.lat * (Math.PI / 180));
  const dx = (leg.b.lon - leg.a.lon) * mLon;
  const dy = (leg.b.lat - leg.a.lat) * M_PER_DEG_LAT;
  const len = Math.hypot(dx, dy);
  return {
    mLon, dx, dy, nx: dy / len, ny: dx / len, bearing: (((Math.atan2(dx, dy) * 180) / Math.PI) + 360) % 360,
  };
});

function legIndexAt(s) {
  const n = FW.legs.length;
  if (s <= 0) return 0;
  if (s >= FW.lengthM) return n - 1;
  // Första segment med s ≤ cum + len (samma villkor som en linjär sökning).
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s <= LEG_END[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Position vid farledskoordinat s (m från sydspetsen) och sidoffset l
 * (m, positivt = höger om norrgående). Ändsegmenten förlängs, så s < 0 och
 * s > lengthM ger punkter bortom kartänden (samma val som projectFix).
 * @param {number} s - sträcka längs farleden (m)
 * @param {number} [l=0] - sidoffset (m)
 * @returns {{lat:number, lon:number, bearing:number}} position och kurs norrut
 */
function pointAt(s, l = 0) {
  const i = legIndexAt(s);
  const leg = FW.legs[i];
  const k = LEG_K[i];
  // Andelen längs det ekvirektangulära segmentet. projectFix räknar t på
  // samma ekvirektangulära vektor men s med leg.len (haversine); t = (s − cum)/len.
  const f = (s - leg.cum) / leg.len;
  const x = (f * k.dx) + (k.nx * l);
  const y = (f * k.dy) - (k.ny * l);
  return { lat: leg.a.lat + (y / M_PER_DEG_LAT), lon: leg.a.lon + (x / k.mLon), bearing: k.bearing };
}

/**
 * Projicera en position på farleden (rådatafacitets projectFix).
 * @param {number} lat - latitud
 * @param {number} lon - longitud
 * @returns {{s:number, offsetM:number}} sträcka och sidoavstånd
 */
const project = (lat, lon) => gt.projectFix(FW, lat, lon);

/**
 * Avstånd (m) till en notispunkt eller bro.
 * @param {number} lat - latitud
 * @param {number} lon - longitud
 * @param {string} name - punktens namn
 * @returns {number} avstånd i meter
 */
function distToPoint(lat, lon, name) {
  const p = noticePointByName[name];
  if (!p) throw new Error(`Okänd notispunkt: ${name}`);
  return calculateDistance(lat, lon, p.lat, p.lon);
}
const distToBridge = distToPoint;
const distToK = (lat, lon) => calculateDistance(lat, lon, K.lat, K.lon);

/**
 * Närmaste notispunkt (fem broar och Kanalinfarten). Stridsbergsbron och
 * Järnvägsbron ligger bara 257 m isär, så en fix inom 300 m från båda räknas
 * till den som ligger närmast.
 * @param {number} lat - latitud
 * @param {number} lon - longitud
 * @returns {{name:string, distM:number}} punkt och avstånd
 */
function nearestNoticePoint(lat, lon) {
  let best = null;
  for (const p of NOTICE_POINTS) {
    const d = calculateDistance(lat, lon, p.lat, p.lon);
    if (best === null || d < best.distM) best = { name: p.name, distM: d };
  }
  return best;
}

/**
 * Radiohorisonten: bevakningsboxen plus uppmätt marginal i korpusarna
 * (lat 58,2649–58,3208, lon ≤ 12,3239). Utanför den hörs inga båtar.
 * @param {number} lat - latitud
 * @param {number} lon - longitud
 * @returns {boolean} inom hörhåll
 */
const RADIO_BOX = {
  latMin: 58.2649, latMax: 58.3208, lonMin: 12.2600, lonMax: 12.3239,
};
const inRadioBox = (lat, lon) => lat >= RADIO_BOX.latMin && lat <= RADIO_BOX.latMax
  && lon >= RADIO_BOX.lonMin && lon <= RADIO_BOX.lonMax;

/** Sektorgränserna längs farleden (samma indelning som generator-spec.json). */
const SECTORS = ['0 S-om-infarten', '1 Infarten–Olide', '2 Olide–Klaff', '3 Klaff–Jvb', '4 Jvb–Strids', '5 Strids–Stallbacka', '6 N-om-Stallbacka'];
function sectorIndex(s) {
  if (s < S_K) return 0;
  if (s < stationByName.Olidebron.s) return 1;
  if (s < stationByName.Klaffbron.s) return 2;
  if (s < stationByName['Järnvägsbron'].s) return 3;
  if (s < stationByName.Stridsbergsbron.s) return 4;
  if (s < stationByName.Stallbackabron.s) return 5;
  return 6;
}
function sectorOf(s) {
  if (s < S_K) return '0 S-om-infarten';
  if (s < stationByName.Olidebron.s) return '1 Infarten–Olide';
  if (s < stationByName.Klaffbron.s) return '2 Olide–Klaff';
  if (s < stationByName['Järnvägsbron'].s) return '3 Klaff–Jvb';
  if (s < stationByName.Stridsbergsbron.s) return '4 Jvb–Strids';
  if (s < stationByName.Stallbackabron.s) return '5 Strids–Stallbacka';
  return '6 N-om-Stallbacka';
}

module.exports = {
  FW,
  STATIONS,
  stationByName,
  K,
  S_K,
  TARGETS,
  NOTICE_POINTS,
  noticePointByName,
  RADIO_BOX,
  pointAt,
  project,
  distToPoint,
  distToBridge,
  distToK,
  nearestNoticePoint,
  inRadioBox,
  SECTORS,
  sectorIndex,
  sectorOf,
  calculateDistance,
  C,
};
