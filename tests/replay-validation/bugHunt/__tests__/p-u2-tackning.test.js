'use strict';

/**
 * U2-VS-DEADLINE: täckningen som höll båten vid korsningen hade rätt längd
 * (2026-11-16, granskningen av verktygsgrenen, punkt 6).
 *
 * Posten godtar en utebliven varning när båten var täckt av en äldre händelse
 * E och korsningen ligger inom E:s första passage + CONVOY_WINDOW_MS. Med
 * granskarens mutant u17arm300 (armens täckningsslut 5 min för sent i
 * BridgeOpeningService) uteblev U24:s släpp på båtens egen deadline och
 * hennes varning i standardvärldarna 449, 1089 och 1214, där basen släpper och
 * varnar henne. Posten kallade utfallet den kända U2-konflikten. Nu får
 * varken armens täckningsslut eller domens fönsterslut i hennes sista dom i E
 * före korsningen ligga mer än en tick efter max(E:s avfyrning, bokföringen
 * av E:s första passage) + CONVOY_WINDOW_MS.
 *
 * Fixturen fixtures/u2-tackning-2026-11-16.json (standardkörningen, basSeed 1,
 * trimmad och kontrollerad mot hela världen):
 *  - mut449, mut1089, mut1214: världarna körda med mutanten;
 *  - bas8, bas1089: två av baslinjens 27 U2-utslag på 058c6e9 (oförändrad app).
 * Inga barnprocesser och inga timers.
 */

const { loadRegistry, PREDICATES } = require('../lib/registry');
const C = require('../../../../lib/constants');
const F = require('./fixtures/u2-tackning-2026-11-16.json');

const U2 = 'U2-VS-DEADLINE';
const TICK = C.BRIDGE_OPENING.TICK_INTERVAL_MS;
const kopia = (x) => JSON.parse(JSON.stringify(x));
const fall = (k) => {
  const x = kopia(F[k]);
  return { fynd: x.fynd[0], ctx: x.ctx };
};
const pred = (extra = {}) => (f, ctx) => PREDICATES.crossingWithinEventWindow.fn(f, ctx, { ...PREDICATES.crossingWithinEventWindow.parametrar, ...extra });
const p2 = pred();
// Hennes domar i händelsen E före korsningen.
const domarI = (fynd, ctx, E) => ctx.resultat.openingCoverageVerdicts
  .filter((v) => String(v.mmsi) === String(fynd.mmsi) && v.bridge === fynd.bro && v.eventId === E && v.t <= fynd.belägg.korsningT);

let reg;
beforeAll(() => {
  reg = loadRegistry();
});

