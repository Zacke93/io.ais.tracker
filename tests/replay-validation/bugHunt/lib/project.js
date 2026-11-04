'use strict';

/**
 * Projektioner av replayresultat (BUGGJAKT §5): vad relationerna jämför.
 *
 * Varje projektion tar en invers mappning så att en variant kan jämföras med
 * sin bas: `dt` dras från variantens tider (tidsförskjutning) och `mm` mappar
 * variantens mmsi tillbaka (MMSI-relationen). Basen projiceras med
 * identiteten.
 *
 *   notiser    (t − Δ, mmsi, bro, riktning, eta, alreadyPassed, meddelande)
 *   öppningar  (t − Δ, bro, riktning, ledare, etaMin, firedBy, sorterade mmsis)
 *   passager   (T|I, mmsi, bro, t − Δ)
 *   text       hela textströmmen (t − Δ, text) i ordning
 *
 * Nyckelprojektionerna (utan tid) är vad M-FAS kräver lika:
 *   notisnyckel mmsi:bro:riktning, öppningsnyckel bro:riktning,
 *   passagenyckel T|I:mmsi:bro.
 */

const signature = require('./signature');
const health = require('./oracles/health');
const bankOps = require('./bankOps');
const { fromEntries } = require('./util');

const ID = (x) => String(x);

function delivered(result) {
  return ((result && result.notifications) || []).filter((n) => n.success !== false);
}

function notifFull(result, { mm = ID, dt = 0 } = {}) {
  return ((result && result.notifications) || []).map((n) => [
    mm(n.mmsi), n.bridge, n.direction, `eta${n.eta}`, `p${n.alreadyPassed}`, `s${n.success}`, n.message || '', `t${n.t - dt}`,
  ].join('|')).sort();
}

function openFull(result, { mm = ID, dt = 0 } = {}) {
  return ((result && result.openingWarnings) || []).map((w) => [
    w.bridge, w.direction, mm(w.leadMmsi), `eta${w.etaMin}`, w.firedBy, (w.mmsis || []).map(mm).sort().join(','), `s${w.success}`, `t${w.t - dt}`,
  ].join('|')).sort();
}

function passFull(result, { mm = ID, dt = 0 } = {}) {
  return [
    ...((result && result.targetPassages) || []).map((p) => `T|${mm(p.mmsi)}|${p.bridge}|t${p.t - dt}`),
    ...((result && result.intermediatePassages) || []).map((p) => `I|${mm(p.mmsi)}|${p.bridge}|t${p.t - dt}`),
  ].sort();
}

function textStream(result, { dt = 0 } = {}) {
  return ((result && result.bridgeTextTransitions) || []).map((x) => `${x.t - dt}|${x.text}`);
}

/** Läckagediagnostiken utan heapUsedMB. */
function leakCounts(result) {
  const out = { ...((result && result.leakDiagnostics) || {}) };
  delete out.heapUsedMB;
  return out;
}

/** Fatala invariantutslag som instansnycklar (ISO → T, mmsi → M, tal kvar). */
function fatalInstances(messages, { mmText = (s) => s } = {}) {
  return messages.map((m) => signature.instanceKey(mmText(m))).sort();
}

function notifKeys(result, { mm = ID } = {}) {
  return delivered(result).map((n) => `${mm(n.mmsi)}:${n.bridge}:${n.direction}`).sort();
}

function openKeys(result) {
  return ((result && result.openingWarnings) || []).filter((w) => w.success !== false).map((w) => `${w.bridge}:${w.direction}`).sort();
}

function passKeys(result, { mm = ID } = {}) {
  return [
    ...((result && result.targetPassages) || []).map((p) => `T:${mm(p.mmsi)}:${p.bridge}`),
    ...((result && result.intermediatePassages) || []).map((p) => `I:${mm(p.mmsi)}:${p.bridge}`),
  ].sort();
}

