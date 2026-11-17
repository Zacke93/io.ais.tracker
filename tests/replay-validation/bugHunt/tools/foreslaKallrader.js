'use strict';

/**
 * Förslag till nya radhänvisningar i beslutsregistret (2026-11-16).
 *
 * När ett citerat dokument ändras (en annan gren, en sammanslagning) glider
 * radhänvisningarna, och `__tests__/n-kallrader.test.js` fäller dem. Skriptet
 * söker för varje underkänd hänvisning det stycke vars TEXT är densamma som
 * förut: tabellens kontrollsumma i `kallrader-forvantat.json`, eller med
 * `--ref=<git-ref>` texten på de gamla raderna i den versionen. Exakt en
 * träff ger förslaget; ingen eller flera ger inget förslag, och posten rättas
 * för hand. Nyckelordet ensamt väljer aldrig stycke (2026-11-16, V1: förut
 * togs första nyckelordsträffen, och vid tre sammanslagningar hamnade U17,
 * K-NÄSTA och en fortsättning i S10 på fel stycke medan allt var grönt).
 *
 *   node tests/replay-validation/bugHunt/tools/foreslaKallrader.js [--ref=HEAD]
 *       visar förslagen (skriver ingenting)
 *   … --skriv
 *       skriver förslagen i registret (alla fält i posten), i tabellen och i
 *       postens rad i docs/BUGGJAKT.md §7; kontrollsumman följer med oförändrad
 *   … --kvittera=POST[,POST]
 *       ger de namngivna posternas tabellrader kontrollsumman av dagens text
 *       bakom hänvisningen (efter att stycket lästs och godkänts). Det finns
 *       ingen kvittering av alla poster på en gång.
 *
 * Slutkod: 0 när allt håller eller allt fick förslag, 1 när något saknar förslag.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  ROOT, REGISTER_FIL, FÖRVÄNTAT_FIL, RE, föreslå, kvittera,
} = require('../lib/kallrader');

/** Raderna [från, till] i `fil` på git-referensen, eller null. */
function gitText(ref) {
  const cache = new Map();
  return (fil, från, till) => {
    if (!cache.has(fil)) {
      let rader = null;
      try {
        rader = execFileSync('git', ['show', `${ref}:${fil}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
      } catch (e) {
        rader = null;
      }
      cache.set(fil, rader);
    }
    const L = cache.get(fil);
    return L && från >= 1 && till <= L.length ? L.slice(från - 1, till) : null;
  };
}

const skrivTabell = (förväntat) => `[\n${förväntat.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n]\n`;

const BUGGJAKT = 'docs/BUGGJAKT.md';

/** Byter raderna i postens hänvisningar till `fil` (också fortsättningar). */
function bytIText(text, fil, gammal, ny) {
  let senast = null;
  let ut = '';
  let pos = 0;
  let n = 0;
  for (const m of text.matchAll(RE)) {
    if (m[1]) senast = m[1].replace(/[.:]+$/, '');
    const rader = m[2] || m[3];
    if (!rader || senast !== fil || rader !== gammal) continue;
    const i = m.index + m[0].lastIndexOf(rader);
    ut += text.slice(pos, i) + ny;
    pos = i + rader.length;
    n += 1;
  }
  return { text: ut + text.slice(pos), n };
}

/**
 * Byter i postens block i registrets råtext (från postens "id" till nästa
 * posts), så att filens format i övrigt står orört.
 */
function bytIRegistret(rå, postId, fil, gammal, ny) {
  const start = rå.indexOf(`"id": ${JSON.stringify(postId)}`);
  if (start < 0) return { rå, n: 0 };
  const nästa = rå.indexOf('"id": "', start + 1);
  const slut = nästa < 0 ? rå.length : nästa;
  const r = bytIText(rå.slice(start, slut), fil, gammal, ny);
  return { rå: rå.slice(0, start) + r.text + rå.slice(slut), n: r.n };
}

/**
 * Byter i docs/BUGGJAKT.md: i postens rad i §7-tabellen både förkortade
 * filnamn (`ARCHITECTURE:972–994`, `etapp7-plan:15`) och fortsättningar
 * (`och :3294–3300`) när raden nämner filen, och i hela dokumentet den
 * fullständiga formen `docs/ARCHITECTURE.md:972–994` (samma fil och rader är
 * samma stycke, var det än citeras).
 */
function bytITabellrad(md, postId, fil, gammal, ny) {
  const stam = path.basename(fil).replace(/\.[^.]+$/, '');
  const prefix = stam.split('-')[0];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const efter = '(?![\\d–-])';
  const rxNamn = new RegExp(`((?:${esc(fil)}|${esc(stam)}(?:\\.\\w+)?|${esc(prefix)}[\\w-]*(?:\\.\\w+)?):)${esc(gammal)}${efter}`, 'g');
  const rxFortsättning = new RegExp(`((?:^|[\\s(,])(?:och\\s+)?:)${esc(gammal)}${efter}`, 'g');
  const rxFull = new RegExp(`(${esc(fil)}:)${esc(gammal)}${efter}`, 'g');
  let n = 0;
  const byt = (_, f) => {
    n += 1;
    return `${f}${ny}`;
  };
  const rader = md.split('\n').map((rad) => {
    if (rad.startsWith(`| ${postId} |`) && (rad.includes(stam) || rad.includes(`${prefix}`))) {
      return rad.replace(rxNamn, byt).replace(rxFortsättning, byt);
    }
    return rad.replace(rxFull, byt);
  });
  return { md: rader.join('\n'), n };
}

/**
 * Skriver förslagen i ETT pass (granskningen 2026-11-16, medel): förut byttes
 * ett förslag i taget med sök-och-ersätt, och när en hänvisnings nya rad var
 * en senare hänvisnings gamla byttes värdet två gånger (sju rader överst i
 * etapp7-plan gav U16 ":22 (U1), :22 (U6)") medan kontrollen var grön. Nu
 * byts varje gammalt värde först mot en markör och sedan alla markörer mot de
 * nya värdena. Två förslag i samma post som pekar på samma nya stycke vägras
 * (de skrivs inte), och kontrollen fäller dubbla nycklar.
 * @param {object[]} förslag - föreslå()
 * @param {{rå: string, md: string, förväntat: Array[]}} in - registrets råtext, BUGGJAKT och tabellen
 * @returns {{rå: string, md: string, förväntat: Array[], logg: string[], vägrade: object[]}} resultat
 */
function skrivFörslag(förslag, { rå, md, förväntat }) {
  const med = förslag.filter((x) => x.ny);
  const vägrade = [];
  const godtagna = med.filter((f) => {
    const krock = med.some((g) => g !== f && g.post === f.post && g.fil === f.fil && g.ny === f.ny && g.gammal !== f.gammal);
    if (krock) vägrade.push(f);
    return !krock;
  });
  const logg = vägrade.map((f) => `  VÄGRAR ${f.post} ${f.fil}:${f.gammal} → :${f.ny}: två hänvisningar i posten skulle peka på samma stycke; rätta för hand`);
  const markör = (i) => `\u27E6V${i}\u27E7`;
  let r = rå;
  let m = md;
  const tabell = förväntat.map((x) => [...x]);
  godtagna.forEach((f, i) => {
    r = bytIRegistret(r, f.post, f.fil, f.gammal, markör(i)).rå;
    m = bytITabellrad(m, f.post, f.fil, f.gammal, markör(i)).md;
    for (const rad of tabell) if (rad[0] === f.post && rad[1] === `${f.fil}:${f.gammal}`) rad[1] = `${f.fil}:${markör(i)}`;
  });
  godtagna.forEach((f, i) => {
    const nR = r.split(markör(i)).length - 1;
    const nM = m.split(markör(i)).length - 1;
    r = r.split(markör(i)).join(f.ny);
    m = m.split(markör(i)).join(f.ny);
    for (const rad of tabell) if (rad[1] === `${f.fil}:${markör(i)}`) rad[1] = `${f.fil}:${f.ny}`;
    logg.push(`  skrev ${f.post}: ${nR} i registret, ${nM} i ${BUGGJAKT}`);
  });
  return {
    rå: r, md: m, förväntat: tabell, logg, vägrade,
  };
}

function main(argv = process.argv.slice(2)) {
  const skriv = argv.includes('--skriv');
  const refArg = argv.find((a) => a.startsWith('--ref='));
  const kvArg = argv.find((a) => a.startsWith('--kvittera='));
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, REGISTER_FIL), 'utf8'));
  const förväntat = JSON.parse(fs.readFileSync(path.join(ROOT, FÖRVÄNTAT_FIL), 'utf8'));
  if (kvArg) {
    const vilka = kvArg.slice('--kvittera='.length).split(',').filter(Boolean);
    if (!vilka.length || vilka.includes('alla')) {
      console.error('--kvittera kräver namngivna poster (--kvittera=POST[,POST]); läs varje stycke först');
      return 1;
    }
    const k = kvittera(reg.poster, förväntat, vilka);
    fs.writeFileSync(path.join(ROOT, FÖRVÄNTAT_FIL), skrivTabell(k.förväntat));
    console.log(`Kvitterade ${k.kvitterade.length} hänvisningar: ${k.kvitterade.join(', ') || '—'}`);
    return 0;
  }
  const förslag = föreslå(reg.poster, förväntat, refArg ? { gammalText: gitText(refArg.slice('--ref='.length)) } : {});
  if (!förslag.length) {
    console.log('Alla radhänvisningar håller.');
    return 0;
  }
  for (const f of förslag) {
    console.log(f.ny
      ? `${f.post} ${f.fil}:${f.gammal} → :${f.ny} (samma text)\n    ${f.första}`
      : `${f.post} ${f.fil}:${f.gammal} → INGET FÖRSLAG: ${f.skäl}; posten rättas för hand`);
  }
  if (skriv) {
    const ut = skrivFörslag(förslag, {
      rå: fs.readFileSync(path.join(ROOT, REGISTER_FIL), 'utf8'),
      md: fs.readFileSync(path.join(ROOT, BUGGJAKT), 'utf8'),
      förväntat,
    });
    for (const rad of ut.logg) console.log(rad);
    JSON.parse(ut.rå);
    fs.writeFileSync(path.join(ROOT, REGISTER_FIL), ut.rå);
    fs.writeFileSync(path.join(ROOT, FÖRVÄNTAT_FIL), skrivTabell(ut.förväntat));
    fs.writeFileSync(path.join(ROOT, BUGGJAKT), ut.md);
    if (ut.vägrade.length) return 1;
  }
  return förslag.some((x) => !x.ny) ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  bytIText, bytIRegistret, bytITabellrad, gitText, skrivFörslag, main,
};
