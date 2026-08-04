'use strict';

/**
 * ÖPPNINGSGRINDARNA (etapp 6, 2026-08-03) — `npm run replay:openings`.
 *
 * Det PROAKTIVA lagret (bridge_opening_soon) har en egen sanning som varken
 * notisfacit, golden-text eller riktningsfacit kan se: gick varningen ut, gick
 * den ut I TID, och gick den ut för en öppning som faktiskt kom? Den här
 * grinden mäter exakt det, mot RÅDATA — inte mot en inspelning av vad koden
 * råkade göra.
 *
 * TRE GRINDAR
 *   O1 ÖPPNINGSTÄCKNING. Varje detekterad målbropassage i varje korpus ska ha
 *      en öppningsvarning FÖRE passagetidpunkten (antingen med fartyget som
 *      medlem i avfyrningen, eller via konvojtäckning — "absorbed"). Varje
 *      MISS klassas mot rå jsonl i tre datastödda klasser; en OKLASSAD miss
 *      är RÖD. Rapporterar täckningsgrad + ledtidsfördelning per korpus.
 *   O2 FANTOMTAK. Varje öppningsvarning som INTE följs av en passage av bron
 *      inom 20 min klassas mot rådata. "U-sväng/avbruten anflygning efter en
 *      äkta beväpnad approach" är produktprincipens ACCEPTERADE falsklarms-
 *      klass; en KAJVOBBEL (båt som aldrig gjorde en riktig avgång) är RÖD.
 *   O3 NATTKONTROLLEN. A/B-nattens två armar körs som fältprov: B-armen
 *      (dubbelkälla, REPLAY_FUSION=1) ska ge sina sex öppningar varnade FÖRE
 *      passagen med konvojen vid Klaffbron som EN varning, noll varningar ur
 *      kajliggarna, och en HELT oförändrad boat_near-dimension. A-armen
 *      (enbart aisstream) ska vara byte-identisk med nattens facit.
 *
 * KLASSNINGEN SKRIVS ALLTID UT I SIN HELHET — varje miss och varje fantom med
 * sitt rådatabevis (avstånd, fart, tider), så att dirigent och batteriagent
 * kan granska besluten i stället för att lita på en siffra.
 *
 * Exit-kod 0 endast om O1 saknar oklassade missar, O2 saknar kajvobbel-fantomer
 * och O3 håller hela nattkontraktet.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const corpora = require('./corpora');
const {
  BRIDGES, TARGET_BRIDGES, BRIDGE_OPENING, MOORING_DETECTION, QUAY_DEPARTURE_GATE,
} = require('../../lib/constants');
const geometry = require('../../lib/utils/geometry');

const RUNNER = path.join(__dirname, 'replayRunner.js');

// A/B-NATTENS FILER LIGGER I REPOT (samma princip som ChatGPT-granskningens
// B3-beslut om korpusdatan): en grind som bara fungerar i den session där
// arbetet gjordes är ingen grind. Filerna är byte-identiska kopior av
// A/B-nattens original — night-fusion.jsonl ÄR redan
// corpora-data/ais-fusion-20260803-nattkorning.jsonl (samma sha256).
// OPENING_AB_DIR pekar om hela uppsättningen för felsökning mot originalen.
const AB_DIR = process.env.OPENING_AB_DIR || null;
const NIGHT_DIR = path.join(__dirname, 'night-facit');
const CORPORA_DATA = path.join(__dirname, 'corpora-data');
const pick = (abName, repoPath) => (AB_DIR && fs.existsSync(path.join(AB_DIR, abName))
  ? path.join(AB_DIR, abName) : repoPath);
const NIGHT_FUSION = pick('night-fusion.jsonl', path.join(CORPORA_DATA, 'ais-fusion-20260803-nattkorning.jsonl'));
const NIGHT_AISSTREAM = pick('night-aisstream.jsonl', path.join(CORPORA_DATA, 'ais-aisstream-20260803-nattkorning.jsonl'));
const FIELD_NOTIF = pick('field-notif.txt', path.join(NIGHT_DIR, 'field-notif.txt'));
const FIELD_TEXTS = pick('field-texts.txt', path.join(NIGHT_DIR, 'field-texts.txt'));
const GT_PASSAGES = pick('gt-passages.json', path.join(NIGHT_DIR, 'gt-passages.json'));

// Parallellitet: varje korpus är en egen nodprocess. 4 samtidiga håller
// väggtiden nere utan att svälta maskinen (samma storleksordning som jest
// använder). OPENING_GATES_JOBS=1 ger deterministisk felsökningsordning.
const JOBS = Math.max(1, parseInt(process.env.OPENING_GATES_JOBS || '4', 10));

// ---------------------------------------------------------------------------
// TRÖSKLAR FÖR KLASSIFICERINGEN (härledda, inte hittepå)
// ---------------------------------------------------------------------------
// Garantifönstret: en varning kan aldrig gå ut tidigare än ledtiden + ett
// tick-intervall efter första observationen inne i beväpningshorisonten
// (deadline-utvärderingen är tick-driven). En passage som ligger närmare än så
// efter första observationen ÄR omöjlig att förvarna — det är fysik, inte bugg.
const MIN_WARNABLE_MS = BRIDGE_OPENING.WARNING_LEAD_MS + BRIDGE_OPENING.TICK_INTERVAL_MS;
// O2-KONTRAKTETS fönster: en passage inom 20 min efter varningen räknas som
// "öppningen kom, precis som utlovat".
const PHANTOM_WINDOW_MS = 20 * 60 * 1000;
// SEN PASSAGE. Deadline-motorn är MEDVETET pessimistisk (DEADLINE_MAX_SPEED_KN
// = 10 kn mot en uppmätt medianfart på 3,13 kn), så en varning som fyras på
// horisontens rand ligger typiskt ~3× längre före passagen än ledtiden.
// Mätt över de 16 korpusarna: MEDIAN 19,4 min ledtid, max 87,4 min. Ett
// 20-minutersfönster hade därför dömt över hälften av alla HELT KORREKTA
// varningar som fantomer. Passager i intervallet 20–120 min bokförs som
// SEN_PASSAGE — öppningen kom, varningen var bara tidig — och fördelningen
// rapporteras så tidigheten går att granska som den produktavvägning den är.
const LATE_PASSAGE_WINDOW_MS = 120 * 60 * 1000;
// Bevis för en ÄKTA anflygning: fartyget ska ha NÄRMAT sig bron mätbart. 200 m
// är grovt fem gånger GPS-bruset i korpusarna (≤20 m syntetiskt, ≤~40 m i
// fält) och en tiondel av beväpningshorisonten.
const GENUINE_APPROACH_M = 200;
// Fönstret bakåt som anflygningsbeviset söks i. En arm lever högst
// ARM_STALE_TTL_MS efter sitt sista fix; anflygningen kan ha börjat före det,
// så beviset söks i dubbla den tiden.
const APPROACH_LOOKBACK_MS = 2 * BRIDGE_OPENING.ARM_STALE_TTL_MS;
// "Under gång" — appens EGEN transitgräns (QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN,
// den tröskel V1-kajbokföringen räknar rörelsefixar med). GLESHETEN ÄR
// VERKLIG: BRANIF (211112870) levererade EXAKT ETT fix på 78 minuter, i
// 4,6 kn — nettonärmandet är noll av ren sampelbrist, inte av stillastående.
const UNDERWAY_SOG_KN = QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN;
// ...MEN ETT ENDA SAMPEL ÖVER TRÖSKELN DUGER INTE (etapp 6-granskningen).
// V1-bokföringen kräver MIN_MOVING_FIXES rörelsefixar OCH ingen netto-reträtt
// — här användes bara 1-knopsdelen, på ett enda sampel, vilket gjorde den
// RÖDA klassen i praktiken onåbar: AKIRA (257605080, 2026-07-08) guppade vid
// kajen 400–660 m från Klaffbron, fick ETT sampel på 1,1 kn och gick sedan
// NORRUT bort från bron — och grinden stämplade henne "äkta anflygning".
// Kravet speglar nu V1:s egen konjunktion.
const UNDERWAY_MIN_FIXES = QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES;
// Ett ENSAMT sampel får bära beviset först vid en fart ingen kajliggare kan
// visa. dig3 mätte den effektiva anflygningsfarten över 1798 sampel:
// median 3,13 kn, p90 5,24. BRANIF-fallets 4,6 kn ligger över medianen; en
// kajvobblare ligger per definition under TRANSIT_SOG_KN större delen av
// tiden. Medianen är alltså den naturliga skiljelinjen och är MÄTT, inte vald.
const UNDERWAY_SOLO_SOG_KN = 3.13;
// KAJBANDET. En kajvobblare är per definition VID EN KAJ. Rörelsebeviset
// ovan är nödvändigt men inte tillräckligt för att döma RÖTT: mätt över
// korpusarna finns en hel klass av GLESA men fullt gångna fartyg 1,4–1,6 km
// ut i farleden (IDUN 2,2 kn, LAMANTIJN 2,9 kn, DIAMOND 2,1 kn — ETT eller
// TVÅ sampel var) som inte är kajliggare och inte får fälla grinden. Röd
// KAJVOBBEL kräver därför också att SAMTLIGA sampel låg inom
// QUAY_DEPARTURE_GATE.LEDGER_RADIUS_M från bron — samma radie som
// V1-kajbokföringen (och öppningslagrets egen karta) använder för "vid kaj".
// AKIRA:s hela vobbel låg på 396–410 m; de tre ovan på 1417–1559 m.
const QUAY_BAND_M = QUAY_DEPARTURE_GATE.LEDGER_RADIUS_M;
// Rörelsebeviset i O1:s missklassning är appens (MOORING_DETECTION) — exakt
// den grind BridgeOpeningService._canArm läser via vessel._hasMovementProof.
const MOVE_SOG_KN = MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN;
// Positionsbaserat rörelsebevis för fartgivarlösa (sog === null): samma
// storleksordning som GPS-bruset ×2,5.
const MOVE_POS_M = 50;

const TARGET_BRIDGE_POS = new Map();
for (const b of Object.values(BRIDGES)) {
  if (b && TARGET_BRIDGES.includes(b.name)) TARGET_BRIDGE_POS.set(b.name, b);
}

// ---------------------------------------------------------------------------
// HJÄLPARE
// ---------------------------------------------------------------------------

const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : '?');
const secs = (ms) => `${Math.round(ms / 1000)} s`;
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function distTo(sample, bridgeName) {
  const b = TARGET_BRIDGE_POS.get(bridgeName);
  if (!b || !Number.isFinite(sample.lat) || !Number.isFinite(sample.lon)) return null;
  const d = geometry.calculateDistance(sample.lat, sample.lon, b.lat, b.lon);
  return Number.isFinite(d) ? d : null;
}

/** Läs en jsonl och indexera positionssamples per mmsi (tidsordnat). */
function loadSamples(jsonlPath) {
  const byMmsi = new Map();
  const raw = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
  for (const line of raw) {
    if (!line) continue;
    let s;
    try {
      s = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (s.ctrl || typeof s.lat !== 'number' || typeof s.lon !== 'number') continue;
    const key = String(s.mmsi);
    if (!byMmsi.has(key)) byMmsi.set(key, []);
    byMmsi.get(key).push(s);
  }
  for (const list of byMmsi.values()) list.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  return byMmsi;
}

/** Kör replayRunner mot en jsonl och returnera resultatobjektet. */
function runReplay(jsonlPath, { fusion = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('node', [RUNNER, jsonlPath], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
      env: fusion ? { ...process.env, REPLAY_FUSION: '1' } : process.env,
    }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const m = String(stdout).match(/__REPLAY_JSON__([\s\S]*?)__END__/);
      if (!m) return reject(new Error(`Ingen JSON-markör i replay-output för ${path.basename(jsonlPath)}`));
      let parsed;
      try {
        parsed = JSON.parse(m[1]);
      } catch (e) {
        return reject(new Error(`Trasig replay-JSON för ${path.basename(jsonlPath)}: ${e.message}`));
      }
      return resolve(parsed);
    });
  });
}

