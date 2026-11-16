'use strict';

/**
 * Rättningskampanjens varv 2, familj E (MOTOR): motorfelen som triagen av
 * restkorten hittade i registrets predikat (BUGGJAKT §7, rad 37 och framåt).
 *
 * Fixturen fixtures/varv2-motor-2026-11-09.json är byggd ur verkliga världar
 * i standardkörningen på c14938f (basSeed 1, radhashen i `recept` är bitlik
 * med världen): fyndet och dess registerkontext med ALLA båtars rader i ett
 * fönster kring fyndet, de resultatfält registret läser, L0 och L1.
 * Byggskriptet kontrollerar att fyndet klassas likadant i den trimmade
 * kontexten som i hela världen.
 *
 * Fixturen fixtures/varv2-u24-2026-11-09.json är provvärld 143 körd på familj
 * B:s 0b0a35d (ägarbeslutet U24) med samma motor, byggd på samma sätt, och
 * fixtures/varv2-m9-1837-2026-11-09.json är värld 1837 med M9:s radio.
 *
 * [träff] är ett utslag som posten ska klassa, [vakt] ett motexempel som ska
 * förbli KANDIDAT. Inga barnprocesser och inga timers.
 */

const { loadRegistry, PREDICATES } = require('../lib/registry');
const V = require('./fixtures/varv2-motor-2026-11-09.json');

const kopia = (x) => JSON.parse(JSON.stringify(x));
const fall = (k) => kopia(V[k]);
const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });
const pred = (namn, extra = {}) => (f, ctx) => PREDICATES[namn].fn(f, ctx, { ...PREDICATES[namn].parametrar, ...extra });
const prövad = (c, post) => (c.prövade || []).find((p) => p.post === post) || (c.närmast && c.närmast.post === post ? c.närmast : null);
const iso = (hh) => Date.parse(`2026-09-14T${hh}Z`);

let reg;
beforeAll(() => {
  reg = loadRegistry();
});

// ---------------------------------------------------------------------------
// M3: gemensam RECOVER (värld 972, F07)
// ---------------------------------------------------------------------------

describe('M3: gemensam RECOVER i villkor (2) av tystRecoverSammaÖppning', () => {
  // QUEST (265159025) och MASEN (265158956) absorberades båda i
  // Stridsbergsbron#6 13:49:33,735, släpptes vid samma täckningsslut och
  // bands till EN ny händelse #10 13:54:52,919, som leds av MASEN (närmast på
  // rått avstånd). Ingen av dem hördes efter absorptionen.
  const W = 'Stridsbergsbron#10';
  const ledare = '265158956';

  test('[träff] värld 972: ledaren släpptes ur samma händelse vid samma täckningsslut, och ingen av dem hördes efteråt; U17', () => {
    const { fynd, ctx } = fall('w972');
    expect(ctx.resultat.openingWarnings.find((w) => w.eventId === W).leadMmsi).toBe(ledare);
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' });
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/gemensam RECOVER med 265158956 som ledare, Stridsbergsbron#10 13:54:52/);
  });

  test('[vakt] ledaren hördes efter sin absorption: W kan vara hans färska varning; KANDIDAT', () => {
    const { fynd, ctx } = fall('w972');
    const mall = ctx.rader.filter((r) => r.mmsi === ledare).pop();
    ctx.rader.push({ ...mall, aisTimestamp: iso('13:53:52.919'), fixTs: iso('13:53:52.919') });
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl).toMatch(/ingen gemensam RECOVER: 265158956 hördes 13:53:52/);
  });

  test('[vakt] hon hördes efter sin absorption; KANDIDAT (här redan av tystnadsvillkoret, eftersom raden ligger efter hennes korsning)', () => {
    const { fynd, ctx } = fall('w972');
    const mall = ctx.rader.filter((r) => r.mmsi === fynd.mmsi).pop();
    ctx.rader.push({ ...mall, aisTimestamp: iso('13:51:00'), fixTs: iso('13:51:00') });
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/fix 13:51:00 .*låg efter korsningen 13:40:31/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] hennes egen rad efter absorptionen (före korsningen) bryter den gemensamma RECOVERn', () => {
    // Absorptionen i #6 flyttas till före hennes korsning 13:40:31, och en rad
    // 13:40:00 läggs efter den: då kan hennes färska prognos ha seedat W.
    const { fynd, ctx } = fall('w972');
    for (const c of ctx.resultat.openingCoverage.filter((x) => x.eventId === 'Stridsbergsbron#6')) c.t = iso('13:39:50');
    const mall = ctx.rader.filter((r) => r.mmsi === fynd.mmsi).pop();
    ctx.rader.push({ ...mall, aisTimestamp: iso('13:40:00'), fixTs: iso('13:40:00') });
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/ingen gemensam RECOVER: 265159025 hördes 13:40:00/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] ledarens senaste absorption gällde en annan händelse; KANDIDAT', () => {
    const { fynd, ctx } = fall('w972');
    const hans = ctx.resultat.openingCoverage.find((c) => c.mmsi === ledare && c.eventId === 'Stridsbergsbron#6');
    hans.eventId = 'Stridsbergsbron#7';
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl).toMatch(/hennes senaste absorption gällde Stridsbergsbron#6 .*ledarens Stridsbergsbron#7/);
  });

  test('[vakt] hon är inte medlem i varningen; KANDIDAT', () => {
    const { fynd, ctx } = fall('w972');
    const w = ctx.resultat.openingWarnings.find((x) => x.eventId === W);
    w.mmsis = [ledare];
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/inte medlem i varningen/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] samma prov gäller läget nästa (K-TYST-BÅT-NÄSTA-ÖPPNING): 972 är samma öppning', () => {
    const { fynd, ctx } = fall('w972');
    expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(fynd, ctx).skäl).toMatch(/inom 600 s \(samma öppning, U17\)/);
  });
});

// ---------------------------------------------------------------------------
// B01: kajpredikatet binds till textens bärare (värld 138 och kajB)
// ---------------------------------------------------------------------------

