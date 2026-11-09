'use strict';

/**
 * T2 — ÖPPNINGSVARNING FÖRE SANN PASSAGE, T3 — FANTOMVARNING MOT AVSIKT och
 * T4 — EN VARNING PER ÖPPNING (liggare). Orakelkatalogen, BUGGJAKT.md bilaga B.
 *
 * T2 och T3 kör runOpeningGates oförändrade (analyseCoverage, classifyMiss,
 * analysePhantoms) med eventId i namnrymd, världens rader och L1 som facit.
 *   T2: bara PUNKTOBSERVERBARA L1-målbrokorsningar skickas in, även för andra
 *       båtar (exakt sanning för osedda korsningar gav falska OKLASSAD).
 *       Felet mäts mot L0: facitets t är den sanna korsningstiden.
 *   T3: alla L1-målbrokorsningar (inferred hamnar i INFERRERAD_TID), plus
 *       L0-avsikt: en varning vars medlemmar enligt L0 inte korsar bron inom
 *       120 min är fantom om inte L0 visar ett avbrott (U-sväng, stopp ≥ 10 min,
 *       förtöjning). Världen som tar slut inom 120 min döms inte.
 *
 * Utslag:
 *   T2 ÖPPNING-MISS:OKLASSAD (allvar 5), T2 LEDTID<60s (allvar 5; golvet är
 *     etapp7-plan C-IV:s 60 s, för kanarier max(60 s; WARNING_LEAD_MS −
 *     TICK_INTERVAL_MS − kadens − 10 s)). Ledtid 60–150 s räknas som "tunn".
 *   T3 FANTOM:<klass>, SEN:<klass>, FANTOM-UTAN-AVBROTT,
 *     VARNING-PÅ-FRUSET-FIX och VARNING-EFTER-SANN-PASSAGE (allvar 4). Den
 *     sista är byggets tillägg: en varning upp till 10 min efter att en
 *     medlem enligt L0 passerat bron (konvojfönstrets bakkant i fältradio,
 *     där korsningen inte är punktobserverbar och T2 därför inte ser den).
 *     Avbrottet som gör AVBRUTEN_APPROACH accepterad räknas från medlemmens
 *     senaste observerade fix, eftersom appen inte kunde se något senare.
 *   T4 räknare: grupper med > 1 och 0 levererade varningar (ger aldrig kort).
 *
 * Förklaringar (registret avgör): accepterade missklasser är tysta
 * (O1-ACCEPTERADE-MISSKLASSER); U2-VS-DEADLINE och J13-J14-KONVOJSEMANTIK
 * (KÄND_ÖPPEN), FIXD-SLINGA (KÄND_ÖPPEN). Konvojförklaringarna använder
 * lib/konvoj.js, samma definitioner av "täckt av händelsen" och "händelsens
 * första passage" som registrets predikat (triagens T-2, motorgranskningens
 * M04). Returresan (U2-RETURRESA) förklaras inte längre: U15 (2026-11-04)
 * gör INV-21:s returresa till kontraktet, så en retur utan egen varning är
 * en kandidat (registret 2026-11-07, BUGGJAKT §7 rad 23).
 *
 * Två beslut tillämpar oraklet själv (registerposterna har verkan iOraklet,
 * M12): en accepterad fantom (AVBRUTEN_APPROACH, GLES_ANFLYGNING) är tyst
 * bara när L0 visar korsning eller avbrott (FALSKLARM-AVBRUTEN-GLES), och en
 * accepterad sen passage (GARANTIPRIS: veff < 10 kn i classifyLatePassage)
 * ger inget utslag (DEADLINE-10KN-GARANTIPRIS); se judgePhantom.
 */

const gates = require('../../../runOpeningGates');
const C = require('../../../../../lib/constants');
const { asGt } = require('../truth');
const konvoj = require('../konvoj');
const {
  fynd, deliveredWarnings, namespaced, samplesFor, toAppDir, hms, iso, reversalsNear,
} = require('./truthCommon');