/** Enkel promise-pool. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      // eslint-disable-next-line no-await-in-loop
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// O1 — ÖPPNINGSTÄCKNING
// ---------------------------------------------------------------------------

/**
 * Klassificera en MISS mot rådata.
 *
 * Tre ACCEPTERADE klasser (alla mätbara i jsonl:en, ingen av dem en ursäkt):
 *   TYST_I_HORISONTEN     — inget enda sampel inom ARM_MAX_DISTANCE_M före
 *                           passagen. Fartyget var tyst i ALLA källor på hela
 *                           anflygningen; det finns ingen observation att
 *                           beväpna på.
 *   FÖRST_SEDD_FÖR_NÄRA   — första observationen inne i horisonten ligger
 *                           närmare passagen än ledtid + ett tick. Ingen
 *                           varning KAN gå ut med den utlovade marginalen.
 *   RÖRELSEBEVIS_FÖR_SENT — fartyget observerades i tid men låg stilla
 *                           (kajliggarprofil) tills det var för sent för
 *                           marginalen. Beväpningsgrindens rörelsekrav —
 *                           nattens NANNA/SALTYX-klass.
 * Allt annat är OKLASSAD och RÖTT.
 */
function classifyMiss(passage, samples, windowStartMs) {
  const list = (samples.get(String(passage.mmsi)) || [])
    .filter((s) => s.aisTimestamp <= passage.t
      && (windowStartMs === null || s.aisTimestamp > windowStartMs));
  const inHorizon = [];
  for (const s of list) {
    const d = distTo(s, passage.bridge);
    if (d !== null && d <= BRIDGE_OPENING.ARM_MAX_DISTANCE_M) inHorizon.push({ s, d });
  }
  if (inHorizon.length === 0) {
    const nearest = list.reduce((best, s) => {
      const d = distTo(s, passage.bridge);
      return d !== null && (best === null || d < best) ? d : best;
    }, null);
    return {
      klass: 'TYST_I_HORISONTEN',
      accepted: true,
      bevis: `0 sampel inom ${BRIDGE_OPENING.ARM_MAX_DISTANCE_M} m före passagen `
        + `(${list.length} sampel totalt i fönstret, närmast ${nearest === null ? 'okänt' : `${Math.round(nearest)} m`})`,
    };
  }

  const first = inHorizon[0];
  const seenMs = passage.t - first.s.aisTimestamp;
  if (seenMs < MIN_WARNABLE_MS) {
    return {
      klass: 'FÖRST_SEDD_FÖR_NÄRA',
      accepted: true,
      bevis: `första sampel inom horisonten ${iso(first.s.aisTimestamp)} `
        + `(${Math.round(first.d)} m) — endast ${secs(seenMs)} före passagen, `
        + `garantifönstret kräver ${secs(MIN_WARNABLE_MS)}`,
    };
  }

  // SNABBARE ÄN DEADLINE-TAKET. Garantin bygger på att ingen båt gör mer än
  // DEADLINE_MAX_SPEED_KN på anflygningen (dig3: 1798 sampel, MAX veff
  // 9,37 kn ⇒ 0 garantibrott vid CAP=10). Ett fartyg som faktiskt går
  // fortare är utanför den populationen och KAN inte varnas med utlovad
  // marginal — det är fysik, inte bugg. Mätt: 218023240 @ Stridsbergsbron
  // 2026-07-14 gick 2197 m på 210 s = 20,3 kn (sog-rapport 33,2 kn).
  const veffKn = seenMs > 0 ? (first.d / (seenMs / 1000)) / 0.514444 : null;
  if (veffKn !== null && veffKn > BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN) {
    return {
      klass: 'SNABBARE_ÄN_DEADLINE_TAKET',
      accepted: true,
      bevis: `första sampel inom horisonten ${iso(first.s.aisTimestamp)} (${Math.round(first.d)} m) `
        + `→ passage efter ${secs(seenMs)} = effektiv fart ${veffKn.toFixed(1)} kn, över `
        + `deadline-taket ${BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN} kn — garantin kan inte hålla`,
    };
  }

  // Rörelsebeviset: första sampel i horisonten med fart ELLER positionsdelta.
  let moveAt = null;
  let moveWhy = '';
  const origin = first.s;
  for (const { s, d } of inHorizon) {
    const sog = Number.isFinite(s.sog) ? s.sog : null;
    if (sog !== null && sog >= MOVE_SOG_KN) {
      moveAt = s.aisTimestamp;
      moveWhy = `sog=${sog.toFixed(1)} kn vid ${Math.round(d)} m`;
      break;
    }
    const moved = geometry.calculateDistance(origin.lat, origin.lon, s.lat, s.lon);
    if (Number.isFinite(moved) && moved >= MOVE_POS_M) {
      moveAt = s.aisTimestamp;
      moveWhy = `positionsdelta ${Math.round(moved)} m (fartgivarlös) vid ${Math.round(d)} m`;
      break;
    }
  }
  if (moveAt === null || passage.t - moveAt < MIN_WARNABLE_MS) {
    return {
      klass: 'RÖRELSEBEVIS_FÖR_SENT',
      accepted: true,
      bevis: moveAt === null
        ? `inget rörelsebevis alls i horisonten (${inHorizon.length} sampel, alla under `
          + `${MOVE_SOG_KN} kn och inom ${MOVE_POS_M} m) — kajliggarprofil ända fram till passagen`
        : `första rörelsebeviset ${iso(moveAt)} (${moveWhy}) — endast `
          + `${secs(passage.t - moveAt)} före passagen, garantifönstret kräver ${secs(MIN_WARNABLE_MS)}`,
    };
  }

  return {
    klass: 'OKLASSAD',
    accepted: false,
    bevis: `sedd inom horisonten från ${iso(first.s.aisTimestamp)} (${Math.round(first.d)} m, `
      + `${secs(seenMs)} före passagen) och i rörelse från ${iso(moveAt)} (${moveWhy}) — `
      + 'varningen hade kunnat gå ut i tid men uteblev',
  };
}

