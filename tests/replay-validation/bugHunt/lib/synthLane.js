'use strict';

/**
 * SANNINGSSPÅRET som fristående drivare (BUGGJAKT.md §4, fas 2):
 *   spec → L0 → radio → rader → replay → domare mot L0/L1.
 *
 * runSynthLane genererar `worlds` världar ur bas-seed, simulerar dem på
 * djupfryst spec, observerar dem med radioprofilen (R0 eller R1), kontrollerar
 * raderna, skriver w<seed>-<i>-<profil>.{jsonl,spec.json,truth.json} i
 * tmpDir, kör varje jsonl genom den inskickade runReplay och dömer med
 * sanningsoraklen. Fynden får världens metadata. Resultaten samlas i
 * indexordning oavsett vilket jobb som blev klart först, så samma seed ger
 * identiska rader och identiska fynd.
 *
 * Motorn rättar ingenting och skriver bara i tmpDir.
 *
 * Fristående körning (egen minimal runReplay med execFile och tidsgräns):
 *   node tests/replay-validation/bugHunt/lib/synthLane.js --worlds=40 --jobs=4 --seed=1 \
 *     [--profiles=R0,R1] [--families=F-KÖ,…] [--tmp=<katalog>] [--keep-temp] [--out=<summary.json>]
 * Utan --tmp skapas en tempkatalog under os.tmpdir() som raderas efteråt
 * (BUGGJAKT §3), om inte --keep-temp anges. En katalog som anges med --tmp
 * är anroparens och raderas aldrig. Barnen körs med cwd i tempkatalogen,
 * som i pool.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const {
  stream, deepFreeze, hashRows, hashJson,
} = require('./rng');
const { sampleWorld, FAMILIES } = require('./families');
const { simulateWorld } = require('./world');
const { observeWorld, checkRows, toJsonl } = require('./radio');
const {
  worldTruth, densityLevel, truthToJson,
} = require('./truth');
const { judgeTruth, statusOf } = require('./oracles/truthJudge');
const { addCounters } = require('./oracles/truthCommon');

const RUNNER = path.join(__dirname, '..', '..', 'replayRunner.js');
const R0_SHARE = 0.3;

// Miljöskrubb enligt BUGGJAKT.md §3.
const SCRUB_PREFIXES = ['REPLAY_', 'AIS_REPLAY_', 'AISHUB_POLL_CAPTURE', 'REGEN_', 'GT_', 'ETA_MEASURE', 'PHASE_SWEEP', 'SOAK_', 'OPENING_GATES_', 'OPENING_GT_'];
const SCRUB_EXACT = ['FUSION_PASS', 'INV21_GT', 'AIS_BRIDGE_SELFTEST', 'NODE_ENV'];

/**
 * Skrubbad miljö för ett barn: bara TMPDIR och (valfritt) REPLAY_MONITORING=1 läggs till.
 * @param {string} tmpDir - barnets TMPDIR
 * @param {boolean} monitoring - REPLAY_MONITORING=1
 * @returns {object} miljö
 */
function scrubbedEnv(tmpDir, monitoring) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (SCRUB_EXACT.includes(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p))) delete env[k];
  }
  env.TMPDIR = tmpDir;
  if (monitoring) env.REPLAY_MONITORING = '1';
  return env;
}

/**
 * Tidsgränsen per körning (BUGGJAKT.md §3, H2):
 * max(60 s; 20 × (0,25 s + 0,31 ms per rad + 0,6 ms per simulerad timme)).
 * @param {number} rows - antal rader
 * @param {number} simHours - simulerade timmar
 * @returns {number} ms
 */
function timeoutMsFor(rows, simHours) {
  return Math.max(60000, 20 * (250 + (0.31 * rows) + (0.6 * simHours)));
}

/**
 * Minimal runReplay för fristående körning: execFile mot det oförändrade
 * replayRunner-CLI:t, skrubbad miljö, cwd i tempkatalogen (som pool.js, så
 * att barnet aldrig skriver i anroparens katalog), SIGKILL vid tidsgräns och
 * en omkörning med dubbel gräns. Ramverkets pool (pool.js) ersätter den i motorn.
 *
 * Tempkatalogen och jsonl-sökvägen görs absoluta mot förälderns cwd innan
 * barnet startas. Barnet har en annan cwd (tempkatalogen), så en relativ
 * sökväg skulle annars tolkas två gånger (efterrättning D: `--tmp=reltmp` gav
 * ENOENT för `reltmp/w…jsonl` i varje värld).
 * @param {object} [o] - {tmpDir}
 * @returns {function(string, object): Promise<object>} runReplay(jsonlPath, {monitoring, timeoutMs})
 */
