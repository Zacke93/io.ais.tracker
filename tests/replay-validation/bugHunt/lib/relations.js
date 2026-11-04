'use strict';

/**
 * Metamorfa relationer på banken (BUGGJAKT §5).
 *
 * M-EXAKT (självtest): ID, SHIFT30 och MMSI är uppmätt tysta på 24 av 24
 * korpusar. Ett brott stoppar jakten (exit 2): antingen räknar motorn fel,
 * eller så har appen fått ett nytt absolut tidsberoende.
 *   ID       samma indata två gånger → byte-identiskt utom heapUsedMB (H5)
 *   SHIFT30  rader och state flyttas 7 d + 30 s; halvminutsfasen mot
 *            UI-klockans absoluta rutnät bevaras, så allt ska vara lika
 *            efter t − Δ
 *   MMSI     ordningsomvänd bijektion m → 999 999 999 − m i rader och state
 *
 * M-FAS (bankspåret): hela korpusen och dess state flyttas δ ur profilens
 * mängd (typbevarande). Kraven: notis-, öppnings- och passagenycklar lika,
 * inga nya fatala invariantinstanser eller leveransfel, parade notiser driver
 * högst 30 s. En tappad och en tillagd post paras till ett byte (riktning,
 * typ) bara inom PAIR_WINDOW_MS, och då närmaste i tid; driften räknas
 * sedan de tappade och tillagda posterna tagits bort (M06, M07).
 * Varje avvikelse taggas KNIVSEGG men undantas aldrig
 * (CLAUDE.md: startberoende utfall ska undersökas). Basresultaten tas ur
 * självtestets cache, så ingen extra baskörning behövs.
 */

const path = require('path');
const bankOps = require('./bankOps');
const project = require('./project');
const health = require('./oracles/health');
const existing = require('./oracles/existing');
const signature = require('./signature');
const { makeFinding } = require('./finding');
const { cmpStr } = require('./util');
const invariants = require('../../invariants');
const delivery = require('../../openingDelivery');

const SHIFT30_MS = (7 * 86400 * 1000) + 30000;
const DRIFT_LIMIT_MS = 30000;
const PAIR_WINDOW_MS = 120000;
const MFAS_SEVERITY = 4;
const TIMELINE_WINDOW_MS = 10 * 60000;
const TIMELINE_MAX = 60;
/** Högst så många syskon (variantens utslag av samma klass och broar) per nytt fatalt utslag. */
const SYSKON_MAX = 40;
const RIKTNING = { northbound: 'norrut', southbound: 'söderut', unknown: 'okänd' };

const clock = (t) => (Number.isFinite(t) ? new Date(Math.round(t)).toISOString().slice(11, 19) : '--:--:--');
const fmtDelta = (d) => `${d > 0 ? '+' : ''}${String(d).replace('-', '−').replace('.', ',')}`;

// ---------------------------------------------------------------------------
// M-EXAKT
// ---------------------------------------------------------------------------

/**
 * Kör SHIFT30 och MMSI på korpusarna i körningen och jämför med basen.
 * @param {object} körning - körningsobjektet (bas, pool, temp, korpusar, plantera)
 * @returns {Promise<object>} {SHIFT30: {n, ok, brott}, MMSI: {n, ok, brott}}
 */
