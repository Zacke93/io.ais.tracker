'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildFacit } = require('./replay-validation/makeGtPassages');
const { validateInvariants } = require('./replay-validation/invariants');
const { eventFacitFailures } = require('./replay-validation/eventFacit');
const corpora = require('./replay-validation/corpora');

const cases = [
  ['20260917-7h', 618, 14, 6, 4],
  ['20260917-16h', 838, 38, 14, 12],
];
const direction = {
  265614080: 'northbound', // DORINDA
  244613000: 'northbound', // SUSANNE
  257942000: 'southbound', // NORDIC SAGA
  210889000: 'northbound', // VISTEN
  314019000: 'northbound', // WILSON ALSTER
  304225000: 'southbound', // SINE BRES
  258715000: 'southbound', // NORDIC SOLA
  244321000: 'southbound', // TUNA
  219031612: 'southbound', // KAPEREN
  235118216: 'northbound', // SYBIL OF WIVENHOE
};
const key = (entry) => `${entry.mmsi}|${entry.bridge}`;
const time = (iso) => Date.parse(iso);

describe.each(cases)('Fält 17–18 september: %s', (id, samples, notices, openings, targets) => {
  let replay;
  let raw;

  beforeAll(() => {
    const corpus = corpora.find((entry) => entry.id === id);
    const stdout = execFileSync(process.execPath, [
      path.join(__dirname, 'replay-validation/replayRunner.js'), corpus.jsonl,
    ], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
      },
    });
    replay = JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]);
    raw = buildFacit(corpus.jsonl).passages;
  }, 40000);

  test('hela inspelningen använder sparat startminne, minutstädning och ren avstängning', () => {
    expect(replay.sampleCount).toBe(samples);
    expect(replay.initialState.source).toBe('recorded');
    expect(replay.processErrors).toBe(0);
    expect(replay.runtimeDiagnostics).toMatchObject({
      monitoringEnabled: true, monitoringStarts: 1, shutdownErrors: 0, timersAfterShutdown: 0,
    });
    expect(replay.runtimeDiagnostics.staleSweeps).toBeGreaterThan(0);
    expect(replay.leakDiagnostics).toMatchObject({ vessels: 0, cleanupTimers: 0, protectionTimers: 0 });
    expect(validateInvariants(replay)).toEqual([]);
  });

  test('alla notiser och målpassager motsvarar oberoende råa korsningar och zonbesök', () => {
    expect(raw).toHaveLength(notices);
    expect(replay.notifications).toHaveLength(notices);
    expect(replay.notifications.map(key).sort()).toEqual(raw.map(key).sort());
    expect(replay.notifications.every((n) => n.success)).toBe(true);
    for (const notification of replay.notifications) {
      expect(notification.direction).toBe(direction[notification.mmsi]);
    }
    const rawTargets = raw.filter((p) => ['Klaffbron', 'Stridsbergsbron'].includes(p.bridge));
    expect(replay.targetPassages).toHaveLength(targets);
    expect(replay.targetPassages.map(key).sort()).toEqual(rawTargets.map(key).sort());
    expect(replay.openingWarnings).toHaveLength(openings);
  });

  test('monitoring bevarar granskade händelser, inklusive notistext, ETA och tid', () => {
    const expected = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'replay-validation/golden-events', `${id}.json`), 'utf8',
    ));
    expect(eventFacitFailures(replay, expected)).toEqual([]);
  });

  if (id === '20260917-7h') {
    test('DORINDAs tysta fortsättning fabricerar ingen målpassage eller närnotis', () => {
      expect(replay.targetPassages.filter((p) => p.mmsi === '265614080')).toEqual([]);
      expect(replay.notifications.filter((n) => n.mmsi === '265614080').map((n) => n.bridge).sort())
        .toEqual(['Kanalinfarten', 'Olidebron']);
      const quietPeriod = replay.bridgeTextTransitions.filter((t) => t.t >= time('2026-09-17T12:41:00Z')
        && t.t < time('2026-09-17T14:27:00Z'));
      expect(quietPeriod).toHaveLength(1);
      expect(quietPeriod[0].text).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
    });
  } else {
    test('KAPERENs glesa Klaffpassage ger en ärlig retroaktiv notis, utan uppfunnen ETA', () => {
      const notifications = replay.notifications.filter((n) => n.mmsi === '219031612' && n.bridge === 'Klaffbron');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        alreadyPassed: true,
        eta: -1,
        source: 'passage-fallback',
        message: 'KAPEREN passerade Klaffbron under AIS-tystnad',
      });
      expect(notifications[0].t).toBeGreaterThanOrEqual(time('2026-09-18T09:43:22Z'));
      expect(notifications[0].t).toBeLessThan(time('2026-09-18T09:43:23Z'));
      expect(replay.targetPassages.filter((p) => p.mmsi === '235118216')).toEqual([]);
    });
  }
});
