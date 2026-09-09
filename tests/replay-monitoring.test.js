'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateScenario } = require('./replay-validation/scenarioGenerator');

describe('Replay med produktionens minutloop och riktig nedstängning', () => {
  let tempDir;
  let baseline;
  let monitored;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-monitoring-test-'));
    const input = path.join(tempDir, 'two-journeys.jsonl');
    const samples = generateScenario({
      seed: 46,
      vessels: [
        {
          mmsi: '902009001', name: 'TIDIG', direction: 'north', speedKn: 5,
        },
        {
          mmsi: '902009002', name: 'SEN', direction: 'south', speedKn: 5, startOffsetS: 8 * 3600,
        },
      ],
      // Omstarten laddar första resans ännu giltiga dedup. Minutloopen
      // måste sedan åldra ut den utan hjälp av en ytterligare omstart.
      events: [{ ctrl: 'restart', atOffsetS: 2 * 3600 }],
    });
    fs.writeFileSync(input, samples.map((sample) => JSON.stringify(sample)).join('\n'));
    const run = (mode) => {
      const stdout = execFileSync(process.execPath, [
        path.join(__dirname, 'replay-validation/replayRunner.js'), input,
      ], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env, REPLAY_MONITORING: mode, REPLAY_FUSION: '0', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
        },
      });
      return JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]);
    };
    baseline = run('0');
    monitored = run('1');
  }, 20000);

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('minutloopen överlever omstart och prunar sex timmar gamla dedupposter', () => {
    expect(monitored.processErrors).toBe(0);
    expect(monitored.runtimeDiagnostics).toMatchObject({ monitoringEnabled: true, monitoringStarts: 2 });
    expect(monitored.runtimeDiagnostics.staleSweeps).toBeGreaterThan(8 * 60);
    expect(monitored.leakDiagnostics.persistentRecentTriggers).toBe(6);
    expect(baseline.leakDiagnostics.persistentRecentTriggers).toBe(12);
    expect(baseline.runtimeDiagnostics).toMatchObject({ monitoringEnabled: false, monitoringStarts: 0, staleSweeps: 0 });
  });

  test('båda resorna ger notiser från samtliga broar och lämnar inga timers efter shutdown', () => {
    for (const result of [baseline, monitored]) {
      expect(result.notificationCount).toBe(12);
      for (const mmsi of ['902009001', '902009002']) {
        expect(result.notifications.filter((notice) => notice.mmsi === mmsi).map((notice) => notice.bridge).sort()).toEqual([
          'Järnvägsbron', 'Kanalinfarten', 'Klaffbron', 'Olidebron', 'Stallbackabron', 'Stridsbergsbron',
        ]);
      }
      expect(result.runtimeDiagnostics).toMatchObject({
        shutdownErrors: 0, timersAfterRestartShutdown: [0], timersAfterShutdown: 0,
      });
      expect(result.leakDiagnostics.vessels).toBe(0);
    }
  });
});