async function runExact(körning) {
  const dir = path.join(körning.temp, 'bank');
  const plan = [];
  const plant = new Set(körning.plantera || []);
  for (const c of körning.korpusar) {
    const base = körning.bas.get(c.id);
    const { kc } = base;
    let st30 = null;
    if (kc.state) st30 = plant.has('skip-state-shift') ? kc.state : bankOps.shiftEpochDeep(kc.state, SHIFT30_MS);
    plan.push({
      id: c.id,
      relation: 'SHIFT30',
      fil: bankOps.writeVariant({
        dir, korpusId: c.id, tagg: 'shift30', rader: bankOps.shiftRows(kc.rader, SHIFT30_MS), state: st30,
      }),
      inv: { dt: SHIFT30_MS, helaResultatet: true },
      kc,
    });
    const map = bankOps.mmsiBijection(kc.rader, kc.state);
    const back = bankOps.invertMap(map);
    let stM = null;
    if (kc.state) stM = plant.has('skip-state-relabel') ? kc.state : bankOps.relabelDeep(kc.state, map);
    plan.push({
      id: c.id,
      relation: 'MMSI',
      fil: bankOps.writeVariant({
        dir, korpusId: c.id, tagg: 'mmsi', rader: bankOps.relabelRows(kc.rader, map), state: stM,
      }),
      inv: { mm: (x) => back.get(String(x)) || String(x) },
      kc,
    });
  }
  const res = await körning.pool.runAll(plan.map((p) => ({
    jsonl: p.fil.jsonl, etikett: `${p.id} ${p.relation}`, rader: p.fil.rader, simTimmar: p.kc.simTimmar,
  })));
  const out = {
    SHIFT30: { n: 0, ok: 0, brott: [] },
    MMSI: { n: 0, ok: 0, brott: [] },
  };
  plan.forEach((p, i) => {
    const u = res[i];
    const base = körning.bas.get(p.id);
    const slot = out[p.relation];
    slot.n++;
    if (!u.ok) {
      slot.brott.push({ korpus: p.id, skillnad: { körfel: u.fel } });
      return;
    }
    const cmp = project.compareExact(base.resultat, u.resultat, {
      ...p.inv, fatalBas: base.fatala, fatalVariant: invariants.validateInvariants(u.resultat),
    });
    if (cmp.lika) slot.ok++;
    else slot.brott.push({ korpus: p.id, skillnad: cmp.skillnader });
  });
  return out;
}

// ---------------------------------------------------------------------------
// M-FAS: jämförelsen
// ---------------------------------------------------------------------------

function cardsOf(result) {
  return ((result && result.openingWarnings) || []).filter((w) => w.success !== false);
}

function cardBrief(w, dt = 0) {
  return {
    bridge: w.bridge, direction: w.direction, leadMmsi: w.leadMmsi, etaMin: w.etaMin, firedBy: w.firedBy, mmsis: w.mmsis || [], t: w.t - dt, eventId: w.eventId,
  };
}

// Valet av tappade och tillagda poster i en nyckel (de n som ligger längst
// från andra sidan i tid) delas med notificationDrift i project.js (M07).
const { pickExtras } = project;

/**
 * Parar tappade och tillagda poster till byten (NOTISRIKTNING BYTT,
 * PASSAGETYP BYTT): bara par som `passar` och ligger högst PAIR_WINDOW_MS
 * isär, och då närmaste i tid. Paren väljs girigt på stigande |Δt| (lika
 * avstånd ordnas på tappad tid, tillagd tid och index), så resultatet är
 * deterministiskt. Rättat 2026-11-04 (M06): förut parades första tillagda
 * post med samma mmsi och bro utan tidsvillkor, så en notis som tappades och
 * en orelaterad notis sex timmar senare blev ett enda riktningsbyte.
 * @param {object[]} removed - tappade poster (basens tidsram)
 * @param {object[]} added - tillagda poster (basens tidsram)
 * @param {Function} passar - (tappad, tillagd) → boolean
 * @returns {Map<number, number>} tappat index → tillagt index
 */
function pairNearest(removed, added, passar) {
  const kandidater = [];
  removed.forEach((r, i) => added.forEach((a, j) => {
    const d = Math.abs(a.t - r.t);
    if (d <= PAIR_WINDOW_MS && passar(r, a)) kandidater.push({ i, j, d });
  }));
  kandidater.sort((x, y) => (x.d - y.d) || (removed[x.i].t - removed[y.i].t) || (added[x.j].t - added[y.j].t) || (x.i - y.i) || (x.j - y.j));
  const par = new Map();
  const tagna = new Set();
  for (const k of kandidater) {
    if (par.has(k.i) || tagna.has(k.j)) continue;
    par.set(k.i, k.j);
    tagna.add(k.j);
  }
  return par;
}

