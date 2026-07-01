'use strict';

/**
 * Syntetisk scenariosvit (2026-06-11) — den PROAKTIVA testpelaren.
 *
 * Kör kurerade syntetiska scenarier (situationer som ALDRIG förekommit i
 * någon korpus) genom den riktiga appen via replay-harnessen och dömer med
 * de facit-oberoende invarianterna + scenariospecifika förväntningar.
 *
 * Användning:  node tests/replay-validation/runSyntheticScenarios.js  (från io.ais.tracker/)
 *              npm run replay:synthetic
 * Exit-kod:    0 = alla scenarier rena, 1 annars.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  generateScenario, buildPath, pathMetrics, BASE_TIME_MS,
} = require('./scenarioGenerator');
const { validateInvariants } = require('./invariants');
const { MOORING_ZONES } = require('../../lib/constants');

const RUNNER = path.join(__dirname, 'replayRunner.js');
const QUAY = {
  lat: (MOORING_ZONES[0].start.lat + MOORING_ZONES[0].end.lat) / 2,
  lon: (MOORING_ZONES[0].start.lon + MOORING_ZONES[0].end.lon) / 2,
};

// Rutt-geometri för tidsberäkningar (möten, anslutningshändelser).
const PATH = buildPath();
const METRICS = pathMetrics(PATH);
// Kedjeindex i PATH: [0]=syd-ext, [1]=Olidebron, [2]=Klaffbron,
// [3]=Järnvägsbron, [4]=Stridsbergsbron, [5]=Stallbackabron, [6]=nord-ext.
const FRAC_KLAFFBRON = METRICS.cum[2] / METRICS.total;
const FRAC_STRIDSBERG = METRICS.cum[4] / METRICS.total;
/** Sekunder tills en norrgående båt (speedKn) når given ruttandel. */
const northSecondsToFraction = (frac, speedKn) => Math.round((frac * METRICS.total) / (speedKn * 0.5144));

/**
 * Kurerad scenariomatris. Förväntningar:
 *  - minTargetPassages: minst N detekterade målbro-passager (detektering + INV-5 ⇒ notiser)
 *  - noTargetPassages: inga målbro-passager får detekteras
 *  - zeroNotifications: inga notiser alls
 *  - noVesselText: ingen "på väg mot"-text får publiceras
 *  - minNotifiedBridges: dessa broar MÅSTE ha fått notis
 */
