'use strict';

/**
 * Rättning M01 (motorgranskningen 2026-11-04): T10 (b) FANTOMPASSAGE kopplar
 * en registrering till en korsning på samma sätt som (a). Korsningen x
 * förklarar registreringen p när x.t − 180 s ≤ p.t ≤ E(x) + 300 s, där E(x)
 * är (a):s beslutsamma fix efter x.
 *
 * Den gamla regeln sökte en korsning i [tredje fixen före registreringen −
 * 120 s; t + 120 s]. En krypande båt som kommer 70 m bortom linjen först
 * efter 5–6 min och registreras 8 min efter korsningen blev då både träff i
 * (a) och fantom i (b) (F08 i standardkörningen). Fixturen är en R0-värld med
 * en båt som kryper i 0,4 kn söderut genom Stridsbergsbron, som i F08:s
 * minsta repro. Inga barnprocesser, ingen replay och inga timers.
 */

const geo = require('../lib/geo');
const { deepFreeze } = require('../lib/rng');
const { simulateWorld } = require('../lib/world');
const { observeWorld } = require('../lib/radio');
const { worldTruth, fixesByMmsi } = require('../lib/truth');
const { judgeT10 } = require('../lib/oracles/t10Passage');
const { beyondLineM } = require('../lib/oracles/truthCommon');

const T0 = Date.UTC(2026, 7, 29, 10, 0, 0);
const S_STRIDS = geo.stationByName.Stridsbergsbron.s;
const MMSI = '265000401';
const MIN = 60000;

/** En båt söderut genom Stridsbergsbron med given plan, observerad i R0. */
function build(plan) {
  const boat = {
    mmsi: MMSI,
    name: 'RUNA',
    cls: 'A',
    role: 'transit',
    dir: 'south',
    tStartS: 60,
    sStart: S_STRIDS + 900,
    sEnd: S_STRIDS - 1200,
    cruiseKn: 4.6,
    laneM: 0,
    queueLaneM: 0,
    lateralSigma: 0,
    plan,
    tags: [],
    seed: 6,
  };
  const sim = simulateWorld(deepFreeze({
    version: 1, seed: 401, startMs: T0, durS: 3 * 3600, era: 'aisstream', boats: [boat], events: [], radioSeed: 401,
  }));
  const { rows } = observeWorld(sim, { profile: 'R0' });
  return { rows, truth: worldTruth(sim, rows) };
}

const crawler = build([{
  op: 'crawl', bridge: 'Stridsbergsbron', withinM: 281, kn: 0.4,
}]);
const cross = crawler.truth.L0.crossings.find((c) => c.bridge === 'Stridsbergsbron');
const passage = (t, bridge = 'Stridsbergsbron') => ({
  t, iso: new Date(t).toISOString(), mmsi: MMSI, bridge,
});

/**
 * (a):s beslutsamma fix, räknad här i testet (oberoende av modulen): första
 * fixen efter korsningen, högst 10 min efter och 600 m från bron och mer än
 * 70 m bortom linjen.
 */
const decisiveAfter = (c) => crawler.truth.L1.fixes.get(MMSI).find((f) => f.aisTimestamp > c.t
  && f.aisTimestamp <= c.t + (10 * MIN) && geo.distToBridge(f.lat, f.lon, c.bridge) <= 600
  && beyondLineM(f, c.bridge, c.dir) > 70);
const judge = (built, targetPassages, truth = built.truth) => judgeT10({
  result: { targetPassages, intermediatePassages: [] }, rows: built.rows, truth,
});
const kinds = (r) => r.fynd.map((f) => `${f.klass} ${f.bro}`).sort();

describe('fixturen', () => {
  test('krypande båten blir beslutsam först 5–6 min efter korsningen', () => {
    expect(cross).toBeDefined();
    expect(cross.kn).toBeCloseTo(0.4, 1);
    const E = decisiveAfter(cross);
    expect((E.aisTimestamp - cross.t) / MIN).toBeGreaterThan(5);
    expect((E.aisTimestamp - cross.t) / MIN).toBeLessThan(6);
  });
});

