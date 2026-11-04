'use strict';

/**
 * Sanningsspårets kärna i motorn (BUGGJAKT §4, fas 2 och 4).
 *
 * En spec blir en dömd värld:
 *   djupfryst spec → L0 (world.js) → radio (radio.js) → schemavaliderade
 *   rader → replay i poolen → dom med alla orakel → fynd i motorns format,
 *   klassade av beslutsregistret.
 *
 * Oraklen är sanningsoraklen T1, T2/T3/T4, T9 och T10 (oracles/truthJudge.js)
 * plus de befintliga domarna INV-F, INV-W och LEV (oracles/existing.js) och
 * hälsoorakel H1–H3 (oracles/health.js). Syntetiska världar döms ABSOLUT:
 * varje utslag är ett rått fynd (INV-W är alltid räknare).
 *
 * Samma kod används av spåret (alla världar), av krympningen och bekräftelsen
 * (prov på förenklade specar) och av hunt:repro. Modulen har inga timers och
 * inget globalt tillstånd; replay sker bara via den pool som skickas in.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { deepFreeze, hashRows } = require('./rng');
const { simulateWorld } = require('./world');
const { observeWorld, checkRows, toJsonl } = require('./radio');
const { worldTruth, densityLevel, asGt } = require('./truth');
const schema = require('./schema');
const existing = require('./oracles/existing');
const health = require('./oracles/health');
const { judgeTruth } = require('./oracles/truthJudge');
const { toAppDir } = require('./oracles/truthCommon');
const { namespaceEventIds } = require('./instances');
const { makeFinding, mechanismOf } = require('./finding');
const { fmtClock, fmtNum, fmtDuration } = require('./report');

const TRUTH_ORACLES = Object.freeze(['T1', 'T2', 'T9', 'T10']);
const TIMELINE_BEFORE_MS = 15 * 60000;
const TIMELINE_AFTER_MS = 10 * 60000;
const TIMELINE_MAX = 60;
const TIMELINE_CARD = 14;
const RIKTNING = Object.freeze({
  northbound: 'norrut', southbound: 'söderut', unknown: 'okänd riktning', nord: 'norrut', syd: 'söderut',
});

const clone = (x) => JSON.parse(JSON.stringify(x));
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const ms = (x) => {
  if (Number.isFinite(x)) return x;
  if (typeof x === 'string') {
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Värld: spec → rader och sanning
// ---------------------------------------------------------------------------

/**
 * Bygger en värld ur en spec. Specen klonas och djupfryses, så varken
 * simulatorn, radion eller anroparen kan skriva i den.
 * @param {object} spec - världens spec (families.sampleWorld eller en förenklad kopia)
 * @param {{profile: string, overrides?: object}} radio - radioprofil (R0/R1)
 * @returns {object} {spec, sim, rows, realisation, truth, density, radHash, simTimmar, jsonl}
 */
function materialize(spec, { profile, overrides = {} }) {
  const frozen = deepFreeze(clone(spec));
  const sim = simulateWorld(frozen);
  const { rows, realisation } = observeWorld(sim, { profile, overrides });
  checkRows(rows);
  schema.assertValidRows(rows, `värld ${frozen.seed} (${profile})`);
  const truth = worldTruth(sim, rows);
  const jsonl = toJsonl(rows);
  return {
    spec: frozen,
    profile,
    sim,
    rows,
    realisation,
    truth,
    density: densityLevel(truth.L0),
    radHash: hashRows(rows),
    simTimmar: frozen.durS / 3600,
    jsonl,
  };
}

/**
 * Skriver världens jsonl och kör den i poolen.
 * @param {object} pool - lib/pool.js Pool
 * @param {object} built - materialize-resultat
 * @param {{dir: string, namn: string, monitoring: boolean}} opts - var och hur
 * @returns {Promise<{utfall: object, jsonlPath: string}>} poolens utfall
 */
