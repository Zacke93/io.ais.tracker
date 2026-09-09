'use strict';

const {
  analyseCoverage, classifyMiss, loadSamples, MIN_WARNABLE_MS,
} = require('./replay-validation/runOpeningGates');
const { loadGtPassages } = require('./replay-validation/makeGtPassages');
const corpora = require('./replay-validation/corpora');
const { BRIDGES } = require('../lib/constants');

const T0 = Date.UTC(2026, 8, 8, 10);
const MMSI = '265000111';
const KLAFF = BRIDGES.klaffbron;

function northOf(meters, minutes, overrides = {}) {
  return {
    mmsi: MMSI,
    lat: KLAFF.lat + meters / 111320,
    lon: KLAFF.lon,
    aisTimestamp: T0 + minutes * 60000,
    sog: 4,
    cog: 180,
    ...overrides,
  };
}

function passage(overrides = {}) {
  return {
    t: T0, mmsi: MMSI, bridge: KLAFF.name, dir: 'syd', ...overrides,
  };
}

function warning(minutes, overrides = {}) {
  return {
    t: T0 + minutes * 60000,
    bridge: KLAFF.name,
    mmsis: [MMSI],
    leadMmsi: MMSI,
    eventId: 'Klaffbron#1',
    success: true,
    ...overrides,
  };
}

const samplesOf = (list) => new Map([[MMSI, list]]);
const incoming = () => samplesOf([northOf(1500, -30), northOf(1000, -20), northOf(500, -10)]);

describe('Rådatafacit: rörelse måste avse passagens anflygning', () => {
  test('en tidigare utfärd kan inte bära den osedda returens riktning', () => {
    const list = [northOf(400, -20, { cog: 0 }), northOf(900, -15, { cog: 0 })];
    const result = classifyMiss(passage(), samplesOf(list), null);
    expect(result.klass).toBe('RIKTNINGSBEVIS_FÖR_SENT');
    expect(result.accepted).toBe(true);
    expect(result.bevis).toContain('ingen observerad anflygning söderut');
  });

  test('en verklig sydanflygning i tid utan varning är fortfarande röd', () => {
    const result = classifyMiss(passage(), incoming(), null);
    expect(result.klass).toBe('OKLASSAD');
    expect(result.accepted).toBe(false);
    expect(result.bevis).toContain('riktning söderut belagd');
  });

  test('många små positionssteg utan fart/kurs får inte bortförklaras', () => {
    const list = Array.from({ length: 30 }, (_, i) => northOf(1800 - 50 * i, -30 + i, {
      sog: null, cog: null,
    }));
    const result = classifyMiss(passage(), samplesOf(list), null);
    expect(result.klass).toBe('OKLASSAD');
    expect(result.bevis).toContain('positionsbevis längs kanalen');
  });

  test('200 m netto i rätt riktning räcker även när den färska fixen står still', () => {
    const list = [northOf(900, -25, { cog: 90 }), northOf(400, -10, { sog: 0, cog: null })];
    expect(classifyMiss(passage(), samplesOf(list), null).klass).toBe('OKLASSAD');
  });

  test('kort sidomanöver och pendling bevisar ingen framtida sydanflygning', () => {
    const list = [
      northOf(300, -20, { cog: 90 }),
      northOf(260, -15, { cog: 100 }),
      northOf(280, -10, { cog: 75 }),
    ];
    expect(classifyMiss(passage(), samplesOf(list), null).klass).toBe('RIKTNINGSBEVIS_FÖR_SENT');
  });

  test('riktning först 60 s före korsning har inte 210 s förvarningsmarginal', () => {
    const list = [northOf(250, -15, { cog: 0 }), northOf(150, -1)];
    const result = classifyMiss(passage(), samplesOf(list), null);
    expect(result.klass).toBe('RIKTNINGSBEVIS_FÖR_SENT');
    expect(result.bevis).toContain('endast 60 s');
    expect(result.bevis).toContain(`${MIN_WARNABLE_MS / 1000} s`);
  });

  test('saknad facitriktning ger inget nytt undantag', () => {
    const list = [northOf(400, -20, { cog: 0 }), northOf(900, -15, { cog: 0 })];
    expect(classifyMiss(passage({ dir: null }), samplesOf(list), null).klass).toBe('OKLASSAD');
  });

  test('interpolerad tid får inte döma ett observerat riktningsbevis som för sent', () => {
    const list = [northOf(250, -15, { cog: 0 }), northOf(150, -1)];
    const inferred = passage({ inferred: true, tFrom: T0 - 60000, tTo: T0 + 3600000 });
    expect(classifyMiss(inferred, samplesOf(list), null).klass).toBe('OKLASSAD');
  });

  test('inferred får inte frikännas som för nära, för snabb eller sent rörelsebevis', () => {
    const inferred = passage({ inferred: true, tFrom: T0 - 60000, tTo: T0 + 3600000 });
    const result = classifyMiss(inferred, samplesOf([northOf(1500, -1)]), null);
    expect(result.klass).toBe('OKLASSAD');
    expect(result.accepted).toBe(false);
    expect(result.bevis).toContain('korsningens exakta tid är okänd');
  });
});

