'use strict';

/**
 * Registret 2026-11-07 (BUGGJAKT §7, rad 23–31): posterna för
 * användarbesluten U17, U18 och U19, dirigentens beslut om R2:s fråga 2 och
 * de kända luckorna för K, M och R1, och borttagningen av U2-RETURRESA.
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

const MIN = 60000;
const kopia = (x) => JSON.parse(JSON.stringify(x));
const fall = (k) => kopia(F[k]);
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
});

// ---------------------------------------------------------------------------
// U17 och K-familjens kvarvarande gräns: den tysta båtens RECOVER-varning
// ---------------------------------------------------------------------------

describe('U17 U17-TYST-BÅT-RECOVER och K-TYST-BÅT-NÄSTA-ÖPPNING', () => {
  test('[träff] värld 41 (VARNING-EFTER-SANN-PASSAGE, 584 s efter E:s första korsning) och 1453 (FRUSET-FIX, hon själv först)', () => {
    for (const k of ['w41', 'w1453']) {
      const { fynd, ctx } = fall(k);
      expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'DESIGN', post: 'U17-TYST-BÅT-RECOVER' });
    }
  });

  test('[träff] nästa öppning: värld 87 (T3, 610 s) och 790 (T2 LEDTID, 707 s) blir KÄND_ÖPPEN', () => {
    for (const k of ['w87', 'w790']) {
      const { fynd, ctx } = fall(k);
      expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'K-TYST-BÅT-NÄSTA-ÖPPNING' });
    }
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
    expect(p(b.fynd, b.ctx).skäl).toMatch(/ingen båt passerar ett steg/);
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

describe('M:s kända gränser M-BRUSBAND-RÖRELSEBEVIS', () => {
  test('[träff] median-sog 0,3 kn (ANCHOR_BLOCK-tröskeln) hos båten som bär texten före och efter episoden', () => {
    const { fynd, ctx } = flapp({ sog: 0.3 });
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'M-BRUSBAND-RÖRELSEBEVIS' });
  });

  test('[träff] nettonärmande 10 m per 60 s (MIN_APPROACH_DISTANCE) med farten 0,5 kn', () => {
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
    const ctx = { rader, resultat: { targetPassages: [], intermediatePassages: [] }, sanning: { uturns: [{ mmsi: '265196010', t: rader[iSyd].aisTimestamp - 1000 }], crossings: [] } };
    return {
      ctx, f: t10('265196010', 'Klaffbron', Math.round(tK), 'syd'), b,
    };
  };

  test('[träff] tät långsam återkorsning (segment under 100 m, korsningsfixet 1,5 kn): KÄND_ÖPPEN', () => {
    const { ctx, f } = tätLångsam();
    expect(klassa(reg, f, ctx)).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'U-SVÄNG-LÅNGSAM-ÅTERKORSNING' });
  });

  test('[träff] långsam vändning utan fix i 2 kn före korsningen (glesa fixturen)', () => {
    const rader = lästFixtur('r1-kand-lucka-gles-langsam-vandning.jsonl');
    const tK = Date.parse('2026-06-25T09:19:00Z');
    const ctx = { rader, resultat: {}, sanning: { uturns: [{ mmsi: '265196010', t: Date.parse('2026-06-25T09:15:00Z') }], crossings: [] } };
    expect(pred('returUtanRörelsebevis')(t10('265196010', 'Klaffbron', tK, 'syd'), ctx).sant).toBe(true);
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
