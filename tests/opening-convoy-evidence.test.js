'use strict';

const { analyseCoverage } = require('./replay-validation/runOpeningGates');
const { loadGtPassages } = require('./replay-validation/makeGtPassages');

const T0 = Date.UTC(2026, 8, 8, 10);
const at = (minutes) => T0 + minutes * 60000;
const MMSI = '265000111';
const OTHER = '265000222';
const BRIDGE = 'Klaffbron';

function scenario(own = {}, other = {}, coverage = {}) {
  const p = {
    mmsi: MMSI, bridge: BRIDGE, t: at(30), tFrom: at(10), tTo: at(40), inferred: true, ...own,
  };
  const q = {
    mmsi: OTHER, bridge: BRIDGE, t: at(5), tFrom: at(3), tTo: at(12), inferred: false, ...other,
  };
  const result = {
    openingWarnings: [
      {
        t: at(0), bridge: BRIDGE, mmsis: [OTHER], eventId: 'prior', success: true,
      },
      {
        t: at(20), bridge: BRIDGE, mmsis: [MMSI], eventId: 'own', success: true,
      },
    ],
    openingCoverage: [{
      t: at(4), bridge: BRIDGE, mmsi: MMSI, eventId: 'prior', reason: 'absorbed', ...coverage,
    }],
  };
  return { p, q, result };
}

function ownUncertain(input) {
  const { p, q, result } = input;
  const actual = analyseCoverage(result, new Map(), [p, q]);
  expect(actual.covered.filter((x) => x.passage === p)).toHaveLength(0);
  const item = actual.uncertain.find((x) => x.passage === p);
  expect(item).toBeDefined();
  expect(item.klass).toBe('TIDPUNKT_OKÄND');
  return item;
}

describe('Tidigare konvojvarning: skilj rådatafönster från interpolerade punkter', () => {
  test('överlappande fönster bevisar varken separata öppningar eller säker konvojtäckning', () => {
    const actual = ownUncertain(scenario());
    expect(actual.earlierConvoyWarnings).toHaveLength(1);
    expect(actual.earlierConvoyWarnings[0].separationProven).toBe(false);
    expect(actual.bevis).toContain('tidigare konvojvarning');
    expect(actual.bevis).toContain('korsningsfönstren bevisar inte separata öppningar');
  });

  test('korta rådatagap får inte behandlas som exakta punkter när inferred=false', () => {
    const actual = ownUncertain(scenario({}, { tFrom: at(1), tTo: at(19) }));
    expect(actual.earlierConvoyWarnings[0].separationProven).toBe(false);
  });

  test('helt åtskilda fönster styrker tidsseparation men grönklassar inte den senare varningen', () => {
    const actual = ownUncertain(scenario({ tFrom: at(18) }, { tTo: at(7) }));
    expect(actual.earlierConvoyWarnings[0].separationProven).toBe(true);
    expect(actual.bevis).toContain('hela korsningsfönster ligger mer än');
    expect(actual.bevis).not.toContain('bevisligen öppnat och STÄNGT');
  });

  test('annans passage delvis före konvojvarningen bevisar ingen avslutad mellanliggande händelse', () => {
    const actual = ownUncertain(scenario({ tFrom: at(18) }, { tFrom: at(-1), tTo: at(7) }));
    expect(actual.earlierConvoyWarnings[0].separationProven).toBe(false);
  });

  test.each([
    { inferred: true, tFrom: null, tTo: null },
    { inferred: false, tFrom: at(12), tTo: at(3) },
    { inferred: false, tFrom: null, tTo: at(7) },
  ])('saknade eller trasiga ändpunkter får inte uppgraderas till punktbevis: %p', (other) => {
    const actual = ownUncertain(scenario({ tFrom: at(18) }, other));
    expect(actual.earlierConvoyWarnings[0].separationProven).toBe(false);
  });

  test('varning från föregående resa får inte redovisas som tidigare konvojvarning för returen', () => {
    const input = scenario();
    const previous = { mmsi: MMSI, bridge: BRIDGE, t: at(1) };
    const result = analyseCoverage(input.result, new Map(), [previous, input.p, input.q]);
    const actual = result.uncertain.find((x) => x.passage === input.p);
    expect(actual.earlierConvoyWarnings).toBeUndefined();
  });

  test('varning på annan bro får inte smygas in i bevistexten', () => {
    const actual = ownUncertain(scenario({}, {}, { bridge: 'Stridsbergsbron' }));
    expect(actual.earlierConvoyWarnings).toBeUndefined();
  });
});

describe('Fyra verkliga konvojfall: samma osäkerhet men synligt underlag', () => {
  test.each([
    ['20260601-41h', '265682580', 'Klaffbron', '2026-06-03T08:40', '2026-06-03T08:17:53.493Z',
      '2026-06-03T08:22:14.560Z', '2026-06-03T08:36:36.976Z', false],
    ['20260712-25h', '265806230', 'Stridsbergsbron', '2026-07-13T08:35', '2026-07-13T08:08:10.126Z',
      '2026-07-13T08:17:46.891Z', '2026-07-13T08:47:19.539Z', false],
    ['20260713-41h', '211291340', 'Stridsbergsbron', '2026-07-14T08:43', '2026-07-14T07:19:59.462Z',
      '2026-07-14T07:41:58.953Z', '2026-07-14T07:52:52.835Z', true],
    ['20260804-17h', '265573130', 'Klaffbron', '2026-08-04T12:16', '2026-08-04T11:31:16.511Z',
      '2026-08-04T11:57:53.510Z', '2026-08-04T12:15:37.334Z', true],
  ])('%s %s %s: konvojbevis enligt låst rådata', (id, mmsi, bridge, prefix, priorAt, absorbedAt, warningAt, separated) => {
    const passages = loadGtPassages(id).filter((x) => ['Klaffbron', 'Stridsbergsbron'].includes(x.bridge));
    const p = passages.find((x) => x.mmsi === mmsi && x.bridge === bridge && x.iso.startsWith(prefix));
    expect(p).toBeDefined();
    const result = analyseCoverage({
      openingWarnings: [
        {
          t: Date.parse(priorAt), bridge, mmsis: [], eventId: 'prior', success: true,
        },
        {
          t: Date.parse(warningAt), bridge, mmsis: [mmsi], eventId: 'own', success: true,
        },
      ],
      openingCoverage: [{
        t: Date.parse(absorbedAt), bridge, mmsi, eventId: 'prior', reason: 'absorbed',
      }],
    }, new Map(), passages);
    const actual = result.uncertain.find((x) => x.passage === p);
    expect(actual).toBeDefined();
    expect(result.covered.find((x) => x.passage === p)).toBeUndefined();
    expect(actual.earlierConvoyWarnings[0].separationProven).toBe(separated);
  });
});