function makeExecFileRunner({ tmpDir = os.tmpdir() } = {}) {
  const dir = path.resolve(tmpDir);
  const once = (jsonlPath, { monitoring = false, timeoutMs = 60000 } = {}) => new Promise((resolve) => {
    const t0 = Date.now();
    execFile(process.execPath, [RUNNER, path.resolve(jsonlPath)], {
      env: scrubbedEnv(dir, monitoring), cwd: dir, maxBuffer: 1 << 29, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true,
    }, (err, stdout, stderr) => {
      const m = String(stdout).match(/__REPLAY_JSON__([\s\S]*?)__END__/);
      let result = null;
      let error = null;
      if (m) {
        try {
          result = JSON.parse(m[1]);
        } catch (e) {
          error = `trasig JSON: ${e.message}`;
        }
      }
      const timedOut = !!(err && err.killed);
      if (!result && !error) error = timedOut ? 'TIDSGRÄNS' : `ingen __REPLAY_JSON__-markör (exit ${err ? err.code : 0})`;
      if (result && result.fatal) error = `fatal: ${result.fatal}`;
      resolve({
        result, stderr: String(stderr), ms: Date.now() - t0, timedOut, error,
      });
    });
  });
  return async (jsonlPath, opts = {}) => {
    const first = await once(jsonlPath, opts);
    if (!first.timedOut) return first;
    const second = await once(jsonlPath, { ...opts, timeoutMs: (opts.timeoutMs || 60000) * 2 });
    return { ...second, timeouts: second.timedOut ? 2 : 1 };
  };
}

/** Kör fn över items med högst `jobs` samtidiga; resultaten i indexordning. */
async function mapPool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i); // eslint-disable-line no-await-in-loop
    }
  });
  await Promise.all(workers);
  return out;
}

/** Radioprofil för värld i: deterministisk ur (seed, 'profil-i'), 30 % R0 när båda finns. */
function profileFor(seed, i, profiles, r0Share = R0_SHARE) {
  if (profiles.length === 1) return profiles[0];
  const u = stream(seed, `profil-${i}`).u();
  if (profiles.includes('R0') && profiles.includes('R1')) return u < r0Share ? 'R0' : 'R1';
  return profiles[Math.floor(u * profiles.length)];
}

/**
 * Bygg en värld fullt ut (utan replay): spec, simulering, rader och sanning.
 * Specen djupfryses före simuleringen.
 * @param {number} seed - bas-seed
 * @param {number} i - världens index
 * @param {object} opts - {profile, families}
 * @returns {object} {spec, sim, rows, realisation, truth, density}
 */
function buildSynthWorld(seed, i, { profile, families } = {}) {
  const spec = deepFreeze(sampleWorld(seed, i, { families }));
  const sim = simulateWorld(spec);
  const { rows, realisation } = observeWorld(sim, { profile });
  checkRows(rows);
  const truth = worldTruth(sim, rows);
  return {
    spec, sim, rows, realisation, truth, density: densityLevel(truth.L0),
  };
}

/** Normalisera runReplay-svaret: antingen {result,…} eller själva replayresultatet. */
function normaliseRun(res) {
  if (res && Array.isArray(res.notifications)) {
    return {
      result: res, stderr: '', ms: null, timedOut: false, error: null,
    };
  }
  return res || { result: null, error: 'runReplay returnerade inget' };
}

/**
 * Kör sanningsspåret.
 * @param {object} o - parametrar
 * @param {number} o.worlds - antal världar (budget i antal, inte tid)
 * @param {number} o.seed - bas-seed
 * @param {string[]} [o.profiles] - ['R0','R1'] (30 % R0 när båda), eller en av dem
 * @param {string[]} [o.families] - familjer att generera (standard alla nio)
 * @param {number} [o.jobs] - samtidiga replay-körningar (standard 4)
 * @param {string} o.tmpDir - katalog för världarnas filer
 * @param {function} o.runReplay - async (jsonlPath, {monitoring, timeoutMs, rows, simHours}) → {result, stderr, ms, timedOut, error} eller replayresultat
 * @param {function} [o.namespaceEventIds] - instances.namespaceEventIds
 * @param {function[]} [o.extraJudges] - (ctx) → fynd[] (t.ex. existing.js och health.js)
 * @param {string[]} [o.oracles] - sanningsorakel (standard T1, T2, T9, T10)
 * @param {number} [o.r0Share] - R0-andel när båda profilerna körs (0,3)
 * @param {function} [o.onWorld] - anropas med världsposten när en värld är dömd
 * @returns {Promise<object>} {findings, counters, rawCounts, worlds, errors, stats, determinism}
 */
