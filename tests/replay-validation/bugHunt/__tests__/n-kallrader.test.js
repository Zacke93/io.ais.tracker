'use strict';

/**
 * Beslutsregistrets radhänvisningar (2026-11-15).
 *
 * Hänvisningarna i `källa` och `orakelvakt` hade glidit: dokumenten och koden
 * har vuxit, och `docs/ARCHITECTURE.md:1934–1951 (U17)` pekade till exempel på
 * ett stycke om förtöjning. Laddningen prövar redan att en `#symbol` definieras
 * i sin fil (lib/registry.js#checkRefs), men en radhänvisning prövades bara
 * på att filen fanns. Därför:
 *  - kod i app.js, lib/ och drivers/ citeras med symbol (`fil.js#namn`), aldrig
 *    med rader: den filen ändras med varje rättning;
 *  - varje radhänvisning (också fortsättningar som `och :15`) ska ligga inom
 *    filen och ha en post i FÖRVÄNTAT nedan: postens nyckelord på det citerade
 *    styckets FÖRSTA rad, och eventuella fler nyckelord någonstans i stycket.
 *    Glider dokumentet bara en rad faller testet, och då rättas hänvisningen
 *    (eller nyckelordet, om stycket skrivits om);
 *  - varje post i FÖRVÄNTAT används, så att tabellen inte ruttnar.
 * Motorns egna filer citeras med symbol (laddningen varnar annars).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const REG = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/replay-validation/bugHunt/beslutsregister.json'), 'utf8'));

// Sökväg, eller en fortsättning (`och :15`, `, :267`) som gäller senaste sökväg.
const RE = /\b((?:docs|lib|tests|drivers)\/[^\s,;:()#]+|app\.js)(?::(\d+(?:[–-]\d+)?))?|(?:^|[\s(,])(?:och\s+)?:(\d+(?:[–-]\d+)?)/g;

/** Radhänvisningarna i en post: [{post, fil, rader, från, till}]. */
function radhänvisningar(post) {
  const ut = [];
  for (const fält of ['källa', 'orakelvakt']) {
    let fil = null;
    for (const m of String(post[fält] || '').matchAll(RE)) {
      if (m[1]) fil = m[1].replace(/[.:]+$/, '');
      const rader = m[2] || m[3];
      if (!rader) continue;
      const [från, till] = rader.split(/[–-]/).map(Number);
      ut.push({
        post: post.id, fält, fil, rader, från, till: Number.isFinite(till) ? till : från,
      });
    }
  }
  return ut;
}

