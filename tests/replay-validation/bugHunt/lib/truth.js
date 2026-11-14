'use strict';

/**
 * SANNINGEN, BUGGJAKT.md §4.1 och §4.3.
 *
 * L0 (fysisk sanning) ur den kontinuerliga banan: exakta, interpolerade
 * brokorsningar; radiebesök inom 300 m från broarna; Kanalinfartens
 * zonbesök; stopp och U-svängar; avsikten (planen).
 *
 * L1 (observerbar sanning) är vad en idealisk observatör av radioströmmen
 * kunde veta. En korsning är PUNKTOBSERVERBAR när radion levererat fixar på
 * båda sidor med högst 900 s emellan; med större glapp är den INFERRED (samma
 * regel som buildFacit); utan fixar på båda sidor finns den inte i L1. För
 * varje korsning bokförs t_obs (leveranstiden för första fixen efter), och
 * för varje fix närmaste notispunkt.
 *
 * DOMREGELN: förutsättningarna (vad appen borde ha gjort) tas ur L1, felet
 * mäts mot L0. Oraklen tar sanningsgränssnittet {L1, L0?}: L1 krävs och L0
 * är valfritt, så att samma kod kan kalibreras på banken (bankTruth).
 *
 * Tider är epok-ms i fejkklockans domän: t = startMs + sekunder · 1000.
 */

const fs = require('fs');
const path = require('path');
const geo = require('./geo');
const { fromPairs } = require('./rng');

const INFERRED_GAP_S = 900; // samma gräns som makeGtPassages.INFERRED_GAP_S
const VISIT_RADIUS_M = 300; // broarnas och Kanalinfartens radie (BRIDGES/TRIGGER_POINTS)
const MOVING_MPS = 0.5; // besöket räknas som rörligt om max |v| ≥ 0,5 m/s
const PREFILTER_M = 600;
const M_PER_DEG_LAT = 111320;
const INNER2 = 290 * 290;
const OUTER2 = 310 * 310;
const mkPt = (name, lat, lon, s) => ({
  name, lat, lon, s, mLon: M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180),
});
const STATION_PTS = geo.STATIONS.map((st) => mkPt(st.name, st.lat, st.lon, st.s));
const K_PT = mkPt(geo.K.name, geo.K.lat, geo.K.lon, geo.S_K);

/**
 * L0 ur en simulering.
 * @param {{world:object, boats:object[]}} sim - simulateWorld-resultat
 * @returns {object} L0 {startMs, endMs, crossings, radius, kVisits, stops,
 *   uturns, intent, boats: Map(mmsi → {spec, traj})}
 */