async function runSynthLane({
  worlds, seed, profiles = ['R0', 'R1'], families = FAMILIES, jobs = 4, tmpDir, runReplay,
  namespaceEventIds, extraJudges = [], oracles, r0Share = R0_SHARE, onWorld,
}) {
  if (!Number.isInteger(worlds) || worlds < 0) throw new Error('runSynthLane: worlds måste vara ett heltal ≥ 0');
  if (!Number.isFinite(seed)) throw new Error('runSynthLane: seed saknas');
  if (!tmpDir) throw new Error('runSynthLane: tmpDir saknas');
  if (typeof runReplay !== 'function') throw new Error('runSynthLane: runReplay saknas');
  fs.mkdirSync(tmpDir, { recursive: true });
  const t0 = Date.now();
  let genMs = 0;
  let judgeMs = 0;
  let replayMs = 0;
  const indices = Array.from({ length: worlds }, (_, i) => i);
  const records = await mapPool(indices, jobs, async (i) => {
    const g0 = Date.now();
    const profile = profileFor(seed, i, profiles, r0Share);
    const W = buildSynthWorld(seed, i, { profile, families });
    const base = `w${W.spec.seed}-${i}-${profile}`;
    const jsonlPath = path.join(tmpDir, `${base}.jsonl`);
    const specPath = path.join(tmpDir, `${base}.spec.json`);
    const truthPath = path.join(tmpDir, `${base}.truth.json`);
    fs.writeFileSync(jsonlPath, toJsonl(W.rows));
    fs.writeFileSync(specPath, `${JSON.stringify({ spec: W.spec, radio: { profil: profile }, realisering: W.realisation }, null, 1)}\n`);
    fs.writeFileSync(truthPath, `${JSON.stringify(truthToJson(W.truth))}\n`);
    const simHours = W.spec.durS / 3600;
    const monitoring = i % 4 === 3;
    genMs += Date.now() - g0;
    const run = normaliseRun(await runReplay(jsonlPath, {
      monitoring, timeoutMs: timeoutMsFor(W.rows.length, simHours), rows: W.rows.length, simHours,
    }));
    replayMs += run.ms || 0;
    const meta = {
      index: i,
      seed: W.spec.seed,
      basSeed: seed,
      familj: W.spec.familj,
      radio: profile,
      era: profile === 'R0' ? 'aisstream' : W.spec.era,
      nivå: W.density['nivå'],
      avseddTäthet: W.spec['avseddTäthet'],
      monitoring,
      specPath,
      jsonlPath,
      truthPath,
    };
    const rec = {
      ...meta,
      båtar: W.spec.boats.length,
      rader: W.rows.length,
      simTimmar: Math.round(simHours * 1000) / 1000,
      täthet: W.density,
      radHash: hashRows(W.rows),
      replayMs: run.ms || null,
      fel: null,
      fynd: [],
      räknare: {},
    };
    if (!run.result || run.error) {
      rec.fel = {
        fel: run.error || 'inget resultat', timedOut: !!run.timedOut, timeouts: run.timeouts || 0, stderr: String(run.stderr || '').slice(0, 2000),
      };
      if (onWorld) onWorld(rec);
      return rec;
    }
    const j0 = Date.now();
    const ctx = {
      result: run.result, rows: W.rows, truth: W.truth, world: W.spec, jsonlPath, namespaceEventIds, stderr: run.stderr || '', sim: W.sim, opts: {},
    };
    const judged = judgeTruth(ctx, oracles ? { oracles } : {});
    const extra = [];
    for (const judge of extraJudges) extra.push(...(judge(ctx) || []));
    judgeMs += Date.now() - j0;
    const värld = {
      index: i, seed: W.spec.seed, familj: W.spec.familj, radio: profile, era: meta.era, nivå: meta['nivå'], monitoring, specPath, jsonlPath, truthPath,
    };
    rec.fynd = [...judged.fynd, ...extra].map((f) => ({ ...f, värld }));
    rec['räknare'] = judged['räknare'];
    rec.notiser = (run.result.notifications || []).length;
    rec.varningar = (run.result.openingWarnings || []).length;
    if (onWorld) onWorld(rec);
    return rec;
  });
  const wallMs = Date.now() - t0;
  const findings = records.flatMap((r) => r.fynd);
  const counters = { totalt: {}, perProfil: {} };
  for (const r of records) {
    addCounters(counters.totalt, r['räknare']);
    if (!counters.perProfil[r.radio]) counters.perProfil[r.radio] = {};
    addCounters(counters.perProfil[r.radio], r['räknare']);
  }
  const rawCounts = {};
  for (const f of findings) {
    const k = `${f.orakel} | ${f.klass} | ${statusOf(f)} | ${f['värld'].radio}`;
    rawCounts[k] = (rawCounts[k] || 0) + 1;
  }
  const simHoursTot = records.reduce((s, r) => s + r.simTimmar, 0);
  const rowsTot = records.reduce((s, r) => s + r.rader, 0);
  // Determinismens fingeravtryck: rader per värld och fynd utan sökvägar.
  const stripPaths = (f) => ({
    ...f,
    värld: {
      ...f['värld'], specPath: path.basename(f['värld'].specPath), jsonlPath: path.basename(f['värld'].jsonlPath), truthPath: path.basename(f['värld'].truthPath),
    },
  });
  const determinism = {
    radHash: hashJson(records.map((r) => r.radHash)),
    fyndHash: hashJson(findings.map(stripPaths)),
  };
  return {
    findings,
    counters,
    rawCounts,
    worlds: records.map((r) => {
      const { fynd: _f, ...rest } = r;
      return { ...rest, fynd: r.fynd.length };
    }),
    errors: records.filter((r) => r.fel).map((r) => ({
      index: r.index, seed: r.seed, radio: r.radio, jsonlPath: r.jsonlPath, ...r.fel,
    })),
    stats: {
      världar: worlds,
      jobb: jobs,
      simTimmar: Math.round(simHoursTot * 10) / 10,
      rader: rowsTot,
      väggMs: wallMs,
      genMs,
      replayMsSumma: replayMs,
      domMs: judgeMs,
      världarPerS: Math.round((worlds / Math.max(1, wallMs / 1000)) * 100) / 100,
      simTimmarPerS: Math.round((simHoursTot / Math.max(1, wallMs / 1000)) * 100) / 100,
    },
    determinism,
  };
}

