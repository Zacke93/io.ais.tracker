'use strict';

/**
 * Registret 2026-11-07 (BUGGJAKT §7, rad 23–33): posterna för
 * användarbesluten U17, U18 och U19, dirigentens beslut om R2:s fråga 2 och
 * de kända luckorna för K, M och R1, och borttagningen av U2-RETURRESA.
 * Efterrättningen samma dag (rad 32–33) snävade predikaten efter
 * granskningens mutationsprov; de fallen står i
 * fixtures/register-efterratt-2026-11-07.json (alla båtars rader i fönstret,
 * fynden ur standardkörningen och ur mutationsdumparna mutA och mutB).
 *
 * Varje post prövas åt båda hållen: [träff] är ett utslag som posten ska
 * klassa, [vakt] ett motexempel med en annan mekanism som ska förbli
 * KANDIDAT (eller falla på predikatet). Fixturen
 * fixtures/kampanj-register-2026-11-07.json är ur standardkörningen på
 * e088a51 (seed 1): fyndet och dess registerkontext (båtens rader,
 * varningar, täckning, passager, brotexter och L0) för en värld i taget.
 * KÄND LUCKA-fallen bygger på R1:s fixturer i tests/fixtures/
 * (r1-kand-lucka-*.jsonl) med handskriven L0, eftersom fixturerna är
 * verkliga rader utan sanning. Inga barnprocesser och inga timers.
 */

const fs = require('fs');
const path = require('path');
const { loadRegistry, PREDICATES, harnessTider } = require('../lib/registry');
const platser = require('../lib/platser');
const F = require('./fixtures/kampanj-register-2026-11-07.json');
const E = require('./fixtures/register-efterratt-2026-11-07.json');

const MIN = 60000;
const kopia = (x) => JSON.parse(JSON.stringify(x));
const fall = (k) => kopia(F[k] || E[k]);
const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });
const pred = (namn, extra = {}) => (f, ctx) => PREDICATES[namn].fn(f, ctx, { ...PREDICATES[namn].parametrar, ...extra });
const prövad = (c, post) => (c.prövade || []).find((p) => p.post === post) || (c.närmast && c.närmast.post === post ? c.närmast : null);

let reg;
beforeAll(() => {
  reg = loadRegistry();
});

