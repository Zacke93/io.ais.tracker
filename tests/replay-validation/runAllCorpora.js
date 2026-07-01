'use strict';

/**
 * Multikorpus-replay (2026-06-10): kör replayRunner mot SAMTLIGA korpusar i
 * corpora.js (~65h produktionsdata) och validerar mot facit.
 *
 * Användning:  node tests/replay-validation/runAllCorpora.js   (från io.ais.tracker/)
 * Exit-kod:    0 om alla LÅSTA korpusar matchar facit och inga processfel,
 *              1 annars. Olåsta korpusar rapporteras informativt.
 *
 * Detta är den proaktiva regressionsgaten för pelarna: körs efter VARJE
 * ändring i status-/notis-/text-/livscykellogik, före commit.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const corpora = require('./corpora');
const { validateInvariants } = require('./invariants');
// Fördelningsfacit (2026-07-01): totalsumman räcker inte — en missad notis +
// en fantomnotis ger samma summa (kompenserande fel). Multiset:en av
// (mmsi,bro)-par låses per korpus; regenerera MEDVETET (med motivering i
// corpora.js-noten) via en verifierad körning när facit ändras.
const distribution = require('./corpora-distribution.json');

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

  // Facit-oberoende invarianter — fångar buggklasser som facit-jämförelsen
  // är strukturellt blind för (se docs/bug-audit-2026-06-10.md §D-E).
  const invariantViolations = validateInvariants(result);
  for (const v of invariantViolations.slice(0, 5)) {
    problems.push(`INVARIANT: ${v}`);
  }
  if (invariantViolations.length > 5) {
    problems.push(`... +${invariantViolations.length - 5} fler invariantbrott`);
  }

  if (corpus.locked && problems.length > 0) failed = true;

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
console.log('✅ Alla låsta korpusar matchar facit.');
process.exit(0);