/**
 * O1 för EN körning. Matchar varje målbropassage mot en varning före den, i
 * resefönstret (mellan föregående passage av samma bro och den här) så att en
 * tur-och-retur-resa inte kan återanvända sin första varning.
 */
function analyseCoverage(result, samples) {
  const passages = [...(result.targetPassages || [])].sort((a, b) => a.t - b.t);
  const warnings = result.openingWarnings || [];
  const coverage = result.openingCoverage || [];
  const prevByKey = new Map();
  const covered = [];
  const misses = [];

  for (const p of passages) {
    const key = `${p.mmsi}:${p.bridge}`;
    const windowStart = prevByKey.has(key) ? prevByKey.get(key) : null;
    prevByKey.set(key, p.t);
    const inWindow = (t) => Number.isFinite(t) && t < p.t && (windowStart === null || t > windowStart);

    // (1) Varningen tog henne som MEDLEM.
    let hit = null;
    let via = null;
    for (const w of warnings) {
      if (w.bridge !== p.bridge || !inWindow(w.t)) continue;
      const members = Array.isArray(w.mmsis) ? w.mmsis : [];
      if (members.includes(String(p.mmsi)) || String(w.leadMmsi) === String(p.mmsi)) {
        if (hit === null || w.t > hit.t) {
          hit = w; via = 'fired';
        }
      }
    }
    // (2) KONVOJTÄCKNING: hon anslöt till en redan avfyrad öppning. Varningen
    //     som täcker henne är den händelsens — ledtiden mäts från DEN.
    //
    //     KONVOJTAKET (etapp 6-granskningen): en absorption fick tidigare
    //     räknas som täckning UTAN tak. Grinden rapporterade därför "FULL
    //     TÄCKNING" för precis den missklass lagret finns för: 211690580
    //     @ Klaffbron 2026-07-10 varnades 10:42:47 och passerade 11:44:04 —
    //     61 minuter senare, med två ANDRA båtars passager emellan, dvs.
    //     bron hade bevisligen öppnat och stängt två gånger utan förvarning.
    //
    //     KRITERIET ÄR EN AVSLUTAD MELLANLIGGANDE ÖPPNING, inte en klocka:
    //     en absorption underkänns om någon ANNAN båt passerat samma bro
    //     efter varningen och mer än CONVOY_WINDOW_MS före den här passagen.
    //     Då har bron bevisligen öppnat och STÄNGT emellan, och varningen
    //     tillhörde den öppningen. En äkta konvoj (passager inom
    //     konvojfönstret) påverkas inte — det är per dig9 samma öppning.
    const otherOpeningBetween = (t) => passages.some((q) => q !== p && q.bridge === p.bridge
      && String(q.mmsi) !== String(p.mmsi)
      && q.t > t && q.t < p.t - BRIDGE_OPENING.CONVOY_WINDOW_MS);
    if (hit === null) {
      for (const c of coverage) {
        if (c.bridge !== p.bridge || String(c.mmsi) !== String(p.mmsi) || !inWindow(c.t)) continue;
        const w = warnings.find((x) => x.eventId === c.eventId);
        if (!w || !inWindow(w.t)) continue;
        if (c.reason === 'absorbed' && otherOpeningBetween(w.t)) continue;
        if (hit === null || w.t > hit.t) {
          hit = w; via = c.reason === 'absorbed' ? 'konvoj' : 'fired';
        }
      }
    }

    if (hit) {
      covered.push({
        passage: p, warning: hit, via, leadMs: p.t - hit.t,
      });
    } else {
      misses.push({ passage: p, ...classifyMiss(p, samples, windowStart) });
    }
  }
  return { passages, covered, misses };
}

/**
 * AVFYRNINGSFÖNSTRET — kontraktets mekanism (c): "avfyra så SENT som garantin
 * tillåter". Servicen skickar med `dueMs` (den tidigaste förfallotiden bland
 * de armar som utlöste); avfyrningen ska alltså ligga i [dueMs, dueMs + ett
 * tick]. Utan den här grinden kunde en regression flytta SAMTLIGA varningar
 * en timme tidigare utan att någon grind rodnade — ledtiden mättes men
 * grindades inte.
 *
 * TOLERANSEN är ett tick-intervall plus en tick till: avfyrningen sker i
 * 30 s-loopen, och ett meddelande som landar mellan två tick förskjuter
 * utvärderingen med upp till ett helt intervall.
 */
