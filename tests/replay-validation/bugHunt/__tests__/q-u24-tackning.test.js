'use strict';

/**
 * U24-DELAD-KÖ-EXTRA-VARNING: täckningsslutet i E kom i tid (2026-11-16,
 * omgranskningen av verktygsgrenen).
 *
 * Posten godtar en extra varning på ett fruset fix när båten delade kö med en
 * båt som U24 släppte, och hennes varning följer inom en tick på hennes
 * täckningsslut i händelsen E. Den prövade inte NÄR täckningsslutet kom. Under
 * granskarens mutanter u17arm120 (armens täckningsslut 2 min för sent) och
 * u17slapp120 (släppet 2 min för sent) tog posten standardvärld 143 med
 * varningen 11:38:10 i stället för appens 11:36:10. Nu gäller samma prov som
 * U17:s villkor (3″) (täckningsslutetsGräns).
 *
 * Fixturen fixtures/u24-tackning-2026-11-16.json (standardkörningen, basSeed 1,
 * trimmad och kontrollerad mot hela världen): bas143 (058c6e9, oförändrad
 * app; baslinjens enda U24-utslag), arm120w143 och slapp120w143 (mutanterna).
 * Inga barnprocesser och inga timers.
 */

const { loadRegistry, PREDICATES } = require('../lib/registry');
const C = require('../../../../lib/constants');
const F = require('./fixtures/u24-tackning-2026-11-16.json');

const U24 = 'U24-DELAD-KÖ-EXTRA-VARNING';
const TICK = C.BRIDGE_OPENING.TICK_INTERVAL_MS;
const kopia = (x) => JSON.parse(JSON.stringify(x));
const fall = (k) => {
  const x = kopia(F[k]);
  return { fynd: x.fynd[0], ctx: x.ctx };
};
const p24 = (f, ctx) => PREDICATES.u24DeladKö.fn(f, ctx, PREDICATES.u24DeladKö.parametrar);
// Hennes dom 'täckningsslut' i E (Stridsbergsbron#3) och varningen efter den.
const E = 'Stridsbergsbron#3';
const släppet = (fynd, ctx) => ctx.resultat.openingCoverageVerdicts
  .filter((v) => String(v.mmsi) === String(fynd.mmsi) && v.eventId === E && v.verdict.kind === 'täckningsslut').pop();

let reg;
beforeAll(() => {
  reg = loadRegistry();
});

describe('U24-DELAD-KÖ-EXTRA-VARNING: täckningsslutet i tid', () => {
  test('[träff] baslinjen (värld 143) är U24 som förut', () => {
    const { fynd, ctx } = fall('bas143');
    expect(reg.classify(fynd, ctx, { räkna: false }).post).toBe(U24);
  });

  test.each([
    ['arm120w143', /täckningsslutet 11:38:10 ur Stridsbergsbron#3 kom mer än en tick efter slutet 11:36:10 som motorn räknar ur händelsen .*armens 11:38:10/],
    ['slapp120w143', /täckningsslutet 11:38:10 ur Stridsbergsbron#3 kom mer än en tick efter slutet 11:36:10 som motorn räknar ur händelsen .*armens 11:36:10/],
  ])('[vakt] mutanten i %s: släppet två minuter för sent; KANDIDAT', (k, skäl) => {
    const { fynd, ctx } = fall(k);
    expect(p24(fynd, ctx)).toMatchObject({ sant: false, skäl: expect.stringMatching(skäl) });
    expect(reg.classify(fynd, ctx, { räkna: false }).klass).toBe('KANDIDAT');
  });

  test('[träff] släppet strax under en tick efter motorns slut ligger inom marginalen; strax över fälls', () => {
    const a = fall('bas143');
    const s = släppet(a.fynd, a.ctx);
    // Släppet, varningen och armens slut flyttas; motorns slut står kvar.
    const w = a.ctx.resultat.openingWarnings.find((x) => x.eventId === a.fynd.belägg.varning.eventId);
    // Basens släpp ligger 1 ms efter motorns slut.
    s.t += TICK - 10;
    w.t = s.t;
    s.arm.coverUntilMs += TICK - 10;
    expect(p24(a.fynd, a.ctx).sant).toBe(true);
    const b = fall('bas143');
    const s2 = släppet(b.fynd, b.ctx);
    const w2 = b.ctx.resultat.openingWarnings.find((x) => x.eventId === b.fynd.belägg.varning.eventId);
    s2.t += TICK + 10;
    w2.t = s2.t;
    s2.arm.coverUntilMs += TICK + 10;
    expect(p24(b.fynd, b.ctx).skäl).toMatch(/kom mer än en tick efter slutet/);
  });

  test('[vakt] utan absorption i E går slutet inte att räkna: nej', () => {
    const { fynd, ctx } = fall('bas143');
    ctx.resultat.openingCoverage = ctx.resultat.openingCoverage.filter((c) => !(c.eventId === E && String(c.mmsi) === String(fynd.mmsi) && c.reason === 'absorbed'));
    expect(p24(fynd, ctx).sant).toBe(false);
  });
});
