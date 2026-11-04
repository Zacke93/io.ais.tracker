'use strict';

/**
 * VÄRLDSMODELLEN (L0), BUGGJAKT.md §4.1.
 *
 * Varje båt är en bana s(t), l(t), v(t) längs farledens centerlinje,
 * simulerad i steg om 1 s ur en deklarativ plan. Banan ÄR den fysiska
 * sanningen; radion (radio.js) avgör vad appen får se av den.
 *
 * Kinematik: acceleration 0,04 m/s², inbromsning 0,06 m/s². Önskad fart är
 * marschfart × sektorfaktor, där sektorfaktorn är sektormedianen / 4,6 kn
 * klippt till 0,6–1,3. Sidledsläget följer en OU-process (τ 90 s) mot båtens
 * fil; under kö flyttas filen till köfilen.
 *
 * Planprimitiver (deklarativ JSON som simulatorn bara läser):
 *   queue{bridge, distM, durS}  stannar exakt distM före stationen
 *   stop{atS, durS}             stannar vid farledskoordinaten atS
 *   crawl{bridge, withinM, kn}  kryper med kn inom withinM före bron
 *   uturn{atS}                  bromsar, vänder 180° och kör tillbaka
 *   role 'moored'               ligger vid kaj {lat, lon} i durS sekunder
 *
 * SPECEN ÄNDRAS ALDRIG. Simulatorn läser den och bygger egna objekt, så den
 * fungerar på en djupfryst spec (rundresan i självtestet kräver det).
 */

const geo = require('./geo');
const cal = require('./calib');
const { stream } = require('./rng');

const KN = 0.514444; // m/s per knop
const A_UP = 0.04; // m/s²
const A_DN = 0.06; // m/s²
const S_MIN = -400; // bortom radiohorisonten i söder (boxkanten ligger vid s ≈ −210)
const S_MAX = 7200; // bortom radiohorisonten i norr (boxkanten ligger vid s ≈ 7050)
const LANE_TAU_S = 90;
const MAX_SIM_S = 8 * 3600;

// Sektorfaktor per (sektor, riktning), beräknad en gång: sektormedianen /
// 4,6 kn klippt till 0,6–1,3.
const FACTOR = { 1: [], '-1': [] };
geo.SECTORS.forEach((sec, k) => {
  for (const [dir, sv] of [[1, 'nord'], [-1, 'syd']]) {
    const med = cal.sectorMedian[`${sec}|${sv}`] || 4.6;
    FACTOR[dir][k] = Math.max(0.6, Math.min(1.3, med / 4.6));
  }
});
const sectorFactor = (s, dir) => FACTOR[dir][geo.sectorIndex(s)];

/**
 * Simulera EN båt. Returnerar banan i steg om 1 s samt stopp och U-svängar.
 * @param {object} b - båtens spec (läses, ändras aldrig)
 * @returns {{traj:object[], stops:object[], uturns:object[]}} bana och händelser
 */