/**
 * Multisetdifferens.
 * @param {string[]} a - basens element
 * @param {string[]} b - variantens element
 * @returns {{baraBas: string[], baraVariant: string[], lika: boolean}} differens
 */
function diffMultiset(a, b) {
  const ca = new Map();
  for (const x of a) ca.set(x, (ca.get(x) || 0) + 1);
  const cb = new Map();
  for (const x of b) cb.set(x, (cb.get(x) || 0) + 1);
  const baraBas = [];
  const baraVariant = [];
  for (const [k, v] of ca) for (let i = 0; i < v - (cb.get(k) || 0); i++) baraBas.push(k);
  for (const [k, v] of cb) for (let i = 0; i < v - (ca.get(k) || 0); i++) baraVariant.push(k);
  baraBas.sort();
  baraVariant.sort();
  return { baraBas, baraVariant, lika: baraBas.length === 0 && baraVariant.length === 0 };
}

/** Första skillnaden mellan två ordnade listor (för textströmmen). */
function firstSequenceDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return { index: i, bas: a[i] === undefined ? null : a[i], variant: b[i] === undefined ? null : b[i] };
  }
  return null;
}

/**
 * Väljer de n element i `extra` som ligger längst från närmaste element i
 * `other` (i tid); lika avstånd ordnas på tid. Det är M-FAS:s val av vilka
 * poster i en nyckel som är tappade eller tillagda (relations.js), och
 * driften räknas på resten (notificationDrift).
 * @param {object[]} extra - poster med t (den sida som har fler)
 * @param {object[]} other - samma nyckels poster på andra sidan
 * @param {number} n - antalet extra poster
 * @returns {object[]} de extra posterna i tidsordning
 */
function pickExtras(extra, other, n) {
  return extra
    .map((x) => ({ x, d: other.length ? Math.min(...other.map((o) => Math.abs(o.t - x.t))) : Infinity }))
    .sort((a, b) => (b.d - a.d) || (a.x.t - b.x.t))
    .slice(0, n)
    .map((e) => e.x)
    .sort((a, b) => a.t - b.t);
}

/**
 * Parar notiser med samma nyckel (mmsi:bro:riktning) i tidsordning och mäter
 * driften |t_variant − Δ − t_bas|. Har ena sidan fler notiser i nyckeln tas
 * först de extra bort, med samma val som M-FAS gör för TAPPAD och TILLAGD
 * (pickExtras). Rättat 2026-11-04 (M07): förut parades notiserna per index,
 * så en extra notis förskjöt alla senare par och gav ett falskt
 * NOTISDRIFT>30s för en notis som fanns oförändrad i båda.
 * @returns {{maxDriftMs: number, perNyckel: object[]}} drift
 */
