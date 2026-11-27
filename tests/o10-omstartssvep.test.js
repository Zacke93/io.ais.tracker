'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { compareRestart, restartPoints, parseArgs } = require('./replay-validation/runRestartSweep');

/**
 * Omgång 10, spår O: omstartssvepet (runRestartSweep.js) och omstarten med
 * paus i replayRunner.js (RESTART_AT, RESTART_PAUSE_MS, RESTART_MODE).
 */
const CORPUS = path.join(__dirname, 'replay-validation', 'corpora-data', 'ais-replay-20260611-115443.jsonl');
const DEFAULT_TEXT = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';

function replay(env = {}) {
  const stdout = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation', 'replayRunner.js'), CORPUS], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const i = stdout.lastIndexOf('__REPLAY_JSON__');
  return JSON.parse(stdout.slice(i + '__REPLAY_JSON__'.length, stdout.lastIndexOf('__END__')));
}

describe('omstart med paus i replayRunner', () => {
  const rows = fs.readFileSync(CORPUS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const at = rows[4].aisTimestamp + 1000;

  test('utan variablerna ingen omstart och inget omstartsfält', () => {
    const r = replay();
    expect(r.restart).toBeUndefined();
    expect(r.runtimeDiagnostics.timersAfterRestartShutdown).toEqual([]);
  });

  test('ordnad omstart: raderna i pausen tappas, enheten skriver "Inga båtar", inga timers kvar', () => {
    const r = replay({ RESTART_AT: String(at), RESTART_PAUSE_MS: '120000' });
    expect(r.restart.mode).toBe('graceful');
    const dropped = rows.filter((s) => s.aisTimestamp >= at && s.aisTimestamp < at + 120000).length;
    expect(r.restart.droppedDuringPause).toBe(dropped);
    expect(r.restart.textAfterInit).toBe(DEFAULT_TEXT);
    expect(r.runtimeDiagnostics.timersAfterRestartShutdown).toEqual([0]);
    expect(r.processErrors).toBe(0);
    // O1: den levande båten sparas av onUninit.
    expect(Object.keys(r.restart.settingsChangedByUninit)).toContain('last_known_positions');
  });

  test('hård omstart: det onUninit skrev kastas (samma omstart, läget bokfört)', () => {
    const r = replay({ RESTART_AT: String(at), RESTART_PAUSE_MS: '120000', RESTART_MODE: 'hard' });
    expect(r.restart.mode).toBe('hard');
    expect(r.runtimeDiagnostics.timersAfterRestartShutdown).toEqual([0]);
  });
});

describe('omstartssvepets jämförelse', () => {
  const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);
  const MIN = 60000;
  const samples = [
    { mmsi: '1', aisTimestamp: T0 + 5 * MIN },
    { mmsi: '1', aisTimestamp: T0 + 20 * MIN },
    { mmsi: '2', aisTimestamp: T0 + 90 * MIN },
  ];
  const plan = {
    at: T0, pauseMs: 2 * MIN, horizonMs: 180 * MIN,
  };
  const w = (t, bridge, mmsis) => ({
    t, bridge, mmsis, success: true,
  });
  const n = (t, mmsi, bridge) => ({
    t, mmsi, bridge, success: true, message: 'x',
  });

  test('utebliven varning för en båt som hördes i tid, dubbel varning och extra notis', () => {
    const bas = {
      openingWarnings: [w(T0 - 10 * MIN, 'Klaffbron', ['2']), w(T0 + 15 * MIN, 'Klaffbron', ['1'])],
      notifications: [n(T0 + 15 * MIN, '1', 'Klaffbron')],
      bridgeTextTransitions: [{ t: T0 - MIN, text: 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter' }],
    };
    const vari = {
      openingWarnings: [w(T0 + 30 * MIN, 'Klaffbron', ['2'])],
      notifications: [n(T0 + 15 * MIN, '1', 'Klaffbron'), n(T0 + 16 * MIN, '1', 'Klaffbron')],
      bridgeTextTransitions: [
        { t: T0 - MIN, text: 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter' },
        { t: T0 + 2 * MIN, text: DEFAULT_TEXT },
        { t: T0 + 5 * MIN, text: 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter' },
      ],
    };
    const r = compareRestart(bas, vari, plan, samples);
    expect(r.varningUtHord).toBe(1);
    expect(r.varningDubbel).toBe(1);
    expect(r.notisExtra).toBe(1);
    expect(r.tomS).toBe(180);
  });

  test('motfall: samma utfall som basen ger inga avvikelser', () => {
    const bas = {
      openingWarnings: [w(T0 + 15 * MIN, 'Klaffbron', ['1'])],
      notifications: [n(T0 + 15 * MIN, '1', 'Klaffbron')],
      bridgeTextTransitions: [],
    };
    const r = compareRestart(bas, bas, plan, samples);
    expect(r.varningUtHord + r.varningUtTyst + r.varningUtPaus + r.varningNy + r.varningDubbel + r.notisExtra).toBe(0);
  });

  test('rastret och flaggorna', () => {
    const o = parseArgs(['--raster=30']);
    const pts = restartPoints({}, [{ aisTimestamp: T0 }, { aisTimestamp: T0 + 100 * MIN }], o);
    expect(pts.map((p) => (p.at - T0) / MIN)).toEqual([15, 45, 75]);
    expect(() => parseArgs(['--modes=snabb'])).toThrow();
  });
});
