'use strict';

/**
 * Ägarbesluten U25 och U26 (2026-11-09): två sena varningar godtas som kända
 * gränser (BUGGJAKT §7, rad 53 och 54; docs/ARCHITECTURE.md vid släppvägen).
 *
 * Fixturen fixtures/u25-u26-2026-11-09.json är byggd ur verkliga världar i
 * standardkörningen (basSeed 1) på eda1839, med fyndet och en trimmad
 * registerkontext: alla båtars rader i ett fönster kring fyndet, de
 * resultatfält registret läser och L0. Byggskriptet kontrollerar att fyndet
 * klassas likadant i den trimmade kontexten som i hela världen.
 *  - w1038: U25:s provvärld (T3 VARNING-EFTER-SANN-PASSAGE).
 *  - w1139: U26:s provvärld (T2 LEDTID<60s).
 *  - w979utanU24: värld 979 körd på en mutant där U24-släppet är bortkopplat
 *    (_ownDeadlineVerdict håller alltid). XENIA varnas då 50 s före korsningen,
 *    som före varv 2. Det är ett appfel och ska förbli KANDIDAT.
 *
 * [träff] är ett utslag som posten ska klassa, [vakt] ett motexempel som ska
 * förbli KANDIDAT. Varje vakt bryter ett villkor i predikatet. Inga
 * barnprocesser och inga timers.
 */

const { loadRegistry, PREDICATES } = require('../lib/registry');
const F = require('./fixtures/u25-u26-2026-11-09.json');

const U25 = 'U25-BAKKANT-VID-SEN-BOKFÖRING';
const U26 = 'U26-STILLA-KÖ-SEN-VARNING';

const kopia = (x) => JSON.parse(JSON.stringify(x));
const fall = (k) => kopia(F[k]);
const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });
const pred = (namn, extra = {}) => (f, ctx) => PREDICATES[namn].fn(f, ctx, { ...PREDICATES[namn].parametrar, ...extra });
const sortera = (ctx) => ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
const domarFör = (ctx, mmsi, bro) => ctx.resultat.openingCoverageVerdicts
  .filter((v) => String(v.mmsi) === mmsi && v.bridge === bro).sort((x, y) => x.t - y.t);
const radVid = (ctx, mmsi, t) => ctx.rader.find((r) => String(r.mmsi) === mmsi && r.aisTimestamp === t);

let reg;
beforeAll(() => {
  reg = loadRegistry();
});

// ---------------------------------------------------------------------------
// U25: bakkanten släpper först när händelsens första passage bokförs (1038)
// ---------------------------------------------------------------------------

