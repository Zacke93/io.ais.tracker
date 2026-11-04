'use strict';

/**
 * Rapporten (BUGGJAKT §9): rapport.md (svenska, för ägaren), rapport.json
 * (maskinläsbar, stabil nyckelordning, separat tidsblock), katalogerna
 * fynd/Fnn-<slug>/ och — bara i motorns egna baskataloger — senaste.txt.
 *
 * rapport.json är deterministisk: samma HEAD + profil + seed ger samma fil
 * bortsett från blocket "tid". Därför står inga tempsökvägar, utkatalogsnamn
 * eller väggtider utanför tidsblocket, och alla objekt skrivs med sorterade
 * nycklar. Undantaget är en AVKORTAD rapport (nödbromsen --max-minutes): den
 * beror på väggklockan, och märkningen säger det.
 *
 * Ett fynd är en KANDIDAT tills ägaren har triagerat det; texten kallar det
 * aldrig en bugg.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const hygiene = require('./hygiene');
const clusterLib = require('./cluster');
const { MAX_KORT } = require('./profiles');
const { fromEntries, copyFile, cmpStr } = require('./util');

const FORMAT = 'buggjägaren-rapport/1';

// ---------------------------------------------------------------------------
// Formattering
// ---------------------------------------------------------------------------

/** Svenskt tal: decimalkomma och typografiskt minus. */
function fmtNum(x, decimals = null) {
  if (!Number.isFinite(x)) return String(x);
  const s = decimals === null ? String(Math.round(x * 100) / 100) : x.toFixed(decimals);
  return s.replace('-', '−').replace('.', ',');
}

/** Heltal med mellanslag som tusentalsavgränsare: 18 679. */
function fmtInt(n) {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ').replace('-', '−');
}

/** δ med tecken: +7, −11,52. */
function fmtDelta(d) {
  return `${d > 0 ? '+' : ''}${fmtNum(d)}`;
}

/** Klockslag HH:MM:SS (UTC, samma som harnessens iso). */
function fmtClock(t) {
  return Number.isFinite(t) ? new Date(Math.round(t)).toISOString().slice(11, 19) : '—';
}

/** Varaktighet: "7 h 30 min", "45 s". */
function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const RIKTNING = Object.freeze({ northbound: 'norrut', southbound: 'söderut', unknown: 'okänd riktning' });

/** ASCII-slug för katalognamn. */
function slugify(text, max = 80) {
  const map = {
    å: 'a', ä: 'a', ö: 'o', Å: 'a', Ä: 'a', Ö: 'o', é: 'e',
  };
  return String(text).toLowerCase().replace(/[åäöÅÄÖé]/g, (c) => map[c] || c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '') || 'fynd';
}

/** JSON med rekursivt sorterade nycklar (stabil byte för byte). */
function stableStringify(value, indent = 1) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') return fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
    return v;
  };
  return `${JSON.stringify(sortDeep(value), null, indent)}\n`;
}

