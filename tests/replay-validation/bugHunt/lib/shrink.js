'use strict';

/**
 * Krympning på specnivå (BUGGJAKT §8, byggplanens steg 10).
 *
 * Världen simuleras om ur den förenklade specen i varje prov, så sanningen
 * (L0/L1) följer med. Predikatet ("utslaget finns kvar") injiceras som
 * `holds(spec) → Promise<boolean>`; i motorn kräver det samma mekanism, samma
 * bro, minst ett inblandat mmsi och samma registerutfall
 * (synthCore.matchesTarget).
 *
 * Stegen:
 *   A   ta bort ctrl-händelser (disconnect/reconnect parvis)
 *   B0  tidsfokus: släng båtar utan aktivitet i [t − 45 min; t + 15 min]
 *   B1  pröva med bara den skyldiga båten
 *   B2  ddmin över båtarna (granularitet 2 → n), den skyldiga båten skyddad
 *   C   förenkla varje båt: ta bort planelement, fast 60 s-kadens (R1), inget
 *       brus, klass B → A, inget namnglapp; AISHub → aisstream för världen
 *   D   korta världen: kajliggarna slutar 15 min efter utslaget
 *   E   gränssök familjens nyckelparameter (högst 7 prov per parameter och
 *       högst 4 parametrar) och anteckna närmaste konstant inom 15 %
 *
 * Budget: 60 prov eller 90 s MODELLERAD körtid (poolens kostnadsmodell, inte
 * väggklockan, så att rapporten förblir deterministisk) per representant;
 * därefter märks fyndet "delvis krympt". Proven körs i fast ordning och varje
 * steg accepterar första (lägsta index) kandidat som håller, så samma indata
 * ger samma minsta repro.
 */

const constants = require('../../../../lib/constants');
const geo = require('./geo');
const { simulateBoat } = require('./world');

const MAX_PROV = 60;
const MAX_KOSTNAD_MS = 90000;
const MAX_PROV_PER_PARAMETER = 7;
const MAX_PARAMETRAR = 4;
const KONSTANT_TOLERANS = 0.15;
const FOKUS_FÖRE_MS = 45 * 60000;
const FOKUS_EFTER_MS = 15 * 60000;
const KAJ_EFTER_S = 15 * 60;

const clone = (x) => JSON.parse(JSON.stringify(x));
const BO = constants.BRIDGE_OPENING;

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Provbudget per representant.
 * @param {{maxProv?: number, maxKostnadMs?: number, stopp?: Function}} [o] - gränser och nödbroms
 * @returns {object} budget {prov, kostnadMs, slut(), skäl()}
 */
function makeBudget({ maxProv = MAX_PROV, maxKostnadMs = MAX_KOSTNAD_MS, stopp = null } = {}) {
  const b = {
    prov: 0,
    kostnadMs: 0,
    maxProv,
    maxKostnadMs,
    nödbroms: false,
    slut() {
      if (stopp && stopp()) b.nödbroms = true;
      return b.nödbroms || b.prov >= maxProv || b.kostnadMs >= maxKostnadMs;
    },
    skäl() {
      if (b.nödbroms) return 'nödbromsen (--max-minutes)';
      if (b.prov >= maxProv) return `taket ${maxProv} prov`;
      if (b.kostnadMs >= maxKostnadMs) return `taket ${Math.round(maxKostnadMs / 1000)} s modellerad körtid`;
      return null;
    },
  };
  return b;
}

// ---------------------------------------------------------------------------
// ddmin
// ---------------------------------------------------------------------------

/**
 * ddmin (Zeller) över en lista med skyddade element: komplementet av varje
 * bit prövas i ordning, och första som håller accepteras.
 * @param {Array} items - elementen
 * @param {Function} test - async (delmängd) → boolean
 * @param {{skyddade?: Array, budget?: object}} [opts] - skyddade element och budget
 * @returns {Promise<{mängd: Array, delvis: boolean}>} minsta mängd
 */
async function ddmin(items, test, { skyddade = [], budget = null } = {}) {
  let cur = [...items];
  let n = 2;
  for (;;) {
    const removable = cur.filter((x) => !skyddade.includes(x));
    if (!removable.length) break;
    const chunk = Math.ceil(removable.length / n);
    let reduced = false;
    for (let i = 0; i < removable.length; i += chunk) {
      if (budget && budget.slut()) return { mängd: cur, delvis: true };
      const drop = new Set(removable.slice(i, i + chunk));
      const cand = cur.filter((x) => !drop.has(x));
      if (!cand.length) continue; // den tomma mängden prövas aldrig
      // eslint-disable-next-line no-await-in-loop
      if (await test(cand)) {
        cur = cand;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= removable.length) break;
      n = Math.min(removable.length, n * 2);
    }
  }
  return { mängd: cur, delvis: false };
}

