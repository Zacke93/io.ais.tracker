'use strict';

/**
 * OMSTARTSSVEPET (omgång 10, spår O).
 *
 * VARFÖR: appen startar om vid varje appuppdatering, när Homey startar om och
 * om den kraschar. Svepet svarar på frågan: vad ser användaren över en omstart
 * mitt i trafiken, jämfört med samma körning utan omstart? Det spelar upp en
 * körning en gång utan omstart och sedan en gång per omstartspunkt med EN
 * omstart inlagd (replayRunner.js, REPLAY_RESTART_AT/_PAUSE_MS/_MODE):
 * appen stängs med onUninit (graceful) eller "dör" (hard: det onUninit skrev
 * till inställningarna kastas), ingen app finns under pausen och rader som
 * kommer då tas aldrig emot, och sedan startar en ny instans mot samma
 * inställningar. Enhetens onInit skriver appens text som i Homey (en ny instans
 * har ingen, alltså "Inga båtar"); under pausen står enhetens gamla text kvar.
 *
 * VAD DET INTE PRÖVAR (följder av hur det är byggt, inte fel i appen):
 *  - fusionen: uppspelningen går utan muxen (bypass), som replay:all;
 *  - AISHub efter omstarten: i Homey hämtar AISHub alla båtars senaste position
 *    inom ungefär en minut; svepet väntar på nästa inspelade rad, så tiden till
 *    första position efter omstarten är en övre gräns;
 *  - fler än en omstart per uppspelning, och uppstartens egna sekunder;
 *  - en hård omstart antar att det appen skrev till homey.settings före
 *    kraschen finns kvar.
 *
 * JÄMFÖRELSEN (per omstart, fönstret från omstarten till --horizon efter
 * pausen), mot samma körning utan omstart, med det stränga mått som granskaren
 * använde i omgång 10 (jamfor-strikt.js):
 *  - Notiser paras per båt och bro (närmast i tid, högst 60 min isär). Fel är
 *    en utebliven notis, en extra, fel riktning och mer än 120 s fel tid.
 *  - Varningar paras per bro och båt (någon gemensam, högst 20 min isär). Fel
 *    är en utebliven, en ny och mer än 5 min fel tid.
 *  - Text: var femte sekund i 90 min från omstarten, efter pausen: sekunder med
 *    "Inga båtar" fast basen visar en båt och sekunder med annan text. Andra
 *    minuttal och en båt som visas fast basen säger "Inga båtar" räknas INTE.
 *  - För tidiga "passerade": mer än 120 s före båtens passage utan omstart.
 *  Måttet ser inte notisens text i övrigt (form, ETA-siffra), inte vilken båt
 *  en konvojvarning nämner, och inte texten under själva pausen.
 *  --compare jämför två svep i samma punkter (före och efter en ändring): en
 *  omstart är sämre om notisfelen eller varningsfelen ökar eller felaktig text
 *  ökar med mer än 60 s, bättre om inget blir sämre och något blir bättre.
 * Allt utom processfel och kvarlämnade timers är INFORMATIVT: en omstart får
 * kosta något, och svepet mäter hur mycket.
 *
 * ANVÄNDNING
 *   npm run replay:restart -- <jsonl> [...]        en eller flera körningar
 *   npm run replay:restart                         hela banken (corpora.js)
 *   node tests/replay-validation/runRestartSweep.js <jsonl> --raster=60 --targeted --pauses=20,120,600 --modes=graceful,hard
 *   npm run replay:restart -- --compare=<utkatalog före>,<utkatalog efter>
 *
 * FLAGGOR
 *   --raster=<min>       omstart var N:e minut (standard 120; 0 = av)
 *   --targeted           också riktade punkter ur basen: väntan vid målbron,
 *                        2 min och 20 s före en målbropassage, 15 s efter en
 *                        öppningsvarning, mitt i ett stopp på minst 30 min
 *   --max-points=<n>     högst n riktade punkter per läge och körning (standard 6)
 *   --pauses=<s,...>     pauser i sekunder (standard 120)
 *   --modes=<lista>      graceful och/eller hard (standard graceful)
 *   --horizon=<min>      jämförelsefönster efter pausen (standard 180)
 *   --out=<katalog>      skriv basen och en rad per omstart: <katalog>/<id>/bas.json
 *                        och <katalog>/<id>/varianter.jsonl (det --compare läser)
 *   --compare=<a>,<b>    jämför två utkataloger i samma punkter (ingen uppspelning)
 *   --examples=<n>       så många exempel per klass i utskriften (standard 5)
 *
 * TID: en uppspelning tar 1–10 s beroende på korpus; standardrastret (120 min,
 * en paus, ett läge) över en dygnskorpus är ett tiotal omstarter. Hela banken
 * med riktade punkter och flera pauser är tungt: kör genom kön.
 *
 * EXITKODER
 *   0 = inga processfel och inga timers kvar efter onUninit
 *   1 = minst en omstart gav processfel, en timer kvar efter onUninit eller en
 *       uppspelning som kastade
 *   2 = anropsfel (okänd flagga, saknad fil)
 *
 * Korpusfilerna rörs aldrig, och svepet skriver inget i repot (--out pekar dit
 * man själv väljer; fältdata får inte läggas i repot).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RUNNER = path.join(__dirname, 'replayRunner.js');
const MAX_BUFFER = 256 * 1024 * 1024;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TEXT = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';

function parseArgs(argv) {
  const o = {
    raster: 120, targeted: false, maxPoints: 6, pauses: [120], modes: ['graceful'], horizon: 180, out: null, examples: 5, files: [],
  };
  for (const a of argv) {
    const i = a.indexOf('=');
    const k = i < 0 ? a : a.slice(0, i);
    const v = i < 0 ? null : a.slice(i + 1);
    if (k === '--raster') o.raster = Number(v);
    else if (k === '--targeted') o.targeted = true;
    else if (k === '--max-points') o.maxPoints = Number(v);
    else if (k === '--pauses') o.pauses = v.split(',').map(Number);
    else if (k === '--modes') o.modes = v.split(',');
    else if (k === '--horizon') o.horizon = Number(v);
    else if (k === '--out') o.out = path.resolve(v);
    else if (k === '--examples') o.examples = Number(v);
    else if (k === '--compare') o.compare = v.split(',').map((d) => path.resolve(d));
    else if (k === '--help' || k === '-h') o.help = true;
    else if (k.startsWith('-')) throw new Error(`Okänd flagga: ${k}`);
    else o.files.push(path.resolve(a));
  }
  if (o.pauses.some((p) => !Number.isFinite(p) || p < 0)) throw new Error('--pauses måste vara sekunder ≥ 0');
  if (o.modes.some((m) => m !== 'graceful' && m !== 'hard')) throw new Error('--modes tar graceful och hard');
  if (!Number.isFinite(o.raster) || o.raster < 0) throw new Error('--raster måste vara minuter ≥ 0');
  return o;
}

function runReplay(jsonl, env) {
  const statePath = jsonl.replace(/\.jsonl$/, '.state.json');
  const out = execFileSync('node', [RUNNER, jsonl], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, REPLAY_INITIAL_STATE: fs.existsSync(statePath) ? statePath : '', ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const i = out.lastIndexOf('__REPLAY_JSON__');
  const j = out.lastIndexOf('__END__');
  if (i < 0 || j < i) throw new Error('Ingen __REPLAY_JSON__-markör i replay-utdata');
  const r = JSON.parse(out.slice(i + '__REPLAY_JSON__'.length, j));
  if (r.fatal) throw new Error(`replayRunner kastade: ${r.fatal}`);
  if (r.error) throw new Error(`replayRunner: ${r.error}`);
  return r;
}

function readSamples(jsonl) {
  return fs.readFileSync(jsonl, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((s) => !s.ctrl && Number.isFinite(s.aisTimestamp))
    .sort((a, b) => a.aisTimestamp - b.aisTimestamp);
}

/** Omstartspunkterna: raster och (med --targeted) riktade punkter ur basen. */
function restartPoints(bas, samples, o) {
  const first = samples[0].aisTimestamp;
  const last = samples[samples.length - 1].aisTimestamp;
  const pts = [];
  if (o.raster > 0) {
    const step = o.raster * 60000;
    for (let t = first + step / 2; t < last; t += step) pts.push({ at: Math.round(t), lage: 'raster' });
  }
  if (o.targeted) {
    const cand = [];
    for (const w of bas.confirmedTargetWaits || []) {
      if (w.until - w.from >= 4 * 60000) cand.push({ at: w.from + 120000, lage: 'väntar-vid-målbro' });
    }
    for (const p of bas.targetPassages || []) {
      cand.push({ at: p.t - 120000, lage: 'före-passage' });
      cand.push({ at: p.t - 20000, lage: 'mitt-i-passage' });
    }
    for (const w of bas.openingWarnings || []) cand.push({ at: w.t + 15000, lage: 'efter-varning' });
    const byV = new Map();
    for (const s of samples) {
      if (!byV.has(String(s.mmsi))) byV.set(String(s.mmsi), []);
      byV.get(String(s.mmsi)).push(s);
    }
    for (const rows of byV.values()) {
      let start = null;
      for (let i = 0; i <= rows.length; i++) {
        const still = rows[i] && Number.isFinite(rows[i].sog) && rows[i].sog < 0.3;
        if (still && start === null) start = rows[i].aisTimestamp;
        if ((!still || i === rows.length) && start !== null) {
          const end = rows[i - 1].aisTimestamp;
          if (end - start >= 30 * 60000) cand.push({ at: (start + end) / 2, lage: 'ligger-still' });
          start = null;
        }
      }
    }
    const byLage = new Map();
    for (const p of cand.sort((a, b) => a.at - b.at)) {
      if (p.at <= first + 60000 || p.at >= last) continue;
      if (!byLage.has(p.lage)) byLage.set(p.lage, []);
      const list = byLage.get(p.lage);
      if (list.length && p.at - list[list.length - 1].at < 30000) continue;
      list.push({ at: Math.round(p.at), lage: p.lage });
    }
    for (const list of byLage.values()) {
      if (list.length <= o.maxPoints) pts.push(...list);
      else for (let i = 0; i < o.maxPoints; i++) pts.push(list[Math.floor((i * list.length) / o.maxPoints)]);
    }
  }
  return pts.sort((a, b) => a.at - b.at);
}