/** Öppningsavvikelser per bro: parade byten, tillagda och tappade kort (basens tidsram). */
function openingDiffs(B, V, dt) {
  const d = project.diffMultiset(project.openKeys(B), project.openKeys(V));
  if (d.lika) return [];
  const out = [];
  const bridges = [...new Set([...d.baraBas, ...d.baraVariant].map((k) => k.split(':')[0]))].sort();
  for (const bridge of bridges) {
    const removedKeys = d.baraBas.filter((k) => k.startsWith(`${bridge}:`));
    const addedKeys = d.baraVariant.filter((k) => k.startsWith(`${bridge}:`));
    const removed = [];
    const added = [];
    for (const key of [...new Set(removedKeys)]) {
      const dir = key.split(':')[1];
      const n = removedKeys.filter((k) => k === key).length;
      const bc = cardsOf(B).filter((w) => w.bridge === bridge && w.direction === dir).map((w) => cardBrief(w));
      const vc = cardsOf(V).filter((w) => w.bridge === bridge && w.direction === dir).map((w) => cardBrief(w, dt));
      removed.push(...pickExtras(bc, vc, n));
    }
    for (const key of [...new Set(addedKeys)]) {
      const dir = key.split(':')[1];
      const n = addedKeys.filter((k) => k === key).length;
      const bc = cardsOf(B).filter((w) => w.bridge === bridge && w.direction === dir).map((w) => cardBrief(w));
      const vc = cardsOf(V).filter((w) => w.bridge === bridge && w.direction === dir).map((w) => cardBrief(w, dt));
      added.push(...pickExtras(vc, bc, n));
    }
    // Para byten: ett tappat och ett tillagt kort vid samma bro inom ±120 s.
    const usedA = new Set();
    for (const r of removed) {
      const j = added.findIndex((a, idx) => !usedA.has(idx) && Math.abs(a.t - r.t) <= PAIR_WINDOW_MS);
      if (j >= 0) {
        usedA.add(j);
        out.push({
          klass: 'ÖPPNINGSRIKTNING BYTT', kort: added[j], par: { bas: r, variant: added[j] }, t: r.t,
        });
      } else {
        out.push({ klass: 'ÖPPNINGSNYCKEL TAPPAD', kort: r, t: r.t });
      }
    }
    added.forEach((a, idx) => {
      if (!usedA.has(idx)) out.push({ klass: 'ÖPPNINGSNYCKEL TILLAGD', kort: a, t: a.t });
    });
  }
  return out;
}

function notificationDiffs(B, V, dt) {
  const d = project.diffMultiset(project.notifKeys(B), project.notifKeys(V));
  if (d.lika) return [];
  const out = [];
  const brief = (n, shift) => ({
    mmsi: String(n.mmsi), bridge: n.bridge, direction: n.direction, eta: n.eta, alreadyPassed: n.alreadyPassed, source: n.source, t: n.t - shift, message: n.message,
  });
  const pickNotes = (res, key, shift) => project.delivered(res).filter((n) => `${n.mmsi}:${n.bridge}:${n.direction}` === key).map((n) => brief(n, shift));
  const removed = [];
  const added = [];
  for (const key of [...new Set(d.baraBas)]) removed.push(...pickExtras(pickNotes(B, key, 0), pickNotes(V, key, dt), d.baraBas.filter((k) => k === key).length));
  for (const key of [...new Set(d.baraVariant)]) added.push(...pickExtras(pickNotes(V, key, dt), pickNotes(B, key, 0), d.baraVariant.filter((k) => k === key).length));
  const par = pairNearest(removed, added, (r, a) => a.mmsi === r.mmsi && a.bridge === r.bridge && a.direction !== r.direction);
  const used = new Set(par.values());
  removed.forEach((r, i) => {
    if (par.has(i)) {
      const a = added[par.get(i)];
      out.push({
        klass: 'NOTISRIKTNING BYTT', notis: a, par: { bas: r, variant: a }, t: r.t, nyRiktning: a.direction,
      });
    } else {
      out.push({ klass: 'NOTISNYCKEL TAPPAD', notis: r, t: r.t });
    }
  });
  added.forEach((a, idx) => {
    if (!used.has(idx)) out.push({ klass: 'NOTISNYCKEL TILLAGD', notis: a, t: a.t });
  });
  return out;
}

