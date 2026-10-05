'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const checker = require('./replay-validation/checkReplayIntegrity');

// Raderna modellerar källornas faktiska kontrakt: en poll deklarerar hela
// batchen före emission; hälsoraden räknar bara faktiskt emitterade fixar.
const boot = 'AIS Bridge starting with modular architecture v2.0';
const config = (source = 'both') => `[AIS_MUX] Källkonfiguration: source=${source} aisstream=nyckel satt aishub=username satt`;
const debug = (level) => `Debug level changed to: ${level}`;
const poll = (accepted) => `[AISHUB_POLL] records=${accepted} accepted=${accepted} dupes=0`;
const sample = (id) => `[AIS_REPLAY_SAMPLE] ${JSON.stringify({
  mmsi: String(265000000 + id), lat: 58.28, lon: 12.28, feed: 'aishub',
})}`;
const hub = (accepted, polls) => `[AISHUB_HEALTH] polls=${polls} netErrors=0 accepted=${accepted}`;
const fusion = (accepted) => `[FUSION_HEALTH] fönster: accepted=1 rejected=0 | totalt: accepted=${accepted} rejected=0`;

describe('Replay-integritet: bortfall i själva källoggen', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-source-audit-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function pair(events) {
    const log = path.join(dir, 'app.log');
    const jsonl = path.join(dir, 'ais.jsonl');
    fs.writeFileSync(log, `${events.map((event, i) => `${new Date(Date.UTC(2026, 8, 21, 0, 0, i)).toISOString()} [log] [AISBridgeApp] ${event}`).join('\n')}\n`);
    // Härled JSONL ENBART från de bevarade raderna, precis som skalfångsten.
    const rows = events.filter((event) => event.startsWith('[AIS_REPLAY_SAMPLE] '))
      .map((event) => event.slice('[AIS_REPLAY_SAMPLE] '.length));
    fs.writeFileSync(jsonl, `${rows.join('\n')}\n`);
    return { log, jsonl, result: checker.checkPair(jsonl, log) };
  }

  test('hel bootförankrad fångst: jsonl matchar och båda källkontrollerna balanserar', () => {
    const { result } = pair([
      boot, config(), debug('full'), poll(1), sample(1), hub(1, 1), fusion(1),
      poll(1), sample(2), hub(2, 2), fusion(2),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit).toMatchObject({
      verdict: 'OK', checkedHubReports: 2, checkedFusionWindows: 1, missingPollEmissionsAtLeast: 0,
    });
    expect(result.sourceAudit.gaps).toEqual([]);
  });

  test('två saknade hela batcher fäller även när jsonl och logg är exakt lika', () => {
    const { result, log, jsonl } = pair([
      boot, config(), debug('full'), poll(1), sample(1), hub(1, 1), fusion(1),
      // Pollraden och sampeln för fix 2 har båda tappats i terminalflödet.
      hub(2, 2), fusion(2),
      poll(1), sample(3), hub(3, 3), fusion(3),
      // En till förlust. Bestående underskott får inte räknas om varje fönster.
      hub(4, 4), fusion(4), hub(4, 4), fusion(4),
    ]);
    expect(result.jsonlComplete).toBe(result.logSamples);
    expect(result.notes.join(' ')).toMatch(/alla 2 rader är identiska/);
    expect(result.verdict).toBe('FEL');
    expect(result.sourceAudit.missingPollEmissionsAtLeast).toBe(2);
    const gaps = result.sourceAudit.gaps.filter((gap) => gap.kind === 'missing_poll_rows');
    expect(gaps).toHaveLength(2);
    expect(gaps.map((gap) => gap.missingEmissionsAtLeast)).toEqual([1, 1]);
    expect(gaps.map((gap) => [gap.from.line, gap.to.line])).toEqual([[6, 8], [12, 14]]);
    expect(result.problems.join(' ')).toMatch(/KÄLLOGGEN ÄR OFULLSTÄNDIG/);
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(checker.main(['node', 'checker', jsonl, log, '--brief'])).toBe(1);
      expect(output.mock.calls.flat().join(' ')).toMatch(/korpuslåsning EJ tillåten/);
      expect(output.mock.calls.flat().join(' ')).toMatch(/kontrollpunkterna/);
    } finally {
      output.mockRestore();
    }
  });

  test('batchspridning och senare emission ger inget falskt underskott', () => {
    const { result } = pair([
      boot, config(), poll(3), sample(1), hub(1, 1),
      sample(2), sample(3), hub(3, 1),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.missingPollEmissionsAtLeast).toBe(0);
  });

  test('avsiktligt släppta batchfixar och stoppade timers kan bara ge ett överskott av deklarationer', () => {
    const { result } = pair([
      boot, config(), poll(3), sample(1),
      '[AISHUB_STALE_EMIT] 265000002: fix gammalt vid emission — släpps inte vidare',
      hub(1, 1), poll(1), sample(4), hub(2, 2),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.gaps).toEqual([]);
  });

  test('polls utan råsvar kan vara nätfel eller en pågående request, aldrig ensamt FEL', () => {
    const { result } = pair([
      boot, config(), poll(1), sample(1), hub(1, 2),
      '[AISHUB_CLIENT] Nätverksfel: timeout',
      '[AISHUB_HEALTH] polls=3 netErrors=1 accepted=1',
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.gaps).toEqual([]);
  });

  test('delad logg utan boot ger OKÄNT intern bokföring, aldrig ett uppfunnet bortfall', () => {
    const { result } = pair([config(), poll(1), sample(1), hub(500, 1000), fusion(500)]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.verdict).toBe('OKÄNT');
    expect(result.sourceAudit.checkedHubReports).toBe(0);
    expect(result.problems).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/nollankare/);
  });

  test('ett äldre okänt pollformat får inte tolkas som en borttappad pollrad', () => {
    const { result } = pair([
      boot, config(), poll(1), sample(1), hub(1, 1),
      '[AISHUB_POLL] records=1 acceptedFixes=1', sample(2), hub(2, 2),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.verdict).toBe('OKÄNT');
    expect(result.problems).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/utan läsbart accepted/);
  });

  test('observerad omstart förankrar nya räknare från noll', () => {
    const { result } = pair([
      boot, config(), poll(2), sample(1), sample(2), hub(2, 1), fusion(2),
      boot, config(), poll(1), sample(3), hub(1, 1), fusion(1),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.verdict).toBe('OK');
    expect(result.sourceAudit.checkedHubReports).toBe(2);
  });

  test('en omstart får inte radera ett redan bevisat bortfall från rapporten', () => {
    const { result } = pair([
      boot, config(), poll(1), sample(1), hub(2, 2),
      boot, config(), poll(1), sample(2), hub(1, 1),
    ]);
    expect(result.verdict).toBe('FEL');
    expect(result.sourceAudit.missingPollEmissionsAtLeast).toBe(1);
  });

  test('räknare som minskar utan boot rebaseras utan falskt FEL', () => {
    const { result } = pair([
      boot, config(), poll(5), sample(1), hub(5, 10), fusion(5),
      hub(1, 1), fusion(1), poll(1), sample(2), hub(2, 2), fusion(2),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.verdict).toBe('OKÄNT');
    expect(result.sourceAudit.missingPollEmissionsAtLeast).toBe(0);
    expect(result.notes.join(' ')).toMatch(/nollställda utan observerad boot/);
  });

  test('källbyte/shadow avgränsar bokföringen även när nya räknaren är större än den gamla', () => {
    const { result } = pair([
      boot, config('shadow'), poll(2), sample(1), hub(2, 1),
      config('both'), poll(1), sample(2), hub(5, 3), fusion(20),
      poll(1), sample(3), hub(6, 4), fusion(21),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.verdict).toBe('OKÄNT');
    expect(result.problems).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/Källbyte/);
  });

  test('debug av/på ger ingen falsk fusionförlust över fångstgränsen', () => {
    const { result } = pair([
      boot, config(), debug('full'), poll(1), sample(1), hub(1, 1), fusion(1),
      debug('basic'), poll(1), hub(2, 2), fusion(2),
      debug('full'), poll(1), sample(3), hub(3, 3), fusion(3),
      poll(1), sample(4), hub(4, 4), fusion(4),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.verdict).toBe('OKÄNT');
    expect(result.sourceAudit.gaps).toEqual([]);
    expect(result.sourceAudit.checkedFusionWindows).toBe(1);
  });

  test('filfångst tillåter fusionsjämförelse även vid debug basic', () => {
    const { result } = pair([
      boot, config(), 'AIS Replay initierat (fil + stdout)', debug('basic'),
      poll(1), sample(1), hub(1, 1), fusion(1),
      poll(1), sample(2), hub(2, 2), fusion(2),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.verdict).toBe('OK');
    expect(result.sourceAudit.checkedFusionWindows).toBe(1);
  });

  test('appens valideringsprefilter räknas inte som bevisad loggförlust', () => {
    const { result } = pair([
      boot, config(), debug('full'), poll(1), sample(1), hub(1, 1), fusion(1),
      poll(3), '[AIS_VALIDATION_REJECT] 265000002: message failed validation',
      // Ett avslag loggas per MMSI/5min, så 3 avslag kan ge en enda rad.
      hub(4, 2), fusion(4),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.verdict).toBe('OKÄNT');
    expect(result.sourceAudit.missingPollEmissionsAtLeast).toBe(0);
    expect(result.notes.join(' ')).toMatch(/Valideringsavslag observerade/);
    expect(result.notes.join(' ')).toMatch(/Differensen ensam är inget bevis/);
  });

  test('oförklarad fusiondifferens är diagnostik med OKÄNT, inte hårt FEL', () => {
    const { result } = pair([
      boot, config(), poll(1), sample(1), hub(1, 1), fusion(1),
      poll(1), hub(2, 2), fusion(2),
    ]);
    expect(result.verdict).toBe('OK');
    expect(result.sourceAudit.verdict).toBe('OKÄNT');
    expect(result.problems).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/Fusion\/sampel OKÄNT/);
    expect(result.notes.join(' ')).toMatch(/Fångstläget är inte explicit belagt/);
  });
});
