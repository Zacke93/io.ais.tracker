'use strict';

const {
  analyseOpeningGroups, reportReminderSeries, reportOpeningLedger,
} = require('./replay-validation/runOpeningGates');
const day = require('./replay-validation/golden-events/20260917-7h.json');
const dayPassages = require('./replay-validation/gt-passages/20260917-7h.json');
const night = require('./replay-validation/golden-events/20260917-16h.json');
const nightPassages = require('./replay-validation/gt-passages/20260917-16h.json');

const T0 = Date.UTC(2026, 8, 17, 12);
const at = (minutes) => T0 + minutes * 60000;
const passage = (minutes, overrides = {}) => ({
  t: at(minutes), bridge: 'Klaffbron', mmsi: '265000111', ...overrides,
});
const warning = (minutes, overrides = {}) => ({
  t: at(minutes),
  bridge: 'Klaffbron',
  leadMmsi: '265000111',
  mmsis: ['265000111'],
  eventId: `Klaffbron#${minutes}`,
  ...overrides,
});
const run = (result, passages) => ({ job: { id: 'field' }, result, gt: { passages } });

function printedBy(report, runs) {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    report(runs);
    return log.mock.calls.map((args) => args.join(' ')).join('\n');
  } finally {
    log.mockRestore();
  }
}