const ok = (x) => x.success !== false && Number.isFinite(x.t);
const inter = (a, b) => (a || []).map(String).some((m) => (b || []).map(String).includes(m));
const iso = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const form = (msg) => (/passera/.test(msg || '') ? 'pass' : 'nar');
const dirOf = (d) => {
  if (/north|norr/.test(d || '')) return 'N';
  if (/south|söder/.test(d || '')) return 'S';
  return '?';
};

function textAt(transitions) {
  const tr = (transitions || []).filter((e) => typeof e.text === 'string');
  let i = 0;
  let cur = null;
  return (t) => {
    while (i < tr.length && tr[i].t <= t) {
      cur = tr[i].text;
      i++;
    }
    return cur;
  };
}

function classifyText(b, v) {
  const bd = !b || b === DEFAULT_TEXT;
  const vd = !v || v === DEFAULT_TEXT;
  if (vd && !bd) return 'tom';
  if (bd && !vd) return 'fantom';
  const norm = (s) => s.replace(/om \d+ minuter?/g, 'om N').replace(/strax/g, 'om N');
  return norm(b) === norm(v) ? 'minuter' : 'annan';
}

/**
 * En variant som rad: varianternas notiser och varningar efter omstarten och
 * textskillnaderna mot basen (var femte sekund i 90 min från omstarten, efter
 * pausen). Formatet är detsamma som omstartssvepets utkataloger i omgång 10,
 * så att två svep kan jämföras med compareSweeps (och med granskarens
 * jamfor-strikt.js).
 */
