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
  ROOT, FÖRVÄNTAT_FIL, radhänvisningar, barahänvisningar, nyckel, brister, föreslå,
} = require('../lib/kallrader');
const { bytIText, bytIRegistret, bytITabellrad } = require('../tools/foreslaKallrader');

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
    expect(förslagFör(f, 'U17-TYST-BÅT-RECOVER').kandidater).toBeGreaterThan(1);
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
