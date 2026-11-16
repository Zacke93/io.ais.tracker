'use strict';

/**
 * Beslutsregistrets radhänvisningar (2026-11-15, utbrutet 2026-11-16).
 *
 * Delas av `__tests__/n-kallrader.test.js` (kontrollen) och
 * `tools/foreslaKallrader.js` (förslag till nya rader när ett dokument har
 * ändrats). Nyckelordstabellen ligger i `kallrader-forvantat.json`:
 * [post, "fil:rader", nyckelord på det citerade styckets första rad,
 * [fler nyckelord någonstans i stycket], kontrollsumma av styckets text].
 * Se docs/BUGGJAKT.md §7 (Radhänvisningarna vid sammanslagning).
 *
 * KONTROLLSUMMAN (2026-11-16, V1): att nyckelordet står någonstans i spannet
 * räcker inte. Vid tre sammanslagningar valde förslagsskriptet ett NYTT
 * stycke längre upp som råkade bära samma nyckelord (U17 och K-NÄSTA, där
 * spannet blev 65 rader i stället för 16), och gav en fortsättning samma
 * startrad som postens första hänvisning (S10). Både skriptet och testet var
 * gröna, och `--skriv` låste felet i tabellen. Nu bär varje tabellrad
 * sha256 (16 hexsiffror) av det citerade styckets exakta text, kontrollen
 * fäller ett stycke som bytt innehåll, och förslaget väljer bara ett stycke
 * med SAMMA text: exakt en träff, annars inget förslag.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const REGISTER_FIL = 'tests/replay-validation/bugHunt/beslutsregister.json';
const FÖRVÄNTAT_FIL = 'tests/replay-validation/bugHunt/kallrader-forvantat.json';

// Sökväg, eller en fortsättning (`och :15`, `, :267`) som gäller senaste sökväg.
const RE = /\b((?:docs|lib|tests|drivers)\/[^\s,;:()#]+|app\.js)(?::(\d+(?:[–-]\d+)?))?|(?:^|[\s(,])(?:och\s+)?:(\d+(?:[–-]\d+)?)/g;

/**
 * Postens textfält med hänvisningar, också nästlade (doktrinernas text och
 * källa): [[fältnamn, text]]. Granskningen 2026-11-16 (L3): förut lästes bara
 * `källa` och `orakelvakt`.
 * @param {object} post - registerposten
 * @returns {Array[]} fälten
 */
