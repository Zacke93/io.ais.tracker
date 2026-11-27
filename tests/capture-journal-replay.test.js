'use strict';

/**
 * U71 (omgång 9): fångstjournalen ändrar bara loggen. En uppspelning ger
 * bitlika utfall på av och full nivå, med och utan minutloopen, och även när
 * journalen saboteras inifrån (kastande skrivningar, full buffert, kodfel).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateScenario } = require('./replay-validation/scenarioGenerator');

// Processens heap mäts av harnessen och varierar mellan körningar oavsett kod.
function withoutHeap(value) {
  if (Array.isArray(value)) return value.map(withoutHeap);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'heapUsedMB') out[k] = withoutHeap(v);
    return out;
  }
  return value;
}

describe('U71: uppspelningarna är bitlika med fångstjournalen', () => {
  let tempDir;
  const results = {};
  const verbose = {};

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u71-replay-'));
    const input = path.join(tempDir, 'resor.jsonl');
    const samples = generateScenario({
      seed: 71,
      vessels: [
        {
          mmsi: '902071001', name: 'NUMRERAD', direction: 'north', speedKn: 5,
        },
        {
          mmsi: '902071002', name: 'OMSÄND', direction: 'south', speedKn: 4.5, startOffsetS: 1800,
        },
      ],
      events: [{ ctrl: 'restart', atOffsetS: 3 * 3600 }],
    });
    fs.writeFileSync(input, samples.map((s) => JSON.stringify(s)).join('\n'));
    const run = (key, level, monitoring, sabotage) => {
      const args = sabotage ? ['-r', path.join(__dirname, 'fixtures/captureJournalSabotage.js')] : [];
      const r = spawnSync(process.execPath, [...args, path.join(__dirname, 'replay-validation/replayRunner.js'), input], {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          REPLAY_MONITORING: monitoring ? '1' : '0',
          REPLAY_FUSION: '0',
          REPLAY_VERBOSE: level === 'full' ? '1' : '',
          REPLAY_DEBUG_LEVEL: level,
        },
      });
      if (r.error) throw r.error;
      expect(r.status).toBe(0);
      results[key] = withoutHeap(JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(r.stdout)[1]));
      verbose[key] = `${r.stdout}\n${r.stderr}`;
    };
    run('off', 'off', false, false);
    run('full', 'full', false, false);
    run('offMon', 'off', true, false);
    run('fullMon', 'full', true, false);
    run('fullMonSabotage', 'full', true, true);
  }, 120000);

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('scenariot har notiser och omstart (annars prövar testet inget)', () => {
    expect(results.off.notificationCount).toBeGreaterThan(6);
    expect(results.offMon.runtimeDiagnostics.monitoringStarts).toBe(2);
  });

  test('av och full nivå utan minutloop: identiska utfall', () => {
    expect(results.full).toEqual(results.off);
  });

  test('av och full nivå med minutloop: identiska utfall', () => {
    expect(results.fullMon).toEqual(results.offMon);
  });

  test('saboterad journal (kastande skrivning, full buffert, kodfel): identiska utfall', () => {
    expect(results.fullMonSabotage).toEqual(results.offMon);
    expect(results.fullMonSabotage.processErrors).toBe(0);
  });

  test('full nivå med minutloop skriver journalen: original, omsändning och kontrollpunkt', () => {
    const log = verbose.fullMon;
    expect(log).toMatch(/#[0-9a-z]+-1:1 \[CAPTURE_START\] sid=[0-9a-z]+-1 reason=boot/);
    expect(log).toMatch(/#[0-9a-z]+-\d+:\d+ \[AIS_REPLAY_SAMPLE\] \{/);
    expect(log).toMatch(/\[CAPTURE_RESEND\] \{"sid":/);
    expect(log).toMatch(/\[CAPTURE_SEQ\] sid=\S+ seq=\d+ buffered=\d+ dropped=0 errors=0/);
    expect(log).toMatch(/\[CAPTURE_END\] sid=\S+ seq=\d+ dropped=0 errors=0 reason=uninit/);
    // Den saboterade körningen skriver inga journalrader alls (varje skrivning kastar).
    expect(verbose.fullMonSabotage).not.toMatch(/CAPTURE_SEQ|CAPTURE_RESEND|#[0-9a-z]+-\d+:\d+ /);
    expect(verbose.off).not.toMatch(/CAPTURE_|#[0-9a-z]+-\d+:\d+ /);
  });
});
