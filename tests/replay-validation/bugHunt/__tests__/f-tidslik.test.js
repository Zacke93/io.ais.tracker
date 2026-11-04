'use strict';

/**
 * Rättningsrunda 2, punkt E6 (rättare F): T1 räknade en tidslik fix som
 * appen ännu inte fått (kortet F21, värld 856).
 *
 * Harnessen stegar klockan i 30 s-bitar och dränerar i bitens slut
 * (replayRunner.js:512–521), så en notis kan gå ut på exakt nästa rads tid
 * innan raden matats in. Harnessen fryser notisens position vid kortanropet
 * (vesselLat/vesselLon) och anger nästa ännu inte inmatade rad
 * (vesselLatNext, replayRunner.js:749–769). Regeln är nu: fixar strikt före
 * notisen, och en tidslik fix bara när notisens position är just den fixen.
 *
 * Världsfallen dömer målbåten i standardvärldarna 856, 86, 783 och 1731
 * (basSeed 1) ur fixtures/f-tidslik-varldar.json: båtens rader, L0:s
 * korsningar och besök för båten och de levererade notiserna, tagna en gång
 * ur generatorn och replayRunner. T1-domen för båten är densamma som på hela
 * världen (prövat när fixturen togs).
 *
 * Mot den gamla motorn (F/pre2): fallen märkta [rättning] fäller den, fallen
 * märkta [vakt] klarar båda motorerna, och fallen märkta [nytt] prövar
 * räknaren och beläggsfältet som rättningen lägger till.
 * Inga barnprocesser och inga timers.
 */

const geo = require('../lib/geo');
const { fixesByMmsi } = require('../lib/truth');
const { judgeT1 } = require('../lib/oracles/t1Notice');
const { judgeT2T3 } = require('../lib/oracles/t2Opening');
const FIXTUR = require('./fixtures/f-tidslik-varldar.json');

const FORM = 'FÖRVARNINGSFORM-EFTER-PASSAGE';
const MIN = 60000;
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// Konstruerade fall
// ---------------------------------------------------------------------------

describe('E6: tidslik fix i T1:s formkrav, konstruerat', () => {
  // En båt norrut genom Klaffbron, 30 s kadens. Raden k = 5 ligger 77 m
  // bortom linjen och har exakt notisens tid.
  const MMSI = '265000777';
  const sB = geo.stationByName.Klaffbron.s;
  const T0 = Date.UTC(2026, 6, 1, 10, 0, 0, 345);
  const OFFSET = [-600, -450, -300, -150, -6, 77, 200, 320];
  const rows = OFFSET.map((d, k) => {
    const p = geo.pointAt(sB + d, 0);
    const t = T0 + (k * 30000);
    return {
      mmsi: MMSI, msgType: 'PositionReport', lat: p.lat, lon: p.lon, sog: 5, cog: 20, aisTimestamp: t, fixTs: t, feed: 'aisstream',
    };
  });
  const truth = {
    L0: null,
    L1: {
      source: 'gt',
      crossings: [{
        mmsi: MMSI, bridge: 'Klaffbron', t: rows[4].aisTimestamp + 2000, dir: 'nord', inferred: false,
      }],
      fixes: fixesByMmsi(rows),
    },
  };
  const notis = (byggdPå, nästa) => ({
    t: rows[5].aisTimestamp,
    mmsi: MMSI,
    bridge: 'Klaffbron',
    direction: 'northbound',
    success: true,
    alreadyPassed: false,
    eta: 0,
    message: 'X närmar sig Klaffbron, beräknad ankomst strax',
    source: 'current',
    vesselLat: byggdPå.lat,
    vesselLon: byggdPå.lon,
    vesselLatNext: nästa ? nästa.lat : null,
  });
  const utanPosition = () => {
    const n = notis(rows[4], rows[5]);
    delete n.vesselLat;
    delete n.vesselLon;
    delete n.vesselLatNext;
    return n;
  };
  // Notisen 10 s efter raden 77 m bortom linjen: fixen kom före notisen.
  const sen = () => ({ ...notis(rows[5], rows[6]), t: rows[5].aisTimestamp + 10000 });
  const judge = (n) => judgeT1({ result: { notifications: [n] }, rows, truth });
  const form = (n) => judge(n).fynd.filter((f) => f.klass === FORM);

  test('[rättning] F21-mönstret: notisen byggd på föregående fix, den tidslika raden väntade på inmatning — inget utslag', () => {
    expect(form(notis(rows[4], rows[5]))).toEqual([]);
  });

  test('[rättning] en tidslik fix utan frusen position räknas inte', () => {
    expect(form(utanPosition())).toEqual([]);
  });

  test('[vakt] SALTIS-mönstret: notisen byggd på den tidslika fixen bortom linjen — utslag', () => {
    const f = form(notis(rows[5], rows[6]));
    expect(f).toHaveLength(1);
    expect(f[0]['belägg'].fixBortom.bortomM).toBe(77);
  });

  test('[vakt] en fix strikt före notisen räknas som förut', () => {
    const f = form(sen());
    expect(f).toHaveLength(1);
    expect(f[0]['belägg'].fixBortom.bortomM).toBe(77);
  });

  test('[nytt] räknaren tidslikUtesluten och beläggets mottagen', () => {
    expect(judge(notis(rows[4], rows[5]))['räknare'].tidslikUtesluten).toEqual({ ejInmatad: 1, oklar: 0 });
    expect(judge(utanPosition())['räknare'].tidslikUtesluten).toEqual({ ejInmatad: 0, oklar: 1 });
    const egen = judge(notis(rows[5], rows[6]));
    expect(egen['räknare'].tidslikUtesluten).toEqual({ ejInmatad: 0, oklar: 0 });
    expect(egen.fynd[0]['belägg'].fixBortom.mottagen).toBe('notisens egen fix (tidslik)');
    expect(form(sen())[0]['belägg'].fixBortom.mottagen).toBe('före notisen');
  });
});

