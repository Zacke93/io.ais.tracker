'use strict';

/**
 * T1 — NOTIS PER OBSERVERAT BESÖK (orakelkatalogen, BUGGJAKT.md bilaga B).
 *
 * Gäller varje båt och notispunkt (fem broar och Kanalinfarten) och varje
 * besök inom 300 m där båten rör sig: L0-besök (max |v| ≥ 0,5 m/s) i
 * syntetiska världar, observerade besök ur raderna på banken.
 *
 * Förutsättningar ur L1 (alla krävs):
 *   (1) radion levererade minst en fix ≤ 300 m från punkten, och punkten är
 *       fixens närmaste notispunkt (Stridsbergsbron och Järnvägsbron ligger
 *       257 m isär);
 *   (2) båten har minst 2 observerade fixar före den fixen;
 *   (3) rörelsebevis: någon observerad fix med sog ≥ 1,0 kn
 *       (QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN) inom [tIn − 10 min; tOut].
 * Ingen dom under ctrl:disconnect, och inte när fixen före besöket är äldre
 * än 10 min (UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS).
 *
 * Krav: en levererad notis för (mmsi, punkt) i [tIn − 10 min; tOut + 15 min].
 * Formkrav: en notis i förvarningsform (alreadyPassed ≠ true) mer än 15 s
 * efter sann korsning är ett brott bara om appen före notisen hade en fix
 * mer än 70 m bortom linjen (UNDER_BRIDGE_CLEAR_DISTANCE). "Hade" är det
 * appen faktiskt fått (truthCommon.noticeHadFix, E6/kortet F21): fixar
 * strikt före notisen, och en tidslik fix bara när notisens frysta position
 * är just den fixen. Räknaren tidslikUtesluten visar de tidslika fixar
 * bortom linjen som därför inte räknades (ejInmatad: vesselLatNext är fixen,
 * raden väntade på inmatning; oklar: allt annat, väntat 0).
 *
 * Utslag: NOTIS-UTEBLIVEN och FÖRVARNINGSFORM-EFTER-PASSAGE (allvar 5).
 * SEN-NOTIS (notis − t_obs > 120 s, ej Kanalinfarten) är bara en räknare.
 *
 * Falsklarmsvakter som förklaring (registret avgör):
 *   BESÖKSREGEL-2026-09-07 (DESIGN): tidigare notis för nyckeln och inga två
 *     konsekutiva observerade fixar över 350 m däremellan
 *     (TriggerPointVisitTracker.js:15, ARCHITECTURE §6);
 *   BN1-BOXKANT (KÄND_ÖPPEN): samma sak vid Kanalinfarten eller
 *     Stallbackabron när båten enligt L0 faktiskt lämnade området
 *     (helgranskning 2026-11-03, beslutspunkt 2);
 *   D3-2H-DEDUP (DESIGN): samma mmsi:bro och riktning inom 2 h (reliability-spec D3);
 *   SKIPPA-BRO-ÅLDER-17MIN (DESIGN): bron korsades i ett glapp och
 *     slutsatsen är äldre än 17 min (runSyntheticScenarios.js:424);
 *   KANALINFARTEN-FP8-SYDGRIND (DESIGN, ny post): sydgående vid
 *     Kanalinfarten utan kanalhistorik får ingen notis (ARCHITECTURE.md,
 *     "Trigger-punktens två grenar"; etapp7-plan: "FP8:s sydgrind (ANNA/S/Y
 *     DESIREE)"). Bankträff 20260806-42h, 265731470.
 * Ett besök som var öppet i korpusens starttillstånd (L1.openVisitsAtStart)
 * räknas som besöket före förra notisen (besöksregeln).
 */

const geo = require('../geo');
const C = require('../../../../../lib/constants');
const {
  fynd, deliveredNotices, noticeHadFix, tiedAtNotice, silenceWindowsMs, beyondLineM, toAppDir, hms, iso,
} = require('./truthCommon');

