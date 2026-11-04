'use strict';

/**
 * Buggjägaren steg 9: sanningsoraklen T1, T2/T3, T9 och T10 med planterade
 * defekter, prövade åt båda hållen. Fixturen är ett trimmat replayresultat
 * för kanarie K1 (taget en gång ur replayRunner); testerna prövar
 * domarlogiken, inte appen. Inga barnprocesser och inga timers.
 */

const geo = require('../lib/geo');
const { hashRows } = require('../lib/rng');
const { fixesByMmsi } = require('../lib/truth');
const st = require('../lib/selftestSynth');
const { judgeTruth, statusOf } = require('../lib/oracles/truthJudge');
const { judgeT1 } = require('../lib/oracles/t1Notice');
const { judgeT10 } = require('../lib/oracles/t10Passage');
const FIXTURE = require('./fixtures/kanarie-K1-resultat.json');

const K1 = st.loadCanaries().find((k) => k.id === 'K1-norr-5kn-A30');
const built = st.buildCanary(K1);
const MMSI = built.spec.boats[0].mmsi;
const clone = (x) => JSON.parse(JSON.stringify(x));
const ctxWith = (result) => ({
  result, rows: built.rows, truth: built.truth, world: built.spec,
});
const crossing = (bridge) => built.truth.L0.crossings.find((c) => c.bridge === bridge);
const kinds = (fynd) => fynd.map((f) => `${f.orakel} ${f.klass} ${f.bro} ${statusOf(f)}`).sort();

describe('fixturen', () => {
  test('kanariens rader är desamma som när fixturen togs', () => {
    expect(hashRows(built.rows)).toBe(FIXTURE._om.radHash);
    expect(built.rows.length).toBe(FIXTURE._om.rader);
  });

  test('(6) oförändrad fixtur ger inga utslag i något sanningsorakel', () => {
    const r = judgeTruth(ctxWith(clone(FIXTURE.resultat)));
    expect(kinds(r.fynd)).toEqual([]);
    // Oraklen prövade på riktigt (inte vakuöst gröna).
    expect(r['räknare'].T1['bedömda']).toBe(6);
    expect(r['räknare'].T2['täckta']).toBe(2);
    expect(r['räknare'].T9['prövade']).toBe(8);
    expect(r['räknare'].T10['beslutsammaKorsningar']).toBe(2);
    expect(r['räknare'].T10.appPassager).toBe(5);
  });

  test('kanariekontrollen är grön på fixturen och blind utan varningar', () => {
    const ok = st.checkCanary(K1, built, clone(FIXTURE.resultat));
    expect(ok.instrumentOk).toBe(true);
    expect(ok.produktOk).toBe(true);
    const blind = clone(FIXTURE.resultat);
    blind.openingWarnings = [];
    blind.openingCoverage = [];
    const bad = st.checkCanary(K1, built, blind);
    expect(bad.instrumentOk).toBe(false);
    expect(bad.instrument.filter((x) => !x.ok).map((x) => x.namn)).toEqual(['öppningsvarningar ≥ 1']);
  });
});

describe('T1 notis per observerat besök', () => {
  test('(1) borttagen Klaffbronnotis ger NOTIS-UTEBLIVEN (kandidat)', () => {
    const res = clone(FIXTURE.resultat);
    res.notifications = res.notifications.filter((n) => n.bridge !== 'Klaffbron');
    const r = judgeT1(ctxWith(res));
    expect(kinds(r.fynd)).toEqual(['T1 NOTIS-UTEBLIVEN Klaffbron KANDIDAT']);
    expect(r.fynd[0].mmsi).toBe(MMSI);
    expect(r.fynd[0].riktning).toBe('northbound');
  });

  test('(7) förvarningsform två minuter efter sann korsning fälls; passerad form gör det inte', () => {
    const cx = crossing('Klaffbron');
    const late = clone(FIXTURE.resultat);
    const n = late.notifications.find((x) => x.bridge === 'Klaffbron');
    n.t = cx.t + 110000;
    n.alreadyPassed = false;
    expect(kinds(judgeT1(ctxWith(late)).fynd)).toEqual(['T1 FÖRVARNINGSFORM-EFTER-PASSAGE Klaffbron KANDIDAT']);
    n.alreadyPassed = true;
    expect(judgeT1(ctxWith(late)).fynd).toEqual([]);
  });

  // Bankformad sanning (bara L1): en båt söder om Klaffbron som lämnar
  // radien kort och kommer tillbaka.
  const sB = geo.stationByName.Klaffbron.s;
  const T0 = Date.UTC(2026, 6, 1, 10, 0, 0);
  const row = (min, before) => {
    const p = geo.pointAt(sB - before, 0);
    const t = T0 + (min * 60000);
    return {
      mmsi: '265000999', msgType: 'PositionReport', lat: p.lat, lon: p.lon, sog: 3, cog: 30, aisTimestamp: t, fixTs: t, feed: 'aisstream',
    };
  };
  const bankCase = (between) => {
    const rows = [row(-4, 900), row(-2, 600), row(0, 250), row(1, 200), ...between, row(15, 280), row(16, 260)];
    const result = {
      notifications: [{
        t: T0 + 1000, mmsi: '265000999', bridge: 'Klaffbron', direction: 'northbound', success: true, alreadyPassed: false, message: 'X närmar sig Klaffbron',
      }],
      openingWarnings: [],
      targetPassages: [],
      intermediatePassages: [],
    };
    const truth = { L0: null, L1: { source: 'gt', crossings: [], fixes: fixesByMmsi(rows) } };
    return judgeT1({ result, rows, truth });
  };

  test('(2) tidigare notis utan utfärd ger DESIGN via BESÖKSREGEL', () => {
    const r = bankCase([row(5, 320), row(10, 330)]);
    expect(r.fynd).toHaveLength(1);
    expect(r.fynd[0].klass).toBe('NOTIS-UTEBLIVEN');
    expect(r.fynd[0]['belägg']['förklaring']).toMatchObject({ post: 'BESÖKSREGEL-2026-09-07', klass: 'DESIGN' });
  });

  test('(2b) med två konsekutiva fixar över 350 m är utfärden belagd och utslaget en kandidat', () => {
    const r = bankCase([row(5, 400), row(10, 420)]);
    expect(r.fynd).toHaveLength(1);
    expect(statusOf(r.fynd[0])).toBe('KANDIDAT');
    expect(r.fynd[0]['belägg']['utfärdObserverad']).toBe(true);
  });

  test('ett besök som var öppet i starttillståndet räknas som samma besök', () => {
    // Båten har legat strax utanför radien (men innanför 350 m) sedan korpusstart.
    const rows = [row(-4, 310), row(-2, 305), row(0, 250), row(1, 200)];
    const judge = (open) => judgeT1({
      result: { notifications: [] },
      rows,
      truth: {
        L0: null,
        L1: {
          source: 'gt', crossings: [], fixes: fixesByMmsi(rows), openVisitsAtStart: new Set(open),
        },
      },
    });
    const r = judge(['265000999:Klaffbron']);
    expect(r.fynd).toHaveLength(1);
    expect(r.fynd[0]['belägg']['förklaring']).toMatchObject({ post: 'BESÖKSREGEL-2026-09-07', klass: 'DESIGN' });
    expect(r.fynd[0]['belägg']['öppetIStarttillstånd']).toBe(true);
    // Utan öppet besök i starttillståndet är samma utslag en kandidat.
    expect(statusOf(judge([]).fynd[0])).toBe('KANDIDAT');
  });
});

