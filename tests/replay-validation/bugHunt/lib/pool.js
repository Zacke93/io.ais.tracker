'use strict';

/**
 * Körpoolen (BUGGJAKT §3, processmodellen).
 *
 * All replay körs i barnprocesser mot det OFÖRÄNDRADE replayRunner-CLI:t
 * (`node replayRunner.js <jsonl> [mmsi]`, markörkontraktet
 * __REPLAY_JSON__ … __END__). 44 jest-sviter och ett tiotal verktyg vilar på
 * kontraktet; barnprocessen isolerar dessutom mot fejkklockans överhörning och
 * runnerns globala sidoeffekter, och den kan dödas hårt.
 *
 * Tidsgräns per körning: max(60 s; 20 × kostnadsmodellen), där kostnaden är
 * 0,25 s + 0,31 ms per rad + 0,6 ms per simulerad timme (map-harness, R² 0,86).
 * Gränsen mäts i FÖRÄLDERN med äkta klocka. Vid överskridande dödas barnet med
 * SIGKILL och körs om EN gång med dubbel gräns; två missar i rad = HÄNG (H2).
 *
 * Resultaten samlas i indexordning oavsett vilket barn som blev klart först.
 *
 * Röktest: node tests/replay-validation/bugHunt/lib/pool.js --smoke
 *          [--smoke-timeout=<ms>]
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hygiene = require('./hygiene');
const signature = require('./signature');

const RUNNER = path.resolve(__dirname, '..', '..', 'replayRunner.js');

const COST_MODEL = Object.freeze({
  basMs: 250, perRadMs: 0.31, perSimTimmeMs: 0.6, faktor: 20, golvMs: 60000,
});
const MAX_BUFFER = 1 << 29;

/** Kostnadsmodellen (ms) för en körning. */
function costModelMs({ rader = 0, simTimmar = 0 } = {}) {
  return COST_MODEL.basMs + (COST_MODEL.perRadMs * rader) + (COST_MODEL.perSimTimmeMs * simTimmar);
}

/** Tidsgränsen (ms) för ett jobb: explicit tidsgränsMs vinner. */
function timeoutMsFor(job) {
  if (Number.isFinite(job.tidsgränsMs) && job.tidsgränsMs > 0) return job.tidsgränsMs;
  return Math.max(COST_MODEL.golvMs, Math.round(COST_MODEL.faktor * costModelMs(job)));
}

/** Rader och simulerade timmar ur en jsonl (för jobb som inte angett dem). */
function jsonlStats(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  let min = Infinity;
  let max = -Infinity;
  for (const line of lines) {
    try {
      const t = JSON.parse(line).aisTimestamp;
      if (Number.isFinite(t)) {
        if (t < min) min = t;
        if (t > max) max = t;
      }
    } catch (e) { /* schemat fångar trasiga rader före skrivning */ }
  }
  return { rader: lines.length, simTimmar: Number.isFinite(min) ? (max - min) / 3.6e6 : 0 };
}

function exitCodeOf(err) {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : null;
}

function execRunner(args, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = execFile(process.execPath, args, {
        env, cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true,
      }, (err, stdout, stderr) => {
        const maxBuffer = !!(err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          ms: Date.now() - t0,
          timedOut: !!(err && err.killed && !maxBuffer),
          maxBuffer,
          exitCode: exitCodeOf(err),
          signal: err ? err.signal || null : null,
          spawnError: null,
        });
      });
    } catch (e) {
      resolve({
        stdout: '', stderr: '', ms: Date.now() - t0, timedOut: false, maxBuffer: false, exitCode: null, signal: null, spawnError: e.message,
      });
    }
    if (child && child.stdin) child.stdin.end();
  });
}

/** Plockar resultat-JSON:en ur markörerna. */
function parseRunnerOutput(stdout) {
  const m = /__REPLAY_JSON__([\s\S]*?)__END__/.exec(stdout || '');
  if (!m) {
    return {
      resultat: null, tolkfel: 'ingen __REPLAY_JSON__-markör', fatal: null, saknarSampel: false,
    };
  }
  let resultat;
  try {
    resultat = JSON.parse(m[1]);
  } catch (e) {
    return {
      resultat: null, tolkfel: `JSON: ${e.message}`, fatal: null, saknarSampel: false,
    };
  }
  if (resultat && resultat.fatal) {
    return {
      resultat: null, tolkfel: null, fatal: String(resultat.fatal), saknarSampel: false,
    };
  }
  if (resultat && resultat.error === 'no samples') {
    return {
      resultat, tolkfel: null, fatal: null, saknarSampel: true,
    };
  }
  return {
    resultat, tolkfel: null, fatal: null, saknarSampel: false,
  };
}

