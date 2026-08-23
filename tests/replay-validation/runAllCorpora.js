'use strict';

/**
 * Multikorpus-replay (2026-06-10): kör replayRunner mot SAMTLIGA korpusar i
 * corpora.js (~100h produktionsdata) och validerar mot facit.
 *
 * Användning:  node tests/replay-validation/runAllCorpora.js   (från io.ais.tracker/)
 * Exit-kod:    0 om alla LÅSTA korpusar matchar facit och inga processfel,
 *              1 annars. Olåsta korpusar rapporteras informativt.
 *
 * Detta är den proaktiva regressionsgaten för pelarna: körs efter VARJE
 * ändring i status-/notis-/text-/livscykellogik, före commit.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const corpora = require('./corpora');
const { validateInvariants, validateWarnInvariants } = require('./invariants');
// Fördelningsfacit (2026-07-01): totalsumman räcker inte — en missad notis +
// en fantomnotis ger samma summa (kompenserande fel). Multiset:en av
// (mmsi,bro)-par låses per korpus; regenerera MEDVETET (med motivering i
// corpora.js-noten) via en verifierad körning när facit ändras.
const distribution = require('./corpora-distribution.json');
// Riktningsfacit (testauditen 2026-07-10, TA2): (mmsi,bro)-multiseten är
// blind för riktnings-token — en systematisk riktningsflip (fel token hela
// resan) rörde ingen gate (INV-15 är WARN med 220 m-tolerans). Multiset:en
// av mmsi:bro:riktning låses separat; regenerera MEDVETET med
// REGEN_DISTRIBUTIONS=1 från en GRÖN körning (skriptet vägrar annars).
const DIRECTION_FILE = path.join(__dirname, 'corpora-direction-distribution.json');
const directionDistribution = fs.existsSync(DIRECTION_FILE)
  ? JSON.parse(fs.readFileSync(DIRECTION_FILE, 'utf8'))
  : {};
// Golden-text (testauditen 2026-07-10, TA1): bridge_text-INNEHÅLLET var
// aldrig facit-låst längs riktiga resor — bara grammatik/struktur
// (invarianterna) och notisräkningen. En ändring som ger "rimligt men fel"
// värde (rätt grammatik, fel båt/antal/ETA) rörde ingen gate. Hela
// transitionsströmmen (iso + text) låses nu per korpus i golden-text/;
// regenerera MEDVETET med REGEN_DISTRIBUTIONS=1 från en GRÖN körning och
// GRANSKA diffen som vid facit-omlåsning (facit-fällans regler gäller).
const GOLDEN_DIR = path.join(__dirname, 'golden-text');
// ÖPPNINGSFACIT (etapp 6, 2026-08-03, O5): multiset:en av bro:riktning per
// korpus + antal, för det PROAKTIVA lagrets varningar. Samma roll för
// bridge_opening_soon som corpora-direction-distribution.json har för
// boat_near — utan den kan en tappad eller uppfunnen öppningsvarning inte
// upptäckas av någon gate (notisfacit och golden-text är per konstruktion
// blinda för den nya dimensionen).
//
// FILEN SKA FINNAS (etapp 6-granskningen). Bootstrap-läget var tidigare
// "saknas hela filen ⇒ kör öppningsdelen informativt", och eftersom filen
// aldrig genererades var HELA dimensionen olåst utan ett ord i utskriften —
// exakt det hål R2-1 en gång stängde för fördelningsfacit, återinfört en nivå
// upp. Saknas filen nu skriver grinden en HÖGLJUDD rad (och regenerering är
// den enda tillåtna vägen: REGEN_DISTRIBUTIONS=1 från en grön körning).
// Finns filen men saknar en LÅST korpus är det ett HÅRT fel — utom för en
// korpus med `lockOpenings: false` (A9a), där dimensionen är MEDVETET olåst
// och posten därför varken jämförs eller skrivs.
const OPENING_FILE = path.join(__dirname, 'opening-distribution.json');
const openingDistribution = fs.existsSync(OPENING_FILE)
  ? JSON.parse(fs.readFileSync(OPENING_FILE, 'utf8'))
  : null;
if (!openingDistribution && process.env.REGEN_DISTRIBUTIONS !== '1') {
  console.log('⚠️ ÖPPNINGSFACIT SAKNAS (opening-distribution.json) — den nya '
    + 'dimensionen är OLÅST i den här körningen. Regenerera med '
    + 'REGEN_DISTRIBUTIONS=1 från en grön körning.');
}
const REGEN = process.env.REGEN_DISTRIBUTIONS === '1';

const RUNNER = path.join(__dirname, 'replayRunner.js');

function runCorpus(corpus) {
  const stdout = execFileSync('node', [RUNNER, corpus.jsonl], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
  if (!m) throw new Error(`Ingen JSON-markör i replay-output för ${corpus.id}`);
  return JSON.parse(m[1]);
}

let failed = false;
const rows = [];
// A8(ii): summeras över korpusarna och skrivs ut sist — se kvittot vid rapporten.
let totalSuppressedTokenTimeouts = 0;
const regeneratedDirections = {};
const regeneratedGolden = {};
const regeneratedOpenings = {};

/** Multiset av öppningsvarningar: "Bro:riktning" → antal. */
function openingKeys(result) {
  const acc = {};
  for (const w of (result.openingWarnings || [])) {
    const k = `${w.bridge}:${w.direction || 'unknown'}`;
    acc[k] = (acc[k] || 0) + 1;
  }
  const sorted = {};
  for (const k of Object.keys(acc).sort((a, b) => a.localeCompare(b))) sorted[k] = acc[k];
  return sorted;
}