describe('B01 och U23: mooringCapsuleStationary binds till den båt som bar texten', () => {
  test('[träff] värld 138: kajliggaren TROLLA (navStatus 5, aldrig målbro) bar aldrig texten; flashen är ULLAs 20-minuterssteg, U1-C11', () => {
    const { fynd, ctx } = fall('w138');
    const c = klassa(reg, fynd, ctx);
    expect(c).toMatchObject({ klass: 'DESIGN', post: 'U1-C11-TYST-FÖRE-DEFAULT' });
    expect(prövad(c, 'U23-KAJZON-UTANFÖR-VÄNTZONEN').skäl).toMatch(/265162412: inget rörelsebevis före stillheten/);
  });

  test('[vakt] värld 138 där TROLLA hade kommit norrut i 3 kn: navStatus 5 under stillheten, så navstatus-lagret klassade henne', () => {
    const { fynd, ctx } = fall('w138');
    const trolla = ctx.rader.filter((x) => x.mmsi === '265162412');
    ctx.rader.push({
      ...trolla[0], lat: trolla[0].lat - 0.0008, sog: 3, cog: 20, navStatus: 0, aisTimestamp: trolla[0].aisTimestamp - 60000, fixTs: trolla[0].aisTimestamp - 60000,
    });
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    expect(pred('mooringCapsuleStationary')(fynd, ctx).skäl).toMatch(/265162412: navStatus 5 .*under stillheten \(navstatus-lagret/);
  });

  // kajB (triage B, kort/kajB): en båt norrut mot Stridsbergsbron stannar
  // 6 min i Kajens kapsel, 979 m från bron. Zonregeln demoterar henne vid
  // raden 08:27:28,095, när stilltiden når 3 min, och texten blir "Inga båtar"
  // 25 ms senare i 240 s. Det är en äkta kajflash.
  test('[träff] kajB: bäraren demoteras av zonregeln efter 3 min när episoden börjar; U23 (som i dag för en båt som inte är på väg mot Klaffbron)', () => {
    const { fynd, ctx } = fall('kajB');
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U23-KAJZON-UTANFÖR-VÄNTZONEN' });
    expect(pred('mooringCapsuleStationary')(fynd, ctx).skäl).toMatch(/U23: bäraren 265900100 .* demoterades av zonregeln \(krav 3 min\) vid raden 08:27:28; .* 25 ms efter/);
  });

  test('[vakt] kajB med navStatus 5 under stillheten: navstatus-lagret, inte zonregeln', () => {
    const { fynd, ctx } = fall('kajB');
    for (const r of ctx.rader.filter((x) => x.sog === 0)) r.navStatus = 5;
    expect(pred('mooringCapsuleStationary')(fynd, ctx).skäl).toMatch(/navStatus 5 08:24:28 under stillheten/);
  });

  test('[vakt] kajB där stillheten börjar en minut senare: episoden börjar före demotionen', () => {
    const { fynd, ctx } = fall('kajB');
    const förstaStilla = ctx.rader.filter((x) => x.sog === 0).slice(0, 2);
    for (const r of förstaStilla) r.sog = 0.6;
    expect(pred('mooringCapsuleStationary')(fynd, ctx).skäl).toMatch(/stilla 120 s sedan 08:25:28, under kravet i "Kajen norr om Klaffbron" \(3 min\)/);
  });

  test('[vakt] kajB på väg söderut (kursen 205°): målbron är Klaffbron, inte Stridsbergsbron', () => {
    const { fynd, ctx } = fall('kajB');
    for (const r of ctx.rader) r.cog = 205;
    expect(pred('mooringCapsuleStationary')(fynd, ctx).skäl).toMatch(/på väg mot Klaffbron .* inte mot Stridsbergsbron/);
  });

  // Appens stillhetsklocka startar vid den första stilla raden var båten än
  // ligger, och zonen prövas vid varje rad. kajG: söderut mot Klaffbron,
  // stopp 4 min 376 m före bron och 45 m öster om farleden i Gästhamnens
  // kapsel (utan köundantag). Raden 08:26:38 (0,2 kn) ligger utanför kapseln
  // men startar klockan; appen demoterar henne vid raden 08:29:38
  // ("zon Gästhamnen norr om Klaffbron (still 3 min)"). kajK: triagens kajA
  // med kön kortad till 17 min, i Kajens kapsel 245 m före Klaffbron;
  // köundantaget (15 min) gäller.
  test('[träff] kajG: demotionen efter 3 min i Gästhamnen hittas på appens klocka; U23 (hela Gästhamnen som i dag)', () => {
    const g = fall('kajG');
    expect(klassa(reg, g.fynd, g.ctx)).toMatchObject({ klass: 'DESIGN', post: 'U23-KAJZON-UTANFÖR-VÄNTZONEN' });
    expect(pred('mooringCapsuleStationary')(g.fynd, g.ctx).skäl)
      .toMatch(/U23: bäraren 265900100 \(på väg mot Klaffbron, 379 m från bron\) låg stilla från 08:26:38 i "Gästhamnen norr om Klaffbron" /);
    expect(pred('mooringCapsuleStationary')(g.fynd, g.ctx).skäl).toMatch(/\(utanför väntzonen, 319 m\) .*krav 3 min\) vid raden 08:29:38/);
  });

  test('[vakt] kajK: en båt på väg mot Klaffbron vid Kajen; enligt U23 ska hon stå kvar (D1), KANDIDAT före och efter familj F', () => {
    // Före F (köundantaget 15 min) demoterar zonregeln henne efter 15 min,
    // och det är appfelet mot U23. Efter F (Infinity) demoteras hon aldrig,
    // och predikatet hittar ingen demotion. KANDIDAT i båda lägena.
    const k = fall('kajK');
    const obegränsat = require('../lib/shrink').kajensKöundantagS() === null;
    expect(pred('mooringCapsuleStationary')(k.fynd, k.ctx).skäl).toMatch(obegränsat
      ? /under kravet i "Kajen norr om Klaffbron" \(aldrig: obegränsat köundantag, U23\)/
      : /demoterad i "Kajen norr om Klaffbron" 245 m från Klaffbron; kapselns närmaste punkt ligger 161 m från bron, inom väntzonen \(300 m\): enligt U23/);
    expect(klassa(reg, k.fynd, k.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] kajK med köundantaget avstängt (3 min, som om zonen saknade queueGraceMs): fortfarande inom väntzonen, KANDIDAT', () => {
    // Villkoret bygger på geometrin, inte på köundantaget, så det håller om
    // familj F:s apprättning ändrar konstanterna i stället för zonregeln.
    const k = fall('kajK');
    expect(pred('mooringCapsuleStationary', { köundantagM: -1 })(k.fynd, k.ctx).sant).toBe(false);
  });

  test('[vakt] kajB utan rörelsebevis (0,4 kn före stillheten): fick aldrig någon målbro', () => {
    const { fynd, ctx } = fall('kajB');
    for (const r of ctx.rader.filter((x) => x.sog > 0)) r.sog = 0.4;
    expect(pred('mooringCapsuleStationary')(fynd, ctx).skäl).toMatch(/inget rörelsebevis/);
  });
});

// ---------------------------------------------------------------------------
// M1: U17 och K-NÄSTA på appens egen prognos MED oberoende fysik
// ---------------------------------------------------------------------------

describe('M1: villkor (3′) på släppvägens domspår (openingCoverageVerdicts)', () => {
  const { namespaceEventIds } = require('../lib/instances');
  // Triage B:s nio U17- och K-NÄSTA-sanna släpp vid täckningsslutet. Appens
  // prognos låg inom fönstrets slut vid varje ren bakkantsdom (+3,5 till
  // +134 s), och den fysiska ankomsten ur samma fix också (+27 till +154 s).
  const U17 = ['w1973', 'w537', 'w625', 'w1337', 'w1629', 'w1752', 'w479'];
  const NÄSTA = ['w510', 'w1704'];

  test('[träff] de sju samma-öppningsfallen blir U17 och de två nästa-öppningsfallen K-NÄSTA', () => {
    for (const k of U17) {
      const { fynd, ctx } = fall(k);
      expect([k, klassa(reg, fynd, ctx)]).toMatchObject([k, { klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' }]);
    }
    for (const k of NÄSTA) {
      const { fynd, ctx } = fall(k);
      expect([k, klassa(reg, fynd, ctx)]).toMatchObject([k, { klass: 'KÄND_ÖPPEN', post: 'K-TYST-BÅT-NÄSTA-ÖPPNING' }]);
    }
  });

  test('[vakt] utan domspåret gäller kvotregeln som förut: värld 625 (restiden 436 av 553 s) är KANDIDAT', () => {
    const { fynd, ctx } = fall('w625');
    delete ctx.resultat.openingCoverageVerdicts;
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/restiden 436 s/);
  });

  test('[vakt] värld 790: appens prognos låg inom fönstret (ETA-golvet 2,5 kn), men den fysiska ankomsten i 1 kn låg 178 s efter; KANDIDAT', () => {
    const { fynd, ctx } = fall('w790');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'K-TYST-BÅT-NÄSTA-ÖPPNING').skäl)
      .toMatch(/den fysiska ankomsten 13:39:08 ur hennes rad 13:28:18 \(334 m, 1 kn\) låg efter fönstrets slut 13:36:10/);
  });

  test('[vakt] bakkanten bortkopplad: en ren dom med prognosen efter fönstrets slut som ändå höll henne; KANDIDAT', () => {
    const { fynd, ctx } = fall('w625');
    const v = ctx.resultat.openingCoverageVerdicts.filter((x) => x.mmsi === fynd.mmsi && x.verdict.kind === 'covered').pop();
    v.arm.expectedArrivalMs = Date.parse('2026-09-01T09:28:06Z');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl).toMatch(/appens prognos 09:28:06 vid hennes fix 09:24:59 .* låg efter fönstrets slut 09:28:01, men bakkanten släppte henne inte/);
  });

  test('[vakt] ett fix efter den skattade passagen men före bokföringen med prognosen efter fönstrets slut (triage A:s M4); KANDIDAT', () => {
    // Värld 1973: domen 15:32:25 gäller fixet 15:32:24,944, efter PELLEs
    // skattade korsning 15:32:03,6 men före bokföringen 15:32:25,0. Appen på
    // c14938f mäter färskheten mot bokföringen och dömer inte det fixet; KRAV (2)
    // och familj B:s rättning mäter mot passagen.
    const { fynd, ctx } = fall('w1973');
    const v = ctx.resultat.openingCoverageVerdicts.find((x) => x.mmsi === fynd.mmsi && x.verdict.kind === 'covered'
      && x.arm.lastSeenAt > x.event.firstPassageAt && x.arm.lastSeenAt <= x.event.firstPassageRegisteredAt);
    expect(v).toBeTruthy();
    v.arm.expectedArrivalMs = Date.parse('2026-06-26T15:42:30Z');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl).toMatch(/appens prognos 15:42:30 vid hennes fix 15:32:24 .* men bakkanten släppte henne inte/);
  });

  test('[vakt] värld 1160 (triage A:s M4): fixet 11:35:15 efter ledarens skattade passage hade prognosen efter fönstrets slut, och passagen bokfördes 3 min före hennes korsning; KANDIDAT', () => {
    // Med familj B:s skiss för färskheten (lastSeenAt mot firstPassageAt)
    // släpper bakkanten henne vid bokföringen 11:36:18, och fyndet försvinner.
    const { fynd, ctx } = fall('w1160');
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl).toMatch(/appens prognos 11:40:57 vid hennes fix 11:35:15 .* efter fönstrets slut 11:39:31, men bakkanten släppte henne inte/);
  });

  test('[träff] värld 1038: passagen bokfördes 12 s efter hennes korsning, så ingen bakkant kunde släppa henne i tid; U17', () => {
    // Prognoserna efter ledarens skattade passage 12:08:19 låg efter fönstrets
    // slut, men bokföringen 12:15:55 kom efter korsningen 12:15:43.
    const { fynd, ctx } = fall('w1038');
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' });
    const a = fall('w1038');
    for (const v of a.ctx.resultat.openingCoverageVerdicts) if (v.event && v.event.firstPassageRegisteredAt) v.event.firstPassageRegisteredAt -= 60000;
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] bakkanten släppte henne (domen bakkant), eller varningen följer inte på täckningsslutet; KANDIDAT', () => {
    const a = fall('w625');
    const slut = a.ctx.resultat.openingCoverageVerdicts.find((x) => x.mmsi === a.fynd.mmsi && x.verdict.kind === 'täckningsslut');
    slut.verdict = { kind: 'bakkant', reason: 'färsk prognos ‹tid› ligger efter fönstrets slut ‹tid›' };
    expect(pred('tystRecoverSammaÖppning')(a.fynd, a.ctx).skäl).toMatch(/bakkanten släppte henne ur Stridsbergsbron#4/);
    const b = fall('w625');
    const slutB = b.ctx.resultat.openingCoverageVerdicts.find((x) => x.mmsi === b.fynd.mmsi && x.verdict.kind === 'täckningsslut');
    slutB.t -= 60000;
    expect(pred('tystRecoverSammaÖppning')(b.fynd, b.ctx).skäl).toMatch(/följer inte inom en tick på ett släpp vid täckningsslutet/);
    expect(klassa(reg, b.fynd, b.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] fysiken ur hennes egen rad: sista fixet i 1 kn 202 m från bron ligger efter fönstrets slut; KANDIDAT', () => {
    const { fynd, ctx } = fall('w625');
    const sista = ctx.rader.filter((r) => r.mmsi === fynd.mmsi && r.aisTimestamp < fynd.t).pop();
    sista.sog = 1;
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/den fysiska ankomsten .* \(202 m, 1 kn\) låg efter fönstrets slut 09:28:01/);
  });

  test('[vakt] under-bron-hållet prövas som förut med domspåret: sista raden 30 m från bron i 6 kn; KANDIDAT', () => {
    const { fynd, ctx } = fall('w625');
    const X = require('../lib/platser').POINTS.Stridsbergsbron;
    const sista = ctx.rader.filter((r) => r.mmsi === fynd.mmsi && r.aisTimestamp < fynd.t).pop();
    Object.assign(sista, { lat: X.lat + 30 / 111320, lon: X.lon, sog: 6 });
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/30 m från bron i 6 kn: under bron/);
  });

  test('[vakt] nya fält i domen (som familj B:s fysikankomst och färskhet) följer med utan att ändra domen; en okänd form ger nej', () => {
    const a = fall('w625');
    for (const v of a.ctx.resultat.openingCoverageVerdicts) v.verdict = { ...v.verdict, physicsArrivalMs: v.t, freshAfter: 'firstPassageAt' };
    expect(klassa(reg, a.fynd, a.ctx)).toMatchObject({ klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' });
    const b = fall('w625');
    delete b.ctx.resultat.openingCoverageVerdicts.find((x) => x.mmsi === b.fynd.mmsi).arm.expectedArrivalMs;
    expect(pred('tystRecoverSammaÖppning')(b.fynd, b.ctx).skäl).toMatch(/domspåret har en post .* utan arm.expectedArrivalMs/);
  });

  test('[nytt] domspårets eventId namnrymdas efter en omstart, som openingCoverage', () => {
    const r = { openingCoverageVerdicts: [{ t: 2000, eventId: 'Klaffbron#1' }, { t: 4000, eventId: 'Klaffbron#1' }] };
    const ut = namespaceEventIds(r, [{ ctrl: 'restart', aisTimestamp: 3000 }]);
    expect(ut.openingCoverageVerdicts.map((x) => x.eventId)).toEqual(['i0:Klaffbron#1', 'i1:Klaffbron#1']);
  });
});

