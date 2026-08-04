'use strict';

/**
 * TÄCKNINGSKARTAN (etapp 6, 2026-08-03) — diagnosverktyg, INTE en gate.
 *
 * Frågan den besvarar: VAR längs farleden, och FÖR VILKEN KÄLLA, tappar vi
 * kontakten med båtarna? Notislöftet (pelare 2) och brotexten (pelare 1) kan
 * aldrig bli bättre än mottagningen — en båt som är radiotyst de sista 700
 * metrarna kan bara räddas av en deadline-motor, och för att dimensionera den
 * måste man veta hur långa glappen FAKTISKT är, var de ligger och om de skiljer
 * sig mellan källorna.
 *
 * Metod:
 *   1. Farleden modelleras som en polylinje (centerlinje) genom Kanalinfarten →
 *      Olidebron → Klaffbron → Järnvägsbron → Stridsbergsbron → Stallbackabron.
 *   2. Varje AIS-fix projiceras på polylinjen → (s = meter längs farleden,
 *      lateralt avstånd). Fixar utanför korridoren räknas men kartläggs inte.
 *   3. Farleden delas i 100 m-segment. Per SEGMENT och per KÄLLA räknas
 *      transitfixar (sog ≥ 2 kn), glapp mellan konsekutiva fixar för samma
 *      fartyg medan det passerar segmentet, mörka passager (traversering utan
 *      en enda fix) och blackouts (glapp > 120 s i rörelse).
 *
 * Utdata:  docs/coverage-map-2026-08-03.json  (maskinläsbar)
 *          docs/coverage-map-2026-08-03.md    (segmenttabell + heatmap + verdikt)
 *
 * Användning (från io.ais.tracker/):
 *   node tests/replay-validation/coverageMap.js
 *   node tests/replay-validation/coverageMap.js --corpus 20260803-natt
 *   node tests/replay-validation/coverageMap.js extra-korpus.jsonl --md /tmp/x.md
 *
 * KLOCKDOMÄNEN (ARCHITECTURE §mux): analysen körs i FIXTIDSDOMÄNEN
 * (fixTs ?? aisTimestamp) — "när hörde mottagarnätet båten". För aisstream är
 * fixTs identiskt med mottagningstiden (pushlatens ~2 s); för AISHub är fixTs
 * den riktiga fixtiden medan aisTimestamp är pollens leveranstid. Att mäta
 * AISHub i leveransdomänen hade gett 65 s-kvantiserade "glapp" för allting —
 * det är pollkadensen, inte antennen. Leveranslatensen redovisas separat.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { calculateDistance, distancePointToSegmentM } = require('../../lib/utils/geometry');
const {
  BRIDGES, TRIGGER_POINTS, MOORING_ZONES, TARGET_BRIDGES,
} = require('../../lib/constants');
const corpora = require('./corpora');

// =============================================================================
// KONSTANTER — HÄRLEDDA UR KORPUSDATAN (16 korpusar, 7 113 fixar, ~250 h)
// =============================================================================

/**
 * FARLEDENS CENTERLINJE.
 *
 * Härledd (2026-08-03) ur korpusarna själva och sedan HÅRDKODAD, så att kartan
 * blir identisk oavsett vilken delmängd korpusar man kör: metoden var
 * (1) parameterisera med raka linjer bro→bro, (2) medianposition per 200
 * m-intervall av de 1 843 rörelsefixarna (sog ≥ 2 kn), (3) 3-punkts glidande
 * medel, (4) itererat 6 varv tills linjen slutat flytta sig.
 *
 * VARFÖR INTE bara raka linjer mellan broarna? Kanalen svänger. Mot den raka
 * bro-till-bro-linjen låg de faktiska fartygsspåren systematiskt fel: −110 m
 * mitt emellan Olidebron och Klaffbron, −200 m söder om Stallbackabron
 * (p90 = 277 m, max 1 161 m). Med centerlinjen: p50 = 7 m, p90 = 21 m,
 * p95 = 27 m. Segmentgränserna blir därmed verkliga 100-metersrutor vatten,
 * inte projektionsartefakter.
 *
 * KONTROLL mot BRIDGE_GAPS (fågelvägen, lib/constants.js): längs centerlinjen
 * blir gapen 1 379 / 970 / 256 / 2 308 m mot fågelvägens 1 363 / 960 / 257 /
 * 2 310 — ≤ 1,2 % skillnad, dvs. linjen är inte "för lång" (ingen brusvandring).
 */
const FAIRWAY_CENTERLINE = [
  [58.266182, 12.265678], // syd om Kanalinfarten (linjen får sticka ut så
  [58.266974, 12.267364], // projektionen inte klampas vid kartkanten)
  [58.268148, 12.269487],
  [58.269666, 12.271336],
  [58.271115, 12.273089],
  [58.272623, 12.275187],
  [58.274023, 12.277223],
  [58.275511, 12.278996],
  [58.277131, 12.280357],
  [58.278880, 12.281455],
  [58.280634, 12.282491],
  [58.282358, 12.283304],
  [58.284121, 12.284090],
  [58.285744, 12.285113],
  [58.287316, 12.286620],
  [58.288811, 12.288494],
  [58.290304, 12.290368],
  [58.291837, 12.292365],
  [58.293306, 12.294437],
  [58.294803, 12.296596],
  [58.296245, 12.298479],
  [58.297762, 12.300141],
  [58.299319, 12.301741],
  [58.300919, 12.303555],
  [58.302434, 12.305403],
  [58.303832, 12.307336],
  [58.305248, 12.309438],
  [58.306606, 12.311662],
  [58.308003, 12.313981],
  [58.309444, 12.316087],
  [58.311078, 12.317832],
  [58.312816, 12.319032],
  [58.314505, 12.319908],
  [58.316219, 12.320817],
  [58.317834, 12.321855],
  [58.318914, 12.322573], // norr om Stallbackabron
];

/** Segmentlängd (m). 100 m ≈ 30 s färd i 6,5 kn (p95-farten i korpusarna). */
const SEGMENT_M = 100;

/**
 * TRANSITFART. Uppdragsgiven (sog ≥ 2 kn) och datastödd: av 7 113 fixar ligger
 * 4 387 (62 %) på exakt 0 kn (förtöjda/ankrade) och 883 (12 %) i 0–2 kn
 * (kajvobbel, manöver, GPS-brus). 2 kn skiljer alltså transit från allt annat
 * med bred marginal — jfr MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN = 0,5.
 */
const TRANSIT_SOG_KN = 2;

/**
 * BLACKOUT-TRÖSKEL (s). Uppdragsgiven. OBS vid tolkning: medianglappet mellan
 * två konsekutiva fixar för ett fartyg I RÖRELSE är 120 s i korpusarna
 * (p25 = 61, p75 = 242, p90 = 531) — 51,9 % av alla rörelselänkar passerar
 * alltså tröskeln. "Blackout" är därför normaltillståndet, inte undantaget;
 * därför graderas listan (se BLACKOUT_TIERS).
 */
const BLACKOUT_S = 120;

/** Gradering av blackouts, så topplistan inte dränks av medianfallet. */
const BLACKOUT_TIERS = [
  { name: 'kritisk', minS: 600 },
  { name: 'allvarlig', minS: 300 },
  { name: 'glapp', minS: BLACKOUT_S },
];

/**
 * KORRIDORBREDD (m, lateralt från centerlinjen). p99 för rörelsefixarnas
 * lateralavstånd är 118 m; 150 m tar med hela farleden inkl. mötande trafik
 * och kajnära manöver men utesluter Spikö-ankringen och gästhamnarna
 * (max-utliggaren låg på 877 m).
 */
const CORRIDOR_M = 150;

/**
 * MAXLÄNK (s). Två fixar längre isär än så knyts inte ihop till en länk —
 * bortom en timme är "samma resa" inte längre bevisbart (jfr
 * TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN = 30 min, som är appens egen gräns för
 * hur länge en resa får leva utan data).
 */
const MAX_LINK_S = 3600;

/**
 * GPS-HOPPVAKT (kn). En länk som implicerar högre fart än så är ett hopp, inte
 * en färd — samma skepsis som GPSJumpAnalyzer har mot omöjlig fysik. Kanalens
 * snabbaste observerade fix ligger på 33,2 kn (en RIB), så 40 kn släpper
 * igenom all verklig trafik.
 */
const MAX_IMPLIED_KN = 40;

/**
 * KORSKÄLLE-DEDUP för den sammanslagna vyn ('fusion'): samma fysiska AIS-
 * rapport levererad av båda källorna. Etapp 5-mätningen på nattkorpusen fann
 * 282 korskällepar med median 2,3 s tidsskillnad (aisstreams pushlatens);
 * 10 s/30 m fångar dem utan att slå ihop två skilda rapporter (i 6 kn hinner
 * en båt 31 m på 10 s).
 */
const CROSS_SOURCE_DEDUP_S = 10;
const CROSS_SOURCE_DEDUP_M = 30;

/** Nattkorpusen (2026-08-03) — enda TVÅKÄLLIGA korpusen. */
const NIGHT_CORPUS = {
  id: '20260803-natt',
  jsonl: path.join(__dirname, 'corpora-data', 'ais-fusion-20260803-nattkorning.jsonl'),
  hours: 10,
  note: 'A/B-natten: aisstream + AISHub parallellt',
};

const DOCS_DIR = path.resolve(__dirname, '../../docs');
const DEFAULT_JSON = path.join(DOCS_DIR, 'coverage-map-2026-08-03.json');
const DEFAULT_MD = path.join(DOCS_DIR, 'coverage-map-2026-08-03.md');

// =============================================================================
// 1. FARLEDSGEOMETRI
// =============================================================================

const M_PER_DEG_LAT = 111320;

/**
 * Projicera en punkt på ett segment A→B. Samma ekvirektangulära matematik som
 * geometry.distancePointToSegmentM (som bara returnerar avståndet) — här
 * behövs även parametern t för att få fram sträckan längs farleden.
 * @param {number} lat - punktens latitud
 * @param {number} lon - punktens longitud
 * @param {object} leg - {a:{lat,lon}, b:{lat,lon}, len, cum}
 * @param {number} tMin - lägsta tillåtna t (< 0 förlänger segmentet bakåt)
 * @param {number} tMax - högsta tillåtna t (> 1 förlänger segmentet framåt)
 * @returns {{t:number, offsetM:number}} projektion
 */
function projectOnLeg(lat, lon, leg, tMin, tMax) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(leg.a.lat * (Math.PI / 180));
  const px = (lon - leg.a.lon) * mPerDegLon;
  const py = (lat - leg.a.lat) * M_PER_DEG_LAT;
  const bx = (leg.b.lon - leg.a.lon) * mPerDegLon;
  const by = (leg.b.lat - leg.a.lat) * M_PER_DEG_LAT;
  const segLenSq = (bx * bx) + (by * by);
  let t = segLenSq > 0 ? ((px * bx) + (py * by)) / segLenSq : 0;
  t = Math.max(tMin, Math.min(tMax, t));
  const dx = px - (t * bx);
  const dy = py - (t * by);
  return { t, offsetM: Math.sqrt((dx * dx) + (dy * dy)) };
}

/**
 * Skär en brolinje (punkt + axelbäring, samma modell som
 * geometry.hasCrossedBridgeLine använder) mot centerlinjen. Ger den punkt där
 * bron FAKTISKT korsar farleden — inte närmaste punkt till brons koordinat.
 * @param {object[]} legs - farledens segment
 * @param {object} anchor - {lat, lon, axisBearing}
 * @returns {{s:number, offsetM:number, mode:string}|null} skärning
 */
function intersectBridgeAxis(legs, anchor) {
  const brg = anchor.axisBearing * (Math.PI / 180);
  const dNorth = Math.cos(brg);
  const dEast = Math.sin(brg);
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(anchor.lat * (Math.PI / 180));
  let best = null;
  for (const leg of legs) {
    const ax = (leg.a.lon - anchor.lon) * mPerDegLon;
    const ay = (leg.a.lat - anchor.lat) * M_PER_DEG_LAT;
    const ex = ((leg.b.lon - anchor.lon) * mPerDegLon) - ax;
    const ey = ((leg.b.lat - anchor.lat) * M_PER_DEG_LAT) - ay;
    const den = (ex * dNorth) - (ey * dEast);
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ay * dEast) - (ax * dNorth)) / den;
    if (t < 0 || t > 1) continue;
    // u = avstånd längs brolinjen från brons koordinat till skärningen
    const u = ((ax * ey) - (ay * ex)) / -den;
    if (!best || Math.abs(u) < Math.abs(best.offsetM)) {
      best = { s: leg.cum + (t * leg.len), offsetM: Math.abs(u), mode: 'axis' };
    }
  }
  return best;
}

/**
 * Bygg farledsmodellen: segment, längd och ankarpunkter (broar + Kanalinfarten).
 * @returns {object} farled
 */
function buildFairway() {
  const pts = FAIRWAY_CENTERLINE.map(([lat, lon]) => ({ lat, lon }));
  const legs = [];
  let cum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = calculateDistance(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon);
    legs.push({
      a: pts[i], b: pts[i + 1], len, cum, index: i,
    });
    cum += len;
  }

  const rawAnchors = [
    { name: 'Kanalinfarten', lat: TRIGGER_POINTS.kanalinfarten.lat, lon: TRIGGER_POINTS.kanalinfarten.lon },
    { name: 'Olidebron', ...BRIDGES.olidebron },
    { name: 'Klaffbron', ...BRIDGES.klaffbron },
    { name: 'Järnvägsbron', ...BRIDGES.jarnvagsbron },
    { name: 'Stridsbergsbron', ...BRIDGES.stridsbergsbron },
    { name: 'Stallbackabron', ...BRIDGES.stallbackabron },
  ];

  const fairway = { pts, legs, lengthM: cum };
  const anchors = rawAnchors.map((a) => {
    const axis = Number.isFinite(a.axisBearing) ? intersectBridgeAxis(legs, a) : null;
    const perp = projectRaw(fairway, a.lat, a.lon);
    const hit = axis || { s: perp.s, offsetM: perp.offsetM, mode: 'perp' };
    return {
      name: a.name, lat: a.lat, lon: a.lon, sRaw: hit.s, offsetM: hit.offsetM, mode: hit.mode,
    };
  });

  const sOrigin = anchors[0].sRaw;
  anchors.forEach((a) => {
    a.s = a.sRaw - sOrigin;
  });
  fairway.anchors = anchors;
  fairway.sOrigin = sOrigin;
  fairway.mapEndM = anchors[anchors.length - 1].s; // Stallbackabron
  fairway.segmentCount = Math.ceil(fairway.mapEndM / SEGMENT_M);
  return fairway;
}

/**
 * Rå projektion i centerlinjens eget s-system (0 = linjens sydspets).
 * @param {object} fairway - farledsmodellen
 * @param {number} lat - latitud
 * @param {number} lon - longitud
 * @returns {{s:number, offsetM:number, legIndex:number}} projektion
 */
function projectRaw(fairway, lat, lon) {
  let best = null;
  const last = fairway.legs.length - 1;
  for (const leg of fairway.legs) {
    // Terminalsegmenten förlängs så fixar utanför kartan får ett vettigt s
    // (annars klampas de och trängs ihop på kartkanten).
    const tMin = leg.index === 0 ? -2 : 0;
    const tMax = leg.index === last ? 3 : 1;
    const p = projectOnLeg(lat, lon, leg, tMin, tMax);
    if (!best || p.offsetM < best.offsetM) {
      best = { s: leg.cum + (p.t * leg.len), offsetM: p.offsetM, legIndex: leg.index };
    }
  }
  return best;
}