describe('Rådatafacit: en lång AIS-lucka är ett fönster, inte en känd passagetid', () => {
  const inferred = passage({ inferred: true, tFrom: T0 - 10 * 60000, tTo: T0 + 30 * 60000 });
  const analyse = (warnings, crossings = [inferred]) => analyseCoverage({ openingWarnings: warnings }, incoming(), crossings);

  test('varning före sista fix framför bron är säkert täckande', () => {
    const result = analyse([warning(-11)]);
    expect(result.covered).toHaveLength(1);
    expect(result.uncertain).toHaveLength(0);
    expect(result.misses).toHaveLength(0);
  });

  test.each([-5, 5, 29])('varning %i min från interpolerad tid har okänd ordning mot passagen', (minutes) => {
    const result = analyse([warning(minutes)]);
    expect(result.covered).toHaveLength(0);
    expect(result.misses).toHaveLength(0);
    expect(result.uncertain).toHaveLength(1);
    expect(result.uncertain[0].klass).toBe('TIDPUNKT_OKÄND');
    expect(result.uncertain[0].bevis).toContain('rådata kan inte visa');
  });

  test.each([30, 31])('varning %i min från interpolerad tid kan inte täcka den avslutade luckan', (minutes) => {
    const result = analyse([warning(minutes)]);
    expect(result.covered).toHaveLength(0);
    expect(result.uncertain).toHaveLength(0);
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0].klass).toBe('OKLASSAD');
  });

  test('en utebliven möjlig varning förblir röd även när passagetiden är osäker', () => {
    const result = analyse([]);
    expect(result.uncertain).toHaveLength(0);
    expect(result.misses[0].klass).toBe('OKLASSAD');
  });

  test('säker tidigare varning prioriteras över senare varning i den osäkra luckan', () => {
    const result = analyse([warning(-11), warning(5)]);
    expect(result.covered).toHaveLength(1);
    expect(result.covered[0].warning.t).toBe(T0 - 11 * 60000);
    expect(result.uncertain).toHaveLength(0);
  });

  test('en punktbestämd passage får inte täckas av senare varning', () => {
    const result = analyse([warning(1)], [passage()]);
    expect(result.covered).toHaveLength(0);
    expect(result.uncertain).toHaveLength(0);
    expect(result.misses[0].klass).toBe('OKLASSAD');
  });
});

describe('Sju granskade fältfall: klassning hämtar bevis ur den låsta rådatabanken', () => {
  const cache = new Map();
  function fieldCase(id, mmsi, bridge, prefix) {
    if (!cache.has(id)) {
      const job = corpora.find((c) => c.id === id);
      cache.set(id, { samples: loadSamples(job.jsonl), passages: loadGtPassages(id) });
    }
    const data = cache.get(id);
    const trip = data.passages.filter((p) => p.mmsi === mmsi && p.bridge === bridge).sort((a, b) => a.t - b.t);
    const index = trip.findIndex((p) => p.iso.startsWith(prefix));
    expect(index).toBeGreaterThanOrEqual(0);
    return { ...data, p: trip[index], start: index > 0 ? trip[index - 1].t : null };
  }

  test.each([
    ['20260708-21h', '257605080', 'Stridsbergsbron', '2026-07-08T07:25', 'OKLASSAD'],
    ['20260711-16h', '265025880', 'Stridsbergsbron', '2026-07-12T08:29', 'OKLASSAD'],
    ['20260711-16h', '265573130', 'Stridsbergsbron', '2026-07-12T11:40', 'RIKTNINGSBEVIS_FÖR_SENT'],
    ['20260712-25h', '265637230', 'Stridsbergsbron', '2026-07-12T15:55', 'RIKTNINGSBEVIS_FÖR_SENT'],
    ['20260804-both-21h', '265573130', 'Klaffbron', '2026-08-05T10:36', 'RIKTNINGSBEVIS_FÖR_SENT'],
    ['20260806-42h', '265573130', 'Klaffbron', '2026-08-07T10:38', 'RIKTNINGSBEVIS_FÖR_SENT'],
  ])('%s %s %s %s: %s', (id, mmsi, bridge, prefix, expected) => {
    const { p, samples, start } = fieldCase(id, mmsi, bridge, prefix);
    expect(classifyMiss(p, samples, start).klass).toBe(expected);
  });

  test('LAENGE LAEUFT: varning 08:47 ligger inne i bevisluckan 08:24–09:22', () => {
    const { p, samples } = fieldCase('20260712-25h', '265806230', 'Stridsbergsbron', '2026-07-13T08:35');
    const result = analyseCoverage({
      openingWarnings: [{
        t: Date.parse('2026-07-13T08:47:19Z'), bridge: p.bridge, mmsis: [p.mmsi], success: true,
      }],
    }, samples, [p]);
    expect(result.covered).toHaveLength(0);
    expect(result.misses).toHaveLength(0);
    expect(result.uncertain).toHaveLength(1);
  });
});