const A = 'docs/ARCHITECTURE.md';
const E7 = 'docs/etapp7-plan-2026-08-08.md';
const RS = 'docs/reliability-spec.md';
const H11 = 'docs/helgranskning-2026-11-03.md';
const INV = 'tests/replay-validation/invariants.js';
// [post, hänvisning, nyckelord på första raden, fler nyckelord i stycket]
const FÖRVÄNTAT = [
  ['KIE-PER-KORPUS', 'tests/replay-validation/corpora.js:21–23', 'knownInvariantExceptions'],
  ['KIE-PER-KORPUS', 'tests/replay-validation/runAllCorpora.js:252–262', 'FP9'],
  ['U16-F40-STRAX-STUDS', 'docs/helgranskning-2026-07-06.md:271–274', 'F40', ['aldrig strax på gammal position']],
  ['U16-F40-STRAX-STUDS', `${E7}:8`, 'U1 (strax-texten)'],
  ['U16-F40-STRAX-STUDS', `${E7}:15`, 'U6'],
  ['U16-F40-STRAX-STUDS', `${E7}:267`, 'C11'],
  ['U23-KAJZON-UTANFÖR-VÄNTZONEN', `${RS}:102`, 'D1'],
  ['U1-C11-TYST-FÖRE-DEFAULT', `${E7}:8`, 'U1 (strax-texten)'],
  ['U1-C11-TYST-FÖRE-DEFAULT', `${E7}:266–267`, 'C11b', ['U1-fixen']],
  ['M-BRUSBAND-RÖRELSEBEVIS', `${A}:1346–1383`, 'Fartprovet', ['(a) brusbandet', '(c) en sog=null-båt']],
  ['R2-MÅLBRO-EFTER-LINJEN', `${INV}:600–628`, 'INV-13'],
  ['MÄTGRÄNS-INV17-R0', `${INV}:645`, 'INV-17 Textflapp-budget'],
  ['MÄTGRÄNS-INV17-R0', `${INV}:764–781`, 'INV-17', ['budgetPerHour']],
  ['MÄTGRÄNS-INV10-VÄNTKEDJA', `${INV}:508–535`, 'INV-10'],
  ['MÄTGRÄNS-INV10-VÄNTKEDJA', `${E7}:15`, 'U6'],
  ['K20-FASKÄNSLIG-LEDARE', `${A}:1221–1231`, 'K20'],
  ['K20-FASKÄNSLIG-LEDARE', 'docs/VALIDATION.md:272–280', '6. **Fas-känsliga utfall**'],
  ['D4-RIKTNING-UNKNOWN', `${RS}:45`, 'D4'],
  ['D4-RIKTNING-UNKNOWN', `${RS}:105`, 'D4'],
  ['BN1-BOXKANT', `${H11}:162–172`, 'BN1'],
  ['KANALINFARTEN-FP8-SYDGRIND', `${A}:514–519`, 'kanalrelevans'],
  ['KANALINFARTEN-FP8-SYDGRIND', `${E7}:485`, 'FP8:s sydgrind'],
  ['SKIPPA-BRO-ÅLDER-17MIN', 'tests/replay-validation/runSyntheticScenarios.js:1428–1431', '35-min-gap', ['gap-35min-över-Klaffbron', '>17 min']],
  ['D3-2H-DEDUP', `${RS}:49`, 'D3'],
  ['D3-2H-DEDUP', `${RS}:104`, 'D3'],
  ['BESÖKSREGEL-2026-09-07', `${A}:588`, 'besöksregeln 2026-09-07'],
  ['S10-VÄNDNING-BRON-BAKOM', `${A}:3260–3261`, 'FIXRUNDA 6 LIGHT', ['S10+S6 godkända']],
  ['S10-VÄNDNING-BRON-BAKOM', `${A}:3203–3206`, 'S10'],
  ['S10-VÄNDNING-BRON-BAKOM', `${A}:3294–3300`, 'S10', ['pending-reversal']],
  ['KAJGRIND-UTAN-RÖRELSEBEVIS', `${A}:1788`, 'Förtöjningslagren'],
  ['U10-BN2-PASSERAD-FORM', `${A}:675–714`, 'P8/U10'],
  ['U2-VS-DEADLINE', `${E7}:310–349`, 'C-IV', ['C8']],
  ['U2-VS-DEADLINE', `${A}:995–1024`, 'U15'],
  ['J13-J14-KONVOJSEMANTIK', `${A}:2940–2960`, 'J13+J33', ['J14']],
  ['J13-J14-KONVOJSEMANTIK', `${A}:995–1024`, 'U15'],
  ['U18-RETUR-BEKRÄFTAD-SENT', `${A}:1547–1554`, 'U18', ['Anomali 18']],
  ['U18-RETUR-BEKRÄFTAD-SENT', `${A}:995–1024`, 'U15'],
  ['U17-TYST-BÅT-RECOVER', `${A}:2786–2801`, 'U17', ['säkerhetsvarningen för en tyst båt']],
  ['K-TYST-BÅT-NÄSTA-ÖPPNING', `${A}:2786–2801`, 'U17'],
  ['K-TYST-BÅT-NÄSTA-ÖPPNING', `${A}:2755–2762`, 'Täckningsslutet', ['räknas däremot från bokföringen', 'U13']],
  ['U25-BAKKANT-VID-SEN-BOKFÖRING', `${A}:972–994`, 'Två sena varningar', ['U25', 'U26']],
  ['U25-BAKKANT-VID-SEN-BOKFÖRING', `${A}:2802–2809`, 'U25 och U26'],
  ['U26-STILLA-KÖ-SEN-VARNING', `${A}:972–994`, 'Två sena varningar', ['U25', 'U26']],
  ['U26-STILLA-KÖ-SEN-VARNING', `${A}:2802–2809`, 'U25 och U26'],
  ['U19-VARNING-UNDER-VÄNTANDE-VÄNDNING', `${A}:1655–1661`, 'U19'],
  ['FALSKLARM-AVBRUTEN-GLES', `${A}:919–920`, 'Tystnad avväpnar aldrig'],
  ['FIXD-SLINGA', `${A}:3360–3361`, 'ANYA ELAN', ['Slingskydd']],
  ['OMSTART-ARMAR-EJ-PERSISTERADE', 'docs/trigger-etapp6-oppningsmotorn-2026-08-03.md:261–265', 'Ingen arm-persistens'],
  ['OMSTART-ARMAR-EJ-PERSISTERADE', `${A}:1208–1214`, 'Dedup i TVÅ lager', ['persisterar inga armar']],
  ['OMSTART-RESETILLSTÅND', `${A}:2086`, 'last_known_positions', ['skrivs vid removal']],
  ['OMSTART-RESETILLSTÅND', `${RS}:104`, 'D3'],
  ['LATENT-INBROMSNING', `${H11}:176–183`, 'Latenta fynd', ['Inbromsning efter glapp']],
  ['P8-L6-SPÖKTEXT', `${H11}:148–161`, 'P8/L6'],
  ['TVÅ-ÅTERKORSADE-BROAR-I-SAMMA-SEGMENT', `${A}:1541–1546`, 'kända luckor', ['två återkorsade broar i samma segment']],
  ['U-SVÄNG-LÅNGSAM-ÅTERKORSNING', `${A}:1541–1546`, 'kända luckor', ['en tät långsam']],
];

