'use strict';

/**
 * U17:s villkor (3″): täckningsslutet kom i tid (2026-11-15).
 *
 * Känd gräns före skärpningen (BUGGJAKT §7 och bilaga A.9): posten
 * U17-TYST-BÅT-RECOVER prövade att varningen följde inom en tick på hennes
 * dom 'täckningsslut', men inte NÄR den domen kom. Med täckningsslutet
 * avsiktligt två minuter för sent i appen (mutant C i A.9) tog U17 15 av 18
 * nya utslag. U17 gäller säkerhetsvarningen VID täckningsslutet, och
 * täckningsslutet räknas enligt appens dokumenterade regler ur händelsen:
 * max(avfyrningen, referensen) + CONVOY_WINDOW_MS vid absorptionen, där
 * referensen är bokföringen av händelsens första passage när den var känd och
 * annars referensankomsten, och en senare bokföring kortar det till
 * max(avfyrningen, bokföringen) + CONVOY_WINDOW_MS men förlänger det aldrig
 * (BridgeOpeningService.js#_bindLooseArms och #_rebaseConvoyCoverage). Nu ska
 * varningen komma högst en tick efter det slut som motorn räknar ur händelsen
 * och efter armens eget slut. Samma predikat bär K-TYST-BÅT-NÄSTA-ÖPPNING.
 *
 * Fixturen är varv 2:s (fixtures/varv2-motor-2026-11-09.json, verkliga
 * världar ur standardkörningen). [träff] ska klassas av posten, [vakt] ska
 * förbli KANDIDAT. Inga barnprocesser och inga timers.
 */

const { loadRegistry, PREDICATES } = require('../lib/registry');
const C = require('../../../../lib/constants');
const V = require('./fixtures/varv2-motor-2026-11-09.json');

const U17 = 'U17-TYST-BÅT-RECOVER';
const TICK = C.BRIDGE_OPENING.TICK_INTERVAL_MS;
const FÖNSTER = C.BRIDGE_OPENING.CONVOY_WINDOW_MS;
const kopia = (x) => JSON.parse(JSON.stringify(x));
const fall = (k) => kopia(V[k]);
const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });
const pred = (namn, extra = {}) => (f, ctx) => PREDICATES[namn].fn(f, ctx, { ...PREDICATES[namn].parametrar, ...extra });
const p17 = pred('tystRecoverSammaÖppning');
const domar = (fynd, ctx) => ctx.resultat.openingCoverageVerdicts
  .filter((v) => String(v.mmsi) === String(fynd.mmsi) && v.bridge === fynd.bro).sort((a, b) => a.t - b.t);
const släppet = (fynd, ctx) => domar(fynd, ctx).filter((v) => v.verdict.kind === 'täckningsslut').pop();
const varningen = (fynd, ctx) => ctx.resultat.openingWarnings.find((w) => w.eventId === fynd.belägg.varning.eventId);

/**
 * Appen släpper henne `ms` för sent (mutant C i A.9): i stället för domen
 * 'täckningsslut' vid armens slut står där en dom 'covered', och släppet och
 * hennes varning kommer `ms` senare. Täckningsslutet i armen och händelsen är
 * oförändrat. U17 gäller en tyst båt, så hennes rader fram till det sena
 * släppet tas bort (i mutantens världar var hon tyst också då, annars hade
 * U17 inte tagit utslaget).
 */
function senareSläpp(fynd, ctx, ms) {
  const s = släppet(fynd, ctx);
  const w = varningen(fynd, ctx);
  const m = String(fynd.mmsi);
  ctx.resultat.openingCoverageVerdicts.push({ ...kopia(s), t: s.t, verdict: { kind: 'covered' } });
  ctx.rader = ctx.rader.filter((r) => !(String(r.mmsi) === m && r.aisTimestamp >= w.t && r.aisTimestamp <= w.t + ms + 1000));
  s.t += ms;
  w.t += ms;
  return { s, w };
}

let reg;
beforeAll(() => {
  reg = loadRegistry();
});