const SCENARIOS = [
  {
    name: 'ren-nord-normal',
    seed: 11,
    vessels: [{ mmsi: '901000001', direction: 'north', speedKn: 4.5 }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'] },
  },
  {
    name: 'ren-syd-normal',
    seed: 12,
    vessels: [{ mmsi: '901000002', direction: 'south', speedKn: 4.5 }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'] },
  },
  {
    name: 'långsam-gles-rapportering',
    seed: 13,
    vessels: [{
      mmsi: '901000003', direction: 'north', speedKn: 1.6, reportIntervalS: 180,
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    name: 'snabb-nord',
    seed: 14,
    vessels: [{
      mmsi: '901000004', direction: 'north', speedKn: 7.5, reportIntervalS: 30,
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    name: 'glapp-över-målbro (SILJA-klassen)',
    seed: 15,
    vessels: [{
      mmsi: '901000005', direction: 'north', speedKn: 4.5, gap: { atFraction: 0.36, durationS: 480 },
    }],
    expect: { minNotifiedBridges: ['Klaffbron'] }, // failsafen ska rädda notisen trots glapp
  },
  {
    name: 'glapp-15min-mitt-i (sandwich-klassen)',
    seed: 16,
    vessels: [{
      mmsi: '901000006', direction: 'north', speedKn: 3.5, gap: { atFraction: 0.25, durationS: 900 },
    }],
    expect: { minTargetPassages: 1 }, // resan ska överleva glappet internt (RC8)
  },
  {
    name: 'väntare-12min-vid-Klaffbron',
    seed: 17,
    vessels: [{
      mmsi: '901000007', direction: 'north', speedKn: 4.0, stop: { atFraction: 0.34, durationS: 720 },
    }],
    expect: { minTargetPassages: 2 }, // ren stillhet får ALDRIG demotera
  },
  {
    name: 'kajliggare-40min (kajbuggen)',
    seed: 18,
    vessels: [{
      mmsi: '901000008', direction: 'north', speedKn: 0, jitterM: 2, moorAt: { ...QUAY, durationS: 2400, navStatus: null },
    }],
    expect: { zeroNotifications: true, noVesselText: true },
  },
  {
    name: 'kajliggare-avgår-norrut',
    seed: 19,
    vessels: [{
      mmsi: '901000009', direction: 'north', speedKn: 4.0, jitterM: 2, moorAt: { ...QUAY, durationS: 1800, navStatus: null }, runRouteAfterMooring: true,
    }],
    expect: { minTargetPassages: 1 }, // Stridsbergsbron efter avgång
  },
  {
    name: 'u-sväng-före-Klaffbron',
    seed: 20,
    vessels: [{
      mmsi: '901000010', direction: 'north', speedKn: 4.5, uTurnAtFraction: 0.30,
    }],
    expect: { noTargetPassages: true },
  },
  {
    name: 'gps-hopp-500m',
    seed: 21,
    vessels: [{
      mmsi: '901000011', direction: 'north', speedKn: 4.5, gpsJump: { atFraction: 0.5, offsetM: 500 },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    name: 'gps-brus-20m',
    seed: 22,
    vessels: [{
      mmsi: '901000012', direction: 'north', speedKn: 4.5, jitterM: 20,
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    name: 'flertrafik-3-båtar',
    seed: 23,
    vessels: [
      {
        mmsi: '901000013', name: 'SYNT-N1', direction: 'north', speedKn: 4.5,
      },
      {
        mmsi: '901000014', name: 'SYNT-N2', direction: 'north', speedKn: 2.5, startOffsetS: 600,
      },
      {
        mmsi: '901000015', name: 'SYNT-S1', direction: 'south', speedKn: 5.0, startOffsetS: 300,
      },
    ],
    expect: { minTargetPassages: 4 },
  },
  {
    name: 'tät-konvoj-2-båtar',
    seed: 24,
    vessels: [
      { mmsi: '901000016', direction: 'north', speedKn: 4.2 },
      {
        mmsi: '901000017', direction: 'north', speedKn: 4.2, startOffsetS: 120,
      },
    ],
    expect: { minTargetPassages: 4 },
  },
  // === Utökning 2026-07-01 (testaudit DEL D + N1/S-F3/S-F4/S-F7-klasserna) ===
  {
    // Äkta tur-och-retur: U-sväng EFTER Klaffbron → returpassagen av samma
    // bro är en NY passage och ska ge en ANDRA notis (journey-reset-vägen,
    // N1). INV-2:s journey-reset-medvetna dubbletthantering dömer.
    name: 'u-sväng-efter-Klaffbron',
    seed: 25,
    vessels: [{
      mmsi: '901000018', direction: 'north', speedKn: 4.5, uTurnAtFraction: 0.45,
    }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Klaffbron'] },
  },
  {
    // Två båtar möts VID Stridsbergsbron — grupplogik, klausulunikhet (INV-9)
    // och att båda får sina målbropassager/notiser utan korskontaminering.
    name: 'möte-vid-Stridsbergsbron',
    seed: 26,
    vessels: [
      {
        mmsi: '901000019', name: 'MÖTE-N', direction: 'north', speedKn: 4.5,
      },
      {
        mmsi: '901000020',
        name: 'MÖTE-S',
        direction: 'south',
        speedKn: 4.5,
        startOffsetS: Math.max(0, northSecondsToFraction(FRAC_STRIDSBERG, 4.5)
          - northSecondsToFraction(1 - FRAC_STRIDSBERG, 4.5)),
      },
    ],
    expect: { minTargetPassages: 4 },
  },
  {
    // navStatus-flap 0↔5 hos en ÄKTA väntare vid Klaffbron — lager 3
    // (navStatus∈{1,5} vid stillhet) får inte demotera en båt som inväntar
    // broöppning (S-F7-klassen).
    name: 'navstatus-flap-väntare',
    seed: 27,
    vessels: [{
      mmsi: '901000021',
      direction: 'north',
      speedKn: 4.0,
      stop: { atFraction: 0.34, durationS: 600 },
      navStatusPattern: [0, 5],
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // Kajliggare med KONSTANT navStatus=5 (moored) — lager 3 ska klassa
    // henne förtöjd; inga notiser, ingen båttext. Första scenariot som
    // faktiskt exercerar navStatus-lagret (korpusarna saknar fältet).
    name: 'navstatus-5-kajliggare',
    seed: 28,
    vessels: [{
      mmsi: '901000022', direction: 'north', speedKn: 0, jitterM: 2, moorAt: { ...QUAY, durationS: 2400, navStatus: 5 },
    }],
    expect: { zeroNotifications: true, noVesselText: true },
  },
  {
    // GPS-outlier som TELEPORTERAR över Klaffbron (en sample, +300 m i
    // färdriktningen, sedan tillbaka på banan) — falsk linjekorsning får
    // inte ge dubbla notiser eller falsk passage (S-F4-klassen).
    name: 'teleport-över-Klaffbron',
    seed: 29,
    vessels: [{
      mmsi: '901000023',
      direction: 'north',
      speedKn: 4.5,
      gpsJump: { atFraction: Math.max(0, FRAC_KLAFFBRON - 150 / METRICS.total), offsetM: 300 },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // RC3-klassen proaktivt: sog-kollaps till 0,6 kn genom själva
    // passagezonen — failsafens tidsskattning får inte strypa notisen.
    name: 'sog-kollaps-vid-Klaffbron',
    seed: 30,
    vessels: [{
      mmsi: '901000024',
      direction: 'north',
      speedKn: 4.5,
      slowZone: { fromFraction: FRAC_KLAFFBRON - 0.03, toFraction: FRAC_KLAFFBRON + 0.01, speedKn: 0.6 },
    }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Klaffbron'] },
  },
  {
    // Krypfart genom hela kanalen — hastighetsgolv/ETA-rimlighet får inte
    // producera absurda texter (INV-1/9) och passagerna ska ändå detekteras.
    name: 'krypfart-0.8kn',
    seed: 31,
    vessels: [{
      mmsi: '901000025', direction: 'north', speedKn: 0.8, reportIntervalS: 300,
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // Varje meddelande levereras DUBBELT (multi-mottagare/AISstream-dubbletter)
    // — utfallet ska vara identiskt med enkel leverans: inga dubbelnotiser.
    name: 'dubblettmeddelanden',
    seed: 32,
    vessels: [{
      mmsi: '901000026', direction: 'north', speedKn: 4.5, duplicateEvery: 1,
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // 35-min-gap i målbrozonen: fartyget stale-raderas (30 min) och återföds
    // BORTOM Klaffbron. Klaffbron-notisen är då >17 min gammal = medvetet
    // INTE notifierad (scenario A-skattningen); resten av resan ska leverera.
    name: 'gap-35min-över-Klaffbron',
    seed: 33,
    vessels: [{
      mmsi: '901000027',
      direction: 'north',
      speedKn: 1.6,
      // Gap-start 1200 m söder om Klaffbron: 2100 s @ 1,6 kn ≈ 1720 m →
      // återfödelse ~520 m norr om Klaffbron (söder om Järnvägsbron) så att
      // resten av resan (Stridsbergsbron) kan levereras normalt.
      gap: { atFraction: Math.max(0, FRAC_KLAFFBRON - 1200 / METRICS.total), durationS: 2100 },
    }],
    expect: { minTargetPassages: 1, minNotifiedBridges: ['Stridsbergsbron'] },
  },
  {
    // Out-of-order-leverans: EN fördröjd gammal position (400 m bakom) mitt
    // i resan — får inte ge sågtand (INV-3), falsk passage eller dubbelnotis.
    name: 'fördröjd-gammal-position',
    seed: 34,
    vessels: [{
      mmsi: '901000028', direction: 'north', speedKn: 4.5, staleEcho: { atFraction: 0.5, backM: 400 },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // Två fartyg med SAMMA namn men olika mmsi — dedup är mmsi-nycklad och
    // får inte korskontaminera.
    name: 'samma-namn-två-mmsi',
    seed: 35,
    vessels: [
      {
        mmsi: '901000029', name: 'HAVSÖRN', direction: 'north', speedKn: 4.2,
      },
      {
        mmsi: '901000030', name: 'HAVSÖRN', direction: 'north', speedKn: 4.2, startOffsetS: 120,
      },
    ],
    expect: { minTargetPassages: 4 },
  },
  {
    // Anslutningsavbrott mitt i passage: AIS-tystnad + disconnect 5 min
    // strax före Klaffbron, reconnect när båten är bortom. Notisen får inte
    // tappas (failsafe-kedjan) och slutstädningen ska vara ren (INV-6/12).
    name: 'avbrott-mitt-i-passage',
    seed: 36,
    vessels: [{
      mmsi: '901000031',
      direction: 'north',
      speedKn: 4.5,
      gap: { atFraction: Math.max(0, FRAC_KLAFFBRON - 200 / METRICS.total), durationS: 300 },
    }],
    events: [
      { ctrl: 'disconnect', atOffsetS: northSecondsToFraction(FRAC_KLAFFBRON - 200 / METRICS.total, 4.5) + 5 },
      { ctrl: 'reconnect', atOffsetS: northSecondsToFraction(FRAC_KLAFFBRON - 200 / METRICS.total, 4.5) + 305 },
    ],
    expect: { minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'] },
  },
];

function runScenario(scenario) {
  const samples = generateScenario(scenario);
  const tmpFile = path.join(os.tmpdir(), `synthetic-${scenario.seed}.jsonl`);
  fs.writeFileSync(tmpFile, samples.map((s) => JSON.stringify(s)).join('\n'));
  try {
    const stdout = execFileSync('node', [RUNNER, tmpFile], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000,
    });
    const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
    if (!m) throw new Error('Ingen JSON-markör i replay-output');
    return { result: JSON.parse(m[1]), sampleCount: samples.length };
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function checkExpectations(scenario, result) {
  const problems = [];
  const e = scenario.expect || {};
  const passages = result.targetPassages || [];
  const notifications = result.notifications || [];

  // Harness-fix (2026-07-01): processErrors är ett TAL — gamla `.length`-
  // kontrollen var död (undefined > 0 är alltid false).
  if ((result.processErrors || 0) > 0) problems.push(`${result.processErrors} processfel`);
  if (result.leakDiagnostics && result.leakDiagnostics.vessels !== 0) {
    problems.push(`${result.leakDiagnostics.vessels} fartyg kvar efter efterspel`);
  }
  if (e.minTargetPassages != null && passages.length < e.minTargetPassages) {
    problems.push(`målbro-passager ${passages.length} < förväntade ${e.minTargetPassages}`);
  }
  if (e.noTargetPassages && passages.length > 0) {
    problems.push(`oväntade målbro-passager: ${passages.map((p) => p.bridge).join(',')}`);
  }
  if (e.zeroNotifications && notifications.length > 0) {
    problems.push(`oväntade notiser: ${notifications.map((n) => `${n.mmsi}:${n.bridge}`).join(',')}`);
  }
  if (e.noVesselText) {
    const vesselTexts = (result.bridgeTextTransitions || []).filter((t) => /på väg mot/.test(t.text));
    if (vesselTexts.length > 0) problems.push(`oväntad båttext: "${vesselTexts[0].text}"`);
  }
  if (e.minNotifiedBridges) {
    const notified = new Set(notifications.map((n) => n.bridge));
    for (const bridge of e.minNotifiedBridges) {
      if (!notified.has(bridge)) problems.push(`saknad notis för ${bridge}`);
    }
  }

  const invariantViolations = validateInvariants(result);
  for (const v of invariantViolations.slice(0, 4)) problems.push(`INVARIANT: ${v}`);
  if (invariantViolations.length > 4) problems.push(`... +${invariantViolations.length - 4} fler invariantbrott`);

  return problems;
}

let failed = false;
console.log('\n=== SYNTETISK SCENARIOSVIT ===');
console.log(`${SCENARIOS.length} scenarier (seedade, deterministiska)\n`);

for (const scenario of SCENARIOS) {
  let outcome;
  try {
    const { result, sampleCount } = runScenario(scenario);
    const problems = checkExpectations(scenario, result);
    if (problems.length === 0) {
      outcome = `✅ ${scenario.name.padEnd(38)} samples=${sampleCount}, passager=${(result.targetPassages || []).length}, notiser=${result.notificationCount}`;
    } else {
      failed = true;
      outcome = `❌ ${scenario.name.padEnd(38)} ${problems.join('; ')}`;
    }
  } catch (err) {
    failed = true;
    outcome = `💥 ${scenario.name.padEnd(38)} ${err.message.slice(0, 120)}`;
  }
  console.log(`  ${outcome}`);
}

console.log('');
if (failed) {
  console.log('❌ MINST ETT SYNTETISKT SCENARIO BRYTER MOT FÖRVÄNTNINGAR/INVARIANTER.');
  process.exit(1);
}
console.log('✅ Alla syntetiska scenarier rena.');
process.exit(0);
