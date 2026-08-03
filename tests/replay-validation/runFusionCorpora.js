'use strict';

/**
 * Fusionsgrinden (etapp 3, 2026-08-02) — `npm run replay:fusion`.
 *
 * För varje LÅST korpus:
 *   1. Generera en AISHub-skuggström (makeFusionCorpus: 65s-pollsnapshots av
 *      senast kända fix, re-leveranser, 150 ms-spridning) och sammanfoga.
 *   2. Kör replayRunner med REPLAY_FUSION=1 — meddelandena matas genom
 *      AISSourceMultiplexer._ingestFromFeed i 'both'-läge, så FixFusionPolicy
 *      F1-F6 sitter PÅ RIKTIGT i vägen (V3-C1: dagens bypass-harness går
 *      förbi fusionslagret och hade gjort grinden till en no-op).
 *   3. Kräv EXAKT parentkorpusens facit: notisantal, (mmsi,bro)-multiset och
 *      (mmsi,bro,riktning)-multiset (distributionsfacit via distKey =
 *      parent-id). Golden-text hoppas MEDVETET över — hub-ekon förskjuter
 *      publiceringstidpunkter utan att ändra innehållsbeslut.
 *   4. Kräv att fusionen var AKTIV: rejected > 0 (ekona ska ha svalts) och
 *      accepted > 0 — en grön körning där F-reglerna aldrig kördes är röd.
 *
 * TVÅ PASS (V4, A/B-natten 2026-08-03) — båda körs ALLTID:
 *   Pass 1 "normal": hub-ekot levereras i pollögonblicket.
 *   Pass 2 "latens": hub-ekots LEVERANSTID skjuts LATENCY_PASS_DELAY_MS framåt
 *      medan fixTs står still — en släpande andrakälla, precis den asymmetri
 *      nattens latenstest fällde koden på: +30 s gav dubbelnotiser på målbro
 *      och +60 s gav sju dubbletter (en av dem 152 m EFTER passagen), medan
 *      källans egen observerade latens hade p90 62,3 s. Facit ska vara EXAKT
 *      identiskt i BÅDA passen — en gammal fix får aldrig kunna flytta ett
 *      fartyg bakåt mot bron och köpa en andra notis.
 *
 * FUSION_PASS=normal|latency kör ETT pass (felsökning). Utan variabeln körs
 * båda — grinden får aldrig kunna bli grön på halva kontraktet.
 *
 * Exit-kod 0 endast om samtliga låsta korpusar håller kontraktet i BÅDA passen.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const corpora = require('./corpora');
const { makeFusionCorpus } = require('./makeFusionCorpus');
const { shiftFeedDelivery } = require('./shiftFeedDelivery');

/** Multiset-räknare (delas av korpuskontrollen och fältkorpusen). */
const countBy = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());

/**
 * Multiset-diff: vad saknas och vad är för mycket.
 * @param {string[]} actual - faktiska nycklar
 * @param {string[]} expected - facitnycklar
 * @returns {{missing: string[], extra: string[]}}
 */
function diffMultiset(actual, expected) {
  const a = countBy(actual);
  const e = countBy(expected);
  const missing = [];
  const extra = [];
  for (const [k, c] of e) for (let i = 0; i < c - (a.get(k) || 0); i++) missing.push(k);
  for (const [k, c] of a) for (let i = 0; i < c - (e.get(k) || 0); i++) extra.push(k);
  return { missing, extra };
}

const distribution = require('./corpora-distribution.json');

const DIRECTION_FILE = path.join(__dirname, 'corpora-direction-distribution.json');
const directionDistribution = fs.existsSync(DIRECTION_FILE)
  ? JSON.parse(fs.readFileSync(DIRECTION_FILE, 'utf8'))
  : {};

// Passageregistret från NORMALPASSET, per korpus-id — latenspasset jämförs
// mot det (se checkCorpus). Fylls i den ordning passen körs.
const passageBaseline = new Map();

const RUNNER = path.join(__dirname, 'replayRunner.js');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-fusion-'));

// Latenspassets förskjutning: 60 s. Härledning — nattens uppmätta AISHub-
// latens var median 27,5 s / p90 62,3 s / max 220,9 s, och 60 s är alltså
// ungefär p90: en fördröjning som källan bevisligen levererar regelbundet,
// inte ett konstruerat extremvärde. Det var också den nivå där den gamla
// koden gick sönder värst (7 dubbletter).
const LATENCY_PASS_DELAY_MS = 60000;

