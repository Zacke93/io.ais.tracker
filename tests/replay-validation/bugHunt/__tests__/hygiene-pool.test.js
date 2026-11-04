'use strict';

/**
 * Buggjägaren steg 1: hygien och poolens rena delar (tidsgränsmodellen,
 * markörtolkningen, stderr-histogrammet, flaggtolkningen). Inga barnprocesser,
 * inga git-anrop och inga timers.
 */

describe('buggjägaren: hygien', () => {
  test('miljöskrubbet tar bort designens prefix och exakta namn men inget annat', () => {
    const { scrubEnv } = require('../lib/hygiene');
    const { env, borttagna } = scrubEnv({
      PATH: '/bin',
      HOME: '/h',
      REPLAY_MONITORING: '1',
      REPLAY_FUSION: '1',
      AIS_REPLAY_CAPTURE_FILE: 'x',
      AISHUB_POLL_CAPTURE_FILE: 'x',
      REGEN_DISTRIBUTIONS: '1',
      GT_PASSAGES_DIR: '/x',
      ETA_MEASURE_CAPTURE: '1',
      PHASE_SWEEP_X: '1',
      SOAK_HOURS: '1',
      OPENING_GATES_X: '1',
      OPENING_GT_X: '1',
      FUSION_PASS: '1',
      INV21_GT: '0',
      AIS_BRIDGE_SELFTEST: '1',
      NODE_ENV: 'test',
      REPLAYX: 'behålls',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'REPLAYX']);
    expect(borttagna).toHaveLength(15);
  });

  test('barnmiljön får egen TMPDIR och monitoring bara på begäran', () => {
    const { childEnv } = require('../lib/hygiene');
    const a = childEnv({ PATH: '/bin', REPLAY_MONITORING: '1' }, { tmpDir: '/t' });
    expect(a).toEqual({
      PATH: '/bin', TMPDIR: '/t', TMP: '/t', TEMP: '/t',
    });
    expect(childEnv({}, { tmpDir: '/t', monitoring: true }).REPLAY_MONITORING).toBe('1');
  });

  test('git-vakten jämför porcelain före och efter; utan git kontrolleras inget', () => {
    const { compareGit } = require('../lib/hygiene');
    const före = { finns: true, porcelain: ' M app.js\n' };
    expect(compareGit(före, { porcelain: ' M app.js\n' })).toEqual({ ok: true, kontrollerad: true, skillnad: [] });
    const ändrad = compareGit(före, { porcelain: ' M app.js\n?? tests/ny.jsonl\n' });
    expect(ändrad.ok).toBe(false);
    expect(ändrad.skillnad).toEqual(['+ ?? tests/ny.jsonl']);
    expect(compareGit({ finns: false, porcelain: null }, null).kontrollerad).toBe(false);
  });

  test('stämpel, körnings-id och isInside', () => {
    const h = require('../lib/hygiene');
    expect(h.stamp(new Date(2026, 10, 4, 5, 7, 9))).toBe('20261104-050709');
    const id = h.runIdOf({
      sha: 'abc', kalibrering: 'k', motorversion: '1', profil: 'quick', seed: 1,
    });
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(h.runIdOf({
      sha: 'abc', kalibrering: 'k', motorversion: '1', profil: 'quick', seed: 2,
    })).not.toBe(id);
    expect(h.isInside('/a/b/c', '/a/b')).toBe(true);
    expect(h.isInside('/a/bc', '/a/b')).toBe(false);
  });
});

