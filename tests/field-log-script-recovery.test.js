'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = fs.readFileSync(path.join(__dirname, '..', 'run-with-logs.sh'), 'utf8');

// Kör produktfunktionerna utan att starta Homey, bakgrundsvakter eller riktiga loggar.
function bashFunction(name) {
  const match = script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'));
  if (!match) throw new Error(`Saknad Bash-funktion: ${name}`);
  return match[0];
}

function runBash(functions, body, env = {}) {
  const result = spawnSync('bash', ['-s'], {
    input: `${functions.map(bashFunction).join('\n')}\n${body}\n`,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error) throw result.error;
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('Fältloggens mtime på BSD och GNU', () => {
  test('GNU-fallbacken kastar stdout från det misslyckade BSD-anropet', () => {
    const output = runBash(['file_mtime'], `
      stat() {
        if [ "$1" = '-f' ]; then
          printf '  File: "app.log"\\nBlock size: 4096\\n'
          return 1
        fi
        printf '1789725600\\n'
      }
      NOW=1789725901
      MTIME=$(file_mtime app.log) || MTIME=$NOW
      printf '%s\\n' "$((NOW - MTIME))"
    `);
    expect(output).toBe('301\n');
  });

  test('BSD använder filens mtime utan GNU-anrop', () => {
    const output = runBash(['file_mtime'], `
      stat() {
        [ "$1" = '-f' ] || return 1
        printf '1789725600\\n'
      }
      file_mtime app.log
    `);
    expect(output).toBe('1789725600\n');
  });

  test.each(['return 1', "printf 'ogiltigt\\n'"])('otillgänglig mtime ger säker reservtid: %s', (statBody) => {
    const output = runBash(['file_mtime'], `
      stat() { ${statBody}; }
      NOW=1789725901
      MTIME=$(file_mtime app.log) || MTIME=$NOW
      printf '%s\\n' "$((NOW - MTIME))"
    `);
    expect(output).toBe('0\n');
  });
});

describe('Fältloggens tidshål följer kalendern', () => {
  let dir;
  let log;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-log-dates-'));
    log = path.join(dir, 'app.log');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test.each([
    ['180 sekunder är tillåtet', '2026-09-17T12:00:00', '2026-09-17T12:03:00'],
    ['181 sekunder är ett hål', '2026-09-17T12:00:00', '2026-09-17T12:03:01'],
    ['vanlig midnatt', '2026-09-17T23:59:59', '2026-09-18T00:00:01'],
    ['helt saknat dygn', '2026-09-17T23:59:59', '2026-09-19T00:00:01'],
    ['månadsskifte', '2026-04-30T23:59:59', '2026-05-01T00:00:01'],
    ['hål över månadsskifte', '2026-04-30T23:59:59', '2026-05-03T00:00:01'],
    ['februari utan skottdag', '2026-02-28T23:59:59', '2026-03-01T00:00:01'],
    ['saknad skottdag', '2024-02-28T23:59:59', '2024-03-01T00:00:01'],
    ['efter skottdag', '2024-02-29T23:59:59', '2024-03-01T00:00:01'],
    ['sekelskifte utan skottdag', '2100-02-28T23:59:59', '2100-03-01T00:00:01'],
    ['sekelskifte med skottdag', '2000-02-28T23:59:59', '2000-03-01T00:00:01'],
    ['årsskifte', '2026-12-31T23:59:59', '2027-01-01T00:00:01'],
    ['hål över årsskifte', '2026-12-31T23:59:59', '2027-01-02T00:00:01'],
  ])('%s', (_label, start, end) => {
    fs.writeFileSync(log, `${start}.000Z Första rad\n${end}.000Z Andra rad\n`);
    const output = runBash(['find_log_holes'], 'find_log_holes "$AUDIT_LOG"', { AUDIT_LOG: log });
    const elapsed = (Date.parse(`${end}Z`) - Date.parse(`${start}Z`)) / 1000;
    expect(output).toBe(elapsed > 180
      ? `- HÅL: ${start} → ${end} (${elapsed} s utan loggrader)\n` : '');
  });
});

// V4 (fältprovet 2026-11-13): hålgränsen följer monitoringloopens minutslag.
// Där [COORDINATION_CLEANUP] är belagt är gränsen 65 s, annars 180 s som förut.
describe('Fältloggens tidshål följer hjärtslaget', () => {
  let dir;
  let log;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-log-heartbeat-'));
    log = path.join(dir, 'app.log');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const BEAT = '[log] [AISBridgeApp] [DEBUG] 🧹 [COORDINATION_CLEANUP] Cleaned old coordination state';
  const holes = (lines) => {
    fs.writeFileSync(log, `${lines.join('\n')}\n`);
    return runBash(['find_log_holes'], 'find_log_holes "$AUDIT_LOG"', { AUDIT_LOG: log });
  };

  test.each([
    ['65 s efter belagt hjärtslag är tillåtet', '2026-11-13T06:01:05', ''],
    ['66 s efter belagt hjärtslag är ett hål (k2:s 88–90 s-bortfall)', '2026-11-13T06:01:06',
      '- HÅL: 2026-11-13T06:00:00 → 2026-11-13T06:01:06 (66 s utan loggrader)\n'],
  ])('%s', (_label, next, expected) => {
    expect(holes([`2026-11-13T06:00:00.000Z ${BEAT}`, `${next}.000Z [log] nästa rad`])).toBe(expected);
  });

  test('utan hjärtslag gäller 180 s, och boot eller ändrad debugnivå nollar det', () => {
    expect(holes([
      `2026-11-13T06:00:00.000Z ${BEAT}`,
      '2026-11-13T06:00:10.000Z [log] [AISBridgeApp] Debug level changed to: basic',
      '2026-11-13T06:02:40.000Z [log] 150 s senare på basic',
      `2026-11-13T06:02:50.000Z ${BEAT}`,
      '2026-11-13T06:02:51.000Z [log] [AISBridgeApp] AIS Bridge starting with modular architecture v2.0',
      '2026-11-13T06:05:50.000Z [log] 179 s efter boot',
    ])).toBe('');
  });

  // Rev 1 (granskningen 2026-11-14): efter en sänkning till basic låg det
  // sista hjärtslaget kvar i svansen i ungefär ett dygn och gav 65 s.
  test('livevakten följer den sista av hjärtslag, nivåbyte och boot', () => {
    const at = (i, msg) => `${new Date(Date.UTC(2026, 10, 13, 6, 0, i * 30)).toISOString()} [log] [AISBridgeApp] ${msg}`;
    const limit = (lines) => {
      fs.writeFileSync(log, `${lines.join('\n')}\n`);
      return runBash(['current_hole_limit'], 'current_hole_limit "$AUDIT_LOG"', { AUDIT_LOG: log });
    };
    const beats = [1, 2, 3].map((i) => at(i, BEAT.replace('[log] [AISBridgeApp] ', '')));
    const basic = at(4, 'Debug level changed to: basic');
    const later = [5, 6, 7].map((i) => at(i, 'rad på basic-nivå'));
    expect(limit([...beats, basic, ...later])).toBe('180\n');
    expect(limit([...beats, at(4, 'AIS Bridge starting with modular architecture v2.0'), ...later])).toBe('180\n');
    expect(limit([...beats, basic, at(5, BEAT.replace('[log] [AISBridgeApp] ', ''))])).toBe('65\n');
  });

  test('millisekunderna räknas: 65,5 s efter hjärtslaget är ett hål, som i node-grinden', () => {
    expect(holes([`2026-11-13T06:00:00.000Z ${BEAT}`, '2026-11-13T06:01:05.500Z [log] nästa rad']))
      .toBe('- HÅL: 2026-11-13T06:00:00 → 2026-11-13T06:01:05 (66 s utan loggrader)\n');
    expect(holes([`2026-11-13T06:00:00.500Z ${BEAT}`, '2026-11-13T06:01:05.400Z [log] nästa rad'])).toBe('');
  });

  test('livevaktens gräns läses ur loggens svans', () => {
    fs.writeFileSync(log, `2026-11-13T06:00:00.000Z ${BEAT}\n`);
    expect(runBash(['current_hole_limit'], 'current_hole_limit "$AUDIT_LOG"', { AUDIT_LOG: log })).toBe('65\n');
    fs.writeFileSync(log, '2026-11-13T06:00:00.000Z [log] inget hjärtslag\n');
    expect(runBash(['current_hole_limit'], 'current_hole_limit "$AUDIT_LOG"', { AUDIT_LOG: log })).toBe('180\n');
  });

  test('terminalutskriften fäller inte nedstängningen när terminalen är borta', () => {
    // Stdout går inte att skriva till (som en terminal som försvunnit vid
    // utloggningen). say ska lyckas tyst så att nedstängningen fortsätter,
    // och texten får inte hänga kvar i bash stdout-buffert och dyka upp i
    // nästa fil som skrivs med omdirigering (i nedstängningen: summaryn).
    const out = path.join(dir, 'status');
    runBash(['say'], `
      ( exec 1</dev/null; say "till en död terminal"; printf 'say=%s\\n' "$?" >"$AUDIT_OUT" )
    `, { AUDIT_OUT: out });
    expect(fs.readFileSync(out, 'utf8')).toBe('say=0\n');
  });
});

// V4 (fältprovet 2026-11-13): körning 2 dödades av en macOS-utloggning efter
// summaryn men före slutsynken, och arkivet saknade loggens och jsonl:ens
// svans. Logg och jsonl ska ligga i arkivet INNAN den långsamma summaryn
// börjar, och summaryn ska redovisa synken.
describe('Nedstängningen synkar arkivet före summaryn', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-log-finish-'));
    fs.mkdirSync(path.join(dir, 'live'));
    fs.mkdirSync(path.join(dir, 'arkiv'));
    const lines = [
      '2026-11-13T18:00:00.000Z [log] [AISBridgeApp] AIS Bridge starting with modular architecture v2.0',
    ];
    for (let i = 1; i <= 6; i += 1) {
      const t = new Date(Date.UTC(2026, 10, 13, 18, 0, i * 30)).toISOString();
      lines.push(`${t} [log] [AISBridgeApp] [DEBUG] 🧹 [COORDINATION_CLEANUP] Cleaned old coordination state`);
      lines.push(`${t} [log] [AISBridgeApp] [AIS_REPLAY_SAMPLE] {"mmsi":"265012090","n":${i}}`);
      lines.push(`${t} [log] [AISBridgeApp] 📱 [UI_UPDATE] Bridge text updated: "Inga båtar ${i}"`);
    }
    fs.writeFileSync(path.join(dir, 'live', 'app-ts.log'), `${lines.join('\n')}\n`);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const setup = `
    LIVE_DIR="$AUDIT_DIR/live"; LOGS_DIR="$AUDIT_DIR/arkiv"; SCRIPT_DIR="$AUDIT_DIR"; TIMESTAMP=ts
    LOGFILE="$LIVE_DIR/app-ts.log"; AIS_REPLAY_FILE="$LIVE_DIR/ais-replay-ts.jsonl"
    BRIDGE_TEXT_SUMMARY="$LIVE_DIR/bridge-text-summary-ts.md"
    FINAL_LOGFILE="$LOGS_DIR/app-ts.log"; FINAL_REPLAY="$LOGS_DIR/ais-replay-ts.jsonl"
    FINAL_SUMMARY="$LOGS_DIR/bridge-text-summary-ts.md"
    EXTRACT_DONE=0; REPLAY_GUARD_PID=""; HOLE_GUARD_PID=""; SYNC_PID=""
  `;
  // \`say\` finns från V4; funktionerna i övrigt fanns före.
  const functions = ['sync_file', 'rebuild_replay_jsonl', 'find_log_holes', 'extract_bridge_text']
    .concat(/^say\(\) \{/m.test(script) ? ['say'] : []);

  test('dödad mitt i summaryn: arkivets logg och jsonl är ändå kompletta', () => {
    // nl körs i summaryns brotextlista; SIGKILL där motsvarar utloggningen.
    const result = spawnSync('bash', ['-s'], {
      input: `${functions.map(bashFunction).join('\n')}\n${setup}\nnl() { kill -KILL $$; }\nextract_bridge_text\n`,
      env: { ...process.env, AUDIT_DIR: dir },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.signal).toBe('SIGKILL');
    const live = fs.readFileSync(path.join(dir, 'live', 'app-ts.log'));
    expect(fs.readFileSync(path.join(dir, 'arkiv', 'app-ts.log')).equals(live)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'arkiv', 'ais-replay-ts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(6);
    expect(fs.existsSync(path.join(dir, 'live', 'bridge-text-summary-ts.md'))).toBe(false);
  });

  test('normal nedstängning: summaryn byts in hel, redovisar synken och synkas sist', () => {
    const out = runBash(functions, `${setup}\nextract_bridge_text`, { AUDIT_DIR: dir });
    expect(out).toMatch(/arkivsynk: OK/);
    const summary = fs.readFileSync(path.join(dir, 'arkiv', 'bridge-text-summary-ts.md'), 'utf8');
    expect(summary).toMatch(/## Arkivsynk/);
    expect(summary).toMatch(/före summaryn: \*\*OK\*\*/);
    expect(summary).toMatch(/Logg-integritet: OK/);
    expect(fs.readdirSync(path.join(dir, 'live')).filter((n) => n.startsWith('.'))).toEqual([]);
  });
});

describe('Misslyckad replay-extraktion bevarar senast hela filer', () => {
  let dir;
  let jsonl;
  let state;
  const originalJsonl = '{"mmsi":"265552060","ts":1}\n';
  const originalState = '{"version":1,"capturedAt":1,"settings":{}}\n';
  const newSample = '{"mmsi":"265552060","ts":2}';
  const newState = '{"version":1,"capturedAt":2,"settings":{}}';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-log-extract-'));
    jsonl = path.join(dir, 'ais-replay-audit.jsonl');
    state = path.join(dir, 'ais-replay-audit.state.json');
    fs.writeFileSync(jsonl, originalJsonl);
    fs.writeFileSync(state, originalState);
    fs.writeFileSync(path.join(dir, 'app.log'), [
      `[AIS_REPLAY_STATE] ${newState}`,
      `[AIS_REPLAY_SAMPLE] ${newSample}`,
      '[AIS_REPLAY_STATE] {"version":1,"capturedAt":3,"settings":{}}',
      '',
    ].join('\n'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function rebuild(stub = '') {
    runBash(['rebuild_replay_jsonl'], `
      LIVE_DIR="$AUDIT_DIR"
      LOGFILE="$AUDIT_DIR/app.log"
      TIMESTAMP=audit
      AIS_REPLAY_FILE="$AUDIT_DIR/ais-replay-audit.jsonl"
      ${stub}
      rebuild_replay_jsonl
    `, { AUDIT_DIR: dir });
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.'))).toEqual([]);
  }

  test('hela sampel och första starttillståndet ersätter tidigare filer', () => {
    rebuild();
    expect(fs.readFileSync(jsonl, 'utf8')).toBe(`${newSample}\n`);
    expect(fs.readFileSync(state, 'utf8')).toBe(`${newState}\n`);
  });

  test('inga grep-träffar ger tom jsonl och bevarar ett befintligt starttillstånd', () => {
    fs.writeFileSync(path.join(dir, 'app.log'), 'Appen har ännu inte levererat sampel\n');
    rebuild();
    expect(fs.readFileSync(jsonl, 'utf8')).toBe('');
    expect(fs.readFileSync(state, 'utf8')).toBe(originalState);
  });

  test.each([
    ['sed misslyckas efter delvis skriven rad', 'sed() { cat >/dev/null; printf \'{"ts":\'; return 1; }'],
    ['sed misslyckas före första skrivningen', 'sed() { cat >/dev/null; return 1; }'],
    ['grep misslyckas efter en match', 'grep() { printf \'%s\\n\' \'[AIS_REPLAY_SAMPLE] {"ts":2}\'; return 2; }'],
  ])('%s', (_label, stub) => {
    rebuild(stub);
    expect(fs.readFileSync(jsonl, 'utf8')).toBe(originalJsonl);
    expect(fs.readFileSync(state, 'utf8')).toBe(originalState);
  });
});

// Revision 1 av V4 (granskningen 2026-11-14): när Terminal stängs kommer
// skriptet till raden efter `wait "$PIPE_PID"` med en död terminal. En
// inbyggd echo/printf dit misslyckas, och bash 3.2 behåller texten i sin
// stdout-buffert. Nästa gaffling (en kommandosubstitution) ärver bufferten
// och skriver ut den i sitt värde: i sync_file fick temp-sökvägen skräptext,
// slutsynken blev FEL och arkivet saknade logg och jsonl. Regeln: på alla
// vägar som kan köras med död terminal går terminalutskrift via say (extern
// printf), och övriga echo/printf skriver till en fil.
describe('Ingen inbyggd terminalskrivning där terminalen kan vara död', () => {
  // Skriptets sista rader: allt efter huvudflödets `wait "$PIPE_PID"` (inte
  // stop_capture:s wait, som står tidigare).
  const MAIN_WAIT = '\nwait "$PIPE_PID"\n';
  const mainTail = () => {
    const at = script.lastIndexOf(MAIN_WAIT);
    if (at < 0) throw new Error('Huvudflödets wait saknas');
    return script.slice(at + MAIN_WAIT.length);
  };
  const code = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const regions = () => {
    const out = [];
    const tail = mainTail();
    out.push(['efter wait "$PIPE_PID"', tail]);
    for (const name of ['finish_run', 'shutdown_and_exit', 'stop_capture', 'extract_bridge_text',
      'cleanup_run_tempfiles', 'sync_file', 'rebuild_replay_jsonl']) {
      out.push([name, bashFunction(name)]);
    }
    for (const [label, start, end] of [
      ['REPLAY-VAKT', '(\n  sleep 120\n', 'REPLAY_GUARD_PID=$!'],
      ['HÅLVAKT', '(\n  sleep 240\n', 'HOLE_GUARD_PID=$!'],
      ['periodisk synk', '(\n  ticks=0\n', 'SYNC_PID=$!'],
    ]) {
      const from = script.indexOf(start);
      const to = script.indexOf(end, from);
      if (from < 0 || to < 0) throw new Error(`Saknat block: ${label}`);
      out.push([label, script.slice(from, to)]);
    }
    return out;
  };

  test('echo och printf skriver bara till filer; terminalen nås via say', () => {
    const offenders = [];
    for (const [label, text] of regions()) {
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('#')) continue;
        if (!/(^|[;&|(]\s*)(echo|printf)\b/.test(line)) continue;
        if (/>>?\s*"\$[A-Z_]+"/.test(line)) continue;
        offenders.push(`${label}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('sync_file bygger temp-sökvägen utan kommandosubstitution', () => {
    expect(code(bashFunction('sync_file'))).not.toMatch(/\$\((dirname|basename)\b/);
    expect(code(bashFunction('extract_bridge_text'))).not.toMatch(/\$\((dirname|basename)\b/);
  });

  // Granskarens prov i miniatyr: en riktig pty vars master stängs medan
  // skriptets sista rader och nedstängningen körs. Kräver python3 (pty).
  const hasPty = process.platform !== 'win32'
    && spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0;
  (hasPty ? test : test.skip)('stängd terminal: logg och jsonl hamnar i arkivet och summaryn är ren', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-log-deadtty-'));
    try {
      fs.mkdirSync(path.join(dir, 'live'));
      fs.mkdirSync(path.join(dir, 'arkiv'));
      const lines = ['2026-11-13T18:00:00.000Z [log] [AISBridgeApp] AIS Bridge starting with modular architecture v2.0'];
      for (let i = 1; i <= 6; i += 1) {
        const t = new Date(Date.UTC(2026, 10, 13, 18, 0, i * 30)).toISOString();
        lines.push(`${t} [log] [AISBridgeApp] [DEBUG] 🧹 [COORDINATION_CLEANUP] Cleaned old coordination state`);
        lines.push(`${t} [log] [AISBridgeApp] [AIS_REPLAY_SAMPLE] {"mmsi":"265012090","n":${i}}`);
        lines.push(`${t} [log] [AISBridgeApp] 📱 [UI_UPDATE] Bridge text updated: "Inga båtar ${i}"`);
      }
      fs.writeFileSync(path.join(dir, 'live', 'app-ts.log'), `${lines.join('\n')}\n`);
      const fns = ['say', 'sync_file', 'rebuild_replay_jsonl', 'find_log_holes', 'extract_bridge_text',
        'cleanup_run_tempfiles', 'stop_capture', 'finish_run'].map(bashFunction).join('\n');
      // Skriptets egna rader efter wait, ordagrant, följda av EXIT-trap:ens finish_run.
      const tail = mainTail();
      const payload = `${fns}
        LIVE_DIR="$AUDIT_DIR/live"; LOGS_DIR="$AUDIT_DIR/arkiv"; SCRIPT_DIR="$AUDIT_DIR"; TIMESTAMP=ts
        LOGFILE="$LIVE_DIR/app-ts.log"; AIS_REPLAY_FILE="$LIVE_DIR/ais-replay-ts.jsonl"
        BRIDGE_TEXT_SUMMARY="$LIVE_DIR/bridge-text-summary-ts.md"
        FINAL_LOGFILE="$LOGS_DIR/app-ts.log"; FINAL_REPLAY="$LOGS_DIR/ais-replay-ts.jsonl"
        FINAL_SUMMARY="$LOGS_DIR/bridge-text-summary-ts.md"
        EXTRACT_DONE=0; REPLAY_GUARD_PID=""; HOLE_GUARD_PID=""; SYNC_PID=""; PIPE_PID=""; APP_PID=""
        trap '' HUP
        while [ ! -e "$AUDIT_DIR/stangd" ]; do sleep 0.05; done
        ${tail}
        finish_run
        : > "$AUDIT_DIR/klar"
      `;
      const harness = `
import os, pty, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvpe('/bin/bash', ['/bin/bash', '-c', sys.argv[1]], os.environ)
time.sleep(0.3)
os.close(fd)
open(os.path.join(os.environ['AUDIT_DIR'], 'stangd'), 'w').close()
os.waitpid(pid, 0)
`;
      const r = spawnSync('python3', ['-c', harness, payload], {
        env: { ...process.env, AUDIT_DIR: dir }, encoding: 'utf8', timeout: 20000,
      });
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(dir, 'klar'))).toBe(true);
      const live = fs.readFileSync(path.join(dir, 'live', 'app-ts.log'));
      expect(fs.existsSync(path.join(dir, 'arkiv', 'app-ts.log'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'arkiv', 'app-ts.log')).equals(live)).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'arkiv', 'ais-replay-ts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(6);
      const summary = fs.readFileSync(path.join(dir, 'arkiv', 'bridge-text-summary-ts.md'), 'utf8');
      expect(summary).toMatch(/före summaryn: \*\*OK\*\*/);
      expect(summary).not.toMatch(/Loggar sparade i/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