function passageDiffs(B, V, dt) {
  const d = project.diffMultiset(project.passKeys(B), project.passKeys(V));
  if (d.lika) return [];
  const list = (res, shift) => [
    ...((res && res.targetPassages) || []).map((p) => ({
      typ: 'T', mmsi: String(p.mmsi), bridge: p.bridge, t: p.t - shift,
    })),
    ...((res && res.intermediatePassages) || []).map((p) => ({
      typ: 'I', mmsi: String(p.mmsi), bridge: p.bridge, t: p.t - shift,
    })),
  ];
  const key = (p) => `${p.typ}:${p.mmsi}:${p.bridge}`;
  const removed = [];
  const added = [];
  for (const k of [...new Set(d.baraBas)]) removed.push(...pickExtras(list(B, 0).filter((p) => key(p) === k), list(V, dt).filter((p) => key(p) === k), d.baraBas.filter((x) => x === k).length));
  for (const k of [...new Set(d.baraVariant)]) added.push(...pickExtras(list(V, dt).filter((p) => key(p) === k), list(B, 0).filter((p) => key(p) === k), d.baraVariant.filter((x) => x === k).length));
  const out = [];
  const par = pairNearest(removed, added, (r, a) => a.mmsi === r.mmsi && a.bridge === r.bridge && a.typ !== r.typ);
  const used = new Set(par.values());
  removed.forEach((r, i) => {
    if (par.has(i)) {
      const a = added[par.get(i)];
      out.push({
        klass: 'PASSAGETYP BYTT', passage: a, par: { bas: r, variant: a }, t: r.t,
      });
    } else out.push({ klass: 'PASSAGENYCKEL TAPPAD', passage: r, t: r.t });
  });
  added.forEach((a, idx) => {
    if (!used.has(idx)) out.push({ klass: 'PASSAGENYCKEL TILLAGD', passage: a, t: a.t });
  });
  return out;
}

/**
 * Tidslinjeutdrag ±10 min kring t (basens tidsram) ur bas och variant.
 * Händelser med samma text i bas och variant inom ±30 s (halvminutsrutnätet)
 * räknas som parade; de oparade är skillnaderna och markeras med ≠.
 * @returns {{alla: string[], skillnader: string[]}} rader
 */
function timeline(B, V, dt, t) {
  if (!Number.isFinite(t)) return { alla: [], skillnader: [] };
  const lo = t - TIMELINE_WINDOW_MS;
  const hi = t + TIMELINE_WINDOW_MS;
  const ev = [];
  const add = (src, res, shift) => {
    const dir = (d) => RIKTNING[d] || d;
    for (const n of project.delivered(res)) {
      ev.push({ t: n.t - shift, src, text: `notis ${n.bridge} ${dir(n.direction)} ${n.mmsi} eta ${n.eta}${n.alreadyPassed ? ' (passerad form)' : ''} [${n.source}]` });
    }
    for (const w of cardsOf(res)) {
      ev.push({ t: w.t - shift, src, text: `öppningsvarning ${w.bridge} ${dir(w.direction)} ledare ${w.leadMmsi} eta ${w.etaMin} (${w.firedBy}) [${(w.mmsis || []).join(',')}]` });
    }
    for (const p of (res && res.targetPassages) || []) ev.push({ t: p.t - shift, src, text: `målbropassage ${p.bridge} ${p.mmsi}` });
    for (const p of (res && res.intermediatePassages) || []) ev.push({ t: p.t - shift, src, text: `mellanbropassage ${p.bridge} ${p.mmsi}` });
    for (const x of (res && res.bridgeTextTransitions) || []) ev.push({ t: x.t - shift, src, text: `text "${x.text}"` });
  };
  add('bas', B, 0);
  add('variant', V, dt);
  const win = ev.filter((e) => e.t >= lo && e.t <= hi)
    .sort((a, b) => (a.t - b.t) || cmpStr(a.src, b.src) || cmpStr(a.text, b.text));
  const used = new Set();
  for (const e of win) {
    if (e.src !== 'bas') continue;
    const j = win.findIndex((x, i) => !used.has(i) && x.src === 'variant' && x.text === e.text && Math.abs(x.t - e.t) <= DRIFT_LIMIT_MS);
    if (j >= 0) {
      used.add(j);
      e.parad = true;
      win[j].parad = true;
    }
  }
  const line = (e) => `${e.parad ? ' ' : '≠'} ${clock(e.t)}  ${e.src.padEnd(7)}  ${e.text}`;
  return {
    alla: win.slice(0, TIMELINE_MAX * 3).map(line),
    skillnader: win.filter((e) => !e.parad).slice(0, TIMELINE_MAX).map(line),
  };
}

