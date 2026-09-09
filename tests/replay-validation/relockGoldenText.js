'use strict';

/**
 * relockGoldenText — PERMANENT omlåsningsverktyg för golden-text-dimensionen
 * (tillkom 2026-08-10, P9-omlåsningen; ersätter det sessionsberoende
 * omlas-golden.js som försvann med sin /tmp-katalog).
 *
 * ANVÄNDNING: node tests/replay-validation/relockGoldenText.js <korpusId...>
 *
 * JÄRNGRINDEN (järnregel §6.1-6.2): verktyget skriver ENDAST golden-text.
 * Före skrivning verifieras att ALLA övriga facitdimensioner är EXAKT intakta:
 *   1. processfel  (result.processErrors)          — måste vara 0
 *   2. fartygsläcka (result.leakDiagnostics.vessels) — måste vara 0
 *   3. notisantal  (result.notificationCount)      — == corpus.expectedNotifications
 *   4. fördelningsmultiset  (mmsi:bro)             — post MÅSTE finnas
 *   5. riktningsmultiset    (mmsi:bro:riktning)    — post MÅSTE finnas
 *   6. öppningsmultiset     (bro:riktning)         — post MÅSTE finnas, utom
 *                                                    vid lockOpenings:false
 *   7. FATALA invarianter (validateInvariants) — VARJE utslag måste
 *      prefixmatcha korpusens knownInvariantExceptions, annars ABORT.
 * Diffar någon av dem avbryts HELA körningen utan att någon fil skrivits.
 * Omlåsningen ska alltid åtföljas av en not i corpora.js (datum + mekanism +
 * rådatabevis).
 *
 * HÄRDNING 2026-08-10 (WS3-fynd F5, "järngrinden svagare än runAllCorpora"):
 * punkterna 1, 2 och 7 SAKNADES, och saknad fördelnings-/riktnings-/
 * öppningspost gjorde gaten tyst överhoppad (`|| {}`) i stället för hårt fel.
 * Det öppnade exakt det hål R2-1-lärdomen skrevs för: ett kompenserande fel
 * (miss + fantom, eller en krasch i notisvägen) som summerar lika passerade
 * alla multiset — och verktyget skrev då om golden-filen, dvs. raderade den
 * ENDA kvarvarande signalen om regressionen. Kontrollerna nedan läser samma
 * fält, i samma form, som runAllCorpora.js:112-262; ändras den ena MÅSTE den
 * andra följa med.
 *
 * ATOMICITET (samma härdning): validering och skrivning är TVÅ FASER. Tidigare
 * skrev loopen fil N innan korpus N+1 ens hade körts, så en abort mitt i en
 * flerkorpuskörning lämnade facit halvskrivet — tvärtemot vad docblocken lovar.
 * Nu valideras samtliga mål först; först när alla är gröna skrivs filerna.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const corpora = require(path.join(BASE, 'corpora'));
const distribution = require(path.join(BASE, 'corpora-distribution.json'));
const directions = require(path.join(BASE, 'corpora-direction-distribution.json'));
const openings = require(path.join(BASE, 'opening-distribution.json'));
const { validateInvariants } = require(path.join(BASE, 'invariants'));
const { openingDeliveryFailures } = require('./openingDelivery');
const { eventFacitFailures } = require('./eventFacit');

const TARGETS = process.argv.slice(2);
if (TARGETS.length === 0) {
  console.error('Ange korpus-id:n att omlåsa, t.ex.: node relockGoldenText.js 20260601-41h');
  process.exit(1);
}

// Jämförelserna nedan är AVSIKTLIGT identiska med runAllCorpora.js — samma
// nyckelformat, samma multisetlogik — så att verktygets grind aldrig kan vara
// svagare (eller strängare på fel sätt) än den riktiga gaten.
const countBy = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** ABORT: skriver felet och avslutar UTAN att någon fil har skrivits. */
function abort(id, msg) {
  console.error(`ABORT ${id}: ${msg}`);
  process.exit(1);
}