async function runBuilt(pool, built, { dir, namn, monitoring }) {
  fs.mkdirSync(dir, { recursive: true });
  const jsonlPath = path.join(dir, `${namn}.jsonl`);
  fs.writeFileSync(jsonlPath, built.jsonl);
  const utfall = await pool.run({
    jsonl: jsonlPath, monitoring: !!monitoring, rader: built.rows.length, simTimmar: built.simTimmar, etikett: namn,
  });
  return { utfall, jsonlPath };
}

// ---------------------------------------------------------------------------
// Fyndformat och registerkontext
// ---------------------------------------------------------------------------

/**
 * Numeriska alias i beläggen för registrets predikat (registry.js läser
 * tIn, tOut, tFörstaFix, korsningT, förväntadRiktning, bortomLinjenM och
 * varning.t som epok-ms). Oraklens egna fält lämnas orörda.
 * @param {object} raw - oraklets fynd
 * @returns {object} belägg
 */
function registryAliases(raw) {
  const b = { ...(raw.belägg || {}) };
  if (raw.orakel === 'T1') {
    if (b.besök) {
      b.tIn = ms(b.besök.tIn);
      b.tOut = ms(b.besök.tOut);
    }
    if (b.förstaFix) b.tFörstaFix = ms(b.förstaFix.t);
    if (b.korsning) {
      b.korsningT = ms(b.korsning.t);
      b.förväntadRiktning = toAppDir(b.korsning.dir) || raw.riktning || undefined;
    }
    if (b.fixBortom && Number.isFinite(b.fixBortom.bortomM)) b.bortomLinjenM = b.fixBortom.bortomM;
  }
  if ((raw.orakel === 'T2' || raw.orakel === 'T10') && b.korsning) b.korsningT = ms(b.korsning.t);
  if (raw.orakel === 'T3' && b.varning) b.varning = { ...b.varning, t: ms(b.varning.t) };
  for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
  return b;
}

/**
 * Registerkontexten för en syntetisk värld (registry.js modulhuvud).
 * @param {object} built - materialize-resultat
 * @param {object} resultat - replayresultatet med eventId i namnrymd
 * @param {{radio: string, profil: string}} meta - radio- och körprofil
 * @returns {object} kontext
 */
function registryContext(built, resultat, { radio, profil }) {
  const { L0, L1 } = built.truth;
  return {
    rader: built.rows,
    resultat,
    gt: asGt(L1.crossings),
    sanning: L0 ? {
      crossings: L0.crossings,
      uturns: L0.uturns,
      stops: L0.stops.map((s) => ({
        mmsi: s.mmsi, tIn: s.t0, tOut: s.t1, kind: s.kind,
      })),
    } : null,
    radio,
    profil,
    täthet: { stress: built.density.nivå === 'stress', maxSamtidiga: built.density.maxSamtidiga, längstaKedja: built.density.längstaKedja },
    korpus: null,
  };
}

/** Fyndets inblandade mmsi: fyndets eget plus varningens medlemmar och ledare. */
function involvedMmsis(f) {
  const b = f.belägg || {};
  const out = new Set();
  if (f.mmsi) out.add(String(f.mmsi));
  const w = b.varning || {};
  for (const m of w.mmsis || []) out.add(String(m));
  if (w.lead) out.add(String(w.lead));
  if (b.sannPassage && b.sannPassage.mmsi) out.add(String(b.sannPassage.mmsi));
  return [...out].filter((m) => /^\d{9}$/.test(m)).sort();
}

/**
 * Klassar fynd med registret och sätter f.register (och taggposternas taggar).
 * @param {object} register - Registry
 * @param {object[]} fynd - fynd
 * @param {object} ctx - registerkontext
 * @param {{räkna?: boolean}} [opts] - räkna=false för krympningens prov
 * @returns {object[]} samma fynd
 */
function classifyAll(register, fynd, ctx, { räkna = true } = {}) {
  for (const f of fynd) {
    const c = register.classify(f, ctx, { räkna });
    f.register = {
      klass: c.klass, post: c.post, närmast: c.närmast, skäl: c.skäl, prövade: (c.prövade || []).slice(0, 4),
    };
    if (c.taggar.length) f.taggar = [...new Set([...(f.taggar || []), ...c.taggar])].sort();
  }
  return fynd;
}