// ---------------------------------------------------------------------------
// Standardens världar 856, 86, 783 och 1731
// ---------------------------------------------------------------------------

describe('E6: standardens T1-formutslag (basSeed 1)', () => {
  const världOf = (index) => FIXTUR['världar'].find((x) => x['värld'] === index);
  const döm = (index) => {
    const w = världOf(index);
    const truth = {
      L0: { ...w.sanning.L0, boats: new Map() },
      L1: { source: 'L1', crossings: w.sanning.L1crossings, fixes: fixesByMmsi(w.rader) },
    };
    const r = judgeT1({ result: { notifications: clone(w.notiser) }, rows: w.rader, truth });
    return { ...r, form: r.fynd.filter((f) => f.klass === FORM && f.mmsi === w.mmsi && f.bro === w.bro) };
  };
  /** Förvarningsnotisen vid fyndets bro med en tidslik rad, raden och föregående rad. */
  const mönster = (index) => {
    const w = världOf(index);
    const egna = w.rader.filter((x) => String(x.mmsi) === w.mmsi);
    const n = w.notiser.find((x) => x.bridge === w.bro && x.alreadyPassed === false && egna.some((y) => y.aisTimestamp === x.t));
    return { n, tidslik: egna.find((y) => y.aisTimestamp === n.t), föregående: egna.filter((y) => y.aisTimestamp < n.t).pop() };
  };
  const ÄKTA = [
    [86, 'Olidebron', 115],
    [783, 'Olidebron', 107],
    [1731, 'Stridsbergsbron', 298],
  ];

  test('[rättning] F21-mönstret (värld 856, XENIA vid Järnvägsbron): notisen byggd på föregående fix ger inget utslag', () => {
    const { n, tidslik, föregående } = mönster(856);
    // Harnessens fält: notisens position är föregående fix (före linjen), och
    // nästa ännu inte inmatade rad är den tidslika (bortom linjen).
    expect([n.vesselLat, n.vesselLon]).toEqual([föregående.lat, föregående.lon]);
    expect(n.vesselLatNext).toBe(tidslik.lat);
    expect(döm(856).form).toEqual([]);
  });

  // Värld 86 är SALTIS-mönstret (F13:s representant); 783 och 1731 ligger i
  // samma kluster (1731 är F13:s r2, KAJSA).
  test.each(ÄKTA)('[vakt] värld %i (%s) är kvar som äkta utslag: notisen byggd på den tidslika fixen %i m bortom linjen', (index, bro, bortomM) => {
    const { n, tidslik } = mönster(index);
    expect([n.vesselLat, n.vesselLon]).toEqual([tidslik.lat, tidslik.lon]);
    const { form } = döm(index);
    expect(form).toHaveLength(1);
    expect(form[0].bro).toBe(bro);
    expect(form[0]['belägg'].fixBortom.bortomM).toBe(bortomM);
  });

  test('[nytt] räknaren och beläggen i de fyra världarna', () => {
    expect(döm(856)['räknare'].tidslikUtesluten).toEqual({ ejInmatad: 1, oklar: 0 });
    for (const [index] of ÄKTA) {
      const r = döm(index);
      expect(r['räknare'].tidslikUtesluten).toEqual({ ejInmatad: 0, oklar: 0 });
      expect(r.form[0]['belägg'].fixBortom.mottagen).toBe('notisens egen fix (tidslik)');
    }
  });
});