function sha12(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Märker körningen AVKORTAD (BUGGJAKT §3): nödbromsen --max-minutes slog
 * till, så rapporten beror på väggklockan och är inte reproducerbar. Skälet
 * ("fas 4 (…): …") står i sammanfattningen och i rapport.json; samma skäl
 * bokförs bara en gång.
 * @param {object} körning - körningsobjektet
 * @param {string} skäl - var och hur nödbromsen slog till
 */
function markeraAvkortad(körning, skäl) {
  körning.avkortad = true;
  if (!Array.isArray(körning.avkortning)) körning.avkortning = [];
  if (skäl && !körning.avkortning.includes(skäl)) körning.avkortning.push(skäl);
}

/** Har nödbromsen slagit till i fas `fas` (skälen börjar med "fas N")? */
function avkortadIFas(körning, fas) {
  return (körning.avkortning || []).some((s) => s.startsWith(`fas ${fas} `) || s === `fas ${fas}`);
}

/** Tillägg för sanningsspårets stresskluster (egna kluster, §8). */
function nivåTillägg(c) {
  return c.nivå === 'stress' ? ' (stress)' : '';
}

// ---------------------------------------------------------------------------
// Orakeltexter och rubriker
// ---------------------------------------------------------------------------

const ORAKEL_TEXT = {
  H1: 'processfel — replayn får inte kasta, fela vid nedstängning eller lämna timers efter sig.',
  H2: 'häng — replayn ska lämna resultatmarkören inom tidsgränsen.',
  H3: 'ny APP ERROR-signatur — stderr ska inte få nya felklasser.',
  'INV-F': 'fatala invarianter (invariants.js) — facit-oberoende sanningar om texter, notiser och passager.',
  'INV-W': 'WARN-invarianter — informativa räknare.',
  LEV: 'öppningsleveransen — varje avfyrning ska nå kortet eller vara en redovisad dubblett.',
  'M-FAS': 'fasrelationen — notis-, öppnings- och passagenycklar ska vara lika när hela korpusen flyttas δ s, och parade notiser får driva högst 30 s.',
  'M-EXAKT': 'exakta relationer (ID, SHIFT30, MMSI) — utfallet ska vara identiskt efter invers mappning.',
};

/** Spår (t.ex. sanningsspåret) kan registrera egna orakeltexter. */
function registerOracleText(id, text) {
  ORAKEL_TEXT[id] = text;
}

const MFAS_RUBRIK = {
  'NOTISNYCKEL TILLAGD': 'Ny notis i fasvarianten',
  'NOTISNYCKEL TAPPAD': 'Tappad notis i fasvarianten',
  'NOTISRIKTNING BYTT': 'Notisens riktning byter med klockfasen',
  'ÖPPNINGSNYCKEL TILLAGD': 'Ny öppningsvarning i fasvarianten',
  'ÖPPNINGSNYCKEL TAPPAD': 'Tappad öppningsvarning i fasvarianten',
  'ÖPPNINGSRIKTNING BYTT': 'Öppningsvarningens riktning byter med klockfasen',
  'PASSAGENYCKEL TILLAGD': 'Ny passage i fasvarianten',
  'PASSAGENYCKEL TAPPAD': 'Tappad passage i fasvarianten',
  'PASSAGETYP BYTT': 'Passagen byter mellan mål- och mellanbro med klockfasen',
  'NOTISDRIFT>30s': 'Notisen driver mer än 30 s med klockfasen',
};

/** Rubriker för sanningsspårets och självtestets klasser (orakel|klass). */
const SYNT_RUBRIK = [
  [/^T1\|NOTIS-UTEBLIVEN/, () => 'Utebliven notis vid ett observerat besök'],
  [/^T1\|FÖRVARNINGSFORM-EFTER-PASSAGE/, () => 'Notis i förvarningsform efter sann passage'],
  [/^T2\|LEDTID</, () => 'Öppningsvarning med för kort ledtid före sann passage'],
  [/^T2\|ÖPPNING-MISS:(.*)/, (m) => `Sann målbropassage utan öppningsvarning (${m[1]})`],
  [/^T3\|VARNING-EFTER-SANN-PASSAGE/, () => 'Öppningsvarning efter sann passage'],
  [/^T3\|FANTOM-UTAN-AVBROTT/, () => 'Fantomvarning utan avbrott i sanningen'],
  [/^T3\|VARNING-PÅ-FRUSET-FIX/, () => 'Öppningsvarning på fruset fix'],
  [/^T3\|FANTOM:(.*)/, (m) => `Fantomvarning (${m[1]})`],
  [/^T3\|SEN:(.*)/, (m) => `Sen passage efter varning (${m[1]})`],
  [/^T9\|FEL-RIKTNING/, () => 'Riktning som motsäger sanningen'],
  [/^T10\|PASSAGE-EJ-REGISTRERAD/, () => 'Sann passage registrerades inte'],
  // Klassen betyder att ingen sann korsning förklarar registreringen: ingen
  // korsning alls, en för sen registrering eller en dubblett (bilaga B, T10).
  [/^T10\|FANTOMPASSAGE\((.*)\)/, (m) => `Registrerad ${m[1] === 'target' ? 'målbro' : 'mellanbro'}passage som ingen sann korsning förklarar`],
  [/^S-KANARIE\|PRODUKTFÖRVÄNTAN (.*)/, (m) => `Kanariens produktförväntan bruten: ${m[1]}`],
];

/** Tabellcell i markdown: lodstreck escapas. */
function cell(text) {
  return String(text).split('|').join('\\|');
}

function only(dist) {
  const keys = Object.keys(dist || {});
  return keys.length === 1 ? keys[0] : null;
}

function headlineOf(c) {
  const bank = (c.fördelning.spår || {}).bank && c.fynd.some((f) => (f.ursprung || {}).relation === 'M-FAS');
  let base;
  if (c.orakel === 'M-FAS') base = MFAS_RUBRIK[c.klass] || `Fasavvikelse: ${c.klass}`;
  else if (c.orakel === 'INV-F') base = `${c.låstBank ? 'Fatalt invariantutslag på låst bank' : 'Fatalt invariantutslag'}: ${c.klass}${bank ? ' i fasvarianten' : ''}`;
  else if (c.orakel === 'LEV') base = `Leveransfel: ${c.klass}`;
  else if (c.orakel === 'H1') base = `Processfel: ${c.klass.replace(/^PROCESSFEL /, '')}`;
  else if (c.orakel === 'H2') base = 'Replayn hänger';
  else if (c.orakel === 'H3') base = 'Ny stderr-signatur';
  else {
    const key = `${c.orakel}|${c.klass}`;
    const hit = SYNT_RUBRIK.map(([re, fn]) => [re.exec(key), fn]).find(([m]) => m);
    base = hit ? hit[1](hit[0]) : `${c.orakel} ${c.klass}`;
  }
  const bro = only(c.fördelning.bro);
  const dir = only(c.fördelning.riktning);
  if (bro) base += ` vid ${bro}`;
  if (bro && dir && RIKTNING[dir]) base += ` ${RIKTNING[dir]}`;
  return base;
}

function distText(dist, limit = 4) {
  const entries = Object.entries(dist || {}).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  if (!entries.length) return '';
  const shown = entries.slice(0, limit).map(([k, v]) => `${RIKTNING[k] || k} ${v}`);
  return `${shown.join(', ')}${entries.length > limit ? ` (+${entries.length - limit})` : ''}`;
}

// ---------------------------------------------------------------------------
// Kort
// ---------------------------------------------------------------------------

function occurrenceText(c) {
  const parts = [];
  const korpusar = Object.keys(c.fördelning.korpus || {});
  if (korpusar.length) parts.push(`${korpusar.length} ${korpusar.length === 1 ? 'korpus' : 'korpusar'} (${korpusar.slice(0, 4).join(', ')}${korpusar.length > 4 ? ' …' : ''})`);
  const världar = c.fynd.filter((f) => (f.ursprung || {}).värld !== undefined && (f.ursprung || {}).värld !== null);
  if (världar.length) {
    const fam = distText(c.fördelning.familj);
    const radio = distText(c.fördelning.radio);
    parts.push(`${new Set(världar.map((f) => f.ursprung.värld)).size} världar${fam ? ` (${fam})` : ''}${radio ? `; radio ${radio}` : ''}`);
  }
  const deltas = Object.keys(c.fördelning.delta || {}).map(Number).sort((a, b) => a - b);
  if (deltas.length) parts.push(`δ = ${deltas.map(fmtDelta).join(' och ')} s`);
  const bro = distText(c.fördelning.bro);
  if (bro) parts.push(bro);
  const dir = distText(c.fördelning.riktning);
  if (dir) parts.push(dir);
  return `${parts.join('; ')}.`;
}

function registryLine(c, registry, rep = null) {
  if (c.registerklass === 'KANDIDAT') {
    // Kortets representant bär sitt eget "närmast"-skäl (tider och mått
    // skiljer mellan klustrets fynd); klustrets första fynd är reserv.
    const reg = (rep && rep.register && rep.register.klass === 'KANDIDAT') ? rep.register : c;
    const närmast = reg.närmast || null;
    if (!närmast) return 'ingen post matchar.';
    const andra = (reg.prövade || []).filter((p) => p.post !== närmast.post).map((p) => p.post);
    return `ingen post matchar. Närmast ${närmast.post} (${närmast.källa || 'källa saknas'}): ${närmast.skäl}.`
      + `${andra.length ? ` Även prövade: ${andra.join(', ')}.` : ''}`;
  }
  if (c.registerklass === 'INSTRUMENTFEL' && c.instrumentfel) return `INSTRUMENTFEL i bekräftelsen — ${c.instrumentfel}.`;
  const e = registry ? registry.entry(c.post) : null;
  return `${c.post} (${c.registerklass})${e ? ` — ${e.regel} Källa: ${e.källa}.` : '.'}`;
}

function nextStep(c) {
  if (c.låstBank) return 'regressionssignal på verklig data — utred innan andra fynd triageras (§15).';
  if (c.knivsegg) return 'triage — kör varianten och avgör om det är en bugg eller ett beslut; KNIVSEGG betyder bara att utfallet beror på klockfasen (§15).';
  return 'triage — läs reprot och avgör om det är en bugg eller ett beslut (§15).';
}

function substitute(text, dir) {
  return String(text).split('<fynd>').join(dir);
}

/**
 * Renderar ett kort.
 * @param {object} card - {id, kluster, katalog (absolut), relKatalog}
 * @param {object} [registry] - registret (för registerraden)
 * @returns {string} markdown
 */
function renderCard(card, registry = null) {
  const c = card.kluster;
  const rep = card.representant || c.fynd[0];
  const repro = rep.repro || {};
  const dir = card.katalog || card.relKatalog || '<fynd>';
  const lines = [];
  lines.push(`### ${card.id} · ${c.registerklass} · ${c.nivå} · allvar ${c.allvar} — ${headlineOf(c)}`);
  lines.push('');
  lines.push('```');
  lines.push(`Orakel:       ${c.orakel} ${c.klass} — ${ORAKEL_TEXT[c.orakel] || 'se orakelkatalogen (BUGGJAKT bilaga B).'}`);
  lines.push(`Förekomst:    ${occurrenceText(c)}`);
  const underlag = repro.underlag || 'utslagets indata (ej krympt).';
  lines.push(`${repro.krympt ? 'Minsta repro:' : 'Underlag:    '} ${underlag}`);
  for (const k of repro.kommandon || []) lines.push(`              ${substitute(k, dir)}`);
  const tl = repro.tidslinje || [];
  if (tl.length) {
    lines.push(repro.tidslinjeRubrik || 'Tidslinje (±10 min):');
    for (const l of tl.slice(0, 14)) lines.push(`  ${l}`);
    if (tl.length > 14) lines.push(`  … ${tl.length - 14} rader till i tidslinje.txt`);
  }
  if (rep.detalj) lines.push(`${rep.belägg && rep.belägg.tidsram === 'variant' ? 'Utslag (variantens klocka):' : 'Utslag:      '} ${rep.detalj.slice(0, 300)}`);
  if (repro.minstaUtslag && repro.minstaUtslag !== rep.detalj) lines.push(`I minsta repro: ${String(repro.minstaUtslag).slice(0, 300)}`);
  if (repro.gräns) lines.push(`Gräns:        ${repro.gräns}`);
  lines.push(`Bekräftelse:  ${repro.bekräftelse || (c.knivsegg ? 'ej krympt; KNIVSEGG (fasberoende).' : 'ej krympt.')}`);
  lines.push(`Register:     ${registryLine(c, registry, rep)}`);
  (card.länkar || []).forEach((l, i) => lines.push(`${i === 0 ? 'Länkar:       ' : '              '}${l.text}`));
  lines.push(`Nästa steg:   ${nextStep(c)}`);
  lines.push('```');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Urval av kort
// ---------------------------------------------------------------------------

const CARD_CLASSES = new Set(['KANDIDAT']);

/** Kluster som ska bli kort (avsnitt 4 och 5), i rapportordning. */
function isFirstCard(c) {
  return c.låstBank || !!(c.fördelning && c.fördelning.taggar && c.fördelning.taggar.KANARIE);
}

function cardClusters(clusters) {
  const låst = clusters.filter((c) => isFirstCard(c) && !c.räknare && CARD_CLASSES.has(c.registerklass));
  const rest = clusters.filter((c) => !isFirstCard(c) && !c.räknare && CARD_CLASSES.has(c.registerklass));
  const order = ['R0', 'bank', 'R1', 'stress'];
  const sections = order.map((nivå) => ({ nivå, kluster: rest.filter((c) => c.nivå === nivå) }));
  const other = rest.filter((c) => !order.includes(c.nivå));
  if (other.length) sections.push({ nivå: 'övrigt', kluster: other });
  return { låst, sections };
}

/**
 * Numrerar korten (högst MAX_KORT i rapport.md) och bestämmer katalognamn.
 * @param {object[]} clusters - sorterade kluster
 * @returns {{kort: object[], överskott: object[], låst: object[], sections: object[]}} urval
 */
function assignCards(clusters) {
  const { låst, sections } = cardClusters(clusters);
  const ordered = [...låst, ...sections.flatMap((s) => s.kluster)];
  const kort = [];
  const överskott = [];
  ordered.forEach((c, i) => {
    if (i < MAX_KORT) {
      const id = `F${String(i + 1).padStart(2, '0')}`;
      kort.push({ id, kluster: c, relKatalog: `fynd/${id}-${slugify(headlineOf(c))}` });
    } else {
      överskott.push(c);
    }
  });
  return {
    kort, överskott, låst, sections,
  };
}

// ---------------------------------------------------------------------------
// Tvillinglänkar (BUGGJAKT §9; runda 2, E8)
// ---------------------------------------------------------------------------

// Korten slås inte ihop — klustringen per mekanism är avsiktlig (§8) — men
// två kort som bär samma apphändelse eller samma mekanism länkas åt båda
// hållen, i rapport.md och rapport.json. Tre relationer:
//   samma-repro    två representanter har samma minsta repro (radhash och
//                  monitoringläge; cluster.reproIdentitet)
//   samma-utslag   klustren delar ett utslag: samma värld eller korpus, bro
//                  och fartyg med överlappande utslagsfönster
//                  (cluster.sammaUtslag). Visas bara där det tillför något
//                  utöver samma-repro.
//   stresstvilling klusternycklarna är lika utan nivån stress
//                  (cluster.utanStress)
const LÄNKTYPER = Object.freeze(['samma-repro', 'samma-utslag', 'stresstvilling']);
const VISADE_UNDERLAG = 4;

/**
 * Kortets representanter i katalogordning: r1 är kortets egen katalog och
 * rN underkatalogen rN/ (writeReport).
 * @param {object} k - kortet
 * @returns {object[]} representanterna
 */
function kortRepresentanter(k) {
  if (Array.isArray(k.representanter) && k.representanter.length) return k.representanter;
  const c = k.kluster;
  if (Array.isArray(c.representanter) && c.representanter.length) return c.representanter;
  return [k.representant || c.fynd[0]].filter(Boolean);
}

/** 'synth|värld:254' → 'värld 254', 'korpus:20260708-21h' → 'korpus 20260708-21h'. */
function underlagText(underlag) {
  const s = String(underlag);
  const i = s.lastIndexOf('|');
  return (i < 0 ? s : s.slice(i + 1)).replace(':', ' ');
}

/** Världens nummer ur en underlagsnyckel (NaN för en korpus). */
function världsnummer(underlag) {
  const m = /värld:(\d+)$/.exec(underlag);
  return m ? Number(m[1]) : NaN;
}

/** Deterministisk ordning för underlag: världar numeriskt, korpusar på namn. */
function cmpUnderlag(a, b) {
  const na = världsnummer(a);
  const nb = världsnummer(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return cmpStr(a, b);
}

/** "1 värld", "14 världar", "2 korpusar". */
function antalText(n, enhet) {
  if (enhet === 'korpus') return `${n} ${n === 1 ? 'korpus' : 'korpusar'}`;
  return `${n} ${n === 1 ? 'värld' : 'världar'}`;
}

/**
 * Samma minsta repro: par av representanter (här, där) med lika identitet.
 * @returns {object[]} [{här, där, underlag, radHash}] med underlagets nyckel
 */
function sammaReproPar(repsA, repsB) {
  const par = [];
  repsA.forEach((fa, ia) => {
    const id = clusterLib.reproIdentitet(fa);
    if (!id) return;
    repsB.forEach((fb, ib) => {
      if (clusterLib.reproIdentitet(fb) !== id) return;
      par.push({
        här: `r${ia + 1}`, där: `r${ib + 1}`, underlag: clusterLib.underlagOf(fa), radHash: fa.repro.recept.radHash,
      });
    });
  });
  return par;
}

/**
 * Samma utslag: underlagen där klustren delar ett utslag, med vilka
 * representanter (här, där) som ingår i ett delat utslag.
 * @returns {Map<string, {här: Set<string>, där: Set<string>}>} per underlag
 */
function sammaUtslagUnderlag(A, B, repsA, repsB) {
  const index = new Map();
  for (const fb of B.kluster.fynd) {
    const p = clusterLib.utslagsplats(fb);
    if (!p) continue;
    if (!index.has(p)) index.set(p, []);
    index.get(p).push(fb);
  }
  const out = new Map();
  for (const fa of A.kluster.fynd) {
    const kandidater = index.get(clusterLib.utslagsplats(fa)) || [];
    for (const fb of kandidater) {
      if (!clusterLib.sammaUtslag(fa, fb)) continue;
      const u = clusterLib.underlagOf(fa);
      if (!out.has(u)) out.set(u, { här: new Set(), där: new Set() });
      const ia = repsA.indexOf(fa);
      const ib = repsB.indexOf(fb);
      if (ia >= 0) out.get(u).här.add(`r${ia + 1}`);
      if (ib >= 0) out.get(u).där.add(`r${ib + 1}`);
    }
  }
  return out;
}

function sammaReproText(annan, par) {
  const detalj = par.map((p) => `${p.här} = ${annan}:s ${p.där} (${p.underlag})`).join('; ');
  return `Samma minsta repro som ${annan} (troligen samma apphändelse): ${detalj}.`;
}

function sammaUtslagText(annan, belägg) {
  // Antalet säger enheten ("i 3 världar"); listan visar världens nummer
  // eller korpusens namn och vilka representanter som ingår.
  const visade = belägg.underlag.slice(0, VISADE_UNDERLAG).map((u) => {
    const vilka = [...u.här.map((r) => `${r} här`), ...u.där.map((r) => `${annan}:s ${r}`)];
    return `${u.underlag.replace(/^(värld|korpus) /, '')}${vilka.length ? ` (${vilka.join(', ')})` : ''}`;
  });
  const fler = belägg.antal > VISADE_UNDERLAG ? ` (+${belägg.antal - VISADE_UNDERLAG})` : '';
  return `Samma utslag som ${annan} i ${antalText(belägg.antal, belägg.enhet)} (troligen samma apphändelse där): ${visade.join(', ')}${fler}.`;
}

/**
 * Bygger kortens tvillinglänkar. Varje länk står på båda korten, med det
 * andra kortets id, och listan sorteras på det andra kortet och typen.
 * Allt härleds ur klustren och representanterna, så länkarna är lika
 * deterministiska som korten.
 * @param {object} urval - assignCards-utfallet (writeReport sätter
 *   k.representanter till de representanter som fick kataloger)
 * @returns {Map<string, object[]>} kort-id → länkar
 */
function kortlänkar(urval) {
  const kort = urval.kort || [];
  const länkar = new Map(kort.map((k) => [k.id, []]));
  const reps = new Map(kort.map((k) => [k.id, kortRepresentanter(k)]));
  const lägg = (k, länk) => länkar.get(k.id).push(länk);
  for (let i = 0; i < kort.length; i++) {
    for (let j = i + 1; j < kort.length; j++) {
      const A = kort[i];
      const B = kort[j];
      const repsA = reps.get(A.id);
      const repsB = reps.get(B.id);
      const par = sammaReproPar(repsA, repsB);
      if (par.length) {
        const förA = par.map((p) => ({ ...p, underlag: underlagText(p.underlag) }));
        const förB = förA.map((p) => ({ ...p, här: p.där, där: p.här }));
        lägg(A, {
          typ: 'samma-repro', kort: B.id, nyckel: B.kluster.nyckel, text: sammaReproText(B.id, förA), belägg: { par: förA },
        });
        lägg(B, {
          typ: 'samma-repro', kort: A.id, nyckel: A.kluster.nyckel, text: sammaReproText(A.id, förB), belägg: { par: förB },
        });
      }
      const delade = sammaUtslagUnderlag(A, B, repsA, repsB);
      const reproUnderlag = new Set(par.map((p) => p.underlag));
      // Samma utslag visas bara där det tillför något utöver samma repro.
      if (!delade.size || [...delade.keys()].every((u) => reproUnderlag.has(u))) continue;
      const harRep = (u) => (u.här.length || u.där.length ? 1 : 0);
      const belägg = (sida) => {
        const motsida = sida === 'här' ? 'där' : 'här';
        const lista = [...delade.entries()]
          .map(([underlag, v]) => ({ underlag, här: [...v[sida]].sort(), där: [...v[motsida]].sort() }))
          // Underlag med representanter först (de syns på korten), sedan resten.
          .sort((a, b) => (harRep(b) - harRep(a)) || cmpUnderlag(a.underlag, b.underlag));
        return {
          antal: lista.length,
          enhet: lista.every((u) => u.underlag.startsWith('korpus:')) ? 'korpus' : 'värld',
          underlag: lista.map((u) => ({ underlag: underlagText(u.underlag), här: u.här, där: u.där })),
        };
      };
      const förA = belägg('här');
      const förB = belägg('där');
      lägg(A, {
        typ: 'samma-utslag', kort: B.id, nyckel: B.kluster.nyckel, text: sammaUtslagText(B.id, förA), belägg: förA,
      });
      lägg(B, {
        typ: 'samma-utslag', kort: A.id, nyckel: A.kluster.nyckel, text: sammaUtslagText(A.id, förB), belägg: förB,
      });
    }
  }
  // Stresstvillingar: samma nyckel utan nivån stress. Tvillingen kan ligga
  // bland klustren utanför de MAX_KORT korten; då saknar länken kort-id.
  const kortAv = new Map(kort.map((k) => [k.kluster.nyckel, k]));
  const alla = [...kort.map((k) => k.kluster), ...(urval.överskott || [])];
  for (const k of kort) {
    const egen = k.kluster.nyckel;
    const tvilling = alla.find((c) => c.nyckel !== egen && clusterLib.utanStress(c.nyckel) === clusterLib.utanStress(egen));
    if (!tvilling) continue;
    const tk = kortAv.get(tvilling.nyckel);
    lägg(k, {
      typ: 'stresstvilling',
      kort: tk ? tk.id : null,
      nyckel: tvilling.nyckel,
      text: tk ? `Stresstvilling till ${tk.id} (samma mekanism).`
        : `Stresstvilling till klustret ${tvilling.mekanism}${nivåTillägg(tvilling)} (samma mekanism; utanför de ${MAX_KORT} korten, finns i rapport.json).`,
      belägg: { mekanism: tvilling.mekanism, nivå: tvilling.nivå },
    });
  }
  for (const lista of länkar.values()) {
    lista.sort((a, b) => cmpStr(a.kort || `~${a.nyckel}`, b.kort || `~${b.nyckel}`) || (LÄNKTYPER.indexOf(a.typ) - LÄNKTYPER.indexOf(b.typ)));
  }
  return länkar;
}

/**
 * Länköversikten överst i avsnittet Kandidater: varje länkat par en gång.
 * @param {object} urval - assignCards-utfallet
 * @param {Map<string, object[]>} länkar - kortlänkar(urval)
 * @returns {string[]} markdownrader (tom lista utan länkar)
 */
function länköversikt(urval, länkar) {
  const par = new Map();
  for (const k of urval.kort || []) {
    for (const l of länkar.get(k.id) || []) {
      const andra = l.kort || `klustret ${l.belägg.mekanism}`;
      if (l.kort && cmpStr(l.kort, k.id) < 0) continue;
      const nyckel = `${k.id} ↔ ${andra}`;
      if (!par.has(nyckel)) par.set(nyckel, []);
      if (l.typ === 'samma-repro') par.get(nyckel).push('samma minsta repro (troligen samma apphändelse)');
      else if (l.typ === 'samma-utslag') par.get(nyckel).push(`samma utslag i ${antalText(l.belägg.antal, l.belägg.enhet)} (troligen samma apphändelse där)`);
      else par.get(nyckel).push('stresstvillingar (samma mekanism)');
    }
  }
  if (!par.size) return [];
  const L = ['Länkade kort (korten slås inte ihop; triagera dem tillsammans, se BUGGJAKT §9):'];
  for (const [nyckel, typer] of par) L.push(`- ${nyckel}: ${typer.join('; ')}.`);
  L.push('');
  return L;
}

// ---------------------------------------------------------------------------
// rapport.json
// ---------------------------------------------------------------------------

function publicFinding(f) {
  const out = { ...f };
  if (out.repro) {
    out.repro = { ...out.repro };
    if (Array.isArray(out.repro.filer)) out.repro.filer = out.repro.filer.map((x) => ({ till: x.till }));
  }
  return out;
}

function fingerprintOf(c) {
  const units = [...new Set(c.fynd.map((f) => {
    const u = f.ursprung || {};
    return u.korpus ? `k:${u.korpus}` : `v:${u.värld}`;
  }))].sort();
  return sha12(`${c.nyckel}|${units.join(',')}`);
}

/**
 * Bygger rapport.json-objektet.
 * @param {object} körning - körningsobjektet efter fas 3
 * @param {object} urval - assignCards-utfallet
 * @returns {object} rapport
 */
function buildReportJson(körning, urval) {
  const cardOf = new Map(urval.kort.map((k) => [k.kluster.nyckel, k]));
  const länkar = urval.länkar || kortlänkar(urval);
  const reg = körning.register;
  const det = {
    format: FORMAT,
    motorversion: körning.motorversion,
    körning: {
      head: körning.git && körning.git.före ? körning.git.före.sha : null,
      arbetsträdÄndrat: körning.git && körning.git.före ? körning.git.före.ändrat : null,
      node: process.version,
      plattform: `${process.platform} ${process.arch}`,
      profil: körning.profil.namn,
      seed: körning.seed,
      spår: körning.spår,
      korpusar: (körning.korpusar || []).map((c) => c.id),
      delmängd: !!körning.delmängd,
      körningsId: körning.körningsId,
      flaggor: körning.flaggorDeterministiska || {},
      avkortad: !!körning.avkortad,
      avkortning: körning.avkortning || [],
    },
    hälsa: körning.hälsa,
    sammanfattning: körning.sammanfattning || [],
    kluster: körning.kluster.map((c) => ({
      ...c,
      fingeravtryck: fingerprintOf(c),
      kort: cardOf.has(c.nyckel) ? cardOf.get(c.nyckel).id : null,
      // Tvillinglänkar (§9): bara korten har länkar; övriga kluster en tom lista.
      länkar: cardOf.has(c.nyckel) ? (länkar.get(cardOf.get(c.nyckel).id) || []) : [],
      katalog: cardOf.has(c.nyckel) ? cardOf.get(c.nyckel).relKatalog : ((urval.exempel && urval.exempel.get(c.nyckel)) || {}).relKatalog || null,
      representanter: (c.representanter || []).map((f) => c.fynd.indexOf(f)),
      fynd: c.fynd.map(publicFinding),
    })),
    register: reg ? {
      användning: reg.användning,
      oanvända: reg.unused(),
      iOraklet: typeof reg.iOraklet === 'function' ? reg.iOraklet() : [],
      varningar: reg.varningar,
    } : null,
    täckning: körning.täckning || {},
    motorfel: körning.motorfel || [],
  };
  det.fingeravtryck = sha12(stableStringify(det));
  return { ...det, tid: körning.tid || {} };
}

// ---------------------------------------------------------------------------
// rapport.md
// ---------------------------------------------------------------------------

function healthLines(h) {
  const L = [];
  const st = h.självtest || {};
  L.push(`- **Självtest:** ${st.status || 'EJ KÖRT'}${st.text ? ` — ${st.text}` : ''}.`);
  for (const s of st.stopp || []) L.push(`  - stopp: ${s}`);
  if (h.instrument) L.push(`- **Instrumentkrav i banken:** ${h.instrument.ok ? 'uppfyllda' : 'BRUTNA'} (${(h.instrument.krav || []).map((k) => `${k.namn} ${k.värde}`).join(', ')}).`);
  if (h.låstBank) L.push(`- **Låst bank:** ${h.låstBank.text}.`);
  if (h.h3Baslinje) {
    const sigs = Object.keys(h.h3Baslinje.signaturer || {});
    const list = sigs.length ? `: ${sigs.map((s) => `\`${s}\``).join(', ')}` : '';
    L.push(`- **H3-baslinje:** ${sigs.length} signatur(er) över ${fmtNum(h.h3Baslinje.timmar, 1)} simulerade timmar (båda bankvarven)${list}.`);
  }
  L.push(`- **Bankkalibrering (S-KALIBRERING):** ${(h.kalibrering && h.kalibrering.text) || 'ej inkopplad i den här versionen'}.`);
  L.push(`- **Kanarier och rundresa:** ${(h.kanarier && h.kanarier.text) || 'ej inkopplade (hör till sanningsspåret)'}.`);
  L.push(`- **R1:s realismnivå:** ${(h.realism && h.realism.text) || 'robusthet (okalibrerad i v1)'}.`);
  if (h.synt) L.push(`- **Sanningsspårets determinism:** ${h.synt.text}.`);
  if (h.git) L.push(`- **Git-vakt:** ${h.git.text}.`);
  if (h.miljö) L.push(`- **Miljöskrubb:** ${h.miljö.text}.`);
  for (const v of h.varningar || []) L.push(`- Varning: ${v}`);
  return L;
}

function knownOutcomeLines(clusters, registry) {
  const known = clusters.filter((c) => !['KANDIDAT', 'KONFLIKT', 'MÄTGRÄNS', 'INSTRUMENTFEL'].includes(c.registerklass));
  const L = [];
  if (!known.length) L.push('Inga kända utfall i den här körningen.');
  else {
    L.push('| Post | Klass | Mekanism | Utslag | Oberoende | Fördelning |');
    L.push('|---|---|---|---|---|---|');
    for (const c of known) {
      const deltas = Object.keys(c.fördelning.delta || {}).map(Number).sort((a, b) => a - b);
      const dist = [distText(c.fördelning.korpus, 3), distText(c.fördelning.bro, 2), deltas.length ? `δ ${deltas.map(fmtDelta).join(', ')} s` : ''];
      L.push(`| ${c.post} | ${c.registerklass} | ${cell(c.mekanism)}${nivåTillägg(c)} | ${c.antal} | ${c.oberoende} | ${cell(dist.filter(Boolean).join('; '))} |`);
    }
  }
  if (registry) {
    const unused = registry.unused();
    const measurable = unused.filter((u) => !u.omätbar).map((u) => u.id);
    const omätbara = unused.filter((u) => u.omätbar).map((u) => u.id);
    // Poster som oraklen tillämpar själva (verkan iOraklet) kan aldrig
    // matcha; de räknas inte som oanvända utan redovisas för sig (M12).
    const iOraklet = typeof registry.iOraklet === 'function' ? registry.iOraklet() : [];
    const prövbara = typeof registry.prövbara === 'function' ? registry.prövbara() : registry.poster.length;
    L.push('');
    const omätText = omätbara.length ? `. Omätbara i v1: ${omätbara.join(', ')}` : '';
    L.push(`Oanvända poster (${unused.length} av ${prövbara}; många gäller spår som inte kördes): ${measurable.join(', ') || 'inga'}${omätText}.`);
    if (iOraklet.length) {
      L.push(`Poster som oraklen tillämpar själva (verkan iOraklet; prövas inte av registret och räknas inte som oanvända): ${iOraklet.map((e) => `${e.id} (${e.gäller.join(', ')})`).join(', ')}.`);
    }
    for (const w of registry.varningar || []) L.push(`- Registervarning: ${w}`);
  }
  return L;
}

function decisionLines(clusters, registry, exempel = new Map()) {
  const L = [];
  const qs = clusters.filter((c) => c.registerklass === 'KONFLIKT' || c.registerklass === 'KÄND_ÖPPEN');
  if (!qs.length) {
    L.push('Inga beslutsfrågor aktualiserades i den här körningen.', '');
    return L;
  }
  for (const c of qs) {
    const e = registry ? registry.entry(c.post) : null;
    L.push(`### ${c.post} · ${c.registerklass}${c.nivå === 'stress' ? ' · stress' : ''} — ${headlineOf(c)}`);
    L.push(`- Förekomst: ${occurrenceText(c)} (${c.antal} utslag)`);
    if (e && Array.isArray(e.doktriner)) e.doktriner.forEach((d, i) => L.push(`- Doktrin ${i + 1}: ${d.text} (${d.källa})`));
    else if (e) L.push(`- Regel: ${e.regel} (${e.källa})`);
    if (e && e.fråga) L.push(`- **Fråga:** ${e.fråga}`);
    const ex = exempel.get(c.nyckel);
    if (ex) {
      const r = ex.representant.repro || {};
      L.push(`- Exempel (${r.krympt ? 'minsta repro' : 'underlag'}): \`${ex.relKatalog}\` — ${r.underlag || ''}`);
      if (r.gräns) L.push(`- Gräns: ${r.gräns}`);
      if (r.bekräftelse) L.push(`- Bekräftelse: ${r.bekräftelse}`);
    }
    L.push('');
  }
  return L;
}

function instrumentLines(clusters, körning) {
  const L = [];
  const ins = clusters.filter((c) => c.registerklass === 'INSTRUMENTFEL' || c.registerklass === 'MÄTGRÄNS');
  for (const c of ins) {
    const vad = `${c.post || c.mekanism}${c.post === 'BEKRÄFTELSE' ? ` (${c.mekanism})` : ''}${nivåTillägg(c)}`;
    L.push(`- ${c.registerklass} · ${vad}: ${c.antal} utslag (${occurrenceText(c)})${c.instrumentfel ? ` — ${c.instrumentfel}` : ''}`);
  }
  for (const m of körning.motorfel || []) L.push(`- MOTORFEL · ${m}`);
  if (!L.length) L.push('Inga instrumentfel eller mätgränser i den här körningen.');
  return L;
}

const V1_PRÖVAR_INTE = [
  'transportlagret (AISStreamClient, AISHubClient, muxens källhälsa)',
  'inställningsändringar under körning',
  'klocksteg',
  'krasch utan flush',
  'plattformsfel i kort, token och enheter',
  'fusion av två källor',
  'P8/L6 (omätbart i standardreplay)',
  'ETA-noggrannhet per båt (T7), spöktext per båt (T5) och utgånget ETA-löfte (T8)',
  'artefakter från den synkrona ticken (tickAsync)',
  'sträckmålen: omstart (T11, F-OMSTART), liveness (T6), isolering (M-ISO), textepisoder i M-FAS, adversariell radio (R2), NAME/QR, krympning av bankfynd, nya radiodragningar i bekräftelsen',
];

function coverageLines(körning) {
  const L = [];
  const t = körning.täckning || {};
  if (Array.isArray(t.rader) && t.rader.length) {
    L.push('| Spår | Orakel/relation | Profil | Prövat | Utslag | Tyst |');
    L.push('|---|---|---|---|---|---|');
    for (const r of t.rader) L.push(`| ${cell(r.spår)} | ${cell(r.orakel)} | ${cell(r.profil || '—')} | ${r.prövat} | ${r.utslag} | ${r.prövat - r.utslag} |`);
  } else {
    L.push('Ingen täckningsdata (inga spår utöver självtestet kördes).');
  }
  if (t.räknare && Object.keys(t.räknare).length) {
    L.push('');
    L.push('Räknare (ger aldrig kort i v1):');
    for (const [k, v] of Object.entries(t.räknare).sort()) L.push(`- ${k}: ${v}`);
  }
  for (const s of t.saknadeSpår || []) L.push(`- Spåret ${s} är inte inkopplat i den här versionen och prövades inte.`);
  L.push('');
  L.push(`Vad v1 inte prövar: ${V1_PRÖVAR_INTE.join('; ')}.`);
  return L;
}

/**
 * Renderar rapport.md.
 * @param {object} körning - körningsobjektet
 * @param {object} urval - assignCards-utfallet (med absoluta kortkataloger)
 * @returns {string} markdown
 */
function renderReportMd(körning, urval) {
  const L = [];
  const g = (körning.git && körning.git.före) || {};
  const tid = körning.tid || {};
  L.push(`# Buggjägarens rapport — ${körning.profil.namn}, seed ${körning.seed}${körning.avkortad ? ' (AVKORTAD)' : ''}`);
  L.push('');
  L.push('Motorn rapporterar bara: den rättar ingenting, låser aldrig om facit och ändrar inte registret. Ett fynd är en kandidat tills du har triagerat det.');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| HEAD | ${g.finns ? `${g.sha7}${g.ändrat ? ' (arbetsträdet ÄNDRAT)' : ' (arbetsträdet orört)'}` : `git saknas (${g.skäl || 'okänt'})`} |`);
  L.push(`| Node | ${process.version} (${process.platform} ${process.arch}) |`);
  const rep = körning.profil.representanter;
  L.push(`| Profil | ${körning.profil.namn} (δ = ${körning.profil.fasDeltaS.map(fmtDelta).join(', ')} s; representanter ${rep.kluster} × ${rep.perKluster}) |`);
  L.push(`| Seed | ${körning.seed} |`);
  const saknade = (körning.täckning && körning.täckning.saknadeSpår) || [];
  L.push(`| Spår | ${(körning.spår || []).join(', ') || '—'}${saknade.length ? ` (ej inkopplat: ${saknade.join(', ')})` : ''} |`);
  L.push(`| Underlag | ${(körning.underlag && körning.underlag.text) || '—'} |`);
  L.push(`| Väggtid | ${fmtDuration(tid.väggtidMs)} |`);
  L.push(`| Körnings-id | ${körning.körningsId} |`);
  L.push('');
  L.push('## Hälsa');
  L.push('');
  L.push(...healthLines(körning.hälsa || {}));
  L.push('');
  L.push('## Sammanfattning');
  L.push('');
  for (const s of körning.sammanfattning || []) L.push(`- ${s}`);
  L.push('');
  const cardById = new Map(urval.kort.map((k) => [k.kluster.nyckel, k]));
  const länkar = urval.länkar || kortlänkar(urval);
  const renderList = (list) => {
    const out = [];
    for (const c of list) {
      const k = cardById.get(c.nyckel);
      if (k) out.push(renderCard({ ...k, länkar: länkar.get(k.id) || [] }, körning.register), '');
    }
    return out;
  };
  L.push('## Nya träffar på låst bank och kanarier');
  L.push('');
  if (urval.låst.length) L.push(...renderList(urval.låst));
  else L.push('Inga nya träffar på den låsta banken och inga brutna kanarieförväntningar.', '');
  L.push('## Kandidater');
  L.push('');
  L.push(...länköversikt(urval, länkar));
  const titles = {
    R0: 'Logikfel (R0, idealradio)', bank: 'Bank (KNIVSEGG-taggade fasutslag)', R1: 'Robusthet (R1, fältlik radio — okalibrerad)', stress: 'Stress (täthet över fältets svans)', övrigt: 'Övrigt',
  };
  let any = false;
  for (const s of urval.sections) {
    if (!s.kluster.length) continue;
    any = true;
    L.push(`### ${titles[s.nivå] || s.nivå}`);
    L.push('');
    L.push(...renderList(s.kluster));
  }
  if (!any) L.push('Inga kandidater i den här körningen.', '');
  if (urval.överskott.length) {
    L.push(`Ytterligare ${urval.överskott.length} kluster ryms inte bland de ${MAX_KORT} korten och finns i rapport.json: ${urval.överskott.map((c) => `${c.mekanism}${nivåTillägg(c)}`).join('; ')}.`);
    L.push('');
  }
  L.push('## Beslutsfrågor och konflikter');
  L.push('');
  L.push(...decisionLines(körning.kluster, körning.register, urval.exempel || new Map()));
  L.push('## Kända utfall');
  L.push('');
  L.push(...knownOutcomeLines(körning.kluster, körning.register));
  L.push('');
  L.push('## Instrumentfel och mätgränser');
  L.push('');
  L.push(...instrumentLines(körning.kluster, körning));
  L.push('');
  L.push('## Täckning');
  L.push('');
  L.push(...coverageLines(körning));
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Skrivning
// ---------------------------------------------------------------------------

function writeCardDir(dir, rep, cluster) {
  fs.mkdirSync(dir, { recursive: true });
  const repro = rep.repro || {};
  for (const f of repro.filer || []) {
    if (f.från && fs.existsSync(f.från)) copyFile(fs, f.från, path.join(dir, f.till));
  }
  if (repro.recept) fs.writeFileSync(path.join(dir, 'recept.json'), stableStringify(repro.recept));
  const full = (repro.tidslinjeFull && repro.tidslinjeFull.length) ? repro.tidslinjeFull : (repro.tidslinje || []);
  if (full.length) fs.writeFileSync(path.join(dir, 'tidslinje.txt'), `${repro.tidslinjeRubrik ? `${repro.tidslinjeRubrik}\n` : ''}${full.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'kommando.txt'), `${(repro.kommandon || []).map((k) => substitute(k, dir)).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'fynd.json'), stableStringify({ mekanism: cluster.mekanism, nyckel: cluster.nyckel, fynd: cluster.fynd.map(publicFinding) }));
}

/**
 * Skriver hela rapporten till körningens utkatalog. En tidigare motorkörning
 * i samma katalog töms först (fynd/, rapport.md, rapport.json), så att inga
 * gamla Fnn-, Bnn- eller r2-kataloger blir kvar; en katalog med annat
 * innehåll vägras (hygiene.checkOutDir). senaste.txt skrivs bara i motorns
 * egna baskataloger — med --out skrivs ingenting utanför utkatalogen.
 * @param {object} körning - körningsobjektet (kluster, hälsa, ut, register …)
 * @param {{representanter?: Function}} [opts] - väljare av representanter per kluster
 * @returns {{md: string, json: string, kort: object[]}} sökvägar
 */
function writeReport(körning, { representanter = (c) => [c.fynd[0]] } = {}) {
  const outDir = körning.ut.dir;
  hygiene.prepareOutDir(outDir, { format: FORMAT });
  const urval = assignCards(körning.kluster);
  for (const k of urval.kort) {
    k.katalog = path.join(outDir, k.relKatalog);
    const reps = representanter(k.kluster);
    k.representant = reps[0] || k.kluster.fynd[0];
    // Länkarna (kortlänkar) pekar på de här katalogerna: r1 är kortets
    // egen katalog och rN underkatalogen rN/.
    k.representanter = reps.length ? reps : [k.representant];
    reps.forEach((rep, i) => writeCardDir(i === 0 ? k.katalog : path.join(k.katalog, `r${i + 1}`), rep, k.kluster));
  }
  urval.länkar = kortlänkar(urval);
  // Beslutsfrågor och konflikter med en krympt representant får en
  // exempelkatalog fynd/Bnn-<post>/ (de är inga kort, men ägaren behöver reprot).
  urval.exempel = new Map();
  let b = 0;
  for (const c of körning.kluster) {
    if (c.registerklass !== 'KONFLIKT' && c.registerklass !== 'KÄND_ÖPPEN') continue;
    const rep = (c.representanter || []).find((f) => f.repro && f.repro.krympt);
    if (!rep) continue;
    b++;
    const relKatalog = `fynd/B${String(b).padStart(2, '0')}-${slugify(`${c.post} ${headlineOf(c)}`)}`;
    const katalog = path.join(outDir, relKatalog);
    writeCardDir(katalog, rep, c);
    urval.exempel.set(c.nyckel, { relKatalog, katalog, representant: rep });
  }
  const json = buildReportJson(körning, urval);
  const jsonPath = path.join(outDir, 'rapport.json');
  fs.writeFileSync(jsonPath, stableStringify(json));
  const mdPath = path.join(outDir, 'rapport.md');
  fs.writeFileSync(mdPath, renderReportMd(körning, urval));
  const senaste = hygiene.senastePath(körning.ut);
  if (senaste) {
    fs.mkdirSync(path.dirname(senaste), { recursive: true });
    fs.writeFileSync(senaste, `${path.relative(path.dirname(senaste), outDir)}\n`);
  }
  return { md: mdPath, json: jsonPath, kort: urval.kort };
}

/** rapport.json utan tidsblocket (för determinismjämförelser). */
function withoutTime(reportJson) {
  const { tid, ...rest } = reportJson;
  return rest;
}

module.exports = {
  FORMAT,
  ORAKEL_TEXT,
  V1_PRÖVAR_INTE,
  fmtNum,
  fmtInt,
  fmtDelta,
  fmtClock,
  fmtDuration,
  slugify,
  stableStringify,
  markeraAvkortad,
  avkortadIFas,
  registerOracleText,
  headlineOf,
  renderCard,
  assignCards,
  kortlänkar,
  buildReportJson,
  renderReportMd,
  writeReport,
  withoutTime,
};
