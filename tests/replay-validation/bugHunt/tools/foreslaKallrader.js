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
 *   … --kvittera=POST[,POST] eller --kvittera=alla
 *       ger tabellraderna kontrollsumman av dagens text bakom hänvisningen
 *       (efter att stycket lästs och godkänts, eller när summan saknas)
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

function main(argv = process.argv.slice(2)) {
  const skriv = argv.includes('--skriv');
  const refArg = argv.find((a) => a.startsWith('--ref='));
  const kvArg = argv.find((a) => a.startsWith('--kvittera='));
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, REGISTER_FIL), 'utf8'));
  const förväntat = JSON.parse(fs.readFileSync(path.join(ROOT, FÖRVÄNTAT_FIL), 'utf8'));
  if (kvArg) {
    const vilka = kvArg.slice('--kvittera='.length).split(',').filter(Boolean);
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
    let md = fs.readFileSync(path.join(ROOT, BUGGJAKT), 'utf8');
    let rå = fs.readFileSync(path.join(ROOT, REGISTER_FIL), 'utf8');
    for (const f of förslag.filter((x) => x.ny)) {
      const r = bytIRegistret(rå, f.post, f.fil, f.gammal, f.ny);
      rå = r.rå;
      for (const rad of förväntat) {
        if (rad[0] === f.post && rad[1] === `${f.fil}:${f.gammal}`) rad[1] = `${f.fil}:${f.ny}`;
      }
      const t = bytITabellrad(md, f.post, f.fil, f.gammal, f.ny);
      md = t.md;
      console.log(`  skrev ${f.post}: ${r.n} i registret, ${t.n} i tabellen i ${BUGGJAKT}`);
    }
    JSON.parse(rå);
    fs.writeFileSync(path.join(ROOT, REGISTER_FIL), rå);
    fs.writeFileSync(path.join(ROOT, FÖRVÄNTAT_FIL), skrivTabell(förväntat));
    fs.writeFileSync(path.join(ROOT, BUGGJAKT), md);
  }
  return förslag.some((x) => !x.ny) ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  bytIText, bytIRegistret, bytITabellrad, gitText, main,
};