const typText = (typ) => (typ === 'T' ? 'målbro' : 'mellanbro');

function passageText(d) {
  if (d.klass === 'PASSAGETYP BYTT') return `passagen bokförs som ${typText(d.par.bas.typ)} i basen men ${typText(d.par.variant.typ)} i varianten`;
  if (d.klass === 'PASSAGENYCKEL TILLAGD') return 'varianten har en passage som basen saknar';
  return 'basens passage saknas i varianten';
}

function openingText(d, w) {
  if (d.klass === 'ÖPPNINGSRIKTNING BYTT') {
    return `kortet ${w.bridge} ${clock(d.t)} har ${d.par.bas.direction} (ledare ${d.par.bas.leadMmsi}) i basen `
      + `men ${d.par.variant.direction} (ledare ${d.par.variant.leadMmsi}) i varianten`;
  }
  const what = d.klass === 'ÖPPNINGSNYCKEL TILLAGD' ? 'varianten har en öppningsvarning som basen saknar' : 'basens öppningsvarning saknas i varianten';
  return `${what}: ${w.bridge} ${w.direction} ${clock(d.t)} ledare ${w.leadMmsi} eta ${w.etaMin} (${w.firedBy})`;
}

/**
 * Jämför en fasvariant med sin bas och returnerar råa fynd (ej klassade).
 * @param {object} base - bascachens post {korpus, kc, resultat, fatala, leverans}
 * @param {object} utfall - variantens poolutfall
 * @param {object} meta - {deltaS, monitoring, fil, h3Baslinje}
 * @returns {object[]} fynd med icke-uppräkningsbar `kontext`
 */
