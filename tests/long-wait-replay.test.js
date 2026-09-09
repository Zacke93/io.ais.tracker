'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateScenario, buildPath, pathMetrics } = require('./replay-validation/scenarioGenerator');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

describe('Lång broväntan genom hela appen, inklusive AIS-tystnad', () => {
  let tempDir;
  let live;
  let silent;
  let stoppedAt;
  let resumedAt;
  let lastFixAt;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-long-wait-test-'));
    const metrics = pathMetrics(buildPath());
    const samples = generateScenario({
      seed: 71,
      vessels: [{
        mmsi: '902009071',
        name: 'LANGVANTARE',
        direction: 'north',
        speedKn: 5,
        jitterM: 0,
        reportIntervalS: 30,
        stopReportIntervalS: 60,
        stop: { atFraction: (metrics.cum[4] - 150) / metrics.total, durationS: 4 * 3600 },
      }],
    });
    stoppedAt = samples.find((sample) => sample.sog < 0.3).aisTimestamp;
    resumedAt = samples.find((sample) => sample.aisTimestamp > stoppedAt && sample.sog >= 0.3).aisTimestamp;
    const beforeSilence = samples.filter((sample) => sample.aisTimestamp <= stoppedAt + 3 * 3600000);
    lastFixAt = beforeSilence.at(-1).aisTimestamp;
    const run = (name, rows) => {
      const input = path.join(tempDir, `${name}.jsonl`);
      fs.writeFileSync(input, rows.map((sample) => JSON.stringify(sample)).join('\n'));
      const stdout = execFileSync(process.execPath, [
        path.join(__dirname, 'replay-validation/replayRunner.js'), input,
      ], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
        },
      });
      return JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]);
    };
    live = run('live', samples);
    silent = run('silent', beforeSilence);
  }, 35000);

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('nya fix på samma koordinater behåller bron efter tre timmars väntan', () => {
    const atThreeHours = live.bridgeTextTransitions.filter((entry) => entry.t <= stoppedAt + 3 * 3600000).at(-1);
    expect(atThreeHours.text).toMatch(/på väg mot Stridsbergsbron|väntar vid Stridsbergsbron/);
    const whileWaiting = live.bridgeTextTransitions.filter((entry) => entry.t >= stoppedAt && entry.t < resumedAt);
    for (const entry of whileWaiting) expect(entry.text).toMatch(/på väg mot Stridsbergsbron|väntar vid Stridsbergsbron/);
    const beforeDeparture = live.bridgeTextTransitions.filter((entry) => entry.t < resumedAt).at(-1);
    expect(beforeDeparture.text).toMatch(/på väg mot Stridsbergsbron|väntar vid Stridsbergsbron/);
    expect(live.targetPassages.filter((passage) => passage.bridge === 'Stridsbergsbron')).toHaveLength(1);
    expect(live.processErrors).toBe(0);
    expect(live.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  });

  test('samma båt tas bort efter AIS-tystnad trots tidigare lång väntan', () => {
    const beforeLoss = silent.bridgeTextTransitions.filter((entry) => entry.t <= lastFixAt).at(-1);
    expect(beforeLoss.text).toMatch(/på väg mot Stridsbergsbron|väntar vid Stridsbergsbron/);
    expect(silent.bridgeTextTransitions.at(-1).text).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    const lastTextAt = silent.bridgeTextTransitions.at(-1).t;
    expect(lastTextAt).toBeGreaterThan(lastFixAt);
    expect(lastTextAt - lastFixAt).toBeLessThanOrEqual(31 * 60000);
    expect(silent.leakDiagnostics.vessels).toBe(0);
    expect(silent.targetPassages.filter((passage) => passage.bridge === 'Stridsbergsbron')).toHaveLength(0);
    expect(silent.processErrors).toBe(0);
  });
});
