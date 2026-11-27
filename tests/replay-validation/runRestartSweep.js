'use strict';

/**
 * OMSTARTSSVEPET (omgång 10, spår O).
 *
 * VARFÖR: appen startar om vid varje appuppdatering, när Homey startar om och
 * om den kraschar. Svepet svarar på frågan: vad ser användaren över en omstart
 * mitt i trafiken, jämfört med samma körning utan omstart? Det spelar upp en
 * körning en gång utan omstart och sedan en gång per omstartspunkt med EN
 * omstart inlagd (replayRunner.js, RESTART_AT/RESTART_PAUSE_MS/RESTART_MODE):
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
 * pausen):
 *  - Varningar: en basvarning är utebliven om varianten inte varnade samma bro
 *    för någon av samma båtar inom 20 min; "efter, hörd" när båten hördes minst
 *    2 min före basens varning efter pausen. En variantvarning utan motsvarighet
 *    är ny; den är dubbel om samma båt redan varnats för samma bro inom 60 min.
 *  - Notiser: antal per båt och bro; underskott är uteblivna, överskott extra.
 *  - Text: var femte sekund i 90 min efter pausen, minuter med "Inga båtar" fast
 *    basen visar en båt.
 * Allt utom processfel och kvarlämnade timers är INFORMATIVT: en omstart får
 * kosta något, och svepet mäter hur mycket.
 *
 * ANVÄNDNING
 *   npm run replay:restart -- <jsonl> [...]        en eller flera körningar
 *   npm run replay:restart                         hela banken (corpora.js)
 *   node tests/replay-validation/runRestartSweep.js <jsonl> --raster=60 --targeted --pauses=20,120,600 --modes=graceful,hard
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
 *   --out=<katalog>      skriv en rad per omstart (JSON) till <katalog>/<id>.jsonl
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
const W20 = 20 * 60000;

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

function textAt(transitions) {
  const tr = (transitions || []).filter((e) => typeof e.text === 'string');
  let i = 0;
  let cur = null;
  return (t) => {
    while (i < tr.length && tr[i].t <= t) {
      cur = tr[i].text; i++;
    }
    return cur;
  };
}

/**
 * Jämför en variant med basen. Ren funktion (testad i
 * tests/o10-omstartssvep.test.js).
 */