function variantRow(bas, vari, plan, samples) {
  const lastFix = samples.length ? samples[samples.length - 1].aisTimestamp : Infinity;
  const effCutoff = Math.min(plan.at + plan.pauseMs + plan.horizonMs, lastFix);
  const resume = plan.at + plan.pauseMs;
  const vn = (vari.notifications || []).filter(ok).filter((n) => n.t >= plan.at && n.t < effCutoff)
    .map((n) => ({
      t: n.t, bridge: n.bridge, mmsi: n.mmsi, dir: n.direction, msg: n.message, name: n.name,
    }));
  const vw = (vari.openingWarnings || []).filter(ok).filter((w) => w.t >= plan.at && w.t < effCutoff)
    .map((w) => ({
      t: w.t, bridge: w.bridge, mmsis: w.mmsis, firedBy: w.firedBy,
    }));
  const fb = textAt(bas.bridgeTextTransitions);
  const fv = textAt(vari.bridgeTextTransitions);
  const text = {
    pausen: {
      tom: 0, fantom: 0, minuter: 0, annan: 0,
    },
    efter: {
      tom: 0, fantom: 0, minuter: 0, annan: 0,
    },
  };
  const end = Math.min(effCutoff, plan.at + 90 * 60000);
  for (let t = plan.at; t < end; t += 5000) {
    const b = fb(t);
    const v = fv(t);
    if (b !== v) text[t < resume ? 'pausen' : 'efter'][classifyText(b, v)] += 5;
  }
  return {
    at: plan.at, pauseMs: plan.pauseMs, mode: plan.mode, horizonMs: plan.horizonMs, vn, vw, text, textModel: 2,
  };
}