describe('T2/T3 öppningsvarningar', () => {
  const moveWarning = (bridge, t) => {
    const res = clone(FIXTURE.resultat);
    const w = res.openingWarnings.find((x) => x.bridge === bridge);
    w.t = t;
    for (const c of res.openingCoverage) if (c.eventId === w.eventId) c.t = t;
    return res;
  };

  test('(3) varning 30 s före sann korsning ger LEDTID<60s (kandidat, varningsbar båt)', () => {
    const cx = crossing('Klaffbron');
    const r = judgeTruth(ctxWith(moveWarning('Klaffbron', cx.t - 30000)));
    expect(kinds(r.fynd)).toEqual(['T2 LEDTID<60s Klaffbron KANDIDAT']);
    expect(r.fynd[0]['belägg'].ledtidS).toBe(30);
    expect(r.fynd[0]['belägg'].varningsbarhet).toBe('OKLASSAD');
  });

  test('(3b) varning efter sann korsning ger ÖPPNING-MISS:OKLASSAD och VARNING-EFTER-SANN-PASSAGE', () => {
    const cx = crossing('Klaffbron');
    const r = judgeTruth(ctxWith(moveWarning('Klaffbron', cx.t + 20000)));
    expect(kinds(r.fynd)).toEqual([
      'T2 ÖPPNING-MISS:OKLASSAD Klaffbron KANDIDAT',
      'T3 VARNING-EFTER-SANN-PASSAGE Klaffbron KANDIDAT',
    ]);
  });

  test('en ensam fantomvarning långt senare fälls av T3', () => {
    const res = clone(FIXTURE.resultat);
    const w = clone(res.openingWarnings[0]);
    w.t = crossing('Stallbackabron').t + (3 * 3600000);
    w.eventId = 'Klaffbron#99';
    res.openingWarnings.push(w);
    const r = judgeTruth(ctxWith(res));
    expect(r.fynd.map((f) => `${f.orakel} ${f.klass}`)).toEqual(expect.arrayContaining(['T3 FANTOM:INGA_SAMPEL_FÖRE', 'T3 VARNING-PÅ-FRUSET-FIX']));
  });
});

describe('T9 riktningssanning', () => {
  test('(4) vänd riktning på notisen ger FEL-RIKTNING; unknown är aldrig fel', () => {
    const res = clone(FIXTURE.resultat);
    const n = res.notifications.find((x) => x.bridge === 'Stridsbergsbron');
    n.direction = 'southbound';
    expect(kinds(judgeTruth(ctxWith(res)).fynd)).toEqual(['T9 FEL-RIKTNING Stridsbergsbron KANDIDAT']);
    n.direction = 'unknown';
    expect(judgeTruth(ctxWith(res)).fynd).toEqual([]);
  });
});

describe('T10 passagedetektion', () => {
  test('(5) raderad targetPassage ger MISS och en tillagd ger FANTOMPASSAGE', () => {
    const del = clone(FIXTURE.resultat);
    del.targetPassages = del.targetPassages.filter((p) => p.bridge !== 'Klaffbron');
    expect(kinds(judgeT10(ctxWith(del)).fynd)).toEqual(['T10 PASSAGE-EJ-REGISTRERAD Klaffbron KANDIDAT']);
    const add = clone(FIXTURE.resultat);
    const { t } = crossing('Olidebron');
    add.targetPassages.push({
      t, iso: new Date(t).toISOString(), mmsi: MMSI, bridge: 'Stridsbergsbron',
    });
    expect(kinds(judgeT10(ctxWith(add)).fynd)).toEqual(['T10 FANTOMPASSAGE(target) Stridsbergsbron KANDIDAT']);
  });
});