function comparePhase(base, utfall, meta) {
  const dt = Math.round(meta.deltaS * 1000);
  const B = base.resultat;
  const { kc } = base;
  const ursprung = {
    korpus: kc.id, relation: 'M-FAS', deltaS: [meta.deltaS], monitoring: !!meta.monitoring, rader: kc.rader.length, timmar: kc.simTimmar,
  };
  const repro = (t, extra = {}) => ({
    filer: [
      { från: kc.jsonl, till: 'bas.jsonl' },
      ...(kc.statePath ? [{ från: kc.statePath, till: 'bas.state.json' }] : []),
      { från: meta.fil.jsonl, till: 'variant.jsonl' },
      ...(meta.fil.statePath ? [{ från: meta.fil.statePath, till: 'variant.state.json' }] : []),
    ],
    kommandon: [
      `${meta.monitoring ? 'REPLAY_MONITORING=1 ' : ''}node tests/replay-validation/replayRunner.js <fynd>/variant.jsonl`,
      `${meta.monitoring ? 'REPLAY_MONITORING=1 ' : ''}node tests/replay-validation/replayRunner.js <fynd>/bas.jsonl`,
      'npm run hunt:repro -- <fynd>',
    ],
    recept: {
      korpus: kc.id,
      relation: 'M-FAS',
      deltaS: meta.deltaS,
      monitoring: !!meta.monitoring,
      operation: 'hela korpusen och dess state flyttas δ s (aisTimestamp, fixTs, receivedAt typbevarande; alla epok-ms i state)',
    },
    underlag: `bas och variant, ${kc.rader.length} rader, ${String(Math.round(kc.simTimmar * 10) / 10).replace('.', ',')} h (bankfynd krymps inte i v1).`,
    tidslinjeRubrik: `Skillnader bas ↔ variant (±10 min, basens tid; variant = δ ${fmtDelta(meta.deltaS)} s; ≠ = oparad):`,
    ...(() => {
      const tl = utfall.resultat ? timeline(B, utfall.resultat, dt, t) : { alla: [], skillnader: [] };
      return { tidslinje: tl.skillnader, tidslinjeFull: tl.alla };
    })(),
    bekräftelse: 'ej krympt (bankfynd krymps inte i v1); KNIVSEGG — utfallet beror på klockfasen.',
    ...extra,
  });
  const fynd = [];
  const push = (f, kontext) => {
    const x = makeFinding({
      ...f, spår: 'bank', nivå: 'bank', ursprung, taggar: ['KNIVSEGG'], repro: repro(f.t),
    });
    Object.defineProperty(x, 'kontext', { value: kontext, enumerable: false });
    fynd.push(x);
  };
  const ctxBase = { korpus: base.korpus, rader: kc.rader, bas: B };
  for (const f of health.h2(utfall)) push(f, ctxBase);
  if (utfall.häng) return fynd;
  if (!utfall.ok) {
    if (utfall.fatal) for (const f of health.h1(utfall)) push(f, ctxBase);
    else {
      push({
        orakel: 'H1', klass: 'PROCESSFEL inget resultat', allvar: health.H1_SEVERITY, detalj: utfall.fel || 'inget resultat', belägg: { fel: utfall.fel },
      }, ctxBase);
    }
    return fynd;
  }
  const V = utfall.resultat;
  // Kontexten i BASENS tidsram: variantens alla epok-ms flyttas tillbaka δ.
  const Vb = bankOps.shiftEpochDeep(V, -dt);
  const ctx = {
    ...ctxBase, resultat: Vb, gt: base.gt, radio: null, profil: null,
  };
  for (const f of health.h1(utfall, { bas: B })) push(f, ctx);
  for (const f of health.h3(utfall.stderr.h3, meta.h3Baslinje, { simTimmar: kc.simTimmar, exempel: utfall.stderr.exempel })) push(f, ctx);
  for (const d of notificationDiffs(B, V, dt)) {
    const n = d.notis;
    push({
      orakel: 'M-FAS',
      klass: d.klass,
      allvar: MFAS_SEVERITY,
      mmsi: n.mmsi,
      bro: n.bridge,
      riktning: n.direction,
      t: d.t,
      detalj: d.klass === 'NOTISRIKTNING BYTT'
        ? `notisen ${n.mmsi}@${n.bridge} ${clock(d.t)} har riktningen ${d.par.bas.direction} i basen men ${d.par.variant.direction} i varianten`
        : `${d.klass === 'NOTISNYCKEL TILLAGD' ? 'varianten har en notis som basen saknar' : 'basens notis saknas i varianten'}: ${n.mmsi}@${n.bridge} ${n.direction} ${clock(d.t)} [${n.source}]`,
      belägg: { notis: n, par: d.par || null, nyRiktning: d.nyRiktning },
    }, ctx);
  }
  for (const d of openingDiffs(B, V, dt)) {
    const w = d.kort;
    push({
      orakel: 'M-FAS',
      klass: d.klass,
      allvar: MFAS_SEVERITY,
      mmsi: w.leadMmsi,
      bro: w.bridge,
      riktning: w.direction,
      t: d.t,
      detalj: openingText(d, w),
      belägg: { kort: w, par: d.par || null, nyRiktning: d.par ? d.par.variant.direction : undefined },
    }, ctx);
  }
  for (const d of passageDiffs(B, V, dt)) {
    const p = d.passage;
    push({
      orakel: 'M-FAS',
      klass: d.klass,
      allvar: MFAS_SEVERITY,
      mmsi: p.mmsi,
      bro: p.bridge,
      t: d.t,
      detalj: `${passageText(d)}: ${p.mmsi}@${p.bridge} ${clock(d.t)}`,
      belägg: { passage: p, par: d.par || null },
    }, ctx);
  }
  const drift = project.notificationDrift(B, V, { dt });
  for (const k of drift.perNyckel.filter((x) => x.driftMs > DRIFT_LIMIT_MS)) {
    const [mmsi, bro, riktning] = k.nyckel.split(':');
    push({
      orakel: 'M-FAS',
      klass: 'NOTISDRIFT>30s',
      allvar: MFAS_SEVERITY,
      mmsi,
      bro,
      riktning,
      t: k.t,
      detalj: `notisen ${k.nyckel} driver ${Math.round(k.driftMs / 1000)} s mellan bas och variant (gräns 30 s)`,
      belägg: { driftMs: k.driftMs },
    }, ctx);
  }
  const fatalV = invariants.validateInvariants(V);
  const fd = project.diffMultiset(project.fatalInstances(base.fatala), project.fatalInstances(fatalV));
  const usedMsg = new Set();
  for (const inst of fd.baraVariant) {
    const msg = fatalV.find((m, i) => !usedMsg.has(i) && signature.instanceKey(m) === inst);
    usedMsg.add(fatalV.indexOf(msg));
    // Beläggen (t.ex. INV-10:s väntintervall) i variantens tidsram, som meddelandet.
    const f = existing.fromInvariant(msg, 'INV-F', { resultat: V });
    const lost = base.fatala.filter((m) => signature.classOf(m) === signature.classOf(msg));
    // Syskonen: variantens ALLA fatala utslag av samma klass vid samma broar,
    // även de som också finns i basen, närmast i tid först. KIE-PER-KORPUS
    // låter ett undantag förklara högst variantens närmaste utslag (en till
    // en per variant; efterrättning D).
    const tMsg = signature.timeOf(msg);
    const broar = signature.bridgesOf(msg).join(',');
    const avstånd = (m) => {
      const t = signature.timeOf(m);
      return Number.isFinite(t) && Number.isFinite(tMsg) ? Math.abs(t - tMsg) : Infinity;
    };
    const syskon = fatalV
      .filter((m) => signature.classOf(m) === signature.classOf(msg) && signature.bridgesOf(m).join(',') === broar)
      .map((m) => ({ m, d: avstånd(m) }))
      .sort((a, b) => (a.d - b.d) || cmpStr(a.m, b.m))
      .slice(0, SYSKON_MAX)
      .map((x) => x.m);
    push({
      ...f,
      t: Number.isFinite(f.t) ? f.t - dt : null,
      detalj: msg,
      belägg: {
        ...f.belägg, meddelanden: [msg], basMeddelanden: lost, syskon, ny: true, tidsram: 'variant',
      },
    }, ctx);
  }
  const levV = delivery.openingDeliveryFailures(V);
  const ld = project.diffMultiset(base.leverans.map(signature.normalize), levV.map(signature.normalize));
  for (const norm of ld.baraVariant) {
    const msg = levV.find((m) => signature.normalize(m) === norm);
    push({ ...existing.fromDelivery(msg) }, ctx);
  }
  return fynd;
}

