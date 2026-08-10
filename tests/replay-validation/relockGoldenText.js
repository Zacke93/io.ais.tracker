#!/usr/bin/env node
/**
 * relockGoldenText — PERMANENT omlåsningsverktyg för golden-text-dimensionen
 * (tillkom 2026-08-10, P9-omlåsningen; ersätter det sessionsberoende
 * omlas-golden.js som försvann med sin /tmp-katalog).
 *
 * ANVÄNDNING: node tests/replay-validation/relockGoldenText.js <korpusId...>
 *
 * JÄRNGRINDEN (järnregel §6.1-6.2): verktyget skriver ENDAST golden-text.
 * Före varje skrivning verifieras att ALLA övriga facitdimensioner är EXAKT
 * intakta — notisantal, fördelningsmultiset (mmsi:bro), riktningsmultiset
 * (mmsi:bro:riktning) och öppningsmultiset (bro:riktning). Diffar någon av
 * dem avbryts HELA körningen utan att någon fil skrivits. Omlåsningen ska
 * alltid åtföljas av en not i corpora.js (datum + mekanism + rådatabevis).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const corpora = require(path.join(BASE, 'corpora'));
const distribution = require(path.join(BASE, 'corpora-distribution.json'));
const directions = require(path.join(BASE, 'corpora-direction-distribution.json'));
const openings = require(path.join(BASE, 'opening-distribution.json'));

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

let wrote = 0;
for (const id of TARGETS) {
  const corpus = corpora.find((c) => c.id === id);
  if (!corpus) { console.error(`SAKNAS i corpora: ${id}`); process.exit(1); }
  if (!corpus.locked) { console.error(`ABORT ${id}: korpusen är inte låst — golden-text-omlåsning gäller låsta korpusar`); process.exit(1); }
  if (corpus.fusionOf) { console.error(`ABORT ${id}: fusionskorpus — golden-text valideras inte för fusionOf (se runAllCorpora)`); process.exit(1); }
  const stdout = execFileSync('node', [path.join(BASE, 'replayRunner.js'), corpus.jsonl], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000,
  });
  const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
  if (!m) { console.error(`Ingen JSON-markör: ${id}`); process.exit(1); }
  const result = JSON.parse(m[1]);
  const distKey = corpus.id;

  // HÅRDA GRINDAR — allt utom golden-text måste vara exakt.
  const notis = (result.notifications || []).length;
  if (notis !== corpus.expectedNotifications) {
    console.error(`ABORT ${id}: notiser ${notis} ≠ ${corpus.expectedNotifications}`); process.exit(1);
  }
  const expectedDist = Object.entries(distribution[distKey] || {})
    .flatMap(([mmsi, bridges]) => bridges.map((b) => `${mmsi}:${b}`)).sort();
  const actualDist = (result.notifications || []).map((n) => `${n.mmsi}:${n.bridge}`).sort();
  if (JSON.stringify(actualDist) !== JSON.stringify(expectedDist)) {
    console.error(`ABORT ${id}: fördelningsmultiset avviker`); process.exit(1);
  }
  const actualDir = countBy((result.notifications || [])
    .map((n) => `${n.mmsi}:${n.bridge}:${n.direction || 'unknown'}`));
  const expectedDir = new Map(Object.entries(directions[distKey] || {}));
  if (!mapsEqual(actualDir, expectedDir)) {
    console.error(`ABORT ${id}: riktningsmultiset avviker`); process.exit(1);
  }
  if (corpus.lockOpenings !== false) {
    const actualOpen = countBy((result.openingWarnings || [])
      .map((w) => `${w.bridge}:${w.direction || 'unknown'}`));
    const expectedOpen = new Map(Object.entries(openings[distKey] || {}).map(([k, v]) => [k, v]));
    if (!mapsEqual(actualOpen, expectedOpen)) {
      console.error(`ABORT ${id}: öppningsmultiset avviker`); process.exit(1);
    }
  }

  const golden = (result.bridgeTextTransitions || []).map((t) => ({ iso: t.iso, text: t.text }));
  const goldenPath = path.join(BASE, 'golden-text', `${id}.json`);
  const old = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  fs.writeFileSync(goldenPath, `${JSON.stringify(golden, null, 1)}\n`);
  console.log(`✅ ${id}: golden ${old.length} → ${golden.length} övergångar (notiser ${notis} = facit, alla multiset exakta)`);
  wrote++;
}
console.log(`\n${wrote}/${TARGETS.length} goldens omlåsta.`);
