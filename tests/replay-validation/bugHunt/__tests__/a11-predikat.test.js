'use strict';

// Spår A, omgång 11 (U90): vaktfall för spärrpostens och U18-postens predikat
// (lib/predikatA11.js). Varje post ska känna igen appens egen regel och avvisa samma
// förlopp när tiden eller bokföringen avviker (mutantbeviset i liten skala).

const { PREDICATES, loadRegistry } = require('../lib/registry');
const constants = require('../../../../lib/constants');

const P = (namn) => {
  const e = loadRegistry().poster.find((x) => x.predikat.namn === namn);
  return (f, ctx) => PREDICATES[namn].fn(f, ctx, e._params);
};
const { fromEntries } = require('../lib/util');

const B = fromEntries(Object.values(constants.BRIDGES).map((b) => [b.name, b]));
const mellan = (a, b, k) => ({ lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k });
const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);
const MMSI = '265000001';

function spärrFall({ förskjutMs = 0, skäl = 'spärren löpte ut' } = {}) {
  const pos = mellan(B.Klaffbron, B.Järnvägsbron, 0.7);
  const F = {
    mmsi: MMSI, aisTimestamp: T0, fixTs: T0, sog: 2.2, cog: 30, ...pos,
  };
  const R = 6371000; const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(B.Stridsbergsbron.lat - pos.lat); const dLon = rad(B.Stridsbergsbron.lon - pos.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(pos.lat)) * Math.cos(rad(B.Stridsbergsbron.lat)) * Math.sin(dLon / 2) ** 2;
  const d = 2 * R * Math.asin(Math.sqrt(a));
  const släppT = T0 + Math.min(300000, (d / (2.2 * 1852 / 3600)) * 1000 - constants.BRIDGE_OPENING.WARNING_LEAD_MS);
  const wT = släppT + förskjutMs;
  const tc = wT + 40000;
  const w = {
    eventId: 'Stridsbergsbron#1', bridge: 'Stridsbergsbron', t: wT, firedBy: 'deadline', leadMmsi: MMSI, mmsis: [MMSI],
  };
  const f = {
    orakel: 'T2',
    klass: 'LEDTID<60s',
    bro: 'Stridsbergsbron',
    mmsi: MMSI,
    riktning: 'northbound',
    belägg: { korsningT: tc, korsning: { dir: 'nord', t: new Date(tc).toISOString() }, varning: { eventId: w.eventId, t: new Date(wT).toISOString() } },
  };
  const ctx = {
    rader: [F, {
      ...F, aisTimestamp: tc + 60000, fixTs: tc + 60000, ...B.Stallbackabron,
    }],
    resultat: {
      openingWarnings: [w],
      openingHolds: [
        {
          t: T0 - 60000, mmsi: MMSI, bridge: 'Stridsbergsbron', typ: 'håll', av: 'Järnvägsbron', gren: '300 s',
        },
        {
          t: wT, mmsi: MMSI, bridge: 'Stridsbergsbron', typ: 'släpp', skäl,
        },
      ],
    },
  };
  return { f, ctx };
}

describe('A11-SPÄRR-VID-TIDIGARE-BRO (a11SparrSlapp)', () => {
  const fn = P('a11SparrSlapp');
  test('varningen på rörelsegrenens släpptid, med appens håll och släpp: känns igen', () => {
    const { f, ctx } = spärrFall();
    expect(fn(f, ctx).sant).toBe(true);
  });
  test('[mutant] släppet 120 s senare än regeln: KANDIDAT', () => {
    const { f, ctx } = spärrFall({ förskjutMs: 120000 });
    expect(fn(f, ctx).sant).toBe(false);
  });
  test('[motfall] utan appens bokförda håll: KANDIDAT', () => {
    const { f, ctx } = spärrFall();
    ctx.resultat.openingHolds = ctx.resultat.openingHolds.filter((h) => h.typ !== 'håll');
    expect(fn(f, ctx).sant).toBe(false);
  });
  test('[motfall] resultat utan openingHolds: KANDIDAT', () => {
    const { f, ctx } = spärrFall();
    delete ctx.resultat.openingHolds;
    expect(fn(f, ctx).sant).toBe(false);
  });
});

describe('A11-U18-INGEN-OMVÄND-FIX (a11ReturUtanOmvandFix)', () => {
  const fn = P('a11ReturUtanOmvandFix');
  const uT = T0; const tc = T0 + 5 * 60000;
  const bas = (rader, resets = []) => ({
    f: {
      orakel: 'T2',
      klass: 'ÖPPNING-MISS:OKLASSAD',
      bro: 'Klaffbron',
      mmsi: MMSI,
      riktning: 'southbound',
      belägg: { korsningT: tc, korsning: { dir: 'syd', t: new Date(tc).toISOString() } },
    },
    ctx: { rader, sanning: { uturns: [{ mmsi: MMSI, t: uT, s: 2900 }] }, resultat: { journeyResets: resets } },
  });
  const rad = (t, sog, cog) => ({
    mmsi: MMSI, aisTimestamp: t, fixTs: t, sog, cog, ...mellan(B.Klaffbron, B.Järnvägsbron, 0.5),
  });
  test('ingen omvänd rad i minst 2 kn och ingen riktningshändelse: känns igen', () => {
    const { f, ctx } = bas([rad(uT + 30000, 0.8, 200), rad(tc + 30000, 5, 200)]);
    expect(fn(f, ctx).sant).toBe(true);
  });
  test('[mutant] en omvänd rad i 4 kn före korsningen (Fix D hade kunnat bekräfta): KANDIDAT', () => {
    const { f, ctx } = bas([rad(uT + 30000, 4, 200), rad(tc + 30000, 5, 200)]);
    expect(fn(f, ctx).sant).toBe(false);
  });
  test('[motfall] appen bokförde en riktningshändelse före korsningen: KANDIDAT', () => {
    const { f, ctx } = bas([rad(uT + 30000, 0.8, 200)], [{ mmsi: MMSI, t: uT + 30000 }]);
    expect(fn(f, ctx).sant).toBe(false);
  });
});