const nyckel = (post, fil, rader) => `${post}|${fil}:${rader}`;
const filrader = new Map();
const raderI = (fil) => {
  if (!filrader.has(fil)) filrader.set(fil, fs.readFileSync(path.join(ROOT, fil), 'utf8').split('\n'));
  return filrader.get(fil);
};
// Radbrytningar och indrag i markdown ska inte fälla ett nyckelord som löper över två rader.
const platt = (s) => s.replace(/\s+/g, ' ');

/**
 * Bristerna i registrets radhänvisningar mot tabellen.
 * @param {object[]} poster - registrets poster
 * @param {Array[]} förväntat - FÖRVÄNTAT
 * @returns {string[]} bristerna
 */
function brister(poster, förväntat) {
  const alla = poster.flatMap(radhänvisningar);
  const tabell = new Map(förväntat.map(([post, ref, först, inom = []]) => [`${post}|${ref}`, { först, inom }]));
  const fel = [];
  const använda = new Set();
  for (const r of alla) {
    const k = nyckel(r.post, r.fil, r.rader);
    if (r.fil === 'app.js' || /^(lib|drivers)\//.test(r.fil)) {
      fel.push(`${k}: kod i app.js, lib/ och drivers/ citeras med symbol (fil.js#namn), inte med rader`);
      continue;
    }
    if (!fs.existsSync(path.join(ROOT, r.fil))) {
      fel.push(`${k}: filen finns inte`);
      continue;
    }
    const L = raderI(r.fil);
    if (!(r.från >= 1 && r.från <= r.till && r.till <= L.length)) {
      fel.push(`${k}: utanför filen (${L.length} rader)`);
      continue;
    }
    const f = tabell.get(k);
    if (!f) {
      fel.push(`${k}: saknar nyckelord i FÖRVÄNTAT`);
      continue;
    }
    använda.add(k);
    const första = L[r.från - 1];
    const stycke = platt(L.slice(r.från - 1, r.till).join('\n'));
    if (!första.includes(f.först)) fel.push(`${k}: första raden saknar "${f.först}": ${första.trim().slice(0, 100)}`);
    for (const ord of f.inom) if (!stycke.includes(ord)) fel.push(`${k}: stycket saknar "${ord}"`);
  }
  for (const k of tabell.keys()) if (!använda.has(k)) fel.push(`${k}: används inte längre i registret`);
  return fel;
}