describe('registret 2026-11-07: posterna finns, laddar utan varningar och U2-RETURRESA är borttagen', () => {
  test('[nytt] de nio nya posterna finns i registerordning efter sina föregångare', () => {
    const ids = reg.poster.map((e) => e.id);
    const nya = ['U1-C11-TYST-FÖRE-DEFAULT', 'M-BRUSBAND-RÖRELSEBEVIS', 'R2-MÅLBRO-EFTER-LINJEN', 'U18-RETUR-BEKRÄFTAD-SENT', 'U17-TYST-BÅT-RECOVER',
      'K-TYST-BÅT-NÄSTA-ÖPPNING', 'U19-VARNING-UNDER-VÄNTANDE-VÄNDNING', 'TVÅ-ÅTERKORSADE-BROAR-I-SAMMA-SEGMENT', 'U-SVÄNG-LÅNGSAM-ÅTERKORSNING'];
    for (const id of nya) expect(ids).toContain(id);
    expect(ids).not.toContain('U2-RETURRESA');
    expect(reg.varningar).toEqual([]);
    // KIE-PER-KORPUS och D1 prövas före de nya INV-14-posterna; O1 före U18–U19.
    expect(ids.indexOf('KIE-PER-KORPUS')).toBeLessThan(ids.indexOf('U1-C11-TYST-FÖRE-DEFAULT'));
    expect(ids.indexOf('D1-KAJZON-DEMOTION')).toBeLessThan(ids.indexOf('U1-C11-TYST-FÖRE-DEFAULT'));
    expect(ids.indexOf('O1-ACCEPTERADE-MISSKLASSER')).toBeLessThan(ids.indexOf('U18-RETUR-BEKRÄFTAD-SENT'));
    expect(ids.indexOf('U18-RETUR-BEKRÄFTAD-SENT')).toBeLessThan(ids.indexOf('U17-TYST-BÅT-RECOVER'));
  });

  test('[nytt] varje ny post citerar sitt beslut och en KÄND_ÖPPEN har en fråga', () => {
    const källa = (id) => reg.entry(id).källa;
    expect(källa('U17-TYST-BÅT-RECOVER')).toMatch(/U17/);
    expect(källa('U18-RETUR-BEKRÄFTAD-SENT')).toMatch(/U18/);
    expect(källa('U19-VARNING-UNDER-VÄNTANDE-VÄNDNING')).toMatch(/U19/);
    expect(källa('R2-MÅLBRO-EFTER-LINJEN')).toMatch(/R2:s fråga 2/);
    expect(källa('U1-C11-TYST-FÖRE-DEFAULT')).toMatch(/U1/);
    for (const e of reg.poster.filter((x) => x.klass === 'KÄND_ÖPPEN')) expect(e.fråga).toBeTruthy();
  });

  test('[vakt] appkonstanten TARGET_REMOVAL_GRACE_PERIOD läses ur källtexten, och utan värde är predikatet falskt', () => {
    expect(PREDICATES.krypbandVidTröskel.parametrar.fönsterMs).toBe(60000);
    const post = {
      id: 'X',
      klass: 'DESIGN',
      datum: '2026-11-07',
      källa: 'docs/BUGGJAKT.md',
      regel: 'r',
      gäller: { orakel: ['INV-F'], inv: ['INV-14'], klassRegex: '.*' },
      predikat: { namn: 'krypbandVidTröskel', parametrar: { fönsterMs: null } },
    };
    const r = loadRegistry({ poster: [post] });
    expect(pred('krypbandVidTröskel', { fönsterMs: null })({ t: 1, bro: 'Klaffbron' }, { rader: [] }).sant).toBe(false);
    expect(r.varningar).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// U18: returen upptäcks sent eftersom Fix D kräver två positioner
// ---------------------------------------------------------------------------

describe('U18 U18-RETUR-BEKRÄFTAD-SENT: knuten till Fix D:s bekräftelse, inte bara till tiden', () => {
  test('[träff] värld 18 (ALVA): OKLASSAD, en omvänd fix 11:42:45 före korsningen 11:46:35, bekräftad först 11:54:01', () => {
    const { fynd, ctx } = fall('w18');
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U18-RETUR-BEKRÄFTAD-SENT' });
  });

  test('[träff] värld 1274 (LEDTID 23 s, K:s F02-r2) och värld 227 (T3 9 s efter korsningen): egen varning vid bekräftelsen', () => {
    for (const k of ['w1274', 'w227']) {
      const { fynd, ctx } = fall(k);
      expect(klassa(reg, fynd, ctx)).toMatchObject({ post: 'U18-RETUR-BEKRÄFTAD-SENT' });
    }
  });

  test('[vakt] värld 1208: vändningen bekräftades 74 s före korsningen men ingen egen varning kom; KANDIDAT (U15)', () => {
    const { fynd, ctx } = fall('w1208');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U18-RETUR-BEKRÄFTAD-SENT').skäl).toMatch(/bekräftade vändningen 13:41:25, före korsningen/);
  });

  test('[vakt] värld 1918 (K2-granskarens fall): bekräftad 77 s före korsningen, egen varning först vid nästa fix; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1918');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U18-RETUR-BEKRÄFTAD-SENT').skäl).toMatch(/77 s före korsningen/);
  });

  test('[vakt] en sen varning som inte följer bekräftelsen, en annan båts varning och en korsning utan vändning faller på predikatet', () => {
    const p = pred('fixDBekräftarReturSent');
    const a = fall('w1274');
    const w = a.ctx.resultat.openingWarnings.find((x) => x.eventId === a.fynd.belägg.varning.eventId);
    w.t += 90000;
    expect(p(a.fynd, a.ctx)).toMatchObject({ sant: false });
    expect(p(a.fynd, a.ctx).skäl).toMatch(/förklaras inte av U18/);
    const b = fall('w1274');
    b.ctx.resultat.openingWarnings.find((x) => x.eventId === b.fynd.belägg.varning.eventId).leadMmsi = '265000000';
    expect(p(b.fynd, b.ctx).skäl).toMatch(/inte av båten själv/);
    const c = fall('w18');
    c.ctx.sanning.uturns = [];
    expect(p(c.fynd, c.ctx).skäl).toMatch(/ingen L0-vändning/);
  });

  test('[vakt] ingen omvänd fix med FIX_D_MIN_SOG före korsningen: tvåpositionskravet förklarar inte utslaget', () => {
    const { fynd, ctx } = fall('w18');
    for (const r of ctx.rader) if (r.aisTimestamp > Date.parse('2026-08-05T11:41:34Z') && r.aisTimestamp < fynd.t) r.sog = 1.5;
    expect(pred('fixDBekräftarReturSent')(fynd, ctx).skäl).toMatch(/ingen omvänd fix/);
  });

  // Efterrättningen 2026-11-07: varningen ska komma vid det bekräftande
  // fixet eller vid första ticken efter det, inte vid nästa fix.
  // Värld 829: Fix D bekräftar returen på fixet 17:01:44.796, och varningen
  // Klaffbron#7 avfyras av det fixet.
  const w829MedNästaFix = () => {
    const a = fall('w829');
    const w = a.ctx.resultat.openingWarnings.find((x) => x.eventId === a.fynd.belägg.varning.eventId);
    const rad = a.ctx.rader.find((r) => r.aisTimestamp === w.t);
    expect(rad).toBeTruthy();
    const ny = {
      ...rad, aisTimestamp: w.t + 29500, lat: rad.lat - 0.0004, fixTs: w.t + 29500,
    };
    a.ctx.rader.push(ny);
    a.ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    return { ...a, w, bek: w.t };
  };

  test('[vakt] granskarens prov: värld 829 med ett nytt fix 29,5 s efter bekräftelsen och varningen på det fixet; KANDIDAT', () => {
    const {
      fynd, ctx, w, bek,
    } = w829MedNästaFix();
    w.t = bek + 29500;
    w.firedBy = 'fix';
    const c = klassa(reg, fynd, ctx);
    expect(c.post).not.toBe('U18-RETUR-BEKRÄFTAD-SENT');
    expect(pred('fixDBekräftarReturSent')(fynd, ctx).skäl).toMatch(/17:02:14 \(fix\) kom inte vid det bekräftande fixet 17:01:44 eller första ticken/);
  });

  test('[träff] varningen vid första ticken efter det bekräftande fixet (firedBy deadline, 20 s senare, ingen egen rad emellan)', () => {
    const a = fall('w829');
    const w = a.ctx.resultat.openingWarnings.find((x) => x.eventId === a.fynd.belägg.varning.eventId);
    w.t += 20000;
    w.firedBy = 'deadline';
    expect(pred('fixDBekräftarReturSent')(a.fynd, a.ctx)).toMatchObject({ sant: true });
    expect(pred('fixDBekräftarReturSent')(a.fynd, a.ctx).skäl).toMatch(/vid första ticken/);
  });

  test('[vakt] ticken efter en egen rad, och ett fix som inte är det bekräftande, faller på predikatet', () => {
    const {
      fynd, ctx, w, bek,
    } = w829MedNästaFix();
    w.t = bek + 29600;
    w.firedBy = 'deadline';
    expect(pred('fixDBekräftarReturSent')(fynd, ctx).skäl).toMatch(/egen rad 17:02:14 emellan/);
    const b = fall('w829');
    const wb = b.ctx.resultat.openingWarnings.find((x) => x.eventId === b.fynd.belägg.varning.eventId);
    wb.t += 5000;
    expect(pred('fixDBekräftarReturSent')(b.fynd, b.ctx).sant).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// U17 och K-familjens kvarvarande gräns: den tysta båtens RECOVER-varning
// ---------------------------------------------------------------------------

describe('U17 U17-TYST-BÅT-RECOVER och K-TYST-BÅT-NÄSTA-ÖPPNING', () => {
  test('[träff] värld 41 (VARNING-EFTER-SANN-PASSAGE, 584 s, tyst sedan bokföringen) och 1453 (FRUSET-FIX, E = #4 som täckte henne vid korsningen)', () => {
    for (const k of ['w41', 'w1453']) {
      const { fynd, ctx } = fall(k);
      expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' });
    }
    const b = fall('w1453');
    expect(pred('tystRecoverSammaÖppning')(b.fynd, b.ctx).skäl).toMatch(/absorberad i Stridsbergsbron#4 07:39:33/);
  });

  test('[träff] värld 1006: rader efter bokföringen med prognosen klart inom fönstret (restiden högst 0,6 av tiden kvar)', () => {
    const { fynd, ctx } = fall('w1006');
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' });
  });

  test('[träff] nästa öppning: värld 87 (T3, 610 s), 1247 (T2 LEDTID, 658 s) och 1907 (FRUSET-FIX, 622 s efter E = #26) blir KÄND_ÖPPEN', () => {
    for (const k of ['w87', 'w1247', 'w1907']) {
      const { fynd, ctx } = fall(k);
      expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'K-TYST-BÅT-NÄSTA-ÖPPNING' });
    }
  });

  test('[träff] värld 182 (T3): O1 avstår från en absorberad båts RECOVER, och U17 tar den', () => {
    const { fynd, ctx } = fall('w182t3');
    const c = klassa(reg, fynd, ctx);
    expect(c).toMatchObject({ klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' });
    expect(prövad(c, 'O1-ACCEPTERADE-MISSKLASSER').skäl).toMatch(/RECOVER-släpp \(U17\)/);
  });

  test('[vakt] mutationen mutB (bakkanten bortkopplad), värld 28 R0: hon sände var 30:e s efter bokföringen; KANDIDAT', () => {
    const { fynd, ctx } = fall('mutB-w28');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'K-TYST-BÅT-NÄSTA-ÖPPNING').skäl).toMatch(/bakkanten kan ha släppt henne/);
  });

  test('[vakt] T2 LEDTID, mutB värld 28 med bara raden efter fönstrets tidigaste slut kvar: hon var inte tyst (villkor 3a); KANDIDAT', () => {
    const { fynd, ctx } = fall('mutB-w28');
    const bok = Date.parse('2026-06-18T13:53:35.995Z');
    const slut = Date.parse('2026-06-18T14:03:05Z');
    ctx.rader = ctx.rader.filter((r) => r.mmsi !== fynd.mmsi || r.aisTimestamp <= bok || r.aisTimestamp >= slut);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(fynd, ctx).skäl).toMatch(/rad 14:03:09 kom efter .* och efter fönstrets tidigaste slut 14:03:05/);
  });

  test('[vakt] granskarens fixturprov (som värld 790): värld 331 med tre färska fixar i 5,8 kn 400–160 m från bron sent i fönstret; KANDIDAT', () => {
    const orörd = fall('w331');
    expect(klassa(reg, orörd.fynd, orörd.ctx)).toMatchObject({ post: 'K-TYST-BÅT-NÄSTA-ÖPPNING' });
    const { fynd, ctx } = fall('w331');
    const X = platser.POINTS.Klaffbron;
    const mall = ctx.rader.filter((r) => r.mmsi === fynd.mmsi).pop();
    [[400, '15:30:00'], [280, '15:31:00'], [160, '15:32:00']].forEach(([dM, hh]) => ctx.rader.push({
      ...mall, lat: X.lat - dM / 111320, lon: X.lon, sog: 5.8, cog: 20, aisTimestamp: Date.parse(`2026-09-23T${hh}Z`), fixTs: Date.parse(`2026-09-23T${hh}Z`),
    }));
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'K-TYST-BÅT-NÄSTA-ÖPPNING').skäl).toMatch(/restiden 134 s .*bakkanten kan ha släppt henne/);
  });

  test('[vakt] mutB värld 1905: prognosen 136 s av 200 s kvar ligger för nära fönstrets slut för att bevisa U17:s premiss; KANDIDAT', () => {
    const { fynd, ctx } = fall('mutB-w1905');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl).toMatch(/restiden 136 s .* mer än 0.6 × de 200 s/);
  });

  test('[gräns] värld 625 (baslinjen): restiden 436 s av 553 s kvar, så posten kan inte skilja henne från en bakkantsregression; KANDIDAT', () => {
    const { fynd, ctx } = fall('w625');
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/restiden 436 s/);
  });

  test('[vakt] mutationen mutA (under-bron-hållet bortkopplat), värld 1831: sista raden 30 m från bron i 6,8 kn; KANDIDAT', () => {
    const { fynd, ctx } = fall('mutA-w1831');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl).toMatch(/30 m från bron i 6.8 kn: under bron/);
  });

  test('[vakt] granskarens fixturprov: värld 41 med sista raden före varningen 35 m norr om Stridsbergsbron i 4,8 kn; KANDIDAT', () => {
    const { fynd, ctx } = fall('w41');
    const X = platser.POINTS.Stridsbergsbron;
    const sista = ctx.rader.filter((r) => r.aisTimestamp < Date.parse('2026-06-19T12:24:20Z')).pop();
    Object.assign(sista, { lat: X.lat + 35 / 111320, lon: X.lon, sog: 4.8 });
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/35 m från bron i 4.8 kn: under bron/);
  });

  test('[vakt] kursen bort från bron i sista raden (_courseAway) håller båten; KANDIDAT', () => {
    const { fynd, ctx } = fall('w41');
    const sista = ctx.rader.filter((r) => r.aisTimestamp < Date.parse('2026-06-19T12:24:20Z')).pop();
    sista.cog = 30;
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/kursen 30° bort från bron/);
  });

  test('[vakt] mutA värld 777: O1 avstår (absorberad före korsningen) och under-bron-hållet utesluter U17; KANDIDAT', () => {
    const { fynd, ctx } = fall('mutA-w777');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'O1-ACCEPTERADE-MISSKLASSER').skäl).toMatch(/absorberades i Klaffbron#2 21:25:16/);
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl).toMatch(/19 m från bron/);
  });

  test('[vakt] granskarens prov: värld 87 plus en annan båts händelse varnad 10:22 och hennes absorption 10:28, efter korsningen; fortfarande KÄND_ÖPPEN', () => {
    const { fynd, ctx } = fall('w87');
    ctx.resultat.openingWarnings.push({
      t: Date.parse('2026-06-13T10:22:00Z'),
      bridge: 'Stridsbergsbron',
      direction: 'southbound',
      eventId: 'Stridsbergsbron#5',
      leadMmsi: '265256999',
      mmsis: ['265256999'],
      firedBy: 'deadline',
      success: true,
    });
    ctx.resultat.openingCoverage.push({
      t: Date.parse('2026-06-13T10:28:00Z'), mmsi: fynd.mmsi, bridge: 'Stridsbergsbron', eventId: 'Stridsbergsbron#5', reason: 'absorbed',
    });
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'K-TYST-BÅT-NÄSTA-ÖPPNING' });
    expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(fynd, ctx).skäl).toMatch(/absorberad i Stridsbergsbron#4/);
  });

  test('[vakt] värld 972: varningen leds av en annan båt; KANDIDAT', () => {
    const { fynd, ctx } = fall('w972');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl).toMatch(/inte av båten själv/);
  });

  test('[vakt] värld 941: båten hördes efter sin korsning, så appen kunde veta att hon passerat; KANDIDAT', () => {
    const { fynd, ctx } = fall('w941');
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/kom efter korsningen/);
  });

  test('[vakt] en varning som avfyrades av ett fix (värld 829, U-svängsreturen) och en båt utan absorption faller på predikatet', () => {
    const näst = pred('tystRecoverSammaÖppning', { läge: 'nästa' });
    const a = fall('w829');
    expect(näst(a.fynd, a.ctx).skäl).toMatch(/avfyrades av fix/);
    const b = fall('w41');
    b.ctx.resultat.openingCoverage = b.ctx.resultat.openingCoverage.filter((c) => c.reason !== 'absorbed');
    expect(pred('tystRecoverSammaÖppning')(b.fynd, b.ctx).skäl).toMatch(/absorberades inte/);
    const c = fall('w41');
    c.ctx.resultat.openingWarnings.find((x) => x.eventId === c.fynd.belägg.varning.eventId).firedBy = 'fix';
    expect(klassa(reg, c.fynd, c.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] lägena utesluter varandra: värld 41 är inte nästa öppning, värld 87 inte samma', () => {
    const a = fall('w41');
    expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(a.fynd, a.ctx).sant).toBe(false);
    const b = fall('w87');
    expect(pred('tystRecoverSammaÖppning')(b.fynd, b.ctx).skäl).toMatch(/utanför 600 s/);
  });

  test('[vakt] appkonstanten MOVING_SOG_KN läses ur BridgeOpeningService.js, och utan värde är predikatet falskt', () => {
    expect(PREDICATES.tystRecoverSammaÖppning.parametrar.rörelseKn).toBe(2);
    const { fynd, ctx } = fall('w41');
    expect(pred('tystRecoverSammaÖppning', { rörelseKn: null })(fynd, ctx).skäl).toMatch(/MOVING_SOG_KN/);
  });
});