// ---------------------------------------------------------------------------
// Punkt 6 (M10): T2-vyn av en K-NÄSTA-händelse i stället för en egen
// mätgränspost (MÄTGRÄNS-U2-FÖNSTERKANT behövs inte)
// ---------------------------------------------------------------------------

describe('Punkt 6: K-TYST-BÅT-NÄSTA-ÖPPNING gäller också T2 ÖPPNING-MISS:OKLASSAD', () => {
  // Värld 510: JOLLY korsade 604 s efter VEGAs första korsning och varnades
  // av sin RECOVER 4 s efter korsningen. T3 ser händelsen som VARNING-EFTER
  // (K-NÄSTA sedan punkt 4) och T2 som ÖPPNING-MISS:OKLASSAD. För en båt i
  // samma öppning tar U2-VS-DEADLINE T2-vyn; för nästa öppning saknades den.
  test('[träff] värld 510:s T2-tvilling blir K-NÄSTA med RECOVERn efter korsningen som varning', () => {
    const { fynd, ctx } = fall('w510t2');
    expect(fynd.belägg.varning).toBeUndefined();
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'K-TYST-BÅT-NÄSTA-ÖPPNING' });
    expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(fynd, ctx).skäl).toMatch(/604 s efter .* egen varning Stridsbergsbron#4 16:08:23 på tick, mer än 600 s/);
  });

  test('[vakt] ingen egen varning efter korsningen (977, 1476, 1794): KANDIDAT', () => {
    for (const k of ['w977', 'w1476', 'w1794']) {
      const { fynd, ctx } = fall(k);
      expect([k, klassa(reg, fynd, ctx).klass]).toEqual([k, 'KANDIDAT']);
      expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(fynd, ctx).skäl).toMatch(/ingen levererad varning för båten/);
    }
  });

  test('[vakt] värld 1094 (triage A:s M4): fixet efter ledarens skattade passage hade prognosen efter fönstrets slut; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1094');
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(fynd, ctx).skäl)
      .toMatch(/appens prognos 11:49:15 vid hennes fix 11:39:27 .* efter fönstrets slut 11:48:47, men bakkanten släppte henne inte/);
  });

  test('[vakt] en varning efter korsningen som inte är en RECOVER på tick, eller kom mer än 600 s efter, förklarar inte T2-vyn', () => {
    const a = fall('w510t2');
    a.ctx.resultat.openingWarnings.find((w) => w.eventId === 'Stridsbergsbron#4').firedBy = 'fix';
    expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(a.fynd, a.ctx).skäl).toMatch(/avfyrades av fix/);
    const b = fall('w510t2');
    b.ctx.resultat.openingWarnings.find((w) => w.eventId === 'Stridsbergsbron#4').t += 10 * 60000;
    expect(klassa(reg, b.fynd, b.ctx).klass).toBe('KANDIDAT');
  });
});

