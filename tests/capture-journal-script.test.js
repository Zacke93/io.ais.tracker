'use strict';

/**
 * U71 (omgång 9): loggskriptet läker en löpnummerlogg. jsonl blir den läkta
 * fångsten (nummerordning, inga dubbletter), summaryn säger hur många hål
 * som läkts, och ett hål som inte läkts fäller som förut.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { healLogFile } = require('./replay-validation/captureJournal');
const { simulateLog, cutHole, text } = require('./fixtures/journalLogSim');

const ROOT = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(ROOT, 'run-with-logs.sh'), 'utf8');
const MIN = 60000;

function bashFunction(name) {
  const match = script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'));
  if (!match) throw new Error(`Saknad Bash-funktion: ${name}`);
  return match[0];
}

const FUNCTIONS = ['sync_file', 'is_journal_log', 'rebuild_replay_jsonl', 'find_log_holes', 'extract_bridge_text', 'say', 'kill_with_sleep'];

function runFinish(dir, scriptDir) {
  const setup = `
    LIVE_DIR="$AUDIT_DIR/live"; LOGS_DIR="$AUDIT_DIR/arkiv"; SCRIPT_DIR="$AUDIT_SCRIPT_DIR"; TIMESTAMP=ts
    LOGFILE="$LIVE_DIR/app-ts.log"; AIS_REPLAY_FILE="$LIVE_DIR/ais-replay-ts.jsonl"
    BRIDGE_TEXT_SUMMARY="$LIVE_DIR/bridge-text-summary-ts.md"
    FINAL_LOGFILE="$LOGS_DIR/app-ts.log"; FINAL_REPLAY="$LOGS_DIR/ais-replay-ts.jsonl"
    FINAL_SUMMARY="$LOGS_DIR/bridge-text-summary-ts.md"
    EXTRACT_DONE=0; REPLAY_GUARD_PID=""; HOLE_GUARD_PID=""; SYNC_PID=""
  `;
  const r = spawnSync('bash', ['-s'], {
    input: `${FUNCTIONS.map(bashFunction).join('\n')}\n${setup}\nextract_bridge_text\n`,
    env: { ...process.env, AUDIT_DIR: dir, AUDIT_SCRIPT_DIR: scriptDir },
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.error) throw r.error;
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return {
    stdout: r.stdout,
    summary: fs.readFileSync(path.join(dir, 'arkiv', 'bridge-text-summary-ts.md'), 'utf8'),
    jsonl: fs.readFileSync(path.join(dir, 'arkiv', 'ais-replay-ts.jsonl'), 'utf8'),
    state: fs.existsSync(path.join(dir, 'arkiv', 'ais-replay-ts.state.json'))
      ? fs.readFileSync(path.join(dir, 'arkiv', 'ais-replay-ts.state.json'), 'utf8') : null,
  };
}

function sandbox(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u71-script-'));
  fs.mkdirSync(path.join(dir, 'live'));
  fs.mkdirSync(path.join(dir, 'arkiv'));
  fs.writeFileSync(path.join(dir, 'live', 'app-ts.log'), text(lines));
  return dir;
}

// De nio uppmätta hålen: [start i min, längd i s] (k1:s tre inom tio minuter).
const NINE = [[30, 90], [33, 90], [37.25, 156], [90, 90], [160, 88], [200, 90], [250, 90], [310, 180], [380, 79]];
const STATE = '{"version":1,"capturedAt":7,"settings":{"debug_level":"full"}}';

describe('U71: loggskriptet läker en löpnummerlogg', () => {
  const hasBash = process.platform !== 'win32' && fs.existsSync('/bin/bash');
  const maybe = hasBash ? test : test.skip;
  let dirs = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  maybe('de nio uppmätta hålen läks: jsonl som en obruten fångst och summaryn räknar hålen', () => {
    const { lines, startMs } = simulateLog({
      minutes: 420,
      passages: [[20, 60], [150, 190], [300, 330]],
      events: [{ atMin: 0.001, message: `[AIS_REPLAY_STATE] ${STATE}` }],
    });
    const whole = sandbox(lines);
    dirs.push(whole);
    const unbroken = healLogFile(path.join(whole, 'live', 'app-ts.log')).healedSamples;
    let cut = lines;
    for (const [m, s] of NINE) cut = cutHole(cut, startMs + m * MIN + 1, startMs + m * MIN + 1 + s * 1000);
    const dir = sandbox(cut);
    dirs.push(dir);
    const out = runFinish(dir, ROOT);
    expect(out.jsonl).toBe(`${unbroken.join('\n')}\n`);
    expect(out.state).toBe(`${STATE}\n`);
    expect(out.summary).toMatch(/TIDSHÅL FUNNA i loggen — löpnumren avgör/);
    expect(out.summary).toMatch(/\*\*9 tidshål läkta\*\*/);
    expect(out.summary).toMatch(/Logg-integritet: OK\*\* — 9 tidshål läkta ur omsändningarna/);
    expect(out.summary).toMatch(/sampel läkta ur omsändningarna \(U71\)/);
    expect(out.stdout).toMatch(/\[U71\] 9 tidshål i loggen läkta/);
    // Inga dubbletter och nummerordning: simulatorns latitud växer med varje sampel.
    const rows = out.jsonl.trim().split('\n').map((l) => JSON.parse(l).lat);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows.slice().sort((a, b) => a - b)).toEqual(rows);
  });

  maybe('ett hål vars omsändningar också försvann fäller som förut', () => {
    const { lines, startMs } = simulateLog({ minutes: 60, passages: [[10, 40]] });
    const from = startMs + 20 * MIN + 1;
    const to = startMs + 21.5 * MIN;
    const lost = lines.filter((l) => l.t >= from && l.t < to)
      .map((l) => /:(\d+) \[AIS_REPLAY_SAMPLE\]/.exec(l.line)).filter(Boolean).map((m) => m[1]);
    const cut = cutHole(lines, from, to).filter((l) => !lost.some((s) => l.line.includes('[CAPTURE_RESEND]') && l.line.includes(`"seq":${s},`)));
    const dir = sandbox(cut);
    dirs.push(dir);
    const out = runFinish(dir, ROOT);
    expect(out.summary).toMatch(/TIDSHÅL SOM INTE LÄKTS/);
    expect(out.summary).toMatch(/Logg-integritet: FEL/);
    expect(out.stdout).toMatch(/\[INTEGRITET\] Logg-integritet: FEL/);
  });

  maybe('utan node-grinden (SCRIPT_DIR utan verktyg) fäller ett hål som förut', () => {
    const { lines, startMs } = simulateLog({ minutes: 60, passages: [[10, 40]] });
    const dir = sandbox(cutHole(lines, startMs + 20 * MIN + 1, startMs + 21.5 * MIN));
    dirs.push(dir);
    const out = runFinish(dir, dir);
    expect(out.summary).toMatch(/TIDSHÅL FUNNA — körningen är OFULLSTÄNDIG/);
    expect(out.summary).toMatch(/Logg-integritet: FEL/);
  });

  maybe('utan hål: samma jsonl som grep+sed och "obruten tidslinje"', () => {
    const { lines } = simulateLog({ minutes: 60, passages: [[10, 40]] });
    const dir = sandbox(lines);
    dirs.push(dir);
    const out = runFinish(dir, ROOT);
    const grepSed = lines.filter((l) => l.line.includes('AIS_REPLAY_SAMPLE'))
      .map((l) => l.line.replace(/^.*AIS_REPLAY_SAMPLE\] /, ''));
    expect(out.jsonl).toBe(`${grepSed.join('\n')}\n`);
    expect(out.summary).toMatch(/Logg-integritet: OK\*\* — obruten tidslinje/);
  });
});