/**
 * Projicera en fix på farleden, i kartans koordinater (s = 0 vid Kanalinfarten).
 * @param {object} fairway - farledsmodellen
 * @param {number} lat - latitud
 * @param {number} lon - longitud
 * @returns {{s:number, offsetM:number, inMap:boolean, inCorridor:boolean}} projektion
 */
function projectFix(fairway, lat, lon) {
  const raw = projectRaw(fairway, lat, lon);
  const s = raw.s - fairway.sOrigin;
  const inMap = s >= 0 && s <= fairway.mapEndM;
  // inCorridor mäter ENBART sidled. En fix strax utanför kartänden är fortfarande
  // en giltig länkändpunkt — annars tappar kantsegmenten sin exponeringstid och
  // får konstlat hög fixfrekvens (kantartefakt).
  return {
    s, offsetM: raw.offsetM, inMap, inCorridor: raw.offsetM <= CORRIDOR_M,
  };
}

/**
 * Självkontroll: vår projektion ska ge samma lateralavstånd som produktionens
 * geometry.distancePointToSegmentM för samma segment (fältlist-fällans
 * motsvarighet för geometri — bygg ingen parallell sanning).
 * @param {object} fairway - farledsmodellen
 * @returns {{checked:number, maxDeltaM:number}} resultat
 */
function selfCheckProjection(fairway) {
  let maxDelta = 0;
  let checked = 0;
  for (const leg of fairway.legs) {
    for (const frac of [0.25, 0.5, 0.75]) {
      const lat = leg.a.lat + ((leg.b.lat - leg.a.lat) * frac) + 0.0004;
      const lon = leg.a.lon + ((leg.b.lon - leg.a.lon) * frac) + 0.0004;
      const mine = projectOnLeg(lat, lon, leg, 0, 1).offsetM;
      const prod = distancePointToSegmentM(lat, lon, leg.a.lat, leg.a.lon, leg.b.lat, leg.b.lon);
      maxDelta = Math.max(maxDelta, Math.abs(mine - prod));
      checked++;
    }
  }
  return { checked, maxDeltaM: maxDelta };
}

// =============================================================================
// 2. INLÄSNING
// =============================================================================

/**
 * Läs en korpus-jsonl och normalisera till analysposter.
 * @param {string} file - sökväg
 * @returns {{rows:object[], skipped:number}} poster
 */