for (const corpus of corpora) {
  let result;
  try {
    result = runCorpus(corpus);
  } catch (err) {
    failed = true;
    rows.push({ id: corpus.id, status: '💥 KRASCH', detail: err.message.slice(0, 120) });
    continue;
  }

  const notifications = result.notificationCount;
  // Harness-fix (2026-07-01): processErrors är ett TAL — den gamla
  // `(...|| []).length` gav alltid undefined → krascher i _processAISMessage
  // flaggades ALDRIG av gaten (död kontroll sedan dag 1).
  const processErrors = result.processErrors || 0;
  totalSuppressedTokenTimeouts += result.suppressedTokenTimeouts || 0;
  const leaks = result.leakDiagnostics || {};
  const vesselsLeft = leaks.vessels;

  const problems = [];
  if (processErrors > 0) problems.push(`${processErrors} processfel`);
  if (vesselsLeft !== 0) problems.push(`${vesselsLeft} fartyg kvar efter efterspel`);
  if (corpus.locked && notifications !== corpus.expectedNotifications) {
    problems.push(`notiser ${notifications} ≠ facit ${corpus.expectedNotifications}`);
  }

  // Etapp 3: en fusionskorpus (fusionOf satt) valideras mot PARENTENS
  // fördelningsfacit — fusionens kontrakt är just "identiskt utfall".
  const distKey = corpus.fusionOf || corpus.id;

  // Helgranskning 2026-07-06 (harness-corpora#R2-1): en LÅST korpus UTAN
  // fördelningspost hoppade tyst över multiset-gaten — kärnskyddet mot
  // kompenserande fel (miss + fantom = samma summa). Saknad post är nu ett
  // hårt fel: varje korpuslåsning MÅSTE registrera sin fördelning.
  if (corpus.locked && !distribution[distKey]) {
    problems.push('FÖRDELNINGSPOST SAKNAS i corpora-distribution.json — multiset-gaten kan inte köras');
  }

  // Fördelningsvalidering: (mmsi,bro)-multiset måste matcha exakt.
  if (corpus.locked && distribution[distKey]) {
    const expectedKeys = Object.entries(distribution[distKey])
      .flatMap(([mmsi, bridges]) => bridges.map((b) => `${mmsi}:${b}`))
      .sort();
    const actualKeys = (result.notifications || [])
      .map((n) => `${n.mmsi}:${n.bridge}`)
      .sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      const countBy = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
      const a = countBy(actualKeys);
      const e = countBy(expectedKeys);
      const missing = [...e].filter(([k, c]) => (a.get(k) || 0) < c).map(([k]) => k);
      const extra = [...a].filter(([k, c]) => (e.get(k) || 0) < c).map(([k]) => k);
      problems.push(`FÖRDELNING AVVIKER: saknas=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
    }
  }

  // TA2 (2026-07-10): riktningsmultiset — mmsi:bro:riktning måste matcha.
  if (corpus.locked && directionDistribution[distKey]) {
    const countBy = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
    const actual = countBy((result.notifications || [])
      .map((n) => `${n.mmsi}:${n.bridge}:${n.direction || 'unknown'}`));
    const expected = new Map(Object.entries(directionDistribution[distKey]));
    const missing = [...expected].filter(([k, c]) => (actual.get(k) || 0) < c).map(([k]) => k);
    const extra = [...actual].filter(([k, c]) => (expected.get(k) || 0) < c).map(([k]) => k);
    if (missing.length || extra.length) {
      problems.push(`RIKTNINGSFÖRDELNING AVVIKER: saknas=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
    }
  } else if (corpus.locked && !REGEN) {
    problems.push('RIKTNINGSPOST SAKNAS i corpora-direction-distribution.json — regenerera med REGEN_DISTRIBUTIONS=1 från grön körning');
  }

  // A9a (etapp 7, 2026-08-08): `lockOpenings: false` låser ALLT UTOM
  // öppningsdimensionen. Se corpora.js-huvudkommentaren — en körning kan vara
  // pelare 1+2-verifierad medan öppningsmotorn bär en KÄND öppen defekt
  // (#17: CARAT-fantomvarningen 05:18:31), och då får multiseten inte
  // förevigas. Frånvarande fält ⇒ dimensionen är låst som förut.
  const openingsLocked = corpus.lockOpenings !== false;

  // O5 (etapp 6, 2026-08-03): öppningsfacit — bro:riktning-multiset.
  // Fusionskorpusar valideras mot PARENTENS facit av samma skäl som
  // notisfördelningen: kontraktet är "identiskt utfall".
  if (corpus.locked && openingsLocked && openingDistribution) {
    const expected = openingDistribution[distKey];
    if (!expected) {
      // Saknad post är ett HÅRT fel i normalläge (R2-1-lärdomen: en gate som
      // tyst hoppas över är farligare än ingen gate). I REGEN-läget är den
      // däremot det NORMALA startläget för en nyinlagd korpus — samma
      // undantag som riktnings- och golden-facit redan har. Skyddet mot att
      // REGEN skriver halvfärdigt facit ligger i complete-vakten (A8(iv))
      // längst ned, inte här.
      if (!REGEN) {
        problems.push(`ÖPPNINGSPOST SAKNAS i opening-distribution.json (distKey=${distKey}) — öppningsgaten kan inte köras`);
      }
    } else {
      const actual = openingKeys(result);
      const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
      const diffs = [];
      for (const k of [...allKeys].sort()) {
        const e = expected[k] || 0;
        const a = actual[k] || 0;
        if (e !== a) diffs.push(`${k}: ${a} (facit ${e})`);
      }
      if (diffs.length) problems.push(`ÖPPNINGSFÖRDELNING AVVIKER: ${diffs.join(', ')}`);
    }
  }

  // TA1 (2026-07-10): golden bridge_text — hela transitionsströmmen jämförs.
  // Etapp 3: hoppas MEDVETET över för fusionskorpusar (fusionOf) — hub-ekon
  // förskjuter publiceringstidpunkter utan att ändra innehållsbesluten;
  // multiset-gaterna ovan är fusionens facit.
  if (corpus.locked && !corpus.fusionOf) {
    const goldenPath = path.join(GOLDEN_DIR, `${corpus.id}.json`);
    if (fs.existsSync(goldenPath)) {
      const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
      const actual = (result.bridgeTextTransitions || []).map((t) => ({ iso: t.iso, text: t.text }));
      if (actual.length !== golden.length) {
        problems.push(`GOLDEN-TEXT: ${actual.length} övergångar ≠ golden ${golden.length}`);
      } else {
        const firstDiff = actual.findIndex((a, i) => a.iso !== golden[i].iso || a.text !== golden[i].text);
        if (firstDiff !== -1) {
          problems.push(`GOLDEN-TEXT AVVIKER från index ${firstDiff}: `
            + `fick "${actual[firstDiff].iso} ${actual[firstDiff].text}" `
            + `väntade "${golden[firstDiff].iso} ${golden[firstDiff].text}"`);
        }
      }
    } else if (!REGEN) {
      problems.push(`GOLDEN-TEXT SAKNAS (golden-text/${corpus.id}.json) — regenerera med REGEN_DISTRIBUTIONS=1 från grön körning`);
    }
  }

  // Facit-oberoende invarianter — fångar buggklasser som facit-jämförelsen
  // är strukturellt blind för (se docs/bug-audit-2026-06-10.md §D-E).
  // FP9 (2026-07-18): en korpuspost får bära knownInvariantExceptions —
  // EXAKTA utslagssträngar (prefixmatch) som är RÅDATAVERIFIERAT designenliga
  // förlopp vilka de textbaserade reglerna inte kan särskilja (NORDIC
  // SOLA-klassen: 6-min-tyst ledare visar sig ha bromsat till kö — färskt
  // sampel rättar ETA:n ärligt uppåt och studsar vid re-acceleration; text-
  // signaturen är identisk med SOKERI-klassens). Varje post MÅSTE motiveras
  // i corpora.js-noten. Matchade utslag loggas synligt men fäller inte;
  // omatchade fäller med full styrka som förut.
  const knownExceptions = Array.isArray(corpus.knownInvariantExceptions)
    ? corpus.knownInvariantExceptions : [];
  const invariantViolations = validateInvariants(result);
  const knownHits = [];
  const liveViolations = [];
  for (const v of invariantViolations) {
    if (knownExceptions.some((k) => v.startsWith(k))) knownHits.push(v);
    else liveViolations.push(v);
  }
  if (knownHits.length > 0) {
    console.log(`\n  ℹ️ ${corpus.id}: ${knownHits.length} KÄNDA invariantutslag (rådataverifierade, se corpora.js):`);
    for (const v of knownHits) console.log(`     ${v}`);
  }
  // M24 (helkodsgranskning runda 4, 2026-08-23): OANVÄNDA UNDANTAG.
  // Ett knownInvariantException är en tyst amnesti för EN namngiven, rådata-
  // verifierad utslagssträng. Slutar strängen matcha — för att defekten fixats
  // (då ska posten pensioneras) ELLER för att utslaget bytt tidsstämpel eller
  // värde (då ska posten UPPDATERAS, annars är amnestin borta och nästa
  // körning fäller på något ingen väntade sig) — hade ingenting sagt det förut.
  // Undantagslistan kunde alltså tyst växa sig full av döda strängar, precis
  // som INV-14 tyst tappade sina längsta spann.
  //
  // WARN, aldrig fällande: en post som blivit oanvänd är oftast GODA nyheter
  // (defekten är borta) och ska inte kunna stoppa en grön körning. Mätt på
  // HEAD 0b72310: 0 oanvända över samtliga 18 korpusar, dvs. kontrollen är
  // tyst i dag och talar först när något faktiskt ändrats.
  const unusedExceptions = knownExceptions.filter(
    (k) => !invariantViolations.some((v) => v.startsWith(k)),
  );
  if (unusedExceptions.length > 0) {
    console.log(`\n  ⚠️ ${corpus.id}: ${unusedExceptions.length} OANVÄNT knownInvariantException `
      + '(matchar inget utslag längre — pensionera posten om defekten är fixad, '
      + 'uppdatera strängen om utslaget bytt värde/tidsstämpel):');
    for (const k of unusedExceptions) console.log(`     ${k}`);
  }
  for (const v of liveViolations.slice(0, 5)) {
    problems.push(`INVARIANT: ${v}`);
  }
  if (liveViolations.length > 5) {
    problems.push(`... +${liveViolations.length - 5} fler invariantbrott`);
  }

  if (corpus.locked && problems.length > 0) failed = true;

  // REGEN-läget samlar riktningsmultiseten + golden-texten för skrivning i
  // slutet — men BARA om korpusen i övrigt är helt grön (facit + fördelning
  // + invarianter).
  if (REGEN && corpus.locked && problems.length === 0) {
    const acc = {};
    for (const n of (result.notifications || [])) {
      const k = `${n.mmsi}:${n.bridge}:${n.direction || 'unknown'}`;
      acc[k] = (acc[k] || 0) + 1;
    }
    const sortedAcc = {};
    for (const k of Object.keys(acc).sort((a, b) => a.localeCompare(b))) {
      sortedAcc[k] = acc[k];
    }
    regeneratedDirections[corpus.id] = sortedAcc;
    regeneratedGolden[corpus.id] = (result.bridgeTextTransitions || [])
      .map((t) => ({ iso: t.iso, text: t.text }));
    // A9a: en korpus med `lockOpenings: false` EXKLUDERAS ur öppningsfacit —
    // annars skriver REGEN in exakt den multiset flaggan finns för att undvika.
    if (openingsLocked) regeneratedOpenings[corpus.id] = openingKeys(result);
  }

  // WARN-invarianter (fas 0.4, 2026-07-03): informativa tills B1–B8 landat —
  // rapporteras men fäller ALDRIG körningen. Skärps i fas 6.
  const warns = validateWarnInvariants(result);
  if (warns.length > 0) {
    // M24 (runda 4, 2026-08-23): visningstaket var KLASSBLINT — `slice(0, 8)`
    // tog de åtta FÖRSTA raderna, så en klass med få utslag kunde försvinna
    // helt bakom en mängd rader från en pratsam granne. Mätt på 20260804-both-21h:
    // INV-18 har 7 utslag och INV-14W 3, och den gamla ordningen visade 7 + 1
    // och gömde de två sista bakom "+2 fler" — det vill säga exakt de långa
    // spann (3506 s, 2794 s) som M24 finns för att göra synliga. Samma
    // defektform som M24 självt: ett tak som tystar instrumentet.
    // Raderna väljs därför RUNDGÅNGSVIS över klasserna, så ingen klass kan bli
    // helt osynlig; budgeten är oförändrad och en klassöversikt skrivs alltid
    // ut i sin helhet.
    const byClass = new Map();
    for (const w of warns) {
      const cls = (w.match(/^INV-\d+W?/) || ['ÖVRIGT'])[0];
      if (!byClass.has(cls)) byClass.set(cls, []);
      byClass.get(cls).push(w);
    }
    const summary = [...byClass.entries()].map(([c, l]) => `${c}×${l.length}`).join(', ');
    console.log(`\n  ⚠️ ${corpus.id}: ${warns.length} WARN-invariantutslag (${summary}):`);
    const WARN_ROW_BUDGET = 8;
    const queues = [...byClass.values()].map((l) => [...l]);
    const shown = [];
    while (shown.length < WARN_ROW_BUDGET && queues.some((q) => q.length > 0)) {
      for (const q of queues) {
        if (shown.length >= WARN_ROW_BUDGET) break;
        if (q.length > 0) shown.push(q.shift());
      }
    }
    for (const w of shown) console.log(`     ${w}`);
    if (warns.length > shown.length) console.log(`     ... +${warns.length - shown.length} fler`);
  }

  let status;
  if (problems.length === 0) {
    status = corpus.locked ? '✅ OK (låst)' : 'ℹ️ OK (olåst)';
  } else if (corpus.locked) {
    status = '❌ REGRESSION';
  } else {
    status = '⚠️ AVVIKELSE (olåst)';
  }

  rows.push({
    id: corpus.id,
    status,
    detail: `${`notiser=${notifications}${corpus.expectedNotifications !== null ? `/${corpus.expectedNotifications}` : ''}, `
      + `övergångar=${(result.bridgeTextTransitions || []).length}, `
      + `öppningsvarningar=${result.openingWarningCount ?? 0}, `}${
      problems.length ? problems.join('; ') : 'rent'}`,
  });
}