function deriveTruth(sim) {
  const T0 = sim.world.startMs;
  const ms = (tS) => T0 + Math.round(tS * 1000);
  const crossings = [];
  const radius = [];
  const kVisits = [];
  const stops = [];
  const uturns = [];
  const intent = [];
  const boats = new Map();
  let endS = 0;
  for (const bt of sim.boats) {
    const b = bt.spec;
    const tr = bt.traj;
    const mmsi = String(b.mmsi);
    boats.set(mmsi, bt);
    if (tr.length) endS = Math.max(endS, tr[tr.length - 1].t);
    intent.push({
      mmsi, role: b.role, dir: b.dir || null, plan: b.plan || [], tags: b.tags || [], fokal: !!b.fokal,
    });
    if (b.role !== 'moored') {
      for (const st of geo.STATIONS) {
        for (let i = 1; i < tr.length; i++) {
          const a = tr[i - 1].s - st.s;
          const c = tr[i].s - st.s;
          if ((a < 0 && c >= 0) || (a > 0 && c <= 0)) {
            const f = a / (a - c);
            crossings.push({
              mmsi,
              bridge: st.name,
              t: T0 + ((tr[i - 1].t + f) * 1000),
              dir: c > a ? 'nord' : 'syd',
              kn: Math.round((Math.abs(tr[i].v) / 0.514444) * 100) / 100,
            });
          }
        }
      }
    }
    // Radiebesök: sammanhängande sekunder inom 300 m från punkten.
    // Tvåstegsfilter, samma klassning som ren haversine: farleden är nästan
    // rak (avböjning < 11° per segment), så en punkt mer än 600 m längs
    // farleden ligger säkert utanför; därefter avgör ett ekvirektangulärt
    // avstånd (fel < 0,5 m på 300 m) utom i bandet 290–310 m, där haversine
    // (produktens calculateDistance) räknas exakt.
    const segs = (pt) => {
      const out = [];
      let cur = null;
      for (const p of tr) {
        let inside = false;
        let d2 = Infinity;
        if (Math.abs(p.s - pt.s) <= PREFILTER_M) {
          const dy = (p.lat - pt.lat) * M_PER_DEG_LAT;
          const dx = (p.lon - pt.lon) * pt.mLon;
          d2 = (dx * dx) + (dy * dy);
          if (d2 < INNER2) inside = true;
          else if (d2 <= OUTER2) inside = geo.calculateDistance(p.lat, p.lon, pt.lat, pt.lon) <= VISIT_RADIUS_M;
        }
        if (inside) {
          if (!cur) {
            cur = {
              t0: p.t, t1: p.t, maxV: 0, minD2: d2,
            };
          }
          cur.t1 = p.t;
          cur.maxV = Math.max(cur.maxV, Math.abs(p.v));
          cur.minD2 = Math.min(cur.minD2, d2);
        } else if (cur) {
          out.push(cur);
          cur = null;
        }
      }
      if (cur) out.push(cur);
      for (const sg of out) sg.minD = Math.sqrt(sg.minD2);
      return out;
    };
    for (const st of STATION_PTS) {
      for (const sg of segs(st)) {
        radius.push({
          mmsi, bridge: st.name, tIn: ms(sg.t0), tOut: ms(sg.t1), moving: sg.maxV >= MOVING_MPS, minDistM: Math.round(sg.minD),
        });
      }
    }
    for (const sg of segs(K_PT)) {
      kVisits.push({
        mmsi, bridge: geo.K.name, tIn: ms(sg.t0), tOut: ms(sg.t1), moving: sg.maxV >= MOVING_MPS, minDistM: Math.round(sg.minD),
      });
    }
    for (const s of bt.stops) {
      stops.push({
        mmsi, t0: ms(s.t0), t1: ms(s.t1), kind: s.kind, s: Math.round(s.s), lat: s.lat, lon: s.lon,
      });
    }
    for (const u of bt.uturns) uturns.push({ mmsi, t: ms(u.t), s: Math.round(u.s) });
  }
  crossings.sort((a, b) => (a.t - b.t) || a.mmsi.localeCompare(b.mmsi) || a.bridge.localeCompare(b.bridge));
  radius.sort((a, b) => (a.tIn - b.tIn) || a.mmsi.localeCompare(b.mmsi) || a.bridge.localeCompare(b.bridge));
  kVisits.sort((a, b) => (a.tIn - b.tIn) || a.mmsi.localeCompare(b.mmsi));
  return {
    startMs: T0, endMs: ms(endS), crossings, radius, kVisits, stops, uturns, intent, boats,
  };
}

/**
 * Observerade fixar per mmsi i leveransordning, med farledsprojektion och
 * närmaste notispunkt.
 * @param {object[]} rows - världens eller korpusens rader
 * @returns {Map<string, object[]>} fixar per mmsi
 */
function fixesByMmsi(rows) {
  const by = new Map();
  rows.forEach((r, line) => {
    if (r.ctrl || typeof r.lat !== 'number' || typeof r.lon !== 'number' || !Number.isFinite(r.aisTimestamp)) return;
    const k = String(r.mmsi);
    if (!by.has(k)) by.set(k, []);
    const proj = geo.project(r.lat, r.lon);
    const nearest = geo.nearestNoticePoint(r.lat, r.lon);
    by.get(k).push({
      line: line + 1,
      mmsi: k,
      aisTimestamp: r.aisTimestamp,
      fixTs: Number.isFinite(r.fixTs) ? r.fixTs : r.aisTimestamp,
      lat: r.lat,
      lon: r.lon,
      sog: Number.isFinite(r.sog) ? r.sog : null,
      cog: Number.isFinite(r.cog) ? r.cog : null,
      navStatus: Number.isFinite(r.navStatus) ? r.navStatus : null,
      feed: r.feed || 'aisstream',
      s: proj.s,
      offsetM: proj.offsetM,
      nearest: nearest.name,
      nearestM: nearest.distM,
    });
  });
  for (const l of by.values()) l.sort((a, b) => (a.aisTimestamp - b.aisTimestamp) || (a.line - b.line));
  return by;
}

/**
 * L1: observerbarheten för varje L0-korsning plus fixarna.
 * Sidan bestäms på fixens farledskoordinat och fixtid (fixTs), med gränser
 * mot samma båts föregående och nästa korsning av samma station så att en
 * U-svängares två passager inte lånar varandras fixar.
 * @param {object} L0 - deriveTruth-resultat
 * @param {object[]} rows - världens rader
 * @returns {object} L1 {crossings, fixes, source:'L1'}
 */