const RADIUS_M = 300;
const EXIT_M = RADIUS_M + 50; // utfärdsbevisets avstånd (TriggerPointVisitTracker: radie + 50)
const PRE_MS = 10 * 60000;
const POST_MS = 15 * 60000;
const FORM_SLACK_MS = 15000;
const BEYOND_M = C.UNDER_BRIDGE_CLEAR_DISTANCE; // 70 m
const MOVE_KN = C.QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN; // 1,0 kn
const STALE_MS = C.UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS; // 10 min
const DEDUP_MS = 2 * 3600000;
const SKIP_AGE_MS = 17 * 60000;
const LATE_MS = 120000;
const EDGE_POINTS = new Set(['Kanalinfarten', 'Stallbackabron']);
// FP8-sydgrinden (ARCHITECTURE.md, "Trigger-punktens två grenar"): sydgående
// vid Kanalinfarten kräver kanalrelevans — passerad bro eller episodstart
// norr om punkten med TRIGGER_POINT_SIDE_MARGIN_DEG (app.js, 0,0009°).
const FP8_MARGIN_DEG = 0.0009;
const southCog = (cog) => Number.isFinite(cog) && cog >= 135 && cog <= 225; // strikt sydband (D4)

/** Observerade besök ur fixarna (banken): sammanhängande fixar ≤ 300 m med punkten närmast. */
function observedVisits(fixes) {
  const out = [];
  for (const [mmsi, list] of fixes) {
    for (const p of geo.NOTICE_POINTS) {
      let cur = null;
      for (const f of list) {
        const inside = f.nearest === p.name && geo.distToPoint(f.lat, f.lon, p.name) <= RADIUS_M;
        if (inside) {
          if (!cur) {
            cur = {
              mmsi, bridge: p.name, tIn: f.fixTs, tOut: f.fixTs,
            };
          }
          cur.tOut = f.fixTs;
        } else if (cur) {
          out.push(cur);
          cur = null;
        }
      }
      if (cur) out.push(cur);
    }
  }
  return out.map((v) => ({ ...v, moving: true, observed: true })).sort((a, b) => a.tIn - b.tIn);
}

/**
 * Döm T1.
 * @param {object} ctx - orakelkontext (se truthCommon)
 * @returns {{fynd:object[], räknare:object}} utslag och räknare
 */