const ALL_PASSES = [
  { id: 'normal', label: 'pass 1: normal leverans', deliveryDelayMs: 0 },
  { id: 'latency', label: `pass 2: leveranslagg +${LATENCY_PASS_DELAY_MS / 1000} s`, deliveryDelayMs: LATENCY_PASS_DELAY_MS },
];
const only = process.env.FUSION_PASS;
const passes = only ? ALL_PASSES.filter((p) => p.id === only) : ALL_PASSES;
if (passes.length === 0) {
  console.log(`❌ Okänt FUSION_PASS='${only}' (giltiga: ${ALL_PASSES.map((p) => p.id).join(', ')})`);
  process.exit(1);
}

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

/**
 * Kör EN korpus i ETT pass och returnera avvikelserna.
 * @param {object} corpus - korpusdefinition ur corpora.js
 * @param {object} pass - {id, label, deliveryDelayMs}
 * @returns {{problems: string[], detail: string}}
 */
function checkCorpus(corpus, pass) {
  const distKey = corpus.fusionOf || corpus.id;
  let result;
  let hubCount = 0;
  try {
    const samples = fs.readFileSync(corpus.jsonl, 'utf8').trim().split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const fusion = makeFusionCorpus(samples, { deliveryDelayMs: pass.deliveryDelayMs });
    hubCount = fusion.hubCount;
    const fusionPath = path.join(TMP_DIR, `${corpus.id}-fusion-${pass.id}.jsonl`);
    fs.writeFileSync(fusionPath, `${fusion.merged.map((s) => JSON.stringify(s)).join('\n')}\n`);
    result = runFusion(fusionPath);
  } catch (err) {
    return { crash: String(err.message || err).slice(0, 160) };
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
      const a = countBy(actualKeys);
      const e = countBy(expectedKeys);
      const missing = [...e].filter(([k, c]) => (a.get(k) || 0) < c).map(([k]) => k);
      // Dubbletterna latenspasset jagar hamnar HÄR (samma nyckel fler gånger).
      const extra = [...a].filter(([k, c]) => (e.get(k) || 0) < c).map(([k]) => k);
      problems.push(`FÖRDELNING AVVIKER: saknas=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
    }
  }

  // Riktningsmultiset mot parentens facit.
  if (directionDistribution[distKey]) {
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
  const byReason = fusion.byReason || {};
  if (!(fusion.accepted > 0)) problems.push('fusionStats.accepted = 0 — muxen satt inte i vägen?');
  if (hubCount > 0 && !(fusion.rejected > 0)) {
    problems.push(`${hubCount} aishub-ekon genererade men fusionStats.rejected = ${fusion.rejected ?? 'null'} — F1/F2b svalde inget?`);
  }
  // Latenspasset måste ha PRÖVAT F6, inte bara råkat överleva. Utan F6 släpps
  // 9-624 släpande hub-fixar per korpus in i pipelinen vid +60 s (mätt
  // offline mot samma korpusar) — är stale_cross_fix noll här har passet
  // antingen inte genererat lagg eller så har grinden slutat sitta i vägen,
  // och den gröna raden vore ett falskt kvitto.
  if (pass.deliveryDelayMs > 0 && hubCount > 0 && !(byReason.stale_cross_fix > 0)) {
    problems.push(`F6 fyrade ALDRIG (stale_cross_fix=${byReason.stale_cross_fix ?? 0}) trots ${pass.deliveryDelayMs} ms leveranslagg — passet prövar inget`);
  }

  // PASSAGEREGISTRET mellan passen (granskningsrunda 2, 2026-08-03).
  // Kontraktet mätte bara notisnycklar, och en latensinducerad regression i
  // PELARE 1 var därför osynlig: en tappad mellanbropassage ändrar ETA-motorns
  // bakben och brotexten utan att en enda notis flyttar sig (mätt: nattens
  // B+30 s gav identiskt notismultiset medan 212571000|Järnvägsbron försvann
  // ur intermediatePassages). Normalpasset är facit — latenspasset ska inte
  // kunna tappa eller uppfinna en passage.
  const passages = {
    intermediate: (result.intermediatePassages || []).map((x) => `${x.mmsi}|${x.bridge}`),
    target: (result.targetPassages || []).map((x) => `${x.mmsi}|${x.bridge}`),
  };
  const baseline = passageBaseline.get(corpus.id);
  if (!baseline) {
    passageBaseline.set(corpus.id, passages);
  } else {
    for (const kind of ['intermediate', 'target']) {
      const d = diffMultiset(passages[kind], baseline[kind]);
      if (d.missing.length || d.extra.length) {
        problems.push(`${kind === 'intermediate' ? 'MELLANBRO' : 'MÅLBRO'}PASSAGER AVVIKER mot normalpasset: `
          + `saknas=[${d.missing.join(', ')}] extra=[${d.extra.join(', ')}]`);
      }
    }
  }

  return {
    problems,
    detail: `notiser=${notifications}/${corpus.expectedNotifications}, ekon=${hubCount} `
      + `(svalda=${fusion.rejected}, accepterade=${fusion.accepted}, feedSwitch=${fusion.feedSwitches}`
      + `${pass.deliveryDelayMs > 0 ? `, F6-svalda=${byReason.stale_cross_fix ?? 0}` : ''})`
      + `, passager=${passages.intermediate.length}+${passages.target.length}`,
  };
}

const locked = corpora.filter((c) => c.locked);
let failed = false;

console.log('=== FUSIONSGRINDEN (REPLAY_FUSION=1 genom AISSourceMultiplexer) ===');
console.log(`${locked.length} låsta korpusar × (original + syntetisk AISHub-skuggström) × ${passes.length} pass\n`);

for (const pass of passes) {
  console.log(`--- ${pass.label} ---`);
  const rows = [];
  for (const corpus of locked) {
    const res = checkCorpus(corpus, pass);
    if (res.crash) {
      failed = true;
      rows.push({ id: corpus.id, status: '💥 KRASCH', detail: res.crash });
    } else if (res.problems.length) {
      failed = true;
      rows.push({ id: corpus.id, status: '❌ AVVIKER', detail: res.problems.join(' | ') });
    } else {
      rows.push({ id: corpus.id, status: '✅ OK', detail: res.detail });
    }
  }
  for (const r of rows) {
    console.log(`  ${r.status.padEnd(12)} ${r.id.padEnd(18)} ${r.detail}`);
  }
  console.log('');
}

// ===========================================================================
// FÄLTKORPUSEN (granskningsrunda 2, 2026-08-03)
// ===========================================================================
// De syntetiska korpusarna ovan sväljer 100 % av hub-ekona (ekot bär
// moderfixens fixTs ⇒ F2/F6 avvisar allt), så de bevisar bara att grindarna
// BLOCKERAR — aldrig att en ACCEPTERAD andrakällefix beter sig rätt. Därmed
// var muxens accept-väg, StatusServices segmentbevis, korskälle-fysik-dt:t och
// klockkompensationen helt oexekverade i det permanenta batteriet: exakt den
// blindfläcksklass som en gång skapade fältprov 3-regressionen.
//
// Fältkorpusen är A/B-nattens B-arm (2026-08-02/03, 1385 rader: 371 aisstream
// + 1014 ÄKTA AISHub-poster). Där accepteras ~1090 fixar varav en stor del är
// hub-attribuerade, och hela dubbelkällekedjan körs på riktig trafik.
// Facit är det verkliga utfallet, oberoende verifierat mot nattens
// notislogg (A-armens 22 nycklar + de två äkta extranotiserna).
const FIELD_CORPUS = path.join(__dirname, 'corpora-data', 'ais-fusion-20260803-nattkorning.jsonl');

// A-armens 22 notisnycklar (mmsi|bro) ur field-notif.txt + de TVÅ äkta
// extranotiser andrakällan tillför: TIM@Stallbackabron (aisstream-glapp
// ~1,5 min) och NANNA@Kanalinfarten.
const FIELD_EXPECTED_KEYS = [
  '211648800|Kanalinfarten', '211648800|Klaffbron', '211648800|Olidebron',
  '212571000|Kanalinfarten', '212571000|Klaffbron', '212571000|Järnvägsbron',
  '212571000|Olidebron', '212571000|Stridsbergsbron', '212571000|Stallbackabron',
  '219001291|Klaffbron', '219001291|Olidebron', '219001291|Kanalinfarten',
  '231907000|Kanalinfarten', '231907000|Klaffbron', '231907000|Järnvägsbron',
  '231907000|Olidebron', '231907000|Stridsbergsbron', '231907000|Stallbackabron',
  '265576720|Kanalinfarten', '265576720|Klaffbron', '265576720|Järnvägsbron',
  '265576720|Olidebron', '265576720|Stridsbergsbron', '265576720|Stallbackabron',
];

// Varianterna. Leveranslagg = shiftFeedDelivery (fixTs orörd); klockskev =
// hub-radernas fixTs förskjuts (leveransordningen orörd). Skevpasset är det
// enda som kan fälla F6b — makeFusionCorpus och shiftFeedDelivery härleder
// båda ekots fixTs ur korpusstämplarna och är per konstruktion blinda för
// fixtidsskev.
const FIELD_VARIANTS = [
  {
    id: 'B', label: 'fältkorpus: B-armen som den levererades', delayMs: 0, skewMs: 0,
  },
  {
    id: 'B+30s', label: 'fältkorpus: +30 s leveranslagg (källans median 27,5 s)', delayMs: 30000, skewMs: 0,
  },
  {
    id: 'B+60s', label: 'fältkorpus: +60 s leveranslagg (källans p90 62,3 s)', delayMs: 60000, skewMs: 0,
  },
  {
    id: 'B+60s/skev+60s', label: 'fältkorpus: +60 s lagg OCH hubklockan 60 s FÖRE', delayMs: 60000, skewMs: 60000,
  },
  {
    id: 'B/skev+300s', label: 'fältkorpus: hubklockan 5 min FÖRE (bortom F4a-klampen)', delayMs: 0, skewMs: 300000,
  },
];

function runFieldVariant(variant) {
  const rows = fs.readFileSync(FIELD_CORPUS, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  let out = rows;
  if (variant.skewMs) {
    out = out.map((r) => (r.feed === 'aishub' && Number.isFinite(r.fixTs)
      ? { ...r, fixTs: r.fixTs + variant.skewMs } : r));
  }
  if (variant.delayMs) {
    out = shiftFeedDelivery(out, variant.delayMs, 'aishub').rows;
  }
  const p = path.join(TMP_DIR, `field-${variant.id.replace(/[^\w+]/g, '_')}.jsonl`);
  fs.writeFileSync(p, `${out.map((s) => JSON.stringify(s)).join('\n')}\n`);
  const result = runFusion(p);

  const problems = [];
  const notifs = result.notifications || [];
  const keys = notifs.map((n) => `${n.mmsi}|${n.bridge}`);
  const d = diffMultiset(keys, FIELD_EXPECTED_KEYS);
  if (d.missing.length || d.extra.length) {
    problems.push(`NOTISNYCKLAR AVVIKER: saknas=[${d.missing.join(', ')}] extra=[${d.extra.join(', ')}]`);
  }
  const dupes = [...countBy(keys)].filter(([, c]) => c > 1);
  if (dupes.length) {
    problems.push(`DUBBLETTER: ${dupes.map(([k, c]) => `${k}×${c}`).join(', ')}`);
  }
  // PRICKBJORN 265012090 07:19:11 — kajvobbelfantomen V1 stänger.
  if (keys.some((k) => k.startsWith('265012090|'))) {
    problems.push('FANTOM: 265012090 (PRICKBJORN) notifierades — V1-grinden läcker');
  }
  // Mellanbropassagerna V2 räddar. TIM/Järnvägsbron är den som föll bort i
  // BÅDA latensvarianterna innan källgrinden formulerades om till källnärvaro.
  const ip = (result.intermediatePassages || []).map((x) => `${x.mmsi}|${x.bridge}`);
  for (const want of ['212571000|Olidebron', '212571000|Järnvägsbron']) {
    if (!ip.includes(want)) problems.push(`MELLANBROPASSAGE SAKNAS: ${want}`);
  }
  const fusion = result.fusionStats || {};
  // Kontraktets kärna: här SKA hub-fixar accepteras (till skillnad från de
  // syntetiska korpusarna). Blir accepted lika med antalet aisstream-rader
  // har andrakällan tystnat och passet bevisar ingenting.
  const streamRows = rows.filter((r) => r.feed !== 'aishub').length;
  if (!(fusion.accepted > streamRows)) {
    problems.push(`INGEN hub-fix accepterad (accepted=${fusion.accepted} ≤ aisstream-rader ${streamRows}) — accept-vägen oexekverad`);
  }
  return {
    problems,
    detail: `notiser=${keys.length}/${FIELD_EXPECTED_KEYS.length}, mellanbropassager=${ip.length}, `
      + `accepterade=${fusion.accepted} (varav hub ≈ ${fusion.accepted - streamRows}), `
      + `avvisade=${fusion.rejected}, hubOffsetMs=${fusion.hubClockOffsetMs}`,
  };
}

if (!process.env.FUSION_PASS) {
  console.log('--- fältkorpus: A/B-nattens B-arm (äkta AISHub-poster, accept-vägen) ---');
  for (const variant of FIELD_VARIANTS) {
    let res;
    try {
      res = runFieldVariant(variant);
    } catch (err) {
      res = { problems: [`KRASCH: ${String(err.message || err).slice(0, 160)}`], detail: '' };
    }
    if (res.problems.length) {
      failed = true;
      console.log(`  ${'❌ AVVIKER'.padEnd(12)} ${variant.id.padEnd(18)} ${res.problems.join(' | ')}`);
    } else {
      console.log(`  ${'✅ OK'.padEnd(12)} ${variant.id.padEnd(18)} ${res.detail}`);
    }
  }
  console.log('');
}

try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) { /* tempstädning är best effort */ }

if (failed) {
  console.log('❌ Fusionsgrinden RÖD — F-reglerna läcker eller facit flyttades.');
  process.exit(1);
} else {
  console.log(`✅ Fusionsgrinden grön i ${passes.length} pass: identiskt facit med F1-F6 i vägen, alla ekon svalda — även med ${LATENCY_PASS_DELAY_MS / 1000} s leveranslagg.`);
  console.log('✅ Fältkorpusen grön i 5 varianter: accepterade AISHub-fixar, oförändrat notisfacit under lagg OCH klockskev.');
}