// ---------------------------------------------------------------------------
// Konstanter för gränsannoteringen (§4.4, "Närliggande konstanter")
// ---------------------------------------------------------------------------

// Kajens köundantag läses ur zonposten (constants.MOORING_ZONES, "Kajen norr
// om Klaffbron") och tolkas som i appen (VesselDataService.js#_classifyMooring):
// ett positivt tal, där Infinity betyder obegränsat. Värdet var 900 s fram
// till ägarbeslutet U23 (2026-11-09); sedan familj F:s apprättning är det
// Infinity, och ett obegränsat eller saknat undantag har inget gränsvärde att
// ligga nära, så posten tas då inte med i tabellen.
function kajensKöundantagS(zoner = constants.MOORING_ZONES) {
  const kaj = (zoner || []).find((z) => /^Kajen\b/.test(String((z && z.name) || '')));
  const ms = kaj && typeof kaj.queueGraceMs === 'number' && kaj.queueGraceMs > 0 ? kaj.queueGraceMs : 0;
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
}
const KAJENS_KÖUNDANTAG_S = kajensKöundantagS();

const KONSTANTER = Object.freeze([
  { namn: 'CONVOY_WINDOW_MS', värde: BO.CONVOY_WINDOW_MS / 1000, enhet: 's' },
  { namn: 'WARNING_LEAD_MS', värde: BO.WARNING_LEAD_MS / 1000, enhet: 's' },
  { namn: 'minsta varningsbarhet (WARNING_LEAD_MS + TICK_INTERVAL_MS)', värde: (BO.WARNING_LEAD_MS + BO.TICK_INTERVAL_MS) / 1000, enhet: 's' },
  { namn: 'TICK_INTERVAL_MS', värde: BO.TICK_INTERVAL_MS / 1000, enhet: 's' },
  { namn: 'STALE_ETA_SOFT_THRESHOLD_MS', värde: constants.UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS / 1000, enhet: 's' },
  { namn: 'STALE_ETA_HARD_THRESHOLD_MS', värde: constants.UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS / 1000, enhet: 's' },
  ...(KAJENS_KÖUNDANTAG_S === null ? [] : [{ namn: 'queueGraceMs (Kajen)', värde: KAJENS_KÖUNDANTAG_S, enhet: 's' }]),
  { namn: 'D5-avbrottet', värde: 120, enhet: 's' },
  { namn: 'besöksutfärd (radie + 50 m)', värde: constants.PROTECTION_ZONE_RADIUS + 50, enhet: 'm' },
  { namn: 'PROTECTION_ZONE_RADIUS', värde: constants.PROTECTION_ZONE_RADIUS, enhet: 'm' },
  { namn: 'APPROACHING_RADIUS', värde: constants.APPROACHING_RADIUS, enhet: 'm' },
  { namn: 'UNDER_BRIDGE_SET_DISTANCE', värde: constants.UNDER_BRIDGE_SET_DISTANCE, enhet: 'm' },
  { namn: 'UNDER_BRIDGE_CLEAR_DISTANCE', värde: constants.UNDER_BRIDGE_CLEAR_DISTANCE, enhet: 'm' },
  { namn: 'WAITING_SET_DISTANCE', värde: constants.STATUS_HYSTERESIS.WAITING_SET_DISTANCE, enhet: 'm' },
  { namn: 'WAITING_CLEAR_DISTANCE', värde: constants.STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE, enhet: 'm' },
  { namn: 'DISARM_MOORED_MIN_DISTANCE_M', värde: BO.DISARM_MOORED_MIN_DISTANCE_M, enhet: 'm' },
  { namn: 'deadline-avståndet (DEADLINE_MAX_SPEED_KN × WARNING_LEAD_MS)', värde: Math.round(BO.DEADLINE_MAX_SPEED_KN * 0.514444 * (BO.WARNING_LEAD_MS / 1000)), enhet: 'm' },
  { namn: 'ARM_MAX_DISTANCE_M', värde: BO.ARM_MAX_DISTANCE_M, enhet: 'm' },
  { namn: 'DEADLINE_MAX_SPEED_KN', värde: BO.DEADLINE_MAX_SPEED_KN, enhet: 'kn' },
  { namn: 'QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN', värde: constants.QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN, enhet: 'kn' },
  { namn: 'MOVEMENT_PROOF_SOG_KN', värde: constants.MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN, enhet: 'kn' },
  { namn: 'krypgränsen 2,0 kn', värde: 2.0, enhet: 'kn' },
]);