/**
 * Slår ihop klassade M-FAS-fynd som bara skiljer i δ (samma korpus,
 * mekanism, bro, riktning, mmsi och registerutfall).
 * @param {object[]} findings - klassade fynd
 * @param {number[]} deltaOrder - profilens δ-ordning
 * @returns {object[]} hopslagna fynd
 */
function mergePhaseFindings(findings, deltaOrder = []) {
  const rank = (d) => {
    const i = deltaOrder.indexOf(d);
    return i < 0 ? 999 : i;
  };
  const out = [];
  const index = new Map();
  const sorted = [...findings].sort((a, b) => rank(a.ursprung.deltaS[0]) - rank(b.ursprung.deltaS[0]));
  for (const f of sorted) {
    if (f.ursprung.relation !== 'M-FAS') {
      out.push(f);
      continue;
    }
    const reg = f.register || {};
    const k = [f.ursprung.korpus, f.ursprung.monitoring, f.orakel, signature.normalize(f.klass), f.bro, f.riktning, f.mmsi, reg.klass, reg.post].join('\u0001');
    if (!index.has(k)) {
      const copy = {
        ...f,
        ursprung: { ...f.ursprung, deltaS: [...f.ursprung.deltaS] },
        belägg: { ...f.belägg, perDelta: [{ deltaS: f.ursprung.deltaS[0], detalj: f.detalj, t: f.t }] },
      };
      if (f.kontext) Object.defineProperty(copy, 'kontext', { value: f.kontext, enumerable: false });
      index.set(k, copy);
      out.push(copy);
      continue;
    }
    const m = index.get(k);
    for (const d of f.ursprung.deltaS) if (!m.ursprung.deltaS.includes(d)) m.ursprung.deltaS.push(d);
    m.ursprung.deltaS.sort((a, b) => rank(a) - rank(b));
    m.belägg.perDelta.push({ deltaS: f.ursprung.deltaS[0], detalj: f.detalj, t: f.t });
    if (Array.isArray(f.belägg.meddelanden)) m.belägg.meddelanden = [...new Set([...(m.belägg.meddelanden || []), ...f.belägg.meddelanden])];
  }
  return out;
}

