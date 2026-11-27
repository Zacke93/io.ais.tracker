'use strict';

/**
 * Omgång 9: registerposterna U62-KÖ-300-800M och U17-EN-FIX (BUGGJAKT §7,
 * dirigentens beslut i omgång 9). Varje villkor i predikaten prövas åt båda
 * hållen: fallet som posten gäller ger sant, och när ett villkor i taget
 * planteras bort blir svaret falskt (KANDIDAT i registret).
 */

const geo = require('../lib/geo');
const { loadRegistry, PREDICATES } = require('../lib/registry');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 22, 9, 0, 0);
const MMSI = '265000101';
const iso = (t) => new Date(t).toISOString();
// Position d m före Klaffbron för en södergående båt (söder om bron är s mindre).
const föreKlaff = (d) => geo.pointAt(geo.stationByName.Klaffbron.s + d, 0);
const rad = (t, d, sog = 0, mmsi = MMSI) => {
  const p = föreKlaff(d);
  return {
    mmsi, lat: p.lat, lon: p.lon, sog, cog: 210, aisTimestamp: t, fixTs: t, feed: 'aisstream',
  };
};

describe('U62-KÖ-300-800M: predikatet köare300till800M', () => {
  const pred = PREDICATES.köare300till800M;
  const p = { ...pred.parametrar };
  const K = T0 + (40 * MIN); // sann korsning
  const fynd = () => ({
    orakel: 'T2',
    klass: 'LEDTID<60s',
    bro: 'Klaffbron',
    mmsi: MMSI,
    t: K,
    belägg: { korsning: { dir: 'syd', t: iso(K) }, korsningT: K, varning: { eventId: 'Klaffbron#3', t: K - 37000 } },
  });
  const ctx = ({ stopp, rader }) => ({
    rader,
    sanning: {
      crossings: [],
      uturns: [],
      stops: stopp.map(([a, b]) => ({
        mmsi: MMSI, tIn: a, tOut: b, kind: 'queue',
      })),
    },
  });
  const väntan = (d, slutFöreMin = 2, längdMin = 6) => {
    const tOut = K - (slutFöreMin * MIN);
    const tIn = tOut - (längdMin * MIN);
    return { stopp: [[tIn, tOut]], rader: [rad(tIn + 30000, d), rad(tIn + (3 * MIN), d), rad(tOut - 30000, d)] };
  };

  test('väntan 344 m före bron, slut 2 min före korsningen: sant', () => {
    const r = pred.fn(fynd(), ctx(väntan(344)), p);
    expect(r.sant).toBe(true);
    expect(r.skäl).toMatch(/U62/);
  });
  test('väntan 250 m före bron (innanför 300 m): falskt', () => {
    expect(pred.fn(fynd(), ctx(väntan(250)), p).sant).toBe(false);
  });
  test('väntan 900 m före bron (utanför 800 m): falskt', () => {
    expect(pred.fn(fynd(), ctx(väntan(900)), p).sant).toBe(false);
  });
  test('väntan som slutade 40 min före korsningen: falskt', () => {
    expect(pred.fn(fynd(), ctx(väntan(344, 40)), p).sant).toBe(false);
  });
  test('väntan utan levererade rader (radiotyst): falskt', () => {
    expect(pred.fn(fynd(), ctx({ ...väntan(344), rader: [] }), p).sant).toBe(false);
  });
  test('ett senare stopp 150 m före bron är det sista stoppet: falskt', () => {
    const v = väntan(344, 10);
    const sen = [K - (5 * MIN), K - (3 * MIN)];
    const c = ctx({ stopp: [...v.stopp, sen], rader: [...v.rader, rad(sen[0] + 30000, 150), rad(sen[1] - 30000, 150)] });
    expect(pred.fn(fynd(), c, p).sant).toBe(false);
  });
  test('väntan 490 m före Stridsbergsbron men 233 m från Järnvägsbron (nattmutanten M7): falskt', () => {
    const tOut = K - (2 * MIN);
    const p0 = geo.pointAt(geo.stationByName.Stridsbergsbron.s - 490, 0);
    const r0 = (t) => ({
      mmsi: MMSI, lat: p0.lat, lon: p0.lon, sog: 0, cog: 30, aisTimestamp: t, fixTs: t, feed: 'aisstream',
    });
    const f = { ...fynd(), bro: 'Stridsbergsbron', belägg: { ...fynd().belägg, korsning: { dir: 'nord', t: iso(K) } } };
    const c = ctx({ stopp: [[tOut - (6 * MIN), tOut]], rader: [r0(tOut - (5 * MIN)), r0(tOut - MIN)] });
    const r = pred.fn(f, c, p);
    expect(r.sant).toBe(false);
    expect(r.skäl).toMatch(/Järnvägsbron/);
  });
  test('utan L0 eller utan stopp: falskt', () => {
    expect(pred.fn(fynd(), { rader: [] }, p).sant).toBe(false);
    expect(pred.fn(fynd(), ctx({ stopp: [], rader: [] }), p).sant).toBe(false);
  });
  test('registret laddar posten utan varningar och gäller T2 LEDTID', () => {
    const reg = loadRegistry();
    const post = reg.poster.find((x) => x.id === 'U62-KÖ-300-800M');
    expect(post).toMatchObject({ klass: 'ACCEPTERAD', predikat: { namn: 'köare300till800M' } });
    expect(reg.varningar || []).toEqual([]);
  });
});