/** Notisfel mot körningen utan omstart: utebliven, extra, fel riktning, mer än 120 s fel tid. */
function noticeErrors(ref, vn) {
  const used = new Set();
  const errs = [];
  for (const b of ref) {
    let best = -1;
    let bestDt = Infinity;
    vn.forEach((v, i) => {
      if (used.has(i) || String(v.mmsi) !== String(b.mmsi) || v.bridge !== b.bridge) return;
      const dt = Math.abs(v.t - b.t);
      if (dt <= 3600000 && dt < bestDt) {
        best = i;
        bestDt = dt;
      }
    });
    if (best < 0) {
      errs.push(`utebliven ${b.name || b.mmsi} ${b.bridge} ${iso(b.t)}`);
      continue;
    }
    used.add(best);
    const v = vn[best];
    if (dirOf(v.dir) !== dirOf(b.direction)) errs.push(`fel riktning ${b.name || b.mmsi} ${b.bridge} ${dirOf(b.direction)}→${dirOf(v.dir)}`);
    if (Math.abs(v.t - b.t) > 120000) errs.push(`fel tid ${b.name || b.mmsi} ${b.bridge} ${Math.round((v.t - b.t) / 1000)} s`);
  }
  vn.forEach((v, i) => {
    if (!used.has(i)) errs.push(`extra ${v.name || v.mmsi} ${v.bridge} ${iso(v.t)} "${(v.msg || '').slice(0, 60)}"`);
  });
  return errs;
}

/** Varningsfel: utebliven (ingen inom 20 min för samma bro och båt), ny, mer än 5 min fel tid. */
function warningErrors(ref, vw) {
  const used = new Set();
  const errs = [];
  for (const w of ref) {
    let best = -1;
    let bestDt = Infinity;
    vw.forEach((v, i) => {
      if (used.has(i) || v.bridge !== w.bridge || !inter(v.mmsis, w.mmsis)) return;
      const dt = Math.abs(v.t - w.t);
      if (dt <= 20 * 60000 && dt < bestDt) {
        best = i;
        bestDt = dt;
      }
    });
    if (best < 0) {
      errs.push(`utebliven varning ${w.bridge} ${JSON.stringify(w.mmsis)} ${iso(w.t)}`);
      continue;
    }
    used.add(best);
    if (Math.abs(vw[best].t - w.t) > 5 * 60000) errs.push(`varning fel tid ${w.bridge} ${Math.round((vw[best].t - w.t) / 60000)} min`);
  }
  vw.forEach((v, i) => {
    if (!used.has(i)) errs.push(`ny varning ${v.bridge} ${JSON.stringify(v.mmsis)} ${iso(v.t)}`);
  });
  return errs;
}

