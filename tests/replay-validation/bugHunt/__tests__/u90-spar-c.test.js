'use strict';

/**
 * U90, spår C (omgång 11): registrets och oraklets ändringar för nattkorten
 * F06, F09, F10 och F14 (nattjakten efter omgång 10, seed 1). Varje post prövas
 * åt båda hållen: kortets minsta repro känns igen, och ett motfall där appen
 * eller världen ändrats i just den punkt som posten bygger på blir KANDIDAT.
 *
 * fixtures/u90-spar-c-2026-11-28.json: korten minsta repro (världens spec och
 * appens replayresultat på 5a975d8). Inga barnprocesser och inga timers.
 */

const core = require('../lib/synthCore');
const { loadRegistry } = require('../lib/registry');
const F = require('./fixtures/u90-spar-c-2026-11-28.json');

const MIN = 60000;
const kopia = (x) => JSON.parse(JSON.stringify(x));
let REG = null;
const register = () => {
  if (!REG) REG = loadRegistry();
  return REG;
};

/** Dömer kortet `id`; `mutera(resultat, built)` får ändra kopior före domen. */
function döm(id, mutera = null) {
  const x = kopia(F[id]);
  const built = core.materialize(x.spec, { profile: x.radio });
  const b = { ...built, rows: built.rows.map((r) => ({ ...r })) };
  if (mutera) mutera(x.utfall.resultat, b);
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
const utslag = (fynd, re) => fynd.find((f) => re.test(`${f.orakel} ${f.klass}`));
const klass = (f) => [f.register.klass, f.register.post || null];

describe('F06: R2-MÅLBRO-EFTER-LINJEN, livet efter appens radering utanför kanalens gräns', () => {
  test.each(['F06-r2-orion', 'F06-r3-masen'])('%s: R2', (id) => {
    expect(klass(utslag(döm(id), /^INV-F INV-13/))).toEqual(['DESIGN', 'R2-MÅLBRO-EFTER-LINJEN']);
  });

  test('[motfall] F06 r2 utan appens radering i domspåret: KANDIDAT', () => {
    const f = utslag(döm('F06-r2-orion', (r) => {
      r.vesselRemovals = r.vesselRemovals.filter((x) => x.mmsi !== '265562103' || x.reason !== 'timeout');
    }), /^INV-F INV-13/);
    expect(f.register.klass).toBe('KANDIDAT');
  });

  test('[motfall] F06 r2 med raderingen efter 30 min (appen hade då kunnat ha målbro): KANDIDAT', () => {
    const f = utslag(döm('F06-r2-orion', (r, b) => {
      const sista = b.rows.filter((x) => x.mmsi === '265562103' && x.lon > 12.32).pop();
      const rad = r.vesselRemovals.find((x) => x.mmsi === '265562103' && x.reason === 'timeout');
      rad.t = sista.aisTimestamp + 30 * MIN + 1000;
      // Nästa rad flyttas så att raderingen fortfarande ligger i glappet.
      for (const x of b.rows) if (x.mmsi === '265562103' && x.aisTimestamp > sista.aisTimestamp) x.aisTimestamp += 20 * MIN;
    }), /^INV-F INV-13/);
    expect(f === undefined || f.register.klass === 'KANDIDAT').toBe(true);
  });

  test('[motfall] F06 r2 med raden före glappet inne i kanalen: KANDIDAT', () => {
    const f = utslag(döm('F06-r2-orion', (r, b) => {
      for (const x of b.rows) if (x.mmsi === '265562103' && x.lon > 12.32) x.lon = 12.3195;
    }), /^INV-F INV-13/);
    expect(f.register.klass).toBe('KANDIDAT');
  });
});

describe('F06: C-P5-SYDBAND-FÖRE-LINJEN', () => {
  test('VEGA (värld 19102), 228° 215 m före Stridsbergsbron: P5, och R2 känner inte igen den', () => {
    const f = utslag(döm('F06-r1-vega'), /^INV-F INV-13/);
    expect(klass(f)).toEqual(['DESIGN', 'C-P5-SYDBAND-FÖRE-LINJEN']);
    expect(f.register.prövade.map((p) => p.post)).toContain('R2-MÅLBRO-EFTER-LINJEN');
  });

  test('[motfall] samma rad med 220° (i det strikta sydbandet, appen kunde ge målbro): KANDIDAT', () => {
    const f = utslag(döm('F06-r1-vega', (r, b) => {
      for (const x of b.rows) if (x.mmsi === '265827977' && x.cog === 228) x.cog = 220;
    }), /^INV-F INV-13/);
    expect(f.register.klass).toBe('KANDIDAT');
  });

  test('[motfall] samma rad utan kurs: KANDIDAT', () => {
    const f = utslag(döm('F06-r1-vega', (r, b) => {
      for (const x of b.rows) if (x.mmsi === '265827977' && x.cog === 228) x.cog = null;
    }), /^INV-F INV-13/);
    expect(f.register.klass).toBe('KANDIDAT');
  });
});

describe('F09: oraklets U17-kedja och U19:s RECOVER-prov', () => {
  test('ALVA (värld 13468): VARNING-EFTER-SANN-PASSAGE, U17-TYST-BÅT-RECOVER (förut FANTOM-UTAN-AVBROTT)', () => {
    const fynd = döm('F09-r1-alva');
    expect(utslag(fynd, /^T3 FANTOM-UTAN-AVBROTT/)).toBeUndefined();
    expect(klass(utslag(fynd, /^T3 VARNING-EFTER-SANN-PASSAGE/))).toEqual(['DESIGN', 'U17-TYST-BÅT-RECOVER']);
  });

  test('[motfall] ALVA med varningen 120 s efter täckningsslutet (släppet senare än appens regel): KANDIDAT', () => {
    const fynd = döm('F09-r1-alva', (r) => {
      const w = r.openingWarnings.find((x) => (x.mmsis || []).includes('265056076') && x.t > Date.parse('2026-09-13T09:09:00Z'));
      w.t += 120000;
    });
    const t3 = fynd.filter((f) => f.orakel === 'T3' && f.mmsi === '265056076');
    expect(t3.length).toBe(1);
    expect(t3[0].register.klass).toBe('KANDIDAT');
  });

  test('IRMA (värld 15940): RECOVER-provet läser domspåret och avvisar inte längre på absorptionen; KANDIDAT av ett annat skäl (RE_CROSS)', () => {
    const f = utslag(döm('F09-r2-irma'), /^T3 FANTOM-UTAN-AVBROTT/);
    expect(f.register.klass).toBe('KANDIDAT');
    expect(f.register.närmast.post).toBe('U19-VARNING-UNDER-VÄNTANDE-VÄNDNING');
    expect(f.register.närmast.skäl).not.toMatch(/absorberades/);
  });

  test('[motfall] IRMA med en dom täckningsslut vid varningens tick: RECOVER-släpp', () => {
    const f = utslag(döm('F09-r2-irma', (r) => {
      const w = r.openingWarnings.find((x) => (x.mmsis || []).includes('265274506') && x.bridge === 'Klaffbron');
      r.openingCoverageVerdicts.push({
        t: w.t - 1, mmsi: '265274506', bridge: 'Klaffbron', eventId: 'Klaffbron#2', verdict: { kind: 'täckningsslut' },
      });
    }), /^T3 FANTOM-UTAN-AVBROTT/);
    expect(f.register.klass).toBe('KANDIDAT');
    expect(f.register.närmast.skäl).toMatch(/RECOVER-släpp/);
  });
});

describe('F10: C-FIXD-DÖDBAND-NOLLAR-VÄNDNING', () => {
  test('GUNHILD (värld 18849): flaggan 30°, nollad av 75,4° 255 m längre norrut', () => {
    expect(klass(utslag(döm('F10-r1-gunhild'), /^T9 FEL-RIKTNING/))).toEqual(['KÄND_ÖPPEN', 'C-FIXD-DÖDBAND-NOLLAR-VÄNDNING']);
  });

  test('[motfall] den andra fixen med 20° (nordbandet; Fix D borde ha bekräftat): KANDIDAT', () => {
    const f = utslag(döm('F10-r1-gunhild', (r, b) => {
      for (const x of b.rows) if (x.mmsi === '265703867' && x.cog === 75.4) x.cog = 20;
    }), /^T9 FEL-RIKTNING/);
    expect(f.register.klass).toBe('KANDIDAT');
  });

  test('[motfall] dödbandsfixen bara 40 m längre norrut (brus): KANDIDAT', () => {
    const f = utslag(döm('F10-r1-gunhild', (r, b) => {
      const egna = b.rows.filter((x) => x.mmsi === '265703867');
      const c = egna.find((x) => x.cog === 75.4);
      const bRad = egna[egna.indexOf(c) - 1];
      c.lat = bRad.lat + 40 / 111320;
    }), /^T9 FEL-RIKTNING/);
    expect(f.register.klass).toBe('KANDIDAT');
  });
});

describe('F14: C-ENSAM-FIX-FÖRE-MELLANBRO', () => {
  test('WILMA (värld 7810): enda fixen 20 m före Järnvägsbron bokförde Klaffbron, inga fler rader', () => {
    expect(klass(utslag(döm('F14-r1-wilma'), /^T1 NOTIS-UTEBLIVEN/))).toEqual(['KÄND_ÖPPEN', 'C-ENSAM-FIX-FÖRE-MELLANBRO']);
  });

  test('[motfall] utan Klaffbrons bokföring vid fixen: KANDIDAT', () => {
    const f = utslag(döm('F14-r1-wilma', (r) => {
      r.targetPassages = r.targetPassages.filter((x) => x.mmsi !== '265577961' || x.bridge !== 'Klaffbron');
      r.intermediatePassages = r.intermediatePassages.filter((x) => x.mmsi !== '265577961' || x.bridge !== 'Klaffbron');
    }), /^T1 NOTIS-UTEBLIVEN/);
    expect(f.register.klass).toBe('KANDIDAT');
  });

  test('[motfall] fixen 90 m före bron (utanför under-bron-bandet): KANDIDAT', () => {
    const f = utslag(döm('F14-r1-wilma', (r, b) => {
      const x = b.rows.find((y) => y.mmsi === '265577961' && Math.abs(y.aisTimestamp - Date.parse('2026-06-08T07:41:30.573Z')) < 1000);
      x.lat -= 70 / 111320;
    }), /^T1 NOTIS-UTEBLIVEN/);
    expect(f === undefined || f.register.klass === 'KANDIDAT').toBe(true);
  });
});