// ---------------------------------------------------------------------------
// Samspelet med familjerna B och F (samordnarens meddelande i varv 2)
// ---------------------------------------------------------------------------

describe('Familj F: Kajens queueGraceMs = Infinity (U23) läses som i appen', () => {
  // F:s apprättning gör Kajens köundantag obegränsat (Infinity). Appen läser
  // det som ett positivt tal (VesselDataService.js#_zoneMinStillMs efter F);
  // predikatet läste Number.isFinite och gjorde Infinity till baskravet 3 min.
  const C = require('../../../../lib/constants');
  const kajen = () => C.MOORING_ZONES.find((z) => /^Kajen\b/.test(z.name));
  const medKaj = (grace, fn) => {
    const z = kajen();
    const förut = z.queueGraceMs;
    z.queueGraceMs = grace;
    try {
      return fn();
    } finally {
      z.queueGraceMs = förut;
    }
  };

  test('[vakt] kajK efter F: zonlagret klassar aldrig köaren mot Klaffbron, så predikatet hittar ingen demotion; KANDIDAT', () => {
    const k = fall('kajK');
    const d = medKaj(Infinity, () => pred('mooringCapsuleStationary')(k.fynd, k.ctx));
    expect(d.sant).toBe(false);
    expect(d.skäl).toMatch(/under kravet i "Kajen norr om Klaffbron" \(aldrig: obegränsat köundantag, U23\)/);
    expect(medKaj(Infinity, () => klassa(reg, k.fynd, k.ctx).klass)).toBe('KANDIDAT');
  });

  test('[träff] kajB efter F: köundantaget gäller inte 979 m från Stridsbergsbron, och demotionen efter 3 min står; U23', () => {
    const k = fall('kajB');
    expect(medKaj(Infinity, () => klassa(reg, k.fynd, k.ctx))).toMatchObject({ klass: 'DESIGN', post: 'U23-KAJZON-UTANFÖR-VÄNTZONEN' });
  });

  test('[nytt] shrink läser Kajens köundantag ur zonposten: 900 s på c14938f, inget gränsvärde när det är obegränsat', () => {
    const shrink = require('../lib/shrink');
    // Före familj F: 900 s; efter F (Infinity) saknas posten.
    const kaj = shrink.KONSTANTER.find((k) => k.namn === 'queueGraceMs (Kajen)');
    if (Number.isFinite(kajen().queueGraceMs)) expect(kaj.värde).toBe(kajen().queueGraceMs / 1000);
    else expect(kaj).toBeUndefined();
    expect(shrink.kajensKöundantagS([{ name: 'Kajen norr om Klaffbron', queueGraceMs: Infinity }])).toBeNull();
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      require('../../../../lib/constants').MOORING_ZONES.find((z) => /^Kajen\b/.test(z.name)).queueGraceMs = Infinity;
      // eslint-disable-next-line global-require
      const s = require('../lib/shrink');
      expect(s.KONSTANTER.some((k) => k.namn === 'queueGraceMs (Kajen)')).toBe(false);
      expect(s.annotateConstant({ värden: [900], enhet: 's', familj: 'F-KÖ' })).toBeNull();
    });
  });
});