/** Familjens närliggande konstanter i prioritetsordning (§4.4). */
const FAMILJ_KONSTANTER = Object.freeze({
  'F-TRANSIT': ['DEADLINE_MAX_SPEED_KN'],
  'F-KONVOJ': ['CONVOY_WINDOW_MS', 'WARNING_LEAD_MS'],
  'F-MÖTE': ['CONVOY_WINDOW_MS'],
  'F-KÖ': ['WAITING_SET_DISTANCE', 'WAITING_CLEAR_DISTANCE', 'PROTECTION_ZONE_RADIUS', 'queueGraceMs (Kajen)', 'STALE_ETA_SOFT_THRESHOLD_MS', 'STALE_ETA_HARD_THRESHOLD_MS'],
  'F-KRYP': ['MOVEMENT_PROOF_SOG_KN', 'QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN', 'krypgränsen 2,0 kn', 'PROTECTION_ZONE_RADIUS', 'APPROACHING_RADIUS'],
  'F-USVÄNG': ['besöksutfärd (radie + 50 m)', 'PROTECTION_ZONE_RADIUS', 'UNDER_BRIDGE_SET_DISTANCE', 'UNDER_BRIDGE_CLEAR_DISTANCE'],
  'F-KAJ': ['DISARM_MOORED_MIN_DISTANCE_M'],
  'F-SENFÖDD': ['minsta varningsbarhet (WARNING_LEAD_MS + TICK_INTERVAL_MS)', 'deadline-avståndet (DEADLINE_MAX_SPEED_KN × WARNING_LEAD_MS)', 'ARM_MAX_DISTANCE_M'],
  'F-AVBROTT': ['D5-avbrottet', 'STALE_ETA_SOFT_THRESHOLD_MS', 'STALE_ETA_HARD_THRESHOLD_MS', 'queueGraceMs (Kajen)'],
  KONVOJPAR: ['CONVOY_WINDOW_MS', 'WARNING_LEAD_MS'],
});

/**
 * Närmaste konstant (samma enhet) inom 15 % av gränsvärdena. Familjens
 * närliggande konstanter prövas först; först om ingen av dem ligger inom
 * toleransen prövas hela tabellen.
 * @param {{värden: number[], enhet: string, familj?: string}} g - gränsens värden
 * @returns {object|null} {namn, värde, enhet, avvikelse, gränsvärde}
 */
function annotateConstant({ värden, enhet, familj = null }) {
  const vals = (värden || []).filter(Number.isFinite);
  if (!vals.length) return null;
  const best = (cands) => {
    let out = null;
    for (const k of cands) {
      for (const v of vals) {
        const rel = Math.abs(v - k.värde) / Math.max(1e-9, Math.abs(k.värde));
        if (rel <= KONSTANT_TOLERANS && (!out || rel < out.avvikelse)) {
          out = {
            namn: k.namn, värde: k.värde, enhet: k.enhet, avvikelse: Math.round(rel * 1000) / 1000, gränsvärde: v,
          };
        }
      }
    }
    return out;
  };
  const same = KONSTANTER.filter((k) => k.enhet === enhet);
  const pref = (FAMILJ_KONSTANTER[familj] || []).map((n) => same.find((k) => k.namn === n)).filter(Boolean);
  return best(pref) || best(same);
}

// ---------------------------------------------------------------------------
// Familjernas nyckelparametrar (steg E)
// ---------------------------------------------------------------------------

const boatOf = (spec, mmsi) => spec.boats.find((b) => String(b.mmsi) === String(mmsi)) || null;
const focalBoats = (spec) => ((spec.fokal && spec.fokal.mmsis) || []).map((m) => boatOf(spec, m)).filter(Boolean);
const planOp = (b, op) => (b && Array.isArray(b.plan) ? b.plan.find((p) => p.op === op) : null);
const round = (v, d = 0) => Math.round(v * (10 ** d)) / (10 ** d);

