'use strict';

const crypto = require('crypto');
const {
  refinePassageWindows, loadAdditionalPassageEvidence,
} = require('./replay-validation/loadPassageEvidence');
const { loadGtPassages } = require('./replay-validation/makeGtPassages');
const { analyseCoverage, gtTargetPassages } = require('./replay-validation/runOpeningGates');
const storedEvidence = require('./replay-validation/passage-evidence/20260804-17h.json');

const ID = '20260804-17h';
const copyEvidence = () => JSON.parse(JSON.stringify(storedEvidence));
const originals = () => loadGtPassages(ID);
const target = (list, mmsi) => list.find((p) => p.mmsi === mmsi && p.bridge === 'Klaffbron'
  && p.iso.startsWith(mmsi === '265032980' ? '2026-08-04T07:14' : '2026-08-04T12:16'));
const rehash = (entry) => {
  entry.observationsSha256 = crypto.createHash('sha256').update(JSON.stringify(entry.observations)).digest('hex');
};
const warning = (p, time) => ({
  t: Date.parse(time), bridge: p.bridge, mmsis: [p.mmsi], leadMmsi: p.mmsi, success: true,
});

describe('Skuggkällans råfixar snävar bara det oberoende passagefönstret', () => {
  test('VERA har observerade positioner före/efter bron 07:13:28–07:14:59 och varning 07:05:56', () => {
    const p = target(loadAdditionalPassageEvidence(ID, originals()), '265032980');
    expect(p.tFrom).toBe(Date.parse('2026-08-04T07:13:28Z'));
    expect(p.tTo).toBe(Date.parse('2026-08-04T07:14:59Z'));
    expect(p.inferred).toBe(true);
    const result = analyseCoverage({
      openingWarnings: [warning(p, '2026-08-04T07:05:56.253Z')],
    }, new Map(), [p]);
    expect(result.covered).toHaveLength(1);
    expect(result.uncertain).toHaveLength(0);
  });

  test('ELFKUNGENs varning fem sekunder efter före-fixen förblir osäker', () => {
    const p = target(loadAdditionalPassageEvidence(ID, originals()), '265573130');
    expect(p.tFrom).toBe(Date.parse('2026-08-04T12:15:32Z'));
    expect(p.tTo).toBe(Date.parse('2026-08-04T12:25:02Z'));
    const result = analyseCoverage({
      openingWarnings: [warning(p, '2026-08-04T12:15:37.334Z')],
    }, new Map(), [p]);
    expect(result.covered).toHaveLength(0);
    expect(result.uncertain).toHaveLength(1);
  });

  test('domarens ordinarie facitläsning använder samma kompletterande underlag', () => {
    const actual = gtTargetPassages({ id: ID });
    expect(actual.filter((p) => p.timingEvidence)).toHaveLength(2);
    expect(target(actual, '265032980').tFrom).toBe(Date.parse('2026-08-04T07:13:28Z'));
  });

  test('fördröjd mottagning flyttar aldrig en observationstid framåt', () => {
    const evidence = copyEvidence();
    for (const entry of evidence.passages) {
      for (const observation of entry.observations) {
        observation.pollAt += 6 * 3600000;
        observation.receivedAt = '2026-08-04T23:00:00Z';
      }
      rehash(entry);
    }
    const actual = refinePassageWindows(originals(), evidence);
    expect(target(actual, '265573130').tFrom).toBe(Date.parse('2026-08-04T12:15:32Z'));
    expect(target(actual, '265032980').tFrom).toBe(Date.parse('2026-08-04T07:13:28Z'));
  });

  test('saknad fixtid får ingen fallback till mottagningstid', () => {
    const evidence = copyEvidence();
    delete evidence.passages[0].observations[0].record.TIME;
    rehash(evidence.passages[0]);
    expect(() => refinePassageWindows(originals(), evidence)).toThrow('Ogiltig källfix');
  });

  test('en källklocka framför mottagningen får inte användas som tidsbevis', () => {
    const evidence = copyEvidence();
    evidence.passages[0].observations[0].pollAt = 1;
    rehash(evidence.passages[0]);
    expect(() => refinePassageWindows(originals(), evidence)).toThrow('Ogiltig källfix');
  });

  test('ändrade positioner utan uppdaterad rådatahash upptäcks', () => {
    const evidence = copyEvidence();
    evidence.passages[0].observations[0].record.LATITUDE += 0.01;
    expect(() => refinePassageWindows(originals(), evidence)).toThrow('Ändrade källposter');
  });

  test('ett annat fartygs fix kan aldrig stärka tidsbeviset', () => {
    const evidence = copyEvidence();
    evidence.passages[0].observations[0].record.MMSI = 123456789;
    rehash(evidence.passages[0]);
    expect(() => refinePassageWindows(originals(), evidence)).toThrow('Ogiltig källfix');
  });

  test('två olika positioner vid samma fixtid får inte godtycklig ordning', () => {
    const evidence = copyEvidence();
    evidence.passages[0].observations[1].record.TIME = evidence.passages[0].observations[0].record.TIME;
    rehash(evidence.passages[0]);
    expect(() => refinePassageWindows(originals(), evidence)).toThrow('Ogiltig källfix');
  });

  test('positionsbevis från motsatt riktning lämnar ursprungsfönstret kvar', () => {
    const evidence = copyEvidence();
    evidence.passages[0].dir = 'syd';
    const p = { ...target(originals(), '265032980'), dir: 'syd' };
    expect(refinePassageWindows([p], evidence)[0]).toBe(p);
  });

  test('fixar helt på samma sida bevisar ingen korsning', () => {
    const evidence = copyEvidence();
    for (const observation of evidence.passages[0].observations) {
      observation.record.LATITUDE = 58.28;
      observation.record.LONGITUDE = 12.282;
    }
    rehash(evidence.passages[0]);
    const p = target(originals(), '265032980');
    expect(refinePassageWindows([p], evidence)[0]).toBe(p);
  });

  test('flera korsningar kan inte väljas ut godtyckligt som samma ankomst', () => {
    const evidence = copyEvidence();
    const entry = evidence.passages[0];
    const p = { ...target(originals(), '265032980'), tTo: Date.parse('2026-08-04T08:20:00Z') };
    entry.originalTo = p.tTo;
    const before = entry.observations[0].record;
    const after = entry.observations[entry.observations.length - 1].record;
    for (const [record, time] of [[before, '2026-08-04 07:45:00 GMT'], [after, '2026-08-04 08:00:00 GMT']]) {
      entry.observations.push({ pollAt: Date.parse(time), record: { ...record, TIME: time } });
    }
    rehash(entry);
    expect(refinePassageWindows([p], evidence)[0]).toBe(p);
  });

  test('ett annat resefönster kan inte återanvända den här resans skuggfixar', () => {
    const p = { ...target(originals(), '265032980'), tFrom: Date.parse('2026-08-04T07:05:00Z') };
    expect(refinePassageWindows([p], copyEvidence())[0]).toBe(p);
  });

  test('skuggdata får inte vidga det ursprungliga fönstret', () => {
    const evidence = copyEvidence();
    const p = { ...target(originals(), '265032980'), tFrom: Date.parse('2026-08-04T07:14:00Z') };
    evidence.passages[0].originalFrom = p.tFrom;
    expect(refinePassageWindows([p], evidence)[0]).toBe(p);
  });

  test('varken ursprungsfacit eller källposter muteras och ingen ny exakt sekund uppfinns', () => {
    const passages = originals();
    const evidence = copyEvidence();
    const before = JSON.stringify({ passages, evidence });
    const actual = refinePassageWindows(passages, evidence);
    expect(JSON.stringify({ passages, evidence })).toBe(before);
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i].t).toBe(passages[i].t);
      expect(actual[i].inferred).toBe(passages[i].inferred);
    }
  });
});