function deriveObservable(L0, rows) {
  const fixes = fixesByMmsi(rows);
  const crossings = [];
  const byKey = new Map();
  for (const c of L0.crossings) {
    const k = `${c.mmsi}|${c.bridge}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => a.t - b.t);
    list.forEach((c, i) => {
      const prevT = i > 0 ? list[i - 1].t : -Infinity;
      const nextT = i + 1 < list.length ? list[i + 1].t : Infinity;
      const own = fixes.get(c.mmsi) || [];
      const sB = geo.stationByName[c.bridge].s;
      const sign = c.dir === 'nord' ? 1 : -1;
      const side = (f) => Math.sign((f.s - sB) * sign); // −1 före, +1 efter
      let before = null;
      let after = null;
      for (const f of own) {
        if (f.fixTs > prevT && f.fixTs <= c.t && side(f) < 0) {
          if (!before || f.fixTs >= before.fixTs) before = f;
        }
        if (f.fixTs >= c.t && f.fixTs < nextT && side(f) > 0) {
          if (!after || f.fixTs < after.fixTs) after = f;
        }
      }
      if (!before || !after) return;
      const gapS = (after.fixTs - before.fixTs) / 1000;
      crossings.push({
        ...c,
        source: 'L1',
        kind: 'line',
        inferred: gapS > INFERRED_GAP_S,
        gapS: Math.round(gapS),
        tFrom: before.aisTimestamp,
        tTo: after.aisTimestamp,
        tObs: after.aisTimestamp,
        beforeM: Math.round(geo.distToBridge(before.lat, before.lon, c.bridge)),
        afterM: Math.round(geo.distToBridge(after.lat, after.lon, c.bridge)),
      });
    });
  }
  crossings.sort((a, b) => (a.t - b.t) || a.mmsi.localeCompare(b.mmsi) || a.bridge.localeCompare(b.bridge));
  return { source: 'L1', crossings, fixes };
}

/**
 * gt-adaptern: L1-korsningar i rådatafacitets format (gtTargetPassages,
 * analyseCoverage, analysePhantoms, validateWarnInvariants).
 * Syntetiska punktobserverbara korsningar får punktfönstret tFrom = tTo = t
 * (sann L0-tid); inferred och bankens facit (source 'gt') behåller radions
 * fönster, precis som gtTargetPassages.
 * `tObs` (V4/V2 rev 1, granskningen 2026-11-14) är mottagningstiden för första
 * fixen bortom linjen, samma sak som `tTo` betyder i bankens rådatafacit.
 * INV-22 dömer mot den, så att invarianten betyder detsamma i banken och i
 * sanningsspåret (med punktfönstret dömde den mot den sanna korsningen och
 * flaggade notiser i samma cykel som första fixen bortom linjen).
 * @param {object[]} l1Crossings - L1.crossings (eller bankens punktfacit)
 * @param {object} [opts] - {targetsOnly, pointOnly}
 * @returns {object[]} facitposter
 */
function asGt(l1Crossings, { targetsOnly = false, pointOnly = false } = {}) {
  return l1Crossings
    .filter((c) => (!targetsOnly || geo.TARGETS.includes(c.bridge)) && (!pointOnly || !c.inferred))
    .map((c) => {
      const window = c.inferred || c.source === 'gt';
      const tTo = window ? c.tTo : c.t;
      return {
        t: c.t,
        iso: new Date(Math.round(c.t)).toISOString(),
        mmsi: String(c.mmsi),
        bridge: c.bridge,
        kind: 'line',
        inferred: !!c.inferred,
        dir: c.dir || null,
        tFrom: window ? c.tFrom : c.t,
        tTo,
        tObs: Number.isFinite(c.tObs) ? c.tObs : tTo,
        source: c.source === 'gt' ? 'gt' : 'truth-L1',
      };
    })
    .sort((a, b) => a.t - b.t);
}

/**
 * Uppmätt täthetsnivå (BUGGJAKT.md §4.4): 'stress' om en kedja med minst
 * 6 korsningar av samma bro i samma riktning har högst 10 min mellanrum,
 * eller om fler än 9 båtar rör sig samtidigt (|v| ≥ 0,5 m/s, minutprov).
 * @param {object} L0 - deriveTruth-resultat
 * @returns {{nivå:string, längstaKedja:number, maxSamtidiga:number}} nivå
 */
function densityLevel(L0) {
  let longest = 0;
  const groups = new Map();
  for (const c of L0.crossings) {
    const k = `${c.bridge}|${c.dir}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c.t);
  }
  for (const ts of groups.values()) {
    ts.sort((a, b) => a - b);
    let run = 1;
    for (let i = 1; i < ts.length; i++) {
      run = ts[i] - ts[i - 1] <= 10 * 60000 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    longest = Math.max(longest, ts.length ? 1 : 0);
  }
  let maxMoving = 0;
  const startS = 0;
  const endS = Math.round((L0.endMs - L0.startMs) / 1000);
  for (let tS = startS; tS <= endS; tS += 60) {
    let n = 0;
    for (const bt of L0.boats.values()) {
      const tr = bt.traj;
      if (!tr.length) continue;
      const i = Math.round(tS - tr[0].t);
      if (i >= 0 && i < tr.length && Math.abs(tr[i].v) >= MOVING_MPS) n++;
    }
    maxMoving = Math.max(maxMoving, n);
  }
  const stress = longest >= 6 || maxMoving > 9;
  return { nivå: stress ? 'stress' : 'realistisk', längstaKedja: longest, maxSamtidiga: maxMoving };
}