/** L0-korsningstid (ms) för en båt vid en bro ur en byggd värld. */
function crossingMs(built, mmsi, bridge) {
  const c = built.truth.L0.crossings.find((x) => x.mmsi === String(mmsi) && x.bridge === bridge);
  return c ? c.t : null;
}

/**
 * Sökbara parametrar för en spec och ett mål. Familjens nyckelparametrar
 * (families.KEY_PARAMS) när de fokala båtarna finns kvar; annars, när målet
 * har minst två inblandade båtar som korsar samma bro, avståndet i tid mellan
 * dem (KONVOJPAR) — så att även en bakgrundskonvoj får sin gräns.
 * @param {object} spec - (förenklad) spec
 * @param {{bro: string|null, mmsis: string[], mmsi: string|null}} mål - målet
 * @returns {object[]} parameterbeskrivningar
 */
function searchableParams(spec, mål) {
  const out = [];
  const fam = spec.familj || (spec.fokal && spec.fokal.familj) || null;
  const fb = focalBoats(spec);
  const bro = mål.bro || null;
  if (fam === 'F-TRANSIT' && fb[0]) {
    out.push({
      namn: 'cruiseKn',
      enhet: 'kn',
      min: 2.5,
      max: 12,
      decimaler: 2,
      get: (s) => boatOf(s, fb[0].mmsi).cruiseKn,
      set: (s, v) => {
        boatOf(s, fb[0].mmsi).cruiseKn = v;
      },
    });
  }
  if ((fam === 'F-KONVOJ' || fam === 'F-MÖTE') && fb.length >= 2) {
    const [a, b] = fb;
    out.push({
      namn: 'deltaS',
      enhet: 's',
      min: fam === 'F-MÖTE' ? -900 : 30,
      max: 1200,
      decimaler: 0,
      get: (s) => boatOf(s, b.mmsi).tStartS - boatOf(s, a.mmsi).tStartS,
      set: (s, v) => {
        boatOf(s, b.mmsi).tStartS = Math.max(0, boatOf(s, a.mmsi).tStartS + v);
      },
      mått: bro ? {
        namn: `B − A vid ${bro}`,
        enhet: 's',
        fn: (built) => {
          const ta = crossingMs(built, a.mmsi, bro);
          const tb = crossingMs(built, b.mmsi, bro);
          return ta !== null && tb !== null ? Math.round((tb - ta) / 1000) : null;
        },
      } : null,
    });
  }
  // Planparametrar: den fokala båten i F-KÖ/F-KRYP/F-USVÄNG, och därefter den
  // skyldiga båtens egen plan oavsett familj (en bakgrundsbåt med U-sväng
  // ska också få sin gräns).
  const planBoats = [];
  if (['F-KÖ', 'F-KRYP', 'F-USVÄNG'].includes(fam) && fb[0]) planBoats.push(fb[0]);
  const culpritBoat = mål.mmsi ? boatOf(spec, mål.mmsi) : null;
  if (culpritBoat && !planBoats.includes(culpritBoat)) planBoats.push(culpritBoat);
  for (const pb of planBoats) {
    const m = pb.mmsi;
    const tag = pb === fb[0] && planBoats.length === 1 ? '' : ` (${m})`;
    if (planOp(pb, 'queue')) {
      out.push({
        namn: 'distM',
        etikett: `köavstånd före bron${tag}`,
        enhet: 'm',
        min: 20,
        max: 600,
        decimaler: 0,
        get: (s) => planOp(boatOf(s, m), 'queue').distM,
        set: (s, v) => {
          planOp(boatOf(s, m), 'queue').distM = v;
        },
      });
      out.push({
        namn: 'durS',
        etikett: `kötid${tag}`,
        enhet: 's',
        min: 60,
        max: 3600,
        decimaler: 0,
        get: (s) => planOp(boatOf(s, m), 'queue').durS,
        set: (s, v) => {
          planOp(boatOf(s, m), 'queue').durS = v;
        },
      });
    }
    if (planOp(pb, 'crawl')) {
      out.push({
        namn: 'kn',
        etikett: `krypfart${tag}`,
        enhet: 'kn',
        min: 0.2,
        max: 3,
        decimaler: 2,
        get: (s) => planOp(boatOf(s, m), 'crawl').kn,
        set: (s, v) => {
          planOp(boatOf(s, m), 'crawl').kn = v;
        },
      });
      out.push({
        namn: 'withinM',
        etikett: `krypsträcka före bron${tag}`,
        enhet: 'm',
        min: 50,
        max: 900,
        decimaler: 0,
        get: (s) => planOp(boatOf(s, m), 'crawl').withinM,
        set: (s, v) => {
          planOp(boatOf(s, m), 'crawl').withinM = v;
        },
      });
    }
    if (planOp(pb, 'uturn')) {
      const u0 = planOp(pb, 'uturn').atS;
      const st = geo.STATIONS.map((x) => ({ x, d: Math.abs(x.s - u0) })).sort((p, q) => p.d - q.d)[0].x;
      const sign = Math.sign(u0 - st.s) || 1;
      out.push({
        namn: 'avståndM',
        enhet: 'm',
        etikett: `U-svängens avstånd från ${st.name}${tag}`,
        min: 30,
        max: 1200,
        decimaler: 0,
        familj: 'F-USVÄNG',
        get: (s) => Math.abs(planOp(boatOf(s, m), 'uturn').atS - st.s),
        set: (s, v) => {
          planOp(boatOf(s, m), 'uturn').atS = Math.round(st.s + (sign * v));
        },
      });
    }
  }
  if (fam === 'F-SENFÖDD' && fb[0] && Number.isFinite(fb[0].firstHeardS) && spec.fokal && spec.fokal.parametrar && spec.fokal.parametrar.bro) {
    const m = fb[0].mmsi;
    const st = geo.stationByName[spec.fokal.parametrar.bro];
    const sign = fb[0].dir === 'north' ? 1 : -1;
    out.push({
      namn: 'hördFöreM',
      enhet: 'm',
      min: 100,
      max: 3000,
      decimaler: 0,
      get: (s) => Math.abs(st.s - boatOf(s, m).firstHeardS),
      set: (s, v) => {
        boatOf(s, m).firstHeardS = Math.round(st.s - (sign * v));
      },
    });
  }
  if (fam === 'F-AVBROTT' && (spec.events || []).length >= 2) {
    out.push({
      namn: 'avbrottS',
      enhet: 's',
      min: 30,
      max: 1800,
      decimaler: 0,
      get: (s) => {
        const d = s.events.find((e) => e.ctrl === 'disconnect');
        const r = s.events.find((e) => e.ctrl === 'reconnect');
        return d && r ? r.atS - d.atS : null;
      },
      set: (s, v) => {
        const d = s.events.find((e) => e.ctrl === 'disconnect');
        const r = s.events.find((e) => e.ctrl === 'reconnect');
        if (d && r) r.atS = d.atS + v;
      },
    });
  }
  if (!out.length && bro && mål.mmsi) {
    // KONVOJPAR: målbåten och den båt som korsar samma bro närmast före den.
    const others = (mål.mmsis || []).filter((x) => x !== String(mål.mmsi) && boatOf(spec, x));
    const cand = others.length ? others : spec.boats.filter((b) => String(b.mmsi) !== String(mål.mmsi) && b.role === 'transit').map((b) => String(b.mmsi));
    const self = boatOf(spec, mål.mmsi);
    if (self && self.role === 'transit' && cand.length) {
      const partner = cand[0];
      out.push({
        namn: 'startförskjutningS',
        enhet: 's',
        etikett: `${mål.mmsi}:s start relativt ${partner}`,
        min: -1500,
        max: 1500,
        decimaler: 0,
        relativ: true,
        get: () => 0,
        set: (s, v) => {
          boatOf(s, mål.mmsi).tStartS = Math.max(0, self.tStartS + v);
        },
        mått: {
          namn: `${mål.mmsi} − ${partner} vid ${bro}`,
          enhet: 's',
          fn: (built) => {
            const ta = crossingMs(built, partner, bro);
            const tb = crossingMs(built, mål.mmsi, bro);
            return ta !== null && tb !== null ? Math.round((tb - ta) / 1000) : null;
          },
        },
        familj: 'KONVOJPAR',
      });
    }
  }
  return out.slice(0, MAX_PARAMETRAR);
}