describe('T10 (b) med samma koppling som (a)', () => {
  test('en krypande båt som registreras 8 min efter korsningen ger ingen FANTOMPASSAGE', () => {
    const r = judge(crawler, [passage(cross.t + (8 * MIN))]);
    expect(kinds(r)).toEqual([]);
    // (a) dömde korsningen och räknade registreringen som träff.
    expect(r['räknare']['beslutsammaKorsningar']).toBe(1);
    expect(r['räknare'].appPassager).toBe(1);
  });

  test('en äkta fantom (registrering utan korsning av bron) fälls fortfarande', () => {
    // Båten korsar aldrig Klaffbron; Stridsbergsbron registreras direkt efter korsningen.
    const r = judge(crawler, [passage(cross.t + MIN), passage(cross.t + (20 * MIN), 'Klaffbron')]);
    expect(kinds(r)).toEqual(['FANTOMPASSAGE(target) Klaffbron']);
  });

  test('i samma värld skiljs den sena registreringen från fantomen', () => {
    const r = judge(crawler, [passage(cross.t + (8 * MIN)), passage(cross.t + (20 * MIN), 'Klaffbron')]);
    expect(kinds(r)).toEqual(['FANTOMPASSAGE(target) Klaffbron']);
    expect(r.fynd[0].detalj).toMatch(/korsar aldrig bron enligt L0/);
    expect(r.fynd[0]['belägg']['närmasteKorsning']).toBeNull();
  });

  test('en U-svängare som vänder 150 m före bron och registreras där fälls', () => {
    const uturner = build([{ op: 'uturn', atS: S_STRIDS + 150 }]);
    expect(uturner.truth.L0.crossings.filter((c) => c.bridge === 'Stridsbergsbron')).toHaveLength(0);
    const turn = uturner.truth.L0.uturns[0];
    const r = judge(uturner, [passage(turn.t + 30000)]);
    expect(kinds(r)).toEqual(['FANTOMPASSAGE(target) Stridsbergsbron']);
  });

  test('(a) och (b) är eniga: en registrering är träff i (a) precis när den är förklarad i (b)', () => {
    const E = decisiveAfter(cross).aisTimestamp;
    const utfall = [];
    for (let d = -5; d <= 14; d += 0.5) {
      const t = cross.t + (d * MIN);
      const r = judge(crawler, [passage(t)]);
      const miss = r.fynd.some((f) => f.klass === 'PASSAGE-EJ-REGISTRERAD');
      const fantom = r.fynd.some((f) => f.klass === 'FANTOMPASSAGE(target)');
      const inom = t >= cross.t - (3 * MIN) && t <= E + (5 * MIN);
      utfall.push({
        d, miss, fantom, inom,
      });
    }
    expect(utfall.filter((u) => u.miss !== u.fantom)).toEqual([]);
    expect(utfall.filter((u) => u.fantom === u.inom)).toEqual([]);
  });

  test('en andra registrering av samma korsning långt senare är en dubblett och pekar ut den första', () => {
    // Som värld 254 i standarden (F13): målbropassage strax efter korsningen och
    // en mellanbropassage av samma bro 13 min senare medan båten ligger kvar.
    const r = judgeT10({
      result: {
        targetPassages: [passage(cross.t + MIN)],
        intermediatePassages: [passage(cross.t + (13 * MIN))],
      },
      rows: crawler.rows,
      truth: crawler.truth,
    });
    expect(kinds(r)).toEqual(['FANTOMPASSAGE(intermediate) Stridsbergsbron']);
    expect(r.fynd[0].detalj).toMatch(/korsningen är redan registrerad \d\d:\d\d:\d\d \(target\)/);
    expect(r.fynd[0]['belägg']['närmasteKorsning']['redanRegistrerad']).toHaveLength(1);
  });

  test('en registrering efter kopplingsfönstret pekar ut närmaste korsning och hur sent den kom', () => {
    const E = decisiveAfter(cross).aisTimestamp;
    const t = E + (5 * MIN) + 60000;
    const r = judge(crawler, [passage(t)]);
    const f = r.fynd.find((x) => x.klass === 'FANTOMPASSAGE(target)');
    expect(f.detalj).toMatch(/ligger 60 s efter/);
    expect(f['belägg']['närmasteKorsning']).toMatchObject({ källa: 'L0', grund: 'beslutsam fix', dir: 'syd' });
  });
});

describe('T10 (b) på banken (facit som L1, ingen L0)', () => {
  // Bankformad sanning ur samma rader: facitkorsningen har radions fönster [tFrom; tTo].
  const own = crawler.truth.L1.crossings.find((c) => c.bridge === 'Stridsbergsbron');
  const gtCross = (o = {}) => ({
    mmsi: MMSI,
    bridge: 'Stridsbergsbron',
    t: own.t,
    dir: 'syd',
    kind: 'line',
    inferred: false,
    gapS: own.gapS,
    tFrom: own.tFrom,
    tTo: own.tTo,
    tObs: own.tTo,
    source: 'gt',
    ...o,
  });
  const bank = (crossings) => ({ L0: null, L1: { source: 'gt', crossings, fixes: fixesByMmsi(crawler.rows) } });

  test('sen registrering av en krypande båt är förklarad, en registrering utan facitkorsning är fantom', () => {
    expect(kinds(judge(crawler, [passage(cross.t + (8 * MIN))], bank([gtCross()])))).toEqual([]);
    expect(kinds(judge(crawler, [passage(cross.t + (8 * MIN))], bank([])))).toEqual(['FANTOMPASSAGE(target) Stridsbergsbron']);
  });

  test('en glappkorsning: fönstret börjar vid facitets tFrom, eftersom facit bara vet [tFrom; tTo]', () => {
    // Facit har bara fixen före (tFrom) och efter (tTo) och uppskattar t 10 min efter tFrom.
    const tFrom = cross.t - (12 * MIN);
    const x = gtCross({
      t: tFrom + (10 * MIN), tFrom, tTo: own.tTo, inferred: true, gapS: 1200,
    });
    expect(kinds(judge(crawler, [passage(tFrom + MIN)], bank([x])))).toEqual([]);
    expect(kinds(judge(crawler, [passage(tFrom - (4 * MIN))], bank([x])))).toEqual(['FANTOMPASSAGE(target) Stridsbergsbron']);
  });
});
