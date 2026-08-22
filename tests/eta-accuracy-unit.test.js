'use strict';

/**
 * Enhetstester för MÄTHARNESSEN tests/replay-validation/measureEtaAccuracy.js.
 *
 * Mätaren är inget facit, men den ska STYRA beslutet om K6-fixen förbättrade
 * ETA:n eller inte — en tyst bugg i parsern eller i felformeln vore därför
 * lika illa som en bugg i produkten. Testerna låser de rena delarna:
 * textparsern, ledarutpekningen, sanningsuppslaget (linje vs zon vs inferred),
 * statistikdefinitionerna och K6-parräkningen.
 *
 * Att bara ladda modulen bevisar dessutom att förladdningsläget INTE startar
 * mätningen när filen require:as (require.main !== module).
 */

const M = require('./replay-validation/measureEtaAccuracy');

describe('brotextparsern', () => {
  test('plockar minutsiffran per målbro i en tvådelad text', () => {
    const claims = M.parseBridgeTextClaims(
      'En båt på väg mot Klaffbron, beräknad broöppning om 11 minuter; '
      + 'Två båtar på väg mot Stridsbergsbron, beräknad broöppning om 9 minuter',
    );
    expect(claims).toEqual([
      {
        bridge: 'Klaffbron', clause: 'minuter', minutes: 11, approx: false, count: 1,
      },
      {
        bridge: 'Stridsbergsbron', clause: 'minuter', minutes: 9, approx: false, count: 2,
      },
    ]);
  });

  test('känner igen cirka-, strax- och okänd-klausulerna', () => {
    expect(M.parseBridgeTextClaims('En båt på väg mot Klaffbron, beräknad broöppning om cirka 4 minuter'))
      .toEqual([{
        bridge: 'Klaffbron', clause: 'minuter', minutes: 4, approx: true, count: 1,
      }]);
    expect(M.parseBridgeTextClaims('En båt på väg mot Klaffbron, beräknad broöppning strax')[0].clause)
      .toBe('strax');
    expect(M.parseBridgeTextClaims('Två båtar på väg mot Stridsbergsbron, ETA okänd')[0].clause)
      .toBe('okänd');
  });

  test('räkneordet läses ut för hela CountTextHelper-serien', () => {
    const c = (word) => M.parseBridgeTextClaims(
      `${word} båtar på väg mot Klaffbron, beräknad broöppning om 5 minuter`,
    )[0].count;
    expect(['Två', 'Tre', 'Fyra', 'Fem', 'Sex', 'Sju', 'Åtta', 'Nio', 'Tio'].map(c))
      .toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(M.parseBridgeTextClaims('11 båtar på väg mot Klaffbron, beräknad broöppning om 5 minuter')[0].count)
      .toBe(11);
  });

  test('DEFAULT_MESSAGE och processfel ger inga påståenden', () => {
    expect(M.parseBridgeTextClaims('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron'))
      .toEqual([]);
    expect(M.parseBridgeTextClaims('__PROCESS_ERROR__:boom')).toEqual([]);
    expect(M.parseBridgeTextClaims('')).toEqual([]);
    expect(M.parseBridgeTextClaims(null)).toEqual([]);
  });

  test('läser även den beskrivande nödfallbacken', () => {
    const claims = M.parseBridgeTextClaims(
      'En båt 167m från Klaffbron (nordgående), beräknad broöppning om 5 minuter',
    );
    expect(claims).toEqual([{
      bridge: 'Klaffbron', clause: 'minuter', minutes: 5, approx: false, count: 1,
    }]);
  });
});

