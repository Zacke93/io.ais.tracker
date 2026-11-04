'use strict';

/**
 * T10 — PASSAGEDETEKTION (orakelkatalogen, BUGGJAKT.md bilaga B).
 *
 * (a) MISS: en L1-punktkorsning av en målbro har en fix före (högst 600 m
 *     från bron) och en BESLUTSAM fix efter (mer än 70 m bortom linjen,
 *     högst 600 m från bron, högst 10 min efter), men appen har ingen
 *     passage (targetPassages eller intermediatePassages) för båten och
 *     bron i KOPPLINGSFÖNSTRET [t − 180 s; beslutsam fix + 300 s].
 * (b) FANTOMPASSAGE: appen har en passage som ingen korsning av samma båt
 *     och bro förklarar. Kopplingen är densamma som i (a): korsningen x
 *     förklarar registreringen p när x.t − 180 s ≤ p.t ≤ E(x) + 300 s, där
 *     E(x) är (a):s beslutsamma fix efter x. En registrering som (a) räknar
 *     som träff är därmed aldrig fantom i (b) (M01: förut kunde en sen men
 *     äkta registrering av en krypande båt vara båda). Saknar x beslutsam
 *     fix (glapp, båten långt bort eller kvar under bron) är E(x) första
 *     fixen efter x mer än 70 m bortom linjen, annars första fixen efter x.
 *     En korsning förklarar högst en registrering per slag (target,
 *     intermediate); en andra registrering av samma slag i fönstret är en
 *     dubblett och fälls (efterrättning D: en båt som låg kvar inom 70 m
 *     bortom linjen fick annars varje registrering förklarad tills den
 *     lämnade bandet).
 *     I syntetiska världar prövas mot L0 (exakt tid), på banken mot
 *     rådatafacitets alla linjekorsningar (även inferred); där vet facit bara
 *     att korsningen ligger i [tFrom; tTo], så fönstret börjar vid tFrom.
 * Allvar 5.
 *
 * Vakter: UNDER-BRO-BANDET-70M (beslutsamheten kräver > 70 m); omstart inom
 * 10 min före korsningen hör till T11 (sträckmål S1); på banken
 * MÄTGRÄNS-FACIT-SIDLED när fixarna ligger mer än 250 m från farleden
 * (rådatafacitets sidledsgrind, makeGtPassages.FAIRWAY_MAX_OFFSET_M).
 * Omstartsvakten och sidledsvakten för (b) läser registreringens
 * observerbarhetsfönster [tredje fixen före registreringen − 120 s; t + 120 s]
 * (efter ett glapp över 900 s från glappets början).
 */

const geo = require('../geo');
const gt = require('../../../makeGtPassages');
const C = require('../../../../../lib/constants');
const {
  fynd, restartTimes, beyondLineM, toAppDir, hms, iso,
} = require('./truthCommon');

const NEAR_M = 600;
const DECISIVE_M = C.UNDER_BRIDGE_CLEAR_DISTANCE; // 70 m
const AFTER_MAX_MS = 10 * 60000;
const PRE_MS = 180000;
const POST_MS = 300000;
const OBS_SLACK_MS = 120000;
const GAP_MS = gt.INFERRED_GAP_S * 1000; // 900 s
const RESTART_MS = 10 * 60000;
const SIDE_GATE_M = gt.FAIRWAY_MAX_OFFSET_M; // 250 m

/**
 * (a):s beslutsamma fix efter korsningen x: första fixen efter x.t, högst
 * 10 min efter, högst 600 m från bron och mer än 70 m bortom linjen.
 * @param {object[]} list - båtens fixar i leveransordning
 * @param {object} x - korsning {t, bridge, dir}
 * @returns {object|undefined} fixen
 */
function decisiveFixAfter(list, x) {
  return list.find((f) => f.aisTimestamp > x.t && f.aisTimestamp <= x.t + AFTER_MAX_MS
    && geo.distToBridge(f.lat, f.lon, x.bridge) <= NEAR_M && beyondLineM(f, x.bridge, x.dir) > DECISIVE_M);
}