describe('beslutsregistrets radhänvisningar', () => {
  test('tolkningen hittar varje radhänvisning, också fortsättningarna', () => {
    expect(REG.poster.flatMap(radhänvisningar)).toHaveLength(FÖRVÄNTAT.length);
  });

  test('varje radhänvisning ligger inom filen och pekar på ett stycke med postens nyckelord', () => {
    expect(brister(REG.poster, FÖRVÄNTAT)).toEqual([]);
  });
});

describe('kontrollen fäller de fel den finns till för', () => {
  const ändrad = (id, från, till) => REG.poster.map((p) => (p.id === id ? { ...p, källa: p.källa.split(från).join(till) } : p));

  test('en hänvisning som glidit en rad', () => {
    const fel = brister(ändrad('U17-TYST-BÅT-RECOVER', `${A}:2786–2801`, `${A}:2787–2802`), FÖRVÄNTAT);
    expect(fel.join('\n')).toMatch(/U17-TYST-BÅT-RECOVER\|docs\/ARCHITECTURE\.md:2787–2802: saknar nyckelord/);
    expect(fel.join('\n')).toMatch(/U17-TYST-BÅT-RECOVER\|docs\/ARCHITECTURE\.md:2786–2801: används inte längre/);
  });

  test('en tabellpost vars första rad inte bär nyckelordet', () => {
    const förskjuten = FÖRVÄNTAT.map((x) => (x[0] === 'U19-VARNING-UNDER-VÄNTANDE-VÄNDNING' ? [x[0], x[1], 'U18'] : x));
    expect(brister(REG.poster, förskjuten).join('\n')).toMatch(/U19-VARNING-UNDER-VÄNTANDE-VÄNDNING\|docs\/ARCHITECTURE\.md:1655–1661: första raden saknar "U18"/);
  });

  test('ett nyckelord som saknas i stycket', () => {
    const utan = FÖRVÄNTAT.map((x) => (x[0] === 'FIXD-SLINGA' ? [x[0], x[1], x[2], ['finns inte i stycket']] : x));
    expect(brister(REG.poster, utan).join('\n')).toMatch(/FIXD-SLINGA\|docs\/ARCHITECTURE\.md:3360–3361: stycket saknar "finns inte i stycket"/);
  });

  test('en rad utanför filen, en fortsättning utanför filen och en fil som saknas', () => {
    expect(brister(ändrad('U19-VARNING-UNDER-VÄNTANDE-VÄNDNING', `${A}:1655–1661`, `${A}:99990–99999`), FÖRVÄNTAT).join('\n'))
      .toMatch(/docs\/ARCHITECTURE\.md:99990–99999: utanför filen/);
    expect(brister(ändrad('D4-RIKTNING-UNKNOWN', ' och :105 (', ' och :9999 ('), FÖRVÄNTAT).join('\n'))
      .toMatch(/D4-RIKTNING-UNKNOWN\|docs\/reliability-spec\.md:9999: utanför filen/);
    expect(brister(ändrad('BN1-BOXKANT', `${H11}:162–172`, 'docs/finns-inte.md:162–172'), FÖRVÄNTAT).join('\n'))
      .toMatch(/docs\/finns-inte\.md:162–172: filen finns inte/);
  });

  test('kod i app.js eller lib/ citerad med rader', () => {
    const fel = brister(ändrad('OMSTART-DEFAULT-FÖRE-FÖRSTA-FIX', 'app.js#onInit', 'app.js:487'), FÖRVÄNTAT);
    expect(fel.join('\n')).toMatch(/OMSTART-DEFAULT-FÖRE-FÖRSTA-FIX\|app\.js:487: kod i app\.js, lib\/ och drivers\/ citeras med symbol/);
  });
});