describe('roundsTo — klausulens avrundning plus loggens toFixed(1)-slack', () => {
  test('exakt avrundning matchar', () => {
    expect(M.roundsTo(5.2, 5, false)).toBe(true);
    expect(M.roundsTo(4.6, 5, false)).toBe(true);
    expect(M.roundsTo(3.9, 5, false)).toBe(false);
  });

  test('loggens 5.5 kan vara sanna 5,49 → matchar publicerat 5', () => {
    expect(M.roundsTo(5.5, 5, false)).toBe(true);
    expect(M.roundsTo(5.5, 6, false)).toBe(true); // och 5,51 → 6
    expect(M.roundsTo(5.6, 5, false)).toBe(false);
  });

  test('extrapolerade strax-zonen skriver fast "cirka 2 minuter"', () => {
    expect(M.roundsTo(0.4, 2, true)).toBe(true);
    expect(M.roundsTo(0.4, 2, false)).toBe(false);
    expect(M.roundsTo(3.4, 2, true)).toBe(false);
  });
});

describe('ledarutpekningen', () => {
  const t = 1000000;
  const mkState = (entries) => new Map(entries);

  test('lägst giltig ETA i brogruppen blir ledare när siffran stämmer', () => {
    const state = mkState([
      ['111', { bridge: 'Klaffbron', eta: 9.2, t }],
      ['222', { bridge: 'Klaffbron', eta: 4.1, t }],
      ['333', { bridge: 'Stridsbergsbron', eta: 1.2, t }],
    ]);
    const att = M.attributeLead(state, 'Klaffbron', 4, false, t);
    expect(att).toMatchObject({ mmsi: '222', confidence: 'ledare', candidates: 2 });
  });

  test('avvikande siffra med EN värdematch ger "värde"', () => {
    const state = mkState([
      ['111', { bridge: 'Klaffbron', eta: 4.1, t }],
      ['222', { bridge: 'Klaffbron', eta: 9.2, t }],
    ]);
    expect(M.attributeLead(state, 'Klaffbron', 9, false, t))
      .toMatchObject({ mmsi: '222', confidence: 'värde' });
  });

  test('ingen match alls ⇒ "ledare-avviker" (utpekningen får inte gissa)', () => {
    const state = mkState([['111', { bridge: 'Klaffbron', eta: 4.1, t }]]);
    expect(M.attributeLead(state, 'Klaffbron', 30, false, t).confidence).toBe('ledare-avviker');
  });

  test('"strax" (minutes=null) använder ledarregeln utan värdekontroll', () => {
    const state = mkState([['111', { bridge: 'Klaffbron', eta: 40, t }]]);
    expect(M.attributeLead(state, 'Klaffbron', null, false, t))
      .toMatchObject({ mmsi: '111', confidence: 'ledare' });
  });

  test('ogiltig ETA och för gammalt tillstånd diskvalificerar kandidaten', () => {
    const invalid = mkState([['111', { bridge: 'Klaffbron', eta: 0, t }]]);
    expect(M.attributeLead(invalid, 'Klaffbron', 4, false, t).confidence).toBe('ingen-kandidat');
    const stale = mkState([['111', { bridge: 'Klaffbron', eta: 4.1, t: t - M.STATE_TTL_MS - 1 }]]);
    expect(M.attributeLead(stale, 'Klaffbron', 4, false, t).confidence).toBe('ingen-kandidat');
  });

  test('isValidEta speglar appens egen regel (>0 och ≤1440)', () => {
    expect(M.isValidEta(0)).toBe(false);
    expect(M.isValidEta(0.1)).toBe(true);
    expect(M.isValidEta(1440)).toBe(true);
    expect(M.isValidEta(1441)).toBe(false);
    expect(M.isValidEta(null)).toBe(false);
    expect(M.isValidEta(NaN)).toBe(false);
  });
});

