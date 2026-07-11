'use strict';

/**
 * 72h-SOAK (2026-07-03, produktionsredo-härdningen) — långtidsdriftprovet.
 *
 * Genererar tre dygns deterministisk blandtrafik (seed 46) och kör den genom
 * den riktiga appen via replay-harnessen (fake-timers gör att 72 h speltid
 * tar minuter i realtid): 36 genomresor dag/natt i båda riktningarna med
 * varierande fart, AIS-gap, köstopp och U-svängar; två kajliggare som sänder
 * var 5:e minut hela tiden; två anslutningsavbrott och två ÄKTA process-
 * omstarter mitt i trafiken.
 *
 * FACIT = drift-stabilitet, inte notissiffror:
 *   1. 0 processfel.
 *   2. Läckagediagnostiken (INV-12-fälten) = 0 efter efterspelet — varje
 *      per-fartygs-struktur (timers, latches, historik, associationer) ska
 *      vara tom efter tre dygn + 40 min.
 *   3. Alla fatala invarianter rena (INV-1..16 inkl. notisdubbletter,
 *      grammatik, namn, distans).
 *   4. Rimlighetsgolv: varje FULLBORDAD genomresa ger ≥5 notiser
 *      (Kanalinfarten/Olide/Klaff/Jvb/Strids/Stallbacka minus gränsfall).
 *   5. heapUsedMB rapporteras (informativt — barnprocessen är färsk, så
 *      absolutvärdet är litet; trenden bevakas manuellt mellan körningar).
 *
 * Användning:  node tests/replay-validation/runSoak.js   (från io.ais.tracker/)
 * Exit-kod:    0 = stabil, 1 annars. Körs på begäran (inte i replay:all —
 * den tar flera minuter) + före publicering.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateScenario, buildPath, pathMetrics } = require('./scenarioGenerator');
const { validateInvariants, validateWarnInvariants } = require('./invariants');
const { MOORING_ZONES } = require('../../lib/constants');

const RUNNER = path.join(__dirname, 'replayRunner.js');
const QUAY = {
  lat: (MOORING_ZONES[0].start.lat + MOORING_ZONES[0].end.lat) / 2,
  lon: (MOORING_ZONES[0].start.lon + MOORING_ZONES[0].end.lon) / 2,
};
const METRICS = pathMetrics(buildPath());

const HOUR = 3600;
const SOAK_HOURS = 72;

// ---- Bygg trafikprogrammet (deterministiskt, ingen slump utanför seeden) ----
const vessels = [];

// Två kajliggare som sänder var 5:e minut i hela 72 h (APHRODITE-klassen).
vessels.push({
  mmsi: '902000001',
  name: 'SOAK-KAJ-A',
  direction: 'north',
  speedKn: 4.0,
  reportIntervalS: 300,
  moorAt: {
    lat: QUAY.lat, lon: QUAY.lon, durationS: SOAK_HOURS * HOUR, navStatus: 5,
  },
});
vessels.push({
  mmsi: '902000002',
  name: 'SOAK-KAJ-B',
  direction: 'south',
  speedKn: 4.0,
  reportIntervalS: 300,
  startOffsetS: 90,
  moorAt: {
    lat: QUAY.lat + 0.0004, lon: QUAY.lon + 0.0006, durationS: SOAK_HOURS * HOUR, navStatus: 1,
  },
});

// 36 genomresor: 12 per dygn dagtid (var ~90:e min 06–24), färre nattetid.
// Varierad fart, riktning växlar, var 4:e får ett AIS-gap, var 6:e ett
// köstopp söder om Klaffbron, var 9:e en U-sväng efter halva rutten.
let journeyIdx = 0;
for (let day = 0; day < 3; day++) {
  for (let slot = 0; slot < 12; slot++) {
    journeyIdx++;
    const startOffsetS = day * 24 * HOUR + 6 * HOUR + slot * 5400; // 06:00–22:30
    const northbound = journeyIdx % 2 === 1;
    const speedKn = 4.0 + (journeyIdx % 5) * 0.7; // 4,0–6,8 kn
    const v = {
      mmsi: String(902001000 + journeyIdx),
      name: `SOAK-RESA-${String(journeyIdx).padStart(2, '0')}`,
      direction: northbound ? 'north' : 'south',
      speedKn,
      startOffsetS,
    };
    if (journeyIdx % 4 === 0) {
      // 12-min AIS-gap mitt på rutten (radioskugga)
      v.gap = { atFraction: 0.45, durationS: 720 };
    }
    if (journeyIdx % 6 === 0) {
      // 20-min köstopp strax söder om Klaffbron (norrgående referensram:
      // för södergående blir det norr om — båda tränar väntlogiken)
      v.stop = { atFraction: (METRICS.cum[2] - 350) / METRICS.total, durationS: 1200 };
    }
    if (journeyIdx % 9 === 0) {
      v.uTurnAtFraction = 0.55;
    }
    vessels.push(v);
  }
}

const fullJourneys = vessels.filter((v) => !v.moorAt && !v.uTurnAtFraction).length;

const scenario = {
  name: `soak-${SOAK_HOURS}h-blandad-trafik`,
  seed: 46,
  vessels,
  events: [
    // Två avbrott (kvällsstorm dag 1, gryning dag 3) + två äkta omstarter
    // (mitt på dag 2 med trafik i kanalen, sen natt dag 2→3 i stiltje).
    { ctrl: 'disconnect', atOffsetS: 1 * 24 * HOUR - 4 * HOUR },
    { ctrl: 'reconnect', atOffsetS: 1 * 24 * HOUR - 4 * HOUR + 480 },
    { ctrl: 'restart', atOffsetS: 1.5 * 24 * HOUR + 1800 },
    { ctrl: 'disconnect', atOffsetS: 2.5 * 24 * HOUR },
    { ctrl: 'reconnect', atOffsetS: 2.5 * 24 * HOUR + 300 },
    { ctrl: 'restart', atOffsetS: 2 * 24 * HOUR + 4 * HOUR },
  ],
};

// ---- Kör ----
console.log(`\n=== ${SOAK_HOURS}h-SOAK (seed ${scenario.seed}) ===`);
const samples = generateScenario(scenario);
console.log(`${vessels.length} fartyg (${fullJourneys} raka genomresor, 2 kajliggare), ${samples.length} samples, ${scenario.events.length} driftshändelser`);

// SOAK_KEEP=<sökväg> behåller jsonl:en där för manuell felsökning.
const tmpFile = process.env.SOAK_KEEP || path.join(os.tmpdir(), `soak-${scenario.seed}.jsonl`);
fs.writeFileSync(tmpFile, samples.map((s) => JSON.stringify(s)).join('\n'));

let result;
try {
  const stdout = execFileSync('node', [RUNNER, tmpFile], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
  if (!m) throw new Error(`Ingen JSON-markör i replay-output (stdout-svans: ${stdout.slice(-300)})`);
  result = JSON.parse(m[1]);
  if (result.fatal) throw new Error(`Replay-fatal: ${result.fatal}`);
} finally {
  if (!process.env.SOAK_KEEP) {
    try {
      fs.unlinkSync(tmpFile);
    } catch (_) { /* tomt */ }
  }
}