const BO = C.BRIDGE_OPENING;
const CONVOY_MS = BO.CONVOY_WINDOW_MS; // 600 s
const FLOOR_MS = 60000; // hårt ledtidsgolv (etapp7-plan C-IV; runOpeningGates)
const THIN_MS = 150000;
const INTENT_MS = 120 * 60000;
const FROZEN_FIX_MS = 19 * 60000;
const LATE_LOOKBACK_MS = 10 * 60000; // en varning upp till 10 min efter sann passage hör till samma öppning
const STOP_MIN_MS = 10 * 60000;

/** Medlemmar i en varning: mmsis, ledaren och konvojtäckning för samma eventId. */
function membersOf(w, coverage) {
  const m = new Set([...(Array.isArray(w.mmsis) ? w.mmsis.map(String) : []), ...(w.leadMmsi ? [String(w.leadMmsi)] : [])]);
  for (const c of coverage) if (c.eventId === w.eventId) m.add(String(c.mmsi));
  return m;
}

/** Kanariegolvet för enbåtsvärldar (orakelkatalogen T2). */
function canaryFloorMs(cadenceS) {
  return Math.max(FLOOR_MS, BO.WARNING_LEAD_MS - BO.TICK_INTERVAL_MS - (cadenceS * 1000) - 10000);
}

/**
 * Förklaringsvakterna för en T2-passage (miss eller kort ledtid), med
 * konvojsemantiken ur lib/konvoj.js — samma definitioner som registrets
 * predikat — och i registrets ordning med postens klassRegex:
 *   ÖPPNING-MISS:OKLASSAD  U2-VS-DEADLINE, J13-J14-KONVOJSEMANTIK
 *   LEDTID<Ns              U2-VS-DEADLINE, J13-J14-KONVOJSEMANTIK, O1 (varningsbarheten)
 * Rättat 2026-11-04 (triagens T-2): förut räknade oraklet alla
 * täckningsrader som medlemskap och prövade J13 före U2-VS-DEADLINE och O1
 * först, så 13 instanser i standardens T2-kandidatkluster bar en förklaring
 * som registret avvisade. Exporteras så att jest kan pröva att oraklets
 * förslag och registrets klass är desamma.
 * @param {object} p - L1-punktkorsningen {mmsi, bridge, t}
 * @param {{varningar: object[], korsningar: object[], coverage: object[]}} data - levererade varningar, punktkorsningar och openingCoverage
 * @param {{ledtid?: boolean, warnable?: object}} [opts] - LEDTID-utslag och båtens varningsbarhet (classifyMiss)
 * @returns {{post: string, klass: string, varför: string, eventId?: string}|null} förklaringen
 */
function explainT2(p, data, { ledtid = false, warnable = null } = {}) {
  // Registret läser korsningstiden ur beläggens ISO-tid (hela ms).
  const k = { mmsi: String(p.mmsi), bro: p.bridge, tc: Math.round(p.t) };
  const u2 = konvoj.inomHändelsefönster(k, data);
  if (u2.sant) {
    return {
      post: 'U2-VS-DEADLINE',
      klass: 'KÄND_ÖPPEN',
      varför: `korsningen ${Math.round((k.tc - u2.first.t) / 1000)} s efter händelsens första passage (${hms(u2.first.t)}, ${u2.first.mmsi}), inom CONVOY_WINDOW_MS; båten täckt av ${u2.w.eventId}`,
      eventId: u2.w.eventId,
    };
  }
  const j13 = konvoj.ickeMedlemEmellan(k, data);
  if (j13.sant) {
    return {
      post: 'J13-J14-KONVOJSEMANTIK',
      klass: 'KÄND_ÖPPEN',
      varför: `icke-medlem ${j13.x.mmsi} korsade ${hms(j13.x.t)} mellan varningen ${j13.w.eventId} (${hms(j13.w.t)}) och passagen`,
      eventId: j13.w.eventId,
    };
  }
  if (ledtid && warnable && warnable.accepted) {
    return { post: 'O1-ACCEPTERADE-MISSKLASSER', klass: 'ACCEPTERAD', varför: `${warnable.klass}: ${String(warnable.bevis || '').slice(0, 160)}` };
  }
  return null;
}