/**
 * Dömer en körd värld med alla orakel och klassar utslagen.
 * @param {object} args - {built, utfall, jsonlPath, register, h3Baslinje, okalibrerade, meta}
 *   meta = {index, radio, monitoring, profil (körprofilens namn), basSeed}
 * @returns {{fynd: object[], räknare: object, resultat: object|null, kontext: object|null}} dom
 */
function judgeBuilt({
  built, utfall, jsonlPath, register, h3Baslinje = null, okalibrerade = [], meta, räkna = true,
}) {
  const { spec } = built;
  const nivå = built.density.nivå === 'stress' ? 'stress' : meta.radio;
  const ursprung = {
    värld: meta.index,
    seed: spec.seed,
    radio: meta.radio,
    era: meta.radio === 'R0' ? 'aisstream' : spec.era,
    familj: spec.familj,
    monitoring: !!meta.monitoring,
    täthet: built.density.nivå,
    båtar: spec.boats.length,
    timmar: Math.round(built.simTimmar * 1000) / 1000,
    rader: built.rows.length,
  };
  const mk = (raw) => makeFinding({
    ...raw,
    belägg: registryAliases(raw),
    räknare: raw.räknare || okalibrerade.includes(raw.orakel),
    spår: 'synth',
    nivå,
    ursprung,
  });
  const fynd = [];
  for (const f of health.h2(utfall)) fynd.push(mk(f));
  if (!utfall.ok) {
    if (utfall.fatal) for (const f of health.h1(utfall)) fynd.push(mk(f));
    else if (!utfall.häng) {
      fynd.push(mk({
        orakel: 'H1', klass: 'PROCESSFEL inget resultat', allvar: health.H1_SEVERITY, detalj: utfall.fel || 'inget resultat', belägg: { fel: utfall.fel },
      }));
    }
    const ctx = registryContext(built, null, { radio: meta.radio, profil: meta.profil });
    classifyAll(register, fynd, ctx, { räkna });
    return {
      fynd, räknare: {}, resultat: null, kontext: ctx,
    };
  }
  const resultat = namespaceEventIds(utfall.resultat, built.rows);
  const gtAll = asGt(built.truth.L1.crossings);
  for (const f of health.h1(utfall)) fynd.push(mk(f));
  for (const f of health.h3(utfall.stderr.h3, h3Baslinje, { simTimmar: built.simTimmar, exempel: utfall.stderr.exempel })) fynd.push(mk(f));
  const ex = existing.judgeExisting({ result: utfall.resultat, rows: built.rows, gt: gtAll });
  for (const f of ex.fynd) fynd.push(mk(f));
  const truthCtx = {
    result: utfall.resultat, rows: built.rows, truth: built.truth, world: spec, jsonlPath, namespaceEventIds, opts: {},
  };
  const judged = judgeTruth(truthCtx, { oracles: TRUTH_ORACLES });
  for (const f of judged.fynd) fynd.push(mk(f));
  const ctx = registryContext(built, resultat, { radio: meta.radio, profil: meta.profil });
  classifyAll(register, fynd, ctx, { räkna });
  return {
    fynd, räknare: judged.räknare, resultat, kontext: ctx,
  };
}

/**
 * Matchar ett fynd målet för krympning och bekräftelse? Samma mekanism, samma
 * bro om målet har en, minst ett inblandat mmsi gemensamt och samma
 * registerutfall (krympningen får inte glida över i en känd förklaring).
 * @param {object} f - fynd ur ett prov
 * @param {object} mål - {mekanism, bro, mmsis, registerklass, post}
 * @returns {boolean} träff
 */
function matchesTarget(f, mål) {
  if (f.räknare) return false;
  if (mechanismOf(f) !== mål.mekanism) return false;
  if (mål.bro && f.bro !== mål.bro) return false;
  if (mål.mmsis && mål.mmsis.length && !involvedMmsis(f).some((m) => mål.mmsis.includes(m))) return false;
  const reg = f.register || {};
  if (mål.registerklass && (reg.klass || 'KANDIDAT') !== mål.registerklass) return false;
  if ((mål.post || null) !== (reg.post || null)) return false;
  return true;
}