function notificationDrift(base, variant, { dt = 0, mm = ID } = {}) {
  const group = (res, map, shift) => {
    const m = new Map();
    for (const n of delivered(res)) {
      const k = `${map(n.mmsi)}:${n.bridge}:${n.direction}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(n.t - shift);
    }
    for (const l of m.values()) l.sort((x, y) => x - y);
    return m;
  };
  const gb = group(base, ID, 0);
  const gv = group(variant, mm, dt);
  // De extra posterna tas bort per identitet (två notiser kan ha samma tid).
  const utanExtra = (ts, us) => {
    if (ts.length === us.length) return [ts, us];
    const wb = ts.map((t) => ({ t }));
    const wv = us.map((t) => ({ t }));
    if (wb.length > wv.length) {
      const ex = new Set(pickExtras(wb, wv, wb.length - wv.length));
      return [wb.filter((x) => !ex.has(x)).map((x) => x.t), us];
    }
    const ex = new Set(pickExtras(wv, wb, wv.length - wb.length));
    return [ts, wv.filter((x) => !ex.has(x)).map((x) => x.t)];
  };
  let maxDriftMs = 0;
  const perNyckel = [];
  for (const [k, alla] of gb) {
    const [ts, us] = utanExtra(alla, gv.get(k) || []);
    let worst = 0;
    let at = null;
    for (let i = 0; i < Math.min(ts.length, us.length); i++) {
      const d = Math.abs(us[i] - ts[i]);
      if (d > worst) {
        worst = d;
        at = ts[i];
      }
    }
    if (worst > 0) perNyckel.push({ nyckel: k, driftMs: worst, t: at });
    maxDriftMs = Math.max(maxDriftMs, worst);
  }
  perNyckel.sort((x, y) => (y.driftMs - x.driftMs) || (x.nyckel < y.nyckel ? -1 : 1));
  return { maxDriftMs, perNyckel };
}

/**
 * Exakt jämförelse efter invers mappning (M-EXAKT).
 * @param {object} base - basens resultat
 * @param {object} variant - variantens resultat
 * @param {{dt?: number, mm?: Function, mmText?: Function, fatalBas?: string[], fatalVariant?: string[]}} inv - inversen
 * @returns {{lika: boolean, skillnader: object}} utfall
 */
function compareExact(base, variant, {
  dt = 0, mm = ID, mmText = (s) => s, fatalBas = null, fatalVariant = null, helaResultatet = false,
} = {}) {
  const skillnader = {};
  if (helaResultatet) {
    // SHIFT30: hela resultatet ska vara lika efter t − Δ (jsonl-namnet,
    // heapUsedMB och runtimeDiagnostics jämförs inte).
    const strip = (r) => {
      const x = health.stripForH5(r);
      delete x.jsonl;
      delete x.runtimeDiagnostics;
      return x;
    };
    const d = health.firstDifference(strip(base), strip(bankOps.shiftTimesDeep(variant, -dt)));
    if (d) skillnader.helaResultatet = d;
  }
  const n = diffMultiset(notifFull(base), notifFull(variant, { mm, dt }));
  if (!n.lika) skillnader.notiser = { baraBas: n.baraBas.slice(0, 3), baraVariant: n.baraVariant.slice(0, 3) };
  const o = diffMultiset(openFull(base), openFull(variant, { mm, dt }));
  if (!o.lika) skillnader.öppningar = { baraBas: o.baraBas.slice(0, 3), baraVariant: o.baraVariant.slice(0, 3) };
  const p = diffMultiset(passFull(base), passFull(variant, { mm, dt }));
  if (!p.lika) skillnader.passager = { baraBas: p.baraBas.slice(0, 3), baraVariant: p.baraVariant.slice(0, 3) };
  const t = firstSequenceDiff(textStream(base), textStream(variant, { dt }));
  if (t) skillnader.text = t;
  if (fatalBas && fatalVariant) {
    const f = diffMultiset(fatalInstances(fatalBas), fatalInstances(fatalVariant, { mmText }));
    if (!f.lika) skillnader.fatala = { baraBas: f.baraBas.slice(0, 3), baraVariant: f.baraVariant.slice(0, 3) };
  }
  const lb = leakCounts(base);
  const lv = leakCounts(variant);
  const leakDiff = Object.keys({ ...lb, ...lv }).filter((k) => lb[k] !== lv[k]);
  if (leakDiff.length) skillnader.läckage = fromEntries(leakDiff.map((k) => [k, { bas: lb[k], variant: lv[k] }]));
  if ((base.processErrors || 0) !== (variant.processErrors || 0)) skillnader.processErrors = { bas: base.processErrors, variant: variant.processErrors };
  return { lika: Object.keys(skillnader).length === 0, skillnader };
}

module.exports = {
  delivered,
  notifFull,
  openFull,
  passFull,
  textStream,
  leakCounts,
  fatalInstances,
  notifKeys,
  openKeys,
  passKeys,
  diffMultiset,
  firstSequenceDiff,
  pickExtras,
  notificationDrift,
  compareExact,
};