function parseArgs(argv) {
  const a = {
    worlds: 40, seed: 1, jobs: 4, profiles: ['R0', 'R1'], families: FAMILIES, tmp: null, out: null, keepTemp: false,
  };
  for (const x of argv.slice(2)) {
    const [k, v] = x.replace(/^--/, '').split('=');
    if (k === 'worlds') a.worlds = Number(v);
    else if (k === 'seed') a.seed = Number(v);
    else if (k === 'jobs') a.jobs = Number(v);
    else if (k === 'profiles' || k === 'radio') a.profiles = v.split(',');
    else if (k === 'families') a.families = v.split(',');
    else if (k === 'tmp') a.tmp = v;
    else if (k === 'out') a.out = v;
    else if (k === 'keep-temp' && v === undefined) a.keepTemp = true;
    else throw new Error(`Okänd flagga: ${x}`);
  }
  return a;
}

/**
 * Den fristående drivaren. Tempkatalogen (utan --tmp) raderas i finally,
 * även när körningen kastar, om inte --keep-temp anges. En relativ --tmp
 * tolkas mot förälderns cwd och görs absolut, eftersom barnen körs med cwd
 * i katalogen.
 * @param {string[]} [argv] - process.argv-formad lista
 */
async function main(argv = process.argv) {
  const a = parseArgs(argv);
  const egen = !a.tmp;
  const tmpDir = a.tmp ? path.resolve(a.tmp) : fs.mkdtempSync(path.join(os.tmpdir(), 'ais-tracker-hunt-synth-'));
  try {
    const runReplay = makeExecFileRunner({ tmpDir });
    const res = await runSynthLane({
      worlds: a.worlds, seed: a.seed, profiles: a.profiles, families: a.families, jobs: a.jobs, tmpDir, runReplay,
    });
    const s = res.stats;
    const tempo = `${s['världarPerS']} världar/s, ${s.simTimmarPerS} sim-h/s`;
    console.log(`Sanningsspåret: ${s['världar']} världar, ${s.simTimmar} simulerade timmar, ${s.rader} rader på ${(s['väggMs'] / 1000).toFixed(1)} s (${tempo})`);
    console.log(`  generering ${s.genMs} ms, replay Σ ${(s.replayMsSumma / 1000).toFixed(1)} s, dom ${s.domMs} ms`);
    console.log(`Fel/häng: ${res.errors.length}`);
    for (const e of res.errors.slice(0, 5)) console.log(`  ${e.index} ${e.radio} ${e.fel}`);
    console.log('Råa utslag (orakel | klass | status | profil):');
    for (const [k, v] of Object.entries(res.rawCounts).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) console.log(`  ${String(v).padStart(4)}  ${k}`);
    console.log(`Determinism: rader ${res.determinism.radHash.slice(0, 16)} fynd ${res.determinism.fyndHash.slice(0, 16)}`);
    if (a.out) fs.writeFileSync(a.out, `${JSON.stringify(res, null, 1)}\n`);
  } finally {
    if (egen && !a.keepTemp) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } else {
      console.log(`Filer: ${tmpDir}${egen ? ' (behålls: --keep-temp)' : ' (--tmp, raderas inte)'}`);
    }
  }
}

module.exports = {
  runSynthLane, buildSynthWorld, makeExecFileRunner, scrubbedEnv, timeoutMsFor, profileFor, mapPool, parseArgs, main, RUNNER,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(`synthLane: ${e.stack || e.message}`);
    process.exit(2);
  });
}