function loadCorpus(file) {
  const rows = [];
  let skipped = 0;
  const seen = new Set();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (e) {
      skipped++;
      continue;
    }
    if (!r || !r.mmsi || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) {
      skipped++;
      continue;
    }
    // Klockdomän F (fysik/fusion): fixTs när källan bär den, annars
    // mottagningsstämpeln — för aisstream är de identiska per konstruktion.
    const ts = Number.isFinite(r.fixTs) ? r.fixTs : r.aisTimestamp;
    if (!Number.isFinite(ts)) {
      skipped++;
      continue;
    }
    const feed = r.feed || 'aisstream';
    // Dedup: AISHubs poll returnerar samma fix tills en nyare finns.
    const key = `${r.mmsi}|${feed}|${ts}|${r.lat}|${r.lon}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    rows.push({
      mmsi: String(r.mmsi),
      name: r.shipName || 'Unknown',
      lat: r.lat,
      lon: r.lon,
      sog: Number.isFinite(r.sog) ? r.sog : null,
      // AIS-KLASSEN (granskningen 2026-08-04): rapporten påstod i fast text
      // att "Klass A sänder var 2–10:e sekund", men två tredjedelar av
      // transitmaterialet är Klass B (30 s i fart, 3 min i stillhet). Utan
      // fältet gick påståendet inte att räkna om mot underlaget.
      classB: /StandardClassB|ClassBPosition|ExtendedClassB/i.test(String(r.msgType || '')),
      feed,
      ts,
      deliveryTs: Number.isFinite(r.aisTimestamp) ? r.aisTimestamp : ts,
    });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { rows, skipped };
}

/**
 * Bygg den sammanslagna (fusions-)vyn: unionen av båda källornas fixar med
 * korskälledubbletterna borttagna. Motsvarar bästa möjliga täckning i
 * 'both'-läge (FixFusionPolicy avvisar en del av dem i produktion — den här
 * vyn är taket, inte prognosen).
 * @param {object[]} vesselRows - alla fixar för ETT fartyg
 * @returns {{rows:object[], merged:number}} sammanslagen ström
 */
function buildFusionView(vesselRows) {
  const sorted = vesselRows.slice().sort((a, b) => a.ts - b.ts);
  const out = [];
  let merged = 0;
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.feed !== r.feed && (r.ts - prev.ts) <= CROSS_SOURCE_DEDUP_S * 1000) {
      const d = calculateDistance(prev.lat, prev.lon, r.lat, r.lon);
      if (d !== null && d <= CROSS_SOURCE_DEDUP_M) {
        merged++;
        continue;
      }
    }
    out.push(r);
  }
  return { rows: out, merged };
}

// =============================================================================
// 3. ANALYS
// =============================================================================

/** @returns {object} tomt segmentkonto */
function emptySegment() {
  return {
    fixes: 0,
    transitFixes: 0,
    gaps: [],
    // ÄNDPUNKTSATTRIBUERADE glapp (granskningen 2026-08-04): `gaps` bokförs på
    // VARJE segment länken spänner, vilket gör p50 till ett CENTRALITETSmått —
    // långa glapp som började någon annanstans passerar mitten. `endGaps`
    // bokförs bara där kontakten faktiskt TAPPADES (segmentet för fix a) och
    // där den ÅTERKOM (fix b). Med ärlig attribution är sektorernas p50
    // praktiskt taget identiska (120–144 s) — korrelationen mellan profilerna
    // över alla 56 segment är r ≈ 0,14, dvs. de mäter inte samma sak.
    endGaps: [],
    exposureSec: 0,
    // BLINDTID: den del av exponeringstiden som ligger inuti ett glapp längre
    // än tröskeln. Det operativt viktigaste måttet — "hur stor del av tiden i
    // det här segmentet är appen blind?" — och det enda som är oberoende av
    // både fart (till skillnad från mörka passager) och av hur exponeringen
    // viktas mellan resor (till skillnad från fixfrekvensen).
    blind120Sec: 0,
    blind300Sec: 0,
    traversals: 0,
    darkTraversals: 0,
    blackouts: 0,
  };
}

/**
 * @param {number[]} arr - värden
 * @param {number} p - kvantil 0..1
 * @returns {number|null} kvantilvärde
 */
function quantile(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)));
  return a[idx];
}

/**
 * Segmentindex för en sträcka längs farleden.
 * @param {object} fairway - farledsmodellen
 * @param {number} s - meter längs farleden
 * @returns {number} segmentindex
 */
function segIndex(fairway, s) {
  return Math.max(0, Math.min(fairway.segmentCount - 1, Math.floor(s / SEGMENT_M)));
}

/**
 * Analysera en korpus.
 * @param {object} corpus - {id, jsonl, hours}
 * @param {object} fairway - farledsmodellen
 * @returns {object} resultat
 */
function analyzeCorpus(corpus, fairway) {
  const { rows, skipped } = loadCorpus(corpus.jsonl);
  const sources = new Map(); // källa → { segments:[], links, ... }
  const blackouts = [];
  const motionLost = [];
  const runsBySector = [];
  const targetApproaches = [];
  const latency = new Map();
  const vessels = new Map();
  // Gemensam nämnare för källjämförelsen: resorna definieras av den
  // SAMMANSLAGNA vyn, så en källa som missade hela passagen räknas som mörk i
  // stället för att försvinna ur statistiken (överlevnadsbias). Fylls i slutet
  // av fartygsloopen, när alla källors projicerade fixar finns tillgängliga.
  const commonCoverage = new Map();
  let outOfMap = 0;
  let outSouth = 0;
  let outNorth = 0;
  let outOfCorridor = 0;
  let mergedCrossSource = 0;

  // AIS-KLASSFÖRDELNINGEN bland TRANSITfixar (sog ≥ transitgränsen). Måttet
  // finns för att rapportens sändningstakts-påstående ska vara räknat, inte
  // skrivet: Klass A sänder var 2–10:e sekund i fart, Klass B var 30:e.
  const classMix = { classA: 0, classB: 0 };
  for (const r of rows) {
    if (!vessels.has(r.mmsi)) vessels.set(r.mmsi, []);
    vessels.get(r.mmsi).push(r);
    if (!latency.has(r.feed)) latency.set(r.feed, []);
    latency.get(r.feed).push((r.deliveryTs - r.ts) / 1000);
    if (r.feed !== 'aishub' && Number.isFinite(r.sog) && r.sog >= TRANSIT_SOG_KN) {
      if (r.classB) classMix.classB += 1;
      else classMix.classA += 1;
    }
  }

  const feedsPresent = new Set(rows.map((r) => r.feed));
  const sourceKeys = [...feedsPresent];
  if (feedsPresent.size > 1) sourceKeys.push('fusion');

  /**
   * @param {string} key - källnyckel
   * @returns {object} källkonto
   */
  const src = (key) => {
    if (!sources.has(key)) {
      sources.set(key, {
        segments: Array.from({ length: fairway.segmentCount }, emptySegment),
        fixes: 0,
        transitFixes: 0,
        links: 0,
        transitLinks: 0,
        runs: 0,
        gapAll: [],
      });
    }
    return sources.get(key);
  };
  sourceKeys.forEach(src);

  for (const [mmsi, vrows] of vessels) {
    const perSource = new Map();
    for (const r of vrows) {
      if (!perSource.has(r.feed)) perSource.set(r.feed, []);
      perSource.get(r.feed).push(r);
    }
    if (sourceKeys.includes('fusion')) {
      const fused = buildFusionView(vrows);
      mergedCrossSource += fused.merged;
      perSource.set('fusion', fused.rows);
    }
    const referenceRuns = [];
    const projectedBySource = new Map();

    for (const [key, list] of perSource) {
      const acc = src(key);
      const fixes = list
        .slice()
        .sort((a, b) => a.ts - b.ts)
        .map((r) => ({ ...r, proj: projectFix(fairway, r.lat, r.lon) }));
      projectedBySource.set(key, fixes);

      // --- fixräkning per segment ---
      for (const f of fixes) {
        if (!f.proj.inMap) {
          if (key !== 'fusion') {
            outOfMap++;
            if (f.proj.s < 0) outSouth++;
            else outNorth++;
          }
          continue;
        }
        if (!f.proj.inCorridor) {
          if (key !== 'fusion') outOfCorridor++;
          continue;
        }
        acc.fixes++;
        const seg = acc.segments[segIndex(fairway, f.proj.s)];
        seg.fixes++;
        if (f.sog !== null && f.sog >= TRANSIT_SOG_KN) {
          seg.transitFixes++;
          acc.transitFixes++;
        }
      }

      // --- länkar (par av konsekutiva fixar) ---
      let run = null;
      const closeRun = () => {
        if (!run) return;
        if (run.links > 0 && run.sMax >= 0 && run.sMin <= fairway.mapEndM) {
          acc.runs++;
          const lo = segIndex(fairway, Math.max(0, run.sMin));
          const hi = segIndex(fairway, Math.min(fairway.mapEndM, run.sMax));
          const sectorExposure = {};
          const sectorFixes = {};
          const sectorBlind = {};
          for (let i = lo; i <= hi; i++) {
            acc.segments[i].traversals++;
            if (!run.segFixes.has(i)) acc.segments[i].darkTraversals++;
            const sec = sectorOf(fairway, (i * SEGMENT_M) + (SEGMENT_M / 2));
            sectorExposure[sec] = (sectorExposure[sec] || 0) + (run.expBySeg.get(i) || 0);
            sectorFixes[sec] = (sectorFixes[sec] || 0) + (run.fixesBySeg.get(i) || 0);
            sectorBlind[sec] = (sectorBlind[sec] || 0) + (run.blindBySeg.get(i) || 0);
          }
          runsBySector.push({
            corpus: corpus.id, mmsi, source: key, sectorExposure, sectorFixes, sectorBlind,
          });
          if (key === 'fusion' || sourceKeys.length === 1) {
            referenceRuns.push({
              mmsi, lo, hi, tFrom: run.tFrom, tTo: run.tTo,
            });
          }
        }
        run = null;
      };

      for (let i = 1; i < fixes.length; i++) {
        const a = fixes[i - 1];
        const b = fixes[i];
        const dt = (b.ts - a.ts) / 1000;
        if (dt <= 0) continue;
        acc.links++;
        const alongM = Math.abs(b.proj.s - a.proj.s);
        const impliedKn = (alongM / dt) * 1.94384;
        const movingEnd = (a.sog !== null && a.sog >= TRANSIT_SOG_KN)
          || (b.sog !== null && b.sog >= TRANSIT_SOG_KN);

        const usable = dt <= MAX_LINK_S && a.proj.inCorridor && b.proj.inCorridor
          && impliedKn <= MAX_IMPLIED_KN;
        const isTransitLink = usable && impliedKn >= TRANSIT_SOG_KN;

        if (!isTransitLink) {
          // Tystnad EFTER rörelse men utan bevisad framfart: båten kan ha
          // stannat (väntar på broöppning) — redovisas separat, aldrig i
          // segmentstatistiken (annars mäter vi väntan, inte mottagning).
          if (movingEnd && dt > BLACKOUT_S && dt <= MAX_LINK_S && a.proj.inCorridor) {
            motionLost.push({
              corpus: corpus.id,
              source: key,
              mmsi,
              name: a.name,
              tIso: new Date(a.ts).toISOString(),
              gapSec: Math.round(dt),
              segment: segIndex(fairway, a.proj.s),
              alongM: Math.round(alongM),
              impliedKn: Number(impliedKn.toFixed(1)),
              sogKn: a.sog,
            });
          }
          closeRun();
          continue;
        }

        const sLo = Math.min(a.proj.s, b.proj.s);
        const sHi = Math.max(a.proj.s, b.proj.s);
        const touchesMap = sHi >= 0 && sLo <= fairway.mapEndM;
        const segA = segIndex(fairway, Math.max(0, Math.min(fairway.mapEndM, a.proj.s)));
        const segB = segIndex(fairway, Math.max(0, Math.min(fairway.mapEndM, b.proj.s)));

        if (touchesMap) {
          acc.transitLinks++;
          acc.gapAll.push(dt);
          const lo = segIndex(fairway, Math.max(0, sLo));
          const hi = segIndex(fairway, Math.min(fairway.mapEndM, sHi));
          const spanM = Math.max(1, alongM);
          if (segA >= 0 && segA < acc.segments.length) acc.segments[segA].endGaps.push(dt);
          if (segB >= 0 && segB < acc.segments.length && segB !== segA) {
            acc.segments[segB].endGaps.push(dt);
          }
          for (let k = lo; k <= hi; k++) {
            const seg = acc.segments[k];
            seg.gaps.push(dt);
            if (dt > BLACKOUT_S) seg.blackouts++;
            // Exponeringstid: länkens dt fördelas proportionellt över den del av
            // segmentet som länken faktiskt täcker (linjär interpolation).
            const segLo = k * SEGMENT_M;
            const segHi = segLo + SEGMENT_M;
            const overlap = Math.max(0, Math.min(segHi, sHi) - Math.max(segLo, sLo));
            const share = dt * (overlap / spanM);
            seg.exposureSec += share;
            if (dt > BLACKOUT_S) seg.blind120Sec += share;
            if (dt > 300) seg.blind300Sec += share;
          }
        }

        if (!run) {
          run = {
            links: 0,
            sMin: a.proj.s,
            sMax: a.proj.s,
            tFrom: a.ts,
            tTo: a.ts,
            segFixes: new Set(a.proj.inMap ? [segA] : []),
            expBySeg: new Map(),
            blindBySeg: new Map(),
            fixesBySeg: new Map(),
          };
          if (a.proj.inMap) run.fixesBySeg.set(segA, 1);
        }
        run.links++;
        run.sMin = Math.min(run.sMin, sLo);
        run.sMax = Math.max(run.sMax, sHi);
        run.tTo = b.ts;
        if (b.proj.inMap) {
          run.segFixes.add(segB);
          run.fixesBySeg.set(segB, (run.fixesBySeg.get(segB) || 0) + 1);
        }
        // Exponering per segment INOM resan — nämnare i det parvisa testet.
        if (touchesMap) {
          const lo = segIndex(fairway, Math.max(0, sLo));
          const hi = segIndex(fairway, Math.min(fairway.mapEndM, sHi));
          const spanM = Math.max(1, alongM);
          for (let k = lo; k <= hi; k++) {
            const segLo = k * SEGMENT_M;
            const overlap = Math.max(0, Math.min(segLo + SEGMENT_M, sHi) - Math.max(segLo, sLo));
            const share = dt * (overlap / spanM);
            run.expBySeg.set(k, (run.expBySeg.get(k) || 0) + share);
            if (dt > BLACKOUT_S) run.blindBySeg.set(k, (run.blindBySeg.get(k) || 0) + share);
          }
        }

        // --- målbroinsegling: vad visste appen när båten gick under bron? ---
        for (const anchor of fairway.anchors) {
          if (!TARGET_BRIDGES.includes(anchor.name)) continue;
          const crossed = (a.proj.s < anchor.s && b.proj.s >= anchor.s)
            || (a.proj.s > anchor.s && b.proj.s <= anchor.s);
          if (!crossed) continue;
          const frac = (anchor.s - a.proj.s) / (b.proj.s - a.proj.s);
          const tCross = a.ts + (frac * (b.ts - a.ts));
          const northbound = b.proj.s > a.proj.s;
          const inApproach = (f, distM) => {
            const d = northbound ? anchor.s - f.proj.s : f.proj.s - anchor.s;
            return d >= 0 && d <= distM && f.ts <= tCross && (tCross - f.ts) <= 60 * 60 * 1000;
          };
          targetApproaches.push({
            corpus: corpus.id,
            source: key,
            mmsi,
            name: a.name,
            bridge: anchor.name,
            direction: northbound ? 'norrut' : 'söderut',
            tCrossIso: new Date(tCross).toISOString(),
            lastFixDistM: Math.round(Math.abs(anchor.s - a.proj.s)),
            silenceSec: Math.round((tCross - a.ts) / 1000),
            fixes1500: fixes.filter((f) => inApproach(f, 1500)).length,
            fixes700: fixes.filter((f) => inApproach(f, 700)).length,
            fixes300: fixes.filter((f) => inApproach(f, 300)).length,
          });
        }

        if (dt > BLACKOUT_S && touchesMap) {
          blackouts.push({
            corpus: corpus.id,
            source: key,
            mmsi,
            name: a.name,
            tIso: new Date(a.ts).toISOString(),
            gapSec: Math.round(dt),
            segFrom: segA,
            segTo: segB,
            sFrom: Math.round(a.proj.s),
            sTo: Math.round(b.proj.s),
            alongM: Math.round(alongM),
            impliedKn: Number(impliedKn.toFixed(1)),
            sogKn: a.sog,
            tier: (BLACKOUT_TIERS.find((t) => dt >= t.minS) || { name: 'glapp' }).name,
          });
        }
      }
      closeRun();
    }

    // --- gemensam nämnare: samma resor mätta för varje källa ---
    if (sourceKeys.includes('fusion')) {
      for (const refRun of referenceRuns) {
        for (const key of sourceKeys) {
          if (!commonCoverage.has(key)) {
            commonCoverage.set(key, {
              segments: Array.from({ length: fairway.segmentCount }, () => ({ traversals: 0, dark: 0 })),
              traversals: 0,
              dark: 0,
              runsWithZeroFixes: 0,
            });
          }
          const cov = commonCoverage.get(key);
          const inWindow = (projectedBySource.get(key) || [])
            .filter((f) => f.ts >= refRun.tFrom && f.ts <= refRun.tTo && f.proj.inMap && f.proj.inCorridor);
          const hit = new Set(inWindow.map((f) => segIndex(fairway, f.proj.s)));
          if (!inWindow.length) cov.runsWithZeroFixes++;
          for (let i = refRun.lo; i <= refRun.hi; i++) {
            cov.segments[i].traversals++;
            cov.traversals++;
            if (!hit.has(i)) {
              cov.segments[i].dark++;
              cov.dark++;
            }
          }
        }
      }
    }
  }

  const latencyStats = {};
  for (const [feed, arr] of latency) {
    latencyStats[feed] = {
      n: arr.length,
      p50: round1(quantile(arr, 0.5)),
      p90: round1(quantile(arr, 0.9)),
      max: round1(Math.max(...arr)),
    };
  }

  const span = rows.length
    ? { fromIso: new Date(rows[0].ts).toISOString(), toIso: new Date(rows[rows.length - 1].ts).toISOString() }
    : null;

  return {
    id: corpus.id,
    classMix,
    file: path.basename(corpus.jsonl),
    // Behövs av gallringskontrollen (thinHubControl) — den måste läsa samma
    // rådata en gång till med en delmängd av en källas fixar.
    jsonlPath: corpus.jsonl,
    hours: corpus.hours,
    rows: rows.length,
    skipped,
    vessels: vessels.size,
    span,
    outOfMap,
    outSouth,
    outNorth,
    outOfCorridor,
    mergedCrossSource,
    latency: latencyStats,
    sources,
    commonCoverage,
    blackouts,
    motionLost,
    runsBySector,
    targetApproaches,
  };
}

/**
 * Object.fromEntries-ersättare (eslint-config-athom sätter node >= 8).
 * @param {Array} pairs - [nyckel, värde]-par
 * @returns {object} objekt
 */
function fromPairs(pairs) {
  const out = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

/**
 * @param {number|null} x - värde
 * @returns {number|null} avrundat till 1 decimal
 */
function round1(x) {
  return x === null || !Number.isFinite(x) ? null : Number(x.toFixed(1));
}

/**
 * Sektornamn för en position längs farleden (mellan vilka ankare ligger den).
 * @param {object} fairway - farledsmodellen
 * @param {number} s - meter längs farleden
 * @returns {string} sektornamn
 */
function sectorOf(fairway, s) {
  const a = fairway.anchors;
  for (let i = 0; i < a.length - 1; i++) {
    if (s >= a[i].s && s < a[i + 1].s) return `${a[i].name}→${a[i + 1].name}`;
  }
  return s < a[0].s ? 'S om Kanalinfarten' : 'N om Stallbackabron';
}

// =============================================================================
// 4. SAMMANSTÄLLNING
// =============================================================================

/**
 * Slå ihop segmentkonton från flera korpusar.
 * @param {object[]} results - analyzeCorpus-resultat
 * @param {object} fairway - farledsmodellen
 * @param {object} filter - {corpusIds:Set|null}
 * @returns {Map<string, object>} källa → aggregerade segment
 */
function aggregate(results, fairway, filter = {}) {
  const out = new Map();
  for (const res of results) {
    if (filter.corpusIds && !filter.corpusIds.has(res.id)) continue;
    for (const [key, acc] of res.sources) {
      if (filter.sources && !filter.sources.includes(key)) continue;
      if (!out.has(key)) {
        out.set(key, {
          segments: Array.from({ length: fairway.segmentCount }, emptySegment),
          fixes: 0,
          transitFixes: 0,
          transitLinks: 0,
          runs: 0,
          gapAll: [],
        });
      }
      const dst = out.get(key);
      dst.fixes += acc.fixes;
      dst.transitFixes += acc.transitFixes;
      dst.transitLinks += acc.transitLinks;
      dst.runs += acc.runs;
      dst.gapAll.push(...acc.gapAll);
      acc.segments.forEach((seg, i) => {
        const d = dst.segments[i];
        d.fixes += seg.fixes;
        d.transitFixes += seg.transitFixes;
        d.exposureSec += seg.exposureSec;
        d.blind120Sec += seg.blind120Sec;
        d.blind300Sec += seg.blind300Sec;
        d.traversals += seg.traversals;
        d.darkTraversals += seg.darkTraversals;
        d.blackouts += seg.blackouts;
        d.gaps.push(...seg.gaps);
        d.endGaps.push(...seg.endGaps);
      });
    }
  }
  return out;
}

/**
 * Beräkna rapportmått för ett segmentkonto.
 * @param {object} seg - segmentkonto
 * @returns {object} mått
 */
function segStats(seg) {
  const expMin = seg.exposureSec / 60;
  return {
    transitFixes: seg.transitFixes,
    fixes: seg.fixes,
    traversals: seg.traversals,
    darkTraversals: seg.darkTraversals,
    darkPct: seg.traversals ? Number(((seg.darkTraversals / seg.traversals) * 100).toFixed(0)) : null,
    exposureMin: Number(expMin.toFixed(1)),
    blind120Pct: seg.exposureSec > 0 ? Number(((seg.blind120Sec / seg.exposureSec) * 100).toFixed(0)) : null,
    blind300Pct: seg.exposureSec > 0 ? Number(((seg.blind300Sec / seg.exposureSec) * 100).toFixed(0)) : null,
    fixRatePerMin: expMin > 0 ? Number((seg.transitFixes / expMin).toFixed(2)) : null,
    gapN: seg.gaps.length,
    gapP50: seg.gaps.length ? Math.round(quantile(seg.gaps, 0.5)) : null,
    gapP90: seg.gaps.length ? Math.round(quantile(seg.gaps, 0.9)) : null,
    gapMax: seg.gaps.length ? Math.round(Math.max(...seg.gaps)) : null,
    // ÄNDPUNKTSATTRIBUERAT p50: bara glapp som BÖRJADE eller SLUTADE här.
    // `gapP50` ovan bokförs på varje segment länken spänner och är därför
    // lika mycket ett centralitetsmått som ett mottagningsmått.
    endGapN: (seg.endGaps || []).length,
    endGapP50: (seg.endGaps || []).length ? Math.round(quantile(seg.endGaps, 0.5)) : null,
    blackouts: seg.blackouts,
  };
}

/**
 * Slå ihop segment till en sektor.
 * @param {object[]} segments - segmentkonton
 * @param {number} from - första index
 * @param {number} to - sista index (inklusive)
 * @returns {object} sektorkonto
 */
function mergeSegments(segments, from, to) {
  const m = emptySegment();
  for (let i = from; i <= to && i < segments.length; i++) {
    const s = segments[i];
    m.fixes += s.fixes;
    m.transitFixes += s.transitFixes;
    m.exposureSec += s.exposureSec;
    m.blind120Sec += s.blind120Sec;
    m.blind300Sec += s.blind300Sec;
    m.traversals += s.traversals;
    m.darkTraversals += s.darkTraversals;
    m.blackouts += s.blackouts;
    m.gaps.push(...s.gaps);
    m.endGaps.push(...(s.endGaps || []));
  }
  return m;
}

/**
 * Sektorindelningen: mellan varje par av ankare.
 * @param {object} fairway - farledsmodellen
 * @returns {object[]} sektorer
 */
function buildSectors(fairway) {
  const out = [];
  const a = fairway.anchors;
  for (let i = 0; i < a.length - 1; i++) {
    const from = segIndex(fairway, a[i].s);
    const to = Math.max(from, segIndex(fairway, Math.max(a[i].s, a[i + 1].s - 1)));
    out.push({
      name: `${a[i].name}→${a[i + 1].name}`, from, to, lengthM: Math.round(a[i + 1].s - a[i].s),
    });
  }
  return out;
}

// =============================================================================
// 5. RAPPORT
// =============================================================================

const HEAT_CHARS = ['·', '░', '▒', '▓', '█'];

/**
 * Heatmap-tecken för ett medianglapp.
 * @param {number|null} gapP50 - medianglapp i sekunder
 * @returns {string} tecken
 */
function heatChar(gapP50) {
  if (gapP50 === null) return ' ';
  if (gapP50 < 60) return HEAT_CHARS[0];
  if (gapP50 < 120) return HEAT_CHARS[1];
  if (gapP50 < 240) return HEAT_CHARS[2];
  if (gapP50 < 480) return HEAT_CHARS[3];
  return HEAT_CHARS[4];
}

/**
 * @param {number} n - antal
 * @param {number} width - bredd
 * @param {number} max - maxvärde
 * @returns {string} stapel
 */
function bar(n, width, max) {
  if (!max || !Number.isFinite(n)) return '';
  const k = Math.round((n / max) * width);
  return '█'.repeat(Math.max(0, Math.min(width, k)));
}

/**
 * @param {object} fairway - farledsmodellen
 * @param {number} idx - segmentindex
 * @returns {string} landmärkesetikett
 */
function segLabel(fairway, idx) {
  const mid = (idx * SEGMENT_M) + (SEGMENT_M / 2);
  let best = null;
  for (const a of fairway.anchors) {
    const d = Math.abs(a.s - mid);
    if (!best || d < best.d) best = { d, a };
  }
  if (best.d <= SEGMENT_M / 2) return `**${best.a.name}**`;
  const sign = mid > best.a.s ? 'N' : 'S';
  return `${best.a.name} ${sign}${Math.round(best.d)}m`;
}

/**
 * Bygg hela markdownrapporten.
 * @param {object} ctx - rapportkontext
 * @returns {string} markdown
 */
function buildMarkdown(ctx) {
  const {
    fairway, results, agg, sectors, night, quay, paired, selfCheck, config, baseSource,
  } = ctx;
  const approachAis = ctx.approaches.filter((x) => x.source === baseSource);
  const L = [];
  const p = (s = '') => L.push(s);

  const allSources = [...agg.keys()].sort();
  const totalRows = results.reduce((s, r) => s + r.rows, 0);
  const totalHours = results.reduce((s, r) => s + (r.hours || 0), 0);
  const allBlackouts = results.flatMap((r) => r.blackouts).filter((b) => b.source !== 'fusion');
  const allMotionLost = results.flatMap((r) => r.motionLost).filter((b) => b.source !== 'fusion');

  p('# Täckningskartan — mottagningsglapp per farledssegment och källa');
  p();
  p(`_Genererad ${new Date().toISOString().slice(0, 19)}Z av \`tests/replay-validation/coverageMap.js\`._`);
  p('_Diagnosverktyg (etapp 6, leverabel 1). Rör ingen produktionskod och ingen gate._');
  p();
  p('## Sammanfattning');
  p();
  const aisAll = agg.get(baseSource);
  const aisGapP50 = aisAll ? Math.round(quantile(aisAll.gapAll, 0.5)) : null;
  const aisGapP90 = aisAll ? Math.round(quantile(aisAll.gapAll, 0.9)) : null;
  p(`* **Underlag:** ${results.length} korpusar, ~${Math.round(totalHours)} h, ${totalRows} AIS-fixar, `
    + `${results.reduce((s, r) => s + r.vessels, 0)} fartygsspår.`);
  // SÄNDNINGSTAKTEN RÄKNAS UT, den skrivs inte (granskningen 2026-08-04):
  // påståendet "Klass A sänder var 2–10:e sekund" gällde 34 % av materialet
  // och överdrev förlustfaktorn 4–12× för resten. Samma sak med
  // "'Glapp > 120 s' är normaltillståndet" — den meningen skrevs ut även när
  // det uträknade medianglappet på samma rad var 76 s.
  const mix = results.reduce((acc, r) => ({
    classA: acc.classA + ((r.classMix && r.classMix.classA) || 0),
    classB: acc.classB + ((r.classMix && r.classMix.classB) || 0),
  }), { classA: 0, classB: 0 });
  const mixTot = mix.classA + mix.classB;
  const classBPct = mixTot ? Math.round((100 * mix.classB) / mixTot) : null;
  const expectedS = mixTot
    ? Math.round(((mix.classA * 6) + (mix.classB * 30)) / mixTot)
    : null;
  const mixText = mixTot
    ? ` Transitmaterialet är ${classBPct} % Klass B (sänder var 30:e sekund i fart) och `
      + `${100 - classBPct} % Klass A (var 2–10:e sekund), dvs. en förväntad sändningstakt runt `
      + `${expectedS} s — medianglappet motsvarar alltså ~${Math.max(1, Math.round(aisGapP50 / expectedS))} `
      + 'missade sändningar, inte en storleksordning fler.'
    : '';
  const normText = aisGapP50 > 120
    ? ' "Glapp > 120 s" är normaltillståndet, inte undantaget.'
    : ' Medianglappet ligger UNDER 120 s — de långa hålen är svansen, inte normaltillståndet.';
  p('* **Mottagningen är gles i hela kanalen.** Medianglappet mellan två konsekutiva aisstream-fixar '
    + `för ett fartyg i transit är **${aisGapP50} s** (p90 ${aisGapP90} s).${mixText}${normText}`);
  if (ctx.verdict.cityWorse !== null) {
    p(`* **Stadssektorn:** ${ctx.verdict.headline}`);
  }
  if (night) {
    p(`* **Nattens tvåkällemätning:** ${ctx.verdict.nightHeadline}`);
  }
  p(`* **Sämsta enskilda segmentet (aisstream):** ${ctx.verdict.worstSegment}`);
  if (approachAis.length) {
    const zero300 = approachAis.filter((x) => x.fixes300 === 0).length;
    const zero700 = approachAis.filter((x) => x.fixes700 === 0).length;
    // TVÅ KLASSER, INTE EN (granskningen 2026-08-04). En "passage" registreras
    // när en transitlänk geometriskt korsar brolinjen — även när länken ÄR en
    // enda lång tystnad. I de fallen är fixes300 = 0 PER KONSTRUKTION: samma
    // tystnad skapar både observationen och nollan. Rubriksiffran blandade
    // ihop dem och blev ~1,8× den observerade. Gränsen är 300 s, dvs. samma
    // tystnad som definierar en verkligt observerad insegling.
    const OBSERVED_SILENCE_S = 300;
    const observed = approachAis.filter((x) => x.silenceSec <= OBSERVED_SILENCE_S);
    const inferred = approachAis.filter((x) => x.silenceSec > OBSERVED_SILENCE_S);
    const zero300Obs = observed.filter((x) => x.fixes300 === 0).length;
    const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
    p(`* **Målbroinseglingen:** i ${pct(zero300, approachAis.length)} % av de `
      + `${approachAis.length} observerade passagerna av Klaffbron/Stridsbergsbron fanns INTE EN ENDA fix på `
      + `de sista 300 metrarna, och i ${pct(zero700, approachAis.length)} % ingen på de sista `
      + `700. Den siffran blandar två klasser: ${inferred.length} passager är INFERRERADE ur samma tystnad `
      + `(> ${OBSERVED_SILENCE_S} s fram till korsningen — de har fixes300 = 0 per konstruktion). `
      + `Räknat bara på de ${observed.length} passager med verkligt observerad insegling är andelen `
      + `**${pct(zero300Obs, observed.length)} %** — fortfarande ett fullgott skäl till deadline-motorn, `
      + 'men det är den siffran som ska citeras. Mediantystnaden fram till passagen var '
      + `${quantile(approachAis.map((x) => x.silenceSec), 0.5)} s `
      + `(p90 ${quantile(approachAis.map((x) => x.silenceSec), 0.9)} s).`);
  }
  p();
  p('---');
  p();

  // ---- Metod ----
  p('## 1. Metod');
  p();
  p('### 1.1 Farledsmodellen');
  p();
  p(`Farleden modelleras som en polylinje med ${fairway.pts.length} noder, härledd ur korpusdatan själv `
    + '(medianposition per 200 m av de 1 843 rörelsefixarna, 3-punkts utjämning, 6 iterationer) och sedan '
    + 'hårdkodad i verktyget så att kartan blir identisk oavsett vilken delmängd korpusar man kör.');
  p();
  p('Raka linjer bro-till-bro fungerar **inte**: kanalen svänger, och mot en rak linje ligger de faktiska '
    + 'fartygsspåren systematiskt fel (−110 m mellan Olidebron och Klaffbron, −200 m söder om Stallbackabron; '
    + 'p90 = 277 m). Mot centerlinjen är samma spår p50 = 7 m, p90 = 21 m, p95 = 27 m från linjen.');
  p();
  p('| Ankare | s längs farleden | Avstånd koordinat→farled | Metod |');
  p('|---|---:|---:|---|');
  for (const a of fairway.anchors) {
    p(`| ${a.name} | ${Math.round(a.s)} m | ${Math.round(a.offsetM)} m | ${a.mode === 'axis' ? 'broaxelns skärning' : 'vinkelrät projektion'} |`);
  }
  p();
  p('Broarnas läge längs farleden bestäms genom att skära **brolinjen** (koordinat + `axisBearing`, samma '
    + 'modell som `geometry.hasCrossedBridgeLine` använder) mot centerlinjen — alltså där bron faktiskt '
    + 'korsar vattnet.');
  p();
  p('> **Sidofynd (ingen åtgärd föreslås här):** `BRIDGES.stallbackabron` ligger '
    + `${Math.round(fairway.anchors[5].offsetM)} m från farleden — koordinaten pekar på brons västra del medan `
    + 'farleden går under den östra. Brolinjen (axisBearing 125°) korsar farleden korrekt, så '
    + 'passagedetekteringen påverkas inte; men varje **avståndsmått** till Stallbackabron är systematiskt '
    + `${Math.round(fairway.anchors[5].offsetM)} m för långt när båten står rakt under bron. `
    + 'Övriga broar ligger inom 11 m från farleden.');
  p();
  p('### 1.2 Klockdomänen');
  p();
  p('Analysen körs i **fixtidsdomänen** (`fixTs ?? aisTimestamp`) — "när hörde mottagarnätet båten". '
    + 'För aisstream är fixtid och mottagningstid identiska per konstruktion. För AISHub är `fixTs` den '
    + 'riktiga fixtiden medan `aisTimestamp` är pollens leveranstid; att mäta AISHub i leveransdomänen hade '
    + 'gett 65-sekunderskvantiserade "glapp" för allting — det är pollkadensen, inte antennen.');
  p();
  p('### 1.3 Definitioner');
  p();
  p('| Begrepp | Definition | Härledning |');
  p('|---|---|---|');
  p(`| Transitfix | fix med sog ≥ ${config.transitSogKn} kn | uppdragsgivet; 62 % av alla fixar ligger `
    + 'på exakt 0 kn och 12 % i 0–2 kn (kajvobbel) |');
  p(`| Segment | ${config.segmentM} m längs farleden | ≈ 30 s färd i 6,5 kn (p95-farten) |`);
  p(`| Korridor | ≤ ${config.corridorM} m lateralt | p99 för rörelsefixarnas lateralavstånd är 118 m |`);
  p(`| Transitlänk | två konsekutiva fixar, samma fartyg + källa, implicerad fart ≥ ${config.transitSogKn} kn, `
    + `≤ ${config.maxLinkS / 60} min isär, ≤ ${config.maxImpliedKn} kn | båten har bevisligen färdats genom `
    + 'de spända segmenten under glappet |');
  p(`| Blackout | transitlänk med glapp > ${config.blackoutS} s | uppdragsgivet; graderas i `
    + `glapp/allvarlig/kritisk (>${config.blackoutS}/>300/>600 s) |`);
  p('| Mörk passage | ett segment traverseras utan en enda fix från källan | den renaste antennsignalen: '
    + 'hålet var totalt |');
  p('| Exponering | tid i segmentet, linjärt interpolerad längs transitlänkarna | nämnare för '
    + 'fixfrekvensen (fart-neutral) |');
  p();
  p('Självkontroll av projektionen mot produktionens `geometry.distancePointToSegmentM`: '
    + `${selfCheck.checked} punkter, största avvikelse ${selfCheck.maxDeltaM.toExponential(1)} m — samma matematik, `
    + 'ingen parallell sanning.');
  p();

  // ---- Underlag ----
  p('## 2. Underlaget');
  p();
  p('| Korpus | h | Fixar | Fartyg | Källor | I kartan | S om kartan | N om kartan | Utanför korridoren | Blackouts |');
  p('|---|---:|---:|---:|---|---:|---:|---:|---:|---:|');
  for (const r of results) {
    const srcs = [...r.sources.keys()].filter((k) => k !== 'fusion').join(' + ');
    const inMap = [...r.sources].filter(([k]) => k !== 'fusion').reduce((s, [, a]) => s + a.fixes, 0);
    p(`| ${r.id} | ${r.hours || '?'} | ${r.rows} | ${r.vessels} | ${srcs} | ${inMap} | ${r.outSouth} `
      + `| ${r.outNorth} | ${r.outOfCorridor} | ${r.blackouts.filter((b) => b.source !== 'fusion').length} |`);
  }
  p();
  p('Kartan börjar per definition vid **Kanalinfarten** och slutar vid **Stallbackabron** — trafiken gör det '
    + 'inte. "S om kartan" är i huvudsak den permanent förtöjda flottan vid infarten (PRICKBJORN, CAPELLA, '
    + 'VIRGO, S/Y ENYA, KNIGHT OWL m.fl.) plus sydlig insegling upp till ~560 m innan triggerpunkten; '
    + '"N om kartan" är trafik ovanför Stallbackabron. "Utanför korridoren" = gästhamnar, Spikö-ankringen '
    + 'och annat som inte är farled. Att andelen är hög är alltså väntat och inte ett mätfel — men det '
    + 'betyder att kartan INTE säger något om mottagningen vid infartskajerna.');
  p();
  p('> **Kolumnen "S om kartan" hoppar från 0 till hundratals mellan 20260710-13h och 20260711-7h.** Det är '
    + 'inte ett mätfel utan ett spår av `AIS_CONFIG.BOUNDING_BOX.SOUTH`, som flyttades 58,2681 → 58,26 '
    + '(ChatGPT-granskningen 2026-07-10, F1). Före den ändringen prenumererade appen inte på området söder '
    + 'om Kanalinfarten, så infartsflottan syns helt enkelt inte i de äldre korpusarna. Det är ett bevis på '
    + 'att projektionen klassar rätt — och en påminnelse om att korpusarna inte är utbytbara mot varandra.');
  p();

  // ---- Segmenttabell ----
  p(`## 3. Segmenttabellen (alla korpusar, källa: ${baseSource})`);
  p();
  p('`n` = transitfixar, `exp` = exponeringstid i minuter, `fix/min` = transitfixar per exponeringsminut, '
    + '`mörk` = andel traverseringar helt utan fix, `p50/p90/max` = glapp i sekunder.');
  p();
  p('| # | s (m) | Landmärke | n | exp (min) | fix/min | trav | mörk | p50 | p90 | max | blackouts |');
  p('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const aisSegs = agg.get(baseSource).segments;
  for (let i = 0; i < fairway.segmentCount; i++) {
    const st = segStats(aisSegs[i]);
    const last = i === fairway.segmentCount - 1;
    const to = last ? Math.round(fairway.mapEndM) : (i + 1) * SEGMENT_M;
    p(`| ${i} | ${i * SEGMENT_M}–${to}${last ? ' †' : ''} | ${segLabel(fairway, i)} | ${st.transitFixes} `
      + `| ${st.exposureMin} | ${fmtRate(st.fixRatePerMin)} | ${st.traversals} `
      + `| ${st.darkPct === null ? '–' : `${st.darkPct} %`} | ${st.gapP50 ?? '–'} | ${st.gapP90 ?? '–'} `
      + `| ${st.gapMax ?? '–'} | ${st.blackouts} |`);
  }
  p();
  p(`† Sista segmentet är kapat vid Stallbackabron (${Math.round(fairway.mapEndM) % SEGMENT_M} m brett).`);
  p();
  p('Läsanvisning: `max` upprepas i långa serier av segment eftersom ETT enda långt glapp bokförs på '
    + 'ALLA segment båten passerade under tystnaden — det är hela poängen med måttet ("hur långt glapp '
    + 'kan drabba en båt som befinner sig här").');
  p();

  // ---- Heatmap ----
  p('## 4. Heatmap');
  p();
  p('Medianglapp per 100 m-segment, syd (Kanalinfarten) → nord (Stallbackabron). '
    + `\`${HEAT_CHARS[0]}\` <60 s · \`${HEAT_CHARS[1]}\` 60–120 s · \`${HEAT_CHARS[2]}\` 120–240 s · `
    + `\`${HEAT_CHARS[3]}\` 240–480 s · \`${HEAT_CHARS[4]}\` >480 s · blank = inget underlag.`);
  p();
  p('OBS: `aisstream`-raden bygger på alla 16 korpusarna, `aishub`/`fusion` finns bara i nattkorpusen — '
    + 'raderna är alltså inte samma underlag. Den rättvisa jämförelsen står i avsnitt 7.');
  p();
  p('```');
  const anchorMarks = fairway.anchors.map((a, i) => ({
    idx: Math.min(fairway.segmentCount - 1, Math.round(a.s / SEGMENT_M)),
    ch: 'IOKJSB'[i],
  }));
  let ruler = '';
  for (let i = 0; i < fairway.segmentCount; i++) {
    const m = anchorMarks.find((x) => x.idx === i);
    ruler += m ? m.ch : '─';
  }
  p(`${' '.repeat(12)}${ruler}`);
  for (const key of allSources) {
    const segs = agg.get(key).segments;
    const strip = segs.map((s) => heatChar(s.gaps.length ? Math.round(quantile(s.gaps, 0.5)) : null)).join('');
    p(`${key.padEnd(10)} S|${strip}|N`);
  }
  p(`${' '.repeat(12)}${ruler}`);
  p('            I=Kanalinfarten  O=Olidebron  K=Klaffbron  J=Järnvägsbron');
  p('            S=Stridsbergsbron  B=Stallbackabron');
  p('```');
  p();
  p('Samma karta som fixtäthet (transitfixar per exponeringsminut, aisstream — hög stapel = tät kontakt). '
    + 'Skalan är kapad vid p90 för att inte domineras av kantsegmenten; `†` = tunt underlag '
    + '(< 5 traverseringar eller < 2 exponeringsminuter).');
  p();
  p('```');
  const rates = aisSegs.map((s) => (s.exposureSec > 0 ? s.transitFixes / (s.exposureSec / 60) : 0));
  const scaleMax = quantile(rates.filter((r) => r > 0), 0.9) || 1;
  for (let i = 0; i < fairway.segmentCount; i++) {
    const st = segStats(aisSegs[i]);
    const thin = st.traversals < 5 || st.exposureMin < 2;
    p(`${String(i * SEGMENT_M).padStart(4)} m ${segLabel(fairway, i).replace(/\*\*/g, '').padEnd(22)} `
      + `${bar(rates[i], 40, scaleMax).padEnd(40)} ${fmtRate(st.fixRatePerMin)}${thin ? ' †' : ''}`);
  }
  p('```');
  p();

  // ---- Sektorer ----
  p('## 5. Sektorerna');
  p();
  p(`Enbart **${baseSource}** (den källa som finns i alla ${results.length} korpusarna). AISHub-jämförelsen `
    + 'ligger i avsnitt 7, där båda källorna såg samma båtar samma natt.');
  p();
  p('**Vilket mått ska man läsa?** `fix/min` och `blind`-kolumnerna är fartneutrala, MEN de är '
    + 'betingade på samma urval: bara länkar med implicerad fart ≥ '
    + `${MAX_IMPLIED_KN ? TRANSIT_SOG_KN : TRANSIT_SOG_KN} kn räknas, och hur stor del av rörelsetiden `
    + 'som därmed kastas skiljer sig KRAFTIGT mellan sektorer (se "tappad rörelsetid" nedan). '
    + 'Jämförelsen är alltså inte äppel-mot-äppel — den sektor som har flest väntande båtar (målbroarna!) '
    + 'får mest bortsållat. `Mörka passager` är dessutom fartberoende (en båt i 8 kn hinner igenom fler '
    + '100 m-rutor mellan två fixar än en i 4 kn) — det måttet ska bara användas för att jämföra KÄLLOR '
    + 'inom samma sektor, där farten är densamma för båda. `Blind >120 s` = andelen av transittiden i '
    + 'sektorn som ligger inuti ett glapp längre än 120 s. `p50` bokförs på VARJE segment länken spänner '
    + 'och är därför lika mycket ett centralitetsmått som ett mottagningsmått; `p50 (ändpunkt)` räknar '
    + 'bara glapp som faktiskt BÖRJADE eller SLUTADE i sektorn och är det ärliga mottagningsmåttet.');
  p();
  p('| Sektor | Längd | Transitfixar | fix/min | Blind >120 s | Blind >300 s | p50 | p50 (ändpunkt) | p90 | Mörka passager |');
  p('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const secRow = (name, lengthM, st) => {
    p(`| ${name} | ${lengthM} m | ${st.transitFixes} | ${fmtRate(st.fixRatePerMin)} `
      + `| ${st.blind120Pct ?? '–'} % | ${st.blind300Pct ?? '–'} % | ${st.gapP50 ?? '–'} `
      + `| ${st.endGapP50 ?? '–'} | ${st.gapP90 ?? '–'} `
      + `| ${st.darkTraversals}/${st.traversals} (${st.darkPct ?? '–'} %) |`);
  };
  // TAPPAD RÖRELSETID PER SEKTOR: hur mycket av rörelsetiden som sållas bort
  // av implicerad-fart-grinden. Utan den här kolumnen läses sektortabellen som
  // äppel-mot-äppel, vilket den inte är — mätt kastas ~50 % av stadens
  // rörelsetid mot ~20 % i övriga sektorer, och urvalet gynnar systematiskt
  // att just målbrosektorerna ser sämst ut (det är där båtar VÄNTAR).
  const lostBySeg = new Map();
  for (const m of results.flatMap((r) => r.motionLost).filter((x) => x.source === baseSource)) {
    lostBySeg.set(m.segment, (lostBySeg.get(m.segment) || 0) + m.gapSec);
  }
  const lostMinIn = (from, to) => {
    let sec = 0;
    for (let i = from; i <= to; i++) sec += lostBySeg.get(i) || 0;
    return sec / 60;
  };
  const lostRows = [];
  for (const sec of sectors) {
    const st = segStats(mergeSegments(agg.get(baseSource).segments, sec.from, sec.to));
    const lost = lostMinIn(sec.from, sec.to);
    lostRows.push({
      name: sec.name,
      lost: Math.round(lost),
      kept: Math.round(st.exposureMin),
      pct: (lost + st.exposureMin) > 0 ? Math.round((100 * lost) / (lost + st.exposureMin)) : 0,
    });
    secRow(sec.name, sec.lengthM, st);
  }
  const cityFrom = sectors.find((s) => s.name === 'Klaffbron→Järnvägsbron').from;
  const cityTo = sectors.find((s) => s.name === 'Järnvägsbron→Stridsbergsbron').to;
  secRow('**STADEN (Klaffbron→Stridsbergsbron)**', (cityTo - cityFrom + 1) * SEGMENT_M,
    segStats(mergeSegments(agg.get(baseSource).segments, cityFrom, cityTo)));
  p();
  p('**Tappad rörelsetid per sektor** (länkar under implicerad-fart-grinden, dvs. tid som INTE ingår i '
    + 'raderna ovan). Andelen skiljer sig kraftigt mellan sektorer, och det är den enskilt viktigaste '
    + 'reservationen mot att läsa tabellen som en rättvis sektorjämförelse:');
  p();
  p('| Sektor | Bortsållad rörelsetid | Behållen | Andel bortsållad |');
  p('|---|---:|---:|---:|');
  for (const r of lostRows) {
    p(`| ${r.name} | ${r.lost} min | ${r.kept} min | ${r.pct} % |`);
  }
  p();
  // MÄTT SPANN ≠ ZONENS SPANN (granskningen 2026-08-04): zonen projicerar till
  // 101 m men statistiken tas på HELA segmenten den rör, dvs. 200 m. Skriv ut
  // båda så läsaren inte tror att 200 m-siffran gäller de 100 metrarna — nästan
  // hela segment 21 (2100–2197 m) ligger SÖDER om kajzonen.
  p(`**Kajen norr om Klaffbron** (\`MOORING_ZONES[0]\` projicerar till ${quay.fromM}–${quay.toM} m `
    + `= ${quay.toM - quay.fromM} m; statistiken tas på hela segment ${quay.from}–${quay.to} `
    + `= ${(quay.to - quay.from + 1) * SEGMENT_M} m): ${quay.stats.transitFixes} transitfixar, `
    + `fix/min ${fmtRate(quay.stats.fixRatePerMin)}, mörka passager `
    + `${quay.stats.darkTraversals}/${quay.stats.traversals} (${quay.stats.darkPct} %), `
    + `glapp p50 ${quay.stats.gapP50 ?? '–'} s / p90 ${quay.stats.gapP90 ?? '–'} s.`);
  p();

  // ---- Parvis jämförelse ----
  p('## 6. Parvis test: är stadssektorn sämre för SAMMA resa?');
  p();
  p('Sektorer skiljer sig också i trafik, fart och årstid. Det parvisa testet eliminerar det: för varje '
    + 'enskild resa som exponerats ≥ 60 s i BÅDE stadssektorn (Klaffbron→Järnvägsbron) och i resten av '
    + 'farleden jämförs fixfrekvensen inom samma resa.');
  p();
  p('| Referens | Resor | fix/min stan | fix/min ref | Kvot | Sämre i stan | p | Blind stan | Blind ref | Blindare i stan | p |');
  p('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of paired) {
    p(`| ${row.reference} | ${row.n} | ${row.cityMedian} | ${row.refMedian} | ${row.ratio} `
      + `| ${row.worse}/${row.decided} (${row.worsePct} %) | ${row.pValue} `
      + `| ${row.blindCity} % | ${row.blindRef} % | ${row.blindWorse}/${row.blindDecided} (${row.blindWorsePct} %) `
      + `| ${row.blindP} |`);
  }
  p();
  p('`ÖVRIGA` = all exponering utanför stadssektorn i samma resa. `Blind` = medianandel av tiden i sektorn '
    + 'som ligger inuti ett glapp > 120 s. Teckenandelarna räknas på AVGJORDA resor (oavgjorda, där måttet '
    + 'är exakt lika i båda sektorerna, utesluts — de bär ingen information). Teckentestet är ett tvåsidigt '
    + 'exakt binomialtest: vore sektorerna likvärdiga skulle "sämre i stan" inträffa i hälften av fallen.');
  p();

  // ---- Nattkorpusen ----
  if (night) {
    p('## 7. Tvåkällenatten: aisstream vs AISHub');
    p();
    p('> **Viktigt vid tolkning:** AISHub-kolumnen är till stor del **användarens egen antennkedja** — '
      + 'den egna mottagaren matar AISHub, och det som kommer tillbaka via webservicen är i huvudsak '
      + 'samma antenn. Kolumnen mäter alltså *den egna installationen*, medan aisstream-kolumnen mäter '
      + 'AISstream.io:s mottagarnät över Trollhättan.');
    p();
    p('> **Och en spärr i mätningen:** AISHub pollas var 65:e sekund och returnerar EN position per fartyg '
      + 'och poll. Källans fixfrekvens kan därför aldrig överstiga ~0,92 fixar/min oavsett hur bra antennen '
      + 'är. Fixtäthet är alltså INTE jämförbar mellan källorna — men **hålen är det**: ett glapp > 120 s '
      + 'betyder att minst en poll passerade utan att nätet hört något nytt från båten.');
    p();
    p('| Källa | Fixar | Transitfixar | Transitlänkar | Glapp p50 | p90 | max | Mörka passager | Leveranslatens p50/p90 |');
    p('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const key of night.sourceOrder) {
      const acc = night.agg.get(key);
      if (!acc) continue;
      const dark = acc.segments.reduce((s, x) => s + x.darkTraversals, 0);
      const trav = acc.segments.reduce((s, x) => s + x.traversals, 0);
      const lat = night.latency[key];
      p(`| ${key} | ${acc.fixes} | ${acc.transitFixes} | ${acc.transitLinks} `
        + `| ${acc.gapAll.length ? Math.round(quantile(acc.gapAll, 0.5)) : '–'} `
        + `| ${acc.gapAll.length ? Math.round(quantile(acc.gapAll, 0.9)) : '–'} `
        + `| ${acc.gapAll.length ? Math.round(Math.max(...acc.gapAll)) : '–'} `
        + `| ${dark}/${trav} (${trav ? Math.round((dark / trav) * 100) : '–'} %) `
        + `| ${lat ? `${lat.p50}/${lat.p90} s` : '–'} |`);
    }
    p();
    p('### 7.1 Gemensam nämnare — samma resor, båda källorna');
    p();
    p('Tabellen ovan har ett mätfel inbyggt: en källa som missade en HEL passage får inga traverseringar '
      + 'alls i det avsnittet i stället för 100 % mörker (överlevnadsbias — den sämre källan ser bättre ut). '
      + 'Här definieras resorna i stället av den **sammanslagna** vyn, och varje källa mäts mot exakt samma '
      + 'segment och samma tidsfönster.');
    p();
    p('| Källa | Mörka segment / traverseringar | Andel mörkt | Resor helt utan en enda fix |');
    p('|---|---:|---:|---:|');
    for (const key of night.sourceOrder) {
      const cov = night.common.get(key);
      if (!cov) continue;
      p(`| ${key} | ${cov.dark}/${cov.traversals} | ${Math.round((cov.dark / cov.traversals) * 100)} % `
        + `| ${cov.runsWithZeroFixes} |`);
    }
    p();
    p(`| Sektor | ${night.sourceOrder.map((k) => `${k} (mörkt)`).join(' | ')} | AISHubs försprång |`);
    p(`|---|${night.sourceOrder.map(() => '---:').join('|')}|---:|`);
    for (const sec of sectors) {
      const pcts = {};
      const cells = night.sourceOrder.map((key) => {
        const cov = night.common.get(key);
        if (!cov) return '–';
        let dark = 0;
        let trav = 0;
        for (let i = sec.from; i <= sec.to && i < cov.segments.length; i++) {
          dark += cov.segments[i].dark;
          trav += cov.segments[i].traversals;
        }
        if (!trav) return '–';
        pcts[key] = Math.round((dark / trav) * 100);
        return `${dark}/${trav} (${pcts[key]} %)`;
      });
      const lead = (pcts.aisstream !== undefined && pcts.aishub !== undefined)
        ? `${pcts.aisstream - pcts.aishub > 0 ? '+' : ''}${pcts.aisstream - pcts.aishub} p.e.` : '–';
      p(`| ${sec.name} | ${cells.join(' | ')} | ${lead} |`);
    }
    p();
    p('"AISHubs försprång" = hur många procentenheter FÄRRE mörka segment den egna kedjan har än AISstream i '
      + 'sektorn. Ett litet försprång betyder att den egna antennen har samma hål som alla andra där.');
    p();
    p('### 7.2 Per källas egna resor');
    p();
    p('Per sektor under natten (mörka passager / traverseringar, varje källa mot sina egna resor):');
    p();
    p(`| Sektor | ${night.sourceOrder.join(' | ')} |`);
    p(`|---|${night.sourceOrder.map(() => '---:').join('|')}|`);
    for (const sec of sectors) {
      const cells = night.sourceOrder.map((key) => {
        const acc = night.agg.get(key);
        if (!acc) return '–';
        const m = mergeSegments(acc.segments, sec.from, sec.to);
        const st = segStats(m);
        if (!st.traversals) return '–';
        return `${st.darkTraversals}/${st.traversals} · p50 ${st.gapP50 ?? '–'} s`;
      });
      p(`| ${sec.name} | ${cells.join(' | ')} |`);
    }
    p();
    p(`Korskälledubbletter som slogs ihop i fusionsvyn: ${night.merged} par `
      + `(≤ ${CROSS_SOURCE_DEDUP_S} s och ≤ ${CROSS_SOURCE_DEDUP_M} m isär).`);
    p();
    p('Nattens heatmap per källa (medianglapp, samma skala som ovan):');
    p();
    p('```');
    for (const key of night.sourceOrder) {
      const acc = night.agg.get(key);
      if (!acc) continue;
      const strip = acc.segments
        .map((s) => heatChar(s.gaps.length ? Math.round(quantile(s.gaps, 0.5)) : null)).join('');
      p(`${key.padEnd(10)} S|${strip}|N`);
    }
    p('```');
    p();
  }

  // ---- Blackouts ----
  p(`## ${night ? 8 : 7}. Topp 20 blackouts`);
  p();
  p(`Transitlänkar med glapp > ${config.blackoutS} s, sorterade på glapplängd. `
    + `Totalt ${allBlackouts.length} blackouts i materialet `
    + `(${allBlackouts.filter((b) => b.tier === 'kritisk').length} kritiska > 600 s, `
    + `${allBlackouts.filter((b) => b.tier === 'allvarlig').length} allvarliga > 300 s).`);
  p();
  p('| Tid (UTC) | Korpus | Källa | Fartyg | Glapp | Sträcka | Segment | sog sista fixen | Medelfart i glappet |');
  p('|---|---|---|---|---:|---:|---|---:|---:|');
  const top = allBlackouts.slice().sort((a, b) => b.gapSec - a.gapSec).slice(0, 20);
  for (const b of top) {
    p(`| ${b.tIso.replace('T', ' ').slice(0, 19)} | ${b.corpus} | ${b.source} | ${b.name} (${b.mmsi}) `
      + `| ${fmtGap(b.gapSec)} | ${b.alongM} m | ${b.segFrom}→${b.segTo} (${b.sFrom}→${b.sTo} m) `
      + `| ${fmtKn(b.sogKn)} | ${fmtKn(b.impliedKn)} |`);
  }
  p();
  p('`sog sista fixen` är farten i den fix då kontakten tappades — den kan vara låg (båten kom just igång) '
    + 'medan medelfarten under glappet bevisar att hon fortsatte. Kolumnen `Segment` visar var kontakten '
    + 'tappades → var den återkom.');
  p();
  p('**Tystnad efter rörelse utan bevisad framfart** (båten kan ha stannat — t.ex. väntat på broöppning; '
    + `ingår ALDRIG i segmentstatistiken): ${allMotionLost.length} fall. `
    + 'De är designfallet för deadline-motorn: sista fixen visar fart, sedan tystnad, och appen kan inte '
    + 'veta om båten fortsatte eller stannade.');
  p();
  if (allMotionLost.length) {
    p('| Tid (UTC) | Korpus | Fartyg | sog sista fixen | Tystnad | Segment | Förflyttning | Medelfart |');
    p('|---|---|---|---:|---:|---:|---:|---:|');
    const topLost = allMotionLost.slice().sort((a, b) => b.gapSec - a.gapSec).slice(0, 10);
    for (const b of topLost) {
      p(`| ${b.tIso.replace('T', ' ').slice(0, 19)} | ${b.corpus} | ${b.name} (${b.mmsi}) `
        + `| ${fmtKn(b.sogKn)} | ${fmtGap(b.gapSec)} | ${b.segment} | ${b.alongM} m `
        + `| ${fmtKn(b.impliedKn)} |`);
    }
    p();
  }

  // ---- Målbroinsegling ----
  const secApproach = night ? 9 : 8;
  p(`## ${secApproach}. Målbroinseglingen — vad visste appen när båten gick under bron?`);
  p();
  p('Varje gång ett fartyg passerade **Klaffbron** eller **Stridsbergsbron** har verktyget räknat bakåt: hur '
    + 'långt bort låg den sista fixen före passagen, hur länge hade det då varit tyst, och hur många fixar '
    + 'fanns över huvud taget på de sista 1 500 / 700 / 300 metrarna. Det är inseglingens verklighet, mätt '
    + 'på riktig trafik.');
  p();
  p('| Källa | Passager | Sista fix (m från bron) p50 / p90 / max | Tystnad vid passagen p50 / p90 / max | Passager utan fix sista 1500 m | 700 m | 300 m |');
  p('|---|---:|---:|---:|---:|---:|---:|');
  const nightId = night ? results.find((r) => r.sources.has('aishub')).id : null;
  const approachRows = [{ label: `${baseSource} (alla ${results.length} korpusar)`, list: approachAis }];
  if (nightId) {
    for (const key of ctx.approachSources) {
      approachRows.push({
        label: `${key} (endast natten)`,
        list: ctx.approaches.filter((x) => x.source === key && x.corpus === nightId),
      });
    }
  }
  for (const row of approachRows) {
    const { list } = row;
    const key = row.label;
    if (!list.length) continue;
    const dist = list.map((x) => x.lastFixDistM);
    const sil = list.map((x) => x.silenceSec);
    const zero = (d) => {
      const n = list.filter((x) => x[`fixes${d}`] === 0).length;
      return `${n}/${list.length} (${Math.round((n / list.length) * 100)} %)`;
    };
    p(`| ${key} | ${list.length} | ${quantile(dist, 0.5)} / ${quantile(dist, 0.9)} / ${Math.max(...dist)} `
      + `| ${quantile(sil, 0.5)} s / ${quantile(sil, 0.9)} s / ${Math.max(...sil)} s `
      + `| ${zero(1500)} | ${zero(700)} | ${zero(300)} |`);
  }
  p();
  p('"Tystnad vid passagen" är tiden från den sista fixen till det interpolerade ögonblick då fartyget '
    + 'korsade brolinjen. Natt-raderna är få passager och ska läsas som en illustration, inte som statistik — '
    + 'men riktningen är entydig: med två källor fanns det alltid data på de sista 700 metrarna.');
  p();

  // ---- Verdikt ----
  p(`## ${night ? 10 : 9}. VERDIKT`);
  p();
  ctx.verdict.lines.forEach((line) => {
    p(line);
    p();
  });

  p('---');
  p();
  p('### Vad kartan INTE säger');
  p();
  p('* Den mäter **levererad** täckning, inte radiotäckning. En fix som mottagarnätet hörde men aldrig '
    + 'levererade (filtrerad, tappad, downsamplad) är osynlig här och räknas som ett hål.');
  p('* Underlaget är ojämnt fördelat: 15 korpusar är enkälliga (aisstream) och en enda är tvåkällig. '
    + 'Källjämförelsen görs därför ENBART inom nattkorpusen, där båda källorna såg samma båtar samtidigt.');
  p('* `Mörka passager` är fartberoende och duger bara för att jämföra KÄLLOR inom samma sektor — för att '
    + 'jämföra sektorer med varandra används fixfrekvens, blindtid och glappkvantiler, som alla är '
    + 'fartneutrala.');
  p('* Målbropassagerna i avsnitt '
    + `${night ? 9 : 8} är GEOMETRISKA (fartyget korsade brolinjen enligt centerlinjeprojektionen), inte `
    + 'appens egna passageregistreringar. De två kan skilja sig i enstaka fall — kartan vet inget om '
    + 'passage-latchar, GPS-hoppgater eller resemodellen.');
  p('* Exponeringstiden interpoleras ur samma fixar som räknas. I ett segment där källan var helt tyst blir '
    + 'exponeringen ändå rätt (den kommer från länken som spänner över hålet), men fixfrekvensen i mycket '
    + 'tunna segment (< 5 traverseringar) ska läsas som indikation, inte mätvärde.');
  p();
  return `${L.join('\n')}\n`;
}