/**
 * stderr → signaturhistogram. H3-rader ([APP ERROR], [FATAL], Unhandled) och
 * övriga rader hålls isär; bara de förra kan ge H3-fynd.
 * @param {string} stderr - barnets stderr
 * @returns {{h3: object, övrigt: object, rader: number, exempel: object}} histogram
 */
function stderrHistogram(stderr) {
  const h3 = {};
  const övrigt = {};
  const exempel = {};
  let rader = 0;
  for (const line of String(stderr || '').split('\n')) {
    if (!line.trim()) continue;
    rader++;
    const sig = signature.stderrSignature(line);
    const target = signature.isH3Line(line) ? h3 : övrigt;
    target[sig] = (target[sig] || 0) + 1;
    if (!exempel[sig]) exempel[sig] = line.slice(0, 400);
  }
  return {
    h3, övrigt, rader, exempel,
  };
}

/**
 * Kör ETT jobb med tidsgräns och en omkörning.
 * @param {object} job - {jsonl, mmsi?, monitoring?, rader?, simTimmar?, tidsgränsMs?, etikett?}
 * @param {{tmpDir: string, baseEnv?: object}} ctx - körningens miljö
 * @returns {Promise<object>} utfall
 */
async function runJob(job, { tmpDir, baseEnv = process.env }) {
  const stats = (Number.isFinite(job.rader) && Number.isFinite(job.simTimmar)) ? job : { ...job, ...jsonlStats(job.jsonl) };
  const limit = timeoutMsFor(stats);
  const args = [RUNNER, job.jsonl];
  if (job.mmsi) args.push(String(job.mmsi));
  const env = hygiene.childEnv(baseEnv, { tmpDir, monitoring: !!job.monitoring });
  const försök = [];
  let out = await execRunner(args, { env, cwd: tmpDir, timeoutMs: limit });
  försök.push({
    ms: out.ms, tidsgränsMs: limit, tidsgräns: out.timedOut, exitkod: out.exitCode, signal: out.signal,
  });
  if (out.timedOut) {
    out = await execRunner(args, { env, cwd: tmpDir, timeoutMs: 2 * limit });
    försök.push({
      ms: out.ms, tidsgränsMs: 2 * limit, tidsgräns: out.timedOut, exitkod: out.exitCode, signal: out.signal,
    });
  }
  const häng = försök.length === 2 && försök[1].tidsgräns;
  const parsed = häng ? {
    resultat: null, tolkfel: null, fatal: null, saknarSampel: false,
  } : parseRunnerOutput(out.stdout);
  const stderr = stderrHistogram(out.stderr);
  const ok = !!parsed.resultat && !parsed.fatal && !parsed.tolkfel && !häng && !parsed.saknarSampel;
  let fel = null;
  if (häng) fel = `HÄNG: ingen markör inom ${limit} ms och ${2 * limit} ms`;
  else if (out.spawnError) fel = `kunde inte starta barnet: ${out.spawnError}`;
  else if (out.maxBuffer) fel = 'utdata översteg maxBuffer';
  else if (parsed.fatal) fel = `replayRunner fatal: ${parsed.fatal}`;
  else if (parsed.tolkfel) fel = `${parsed.tolkfel} (exitkod ${out.exitCode})`;
  else if (parsed.saknarSampel) fel = 'replayRunner: inga sampel (mmsiFilter utan träff?)';
  return {
    etikett: job.etikett || path.basename(job.jsonl),
    jsonl: job.jsonl,
    mmsi: job.mmsi || null,
    monitoring: !!job.monitoring,
    rader: stats.rader,
    simTimmar: stats.simTimmar,
    ok,
    häng,
    fel,
    fatal: parsed.fatal,
    försök,
    ms: försök.reduce((s, f) => s + f.ms, 0),
    resultat: parsed.resultat,
    stderr,
  };
}

/**
 * Kör fn över items med högst `jobs` samtidiga, resultat i indexordning.
 * Med `stop` (nödbromsen --max-minutes) tas inga nya jobb när stop() är
 * sant; de index som aldrig startade blir undefined, och anroparen använder
 * det sammanhängande prefixet.
 * @param {Array} items - indata
 * @param {number} jobs - parallellitet
 * @param {Function} fn - (item, index) => Promise
 * @param {Function} [stop] - () => boolean
 * @returns {Promise<Array>} utdata i indexordning
 */