// ---------------------------------------------------------------------------
// M-FAS: körningen
// ---------------------------------------------------------------------------

/**
 * Kör M-FAS över korpusarna och profilens δ (och monitoringarmar).
 * @param {object} körning - körningsobjektet (bas måste vara fylld)
 * @param {{ensureBase: Function}} deps - bygger basen för en monitoringarm
 * @returns {Promise<{fynd: object[], varianter: object[]}>} råa fynd och variantsammanfattning
 */
async function runPhase(körning, { ensureBase }) {
  const dir = path.join(körning.temp, 'bank');
  const fynd = [];
  const varianter = [];
  for (const monitoring of körning.profil.fasMonitoring) {
    if (körning.tidenUte && körning.tidenUte()) {
      körning.avkortad = true;
      break;
    }
    const baseMap = monitoring ? await ensureBase(körning, { monitoring: true }) : körning.bas;
    const plan = [];
    for (const c of körning.korpusar) {
      const base = baseMap.get(c.id);
      for (const deltaS of körning.profil.fasDeltaS) {
        const dtMs = Math.round(deltaS * 1000);
        const fil = bankOps.writeVariant({
          dir,
          korpusId: c.id,
          tagg: `${bankOps.phaseTag(deltaS)}${monitoring ? '.mon' : ''}`,
          rader: bankOps.shiftRows(base.kc.rader, dtMs),
          state: base.kc.state ? bankOps.shiftEpochDeep(base.kc.state, dtMs) : null,
        });
        plan.push({
          id: c.id, deltaS, fil, base,
        });
      }
    }
    const res = await körning.pool.runAll(plan.map((p) => ({
      jsonl: p.fil.jsonl, etikett: `${p.id} ${bankOps.phaseTag(p.deltaS)}`, monitoring, rader: p.fil.rader, simTimmar: p.base.kc.simTimmar,
    })), { stopp: körning.tidenUte || null });
    // Nödbromsen: bara det sammanhängande prefixet av dömda varianter räknas.
    let prefix = res.findIndex((r) => r === undefined);
    if (prefix < 0) prefix = res.length;
    else körning.avkortad = true;
    plan.slice(0, prefix).forEach((p, i) => {
      const f = comparePhase(p.base, res[i], {
        deltaS: p.deltaS, monitoring, fil: p.fil, h3Baslinje: körning.hälsa.h3Baslinje,
      });
      fynd.push(...f);
      const kort = f.filter((x) => !x.räknare);
      varianter.push({
        korpus: p.id, deltaS: p.deltaS, monitoring, ren: kort.length === 0, utslag: kort.map((x) => `${x.orakel}|${x.klass}`), ms: res[i].ms,
      });
    });
  }
  return { fynd, varianter };
}

module.exports = {
  SHIFT30_MS,
  DRIFT_LIMIT_MS,
  PAIR_WINDOW_MS,
  runExact,
  openingDiffs,
  notificationDiffs,
  passageDiffs,
  pairNearest,
  timeline,
  comparePhase,
  mergePhaseFindings,
  runPhase,
};