// ---------------------------------------------------------------------------
// U19: planerad varning medan en vändning väntar
// ---------------------------------------------------------------------------

describe('U19 U19-VARNING-UNDER-VÄNTANDE-VÄNDNING', () => {
  test('[träff] ZELDA i värld 188 (T9 FEL-RIKTNING) och SALTIS i värld 1590 (T3 FANTOM-UTAN-AVBROTT)', () => {
    for (const k of ['w188', 'w1590']) {
      const { fynd, ctx } = fall(k);
      expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'ACCEPTERAD', post: 'U19-VARNING-UNDER-VÄNTANDE-VÄNDNING' });
    }
  });

  test('[vakt] en flagga som aldrig bekräftas (båten fortsatte) ger KANDIDAT', () => {
    const { fynd, ctx } = fall('w188');
    ctx.rader = ctx.rader.filter((r) => r.aisTimestamp < Date.parse('2026-09-26T14:54:30Z'));
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U19-VARNING-UNDER-VÄNTANDE-VÄNDNING').skäl).toMatch(/bekräftades aldrig/);
  });

  test('[vakt] ett RECOVER-släpp (absorbed-rad före varningen) och ett notisanspråk faller på predikatet', () => {
    const p = pred('väntandeVändningVidVarning');
    const a = fall('w1590');
    a.ctx.resultat.openingCoverage.push({
      t: a.fynd.t - 5 * MIN, mmsi: a.fynd.mmsi, bridge: a.fynd.bro, eventId: 'Klaffbron#11', reason: 'absorbed',
    });
    expect(p(a.fynd, a.ctx).skäl).toMatch(/RECOVER-släpp/);
    const b = fall('w188');
    b.fynd.belägg.anspråk.slag = 'notis';
    expect(p(b.fynd, b.ctx).skäl).toMatch(/ingen levererad varning/);
  });
});