/**
 * Gränssökning på en parameter med högst 7 prov: vidgande steg åt båda håll
 * från utgångsvärdet tills utslaget försvinner, sedan halvering mot den sida
 * (eller de sidor) där det försvann.
 * @param {object} spec - minsta spec (utslaget håller)
 * @param {object} param - searchableParams-post
 * @param {Function} probe - async (spec) → {holds, mått}
 * @param {object} budget - provbudget
 * @returns {Promise<object|null>} gräns
 */
async function searchParam(spec, param, probe, budget) {
  const v0 = param.get(spec);
  if (!Number.isFinite(v0)) return null;
  const prov = [];
  const at = async (v) => {
    const s = clone(spec);
    param.set(s, round(v, param.decimaler));
    const r = await probe(s);
    const p = { värde: round(v, param.decimaler), fel: !!r.holds, mått: r.mått === undefined ? null : r.mått };
    prov.push(p);
    return p;
  };
  if (budget.slut()) return null;
  const p0 = await at(v0);
  if (!p0.fel) {
    return {
      parameter: param.namn, etikett: param.etikett || param.namn, enhet: param.enhet, prov, instabil: true,
    };
  }
  let used = 1;
  const full = () => used >= MAX_PROV_PER_PARAMETER || budget.slut();
  // Vidgande sökning från utgångsvärdet: steget börjar på 1/16 av
  // intervallet och fördubblas tills utslaget försvinner eller kanten nås.
  // Felområdet är ofta smalt (konvojbakkanten är ~60 s bred), så en start
  // vid ändarna skulle slösa proven långt bort.
  const sides = [];
  const step0 = (param.max - param.min) / 16;
  for (const dir of [-1, 1]) {
    let lastFail = v0;
    let d = step0;
    for (;;) {
      if (full()) break;
      const v = dir < 0 ? Math.max(param.min, v0 - d) : Math.min(param.max, v0 + d);
      if (v === lastFail) break;
      // eslint-disable-next-line no-await-in-loop
      const p = await at(v);
      used++;
      if (!p.fel) {
        sides.push({ fel: lastFail, ok: v });
        break;
      }
      lastFail = v;
      if (v === param.min || v === param.max) break;
      d *= 2;
    }
  }
  // Halvering: alternera mellan sidorna där utslaget försvinner.
  const minStep = param.enhet === 'kn' ? 0.05 : 5;
  let k = 0;
  while (sides.length && !full()) {
    const i = k % sides.length;
    const side = sides[i];
    if (Math.abs(side.ok - side.fel) <= minStep) {
      sides.splice(i, 1);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const p = await at((side.fel + side.ok) / 2);
    used++;
    if (p.fel) side.fel = (side.fel + side.ok) / 2;
    else side.ok = (side.fel + side.ok) / 2;
    k++;
  }
  const sorted = [...prov].sort((a, b) => a.värde - b.värde);
  const felVärden = sorted.filter((p) => p.fel);
  const okVärden = sorted.filter((p) => !p.fel);
  const lo = felVärden.length ? felVärden[0] : null;
  const hi = felVärden.length ? felVärden[felVärden.length - 1] : null;
  const nedreOk = lo ? okVärden.filter((p) => p.värde < lo.värde).pop() || null : null;
  const övreOk = hi ? okVärden.find((p) => p.värde > hi.värde) || null : null;
  const useMått = !!param.mått && sorted.every((p) => Number.isFinite(p.mått));
  const val = (p) => {
    if (!p) return null;
    return useMått ? p.mått : p.värde;
  };
  const kantVärden = [];
  if (nedreOk) kantVärden.push((val(lo) + val(nedreOk)) / 2, val(lo));
  if (övreOk) kantVärden.push((val(hi) + val(övreOk)) / 2, val(hi));
  const konstant = annotateConstant({
    värden: kantVärden, enhet: useMått ? param.mått.enhet : param.enhet, familj: param.familj || spec.familj || null,
  });
  return {
    parameter: param.namn,
    etikett: param.etikett || param.namn,
    enhet: param.enhet,
    mått: useMått ? { namn: param.mått.namn, enhet: param.mått.enhet } : null,
    prov: sorted,
    fel: lo ? { från: val(lo), till: val(hi) } : null,
    okNedanför: val(nedreOk),
    okOvanför: val(övreOk),
    gränsHittad: !!(nedreOk || övreOk),
    konstant,
  };
}

/** Svensk text för en gräns: "fel när B − A ∈ 618–678 s; ok vid 588 och 708 s. Närmaste konstant: …". */
function boundaryText(g) {
  if (!g) return null;
  if (g.instabil) return `${g.etikett}: utslaget höll inte vid omprov av utgångsvärdet — ingen gräns.`;
  const enhet = g.mått ? g.mått.enhet : g.enhet;
  const namn = g.mått ? g.mått.namn : g.etikett;
  const fmt = (v) => String(Math.round(v * 100) / 100).replace('.', ',').replace('-', '−');
  if (!g.fel) return `${namn}: ingen gräns hittad.`;
  const parts = [g.fel.från === g.fel.till
    ? `fel vid ${namn} = ${fmt(g.fel.från)} ${enhet}`
    : `fel när ${namn} ∈ ${fmt(Math.min(g.fel.från, g.fel.till))}–${fmt(Math.max(g.fel.från, g.fel.till))} ${enhet}`];
  const oks = [g.okNedanför, g.okOvanför].filter((v) => v !== null && v !== undefined);
  if (oks.length) parts.push(`borta vid ${oks.map(fmt).join(' och ')} ${enhet}`);
  else parts.push(`kvar i hela sökintervallet (${g.prov.length} prov)`);
  let text = parts.join('; ');
  if (g.konstant) text += `. Närmaste konstant: ${g.konstant.namn} = ${fmt(g.konstant.värde)} ${g.konstant.enhet}`;
  return `${text}.`;
}

// ---------------------------------------------------------------------------
// Själva krympningen
// ---------------------------------------------------------------------------

/** Båtens aktivitetsfönster [start, slut] i epok-ms (ur dess bana). */
function activityWindow(spec, b) {
  const { traj } = simulateBoat(b);
  if (!traj.length) return null;
  return [spec.startMs + (traj[0].t * 1000), spec.startMs + (traj[traj.length - 1].t * 1000)];
}

/**
 * Krymper en spec.
 * @param {object} spec0 - världens spec (klonas)
 * @param {object} mål - {mmsi, mmsis, bro, t} (t i epok-ms)
 * @param {object} deps - {holds: async (spec) → boolean, measure?: async (spec, param) → {holds, mått},
 *                         budget, radio: 'R0'|'R1', log?}
 * @returns {Promise<object>} {spec, steg, delvis, delvisSkäl, gränser}
 */
async function shrinkSpec(spec0, mål, deps) {
  const { holds, budget, radio = 'R1' } = deps;
  const log = deps.log || (() => {});
  let spec = clone(spec0);
  const steg = [];
  const culprit = mål.mmsi ? String(mål.mmsi) : null;
  const tryAccept = async (cand, label) => {
    if (budget.slut()) return false;
    if (await holds(cand)) {
      spec = cand;
      steg.push(label);
      log(`  ✔ ${label}`);
      return true;
    }
    log(`  ✘ ${label}`);
    return false;
  };

  // (A) ctrl-händelser: alla på en gång, annars parvis.
  if ((spec.events || []).length) {
    const c = clone(spec);
    c.events = [];
    if (!(await tryAccept(c, `ta bort alla ctrl-händelser (${spec.events.length})`))) {
      const evs = [...spec.events].sort((a, b) => a.atS - b.atS);
      for (const d of evs.filter((e) => e.ctrl === 'disconnect')) {
        const r = evs.find((e) => e.ctrl === 'reconnect' && e.atS > d.atS);
        const cand = clone(spec);
        cand.events = cand.events.filter((e) => !(e.atS === d.atS && e.ctrl === d.ctrl) && !(r && e.atS === r.atS && e.ctrl === r.ctrl));
        // eslint-disable-next-line no-await-in-loop
        await tryAccept(cand, `ta bort avbrottet ${d.atS}–${r ? r.atS : '∞'} s`);
      }
    }
  }

  // (B0) tidsfokus.
  if (Number.isFinite(mål.t) && spec.boats.length > 1) {
    const keep = spec.boats.filter((b) => {
      if (String(b.mmsi) === culprit) return true;
      const w = activityWindow(spec, b);
      return w && w[1] >= mål.t - FOKUS_FÖRE_MS && w[0] <= mål.t + FOKUS_EFTER_MS;
    }).map((b) => String(b.mmsi));
    if (keep.length < spec.boats.length) {
      const c = clone(spec);
      c.boats = c.boats.filter((b) => keep.includes(String(b.mmsi)));
      await tryAccept(c, `tidsfokus: behåll ${keep.length} av ${spec.boats.length} båtar med aktivitet i [t − 45 min; t + 15 min]`);
    }
  }

  // (B1) bara den skyldiga båten; (B2) annars ddmin över båtarna med den
  // skyldiga skyddad. Ett utslag utan mmsi (t.ex. en ETA-invariant på
  // brotexten) får ddmin utan skyddad båt.
  const hasCulprit = culprit && spec.boats.some((b) => String(b.mmsi) === culprit);
  let needDdmin = spec.boats.length > 1;
  if (hasCulprit && spec.boats.length > 1) {
    const c = clone(spec);
    c.boats = c.boats.filter((b) => String(b.mmsi) === culprit);
    if (await tryAccept(c, `bara den skyldiga båten ${culprit}`)) needDdmin = false;
    else needDdmin = spec.boats.length > 2;
  }
  if (needDdmin && !budget.slut()) {
    const before = spec.boats.length;
    const res = await ddmin(spec.boats.map((b) => String(b.mmsi)), async (subset) => {
      const cand = clone(spec);
      cand.boats = cand.boats.filter((b) => subset.includes(String(b.mmsi)));
      return holds(cand);
    }, { skyddade: hasCulprit ? [culprit] : [], budget });
    if (res.mängd.length < before) {
      spec.boats = spec.boats.filter((b) => res.mängd.includes(String(b.mmsi)));
      steg.push(`ddmin: ${before} → ${spec.boats.length} båtar`);
      log(`  ✔ ddmin ${before} → ${spec.boats.length}`);
    }
  }

  // (C) förenkla varje kvarvarande båt.
  for (const b0 of clone(spec.boats)) {
    const edit = async (fn, label) => {
      const c = clone(spec);
      const bb = c.boats.find((x) => String(x.mmsi) === String(b0.mmsi));
      if (!bb) return false;
      if (fn(bb, c) === false) return false;
      return tryAccept(c, `${b0.mmsi}: ${label}`);
    };
    for (let i = (b0.plan || []).length - 1; i >= 0; i--) {
      // eslint-disable-next-line no-await-in-loop
      await edit((bb) => {
        bb.plan.splice(i, 1);
      }, `ta bort planelementet ${b0.plan[i].op}`);
    }
    if (radio !== 'R0' && b0.fixedIntervalS !== 60) {
      await edit((bb) => {
        bb.fixedIntervalS = 60;
      }, 'fast radiokadens 60 s');
    }
    if (radio !== 'R0' && b0.noise !== false) {
      await edit((bb) => {
        bb.noise = false;
      }, 'inget brus');
    }
    if (b0.lateralSigma !== 0 || (b0.laneM || 0) !== 0) {
      await edit((bb) => {
        bb.lateralSigma = 0;
        bb.laneM = 0;
      }, 'inget sidledsbrus');
    }
    if (radio !== 'R0' && b0.cls === 'B') {
      await edit((bb) => {
        bb.cls = 'A';
      }, 'klass B → A');
    }
    if (radio !== 'R0' && b0.nameLagMin !== 0) {
      await edit((bb) => {
        bb.nameLagMin = 0;
      }, 'inget namnglapp');
    }
  }
  if (radio !== 'R0' && spec.era !== 'aisstream') {
    const c = clone(spec);
    c.era = 'aisstream';
    await tryAccept(c, 'källa AISHub → aisstream');
  }

  // (D) korta världen: kajliggarna slutar 15 min efter utslaget.
  if (Number.isFinite(mål.t)) {
    const endS = Math.max(60, Math.round((mål.t - spec.startMs) / 1000) + KAJ_EFTER_S);
    const moored = spec.boats.filter((b) => b.role === 'moored' && b.tStartS + b.durS > endS);
    if (moored.length) {
      const c = clone(spec);
      for (const b of c.boats) if (b.role === 'moored' && b.tStartS + b.durS > endS) b.durS = Math.max(60, endS - b.tStartS);
      await tryAccept(c, `korta världen: kajliggarna slutar ${Math.round(endS / 60)} min efter start`);
    }
  }

  // (E) gränssökning.
  const gränser = [];
  if (deps.measure) {
    for (const param of searchableParams(spec, mål)) {
      if (budget.slut()) break;
      // eslint-disable-next-line no-await-in-loop
      const g = await searchParam(spec, param, (s) => deps.measure(s, param), budget);
      if (g) gränser.push(g);
    }
  }
  const delvisSkäl = budget.skäl();
  return {
    spec, steg, delvis: !!delvisSkäl, delvisSkäl, gränser,
  };
}

module.exports = {
  MAX_PROV,
  MAX_KOSTNAD_MS,
  MAX_PROV_PER_PARAMETER,
  MAX_PARAMETRAR,
  KONSTANT_TOLERANS,
  KONSTANTER,
  FAMILJ_KONSTANTER,
  kajensKöundantagS,
  makeBudget,
  ddmin,
  annotateConstant,
  searchableParams,
  searchParam,
  boundaryText,
  activityWindow,
  shrinkSpec,
};