/** "Passerade" före båtens passage i körningen utan omstart (mer än 120 s före, ingen passage de senaste 6 h). */
function prematurePass(bas, vn) {
  const pass = [...(bas.targetPassages || []), ...(bas.intermediatePassages || [])];
  const out = [];
  for (const v of vn) {
    if (form(v.msg) !== 'pass') continue;
    const same = pass.filter((p) => String(p.mmsi) === String(v.mmsi) && p.bridge === v.bridge);
    const before = same.some((p) => p.t <= v.t + 120000 && p.t > v.t - 6 * 3600000);
    const later = same.find((p) => p.t > v.t + 120000 && p.t < v.t + 3600000);
    if (!before && later) out.push(`för tidig "passerade" ${v.name || v.mmsi} ${v.bridge} ${Math.round((later.t - v.t) / 60000)} min före passagen`);
  }
  return out;
}

/**
 * Det stränga måttet för en omstart (samma som granskarens jamfor-strikt.js i
 * omgång 10): notisfel, varningsfel och sekunder fel text ("Inga båtar" och
 * annan text; minutskillnader och en båt som visas fast basen säger "Inga
 * båtar" räknas inte), mot körningen utan omstart.
 */
function strictErrors(bas, row) {
  const cutoff = row.at + row.pauseMs + (row.horizonMs || 180 * 60000);
  const refN = (bas.notifications || []).filter(ok).filter((n) => n.t >= row.at && n.t < cutoff);
  const refW = (bas.openingWarnings || []).filter(ok).filter((w) => w.t >= row.at && w.t < cutoff);
  const vn = row.vn.filter((n) => n.t < cutoff);
  return {
    notis: noticeErrors(refN, vn),
    varning: warningErrors(refW, row.vw.filter((w) => w.t < cutoff)),
    textS: (row.text.efter.tom || 0) + (row.text.efter.annan || 0),
    tomS: row.text.efter.tom || 0,
    fortida: prematurePass(bas, vn),
  };
}

/**
 * Jämför två svep i samma punkter (före och efter en ändring) med det stränga
 * måttet. En omstart är sämre om notisfelen eller varningsfelen ökar eller
 * felaktig text ökar med mer än 60 s; bättre om inget blir sämre och något
 * blir bättre.
 */
function compareSweeps(dirA, dirB) {
  const load = (dir, id) => {
    const f = path.join(dir, id, 'varianter.jsonl');
    const m = new Map();
    if (!fs.existsSync(f)) return m;
    for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(l);
      if (!r.fel && r.vw && r.vn && r.textModel === 2) m.set(`${r.at}|${r.pauseMs}|${r.mode}|${r.lage}`, r);
    }
    return m;
  };
  const tot = {
    rader: 0, battre: 0, samre: 0, lika: 0, nA: 0, nB: 0, wA: 0, wB: 0, tA: 0, tB: 0, pA: 0, pB: 0,
  };
  const worse = [];
  for (const id of fs.readdirSync(dirA).filter((x) => fs.existsSync(path.join(dirB, x, 'varianter.jsonl')))) {
    const basF = path.join(dirA, id, 'bas.json');
    if (!fs.existsSync(basF)) continue;
    const bas = JSON.parse(fs.readFileSync(basF, 'utf8'));
    const A = load(dirA, id);
    const B = load(dirB, id);
    for (const [k, ra] of A) {
      const rb = B.get(k);
      if (!rb) continue;
      const a = strictErrors(bas, { ...ra, horizonMs: 180 * 60000 });
      const b = strictErrors(bas, { ...rb, horizonMs: 180 * 60000 });
      tot.rader++;
      tot.nA += a.notis.length;
      tot.nB += b.notis.length;
      tot.wA += a.varning.length;
      tot.wB += b.varning.length;
      tot.tA += a.textS;
      tot.tB += b.textS;
      tot.pA += a.fortida.length;
      tot.pB += b.fortida.length;
      const isWorse = b.notis.length > a.notis.length || b.varning.length > a.varning.length || b.textS - a.textS > 60;
      const isBetter = b.notis.length < a.notis.length || b.varning.length < a.varning.length || a.textS - b.textS > 60;
      if (isWorse) {
        tot.samre++;
        worse.push(`${id} ${ra.lage} ${iso(ra.at)} paus ${ra.pauseMs / 1000}s: notisfel ${a.notis.length}→${b.notis.length}, `
          + `varningsfel ${a.varning.length}→${b.varning.length}, text ${Math.round(a.textS / 60)}→${Math.round(b.textS / 60)} min`);
      } else if (isBetter) tot.battre++;
      else tot.lika++;
    }
  }
  return { tot, worse };
}