// ---------------------------------------------------------------------------
// R2:s fråga 2: målbron tilldelas vid eller efter linjen
// ---------------------------------------------------------------------------

describe('R2:s fråga 2 R2-MÅLBRO-EFTER-LINJEN', () => {
  test('[träff] värld 1227 (ELSA MARIA, första raden bortom bron) och 1731 (KAJSA, stilla 92 m norr om bron)', () => {
    for (const k of ['w1227', 'w1731']) {
      const { fynd, ctx } = fall(k);
      expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'R2-MÅLBRO-EFTER-LINJEN' });
    }
  });

  test('[vakt] R2:s sonder: ett glapp på 28,5 min med fart, kursen 200° mot bron och 1227 med första raden norr om bron', () => {
    const p = pred('målbroEfterLinjen');
    const a = fall('w1731');
    const r0 = a.ctx.rader[0];
    a.ctx.rader.unshift({
      ...r0, aisTimestamp: r0.aisTimestamp - 28.5 * MIN, sog: 6.1, cog: 200,
    });
    expect(p(a.fynd, a.ctx).skäl).toMatch(/rörelsebevis/);
    const b = fall('w1731');
    b.ctx.rader[0].cog = 200;
    expect(p(b.fynd, b.ctx).skäl).toMatch(/kurs mot bron/);
    const c = fall('w1227');
    c.ctx.rader.unshift({ ...c.ctx.rader[0], lat: platser.POINTS.Stridsbergsbron.lat + 0.0008, aisTimestamp: c.ctx.rader[0].aisTimestamp - 60000 });
    expect(p(c.fynd, c.ctx).skäl).toMatch(/rörelsebevis/);
  });

  test('[vakt] granskarens prov: värld 1227 med hela livet flyttat 1,5 km bortom bron är inte "vid eller just efter bron"; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1227');
    for (const r of ctx.rader) r.lat -= 1500 / 111320;
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('målbroEfterLinjen')(fynd, ctx).skäl).toMatch(/mer än 70 m: inte vid eller just efter bron/);
  });

  test('[vakt] en registrering mer än 10 min efter första raden bortom bron (R2:s dubbelbokföring, värld 254) och den låsta banken', () => {
    const p = pred('målbroEfterLinjen');
    const a = fall('w1227');
    a.fynd.t += 15 * MIN;
    expect(p(a.fynd, a.ctx).skäl).toMatch(/mer än 10 min/);
    const b = fall('w1227');
    b.fynd.ursprung = { relation: 'BAS' };
    expect(p(b.fynd, b.ctx).skäl).toMatch(/låsta banken/);
  });
});