async function mapPool(items, jobs, fn, stop = null) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (stop && stop()) return;
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, worker));
  return out;
}

class Pool {
  /**
   * @param {{jobb?: number, tmpDir: string, baseEnv?: object}} opts - inställningar
   */
  constructor({ jobb = Math.min(4, os.cpus().length || 1), tmpDir, baseEnv = process.env }) {
    if (!tmpDir) throw new Error('Pool kräver tmpDir');
    this.jobb = Math.max(1, jobb);
    this.tmpDir = tmpDir;
    this.baseEnv = baseEnv;
    this.statistik = {
      körningar: 0, omkörningar: 0, häng: 0, fel: 0, msTotalt: 0,
    };
  }

  async run(job) {
    const res = await runJob(job, { tmpDir: this.tmpDir, baseEnv: this.baseEnv });
    this.statistik.körningar++;
    if (res.försök.length > 1) this.statistik.omkörningar++;
    if (res.häng) this.statistik.häng++;
    if (!res.ok) this.statistik.fel++;
    this.statistik.msTotalt += res.ms;
    return res;
  }

  /**
   * Kör alla jobb; resultat i indexordning.
   * @param {object[]} jobs - jobb
   * @param {{stopp?: Function}} [opts] - nödbroms
   * @returns {Promise<object[]>} utfall
   */
  runAll(jobs, { stopp = null } = {}) {
    return mapPool(jobs, this.jobb, (job) => this.run(job), stopp);
  }
}

// ---------------------------------------------------------------------------
// Röktest
// ---------------------------------------------------------------------------

async function smoke(argv) {
  const timeoutArg = argv.find((a) => a.startsWith('--smoke-timeout='));
  const forcedTimeout = timeoutArg ? Number(timeoutArg.split('=')[1]) : null;
  // eslint-disable-next-line global-require
  const corpora = require('../../corpora');
  const corpus = corpora.find((c) => c.id === '20260525');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-tracker-hunt-smoke-'));
  const pool = new Pool({ jobb: 1, tmpDir });
  let ok = true;
  try {
    if (forcedTimeout !== null) {
      const t = await pool.run({ jsonl: corpus.jsonl, tidsgränsMs: forcedTimeout, etikett: '20260525 (tvingad tidsgräns)' });
      const both = t.försök.length === 2 && t.försök.every((f) => f.tidsgräns);
      console.log(`tvingad tidsgräns ${forcedTimeout} ms: försök ${t.försök.length}, tidsgräns ${t.försök.filter((f) => f.tidsgräns).length}/2, HÄNG ${t.häng ? 'ja' : 'nej'}`);
      if (!both || !t.häng) {
        ok = false;
        console.log('FEL: körningen skulle bokföras som tidsgräns två gånger');
      }
    }
    const r = await pool.run({ jsonl: corpus.jsonl, etikett: '20260525' });
    const sigs = Object.keys(r.stderr.h3);
    const res = r.resultat || {};
    console.log(`20260525: ok ${r.ok}, notificationCount ${res.notificationCount}, openingWarningCount ${res.openingWarningCount}, `
      + `stderr-signaturer [${sigs.join(' | ')}], ${r.ms} ms, tidsgräns ${r.försök[0].tidsgränsMs} ms`);
    if (!r.ok || r.resultat.notificationCount !== 30 || r.resultat.openingWarningCount !== 11 || sigs.length !== 0) {
      ok = false;
      console.log('FEL: förväntat notificationCount 30, openingWarningCount 11 och inga stderr-signaturer');
    }
    console.log(`poolstatistik: ${JSON.stringify(pool.statistik)}`);
  } finally {
    hygiene.removeDir(tmpDir);
  }
  console.log(ok ? 'RÖKTEST GRÖNT' : 'RÖKTEST RÖTT');
  return ok ? 0 : 1;
}

if (require.main === module) {
  if (!process.argv.includes('--smoke')) {
    console.log('Användning: node tests/replay-validation/bugHunt/lib/pool.js --smoke [--smoke-timeout=<ms>]');
    process.exitCode = 1;
  } else {
    smoke(process.argv.slice(2)).then((code) => {
      process.exitCode = code;
    }, (e) => {
      console.error(e.stack || e.message);
      process.exitCode = 2;
    });
  }
}

module.exports = {
  RUNNER,
  COST_MODEL,
  costModelMs,
  timeoutMsFor,
  jsonlStats,
  parseRunnerOutput,
  stderrHistogram,
  runJob,
  mapPool,
  Pool,
};