describe('U25: bakkantens släpp vid en sen bokföring utan tidigare underlag (provvärld 1038)', () => {
  // ELSA MARIA (265310915) absorberas 12:02:52 i ZELDAs Stridsbergsbron#2.
  // ZELDA (265310872) korsar tyst 12:07:18 och hörs nästa gång 12:15:55,094.
  // Då bokförs #2:s första passage, bakkanten släpper ELSA MARIA i samma
  // utvärdering, och hennes egen varning #6 går 12 s efter hennes korsning
  // 12:15:43.
  const iso = (hh) => Date.parse(`2026-06-20T${hh}Z`);
  const M = '265310915';
  const LEDARE = '265310872';
  const BRO = 'Stridsbergsbron';
  const p25 = pred('bakkantVidSenBokföring');
  const släppet = (ctx) => domarFör(ctx, M, BRO).pop();

  test('[träff] värld 1038: bokföringen kom 12 s efter hennes korsning, på ledarens första rad efter bron; ACCEPTERAD U25', () => {
    const { fynd, ctx } = fall('w1038');
    expect(släppet(ctx)).toMatchObject({ t: iso('12:15:55.094'), eventId: 'Stridsbergsbron#2', verdict: { kind: 'bakkant' } });
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'ACCEPTERAD', post: U25 });
    expect(p25(fynd, ctx).skäl).toMatch(/U25: absorberad i Stridsbergsbron#2 12:02:52.*bokfördes först 12:15:55.*12 s efter korsningen/);
  });

  test('[vakt] (a) händelsens varning kom efter hennes korsning; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1038');
    ctx.resultat.openingWarnings.find((w) => w.eventId === 'Stridsbergsbron#2').t = iso('12:15:50');
    expect(p25(fynd, ctx).skäl).toMatch(/absorberades inte före sin korsning/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (b) hennes sista dom var inte bakkantens släpp, eller släppet var U24:s egen deadline; KANDIDAT', () => {
    const a = fall('w1038');
    släppet(a.ctx).verdict.kind = 'täckningsslut';
    expect(p25(a.fynd, a.ctx).skäl).toMatch(/inte bakkantens släpp/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');

    const b = fall('w1038');
    Object.assign(släppet(b.ctx).event, { firstPassageAt: null, firstPassageRegisteredAt: null });
    expect(p25(b.fynd, b.ctx).skäl).toMatch(/U24:s egen deadline före händelsens första passage/);
    expect(klassa(reg, b.fynd, b.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (b) bakkanten släppte henne mer än en tick efter bokföringen: släppet var sent i sig; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1038');
    släppet(ctx).event.firstPassageRegisteredAt -= 45 * 1000;
    expect(p25(fynd, ctx).skäl).toMatch(/inte inom en tick efter att händelsens första passage bokfördes 12:15:10/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (c) bokföringen måste komma senare än korsningen minus golvet (här golvet −20 s mot bokföringen 12 s efter)', () => {
    const { fynd, ctx } = fall('w1038');
    expect(pred('bakkantVidSenBokföring', { golvMs: -20 * 1000 })(fynd, ctx).skäl).toMatch(/bokföringen var inte sen/);
  });

  test('[vakt] (d) appen hade underlaget tidigare: ledaren hördes efter sin korsning 12:10:00 men passagen bokfördes först 12:15:55; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1038');
    const mall = radVid(ctx, LEDARE, iso('12:15:55.094'));
    ctx.rader.push({ ...mall, aisTimestamp: iso('12:10:00'), fixTs: iso('12:10:00') });
    sortera(ctx);
    expect(p25(fynd, ctx).skäl).toMatch(/appen hade underlag för Stridsbergsbron#2:s första passage redan 12:10:00.*mer än en tick före bokföringen 12:15:55/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[träff] (d) ledarens rad kom inom en tick före bokföringen: fortfarande inget tidigare underlag; U25', () => {
    const { fynd, ctx } = fall('w1038');
    const mall = radVid(ctx, LEDARE, iso('12:15:55.094'));
    ctx.rader.push({ ...mall, aisTimestamp: iso('12:15:35'), fixTs: iso('12:15:35') });
    sortera(ctx);
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'ACCEPTERAD', post: U25 });
  });

  test('[vakt] (e) släppet följde inte bakkantens regel: orent fix, fryst arm eller kursen bort; KANDIDAT', () => {
    const a = fall('w1038');
    släppet(a.ctx).arm.lastFixClean = false;
    expect(p25(a.fynd, a.ctx).skäl).toMatch(/orent fix eller ur en fryst arm/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');

    const b = fall('w1038');
    släppet(b.ctx).frozen = true;
    expect(p25(b.fynd, b.ctx).skäl).toMatch(/orent fix eller ur en fryst arm/);

    const c = fall('w1038');
    släppet(c.ctx).courseAway = true;
    expect(p25(c.fynd, c.ctx).skäl).toMatch(/ledde bort från bron/);
  });

  test('[vakt] (e) ankomsten låg inom fönstret, eller bara efter ett för tidigt fönsterslut i appen; KANDIDAT', () => {
    const a = fall('w1038');
    const va = släppet(a.ctx).verdict;
    va.arrivalMs = va.windowEndMs - 1000;
    expect(p25(a.fynd, a.ctx).skäl).toMatch(/släppet följde inte bakkantens regel/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');

    // Appens fönsterslut två minuter för tidigt och ankomsten mellan appens
    // och motorns slut: motorn räknar slutet ur händelsen och säger nej.
    const b = fall('w1038');
    const vb = släppet(b.ctx).verdict;
    vb.arrivalMs = vb.windowEndMs - 10 * 1000;
    vb.windowEndMs -= 120 * 1000;
    expect(vb.arrivalMs).toBeGreaterThan(vb.windowEndMs);
    expect(p25(b.fynd, b.ctx).skäl).toMatch(/låg inte efter fönstrets slut 12:16:26.*släppet följde inte bakkantens regel/);
    expect(klassa(reg, b.fynd, b.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (f) U24 kunde ha släppt henne före bokföringen: ett fix i 0,8 kn utanför väntzonen med ankomsten efter fönstret; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1038');
    radVid(ctx, M, iso('12:09:16.940')).sog = 0.8;
    expect(p25(fynd, ctx).skäl).toMatch(/U24 kunde ha släppt henne ur Stridsbergsbron#2 \(dom 12:09:16\).*varningen blev sen av det skälet/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (g) hon hördes efter sin korsning före varningen: appen hade kunnat bokföra hennes egen passage; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1038');
    const mall = radVid(ctx, M, iso('12:16:55.891'));
    ctx.rader.push({ ...mall, aisTimestamp: iso('12:15:50'), fixTs: iso('12:15:50') });
    sortera(ctx);
    expect(p25(fynd, ctx).skäl).toMatch(/hon var inte tyst över korsningen/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] utan släppvägens domspår, eller när varningen leds av en annan båt; KANDIDAT', () => {
    const a = fall('w1038');
    delete a.ctx.resultat.openingCoverageVerdicts;
    expect(p25(a.fynd, a.ctx).skäl).toMatch(/saknar släppvägens domspår/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');

    const b = fall('w1038');
    b.ctx.resultat.openingWarnings.find((w) => w.eventId === 'Stridsbergsbron#6').leadMmsi = LEDARE;
    expect(p25(b.fynd, b.ctx).skäl).toMatch(/leds av 265310872, inte av båten själv/);
  });

  test('[vakt] posten gäller bara T3 VARNING-EFTER-SANN-PASSAGE: U26:s provvärld tas inte', () => {
    const { fynd, ctx } = fall('w1139');
    expect(klassa(reg, fynd, ctx).post).not.toBe(U25);
    expect(reg.poster.find((x) => x.id === U25).gäller).toEqual({ orakel: ['T3'], klassRegex: '^VARNING-EFTER-SANN-PASSAGE$' });
  });
});

// ---------------------------------------------------------------------------
// U26: en stilla köande båt varnas vid täckningsslutet när avgången inte hördes (1139)
// ---------------------------------------------------------------------------

describe('U26: stilla i kön vid täckningsslutet i en händelse utan passage (provvärld 1139)', () => {
  // MASEN (265620261) ligger stilla 157 m från Stridsbergsbron. Vid #1:s
  // täckningsslut 12:26:08 absorberas hon i #5, som avfyrades 12:25:02,446 på
  // den tysta YRSA 2:s (265620285) gamla fix. YRSA 2 hade korsat osedd
  // 12:23:03 och hördes aldrig mer. MASEN avgår osedd och varnas vid #5:s
  // täckningsslut 12:35:02,447, 41 s före korsningen 12:35:43.
  const iso = (hh) => Date.parse(`2026-06-13T${hh}Z`);
  const M = '265620261';
  const TYST = '265620285';
  const BRO = 'Stridsbergsbron';
  const p26 = pred('stillaKöVidTäckningsslut');
  const slutdomen = (ctx) => domarFör(ctx, M, BRO).pop();
  const UTANFÖR = { lat: 58.297793, lon: 12.300189 }; // hennes läge 12:16:49, cirka 577 m från bron

  test('[träff] värld 1139: stilla i kön, avgången hördes inte, varningen vid täckningsslutet 41 s före korsningen; ACCEPTERAD U26', () => {
    const { fynd, ctx } = fall('w1139');
    expect(slutdomen(ctx)).toMatchObject({ t: iso('12:35:02.447'), eventId: 'Stridsbergsbron#5', verdict: { kind: 'täckningsslut' } });
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'ACCEPTERAD', post: U26 });
    expect(p26(fynd, ctx).skäl).toMatch(/U26: absorberad i Stridsbergsbron#5 12:26:08 \(passagen okänd\), stilla i kön 15\d m från bron.*41 s före korsningen/);
  });

  test('[vakt] (a) hennes sista dom var inte ett täckningsslut, eller händelsens passage var känd; KANDIDAT', () => {
    const a = fall('w1139');
    slutdomen(a.ctx).verdict.kind = 'bakkant';
    expect(p26(a.fynd, a.ctx).skäl).toMatch(/inte ett täckningsslut/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');

    const b = fall('w1139');
    Object.assign(slutdomen(b.ctx).event, { firstPassageAt: iso('12:23:03'), firstPassageRegisteredAt: iso('12:27:00') });
    expect(p26(b.fynd, b.ctx).skäl).toMatch(/första passage var känd vid täckningsslutet/);
    expect(klassa(reg, b.fynd, b.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (a) varningen avfyrades av ett fix och inte av ticken; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1139');
    ctx.resultat.openingWarnings.find((w) => w.eventId === 'Stridsbergsbron#6').firedBy = 'fix';
    expect(p26(fynd, ctx).skäl).toMatch(/avfyrades av fix, inte av ticken/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (a) täckningsslutet kom två minuter efter det slut som motorn räknar ur händelsen; inte U26', () => {
    // Händelsens levererade varning två minuter tidigare ger motorns slut
    // 12:33:02; appens täckningsslut 12:35:02 ligger då mer än en tick efter.
    // Med den flyttade tiden ligger #5:s varning dessutom före YRSA 2:s sanna
    // korsning, så K-TYST-BÅT-NÄSTA-ÖPPNING (KÄND_ÖPPEN) tar fyndet. Det hör
    // till den posten och inte till U26; provet gäller bara att U26 säger nej.
    const { fynd, ctx } = fall('w1139');
    ctx.resultat.openingWarnings.find((w) => w.eventId === 'Stridsbergsbron#5').t -= 120 * 1000;
    expect(p26(fynd, ctx).skäl).toMatch(/kom inte inom en tick efter täckningsslutet 12:33:02.* som motorn räknar ur Stridsbergsbron#5/);
    expect(klassa(reg, fynd, ctx).post).not.toBe(U26);
    // Samma prov utan sidoeffekten: fönstret två minuter kortare ger samma slut.
    const b = fall('w1139');
    expect(pred('stillaKöVidTäckningsslut', { fönsterMs: 8 * 60 * 1000 })(b.fynd, b.ctx).skäl)
      .toMatch(/kom inte inom en tick efter täckningsslutet 12:33:02/);
  });

  test('[vakt] (b) hennes sista rad före varningen visade fart, eller låg utanför väntzonen; KANDIDAT', () => {
    const a = fall('w1139');
    radVid(a.ctx, M, iso('12:32:34.887')).sog = 3;
    expect(p26(a.fynd, a.ctx).skäl).toMatch(/hade 3 kn .*hon låg inte stilla i kön/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');

    const b = fall('w1139');
    Object.assign(radVid(b.ctx, M, iso('12:32:34.887')), UTANFÖR);
    expect(p26(b.fynd, b.ctx).skäl).toMatch(/låg 5\d\d m från bron, utanför väntzonen \(350 m\)/);
    expect(klassa(reg, b.fynd, b.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (c) avgången hördes: en rad i 2,5 kn efter hennes deadline, fast sista raden åter var stilla; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1139');
    const mall = radVid(ctx, M, iso('12:32:34.887'));
    ctx.rader.push({
      ...mall, aisTimestamp: iso('12:33:30'), fixTs: iso('12:33:30'), sog: 2.5, cog: 217,
    });
    ctx.rader.push({
      ...mall, aisTimestamp: iso('12:34:00'), fixTs: iso('12:34:00'), sog: 0,
    });
    sortera(ctx);
    expect(p26(fynd, ctx).skäl).toMatch(/hennes rad 12:33:30.*\(2\.5 kn\).*avgången hördes/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (d) en rad i händelsen låg utanför väntzonen: U24 kan ha omfattat henne; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1139');
    Object.assign(radVid(ctx, M, iso('12:29:22.095')), UTANFÖR);
    expect(p26(fynd, ctx).skäl).toMatch(/hennes rad 12:29:22.* i Stridsbergsbron#5 låg 5\d\d m från bron.*U24 kan ha omfattat henne/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (d) bakkanten i den tidigare händelsen kunde ha släppt henne: ankomsten låg efter fönstrets slut; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1139');
    const v = domarFör(ctx, M, BRO).find((x) => x.t === iso('12:18:59.106'));
    expect(v).toMatchObject({ eventId: 'Stridsbergsbron#1', verdict: { kind: 'covered' } });
    v.verdict.arrivalMs = v.verdict.windowEndMs + 60 * 1000;
    expect(p26(fynd, ctx).skäl).toMatch(/bakkanten kunde ha släppt henne ur Stridsbergsbron#1 \(dom 12:18:59\).*inte bara av den tysta avgången/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (e) data visade händelsens passage: YRSA 2 hördes efter sin korsning före varningen; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1139');
    const mall = radVid(ctx, M, iso('12:39:48.019'));
    ctx.rader.push({
      ...mall, mmsi: TYST, aisTimestamp: iso('12:28:00'), fixTs: iso('12:28:00'),
    });
    sortera(ctx);
    expect(p26(fynd, ctx).skäl).toMatch(/appen hade underlag för Stridsbergsbron#5:s första passage 12:28:00.*passagen borde ha bokförts/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] utan släppvägens domspår; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1139');
    delete ctx.resultat.openingCoverageVerdicts;
    expect(p26(fynd, ctx).skäl).toMatch(/saknar släppvägens domspår/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] värld 979 med U24-släppet bortkopplat: en båt i rörelse utanför väntzonen tas aldrig; KANDIDAT', () => {
    const { fynd, ctx } = fall('w979utanU24');
    expect(fynd).toMatchObject({
      orakel: 'T2', klass: 'LEDTID<60s', mmsi: '265141626', bro: BRO,
    });
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(p26(fynd, ctx).sant).toBe(false);
    expect(p26(fynd, ctx).skäl).toMatch(/utanför väntzonen|hon låg inte stilla i kön|U24 kunde ha släppt henne/);
  });

  test('[vakt] posten gäller bara T2 LEDTID: U25:s provvärld tas inte', () => {
    const { fynd, ctx } = fall('w1038');
    expect(klassa(reg, fynd, ctx).post).not.toBe(U26);
    expect(reg.poster.find((x) => x.id === U26).gäller).toEqual({ orakel: ['T2'], klassRegex: '^LEDTID' });
  });
});