// ---------------------------------------------------------------------------
// U1/C11: den tysta bäraren släpps ur texten (familj M:s F05/r2)
// ---------------------------------------------------------------------------

describe('U1/C11 U1-C11-TYST-FÖRE-DEFAULT', () => {
  test('[träff] värld 182 (en annan båt tar över, B) och 1526 (samma båt hörs igen, C)', () => {
    for (const k of ['w182', 'w1526']) {
      const { fynd, ctx } = fall(k);
      expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U1-C11-TYST-FÖRE-DEFAULT' });
    }
  });

  test('[vakt] texten före bar en ETA (bäraren var färsk), eller ingen båts tystnad passerar trappan vid episoden', () => {
    const p = pred('tystBärareFörfallen');
    const a = fall('w182');
    const före = a.ctx.resultat.bridgeTextTransitions.filter((x) => x.t < a.fynd.t - 1000).pop();
    före.text = 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 5 minuter';
    expect(p(a.fynd, a.ctx).skäl).toMatch(/inte en båt med okänd ETA/);
    const b = fall('w182');
    b.ctx.rader[b.ctx.rader.length - 1].aisTimestamp += 3 * MIN;
    expect(p(b.fynd, b.ctx).skäl).toMatch(/ingen bärare på väg mot Stridsbergsbron passerar sitt trappsteg/);
  });

  // Efterrättningen 2026-11-07: steget ska vara bärarens eget, och en båt med
  // målbro släpps tidigast vid 15 min.
  test('[vakt] granskarens prov: värld 182 där bäraren varit tyst i 610 s (trappans 10 min-steg gäller inte en båt med målbro); KANDIDAT', () => {
    const { fynd, ctx } = fall('w182');
    const sista = ctx.rader[ctx.rader.length - 1];
    sista.aisTimestamp = Date.parse('2026-08-05T13:06:30.040Z') - 610 * 1000;
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(pred('tystBärareFörfallen')(fynd, ctx).skäl).toMatch(/tyst i 610 s, inte vid sitt steg 15 min/);
  });

  test('[vakt] en annan båts trappsteg i samma fönster (hon är inte på väg mot bron) förklarar inte episoden; KANDIDAT', () => {
    const { fynd, ctx } = fall('w182');
    const sista = ctx.rader[ctx.rader.length - 1];
    sista.aisTimestamp = Date.parse('2026-08-05T13:06:30.040Z') - 700 * 1000;
    // En nordgående båt norr om Stallbackabron, tyst i 15 min + 10 s.
    ctx.rader.push({
      mmsi: '265324000', lat: 58.3200, lon: 12.3200, sog: 5, cog: 20, aisTimestamp: Date.parse('2026-08-05T13:06:30.040Z') - (15 * 60 + 10) * 1000,
    });
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    const s = pred('tystBärareFörfallen')(fynd, ctx);
    expect(s.sant).toBe(false);
    expect(s.skäl).toMatch(/265324000 \(15 min, inte på väg mot Stridsbergsbron\)/);
  });

  test('[vakt] M:s flapp: samma båt sänder var 30:e s och tappar målbron vid sin rad; KANDIDAT', () => {
    const { fynd, ctx } = flapp({ sog: 1.0, närmM: 12.5 });
    expect(pred('tystBärareFörfallen')(fynd, ctx).sant).toBe(false);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });
});

// ---------------------------------------------------------------------------
// M:s kända gränser (a)–(c): brusbandet kring rörelsebevisets trösklar
// ---------------------------------------------------------------------------

/**
 * En krypare som bär "En båt på väg mot Klaffbron" och flappar till "Inga
 * båtar" när harnessen bearbetar hennes rad, och tillbaka vid nästa rad.
 * Raderna har 30 s kadens 1000 m söder om Klaffbron med farten `sog` och
 * närmandet `närmM` per rad.
 */