describe('U17-EN-FIX: predikatet enFixFörVarning', () => {
  const pred = PREDICATES.enFixFörVarning;
  const p = { ...pred.parametrar };
  const W = T0 + (24 * MIN);
  const varning = (o = {}) => ({
    t: W, bridge: 'Klaffbron', eventId: 'Klaffbron#5', firedBy: 'deadline', leadMmsi: MMSI, mmsis: [MMSI], success: true, ...o,
  });
  const fynd = () => ({
    orakel: 'T3',
    klass: 'VARNING-PÅ-FRUSET-FIX',
    bro: 'Klaffbron',
    mmsi: MMSI,
    t: W,
    belägg: { senasteFix: iso(T0), varning: { eventId: 'Klaffbron#5', t: W } },
  });
  const ctx = ({ rader = [rad(T0, 1500, 11)], w = varning() } = {}) => ({ rader, resultat: { openingWarnings: [w] } });

  test('en enda rad i 11 kn 24 min före tickens varning: sant', () => {
    const r = pred.fn(fynd(), ctx(), p);
    expect(r.sant).toBe(true);
    expect(r.skäl).toMatch(/hördes en enda gång/);
  });
  test('två rader före varningen: falskt', () => {
    expect(pred.fn(fynd(), ctx({ rader: [rad(T0, 1500, 11), rad(T0 + MIN, 1200, 11)] }), p).sant).toBe(false);
  });
  test('den enda raden under 2 kn: falskt', () => {
    expect(pred.fn(fynd(), ctx({ rader: [rad(T0, 1500, 1.5)] }), p).sant).toBe(false);
  });
  test('den enda raden yngre än 10 min vid varningen: falskt', () => {
    expect(pred.fn(fynd(), ctx({ rader: [rad(W - (5 * MIN), 900, 11)] }), p).sant).toBe(false);
  });
  test('varningen avfyrad på en fix, inte av ticken: falskt', () => {
    expect(pred.fn(fynd(), ctx({ w: varning({ firedBy: 'fix' }) }), p).sant).toBe(false);
  });
  test('båten varken leder eller ingår i varningen: falskt', () => {
    expect(pred.fn(fynd(), ctx({ w: varning({ leadMmsi: '265000999', mmsis: ['265000999'] }) }), p).sant).toBe(false);
  });
  test('ingen levererad varning: falskt', () => {
    expect(pred.fn(fynd(), { rader: [rad(T0, 1500, 11)], resultat: { openingWarnings: [] } }, p).sant).toBe(false);
  });
  test('registret laddar posten direkt efter U17-TYST-BÅT-RECOVER', () => {
    const reg = loadRegistry();
    const ids = reg.poster.map((x) => x.id);
    expect(ids.indexOf('U17-EN-FIX')).toBe(ids.indexOf('U17-TYST-BÅT-RECOVER') + 1);
    expect(reg.poster.find((x) => x.id === 'U17-EN-FIX')).toMatchObject({ klass: 'DESIGN', predikat: { namn: 'enFixFörVarning' } });
  });
});