/**
 * Kopplingsfönstret för korsningen x i (b): [x.t − PRE_MS; E(x) + POST_MS],
 * samma som träffönstret i (a) när x har en beslutsam fix E(x). Saknas den
 * (glapp, fixen långt bort eller båten kvar inom 70 m) används första fixen
 * efter x mer än 70 m bortom linjen, annars första fixen efter x, annars x
 * själv. För bankens facit (source 'gt') börjar fönstret vid tFrom (fixen
 * före), eftersom facit bara vet att korsningen ligger i [tFrom; tTo]. Fönstret
 * innehåller alltid (a):s träffönster för samma korsning.
 * @param {object[]} list - båtens fixar i leveransordning
 * @param {object} x - korsning (L0 eller facit)
 * @returns {{från:number, till:number, evidens:object|null, grund:string}} fönster
 */
function matchWindow(list, x) {
  let evidens = decisiveFixAfter(list, x);
  let grund = 'beslutsam fix';
  if (!evidens) {
    evidens = list.find((f) => f.aisTimestamp > x.t && beyondLineM(f, x.bridge, x.dir) > DECISIVE_M);
    grund = `första fix > ${DECISIVE_M} m bortom linjen`;
  }
  if (!evidens) {
    evidens = list.find((f) => f.aisTimestamp > x.t);
    grund = 'första fix efter korsningen';
  }
  if (!evidens) grund = 'ingen fix efter korsningen';
  const t0 = x.source === 'gt' && Number.isFinite(x.tFrom) ? Math.min(x.t, x.tFrom) : x.t;
  const tE = evidens ? evidens.aisTimestamp : x.t;
  return {
    från: t0 - PRE_MS, till: tE + POST_MS, evidens: evidens || null, grund,
  };
}

/**
 * Registreringens observerbarhetsfönster för omstarts- och sidledsvakten:
 * [tredje fixen före registreringen − 120 s; t + 120 s], efter ett glapp
 * över 900 s från glappets början.
 */
function observationWindow(list, p) {
  const k = list.findIndex((f) => f.aisTimestamp > p.t + 1000);
  const idx = (k < 0 ? list.length : k) - 1;
  let from = list[Math.max(0, idx - 3)] ? list[Math.max(0, idx - 3)].aisTimestamp - OBS_SLACK_MS : p.t - 3600000;
  for (let j = idx; j > 0 && list[j].aisTimestamp >= p.t - (30 * 60000); j--) {
    if (list[j].aisTimestamp - list[j - 1].aisTimestamp > GAP_MS) {
      from = Math.min(from, list[j - 1].aisTimestamp - OBS_SLACK_MS);
      break;
    }
  }
  return { from, to: p.t + OBS_SLACK_MS };
}

/**
 * Döm T10.
 * @param {object} ctx - orakelkontext
 * @returns {{fynd:object[], räknare:object}} utslag och räknare
 */