function judgeT1(ctx) {
  const { result, truth } = ctx;
  const { L1 } = truth;
  const L0 = truth.L0 || null;
  const { fixes } = L1;
  const notes = deliveredNotices(result);
  const silences = silenceWindowsMs(ctx.rows);
  const silentAt = (t0, t1 = t0) => silences.some(([a, z]) => t0 < z && t1 >= a);
  const out = [];
  const räknare = {
    besök: 0,
    bedömda: 0,
    ejObserverat: 0,
    förFåFixarFöre: 0,
    utanRörelsebevis: 0,
    underAvbrott: 0,
    gammalFixFöre: 0,
    'SEN-NOTIS': 0,
    tidslikUtesluten: { ejInmatad: 0, oklar: 0 },
    förklarade: {},
  };
  const visits = L0
    ? [...L0.radius, ...L0.kVisits].filter((v) => v.moving).sort((a, b) => (a.tIn - b.tIn) || a.mmsi.localeCompare(b.mmsi))
    : observedVisits(fixes);
  // Korsningen i besöket: L0 i syntetiska världar, punktfacit på banken.
  const crossingsOf = (mmsi, bridge) => (L0 ? L0.crossings : L1.crossings.filter((c) => !c.inferred))
    .filter((c) => c.mmsi === String(mmsi) && c.bridge === bridge);
  for (const v of visits) {
    räknare['besök']++;
    const list = fixes.get(String(v.mmsi)) || [];
    const inR = list.filter((f) => f.fixTs >= v.tIn - 120000 && f.fixTs <= v.tOut + 120000
      && f.nearest === v.bridge && geo.distToPoint(f.lat, f.lon, v.bridge) <= RADIUS_M);
    if (!inR.length) {
      räknare.ejObserverat++;
      continue;
    }
    const first = inR[0];
    const before = list.filter((f) => f.aisTimestamp < first.aisTimestamp);
    if (before.length < 2) {
      räknare['förFåFixarFöre']++;
      continue;
    }
    const moveProof = list.some((f) => f.aisTimestamp >= v.tIn - PRE_MS && f.aisTimestamp <= Math.max(v.tOut, first.aisTimestamp)
      && f.sog !== null && f.sog >= MOVE_KN);
    if (!moveProof) {
      räknare['utanRörelsebevis']++;
      continue;
    }
    if (silentAt(first.aisTimestamp) || silentAt(v.tIn, v.tOut)) {
      räknare.underAvbrott++;
      continue;
    }
    const lastBefore = before[before.length - 1];
    if (first.aisTimestamp - lastBefore.aisTimestamp > STALE_MS) {
      räknare.gammalFixFöre++;
      continue;
    }
    räknare['bedömda']++;
    const pad = L0 ? 1000 : PRE_MS;
    const cx = crossingsOf(v.mmsi, v.bridge).find((c) => c.t >= v.tIn - pad && c.t <= v.tOut + pad) || null;
    let visitDir = cx ? cx.dir : null;
    if (!visitDir && L0) {
      const bt = L0.boats.get(String(v.mmsi));
      const p = bt && bt.traj.length ? bt.traj[Math.max(0, Math.min(bt.traj.length - 1, Math.round(((first.fixTs - L0.startMs) / 1000) - bt.traj[0].t)))] : null;
      if (p && Math.abs(p.v) > 0.25) visitDir = p.v > 0 ? 'nord' : 'syd';
    }
    const mine = notes.filter((n) => String(n.mmsi) === String(v.mmsi) && n.bridge === v.bridge);
    const inWin = mine.filter((n) => n.t >= v.tIn - PRE_MS && n.t <= v.tOut + POST_MS);
    if (!inWin.length) {
      let prev = mine.filter((n) => n.t < v.tIn - PRE_MS).pop() || null;
      // Ett besök som var öppet i starttillståndet har sin notis före korpusen.
      const openAtStart = !prev && L1.openVisitsAtStart && L1.openVisitsAtStart.has(`${v.mmsi}:${v.bridge}`);
      if (openAtStart) {
        prev = {
          t: -Infinity, direction: null, message: '(öppet besök i starttillståndet)', starttillstånd: true,
        };
      }
      let förklaring = null;
      // Utfärdsbevis mellan förra notisen och besöket: två konsekutiva fixar > 350 m.
      let exited = false;
      if (prev) {
        let run = 0;
        for (const f of list) {
          if (f.aisTimestamp <= prev.t || f.aisTimestamp >= first.aisTimestamp) continue;
          if (geo.distToPoint(f.lat, f.lon, v.bridge) > EXIT_M) {
            run++;
            if (run >= 2) exited = true;
          } else run = 0;
        }
      }
      // Lämnade båten enligt L0 området mellan notisen och besöket?
      const physicallyLeft = prev && L0
        ? (L0.boats.get(String(v.mmsi))?.traj || []).some((p) => {
          const t = L0.startMs + (p.t * 1000);
          return t > prev.t && t < v.tIn && geo.distToPoint(p.lat, p.lon, v.bridge) > EXIT_M;
        })
        : null;
      if (prev && !exited) {
        if (EDGE_POINTS.has(v.bridge) && physicallyLeft) {
          förklaring = { post: 'BN1-BOXKANT', klass: 'KÄND_ÖPPEN', varför: `utfart vid ${v.bridge} utan två fixar > ${EXIT_M} m; förra notisen ${hms(prev.t)}` };
        } else {
          förklaring = {
            post: 'BESÖKSREGEL-2026-09-07',
            klass: 'DESIGN',
            varför: prev.starttillstånd
              ? `besöket var öppet i starttillståndet och inga två konsekutiva fixar > ${EXIT_M} m sedan korpusstart`
              : `förra notisen ${hms(prev.t)} och inga två konsekutiva fixar > ${EXIT_M} m sedan dess`,
          };
        }
      }
      if (!förklaring && v.bridge === 'Kanalinfarten') {
        // Sydgående utan kanalhistorik: ingen passerad bro före besöket och
        // första observerade fixen inte norr om punkten.
        const south = visitDir ? visitDir === 'syd' : inR.every((f) => f.cog === null || southCog(f.cog)) && inR.some((f) => southCog(f.cog));
        const passedBefore = (L0 ? L0.crossings : L1.crossings).some((c) => c.mmsi === String(v.mmsi) && c.t < first.fixTs);
        const startedNorth = list.length && list[0].lat > geo.K.lat + FP8_MARGIN_DEG;
        if (south && !passedBefore && !startedNorth) {
          förklaring = { post: 'KANALINFARTEN-FP8-SYDGRIND', klass: 'DESIGN', varför: 'sydgående vid Kanalinfarten utan kanalhistorik (ingen passerad bro, episodstart inte norr om punkten)' };
        }
      }
      if (!förklaring && prev && visitDir && toAppDir(visitDir) === prev.direction && v.tIn - prev.t <= DEDUP_MS) {
        förklaring = { post: 'D3-2H-DEDUP', klass: 'DESIGN', varför: `samma riktning ${prev.direction} inom 2 h (förra notisen ${hms(prev.t)})` };
      }
      if (!förklaring && cx && inR.every((f) => f.fixTs > cx.t) && first.aisTimestamp - cx.t > SKIP_AGE_MS) {
        förklaring = {
          post: 'SKIPPA-BRO-ÅLDER-17MIN',
          klass: 'DESIGN',
          varför: `korsningen ${hms(cx.t)} låg i ett glapp; första fixen efter kom ${Math.round((first.aisTimestamp - cx.t) / 60000)} min senare`,
        };
      }
      if (förklaring) räknare['förklarade'][förklaring.post] = (räknare['förklarade'][förklaring.post] || 0) + 1;
      out.push(fynd({
        orakel: 'T1',
        klass: 'NOTIS-UTEBLIVEN',
        allvar: 5,
        mmsi: v.mmsi,
        bro: v.bridge,
        riktning: toAppDir(visitDir),
        t: first.aisTimestamp,
        detalj: `${inR.length} observerade fixar ≤ ${RADIUS_M} m (första ${hms(first.aisTimestamp)}, ${Math.round(geo.distToPoint(first.lat, first.lon, v.bridge))} m); `
          + `sann ${cx ? `korsning ${hms(cx.t)} ${cx.dir}` : 'zonvistelse'}; ingen notis för nyckeln i [tIn − 10 min; tOut + 15 min]`
          + `${prev ? `; förra notisen ${hms(prev.t)}` : ''}`,
        belägg: {
          besök: { tIn: iso(v.tIn), tOut: iso(v.tOut), observerat: !!v.observed },
          förstaFix: { t: iso(first.aisTimestamp), avståndM: Math.round(geo.distToPoint(first.lat, first.lon, v.bridge)), rad: first.line },
          korsning: cx ? { t: iso(cx.t), dir: cx.dir } : null,
          förraNotis: prev ? { t: iso(prev.t), riktning: prev.direction, meddelande: prev.message } : null,
          öppetIStarttillstånd: !!openAtStart,
          utfärdObserverad: prev ? exited : null,
          lämnadeEnligtL0: physicallyLeft,
          förklaring,
        },
      }));
      continue;
    }
    const n = inWin[0];
    if (v.bridge !== 'Kanalinfarten' && n.t - first.aisTimestamp > LATE_MS) räknare['SEN-NOTIS']++;
    if (cx && n.alreadyPassed !== true && n.t > cx.t + FORM_SLACK_MS) {
      // Bara fixar som appen hade fått när notisen gick ut (noticeHadFix).
      // Förut räknade `f.aisTimestamp <= n.t` även en tidslik rad som
      // harnessen matade in först efter notisen (F21, värld 856).
      const past = list
        .filter((f) => f.aisTimestamp <= n.t && f.fixTs >= cx.t)
        .map((f) => ({ f, d: beyondLineM(f, v.bridge, cx.dir) }))
        .filter((x) => x.d > BEYOND_M);
      for (const x of past) {
        const slag = tiedAtNotice(x.f, n);
        if (slag === 'ej-inmatad') räknare.tidslikUtesluten.ejInmatad++;
        else if (slag === 'oklar') räknare.tidslikUtesluten.oklar++;
      }
      const beyond = past.filter((x) => noticeHadFix(x.f, n));
      if (beyond.length) {
        const worst = beyond.reduce((a, b) => (b.d > a.d ? b : a));
        out.push(fynd({
          orakel: 'T1',
          klass: 'FÖRVARNINGSFORM-EFTER-PASSAGE',
          allvar: 5,
          mmsi: v.mmsi,
          bro: v.bridge,
          riktning: toAppDir(cx.dir),
          t: n.t,
          detalj: `notis ${hms(n.t)} "${String(n.message || '').slice(0, 80)}" i förvarningsform, men sann korsning ${hms(cx.t)} `
            + `och appen hade fix ${Math.round(worst.d)} m bortom linjen (${hms(worst.f.aisTimestamp)})`,
          belägg: {
            notis: {
              t: iso(n.t), meddelande: n.message, alreadyPassed: n.alreadyPassed, eta: n.eta, source: n.source,
            },
            korsning: { t: iso(cx.t), dir: cx.dir },
            fixBortom: {
              t: iso(worst.f.aisTimestamp),
              bortomM: Math.round(worst.d),
              rad: worst.f.line,
              // Hur appen hade fixen (noticeHadFix): tidslik betyder att notisen byggdes på den.
              mottagen: worst.f.aisTimestamp === n.t ? 'notisens egen fix (tidslik)' : 'före notisen',
            },
            förklaring: null,
          },
        }));
      }
    }
  }
  return { fynd: out, räknare };
}

module.exports = { judgeT1, observedVisits };