/**
 * Döm T2, T3 och T4.
 * @param {object} ctx - orakelkontext; ctx.opts.ledtidsgolvMs sätter T2-golvet
 * @returns {{fynd:object[], räknare:object}} utslag och räknare
 */
function judgeT2T3(ctx) {
  const result = namespaced(ctx);
  const samples = samplesFor(ctx);
  const { L1 } = ctx.truth;
  const L0 = ctx.truth.L0 || null;
  const floorMs = (ctx.opts && Number.isFinite(ctx.opts.ledtidsgolvMs)) ? ctx.opts.ledtidsgolvMs : FLOOR_MS;
  const warnings = deliveredWarnings(result);
  const coverage = result.openingCoverage || [];
  const gtPoint = asGt(L1.crossings, { targetsOnly: true, pointOnly: true });
  const gtAll = asGt(L1.crossings, { targetsOnly: true });
  const out = [];
  const räknare = {
    T2: {
      korsningar: gtPoint.length, täckta: 0, tunn: 0, osäkra: 0, missAccepterad: {}, förklarade: {},
    },
    T3: {
      varningar: warnings.length, bekräftade: 0, inferredTid: 0, accepterade: {}, L0Bekräftad: 0, ejDömdVärldsslut: 0, förklarade: {},
    },
    T4: { grupper: 0, flerÄn1: 0, noll: 0 },
  };
  const note = (bucket, post) => {
    räknare[bucket]['förklarade'][post] = (räknare[bucket]['förklarade'][post] || 0) + 1;
  };

  /** Konvojbelägg: båtens absorberade täckning och egna varningar för bron före t. */
  const convoyEvidence = (mmsi, bridge, beforeT) => {
    const absorbed = coverage.filter((c) => String(c.mmsi) === String(mmsi) && c.bridge === bridge && c.reason === 'absorbed' && c.t < beforeT)
      .map((c) => ({ eventId: c.eventId, t: iso(c.t) }));
    const own = warnings.filter((w) => w.bridge === bridge && String(w.leadMmsi) === String(mmsi) && w.t < beforeT + 600000)
      .map((w) => ({ eventId: w.eventId, t: iso(w.t) }));
    return absorbed.length ? { absorberad: absorbed, egnaVarningar: own } : null;
  };

  // Konvojförklaringarna med samma underlag som registrets predikat (explainT2).
  const konvojData = { varningar: warnings, korsningar: gtPoint, coverage };
  const t2Explain = (p, opts) => explainT2(p, konvojData, opts);

  // ---- T2 ----
  const cov = gates.analyseCoverage(result, samples, gtPoint);
  räknare.T2['osäkra'] = cov.uncertain.length;
  for (const m of cov.misses) {
    if (m.accepted) {
      räknare.T2['missAccepterad'][m.klass] = (räknare.T2['missAccepterad'][m.klass] || 0) + 1;
      continue;
    }
    const p = m.passage;
    const förklaring = t2Explain(p);
    if (förklaring) note('T2', förklaring.post);
    out.push(fynd({
      orakel: 'T2',
      klass: `ÖPPNING-MISS:${m.klass}`,
      allvar: 5,
      mmsi: p.mmsi,
      bro: p.bridge,
      riktning: toAppDir(p.dir),
      t: p.t,
      detalj: `sann korsning ${hms(p.t)} ${p.dir || ''} utan varning före; ${String(m.bevis || '').slice(0, 300)}`,
      belägg: {
        korsning: { t: iso(p.t), dir: p.dir },
        missklass: m.klass,
        bevis: m.bevis,
        varningarFörBron: warnings.filter((w) => w.bridge === p.bridge).map((w) => ({
          t: iso(w.t), eventId: w.eventId, lead: w.leadMmsi, mmsis: w.mmsis,
        })),
        konvoj: convoyEvidence(p.mmsi, p.bridge, p.t),
        förklaring,
      },
    }));
  }
  for (const c of cov.covered) {
    räknare.T2['täckta']++;
    if (c.leadMs >= THIN_MS) continue;
    if (c.leadMs >= floorMs) {
      räknare.T2.tunn++;
      continue;
    }
    const p = c.passage;
    // Bara VARNINGSBARA båtar har rätt till full ledtid: samma missklassning
    // som O1 (classifyMiss) avgör om båten sågs tidigt nog, var under gång i
    // rätt riktning och höll sig under deadline-taket.
    const prev = gtPoint.filter((q) => q !== p && String(q.mmsi) === String(p.mmsi) && q.bridge === p.bridge && q.t < p.t).pop();
    const warnable = gates.classifyMiss(p, samples, prev ? (prev.tTo ?? prev.t) : null, !!prev && prev.tFrom < prev.tTo);
    const förklaring = t2Explain(p, { ledtid: true, warnable });
    if (förklaring) note('T2', förklaring.post);
    out.push(fynd({
      orakel: 'T2',
      klass: `LEDTID<${Math.round(floorMs / 1000)}s`,
      allvar: 5,
      mmsi: p.mmsi,
      bro: p.bridge,
      riktning: toAppDir(p.dir),
      t: p.t,
      detalj: `varning ${c.warning.eventId} ${hms(c.warning.t)} (${c.via}) bara ${Math.round(c.leadMs / 1000)} s före sann korsning ${hms(p.t)}`,
      belägg: {
        korsning: { t: iso(p.t), dir: p.dir },
        varning: {
          t: iso(c.warning.t), eventId: c.warning.eventId, via: c.via, lead: c.warning.leadMmsi, mmsis: c.warning.mmsis,
        },
        ledtidS: Math.round(c.leadMs / 1000),
        golvS: Math.round(floorMs / 1000),
        varningsbarhet: warnable.klass,
        konvoj: convoyEvidence(p.mmsi, p.bridge, p.t),
        förklaring,
      },
    }));
  }

  // ---- T3 ----
  const ph = gates.analysePhantoms(result, samples, gtAll);
  räknare.T3['bekräftade'] = ph.confirmed;
  räknare.T3.inferredTid = ph.inferredTime.length;
  const worldEnd = L0 ? L0.endMs : Math.max(...(ctx.rows || []).map((r) => r.aisTimestamp || 0));
  const l0Crossed = (w, mem, horizonMs) => (L0 ? L0.crossings.find((x) => x.bridge === w.bridge && mem.has(x.mmsi)
    && x.t >= w.t && x.t <= w.t + horizonMs) : null);
  // Medlemmens senaste observerade fix före t (fixtid): ett avbrott efter den
  // kunde appen inte ha sett när varningen gick ut.
  // `<=` är avsiktligt (E6, analyserat 2026-11-04): en rad på exakt
  // varningens tid är i praktiken raden som utlöste en fix-varning (firedBy
  // 'fix', avfyrad när raden matades in) och som appen alltså hade. I
  // standardens 2 000 världar gällde det 2 351 av 2 352 tidslika medlemsrader;
  // den enda deadline-varningen med tidslik rad ändrade inget utfall. T1:s
  // regel (truthCommon.noticeHadFix) passar inte här: varningar har ingen
  // frusen position, och en strikt jämförelse hade dolt ett äkta
  // FANTOM-UTAN-AVBROTT (bilaga B T3).
  const lastSeenFixTs = (m, t) => {
    let last = null;
    for (const s of samples.get(String(m)) || []) if (s.aisTimestamp <= t) last = s;
    if (!last) return null;
    return Number.isFinite(last.fixTs) ? last.fixTs : last.aisTimestamp;
  };
  const l0Interrupt = (w, mem) => {
    if (!L0) return null;
    const seen = [...mem].map((m) => lastSeenFixTs(m, w.t)).filter(Number.isFinite);
    const from = Math.min(w.t, ...seen) - 60000;
    const u = L0.uturns.find((x) => mem.has(x.mmsi) && x.t >= from && x.t <= w.t + INTENT_MS);
    if (u) return `U-sväng ${hms(u.t)}`;
    const s = L0.stops.find((x) => mem.has(x.mmsi) && x.t1 >= from && x.t0 <= w.t + INTENT_MS && (x.kind === 'moor' || x.t1 - x.t0 >= STOP_MIN_MS));
    if (s) return `${s.kind === 'moor' ? 'förtöjd' : 'stopp'} ${hms(s.t0)}–${hms(s.t1)}`;
    return null;
  };
  const judgePhantom = (p, bucket) => {
    const w = p.warning;
    const mem = membersOf(w, coverage);
    const crossedSoon = l0Crossed(w, mem, gates.PHANTOM_WINDOW_MS);
    if (crossedSoon) {
      // Appen hade rätt: korsningen inom 20 min fanns i L0 men var inte
      // observerbar på båda sidor i L1 (och kunde därför inte bära hinken).
      räknare.T3.L0Bekräftad++;
      return;
    }
    // Varningen kom EFTER att en medlem enligt L0 redan passerat bron
    // (konvojfönstrets bakkant: täckningen släpps vid referensankomst + 10 min).
    const crossedBefore = L0 ? L0.crossings.filter((x) => x.bridge === w.bridge && mem.has(x.mmsi)
      && x.t < w.t && x.t >= w.t - LATE_LOOKBACK_MS).pop() : null;
    if (crossedBefore) {
      // Var båten varningsbar inför den passagen? (samma prov som T2)
      const passage = {
        t: crossedBefore.t, mmsi: crossedBefore.mmsi, bridge: w.bridge, inferred: false, dir: crossedBefore.dir, tFrom: crossedBefore.t, tTo: crossedBefore.t,
      };
      const warnable = gates.classifyMiss(passage, samples, null);
      const förklaring = warnable.accepted
        ? { post: 'O1-ACCEPTERADE-MISSKLASSER', klass: 'ACCEPTERAD', varför: `${warnable.klass}: ${String(warnable.bevis || '').slice(0, 160)}` }
        : null;
      if (förklaring) note('T3', förklaring.post);
      out.push(fynd({
        orakel: 'T3',
        klass: 'VARNING-EFTER-SANN-PASSAGE',
        allvar: 4,
        mmsi: crossedBefore.mmsi,
        bro: w.bridge,
        riktning: w.direction,
        t: w.t,
        detalj: `varning ${w.eventId} ${hms(w.t)} kom ${Math.round((w.t - crossedBefore.t) / 1000)} s EFTER att medlemmen `
          + `${crossedBefore.mmsi} enligt L0 passerade ${w.bridge} (${hms(crossedBefore.t)}); rådataklass ${p.klass}`,
        belägg: {
          varning: {
            t: iso(w.t), eventId: w.eventId, mmsis: [...mem], firedBy: w.firedBy, distance: w.distance,
          },
          sannPassage: { t: iso(crossedBefore.t), mmsi: crossedBefore.mmsi, dir: crossedBefore.dir },
          efterS: Math.round((w.t - crossedBefore.t) / 1000),
          senasteFix: iso(lastSeenFixTs(crossedBefore.mmsi, w.t)),
          konvoj: convoyEvidence(crossedBefore.mmsi, w.bridge, crossedBefore.t),
          rådataklass: p.klass,
          varningsbarhet: warnable.klass,
          förklaring,
        },
      }));
      return;
    }
    if (p.accepted) {
      räknare.T3['accepterade'][p.klass] = (räknare.T3['accepterade'][p.klass] || 0) + 1;
      if (!L0 || bucket !== 'FANTOM') return;
      // ACCEPTERAD bara när L0 bekräftar avbrottet.
      if (w.t + INTENT_MS > worldEnd) {
        räknare.T3['ejDömdVärldsslut']++;
        return;
      }
      if (l0Crossed(w, mem, INTENT_MS) || l0Interrupt(w, mem)) return;
      out.push(fynd({
        orakel: 'T3',
        klass: 'FANTOM-UTAN-AVBROTT',
        allvar: 4,
        mmsi: w.leadMmsi,
        bro: w.bridge,
        riktning: w.direction,
        t: w.t,
        detalj: `varning ${w.eventId} ${hms(w.t)} klassad ${p.klass}, men enligt L0 korsar ingen medlem ${w.bridge} inom 120 min och inget avbrott finns`,
        belägg: {
          varning: { t: iso(w.t), eventId: w.eventId, mmsis: [...mem] }, rådataklass: p.klass, bevis: p.bevis, förklaring: null,
        },
      }));
      return;
    }
    let förklaring = null;
    if (L0 && [...mem].some((m) => reversalsNear(L0, m, w.t) >= 2)) {
      förklaring = { post: 'FIXD-SLINGA', klass: 'KÄND_ÖPPEN', varför: 'minst två vändningar inom 60 min kring varningen' };
      note('T3', förklaring.post);
    }
    out.push(fynd({
      orakel: 'T3',
      klass: `${bucket === 'FANTOM' ? 'FANTOM' : 'SEN'}:${p.klass}`,
      allvar: 4,
      mmsi: w.leadMmsi,
      bro: w.bridge,
      riktning: w.direction,
      t: w.t,
      detalj: `varning ${w.eventId} ${hms(w.t)}${p.passage ? ` (passage först ${hms(p.passage.t)})` : ''}: ${String(p.bevis || '').slice(0, 300)}`,
      belägg: {
        varning: { t: iso(w.t), eventId: w.eventId, mmsis: [...mem] },
        passage: p.passage ? { t: iso(p.passage.t), mmsi: p.passage.mmsi } : null,
        L0Avbrott: l0Interrupt(w, mem),
        bevis: p.bevis,
        förklaring,
      },
    }));
  };
  for (const p of ph.phantoms) judgePhantom(p, 'FANTOM');
  for (const p of ph.latePassages) judgePhantom(p, 'SEN');
  // VARNING-PÅ-FRUSET-FIX: någon medlems senaste fix före varningen är äldre än 19 min.
  // `<=` är avsiktligt av samma skäl som i lastSeenFixTs: den tidslika raden
  // är den som utlöste en fix-varning. En strikt jämförelse hade gett 19
  // falska utslag i standardens världar, där en färsk fix efter mer än 19 min
  // tystnad utlöser varningen (E6, bilaga B T3).
  for (const w of warnings) {
    const mem = [...(Array.isArray(w.mmsis) ? w.mmsis.map(String) : []), ...(w.leadMmsi ? [String(w.leadMmsi)] : [])];
    for (const m of new Set(mem)) {
      const list = samples.get(m) || [];
      let last = null;
      for (const s of list) if (s.aisTimestamp <= w.t) last = s;
      if (last && w.t - last.aisTimestamp > FROZEN_FIX_MS) {
        out.push(fynd({
          orakel: 'T3',
          klass: 'VARNING-PÅ-FRUSET-FIX',
          allvar: 4,
          mmsi: m,
          bro: w.bridge,
          riktning: w.direction,
          t: w.t,
          detalj: `varning ${w.eventId} ${hms(w.t)} med medlem ${m} vars senaste fix är ${Math.round((w.t - last.aisTimestamp) / 60000)} min gammal`,
          belägg: {
            varning: { t: iso(w.t), eventId: w.eventId }, senasteFix: iso(last.aisTimestamp), förklaring: null,
          },
        }));
        break;
      }
    }
  }

  // ---- T4 (liggare) ----
  const byBridge = new Map();
  for (const p of gtPoint) {
    if (!byBridge.has(p.bridge)) byBridge.set(p.bridge, []);
    byBridge.get(p.bridge).push(p);
  }
  for (const [bridge, list] of byBridge) {
    const groups = [];
    for (const p of list.sort((a, b) => a.t - b.t)) {
      const g = groups[groups.length - 1];
      if (!g || p.t - g.first > CONVOY_MS) groups.push({ first: p.t });
    }
    groups.forEach((g, i) => {
      const from = i > 0 ? groups[i - 1].first : -Infinity;
      const n = warnings.filter((w) => w.bridge === bridge && w.t > from && w.t <= g.first).length;
      räknare.T4.grupper++;
      if (n > 1) räknare.T4['flerÄn1']++;
      if (n === 0) räknare.T4.noll++;
    });
  }
  return { fynd: out, räknare };
}

module.exports = {
  judgeT2T3, explainT2, canaryFloorMs, membersOf, FLOOR_MS, FROZEN_FIX_MS,
};