/**
 * @param {number|null} k - fart i knop
 * @returns {string} formaterat värde
 */
function fmtKn(k) {
  return k === null || !Number.isFinite(k) ? '–' : `${String(k).replace('.', ',')} kn`;
}

/**
 * @param {number|null} r - fixar per minut
 * @returns {string} formaterat värde
 */
function fmtRate(r) {
  return r === null || !Number.isFinite(r) ? '–' : r.toFixed(2).replace('.', ',');
}

/**
 * @param {number} sec - sekunder
 * @returns {string} formaterad tid
 */
function fmtGap(sec) {
  if (sec < 120) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

// =============================================================================
// 6. VERDIKT-BERÄKNING
// =============================================================================

/**
 * Formatera p-värde svenskt.
 * @param {number} pv - p-värde
 * @returns {string} formaterat
 */
function fmtP(pv) {
  return pv < 0.001 ? '< 0,001' : pv.toFixed(3).replace('.', ',');
}

/**
 * P-värde för löpande text ("p < 0,001" respektive "p = 0,004").
 * @param {number} pv - p-värde
 * @returns {string} formaterat
 */
function fmtPInline(pv) {
  return pv < 0.001 ? '< 0,001' : `= ${pv.toFixed(3).replace('.', ',')}`;
}

/**
 * Tvåsidigt exakt binomialtest (teckentest).
 * @param {number} k - antal utfall
 * @param {number} n - antal försök
 * @returns {number} p-värde
 */
function binomialTwoSidedP(k, n) {
  if (!n) return 1;
  const logFact = (m) => {
    let s = 0;
    for (let i = 2; i <= m; i++) s += Math.log(i);
    return s;
  };
  const pmf = (i) => Math.exp(logFact(n) - logFact(i) - logFact(n - i) - (n * Math.log(2)));
  const target = pmf(k) * (1 + 1e-9);
  let p = 0;
  for (let i = 0; i <= n; i++) {
    const v = pmf(i);
    if (v <= target) p += v;
  }
  return Math.min(1, p);
}

/**
 * Parvis jämförelse stad vs referens inom samma resa.
 * @param {object[]} results - analysresultat
 * @param {string} citySector - stadssektorns namn
 * @param {string[]} references - referenssektorer
 * @returns {object[]} rader
 */
function pairedComparison(results, citySector, references) {
  const rows = [];
  const runs = results.flatMap((r) => r.runsBySector).filter((r) => r.source !== 'fusion');
  for (const ref of references) {
    const pairs = [];
    for (const run of runs) {
      const cityExp = run.sectorExposure[citySector] || 0;
      const refExp = ref === 'ÖVRIGA'
        ? Object.entries(run.sectorExposure).filter(([k]) => k !== citySector).reduce((s, [, v]) => s + v, 0)
        : (run.sectorExposure[ref] || 0);
      if (cityExp < 60 || refExp < 60) continue;
      const cityFix = run.sectorFixes[citySector] || 0;
      const refFix = ref === 'ÖVRIGA'
        ? Object.entries(run.sectorFixes).filter(([k]) => k !== citySector).reduce((s, [, v]) => s + v, 0)
        : (run.sectorFixes[ref] || 0);
      const cityBlind = run.sectorBlind[citySector] || 0;
      const refBlind = ref === 'ÖVRIGA'
        ? Object.entries(run.sectorBlind).filter(([k]) => k !== citySector).reduce((s, [, v]) => s + v, 0)
        : (run.sectorBlind[ref] || 0);
      pairs.push({
        city: cityFix / (cityExp / 60),
        reference: refFix / (refExp / 60),
        cityBlind: (cityBlind / cityExp) * 100,
        refBlind: (refBlind / refExp) * 100,
      });
    }
    if (!pairs.length) {
      rows.push({
        reference: ref,
        n: 0,
        cityMedian: '–',
        refMedian: '–',
        ratio: '–',
        worse: 0,
        decided: 0,
        worsePct: '–',
        pValue: '–',
        blindCity: '–',
        blindRef: '–',
        blindWorse: 0,
        blindDecided: 0,
        blindWorsePct: '–',
        blindP: '–',
      });
      continue;
    }
    const cityMed = quantile(pairs.map((x) => x.city), 0.5);
    const refMed = quantile(pairs.map((x) => x.reference), 0.5);
    const worse = pairs.filter((x) => x.city < x.reference).length;
    const decided = pairs.filter((x) => x.city !== x.reference).length;
    const pv = binomialTwoSidedP(worse, decided);
    const blindWorse = pairs.filter((x) => x.cityBlind > x.refBlind).length;
    const blindDecided = pairs.filter((x) => x.cityBlind !== x.refBlind).length;
    const blindP = binomialTwoSidedP(blindWorse, blindDecided);
    rows.push({
      reference: ref,
      n: pairs.length,
      cityMedian: fmtRate(cityMed),
      refMedian: fmtRate(refMed),
      ratio: refMed > 0 ? fmtRate(cityMed / refMed) : '–',
      worse,
      decided,
      worsePct: decided ? Math.round((worse / decided) * 100) : 0,
      ratioNum: refMed > 0 ? cityMed / refMed : null,
      pValue: fmtP(pv),
      pNum: pv,
      blindCity: Math.round(quantile(pairs.map((x) => x.cityBlind), 0.5)),
      blindRef: Math.round(quantile(pairs.map((x) => x.refBlind), 0.5)),
      blindWorse,
      blindDecided,
      blindWorsePct: blindDecided ? Math.round((blindWorse / blindDecided) * 100) : 0,
      blindP: fmtP(blindP),
      blindPNum: blindP,
    });
  }
  return rows;
}

/**
 * Formulera verdiktet ur siffrorna.
 * @param {object} ctx - kontext
 * @returns {object} verdikt
 */
function buildVerdict(ctx) {
  const {
    fairway, agg, sectors, night, quay, paired, placebo, baseSource,
  } = ctx;
  const ais = agg.get(baseSource);
  const lines = [];

  const citySector = sectors.find((s) => s.name === 'Klaffbron→Järnvägsbron');
  const cityStats = segStats(mergeSegments(ais.segments, citySector.from, citySector.to));
  const others = sectors.filter((s) => s.name !== citySector.name);
  const otherStats = others.map((s) => ({ name: s.name, st: segStats(mergeSegments(ais.segments, s.from, s.to)) }));
  const rateAll = otherStats.filter((o) => o.st.fixRatePerMin !== null).map((o) => o.st.fixRatePerMin);
  const refRate = quantile(rateAll, 0.5);
  const ratio = refRate ? cityStats.fixRatePerMin / refRate : null;
  const pairedAll = paired.find((r) => r.reference === 'ÖVRIGA');

  const cityWorse = ratio !== null ? ratio < 0.8 : null;
  const headline = ratio === null
    ? 'otillräckligt underlag'
    : `${fmtRate(cityStats.fixRatePerMin)} fixar/min mot ${fmtRate(refRate)} i övriga sektorer `
      + `(kvot ${fmtRate(ratio)}), `
      + `glapp p50 ${cityStats.gapP50} s mot ${quantile(otherStats.map((o) => o.st.gapP50).filter((x) => x !== null), 0.5)} s, `
      + `mörka passager ${cityStats.darkPct} %.`;

  lines.push('### Är stadssektorn Klaffbron↔Järnvägsbron sämre än övriga farleden?');
  lines.push(`**${verdictWord(ratio, pairedAll, placebo)}**`);
  if (placebo && placebo.length) {
    const hits = placebo.filter((x) => x.hit);
    const placeboTail = hits.length >= 2
      ? 'Utslaget är alltså inte specifikt för staden utan följer positionen i farleden — en resas '
        + 'fixar klumpas vid start och slut, så den långa spännande länken dominerar mitten._'
      : 'Utslaget är specifikt för stadssektorn._';
    lines.push('_Placebokontroll: samma parvisa test kört med VARJE sektor som kandidat ger utslag i '
      + `${hits.length} av ${placebo.length} sektorer`
      + `${hits.length ? ` (${hits.map((x) => x.name).join(', ')})` : ''}. ${placeboTail}`);
  }
  lines.push(`Stadssektorn (${citySector.lengthM} m, segment ${citySector.from}–${citySector.to}) har `
    + `${cityStats.transitFixes} transitfixar över ${Math.round(cityStats.exposureMin)} exponeringsminuter = `
    + `**${fmtRate(cityStats.fixRatePerMin)} fixar/min**. Medianen för övriga fyra sektorer är `
    + `**${fmtRate(refRate)} fixar/min** (kvot ${fmtRate(ratio)}). Medianglappet är ${cityStats.gapP50} s mot `
    + `${quantile(otherStats.map((o) => o.st.gapP50).filter((x) => x !== null), 0.5)} s, och `
    + `${cityStats.darkTraversals} av ${cityStats.traversals} traverseringar (${cityStats.darkPct} %) skedde utan en enda fix.`);
  if (pairedAll && pairedAll.n) {
    lines.push(`Det parvisa testet (samma resa, stad mot resten av farleden, ${pairedAll.n} resor — samma fartyg, `
      + 'samma utrustning, samma timme, så trafikmixen kan inte förklara skillnaden) skiljer på TVÅ saker. '
      + `**Mängden data** är ungefär densamma: median ${pairedAll.cityMedian} mot ${pairedAll.refMedian} fixar/min `
      + `(kvot ${pairedAll.ratio}, ${pairedAll.worse}/${pairedAll.decided} avgjorda resor sämre i stan, `
      + `p ${fmtPInline(pairedAll.pNum)}). **Fördelningen** är däremot sämre: medianresan tillbringar `
      + `${pairedAll.blindCity} % av sin stadstid inuti ett glapp > 120 s mot ${pairedAll.blindRef} % i resten `
      + `av samma resa, och ${pairedAll.blindWorse} av ${pairedAll.blindDecided} avgjorda resor `
      + `(${pairedAll.blindWorsePct} %) var blindare i stan (p ${fmtPInline(pairedAll.blindPNum)}). `
      + 'Slutsatsen: i stan kommer fixarna i klumpar med långa hål emellan — precis den felmod som fäller '
      + 'ett notislöfte, eftersom det är hålets längd och inte fixarnas antal som avgör om varningen hinner ut.');
  }
  const cityWideFrom = sectors.find((s) => s.name === 'Klaffbron→Järnvägsbron').from;
  const cityWideTo = sectors.find((s) => s.name === 'Järnvägsbron→Stridsbergsbron').to;
  const cityWide = segStats(mergeSegments(ais.segments, cityWideFrom, cityWideTo));
  lines.push('Tar man hela stadskärnan (Klaffbron→Stridsbergsbron, dvs. båda målbroarna och Järnvägsbron '
    + `emellan) är bilden densamma: ${fmtRate(cityWide.fixRatePerMin)} fixar/min, medianglapp `
    + `${cityWide.gapP50} s, ${cityWide.darkPct} % mörka passager. **Det är exakt den sträcka där appens `
    + 'notislöfte avgörs** — inseglingen mot en målbro.');

  const sectorRank = sectors
    .map((s) => ({ name: s.name, st: segStats(mergeSegments(ais.segments, s.from, s.to)) }))
    .filter((x) => x.st.fixRatePerMin !== null)
    .sort((a, b) => a.st.fixRatePerMin - b.st.fixRatePerMin);
  lines.push('Rangordning (sämst först, fixar/min): '
    + `${sectorRank.map((x) => `${x.name} ${fmtRate(x.st.fixRatePerMin)}`).join(' · ')}.`);

  // Kajen
  lines.push('### Kajen norr om Klaffbron');
  const quayVerdict = quay.stats.fixRatePerMin === null
    ? 'Otillräckligt underlag — kajzonen passeras sällan i transitfart i korpusarna.'
    : `Kajsegmenten (segment ${quay.from}–${quay.to} = ${(quay.to - quay.from + 1) * SEGMENT_M} m, `
      + `varav kajzonen själv är ${quay.fromM}–${quay.toM} m) har `
      + `${fmtRate(quay.stats.fixRatePerMin)} fixar/min och medianglapp ${quay.stats.gapP50} s — `
      + `${cmpWord(quay.stats.fixRatePerMin, refRate)} farledssnittet. `
      + `${quay.stats.darkTraversals} av ${quay.stats.traversals} traverseringar `
      + `(${quay.stats.darkPct} %) var mörka.`;
  lines.push(quayVerdict);
  lines.push('Kajzonen är dessutom den plats där sämst täckning gör mest skada: det är här V1-kajbokföringen '
    + 'ska skilja en avgående båt från en kajvobblare, och varje minut utan fix är en minut där '
    + 'avgångsbeviset inte kan samlas in.');

  // Sämsta segment
  const worst = ais.segments
    .map((s, i) => ({ i, st: segStats(s) }))
    .filter((x) => x.st.traversals >= 5 && x.st.gapP50 !== null)
    .sort((a, b) => b.st.gapP50 - a.st.gapP50)[0];
  // ÄNDPUNKTSATTRIBUERAD RANGORDNING vid sidan av: span-p50:n kröner det
  // segment som flest LÅNGA glapp PASSERAR, inte det där kontakten faktiskt
  // tappas. Båda redovisas så rubriken inte bär mer än den kan.
  const worstEnd = ais.segments
    .map((s, i) => ({ i, st: segStats(s) }))
    .filter((x) => x.st.traversals >= 5 && x.st.endGapP50 !== null && x.st.endGapN >= 5)
    .sort((a, b) => b.st.endGapP50 - a.st.endGapP50)[0];
  const worstSegment = worst
    ? `segment ${worst.i} (${worst.i * SEGMENT_M}–${(worst.i + 1) * SEGMENT_M} m, `
      + `${segLabel(fairway, worst.i).replace(/\*\*/g, '')}) med medianglapp ${worst.st.gapP50} s `
      + `(ändpunktsattribuerat ${worst.st.endGapP50 ?? '–'} s på ${worst.st.endGapN} glapp) `
      + `och ${worst.st.darkPct} % mörka passager`
    : 'inget segment har tillräckligt underlag';
  lines.push('### Sämsta enskilda segmentet');
  lines.push(`Med minst 5 traverseringar: ${worstSegment}.`);
  if (worstEnd) {
    lines.push('Rangordnat på ÄNDPUNKTSATTRIBUERADE glapp — där kontakten faktiskt tappades eller '
      + 'återkom, inte där ett långt glapp råkade passera — är sämsta segmentet i stället nr '
      + `${worstEnd.i} (${worstEnd.i * SEGMENT_M}–${(worstEnd.i + 1) * SEGMENT_M} m, `
      + `${segLabel(fairway, worstEnd.i).replace(/\*\*/g, '')}) med `
      + `${worstEnd.st.endGapP50} s på ${worstEnd.st.endGapN} glapp. Skillnaden mellan de två `
      + 'listorna ÄR span-attributionen: läs den första som "här är man ofta blind", den andra '
      + 'som "här tappas kontakten".');
  }

  // Natten
  let nightHeadline = null;
  if (night) {
    const a = night.agg.get('aisstream');
    const h = night.agg.get('aishub');
    const f = night.agg.get('fusion');
    const darkOf = (key) => {
      const cov = night.common.get(key);
      if (!cov) return { dark: 0, trav: 0, pct: null };
      return { dark: cov.dark, trav: cov.traversals, pct: cov.traversals ? Math.round((cov.dark / cov.traversals) * 100) : null };
    };
    const da = darkOf('aisstream');
    const dh = darkOf('aishub');
    const df = darkOf('fusion');
    const thinTail = night.thinned
      ? ` — men gallrad till samma ${night.thinned.target} fixar ligger AISHub på `
        + `${night.thinned.min}–${night.thinned.max} % mörkt, så skillnaden är leveransvolym, `
        + 'inte antenn.'
      : '.';
    nightHeadline = `AISHub (den egna antennkedjan) levererade ${h.fixes} fixar mot aisstreams ${a.fixes}; `
      + `mörka segment på samma resor ${dh.dark}/${dh.trav} (${dh.pct} %) mot ${da.dark}/${da.trav} (${da.pct} %), `
      + `tillsammans ${df.dark}/${df.trav} (${df.pct} %)${thinTail}`;
    lines.push('### Antennfrågan: vad säger tvåkällenatten?');
    lines.push(`Under de ${night.hours} timmarna levererade **AISHub ${h.fixes} fixar** och **aisstream ${a.fixes}** `
      + `i kartområdet (unionen ${f.fixes} efter att ${night.merged} korskälledubbletter slagits ihop). `
      + `Medianglappet i transit var ${Math.round(quantile(h.gapAll, 0.5))} s för AISHub — men det talet är `
      + 'golvat av pollkadensen (65 s), så det ska INTE läsas som antennkvalitet. '
      + 'Det som ÄR jämförbart är mörka segment mätta på GEMENSAM nämnare (samma resor, samma fönster): '
      + `AISHub ${dh.dark}/${dh.trav} (${dh.pct} %) mot aisstream ${da.dark}/${da.trav} (${da.pct} %).`);
    lines.push(`Slutsatsen för antennplaceringen: ${antennaVerdict(da, dh, df, night)}`);
  }

  return {
    lines, cityWorse, headline, worstSegment, nightHeadline,
  };
}

/**
 * @param {number|null} ratio - kvot stad/referens
 * @param {object|null} pairedAll - parvis rad
 * @returns {string} verdiktord
 */
function verdictWord(ratio, pairedAll, placebo) {
  if (ratio === null) return 'Kan inte avgöras med detta underlag.';
  // PLACEBOKONTROLLEN FÖRST: slår samma parvisa test ut för flera ANDRA
  // sektorer är utslaget inte specifikt för staden utan för positionen i
  // farleden, och verdiktet får inte påstå något annat.
  const hits = Array.isArray(placebo) ? placebo.filter((x) => x.hit) : [];
  const nonSpecific = hits.length >= 2;
  // Parvis bekräftelse: samma riktning OCH statistiskt hållbart teckentest, i
  // ENDERA av de två parvisa måtten (fixfrekvens = hur mycket data, blindtid =
  // hur klumpad den är). Att bara det senare slår ut är ett giltigt fynd —
  // lika många fixar men samlade i klumpar är sämre för ett notislöfte.
  const enough = pairedAll && pairedAll.n >= 20;
  const rateWorse = enough && pairedAll.ratioNum !== null && pairedAll.ratioNum < 1 && pairedAll.pNum < 0.05;
  const blindWorse = enough && pairedAll.blindWorsePct > 50 && pairedAll.blindPNum < 0.05;
  const pairedWorse = rateWorse || blindWorse;
  const placeboNote = nonSpecific
    ? ` (OBS: samma parvisa test slår ut för ${hits.length} av ${placebo.length} sektorer —`
      + ` ${hits.map((x) => x.name).join(', ')} — så utslaget är inte specifikt för staden`
      + ' utan följer positionen i farleden)'
    : '';
  if (ratio < 0.85 && pairedWorse && !nonSpecific) {
    return 'JA — mätbart sämre, och parvis bekräftat på samma resor.';
  }
  if (ratio < 0.85 && pairedWorse) {
    return `DELVIS — sämre i aggregatet, men den parvisa bekräftelsen är inte specifik${placeboNote}.`;
  }
  if (ratio < 0.85) return 'DELVIS — sämre i aggregatet, men det parvisa testet stödjer det inte entydigt.';
  if (pairedWorse && nonSpecific) {
    return `NEJ — likvärdig fixmängd, och det parvisa utslaget är inte specifikt${placeboNote}.`;
  }
  if (pairedWorse) return 'DELVIS — likvärdig fixmängd, men parvis bekräftat sämre fördelad (längre hål).';
  if (ratio > 1.15) return 'NEJ — stadssektorn är tvärtom BÄTTRE täckt än farledens snitt.';
  return 'NEJ — ingen mätbar skillnad mot övriga farleden.';
}

/**
 * @param {number} a - värde
 * @param {number} b - referens
 * @returns {string} jämförelseord
 */
function cmpWord(a, b) {
  if (!b) return 'kan inte jämföras med';
  const r = a / b;
  if (r < 0.7) return 'klart under';
  if (r < 0.9) return 'under';
  if (r > 1.3) return 'klart över';
  if (r > 1.1) return 'över';
  return 'i nivå med';
}

/**
 * KONTROLLEXPERIMENT: gallra AISHub slumpmässigt ned till AISstreams fixantal
 * och mät om mörkerandelen. Måttet "mörka segment" räknar traverseringar UTAN
 * fix och är därför monotont i fixantalet — utan den här kontrollen kan en
 * skillnad i mörker inte skiljas från en skillnad i LEVERANSVOLYM.
 * @param {object} nightRes - analyzeCorpus-resultatet för nattkorpusen
 * @param {object} fairway - farledsmodellen
 * @returns {object|null} { target, draws:[{fixes,pct}], p50, min, max }
 */
function thinHubControl(nightRes, fairway) {
  const hub = nightRes.sources.get('aishub');
  const ais = nightRes.sources.get('aisstream');
  if (!hub || !ais || !hub.fixes || !ais.fixes || ais.fixes >= hub.fixes) return null;
  const keepFrac = ais.fixes / hub.fixes;
  const raw = fs.readFileSync(nightRes.jsonlPath, 'utf8').trim().split('\n');
  const draws = [];
  // Fyra dragningar med FASTA frön — kontrollen måste vara reproducerbar.
  for (const seed of [11, 22, 33, 44]) {
    let st = seed;
    const rnd = () => {
      st = (st * 1103515245 + 12345) % 2147483648;
      return st / 2147483648;
    };
    const kept = raw.filter((line) => {
      let o;
      try {
        o = JSON.parse(line);
      } catch (e) {
        return false;
      }
      return !(o.feed === 'aishub' && rnd() > keepFrac);
    });
    const tmp = path.join(os.tmpdir(), `coverage-thin-${seed}-${process.pid}.jsonl`);
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`);
    try {
      const r = analyzeCorpus({ id: 'thin', jsonl: tmp, hours: nightRes.hours || 10 }, fairway);
      const cov = r.commonCoverage.get('aishub');
      const src = r.sources.get('aishub');
      if (cov && cov.traversals && src) {
        draws.push({ fixes: src.fixes, pct: Math.round((100 * cov.dark) / cov.traversals) });
      }
    } finally {
      fs.unlinkSync(tmp);
    }
  }
  if (!draws.length) return null;
  const pcts = draws.map((d) => d.pct).sort((a, b) => a - b);
  return {
    target: ais.fixes,
    draws,
    min: pcts[0],
    max: pcts[pcts.length - 1],
    p50: quantile(pcts, 0.5),
  };
}

/**
 * @param {object} da - aisstream mörkerandel
 * @param {object} dh - aishub mörkerandel
 * @param {object} df - fusion mörkerandel
 * @param {object} night - nattkontext
 * @returns {string} antennverdikt
 */
function antennaVerdict(da, dh, df, night) {
  const parts = [];
  const thin = night.thinned;
  if (dh.pct !== null && da.pct !== null) {
    parts.push(`den egna kedjan (AISHub) har ${dh.pct} % mörka segment mot AISstreams ${da.pct} % `
      + 'på samma resor');
    if (thin) {
      // FIXMÄNGDEN FÖRST. Gallrad till samma fixantal ligger AISHub i bandet
      // [min, max]; ligger AISstreams värde inom (eller under) det bandet
      // säger skillnaden ingenting om antennen.
      const indistinguishable = da.pct >= thin.min - 3 && da.pct <= thin.max + 3;
      parts.push('MEN skillnaden är i första hand LEVERANSVOLYM: gallras AISHub slumpmässigt ned till '
        + `AISstreams ${thin.target} fixar hamnar den på ${thin.min}–${thin.max} % mörkt `
        + `(4 dragningar: ${thin.draws.map((d) => `${d.fixes}→${d.pct} %`).join(', ')})`);
      parts.push(indistinguishable
        ? 'vid samma fixantal är källorna alltså OSKILJBARA — mätningen ger inget stöd för att '
          + 'den egna antennen hör båtar som AISstream-nätet missar, och inget underlag för att '
          + 'flytta antennen'
        : 'skillnaden kvarstår ÄVEN vid samma fixantal — det är först då den säger något om antennen');
    } else {
      parts.push('kontrollen som skiljer antenn från leveransvolym kunde inte köras — '
        + 'tolka skillnaden som volym tills den finns');
    }
  }
  if (df.pct !== null) {
    const best = Math.min(dh.pct === null ? 100 : dh.pct, da.pct === null ? 100 : da.pct);
    parts.push(`tillsammans faller mörkret till ${df.pct} % (från ${best} %)`);
    parts.push(thin
      ? 'även den vinsten är till största delen fler fixar, inte komplementaritet: '
        + 'mörkerandelen faller monotont med fixantalet enligt gallringskurvan ovan, '
        + 'och bara överskottet mot den kurvan är äkta komplementaritet'
      : 'hur mycket av det som är komplementaritet och hur mycket som är fler fixar går '
        + 'inte att avgöra utan gallringskontrollen');
  }
  if (night.hubSectors && night.hubSectors.length) {
    const best = night.hubSectors[0];
    const worst = night.hubSectors[night.hubSectors.length - 1];
    parts.push(`per sektor (endast celler med ≥${night.sectorMinTraversals} traverseringar) är den egna `
      + `kedjan starkast i ${best.name} (${best.hubPct} % mörkt mot AISstreams ${best.aisPct} %) och `
      + `svagast i ${worst.name} (${worst.hubPct} % mörkt) — men underlaget är 5 båtresor, `
      + 'så sektorsiffrorna är illustration, inte statistik, och bär ingen antennrekommendation');
  }
  return `${parts.join('; ')}.`;
}

// =============================================================================
// 7. MAIN
// =============================================================================

/**
 * @param {string[]} argv - kommandoradsargument
 * @returns {object} konfiguration
 */
function parseArgs(argv) {
  const cfg = {
    files: [],
    corpusFilter: null,
    json: DEFAULT_JSON,
    md: DEFAULT_MD,
    segmentM: SEGMENT_M,
    transitSogKn: TRANSIT_SOG_KN,
    blackoutS: BLACKOUT_S,
    corridorM: CORRIDOR_M,
    maxLinkS: MAX_LINK_S,
    maxImpliedKn: MAX_IMPLIED_KN,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') {
      i += 1;
      cfg.json = argv[i];
    } else if (a === '--md') {
      i += 1;
      cfg.md = argv[i];
    } else if (a === '--corpus') {
      i += 1;
      cfg.corpusFilter = (cfg.corpusFilter || []).concat(argv[i].split(','));
    } else if (a === '--no-json') {
      cfg.json = null;
    } else if (a === '--no-md') {
      cfg.md = null;
    } else if (a === '--help' || a === '-h') {
      cfg.help = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Okänd flagga: ${a}`);
    } else {
      cfg.files.push(a);
    }
  }
  // DELMÄNGDSSKYDDET (granskningen 2026-08-04): en delmängdskörning skrev
  // rakt över den committade helrapporten i docs/ — samma datumstämplade
  // filnamn, samma auktoritativa rubriker, men "1 korpusar" i underlaget och
  // ett verdikt som motsade originalet. Filerna är ospårade, så det fanns
  // ingen git-restore att falla tillbaka på. En körning som INTE omfattar
  // hela underlaget måste därför peka ut sina egna utfiler.
  const subset = (cfg.corpusFilter && cfg.corpusFilter.length) || cfg.files.length > 0;
  const writesDefault = cfg.json === DEFAULT_JSON || cfg.md === DEFAULT_MD;
  if (subset && writesDefault) {
    throw new Error('--corpus/filargument är en DELMÄNGD och får inte skriva över helrapporten i '
      + 'docs/. Ange egna utfiler (--json <fil> --md <fil>) eller stäng av skrivningen '
      + '(--no-json --no-md).');
  }
  return cfg;
}