describe('Familj B: (3′) läser domens arrivalMs och windowEndMs, och U24-släppet är en bakkant', () => {
  // Steg 2 (M5) låter bakkanten jämföra domens arrivalMs, under ETA-golvet
  // den senare av prognosen och armens fysik, med windowEndMs. Predikatet
  // läste armens expectedArrivalMs och sitt eget fönsterslut, och missade
  // då en krypare som bakkanten borde ha släppt.
  const renDom = (ctx, m) => ctx.resultat.openingCoverageVerdicts.filter((x) => x.mmsi === m && x.verdict.kind === 'covered').pop();

  test('[vakt] domens arrivalMs låg efter fönstrets slut fast armens prognos låg inom: bakkanten borde ha släppt henne; KANDIDAT', () => {
    const { fynd, ctx } = fall('w625');
    const v = renDom(ctx, fynd.mmsi);
    v.verdict = { ...v.verdict, arrivalMs: Date.parse('2026-09-01T09:28:30Z'), physicsArrivalMs: Date.parse('2026-09-01T09:28:30Z') };
    const c = klassa(reg, fynd, ctx);
    expect(c.klass).toBe('KANDIDAT');
    expect(prövad(c, 'U17-TYST-BÅT-RECOVER').skäl)
      .toMatch(/appens ankomst \(domens arrivalMs\) 09:28:30 vid hennes fix 09:24:59 .* låg efter fönstrets slut 09:28:01, men bakkanten släppte henne inte/);
  });

  test('[vakt] domens windowEndMs gäller före det räknade fönstret; KANDIDAT', () => {
    const { fynd, ctx } = fall('w625');
    const v = renDom(ctx, fynd.mmsi);
    v.verdict = { ...v.verdict, windowEndMs: v.arm.expectedArrivalMs - 1000 };
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/appens prognos .* låg efter fönstrets slut .*, men bakkanten släppte henne inte/);
  });

  test('[träff] domens fält inom fönstret ändrar inget: arrivalMs lika med prognosen; U17', () => {
    const { fynd, ctx } = fall('w625');
    for (const v of ctx.resultat.openingCoverageVerdicts) {
      if (v.mmsi === fynd.mmsi && v.verdict.kind === 'covered') v.verdict = { ...v.verdict, arrivalMs: v.arm.expectedArrivalMs, physicsArrivalMs: null };
    }
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' });
  });

  test('[vakt] U24:s släpp på hennes egen deadline före första passagen räknas som bakkant; KANDIDAT', () => {
    const a = fall('w625');
    const slut = a.ctx.resultat.openingCoverageVerdicts.find((x) => x.mmsi === a.fynd.mmsi && x.verdict.kind === 'täckningsslut');
    slut.verdict = { kind: 'bakkant', reason: 'egen deadline ‹tid› förföll före händelsens första passage; prognos ‹tid› och fysik ‹tid› ligger efter fönstrets slut ‹tid›' };
    slut.event = { ...slut.event, firstPassageAt: null, firstPassageRegisteredAt: null };
    expect(pred('tystRecoverSammaÖppning')(a.fynd, a.ctx).skäl).toMatch(/U24 släppte henne ur Stridsbergsbron#4 .* på hennes egen deadline före händelsens första passage/);
    expect(pred('tystRecoverSammaÖppning', { läge: 'nästa' })(a.fynd, a.ctx).skäl).toMatch(/U24 släppte henne/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');
  });
});

describe('U24: den delade kön i provvärld 143 (U24-DELAD-KÖ-EXTRA-VARNING)', () => {
  // Fixturen fixtures/varv2-u24-2026-11-09.json är värld 143 (R1) körd på
  // familj B:s 0b0a35d (U24, M7) med den här motorn. RUNA (265101154)
  // släpps ur ALVAs Stridsbergsbron#1 på sin egen deadline 11:14:52 och
  // varnas själv (#3). CORDELIA (265101116) köar 104 m från bron, går vid
  // #1:s täckningsslut 11:25:13 till #3 och varnas vid dess täckningsslut
  // 11:36:10 (#8) på sitt fix från 11:15:10; hon korsar 353 s efter RUNA.
  const U = require('./fixtures/varv2-u24-2026-11-09.json');
  const u24 = () => kopia(U.w143);
  const RUNA = '265101154';
  const CORDELIA = '265101116';
  const X = require('../lib/platser').POINTS.Stridsbergsbron;
  const flytta = (r, m) => Object.assign(r, { lat: X.lat + m / 111320, lon: X.lon });
  const skäl = (f, ctx, extra) => pred('u24DeladKö', extra)(f, ctx).skäl;

  test('[träff] CORDELIAs varning vid RUNAs täckningsslut på ett 21 min gammalt fix; DESIGN U24', () => {
    const { fynd, ctx } = u24();
    expect(fynd).toMatchObject({ orakel: 'T3', klass: 'VARNING-PÅ-FRUSET-FIX', mmsi: CORDELIA });
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U24-DELAD-KÖ-EXTRA-VARNING' });
    expect(skäl(fynd, ctx)).toMatch(/^U24: 265101154 släpptes ur Stridsbergsbron#1 på sin egen deadline 11:14:52 \(1752 m från bron i 4.3 kn\) och varnades i Stridsbergsbron#3; /);
    expect(skäl(fynd, ctx)).toMatch(/till Stridsbergsbron#3 och varnades vid dess täckningsslut \(Stridsbergsbron#8 11:36:10\) på fixet 11:15:10; hon korsade 353 s efter/);
    expect(PREDICATES.u24DeladKö.parametrar.frusetMs).toBe(require('../lib/oracles/t2Opening').FROZEN_FIX_MS);
  });

  test('[vakt] utan U24-släppet (c14938f, eller bakkanten bortkopplad) och utan domspår; KANDIDAT', () => {
    const a = u24();
    for (const v of a.ctx.resultat.openingCoverageVerdicts) if (v.mmsi === RUNA && v.verdict.kind === 'bakkant') v.verdict = { kind: 'covered' };
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');
    expect(skäl(a.fynd, a.ctx)).toMatch(/265101154 släpptes inte av bakkanten inom en tick före sin varning Stridsbergsbron#3/);
    const b = u24();
    delete b.ctx.resultat.openingCoverageVerdicts;
    expect(skäl(b.fynd, b.ctx)).toMatch(/saknar släppvägens domspår/);
  });

  test('[vakt] släppet är bakkanten efter en passage, inte U24; eller händelsens passage var känd vid täckningsslutet; KANDIDAT', () => {
    const a = u24();
    const s = a.ctx.resultat.openingCoverageVerdicts.find((v) => v.mmsi === RUNA && v.verdict.kind === 'bakkant');
    s.verdict = { ...s.verdict, reason: 'färsk prognos ‹tid› ligger efter fönstrets slut ‹tid›' };
    expect(skäl(a.fynd, a.ctx)).toMatch(/är inget U24-släpp/);
    const b = u24();
    const slut = b.ctx.resultat.openingCoverageVerdicts.filter((v) => v.mmsi === CORDELIA && v.verdict.kind === 'täckningsslut').pop();
    slut.event = { ...slut.event, firstPassageAt: slut.t - 60000 };
    expect(skäl(b.fynd, b.ctx)).toMatch(/Stridsbergsbron#3:s första passage var känd vid täckningsslutet/);
    expect(klassa(reg, b.fynd, b.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] RUNA låg i väntzonen när hon släpptes: U24:s villkor höll inte; KANDIDAT', () => {
    const a = u24();
    const s = a.ctx.resultat.openingCoverageVerdicts.find((v) => v.mmsi === RUNA && v.verdict.kind === 'bakkant');
    flytta(a.ctx.rader.filter((r) => r.mmsi === RUNA && r.aisTimestamp <= s.t).pop(), 300);
    expect(skäl(a.fynd, a.ctx)).toMatch(/U24:s villkor höll inte för 265101154 vid släppet 11:14:52: raden 11:12:12 300 m från bron/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] CORDELIA utanför väntzonen efter absorptionen, eller i rörelse vid sitt sista fix: U24 kan ha gällt henne; KANDIDAT', () => {
    const a = u24();
    flytta(a.ctx.rader.find((r) => r.mmsi === CORDELIA && r.aisTimestamp === Date.parse('2026-07-28T11:14:17.668Z')), 400);
    expect(skäl(a.fynd, a.ctx)).toMatch(/hennes rad 11:14:17 låg 400 m från bron, utanför väntzonen \(350 m\)/);
    const b = u24();
    b.ctx.rader.filter((r) => r.mmsi === CORDELIA && r.aisTimestamp < b.fynd.t).pop().sog = 1.2;
    expect(skäl(b.fynd, b.ctx)).toMatch(/hennes sista rad före varningen 11:15:10 hade 1.2 kn: hon låg inte stilla i kön/);
    expect(klassa(reg, b.fynd, b.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] hon korsade mer än 600 s efter RUNA, eller fixet var redan fruset vid den äldre händelsens täckningsslut; KANDIDAT', () => {
    const a = u24();
    a.ctx.sanning.crossings.find((x) => x.mmsi === CORDELIA && x.bridge === 'Stridsbergsbron').t += 300000;
    expect(skäl(a.fynd, a.ctx)).toMatch(/hon korsade 11:51:32, 653 s efter 265101154 \(11:40:39\): inte inom 600 s efter hennes korsning/);
    const b = u24();
    expect(skäl(b.fynd, b.ctx, { frusetMs: 9 * 60000 })).toMatch(/hennes fix 11:15:10 var redan vid Stridsbergsbron#1:s täckningsslut 11:25:13 äldre än 9 min/);
    const c = u24();
    c.ctx.sanning.crossings.find((x) => x.mmsi === RUNA && x.bridge === 'Stridsbergsbron').t += 400000;
    expect(skäl(c.fynd, c.ctx)).toMatch(/hon korsade 11:46:32, -47 s efter 265101154/);
  });

  test('[träff] en hörd köare (familj B:s granskning, anmärkning 4): en rad i kön efter #1:s täckningsslut; DESIGN U24', () => {
    const { fynd, ctx } = u24();
    const mall = ctx.rader.filter((r) => r.mmsi === CORDELIA && r.aisTimestamp < fynd.t).pop();
    ctx.rader.push({ ...mall, aisTimestamp: Date.parse('2026-07-28T11:26:00Z'), fixTs: Date.parse('2026-07-28T11:26:00Z') });
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U24-DELAD-KÖ-EXTRA-VARNING' });
    expect(skäl(fynd, ctx)).toMatch(/varnades vid dess täckningsslut \(Stridsbergsbron#8 11:36:10\) på fixet 11:26:00/);
  });

  // A3e (omgranskningen av B): CORDELIA lämnar #1 genom ett eget U24-släpp
  // 11:20:00 i stället för vid täckningsslutet, absorberas i RUNAs #3, köar
  // där (hörd 11:26:00) och varnas vid #3:s täckningsslut.
  const egetSläpp = (medGiltigRad) => {
    const a = u24();
    const t = Date.parse('2026-07-28T11:20:00Z');
    const v = a.ctx.resultat.openingCoverageVerdicts.find((x) => x.mmsi === CORDELIA && x.eventId === 'Stridsbergsbron#1' && x.verdict.kind === 'täckningsslut');
    const slutE0 = 1785237913759.676;
    Object.assign(v, { t });
    v.verdict = {
      kind: 'bakkant',
      reason: 'egen deadline ‹tid› förföll före händelsens första passage; prognos ‹tid› och fysik ‹tid› ligger efter fönstrets slut ‹tid›',
      arrivalMs: Date.parse('2026-07-28T11:26:00Z'),
      physicsArrivalMs: Date.parse('2026-07-28T11:31:39Z'),
      windowEndMs: slutE0,
      ownDeadlineMs: t - 60000,
    };
    Object.assign(v.arm, {
      distanceM: 1500, expectedArrivalMs: Date.parse('2026-07-28T11:26:00Z'), coverUntilMs: slutE0, lastFixClean: true, waitingAtBridge: null,
    });
    a.ctx.resultat.openingCoverage.find((c) => c.mmsi === CORDELIA && c.reason === 'absorbed' && c.eventId === 'Stridsbergsbron#3').t = t;
    const mall = a.ctx.rader.filter((r) => r.mmsi === CORDELIA && r.aisTimestamp < a.fynd.t).pop();
    if (medGiltigRad) {
      const r0 = Date.parse('2026-07-28T11:19:30Z');
      a.ctx.rader.push({
        ...flytta({ ...mall }, 1500), sog: 4, cog: 200, aisTimestamp: r0, fixTs: r0,
      });
    }
    const r1 = Date.parse('2026-07-28T11:26:00Z');
    a.ctx.rader.push({ ...mall, aisTimestamp: r1, fixTs: r1 });
    a.ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    return a;
  };

  test('[träff] A3e: hon lämnar #1 genom ett eget U24-släpp som höll U24:s villkor och köar i #3; DESIGN U24', () => {
    const { fynd, ctx } = egetSläpp(true);
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U24-DELAD-KÖ-EXTRA-VARNING' });
    expect(skäl(fynd, ctx)).toMatch(/gick genom ett eget U24-släpp 11:20:00 till Stridsbergsbron#3/);
  });

  test('[vakt] A3e: hennes eget U24-släpp bröt mot U24:s villkor (hon låg i kön); KANDIDAT', () => {
    const { fynd, ctx } = egetSläpp(false);
    expect(skäl(fynd, ctx)).toMatch(/hennes eget U24-släpp ur Stridsbergsbron#1: U24:s villkor höll inte för 265101116/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] RUNA hade redan korsat bron när U24 släppte henne (grinden bakom); KANDIDAT', () => {
    const { fynd, ctx } = u24();
    ctx.sanning.crossings.push({ mmsi: RUNA, bridge: 'Stridsbergsbron', t: Date.parse('2026-07-28T11:14:00Z') });
    expect(skäl(fynd, ctx)).toMatch(/bröt mot en grind: bron låg redan bakom henne vid släppet \(bakom\)/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] U24-släppet bröt mot en av appens grindar (familj B:s förslag): KANDIDAT för varje grind', () => {
    const fall6 = [
      [(v) => Object.assign(v.verdict, { ownDeadlineMs: v.t + 1000 }), /före hennes egen deadline/],
      [(v) => Object.assign(v.arm, { coverUntilMs: v.verdict.arrivalMs - 181000 }), /täckningsslutet .* hade gett henne ledtiden/],
      [(v) => Object.assign(v.arm, { expectedArrivalMs: v.t + 30000 }), /under två tick kvar till ankomsten .* \(golvet\)/],
      [(v) => Object.assign(v, { courseAway: true }), /kursen ledde bort från bron/],
      [(v) => Object.assign(v.arm, { lastFixClean: false }), /fixet var orent eller armen fryst/],
      [(v) => Object.assign(v.arm, { distanceM: 300 }), /armens avstånd 300 m, inom väntzonen \(350 m\)/],
      [(v) => Object.assign(v.verdict, { physicsArrivalMs: v.arm.expectedArrivalMs }), /bara en prognos: appens ETA saknades, .*\(en-prognos\)/],
      [(v) => Object.assign(v.arm, { waitingAtBridge: 'Stridsbergsbron' }), /armen hade appens köflagga \(waitingAtBridge Stridsbergsbron\)/],
    ];
    for (const [ändra, re] of fall6) {
      const a = u24();
      ändra(a.ctx.resultat.openingCoverageVerdicts.find((v) => v.mmsi === RUNA && v.verdict.kind === 'bakkant'));
      expect(skäl(a.fynd, a.ctx)).toMatch(re);
      expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');
    }
  });
});

describe('Villkor (3a) med domspår: raden mäts mot fönstrets slut i appens dom (värld 1837)', () => {
  // Fixturen fixtures/varv2-m9-1837-2026-11-09.json är värld 1837 med M9:s
  // radio (2f65c07). 265594787 absorberades i Stridsbergsbron#4, och hennes
  // rad 12:52:32,176 (fixen 12:52:14, 85 m före bron i 5,4 kn) bearbetades
  // efter bokföringen 12:51:26. Appens dom vid raden: 'covered', prognosen
  // 12:52:43,893 inom täckningsslutet 12:52:46,115. Hon korsade 12:52:43,927
  // osedd och varnades av sin RECOVER 12:52:46,116. Fönstrets skattade
  // tidigaste slut, W − tickMs = 12:52:16, låg före raden, så villkoret (3a)
  // gjorde henne till KANDIDAT fast hennes position sa att hon skulle hinna.
  const M = require('./fixtures/varv2-m9-1837-2026-11-09.json');
  const w1837 = () => kopia(M.w1837);

  test('[träff] raden kom efter den skattade gränsen men före fönstrets slut i domen; U17', () => {
    const { fynd, ctx } = w1837();
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' });
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/^U17: tyst sedan 12:52:32 \(85 m\), .* korsade 12:52:43, 320 s efter/);
  });

  test('[vakt] utan domspåret gäller den skattade gränsen som förut; KANDIDAT', () => {
    const { fynd, ctx } = w1837();
    delete ctx.resultat.openingCoverageVerdicts;
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/rad 12:52:32 kom efter .* och efter fönstrets tidigaste slut 12:52:16: bakkanten kunde släppa henne/);
  });

  test('[vakt] raden bearbetades efter fönstrets slut i sin egen dom; KANDIDAT', () => {
    const { fynd, ctx } = w1837();
    const v = ctx.resultat.openingCoverageVerdicts.find((x) => x.mmsi === fynd.mmsi && x.t >= Date.parse('2026-06-02T12:52:32.176Z'));
    Object.assign(v.arm, { lastFixClean: false, coverUntilMs: v.t - 1000 });
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/rad 12:52:32 kom efter .* och efter fönstrets slut 12:52:31 \(domen 12:52:32\): bakkanten kunde släppa henne/);
  });
});

describe('H1 (granskningen av varv 2): villkor (3′) är oberoende av appens flaggor och fönsterslut', () => {
  // En bakkant som slås ut genom att appen markerar fixen som orena, eller
  // genom att appens fönsterslut blir för sent, ska synas som KANDIDAT, som
  // med c14938f:s kvotregel. Mutationerna "aldrig rent fix" och "fönsterslut
  // = täckningsslut" i quick: BUGGJAKT §7 rad 50 och bilaga A.7.
  const medSistaRad = (k, sog) => {
    const a = fall(k);
    a.ctx.rader.filter((r) => r.mmsi === a.fynd.mmsi && r.aisTimestamp < a.fynd.t).pop().sog = sog;
    return a;
  };

  test('[vakt] aldrig rent fix: appen markerar hennes fix som orena och fysiken i 1 kn ligger efter fönstret; KANDIDAT', () => {
    for (const k of ['w625', 'w1973', 'w1337']) {
      const { fynd, ctx } = medSistaRad(k, 1);
      for (const v of ctx.resultat.openingCoverageVerdicts) if (v.mmsi === fynd.mmsi) v.arm.lastFixClean = false;
      expect([k, klassa(reg, fynd, ctx).klass]).toEqual([k, 'KANDIDAT']);
      expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/den fysiska ankomsten .* låg efter fönstrets slut/);
    }
  });

  test('[vakt] en fryst arm i domspåret undantar inte raden från fysikprovet; KANDIDAT', () => {
    const { fynd, ctx } = medSistaRad('w625', 1);
    for (const v of ctx.resultat.openingCoverageVerdicts) if (v.mmsi === fynd.mmsi && v.event && Number.isFinite(v.event.firstPassageAt)) v.frozen = true;
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/den fysiska ankomsten .* \(202 m, 1 kn\) låg efter fönstrets slut 09:28:01/);
  });

  test('[vakt] fönsterslut = täckningsslut: domens windowEndMs ligger senare än motorns räknade slut, och det tidigare gäller; KANDIDAT', () => {
    const { fynd, ctx } = medSistaRad('w625', 2.0);
    for (const v of ctx.resultat.openingCoverageVerdicts) {
      if (v.mmsi === fynd.mmsi && v.verdict.kind === 'covered' && v.event && Number.isFinite(v.event.firstPassageAt)) v.verdict.windowEndMs = v.arm.coverUntilMs;
    }
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(pred('tystRecoverSammaÖppning')(fynd, ctx).skäl).toMatch(/låg efter fönstrets slut 09:28:01/);
  });

  test('[träff] utan ändringar är de nio U17- och K-NÄSTA-fallen och 1837 oförändrade', () => {
    for (const k of ['w1973', 'w537', 'w625', 'w1337', 'w1629', 'w1752', 'w479']) {
      const { fynd, ctx } = fall(k);
      expect([k, klassa(reg, fynd, ctx).post]).toEqual([k, 'U17-TYST-BÅT-RECOVER']);
    }
    const m = kopia(require('./fixtures/varv2-m9-1837-2026-11-09.json').w1837);
    expect(klassa(reg, m.fynd, m.ctx).post).toBe('U17-TYST-BÅT-RECOVER');
  });
});

describe('L3 (granskningen av varv 2): harnessens bokföring av domspåret är undantagssäker', () => {
  // instrumentCoverageVerdicts ligger i replayRunner.js, som kör sin main när
  // filen laddas; funktionen prövas därför fristående ur källtexten.
  const fs = require('fs');
  const path = require('path');
  const källa = fs.readFileSync(path.join(__dirname, '../../replayRunner.js'), 'utf8');
  const början = källa.indexOf('function instrumentCoverageVerdicts(');
  const slut = källa.indexOf('\nasync function main()', början);
  // eslint-disable-next-line no-new-func
  const instrument = new Function(`${källa.slice(början, slut)}\nreturn instrumentCoverageVerdicts;`)();
  const arm = {
    mmsi: 1, bridge: 'Klaffbron', eventId: 'Klaffbron#1', lastSeenAt: 1, waitingAtBridge: 'Klaffbron',
  };

  test('[nytt] en dom som inte går att kopiera ger en felpost, och appen får sin dom', () => {
    const cyklisk = { kind: 'covered' };
    cyklisk.själv = cyklisk;
    const ops = { _coverageVerdict: () => cyklisk };
    const spår = [];
    instrument(ops, spår);
    expect(ops._coverageVerdict(arm, null, 5)).toBe(cyklisk);
    expect(spår).toHaveLength(1);
    expect(spår[0]).toMatchObject({ t: 5, mmsi: '1', bridge: 'Klaffbron' });
    expect(typeof spår[0].fel).toBe('string');
  });

  test('[nytt] en vanlig dom bokförs med köflaggan', () => {
    const ops = { _coverageVerdict: () => ({ kind: 'covered' }) };
    const spår = [];
    instrument(ops, spår);
    expect(ops._coverageVerdict(arm, null, 7)).toEqual({ kind: 'covered' });
    expect(spår[0]).toMatchObject({ t: 7, verdict: { kind: 'covered' }, arm: { waitingAtBridge: 'Klaffbron' } });
  });
});