// ---- Döm ----
const problems = [];
const leaks = result.leakDiagnostics || {};

if ((result.processErrors || 0) > 0) problems.push(`${result.processErrors} processfel`);

const LEAK_EXCEPTIONS = new Set(['triggeredBoatNearKeys', 'persistentRecentTriggers', 'heapUsedMB']);
for (const [field, value] of Object.entries(leaks)) {
  if (LEAK_EXCEPTIONS.has(field)) continue;
  // Helgranskning 2026-07-06 (harness-corpora#R2-3): icke-finita värden
  // inaktiverade kontrollen TYST — ett omdöpt/trasigt diagnostikfält såg ut
  // som "ingen läcka". Nu är icke-finit själv ett fel.
  if (!Number.isFinite(value)) {
    problems.push(`LÄCKAGEDIAGNOSTIK TRASIG: ${field}=${value} (icke-finit — kontrollen kan inte köras)`);
  } else if (value !== 0) {
    problems.push(`LÄCKA efter 72h: ${field}=${value} (ska vara 0)`);
  }
}
// Dedup-mappen (2h-TTL): TTL-städningen bor i appens MONITORING-loop, som
// replay-harnessen medvetet aldrig startar (feed-hälsokollen skulle annars
// slåss med den manuella matningen). I replay prunas mappen därför BARA vid
// ctrl:'restart' (expiry-filtret i _loadPersistentTriggers — verifierat:
// körningen ackumulerar ~200 nycklar totalt men slutar på ~66 = resorna
// efter sista omstarten vid 52h). Produktionsbeteendet (per-minut-städning)
// täcks av enhetstester. Taket här vaktar OBEGRÄNSAD tillväxt, inte TTL:n:
// 10 resor à 6 broar efter sista omstarten + marginal.
if (Number.isFinite(leaks.persistentRecentTriggers) && leaks.persistentRecentTriggers > 100) {
  problems.push(`persistentRecentTriggers=${leaks.persistentRecentTriggers} efter 72h (växer bortom restart-prunade nivån)`);
}