console.log('\n=== MULTIKORPUS-REPLAY ===');
const totalHours = corpora.reduce((s, c) => s + c.hours, 0);
console.log(`${corpora.length} korpusar, ~${totalHours}h produktionsdata\n`);
for (const row of rows) {
  console.log(`  ${row.status.padEnd(22)} ${row.id.padEnd(18)} ${row.detail}`);
}
console.log('');

// A8(ii)-KVITTOT (dirigentens QC efter fasgrind A, 2026-08-08): filtret i
// replayRunner sväljer GLOBAL_TOKEN_TIMEOUT-raden och räknar den i
// `suppressedTokenTimeouts` — men fältet hade NOLL läsare, så 2 697 rader
// försvann ur utskriften utan att någon rad nämnde det. Det är svälj-fällan i
// harnessens egen skepnad: "räknat men osynligt" är inte räknat.
// Summan skrivs ALLTID ut när den är > 0, så att en plötslig förändring
// (t.ex. att bruset flyttar sig till en ny kodväg) syns direkt.
if (totalSuppressedTokenTimeouts > 0) {
  console.log(`  ℹ️ ${totalSuppressedTokenTimeouts} GLOBAL_TOKEN_TIMEOUT-rader undertryckta av `
    + 'harness-filtret (fake-timer-artefakt, 0 i fält — se replayRunner.js A8(ii)).');
  console.log('');
}

