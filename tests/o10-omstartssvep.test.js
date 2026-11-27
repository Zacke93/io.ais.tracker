'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  variantRow, strictErrors, compareSweeps, restartPoints, parseArgs,
} = require('./replay-validation/runRestartSweep');

/**
 * Omgång 10, spår O: omstartssvepet (runRestartSweep.js) och omstarten med
 * paus i replayRunner.js (REPLAY_RESTART_AT, REPLAY_RESTART_PAUSE_MS, REPLAY_RESTART_MODE).
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
    const r = replay({ REPLAY_RESTART_AT: String(at), REPLAY_RESTART_PAUSE_MS: '120000' });
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
    const r = replay({ REPLAY_RESTART_AT: String(at), REPLAY_RESTART_PAUSE_MS: '120000', REPLAY_RESTART_MODE: 'hard' });
    expect(r.restart.mode).toBe('hard');
    expect(r.runtimeDiagnostics.timersAfterRestartShutdown).toEqual([0]);
  });
});

describe('omstartssvepets jämförelse (strängt mått)', () => {
  const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);
  const MIN = 60000;
  const samples = [{ mmsi: '1', aisTimestamp: T0 + 300 * MIN }];
  const plan = {
    at: T0, pauseMs: 2 * MIN, mode: 'graceful', horizonMs: 180 * MIN,
  };
  const w = (t, bridge, mmsis) => ({
    t, bridge, mmsis, success: true,
  });
  const n = (t, mmsi, bridge, direction, message = 'närmar sig') => ({
    t, mmsi, bridge, direction, message, success: true,
  });
  const boat = 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter';
  const bas = {
    openingWarnings: [w(T0 + 15 * MIN, 'Klaffbron', ['1']), w(T0 + 40 * MIN, 'Stridsbergsbron', ['1'])],
    notifications: [n(T0 + 15 * MIN, '1', 'Klaffbron', 'northbound'), n(T0 + 30 * MIN, '1', 'Järnvägsbron', 'northbound')],
    bridgeTextTransitions: [{ t: T0 - MIN, text: boat }],
    targetPassages: [{ t: T0 + 50 * MIN, mmsi: '1', bridge: 'Stridsbergsbron' }],
  };

  test('utebliven, extra, fel riktning och fel tid; varning utebliven, ny och sen; text; för tidig "passerade"', () => {
    const vari = {
      openingWarnings: [w(T0 + 25 * MIN, 'Klaffbron', ['1']), w(T0 + 90 * MIN, 'Klaffbron', ['2'])],
      notifications: [
        n(T0 + 15 * MIN, '1', 'Klaffbron', 'southbound'),
        n(T0 + 36 * MIN, '1', 'Järnvägsbron', 'northbound'),
        n(T0 + 37 * MIN, '1', 'Stridsbergsbron', 'northbound', 'passerade Stridsbergsbron under AIS-tystnad'),
      ],
      bridgeTextTransitions: [
        { t: T0 - MIN, text: boat },
        { t: T0 + 2 * MIN, text: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron' },
        { t: T0 + 5 * MIN, text: boat },
      ],
    };
    const row = variantRow(bas, vari, plan, samples);
    const e = strictErrors(bas, row);
    expect(e.notis.map((x) => x.split(' ')[0] + (x.includes('riktning') ? '-riktning' : ''))).toEqual(
      expect.arrayContaining(['fel-riktning', 'fel', 'extra']),
    );
    expect(e.notis.some((x) => x.startsWith('fel tid'))).toBe(true);
    expect(e.varning.some((x) => x.startsWith('varning fel tid'))).toBe(true);
    expect(e.varning.some((x) => x.startsWith('utebliven varning Stridsbergsbron'))).toBe(true);
    expect(e.varning.some((x) => x.startsWith('ny varning'))).toBe(true);
    expect(e.tomS).toBe(180);
    expect(e.fortida).toHaveLength(1);
  });

  test('motfall: samma utfall som basen ger inga fel', () => {
    const e = strictErrors(bas, variantRow(bas, bas, plan, samples));
    expect(e.notis.length + e.varning.length + e.textS + e.fortida.length).toBe(0);
  });

  test('två svep i samma punkter: sämre, bättre och lika räknas som granskarens mått', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o10-svep-'));
    const write = (name, rows) => {
      fs.mkdirSync(path.join(root, name, 'k'), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'k', 'bas.json'), JSON.stringify(bas));
      fs.writeFileSync(path.join(root, name, 'k', 'varianter.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
    };
    const good = { ...variantRow(bas, bas, plan, samples), lage: 'raster' };
    const bad = { ...variantRow(bas, { ...bas, notifications: [] }, plan, samples), lage: 'raster' };
    const at2 = { ...good, at: T0 + MIN };
    write('a', [good, { ...bad, at: T0 + MIN }, { ...good, at: T0 + 2 * MIN }]);
    write('b', [bad, at2, { ...good, at: T0 + 2 * MIN }]);
    const { tot } = compareSweeps(path.join(root, 'a'), path.join(root, 'b'));
    fs.rmSync(root, { recursive: true, force: true });
    expect(tot).toMatchObject({
      rader: 3, samre: 1, battre: 1, lika: 1,
    });
  });

  test('rastret och flaggorna', () => {
    const o = parseArgs(['--raster=30']);
    const pts = restartPoints({}, [{ aisTimestamp: T0 }, { aisTimestamp: T0 + 100 * MIN }], o);
    expect(pts.map((p) => (p.at - T0) / MIN)).toEqual([15, 45, 75]);
    expect(() => parseArgs(['--modes=snabb'])).toThrow();
    expect(parseArgs(['--compare=a,b']).compare).toHaveLength(2);
  });
});