function flapp({ sog = 0.3, närmM = 4, slutAnnan = false } = {}) {
  const T = Date.parse('2026-07-01T10:00:00.000Z');
  const B = platser.POINTS.Klaffbron;
  const mPerLat = 111320;
  const rad = (mmsi, i, dM) => ({
    mmsi, lat: B.lat - (1000 - dM) / mPerLat, lon: B.lon, sog, cog: 25, aisTimestamp: T + i * 30000,
  });
  const rader = Array.from({ length: 14 }, (_, i) => rad('265999001', i, i * närmM));
  if (slutAnnan) rader.push({ ...rad('265999002', 12, 0), aisTimestamp: T + 12 * 30000 - 5000, lat: B.lat - 2000 / mPerLat });
  rader.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  const ctx = { rader, resultat: {} };
  const tider = harnessTider(ctx);
  const text = 'En båt på väg mot Klaffbron, beräknad broöppning om 20 minuter';
  const t0 = tider.get(rader.find((r) => r.mmsi === '265999001' && r.aisTimestamp === T + 11 * 30000)) + 20;
  const slutRad = slutAnnan ? rader.find((r) => r.mmsi === '265999002') : rader.find((r) => r.aisTimestamp === T + 12 * 30000);
  const t1 = tider.get(slutRad) + 20;
  ctx.resultat.bridgeTextTransitions = [
    { t: T, text }, { t: t0, text: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron' }, { t: t1, text },
  ];
  const fynd = {
    orakel: 'INV-F', klass: 'INV-14 DEFAULT-FLASH', inv: 'INV-14', allvar: 4, mmsi: null, bro: 'Klaffbron', t: t0, belägg: {},
  };
  return { fynd, ctx };
}

/**
 * En krypare med 30 s kadens dM meter söder om punkten (kurs norr) med
 * farterna sogs (en per rad; raderna efter listan får sista värdet) och
 * närmandet närmM per rad. Texten "En båt på väg mot Klaffbron" faller till
 * "Inga båtar" när harnessen bearbetar rad iStart och kommer tillbaka vid rad
 * iSlut. Med passerad har båten en bokförd passage av Olidebron före raderna
 * (ANCHOR_BLOCK:s villkor).
 */
function kryp({
  sogs, dM = 632, punkt = 'Klaffbron', närmM = 0, iStart = 11, iSlut = 12, passerad = false, n = 16,
}) {
  const T = Date.parse('2026-07-01T10:00:00.000Z');
  const P = platser.POINTS[punkt];
  const rader = Array.from({ length: n }, (_, i) => ({
    mmsi: '265999001', lat: P.lat - (dM - i * närmM) / 111320, lon: P.lon, sog: sogs[Math.min(i, sogs.length - 1)], cog: 20, aisTimestamp: T + i * 30000,
  }));
  const ctx = { rader, resultat: { targetPassages: [], intermediatePassages: passerad ? [{ t: T - 10 * MIN, mmsi: '265999001', bridge: 'Olidebron' }] : [] } };
  const tider = harnessTider(ctx);
  const text = 'En båt på väg mot Klaffbron, beräknad broöppning om 20 minuter';
  const t0 = tider.get(rader[iStart]) + 20;
  const t1 = tider.get(rader[iSlut]) + 20;
  ctx.resultat.bridgeTextTransitions = [
    { t: T, text }, { t: t0, text: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron' }, { t: t1, text },
  ];
  const fynd = {
    orakel: 'INV-F', klass: 'INV-14 DEFAULT-FLASH', inv: 'INV-14', allvar: 4, mmsi: null, bro: 'Klaffbron', t: t0, belägg: {},
  };
  return { fynd, ctx };
}

// Fartgrinden 0,7 kn: farten brusar kring grinden, under den de 60 s före
// borttagningen och över den de 60 s före återkomsten.
const brus07 = [0.75, 0.65, 0.75, 0.65, 0.75, 0.65, 0.75, 0.65, 0.65, 0.65, 0.65, 0.65, 0.75, 0.75, 0.75, 0.75];
// ANCHOR_BLOCK 0,3 kn: under tröskeln de 60 s före borttagningen, över den
// vid raden som avslutar episoden.
const brus03 = [0.35, 0.25, 0.35, 0.25, 0.35, 0.25, 0.35, 0.25, 0.25, 0.25, 0.25, 0.25, 0.35];

describe('M:s kända gränser M-BRUSBAND-RÖRELSEBEVIS', () => {
  test('[träff] (i) fartgrinden 0,7 kn 632 m från närmaste bro: under grinden 60 s före, över den 60 s före återkomsten, episoden 120 s', () => {
    const { fynd, ctx } = kryp({ sogs: brus07, iSlut: 15 });
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'M-BRUSBAND-RÖRELSEBEVIS' });
    expect(pred('krypbandVidTröskel')(fynd, ctx).skäl).toMatch(/^\(i\) .*fartgrinden 0.7 kn/);
  });

  test('[vakt] samma brus men episoden en kadens lång: fartprovet dömer över tiden, så det är en regression av M:s rättning; KANDIDAT', () => {
    const { fynd, ctx } = kryp({ sogs: brus07, iSlut: 12 });
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('krypbandVidTröskel')(fynd, ctx).skäl).toMatch(/fartprovet vid 0.7 kn håller inte/);
  });

  test('[vakt] 0,7 kn-bruset 150 m från bron (ingen fartgräns där) och 400 m från bron (0,1 kn-zonen): KANDIDAT', () => {
    for (const dM of [150, 400]) {
      const { fynd, ctx } = kryp({ sogs: brus07, iSlut: 15, dM });
      expect(pred('krypbandVidTröskel')(fynd, ctx).sant).toBe(false);
    }
  });

  test('[träff] (i) ANCHOR_BLOCK 0,3 kn efter en bokförd passage: under tröskeln från 60 s före, 0,35 kn vid återkomsten', () => {
    const { fynd, ctx } = kryp({ sogs: brus03, dM: 150, passerad: true });
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'M-BRUSBAND-RÖRELSEBEVIS' });
    expect(pred('krypbandVidTröskel')(fynd, ctx).skäl).toMatch(/^\(i\) .*ANCHOR_BLOCK 0.3 kn/);
  });

  test('[vakt] samma 0,3 kn-brus utan bokförd passage: ANCHOR_BLOCK gäller inte; KANDIDAT', () => {
    const { fynd, ctx } = kryp({ sogs: brus03, dM: 150 });
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('krypbandVidTröskel')(fynd, ctx).skäl).toMatch(/ANCHOR_BLOCK \(0.3 kn\) gäller inte utan bokförd passage/);
  });

  test('[vakt] granskarens prov: en stillaliggande båt i 0 kn 1 km från bron flappar; KANDIDAT', () => {
    const { fynd, ctx } = kryp({ sogs: [0], dM: 1000, punkt: 'Olidebron' });
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] granskarens mönster: 0 kn 150, 1000 och 3000 m från Klaffbron och 0,4 kn 2000 m från den; KANDIDAT', () => {
    for (const [sog, dM] of [[0, 150], [0, 1000], [0, 3000], [0.4, 2000]]) {
      const { fynd, ctx } = kryp({ sogs: [sog], dM });
      expect(pred('krypbandVidTröskel')(fynd, ctx).sant).toBe(false);
      expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    }
  });

  test('[vakt] M:s krypare i jämn 0,4 kn efter en passage (F-KRYP) har inga rader under 0,3 kn; KANDIDAT', () => {
    const { fynd, ctx } = kryp({ sogs: [0.4], dM: 150, passerad: true });
    expect(pred('krypbandVidTröskel')(fynd, ctx).sant).toBe(false);
  });

  test('[träff] (ii) nettonärmande 10 m per 60 s (MIN_APPROACH_DISTANCE) med farten 0,5 kn', () => {
    const { fynd, ctx } = flapp({ sog: 0.5, närmM: 5 });
    expect(pred('krypbandVidTröskel')(fynd, ctx).skäl).toMatch(/^\(ii\)/);
  });

  test('[vakt] farten 0,5 kn och närmandet 25 m per 60 s ligger utanför brusbandet', () => {
    const { fynd, ctx } = flapp({ sog: 0.5, närmM: 12.5 });
    expect(pred('krypbandVidTröskel')(fynd, ctx).skäl).toMatch(/inte i brusbandet/);
  });

  test('[vakt] episoden slutar vid en annan båts rad: ingen båt bär texten före och efter', () => {
    const { fynd, ctx } = flapp({ sog: 0.3, slutAnnan: true });
    expect(pred('krypbandVidTröskel')(fynd, ctx).skäl).toMatch(/ingen båt bär texten/);
  });
});