/**
 * Sanningsgränssnittet för en syntetisk värld.
 * @param {object} sim - simulateWorld-resultat
 * @param {object[]} rows - radiorader
 * @returns {{L0:object, L1:object}} sanning
 */
function worldTruth(sim, rows) {
  const L0 = deriveTruth(sim);
  return { L0, L1: deriveObservable(L0, rows) };
}

/**
 * Bankens sanning för kalibreringen (BUGGJAKT.md §4.3): L1 = rådatafacitets
 * linjekorsningar i gt-passages (inferred-märkta; oraklen tar bara de
 * punktstämplade som förutsättning) plus raderna. Ingen L0.
 * @param {string} corpusId - korpus-id
 * @param {object[]} rows - korpusens rader
 * @param {object} [opts] - {gtDir} (standard tests/replay-validation/gt-passages)
 * @returns {{L1:object, L0:null}} sanning
 */
function bankTruth(corpusId, rows, { gtDir = path.join(__dirname, '..', '..', 'gt-passages'), statePath = null } = {}) {
  const file = path.join(gtDir, `${corpusId}.json`);
  if (!fs.existsSync(file)) throw new Error(`Rådatafacit saknas för ${corpusId}: ${file}`);
  const gt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const passages = Array.isArray(gt) ? gt : (gt.passages || []);
  const line = passages.filter((g) => g.kind !== 'zone');
  const crossings = line.map((g) => ({
    mmsi: String(g.mmsi),
    bridge: g.bridge,
    t: g.t,
    dir: g.dir || null,
    kind: 'line',
    inferred: g.inferred === true,
    gapS: g.gapS ?? null,
    tFrom: g.tFrom ?? g.t,
    tTo: g.tTo ?? g.t,
    tObs: g.tTo ?? g.t,
    source: 'gt',
  })).sort((a, b) => a.t - b.t);
  return {
    L0: null,
    L1: {
      source: 'gt', corpusId, crossings, fixes: fixesByMmsi(rows), openVisitsAtStart: openVisitsInState(corpusId, statePath),
    },
  };
}

/**
 * Besök som var ÖPPNA i korpusens starttillstånd (trigger_point_visits utan
 * exitedAt). Notisen för dem ligger före korpusen, så besöksregeln gäller
 * från första raden. Tom mängd när korpusen saknar .state.json.
 * @param {string} corpusId - korpus-id
 * @param {string|null} statePath - explicit sökväg, annars <jsonl>.state.json ur corpora.js
 * @returns {Set<string>} nycklar 'mmsi:punkt'
 */
function openVisitsInState(corpusId, statePath) {
  let file = statePath;
  if (!file) {
    const corpus = require('../../corpora').find((c) => c.id === corpusId); // eslint-disable-line global-require
    file = corpus ? corpus.jsonl.replace(/\.jsonl$/, '.state.json') : null;
  }
  const out = new Set();
  if (!file || !fs.existsSync(file)) return out;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = state && state.settings && state.settings.trigger_point_visits && state.settings.trigger_point_visits.entries;
  for (const [key, e] of Object.entries(entries || {})) if (e && (e.exitedAt === null || e.exitedAt === undefined)) out.add(key);
  return out;
}

/**
 * Sanningen i JSON-form för repro.truth.json (utan 1 s-banorna).
 * @param {{L0:object, L1:object}} truth - sanning
 * @returns {object} serialiserbar sanning
 */
function truthToJson(truth) {
  const { L0, L1 } = truth;
  return {
    L0: L0 ? {
      startMs: L0.startMs,
      endMs: L0.endMs,
      crossings: L0.crossings,
      radius: L0.radius,
      kVisits: L0.kVisits,
      stops: L0.stops,
      uturns: L0.uturns,
      intent: L0.intent,
    } : null,
    L1: {
      source: L1.source,
      crossings: L1.crossings,
      fixer: fromPairs([...L1.fixes.entries()].map(([m, l]) => [m, l.length])),
    },
  };
}

module.exports = {
  INFERRED_GAP_S,
  VISIT_RADIUS_M,
  MOVING_MPS,
  deriveTruth,
  deriveObservable,
  fixesByMmsi,
  asGt,
  densityLevel,
  worldTruth,
  bankTruth,
  openVisitsInState,
  truthToJson,
};