function writeBas(outDir, id, bas) {
  fs.mkdirSync(path.join(outDir, id), { recursive: true });
  fs.writeFileSync(path.join(outDir, id, 'bas.json'), JSON.stringify(bas));
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(2);
  }
  if (o.help) {
    console.log('Se filhuvudet i tests/replay-validation/runRestartSweep.js.');
    process.exit(0);
  }
  if (o.compare) {
    const [dirA, dirB] = o.compare;
    if (!dirA || !dirB || !fs.existsSync(dirA) || !fs.existsSync(dirB)) {
      console.error('❌ --compare kräver två befintliga utkataloger: --compare=<före>,<efter>');
      process.exit(2);
    }
    const { tot, worse } = compareSweeps(dirA, dirB);
    console.log(`omstarter: ${tot.rader}; bättre ${tot.battre}, sämre ${tot.samre}, lika ${tot.lika}`);
    console.log(`notisfel (utebliven, extra, riktning, tid > 120 s) ${tot.nA} → ${tot.nB}`);
    console.log(`varningsfel (utebliven, ny, tid > 5 min) ${tot.wA} → ${tot.wB}`);
    console.log(`fel text efter pausen ${Math.round(tot.tA / 60)} → ${Math.round(tot.tB / 60)} min`);
    console.log(`för tidiga "passerade" ${tot.pA} → ${tot.pB}`);
    for (const s of worse.slice(0, o.examples * 10)) console.log(`  sämre: ${s}`);
    process.exit(0);
  }
  if (o.files.length === 0) {
    // eslint-disable-next-line global-require
    const corpora = require('./corpora');
    o.files = (Array.isArray(corpora) ? corpora : Object.values(corpora)).map((c) => c.jsonl);
  }
  for (const f of o.files) {
    if (!fs.existsSync(f)) {
      console.error(`❌ Saknad fil: ${f}`);
      process.exit(2);
    }
  }
  console.log('\n=== OMSTARTSSVEPET ===');
  console.log(`raster ${o.raster} min, riktade punkter ${o.targeted ? `ja (högst ${o.maxPoints} per läge)` : 'nej'}, pauser ${o.pauses.join('/')} s, ${o.modes.join('/')}, fönster ${o.horizon} min`);
  console.log('Prövar inte: fusionen, AISHub efter omstarten, fler än en omstart per uppspelning.');
  console.log('Fel räknas mot samma körning utan omstart (strängt mått: utebliven, extra, riktning, tid).\n');
  const total = {
    n: 0, notis: 0, varning: 0, textS: 0, tomS: 0, fortida: 0,
  };
  let hardFailures = 0;
  const examples = new Map();
  const addEx = (kind, s) => {
    if (!examples.has(kind)) examples.set(kind, []);
    examples.get(kind).push(s);
  };
  for (const file of o.files) {
    const id = path.basename(file, '.jsonl') === 'ais' ? path.basename(path.dirname(file)) : path.basename(file, '.jsonl');
    let bas;
    try {
      bas = runReplay(file, {});
    } catch (e) {
      console.log(`  💥 ${id}: basen kastade: ${e.message}`);
      hardFailures++;
      continue;
    }
    if (o.out) writeBas(o.out, id, bas);
    const samples = readSamples(file);
    const sum = {
      n: 0, notis: 0, varning: 0, textS: 0, tomS: 0, fortida: 0,
    };
    for (const p of restartPoints(bas, samples, o)) {
      for (const pause of o.pauses) {
        for (const mode of o.modes) {
          const plan = {
            at: p.at, pauseMs: pause * 1000, mode, horizonMs: o.horizon * 60000,
          };
          const label = `${id} ${p.lage} ${iso(p.at)} ${pause}s ${mode}`;
          let row;
          try {
            const vari = runReplay(file, {
              REPLAY_RESTART_AT: String(p.at),
              REPLAY_RESTART_PAUSE_MS: String(plan.pauseMs),
              REPLAY_RESTART_MODE: mode,
              REPLAY_RESTART_TRUNCATE_AT: String(p.at + plan.pauseMs + plan.horizonMs),
              REPLAY_RESTART_SLIM: '1',
            });
            row = { ...variantRow(bas, vari, plan, samples), lage: p.lage };
            const e = strictErrors(bas, row);
            const timers = (vari.runtimeDiagnostics && vari.runtimeDiagnostics.timersAfterRestartShutdown) || [];
            if ((vari.processErrors || 0) > 0 || timers.some((x) => x > 0)) {
              hardFailures++;
              addEx('fel', `❌ ${label}: processfel ${vari.processErrors}, timers kvar ${JSON.stringify(timers)}`);
            }
            sum.n++;
            sum.notis += e.notis.length;
            sum.varning += e.varning.length;
            sum.textS += e.textS;
            sum.tomS += e.tomS;
            sum.fortida += e.fortida.length;
            for (const x of [...e.notis, ...e.varning, ...e.fortida]) addEx(x.split(' ').slice(0, 2).join(' '), `${label}: ${x}`);
            Object.assign(row, {
              processErrors: vari.processErrors,
              timersAfterRestartShutdown: timers,
              settingsChangedByUninit: vari.restart && vari.restart.settingsChangedByUninit,
            });
          } catch (err) {
            hardFailures++;
            addEx('fel', `💥 ${label}: ${err.message.slice(0, 200)}`);
            row = {
              at: p.at, lage: p.lage, pauseMs: plan.pauseMs, mode, fel: err.message.slice(0, 500),
            };
          }
          if (o.out) fs.appendFileSync(path.join(o.out, id, 'varianter.jsonl'), `${JSON.stringify(row)}\n`);
        }
      }
    }
    for (const k of Object.keys(total)) total[k] += sum[k];
    console.log(`  ${id}: ${sum.n} omstarter; notisfel ${sum.notis}, varningsfel ${sum.varning}, fel text ${Math.round(sum.textS / 60)} min `
      + `(varav "Inga båtar" fast båt fanns ${Math.round(sum.tomS / 60)}), för tidiga "passerade" ${sum.fortida}`);
  }
  console.log(`\nSUMMA: ${total.n} omstarter; notisfel ${total.notis}, varningsfel ${total.varning}, fel text ${Math.round(total.textS / 60)} min `
    + `(varav "Inga båtar" ${Math.round(total.tomS / 60)}), för tidiga "passerade" ${total.fortida}`);
  for (const [kind, list] of examples) {
    console.log(`\n  ${kind} (${list.length}):`);
    for (const ex of list.slice(0, kind === 'fel' ? 50 : o.examples)) console.log(`    ${ex}`);
  }
  if (hardFailures > 0) {
    console.log(`\n❌ ${hardFailures} omstart(er) med processfel, timer kvar efter onUninit eller kastande uppspelning.`);
    process.exit(1);
  }
  console.log('\n✅ Inga processfel och inga timers kvar efter onUninit (felen ovan är informativa).');
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  parseArgs, restartPoints, variantRow, strictErrors, compareSweeps,
};