describe('U17 (3″): täckningsslutet kom i tid', () => {
  test('[träff] de nio U17- och K-NÄSTA-fallen, 1038 och 972 klassas som förut', () => {
    for (const k of ['w1973', 'w537', 'w625', 'w1337', 'w1629', 'w1752', 'w479', 'w1038', 'w972']) {
      const { fynd, ctx } = fall(k);
      expect([k, klassa(reg, fynd, ctx).post]).toEqual([k, U17]);
    }
    for (const k of ['w510', 'w1704']) {
      const { fynd, ctx } = fall(k);
      expect([k, klassa(reg, fynd, ctx).post]).toEqual([k, 'K-TYST-BÅT-NÄSTA-ÖPPNING']);
    }
  });

  test.each(['w1973', 'w537', 'w625', 'w1337', 'w1629', 'w1752', 'w479', 'w1038'])(
    '[vakt] mutant C i %s: släppet och varningen två minuter efter täckningsslutet; KANDIDAT',
    (k) => {
      const { fynd, ctx } = fall(k);
      senareSläpp(fynd, ctx, 2 * 60000);
      expect(p17(fynd, ctx).skäl).toMatch(/kom mer än en tick efter täckningsslutet .* som motorn räknar ur händelsen/);
      expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    },
  );

  test('[vakt] samma sena släpp i läget nästa (K-TYST-BÅT-NÄSTA-ÖPPNING, värld 510); KANDIDAT', () => {
    const { fynd, ctx } = fall('w510');
    senareSläpp(fynd, ctx, 2 * 60000);
    expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(fynd, ctx).skäl).toMatch(/kom mer än en tick efter täckningsslutet/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[träff] släppet en halv tick sent ligger inom marginalen; U17', () => {
    const { fynd, ctx } = fall('w1973');
    senareSläpp(fynd, ctx, TICK / 2);
    expect(klassa(reg, fynd, ctx).post).toBe(U17);
  });

  test('[vakt] armens täckningsslut är inte facit: ett för sent räknat slut fälls av bokföringen (1973); KANDIDAT', () => {
    // Händelsens första passage bokfördes 15:32:25,018; täckningen kan då
    // sluta senast max(avfyrningen 15:27:55, bokföringen) + 600 s =
    // 15:42:25,018. Appen räknar armens slut två minuter för sent och släpper
    // henne där.
    const { fynd, ctx } = fall('w1973');
    const { s } = senareSläpp(fynd, ctx, 2 * 60000);
    for (const v of domar(fynd, ctx).filter((x) => x.eventId === s.eventId)) v.arm.coverUntilMs += 2 * 60000;
    expect(p17(fynd, ctx).skäl).toMatch(/täckningsslutet 15:42:25 som motorn räknar ur händelsen \(max\(Stridsbergsbron#1:s varning 15:27:55, bokföringen 15:32:25\) \+ 600 s/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] bokföringen tidigare än släppet säger: täckningen hade kortats (537); KANDIDAT', () => {
    // Bokföringen två minuter tidigare (12:49:39,952) kortar täckningen till
    // max(avfyrningen, bokföringen) + 600 s = 12:59:39,952, men appen släppte
    // henne vid armens slut 13:01:15.
    const { fynd, ctx } = fall('w537');
    for (const v of domar(fynd, ctx)) {
      if (v.event && Number.isFinite(v.event.firstPassageRegisteredAt)) v.event.firstPassageRegisteredAt -= 2 * 60000;
    }
    expect(p17(fynd, ctx).skäl).toMatch(/täckningsslutet 12:59:39 som motorn räknar ur händelsen \(max\(Stridsbergsbron#6:s varning 12:44:44, bokföringen 12:49:39\)/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  describe('referensankomsten ur U24:s underlag (windowEndMs) när passagen bokfördes efter absorptionen (1038)', () => {
    // ELSA MARIA absorberades 12:02:52 i Stridsbergsbron#2 (avfyrad
    // 11:56:35); passagen bokfördes först 12:15:55, och armens slut
    // 12:16:26,688 kommer ur referensankomsten 12:06:26,688.
    const medFönster = (fynd, ctx, windowEndMs) => {
      for (const v of domar(fynd, ctx)) {
        if (v.eventId === 'Stridsbergsbron#2' && !(v.event && Number.isFinite(v.event.firstPassageRegisteredAt))) {
          v.verdict.windowEndMs = windowEndMs;
        }
      }
    };
    test('[träff] underlaget ger samma slut som armen; U17', () => {
      const { fynd, ctx } = fall('w1038');
      medFönster(fynd, ctx, släppet(fynd, ctx).arm.coverUntilMs);
      expect(klassa(reg, fynd, ctx).post).toBe(U17);
    });
    test('[vakt] underlaget ger ett slut två minuter före armens; KANDIDAT', () => {
      const { fynd, ctx } = fall('w1038');
      medFönster(fynd, ctx, släppet(fynd, ctx).arm.coverUntilMs - 2 * 60000);
      expect(p17(fynd, ctx).skäl).toMatch(/täckningsslutet 12:14:26 som motorn räknar ur händelsen \(max\(Stridsbergsbron#2:s varning 11:56:35, referensankomsten 12:04:26\) \+ 600 s/);
      expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    });
    test('[vakt] utan underlaget gäller bokföringen som övre gräns: släppet efter max(avfyrningen, bokföringen) + 600 s; KANDIDAT', () => {
      const { fynd, ctx } = fall('w1038');
      const B = Date.parse('2026-06-20T12:15:55.094Z');
      // Armens slut och släppet flyttas förbi den övre gränsen B + 600 s.
      const { s } = senareSläpp(fynd, ctx, (B + FÖNSTER + TICK + 1000) - släppet(fynd, ctx).t);
      for (const v of domar(fynd, ctx).filter((x) => x.eventId === s.eventId)) v.arm.coverUntilMs = s.t;
      expect(p17(fynd, ctx).skäl).toMatch(/som motorn räknar ur händelsen \(max\(Stridsbergsbron#2:s varning 11:56:35, bokföringen 12:15:55\) \+ 600 s \(övre gräns: referensankomsten saknas\)/);
      expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    });
  });

  test('[vakt] utan bokföring och underlag prövas armens slut (972, appen före U24); KANDIDAT', () => {
    const { fynd, ctx } = fall('w972');
    senareSläpp(fynd, ctx, 2 * 60000);
    expect(p17(fynd, ctx).skäl).toMatch(/armens täckningsslut; Stridsbergsbron#6:s första passage var inte bokförd/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  describe('kedjan av återabsorptioner (standardvärld 1907, K-NÄSTA)', () => {
    // Fixturen fixtures/u17-kedja-1907-2026-11-15.json: värld 1907 i
    // standardkörningen (basSeed 1) på 1f6dd46, trimmad till 09:50–12:05 och
    // kontrollerad mot hela världen. 265183171 absorberas 11:24:30 i
    // Stridsbergsbron#26, korsar tyst 11:42:30, släpps vid #26:s
    // täckningsslut 11:42:31,935 och återabsorberas i #28 (bokförd 11:40:56,
    // täckt t.o.m. 11:50:56,506), släpps där 11:50:56,507 och absorberas i
    // #29, vars täckning redan slutade 11:47:30; hon släpps i samma
    // utvärdering och varnas (#34). Varje släpp kom i tid.
    const K = require('./fixtures/u17-kedja-1907-2026-11-15.json');
    const NÄSTA = 'K-TYST-BÅT-NÄSTA-ÖPPNING';
    const fall1907 = (klass) => ({ fynd: kopia(K.fynd[klass]), ctx: kopia(K.ctx) });
    const pNästa = pred('tystRecoverSammaÖppning', { läge: 'nästa' });
    const iE = (ctx, e) => ctx.resultat.openingCoverageVerdicts.filter((v) => String(v.mmsi) === '265183171' && v.eventId === e);

    test('[träff] båda fynden är K-NÄSTA: släppet ur #29 i samma utvärdering som absorptionen räknas inte som sent', () => {
      for (const klass of ['VARNING-EFTER-SANN-PASSAGE', 'VARNING-PÅ-FRUSET-FIX']) {
        const { fynd, ctx } = fall1907(klass);
        expect([klass, klassa(reg, fynd, ctx)]).toMatchObject([klass, { klass: 'KÄND_ÖPPEN', post: NÄSTA }]);
      }
    });

    test('[vakt] ett mellanled i kedjan släppt två minuter för sent (#28) fälls; KANDIDAT', () => {
      const { fynd, ctx } = fall1907('VARNING-PÅ-FRUSET-FIX');
      for (const v of iE(ctx, 'Stridsbergsbron#28')) {
        v.arm.coverUntilMs -= 2 * 60000;
        if (v.event && Number.isFinite(v.event.firstPassageRegisteredAt)) v.event.firstPassageRegisteredAt -= 2 * 60000;
      }
      expect(pNästa(fynd, ctx).skäl).toMatch(/släppet 11:50:56 ur Stridsbergsbron#28 .* kom mer än en tick efter täckningsslutet 11:48:56/);
      expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    });

    test('[vakt] absorptionen i #29 före släppet: då gäller täckningsslutet, och släppet var sent; KANDIDAT', () => {
      const { fynd, ctx } = fall1907('VARNING-PÅ-FRUSET-FIX');
      const abs = ctx.resultat.openingCoverage.find((c) => String(c.mmsi) === '265183171' && c.reason === 'absorbed' && c.eventId === 'Stridsbergsbron#29');
      abs.t = Date.parse('2026-09-18T11:48:00Z');
      expect(pNästa(fynd, ctx).skäl).toMatch(/släppet 11:50:56 ur Stridsbergsbron#29 .* absorptionen 11:48:00/);
      expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    });
  });

  describe('saknat armvärde i släppet (granskningen 2026-11-16, L2)', () => {
    // Math.min(slut, undefined) blev NaN och jämförelsen godkände; null
    // räknades som 0. Nu prövas bara slutet ur händelsen (här bokföringen).
    // Nyckeln finns men värdet saknas (en saknad nyckel fälls redan av
    // formkontrollen, se sista testet i blocket).
    const utanArm = (fynd, ctx, värde) => {
      for (const v of domar(fynd, ctx).filter((x) => x.verdict.kind === 'täckningsslut')) v.arm.coverUntilMs = värde;
    };
    test.each([['undefined', undefined], ['null', null]])(
      '[vakt] släppet två minuter efter bokföringens slut, armvärdet %s; KANDIDAT (1973)',
      (_namn, värde) => {
        const { fynd, ctx } = fall('w1973');
        senareSläpp(fynd, ctx, 2 * 60000);
        utanArm(fynd, ctx, värde);
        expect(p17(fynd, ctx).skäl).toMatch(/kom mer än en tick efter täckningsslutet 15:42:25 som motorn räknar ur händelsen/);
        expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
      },
    );
    test.each([['undefined', undefined], ['null', null]])(
      '[träff] släppet i tid mot bokföringens slut, armvärdet %s; U17 (1973)',
      (_namn, värde) => {
        const { fynd, ctx } = fall('w1973');
        utanArm(fynd, ctx, värde);
        expect(klassa(reg, fynd, ctx).post).toBe(U17);
      },
    );
    test('[vakt] saknas nyckeln fäller formkontrollen; KANDIDAT (1973)', () => {
      const { fynd, ctx } = fall('w1973');
      for (const v of domar(fynd, ctx).filter((x) => x.verdict.kind === 'täckningsslut')) delete v.arm.coverUntilMs;
      expect(p17(fynd, ctx).skäl).toMatch(/utan arm\.coverUntilMs; predikatet läser inte en okänd form/);
      expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    });
  });

  test('[vakt] går slutet inte att räkna alls blir predikatet falskt, inte godkänt (972 utan armvärde); KANDIDAT', () => {
    const { fynd, ctx } = fall('w972');
    släppet(fynd, ctx).arm.coverUntilMs = null;
    expect(p17(fynd, ctx).skäl).toMatch(/täckningsslut kan inte räknas: ingen bokföring, inget fönsterslut/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });
});