describe('tillståndsströmmen', () => {
  test('eta sätter bro+värde, pa behåller bron, target byter bro, remove tömmer', () => {
    const state = new Map();
    M.applyEvent(state, {
      t: 1, kind: 'eta', mmsi: '111', bridge: 'Klaffbron', eta: 8,
    });
    expect(state.get('111')).toEqual({ bridge: 'Klaffbron', eta: 8, t: 1 });
    M.applyEvent(state, {
      t: 2, kind: 'pa', mmsi: '111', eta: 7.5,
    });
    expect(state.get('111')).toEqual({ bridge: 'Klaffbron', eta: 7.5, t: 2 });
    M.applyEvent(state, {
      t: 3, kind: 'eta-null', mmsi: '111',
    });
    expect(state.get('111')).toEqual({ bridge: 'Klaffbron', eta: null, t: 3 });
    M.applyEvent(state, {
      t: 4, kind: 'target', mmsi: '111', bridge: 'Stridsbergsbron',
    });
    expect(state.get('111').bridge).toBe('Stridsbergsbron');
    M.applyEvent(state, { t: 5, kind: 'remove', mmsi: '111' });
    expect(state.has('111')).toBe(false);
  });
});

describe('sanningsuppslaget mot rådatafacit', () => {
  const gt = {
    index: new Map([
      ['111|Klaffbron', [
        { t: 500, inferred: false, kind: 'line' },
        { t: 2000, inferred: true, kind: 'line' },
        { t: 3000, inferred: false, kind: 'line' },
      ]],
      ['111|Kanalinfarten', [{ t: 4000, inferred: false, kind: 'zone' }]],
    ]),
  };

  test('tar FÖRSTA linjekorsningen vid eller efter t', () => {
    expect(M.nextCrossing(gt, '111', 'Klaffbron', 400).t).toBe(500);
    expect(M.nextCrossing(gt, '111', 'Klaffbron', 500).t).toBe(500);
    expect(M.nextCrossing(gt, '111', 'Klaffbron', 501).t).toBe(2000);
    expect(M.nextCrossing(gt, '111', 'Klaffbron', 2001).t).toBe(3000);
  });

  test('zonbesök är ALDRIG en brolinjekorsning', () => {
    expect(M.nextCrossing(gt, '111', 'Kanalinfarten', 0)).toBeNull();
  });

  test('okänd nyckel och tid efter sista korsningen ger null', () => {
    expect(M.nextCrossing(gt, '999', 'Klaffbron', 0)).toBeNull();
    expect(M.nextCrossing(gt, '111', 'Klaffbron', 3001)).toBeNull();
  });
});

