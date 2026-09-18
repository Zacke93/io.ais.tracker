'use strict';

const { analyseCoverage, gtTargetPassages, loadSamples } = require('./replay-validation/runOpeningGates');
const corpora = require('./replay-validation/corpora');
const field = require('./replay-validation/golden-events/20260711-16h.json');

const T0 = Date.UTC(2026, 8, 17, 12);
const at = (minutes) => T0 + minutes * 60000;
const mmsi = '265000111';
const bridge = 'Klaffbron';
const warning = (minutes, extra = {}) => ({
  t: at(minutes), bridge, mmsis: [mmsi], ...extra,
});
const passage = (minutes, extra = {}) => ({
  t: at(minutes), bridge, mmsi, ...extra,
});

test('ELFKUNGEN:s nordvarning inne i första råintervallet får inte täcka sydreturen', () => {
  const job = corpora.find((c) => c.id === '20260711-16h');
  const passages = gtTargetPassages(job).filter((p) => p.mmsi === '265573130' && p.bridge === bridge);
  expect(passages).toHaveLength(2);
  expect(passages.map((p) => p.dir)).toEqual(['nord', 'syd']);
  const own = field.openingWarnings.filter((w) => w.bridge === bridge && w.mmsis.includes('265573130'));
  expect(own).toHaveLength(1);
  expect(own[0].t).toBeGreaterThan(passages[0].t);
  expect(own[0].t).toBeLessThan(passages[0].tTo);
  const result = analyseCoverage({ openingWarnings: own }, loadSamples(job.jsonl), passages);
  expect(result.covered).toEqual([]);
  expect(result.uncertain).toHaveLength(1);
  expect(result.uncertain[0].passage).toBe(passages[0]);
  expect(result.misses).toHaveLength(1);
  expect(result.misses[0].passage).toBe(passages[1]);
  expect(result.misses[0].klass).toBe('RIKTNINGSBEVIS_FÖR_SENT');
});

test.each([true, false])('första möjliga passage styr resefönstret även efter interpolerat t (inferred=%s)', (inferred) => {
  const first = passage(5, { inferred, tFrom: at(3), tTo: at(10) });
  const next = passage(20);
  const firstWarning = warning(6);
  const nextWarning = warning(15);
  const result = analyseCoverage({ openingWarnings: [firstWarning, nextWarning] }, new Map(), [first, next]);
  expect(result.uncertain).toHaveLength(1);
  expect(result.uncertain[0].passage).toBe(first);
  expect(result.uncertain[0].warning).toBe(firstWarning);
  expect(result.covered).toHaveLength(1);
  expect(result.covered[0].passage).toBe(next);
  expect(result.covered[0].warning).toBe(nextWarning);
});

test('absorberad konvojvarning i första råintervallet får inte återanvändas för returresan', () => {
  const first = passage(5, { inferred: true, tFrom: at(3), tTo: at(10) });
  const next = passage(20);
  const w = warning(6, { mmsis: ['265000222'], eventId: 'convoy' });
  const result = analyseCoverage({
    openingWarnings: [w],
    openingCoverage: [{
      t: at(7), bridge, mmsi, eventId: w.eventId, reason: 'absorbed',
    }],
  }, new Map(), [first, next]);
  expect(result.covered).toEqual([]);
  expect(result.uncertain).toHaveLength(1);
  expect(result.uncertain[0].passage).toBe(first);
  expect(result.misses.map((m) => m.passage)).toEqual([next]);
});

test('inferred utan ändpunkter gör inte en senare resa säkert varnad via interpolerat t', () => {
  const first = passage(5, { inferred: true });
  const next = passage(20);
  const result = analyseCoverage({ openingWarnings: [warning(6)] }, new Map(), [first, next]);
  expect(result.covered).toEqual([]);
  expect(result.uncertain[0].passage).toBe(first);
  expect(result.uncertain[0].bevis).toContain('okänd start–okänt slut');
  expect(result.misses.map((m) => m.passage)).toEqual([next]);
});

test('slutfixet efter föregående råkorsning bevaras som första observationsbevis för returen', () => {
  const job = corpora.find((c) => c.id === '20260806-42h');
  const passages = gtTargetPassages(job).filter((p) => p.mmsi === '265573130' && p.bridge === bridge);
  const target = passages.find((p) => p.iso.startsWith('2026-08-07T10:38'));
  expect(target).toBeDefined();
  const result = analyseCoverage({ openingWarnings: [] }, loadSamples(job.jsonl), passages);
  const miss = result.misses.find((m) => m.passage === target);
  expect(miss.klass).toBe('RIKTNINGSBEVIS_FÖR_SENT');
  expect(miss.bevis).toContain('2026-08-07T10:37:28.169Z');
});
