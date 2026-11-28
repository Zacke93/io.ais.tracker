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