// ---------------------------------------------------------------------------
// R1:s kända luckor i returens bokföring
// ---------------------------------------------------------------------------

const lästFixtur = (namn) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'fixtures', namn), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => Number.isFinite(r.lat));
const t10 = (mmsi, bro, t, dir) => ({
  orakel: 'T10',
  klass: 'PASSAGE-EJ-REGISTRERAD',
  allvar: 5,
  mmsi,
  bro,
  riktning: dir === 'nord' ? 'northbound' : 'southbound',
  t,
  belägg: { korsningT: t, korsning: { t: new Date(t).toISOString(), dir } },
});

describe('R1:s kända luckor TVÅ-ÅTERKORSADE-BROAR-I-SAMMA-SEGMENT och U-SVÄNG-LÅNGSAM-ÅTERKORSNING', () => {
  // KAJSA utan fixet 11:01:04: segmentet 10:53:43 → 11:05:53 korsar
  // Järnvägsbron och Stridsbergsbron norrut; appen bokför bara Stridsbergsbron.
  // Utresan söderut (L0 10:46:20 och 10:48:36, interpolerad ur raderna) gör
  // korsningen till en återkorsning (efterrättningen 2026-11-07).
  const tvåBroar = () => {
    const rader = lästFixtur('r1-kand-lucka-tva-broar-i-segmentet.jsonl');
    const b = rader.find((r) => r.aisTimestamp === Date.parse('2026-08-14T11:05:53.613Z'));
    const ctx = {
      rader,
      resultat: { intermediatePassages: [{ t: b.aisTimestamp, mmsi: '265781143', bridge: 'Stridsbergsbron' }], targetPassages: [] },
      sanning: {
        uturns: [{ mmsi: '265781143', t: Date.parse('2026-08-14T10:54:40Z') }],
        crossings: [
          {
            mmsi: '265781143', bridge: 'Stridsbergsbron', t: Date.parse('2026-08-14T10:46:20Z'), dir: 'syd',
          },
          {
            mmsi: '265781143', bridge: 'Järnvägsbron', t: Date.parse('2026-08-14T10:48:36Z'), dir: 'syd',
          },
          {
            mmsi: '265781143', bridge: 'Järnvägsbron', t: Date.parse('2026-08-14T11:03:30Z'), dir: 'nord',
          },
          {
            mmsi: '265781143', bridge: 'Stridsbergsbron', t: Date.parse('2026-08-14T11:04:57Z'), dir: 'nord',
          },
        ],
      },
    };
    return { ctx, f: t10('265781143', 'Järnvägsbron', Date.parse('2026-08-14T11:03:30Z'), 'nord'), b };
  };

  test('[träff] två återkorsade broar i samma segment: Järnvägsbron blir KÄND_ÖPPEN', () => {
    const { ctx, f } = tvåBroar();
    expect(klassa(reg, f, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'TVÅ-ÅTERKORSADE-BROAR-I-SAMMA-SEGMENT' });
  });

  test('[vakt] vändningen bekräftad före segmentet (två omvända fixar i 4 kn 10:56 och 10:58): den vanliga passagelogiken; KANDIDAT', () => {
    const { ctx, f } = tvåBroar();
    const J = platser.POINTS.Järnvägsbron;
    const mall = ctx.rader.filter((r) => r.aisTimestamp < Date.parse('2026-08-14T10:54:00Z')).pop();
    for (const [hh, dM] of [['10:56:00', 400], ['10:58:00', 300]]) {
      ctx.rader.push({
        ...mall, aisTimestamp: Date.parse(`2026-08-14T${hh}Z`), lat: J.lat - dM / 111320, sog: 4, cog: 30,
      });
    }
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    const c = klassa(reg, f, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'TVÅ-ÅTERKORSADE-BROAR-I-SAMMA-SEGMENT').skäl).toMatch(/Fix D bekräftade vändningen 10:58:00, senast vid a/);
  });

  test('[vakt] ingen tidigare korsning av bron i motsatt riktning: ingen återkorsning; KANDIDAT', () => {
    const { ctx, f } = tvåBroar();
    ctx.sanning.crossings = ctx.sanning.crossings.filter((x) => x.dir === 'nord');
    expect(pred('andraBronISammaSegment')(f, ctx).skäl).toMatch(/ingen tidigare L0-korsning av Järnvägsbron söderut/);
  });

  test('[vakt] bokföringen av den andra bron ligger inte vid segmentets slutfix: KANDIDAT (och segmentet har rörelse i nuet)', () => {
    const { ctx, f } = tvåBroar();
    ctx.resultat.intermediatePassages[0].t += 30000;
    const c = klassa(reg, f, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(pred('returUtanRörelsebevis')(f, ctx).skäl).toMatch(/rörelse i nuet/);
  });

  // HAVSORN: EN omvänd fix i 4 kn (väntan), sedan 1,5 kn med 30 s kadens över
  // Klaffbron och 5 kn först 120 m söder om bron.
  // Raderna efter 09:46 lämnar farledens centerlinje (över 250 m) och hade
  // gjort utslaget till MÄTGRÄNS-FACIT-SIDLED; de rör inte predikatet.
  const tätLångsam = () => {
    const rader = lästFixtur('r1-kand-lucka-tat-langsam-aterkorsning.jsonl').filter((r) => platser.project(r).offsetM < 250);
    const B = platser.POINTS.Klaffbron;
    const iB = rader.findIndex((r, i) => i > 0 && rader[i - 1].lat > B.lat && r.lat <= B.lat);
    const a = rader[iB - 1];
    const b = rader[iB];
    const tK = a.aisTimestamp + ((a.lat - B.lat) / (a.lat - b.lat)) * (b.aisTimestamp - a.aisTimestamp);
    const iSyd = rader.findIndex((r) => r.cog >= 135 && r.cog < 315);
    // Utresan norrut över Klaffbron 09:10:35 (interpolerad mellan 09:10:08
    // och 09:12:03).
    const ut = {
      mmsi: '265196010', bridge: 'Klaffbron', t: Date.parse('2026-06-25T09:10:35Z'), dir: 'nord',
    };
    const ctx = { rader, resultat: { targetPassages: [], intermediatePassages: [] }, sanning: { uturns: [{ mmsi: '265196010', t: rader[iSyd].aisTimestamp - 1000 }], crossings: [ut] } };
    return {
      ctx, f: t10('265196010', 'Klaffbron', Math.round(tK), 'syd'), b,
    };
  };

  test('[träff] tät långsam återkorsning (segment under 100 m, korsningsfixet 1,5 kn): KÄND_ÖPPEN', () => {
    const { ctx, f } = tätLångsam();
    expect(klassa(reg, f, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'U-SVÄNG-LÅNGSAM-ÅTERKORSNING' });
  });

  const gles = () => {
    const rader = lästFixtur('r1-kand-lucka-gles-langsam-vandning.jsonl');
    const tK = Date.parse('2026-06-25T09:19:00Z');
    const ut = {
      mmsi: '265196010', bridge: 'Klaffbron', t: Date.parse('2026-06-25T09:10:35Z'), dir: 'nord',
    };
    const ctx = { rader, resultat: {}, sanning: { uturns: [{ mmsi: '265196010', t: Date.parse('2026-06-25T09:15:00Z') }], crossings: [ut] } };
    return { ctx, f: t10('265196010', 'Klaffbron', tK, 'syd') };
  };

  test('[träff] långsam vändning utan fix i 2 kn före korsningen (glesa fixturen)', () => {
    const { ctx, f } = gles();
    expect(pred('returUtanRörelsebevis')(f, ctx).sant).toBe(true);
  });

  test('[vakt] granskarens prov: glesa fixturen med två omvända fixar i 4 kn 09:15:20 och 09:15:50 (bekräftad 3,5 min före korsningen); KANDIDAT', () => {
    const { ctx, f } = gles();
    const mall = ctx.rader.filter((r) => r.aisTimestamp < Date.parse('2026-06-25T09:14:30Z')).pop();
    for (const hh of ['09:15:20', '09:15:50']) {
      ctx.rader.push({
        ...mall, aisTimestamp: Date.parse(`2026-06-25T${hh}Z`), sog: 4, cog: 210,
      });
    }
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    const s = pred('returUtanRörelsebevis')(f, ctx);
    expect(s.sant).toBe(false);
    expect(s.skäl).toMatch(/Fix D bekräftade vändningen 09:15:50, senast vid a/);
    expect(klassa(reg, f, ctx).post).not.toBe('U-SVÄNG-LÅNGSAM-ÅTERKORSNING');
  });

  test('[vakt] tät långsam återkorsning med vändningen bekräftad i 2,5 kn 09:18:09, och utan utresa över bron: KANDIDAT', () => {
    const a = tätLångsam();
    a.ctx.rader.filter((r) => r.aisTimestamp < Date.parse('2026-06-25T09:18:30Z')).pop().sog = 2.5;
    expect(pred('returUtanRörelsebevis')(a.f, a.ctx).skäl).toMatch(/Fix D bekräftade vändningen 09:18:09/);
    const b = tätLångsam();
    b.ctx.sanning.crossings = [];
    expect(pred('returUtanRörelsebevis')(b.f, b.ctx).skäl).toMatch(/ingen tidigare L0-korsning av Klaffbron norrut/);
  });

  test('[vakt] korsningsfixet går i 2,4 kn (RE_CROSS_EVIDENCED:s fartkrav håller) och en korsning utan vändning: KANDIDAT', () => {
    const a = tätLångsam();
    a.b.sog = 2.4;
    expect(klassa(reg, a.f, a.ctx).klass).toBe('KANDIDAT');
    const b = tätLångsam();
    b.ctx.sanning.uturns = [];
    expect(pred('returUtanRörelsebevis')(b.f, b.ctx).skäl).toMatch(/ingen L0-vändning/);
  });
});