// ---- FAS 1: kör och validera SAMTLIGA mål. Ingen fil skrivs här. ----
const pending = [];
for (const id of TARGETS) {
  const corpus = corpora.find((c) => c.id === id);
  if (!corpus) {
    console.error(`SAKNAS i corpora: ${id}`);
    process.exit(1);
  }
  if (!corpus.locked) abort(id, 'korpusen är inte låst — golden-text-omlåsning gäller låsta korpusar');
  if (corpus.fusionOf) abort(id, 'fusionskorpus — golden-text valideras inte för fusionOf (se runAllCorpora)');
  const stdout = execFileSync('node', [path.join(BASE, 'replayRunner.js'), corpus.jsonl], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000,
  });
  const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
  if (!m) {
    console.error(`Ingen JSON-markör: ${id}`);
    process.exit(1);
  }
  const result = JSON.parse(m[1]);
  const deliveryErrors = openingDeliveryFailures(result);
  if (deliveryErrors.length) abort(id, deliveryErrors.join('; '));
  if (corpus.lockEvents) {
    const eventPath = path.join(BASE, 'golden-events', `${id}.json`);
    if (!fs.existsSync(eventPath)) abort(id, 'GOLDEN-EVENTS saknas');
    const differences = eventFacitFailures(result, JSON.parse(fs.readFileSync(eventPath, 'utf8')));
    if (differences.length) abort(id, differences.join('; '));
  }
  // Icke-fusionskorpus (gaten ovan) ⇒ distKey === id; skrivsättet behålls
  // identiskt med runAllCorpora:130 så att de inte kan glida isär.
  const distKey = corpus.fusionOf || corpus.id;

  // HÅRDA GRINDAR — allt utom golden-text måste vara exakt.

  // (1) Processfel. runAllCorpora:113-116: fältet är ett TAL — den gamla
  // `(... || []).length`-formen gav undefined och gjorde kontrollen DÖD, så
  // krascher i _processAISMessage flaggades aldrig. Läs det som ett tal.
  const processErrors = result.processErrors || 0;
  if (processErrors > 0) abort(id, `${processErrors} processfel i replayn — facit får inte låsas om från en körning som kastat`);

  // (2) Fartygsläcka. runAllCorpora:118-123 kräver EXAKT 0 kvar efter
  // efterspelet; undefined (fältet borta) är också fel — då är kontrollen död.
  const leaks = result.leakDiagnostics || {};
  const vesselsLeft = leaks.vessels;
  if (vesselsLeft !== 0) abort(id, `${vesselsLeft} fartyg kvar efter efterspel (leakDiagnostics.vessels måste vara 0)`);

  // (3) Notisantal. Samma fält som runAllCorpora:112.
  const notis = result.notificationCount;
  if (notis !== corpus.expectedNotifications) {
    abort(id, `notiser ${notis} ≠ ${corpus.expectedNotifications}`);
  }

  // (4) Fördelningsmultiset. Saknad post = HÅRT fel (R2-1-lärdomen: en gate
  // som tyst hoppas över är farligare än ingen gate). Det gamla `|| {}` gjorde
  // en postlös korpus tyst OK så snart den råkade ge noll notiser.
  if (!distribution[distKey]) {
    abort(id, `FÖRDELNINGSPOST SAKNAS i corpora-distribution.json (distKey=${distKey}) — multiset-gaten kan inte köras`);
  }
  const expectedDist = Object.entries(distribution[distKey])
    .flatMap(([mmsi, bridges]) => bridges.map((b) => `${mmsi}:${b}`)).sort();
  const actualDist = (result.notifications || []).map((n) => `${n.mmsi}:${n.bridge}`).sort();
  if (JSON.stringify(actualDist) !== JSON.stringify(expectedDist)) {
    abort(id, 'fördelningsmultiset avviker');
  }

  // (5) Riktningsmultiset. Saknad post = HÅRT fel av samma skäl.
  if (!directions[distKey]) {
    abort(id, `RIKTNINGSPOST SAKNAS i corpora-direction-distribution.json (distKey=${distKey}) — riktningsgaten kan inte köras`);
  }
  const actualDir = countBy((result.notifications || [])
    .map((n) => `${n.mmsi}:${n.bridge}:${n.direction || 'unknown'}`));
  const expectedDir = new Map(Object.entries(directions[distKey]));
  if (!mapsEqual(actualDir, expectedDir)) {
    abort(id, 'riktningsmultiset avviker');
  }

  // (6) Öppningsmultiset. `lockOpenings: false` (A9a) låser ALLT UTOM
  // öppningsdimensionen — då finns posten medvetet inte och gaten hoppas över.
  // I alla andra fall är saknad post ett HÅRT fel.
  if (corpus.lockOpenings !== false) {
    if (!openings[distKey]) {
      abort(id, `ÖPPNINGSPOST SAKNAS i opening-distribution.json (distKey=${distKey}) — öppningsgaten kan inte köras`);
    }
    const actualOpen = countBy((result.openingWarnings || [])
      .map((w) => `${w.bridge}:${w.direction || 'unknown'}`));
    const expectedOpen = new Map(Object.entries(openings[distKey]));
    if (!mapsEqual(actualOpen, expectedOpen)) {
      abort(id, 'öppningsmultiset avviker');
    }
  }

  // (7) FATALA invarianter (runAllCorpora:232-260). Multiseten är
  // strukturellt blinda för hela klasser av fel — INV-1 grammatik, INV-2
  // notisdubbletter/tokens, INV-5/7 räkningsbaserade målbropassager, INV-6,
  // INV-8, INV-11, INV-12, INV-16 — och just golden-TEXTEN är den dimension
  // verktyget skriver över. Ett utslag får bara passera om det prefixmatchar
  // korpusens knownInvariantExceptions (FP9: rådataverifierat designenliga
  // förlopp, motiverade i corpora.js-noten). Allt annat fäller, med utskrift.
  const knownExceptions = Array.isArray(corpus.knownInvariantExceptions)
    ? corpus.knownInvariantExceptions : [];
  const violations = validateInvariants(result);
  const knownHits = violations.filter((v) => knownExceptions.some((k) => v.startsWith(k)));
  const liveViolations = violations.filter((v) => !knownExceptions.some((k) => v.startsWith(k)));
  if (knownHits.length > 0) {
    console.log(`  ℹ️ ${id}: ${knownHits.length} KÄNDA invariantutslag (rådataverifierade, se corpora.js):`);
    for (const v of knownHits) console.log(`     ${v}`);
  }
  if (liveViolations.length > 0) {
    console.error(`ABORT ${id}: ${liveViolations.length} FATALA invariantbrott — golden får inte låsas om:`);
    for (const v of liveViolations) console.error(`   INVARIANT: ${v}`);
    process.exit(1);
  }

  const golden = (result.bridgeTextTransitions || []).map((t) => ({ iso: t.iso, text: t.text }));
  const goldenPath = path.join(BASE, 'golden-text', `${id}.json`);
  if (!fs.existsSync(goldenPath)) {
    abort(id, `golden-text/${id}.json saknas — verktyget låser OM befintligt facit, det skapar inte nytt`);
  }
  const old = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  pending.push({
    id, goldenPath, golden, oldLength: old.length, notis,
  });
  console.log(`   ✓ ${id}: grind godkänd (notiser ${notis} = facit, multiset exakta, 0 processfel, 0 läckta fartyg, 0 fatala invariantbrott)`);
}

// ---- FAS 2: alla mål är gröna — skriv. ----
let wrote = 0;
for (const p of pending) {
  fs.writeFileSync(p.goldenPath, `${JSON.stringify(p.golden, null, 1)}\n`);
  console.log(`✅ ${p.id}: golden ${p.oldLength} → ${p.golden.length} övergångar`);
  wrote++;
}
console.log(`\n${wrote}/${TARGETS.length} goldens omlåsta.`);
