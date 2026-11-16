'use strict';

/**
 * Granskningen av V1 (2026-11-16, domen ÄNDRINGAR KRÄVS): granskaren lurade
 * sju uppmjukningar med avsiktligt införda fel i en kopia av appen
 * (mutanterna) eller med motfall ur nattens representanter. Varje test här
 * bygger på granskarens mutant eller motfall och var rött på V1:s förra HEAD
 * (`e6f28c1`): verktyget kallade felet DESIGN, ACCEPTERAD, MÄTGRÄNS eller
 * KÄND_ÖPPEN där basens verktyg sa KANDIDAT.
 *
 * fixtures/granskning-v1-2026-11-16.json: världens spec och den muterade
 * appens replayresultat (granskarens körningar):
 *   M1-andra   en andra händelse vid samma bro inom 20 min avfyras inte
 *   M7         reserven för en tyst köande båt 3 min sen
 *   M3b-ledare ledaren byts när den främsta varit tyst 90–300 s
 *   M5         appens U21-gräns + 15 min
 * Inga barnprocesser och inga timers.
 */

const core = require('../lib/synthCore');
const C = require('../../../../lib/constants');
const { döm, register, utslag } = require('./nattV1');
const M = require('./fixtures/granskning-v1-2026-11-16.json');

const MIN = 60000;
const kopia = (x) => JSON.parse(JSON.stringify(x));
const klassa = (f, ctx) => register().classify(f, ctx, { räkna: false });
const post = (f, ctx) => {
  const c = klassa(f, ctx);
  return [c.klass, c.post || null];
};
/** Dömer en mutantkörning ur fixturen. */
function mutant(nyckel) {
  const x = kopia(M[nyckel]);
  const b = core.materialize(x.spec, { profile: x.radio });
  const dom = core.judgeBuilt({
    built: b,
    utfall: x.utfall,
    jsonlPath: null,
    register: register(),
    meta: {
      index: x.index, radio: x.radio, monitoring: x.monitoring, profil: 'repro',
    },
    räkna: false,
  });
  return dom.fynd.filter((f) => !f.räknare);
}
const fall = (id, re) => {
  const d = döm(id);
  return { f: utslag(d.fynd, re), ctx: d.kontext };
};

describe('H1: den fysiska öppningen är borttagen (mutanten M1)', () => {
  test.each(['M1-andra:s122', 'M1-andra:s63'])('[mutant] %s: båten som inte fick sin egen varning är KANDIDAT', (k) => {
    const t2 = mutant(k).filter((f) => f.orakel === 'T2');
    expect(t2.length).toBeGreaterThan(0);
    expect(t2.every((f) => f.register.klass === 'KANDIDAT')).toBe(true);
  });

  test('nattkorten F22 r1 och F02 r2 står kvar som KANDIDAT', () => {
    expect(utslag(döm('F22-r1').fynd, /^T2 LEDTID/).register.klass).toBe('KANDIDAT');
    expect(utslag(döm('F02-r2').fynd, /^T2 ÖPPNING-MISS/).register.klass).toBe('KANDIDAT');
  });
});

describe('H2: STILLA_KÖ_AVGÅNG_OSEDD kräver passagen före reserven + en tick (mutanten M7)', () => {
  test('[mutant] nattvärld 8967 med reserven 3 min sen: missen är KANDIDAT', () => {
    const miss = mutant('M7:n8967').filter((f) => /ÖPPNING-MISS/.test(f.klass));
    expect(miss).toHaveLength(1);
    expect(miss[0].register.klass).toBe('KANDIDAT');
  });
});

describe('H3: varje saknad notis i INV-5 har sin egen förklaring', () => {
  const extraPassage = (ctx, f) => {
    const c = kopia(ctx);
    const sista = c.resultat.targetPassages.filter((x) => String(x.mmsi) === String(f.mmsi) && x.bridge === f.bro).pop();
    c.resultat.targetPassages.push({ ...sista, t: sista.t + 30 * MIN });
    return c;
  };
  const underskott2 = (f) => ({ ...f, detalj: f.detalj.replace(/(\d+) registrerade passager men (\d+) notis/, (_, a, b) => `${Number(a) + 1} registrerade passager men ${b} notis`) });

  test('[motfall] F14 r1 (U39) med en extra saknad notis: KANDIDAT', () => {
    const { f, ctx } = fall('F14-r1', /^INV-F INV-5/);
    expect(post(f, ctx)).toEqual(['ACCEPTERAD', 'U39-RETUR-EFTER-RADERING']);
    expect(post(underskott2(f), extraPassage(ctx, f))).toEqual(['KANDIDAT', null]);
  });

  test('[motfall] F14 r2 (U21) med en extra saknad notis: KANDIDAT', () => {
    const { f, ctx } = fall('F14-r2', /^INV-F INV-5/);
    expect(post(f, ctx)).toEqual(['DESIGN', 'U21-RETUR-EFTER-10-MIN']);
    expect(post(underskott2(f), extraPassage(ctx, f))).toEqual(['KANDIDAT', null]);
  });

  test('[motfall] U39-spärren vid en annan passage än den saknade räknas inte', () => {
    const { f, ctx } = fall('F14-r1', /^INV-F INV-5/);
    const c = kopia(ctx);
    for (const b of c.resultat.persistentDedupBlocks) b.t -= 10 * MIN;
    expect(post(f, c)).toEqual(['KANDIDAT', null]);
  });
});

