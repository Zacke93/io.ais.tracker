'use strict';

/**
 * Beslutsregistrets radhänvisningar (2026-11-15, utbrutet 2026-11-16).
 *
 * Delas av `__tests__/n-kallrader.test.js` (kontrollen) och
 * `tools/foreslaKallrader.js` (förslag till nya rader när ett dokument har
 * ändrats). Nyckelordstabellen ligger i `kallrader-forvantat.json`:
 * [post, "fil:rader", nyckelord på det citerade styckets första rad,
 * [fler nyckelord någonstans i stycket]]. Se docs/BUGGJAKT.md §7
 * (Radhänvisningarna vid sammanslagning).
 */

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

const tabellen = (förväntat) => new Map(förväntat.map(([post, ref, först, inom = []]) => [`${post}|${ref}`, { först, inom }]));

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
  }
  for (const k of tabell.keys()) if (!använda.has(k)) fel.push(`${k}: används inte längre i registret`);
  return fel;
}

/**
 * Förslag till nya rader för de hänvisningar som inte längre håller.
 * För varje underkänd hänvisning söks raderna där tabellens första nyckelord
 * står; för varje sådan rad prövas ett stycke av samma längd som förut, och
 * annars det kortaste stycket (högst `maxRader` rader) som bär alla
 * nyckelord. Kandidaten närmast den gamla raden vinner. Hittas ingen är
 * förslaget null: stycket har skrivits om och måste läsas för hand.
 * @param {object[]} poster - registrets poster
 * @param {Array[]} förväntat - nyckelordstabellen
 * @param {{läs?: function, maxRader?: number}} [opt] - filläsare och sökgräns
 * @returns {object[]} [{post, fil, gammal, ny, kandidater, första}]
 */
function föreslå(poster, förväntat, { läs = läsare(), maxRader = 80 } = {}) {
  const tabell = tabellen(förväntat);
  const ut = [];
  const sedda = new Set();
  for (const r of poster.flatMap(radhänvisningar)) {
    const k = nyckel(r.post, r.fil, r.rader);
    if (sedda.has(k) || LEVANDE_KOD(r.fil)) continue;
    sedda.add(k);
    const f = tabell.get(k);
    const L = läs(r.fil);
    if (!f || !L || håller(L, r.från, r.till, f)) continue;
    const längd = r.till - r.från;
    const kandidater = [];
    L.forEach((rad, i) => {
      if (!rad.includes(f.först)) return;
      const från = i + 1;
      if (håller(L, från, Math.min(från + längd, L.length), f)) {
        kandidater.push({ från, till: Math.min(från + längd, L.length) });
        return;
      }
      for (let till = från; till <= Math.min(L.length, från + maxRader); till++) {
        if (håller(L, från, till, f)) {
          kandidater.push({ från, till });
          return;
        }
      }
    });
    ut.push({
      post: r.post, fil: r.fil, gammal: r.rader, från: r.från, längd, kandidaterna: kandidater, L,
    });
  }
  // Flera kandidater: välj den närmast den förskjutning som den närmaste
  // entydiga hänvisningen i samma fil fick (ett nytt avsnitt flyttar alla
  // stycken efter det lika långt), annars närmast den gamla raden. Bland
  // lika nära vinner ett stycke av samma längd som förut.
  const entydiga = ut.filter((x) => x.kandidaterna.length === 1);
  for (const x of ut) {
    const granne = entydiga.filter((e) => e.fil === x.fil && e !== x)
      .sort((a, b) => Math.abs(a.från - x.från) - Math.abs(b.från - x.från))[0];
    const väntad = x.från + (granne ? granne.kandidaterna[0].från - granne.från : 0);
    const rang = (c) => Math.abs(c.från - väntad) * 2 + (c.till - c.från === x.längd ? 0 : 1);
    const bäst = [...x.kandidaterna].sort((a, b) => rang(a) - rang(b))[0] || null;
    const intervall = (c) => (c.från === c.till ? `${c.från}` : `${c.från}–${c.till}`);
    x.ny = bäst ? intervall(bäst) : null;
    x.kandidater = x.kandidaterna.length;
    x.första = bäst ? x.L[bäst.från - 1].trim().slice(0, 100) : null;
  }
  return ut.map(({
    post, fil, gammal, ny, kandidater, första,
  }) => ({
    post, fil, gammal, ny, kandidater, första,
  }));
}

module.exports = {
  ROOT, REGISTER_FIL, FÖRVÄNTAT_FIL, RE, textfält, barahänvisningar, radhänvisningar, nyckel, LEVANDE_KOD, platt, läsare, brister, föreslå,
};