function simulateBoat(b) {
  const traj = [];
  const stops = [];
  const uturns = [];
  if (b.role === 'moored') {
    const p = geo.project(b.quay.lat, b.quay.lon);
    for (let t = b.tStartS; t <= b.tStartS + b.durS; t += 1) {
      traj.push({
        t, s: p.s, l: 0, v: 0, dir: 0, phase: 'moored', lat: b.quay.lat, lon: b.quay.lon, bearing: null,
      });
    }
    stops.push({
      t0: b.tStartS, t1: b.tStartS + b.durS, s: p.s, kind: 'moor', lat: b.quay.lat, lon: b.quay.lon,
    });
    return { traj, stops, uturns };
  }
  let t = b.tStartS;
  let s = b.sStart;
  let dir = b.dir === 'north' ? 1 : -1;
  let v = Number.isFinite(b.v0Kn) ? b.v0Kn * KN : b.cruiseKn * KN * 0.8;
  let l = b.laneM || 0;
  const lateralSigma = Number.isFinite(b.lateralSigma) ? b.lateralSigma : 0.45;
  const rnd = stream(b.seed || 1, `lat-${b.mmsi}`);
  // Egen arbetskopia av planen: specens element fryses och får inte märkas.
  const plan = (b.plan || []).map((p) => ({ ...p, done: false }));
  let waitUntil = null;
  let waitKind = null;
  let waitStart = null;
  let waitS = null;
  let endS = b.sEnd;
  let guard = 0;
  while (s >= S_MIN && s <= S_MAX && guard++ < MAX_SIM_S) {
    const step = plan.find((p) => !p.done);
    let vDes = b.cruiseKn * KN * sectorFactor(s, dir);
    let phase = 'cruise';
    if (waitUntil !== null) {
      v = 0;
      phase = waitKind;
      if (t >= waitUntil) {
        stops.push({
          t0: waitStart, t1: t, s: waitS, kind: waitKind, lat: null, lon: null,
        });
        waitUntil = null;
        step.done = true;
        phase = 'depart';
      }
    } else if (step) {
      if (step.op === 'queue' || step.op === 'stop') {
        const sStop = step.op === 'queue' ? geo.stationByName[step.bridge].s - (dir * step.distM) : step.atS;
        const ahead = (sStop - s) * dir;
        if (ahead > -2) {
          vDes = Math.min(vDes, Math.sqrt(2 * A_DN * Math.max(0, ahead)));
          if (ahead < 400) phase = 'approach-stop';
          if (ahead < 1.5 && v < 0.15) {
            waitUntil = t + step.durS;
            waitKind = step.op;
            waitStart = t;
            waitS = s;
            v = 0;
          }
        } else step.done = true; // redan förbi (planfel): hoppa över elementet
      } else if (step.op === 'crawl') {
        const ahead = (geo.stationByName[step.bridge].s - s) * dir;
        if (ahead < -60) step.done = true;
        else if (ahead < step.withinM) {
          vDes = Math.min(vDes, step.kn * KN);
          phase = 'crawl';
        }
      } else if (step.op === 'uturn') {
        const ahead = (step.atS - s) * dir;
        if (ahead <= 0 || (ahead < 30 && v < 0.2)) {
          dir = -dir;
          step.done = true;
          uturns.push({ t, s });
          v = 0.1;
          phase = 'uturn';
          endS = dir === 1 ? S_MAX - 50 : S_MIN + 50;
        } else vDes = Math.min(vDes, Math.max(0.25, Math.sqrt(2 * A_DN * ahead)));
      }
    }
    if (waitUntil === null) {
      if (v < vDes) v = Math.min(vDes, v + A_UP);
      else v = Math.max(vDes, v - A_DN);
    }
    let lMu = b.laneM || 0;
    if (waitUntil !== null && Number.isFinite(b.queueLaneM)) lMu = b.queueLaneM;
    l += ((lMu - l) / LANE_TAU_S) + (lateralSigma * rnd.normal());
    s += dir * v;
    t += 1;
    traj.push({
      t, s, l, v: dir * v, dir, phase,
    });
    if (endS !== null && endS !== undefined && ((dir === 1 && s >= endS) || (dir === -1 && s <= endS))) break;
  }
  return { traj, stops, uturns };
}

/**
 * Simulera en hel värld. Specen läses och ändras aldrig; banorna får
 * lat/lon via farledens invers.
 * @param {object} world - världens spec (får vara djupfryst)
 * @returns {{world:object, boats:object[]}} simulering
 */
function simulateWorld(world) {
  const boats = world.boats.map((b) => ({ spec: b, ...simulateBoat(b) }));
  for (const bt of boats) {
    for (const p of bt.traj) {
      if (p.lat === undefined) {
        const q = geo.pointAt(p.s, p.l);
        p.lat = q.lat;
        p.lon = q.lon;
        p.bearing = q.bearing;
      }
    }
    for (const st of bt.stops) {
      if (st.lat === null) {
        const at = bt.traj.find((p) => p.t >= st.t0) || bt.traj[bt.traj.length - 1];
        st.lat = at.lat;
        st.lon = at.lon;
      }
    }
  }
  return { world, boats };
}

/**
 * Banans tillstånd vid tiden tS (närmaste sekund) eller null utanför banan.
 * @param {object} bt - simulerad båt
 * @param {number} tS - sekunder från världens start
 * @returns {object|null} banpunkt
 */
function truthAt(bt, tS) {
  const tr = bt.traj;
  if (!tr.length) return null;
  const i = Math.round(tS - tr[0].t);
  if (i < 0 || i >= tr.length) return null;
  return tr[i];
}

module.exports = {
  simulateBoat, simulateWorld, truthAt, KN, A_UP, A_DN, S_MIN, S_MAX,
};
