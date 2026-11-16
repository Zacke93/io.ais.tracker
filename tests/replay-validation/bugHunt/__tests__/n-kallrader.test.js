'use strict';

/**
 * Beslutsregistrets radhänvisningar (2026-11-15).
 *
 * Hänvisningarna i `källa` och `orakelvakt` hade glidit: dokumenten och koden
 * har vuxit, och `docs/ARCHITECTURE.md:1934–1951 (U17)` pekade till exempel på
 * ett stycke om förtöjning. Laddningen prövar redan att en `#symbol` definieras
 * i sin fil (lib/registry.js#checkRefs), men en radhänvisning prövades bara
 * på att filen fanns. Därför:
 *  - kod i app.js, lib/, drivers/ och harnessens invariants.js och
 *    replayRunner.js citeras med symbol (`fil.js#namn`), aldrig med rader: de
 *    filerna ändras med varje rättning;
 *  - varje radhänvisning (också fortsättningar som `och :15`) ska ligga inom
 *    filen och ha en post i nyckelordstabellen (`kallrader-forvantat.json`):
 *    postens nyckelord på det citerade styckets FÖRSTA rad, och eventuella fler
 *    nyckelord någonstans i stycket. Glider dokumentet bara en rad faller
 *    testet, och då rättas hänvisningen (eller nyckelordet, om stycket skrivits
 *    om); `tools/foreslaKallrader.js` föreslår de nya raderna;
 *  - varje post i tabellen används, så att tabellen inte ruttnar.
 * Motorns egna filer citeras med symbol (laddningen varnar annars).
 * Logiken ligger i `lib/kallrader.js` (2026-11-16) och delas med skriptet.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT, FÖRVÄNTAT_FIL, radhänvisningar, barahänvisningar, nyckel, brister, föreslå, kvittera, stycketsSumma,
} = require('../lib/kallrader');
const {
  bytIText, bytIRegistret, bytITabellrad, skrivFörslag,
} = require('../tools/foreslaKallrader');

const REG = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/replay-validation/bugHunt/beslutsregister.json'), 'utf8'));
const FÖRVÄNTAT = JSON.parse(fs.readFileSync(path.join(ROOT, FÖRVÄNTAT_FIL), 'utf8'));
const A = 'docs/ARCHITECTURE.md';
const RS = 'docs/reliability-spec.md';
const H11 = 'docs/helgranskning-2026-11-03.md';
// Postens (första) hänvisning till `fil` ur tabellen: "fil:rader".
const ref = (post, fil = A) => FÖRVÄNTAT.find((x) => x[0] === post && x[1].startsWith(`${fil}:`))[1];
const rader = (r) => r.slice(r.lastIndexOf(':') + 1);
const flytta = (r, d) => {
  const [a, b] = rader(r).split('–').map(Number);
  return `${r.slice(0, r.lastIndexOf(':') + 1)}${a + d}${Number.isFinite(b) ? `–${b + d}` : ''}`;
};

describe('beslutsregistrets radhänvisningar', () => {
  test('tolkningen hittar varje radhänvisning, också fortsättningarna', () => {
    // Samma hänvisning kan stå i flera fält i en post (källan och doktrinen).
    const unika = new Set(REG.poster.flatMap(radhänvisningar).map((r) => nyckel(r.post, r.fil, r.rader)));
    expect(unika.size).toBe(FÖRVÄNTAT.length);
  });

  test('varje radhänvisning ligger inom filen och pekar på ett stycke med postens nyckelord', () => {
    expect(brister(REG.poster, FÖRVÄNTAT)).toEqual([]);
  });

  test('alla fält läses, också regeln och doktrinerna', () => {
    const fält = new Set(REG.poster.flatMap(radhänvisningar).map((r) => r.fält.replace(/\[\d+\]/g, '[]')));
    expect([...fält].sort()).toEqual(['doktriner[].källa', 'källa']);
  });

  test('inget filnamn med rader utan sökväg', () => {
    expect(REG.poster.flatMap(barahänvisningar)).toEqual([]);
  });
});

describe('kontrollen fäller de fel den finns till för', () => {
  const ändrad = (id, från, till) => REG.poster.map((p) => (p.id === id ? { ...p, källa: p.källa.split(från).join(till) } : p));

  test('en hänvisning som glidit en rad', () => {
    const u17 = ref('U17-TYST-BÅT-RECOVER');
    const fel = brister(ändrad('U17-TYST-BÅT-RECOVER', u17, flytta(u17, 1)), FÖRVÄNTAT).join('\n');
    expect(fel).toContain(`U17-TYST-BÅT-RECOVER|${flytta(u17, 1)}: saknar nyckelord`);
    expect(fel).toContain(`U17-TYST-BÅT-RECOVER|${u17}: används inte längre`);
  });

  test('en tabellpost vars första rad inte bär nyckelordet', () => {
    const förskjuten = FÖRVÄNTAT.map((x) => (x[0] === 'U19-VARNING-UNDER-VÄNTANDE-VÄNDNING' ? [x[0], x[1], 'U18'] : x));
    expect(brister(REG.poster, förskjuten).join('\n')).toContain(`U19-VARNING-UNDER-VÄNTANDE-VÄNDNING|${ref('U19-VARNING-UNDER-VÄNTANDE-VÄNDNING')}: första raden saknar "U18"`);
  });

  test('ett nyckelord som saknas i stycket', () => {
    const utan = FÖRVÄNTAT.map((x) => (x[0] === 'FIXD-SLINGA' ? [x[0], x[1], x[2], ['finns inte i stycket']] : x));
    expect(brister(REG.poster, utan).join('\n')).toContain(`FIXD-SLINGA|${ref('FIXD-SLINGA')}: stycket saknar "finns inte i stycket"`);
  });

  test('en rad utanför filen, en fortsättning utanför filen och en fil som saknas', () => {
    expect(brister(ändrad('U19-VARNING-UNDER-VÄNTANDE-VÄNDNING', ref('U19-VARNING-UNDER-VÄNTANDE-VÄNDNING'), `${A}:99990–99999`), FÖRVÄNTAT).join('\n'))
      .toMatch(/docs\/ARCHITECTURE\.md:99990–99999: utanför filen/);
    expect(brister(ändrad('D4-RIKTNING-UNKNOWN', ' och :105 (', ' och :9999 ('), FÖRVÄNTAT).join('\n'))
      .toMatch(/D4-RIKTNING-UNKNOWN\|docs\/reliability-spec\.md:9999: utanför filen/);
    expect(brister(ändrad('BN1-BOXKANT', ref('BN1-BOXKANT', H11), 'docs/finns-inte.md:162–172'), FÖRVÄNTAT).join('\n'))
      .toMatch(/docs\/finns-inte\.md:162–172: filen finns inte/);
  });

  test('en glidning i regeltexten eller i en doktrin fälls (granskningen 2026-11-16, L3)', () => {
    const iRegel = REG.poster.map((p) => (p.id === 'D4-RIKTNING-UNKNOWN'
      ? { ...p, regel: `${p.regel} Se ${RS}:46.` } : p));
    expect(brister(iRegel, FÖRVÄNTAT).join('\n')).toMatch(/D4-RIKTNING-UNKNOWN\|docs\/reliability-spec\.md:46: saknar nyckelord/);
    const iDoktrin = REG.poster.map((p) => (p.id === 'OMSTART-RESETILLSTÅND'
      ? { ...p, doktriner: p.doktriner.map((d, i) => (i === 0 ? { ...d, källa: `${A}:1102` } : d)) } : p));
    expect(brister(iDoktrin, FÖRVÄNTAT).join('\n')).toMatch(/OMSTART-RESETILLSTÅND\|docs\/ARCHITECTURE\.md:1102: saknar nyckelord/);
    const appRegel = REG.poster.map((p) => (p.id === 'MÄTGRÄNS-INV10-VÄNTKEDJA'
      ? { ...p, regel: p.regel.replace('app.js#_initializeCoalescingSystem', 'app.js:13259–13266') } : p));
    expect(brister(appRegel, FÖRVÄNTAT).join('\n')).toMatch(/MÄTGRÄNS-INV10-VÄNTKEDJA\|app\.js:13259–13266: kod i app\.js/);
  });

  test('laddningen prövar symbolerna i regeln och doktrinerna som i källan', () => {
    const { loadRegistry } = require('../lib/registry');
    const med = (id, ändra) => loadRegistry({ ...REG, poster: REG.poster.map((p) => (p.id === id ? ändra(p) : p)) }, { root: ROOT });
    expect(med('U16-F40-STRAX-STUDS', (p) => p).varningar).toEqual([]);
    const iRegel = med('U16-F40-STRAX-STUDS', (p) => ({ ...p, regel: p.regel.replace('app.js#_publishUpdate', 'app.js#_finnsInte') }));
    expect(iRegel.varningar).toEqual(['U16-F40-STRAX-STUDS: regelns fil app.js definierar inte _finnsInte']);
    const iDoktrin = med('OMSTART-RESETILLSTÅND', (p) => ({
      ...p, doktriner: p.doktriner.map((d, i) => (i === 0 ? { ...d, källa: 'app.js#_finnsInte' } : d)),
    }));
    expect(iDoktrin.varningar).toEqual(['OMSTART-RESETILLSTÅND: doktrinens fil app.js definierar inte _finnsInte']);
  });

  test('ett bart filnamn med rader fälls, i vilket fält som helst', () => {
    const bar = REG.poster.map((p) => (p.id === 'U16-F40-STRAX-STUDS'
      ? { ...p, regel: p.regel.replace('tests/replay-validation/invariants.js#validateInvariants, fromSoftZone', 'invariants.js:334–351, fromSoftZone') } : p));
    expect(bar.flatMap(barahänvisningar)).toEqual([{ post: 'U16-F40-STRAX-STUDS', fält: 'regel', ref: 'invariants.js:' }]);
  });

  test('kod i app.js, lib/ eller harnessens invariants.js citerad med rader', () => {
    const fel = brister(ändrad('OMSTART-DEFAULT-FÖRE-FÖRSTA-FIX', 'app.js#onInit', 'app.js:487'), FÖRVÄNTAT);
    expect(fel.join('\n')).toMatch(/OMSTART-DEFAULT-FÖRE-FÖRSTA-FIX\|app\.js:487: kod i app\.js, lib\/, drivers\/ och harnessens invariants\.js och replayRunner\.js citeras med symbol/);
    const inv = brister(ändrad('MÄTGRÄNS-INV10-VÄNTKEDJA', 'invariants.js#STRAX_ZOMBIE_MS', 'invariants.js:550'), FÖRVÄNTAT);
    expect(inv.join('\n')).toMatch(/MÄTGRÄNS-INV10-VÄNTKEDJA\|tests\/replay-validation\/invariants\.js:550: kod i app\.js/);
  });
});

// Förslagsskriptet (tools/foreslaKallrader.js, 2026-11-16): efter en
// konstruerad glidning i ett dokument föreslår det rätt rad, och skrivarna
// byter bara den hänvisning som avses.
describe('förslag till nya rader efter en glidning', () => {
  const äkta = fs.readFileSync(path.join(ROOT, A), 'utf8').split('\n');
  // Filläsare där ARCHITECTURE.md ersatts av `rader`, övriga filer äkta.
  const med = (raderA) => {
    const cache = new Map();
    return (fil) => {
      if (fil === A) return raderA;
      if (!cache.has(fil)) cache.set(fil, fs.existsSync(path.join(ROOT, fil)) ? fs.readFileSync(path.join(ROOT, fil), 'utf8').split('\n') : null);
      return cache.get(fil);
    };
  };
  const förslagFör = (förslag, post) => förslag.find((x) => x.post === post && x.fil === A);

  test('utan glidning finns inga förslag', () => {
    expect(föreslå(REG.poster, FÖRVÄNTAT)).toEqual([]);
  });

  test('tre rader överst: varje hänvisning i ARCHITECTURE.md får sin gamla rad + 3', () => {
    const f = föreslå(REG.poster, FÖRVÄNTAT, { läs: med(['x', 'y', 'z', ...äkta]) });
    // Alla utom de vars nyckelord också står tre rader tidigare (U10:s
    // "P8/U10" står även tre rader ovanför stycket) faller och får ett förslag.
    expect(f.filter((x) => x.fil === A).length).toBeGreaterThan(20);
    expect(förslagFör(f, 'J13-J14-KONVOJSEMANTIK').ny).toBe(rader(flytta(ref('J13-J14-KONVOJSEMANTIK'), 3)));
    for (const x of f.filter((y) => y.fil === A)) expect([x.post, `${A}:${x.ny}`]).toEqual([x.post, flytta(`${A}:${x.gammal}`, 3)]);
  });

  test('ett nytt avsnitt mitt i: stycken före står kvar, stycken efter får + 50, också när nyckelordet står på flera ställen', () => {
    const u17 = ref('U17-TYST-BÅT-RECOVER');
    const vid = Number(rader(u17).split('–')[0]) - 300;
    const ny = [...äkta.slice(0, vid), ...Array(50).fill('nytt avsnitt'), ...äkta.slice(vid)];
    const f = föreslå(REG.poster, FÖRVÄNTAT, { läs: med(ny) });
    // U17 och K-NÄSTA citerar samma stycke; "U17" står på flera ställen.
    expect(`${A}:${förslagFör(f, 'U17-TYST-BÅT-RECOVER').ny}`).toBe(flytta(u17, 50));
    // "U17" står på flera ställen, men bara ett stycke har samma text (V1).
    expect(förslagFör(f, 'U17-TYST-BÅT-RECOVER').kandidater).toBe(1);
    expect(f.filter((x) => x.post === 'K-TYST-BÅT-NÄSTA-ÖPPNING' && x.gammal === rader(u17))[0].ny).toBe(rader(flytta(u17, 50)));
    // En hänvisning före avsnittet håller och får inget förslag.
    expect(förslagFör(f, 'U2-VS-DEADLINE')).toBeUndefined();
  });

  test('ett omskrivet stycke (nyckelorden borta) får inget förslag', () => {
    const borta = äkta.map((l) => l.split('säkerhetsvarningen för en tyst båt').join('omskrivet'));
    const f = föreslå(REG.poster, FÖRVÄNTAT, { läs: med(['x', ...borta]) });
    expect(förslagFör(f, 'U17-TYST-BÅT-RECOVER').ny).toBeNull();
  });

  test('skrivarna: fortsättningar i registret, förkortade namn och full form i BUGGJAKT', () => {
    expect(bytIText('docs/reliability-spec.md:45 och :105 (D4)', RS, '105', '107').text).toBe('docs/reliability-spec.md:45 och :107 (D4)');
    expect(bytIText(`${A}:105 och docs/VALIDATION.md:105`, RS, '105', '107').n).toBe(0);
    const rå = `${JSON.stringify({ poster: [{ id: 'P1', källa: `${A}:10–12` }, { id: 'P2', källa: `${A}:10–12` }] }, null, 2)}\n`;
    const r = bytIRegistret(rå, 'P2', A, '10–12', '13–15');
    expect(r.n).toBe(1);
    expect(r.rå).toBe(rå.replace(/(P2",\n {6}"källa": "docs\/ARCHITECTURE\.md:)10–12/, '$113–15'));
    const md = '| P1 | x | y | ARCHITECTURE:10–12 och :20–21; etapp7-plan:15 |\n| P2 | ARCHITECTURE:10–12 |\nText (`docs/ARCHITECTURE.md:10–12`) och :10–12.\n';
    const t1 = bytITabellrad(md, 'P1', A, '10–12', '13–15');
    expect(t1.md.split('\n')[0]).toBe('| P1 | x | y | ARCHITECTURE:13–15 och :20–21; etapp7-plan:15 |');
    expect(t1.md.split('\n')[1]).toBe('| P2 | ARCHITECTURE:10–12 |');
    expect(t1.md.split('\n')[2]).toBe('Text (`docs/ARCHITECTURE.md:13–15`) och :10–12.');
    expect(bytITabellrad(md, 'P1', A, '20–21', '22–23').md.split('\n')[0]).toContain('och :22–23');
    expect(bytITabellrad(md, 'P1', 'docs/etapp7-plan-2026-08-08.md', '15', '16').md.split('\n')[0]).toContain('etapp7-plan:16');
  });
});

// Texten bakom hänvisningen (2026-11-16, V1): vid tre sammanslagningar valde
// förslagsskriptet ett NYTT stycke med samma nyckelord (U17 och K-NÄSTA) och
// gav en fortsättning i S10 samma startrad som postens första hänvisning,
// medan både skriptet och testet var gröna. Nu bär tabellen styckets
// kontrollsumma: kontrollen fäller ett stycke som bytt innehåll, och
// förslaget väljer bara ett stycke med samma text (exakt en träff).
describe('kontrollsumman: förslaget väljer stycket på dess text', () => {
  const äkta = fs.readFileSync(path.join(ROOT, A), 'utf8').split('\n');
  const med = (raderA) => {
    const cache = new Map();
    return (fil) => {
      if (fil === A) return raderA;
      if (!cache.has(fil)) cache.set(fil, fs.existsSync(path.join(ROOT, fil)) ? fs.readFileSync(path.join(ROOT, fil), 'utf8').split('\n') : null);
      return cache.get(fil);
    };
  };
  const u17 = ref('U17-TYST-BÅT-RECOVER');
  const [u0, u1] = rader(u17).split('–').map(Number);
  const förslag = (f, post, gammal) => f.find((x) => x.post === post && x.fil === A && x.gammal === gammal);

  test('varje tabellrad bär en kontrollsumma som stämmer med dagens text', () => {
    expect(FÖRVÄNTAT.every((x) => typeof x[4] === 'string' && /^[0-9a-f]{16}$/.test(x[4]))).toBe(true);
    expect(stycketsSumma(äkta, u0, u1)).toBe(FÖRVÄNTAT.find((x) => x[0] === 'U17-TYST-BÅT-RECOVER' && x[1] === u17)[4]);
  });

  test('felet i U17 och K-NÄSTA: ett nytt stycke med samma nyckelord ovanför det gamla får inte förslaget', () => {
    // Det nya stycket nämner "(U17)", "säkerhetsvarningen för en tyst båt" och
    // "räknas däremot från bokföringen" på sin första rad, som vid
    // sammanslagningen, och är 65 rader långt.
    const nytt = ['- **Täckningsslutet (U17) räknas däremot från bokföringen: säkerhetsvarningen för en tyst båt, U13.**',
      ...Array(64).fill('  nytt stycke')];
    const vid = u0 - 40;
    const L = [...äkta.slice(0, vid), ...nytt, ...äkta.slice(vid)];
    const f = föreslå(REG.poster, FÖRVÄNTAT, { läs: med(L) });
    const x = förslag(f, 'U17-TYST-BÅT-RECOVER', rader(u17));
    expect(x.ny).toBe(`${u0 + 65}–${u1 + 65}`);
    expect(x.kandidater).toBe(1);
    expect(förslag(f, 'K-TYST-BÅT-NÄSTA-ÖPPNING', rader(u17)).ny).toBe(`${u0 + 65}–${u1 + 65}`);
    // Det nya stycket bär nyckelorden: den gamla regeln (första
    // nyckelordsträffen) hade godtagit det.
    expect(L[vid]).toContain('U17');
    // Kontrollen fäller samma läge utan rättning (det gamla spannet pekar nu
    // in i det nya stycket).
    const reg = REG.poster;
    expect(brister(reg, FÖRVÄNTAT, med(L)).join('\n')).toMatch(new RegExp(`U17-TYST-BÅT-RECOVER\\|${A.replace('.', '\\.')}:${u0}–${u1}`));
  });

  test('ett stycke som ändrats på plats fälls av kontrollen även när nyckelorden står kvar, och får inget förslag', () => {
    const L = [...äkta];
    L[u0] = `${L[u0]} (ändrad)`;
    const fel = brister(REG.poster, FÖRVÄNTAT, med(L)).join('\n');
    expect(fel).toMatch(/U17-TYST-BÅT-RECOVER\|docs\/ARCHITECTURE\.md:\d+–\d+: stycket har bytt innehåll mot förväntan/);
    const x = förslag(föreslå(REG.poster, FÖRVÄNTAT, { läs: med(L) }), 'U17-TYST-BÅT-RECOVER', rader(u17));
    expect(x).toMatchObject({ ny: null, skäl: expect.stringMatching(/ingen exakt träff/) });
  });

  test('två stycken med samma text: inget förslag, posten rättas för hand', () => {
    const kopia = äkta.slice(u0 - 1, u1);
    const L = ['x', ...äkta.slice(0, u0 - 300), ...kopia, ...äkta.slice(u0 - 300)];
    const x = förslag(föreslå(REG.poster, FÖRVÄNTAT, { läs: med(L) }), 'U17-TYST-BÅT-RECOVER', rader(u17));
    expect(x).toMatchObject({ ny: null, kandidater: 2, skäl: expect.stringMatching(/2 stycken har samma text/) });
  });

  test('felet i S10: fortsättningen prövas för sig och får sitt eget stycke', () => {
    const { källa } = REG.poster.find((p) => p.id === 'S10-VÄNDNING-BRON-BAKOM');
    const m = /ARCHITECTURE\.md:(\d+)–(\d+) \(S10 i notisvägen[^)]*\)|ARCHITECTURE\.md:(\d+)–(\d+) och :(\d+)–(\d+)/.exec(källa);
    const [a0, , b0, b1] = [m[3], m[4], m[5], m[6]].map(Number);
    expect(Number.isFinite(b0)).toBe(true);
    // Sju nya rader mellan den första hänvisningen och fortsättningen, och en
    // ny rad med "S10" och "pending-reversal" strax före den första.
    const L = [...äkta.slice(0, a0 - 2), 'S10: pending-reversal (nytt)', ...äkta.slice(a0 - 2, b0 - 3), ...Array(7).fill('ny'), ...äkta.slice(b0 - 3)];
    const f = föreslå(REG.poster, FÖRVÄNTAT, { läs: med(L) });
    const första = f.find((x) => x.post === 'S10-VÄNDNING-BRON-BAKOM' && x.gammal.startsWith(`${a0}–`));
    const forts = förslag(f, 'S10-VÄNDNING-BRON-BAKOM', `${b0}–${b1}`);
    expect(första.ny.split('–')[0]).toBe(String(a0 + 1));
    expect(forts.ny).toBe(`${b0 + 8}–${b1 + 8}`);
    expect(forts.ny.split('–')[0]).not.toBe(första.ny.split('–')[0]);
  });

  test('--ref: den betrodda versionens text används när tabellen saknar kontrollsumman', () => {
    const utan = FÖRVÄNTAT.map((x) => (x[0] === 'U17-TYST-BÅT-RECOVER' ? x.slice(0, 4) : x));
    const L = ['x', 'y', ...äkta];
    const gammalText = (fil, från, till) => (fil === A ? äkta.slice(från - 1, till) : null);
    const x = förslag(föreslå(REG.poster, utan, { läs: med(L), gammalText }), 'U17-TYST-BÅT-RECOVER', rader(u17));
    expect(x.ny).toBe(`${u0 + 2}–${u1 + 2}`);
    // Utan summa och utan betrodd version: inget förslag.
    expect(förslag(föreslå(REG.poster, utan, { läs: med(L) }), 'U17-TYST-BÅT-RECOVER', rader(u17)))
      .toMatchObject({ ny: null, skäl: expect.stringMatching(/saknar kontrollsumma/) });
    // Och kontrollen kräver summan.
    expect(brister(REG.poster, utan).join('\n')).toMatch(/U17-TYST-BÅT-RECOVER\|docs\/ARCHITECTURE\.md:\d+–\d+: saknar kontrollsumma/);
    // Kvitteringen ger raden dagens summa.
    const k = kvittera(REG.poster, utan, ['U17-TYST-BÅT-RECOVER']);
    expect(k.förväntat).toEqual(FÖRVÄNTAT);
  });
});

// Granskningen 2026-11-16 (medel): --skriv bytte ett förslag i taget, och
// sju rader överst i etapp7-plan gav U16 ":22 (U1), :22 (U6)" medan kontrollen
// var grön; --kvittera=alla kvitterade utan villkor; CRLF gjorde alla summor röda.
describe('granskningen: kedjade byten, dubbla nycklar, kvittering och CRLF', () => {
  const E7 = 'docs/etapp7-plan-2026-08-08.md';
  const äktaE7 = fs.readFileSync(path.join(ROOT, E7), 'utf8').split('\n');
  const medE7 = (raderE7) => {
    const cache = new Map();
    return (fil) => {
      if (fil === E7) return raderE7;
      if (!cache.has(fil)) cache.set(fil, fs.existsSync(path.join(ROOT, fil)) ? fs.readFileSync(path.join(ROOT, fil), 'utf8').split('\n') : null);
      return cache.get(fil);
    };
  };
  const rå = fs.readFileSync(path.join(ROOT, 'tests/replay-validation/bugHunt/beslutsregister.json'), 'utf8');
  const md = fs.readFileSync(path.join(ROOT, 'docs/BUGGJAKT.md'), 'utf8');

  test('sju rader överst i etapp7-plan: U16 får :15 (U1) och :22 (U6), inte :22 två gånger, och kontrollen är grön efteråt', () => {
    const L = [...Array(7).fill('ny rad'), ...äktaE7];
    const förslag = föreslå(REG.poster, FÖRVÄNTAT, { läs: medE7(L) });
    const ut = skrivFörslag(förslag, { rå, md, förväntat: FÖRVÄNTAT });
    const u16 = JSON.parse(ut.rå).poster.find((x) => x.id === 'U16-F40-STRAX-STUDS');
    expect(JSON.stringify(u16)).toContain(`${E7}:15 (U1), :22 (U6) och :274 (C11`);
    expect(brister(JSON.parse(ut.rå).poster, ut.förväntat, medE7(L))).toEqual([]);
  });

  test('kontrollen fäller samma hänvisning två gånger i ett fält och två tabellrader med samma nyckel', () => {
    const kedjad = REG.poster.map((x) => (x.id === 'U16-F40-STRAX-STUDS' ? { ...x, källa: x.källa.replace(`${E7}:8 (U1), :15 (U6)`, `${E7}:15 (U1), :15 (U6)`) } : x));
    expect(brister(kedjad, FÖRVÄNTAT).join('\n')).toMatch(/U16-F40-STRAX-STUDS\|docs\/etapp7-plan-2026-08-08\.md:15: samma hänvisning två gånger i fältet källa/);
    const dubbel = [...FÖRVÄNTAT, FÖRVÄNTAT[0]];
    expect(brister(REG.poster, dubbel).join('\n')).toMatch(/två rader i FÖRVÄNTAT med samma nyckel/);
  });

  test('två förslag i samma post som pekar på samma nya stycke skrivs inte', () => {
    const f = [{
      post: 'P', fil: A, gammal: '10–12', ny: '20–22',
    }, {
      post: 'P', fil: A, gammal: '30–32', ny: '20–22',
    }];
    const källa = `${A}:10–12 och :30–32`;
    const r = `${JSON.stringify({ poster: [{ id: 'P', källa }] }, null, 2)}\n`;
    const ut = skrivFörslag(f, { rå: r, md: '', förväntat: [] });
    expect(ut.vägrade).toHaveLength(2);
    expect(JSON.parse(ut.rå).poster[0].källa).toBe(källa);
  });

  test('kvittering kräver namngivna poster ("alla" kvitterar ingenting), och CRLF ger samma summa som LF', () => {
    const utan = FÖRVÄNTAT.map((x) => x.slice(0, 4));
    expect(kvittera(REG.poster, utan, ['alla']).kvitterade).toEqual([]);
    const rader = ['a', 'b', 'c'];
    expect(stycketsSumma(rader.map((x) => `${x}\r`), 1, 3)).toBe(stycketsSumma(rader, 1, 3));
  });
});
