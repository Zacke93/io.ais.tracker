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
