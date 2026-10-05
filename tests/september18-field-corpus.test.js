'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { buildFacit } = require('./replay-validation/makeGtPassages');
const { validateInvariants, validateWarnInvariants } = require('./replay-validation/invariants');
const { eventFacitFailures } = require('./replay-validation/eventFacit');
const {
  analyseCoverage, analysePhantoms, analyseOpeningGroups, loadSamples,
} = require('./replay-validation/runOpeningGates');
const corpora = require('./replay-validation/corpora');

const ID = '20260918-7h';
const HENRY = '265799290';
const NINA = '209982000';
const TARGETS = ['Klaffbron', 'Stridsbergsbron'];
const key = (entry) => `${entry.mmsi}|${entry.bridge}`;
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('Fält 18 september: råpassager, första observation och brobyte', () => {
  let corpus;
  let replay;
  let raw;
  let samples;
  let recorded;

  beforeAll(() => {
    corpus = corpora.find((entry) => entry.id === ID);
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
    samples = loadSamples(corpus.jsonl);
    recorded = fs.readFileSync(corpus.jsonl, 'utf8').trim().split('\n').map(JSON.parse);
  }, 40000);

  test('rådata och startminne är byteexakta kopior av den integritetskontrollerade fångsten', () => {
    expect(sha256(corpus.jsonl)).toBe('851bff9428abfce542d41b8a28b0e845e402f88bf0810e38e9ad3ab1266eae91');
    expect(sha256(corpus.jsonl.replace(/\.jsonl$/, '.state.json')))
      .toBe('5515819cabaf38e312fb170f556802bca116856745af228994f72aaec60fa801');
    expect(replay.sampleCount).toBe(379);
    expect(replay.initialState.source).toBe('recorded');
  });

  test('hela körningen klarar minutstädning, invarianter och ren avstängning', () => {
    expect(replay.processErrors).toBe(0);
    expect(replay.runtimeDiagnostics).toMatchObject({
      monitoringEnabled: true, monitoringStarts: 1, shutdownErrors: 0, timersAfterShutdown: 0,
    });
    expect(replay.runtimeDiagnostics.staleSweeps).toBeGreaterThan(0);
    expect(replay.leakDiagnostics).toMatchObject({ vessels: 0, cleanupTimers: 0, protectionTimers: 0 });
    expect(validateInvariants(replay)).toEqual([]);
    expect(validateWarnInvariants(replay)).toEqual([]);
  });

  test('alla 14 råa korsningar och zonbesök har var sin närnotis med rätt riktning', () => {
    expect(raw).toHaveLength(14);
    expect(raw.every((passage) => !passage.inferred)).toBe(true);
    expect(replay.notifications).toHaveLength(16);
    expect(replay.notifications.every((notice) => notice.success)).toBe(true);
    // Henrys två första notiser är närhet respektive policyinferens, inte
    // extra korsningar i rådatafacit. De granskas separat nedan.
    const covered = replay.notifications.filter((notice) => !(notice.mmsi === HENRY
      && ['Järnvägsbron', 'Klaffbron'].includes(notice.bridge)));
    expect(covered.map(key).sort()).toEqual(raw.map(key).sort());
    for (const passage of raw) {
      const notice = covered.find((entry) => key(entry) === key(passage));
      expect(notice.direction).toBe(passage.dir === 'nord' ? 'northbound' : 'southbound');
    }
    expect(replay.targetPassages.map(key).sort())
      .toEqual(raw.filter((passage) => TARGETS.includes(passage.bridge)).map(key).sort());
  });

  test('SIR HENRYs första fix skiljer observerad närhet från obevisad kanalportinferens', () => {
    const first = recorded.find((sample) => sample.mmsi === HENRY);
    expect(first).toMatchObject({
      aisTimestamp: Date.parse('2026-09-18T12:32:16.862Z'),
      lat: 58.29192666666667,
      lon: 12.292399999999999,
      sog: 7.1,
      cog: 32.1,
    });
    expect(fs.readFileSync(corpus.jsonl.replace(/\.jsonl$/, '.state.json'), 'utf8')).not.toContain(HENRY);
    expect(raw.filter((passage) => passage.mmsi === HENRY).map((passage) => passage.bridge))
      .toEqual(['Stridsbergsbron', 'Stallbackabron']);
    const notices = replay.notifications.filter((notice) => notice.mmsi === HENRY && notice.t === first.aisTimestamp);
    expect(notices.find((notice) => notice.bridge === 'Järnvägsbron')).toMatchObject({
      source: 'current', distance: 39, direction: 'northbound', alreadyPassed: false, eta: 0,
    });
    // Scenario A/F8 är ett tidigare uttryckligt produktbeslut: trolig
    // kanalankomst notifieras. Fältet bevisar INTE denna Klaffkorsning.
    expect(notices.find((notice) => notice.bridge === 'Klaffbron')).toMatchObject({
      source: 'passage-fallback',
      distance: 1002,
      direction: 'northbound',
      alreadyPassed: true,
      eta: -1,
      message: 'SIR HENRY passerade Klaffbron under AIS-tystnad',
    });
  });

  test('byte från passerad Stridsbergsbro tappar inte NINAs rena Järnvägssegment', () => {
    const rawIntermediate = raw.filter((passage) => passage.kind === 'line' && !TARGETS.includes(passage.bridge));
    expect(rawIntermediate).toHaveLength(7);
    expect(replay.intermediatePassages.map(key).sort()).toEqual(rawIntermediate.map(key).sort());
    const crossing = rawIntermediate.find((passage) => passage.mmsi === NINA && passage.bridge === 'Järnvägsbron');
    expect(crossing).toMatchObject({
      tFrom: Date.parse('2026-09-18T17:31:26.104Z'),
      tTo: Date.parse('2026-09-18T17:32:34.469Z'),
      inferred: false,
    });
    const firstAfterCrossing = recorded.find((sample) => sample.mmsi === NINA && sample.aisTimestamp > crossing.tTo);
    const registered = replay.intermediatePassages.find((passage) => passage.mmsi === NINA && passage.bridge === 'Järnvägsbron');
    expect(registered.t).toBeGreaterThanOrEqual(crossing.tFrom);
    expect(registered.t).toBeLessThanOrEqual(firstAfterCrossing.aisTimestamp);
    expect(registered.noTarget).toBe(false);
  });

  test('fyra varningar täcker fem råa målpassager utan fantom eller upprepad öppning', () => {
    const targets = raw.filter((passage) => TARGETS.includes(passage.bridge));
    const coverage = analyseCoverage(replay, samples, targets);
    expect(coverage.covered).toHaveLength(5);
    expect(coverage.misses).toEqual([]);
    expect(coverage.uncertain).toEqual([]);
    // Mät mot fönstrets BÖRJAN så interpolation inte ger falsk förvarning.
    for (const { passage, warning } of coverage.covered) {
      expect(passage.tFrom - warning.t).toBeGreaterThanOrEqual(60000);
    }
    const phantoms = analysePhantoms(replay, samples, targets);
    expect(phantoms.confirmed).toBe(4);
    expect(phantoms.phantoms).toEqual([]);
    expect(phantoms.inferredTime).toEqual([]);
    const { groups, unattachedWarnings } = analyseOpeningGroups(replay, targets);
    expect(groups).toHaveLength(4);
    expect(unattachedWarnings).toEqual([]);
    for (const group of groups) {
      expect(group.warnings).toHaveLength(1);
      expect(group.uncertainWarnings).toEqual([]);
    }
  });

  test('fulla händelser och alla 33 brotexter motsvarar enbart denna korpus granskade referenser', () => {
    const expectedEvents = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'replay-validation/golden-events', `${ID}.json`), 'utf8',
    ));
    const expectedText = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'replay-validation/golden-text', `${ID}.json`), 'utf8',
    ));
    expect(eventFacitFailures(replay, expectedEvents)).toEqual([]);
    expect(replay.bridgeTextTransitions).toHaveLength(33);
    expect(replay.bridgeTextTransitions.map(({ iso, text }) => ({ iso, text }))).toEqual(expectedText);
  });
});