// ---------------------------------------------------------------------------
// Systerställena i T2/T3 (vakt, ingen ändring)
// ---------------------------------------------------------------------------

describe('E6: systerställena i T3 behåller <= för varningar som en fix utlöser', () => {
  // En båt tyst i 25 min; dess nästa fix (exakt varningens tid) utlöser en
  // öppningsvarning (firedBy 'fix'). Den tidslika raden är den som utlöste
  // varningen och var alltså inmatad. En strikt regel som i T1 hade gjort
  // fixen fryst (19 fall i standardens världar, BUGGJAKT bilaga B T3).
  const MMSI = '265000888';
  const sB = geo.stationByName.Stridsbergsbron.s;
  const T = Date.UTC(2026, 6, 1, 12, 0, 0, 521);
  const rad = (min, d) => {
    const p = geo.pointAt(sB - d, 0);
    const t = T + (min * MIN);
    return {
      mmsi: MMSI, msgType: 'PositionReport', lat: p.lat, lon: p.lon, sog: 5, cog: 20, aisTimestamp: t, fixTs: t, feed: 'aisstream',
    };
  };
  const tidigare = [rad(-27, 2400), rad(-26, 2250), rad(-25, 2100)];
  const utlösande = rad(0, 900);
  const varning = {
    t: T,
    iso: new Date(T).toISOString(),
    bridge: 'Stridsbergsbron',
    direction: 'northbound',
    etaMin: 6,
    vesselCount: 1,
    leadVessel: 'X',
    firedBy: 'fix',
    eventId: 'Stridsbergsbron#1',
    leadMmsi: MMSI,
    mmsis: [MMSI],
    distance: 900,
    dueMs: T,
    originalDueMs: T,
    success: true,
    error: null,
  };
  const fruset = (rows) => judgeT2T3({
    result: { openingWarnings: [varning], openingCoverage: [], notifications: [] },
    rows,
    truth: { L0: null, L1: { source: 'gt', crossings: [], fixes: fixesByMmsi(rows) } },
  }).fynd.filter((f) => f.klass === 'VARNING-PÅ-FRUSET-FIX');

  test('[vakt] den utlösande tidslika raden räknas: ingen VARNING-PÅ-FRUSET-FIX efter 25 min tystnad', () => {
    expect(fruset([...tidigare, utlösande, rad(1, 750)])).toEqual([]);
  });

  test('[vakt] utan den tidslika raden är fixen 25 min gammal och varningen fälls', () => {
    const f = fruset([...tidigare, rad(1, 750)]);
    expect(f).toHaveLength(1);
    expect(f[0].mmsi).toBe(MMSI);
    expect(f[0].detalj).toMatch(/25 min gammal/);
  });
});