if (failed) {
  console.log('❌ MINST EN LÅST KORPUS AVVIKER — regression i pelarna.');
  process.exit(1);
}

if (REGEN) {
  const lockedCorpora = corpora.filter((c) => c.locked);
  const lockedIds = lockedCorpora.map((c) => c.id);

  // A8(iv) COMPLETE-VAKTEN (etapp 7, 2026-08-08).
  //
  // Den gamla vakten kontrollerade ENBART riktningsfacit och skrev sedan alla
  // tre filerna. Golden- och öppningsskrivningen läste därför obevakade
  // uppslag: `JSON.stringify(undefined)` ger `undefined` (inte ett kast), så
  // ett hål i insamlingen hade skrivit den fyra tecken långa strängen
  // "undefined" som golden-fil — en tyst facitförstörelse som ingen gate kan
  // upptäcka i efterhand eftersom den ERSÄTTER sanningen. Nu måste SAMTLIGA
  // dimensioner finnas för SAMTLIGA låsta korpusar innan NÅGON fil skrivs.
  //
  // Två dokumenterade undantag, båda strukturella och inte "hål":
  //   - `fusionOf` ⇒ ingen golden (hub-ekon förskjuter publiceringstidpunkter
  //     utan att ändra innehållsbesluten; jämförelsen hoppas medvetet ovan).
  //   - `lockOpenings: false` (A9a) ⇒ ingen öppningspost.
  const missingFacit = [];
  for (const c of lockedCorpora) {
    if (!regeneratedDirections[c.id]) {
      missingFacit.push(`${c.id}: riktningsfacit (korpusen var inte grön)`);
      continue;
    }
    if (!c.fusionOf && !regeneratedGolden[c.id]) missingFacit.push(`${c.id}: golden-text`);
    if (c.lockOpenings !== false && !regeneratedOpenings[c.id]) missingFacit.push(`${c.id}: öppningsfacit`);
  }
  if (missingFacit.length) {
    console.log('❌ REGEN AVBRUTEN — facit skrivs ALDRIG halvfärdigt. Saknas:');
    for (const m of missingFacit) console.log(`   • ${m}`);
    console.log('   (riktning + golden + öppningar måste vara kompletta för SAMTLIGA låsta '
      + 'korpusar; undantag: fusionOf saknar golden, lockOpenings:false saknar öppningspost.)');
    process.exit(1);
  }

  const goldenIds = lockedCorpora.filter((c) => !c.fusionOf).map((c) => c.id);
  const openingIds = lockedCorpora.filter((c) => c.lockOpenings !== false).map((c) => c.id);
  const skippedOpenings = lockedIds.filter((id) => !openingIds.includes(id));

  fs.writeFileSync(DIRECTION_FILE, `${JSON.stringify(regeneratedDirections, null, 2)}\n`);
  console.log(`📝 REGEN: riktningsfacit skrivet till ${path.basename(DIRECTION_FILE)} (${lockedIds.length} korpusar).`);
  if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR);
  for (const id of goldenIds) {
    fs.writeFileSync(
      path.join(GOLDEN_DIR, `${id}.json`),
      `${JSON.stringify(regeneratedGolden[id], null, 1)}\n`,
    );
  }
  console.log(`📝 REGEN: golden-text skriven till golden-text/ (${goldenIds.length} korpusar).`);
  // O5: öppningsfacit skrivs i SAMMA regen-svep och med samma villkor (endast
  // från en helt grön körning). Det är den enda vägen filen ska skapas —
  // aldrig för hand.
  fs.writeFileSync(OPENING_FILE, `${JSON.stringify(regeneratedOpenings, null, 2)}\n`);
  console.log(`📝 REGEN: öppningsfacit skrivet till ${path.basename(OPENING_FILE)} (${openingIds.length} korpusar).`);
  if (skippedOpenings.length) {
    console.log(`   ℹ️ lockOpenings:false — ingen öppningspost skrevs för: ${skippedOpenings.join(', ')}`);
  }
}

console.log('✅ Alla låsta korpusar matchar facit.');
process.exit(0);