describe('statistikdefinitionerna', () => {
  test('median och nearest-rank-percentil', () => {
    expect(M.median([1, 2, 3])).toBe(2);
    expect(M.median([1, 2, 3, 4])).toBe(2.5);
    expect(M.median([])).toBeNull();
    expect(M.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(M.percentile([5], 0.9)).toBe(5);
  });

  test('summarize räknar summa, median, p90, bias och andel ≤2 min', () => {
    const s = M.summarize([
      { error: 1 }, { error: -1 }, { error: 3 }, { error: -9 },
    ]);
    expect(s.n).toBe(4);
    expect(s.sumAbsErr).toBe(14);
    expect(s.medianAbsErr).toBe(2); // |1|,|1|,|3|,|9| → (1+3)/2
    expect(s.p90AbsErr).toBe(9);
    expect(s.bias).toBe(-1.5); // (1-1+3-9)/4
    expect(s.within2Count).toBe(2);
    expect(s.within2).toBe(50);
  });

  test('tom mängd kraschar inte', () => {
    expect(M.summarize([])).toMatchObject({ n: 0, sumAbsErr: 0, medianAbsErr: null });
  });
});

describe('K6-måttet: dubbelkörningspar', () => {
  test('två beräkningar för samma mmsi inom fönstret bildar ETT par', () => {
    const r = M.measureDoubleRuns([
      {
        t: 1000, seq: 1, mmsi: 'A', eta: 15.5,
      },
      {
        t: 1060, seq: 2, mmsi: 'A', eta: 15.2,
      }, // samma fix, snapshotpasset
      {
        t: 71000, seq: 3, mmsi: 'A', eta: 12.0,
      }, // nästa fix, 70 s senare
      {
        t: 71060, seq: 4, mmsi: 'A', eta: 11.8,
      },
    ]);
    expect(r.lines).toBe(4);
    expect(r.pairs).toBe(2);
    expect(r.pairsChangedValue).toBe(2);
    expect(r.mmsiWithPairs).toBe(1);
    expect(r.pairsByDt['1-60']).toBe(2);
    expect(r.shareOfLinesInPair).toBe(100);
  });

  test('olika mmsi i samma millisekund är INTE ett par', () => {
    const r = M.measureDoubleRuns([
      {
        t: 1000, seq: 1, mmsi: 'A', eta: 5,
      },
      {
        t: 1000, seq: 2, mmsi: 'B', eta: 6,
      },
    ]);
    expect(r.pairs).toBe(0);
    expect(r.shareOfLinesInPair).toBe(0);
  });

  test('exakt fönstergränsen ligger UTANFÖR paret', () => {
    const r = M.measureDoubleRuns([
      {
        t: 0, seq: 1, mmsi: 'A', eta: 5,
      },
      {
        t: M.DOUBLE_RUN_WINDOW_MS, seq: 2, mmsi: 'A', eta: 5,
      },
    ]);
    expect(r.pairs).toBe(0);
  });

  test('riktningen på pass 2 räknas (K6: dubbel EMA drar tillbaka värdet)', () => {
    const r = M.measureDoubleRuns([
      {
        t: 0, seq: 1, mmsi: 'A', eta: 16.2,
      },
      {
        t: 60, seq: 2, mmsi: 'A', eta: 15.9,
      }, // sänkt 0,3
      {
        t: 90000, seq: 3, mmsi: 'B', eta: 4.0,
      },
      {
        t: 90060, seq: 4, mmsi: 'B', eta: 4.5,
      }, // höjt 0,5
    ]);
    expect(r.pairsSecondLower).toBe(1);
    expect(r.pairsSecondHigher).toBe(1);
    expect(r.sumAbsPairDeltaMin).toBeCloseTo(0.8, 5);
    expect(r.meanAbsPairDeltaMin).toBeCloseTo(0.4, 5);
  });

  test('oförändrat värde räknas som par men inte som ändrat', () => {
    const r = M.measureDoubleRuns([
      {
        t: 0, seq: 1, mmsi: 'A', eta: 9.5,
      },
      {
        t: 60, seq: 2, mmsi: 'A', eta: 9.5,
      },
    ]);
    expect(r.pairs).toBe(1);
    expect(r.pairsChangedValue).toBe(0);
  });
});

describe('K6-måttet: självorsakade outliers', () => {
  test('outlier med egen baslinje < 200 ms bakåt räknas som självorsakad', () => {
    const outliers = [
      {
        t: 1060, seq: 2, mmsi: 'A', raw: 73.1, reason: 'dramatic_increase_5.00x',
      },
      {
        t: 90000, seq: 9, mmsi: 'B', raw: 0.4, reason: 'gps_coordination_active',
      },
    ];
    const calcs = [
      {
        t: 1000, seq: 1, mmsi: 'A', eta: 14.6,
      },
      {
        t: 60000, seq: 8, mmsi: 'B', eta: 1.5,
      },
    ];
    const r = M.measureSelfCausedOutliers(outliers, calcs);
    expect(r.lines).toBe(2);
    expect(r.selfCaused).toBe(1);
    expect(r.byReason).toEqual({ dramatic_increase: 1, gps_coordination_active: 1 });
  });
});

describe('attributeClaim — gruppen ur appens egen brotextfilter-rad', () => {
  const t = 1000000;

  test('EN båt i gruppen ⇒ identiteten är bevisad utan att ETA:n matchar', () => {
    // Den EXTRAPOLERADE nedräkningen ("om cirka 6/5/4 minuter") lämnar ingen
    // [ETA_CALC_V2]-rad, så tillståndet står kvar på 11 min. Gruppen avgör.
    const state = new Map([['111', { bridge: 'Stridsbergsbron', eta: 11, t }]]);
    const pass = { included: [{ mmsi: '111', name: 'X', bridge: 'Stridsbergsbron' }] };
    expect(M.attributeClaim({
      state, pass, bridge: 'Stridsbergsbron', count: 1, minutes: 5, approx: true, t,
    })).toEqual({ mmsi: '111', confidence: 'grupp-ensam', candidates: 1 });
  });

  test('gruppstorlek ≠ textens räkneord ⇒ passet förkastas, ledarregeln gäller', () => {
    const state = new Map([['111', { bridge: 'Klaffbron', eta: 5.1, t }]]);
    const pass = { included: [{ mmsi: '999', name: 'FEL', bridge: 'Klaffbron' }] };
    const att = M.attributeClaim({
      state, pass, bridge: 'Klaffbron', count: 2, minutes: 5, approx: false, t,
    });
    expect(att).toMatchObject({ mmsi: '111', confidence: 'ledare' });
  });

  test('flerbåtsgrupp: ledaren väljs BLAND gruppens medlemmar', () => {
    const state = new Map([
      ['111', { bridge: 'Klaffbron', eta: 9.2, t }],
      ['222', { bridge: 'Klaffbron', eta: 4.1, t }],
      ['333', { bridge: 'Klaffbron', eta: 1.1, t }], // ej med i passet
    ]);
    const pass = {
      included: [
        { mmsi: '111', name: 'A', bridge: 'Klaffbron' },
        { mmsi: '222', name: 'B', bridge: 'Klaffbron' },
      ],
    };
    expect(M.attributeClaim({
      state, pass, bridge: 'Klaffbron', count: 2, minutes: 4, approx: false, t,
    })).toMatchObject({ mmsi: '222', confidence: 'ledare' });
  });

  test('flerbåtsgrupp utan värdematch ⇒ grupp-ledare (identiteten är ändå känd)', () => {
    const state = new Map([
      ['111', { bridge: 'Klaffbron', eta: 9.2, t }],
      ['222', { bridge: 'Klaffbron', eta: 4.1, t }],
    ]);
    const pass = {
      included: [
        { mmsi: '111', name: 'A', bridge: 'Klaffbron' },
        { mmsi: '222', name: 'B', bridge: 'Klaffbron' },
      ],
    };
    expect(M.attributeClaim({
      state, pass, bridge: 'Klaffbron', count: 2, minutes: 30, approx: false, t,
    })).toMatchObject({ mmsi: '222', confidence: 'grupp-ledare' });
  });

  test('grupp utan någon känd ETA ⇒ ingen utpekning (mätvärdet skippas)', () => {
    const pass = {
      included: [
        { mmsi: '111', name: 'A', bridge: 'Klaffbron' },
        { mmsi: '222', name: 'B', bridge: 'Klaffbron' },
      ],
    };
    expect(M.attributeClaim({
      state: new Map(), pass, bridge: 'Klaffbron', count: 2, minutes: 7, approx: false, t,
    })).toMatchObject({ mmsi: null, confidence: 'grupp-utan-eta' });
  });

  test('fartyg utan målbro i passet räknas inte in i gruppen', () => {
    const state = new Map([['111', { bridge: 'Klaffbron', eta: 5.1, t }]]);
    const pass = {
      included: [
        { mmsi: '111', name: 'A', bridge: 'Klaffbron' },
        { mmsi: '777', name: 'STALLBACKA', bridge: null },
      ],
    };
    expect(M.attributeClaim({
      state, pass, bridge: 'Klaffbron', count: 1, minutes: 5, approx: false, t,
    })).toMatchObject({ mmsi: '111', confidence: 'grupp-ensam' });
  });
});