describe('H4/H4b binder varningar till passerande medlemmar', () => {
  test('DORINDA får inte låna SUSANNE:s eller NORDIC SAGA:s passager timmar senare', () => {
    const result = analyseOpeningGroups(day, dayPassages);
    expect(result.groups).toHaveLength(4);
    expect(result.groups.map((g) => g.warnings.length)).toEqual([1, 1, 1, 1]);
    expect(result.groups.every((g) => g.uncertainWarnings.length === 0)).toBe(true);
    expect(result.unattachedWarnings.map((w) => w.leadMmsi)).toEqual(['265614080', '265614080']);
    for (const report of [reportReminderSeries, reportOpeningLedger]) {
      const text = printedBy(report, [run(day, dayPassages)]);
      expect(text).toMatch(/4 passagegrupper/);
      expect(text).toMatch(/0 med >1/);
      expect(text).toContain('2 oanknutna varningar');
      expect(text).not.toContain('4 fysiska öppningar');
    }
  });

  test('nattens två SYBIL-varningar förblir oanknutna när ingen målpassage observerats', () => {
    const result = analyseOpeningGroups(night, nightPassages);
    expect(result.groups).toHaveLength(12);
    expect(result.groups.map((g) => g.warnings.length)).toEqual(Array(12).fill(1));
    expect(result.groups.every((g) => g.uncertainWarnings.length === 0)).toBe(true);
    expect(result.unattachedWarnings.map((w) => w.leadMmsi)).toEqual(['235118216', '235118216']);
  });

  test('två verkliga förvarningar för samma medlem och passage räknas fortfarande', () => {
    const data = { openingWarnings: [warning(1), warning(2)] };
    const passages = [passage(5)];
    const result = analyseOpeningGroups(data, passages);
    expect(result.groups[0].warnings).toEqual(data.openingWarnings);
    expect(result.unattachedWarnings).toEqual([]);
    for (const report of [reportReminderSeries, reportOpeningLedger]) {
      expect(printedBy(report, [run(data, passages)])).toMatch(/1 med >1/);
    }
  });

  test('konvojens direkta och absorberade medlemmar ger en varning per passagegrupp', () => {
    const w = warning(1, { mmsis: [265000111, '265000222'] });
    const data = {
      openingWarnings: [w],
      openingCoverage: [{
        eventId: w.eventId, bridge: w.bridge, mmsi: '265000333', t: at(3), reason: 'absorbed',
      }],
    };
    const result = analyseOpeningGroups(data, [
      passage(5), passage(6, { mmsi: '265000222' }), passage(7, { mmsi: '265000333' }),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].warnings).toEqual([w]);
    expect(result.groups[0].bindings[0].certainPassages).toHaveLength(3);
    expect(result.groups[0].uncertainWarnings).toEqual([]);
  });

  test('leadMmsi fungerar även när den äldre payloaden saknar medlemslista', () => {
    const w = warning(1, { mmsis: undefined });
    expect(analyseOpeningGroups({ openingWarnings: [w] }, [passage(5)]).groups[0].warnings).toEqual([w]);
  });

  test('första resans varning återanvänds inte vid samma medlems returpassage', () => {
    const first = warning(1);
    const next = warning(25);
    const result = analyseOpeningGroups({ openingWarnings: [first, next] }, [passage(5), passage(30), passage(60)]);
    expect(result.groups.map((g) => g.warnings)).toEqual([[first], [next], []]);
  });

  test('en senare anslutning får inte flytta en gammal varning till medlemmens nästa resa', () => {
    const w = warning(1, { leadMmsi: '265000999', mmsis: ['265000999'] });
    const data = {
      openingWarnings: [w],
      openingCoverage: [{
        eventId: w.eventId, bridge: w.bridge, mmsi: '265000111', t: at(25), reason: 'absorbed',
      }],
    };
    const result = analyseOpeningGroups(data, [passage(5), passage(30)]);
    expect(result.groups.map((g) => g.warnings)).toEqual([[], []]);
    expect(result.unattachedWarnings).toEqual([w]);
  });

  test.each([
    { eventId: 'annan-händelse' }, { bridge: 'Stridsbergsbron' }, { t: at(0) },
  ])('konvojbevis måste gälla rätt händelse, bro och tid: %j', (override) => {
    const w = warning(1, { leadMmsi: '265000999', mmsis: ['265000999'] });
    const result = analyseOpeningGroups({
      openingWarnings: [w],
      openingCoverage: [{
        eventId: w.eventId, bridge: w.bridge, mmsi: '265000111', t: at(2), reason: 'absorbed', ...override,
      }],
    }, [passage(5)]);
    expect(result.groups[0].warnings).toEqual([]);
    expect(result.unattachedWarnings).toEqual([w]);
  });

  test.each([true, false])('varning inne i råpassagens intervall har okänd ordning (inferred=%s)', (inferred) => {
    const data = { openingWarnings: [warning(1), warning(4)] };
    const passages = [passage(5, { inferred, tFrom: at(3), tTo: at(6) })];
    const result = analyseOpeningGroups(data, passages);
    expect(result.groups[0].warnings).toEqual([data.openingWarnings[0]]);
    expect(result.groups[0].uncertainWarnings).toEqual([data.openingWarnings[1]]);
    expect(result.unattachedWarnings).toEqual([]);
    for (const report of [reportReminderSeries, reportOpeningLedger]) {
      expect(printedBy(report, [run(data, passages)])).toMatch(/0 med >1/);
    }
    expect(printedBy(reportOpeningLedger, [run(data, passages)])).toContain('1 med okänt antal');
  });

  test('enbart osäker ordning räknas varken som säker förvarning eller som noll varningar', () => {
    const data = { openingWarnings: [warning(4)] };
    const passages = [passage(5, { tFrom: at(3), tTo: at(6) })];
    const text = printedBy(reportOpeningLedger, [run(data, passages)]);
    expect(text).toContain('0 utan kopplad varning (0-räknaren)');
    expect(text).toContain('0 med exakt en, 1 med okänt antal');
  });

  test('inferred utan kända intervallgränser får aldrig bli ett punktbevis', () => {
    const w = warning(1);
    const result = analyseOpeningGroups({ openingWarnings: [w] }, [passage(5, { inferred: true })]);
    expect(result.groups[0].warnings).toEqual([]);
    expect(result.groups[0].uncertainWarnings).toEqual([w]);
  });

  test('samma millisekund som en punktpassage bevisar inte varning före passage', () => {
    const w = warning(5);
    const result = analyseOpeningGroups({ openingWarnings: [w] }, [passage(5)]);
    expect(result.groups[0].warnings).toEqual([]);
    expect(result.groups[0].uncertainWarnings).toEqual([w]);
  });

  test('varning vid första råfixet föregår intervallet, vid det sista är ordningen okänd', () => {
    const before = warning(3);
    const unknown = warning(6);
    const result = analyseOpeningGroups({ openingWarnings: [before, unknown] }, [
      passage(5, { tFrom: at(3), tTo: at(6) }),
    ]);
    expect(result.groups[0].warnings).toEqual([before]);
    expect(result.groups[0].uncertainWarnings).toEqual([unknown]);
  });

  test('en osäker första passage får inte hoppas över till förmån för säker täckning av nästa', () => {
    const w = warning(6);
    const result = analyseOpeningGroups({ openingWarnings: [w] }, [
      passage(5, { inferred: true, tFrom: at(3), tTo: at(10) }), passage(30),
    ]);
    expect(result.groups.map((g) => g.warnings)).toEqual([[], []]);
    expect(result.groups.map((g) => g.uncertainWarnings)).toEqual([[w], []]);
  });

  test('en sen konvojanslutning inne i korsningsfönstret bevisar inte varning före passage', () => {
    const w = warning(1, { leadMmsi: '265000999', mmsis: ['265000999'] });
    const result = analyseOpeningGroups({
      openingWarnings: [w],
      openingCoverage: [{
        eventId: w.eventId, bridge: w.bridge, mmsi: '265000111', t: at(4), reason: 'absorbed',
      }],
    }, [passage(5, { tFrom: at(3), tTo: at(6) })]);
    expect(result.groups[0].warnings).toEqual([]);
    expect(result.groups[0].uncertainWarnings).toEqual([w]);
  });

  test('äldre konvojbevis efter en mellanliggande passage blir inte säker täckning', () => {
    const w = warning(1, { leadMmsi: '265000999', mmsis: ['265000999'] });
    const result = analyseOpeningGroups({
      openingWarnings: [w],
      openingCoverage: [{
        eventId: w.eventId, bridge: w.bridge, mmsi: '265000111', t: at(20), reason: 'absorbed',
      }],
    }, [passage(5, { mmsi: '265000999' }), passage(30)]);
    expect(result.groups[0].warnings).toEqual([w]);
    expect(result.groups[1].warnings).toEqual([]);
    expect(result.groups[1].uncertainWarnings).toEqual([w]);
  });

  test('varningar utan passager syns även när liggaren inte har några grupper', () => {
    const data = { openingWarnings: [warning(1)] };
    for (const report of [reportReminderSeries, reportOpeningLedger]) {
      expect(printedBy(report, [run(data, [])])).toContain('1 oanknutna varningar');
    }
  });
});