function compareRestart(bas, vari, plan, samples) {
  const resume = plan.at + plan.pauseMs;
  const lastFix = samples.length ? samples[samples.length - 1].aisTimestamp : Infinity;
  const cutoff = Math.min(resume + plan.horizonMs, lastFix);
  const heard = new Map();
  for (const s of samples) {
    if (!heard.has(String(s.mmsi))) heard.set(String(s.mmsi), []);
    heard.get(String(s.mmsi)).push(s.aisTimestamp);
  }
  const heardInTime = (mmsis, t) => (mmsis || []).some((m) => (heard.get(String(m)) || []).some((h) => h >= resume && h <= t - 120000));
  const res = {
    varningUtPaus: 0,
    varningUtTyst: 0,
    varningUtHord: 0,
    varningFelTid: 0,
    varningNy: 0,
    varningDubbel: 0,
    notisUtPaus: 0,
    notisUtTyst: 0,
    notisUtHord: 0,
    notisExtra: 0,
    tomS: 0,
    exempel: [],
  };
  const bw = (bas.openingWarnings || []).filter(ok).filter((w) => w.t >= plan.at && w.t < cutoff);
  const vw = (vari.openingWarnings || []).filter(ok).filter((w) => w.t >= plan.at && w.t < cutoff);
  for (const w of bw) {
    const near = vw.some((v) => v.bridge === w.bridge && inter(v.mmsis, w.mmsis) && Math.abs(v.t - w.t) <= W20);
    if (near) continue;
    if (vw.some((v) => v.bridge === w.bridge && inter(v.mmsis, w.mmsis))) {
      res.varningFelTid++; continue;
    }
    if (w.t < resume) res.varningUtPaus++;
    else if (heardInTime(w.mmsis, w.t)) {
      res.varningUtHord++;
      res.exempel.push(`varning utebliven fast båten hördes: ${w.bridge} ${JSON.stringify(w.mmsis)} basen ${new Date(w.t).toISOString()}`);
    } else res.varningUtTyst++;
  }
  const allVw = (vari.openingWarnings || []).filter(ok);
  const priorBw = (bas.openingWarnings || []).filter(ok).filter((w) => w.t < plan.at);
  for (const v of vw) {
    if (bw.some((w) => w.bridge === v.bridge && inter(v.mmsis, w.mmsis))) continue;
    const earlier = [...priorBw, ...allVw.filter((x) => x.t < v.t && x.t >= plan.at)]
      .some((w) => w.bridge === v.bridge && inter(v.mmsis, w.mmsis) && v.t - w.t > 0 && v.t - w.t <= 60 * 60000);
    if (earlier) {
      res.varningDubbel++;
      res.exempel.push(`dubbel varning: ${v.bridge} ${JSON.stringify(v.mmsis)} ${new Date(v.t).toISOString()}`);
    } else res.varningNy++;
  }
  const bn = (bas.notifications || []).filter(ok).filter((n) => n.t >= plan.at && n.t < cutoff);
  const vn = (vari.notifications || []).filter(ok).filter((n) => n.t >= plan.at && n.t < cutoff);
  const key = (n) => `${n.mmsi}|${n.bridge}`;
  for (const k of new Set([...bn, ...vn].map(key))) {
    const b = bn.filter((n) => key(n) === k);
    const v = vn.filter((n) => key(n) === k);
    for (const n of b.slice(v.length)) {
      if (n.t < resume) res.notisUtPaus++;
      else if (heardInTime([n.mmsi], n.t)) res.notisUtHord++;
      else res.notisUtTyst++;
    }
    if (v.length > b.length) {
      res.notisExtra += v.length - b.length;
      for (const n of v.slice(b.length)) res.exempel.push(`extra notis: ${n.name || n.mmsi} ${n.bridge} "${n.message}"`);
    }
  }
  const fb = textAt(bas.bridgeTextTransitions);
  const fv = textAt(vari.bridgeTextTransitions);
  const end = Math.min(cutoff, resume + 90 * 60000);
  for (let t = plan.at; t < end; t += 5000) {
    const b = fb(t);
    const v = fv(t);
    if (t >= resume && b !== v && (!v || v === DEFAULT_TEXT) && b && b !== DEFAULT_TEXT) res.tomS += 5;
  }
  return res;
}

const SUMMA_FALT = ['varningUtPaus', 'varningUtTyst', 'varningUtHord', 'varningFelTid', 'varningNy', 'varningDubbel',
  'notisUtPaus', 'notisUtTyst', 'notisUtHord', 'notisExtra', 'tomS'];
