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
const { openingDeliveryFailures } = require('./openingDelivery');
const corpora = require('./corpora');
const {
  BRIDGES, TARGET_BRIDGES, BRIDGE_OPENING, MOORING_DETECTION, QUAY_DEPARTURE_GATE,
} = require('../../lib/constants');
const geometry = require('../../lib/utils/geometry');
const { isNorthCog, isSouthCogStrict } = require('../../lib/utils/cogDirection');
const { beforeBridge } = require('../../lib/utils/bridgeQueue');
// M2 (helkodsgranskning RUNDA 4, 2026-08-23): SAMMA modul som produktionens
// kajgrind i app.js använder. Grinden hade en EGEN kopia av regeln och ärvde
// därmed exakt den defekt den skulle upptäcka — replay:openings kunde
// strukturellt inte se felmoden "ett brusigt sog-värde öppnar hela skyddet".
const {
  isCorroboratedTransit, MAX_PREV_FIX_AGE_MS, KN_TO_MPS,
} = require('../../lib/utils/quayTransitProof');
// Granskning 4c: TVÅ knopomräkningar, MEDVETET. KN_TO_MPS (0,5144) är modulens —
// används BARA i korroboreringsledet så grinden speglar quayTransitProof exakt.
// Deadline-jämförelserna mot BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN (rörelsebevisets
// effektivfart och O2:s GARANTIPRIS) ska i stället spegla BridgeOpeningService,
// som räknar med SI-talet 0,514444. Skillnaden är 0,0086 % och mätt utslag 0 —
// men de två ställena ska inte kunna glida var för sig.
const KN_TO_MPS_BOS = 0.514444;
const { loadGtPassages } = require('./makeGtPassages');
const { loadAdditionalPassageEvidence } = require('./loadPassageEvidence');

const RUNNER = path.join(__dirname, 'replayRunner.js');