/** Kör verktyget. */
function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.help) {
    console.log('node tests/replay-validation/coverageMap.js [--corpus id[,id]] [--json fil] [--md fil] [extra.jsonl ...]');
    return;
  }

  const fairway = buildFairway();
  const selfCheck = selfCheckProjection(fairway);
  if (selfCheck.maxDeltaM > 0.5) {
    throw new Error(`Projektionen avviker från geometry.distancePointToSegmentM: ${selfCheck.maxDeltaM} m`);
  }

  let inputs = corpora.map((c) => ({ id: c.id, jsonl: c.jsonl, hours: c.hours })).concat([NIGHT_CORPUS]);
  if (cfg.files.length) {
    inputs = cfg.files.map((f) => ({ id: path.basename(f, '.jsonl'), jsonl: path.resolve(f), hours: null }));
  }
  if (cfg.corpusFilter) {
    inputs = inputs.filter((c) => cfg.corpusFilter.includes(c.id));
    if (!inputs.length) throw new Error(`Ingen korpus matchade --corpus ${cfg.corpusFilter.join(',')}`);
  }

  console.log(`Täckningskartan: ${inputs.length} korpusar, farled ${Math.round(fairway.mapEndM)} m `
    + `i ${fairway.segmentCount} segment à ${SEGMENT_M} m`);

  const results = inputs.map((c) => {
    const r = analyzeCorpus(c, fairway);
    console.log(`  ${r.id.padEnd(16)} ${String(r.rows).padStart(5)} fixar  ${String(r.vessels).padStart(3)} fartyg  `
      + `${String(r.blackouts.filter((b) => b.source !== 'fusion').length).padStart(4)} blackouts`);
    return r;
  });

  const agg = aggregate(results, fairway);
  const sectors = buildSectors(fairway);

  // Kajzonen norr om Klaffbron (MOORING_ZONES[0]) projicerad på farleden
  const zone = MOORING_ZONES[0];
  const zStart = projectFix(fairway, zone.start.lat, zone.start.lon);
  const zEnd = projectFix(fairway, zone.end.lat, zone.end.lon);
  const quayFrom = segIndex(fairway, Math.min(zStart.s, zEnd.s));
  const quayTo = segIndex(fairway, Math.max(zStart.s, zEnd.s));
  const quay = {
    from: quayFrom,
    to: quayTo,
    fromM: Math.round(Math.min(zStart.s, zEnd.s)),
    toM: Math.round(Math.max(zStart.s, zEnd.s)),
    stats: segStats(mergeSegments(agg.get(agg.has('aisstream') ? 'aisstream' : [...agg.keys()][0]).segments,
      quayFrom, quayTo)),
  };

  // PLACEBOKONTROLLEN (granskningen 2026-08-04): verdiktet "stadssektorn är
  // mätbart sämre, parvis bekräftat" reproducerades av godtyckliga
  // kontrollfönster på andra ställen i farleden — 5 av 10 gav samma
  // "signifikanta" utslag, och det STARKASTE låg norr om Stridsbergsbron.
  // Effekten är alltså i hög grad en egenskap hos MITTENPOSITIONEN (en resas
  // fixar klumpas vid start och slut, så den långa spännande länken dominerar
  // mitten), inte hos staden. Kontrollen kör därför samma parvisa test med
  // VARJE sektor som kandidat och redovisar hur många som slår ut.
  const placebo = sectors.map((sec) => {
    const row = pairedComparison(results, sec.name, ['ÖVRIGA'])[0];
    const enough = row && row.n >= 20;
    const rateWorse = enough && row.ratioNum !== null && row.ratioNum < 1 && row.pNum < 0.05;
    const blindWorse = enough && row.blindWorsePct > 50 && row.blindPNum < 0.05;
    return {
      name: sec.name, n: row ? row.n : 0, rateWorse, blindWorse, hit: rateWorse || blindWorse,
    };
  });

  const paired = pairedComparison(results, 'Klaffbron→Järnvägsbron', [
    'ÖVRIGA', 'Olidebron→Klaffbron', 'Stridsbergsbron→Stallbackabron',
  ]);

  // Nattkorpusen separat (enda tvåkälliga)
  const nightRes = results.find((r) => r.sources.has('aishub'));
  let night = null;
  if (nightRes) {
    const nightAgg = aggregate([nightRes], fairway);
    const sourceOrder = ['aisstream', 'aishub', 'fusion'].filter((k) => nightAgg.has(k));
    const hubCov = nightRes.commonCoverage.get('aishub');
    const aisCov = nightRes.commonCoverage.get('aisstream');
    const sumCov = (cov, sec) => {
      let dark = 0;
      let trav = 0;
      for (let i = sec.from; i <= sec.to && i < cov.segments.length; i++) {
        dark += cov.segments[i].dark;
        trav += cov.segments[i].traversals;
      }
      return { dark, trav, pct: trav ? Math.round((dark / trav) * 100) : null };
    };
    // SEKTORVAKTEN (granskningen 2026-08-04): trav ≥ 5 SEGMENT-traverseringar
    // är en halv båtresa genom en sektor — det är ingen vakt. En sektor är
    // ~10 segment, så kravet höjs till 3 hela sektorpassager (30
    // traverseringar). Underlaget är 5 fusionsresor; färre än så och en cell
    // är ren pseudoreplikation (den gamla gränsen släppte igenom cellen som
    // antennrekommendationen byggde på: 34 traverseringar ≈ 3,4 resor, och
    // hela "försprånget" var två segment).
    const SECTOR_MIN_TRAVERSALS = 30;
    const hubSectors = (hubCov && aisCov ? sectors : [])
      .map((sec) => ({ name: sec.name, h: sumCov(hubCov, sec), a: sumCov(aisCov, sec) }))
      .filter((x) => x.h.trav >= SECTOR_MIN_TRAVERSALS)
      .map((x) => ({
        name: x.name, hubPct: x.h.pct, aisPct: x.a.pct, trav: x.h.trav,
      }))
      .sort((x, y) => x.hubPct - y.hubPct);
    night = {
      agg: nightAgg,
      common: nightRes.commonCoverage,
      sourceOrder,
      latency: nightRes.latency,
      merged: nightRes.mergedCrossSource,
      hours: nightRes.hours || 10,
      rows: nightRes.rows,
      hubSectors,
      sectorMinTraversals: SECTOR_MIN_TRAVERSALS,
      // KONTROLLEXPERIMENTET (granskningen 2026-08-04). "Mörka segment" är en
      // MONOTON funktion av fixantalet, så en källa som levererar dubbelt så
      // många fixar får färre mörka segment även med identisk antenn. Utan
      // den här kontrollen påstod rapporten att den egna antennen "hör båtar
      // som AISstream-nätet missar" — vilket inte gick att skilja från att
      // AISHub levererade 138 fixar mot 70. Kontrollen gallrar AISHub
      // slumpmässigt ned till den andra källans fixantal och mäter om.
      thinned: thinHubControl(nightRes, fairway),
    };
  }

  const approaches = results.flatMap((r) => r.targetApproaches);
  const approachSources = ['aisstream', 'aishub', 'fusion'].filter((k) => approaches.some((x) => x.source === k));
  const baseSource = agg.has('aisstream') ? 'aisstream' : [...agg.keys()][0];
  if (!baseSource) throw new Error('Ingen källa i underlaget — tom eller ogiltig korpus?');
  const ctx = {
    fairway,
    baseSource,
    results,
    agg,
    sectors,
    night,
    quay,
    paired,
    placebo,
    selfCheck,
    approaches,
    approachSources,
    config: cfg,
  };
  ctx.verdict = buildVerdict(ctx);

  // ---- JSON ----
  if (cfg.json) {
    const json = {
      generatedAt: new Date().toISOString(),
      tool: 'tests/replay-validation/coverageMap.js',
      config: {
        segmentM: SEGMENT_M,
        transitSogKn: TRANSIT_SOG_KN,
        blackoutS: BLACKOUT_S,
        corridorM: CORRIDOR_M,
        maxLinkS: MAX_LINK_S,
        maxImpliedKn: MAX_IMPLIED_KN,
        crossSourceDedup: { seconds: CROSS_SOURCE_DEDUP_S, meters: CROSS_SOURCE_DEDUP_M },
      },
      fairway: {
        lengthM: Math.round(fairway.mapEndM),
        segmentCount: fairway.segmentCount,
        centerline: FAIRWAY_CENTERLINE,
        anchors: fairway.anchors.map((a) => ({
          name: a.name, sM: Math.round(a.s), coordOffsetM: Math.round(a.offsetM), mode: a.mode,
        })),
        sectors,
      },
      corpora: results.map((r) => ({
        id: r.id,
        file: r.file,
        hours: r.hours,
        rows: r.rows,
        vessels: r.vessels,
        span: r.span,
        outOfMap: r.outOfMap,
        outSouth: r.outSouth,
        outNorth: r.outNorth,
        outOfCorridor: r.outOfCorridor,
        latency: r.latency,
        sources: fromPairs([...r.sources].map(([k, acc]) => [k, {
          fixes: acc.fixes,
          transitFixes: acc.transitFixes,
          transitLinks: acc.transitLinks,
          runs: acc.runs,
          gapP50: acc.gapAll.length ? Math.round(quantile(acc.gapAll, 0.5)) : null,
          gapP90: acc.gapAll.length ? Math.round(quantile(acc.gapAll, 0.9)) : null,
        }])),
        segments: fromPairs([...r.sources].map(([k, acc]) => [k,
          acc.segments.map((s, i) => ({ i, ...segStats(s) })).filter((s) => s.fixes || s.traversals),
        ])),
      })),
      aggregate: fromPairs([...agg].map(([k, acc]) => [k, {
        fixes: acc.fixes,
        transitFixes: acc.transitFixes,
        transitLinks: acc.transitLinks,
        gapP50: acc.gapAll.length ? Math.round(quantile(acc.gapAll, 0.5)) : null,
        gapP90: acc.gapAll.length ? Math.round(quantile(acc.gapAll, 0.9)) : null,
        segments: acc.segments.map((s, i) => ({
          i, fromM: i * SEGMENT_M, toM: (i + 1) * SEGMENT_M, ...segStats(s),
        })),
        sectors: sectors.map((sec) => ({ name: sec.name, ...segStats(mergeSegments(acc.segments, sec.from, sec.to)) })),
      }])),
      quayNorthOfKlaffbron: quay,
      pairedCityTest: paired,
      targetApproaches: results.flatMap((r) => r.targetApproaches)
        .sort((a, b) => b.lastFixDistM - a.lastFixDistM),
      blackouts: results.flatMap((r) => r.blackouts).sort((a, b) => b.gapSec - a.gapSec),
      motionLostGaps: results.flatMap((r) => r.motionLost).sort((a, b) => b.gapSec - a.gapSec),
      verdict: {
        cityWorse: ctx.verdict.cityWorse,
        headline: ctx.verdict.headline,
        worstSegment: ctx.verdict.worstSegment,
        nightHeadline: ctx.verdict.nightHeadline,
      },
    };
    fs.writeFileSync(cfg.json, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`JSON  → ${cfg.json}`);
  }

  // ---- Markdown ----
  if (cfg.md) {
    fs.writeFileSync(cfg.md, buildMarkdown(ctx));
    console.log(`MD    → ${cfg.md}`);
  }

  console.log(`\nVERDIKT: ${ctx.verdict.headline}`);
  if (ctx.verdict.nightHeadline) console.log(`NATTEN: ${ctx.verdict.nightHeadline}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  FAIRWAY_CENTERLINE,
  buildFairway,
  projectFix,
  loadCorpus,
  analyzeCorpus,
  segStats,
  quantile,
  SEGMENT_M,
  TRANSIT_SOG_KN,
  BLACKOUT_S,
  CORRIDOR_M,
};