describe('H4: U18:s T9-gren kräver att ingen riktningshändelse kom före notisen', () => {
  test('[motfall] F12 r3 med en journeyReset 90 s före notisen: KANDIDAT', () => {
    const { f, ctx } = fall('F12-r3', /^T9 FEL-RIKTNING/);
    expect(post(f, ctx)).toEqual(['DESIGN', 'U18-RETUR-BEKRÄFTAD-SENT']);
    const c = kopia(ctx);
    c.resultat.journeyResets.push({ t: f.t - 90000, mmsi: String(f.mmsi) });
    expect(post(f, c)).toEqual(['KANDIDAT', null]);
  });
});

describe('H5: U25:s vidgning för skattningsfelet är borttagen', () => {
  test('F06 r3 är KANDIDAT', () => {
    const { f, ctx } = fall('F06-r3', /^T3 VARNING-EFTER-SANN-PASSAGE/);
    expect(post(f, ctx)).toEqual(['KANDIDAT', null]);
  });
});

describe('H6: INV-10-väntkedjans stillhet gäller den båt som bar strax', () => {
  test('[motfall] F18 med väntaren i rörelse fram till bekräftelsen och en ANNAN båt stilla vid bron: KANDIDAT', () => {
    const { f, ctx } = fall('F18-r1', /^INV-F INV-10/);
    expect(post(f, ctx)).toEqual(['MÄTGRÄNS', 'MÄTGRÄNS-INV10-VÄNTKEDJA']);
    const c = kopia(ctx);
    const { från } = f.belägg.väntan.intervall[0];
    for (const r of c.rader) if (r.mmsi === '265779755' && r.aisTimestamp < från - 1000) r.sog = 3.5;
    const mall = c.rader.find((r) => r.mmsi === '265779755' && r.aisTimestamp >= från - 1000);
    for (let t = f.belägg.väntan.från + MIN; t <= från; t += Math.min(2 * MIN, Math.max(30000, från - t - 30000))) {
      c.rader.push({
        ...mall, mmsi: '265000777', aisTimestamp: t, fixTs: t, sog: 0,
      });
    }
    c.rader.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
    expect(post(f, c)).toEqual(['KANDIDAT', null]);
  });
});

describe('H7: U34 gren (c) kräver uttömningens stämpel och tystnad över 300 s (mutanten M3b)', () => {
  test.each(['M3b-ledare:s578', 'M3b-ledare:s1975'])('[mutant] %s: ledarbytet när den främsta var tyst 90–300 s är KANDIDAT', (k) => {
    const inv3 = mutant(k).filter((f) => f.inv === 'INV-3');
    expect(inv3.length).toBeGreaterThan(0);
    expect(inv3.filter((f) => f.register.post === 'LEDARBYTE-TYST-FRÄMSTA')).toEqual([]);
  });
});

describe('medel: en returnotis senare än U21:s 10 min fälls (mutanten M5)', () => {
  test('[mutant] F14 r2 med returen 754 s efter korsningen: SEN RETURNOTIS (fatalt, KANDIDAT)', () => {
    const f = mutant('M5:F14-r2').find((x) => /SEN RETURNOTIS/.test(x.klass));
    expect(f).toBeDefined();
    expect(f.register.klass).toBe('KANDIDAT');
  });
});

describe('medel: verktygets egna beslutade tal mot appens konstanter', () => {
  test('U21 10 min, U2 600 s, U38 5 min och tick 30 s, tystnadsgrenarna 300/600 s', () => {
    const inv = require('../../invariants');
    const gates = require('../../runOpeningGates');
    const konvoj = require('../lib/konvoj');
    const reg = require('../lib/registry');
    // Avviker appens konstant fälls testet: beslutet ska då prövas, inte följa med.
    expect(C.UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS).toBe(inv.U21_RETURN_MAX_LATENESS_MS);
    expect(C.UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS).toBe(reg.U21_MS);
    expect(C.UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS).toBe(gates.U38_RESERVE_MS);
    expect(C.UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS).toBe(reg.STALE_SOFT_MS);
    expect(C.UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS).toBe(reg.STALE_HARD_MS);
    expect(C.BRIDGE_OPENING.TICK_INTERVAL_MS).toBe(gates.U38_TICK_MS);
    expect(C.BRIDGE_OPENING.CONVOY_WINDOW_MS).toBe(konvoj.U2_FÖNSTER_MS);
    expect(reg.PREDICATES.missklassAccepterad.parametrar.reservMs).toBe(gates.U38_RESERVE_MS);
  });
});

describe('medel: R2 utan villkor (c), KAJVOBBEL kräver reservens tystnad', () => {
  test('F09 r1 är KANDIDAT (appens utdata förklarar inte appen)', () => {
    expect(utslag(döm('F09-r1').fynd, /^INV-F INV-13/).register.klass).toBe('KANDIDAT');
  });

  test('[motfall] F19 med en rad från köaren 2 min före varningen: FANTOM:KAJVOBBEL', () => {
    const { fynd } = döm('F19-r1', {
      mutera: (r, b) => {
        const w = r.openingWarnings.find((x) => x.eventId === 'Klaffbron#5');
        const mall = b.rows.filter((x) => x.mmsi === '265012524' && x.aisTimestamp < w.t).pop();
        b.rows.push({ ...mall, aisTimestamp: w.t - 2 * MIN, fixTs: w.t - 2 * MIN });
        b.rows.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
      },
    });
    expect(utslag(fynd, /KAJVOBBEL/)).toBeDefined();
  });
});