// A/B-NATTENS FILER LIGGER I REPOT (samma princip som ChatGPT-granskningens
// B3-beslut om korpusdatan): en grind som bara fungerar i den session där
// arbetet gjordes är ingen grind. Filerna är byte-identiska kopior av
// A/B-nattens original — night-fusion.jsonl ÄR redan
// corpora-data/ais-fusion-20260803-nattkorning.jsonl (samma sha256).
// OPENING_AB_DIR pekar om hela uppsättningen för felsökning mot originalen.
//
// ── C0-OMBASERINGEN 2026-08-10 (night-facit/, 4 värden) ────────────────────
// .txt-facitfilerna kan inte bära kommentarer, så noten står här — i den enda
// fil som läser dem. C0 flyttade Stallbackabron till den verifierade
// konsensuspunkten (58.309802/12.316748, gap 2226; se BRIDGES.stallbackabron).
// Nattens A-arm bär därför FYRA omräknade värden, alla rådataverifierade mot
// ais-aisstream-20260803-nattkorning.jsonl och alla MER korrekta än förut.
// Multiseten (mmsi, bro) är BYTE-IDENTISKA: 22 notiser före som efter, inga
// tillkomna, inga borta — det är enbart avståndsfältet och två ETA-minuter
// som rört sig.
//   field-notif.txt (avståndsfältet mäts mot bropunkten och kan inte överleva
//   en punktflytt):
//     • 231907000|Stallbackabron 276 → 193. Fartygets position i notisticket
//       är 58.30847/12.31463; haversine till konsensuspunkten = 192,7 m.
//       (Mot den gamla punkten låg samma position på 329 m, dvs. UTANFÖR
//       300 m-ringen — notisen fyrade förr på ett senare sampel.)
//     • 265576720|Stallbackabron 218 → 190. Position 58.31131/12.31829,
//       haversine till konsensuspunkten = 190,1 m.
//   field-texts.txt (progressiv ETA läser BÅDE bropunkten och gapet; samma
//   klass som de 14 omlåsta golden-texterna, index 37–38 av 45 — antalet
//   övergångar är oförändrat och ingen annan rad rör sig):
//     • 05:54:47 "om 9 minuter" → "om 8". JUNO (265576720) 190 m från
//       Stallbackabron i 9,4 kn (4,836 m/s): 190/4,836 + 2226/4,836 = 499,6 s
//       = 8,3 min. Gamla kedjan räknade 218/4,836 + 2310/4,836 = 522,7 s
//       = 8,7 min → 9. Kontroll mot fysiken: fågelvägen till Stridsbergsbron
//       är 2 415 m, dvs. 8,3 min i den farten — den NYA siffran är den sanna.
//     • 05:56:38 "om 8 minuter" → "om 7". Samma fartyg 30 s senare, 2 022 m
//       från Stridsbergsbron i 9,7 kn = 6,8 min → 7. Gamla värdet var
//       pessimistiskt av exakt samma två skäl (fel bropunkt + för långt gap).
const AB_DIR = process.env.OPENING_AB_DIR || null;
const NIGHT_DIR = path.join(__dirname, 'night-facit');
// Omlåst 2026-09-12: JUNOs sista rena fix 06:05:18.716 ligger före
// Järnvägsbron. Efter fem minuters tystnad visas ETA okänd vid Klaffbron
// direkt, utan den gamla extrapolerade mellanraden "om cirka 2 minuter".
// Övriga texter och nattens samtliga närnotiser är oförändrade.
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
// Två sådana fartvärden behöver dessutom samma mätbara nettoavgång
// som kajgrinden (NET_APPROACH_M); upprepade brusvärden är inget avgångsbevis.
const UNDERWAY_MIN_FIXES = QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES;
// Ett ENSAMT sampel får bära beviset först vid en fart ingen kajliggare kan
// visa. dig3 mätte den effektiva anflygningsfarten över 1798 sampel:
// median 3,13 kn, p90 5,24. BRANIF-fallets 4,6 kn ligger över medianen; en
// kajvobblare ligger per definition under TRANSIT_SOG_KN större delen av
// tiden. Medianen är alltså den naturliga skiljelinjen och är MÄTT, inte vald.
//
// M2 (RUNDA 4, 2026-08-23): talet var HÅRDKODAT till 3,13 här samtidigt som
// produktionen läser BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN — två kopior av
// samma mätning som kan glida isär utan att något larmar. Nu EN källa.
const UNDERWAY_SOLO_SOG_KN = BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN;
// KAJBANDET. En kajvobblare är per definition VID EN KAJ. Rörelsebeviset
// ovan är nödvändigt men inte tillräckligt för att döma RÖTT: mätt över
// korpusarna finns en hel klass av GLESA men fullt gångna fartyg 1,4–1,6 km
// ut i farleden (IDUN 2,2 kn, LAMANTIJN 2,9 kn, DIAMOND 2,1 kn — ETT eller
// TVÅ sampel var) som inte är kajliggare och inte får fälla grinden. Röd
// KAJVOBBEL kräver därför också att SAMTLIGA sampel låg inom
// QUAY_DEPARTURE_GATE.LEDGER_RADIUS_M från NÅGON målbro — samma radie som
// V1-kajbokföringen (och öppningslagrets egen karta) använder för "vid kaj".
// AKIRA:s hela vobbel låg på 396–410 m; de tre ovan på 1417–1559 m.
// Kajläget följer platsen, inte vilken bro kortet varnar för: CARAT låg
// 404–435 m från Klaffbron men fick ett Stridskort 814 m från målbron.
const QUAY_BAND_M = QUAY_DEPARTURE_GATE.LEDGER_RADIUS_M;
// RÖRELSEBEVISET I O1:s MISSKLASSNING. Tröskeln är appens egen
// (MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN) — samma tal som sätter det
// klistrande vessel._hasMovementProof.
//
// M2b (RUNDA 4, 2026-08-23): KOMMENTAREN HÄR PÅSTOD ATT GRINDEN "SPEGLAR
// _hasMovementProof". Det stämde bokstavligt men var vilseledande, för appen
// BEVÄPNAR inte på den flaggan ensam. _canArm kräver HELA kedjan:
// _hasMovementProof OCH C6:s _hasArmingMovementEvidence OCH att stillhets-
// beviset inte håller (C9b/M1:s jittertåliga ankare) OCH att kajgrinden
// _isBridgeOpeningQuayWobbler (M2:s korroborering) släpper igenom. En grind
// som bara läser tröskeln är alltså SVAGARE än produkten och dömer appen för
// att ha låtit bli att beväpna på just den kajbrusevidens som O2 i samma
// körning kallar KAJVOBBEL-fantom. Se classifyMiss för speglingen.
const MOVE_SOG_KN = MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN;
// Positionsbaserat rörelsebevis: appens EGEN nettotröskel
// (MOORING_DETECTION.MOVEMENT_PROOF_NET_M) — samma tal och samma mening som
// rörelsebevisets positionsgren, C9b:s "äkta avgång släpper ankaret" och
// null-sog-vägens V1-1-släpp. Var hårdkodat 50 här; nu EN källa.
const MOVE_POS_M = MOORING_DETECTION.MOVEMENT_PROOF_NET_M;
// Knop → m/s: IMPORTERAD ur quayTransitProof (4c), inte en egen literal. Den
// lokala kopian stod på 0,514444 medan modulen räknar med appens 0,5144 — två
// sidor som ska spegla PRECIS samma regel (modulens korroborering respektive
// stillnessStay nedan) räknade alltså om knop olika. Utslag 0 på dagens bank,
// men det är samma felklass M2 finns för att avskaffa, i miniatyr.

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
 * ETABLERAD STILLHETSVISTELSE — grindens spegel av appens C9b/M1-ankare.
 *
 * VARFÖR (M2b, helkodsgranskning RUNDA 4, 2026-08-23): en brusig fartgivare
 * vid kaj rapporterar 0,5–7,4 kn utan att båten flyttar sig. Produkten har
 * hela tre lager mot exakt det (C9b:s jittertåliga stillhetsklocka, M1:s
 * ihållande ankare, M2:s korroborering av kajgrindens enkelsampel-undantag),
 * men O1:s missklassning hade inget — den tog FÖRSTA sampel över 0,5 kn som
 * "i rörelse". Följden var ett självmotsägande par verdikt om samma sampel:
 * O2 kallade en varning på kajbruset KAJVOBBEL-fantom (rött) medan O1 kallade
 * frånvaron av samma varning OKLASSAD miss (också rött).
 *
 * REGELN ÄR APPENS EGEN (_stillnessJitterHolds, VesselDataService):
 *   (a) ankaret = första sampel i horisonten; vistelsen består så länge
 *       nettoförflyttningen från ankaret är < MOVE_POS_M
 *       (MOORING_DETECTION.MOVEMENT_PROOF_NET_M) — passeras tröskeln är det
 *       en ÄKTA avgång och ankaret släpps på det samplet ("återkomsten är
 *       gratis"),
 *   (b) vistelsen ska vara ETABLERAD: minst BRIDGE_OPENING.ARM_STALE_TTL_MS
 *       (30 min) lång — exakt appens villkor (2). 30 minuter inom 50 m är en
 *       medelfart på 0,05 kn; det är ingen anflygning i någon fart.
 *
 * ETT TREDJE LED, som appen inte behöver men grinden måste ha: vistelsen ska
 * vara MOTBEVISAD PÅ ETT MÄTBART GLAPP, inte på en tystnad. Minst ett par av
 * varandra följande fixar inne i vistelsen ska ligga högst MAX_PREV_FIX_AGE_MS
 * isär (quayTransitProof:s egen kadensregel) och visa en implicerad fart under
 * MOVE_SOG_KN. Utan det ledet hade 265726650-klassen fallit: TVÅ fixar med
 * 70 minuters tystnad emellan och 14 m netto ser ut som en stillhetsvistelse,
 * men positionsdeltat säger ingenting om vad båten gjorde däremellan (hon kan
 * ha gått ut och kommit tillbaka). Samma fail-open-riktning som modulen.
 *
 * GRINDEN DÖMER I EFTERHAND. Appen prövar villkor (b) online och kan därför
 * inte hålla de första 30 minuterna av en vistelse; grinden ser hela spåret
 * och tillämpar verdiktet på HELA vistelsen. Skillnaden är avsiktlig och går
 * bara åt ett håll: den kan flytta en miss från OKLASSAD till en accepterad
 * klass, aldrig tvärtom.
 * @param {object[]} inHorizon - {s, d, prev} i tidsordning, s = sampel
 * @returns {{established: boolean, spanMs: number, contradiction: object|null}}
 */
function stillnessStay(inHorizon) {
  const origin = inHorizon[0].s;
  let lastInside = origin.aisTimestamp;
  let contradiction = null;
  for (const { s, prev } of inHorizon) {
    const net = geometry.calculateDistance(origin.lat, origin.lon, s.lat, s.lon);
    if (Number.isFinite(net) && net >= MOVE_POS_M) break; // äkta avgång
    lastInside = s.aisTimestamp;
    if (!prev) continue;
    const dtMs = s.aisTimestamp - prev.aisTimestamp;
    if (!(dtMs > 0) || dtMs > MAX_PREV_FIX_AGE_MS) continue;
    const step = geometry.calculateDistance(prev.lat, prev.lon, s.lat, s.lon);
    if (!Number.isFinite(step)) continue;
    const impliedKn = (step / (dtMs / 1000)) / KN_TO_MPS;
    if (impliedKn < MOVE_SOG_KN
      && (contradiction === null || impliedKn < contradiction.impliedKn)) {
      contradiction = {
        t: s.aisTimestamp, dtMs, step, impliedKn,
      };
    }
  }
  const spanMs = lastInside - origin.aisTimestamp;
  return {
    established: spanMs >= BRIDGE_OPENING.ARM_STALE_TTL_MS && contradiction !== null,
    spanMs,
    contradiction,
  };
}

/**
 * Klassificera en MISS mot rådata.
 *
 * ACCEPTERADE klasser kräver mätbara hinder i jsonl:en:
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
 *   RIKTNINGSBEVIS_FÖR_SENT — tidigare rörelse avsåg motsatt/okänd riktning;
 *                           rätt anflygning blev belagd först för sent.
 * Allt annat är OKLASSAD och RÖTT.
 *
 * RÖRELSEBEVISET HAR TRE LED (M2b, RUNDA 4, 2026-08-23). Grinden ska svara på
 * frågan "kunde en GILTIG varning ha gått ut i tid?", och en varning är giltig
 * bara om O2 i samma körning accepterar den. Därför måste beviskravet här
 * spegla HELA appens beväpningskedja, inte bara tröskeln
 * MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN:
 *   1. POSITIONEN. Nettoförflyttning ≥ MOVE_POS_M från första sampel i
 *      horisonten är rörelsebevis i sig — appens egen MOVEMENT_PROOF_NET_M,
 *      och det enda beviset en fartgivarlös båt kan lämna.
 *   2. STILLHETSVISTELSEN (C9b/M1). Sitter samplet inne i en ETABLERAD
 *      stillhetsvistelse är sog-spiken jitter, inte rörelse — se
 *      stillnessStay ovan.
 *   3. KORROBORERINGEN (M2). Ett rått fartvärde får bära beviset först när
 *      fartygets EGEN förflyttning inte motsäger det, prövat i den DELADE
 *      modulen lib/utils/quayTransitProof.js — samma anrop som O2:s
 *      approachEvidence och som produktionens kajgrind i app.js.
 * Utan led 2 och 3 var grinden svagare än produkten: CARAT (211452170, korpus
 * 20260804-both-21h) låg 00:04–06:49 inom 43 m av sin första position, 384–435
 * m från Klaffbron, med en givare som rapporterade 0,5–7,4 kn. Hennes ALLRA
 * FÖRSTA horisontsampel (00:04:32, sog 1,0) räknades som "i rörelse", och
 * missen 6 h 49 min senare blev OKLASSAD — trots att hennes sista fix före
 * passagen (06:48:58, 409 m, sog 0,5) ligger inne i vistelsen och nästa fix
 * (06:53:35) redan är 112 m förbi bron. Avgången skedde i ett rapportglapp på
 * 4 min 37 s; ingen varning var möjlig, och klassen är RÖRELSEBEVIS_FÖR_SENT.
 */
function classifyMiss(passage, samples, windowStartMs) {
  // M2b: FÖREGÅENDE FIX bärs per sampel och hämtas ur HELA den tidsordnade
  // serien, inte ur det filtrerade fönstret (samma lärdom som approachEvidence
  // i O2). Vid fönstrets första sampel ligger föregående fix per definition
  // UTANFÖR fönstret; en fönsterlokal granne hade jämfört mot fel sampel —
  // eller mot inget alls, vilket är fail-open åt fel håll.
  const series = samples.get(String(passage.mmsi)) || [];
  const list = [];
  const prevOf = new Map();
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    if (!(s.aisTimestamp <= passage.t)) continue;
    if (windowStartMs !== null && !(s.aisTimestamp > windowStartMs)) continue;
    list.push(s);
    prevOf.set(s, i > 0 ? series[i - 1] : null);
  }
  const inHorizon = [];
  for (const s of list) {
    const d = distTo(s, passage.bridge);
    if (d !== null && d <= BRIDGE_OPENING.ARM_MAX_DISTANCE_M) {
      inHorizon.push({ s, d, prev: prevOf.get(s) || null });
    }
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
  // Inferred ger ett korsningsfönster. Dess interpolerade punkt får varken
  // bevisa sen ankomst eller en för hög effektiv fart i en MISS-klassning.
  if (!passage.inferred && seenMs < MIN_WARNABLE_MS) {
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
  const veffKn = seenMs > 0 ? (first.d / (seenMs / 1000)) / KN_TO_MPS_BOS : null;
  if (!passage.inferred && veffKn !== null && veffKn > BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN) {
    return {
      klass: 'SNABBARE_ÄN_DEADLINE_TAKET',
      accepted: true,
      bevis: `första sampel inom horisonten ${iso(first.s.aisTimestamp)} (${Math.round(first.d)} m) `
        + `→ passage efter ${secs(seenMs)} = effektiv fart ${veffKn.toFixed(1)} kn, över `
        + `deadline-taket ${BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN} kn — garantin kan inte hålla`,
    };
  }

  // RÖRELSEBEVISET — tre led, se docblocket ovan. Ordningen inne i ett sampel
  // spelar ingen roll för TIDPUNKTEN (samma sampel, samma aisTimestamp), bara
  // för texten: positionen prövas först eftersom den är det starkaste beviset
  // och det enda en fartgivarlös båt kan lämna.
  let moveAt = null;
  let moveWhy = '';
  const origin = first.s;
  const stay = stillnessStay(inHorizon);
  for (const { s, d, prev } of inHorizon) {
    // (1) POSITIONEN — appens MOVEMENT_PROOF_NET_M. Släpper också C9b-ankaret.
    const moved = geometry.calculateDistance(origin.lat, origin.lon, s.lat, s.lon);
    if (Number.isFinite(moved) && moved >= MOVE_POS_M) {
      moveAt = s.aisTimestamp;
      // Etiketten skiljer de två populationerna åt i utskriften: en
      // fartgivarlös båt KAN inte lämna något annat bevis, medan en båt med
      // givare som når hit har fått sitt fartvärde underkänt av led 2/3.
      moveWhy = `positionsdelta ${Math.round(moved)} m från första sampel vid ${Math.round(d)} m`
        + `${Number.isFinite(s.sog) ? '' : ' (fartgivarlös)'}`;
      break;
    }
    const sog = Number.isFinite(s.sog) ? s.sog : null;
    if (sog === null || sog < MOVE_SOG_KN) continue;
    // (2) C9b/M1 — sog-spik utan nettoförflyttning i en etablerad vistelse är
    // jitter. Appens STILLNESS_JITTER_HELD, i grindens efterhandsform.
    if (stay.established) continue;
    // (3) M2 — ett rått fartvärde bär beviset först när fartygets egen
    // förflyttning inte motsäger det. SAMMA delade modul som O2 och app.js;
    // fail-open när förflyttningen inte går att mäta (saknad/gammal
    // föregående fix), annars hade den glesa men äkta klassen dömts fel.
    if (!isCorroboratedTransit({
      sogKn: sog,
      prevFix: prev
        ? {
          lat: prev.lat, lon: prev.lon, ts: prev.aisTimestamp, fixTs: prev.fixTs, feed: prev.feed,
        }
        : null,
      curFix: {
        lat: s.lat, lon: s.lon, ts: s.aisTimestamp, fixTs: s.fixTs, feed: s.feed,
      },
    })) continue;
    moveAt = s.aisTimestamp;
    moveWhy = `sog=${sog.toFixed(1)} kn vid ${Math.round(d)} m (korroborerad av egen förflyttning)`;
    break;
  }
  // Vistelsen skrivs ut i KLARTEXT i varje bevissträng den påverkar — annars
  // går grindens beslut inte att granska i efterhand, och hela filens princip
  // är att klassningen ska gå att pröva mot rådata utan att köra om den.
  const stayNote = stay.established
    ? `; etablerad stillhetsvistelse ${mins(stay.spanMs)} inom ${MOVE_POS_M} m av första sampel `
      + `(${iso(stay.contradiction.t)}: ${Math.round(stay.contradiction.step)} m på `
      + `${secs(stay.contradiction.dtMs)} = ${stay.contradiction.impliedKn.toFixed(2)} kn) — `
      + 'sog-spikarna inne i den är jitter (appens C9b/M1)'
    : '';
  if (moveAt === null || (!passage.inferred && passage.t - moveAt < MIN_WARNABLE_MS)) {
    return {
      klass: 'RÖRELSEBEVIS_FÖR_SENT',
      accepted: true,
      bevis: (moveAt === null
        ? `inget rörelsebevis alls i horisonten (${inHorizon.length} sampel, ingen `
          + `nettoförflyttning ≥ ${MOVE_POS_M} m från första sampel) — kajliggarprofil `
          + 'ända fram till passagen'
        : `första rörelsebeviset ${iso(moveAt)} (${moveWhy}) — endast `
          + `${secs(passage.t - moveAt)} före passagen, garantifönstret kräver ${secs(MIN_WARNABLE_MS)}`)
        + stayNote,
    };
  }

  // Rörelse är inte samma sak som rätt anflygningsriktning. En nordgående
  // utfärd efter förra passagen får inte bli sydreturens bevis, och en kort
  // sidomanöver vid kajen säger inget om vilken bro båten kommer att välja.
  const directionEvidence = directedApproachEvidence(passage, inHorizon);
  if (directionEvidence && (directionEvidence.t === null
      || (!passage.inferred && passage.t - directionEvidence.t < MIN_WARNABLE_MS))) {
    return {
      klass: 'RIKTNINGSBEVIS_FÖR_SENT',
      accepted: true,
      bevis: directionEvidence.t === null
        ? `ingen observerad anflygning ${directionEvidence.label} före passagen; `
          + 'tidigare rörelse avser motsatt eller obelagd riktning'
        : `första belagda anflygningen ${directionEvidence.label} ${iso(directionEvidence.t)} `
          + `(${directionEvidence.why}) — endast ${secs(passage.t - directionEvidence.t)} före passagen, `
          + `garantifönstret kräver ${secs(MIN_WARNABLE_MS)}`,
    };
  }

  const seenNote = passage.inferred
    ? 'korsningens exakta tid är okänd'
    : `${secs(seenMs)} före passagen`;
  const directionNote = directionEvidence
    ? `; riktning ${directionEvidence.label} belagd ${iso(directionEvidence.t)} (${directionEvidence.why})`
    : '';
  return {
    klass: 'OKLASSAD',
    accepted: false,
    bevis: `sedd inom horisonten från ${iso(first.s.aisTimestamp)} (${Math.round(first.d)} m, `
      + `${seenNote}) och i rörelse från ${iso(moveAt)} (${moveWhy}) — `
      + `ingen rådatastödd förklaring till utebliven varning${stayNote}${directionNote}`,
  };
}

/** Oberoende riktningsbevis ur rådata; ett app-ruttlås kan inte frikänna sig självt. */
function directedApproachEvidence(passage, inHorizon) {
  const dir = { nord: 'north', syd: 'south' }[passage.dir] || null;
  if (!dir) return null; // Appserien/äldre facit saknar riktning: inga nya undantag.
  const bridge = Object.values(BRIDGES).find((b) => b.name === passage.bridge);
  if (!bridge) return null;
  let originLat = null;
  for (const { s, prev } of inHorizon) {
    for (const lat of [prev?.lat, s.lat]) {
      if (!Number.isFinite(lat)) continue;
      if (originLat === null) originLat = lat;
      else originLat = dir === 'north' ? Math.min(originLat, lat) : Math.max(originLat, lat);
    }
    if (!beforeBridge(s, bridge, dir)) continue;
    const axialM = originLat === null ? null : (s.lat - originLat) * 111320;
    // En tydlig förflyttning längs kanalen är riktning även när återkomstens
    // aktuella fart är noll. 200 m är grindens befintliga anflygningsbevis;
    // BLADE:s pendling på 46 m söderut och 21 m tillbaka räcker inte. Många
    // små steg åt samma håll måste däremot räknas; ett 200 m-krav PER fix
    // skulle felaktigt frikänna missar för tätt rapporterande båtar utan COG.
    const deltaMatches = Number.isFinite(axialM)
      && (dir === 'north' ? axialM >= GENUINE_APPROACH_M : axialM <= -GENUINE_APPROACH_M);
    const cogMatches = Number.isFinite(s.sog) && s.sog >= MOVE_SOG_KN
      && (dir === 'north' ? isNorthCog(s.cog) : isSouthCogStrict(s.cog));
    if (!deltaMatches && !cogMatches) continue;
    return {
      t: s.aisTimestamp,
      label: dir === 'north' ? 'norrut' : 'söderut',
      why: deltaMatches ? `${Math.round(Math.abs(axialM))} m positionsbevis längs kanalen`
        : `kurs ${s.cog.toFixed(1)}°, fart ${s.sog.toFixed(1)} kn`,
    };
  }
  return { t: null, label: dir === 'north' ? 'norrut' : 'söderut' };
}

/**
 * A3 (etapp 7, 2026-08-08): MÅLBROPASSAGERNA UR RÅDATAFACIT.
 *
 * Appens egna passageregistreringar delar grindarnas blindfläck — 42h-provet
 * mätte 96 registrerade mot 107 verkliga, och blindheterna är KORRELERADE:
 * O1, INV-5, INV-13 och INV-21 är blinda för exakt samma 10 %. En grind som
 * mäter appen mot appen kan aldrig upptäcka den klassen. Här läses i stället
 * rådatafacit (A2, makeGtPassages.js) när det finns.
 *
 * `inferred`-poster (korsning bevisad, TIDPUNKT bara ett fönster) räknas i
 * TÄCKNINGENS NÄMNARE men utesluts ur varje TIDSFÖNSTERMÄTNING — man kan inte
 * mäta förvarningsmarginal mot en tid man inte känner. Differensen mellan
 * serierna ÄR källtystnadsmåttet.
 * @param {object} job - körningens jobb (id + jsonl)
 * @returns {object[]|null} målbropassager ur rådatafacit, eller null
 */
function gtTargetPassages(job) {
  const gt = loadGtPassages(job.gtId || job.id);
  if (!gt) return null;
  return loadAdditionalPassageEvidence(job.gtId || job.id, gt)
    .filter((g) => g.kind !== 'zone' && TARGET_BRIDGES.includes(g.bridge))
    .map((g) => ({
      t: g.t,
      iso: g.iso || new Date(Math.round(g.t)).toISOString(),
      mmsi: String(g.mmsi),
      bridge: g.bridge,
      inferred: g.inferred === true,
      dir: g.dir || null,
      tFrom: g.tFrom ?? null,
      tTo: g.tTo ?? null,
      source: 'gt',
      ...(g.timingEvidence ? { timingEvidence: g.timingEvidence } : {}),
    }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Rådatans ändpunkter avgränsar även korta korsningar vars `t` interpoleras.
 * En inferred-post utan båda ändpunkterna får aldrig bli ett punktbevis.
 */
function passageTimeBounds(p) {
  if (Number.isFinite(p.tFrom) && Number.isFinite(p.tTo) && p.tFrom <= p.tTo) {
    return { from: p.tFrom, to: p.tTo };
  }
  if (!p.inferred && p.tFrom == null && p.tTo == null && Number.isFinite(p.t)) {
    return { from: p.t, to: p.t };
  }
  return null;
}

/**
 * Skilj en belagd tidsseparation från en ordning som bara följer interpolationen.
 * Båda utesluts konservativt ur säker konvojtäckning; här redovisas bevisstyrkan.
 */
function priorConvoyEvidence(p, warning, absorbedAt, intervening) {
  const ownBounds = passageTimeBounds(p);
  const interveningPassages = intervening.map((q) => {
    const bounds = passageTimeBounds(q);
    return {
      passage: q,
      separationProven: !!(ownBounds && bounds && bounds.from > warning.t
        && bounds.to < ownBounds.from - BRIDGE_OPENING.CONVOY_WINDOW_MS),
    };
  });
  return {
    warning,
    absorbedAt,
    separationProven: interveningPassages.some((q) => q.separationProven),
    interveningPassages,
  };
}

function describePriorConvoyEvidence(evidence) {
  return evidence.map((e) => {
    const conclusion = e.separationProven
      ? `en annan båts hela korsningsfönster ligger mer än ${mins(BRIDGE_OPENING.CONVOY_WINDOW_MS)} `
        + 'före denna passage; samma konvoj kan inte säkerställas'
      : 'korsningsfönstren bevisar inte separata öppningar; konvojtillhörigheten är också okänd';
    return `; tidigare konvojvarning ${iso(e.warning.t)} `
      + `(ansluten ${iso(e.absorbedAt)}) finns, men ${conclusion}`;
  })
    .join('');
}

/**
 * O1 för EN körning. Matchar varje målbropassage mot en varning före den, i
 * resefönstret (mellan föregående passage av samma bro och den här) så att en
 * tur-och-retur-resa inte kan återanvända sin första varning.
 * @param {object} result - replay-resultatet
 * @param {Map} samples - rå sampel per mmsi
 * @param {object[]|null} gtPassages - rådatafacit; null ⇒ appens egna passager
 */
function analyseCoverage(result, samples, gtPassages = null) {
  const passages = gtPassages
    ? [...gtPassages].sort((a, b) => a.t - b.t)
    : [...(result.targetPassages || [])].sort((a, b) => a.t - b.t);
  const warnings = result.openingWarnings || [];
  const coverage = result.openingCoverage || [];
  const prevByKey = new Map();
  const covered = [];
  const misses = [];
  const uncertain = [];

  for (const p of passages) {
    const key = `${p.mmsi}:${p.bridge}`;
    const windowStart = prevByKey.has(key) ? prevByKey.get(key) : null;
    prevByKey.set(key, p.t);
    // En inferred-korsning har ingen känd punktstämpel. En varning inne i
    // rådatans lucka kan vara före ELLER efter korsningen och måste visas
    // som okänd, inte som säker täckning eller en bevisat sen varning.
    const latestPassage = p.inferred && Number.isFinite(p.tTo) ? p.tTo : p.t;
    const inWindow = (t) => Number.isFinite(t) && t < latestPassage && (windowStart === null || t > windowStart);
    const certainlyBefore = (w) => !p.inferred || (Number.isFinite(p.tFrom) && w.t <= p.tFrom);

    // (1) Varningen tog henne som MEDLEM.
    let hit = null;
    let via = null;
    const consider = (w, how) => {
      if (hit === null || (certainlyBefore(w) && !certainlyBefore(hit))
          || (certainlyBefore(w) === certainlyBefore(hit) && w.t > hit.t)) {
        hit = w; via = how;
      }
    };
    for (const w of warnings) {
      if (w.bridge !== p.bridge || !inWindow(w.t)) continue;
      const members = Array.isArray(w.mmsis) ? w.mmsis : [];
      if (members.includes(String(p.mmsi)) || String(w.leadMmsi) === String(p.mmsi)) {
        consider(w, 'fired');
      }
    }
    // (2) KONVOJTÄCKNING: hon anslöt till en redan avfyrad öppning. Varningen
    //     som täcker henne är den händelsens — ledtiden mäts från DEN.
    //
    //     En mellanliggande båtpassage mer än ett konvojfönster före denna
    //     utesluter återbruk av den äldre varningen. Vid inferred-passager kan
    //     interpolerade punkter antyda en sådan separation utan att hela
    //     rådatafönstren bevisar den. Även då krävs fortsatt osäker klassning:
    //     vi kan varken bevisa samma konvoj eller att bron stängde emellan.
    const otherPassagesBetween = (t) => passages.filter((q) => q !== p && q.bridge === p.bridge
      && String(q.mmsi) !== String(p.mmsi)
      && q.t > t && q.t < p.t - BRIDGE_OPENING.CONVOY_WINDOW_MS);
    const earlierConvoyWarnings = [];
    if (hit === null || !certainlyBefore(hit)) {
      for (const c of coverage) {
        if (c.bridge !== p.bridge || String(c.mmsi) !== String(p.mmsi) || !inWindow(c.t)) continue;
        const w = warnings.find((x) => x.eventId === c.eventId);
        if (!w || !inWindow(w.t)) continue;
        if (c.reason === 'absorbed') {
          const intervening = otherPassagesBetween(w.t);
          if (intervening.length) {
            if (p.inferred && certainlyBefore(w)) {
              earlierConvoyWarnings.push(priorConvoyEvidence(p, w, c.t, intervening));
            }
            continue;
          }
        }
        consider(w, c.reason === 'absorbed' ? 'konvoj' : 'fired');
      }
    }

    if (hit && !certainlyBefore(hit)) {
      uncertain.push({
        passage: p,
        warning: hit,
        via,
        klass: 'TIDPUNKT_OKÄND',
        ...(earlierConvoyWarnings.length ? { earlierConvoyWarnings } : {}),
        bevis: `varning ${iso(hit.t)} ligger i korsningsfönstret `
          + `${Number.isFinite(p.tFrom) ? iso(p.tFrom) : 'okänd start'}–${iso(latestPassage)}; `
          + `rådata kan inte visa om varningen kom före eller efter passagen${describePriorConvoyEvidence(earlierConvoyWarnings)}`,
      });
    } else if (hit) {
      covered.push({
        passage: p, warning: hit, via, leadMs: p.t - hit.t,
      });
    } else {
      misses.push({ passage: p, ...classifyMiss(p, samples, windowStart) });
    }
  }
  return {
    passages, covered, misses, uncertain,
  };
}

/**
 * AVFYRNINGSFÖNSTRET — grinden mäter TICK-RASTRERING, inte ledtid.
 *
 * Servicen skickar med `dueMs` (den tidigaste förfallotiden bland de armar som
 * utlöste) och grinden prövar att avfyrningen ligger i [dueMs, dueMs + två
 * tick]. Det den DÄRMED bevakar är att tick-loopen faktiskt tickar: ett tappat
 * eller strypt tick skjuter avfyrningen bortom taket och syns direkt.
 *
 * ⚠️ VAD DEN INTE GÖR (L13, helkodsgranskning runda 3, 2026-08-22 — docblocket
 * påstod förut motsatsen): den fångar INTE en regression som flyttar samtliga
 * varningar tidigare. Grinden är SJÄLVUPPFYLLANDE åt det hållet, för `dueMs`
 * härleds ur exakt de tal som beslutar avfyrningen. `dueMs` är min över de
 * förfallna armarna av max(fireDueMs, eligibleAt); avfyrning KRÄVER att
 * fireDueMs har passerat (due-filtret i BridgeOpeningService._evaluateBridge),
 * och eligibleAt sätts till `now` vid varje händelseknytning — inklusive den
 * som sker i samma _evaluateBridge-anrop som avfyrningen. Alltså är dueMs ≤ t
 * per konstruktion och den negativa grenen strukturellt onåbar i dag.
 * MUTATIONSBEVIS (utan repoändring, preload som höjer WARNING_LEAD_MS): +60 s
 * och +120 s flyttar varje varning 60–300 s tidigare i fem korpusar och den
 * här grinden ger NOLL brott i samtliga. Ledtiden MÄTS (O1 skriver ut
 * fördelningen) men är inte LÅST.
 *
 * DEN NEGATIVA GRENEN STÅR ÄNDÅ KVAR och är inte död vikt: den vaktar en
 * regression i due-filtret. Släpper någon fram en arm vars fireDueMs ännu inte
 * passerat — eller börjar eligibleAt sättas framåt i tiden — blir delta
 * negativt och grinden rodnar. Uppmätt i dag: 0 av 80 varningar (fem korpusar)
 * och 0 av 367 i granskningens svep.
 *
 * BYT INTE dueMs MOT originalDueMs. Det ser ut som fixen men rödfärgar ett
 * grönt HEAD: originalDueMs är armens FRYSTA ursprungsdeadline, och H-4 mäter
 * legitim deadlineförflyttning upp till ~29,6 min när ett närmare fix binder om
 * fireDueMs. Mätt över samma fem korpusar: t − originalDueMs har p50 72 s, p90
 * 580 s och max 28,8 min, och en grind på det talet hade fällt 43 av 80
 * varningar — alltså larm på normal drift.
 *
 * LEDTIDSFÖRDELNINGEN ÄR OLÅST — förslag, inte gjort i den här rundan: lås
 * facit på serien t − originalDueMs per korpus, så en formeländring i
 * WARNING_LEAD_MS syns som ett fördelningsbrott. Det skapar NYTT facit som
 * måste rådataverifieras en gång, och hör därför till en egen låsningsrunda.
 *
 * TOLERANSEN är ett tick-intervall plus en tick till: avfyrningen sker i
 * 30 s-loopen, och ett meddelande som landar mellan två tick förskjuter
 * utvärderingen med upp till ett helt intervall. BASLINJE för tick-rastreringen
 * (mätt 2026-08-22 över 80 varningar i fem korpusar): min 0 s, p50 11,1 s,
 * p90 25,4 s, max 29,2 s mot taket 60 s — full mäthöjd kvar för ett tappat tick.
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
 * höga solotröskel (UNDERWAY_SOLO_SOG_KN) bära rörelsebeviset när egen
 * färsk förflyttning inte motsäger det. Två lägre fartvärden måste däremot
 * stödjas av nettoavgång över kajgrindens befintliga brusgolv.
 */
function approachEvidence(warning, samples) {
  const members = new Set([
    ...(Array.isArray(warning.mmsis) ? warning.mmsis.map(String) : []),
    ...(warning.leadMmsi ? [String(warning.leadMmsi)] : []),
  ]);
  let best = null;
  for (const mmsi of members) {
    // M2: fönstret bär FÖREGÅENDE fix ur HELA den tidsordnade listan, inte ur
    // det filtrerade fönstret. Korroboreringen mäter förflyttning mellan två
    // på varandra följande fixar — vid fönstrets första sampel ligger
    // föregående fix per definition UTANFÖR fönstret, och en fönsterlokal
    // granne hade jämfört mot fel sampel (eller inget alls).
    const allSamples = samples.get(mmsi) || [];
    const windowed = [];
    for (let idx = 0; idx < allSamples.length; idx++) {
      const s = allSamples[idx];
      if (s.aisTimestamp >= warning.t - APPROACH_LOOKBACK_MS && s.aisTimestamp <= warning.t) {
        windowed.push({ s, prev: idx > 0 ? allSamples[idx - 1] : null });
      }
    }
    const list = windowed.map((x) => x.s);
    if (list.length === 0) continue;
    let firstD = null;
    let minD = Infinity;
    let maxD = 0;
    let maxSog = null;
    let maxMove = 0;
    let underwayFixes = 0;
    let inHorizon = 0;
    // M2: enkelsampel-beviset räknas i TVÅ storheter — hur många sampel som
    // NÅR tröskeln, och hur många av dem som också är KORROBORERADE av
    // fartygets egen förflyttning. Skillnaden mellan dem är precis den falska
    // rörelseklassning som fällde CARAT.
    let soloSogFixes = 0;
    let soloProofFixes = 0;
    for (let i = 0; i < windowed.length; i++) {
      const { s, prev } = windowed[i];
      const d = distTo(s, warning.bridge);
      if (d === null) continue;
      if (firstD === null) firstD = d;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
      if (d <= BRIDGE_OPENING.ARM_MAX_DISTANCE_M) inHorizon++;
      const sog = Number.isFinite(s.sog) ? s.sog : null;
      if (sog !== null && (maxSog === null || sog > maxSog)) maxSog = sog;
      if (sog !== null && sog >= UNDERWAY_SOG_KN) underwayFixes++;
      if (sog !== null && sog >= UNDERWAY_SOLO_SOG_KN) {
        soloSogFixes++;
        // SAMMA prövning som produktionens kajgrind, ur den DELADE modulen.
        // Fail-open där förflyttningen inte går att mäta (saknad/gammal
        // föregående fix) — annars dör 265726650:s äkta varning, som vilar på
        // ETT sampel efter 70 minuters tystnad.
        if (isCorroboratedTransit({
          sogKn: sog,
          prevFix: prev
            ? {
              lat: prev.lat, lon: prev.lon, ts: prev.aisTimestamp, fixTs: prev.fixTs, feed: prev.feed,
            }
            : null,
          curFix: {
            lat: s.lat, lon: s.lon, ts: s.aisTimestamp, fixTs: s.fixTs, feed: s.feed,
          },
        })) soloProofFixes++;
      }
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
      soloSogFixes,
      soloProofFixes,
      inHorizon,
    };
    // ÄKTA ANFLYGNING kräver (a) att fartyget någon gång varit INNE i
    // beväpningshorisonten — utan det benet accepterade grinden en varning
    // för ett fartyg 12 km bort, dvs. hela regressionsklassen "beväpnar mot
    // fel bro" hade passerat tyst — OCH (b) ett rörelsebevis som håller:
    // mätbart närmande, mätbar förflyttning, upprepad lägre fart MED
    // nettoavgång, eller ett ensamt korroborerat sampel över solotröskeln.
    // CARATs två 1,0/1,6-knopsfixar flyttade bara positionen 32 m: samma
    // kajbrus blir inte rörelsebevis bara för att fartgivaren upprepar det.
    cand.nearEnough = cand.inHorizon > 0;
    // M2: det ensamma sampel-benet kräver KORROBORERING. Tidigare räckte
    // `maxSog >= UNDERWAY_SOLO_SOG_KN`, dvs. ETT rått fartvärde någonstans i
    // fönstret — samma enkelsampel-genväg som produktionens kajgrind hade, så
    // grinden kunde per konstruktion inte se felmoden den skulle mäta.
    cand.moving = cand.net >= GENUINE_APPROACH_M
      || cand.maxMove >= GENUINE_APPROACH_M
      || (cand.underwayFixes >= UNDERWAY_MIN_FIXES
        && cand.maxMove >= QUAY_DEPARTURE_GATE.NET_APPROACH_M)
      || cand.soloProofFixes > 0;
    // KAJVOBBELNS TVÅ SIGNATURER (utan rörelsebevis i övrigt):
    //  (a) hon lämnade aldrig kajbandet vid bron, eller
    //  (b) hon nådde aldrig ens appens egen transitgräns — provably stilla.
    // Utan (a) hade grinden fällt en hel klass GLESA men fullt gångna fartyg
    // 1,4–1,6 km ut (IDUN 2,2 kn, LAMANTIJN 2,9 kn, DIAMOND 2,1 kn — ETT
    // eller TVÅ sampel var). Utan (b) hade en båt som ligger still 800 m ut i
    // 30 sampel à 0,2 kn sluppit igenom bara för att hon låg utanför bandet.
    cand.quayBridge = [...TARGET_BRIDGE_POS.keys()].find((bridgeName) => list.every((s) => {
      const d = distTo(s, bridgeName);
      return d !== null && d <= QUAY_BAND_M;
    })) || null;
    cand.atQuay = cand.quayBridge !== null;
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
  const quayLocation = best.atQuay
    ? `HELA fönstret inom kajbandet ${QUAY_BAND_M} m vid ${best.quayBridge}`
    : `utanför målbroarnas kajband (maxavstånd till målbron ${Math.round(best.maxD)} m)`;
  const bevis = `${best.mmsi}: ${best.samples} sampel (${best.inHorizon} inom `
    + `${BRIDGE_OPENING.ARM_MAX_DISTANCE_M} m), avstånd ${Math.round(best.firstD)}→`
    + `${Math.round(best.minD)} m (netto-närmande ${Math.round(best.net)} m), `
    + `maxfart ${best.maxSog === null ? 'okänd (fartgivarlös)' : `${best.maxSog.toFixed(1)} kn`}, `
    + `${best.underwayFixes} fix ≥${UNDERWAY_SOG_KN} kn, `
    + `${best.soloProofFixes}/${best.soloSogFixes} fix ≥${UNDERWAY_SOLO_SOG_KN} kn `
    + 'KORROBORERADE av egen förflyttning, '
    + `positionsförflyttning ${Math.round(best.maxMove)} m, `
    + `${quayLocation}`;

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
  const veffKn = travelS > 0 ? (dist / travelS) / KN_TO_MPS_BOS : null;
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
 *
 * S14 (systerställesrundan 2026-08-23): PASSAGESERIEN ÄR VALFRI. Utan
 * `gtPassages` mäts appen mot APPENS EGNA passager — exakt den blindfläck O1
 * hade före A3: en varning som appen själv bokfört som passage kallas
 * BEKRÄFTAD även när rådatafacit säger något annat, och O2 äger exitkoden för
 * röda fantomer. Med `gtPassages` (gtTargetPassages, dvs. A2:s rådatafacit
 * filtrerat på målbroar) körs SAMMA klassificerare mot rådataserien —
 * O1b:s mönster, rapporterat som en egen O2b-rubrik BREDVID O2.
 *
 * TVÅ VILLKOR som följer av facitets egen semantik:
 *  (a) `inferred`-poster (korsningen bevisad, TIDPUNKTEN bara ett fönster
 *      tFrom–tTo) får ALDRIG bära hinkindelningen. Hinkarna ÄR en
 *      tidsfönstermätning (20 min / 120 min) och en tid man inte känner kan
 *      inte jämföras med ett fönster — samma uteslutning som A3(b) och INV-21
 *      redan gör. En varning vars första möjliga korsning är `inferred`
 *      hamnar därför i den EGNA hinken INFERRERAD_TID: varken bekräftad, sen
 *      eller fantom. Tas de med får man falska «farliga byten» direkt
 *      (mätt i rundan: 3 av 4 vilade på inferrerade poster).
 *  (b) facitserien innehåller bara MÅLBROAR (gtTargetPassages filtrerar på
 *      TARGET_BRIDGES). Det är också det som behåller INV-13:s klass: en
 *      målbrokorsning som appen bokförde som INTERMEDIATE finns i facit
 *      oavsett hur appen bokförde den, så designenliga förlopp blir inte
 *      falska fantomer i rådataserien heller.
 * @param {object} result - replay-resultatet
 * @param {Map} samples - rå sampel per mmsi
 * @param {object[]|null} gtPassages - rådatafacit (målbroar); null ⇒ appserien
 * @returns {object} confirmed, latePassages, phantoms, inferredTime, byWarning
 */
function analysePhantoms(result, samples, gtPassages = null) {
  const warnings = result.openingWarnings || [];
  // APPSERIEN: unionen target ∪ intermediate. En målbrokorsning som bokförts
  // som INTERMEDIATE (mållös båt, U-svängskorrigerad resa) är fortfarande en
  // verklig broöppning — INV-13:s klass. Räkna den, annars blir designenliga
  // förlopp falska fantomer.
  const series = gtPassages
    ? [...gtPassages]
    : [...(result.targetPassages || []), ...(result.intermediatePassages || [])];
  const phantoms = [];
  const latePassages = [];
  // Varningar vars enda möjliga korsning är `inferred` — hålls UTANFÖR de tre
  // hinkarna (villkor (a) ovan). Tom i appserien: appens egna passager har
  // ingen `inferred`-flagga.
  const inferredTime = [];
  // Per-varningsetikett så O2b kan diffa hinkarna mot O2 utan att köra om
  // klassificeraren en tredje gång.
  const byWarning = [];
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
    const mine = series.filter((p) => p.bridge === w.bridge && members.has(String(p.mmsi)));
    const after = mine
      .filter((p) => p.inferred !== true && p.t >= w.t)
      .sort((a, b) => a.t - b.t);
    const first = after[0];
    // En inferrerad korsning vars FÖNSTER kan ligga före den första säkra
    // passagen gör hinken omätbar: bron öppnades bevisligen, men när vet vi
    // inte, och just den ordningen är det hinkarna avgörs av.
    // Övre gränsen är LATE_PASSAGE_WINDOW_MS: börjar fönstret EFTER hela
    // mätfönstret kan korsningen omöjligt ha avgjort någon hink, och då ska
    // varningen klassas som vanligt (annars göms äkta fantomer i den omätbara
    // hinken).
    const blindLimit = Math.min(
      first ? first.t : Infinity,
      w.t + LATE_PASSAGE_WINDOW_MS,
    );
    const blind = mine.find((p) => p.inferred === true
      && (p.tTo ?? p.t) >= w.t
      && (p.tFrom ?? p.t) <= blindLimit);
    if (blind) {
      inferredTime.push({ warning: w, passage: blind });
      byWarning.push({
        warning: w, hink: 'INFERRERAD_TID', klass: 'INFERRERAD_TID', accepted: null,
      });
    } else if (first && first.t - w.t <= PHANTOM_WINDOW_MS) {
      confirmed++;
      byWarning.push({
        warning: w, hink: 'BEKRÄFTAD', klass: 'BEKRÄFTAD', accepted: true,
      });
    } else if (first && first.t - w.t <= LATE_PASSAGE_WINDOW_MS) {
      const late = {
        warning: w,
        passage: first,
        delayMs: first.t - w.t,
        ...classifyLatePassage(w, first, samples),
      };
      latePassages.push(late);
      byWarning.push({
        warning: w, hink: 'SEN_PASSAGE', klass: late.klass, accepted: late.accepted,
      });
    } else {
      const ph = { warning: w, ...classifyPhantom(w, samples) };
      phantoms.push(ph);
      byWarning.push({
        warning: w, hink: 'FANTOM', klass: ph.klass, accepted: ph.accepted,
      });
    }
  }
  return {
    confirmed, latePassages, phantoms, inferredTime, byWarning,
  };
}

// ---------------------------------------------------------------------------
// A8(iii) — SISTA-PÅMINNELSE-SERIEN (etapp 7, 2026-08-08)
// ---------------------------------------------------------------------------

/**
 * Gruppera varningarna i FYSISKA ÖPPNINGAR och mät påminnelsebeteendet.
 *
 * Semantiken är användarens (U2): en öppningshändelse avgränsas av den FÖRSTA
 * FAKTISKA PASSAGEN — båtar som väntar tillhör samma händelse hur länge de än
 * väntar, båtar som anländer efter passagen tillhör nästa. Kontraktet är EN
 * varning per öppning; serien mäter hur långt ifrån det vi ligger, per bro:
 *   - antal varningar per öppning (kontraktsbrottet, C8:s kvot),
 *   - intervallen mellan dem (är det påminnelser eller dubbletter?),
 *   - ÅLDERN på den sista varningen när passagen sker (blir förvarningen
 *     inaktuell innan bron öppnar?).
 *
 * `originalDueMs` (H-4, läggs till av öppningsservicen i P-OA) visar hur mycket
 * eligibleAt-ombindningen sköt fram avfyrningen. Saknas fältet rapporteras det
 * som okänt — serien får aldrig krascha på en payload som ännu inte landat.
 * @param {object[]} runs - körningarna
 */
function reportReminderSeries(runs) {
  console.log('--- H-4: SISTA-PÅMINNELSE-SERIEN (per FYSISK öppning; U2 kräver exakt EN varning) ---\n');
  let openings = 0;
  let multi = 0;
  let noPassage = 0;
  let inferredEnd = 0;
  const perOpening = [];
  const gapsBetween = [];
  const lastAges = [];
  const rebindDeltas = [];
  let rebindKnown = 0;
  let rebindMissing = 0;
  const rows = [];

  for (const run of runs) {
    if (run.error) continue;
    // Sanningen om passagerna: rådatafacit när det finns, annars appens egna
    // (samma fallback som O1b, tydligt markerad i raden nedan).
    const gtP = run.gt ? run.gt.passages : null;
    const passages = gtP || (run.result.targetPassages || []);
    const warnings = [...(run.result.openingWarnings || [])]
      .filter((w) => Number.isFinite(w.t)).sort((a, b) => a.t - b.t);
    for (const w of warnings) {
      if (Number.isFinite(w.originalDueMs) && Number.isFinite(w.t)) {
        rebindKnown++;
        rebindDeltas.push(w.t - w.originalDueMs);
      } else rebindMissing++;
    }
    let corpusOpenings = 0;
    let corpusMulti = 0;
    for (const bridge of TARGET_BRIDGES) {
      const bw = warnings.filter((w) => w.bridge === bridge);
      const bp = passages.filter((p) => p.bridge === bridge).sort((a, b) => a.t - b.t);
      let i = 0;
      while (i < bw.length) {
        const start = bw[i];
        const passage = bp.find((p) => p.t >= start.t);
        // Alla varningar fram till (och med) passagen tillhör samma öppning.
        const end = passage ? passage.t : Infinity;
        const group = [];
        while (i < bw.length && bw[i].t <= end) {
          group.push(bw[i]);
          i++;
        }
        openings++;
        corpusOpenings++;
        perOpening.push(group.length);
        if (group.length > 1) {
          multi++;
          corpusMulti++;
          for (let k = 1; k < group.length; k++) gapsBetween.push(group[k].t - group[k - 1].t);
        }
        // ÅLDERSMÅTTET är en tidsfönstermätning ⇒ `inferred`-passager utesluts
        // (A3(b)): deras tidpunkt är ett fönster, inte en klockslag. De
        // avgränsar däremot öppningen som vanligt — korsningen ÄR bevisad.
        if (passage && passage.inferred) inferredEnd++;
        else if (passage) lastAges.push(passage.t - group[group.length - 1].t);
        else noPassage++;
      }
    }
    if (corpusOpenings) {
      rows.push(`  ${run.job.id.padEnd(26)} ${String(corpusOpenings).padStart(3)} öppningar, `
        + `${corpusMulti} med >1 varning${gtP ? ' (rådatafacit)' : ' (appens passager — gt saknas)'}`);
    }
  }
  for (const r of rows) console.log(r);
  if (openings === 0) {
    console.log('  (inga öppningsvarningar i körningen)\n');
    return;
  }
  const maxPer = Math.max(...perOpening);
  console.log(`\n  SUMMA: ${openings} fysiska öppningar, ${multi} med fler än en varning `
    + `(${((100 * multi) / openings).toFixed(1)} %), max ${maxPer} varningar på samma öppning, `
    + `kvot ${(perOpening.reduce((a, b) => a + b, 0) / openings).toFixed(2)} varningar/öppning `
    + '(U2-kontraktet: 1,00)');
  if (gapsBetween.length) {
    const s = [...gapsBetween].sort((a, b) => a - b);
    console.log(`  INTERVALL mellan varningar i samma öppning: median ${mins(median(gapsBetween))}, `
      + `min ${mins(s[0])}, max ${mins(s[s.length - 1])} (${gapsBetween.length} extravarningar)`);
  }
  if (lastAges.length) {
    const s = [...lastAges].sort((a, b) => a - b);
    console.log(`  ÅLDER på sista varningen vid passagen: median ${mins(median(lastAges))}, `
      + `min ${mins(s[0])}, max ${mins(s[s.length - 1])}`);
  }
  if (noPassage) console.log(`  ${noPassage} öppningar utan efterföljande passage (O2:s fantomhink äger dem)`);
  if (inferredEnd) {
    console.log(`  ${inferredEnd} öppningar avslutades av en \`inferred\` passage — uteslutna ur åldersmåttet `
      + '(korsningen är bevisad, tidpunkten bara ett fönster)');
  }
  if (rebindKnown) {
    const s = [...rebindDeltas].sort((a, b) => a - b);
    console.log(`  eligibleAt-OMBINDNING (originalDueMs): ${rebindKnown} varningar, `
      + `median ${mins(median(rebindDeltas))}, max ${mins(s[s.length - 1])} efter ursprunglig deadline`);
  }
  if (rebindMissing) {
    console.log(`  ℹ️ originalDueMs saknas i ${rebindMissing} varningar — payloadfältet (H-4) `
      + 'läggs till av öppningsservicen; serien rapporterar det som okänt tills dess.');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// H-4b — ÖPPNINGSLIGGAREN: 0-RÄKNAREN (etapp 7 fas C-VI, 2026-08-10)
// ---------------------------------------------------------------------------

/**
 * RÄKNA FRÅN PASSAGERNA, INTE FRÅN VARNINGARNA.
 *
 * H-4-serien ovan går från VARNING → öppning och kan därför per konstruktion
 * ALDRIG se en öppning som fick noll varningar. Det är exakt det måttet C8 föll
 * på (26 → 32 ovarnade öppningar), och C-IV:s metodfynd 2 säger det rakt ut:
 * »kvoten ensam duger inte som acceptanskriterium — korpus #18 har kvot 1,00,
 * men bara för att sex öppningar med noll varningar exakt kompenserar sex med
 * för många. >1-räknaren och 0-räknaren måste redovisas var för sig.«
 *
 * LIGGAREN. En FYSISK ÖPPNING är en klunga passager vid samma bro inom
 * CONVOY_WINDOW_MS — dig9:s egen definition, samma som konvojkriteriet och
 * O1:s konvojtak använder. Varje varning bokförs på den FÖRSTA klunga vars
 * sista passage ligger vid eller efter varningen; varningar efter den sista
 * klungan hör till O2:s fantomhink och räknas inte här.
 *
 * SANNINGEN är rådatafacit (A2) när det finns, annars appens egna passager —
 * samma fallback som H-4 och O1b, och den markeras i raden.
 *
 * RENT INSTRUMENT: metoden skriver bara ut. Exit-koden ägs av O1/O2/O3.
 * @param {object[]} runs - körningarna
 */
function reportOpeningLedger(runs) {
  console.log('--- H-4b: ÖPPNINGSLIGGAREN (från PASSAGERNA — 0-räknaren och >1-räknaren var för sig) ---\n');
  let openings = 0;
  let zero = 0;
  let multi = 0;
  let warningsOnOpenings = 0;
  let warningsAfterLast = 0;
  const rows = [];

  for (const run of runs) {
    if (run.error) continue;
    const gtP = run.gt ? run.gt.passages : null;
    const passages = gtP || (run.result.targetPassages || []);
    const warnings = (run.result.openingWarnings || []).filter((w) => Number.isFinite(w.t));
    let corpusOpenings = 0;
    let corpusZero = 0;
    let corpusMulti = 0;
    for (const bridge of TARGET_BRIDGES) {
      const bp = passages.filter((p) => p.bridge === bridge && Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t);
      if (bp.length === 0) continue;
      // (1) Klungor = fysiska öppningar.
      const clusters = [];
      for (const p of bp) {
        const last = clusters[clusters.length - 1];
        if (last && p.t - last.lastT <= BRIDGE_OPENING.CONVOY_WINDOW_MS) {
          last.lastT = p.t;
          last.n++;
        } else {
          clusters.push({
            firstT: p.t, lastT: p.t, n: 1, warnings: 0,
          });
        }
      }
      // (2) Bokför varningarna på den öppning de FÖRVARNADE.
      for (const w of warnings.filter((x) => x.bridge === bridge)) {
        const target = clusters.find((c) => c.lastT >= w.t);
        if (target) {
          target.warnings++;
          warningsOnOpenings++;
        } else warningsAfterLast++;
      }
      for (const c of clusters) {
        openings++;
        corpusOpenings++;
        if (c.warnings === 0) {
          zero++;
          corpusZero++;
        } else if (c.warnings > 1) {
          multi++;
          corpusMulti++;
        }
      }
    }
    if (corpusOpenings) {
      rows.push(`  ${run.job.id.padEnd(26)} ${String(corpusOpenings).padStart(3)} fysiska öppningar, `
        + `${String(corpusZero).padStart(2)} OVARNADE, ${String(corpusMulti).padStart(2)} med >1 varning`
        + `${gtP ? ' (rådatafacit)' : ' (appens passager — gt saknas)'}`);
    }
  }
  for (const r of rows) console.log(r);
  if (openings === 0) {
    console.log('  (inga målbropassager i körningen)\n');
    return;
  }
  console.log(`\n  SUMMA: ${openings} fysiska öppningar — ${zero} OVARNADE (0-räknaren), `
    + `${multi} med >1 varning (>1-räknaren), ${openings - zero - multi} med exakt en`);
  console.log(`  KVOT: ${((warningsOnOpenings + warningsAfterLast) / openings).toFixed(3)} varningar/öppning `
    + `(${warningsOnOpenings} bokförda på en öppning + ${warningsAfterLast} efter sista passagen `
    + '— O2:s fantomhink äger de senare)');
  console.log('');
}

// ---------------------------------------------------------------------------
// KÖRNINGSPLAN
// ---------------------------------------------------------------------------

const JOB_LIST = [
  // A9a (etapp 7, 2026-08-08): `locked` FÖLJER MED från corpora.js.
  //
  // Hålet fältprovet hittade: den här listan tog ALLA korpuslistans poster och
  // varje utslag satte `failed`. En OLÅST korpus — vars hela poäng är att den
  // bär kända, ännu ofixade defekter — kunde alltså fälla öppningsgrindarna,
  // trots att `runAllCorpora` sedan dag ett behandlar samma korpus informativt.
  // Två grindar med motsatt doktrin om samma post är en fälla: den olåsta
  // korpusen blir omöjlig att checka in, och frestelsen blir att i stället
  // "tysta" fyndet.
  //
  // VALT: kör korpusen (mätvärdet är hela skälet att ta in #18 — 36 fältavfyrade
  // öppningar i AISHub-eran), men låt utslagen vara INFORMATIVA. Alternativet —
  // ett rent `.filter(c => c.locked)` — hade tagit bort både bruset OCH
  // mätningen, och det är mätningen fas C behöver. Varje utslag skrivs ut i sin
  // helhet, märkt OLÅST, och summeras i en egen slutrad så att ingenting kan
  // gömma sig i informativitet.
  //
  // KRAV VID NY KANDIDAT (planens formulering): O1/O2 ska TORRKÖRAS mot posten
  // innan den läggs in i corpora.js — utfallet är underlag för låsningsbeslutet,
  // oavsett `locked`-värde.
  ...corpora.map((c) => ({
    id: c.id, jsonl: c.jsonl, fusion: false, hours: c.hours, locked: c.locked !== false,
  })),
  // Korpus 16: A/B-nattens B-arm (äkta AISHub + aisstream). Körs i FUSIONS-
  // läge — det är den enda korpus där andrakällan faktiskt accepteras, och
  // öppningslagret måste bevisas i just den kedjan.
  {
    // gtId: rådatafacit ligger under korpusens id utan lägesmarkören — natten
    // är EN inspelning, oavsett vilken arm som spelas upp.
    id: '20260803-natt (fusion)', gtId: '20260803-natt', jsonl: NIGHT_FUSION, fusion: true, hours: 9, locked: true,
  },
];

/**
 * O2b (S14, systerställesrundan 2026-08-23) — FANTOMTAKET MOT RÅDATAFACIT.
 *
 * Samma klassificerare som O2, men passageserien är A2:s rådatafacit i stället
 * för appens egna bokföringar. Skälet är O1b:s: appens passageregistreringar
 * delar grindarnas blindfläck (42h-provet: 96 registrerade mot 107 verkliga),
 * så en varning kan kallas BEKRÄFTAD av appens egen bokföring medan rådatan
 * inte känner någon korsning. Serierna redovisas BREDVID varandra, aldrig i
 * stället för varandra — annars blir jämförelser mot äldre körningsloggar
 * omöjliga.
 *
 * INFORMATIV I DEN HÄR ETAPPEN: O2b rör INTE exitkoden. Grinden ligger kvar på
 * appserien precis som O1:s täckning gör i fas A ("instrument före produkt" —
 * ett nytt mått får inte flytta ett grindutfall samma dag det införs).
 * Uppmätt vid införandet: 0 röda i BÅDA serierna, medan 118 av 360 varningar
 * byter hink — 98 av dem in i INFERRERAD_TID (omätbar tid, villkor (a)) och
 * bara EN åt det farliga hållet (JAATTEN II @ Stridsbergsbron i 20260708-21h,
 * samma fall INV-21 redan fäller). Rundans egen förmätning utan
 * inferrerad-uteslutningen gav 78 byten och 4 farliga; skillnaden ÄR villkor
 * (a):s verkan och siffrorna är därför inte jämförbara rakt av. När fas C är
 * klar flyttas exitkoden hit av OPENING_GT_STRICT, likadant som O1b:s
 * oklassade missar.
 * @param {object[]} runs - körningarna (kräver run.gtPassages och run.o2App)
 * @returns {void}
 */
function reportGtPhantoms(runs) {
  const withGt = runs.filter((r) => !r.error && r.gtPassages && r.analysis);
  if (withGt.length === 0) {
    console.log('  ⚠️ RÅDATAFACIT SAKNAS för samtliga korpusar — O2b hoppas över '
      + '(kör `node tests/replay-validation/makeGtPassages.js`, A2).\n');
    return;
  }
  console.log('--- O2b: FANTOMTAK MOT RÅDATAFACIT (A2) — appens egna passager är INTE sanningen ---\n');
  const rows = [];
  const byClass = new Map();
  const switches = new Map();
  const dangerous = [];
  const reds = [];
  const delays = [];
  let warningsTot = 0;
  let confirmedTot = 0;
  let lateTot = 0;
  let phantomTot = 0;
  let inferredTot = 0;
  for (const run of withGt) {
    const gt = analysePhantoms(run.result, run.analysis.samples, run.gtPassages);
    const warnings = (run.result.openingWarnings || []).length;
    warningsTot += warnings;
    confirmedTot += gt.confirmed;
    lateTot += gt.latePassages.length;
    phantomTot += gt.phantoms.length;
    inferredTot += gt.inferredTime.length;
    for (const l of gt.latePassages) delays.push(l.delayMs);
    for (const x of [...gt.phantoms, ...gt.latePassages]) {
      byClass.set(x.klass, (byClass.get(x.klass) || 0) + 1);
      if (!x.accepted) reds.push({ id: run.job.id, x });
    }
    // HINKDIFFEN mot appserien: nyckeln är varningens identitet, inte dess
    // ordning (en varning kan byta plats mellan serierna).
    const keyOf = (e) => `${e.warning.eventId}|${e.warning.t}|${e.warning.leadMmsi}`;
    const appLabels = new Map(((run.o2App && run.o2App.byWarning) || []).map((e) => [keyOf(e), e]));
    for (const e of gt.byWarning) {
      const a = appLabels.get(keyOf(e));
      if (!a || a.hink === e.hink) continue;
      const k = `${a.hink}→${e.hink}`;
      switches.set(k, (switches.get(k) || 0) + 1);
      // FARLIGT håll: appen sade att öppningen kom INOM kontraktsfönstret,
      // rådatan säger något svagare. INFERRERAD_TID räknas INTE hit — där är
      // korsningen bevisad och bara tidpunkten okänd, dvs. ett OMÄTBART fall,
      // inte ett motsägande. Räknas den som farlig får man i dag 18 falsklarm
      // i stället för det enda äkta (JAATTEN II @ Stridsbergsbron), precis den
      // förorening villkor (a) finns för att undvika.
      if (a.hink === 'BEKRÄFTAD' && (e.hink === 'FANTOM' || e.hink === 'SEN_PASSAGE')) {
        dangerous.push({ id: run.job.id, e, from: a.hink });
      }
    }
    rows.push({
      id: run.job.id,
      detail: `${gt.confirmed} bekräftade ≤20 min, ${gt.latePassages.length} sena passager, `
        + `${gt.phantoms.length} utan passage, ${gt.inferredTime.length} inferrerade (utan hink) `
        + `av ${warnings} varningar`,
    });
  }
  for (const r of rows) console.log(`  ℹ️ ${r.id.padEnd(26)} ${r.detail}`);
  console.log('');
  console.log(`  SUMMA (rådataserien): ${confirmedTot}/${warningsTot} varningar bekräftade inom 20 min, `
    + `${lateTot} bekräftade senare, ${phantomTot} utan passage, ${inferredTot} utan mätbar hink `
    + '(`inferred`: korsning bevisad, tidpunkt = fönster)');
  if (delays.length) {
    const sorted = [...delays].sort((a, b) => a - b);
    console.log(`  SENA PASSAGER: median ${mins(median(delays))}, max ${mins(sorted[sorted.length - 1])}`);
  }
  if (byClass.size) {
    console.log(`  FANTOMKLASSER: ${[...byClass].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  const switchTot = [...switches.values()].reduce((a, b) => a + b, 0);
  console.log(`  HINKBYTEN mot O2 (appserien): ${switchTot} av ${warningsTot} varningar`
    + `${switchTot ? ` — ${[...switches].map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
  for (const d of dangerous) {
    console.log(`     • FARLIGT HÅLL ${d.id} — ${d.e.warning.bridge} ${d.e.warning.iso} `
      + `(ledande ${d.e.warning.leadVessel}/${d.e.warning.leadMmsi}): appserien ${d.from}, `
      + `rådataserien ${d.e.hink}${d.e.klass && d.e.klass !== d.e.hink ? ` (${d.e.klass})` : ''}`);
  }
  for (const r of reds) {
    console.log(`  ℹ️ RÖD I RÅDATASERIEN ${r.id} — ${r.x.warning.bridge} ${r.x.warning.iso} `
      + `(ledande ${r.x.warning.leadVessel}/${r.x.warning.leadMmsi})`);
    console.log(`      klass: ${r.x.klass}`);
    console.log(`      bevis: ${r.x.bevis}`);
  }
  console.log('  ℹ️ INFORMATIV: O2b ändrar INTE exitkoden i den här etappen — grinden ligger kvar på '
    + 'appserien (O2). OPENING_GT_STRICT flyttar den hit först när fas C är klar, likadant som O1b.');
  console.log('');
}

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
  // A9a: utslag från OLÅSTA korpusar fäller inte grinden — de bokförs här och
  // skrivs ut som egen slutrad. `gateFail` är den ENDA vägen ett korpusutslag
  // får sätta `failed`, så doktrinen kan inte glida isär rad för rad igen.
  const unlockedFindings = [];
  const gateFail = (job, what) => {
    if (job && job.locked === false) unlockedFindings.push(`${job.id}: ${what}`);
    else failed = true;
  };
  const tagFor = (job) => (job && job.locked === false ? 'ℹ️ OLÅST' : '❌');

  // ---- O1 ----------------------------------------------------------------
  console.log('--- O1: ÖPPNINGSTÄCKNING (varje målbropassage ska ha en varning FÖRE) ---\n');
  const o1Rows = [];
  const allLeads = [];
  const missByClass = new Map();
  let totalPassages = 0;
  let totalCovered = 0;
  let thinLeads = 0;
  // A3: rådataserien bokförs parallellt med appserien. GRINDEN ligger kvar på
  // appserien i fas A (planens "instrument före produkt" — fas A får inte
  // ändra utfallet av någon grind); OPENING_GT_STRICT=1 flyttar den till
  // rådataserien när fas C har åtgärdat fyndlistan.
  const gtTotals = {
    passages: 0,
    covered: 0,
    inferred: 0,
    misses: 0,
    unclassified: 0,
    uncertain: 0,
    detected: 0,
    undetectedInferred: 0,
    corpora: 0,
  };
  const gtLeads = [];
  const gtMissByClass = new Map();
  // De normalsamplade passager appen ALDRIG bokförde — fyndklassen (till
  // skillnad från `inferred`, där källan var tyst och appen inte KUNDE se dem).
  const gtUndetectedNormal = [];

  for (const run of runs) {
    if (run.error) {
      // KRASCH är fatal även för en OLÅST korpus: en jsonl som inte går att
      // replaya är ett harness-/datafel, inte ett beteendeutslag.
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
    if (unclassified.length) gateFail(run.job, `${unclassified.length} oklassad(e) O1-miss(ar)`);
    for (const m of misses) missByClass.set(m.klass, (missByClass.get(m.klass) || 0) + 1);

    // ---- A3: SAMMA MÄTNING MOT RÅDATAFACIT ----------------------------------
    const gtPassages = gtTargetPassages(run.job);
    run.gt = null;
    // S14: O2b kör SAMMA facitserie som O1b — den plockas en gång här.
    run.gtPassages = gtPassages;
    if (gtPassages) {
      const g = analyseCoverage(run.result, samples, gtPassages);
      run.gt = g;
      gtTotals.corpora++;
      gtTotals.passages += g.passages.length;
      gtTotals.covered += g.covered.length;
      gtTotals.inferred += g.passages.filter((p) => p.inferred).length;
      gtTotals.misses += g.misses.length;
      gtTotals.unclassified += g.misses.filter((m) => !m.accepted).length;
      gtTotals.uncertain += g.uncertain.length;
      // TIDSFÖNSTERMÄTNINGEN utesluter `inferred` (planens A3(b)).
      for (const c of g.covered) if (!c.passage.inferred) gtLeads.push(c.leadMs);
      for (const m of g.misses) gtMissByClass.set(m.klass, (gtMissByClass.get(m.klass) || 0) + 1);
      // DETEKTIONSGRAD (A3(c), separat serie): hur många av rådatans passager
      // registrerade appen själv? Matchning: samma mmsi + bro, appens tid
      // inom rådatans tidsfönster ± ett konvojfönster (rastrering + appens
      // egen fördröjning mellan korsning och registrering).
      // UNIONEN target ∪ intermediate: en målbrokorsning som bokförts som
      // INTERMEDIATE (mållös båt, U-svängskorrigerad resa — INV-13:s klass) ÄR
      // detekterad. Räknas bara den ena listan blir detektionsgraden konstlat
      // låg och fyndlistan förorenad med designenliga förlopp.
      const appP = [...(run.result.targetPassages || []), ...(run.result.intermediatePassages || [])];
      for (const p of g.passages) {
        const from = (p.tFrom ?? p.t) - BRIDGE_OPENING.CONVOY_WINDOW_MS;
        const to = (p.tTo ?? p.t) + BRIDGE_OPENING.CONVOY_WINDOW_MS;
        if (appP.some((a) => String(a.mmsi) === p.mmsi && a.bridge === p.bridge
          && a.t >= from && a.t <= to)) gtTotals.detected++;
        else if (p.inferred) gtTotals.undetectedInferred++;
        else gtUndetectedNormal.push({ id: run.job.id, p });
      }
    }

    const byFired = (run.result.openingWarnings || []).reduce((acc, w) => {
      acc[w.firedBy || 'okänd'] = (acc[w.firedBy || 'okänd'] || 0) + 1;
      return acc;
    }, {});
    // LEVERANSKONTROLL: servicen avfyrade N gånger, kortet fick M. Skillnaden
    // är alltid en bugg i app.js avfyrningsväg (dedup som spärrar fel, saknat
    // kort, kastande tokenbygge) — och den är osynlig för både täcknings- och
    // fantomanalysen, som bara ser det kortet fick.
    for (const problem of openingDeliveryFailures(run.result)) {
      gateFail(run.job, problem);
      console.log(`  ${tagFor(run.job)} ${run.job.id}: ${problem}`);
    }
    // Armarna får aldrig överleva efterspelet (ARM_STALE_TTL 30 min < 40 min).
    const leaks = run.result.leakDiagnostics || {};
    if (Number.isFinite(leaks.openingArms) && leaks.openingArms !== 0) {
      gateFail(run.job, `ÖPPNINGSLÄCKA ${leaks.openingArms} armar`);
      console.log(`  ${tagFor(run.job)} ÖPPNINGSLÄCKA ${run.job.id}: ${leaks.openingArms} armar kvar efter efterspelet`);
    }
    const badWarnings = (run.result.openingWarnings || []).filter((w) => w.success === false);
    if (badWarnings.length) {
      gateFail(run.job, `ÖPPNINGSVARNING KASTADE: ${badWarnings[0].error}`);
      console.log(`  ${tagFor(run.job)} ÖPPNINGSVARNING KASTADE ${run.job.id}: ${badWarnings[0].error}`);
    }
    // AVFYRNINGSFÖNSTRET: TICK-RASTRERING (tappat/strypt tick) plus den
    // negativa vakten på due-filtret. Den mäter INTE ledtid — se docblocket
    // vid FIRE_WINDOW_SLACK_MS för mutationsbeviset och för varför
    // originalDueMs inte får bytas in här.
    const badFire = analyseFireWindow(run.result);
    if (badFire.length) {
      gateFail(run.job, `${badFire.length} avfyrningsfönsterbrott`);
      for (const b of badFire) {
        console.log(`  ${tagFor(run.job)} AVFYRNINGSFÖNSTER ${run.job.id}: ${b.w.bridge} ${b.w.iso} `
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
      gateFail(run.job, `${tooLate.length} varning(ar) under ledtidsgolvet`);
      for (const c of tooLate) {
        console.log(`  ${tagFor(run.job)} LEDTIDSGOLV ${run.job.id}: ${c.passage.mmsi} @ ${c.passage.bridge} `
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
    if (unclassified.length) o1Status = `${tagFor(run.job)} OKLASSAD MISS`;
    else if (misses.length) o1Status = '⚠️ KLASSAD MISS';
    o1Rows.push({
      id: run.job.id,
      status: o1Status,
      gt: run.gt
        ? `${run.gt.covered.length}/${run.gt.passages.length}`
        : 'gt saknas',
      detail: `${covered.length}/${passages.length} passager varnade`
        + `${convoyCovered ? ` (varav ${convoyCovered} via konvoj)` : ''}`
        + `, ledtid median ${leads.length ? mins(median(leads)) : '—'} / min ${leads.length ? mins(Math.min(...leads)) : '—'}`
        + `, varningar=${(run.result.openingWarnings || []).length}`
        + ` (fix ${byFired.fix || 0} / deadline ${byFired.deadline || 0})`,
    });

    for (const m of misses) {
      const tag = m.accepted ? 'ℹ️ KLASSAD MISS ' : `${tagFor(run.job)} OKLASSAD MISS`;
      console.log(`  ${tag} ${run.job.id} — ${m.passage.mmsi} @ ${m.passage.bridge} ${m.passage.iso}`);
      console.log(`      klass: ${m.klass}`);
      console.log(`      bevis: ${m.bevis}`);
    }
  }
  for (const r of o1Rows) {
    console.log(`  ${r.status.padEnd(18)} ${r.id.padEnd(26)} ${r.detail}`
      + `${r.gt ? ` | rådatafacit ${r.gt}` : ''}`);
  }
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

  // ---- A3: RÅDATASERIEN (separat rapporterad, planens A3(c)) --------------
  if (gtTotals.corpora === 0) {
    console.log('  ⚠️ RÅDATAFACIT SAKNAS för samtliga korpusar — kör '
      + '`node tests/replay-validation/makeGtPassages.js` (A2). Serien ovan mäter appen mot appen.\n');
  } else {
    const gtStrict = process.env.OPENING_GT_STRICT === '1';
    console.log('--- O1b: TÄCKNING MOT RÅDATAFACIT (A2) — appens egna passager är INTE sanningen ---\n');
    console.log(`  TÄCKNING: ${gtTotals.covered}/${gtTotals.passages} rådataverifierade målbropassager `
      + `varnade (${gtTotals.passages ? ((100 * gtTotals.covered) / gtTotals.passages).toFixed(1) : '0'} %) `
      + `i ${gtTotals.corpora} korpusar; ${gtTotals.inferred} av nämnaren är \`inferred\` `
      + '(korsning bevisad, tidpunkt = fönster)');
    console.log(`  DETEKTIONSGRAD I PASSAGELOGGAR: ${gtTotals.detected}/${gtTotals.passages} `
      + `(${gtTotals.passages ? ((100 * gtTotals.detected) / gtTotals.passages).toFixed(1) : '0'} %) — `
      + `${gtTotals.passages - gtTotals.detected} saknar matchande mål-/mellanbropost. `
      + 'Efterhandsnotiser via passage-fallback ingår inte i detta mått.');
    console.log(`     Saknade poster: ${gtTotals.undetectedInferred} märkta \`inferred\` i facit och `
      + `${gtTotals.passages - gtTotals.detected - gtTotals.undetectedInferred} utan den märkningen. `
      + 'Äldre omärkta facitposter kan också vara interpolerade; rådatagranskning krävs.');
    for (const u of gtUndetectedNormal) {
      console.log(`     • ${u.id} — ${u.p.mmsi} @ ${u.p.bridge} ${u.p.iso} (rådatakorsning utan `
        + 'TARGET/INTERMEDIATE_PASSAGE_RECORDED i appen)');
    }
    if (gtLeads.length) {
      const s = [...gtLeads].sort((a, b) => a - b);
      console.log(`  LEDTID (endast icke-inferred, ${gtLeads.length} poster): median ${mins(median(gtLeads))}, `
        + `min ${mins(s[0])}, p10 ${mins(s[Math.floor(s.length * 0.1)])}, max ${mins(s[s.length - 1])}`);
    }
    if (gtMissByClass.size) {
      console.log(`  MISSKLASSER: ${[...gtMissByClass].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    for (const run of runs) {
      for (const p of run.gtPassages || []) {
        if (!p.timingEvidence) continue;
        const e = p.timingEvidence;
        console.log(`  KOMPLETTERAT RÅDATABEVIS: ${run.job.id} — ${p.mmsi} @ ${p.bridge}: `
          + `${iso(e.originalFrom)}–${iso(e.originalTo)} snävas till ${iso(p.tFrom)}–${iso(p.tTo)} `
          + `med observationstider från ${e.source.feed}; appens replayindata är oförändrade.`);
      }
    }
    if (gtTotals.uncertain) {
      console.log(`  TIDPUNKT_OKÄND: ${gtTotals.uncertain} varning(ar) ligger inne i ett AIS-glapp med `
        + 'bevisad korsning. De räknas varken som säker förvarning eller som bevisad miss.');
      for (const run of runs) {
        for (const u of run.gt?.uncertain || []) {
          console.log(`     ${run.job.id} — ${u.passage.mmsi} @ ${u.passage.bridge}: ${u.bevis}`);
        }
      }
      // Ett strikt certifieringsläge får inte bli grönt genom att räkna
      // okända tidpunkter som godkända förvarningar.
      if (gtStrict) failed = true;
    }
    if (gtTotals.unclassified) {
      console.log(`  ${gtStrict ? '❌' : 'ℹ️'} ${gtTotals.unclassified} OKLASSAD(E) MISS(AR) i rådataserien `
        + `${gtStrict ? '— GRINDEN ÄR RÖD' : '— fyndlista för fas C (grinden ligger kvar på appserien i fas A; '
          + 'OPENING_GT_STRICT=1 flyttar den hit)'}`);
      for (const run of runs) {
        if (!run.gt) continue;
        for (const m of run.gt.misses.filter((x) => !x.accepted)) {
          console.log(`     ${run.job.id} — ${m.passage.mmsi} @ ${m.passage.bridge} ${m.passage.iso}`
            + `${m.passage.inferred ? ' [inferred]' : ''}: ${m.bevis}`);
        }
      }
      if (gtStrict) failed = true;
    }
    console.log('');
  }

  // ---- A8(iii): SISTA-PÅMINNELSE-SERIEN -----------------------------------
  reportReminderSeries(runs);

  // ---- H-4b: ÖPPNINGSLIGGAREN (0-räknaren) --------------------------------
  reportOpeningLedger(runs);

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
    const appSeries = analysePhantoms(run.result, run.analysis.samples);
    // S14: etiketterna sparas så O2b kan diffa hinkarna mot appserien.
    run.o2App = appSeries;
    const { confirmed, latePassages, phantoms } = appSeries;
    const warnings = (run.result.openingWarnings || []).length;
    totalWarnings += warnings;
    totalConfirmed += confirmed;
    totalLate += latePassages.length;
    for (const l of latePassages) allDelays.push(l.delayMs);
    const red = phantoms.filter((p) => !p.accepted);
    const redLate = latePassages.filter((l) => !l.accepted);
    if (red.length || redLate.length) gateFail(run.job, `${red.length} röd(a) fantom(er) + ${redLate.length} röd(a) sen(a) passage(r)`);
    for (const p of phantoms) phantomByClass.set(p.klass, (phantomByClass.get(p.klass) || 0) + 1);
    for (const l of latePassages) phantomByClass.set(l.klass, (phantomByClass.get(l.klass) || 0) + 1);

    let o2Status = '✅ INGA FANTOMER';
    if (red.length || redLate.length) o2Status = `${tagFor(run.job)} RÖD FANTOM`;
    else if (phantoms.length) o2Status = '⚠️ ACCEPTERADE';
    o2Rows.push({
      id: run.job.id,
      status: o2Status,
      detail: `${confirmed} bekräftade ≤20 min, ${latePassages.length} sena passager `
        + `(${redLate.length} röda), ${phantoms.length} utan passage (${red.length} röda) `
        + `av ${warnings} varningar`,
    });
    for (const p of phantoms) {
      const tag = p.accepted ? 'ℹ️ ACCEPTERAD  ' : `${tagFor(run.job)} RÖD FANTOM  `;
      console.log(`  ${tag} ${run.job.id} — ${p.warning.bridge} ${p.warning.iso} `
        + `(ledande ${p.warning.leadVessel}/${p.warning.leadMmsi}, d=${p.warning.distance} m, ${p.warning.firedBy})`);
      console.log(`      klass: ${p.klass}`);
      console.log(`      bevis: ${p.bevis}`);
    }
    // SENA PASSAGER klassas nu MOT RÅDATA (kontraktets O2). Bara de RÖDA
    // skrivs ut i sin helhet; de accepterade summeras i klasstabellen.
    for (const l of redLate) {
      console.log(`  ${tagFor(run.job)} RÖD SEN     ${run.job.id} — ${l.warning.bridge} ${l.warning.iso} `
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

  // ---- O2b: SAMMA FANTOMMÄTNING MOT RÅDATAFACIT (S14) ---------------------
  reportGtPhantoms(runs);

  // ---- A9a: OLÅSTA KORPUSARS FYND ----------------------------------------
  // De fäller inte grinden, men de får inte heller försvinna i logglängden.
  // Raden är fyndlistan för den korpus som väntar på skarp låsning.
  if (unlockedFindings.length) {
    console.log(`--- OLÅSTA KORPUSAR: ${unlockedFindings.length} utslag (INFORMATIVA — fäller inte grinden) ---\n`);
    for (const f of unlockedFindings) console.log(`  ℹ️ ${f}`);
    console.log('\n  Dessa MÅSTE vara åtgärdade eller bära rådataverifierad motivering '
      + 'innan korpusen sätts locked: true.\n');
  }

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
  console.log('✅ Standardgrindarna för öppningar godkända: appserien klassad, inga kajvobbel-fantomer, natten intakt.');
  if (gtTotals.unclassified || gtTotals.uncertain) {
    console.log(`⚠️ Rådatafacit är inte fullt godkänt: ${gtTotals.unclassified} oklassade missar `
      + `och ${gtTotals.uncertain} varningar med okänd ordning mot passagen kvarstår (se ovan).`);
  }
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
  gtTargetPassages,
  classifyMiss,
  stillnessStay,
  classifyPhantom,
  classifyLatePassage,
  approachEvidence,
  analyseCoverage,
  analysePhantoms,
  reportGtPhantoms,
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
