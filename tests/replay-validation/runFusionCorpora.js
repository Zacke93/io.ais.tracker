'use strict';

/**
 * Fusionsgrinden (etapp 3, 2026-08-02) — `npm run replay:fusion`.
 *
 * För varje LÅST korpus:
 *   1. Generera en AISHub-skuggström (makeFusionCorpus: 65s-pollsnapshots av
 *      senast kända fix, re-leveranser, 150 ms-spridning) och sammanfoga.
 *   2. Kör replayRunner med REPLAY_FUSION=1 — meddelandena matas genom
 *      AISSourceMultiplexer._ingestFromFeed i 'both'-läge, så FixFusionPolicy
 *      F1-F5 sitter PÅ RIKTIGT i vägen (V3-C1: dagens bypass-harness går
 *      förbi fusionslagret och hade gjort grinden till en no-op).
 *   3. Kräv EXAKT parentkorpusens facit: notisantal, (mmsi,bro)-multiset och
 *      (mmsi,bro,riktning)-multiset (distributionsfacit via distKey =
 *      parent-id). Golden-text hoppas MEDVETET över — hub-ekon förskjuter
 *      publiceringstidpunkter utan att ändra innehållsbeslut.
 *   4. Kräv att fusionen var AKTIV: rejected > 0 (ekona ska ha svalts) och
 *      accepted > 0 — en grön körning där F-reglerna aldrig kördes är röd.
 *
 * Exit-kod 0 endast om samtliga låsta korpusar håller kontraktet.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const corpora = require('./corpora');
const { makeFusionCorpus } = require('./makeFusionCorpus');

const distribution = require('./corpora-distribution.json');

const DIRECTION_FILE = path.join(__dirname, 'corpora-direction-distribution.json');
const directionDistribution = fs.existsSync(DIRECTION_FILE)
  ? JSON.parse(fs.readFileSync(DIRECTION_FILE, 'utf8'))
  : {};

const RUNNER = path.join(__dirname, 'replayRunner.js');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-fusion-'));

function runFusion(jsonlPath) {
  const stdout = execFileSync('node', [RUNNER, jsonlPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    env: { ...process.env, REPLAY_FUSION: '1' },
  });
  const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
  if (!m) throw new Error('Ingen JSON-markör i replay-output');
  return JSON.parse(m[1]);
}

const locked = corpora.filter((c) => c.locked);
let failed = false;
const rows = [];

console.log('=== FUSIONSGRINDEN (REPLAY_FUSION=1 genom AISSourceMultiplexer) ===');
console.log(`${locked.length} låsta korpusar × (original + syntetisk AISHub-skuggström)\n`);

for (const corpus of locked) {
  const distKey = corpus.fusionOf || corpus.id;
  let result;
  let hubCount = 0;
  try {
    const samples = fs.readFileSync(corpus.jsonl, 'utf8').trim().split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const fusion = makeFusionCorpus(samples);
    hubCount = fusion.hubCount;
    const fusionPath = path.join(TMP_DIR, `${corpus.id}-fusion.jsonl`);
    fs.writeFileSync(fusionPath, `${fusion.merged.map((s) => JSON.stringify(s)).join('\n')}\n`);
    result = runFusion(fusionPath);
  } catch (err) {
    failed = true;
    rows.push({ id: corpus.id, status: '💥 KRASCH', detail: String(err.message || err).slice(0, 160) });
    continue;
  }

  const problems = [];
  const notifications = result.notificationCount;
  const processErrors = result.processErrors || 0;
  if (processErrors > 0) problems.push(`${processErrors} processfel`);
  if (notifications !== corpus.expectedNotifications) {
    problems.push(`notiser ${notifications} ≠ facit ${corpus.expectedNotifications}`);
  }

  // (mmsi,bro)-multiset mot parentens fördelningsfacit.
  if (!distribution[distKey]) {
    problems.push(`FÖRDELNINGSPOST SAKNAS för distKey=${distKey}`);
  } else {
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

  // Riktningsmultiset mot parentens facit.
  if (directionDistribution[distKey]) {
    const countBy = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
    const actual = countBy((result.notifications || [])
      .map((n) => `${n.mmsi}:${n.bridge}:${n.direction || 'unknown'}`));
    const expected = new Map(Object.entries(directionDistribution[distKey]));
    const missing = [...expected].filter(([k, c]) => (actual.get(k) || 0) < c).map(([k]) => k);
    const extra = [...actual].filter(([k, c]) => (expected.get(k) || 0) < c).map(([k]) => k);
    if (missing.length || extra.length) {
      problems.push(`RIKTNINGSFÖRDELNING AVVIKER: saknas=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
    }
  }

  // Fusionen måste ha varit AKTIV — grön-utan-att-köras är rött (V3-C1).
  const fusion = result.fusionStats || {};
  if (!(fusion.accepted > 0)) problems.push('fusionStats.accepted = 0 — muxen satt inte i vägen?');
  if (hubCount > 0 && !(fusion.rejected > 0)) {
    problems.push(`${hubCount} aishub-ekon genererade men fusionStats.rejected = ${fusion.rejected ?? 'null'} — F1/F2b svalde inget?`);
  }

  if (problems.length) {
    failed = true;
    rows.push({ id: corpus.id, status: '❌ AVVIKER', detail: problems.join(' | ') });
  } else {
    rows.push({
      id: corpus.id,
      status: '✅ OK',
      detail: `notiser=${notifications}/${corpus.expectedNotifications}, ekon=${hubCount} (svalda=${fusion.rejected}, accepterade=${fusion.accepted}, feedSwitch=${fusion.feedSwitches})`,
    });
  }
}

for (const r of rows) {
  console.log(`  ${r.status.padEnd(12)} ${r.id.padEnd(18)} ${r.detail}`);
}

try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) { /* tempstädning är best effort */ }

if (failed) {
  console.log('\n❌ Fusionsgrinden RÖD — F-reglerna läcker eller facit flyttades.');
  process.exit(1);
} else {
  console.log('\n✅ Fusionsgrinden grön: identiskt facit med F1-F5 i vägen, alla ekon svalda.');
}