const nollor = () => SUMMA_FALT.reduce((acc, k) => ({ ...acc, [k]: 0 }), {});

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
  if (o.out) fs.mkdirSync(o.out, { recursive: true });
  console.log('\n=== OMSTARTSSVEPET ===');
  console.log(`raster ${o.raster} min, riktade punkter ${o.targeted ? `ja (högst ${o.maxPoints} per läge)` : 'nej'}, pauser ${o.pauses.join('/')} s, ${o.modes.join('/')}, fönster ${o.horizon} min`);
  console.log('Prövar inte: fusionen, AISHub efter omstarten, fler än en omstart per uppspelning.\n');
  const total = nollor();
  let restarts = 0;
  let hardFailures = 0;
  const examples = [];
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
    const samples = readSamples(file);
    const points = restartPoints(bas, samples, o);
    const sum = nollor();
    let n = 0;
    for (const p of points) {
      for (const pause of o.pauses) {
        for (const mode of o.modes) {
          const plan = {
            at: p.at, pauseMs: pause * 1000, mode, horizonMs: o.horizon * 60000,
          };
          let row;
          try {
            const vari = runReplay(file, {
              RESTART_AT: String(p.at),
              RESTART_PAUSE_MS: String(plan.pauseMs),
              RESTART_MODE: mode,
              RESTART_TRUNCATE_AT: String(p.at + plan.pauseMs + plan.horizonMs),
              RESTART_SLIM: '1',
            });
            const cmp = compareRestart(bas, vari, plan, samples);
            const timers = (vari.runtimeDiagnostics && vari.runtimeDiagnostics.timersAfterRestartShutdown) || [];
            const fel = (vari.processErrors || 0) > 0 || timers.some((x) => x > 0);
            if (fel) {
              hardFailures++;
              examples.push(`❌ ${id} ${p.lage} ${new Date(p.at).toISOString()} ${pause}s ${mode}: processfel ${vari.processErrors}, timers kvar ${JSON.stringify(timers)}`);
            }
            for (const k of SUMMA_FALT) sum[k] += cmp[k];
            for (const ex of cmp.exempel) examples.push(`${id} ${p.lage} ${new Date(p.at).toISOString()} ${pause}s ${mode}: ${ex}`);
            row = {
              id,
              ...p,
              pauseMs: plan.pauseMs,
              mode,
              ...cmp,
              processErrors: vari.processErrors,
              timersAfterRestartShutdown: timers,
              settingsChangedByUninit: vari.restart && vari.restart.settingsChangedByUninit,
            };
            n++;
          } catch (e) {
            hardFailures++;
            examples.push(`💥 ${id} ${p.lage} ${new Date(p.at).toISOString()} ${pause}s ${mode}: ${e.message.slice(0, 200)}`);
            row = {
              id, ...p, pauseMs: plan.pauseMs, mode, fel: e.message.slice(0, 500),
            };
          }
          if (o.out) fs.appendFileSync(path.join(o.out, `${id}.jsonl`), `${JSON.stringify(row)}\n`);
        }
      }
    }
    restarts += n;
    for (const k of SUMMA_FALT) total[k] += sum[k];
    console.log(`  ${id}: ${n} omstarter; varningar uteblivna ${sum.varningUtPaus}/${sum.varningUtTyst}/${sum.varningUtHord} (pausen/tyst/hörd), `
      + `fel tid ${sum.varningFelTid}, nya ${sum.varningNy}, dubbla ${sum.varningDubbel}; notiser uteblivna ${sum.notisUtPaus}/${sum.notisUtTyst}/${sum.notisUtHord}, `
      + `extra ${sum.notisExtra}; "Inga båtar" fast båt fanns ${Math.round(sum.tomS / 60)} min`);
  }
  console.log(`\nSUMMA: ${restarts} omstarter; varningar uteblivna ${total.varningUtPaus}/${total.varningUtTyst}/${total.varningUtHord} (i pausen/efter, tyst båt/efter, hörd båt), `
    + `> 20 min fel ${total.varningFelTid}, nya ${total.varningNy}, dubbla ${total.varningDubbel}; notiser uteblivna `
    + `${total.notisUtPaus}/${total.notisUtTyst}/${total.notisUtHord}, extra ${total.notisExtra}; "Inga båtar" fast båt fanns ${Math.round(total.tomS / 60)} min`);
  const byKind = new Map();
  for (const ex of examples) {
    const kind = ex.includes('❌') || ex.includes('💥') ? 'fel' : ex.split(': ')[1].split(':')[0];
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(ex);
  }
  for (const [kind, list] of byKind) {
    console.log(`\n  ${kind} (${list.length}):`);
    for (const ex of list.slice(0, kind === 'fel' ? 50 : o.examples)) console.log(`    ${ex}`);
  }
  if (hardFailures > 0) {
    console.log(`\n❌ ${hardFailures} omstart(er) med processfel, timer kvar efter onUninit eller kastande uppspelning.`);
    process.exit(1);
  }
  console.log('\n✅ Inga processfel och inga timers kvar efter onUninit (jämförelsen ovan är informativ).');
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  parseArgs, restartPoints, compareRestart,
};