function judgeT10(ctx) {
  const { result, truth } = ctx;
  const { L1 } = truth;
  const L0 = truth.L0 || null;
  const { fixes } = L1;
  const restarts = restartTimes(ctx.rows);
  const out = [];
  const räknare = {
    appPassager: 0, beslutsammaKorsningar: 0, omstartsnära: 0, förklarade: {},
  };
  const appPass = [
    ...(result.targetPassages || []).map((p) => ({ ...p, slag: 'target' })),
    ...(result.intermediatePassages || []).map((p) => ({ ...p, slag: 'intermediate' })),
  ].sort((a, b) => a.t - b.t);

  // ---- (a) MISS ----
  const point = L1.crossings.filter((c) => !c.inferred && geo.TARGETS.includes(c.bridge));
  for (const c of point) {
    const list = fixes.get(String(c.mmsi)) || [];
    const prevSame = L1.crossings.filter((x) => x.mmsi === c.mmsi && x.bridge === c.bridge && x.t < c.t).pop();
    const beforeFix = [...list].reverse().find((f) => f.aisTimestamp < c.t
      && (!prevSame || f.aisTimestamp > prevSame.t)
      && geo.distToBridge(f.lat, f.lon, c.bridge) <= NEAR_M);
    const after = decisiveFixAfter(list, c);
    if (!beforeFix || !after) continue;
    if (restarts.some((r) => r >= c.t - RESTART_MS && r <= after.aisTimestamp)) {
      räknare['omstartsnära']++;
      continue;
    }
    räknare['beslutsammaKorsningar']++;
    const hit = appPass.find((p) => String(p.mmsi) === String(c.mmsi) && p.bridge === c.bridge
      && p.t >= c.t - PRE_MS && p.t <= after.aisTimestamp + POST_MS);
    if (hit) continue;
    out.push(fynd({
      orakel: 'T10',
      klass: 'PASSAGE-EJ-REGISTRERAD',
      allvar: 5,
      mmsi: c.mmsi,
      bro: c.bridge,
      riktning: toAppDir(c.dir),
      t: c.t,
      detalj: `sann korsning ${hms(c.t)} ${c.dir}, fix före ${hms(beforeFix.aisTimestamp)} (${Math.round(geo.distToBridge(beforeFix.lat, beforeFix.lon, c.bridge))} m) `
        + `och beslutsam fix efter ${hms(after.aisTimestamp)} (${Math.round(beyondLineM(after, c.bridge, c.dir))} m bortom) men ingen passage registrerad`,
      belägg: {
        korsning: { t: iso(c.t), dir: c.dir, källa: c.source || 'L1' },
        fixFöre: { t: iso(beforeFix.aisTimestamp), rad: beforeFix.line },
        fixEfter: { t: iso(after.aisTimestamp), bortomM: Math.round(beyondLineM(after, c.bridge, c.dir)), rad: after.line },
        förklaring: null,
      },
    }));
  }

  // ---- (b) FANTOMPASSAGE ----
  // Samma koppling som (a): en registrering är förklarad när en korsning av
  // samma båt och bro (L0 i syntetiken, facit på banken) har den i sitt
  // kopplingsfönster [x.t − 180 s; E(x) + 300 s] (matchWindow).
  //
  // En korsning förklarar högst EN registrering per slag (target,
  // intermediate): appen bokför varje passage en gång (dubblettvakterna
  // PASSAGE_DUPLICATE och INTERMEDIATE_PASSAGE_DUPLICATE i
  // VesselDataService.js). En andra registrering av samma slag för en redan
  // registrerad korsning är därför en dubblett och fälls. Registreringarna
  // kopplas i tidsordning till den lediga korsning vars fönster slutar först
  // (girigt; ger flest kopplade registreringar). Slagen kopplas var för sig,
  // eftersom en målbro som först bokförs som mellanbro och rättas inom samma
  // tick är INV-13:s sak (invariants.js:568–593), inte T10:s. Rättat
  // 2026-11-04 (efterrättning D): när E(x) saknar beslutsam fix kan fönstret
  // sträcka sig tills båten lämnar 70 m-bandet, och utan en-till-en-kopplingen
  // förklarade det varje registrering medan båten låg kvar inom bandet.
  const candidates = L0 ? L0.crossings : L1.crossings;
  const upptagna = { target: new Map(), intermediate: new Map() }; // slag → korsning → registreringen som tog den
  for (const p of appPass) {
    räknare.appPassager++;
    const list = fixes.get(String(p.mmsi)) || [];
    const { from, to } = observationWindow(list, p);
    if (restarts.some((r) => r >= from - RESTART_MS && r <= to)) {
      räknare['omstartsnära']++;
      continue;
    }
    const kopplade = candidates
      .filter((x) => String(x.mmsi) === String(p.mmsi) && x.bridge === p.bridge)
      .map((x) => ({ x, w: matchWindow(list, x) }));
    const tagna = upptagna[p.slag] || new Map();
    const iFönster = kopplade.filter(({ w }) => p.t >= w.från && p.t <= w.till);
    const ledig = iFönster.filter(({ x }) => !tagna.has(x))
      .sort((a, b) => (a.w.till - b.w.till) || (a.x.t - b.x.t))[0];
    if (ledig) {
      tagna.set(ledig.x, p);
      continue;
    }
    // Närmaste korsning för beläggen: en korsning vars fönster rymmer
    // registreringen (dubbletten), annars minsta avstånd till fönstret.
    const gapTo = ({ w }) => (p.t < w.från ? w.från - p.t : p.t - w.till);
    const närmast = iFönster.length
      ? [...iFönster].sort((a, b) => (Math.abs(a.x.t - p.t) - Math.abs(b.x.t - p.t)) || (a.x.t - b.x.t))[0]
      : kopplade.reduce((best, k) => (!best || gapTo(k) < gapTo(best) ? k : best), null);
    let förklaring = null;
    if (!L0) {
      const near = list.filter((f) => f.aisTimestamp >= from && f.aisTimestamp <= to);
      const wide = near.filter((f) => f.offsetM > SIDE_GATE_M);
      if (wide.length) {
        const maxOff = Math.round(Math.max(...wide.map((f) => f.offsetM)));
        förklaring = {
          post: 'MÄTGRÄNS-FACIT-SIDLED',
          klass: 'MÄTGRÄNS',
          varför: `${wide.length} fixar i fönstret ligger mer än ${SIDE_GATE_M} m från farleden (max ${maxOff} m)`,
        };
        räknare['förklarade'][förklaring.post] = (räknare['förklarade'][förklaring.post] || 0) + 1;
      }
    }
    const källa = L0 ? 'L0' : 'facit';
    let varför = `båten korsar aldrig bron enligt ${källa}`;
    let närmasteKorsning = null;
    if (närmast) {
      const { x, w } = närmast;
      const dubblett = iFönster.length > 0;
      const fönsterText = `kopplingsfönstret ${hms(w.från)}–${hms(w.till)} (${w.grund}${w.evidens ? ` ${hms(w.evidens.aisTimestamp)}` : ''})`;
      // Andra registreringar i korsningens fönster: den här är en dubblett
      // (inom fönstret: av samma slag, som tog korsningen; utanför: av något slag).
      const redan = dubblett
        ? [tagna.get(x)].filter(Boolean)
        : appPass.filter((q) => q !== p && String(q.mmsi) === String(p.mmsi) && q.bridge === p.bridge && q.t >= w.från && q.t <= w.till);
      const redanText = redan.map((q) => `${hms(q.t)} (${q.slag})`).join(', ');
      if (dubblett) {
        varför = `ingen korsning av bron förklarar den; dubblett: korsningen ${hms(x.t)} ${x.dir || ''} har ${fönsterText} och är redan registrerad ${redanText}`
          + ' (en korsning förklarar högst en registrering per slag)';
      } else {
        const sida = p.t < w.från ? `${Math.round((w.från - p.t) / 1000)} s före` : `${Math.round((p.t - w.till) / 1000)} s efter`;
        varför = `ingen korsning av bron förklarar den; närmaste korsning ${hms(x.t)} ${x.dir || ''} har ${fönsterText}, registreringen ligger ${sida}`
          + `${redan.length ? `; korsningen är redan registrerad ${redanText}` : ''}`;
      }
      närmasteKorsning = {
        t: iso(x.t),
        dir: x.dir || null,
        källa,
        fönster: { från: iso(w.från), till: iso(w.till) },
        grund: w.grund,
        evidens: w.evidens ? { t: iso(w.evidens.aisTimestamp), rad: w.evidens.line } : null,
        dubblett,
        redanRegistrerad: redan.map((q) => ({ t: iso(q.t), slag: q.slag })),
      };
    }
    out.push(fynd({
      orakel: 'T10',
      klass: `FANTOMPASSAGE(${p.slag})`,
      allvar: 5,
      mmsi: p.mmsi,
      bro: p.bridge,
      riktning: null,
      t: p.t,
      detalj: `appen registrerade ${p.slag}-passage av ${p.bridge} ${hms(p.t)} men ${varför}`,
      belägg: {
        passage: { t: iso(p.t), slag: p.slag, noTarget: p.noTarget ?? null },
        observerbarhetsfönster: { från: iso(from), till: iso(to) },
        närmasteKorsning,
        förklaring,
      },
    }));
  }
  return { fynd: out, räknare };
}

module.exports = {
  judgeT10, decisiveFixAfter, matchWindow, observationWindow,
};
