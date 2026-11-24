'use strict';

// U61 (2026-11-24): measure:eta redovisar påståendetyperna (brotext, notis,
// öppningskort) också för sig med sanning inom 60 min — i json
// `total.byKindWithin60` och i rapporten "PER PÅSTÅENDETYP (mätta, sanning ≤
// 60 min)". Bland korten stod sju där båten sedan låg förtöjd i timmar för
// 79 % av felsumman. Inga andra tal ändras.

const {
  buildReport, renderText, measureDoubleRuns, measureSelfCausedOutliers,
} = require('./replay-validation/measureEtaAccuracy');

function claim(kind, truth, error) {
  return {
    kind, truth, error, published: truth + error, status: 'mätt', bridge: 'Klaffbron', source: 'test', mmsi: '1', t: 0, iso: '-',
  };
}

function corpus(claims) {
  return {
    id: 'test',
    locked: true,
    hours: 1,
    jsonl: '/x/test.jsonl',
    gtCrossings: 0,
    sampleCount: 0,
    processErrors: 0,
    transitions: 0,
    notifications: 0,
    openings: 0,
    claims,
    straxClaims: [],
    textStats: {
      byConfidence: {}, straxByConfidence: {}, phrases: 0, numeric: 0, strax: 0, unknown: 0,
    },
    doubleRuns: {
      etaCalcV2: measureDoubleRuns([]),
      etaStart: measureDoubleRuns([]),
      outliers: measureSelfCausedOutliers([], []),
      smoothingLines: 0,
    },
  };
}

describe('U61: påståendetyperna med sanning inom 60 min', () => {
  const claims = [
    claim('öppningskort', 5, 1), claim('öppningskort', 300, -290), claim('öppningskort', 60, 2), claim('brotext', 10, -2),
  ];
  const report = buildReport([corpus(claims)], { label: 'test', stamp: false });

  test('json: korten med sanning över 60 min räknas inte i byKindWithin60, men står kvar i byKind', () => {
    expect(report.total.byKind['öppningskort'].n).toBe(3);
    expect(report.total.byKindWithin60['öppningskort'].n).toBe(2);
    expect(report.total.byKindWithin60['öppningskort'].sumAbsErr).toBe(3);
    expect(report.total.byKindWithin60.brotext.n).toBe(1);
  });

  test('rapporten har tabellen, och de befintliga totalerna är oförändrade', () => {
    const text = renderText(report);
    expect(text).toContain('PER PÅSTÅENDETYP (mätta, sanning ≤ 60 min)');
    expect(text).toMatch(/öppningskort\s+n=\s+2\s+summa\|f\|=\s+3\.0/);
    expect(report.total.measured.n).toBe(4);
    expect(report.total.measuredWithin60.n).toBe(3);
  });
});