function textfält(post) {
  const ut = [];
  const gå = (namn, v) => {
    if (typeof v === 'string') ut.push([namn, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => gå(`${namn}[${i}]`, x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) gå(`${namn}.${k}`, x);
  };
  for (const [k, v] of Object.entries(post)) if (k !== 'id') gå(k, v);
  return ut;
}

// Ett filnamn med rader utan sökvägen framför (`invariants.js:334`) går
// varken att slå upp eller att pröva; skriv hela sökvägen eller en symbol.
const BART = /(^|[^\w/.-])([\w-]+\.(?:js|md|json|sh)):\d/g;
/** Bara filnamn med rader i en post: [{post, fält, ref}]. */
function barahänvisningar(post) {
  return textfält(post).flatMap(([fält, text]) => [...text.matchAll(BART)].map((m) => ({
    post: post.id, fält, ref: `${m[2]}:`,
  })));
}

/** Radhänvisningarna i en post: [{post, fält, fil, rader, från, till}]. */
function radhänvisningar(post) {
  const ut = [];
  for (const [fält, text] of textfält(post)) {
    let fil = null;
    for (const m of text.matchAll(RE)) {
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

const nyckel = (post, fil, rader) => `${post}|${fil}:${rader}`;
// Kod som ändras med varje rättning: appen och harnessens domare och körare.
// Där glider radnummer, och en symbol prövas av laddningen
// (lib/registry.js#checkRefs).
const LEVANDE_KOD = (fil) => fil === 'app.js' || /^(lib|drivers)\//.test(fil)
  || fil === 'tests/replay-validation/invariants.js' || fil === 'tests/replay-validation/replayRunner.js';
// Radbrytningar och indrag i markdown ska inte fälla ett nyckelord som löper över två rader.
const platt = (s) => s.replace(/\s+/g, ' ');

/** Filläsare med cache: fil → rader. `root` kan bytas i test. */
function läsare(root = ROOT) {
  const cache = new Map();
  const läs = (fil) => {
    if (!cache.has(fil)) cache.set(fil, fs.existsSync(path.join(root, fil)) ? fs.readFileSync(path.join(root, fil), 'utf8').split('\n') : null);
    return cache.get(fil);
  };
  return läs;
}

const tabellen = (förväntat) => new Map(förväntat.map(([post, ref, först, inom = [], summa = null]) => [`${post}|${ref}`, { först, inom, summa }]));

/** Kontrollsumman av raderna [från, till]: sha256 av den exakta texten, 16 hexsiffror. */
function stycketsSumma(L, från, till) {
  // CRLF räknas som LF (granskningen 2026-11-16, låg): en utcheckning med
  // Windows-radslut ska inte göra alla summor röda.
  const text = L.slice(från - 1, till).map((x) => String(x).replace(/\r$/, '')).join('\n');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Håller stycket rader [från, till] postens nyckelord? */
function håller(L, från, till, f) {
  if (!(från >= 1 && från <= till && till <= L.length)) return false;
  if (!L[från - 1].includes(f.först)) return false;
  const stycke = platt(L.slice(från - 1, till).join('\n'));
  return f.inom.every((ord) => stycke.includes(ord));
}

/**
 * Bristerna i registrets radhänvisningar mot tabellen.
 * @param {object[]} poster - registrets poster
 * @param {Array[]} förväntat - nyckelordstabellen
 * @param {function} [läs] - fil → rader (null om filen saknas)
 * @returns {string[]} bristerna
 */
function brister(poster, förväntat, läs = läsare()) {
  const alla = poster.flatMap(radhänvisningar);
  const tabell = tabellen(förväntat);
  const fel = [];
  const använda = new Set();
  // Dubbla nycklar (granskningen 2026-11-16, medel): samma hänvisning två
  // gånger i samma fält, eller två tabellrader med samma nyckel, är spåret av
  // ett kedjat byte (två hänvisningar som hamnat på samma stycke).
  const iFält = new Map();
  for (const r of alla) {
    const k = `${nyckel(r.post, r.fil, r.rader)}|${r.fält}`;
    if (iFält.has(k)) fel.push(`${nyckel(r.post, r.fil, r.rader)}: samma hänvisning två gånger i fältet ${r.fält}`);
    iFält.set(k, true);
  }
  const tabellNycklar = new Set();
  for (const [post, ref] of förväntat) {
    if (tabellNycklar.has(`${post}|${ref}`)) fel.push(`${post}|${ref}: två rader i FÖRVÄNTAT med samma nyckel`);
    tabellNycklar.add(`${post}|${ref}`);
  }
  for (const r of alla) {
    const k = nyckel(r.post, r.fil, r.rader);
    if (LEVANDE_KOD(r.fil)) {
      fel.push(`${k}: kod i app.js, lib/, drivers/ och harnessens invariants.js och replayRunner.js citeras med symbol (fil.js#namn), inte med rader`);
      continue;
    }
    const L = läs(r.fil);
    if (!L) {
      fel.push(`${k}: filen finns inte`);
      continue;
    }
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
    if (!f.summa) fel.push(`${k}: saknar kontrollsumma i FÖRVÄNTAT (kvittera stycket med foreslaKallrader.js --kvittera=${r.post})`);
    else if (stycketsSumma(L, r.från, r.till) !== f.summa) {
      fel.push(`${k}: stycket har bytt innehåll mot förväntan (kontrollsumma ${stycketsSumma(L, r.från, r.till)}, väntad ${f.summa}): `
        + 'läs stycket, rätta hänvisningen eller kvittera det nya innehållet');
    }
  }
  for (const k of tabell.keys()) if (!använda.has(k)) fel.push(`${k}: används inte längre i registret`);
  return fel;
}

/**
 * Förslag till nya rader för de hänvisningar som inte längre håller.
 * Stycket söks på sin TEXT, inte på nyckelordet (2026-11-16, V1): det gamla
 * stycket är det som tabellens kontrollsumma beskriver, eller, med
 * `gammalText`, texten på de gamla raderna i en betrodd version (git-ref).
 * Varje fönster av samma längd i dagens fil vars text är densamma, och vars
 * nyckelord håller, är en kandidat. Exakt en kandidat ger förslaget; ingen
 * eller flera ger inget förslag, och hänvisningen rättas för hand. Varje
 * hänvisning prövas för sig, också fortsättningar som `och :3499–3505`.
 * @param {object[]} poster - registrets poster
 * @param {Array[]} förväntat - nyckelordstabellen
 * @param {{läs?: function, gammalText?: function}} [opt] - filläsare, och
 *   (fil, från, till) → raderna i den betrodda versionen eller null
 * @returns {object[]} [{post, fil, gammal, ny, kandidater, första, skäl}]
 */
function föreslå(poster, förväntat, { läs = läsare(), gammalText = null } = {}) {
  const tabell = tabellen(förväntat);
  const ut = [];
  const sedda = new Set();
  for (const r of poster.flatMap(radhänvisningar)) {
    const k = nyckel(r.post, r.fil, r.rader);
    if (sedda.has(k) || LEVANDE_KOD(r.fil)) continue;
    sedda.add(k);
    const f = tabell.get(k);
    const L = läs(r.fil);
    if (!f || !L) continue;
    const summaNu = håller(L, r.från, r.till, f) ? stycketsSumma(L, r.från, r.till) : null;
    const gammal = gammalText ? gammalText(r.fil, r.från, r.till) : null;
    const väntad = gammal ? stycketsSumma(gammal, 1, gammal.length) : f.summa;
    if (summaNu !== null && väntad && summaNu === väntad) continue;
    if (summaNu !== null && !väntad) continue;
    const längd = r.till - r.från;
    let skäl = null;
    const kandidater = [];
    if (!väntad) skäl = 'tabellen saknar kontrollsumma och ingen betrodd version angavs';
    else if (gammal && f.summa && väntad !== f.summa) skäl = `den betrodda versionens stycke stämmer inte med tabellens kontrollsumma (${väntad} mot ${f.summa})`;
    else {
      for (let från = 1; från + längd <= L.length; från++) {
        if (stycketsSumma(L, från, från + längd) === väntad && håller(L, från, från + längd, f)) kandidater.push({ från, till: från + längd });
      }
      if (!kandidater.length) skäl = 'ingen exakt träff: stycket har skrivits om eller flyttats med ändringar';
      else if (kandidater.length > 1) skäl = `${kandidater.length} stycken har samma text: välj för hand`;
    }
    const bäst = kandidater.length === 1 ? kandidater[0] : null;
    const intervall = (c) => (c.från === c.till ? `${c.från}` : `${c.från}–${c.till}`);
    ut.push({
      post: r.post,
      fil: r.fil,
      gammal: r.rader,
      ny: bäst ? intervall(bäst) : null,
      kandidater: kandidater.length,
      första: bäst ? L[bäst.från - 1].trim().slice(0, 100) : null,
      skäl,
    });
  }
  return ut;
}

/**
 * Kvitterar styckena: tabellraderna för `poster` (id, eller 'alla') får
 * kontrollsumman av dagens text bakom hänvisningen. Används när ett stycke
 * medvetet skrivits om (läs det först) och när tabellen saknar summan.
 * @returns {{förväntat: Array[], kvitterade: string[]}} ny tabell och nycklarna
 */
function kvittera(poster, förväntat, vilka, läs = läsare()) {
  // Bara namngivna poster (granskningen 2026-11-16, medel: 'alla' kvitterade
  // också ändrade stycken utan villkor).
  const alla = false;
  const refs = new Map(poster.flatMap(radhänvisningar).map((r) => [nyckel(r.post, r.fil, r.rader), r]));
  const kvitterade = [];
  const ny = förväntat.map((rad) => {
    const [post, ref, först, inom = []] = rad;
    if (!alla && !vilka.includes(post)) return rad;
    const r = refs.get(`${post}|${ref}`);
    const L = r ? läs(r.fil) : null;
    if (!r || !L || !(r.från >= 1 && r.till <= L.length)) return rad;
    kvitterade.push(`${post}|${ref}`);
    return [post, ref, först, inom, stycketsSumma(L, r.från, r.till)];
  });
  return { förväntat: ny, kvitterade };
}

module.exports = {
  ROOT,
  REGISTER_FIL,
  FÖRVÄNTAT_FIL,
  RE,
  textfält,
  barahänvisningar,
  radhänvisningar,
  nyckel,
  LEVANDE_KOD,
  platt,
  läsare,
  brister,
  föreslå,
  kvittera,
  stycketsSumma,
};