describe('buggjägaren: poolens rena delar', () => {
  test('tidsgränsen är max(60 s; 20 × kostnadsmodellen)', () => {
    const pool = require('../lib/pool');
    expect(pool.timeoutMsFor({ rader: 244, simTimmar: 18.9 })).toBe(60000);
    // 200 000 rader: 20 × (250 + 62 000 + 6) ms ≈ 1 246 s.
    expect(pool.timeoutMsFor({ rader: 200000, simTimmar: 10 })).toBe(Math.round(20 * (250 + 0.31 * 200000 + 0.6 * 10)));
    expect(pool.timeoutMsFor({ tidsgränsMs: 5 })).toBe(5);
  });

  test('markörtolkningen skiljer resultat, fatal, inga sampel och trasig utdata', () => {
    const { parseRunnerOutput } = require('../lib/pool');
    expect(parseRunnerOutput('x__REPLAY_JSON__{"notificationCount":3}__END__\n').resultat).toEqual({ notificationCount: 3 });
    expect(parseRunnerOutput('__REPLAY_JSON__{"fatal":"boom"}__END__').fatal).toBe('boom');
    expect(parseRunnerOutput('__REPLAY_JSON__{"error":"no samples"}__END__').saknarSampel).toBe(true);
    expect(parseRunnerOutput('inget').tolkfel).toMatch(/ingen __REPLAY_JSON__/);
    expect(parseRunnerOutput('__REPLAY_JSON__{trasig__END__').tolkfel).toMatch(/^JSON:/);
  });

  test('stderr-histogrammet håller isär H3-rader och övriga rader', () => {
    const { stderrHistogram } = require('../lib/pool');
    const h = stderrHistogram([
      '[APP ERROR] 🚨 [GPS_JUMP] 265035480: GPS jump detected 583m',
      '[APP ERROR] 🚨 [GPS_JUMP] 211593250: GPS jump detected 612m',
      'Unhandled rejection: x',
      '[REPLAY] GLOBAL_TOKEN_DELIVERY_MISMATCH: token="a"',
      '',
    ].join('\n'));
    expect(h.rader).toBe(4);
    expect(h.h3).toEqual({ '[APP ERROR] 🚨 [GPS_JUMP] M: GPS jump detected Nm': 2, 'Unhandled rejection: x': 1 });
    expect(Object.keys(h.övrigt)).toHaveLength(1);
  });

  test('mapPool samlar i indexordning och nödbromsen ger ett sammanhängande prefix', async () => {
    const { mapPool } = require('../lib/pool');
    const out = await mapPool([3, 1, 2], 3, async (x) => x * 10);
    expect(out).toEqual([30, 10, 20]);
    let n = 0;
    const braked = await mapPool([1, 2, 3, 4], 1, async (x) => {
      n++;
      return x;
    }, () => n >= 2);
    expect(braked.slice(0, 2)).toEqual([1, 2]);
    expect(braked[2]).toBeUndefined();
  });
});

describe('buggjägaren: flaggtolkningen', () => {
  test('giltiga flaggor tolkas och fel ger meddelande (exit 1 i CLI:t)', () => {
    const { parseArgs } = require('../hunt');
    const ok = parseArgs(['--profile=quick', '--seed=7', '--corpus=20260806-42h,20260710-13h', '--jobs=2', '--no-shrink', '--plant=skip-state-shift']);
    expect(ok.fel).toBeNull();
    expect(ok.flaggor).toMatchObject({
      profil: 'quick', seed: 7, korpus: ['20260806-42h', '20260710-13h'], jobb: 2, ingenKrympning: true, plantera: ['skip-state-shift'],
    });
    expect(parseArgs(['--selftest']).flaggor.spår).toEqual(['selftest']);
    expect(parseArgs(['--repro', '/x/F01']).flaggor.repro).toBe('/x/F01');
    expect(parseArgs(['--profile=snabb']).fel).toMatch(/okänd profil/);
    expect(parseArgs(['--corpus=finnsinte']).fel).toMatch(/okänd korpus/);
    expect(parseArgs(['--plant=x']).fel).toMatch(/okänd --plant/);
    expect(parseArgs(['--worlds=0']).fel).toMatch(/positivt heltal/);
    expect(parseArgs(['--repro']).fel).toMatch(/fyndkatalog/);
    expect(parseArgs(['--bogus']).fel).toMatch(/okänd flagga/);
  });
});
