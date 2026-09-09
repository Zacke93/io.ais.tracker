'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const corpora = require('./replay-validation/corpora');
const { openingDeliveryFailures } = require('./replay-validation/openingDelivery');
const { analyseCoverage, gtTargetPassages, loadSamples } = require('./replay-validation/runOpeningGates');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

const ROOT = path.join(__dirname, '..');
const job = corpora.find((entry) => entry.id === '20260804-both-21h');
const ANYA = '265705550';
const ANTJE = '211347380';
const FIRST = Date.parse('2026-08-05T07:10:56.896Z');
const SECOND = Date.parse('2026-08-05T07:34:25.548Z');
const EVENT = 'Stridsbergsbron#11';

describe('ANYA/ANTJE: nytillkomna båten får sitt kort utan att ANYA upprepas', () => {
  let result;

  beforeAll(() => {
    const output = execFileSync(process.execPath, [
      path.join(ROOT, 'tests/replay-validation/replayRunner.js'), job.jsonl,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        REPLAY_MONITORING: '0',
        REPLAY_FUSION: '0',
        REPLAY_VERBOSE: '',
        REPLAY_DEBUG_LEVEL: 'off',
      },
    });
    result = JSON.parse(output.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  }, 25000);

  test('råpositionerna visar ingen ny Stridsankomst mellan korten', () => {
    const raw = fs.readFileSync(job.jsonl, 'utf8').trim().split('\n').map(JSON.parse);
    const points = raw.filter((r) => String(r.mmsi) === ANYA
      && r.aisTimestamp >= Date.parse('2026-08-05T07:20:00Z') && r.aisTimestamp <= SECOND);
    expect(points.map((r) => r.aisTimestamp)).toEqual([
      Date.parse('2026-08-05T07:20:43.748Z'), Date.parse('2026-08-05T07:23:01.425Z'),
      Date.parse('2026-08-05T07:28:00.273Z'), SECOND,
    ]);
    const bridge = BRIDGES.stridsbergsbron;
    const distances = points.map((p) => geometry.calculateDistance(p.lat, p.lon, bridge.lat, bridge.lon));
    expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(350);
    expect(distances.every((distance) => distance > 700)).toBe(true);
    expect(gtTargetPassages(job).filter((p) => p.mmsi === ANYA && p.bridge === bridge.name
      && p.t >= FIRST && p.t <= SECOND)).toEqual([]);
  });

  test('ANTJE får 19 minuter och sina egna mätvärden på den ursprungliga deadlinen', () => {
    const warnings = result.openingWarnings.filter((w) => w.bridge === 'Stridsbergsbron');
    expect(warnings.find((w) => w.t === FIRST)).toMatchObject({
      leadMmsi: ANYA, leadVessel: 'ANYA ELAN 380', mmsis: [ANYA], vesselCount: 1,
    });
    expect(warnings.find((w) => w.eventId === EVENT)).toMatchObject({
      t: SECOND,
      leadMmsi: ANTJE,
      leadVessel: 'ANTJE',
      mmsis: [ANTJE],
      vesselCount: 1,
      direction: 'northbound',
      etaMin: 19,
      distance: 2283,
      firedBy: 'fix',
      dueMs: SECOND,
      originalDueMs: 1785915219365.1772,
      success: true,
    });
    expect(warnings.filter((w) => w.mmsis.includes(ANYA))).toHaveLength(1);
  });

  test('kortfångst, konvoj och fysisk förvarning bevaras utan extra suppression', () => {
    expect(result.openingWarnings).toHaveLength(31);
    expect(result.notificationCount).toBe(151);
    expect(result.openingSuppressions.some((entry) => entry.eventId === EVENT)).toBe(false);
    expect(result.openingCoverage.filter((entry) => entry.eventId === EVENT && entry.reason === 'fired')
      .map((entry) => entry.mmsi).sort()).toEqual([ANYA, ANTJE].sort());
    expect(result.openingCoverage.filter((entry) => entry.eventId === EVENT && entry.reason === 'absorbed')
      .map((entry) => entry.mmsi)).toEqual(['246924000']);
    expect(openingDeliveryFailures(result)).toEqual([]);
    const analysis = analyseCoverage(result, loadSamples(job.jsonl), gtTargetPassages(job));
    expect(analysis.misses.filter((miss) => [ANYA, ANTJE].includes(miss.passage.mmsi))).toEqual([]);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  });
});
