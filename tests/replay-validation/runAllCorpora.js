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
const regeneratedDirections = {};
const regeneratedGolden = {};

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
  const leaks = result.leakDiagnostics || {};
  const vesselsLeft = leaks.vessels;

  const problems = [];
  if (processErrors > 0) problems.push(`${processErrors} processfel`);
  if (vesselsLeft !== 0) problems.push(`${vesselsLeft} fartyg kvar efter efterspel`);
  if (corpus.locked && notifications !== corpus.expectedNotifications) {
    problems.push(`notiser ${notifications} ≠ facit ${corpus.expectedNotifications}`);
  }

  // Helgranskning 2026-07-06 (harness-corpora#R2-1): en LÅST korpus UTAN
  // fördelningspost hoppade tyst över multiset-gaten — kärnskyddet mot
  // kompenserande fel (miss + fantom = samma summa). Saknad post är nu ett
  // hårt fel: varje korpuslåsning MÅSTE registrera sin fördelning.
  if (corpus.locked && !distribution[corpus.id]) {
    problems.push('FÖRDELNINGSPOST SAKNAS i corpora-distribution.json — multiset-gaten kan inte köras');
  }

  // Fördelningsvalidering: (mmsi,bro)-multiset måste matcha exakt.
  if (corpus.locked && distribution[corpus.id]) {
    const expectedKeys = Object.entries(distribution[corpus.id])
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
  if (corpus.locked && directionDistribution[corpus.id]) {
    const countBy = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
    const actual = countBy((result.notifications || [])
      .map((n) => `${n.mmsi}:${n.bridge}:${n.direction || 'unknown'}`));
    const expected = new Map(Object.entries(directionDistribution[corpus.id]));
    const missing = [...expected].filter(([k, c]) => (actual.get(k) || 0) < c).map(([k]) => k);
    const extra = [...actual].filter(([k, c]) => (expected.get(k) || 0) < c).map(([k]) => k);
    if (missing.length || extra.length) {
      problems.push(`RIKTNINGSFÖRDELNING AVVIKER: saknas=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
    }
  } else if (corpus.locked && !REGEN) {
    problems.push('RIKTNINGSPOST SAKNAS i corpora-direction-distribution.json — regenerera med REGEN_DISTRIBUTIONS=1 från grön körning');
  }

  // TA1 (2026-07-10): golden bridge_text — hela transitionsströmmen jämförs.
  if (corpus.locked) {
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
  }

  // WARN-invarianter (fas 0.4, 2026-07-03): informativa tills B1–B8 landat —
  // rapporteras men fäller ALDRIG körningen. Skärps i fas 6.
  const warns = validateWarnInvariants(result);
  if (warns.length > 0) {
    const shown = warns.slice(0, 8);
    console.log(`\n  ⚠️ ${corpus.id}: ${warns.length} WARN-invariantutslag:`);
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
      + `övergångar=${(result.bridgeTextTransitions || []).length}, `}${
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

if (failed) {
  console.log('❌ MINST EN LÅST KORPUS AVVIKER — regression i pelarna.');
  process.exit(1);
}

if (REGEN) {
  const lockedIds = corpora.filter((c) => c.locked).map((c) => c.id);
  const complete = lockedIds.every((id) => regeneratedDirections[id]);
  if (!complete) {
    console.log('❌ REGEN avbruten: minst en låst korpus var inte grön — riktningsfacit skrivs ALDRIG från en bruten körning.');
    process.exit(1);
  }
  fs.writeFileSync(DIRECTION_FILE, `${JSON.stringify(regeneratedDirections, null, 2)}\n`);
  console.log(`📝 REGEN: riktningsfacit skrivet till ${path.basename(DIRECTION_FILE)} (${lockedIds.length} korpusar).`);
  if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR);
  for (const id of lockedIds) {
    fs.writeFileSync(
      path.join(GOLDEN_DIR, `${id}.json`),
      `${JSON.stringify(regeneratedGolden[id], null, 1)}\n`,
    );
  }
  console.log(`📝 REGEN: golden-text skriven till golden-text/ (${lockedIds.length} korpusar).`);
}

console.log('✅ Alla låsta korpusar matchar facit.');
process.exit(0);