/** Krympningens och bekräftelsens mål för en representant. */
function targetOf(f) {
  return {
    mekanism: mechanismOf(f),
    bro: f.bro || null,
    mmsis: involvedMmsis(f),
    registerklass: (f.register && f.register.klass) || 'KANDIDAT',
    post: (f.register && f.register.post) || null,
  };
}

// ---------------------------------------------------------------------------
// Tidslinje: sanning mot app
// ---------------------------------------------------------------------------

/**
 * Tidslinje kring t (från 15 min före till 10 min efter): L0-händelser
 * (korsningar, U-svängar, stopp) och appens händelser (notiser, varningar,
 * absorptioner, passager) för de inblandade båtarna — fyndets egna mmsi plus
 * medlemmarna i de händelser vid fyndets bro som båten var medlem i eller
 * absorberades i (konvojbakkanten kräver A:s händelse för att B ska gå att
 * förstå). Kortet visar de högst 14 rader som ligger vid fyndets bro och
 * närmast t; tidslinje.txt får alla.
 * @param {object} built - materialize-resultat
 * @param {object|null} resultat - replayresultatet (namnrymdade eventId)
 * @param {object} f - fyndet
 * @returns {{kort: string[], full: string[]}} rader
 */
function timelineFor(built, resultat, f) {
  if (!Number.isFinite(f.t)) return { kort: [], full: [] };
  const lo = f.t - TIMELINE_BEFORE_MS;
  const hi = f.t + TIMELINE_AFTER_MS;
  const who = new Set(involvedMmsis(f));
  if (resultat && f.mmsi && f.bro) {
    const events = new Set([
      ...(resultat.openingCoverage || []).filter((c) => String(c.mmsi) === String(f.mmsi) && c.bridge === f.bro).map((c) => c.eventId),
      ...(resultat.openingWarnings || []).filter((w) => w.bridge === f.bro && (w.mmsis || []).map(String).includes(String(f.mmsi))).map((w) => w.eventId),
    ]);
    for (const w of resultat.openingWarnings || []) {
      if (!events.has(w.eventId) || w.t < lo - TIMELINE_BEFORE_MS || w.t > hi) continue;
      for (const m of w.mmsis || []) who.add(String(m));
      if (w.leadMmsi) who.add(String(w.leadMmsi));
    }
  }
  if (!who.size) for (const b of built.spec.boats) who.add(String(b.mmsi));
  const name = new Map(built.spec.boats.map((b) => [String(b.mmsi), b.name]));
  const label = (m) => `${m}${name.get(String(m)) ? ` ${name.get(String(m))}` : ''}`;
  const ev = [];
  const push = (t, src, text, bro) => ev.push({
    t, src, text, prio: !f.bro || bro === f.bro ? 0 : 1,
  });
  const { L0 } = built.truth;
  for (const c of L0.crossings) {
    if (who.has(c.mmsi)) push(c.t, 'L0', `${label(c.mmsi)} korsar ${c.bridge} ${RIKTNING[c.dir] || c.dir} (${fmtNum(c.kn, 1)} kn)`, c.bridge);
  }
  for (const u of L0.uturns) if (who.has(u.mmsi)) push(u.t, 'L0', `${label(u.mmsi)} vänder (U-sväng vid s ${Math.round(u.s)} m)`, f.bro);
  for (const s of L0.stops) {
    if (who.has(s.mmsi) && s.kind !== 'moor') push(s.t0, 'L0', `${label(s.mmsi)} stannar (${s.kind}, ${fmtDuration(s.t1 - s.t0)})`, f.bro);
  }
  if (resultat) {
    for (const n of resultat.notifications || []) {
      if (n.success === false || !who.has(String(n.mmsi))) continue;
      push(n.t, 'app', `notis ${n.bridge} ${RIKTNING[n.direction] || n.direction} ${label(n.mmsi)}${n.alreadyPassed ? ' (passerad form)' : ` eta ${n.eta}`}`, n.bridge);
    }
    for (const w of resultat.openingWarnings || []) {
      if (w.success === false) continue;
      const mem = (w.mmsis || []).map(String);
      if (w.bridge !== f.bro && !mem.some((m) => who.has(m))) continue;
      push(w.t, 'app', `varning ${w.eventId} ${RIKTNING[w.direction] || w.direction} ledare ${label(w.leadMmsi)} (${w.firedBy}) [${mem.join(',')}]`, w.bridge);
    }
    for (const c of resultat.openingCoverage || []) {
      if (c.reason === 'absorbed' && who.has(String(c.mmsi))) push(c.t, 'app', `${label(c.mmsi)} absorberas i ${c.eventId}`, c.bridge);
    }
    for (const p of resultat.targetPassages || []) if (who.has(String(p.mmsi))) push(p.t, 'app', `målbropassage ${p.bridge} ${label(p.mmsi)}`, p.bridge);
    for (const p of resultat.intermediatePassages || []) if (who.has(String(p.mmsi))) push(p.t, 'app', `mellanbropassage ${p.bridge} ${label(p.mmsi)}`, p.bridge);
  }
  for (const e of built.spec.events || []) push(built.spec.startMs + (e.atS * 1000), 'radio', `ctrl:${e.ctrl}`, f.bro);
  const inWin = ev.filter((e) => e.t >= lo && e.t <= hi);
  const chrono = (a, b) => (a.t - b.t) || (a.src < b.src ? -1 : 1) || (a.text < b.text ? -1 : 1);
  const line = (e) => `${fmtClock(e.t)}  ${e.src.padEnd(5)}  ${e.text}`;
  const full = [...inWin].sort(chrono).slice(0, TIMELINE_MAX);
  const kort = [...inWin].sort((a, b) => (a.prio - b.prio) || (Math.abs(a.t - f.t) - Math.abs(b.t - f.t)) || chrono(a, b))
    .slice(0, TIMELINE_CARD).sort(chrono);
  return { kort: kort.map(line), full: full.map(line) };
}