const FIRE_WINDOW_SLACK_MS = 2 * BRIDGE_OPENING.TICK_INTERVAL_MS;

function analyseFireWindow(result) {
  const bad = [];
  for (const w of (result.openingWarnings || [])) {
    if (!Number.isFinite(w.dueMs) || !Number.isFinite(w.t)) continue;
    const delta = w.t - w.dueMs;
    if (delta < 0) {
      bad.push({ w, why: `avfyrad ${secs(-delta)} FÖRE sin egen deadline` });
    } else if (delta > FIRE_WINDOW_SLACK_MS) {
      bad.push({ w, why: `avfyrad ${secs(delta)} EFTER sin deadline (tak ${secs(FIRE_WINDOW_SLACK_MS)})` });
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
// O2 — FANTOMTAK
// ---------------------------------------------------------------------------

/**
 * Klassificera en varning som INTE följdes av en passage.
 *
 * ACCEPTERAT (produktprincipen, uttalad av användaren): en båt som gjort en
 * ÄKTA anflygning — under gång, mätbart närmande eller mätbar förflyttning —
 * och sedan stannat, vänt eller tystnat. Det är priset för att aldrig missa en
 * öppning, och användaren har uttryckligen valt det priset.
 * RÖTT: fartyget gjorde aldrig en riktig avgång (kajvobbel), eller varningen
 * vilar inte på ett enda sampel.
 *
 * GLESHETSFÄLLAN, uttrycklig: nettonärmandet är noll så snart fartyget bara
 * levererat ETT fix i fönstret. Därför får ett enskilt fix över appens egen
 * transitgräns (UNDERWAY_SOG_KN) räknas som fullgott rörelsebevis i sig — en
 * båt i 4,6 kn ÄR under gång, hur glest hon än rapporterar.
 */
function approachEvidence(warning, samples) {
  const members = new Set([
    ...(Array.isArray(warning.mmsis) ? warning.mmsis.map(String) : []),
    ...(warning.leadMmsi ? [String(warning.leadMmsi)] : []),
  ]);
  let best = null;
  for (const mmsi of members) {
    const list = (samples.get(mmsi) || []).filter(
      (s) => s.aisTimestamp >= warning.t - APPROACH_LOOKBACK_MS && s.aisTimestamp <= warning.t,
    );
    if (list.length === 0) continue;
    let firstD = null;
    let minD = Infinity;
    let maxD = 0;
    let maxSog = null;
    let maxMove = 0;
    let underwayFixes = 0;
    let inHorizon = 0;
    for (const s of list) {
      const d = distTo(s, warning.bridge);
      if (d === null) continue;
      if (firstD === null) firstD = d;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
      if (d <= BRIDGE_OPENING.ARM_MAX_DISTANCE_M) inHorizon++;
      const sog = Number.isFinite(s.sog) ? s.sog : null;
      if (sog !== null && (maxSog === null || sog > maxSog)) maxSog = sog;
      if (sog !== null && sog >= UNDERWAY_SOG_KN) underwayFixes++;
      const moved = geometry.calculateDistance(list[0].lat, list[0].lon, s.lat, s.lon);
      if (Number.isFinite(moved) && moved > maxMove) maxMove = moved;
    }
    if (firstD === null) continue;
    const cand = {
      mmsi,
      samples: list.length,
      firstD,
      minD,
      maxD,
      net: firstD - minD,
      maxSog,
      maxMove,
      underwayFixes,
      inHorizon,
    };
    // ÄKTA ANFLYGNING kräver (a) att fartyget någon gång varit INNE i
    // beväpningshorisonten — utan det benet accepterade grinden en varning
    // för ett fartyg 12 km bort, dvs. hela regressionsklassen "beväpnar mot
    // fel bro" hade passerat tyst — OCH (b) ett rörelsebevis som håller:
    // mätbart närmande, mätbar förflyttning, IHÅLLANDE fart (V1:s egen
    // konjunktion) eller ett ensamt sampel över den uppmätta medianfarten för
    // äkta anflygningar.
    cand.nearEnough = cand.inHorizon > 0;
    cand.moving = cand.net >= GENUINE_APPROACH_M
      || cand.maxMove >= GENUINE_APPROACH_M
      || cand.underwayFixes >= UNDERWAY_MIN_FIXES
      || (cand.maxSog !== null && cand.maxSog >= UNDERWAY_SOLO_SOG_KN);
    // KAJVOBBELNS TVÅ SIGNATURER (utan rörelsebevis i övrigt):
    //  (a) hon lämnade aldrig kajbandet vid bron, eller
    //  (b) hon nådde aldrig ens appens egen transitgräns — provably stilla.
    // Utan (a) hade grinden fällt en hel klass GLESA men fullt gångna fartyg
    // 1,4–1,6 km ut (IDUN 2,2 kn, LAMANTIJN 2,9 kn, DIAMOND 2,1 kn — ETT
    // eller TVÅ sampel var). Utan (b) hade en båt som ligger still 800 m ut i
    // 30 sampel à 0,2 kn sluppit igenom bara för att hon låg utanför bandet.
    cand.atQuay = cand.maxD <= QUAY_BAND_M;
    cand.stationary = cand.maxSog !== null && cand.maxSog < UNDERWAY_SOG_KN;
    cand.genuine = cand.nearEnough
      && (cand.moving || !(cand.atQuay || cand.stationary));
    // Bästa kandidat = den som starkast bevisar en äkta anflygning.
    if (best === null || (cand.genuine && !best.genuine)
      || (cand.genuine === best.genuine && cand.net > best.net)) best = cand;
  }
  if (best !== null) best.members = [...members];
  return best;
}

function classifyPhantom(warning, samples) {
  const best = approachEvidence(warning, samples);
  if (best === null) {
    return {
      klass: 'INGA_SAMPEL_FÖRE',
      accepted: false,
      bevis: 'ingen av varningens medlemmar har ett enda sampel i '
        + `${mins(APPROACH_LOOKBACK_MS)} före varningen — varningen vilar på ingenting`,
    };
  }
  const bevis = `${best.mmsi}: ${best.samples} sampel (${best.inHorizon} inom `
    + `${BRIDGE_OPENING.ARM_MAX_DISTANCE_M} m), avstånd ${Math.round(best.firstD)}→`
    + `${Math.round(best.minD)} m (netto-närmande ${Math.round(best.net)} m), `
    + `maxfart ${best.maxSog === null ? 'okänd (fartgivarlös)' : `${best.maxSog.toFixed(1)} kn`}, `
    + `${best.underwayFixes} fix ≥${UNDERWAY_SOG_KN} kn, `
    + `positionsförflyttning ${Math.round(best.maxMove)} m, `
    + `${best.atQuay ? `HELA fönstret inom kajbandet ${QUAY_BAND_M} m` : `ute i farleden (max ${Math.round(best.maxD)} m)`}`;

  if (!best.nearEnough) return { klass: 'UTANFÖR_HORISONTEN', accepted: false, bevis };
  if (!best.moving && (best.atQuay || best.stationary)) {
    return { klass: 'KAJVOBBEL', accepted: false, bevis };
  }
  // GLES men bevisligen ute i farleden och under gång: BRANIF-klassen
  // (ETT fix på 78 minuter). Glesheten är verklig, inte stillastående.
  if (!best.moving) return { klass: 'GLES_ANFLYGNING', accepted: true, bevis };
  return { klass: 'AVBRUTEN_APPROACH', accepted: true, bevis };
}

/**
 * O2:s TREDJE hink — varningen följdes av en passage, men SENARE än
 * kontraktets 20 minuter. Kontraktet kräver att varje varning utan passage
 * inom 20 min klassas MOT RÅDATA; tidigare bara RÄKNADES de här, vilket
 * gjorde att 83 av 236 varningar (35 %) helt undgick kravet och att en
 * regression som fyrar allt en timme för tidigt bara hade flyttat rader
 * mellan hinkarna.
 *
 * PASSAGEN SJÄLV bevisar rörelsebenet (hon kom ju fram) — kajvobbel är därför
 * per definition uteslutet här. Kvar att pröva är NÄRHETSBENET (var hon
 * någonsin inne i beväpningshorisonten?) och VARFÖR varningen låg tidigt:
 *   GARANTIPRIS  — den effektiva anflygningsfarten var lägre än deadline-
 *                  motorns pessimistiska tak, dvs. tidigheten ÄR garantin.
 *   VÄNTAN_VID_BRO — hon nådde väntzonen och stod still tills bron öppnade.
 * Allt annat är OFÖRKLARAD_TIDIGHET och RÖTT.
 */
function classifyLatePassage(warning, passage, samples) {
  const best = approachEvidence(warning, samples);
  if (best === null) {
    return {
      klass: 'INGA_SAMPEL_FÖRE',
      accepted: false,
      bevis: 'ingen medlem har ett enda sampel före varningen — varningen vilar på ingenting',
    };
  }
  const bevisBas = `${best.mmsi}: ${best.samples} sampel (${best.inHorizon} inom `
    + `${BRIDGE_OPENING.ARM_MAX_DISTANCE_M} m), närmast ${Math.round(best.minD)} m vid varningen`;
  if (!best.nearEnough) {
    return { klass: 'UTANFÖR_HORISONTEN', accepted: false, bevis: bevisBas };
  }

  // Effektiv anflygningsfart mellan varning och passage, mätt på det avstånd
  // fartyget faktiskt hade när varningen gick ut.
  const dist = Number.isFinite(warning.distance) ? warning.distance : best.minD;
  const travelS = (passage.t - warning.t) / 1000;
  const veffKn = travelS > 0 ? (dist / travelS) / 0.514444 : null;
  if (veffKn !== null && veffKn < BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN) {
    return {
      klass: 'GARANTIPRIS',
      accepted: true,
      bevis: `${bevisBas}; d=${Math.round(dist)} m → passage efter ${mins(passage.t - warning.t)} `
        + `= effektiv fart ${veffKn.toFixed(2)} kn < deadline-taket `
        + `${BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN} kn — tidigheten ÄR garantin`,
    };
  }
  // Väntan vid bron: sista sampel före varningen låg innanför väntzonen.
  if (best.minD <= BRIDGE_OPENING.DISARM_MOORED_MIN_DISTANCE_M) {
    return {
      klass: 'VÄNTAN_VID_BRO',
      accepted: true,
      bevis: `${bevisBas} — inne i väntzonen (≤${BRIDGE_OPENING.DISARM_MOORED_MIN_DISTANCE_M} m), `
        + `passage efter ${mins(passage.t - warning.t)}`,
    };
  }
  return {
    klass: 'OFÖRKLARAD_TIDIGHET',
    accepted: false,
    bevis: `${bevisBas}; d=${Math.round(dist)} m → passage efter ${mins(passage.t - warning.t)} `
      + `= effektiv fart ${veffKn === null ? 'okänd' : `${veffKn.toFixed(2)} kn`}, `
      + 'dvs. varningen låg tidigare än både deadline-fysiken och väntan förklarar',
  };
}

/**
 * O2 för EN körning. Tre utfall per varning:
 *   BEKRÄFTAD    — passage av bron inom PHANTOM_WINDOW_MS (kontraktets 20 min)
 *   SEN_PASSAGE  — passage inom LATE_PASSAGE_WINDOW_MS; öppningen KOM, men
 *                  varningen låg tidigare än kontraktsfönstret. Rapporteras
 *                  med fördröjning så tidigheten kan granskas.
 *   FANTOM       — ingen passage alls; klassas mot rådata.
 */
function analysePhantoms(result, samples) {
  const warnings = result.openingWarnings || [];
  const targetP = result.targetPassages || [];
  const interP = result.intermediatePassages || [];
  const phantoms = [];
  const latePassages = [];
  let confirmed = 0;
  for (const w of warnings) {
    const members = new Set([
      ...(Array.isArray(w.mmsis) ? w.mmsis.map(String) : []),
      ...(w.leadMmsi ? [String(w.leadMmsi)] : []),
    ]);
    // Konvojtäckta båtar som anslöt EFTER avfyrningen hör också till öppningen.
    for (const c of (result.openingCoverage || [])) {
      if (c.eventId === w.eventId) members.add(String(c.mmsi));
    }
    // En målbrokorsning som bokförts som INTERMEDIATE (mållös båt,
    // U-svängskorrigerad resa) är fortfarande en verklig broöppning — INV-13:s
    // klass. Räkna den, annars blir designenliga förlopp falska fantomer.
    const after = [...targetP, ...interP]
      .filter((p) => p.bridge === w.bridge && members.has(String(p.mmsi)) && p.t >= w.t)
      .sort((a, b) => a.t - b.t);
    const first = after[0];
    if (first && first.t - w.t <= PHANTOM_WINDOW_MS) {
      confirmed++;
    } else if (first && first.t - w.t <= LATE_PASSAGE_WINDOW_MS) {
      latePassages.push({
        warning: w,
        passage: first,
        delayMs: first.t - w.t,
        ...classifyLatePassage(w, first, samples),
      });
    } else {
      phantoms.push({ warning: w, ...classifyPhantom(w, samples) });
    }
  }
  return { confirmed, latePassages, phantoms };
}

// ---------------------------------------------------------------------------
// KÖRNINGSPLAN
// ---------------------------------------------------------------------------

const JOB_LIST = [
  ...corpora.map((c) => ({
    id: c.id, jsonl: c.jsonl, fusion: false, hours: c.hours,
  })),
  // Korpus 16: A/B-nattens B-arm (äkta AISHub + aisstream). Körs i FUSIONS-
  // läge — det är den enda korpus där andrakällan faktiskt accepteras, och
  // öppningslagret måste bevisas i just den kedjan.
  {
    id: '20260803-natt (fusion)', jsonl: NIGHT_FUSION, fusion: true, hours: 9,
  },
];

async function main() {
  const missingNight = [NIGHT_FUSION, NIGHT_AISSTREAM, FIELD_NOTIF, FIELD_TEXTS, GT_PASSAGES]
    .filter((p) => !fs.existsSync(p));
  const jobs = JOB_LIST.filter((j) => fs.existsSync(j.jsonl));

  console.log('=== ÖPPNINGSGRINDARNA (etapp 6) ===');
  console.log(`${jobs.length} korpusar, ${JOBS} parallella körningar\n`);
  if (missingNight.length) {
    // HÅRT FEL, inte tyst överhopp: en saknad facitfil gör O3 vakuös, och en
    // vakuös grind som rapporterar grönt är farligare än ingen grind alls
    // (R2-1-lärdomen från fördelningsfacit).
    console.log(`❌ Nattkontrollens filer saknas: ${missingNight.map((p) => path.basename(p)).join(', ')}`);
    console.log('   Filerna ska ligga i tests/replay-validation/night-facit/ + corpora-data/.\n');
  }

  const runs = await mapPool(jobs, JOBS, async (job) => {
    try {
      const result = await runReplay(job.jsonl, { fusion: job.fusion });
      return { job, result };
    } catch (err) {
      return { job, error: String(err.message || err).slice(0, 200) };
    }
  });

  let failed = false;

  // ---- O1 ----------------------------------------------------------------
  console.log('--- O1: ÖPPNINGSTÄCKNING (varje målbropassage ska ha en varning FÖRE) ---\n');
  const o1Rows = [];
  const allLeads = [];
  const missByClass = new Map();
  let totalPassages = 0;
  let totalCovered = 0;
  let thinLeads = 0;

  for (const run of runs) {
    if (run.error) {
      failed = true;
      o1Rows.push({ id: run.job.id, status: '💥 KRASCH', detail: run.error });
      continue;
    }
    const samples = loadSamples(run.job.jsonl);
    const { passages, covered, misses } = analyseCoverage(run.result, samples);
    run.analysis = { covered, misses, samples };
    totalPassages += passages.length;
    totalCovered += covered.length;
    const leads = covered.map((c) => c.leadMs);
    allLeads.push(...leads);
    const unclassified = misses.filter((m) => !m.accepted);
    if (unclassified.length) failed = true;
    for (const m of misses) missByClass.set(m.klass, (missByClass.get(m.klass) || 0) + 1);

    const byFired = (run.result.openingWarnings || []).reduce((acc, w) => {
      acc[w.firedBy || 'okänd'] = (acc[w.firedBy || 'okänd'] || 0) + 1;
      return acc;
    }, {});
    // LEVERANSKONTROLL: servicen avfyrade N gånger, kortet fick M. Skillnaden
    // är alltid en bugg i app.js avfyrningsväg (dedup som spärrar fel, saknat
    // kort, kastande tokenbygge) — och den är osynlig för både täcknings- och
    // fantomanalysen, som bara ser det kortet fick.
    const fires = run.result.openingServiceFires;
    const delivered = (run.result.openingWarnings || []).length;
    if (Number.isFinite(fires) && fires !== delivered) {
      failed = true;
      console.log(`  ❌ ÖPPNINGSLEVERANS ${run.job.id}: servicen avfyrade ${fires} men kortet fick ${delivered}`);
    }
    // Armarna får aldrig överleva efterspelet (ARM_STALE_TTL 30 min < 40 min).
    const leaks = run.result.leakDiagnostics || {};
    if (Number.isFinite(leaks.openingArms) && leaks.openingArms !== 0) {
      failed = true;
      console.log(`  ❌ ÖPPNINGSLÄCKA ${run.job.id}: ${leaks.openingArms} armar kvar efter efterspelet`);
    }
    const badWarnings = (run.result.openingWarnings || []).filter((w) => w.success === false);
    if (badWarnings.length) {
      failed = true;
      console.log(`  ❌ ÖPPNINGSVARNING KASTADE ${run.job.id}: ${badWarnings[0].error}`);
    }
    // AVFYRNINGSFÖNSTRET: mekanism (c) — "avfyra så SENT som garantin tillåter".
    const badFire = analyseFireWindow(run.result);
    if (badFire.length) {
      failed = true;
      for (const b of badFire) {
        console.log(`  ❌ AVFYRNINGSFÖNSTER ${run.job.id}: ${b.w.bridge} ${b.w.iso} `
          + `(${b.w.eventId}) — ${b.why}`);
      }
    }
    // LEDTIDSGOLVET. Utan det räknades en varning med NOLL sekunders
    // förvarning som "varnad i tid" (ELFKUNGEN @ Stridsbergsbron 2026-07-03:
    // varning och passage i samma millisekund), och en regression som
    // kollapsade hela ledtidsfördelningen hade passerat tyst.
    //  - FATALT golv = 2 tick (60 s): den grövsta upplösning en tick-driven
    //    motor kan lova. Under den är varningen funktionellt värdelös.
    //  - RAPPORTERAT golv = utlovad ledtid − 1 tick (150 s): under den är
    //    varningen tunn men verksam, och orsaken är alltid att armen såg
    //    fartyget sent (O1:s egna missklasser mäter samma sak).
    const leadHardFloorMs = 2 * BRIDGE_OPENING.TICK_INTERVAL_MS;
    const leadPromiseMs = BRIDGE_OPENING.WARNING_LEAD_MS - BRIDGE_OPENING.TICK_INTERVAL_MS;
    const tooLate = covered.filter((c) => c.leadMs < leadHardFloorMs);
    const thin = covered.filter((c) => c.leadMs >= leadHardFloorMs && c.leadMs < leadPromiseMs);
    if (tooLate.length) {
      failed = true;
      for (const c of tooLate) {
        console.log(`  ❌ LEDTIDSGOLV ${run.job.id}: ${c.passage.mmsi} @ ${c.passage.bridge} `
          + `${c.passage.iso} varnades bara ${secs(c.leadMs)} före (hårt golv ${secs(leadHardFloorMs)})`);
      }
    }
    for (const c of thin) {
      console.log(`  ⚠️ TUNN LEDTID ${run.job.id}: ${c.passage.mmsi} @ ${c.passage.bridge} `
        + `${c.passage.iso} varnades ${secs(c.leadMs)} före (utlovat ${secs(leadPromiseMs)})`);
    }
    thinLeads += thin.length;
    const convoyCovered = covered.filter((c) => c.via === 'konvoj').length;

    let o1Status = '✅ FULL TÄCKNING';
    if (unclassified.length) o1Status = '❌ OKLASSAD MISS';
    else if (misses.length) o1Status = '⚠️ KLASSAD MISS';
    o1Rows.push({
      id: run.job.id,
      status: o1Status,
      detail: `${covered.length}/${passages.length} passager varnade`
        + `${convoyCovered ? ` (varav ${convoyCovered} via konvoj)` : ''}`
        + `, ledtid median ${leads.length ? mins(median(leads)) : '—'} / min ${leads.length ? mins(Math.min(...leads)) : '—'}`
        + `, varningar=${(run.result.openingWarnings || []).length}`
        + ` (fix ${byFired.fix || 0} / deadline ${byFired.deadline || 0})`,
    });

    for (const m of misses) {
      const tag = m.accepted ? 'ℹ️ KLASSAD MISS ' : '❌ OKLASSAD MISS';
      console.log(`  ${tag} ${run.job.id} — ${m.passage.mmsi} @ ${m.passage.bridge} ${m.passage.iso}`);
      console.log(`      klass: ${m.klass}`);
      console.log(`      bevis: ${m.bevis}`);
    }
  }
  for (const r of o1Rows) console.log(`  ${r.status.padEnd(18)} ${r.id.padEnd(26)} ${r.detail}`);
  console.log('');
  console.log(`  SUMMA: ${totalCovered}/${totalPassages} målbropassager varnade i tid `
    + `(${totalPassages ? ((100 * totalCovered) / totalPassages).toFixed(1) : '0'} %)`);
  if (allLeads.length) {
    const sorted = [...allLeads].sort((a, b) => a - b);
    console.log(`  LEDTID: median ${mins(median(allLeads))}, min ${mins(sorted[0])}, `
      + `p10 ${mins(sorted[Math.floor(sorted.length * 0.1)])}, max ${mins(sorted[sorted.length - 1])}`
      + `${thinLeads ? ` — ${thinLeads} tunna (< utlovad ledtid)` : ''}`);
  }
  if (missByClass.size) {
    console.log(`  MISSKLASSER: ${[...missByClass].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log('');

  // ---- O2 ----------------------------------------------------------------
  console.log('--- O2: FANTOMTAK (varning utan passage klassas mot rådata) ---\n');
  const o2Rows = [];
  let totalWarnings = 0;
  let totalConfirmed = 0;
  let totalLate = 0;
  const allDelays = [];
  const phantomByClass = new Map();

  for (const run of runs) {
    if (run.error) continue;
    const { confirmed, latePassages, phantoms } = analysePhantoms(run.result, run.analysis.samples);
    const warnings = (run.result.openingWarnings || []).length;
    totalWarnings += warnings;
    totalConfirmed += confirmed;
    totalLate += latePassages.length;
    for (const l of latePassages) allDelays.push(l.delayMs);
    const red = phantoms.filter((p) => !p.accepted);
    const redLate = latePassages.filter((l) => !l.accepted);
    if (red.length || redLate.length) failed = true;
    for (const p of phantoms) phantomByClass.set(p.klass, (phantomByClass.get(p.klass) || 0) + 1);
    for (const l of latePassages) phantomByClass.set(l.klass, (phantomByClass.get(l.klass) || 0) + 1);

    let o2Status = '✅ INGA FANTOMER';
    if (red.length || redLate.length) o2Status = '❌ RÖD FANTOM';
    else if (phantoms.length) o2Status = '⚠️ ACCEPTERADE';
    o2Rows.push({
      id: run.job.id,
      status: o2Status,
      detail: `${confirmed} bekräftade ≤20 min, ${latePassages.length} sena passager `
        + `(${redLate.length} röda), ${phantoms.length} utan passage (${red.length} röda) `
        + `av ${warnings} varningar`,
    });
    for (const p of phantoms) {
      const tag = p.accepted ? 'ℹ️ ACCEPTERAD  ' : '❌ RÖD FANTOM  ';
      console.log(`  ${tag} ${run.job.id} — ${p.warning.bridge} ${p.warning.iso} `
        + `(ledande ${p.warning.leadVessel}/${p.warning.leadMmsi}, d=${p.warning.distance} m, ${p.warning.firedBy})`);
      console.log(`      klass: ${p.klass}`);
      console.log(`      bevis: ${p.bevis}`);
    }
    // SENA PASSAGER klassas nu MOT RÅDATA (kontraktets O2). Bara de RÖDA
    // skrivs ut i sin helhet; de accepterade summeras i klasstabellen.
    for (const l of redLate) {
      console.log(`  ❌ RÖD SEN     ${run.job.id} — ${l.warning.bridge} ${l.warning.iso} `
        + `(ledande ${l.warning.leadVessel}/${l.warning.leadMmsi}, d=${l.warning.distance} m, ${l.warning.firedBy})`);
      console.log(`      klass: ${l.klass} (passage efter ${mins(l.delayMs)})`);
      console.log(`      bevis: ${l.bevis}`);
    }
  }
  for (const r of o2Rows) console.log(`  ${r.status.padEnd(18)} ${r.id.padEnd(26)} ${r.detail}`);
  console.log('');
  console.log(`  SUMMA: ${totalConfirmed}/${totalWarnings} varningar bekräftade inom 20 min, `
    + `${totalLate} bekräftade senare (öppningen kom, varningen var tidig)`);
  if (allDelays.length) {
    const sorted = [...allDelays].sort((a, b) => a - b);
    console.log(`  SENA PASSAGER: median ${mins(median(allDelays))}, max ${mins(sorted[sorted.length - 1])} `
      + '— deadline-motorns pessimism (10 kn mot uppmätt median 3,13 kn) ligger bakom');
  }
  if (phantomByClass.size) {
    console.log(`  FANTOMKLASSER: ${[...phantomByClass].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log('');

  // ---- O3 ----------------------------------------------------------------
  if (missingNight.length > 0) {
    failed = true;
  } else {
    console.log('--- O3: NATTKONTROLLEN (A/B-nattens två armar) ---\n');
    const problems = await checkNight(runs);
    if (problems.length) {
      failed = true;
      for (const p of problems) console.log(`  ❌ ${p}`);
    } else {
      console.log('  ✅ Nattkontrakten hålls: 6/6 öppningar varnade före, konvojen som EN varning, '
        + '0 varningar ur kajliggarna, boat_near oförändrad, A-armen identisk med facit.');
    }
    console.log('');
  }

  if (failed) {
    console.log('❌ ÖPPNINGSGRINDARNA RÖDA — se klassningarna ovan.');
    process.exit(1);
  }
  console.log('✅ Öppningsgrindarna gröna: full klassad täckning, inga kajvobbel-fantomer, natten intakt.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// O3 — NATTKONTROLLEN
// ---------------------------------------------------------------------------

// Nattens SEX öppningar som MÅSTE ha förvarnats, med sanna passagetider ur
// gt-passages.json (oberoende facit, framtaget ur rådatan 2026-08-03).
// NANNA:s Klaffbron-öppning 05:55:36 saknas MEDVETET i listan: hennes avgång
// var tyst-från-start (kajavgång utan rörelsebevis inne i horisonten) och
// klassas av O1 — se rapporten. Konvojen SALTYX+JUNO vid Klaffbron ska ge
// EXAKT EN varning, inte en per båt.
const NIGHT_REQUIRED_OPENINGS = [
  { mmsi: '212571000', name: 'TIM', bridge: 'Klaffbron' },
  { mmsi: '212571000', name: 'TIM', bridge: 'Stridsbergsbron' },
  { mmsi: '231907000', name: 'TIDAN', bridge: 'Klaffbron' },
  { mmsi: '231907000', name: 'TIDAN', bridge: 'Stridsbergsbron' },
  { mmsi: '265576720', name: 'JUNO', bridge: 'Stridsbergsbron' },
  { mmsi: '265576720', name: 'JUNO', bridge: 'Klaffbron' },
];
// Morgonkonvojens fönster vid Klaffbron: NANNA 05:55, SALTYX 06:09, JUNO
// 06:11. Kravet "EN varning per förestående öppning" mäts här.
const CONVOY_WINDOW = { from: Date.UTC(2026, 7, 3, 5, 30), to: Date.UTC(2026, 7, 3, 6, 30) };

async function checkNight(runs) {
  const problems = [];
  const gt = JSON.parse(fs.readFileSync(GT_PASSAGES, 'utf8'));
  const movers = new Set(gt.map((g) => String(g.mmsi)));

  // ---- B-armen (fusion) — redan körd som korpus 16 -----------------------
  const bRun = runs.find((r) => r.job.jsonl === NIGHT_FUSION);
  if (!bRun || bRun.error) {
    problems.push(`B-armen kunde inte köras: ${bRun ? bRun.error : 'körning saknas'}`);
    return problems;
  }
  const b = bRun.result;
  const warnings = b.openingWarnings || [];

  // (1) Sex öppningar varnade FÖRE den SANNA passagetiden.
  for (const req of NIGHT_REQUIRED_OPENINGS) {
    const truth = gt.find((g) => String(g.mmsi) === req.mmsi && g.bridge === req.bridge);
    if (!truth) {
      problems.push(`gt-passages.json saknar ${req.name} @ ${req.bridge} — facit kan inte prövas`);
      continue;
    }
    const covering = warnings.filter((w) => w.bridge === req.bridge && w.t < truth.t
      && (w.mmsis.includes(req.mmsi) || String(w.leadMmsi) === req.mmsi
        || (b.openingCoverage || []).some((c) => c.eventId === w.eventId && String(c.mmsi) === req.mmsi)));
    if (covering.length === 0) {
      problems.push(`ÖPPNING OVARNAD: ${req.name} @ ${req.bridge} (sann passage ${iso(truth.t)}) — `
        + `varningar för bron: [${warnings.filter((w) => w.bridge === req.bridge).map((w) => w.iso).join(', ') || 'inga'}]`);
    } else {
      const last = covering[covering.length - 1];
      console.log(`  ✅ ${req.name.padEnd(6)} @ ${req.bridge.padEnd(16)} varnad ${last.iso} `
        + `— ${mins(truth.t - last.t)} före sann passage ${iso(truth.t)} (${last.firedBy}, eta=${last.etaMin} min)`);
    }
  }

  // (2) Konvojen vid Klaffbron = EN varning.
  const convoy = warnings.filter((w) => w.bridge === 'Klaffbron'
    && w.t >= CONVOY_WINDOW.from && w.t <= CONVOY_WINDOW.to);
  if (convoy.length !== 1) {
    problems.push(`KONVOJEN: ${convoy.length} Klaffbron-varningar i fönstret `
      + `${iso(CONVOY_WINDOW.from)}–${iso(CONVOY_WINDOW.to)} (ska vara EXAKT 1): `
      + `[${convoy.map((w) => `${w.iso}/${w.leadVessel}`).join(', ')}]`);
  } else {
    console.log(`  ✅ Konvojen @ Klaffbron: EN varning ${convoy[0].iso} (ledande ${convoy[0].leadVessel}) `
      + 'täcker hela öppningen 06:09–06:13');
  }

  // (3) Noll varningar ur kajliggarna. Nattens rörliga båtar är exakt de som
  //     har en passage i gt-passages.json; alla andra låg vid kaj.
  for (const w of warnings) {
    const members = new Set([...(w.mmsis || []).map(String), String(w.leadMmsi)]);
    const quayOnly = [...members].filter((m) => m && m !== 'null' && !movers.has(m));
    if (quayOnly.length) {
      problems.push(`KAJLIGGARE VARNAD: ${w.bridge} ${w.iso} innehåller ${quayOnly.join(', ')} `
        + '(ingen passage i nattens rådatafacit)');
    }
  }

  // (4) boat_near-dimensionen OFÖRÄNDRAD: 24 notiser, 0 dubbletter, 0 fantomer.
  const keys = (b.notifications || []).map((n) => `${n.mmsi}|${n.bridge}`);
  const FIELD_EXPECTED = 24;
  if (keys.length !== FIELD_EXPECTED) {
    problems.push(`B-ARMENS NOTISER: ${keys.length} ≠ ${FIELD_EXPECTED} (öppningslagret ska vara helt additivt)`);
  }
  const dupes = [...keys.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map())]
    .filter(([, c]) => c > 1);
  if (dupes.length) problems.push(`B-ARMENS DUBBLETTER: ${dupes.map(([k, c]) => `${k}×${c}`).join(', ')}`);
  const phantomNotifs = keys.filter((k) => !movers.has(k.split('|')[0]));
  if (phantomNotifs.length) problems.push(`B-ARMENS FANTOMNOTISER: ${phantomNotifs.join(', ')}`);
  if ((b.processErrors || 0) > 0) problems.push(`B-armen: ${b.processErrors} processfel`);

  // ---- A-armen (enbart aisstream) — byte-identisk med nattens facit -------
  let a;
  try {
    a = await runReplay(NIGHT_AISSTREAM, { fusion: false });
  } catch (err) {
    problems.push(`A-armen kunde inte köras: ${String(err.message || err).slice(0, 160)}`);
    return problems;
  }
  const expectedNotif = fs.readFileSync(FIELD_NOTIF, 'utf8').trim().split('\n').filter(Boolean);
  const actualNotif = (a.notifications || []).map((n) => `${n.mmsi}|${n.bridge}|${n.distance}`);
  // MULTISET, inte ordning: två notiser som avfyras i SAMMA fake-millisekund
  // (t.ex. current + passage-fallback för samma båt) har ingen kanonisk
  // inbördes ordning — nattens facitfil ordnar dem olika för olika fartyg.
  const sortJoin = (arr) => [...arr].sort().join('\n');
  if (actualNotif.length !== expectedNotif.length || sortJoin(actualNotif) !== sortJoin(expectedNotif)) {
    const a2 = new Set(actualNotif);
    const e2 = new Set(expectedNotif);
    problems.push(`A-ARMENS NOTISFACIT AVVIKER (${actualNotif.length} vs ${expectedNotif.length}): `
      + `saknas=[${expectedNotif.filter((k) => !a2.has(k)).join(', ')}] `
      + `extra=[${actualNotif.filter((k) => !e2.has(k)).join(', ')}]`);
  }
  const expectedTexts = fs.readFileSync(FIELD_TEXTS, 'utf8').trim().split('\n');
  const actualTexts = (a.bridgeTextTransitions || []).map((t) => t.text);
  if (actualTexts.length !== expectedTexts.length) {
    problems.push(`A-ARMENS TEXTFACIT: ${actualTexts.length} övergångar ≠ ${expectedTexts.length}`);
  } else {
    const diff = actualTexts.findIndex((t, i) => t !== expectedTexts[i]);
    if (diff !== -1) {
      problems.push(`A-ARMENS TEXTFACIT AVVIKER vid index ${diff}: fick "${actualTexts[diff]}" `
        + `väntade "${expectedTexts[diff]}"`);
    }
  }
  if ((a.processErrors || 0) > 0) problems.push(`A-armen: ${a.processErrors} processfel`);
  if (problems.length === 0) {
    console.log(`  ✅ A-armen: ${actualNotif.length} notiser + ${actualTexts.length} texter ordagrant enligt nattens facit`);
    console.log(`  ✅ B-armen: ${keys.length} notiser, 0 dubbletter, 0 fantomer — boat_near helt oförändrad`);
  }
  return problems;
}

// KÖRS SOM SKRIPT — men KLASSIFICERARNA exporteras också, så domarlogiken kan
// enhetstestas direkt (samma princip som replay-invariants-unit.test.js: en
// tyst trasig domare ser ut som "allt grönt"). Utan require.main-vakten hade
// varje `require` av filen dragit igång alla 16 korpuskörningar.
if (require.main === module) {
  main().catch((err) => {
    console.error(`💥 Öppningsgrindarna kraschade: ${err.stack || err.message || err}`);
    process.exit(1);
  });
}

module.exports = {
  classifyMiss,
  classifyPhantom,
  classifyLatePassage,
  approachEvidence,
  analyseCoverage,
  analysePhantoms,
  analyseFireWindow,
  loadSamples,
  MIN_WARNABLE_MS,
  PHANTOM_WINDOW_MS,
  LATE_PASSAGE_WINDOW_MS,
  GENUINE_APPROACH_M,
  UNDERWAY_SOG_KN,
  UNDERWAY_MIN_FIXES,
  UNDERWAY_SOLO_SOG_KN,
  FIRE_WINDOW_SLACK_MS,
};