describe('U2-VS-DEADLINE: täckningens längd', () => {
  test('[träff] baslinjens fall (bas8, bas1089) är U2 som förut, med täckningens slut inom händelsens', () => {
    for (const k of ['bas8', 'bas1089']) {
      const { fynd, ctx } = fall(k);
      expect([k, reg.classify(fynd, ctx, { räkna: false }).post]).toEqual([k, U2]);
    }
    expect(p2(...Object.values(fall('bas8'))).skäl).toMatch(/täckningens slut 03:12:02 ligger inom max\(Klaffbron#8:s avfyrning 02:52:41, bokföringen 03:02:02\) \+ 600 s = 03:12:02/);
  });

  // J13-J14-KONVOJSEMANTIK (samma dag): posten tog 1089 och 1214 när U2
  // släppte dem, och prövar nu samma längd. Under mutanten blir de KANDIDAT.
  test.each(['mut1089', 'mut1214'])('[vakt] J13 i %s: täckningen var för lång; KANDIDAT', (k) => {
    const { fynd, ctx } = fall(k);
    const r = PREDICATES.nonMemberCrossingBetween.fn(fynd, ctx, PREDICATES.nonMemberCrossingBetween.parametrar);
    expect(r).toMatchObject({ sant: false, skäl: expect.stringMatching(/täckningen var för lång, och då förklarar konvojsemantiken \(U2, J13\) inte/) });
    expect(reg.classify(fynd, ctx, { räkna: false }).klass).toBe('KANDIDAT');
  });

  test('[träff] J13 i baslinjevärlden bas1089: icke-medlemmen och täckningen inom händelsens slut', () => {
    const { fynd, ctx } = fall('bas1089');
    expect(PREDICATES.nonMemberCrossingBetween.fn(fynd, ctx, PREDICATES.nonMemberCrossingBetween.parametrar).skäl)
      .toMatch(/icke-medlemmen 265411057 korsade 07:22:08 .*; täckningens slut 07:40:46 ligger inom/);
  });

  test('[träff] J13 i baslinjevärld 212: en ledare utan dom i sin egen händelse har ingen arm att pröva; J13 som förut', () => {
    // 265817494 leder Klaffbron#19 (avfyrad 11:55:42, 55 s före korsningen)
    // och har inga domar. Ett första utkast krävde en dom och flyttade
    // utslaget till O1; bara en absorberad båt utan dom saknar underlaget.
    const { fynd, ctx } = fall('bas212');
    expect(PREDICATES.nonMemberCrossingBetween.fn(fynd, ctx, PREDICATES.nonMemberCrossingBetween.parametrar).skäl)
      .toMatch(/täckningens längd prövas inte: båten var medlem i Klaffbron#19, inte absorberad/);
    expect(reg.classify(fynd, ctx, { räkna: false }).post).toBe('J13-J14-KONVOJSEMANTIK');
    // En absorption först efter korsningen räknas inte.
    const sen = ctx.resultat.openingCoverage.find((c) => c.eventId === 'Klaffbron#19' && String(c.mmsi) === '265817494');
    ctx.resultat.openingCoverage.push({ ...sen, reason: 'absorbed', t: fynd.belägg.korsningT + 1000 });
    expect(PREDICATES.nonMemberCrossingBetween.fn(fynd, ctx, PREDICATES.nonMemberCrossingBetween.parametrar).sant).toBe(true);
    ctx.resultat.openingCoverage.pop();
    // Var hon absorberad i #19 i stället hade domen saknats: nej.
    for (const c of ctx.resultat.openingCoverage) {
      if (c.eventId === 'Klaffbron#19' && String(c.mmsi) === '265817494') c.reason = 'absorbed';
    }
    expect(PREDICATES.nonMemberCrossingBetween.fn(fynd, ctx, PREDICATES.nonMemberCrossingBetween.parametrar).skäl)
      .toMatch(/domspåret har ingen dom för båten i Klaffbron#19 före korsningen/);
  });

  test.each([
    ['mut1089', /armens täckningsslut 07:45:46 i domen 07:40:04 ligger mer än en tick efter max\(Stridsbergsbron#15:s avfyrning 07:20:49, bokföringen 07:33:14\) \+ 600 s = 07:43:14/],
    ['mut1214', /armens täckningsslut 13:31:08 i domen 13:20:34 ligger mer än en tick efter max\(Stridsbergsbron#2:s avfyrning 13:09:51, bokföringen 13:16:08\) \+ 600 s = 13:26:08/],
  ])('[vakt] mutanten i %s: täckningen var för lång; inte U2', (k, skäl) => {
    const { fynd, ctx } = fall(k);
    const r = p2(fynd, ctx);
    expect(r.sant).toBe(false);
    expect(r.skäl).toMatch(skäl);
    expect(reg.classify(fynd, ctx, { räkna: false }).post).not.toBe(U2);
  });

  test('[känd gräns] mutanten i 449: bokföringen kom sent, så slutet ur händelsen fångar inte den för långa täckningen', () => {
    // Händelsens första passage bokfördes 08:42:41, efter hennes absorption
    // 08:26:30. Då gäller appens referensankomst (bokföringen kortar men
    // förlänger aldrig), och den läses bara ur appen själv (windowEndMs), som
    // mutanten också flyttar. Samma gräns som U17:s (3″) och A.8.
    const { fynd, ctx } = fall('mut449');
    expect(p2(fynd, ctx).skäl).toMatch(/täckningens slut 08:49:33 ligger inom max\(Stridsbergsbron#5:s avfyrning 08:23:11, bokföringen 08:42:41\) \+ 600 s = 08:52:41/);
  });

  describe('villkoret i en baslinjevärld (bas8, Klaffbron#8)', () => {
    const E = 'Klaffbron#8';
    test('[vakt] armens täckningsslut mer än en tick för sent; inte U2', () => {
      const { fynd, ctx } = fall('bas8');
      for (const v of domarI(fynd, ctx, E)) v.arm.coverUntilMs += TICK + 1;
      expect(p2(fynd, ctx).skäl).toMatch(/armens täckningsslut 03:12:3\d i domen .* ligger mer än en tick efter .* täckningen var för lång/);
      expect(reg.classify(fynd, ctx, { räkna: false }).post).not.toBe(U2);
    });

    test('[träff] armens täckningsslut exakt en tick för sent ligger inom marginalen; U2', () => {
      const { fynd, ctx } = fall('bas8');
      for (const v of domarI(fynd, ctx, E)) v.arm.coverUntilMs += TICK;
      expect(reg.classify(fynd, ctx, { räkna: false }).post).toBe(U2);
    });

    test('[vakt] domens fönsterslut mer än en tick för sent (U24 avgör mot det); inte U2', () => {
      const { fynd, ctx } = fall('bas8');
      const sista = domarI(fynd, ctx, E).pop();
      sista.verdict.windowEndMs = sista.arm.coverUntilMs + TICK + 1;
      expect(p2(fynd, ctx).skäl).toMatch(/domens fönsterslut .* ligger mer än en tick efter .* U24 avgjorde mot ett för sent fönster/);
    });

    test('utan domspåret (äldre resultat) döms posten som förut', () => {
      const a = fall('bas8');
      delete a.ctx.resultat.openingCoverageVerdicts;
      expect(p2(a.fynd, a.ctx)).toMatchObject({ sant: true, skäl: expect.stringMatching(/täckningens längd prövas inte: resultatet saknar släppvägens domspår/) });
    });

    test('[vakt] utan en dom i E före korsningen eller utan armvärde: inte U2', () => {
      const b = fall('bas8');
      b.ctx.resultat.openingCoverageVerdicts = b.ctx.resultat.openingCoverageVerdicts.filter((v) => !(v.eventId === E && String(v.mmsi) === String(b.fynd.mmsi)));
      expect(p2(b.fynd, b.ctx).skäl).toMatch(/domspåret har ingen dom för båten i Klaffbron#8 före korsningen/);
      const c = fall('bas8');
      domarI(c.fynd, c.ctx, E).pop().arm.coverUntilMs = null;
      expect(p2(c.fynd, c.ctx)).toMatchObject({ sant: false, skäl: expect.stringMatching(/saknar armens täckningsslut/) });
    });

    test('[träff] en sen avfyrning flyttar slutet: max(avfyrningen, bokföringen) + 600 s', () => {
      // Avfyrningen tre minuter efter bokföringen: slutet är avfyrningen + 600 s,
      // och ett armslut två minuter efter bokföringen + 600 s ligger inom det.
      const { fynd, ctx } = fall('bas8');
      for (const v of domarI(fynd, ctx, E)) {
        v.event.firedAt = Date.parse('2026-09-13T03:05:02Z');
        v.arm.coverUntilMs += 2 * 60000;
      }
      expect(fynd.belägg.korsningT).toBeGreaterThan(Date.parse('2026-09-13T03:05:02Z'));
      expect(p2(fynd, ctx).skäl).toMatch(/max\(Klaffbron#8:s avfyrning 03:05:02, bokföringen 03:02:02\) \+ 600 s = 03:15:02/);
      expect(reg.classify(fynd, ctx, { räkna: false }).post).toBe(U2);
    });

    test('[träff] var passagen inte bokförd vid domen prövas längden inte, och posten dömer som förut', () => {
      const { fynd, ctx } = fall('bas8');
      domarI(fynd, ctx, E).pop().event.firstPassageRegisteredAt = null;
      expect(p2(fynd, ctx).skäl).toMatch(/täckningens längd prövas inte: Klaffbron#8:s första passage var inte bokförd/);
      expect(reg.classify(fynd, ctx, { räkna: false }).post).toBe(U2);
    });

    test('[vakt] en dom efter korsningen räknas inte som hennes sista dom före den', () => {
      const { fynd, ctx } = fall('bas8');
      const före = domarI(fynd, ctx, E);
      for (const v of före) v.arm.coverUntilMs += 10 * 60000;
      const efter = { ...kopia(före[före.length - 1]), t: fynd.belägg.korsningT + 1 };
      efter.arm.coverUntilMs -= 10 * 60000;
      ctx.resultat.openingCoverageVerdicts.push(efter);
      expect(p2(fynd, ctx).sant).toBe(false);
    });
  });
});