const invariantViolations = validateInvariants(result);
for (const v of invariantViolations.slice(0, 8)) problems.push(`INVARIANT: ${v}`);
if (invariantViolations.length > 8) problems.push(`... +${invariantViolations.length - 8} fler invariantbrott`);

// Rimlighetsgolv: fullbordade genomresor ger ≥5 notiser var.
const minExpected = fullJourneys * 5;
if (result.notificationCount < minExpected) {
  problems.push(`notiser ${result.notificationCount} < rimlighetsgolv ${minExpected} (${fullJourneys} genomresor × 5)`);
}

// ChatGPT-granskning 2 (CG2-19, 2026-07-11): PER-BRO-golv. Det aggregerade
// golvet (×5 av 6 notispunkter) släppte igenom att en HEL broklass tappade
// alla sina notiser — varje resa gav då exakt 5 och totalen landade på
// golvet. INV-5 backstoppar bara målbroarna (Klaffbron/Stridsbergsbron);
// mellanbroarna hade ingen täckning alls. Kräv minst hälften av de raka
// genomresornas notiser per bro/triggerpunkt (toleransen absorberar legitim
// per-resa-suppression: gap-resorna %4, köstoppen %6, U-svängarna %9).
const EXPECTED_NOTIFICATION_POINTS = [
  'Kanalinfarten', 'Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron',
];
const perBridgeCounts = new Map();
for (const n of (result.notifications || [])) {
  if (n && n.bridge) perBridgeCounts.set(n.bridge, (perBridgeCounts.get(n.bridge) || 0) + 1);
}
const perBridgeFloor = Math.ceil(fullJourneys * 0.5);
const perBridgeSummary = EXPECTED_NOTIFICATION_POINTS
  .map((b) => `${b}=${perBridgeCounts.get(b) || 0}`).join(' ');
for (const bridgeName of EXPECTED_NOTIFICATION_POINTS) {
  const count = perBridgeCounts.get(bridgeName) || 0;
  if (count < perBridgeFloor) {
    problems.push(`broklass ${bridgeName}: ${count} notiser < per-bro-golv ${perBridgeFloor} (systematisk klassmiss?)`);
  }
}

const warns = validateWarnInvariants(result);

console.log(`\nNotiser: ${result.notificationCount} (golv ${minExpected})`);
console.log(`Per bro (golv ${perBridgeFloor}): ${perBridgeSummary}`);
console.log(`Textövergångar: ${(result.bridgeTextTransitions || []).length}`);
console.log(`Målbropassager: ${(result.targetPassages || []).length}`);
console.log(`heapUsedMB: ${leaks.heapUsedMB} | persistentRecentTriggers: ${leaks.persistentRecentTriggers} | triggeredBoatNearKeys: ${leaks.triggeredBoatNearKeys}`);
if (warns.length > 0) {
  console.log(`\n⚠️ ${warns.length} WARN-invariantutslag (informativa):`);
  for (const w of warns.slice(0, 6)) console.log(`   ${w}`);
  if (warns.length > 6) console.log(`   ... +${warns.length - 6} fler`);
}

if (problems.length > 0) {
  console.log('\n❌ SOAKEN FÖLL:');
  for (const p of problems) console.log(`   ${p}`);
  process.exit(1);
}
// Formulering rättad 2026-07-10 (andra granskningsrundan): dedup-nycklarna
// är MEDVETET undantagna tomhetskravet (se motiveringen vid LEAK_EXCEPTIONS
// ovan — de ska överleva per design och vaktas av 100-taket i stället).
console.log('\n✅ 72h-soaken stabil: 0 processfel, per-fartygs-strukturer tomma '
  + '(dedup-nycklar medvetet undantagna — vaktade av 100-taket), inga fatala invariantutslag.');
process.exit(0);
