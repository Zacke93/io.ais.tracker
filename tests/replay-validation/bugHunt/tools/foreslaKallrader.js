'use strict';

/**
 * Förslag till nya radhänvisningar i beslutsregistret (2026-11-16).
 *
 * När ett citerat dokument ändras (en annan gren, en sammanslagning) glider
 * radhänvisningarna, och `__tests__/n-kallrader.test.js` fäller dem. Skriptet
 * söker för varje underkänd hänvisning postens nyckelord ur
 * `kallrader-forvantat.json` i dokumentet och föreslår de nya raderna.
 *
 *   node tests/replay-validation/bugHunt/tools/foreslaKallrader.js
 *       visar förslagen (skriver ingenting)
 *   node tests/replay-validation/bugHunt/tools/foreslaKallrader.js --skriv
 *       skriver förslagen i registret (alla fält i posten), i
 *       nyckelordstabellen och i postens rad i docs/BUGGJAKT.md §7
 *
 * Läs varje förslag mot dokumentet innan det skrivs: att nyckelordet finns
 * betyder inte att stycket säger samma sak som förut. En hänvisning utan
 * förslag gäller ett stycke som skrivits om; den rättas för hand.
 * Slutkod: 0 när allt håller eller allt fick förslag, 1 när något saknar förslag.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT, REGISTER_FIL, FÖRVÄNTAT_FIL, RE, föreslå,
} = require('../lib/kallrader');

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
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, REGISTER_FIL), 'utf8'));
  const förväntat = JSON.parse(fs.readFileSync(path.join(ROOT, FÖRVÄNTAT_FIL), 'utf8'));
  const förslag = föreslå(reg.poster, förväntat);
  if (!förslag.length) {
    console.log('Alla radhänvisningar håller.');
    return 0;
  }
  for (const f of förslag) {
    console.log(f.ny
      ? `${f.post} ${f.fil}:${f.gammal} → :${f.ny}${f.kandidater > 1 ? ` (${f.kandidater} kandidater, närmast vald)` : ''}\n    ${f.första}`
      : `${f.post} ${f.fil}:${f.gammal} → INGET FÖRSLAG: nyckelordet står inte i ett stycke som håller; läs stycket och rätta för hand`);
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
    fs.writeFileSync(path.join(ROOT, FÖRVÄNTAT_FIL), `[\n${förväntat.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n]\n`);
    fs.writeFileSync(path.join(ROOT, BUGGJAKT), md);
  }
  return förslag.some((x) => !x.ny) ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  bytIText, bytIRegistret, bytITabellrad, main,
};
