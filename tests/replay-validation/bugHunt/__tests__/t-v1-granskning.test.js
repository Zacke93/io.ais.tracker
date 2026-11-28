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
 *   M3-eta     den visade tiden + 6 min i en halvminut (samma bärare)
 *   M5         appens U21-gräns + 15 min
 *   orörd:n295 nattvärld 295 med orörd app (U2-beslutet om den senaste bindningen)
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
/** Dömer en mutantkörning ur fixturen; `sanning(b)` får ändra den byggda världens sanning före domen. */
function mutant(nyckel, sanning = null) {
  const x = kopia(M[nyckel]);
  const b = core.materialize(x.spec, { profile: x.radio });
  if (sanning) sanning(b);
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

describe('U2 och den senaste bindningen (dirigentens beslut 2026-11-16, nattvärld 295)', () => {
  const HAVSORN = '265349432';
  const ledtid = (fynd) => fynd.find((f) => f.orakel === 'T2' && /^LEDTID/.test(f.klass) && String(f.mmsi) === HAVSORN);

  test('HAVSORN, släppt ur #1 och varnad i #3 28 s före korsningen 3 min efter #1:s första passage: U2-VS-DEADLINE', () => {
    const f = ledtid(mutant('orörd:n295'));
    expect(f).toBeDefined();
    expect([f.register.klass, f.register.post]).toEqual(['KÄND_ÖPPEN', 'U2-VS-DEADLINE']);
  });

  test('[motfall] samma värld med #1:s första passage flyttad så att korsningen ligger 11 min efter den: KANDIDAT', () => {
    const f = ledtid(mutant('orörd:n295', (b) => {
      const egen = b.truth.L1.crossings.find((c) => String(c.mmsi) === HAVSORN && c.bridge === 'Stridsbergsbron');
      const först = b.truth.L1.crossings.find((c) => String(c.mmsi) === '265349363' && c.bridge === 'Stridsbergsbron');
      först.t = egen.t - 11 * MIN;
      if (Number.isFinite(först.tTo)) först.tTo = först.t;
      b.truth.L1.crossings.sort((x, y) => x.t - y.t);
    }));
    expect(f).toBeDefined();
    expect(f.register.klass).toBe('KANDIDAT');
  });

  test('[motfall] en båt som aldrig var bunden till #1 täcks inte (gren ii kommer inte tillbaka)', () => {
    const f = ledtid(mutant('orörd:n295', (b) => b)); // kontroll: samma värld
    expect(f.register.post).toBe('U2-VS-DEADLINE');
    const konvoj = require('../lib/konvoj');
    const x = kopia(M['orörd:n295']);
    const r = x.utfall.resultat;
    const w1 = r.openingWarnings.find((w) => w.eventId === 'Stridsbergsbron#1');
    const kors = [{ mmsi: '265349363', bridge: 'Stridsbergsbron', t: w1.t + 11 * MIN }, { mmsi: HAVSORN, bridge: 'Stridsbergsbron', t: w1.t + 14 * MIN }];
    const utan = r.openingCoverage.filter((c) => !(String(c.mmsi) === HAVSORN && c.eventId === 'Stridsbergsbron#1'));
    expect(konvoj.täcktAv(w1, HAVSORN, r.openingCoverage, kors[1].t, kors).sant).toBe(true);
    expect(konvoj.täcktAv(w1, HAVSORN, utan, kors[1].t, kors).sant).toBe(false);
  });

  test('nattkortet F23 r1 (BRISEN släppt ur Klaffbron#1, korsade 207 s före dess första passage) döms som förut', () => {
    expect(utslag(döm('F23-r1').fynd, /^T2 ÖPPNING-MISS/).register.post).toBe('U2-VS-DEADLINE');
  });
});

describe('U34: den nya nivån ska hålla (mutanten M3, uppblåst tid i en halvminut)', () => {
  test('[mutant] M3-eta:s627: hoppet 4 → 10 bakom ett ledarbyte, som inte håller, är KANDIDAT', () => {
    const f = mutant('M3-eta:s627').find((x) => x.inv === 'INV-3' && /ETA-SÅGTAND UPP/.test(x.klass) && /4→10/.test(x.detalj));
    expect(f).toBeDefined();
    expect(f.register.klass).toBe('KANDIDAT');
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
  // U90 (spår C, omgång 11): F09 r1 är VEGA, samma värld som nattkortet F06
  // r1 efter omgång 10. R2 känner fortfarande inte igen den (appens utdata
  // förklarar inte appen), men P5-posten gör det på radernas kurser.
  test('F09 r1 känns inte igen av R2 (appens utdata förklarar inte appen); sedan U90 är den C-P5-SYDBAND-FÖRE-LINJEN', () => {
    const f = utslag(döm('F09-r1').fynd, /^INV-F INV-13/);
    expect(f.register.post).toBe('C-P5-SYDBAND-FÖRE-LINJEN');
    expect(f.register.prövade.map((p) => p.post)).toContain('R2-MÅLBRO-EFTER-LINJEN');
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

describe('U43: två kända gränser efter riktningsändringen (dirigentens beslut 2026-11-16)', () => {
  test('(1) F12 r1: dödbandskursen 52° mitt i U-svängen: U43-DÖDBAND-I-U-SVÄNG; F12 r3 är fortfarande U18', () => {
    expect(post(...Object.values(fall('F12-r1', /^T9 FEL-RIKTNING/)))).toEqual(['KÄND_ÖPPEN', 'U43-DÖDBAND-I-U-SVÄNG']);
    expect(post(...Object.values(fall('F12-r3', /^T9 FEL-RIKTNING/)))).toEqual(['DESIGN', 'U18-RETUR-BEKRÄFTAD-SENT']);
  });

  test('[motfall] (1) F12 r1 med 52° utbytt mot en ren nordlig kurs (två omvända i följd, appen borde ha bekräftat): KANDIDAT', () => {
    const { fynd } = döm('F12-r1', {
      mutera: (r, b) => {
        for (const x of b.rows) if (x.mmsi === '265313289' && x.cog === 52) x.cog = 17;
      },
    });
    expect(utslag(fynd, /^T9 FEL-RIKTNING/).register.klass).toBe('KANDIDAT');
  });

  test('(2) F10 r3: enda fixen 13 m bortom Järnvägsbron, nästa först efter U-svängen: U43-PARBRO-FÖRE-U-SVÄNG', () => {
    expect(post(...Object.values(fall('F10-r3', /^T1 NOTIS-UTEBLIVEN/)))).toEqual(['KÄND_ÖPPEN', 'U43-PARBRO-FÖRE-U-SVÄNG']);
  });

  test('[motfall] (2) F10 r3 med en fix till 30 s efter, söder om bron före vändningen: KANDIDAT', () => {
    const { fynd } = döm('F10-r3', {
      mutera: (r, b) => {
        const x = b.rows.find((y) => y.mmsi === '265292276' && Math.abs(y.aisTimestamp - Date.parse('2026-08-21T08:26:36.432Z')) < 1000);
        b.rows.push({
          ...x, aisTimestamp: x.aisTimestamp + 30000, fixTs: (x.fixTs || x.aisTimestamp) + 30000, lat: x.lat - 0.0012,
        });
        b.rows.sort((y, z) => y.aisTimestamp - z.aisTimestamp);
      },
    });
    expect(utslag(fynd, /^T1 NOTIS-UTEBLIVEN/).register.klass).toBe('KANDIDAT');
  });
});
