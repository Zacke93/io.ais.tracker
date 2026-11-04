'use strict';

/**
 * Platser och avstånd för registrets predikat (och bankspårets tidslinjer).
 *
 * Koordinaterna läses ur produktens konstanter (lib/constants.js: BRIDGES,
 * TRIGGER_POINTS, MOORING_ZONES) och farledsprojektionen ur rådatafacitets
 * frusna centerlinje (makeGtPassages.buildFairway/projectFix) — samma
 * mätinstrument som gt-passages bygger på. Inga produktfunktioner som avgör
 * samma sak som ett orakel anropas härifrån.
 *
 * OBS för integratören: sanningsspårets lib/geo.js (byggare B) har egna
 * projektioner; den här modulen är medvetet liten och beroendefri.
 */

const constants = require('../../../../lib/constants');
const gt = require('../../makeGtPassages');
const { fromEntries } = require('./util');

const FAIRWAY = gt.buildFairway();
const EARTH_R = 6371000;

/** Notispunkterna: de fem broarna och Kanalinfarten. */
const POINTS = Object.freeze(fromEntries([
  ...Object.values(constants.BRIDGES).map((b) => [b.name, { name: b.name, lat: b.lat, lon: b.lon }]),
  ...Object.values(constants.TRIGGER_POINTS).map((p) => [p.name, { name: p.name, lat: p.lat, lon: p.lon }]),
]));
const POINT_NAMES = Object.freeze(Object.keys(POINTS));
const TARGET_BRIDGES = Object.freeze(['Klaffbron', 'Stridsbergsbron']);

const toRad = (d) => (d * Math.PI) / 180;

/** Storcirkelavstånd i meter. */
function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Avstånd (m) från en rad/position till en namngiven punkt. */
function distanceToPoint(pos, name) {
  const p = POINTS[name];
  if (!p || !pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return Infinity;
  return distanceM(pos.lat, pos.lon, p.lat, p.lon);
}

/** Närmaste notispunkt för en position. */
function nearestPoint(pos) {
  let best = null;
  let bestD = Infinity;
  for (const name of POINT_NAMES) {
    const d = distanceToPoint(pos, name);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** Projektion på farleden: {s (m längs leden), offsetM (sidled)}. */
function project(pos) {
  return gt.projectFix(FAIRWAY, pos.lat, pos.lon);
}

/** Stationens s (m) för en bro, eller Kanalinfartens projektion. */
function stationS(name) {
  const st = gt.BRIDGE_STATIONS.find((b) => b.name === name);
  if (st) return st.s;
  if (POINTS[name]) return project(POINTS[name]).s;
  return null;
}

/** Avstånd (m) från en punkt till en kapsels mittlinje (lokal plan approximation). */
function distanceToSegmentM(pos, start, end) {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(toRad(start.lat));
  const px = (pos.lon - start.lon) * mPerDegLon;
  const py = (pos.lat - start.lat) * mPerDegLat;
  const ex = (end.lon - start.lon) * mPerDegLon;
  const ey = (end.lat - start.lat) * mPerDegLat;
  const len2 = ex * ex + ey * ey;
  const u = len2 > 0 ? Math.max(0, Math.min(1, (px * ex + py * ey) / len2)) : 0;
  return Math.hypot(px - u * ex, py - u * ey);
}

/** Kajkapseln (MOORING_ZONES) som positionen ligger i, eller null. */
function capsuleOf(pos) {
  for (const z of constants.MOORING_ZONES) {
    if (distanceToSegmentM(pos, z.start, z.end) <= z.radiusM) return z;
  }
  return null;
}

/** Kortaste avstånd (m) från en kajkapsel till en punkt. */
function capsuleDistanceToPoint(zone, name) {
  const p = POINTS[name];
  if (!p) return Infinity;
  return Math.max(0, distanceToSegmentM(p, zone.start, zone.end) - zone.radiusM);
}

/** Observerade positionsrader per mmsi, sorterade på tid. */
function rowsByMmsi(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!r || r.ctrl || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const k = String(r.mmsi);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  for (const list of m.values()) list.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  return m;
}

module.exports = {
  FAIRWAY,
  POINTS,
  POINT_NAMES,
  TARGET_BRIDGES,
  distanceM,
  distanceToPoint,
  nearestPoint,
  project,
  stationS,
  distanceToSegmentM,
  capsuleOf,
  capsuleDistanceToPoint,
  rowsByMmsi,
};