// ---------------------------------------------------------------------------
// Beskrivningar
// ---------------------------------------------------------------------------

/** "2 båtar söderut, klass A, 54 rader, 1 h 10 min" */
function describeWorld(built) {
  const { boats } = built.spec;
  const dirs = {};
  for (const b of boats) {
    const k = b.role === 'moored' ? 'vid kaj' : (RIKTNING[b.dir === 'north' ? 'nord' : 'syd']);
    dirs[k] = (dirs[k] || 0) + 1;
  }
  const dirText = Object.entries(dirs).sort().map(([k, n]) => (Object.keys(dirs).length === 1 ? k : `${n} ${k}`)).join(', ');
  const uturns = boats.filter((b) => (b.plan || []).some((p) => p.op === 'uturn')).length;
  const classes = built.profile === 'R0' ? ['A'] : [...new Set(boats.map((b) => b.cls))].sort();
  const rows = built.rows.filter((r) => !r.ctrl);
  const span = rows.length > 1 ? rows[rows.length - 1].aisTimestamp - rows[0].aisTimestamp : 0;
  const sep = Object.keys(dirs).length === 1 ? ' ' : ': ';
  return `${boats.length} ${boats.length === 1 ? 'båt' : 'båtar'}${sep}${dirText}${uturns ? ` (${uturns} med U-sväng)` : ''}, klass ${classes.join('/')}, `
    + `${built.rows.length} rader, ${fmtDuration(span)} (${built.profile}${built.spec.era && built.profile !== 'R0' ? `, ${built.spec.era}` : ''})`;
}

/** Världens spec i repro-format (hunt:repro bygger om världen ur den). */
function specFileContent(built, { monitoring }) {
  return `${JSON.stringify({
    format: 'buggjägaren-spec/1', spec: built.spec, radio: { profil: built.profile }, monitoring: !!monitoring, realisering: built.realisation,
  }, null, 1)}\n`;
}

module.exports = {
  TRUTH_ORACLES,
  clone,
  sha,
  materialize,
  runBuilt,
  registryAliases,
  registryContext,
  involvedMmsis,
  classifyAll,
  judgeBuilt,
  matchesTarget,
  targetOf,
  timelineFor,
  describeWorld,
  specFileContent,
};
