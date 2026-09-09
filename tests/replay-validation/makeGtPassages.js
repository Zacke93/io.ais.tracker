'use strict';

/**
 * RÅDATAFACIT-GENERATORN (etapp 7, fas A2 — 2026-08-08).
 *
 * Frågan den besvarar: NÄR passerade fartyget bron — enligt RÅDATAN, inte
 * enligt appen? Hela regressionsskyddet har hittills mätt öppningstäckning
 * (O1), INV-5/7/13/21 m.fl. mot appens EGNA passageregistreringar. 42h-
 * fältprovet visade att den mätningen är cirkulär: appen registrerade 96 av
 * 107 verkliga målbropassager, och grindarna var blinda för exakt samma 10 %
 * som appen — blindheterna är KORRELERADE, inte oberoende. En korsvalidering
 * mellan två blinda mätare ser falskt bekräftande ut.
 *
 * Utdata: tests/replay-validation/gt-passages/<korpusid>.json, ett fält per
 * korsning (samma nyckeluppsättning som night-facit/gt-passages.json, plus de
 * fält fältprovet krävde). Filerna checkas in och granskas manuellt — de ÄR
 * facit, inte en cache.
 *
 * ── GEOMETRIN (fyra skärpningar ur fältprovet, planens A2-avsnitt) ──────────
 *
 * (i)  TECKENBYTE OAVSETT GAP. Den gamla metoden filtrerade bort sampelpar med
 *      > 900 s mellanrum. Det fällde 12 ÄKTA korsningar i 42h-korpusen — t.ex.
 *      NIGE-O, som 09:24:09 låg norr om Stridsbergsbron och 12:28:24 söder om
 *      Klaffbron. Farleden är SLUTEN: tre broar MÅSTE ha passerats. Sådana
 *      korsningar räknas nu, men märks `inferred` och bär ett TIDSFÖNSTER
 *      (tFrom/tTo) i stället för en punktstämpel — tiden är okänd inom
 *      fönstret, och den som mäter förvarningsmarginaler måste utesluta dem
 *      (A3 gör det; skillnaden mellan serierna ÄR källtystnadsmåttet).
 *
 * (ii) AVSTÅND TILL FARLEDSPOLYLINJEN, inte till grannbrons korda. Kordan
 *      mellan två brokoordinater är 17–18° fel vid Olidebron och Klaffbron.
 *      Här projiceras varje fix på farledens centerlinje (coverageMap.js, 36
 *      noder, härledd ur korpusarna själva) → s = meter längs farleden.
 *      Korsning = teckenbyte i (s − s_bro). Sidledsavståndet grindar BÅDA
 *      sampelpunkterna; den interpolerade korsningspunkten ligger per
 *      konstruktion PÅ linjen (offset 0), så den gamla fällan "kasta bort
 *      korsningen för att mittpunkten hamnade 161 m vid sidan" kan inte uppstå.
 *
 * (iii) RÖRELSEGRIND VID KANALINFARTEN + `inside` FRÅN FÖRSTA SAMPLET.
 *      ELFKUNGENs kajplats ligger PÅ 300 m-gränsen (317 av 326 stillaliggande
 *      sampel i bandet 295–305 m) ⇒ 20 av 42 "intrång" i dirigentens facit var
 *      GPS-brus. Och eftersom `inside` initierades till null var facitet blint
 *      för vistelser som PÅGICK vid korpusstart (VALKYRIA, UTOPIA).
 *
 * (iv) ALDRIG `BRIDGES`-KOORDINATEN FÖR GEOMETRI. Broarnas lägen ligger FRUSNA
 *      här, som stationer längs farleden (se BRIDGE_STATIONS). Läser facit
 *      konstanterna i drift ärver det varje koordinatfel de bär, och en
 *      koordinatändring skriver om facit i samma andetag som den ska prövas
 *      MOT facit (mätt på den gamla metoden: 137→136 korsningar, tidsskift
 *      −62…+44 s, Stridsbergs axel roterar 3,66°).
 *      C0 2026-08-10: Stallbackabrons station räknades om ändå — inte för att
 *      konstanten flyttade, utan för att det frusna talet självt var härlett
 *      ur C0-planens SEDAN FALSIFIERADE mål. Se BRIDGE_STATIONS. Det är den
 *      enda tillåtna anledningen att röra listan: att talet var fel.
 *
 * KLOCKDOMÄNEN: `t` ligger i LEVERANSDOMÄNEN (`aisTimestamp`) — samma tidslinje
 * som replay-harnessens fejkklocka driver, så gt-tider och appens egna
 * händelser är direkt jämförbara. `tFix` ger samma korsning i FIXDOMÄNEN
 * (`fixTs ?? aisTimestamp`, "när båten faktiskt var där") för den som mäter
 * källfärskhet. Blanda dem aldrig i samma mätning.
 *
 * Körning (från io.ais.tracker/):
 *   node tests/replay-validation/makeGtPassages.js                 # alla korpusar
 *   node tests/replay-validation/makeGtPassages.js --corpus 20260806-42h
 *   node tests/replay-validation/makeGtPassages.js --jsonl x.jsonl --id egen
 *   node tests/replay-validation/makeGtPassages.js --check         # incheckat == genererat
 *   node tests/replay-validation/makeGtPassages.js --audit 20260806-42h --samples 3
 *   node tests/replay-validation/makeGtPassages.js --compare <fil.json> --corpus <id>
 *   node tests/replay-validation/makeGtPassages.js --anchor-check  # diagnos mot BRIDGES
 */

const fs = require('fs');
const path = require('path');
const { calculateDistance } = require('../../lib/utils/geometry');
const { FAIRWAY_CENTERLINE } = require('./coverageMap');
const corpora = require('./corpora');

// =============================================================================
// KONSTANTER — HÄRLEDDA, INTE VALDA
// =============================================================================

/**
 * BROARNAS STATIONER LÄNGS FARLEDEN (meter från centerlinjens sydspets).
 *
 * FRUSNA MED FLIT (krav iv). Härledda EN gång 2026-08-08 genom att skära varje
 * bros axel (axisBearing, samma modell som geometry.hasCrossedBridgeLine) mot
 * FAIRWAY_CENTERLINE. Sidledsavståndet mellan brokoordinat och farled blev
 * 4–11 m för de fyra broar vars koordinater är verifierade sedan flera
 * granskningar — polylinjen och brokoordinaterna är alltså samma verklighet.
 *
 * STALLBACKABRON är undantaget och skälet till att listan är frusen. Talet
 * stod tidigare på 5948,8 m, härlett ur C0-planens dåvarande mål
 * lon 12.317971 — ett mål som den oberoende koordinatverifieringen 2026-08-10
 * FALSIFIERADE (det låg 159,8 m från brolinjen, dvs. AV bron). Stationen är
 * därför omräknad 2026-08-10 mot den LANDADE konsensuspunkten:
 *   - gammal konstant (lon 12.31456…, axis 125) → station 5832,9 m, 186 m VID
 *     SIDAN av farleden (koordinaten pekade på mittspannet, inte underfarten);
 *   - falsifierat C0-mål (lon 12.317971, axis 125) → station 5948,8 m;
 *   - LANDAD konsensuspunkt (58.309802 / 12.316748, axis 142) → 5762,0 m,
 *     14 m från farleden — samma metod, samma polylinje, rätt punkt.
 * Kontroll: stationsavstånden blir 1379 / 970 / 256 / 2237 m mot BRIDGE_GAPS
 * 1363 / 960 / 257 / 2226 — samtliga fyra stämmer nu på ≤ 1,2 %, mot tre av
 * fyra före omräkningen. Facit förblir immunt mot framtida koordinatändringar:
 * stationen är ett TAL här, inte ett uppslag i BRIDGES.
 *
 * `node makeGtPassages.js --anchor-check` skriver ut differensen mot vad
 * BRIDGES säger just nu (ren diagnostik — påverkar aldrig facit).
 */
const BRIDGE_STATIONS = [
  { id: 'olidebron', name: 'Olidebron', s: 919.1 },
  { id: 'klaffbron', name: 'Klaffbron', s: 2298.4 },
  { id: 'jarnvagsbron', name: 'Järnvägsbron', s: 3268.4 },
  { id: 'stridsbergsbron', name: 'Stridsbergsbron', s: 3524.8 },
  // C0 2026-08-10 (se docblocket ovan): 5948,8 → 5762,0.
  { id: 'stallbackabron', name: 'Stallbackabron', s: 5762.0 },
];

/**
 * KANALINFARTEN är ingen bro utan en TRIGGERPUNKT med radie — appens notis
 * utlöses av att båten kommer innanför cirkeln, inte av en linjekorsning. Den
 * dimensionen modelleras därför som zonbesök. Koordinaten är frusen av samma
 * skäl som stationerna ovan (den ligger i TRIGGER_POINTS, som C0 inte rör, men
 * en generator som läser konstanter i drift är per definition inte immun).
 * Värdena är byte-identiska med TRIGGER_POINTS.kanalinfarten 2026-08-08.
 */
const KANALINFARTEN = {
  id: 'kanalinfarten',
  name: 'Kanalinfarten',
  lat: 58.26800304269953,
  lon: 12.26936457556289,
  radiusM: 300,
};

/**
 * SIDLEDSGRIND (m från farledens centerlinje), krav (ii): BÅDA sampelpunkterna
 * i det korsande paret måste ligga innanför. Mätt över samtliga 18 korpusar är
 * det största sidledsavståndet i ett korsande par 206 m (VIRGO 2026-07-10, kaj
 * norr om Stallbackabron), p50 = 14 m och p90 = 45 m; i 42h-korpusen är max
 * 38 m. 250 m ger alltså ~20 % marginal till det bredaste ÄKTA fallet och
 * ligger ändå innanför broarnas egen detektionsradie (300 m). Grindens uppgift
 * är inte att trimma bort transiter utan att hindra att en båt som ligger
 * långt UTANFÖR farleden (gästhamn, ankarplats) får sin projektion att vandra
 * över en brostation.
 */
const FAIRWAY_MAX_OFFSET_M = 250;

/**
 * DÖDBAND (m längs farleden). En korsning bokförs först när fartyget varit
 * BESLUTSAMT på ena sidan och sedan beslutsamt på den andra. Utan dödbandet
 * skulle en förtöjd båt vars projektion råkar ligga på en station generera en
 * korsning per GPS-vobbel. 50 m = MOORING_DETECTION.MOVEMENT_PROOF_NET_M, dvs.
 * appens EGEN gräns för "har rört sig" (och 10 m över NULL_SOG_STILL_RADIUS_M,
 * vobbelradien för fartgivarlösa). Kontroll: den kortaste ÄKTA korsningsstegen
 * över alla korpusar är 34 m (ANDREA @ Stridsbergsbron, 1 kn efter 98 min
 * väntan) — dödbandet mäts mot HELA spåret, inte mot det enskilda steget, så
 * den korsningen bokförs ändå.
 */
const DECISIVE_SIDE_M = 50;

/**
 * HOPPVAKT (kn). Ett sampelpar som implicerar högre fart än så är ett GPS-hopp,
 * inte en färd, och får inte bokföras som korsning. Samma värde och samma
 * härledning som coverageMap.MAX_IMPLIED_KN: kanalens snabbaste observerade fix
 * ligger på 33,2 kn (en RIB), så 40 kn släpper igenom all verklig trafik.
 */
const MAX_IMPLIED_KN = 40;

/**
 * GRÄNS FÖR `inferred` (s). Över detta glapp är KORSNINGEN säker (teckenbytet
 * är geometriskt bevisat) men TIDPUNKTEN bara ett intervall. 900 s är den
 * gamla metodens filtergräns — behållen som märkning i stället för bortval, så
 * diffen mot det gamla facitet blir exakt tolkbar — och ligger ~1,7× över p90
 * för glappet mellan två fixar i rörelse (531 s, coverageMap).
 */
const INFERRED_GAP_S = 900;

// P9 (fältprov 11): PHOENIX stod stilla vid ena ändpunkten av ett 721 s
// korsningsglapp. Konstant fart ger då en påhittad punktstämpel. Vid glesa
// par (> 120 s) med stillhet (< 0,5 kn) i NÅGON ändpunkt vet vi inte när
// väntan/accelerationen låg: behåll korsningen, men mät bara tidsfönstret.
// 120 s begränsar det korta undantagets hela tidsosäkerhet till ETA-mätarens
// befintliga tvåminutersband. Tät korsning behåller därför punktstämpeln;
// ett enskilt nollvärde kan då inte förskjuta sanningen mer än två minuter.
// Frusna mätkonstanter: facitet får inte ändras när produktens trösklar ändras.
const STOPPED_ENDPOINT_GAP_S = 120;
const STOPPED_ENDPOINT_SOG_KN = 0.5;

/**
 * RÖRELSEBEVIS FÖR ETT KANALINFARTS-BESÖK (krav iii). Ett besök räknas bara om
 * fartyget faktiskt FÄRDADES: någon fix ≥ 2 kn (coverageMap.TRANSIT_SOG_KN —
 * 62 % av alla fixar ligger på exakt 0 kn och ytterligare 12 % i 0–2 kn, dvs.
 * tröskeln skiljer transit från kajvobbel med bred marginal) ELLER en
 * nettoförflyttning ≥ 100 m under besöket (2× MOVEMENT_PROOF_NET_M — behövs för
 * de FARTGIVARLÖSA, som saknar sog helt). Mätt på 42h-korpusen: 47 råa besök →
 * 24 äkta; av dirigentens 42 (som saknade de fem vistelser som pågick vid
 * korpusstart) faller exakt 20, precis den GPS-brusandel fältprovet räknade
 * fram. Ingen ÄKTA transit ligger i marginalen: nettoförflyttningarna hoppar
 * från 72 m (redan tagen av sog-benet) till 197 m.
 */
const VISIT_TRANSIT_SOG_KN = 2;
const VISIT_TRACK_M = 100;

const M_PER_DEG_LAT = 111320;
const OUT_DIR = path.join(__dirname, 'gt-passages');
const INDEX_FILE = path.join(OUT_DIR, 'index.json');

/**
 * FÄLTKORPUSAR SOM ÄNNU INTE LIGGER I REPOT (A9 checkar in dem).
 * Uppslagsordningen är: (1) corpora.js — så fort A9 lagt in posten hittas
 * jsonl:en där och den här tabellen blir en no-op; (2) $GT_SOURCE_DIR;
 * (3) fältkörningens ursprungliga sökväg. Sista steget är MEDVETET en absolut
 * sökväg till en sessionsmapp: den dokumenterar var datan kom ifrån, och när
 * mappen är borta säger generatorn högt att källan saknas i stället för att
 * tyst hoppa över korpusen.
 */
const FIELD_SCRATCH = '/private/tmp/claude-502/-Users-Zamo0004-Library-CloudStorage-OneDrive-Privat-Bro-ppning-Homey-AIS-Tracker-VC-02/950893e7-b735-40d0-aacc-9258592a6fc1/scratchpad';
const EXTRA_CORPORA = [
  {
    id: '20260804-17h',
    files: ['ais-replay-20260804-17h.jsonl', 'day-aisstream.jsonl'],
    fallback: path.join(FIELD_SCRATCH, 'ab2', 'day-aisstream.jsonl'),
    note: 'A/B-dagskörningen 2026-08-04 (GO-beslutet), A-armen aisstream',
  },
  {
    id: '20260804-both-21h',
    files: ['ais-replay-20260804-both-21h.jsonl', 'both-day.jsonl'],
    fallback: path.join(FIELD_SCRATCH, 'both1', 'both-day.jsonl'),
    note: 'både-dygn 1 (2026-08-04/05), source=both',
  },
  {
    id: '20260806-42h',
    files: ['ais-replay-20260806-42h.jsonl', 'corpus.jsonl'],
    fallback: path.join(FIELD_SCRATCH, 'faltdygn3', 'corpus.jsonl'),
    note: '42h-fältprovet 2026-08-06/07 (korpus #18-kandidat)',
  },
];

/**
 * A/B-NATTEN ligger i corpora-data men saknar post i corpora.js (den körs av
 * runOpeningGates/runFusionCorpora direkt). Båda armarna får eget rådatafacit —
 * fusionsarmen är dessutom den enda tvåkälliga korpusen och därmed den enda
 * plats där fp/fq skiljer sig åt.
 */
const NIGHT_CORPORA = [
  { id: '20260803-natt', file: 'ais-fusion-20260803-nattkorning.jsonl' },
  { id: '20260803-natt-aisstream', file: 'ais-aisstream-20260803-nattkorning.jsonl' },
];

// =============================================================================
// 1. FARLEDSGEOMETRI (endast polylinjen — ingen brokoordinat)
// =============================================================================

/**
 * Bygg farledens segmentmodell ur centerlinjen.
 * @returns {{legs:object[], lengthM:number}} farled
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
  return { legs, lengthM: cum };
}

/**
 * Projicera en punkt på ett farledssegment. Samma ekvirektangulära matematik
 * som geometry.distancePointToSegmentM (och coverageMap.projectOnLeg) — här
 * behövs även parametern t för sträckan längs farleden.
 * @param {number} lat - latitud
 * @param {number} lon - longitud
 * @param {object} leg - segment
 * @param {number} tMin - lägsta t (< 0 förlänger segmentet bakåt)
 * @param {number} tMax - högsta t (> 1 förlänger segmentet framåt)
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
 * Projicera en fix på farleden. Terminalsegmenten förlängs (samma val som
 * coverageMap) så att fixar utanför kartänden får ett vettigt s i stället för
 * att klampas ihop på kanten — annars hade en båt norr om Stallbackabron
 * fastnat exakt på stationen och vobblat över den.
 * @param {object} fairway - farledsmodellen
 * @param {number} lat - latitud
 * @param {number} lon - longitud
 * @returns {{s:number, offsetM:number}} projektion
 */
function projectFix(fairway, lat, lon) {
  let best = null;
  const last = fairway.legs.length - 1;
  for (const leg of fairway.legs) {
    const tMin = leg.index === 0 ? -2 : 0;
    const tMax = leg.index === last ? 3 : 1;
    const p = projectOnLeg(lat, lon, leg, tMin, tMax);
    if (!best || p.offsetM < best.offsetM) {
      best = { s: leg.cum + (p.t * leg.len), offsetM: p.offsetM };
    }
  }
  return best;
}

// =============================================================================
// 2. INLÄSNING
// =============================================================================

/**
 * Läs en korpus-jsonl till normaliserade sampel.
 *
 * DETERMINISM: sorteringen är (aisTimestamp, radnummer) — radnumret bryter
 * lika tider så att två körningar av samma fil ger samma ordning. Rader utan
 * position (ctrl-sampel, statiska namnrapporter) hoppas.
 * @param {string} file - sökväg till jsonl
 * @returns {object[]} sampel
 */
function loadSamples(file) {
  const rows = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (e) {
      throw new Error(`Trasig JSON på rad ${i + 1} i ${path.basename(file)}: ${e.message}`);
    }
    if (r.ctrl) continue;
    if (typeof r.lat !== 'number' || typeof r.lon !== 'number') continue;
    if (!Number.isFinite(r.aisTimestamp)) continue;
    rows.push({
      line: i + 1,
      mmsi: String(r.mmsi),
      name: typeof r.shipName === 'string' ? r.shipName.trim() : '',
      lat: r.lat,
      lon: r.lon,
      sog: Number.isFinite(r.sog) ? r.sog : null,
      t: r.aisTimestamp,
      // Etapp 0-konventionen (replayRunner:389): korpusar utan fälten får
      // fixTs = aisTimestamp och feed 'aisstream'. Samma default här, annars
      // hade fp/fq blivit null för de 15 låsta korpusarna.
      tFix: Number.isFinite(r.fixTs) ? r.fixTs : r.aisTimestamp,
      feed: r.feed || 'aisstream',
    });
  }
  rows.sort((a, b) => (a.t - b.t) || (a.line - b.line));
  return rows;
}

/**
 * Namnet fartyget bär vid en given tidpunkt: senaste riktiga namnet på eller
 * före tiden, annars det första riktiga namn strömmen någonsin visar, annars
 * 'Unknown'. (Samma princip som appens namncache — ett 'Unknown' i ett enskilt
 * sampel får inte döpa om en korsning.)
 * @param {object[]} list - fartygets sampel i tidsordning
 * @param {number} t - tidpunkt
 * @returns {string} namn
 */
function nameAt(list, t) {
  let best = null;
  let firstReal = null;
  for (const s of list) {
    if (!s.name || s.name === 'Unknown') continue;
    if (firstReal === null) firstReal = s.name;
    if (s.t <= t) best = s.name;
  }
  return best || firstReal || 'Unknown';
}

// =============================================================================
// 3. KORSNINGSDETEKTERING
// =============================================================================

/**
 * Linjär interpolation av korsningen mellan två sampel.
 * @param {object} p - tidigare sampel (med s)
 * @param {object} q - senare sampel (med s)
 * @param {number} sBridge - brostationen
 * @returns {{t:number, tFix:number, frac:number}} korsningen
 */
function interpolate(p, q, sBridge) {
  const span = q.s - p.s;
  const frac = span === 0 ? 0 : (sBridge - p.s) / span;
  return {
    t: p.t + (frac * (q.t - p.t)),
    tFix: p.tFix + (frac * (q.tFix - p.tFix)),
    frac,
  };
}

/**
 * Bokför en korsning ur ett straddle-par.
 * @param {object} station - brostationen
 * @param {object} p - sampel före
 * @param {object} q - sampel efter
 * @param {object[]} list - fartygets sampel (för namnet)
 * @returns {object} facitpost
 */
function makeCrossing(station, p, q, list) {
  const cross = interpolate(p, q, station.s);
  const gapS = Math.round((q.t - p.t) / 1000);
  const stoppedEndpoint = [p, q].some((s) => Number.isFinite(s.sog)
    && s.sog >= 0 && s.sog < STOPPED_ENDPOINT_SOG_KN);
  const sparseStop = (q.t - p.t) / 1000 > STOPPED_ENDPOINT_GAP_S && stoppedEndpoint;
  const inferred = gapS > INFERRED_GAP_S || sparseStop;
  return {
    mmsi: p.mmsi,
    name: nameAt(list, cross.t),
    bridge: station.name,
    bridgeId: station.id,
    kind: 'line',
    t: cross.t,
    iso: new Date(Math.round(cross.t)).toISOString(),
    // TIDSFÖNSTRET (krav i): för `inferred` ÄR fönstret svaret — `t` är då bara
    // en linjär gissning inuti det och får aldrig användas som punktstämpel.
    tFrom: p.t,
    tTo: q.t,
    inferred,
    ...(sparseStop ? { inferredReason: 'sparse-stopped-endpoint' } : {}),
    tFix: cross.tFix,
    dir: q.s > p.s ? 'nord' : 'syd',
    gapS,
    // dp/dq: avstånd LÄNGS FARLEDEN från respektive sampel till brostationen
    // (den gamla metodens dp/dq var perpendikelavstånd till brokordan — samma
    // roll, men mätt mot rätt referens).
    dp: Math.round(Math.abs(p.s - station.s)),
    dq: Math.round(Math.abs(q.s - station.s)),
    stepM: Math.round(Math.abs(q.s - p.s)),
    offP: Math.round(p.offsetM),
    offQ: Math.round(q.offsetM),
    fp: p.feed,
    fq: q.feed,
  };
}

/**
 * Alla brokorsningar för ETT fartyg.
 *
 * Tillståndsmaskinen per bro: sidan (`side`) är −1 söder / +1 norr och byter
 * bara när fartyget är BESLUTSAMT på den nya sidan (|s − s_bro| ≥ dödbandet).
 * Det senaste par som faktiskt straddlade stationen sparas och används som
 * korsningens tidsbevis. Ett par som implicerar orimlig fart (GPS-hopp) får
 * aldrig bli tidsbevis.
 * @param {object[]} list - fartygets sampel i tidsordning (med s/offsetM)
 * @returns {object[]} korsningar
 */
function crossingsForVessel(list) {
  const out = [];
  for (const station of BRIDGE_STATIONS) {
    let side = 0; // 0 = okänd (ingen beslutsam observation ännu)
    let straddle = null;
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      const rel = cur.s - station.s;
      if (i > 0) {
        const prev = list[i - 1];
        const relPrev = prev.s - station.s;
        if (relPrev !== 0 && rel !== 0 && (relPrev < 0) !== (rel < 0)) {
          const dtS = (cur.t - prev.t) / 1000;
          const moved = calculateDistance(prev.lat, prev.lon, cur.lat, cur.lon);
          const impliedKn = dtS > 0 ? (moved / dtS) / 0.514444 : Infinity;
          straddle = impliedKn > MAX_IMPLIED_KN ? null : { p: prev, q: cur };
        }
      }
      if (Math.abs(rel) < DECISIVE_SIDE_M) continue;
      const newSide = rel > 0 ? 1 : -1;
      if (newSide === side) {
        // Tillbaka på samma sida utan att ha fullbordat något — vobbel.
        straddle = null;
        continue;
      }
      if (straddle) out.push(makeCrossing(station, straddle.p, straddle.q, list));
      straddle = null;
      side = newSide;
    }
  }
  return out;
}

/**
 * Kanalinfartens zonbesök för ETT fartyg (krav iii).
 *
 * `inside` initieras från FÖRSTA samplet: ett besök som redan pågår när
 * korpusen börjar bokförs med `inferred: true` och tFrom = null (inträdet
 * skedde före inspelningen) i stället för att tigas ihjäl.
 * @param {object[]} list - fartygets sampel i tidsordning
 * @returns {object[]} besök
 */
function visitsForVessel(list) {
  const out = [];
  let visit = null;
  // Riktningen kräver ett sampel UTANFÖR radien att jämföra med — utan det
  // (vistelse som pågick vid korpusstart) är den ärligt okänd.
  const dirOf = (p, q) => {
    if (!p) return null;
    return q.s > p.s ? 'nord' : 'syd';
  };
  const close = () => {
    if (!visit) return;
    const movedTrack = calculateDistance(
      visit.first.lat, visit.first.lon, visit.last.lat, visit.last.lon,
    );
    const moving = (visit.maxSog !== null && visit.maxSog >= VISIT_TRANSIT_SOG_KN)
      || movedTrack >= VISIT_TRACK_M;
    if (moving) {
      const p = visit.before;
      const q = visit.first;
      // Radiekorsningen interpoleras på avståndet till triggerpunkten, exakt
      // som brokorsningen interpoleras på s — så att t betyder samma sak
      // (ögonblicket geometrin skiftade), inte "första observation innanför".
      let { t, tFix } = q;
      if (p) {
        const span = p.dist - q.dist;
        const frac = span === 0 ? 0 : (p.dist - KANALINFARTEN.radiusM) / span;
        t = p.t + (frac * (q.t - p.t));
        tFix = p.tFix + (frac * (q.tFix - p.tFix));
      }
      const gapS = p ? Math.round((q.t - p.t) / 1000) : null;
      out.push({
        mmsi: q.mmsi,
        name: nameAt(list, t),
        bridge: KANALINFARTEN.name,
        bridgeId: KANALINFARTEN.id,
        kind: 'zone',
        t,
        iso: new Date(Math.round(t)).toISOString(),
        tFrom: p ? p.t : null,
        tTo: q.t,
        // Utan ett sampel UTANFÖR radien är inträdestiden okänd — antingen för
        // att besöket pågick vid korpusstart eller för att glappet är för långt.
        inferred: !p || (gapS !== null && gapS > INFERRED_GAP_S),
        tFix,
        dir: dirOf(p, q),
        gapS,
        dp: p ? Math.round(p.dist) : null,
        dq: Math.round(q.dist),
        stepM: p ? Math.round(Math.abs(q.s - p.s)) : null,
        offP: p ? Math.round(p.offsetM) : null,
        offQ: Math.round(q.offsetM),
        fp: p ? p.feed : null,
        fq: q.feed,
      });
    }
    visit = null;
  };
  let prev = null;
  for (const s of list) {
    const inside = s.dist <= KANALINFARTEN.radiusM;
    if (inside) {
      if (!visit) {
        visit = {
          before: prev, first: s, last: s, maxSog: s.sog,
        };
      } else {
        visit.last = s;
        if (s.sog !== null) visit.maxSog = Math.max(visit.maxSog ?? 0, s.sog);
      }
    } else {
      close();
    }
    prev = s;
  }
  close();
  return out;
}

/**
 * Rådatafacit för en hel korpus.
 * @param {string} file - jsonl-sökväg
 * @returns {{passages:object[], stats:object}} facit + statistik
 */
function buildFacit(file) {
  const fairway = buildFairway();
  const samples = loadSamples(file);
  const byMmsi = new Map();
  let dropped = 0;
  for (const s of samples) {
    const proj = projectFix(fairway, s.lat, s.lon);
    s.s = proj.s;
    s.offsetM = proj.offsetM;
    s.dist = calculateDistance(s.lat, s.lon, KANALINFARTEN.lat, KANALINFARTEN.lon);
    if (!byMmsi.has(s.mmsi)) byMmsi.set(s.mmsi, { all: [], inCorridor: [] });
    const bucket = byMmsi.get(s.mmsi);
    bucket.all.push(s);
    // SIDLEDSGRINDEN (krav ii) appliceras genom att sampel utanför korridoren
    // aldrig blir ändpunkt i ett par — då gäller tröskeln automatiskt BÅDA
    // punkterna, och den interpolerade korsningen ligger per konstruktion på
    // linjen (offset 0), aldrig i den gamla metodens 161-metersfälla.
    if (proj.offsetM <= FAIRWAY_MAX_OFFSET_M) bucket.inCorridor.push(s);
    else dropped++;
  }
  const passages = [];
  for (const { all, inCorridor } of byMmsi.values()) {
    passages.push(...crossingsForVessel(inCorridor));
    passages.push(...visitsForVessel(all));
  }
  passages.sort((a, b) => (a.t - b.t)
    || a.mmsi.localeCompare(b.mmsi)
    || a.bridgeId.localeCompare(b.bridgeId));
  const stats = {
    samples: samples.length,
    vessels: byMmsi.size,
    droppedOutsideCorridor: dropped,
    crossings: passages.length,
    inferred: passages.filter((p) => p.inferred).length,
    byBridge: passages.reduce((acc, p) => {
      acc[p.bridge] = (acc[p.bridge] || 0) + 1;
      return acc;
    }, {}),
  };
  return { passages, stats };
}

// =============================================================================
// 4. KORPUSREGISTER
// =============================================================================

/**
 * Alla korpusar generatorn känner till, med löst källfilsvägar.
 * @returns {object[]} jobb {id, jsonl, note, missing}
 */
function resolveJobs() {
  const jobs = corpora.map((c) => ({ id: c.id, jsonl: c.jsonl, note: `korpus (${c.hours}h)` }));
  const known = new Set(jobs.map((j) => j.id));
  for (const n of NIGHT_CORPORA) {
    if (known.has(n.id)) continue;
    jobs.push({
      id: n.id,
      jsonl: path.join(__dirname, 'corpora-data', n.file),
      note: 'A/B-natten 2026-08-03',
    });
  }
  for (const e of EXTRA_CORPORA) {
    if (known.has(e.id)) continue;
    const candidates = [
      ...e.files.map((f) => path.join(__dirname, 'corpora-data', f)),
      ...(process.env.GT_SOURCE_DIR ? e.files.map((f) => path.join(process.env.GT_SOURCE_DIR, f)) : []),
      e.fallback,
    ];
    const hit = candidates.find((p) => fs.existsSync(p));
    jobs.push({ id: e.id, jsonl: hit || e.fallback, note: e.note });
  }
  return jobs.map((j) => ({ ...j, missing: !fs.existsSync(j.jsonl) }));
}

// =============================================================================
// 5. LÄSNING UTIFRÅN (konsumenterna: runOpeningGates, invariants)
// =============================================================================

const gtCache = new Map();

/**
 * Läs rådatafacit för en korpus-id. Returnerar null när facit saknas — varje
 * konsument MÅSTE då falla tillbaka på appens egna passager och säga det högt
 * (en tyst fallback är en vakuös grind).
 * @param {string} id - korpus-id
 * @returns {object[]|null} facit
 */
function loadGtPassages(id) {
  if (!id) return null;
  if (gtCache.has(id)) return gtCache.get(id);
  const dir = process.env.GT_PASSAGES_DIR || OUT_DIR;
  const file = path.join(dir, `${id}.json`);
  let data = null;
  try {
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    data = null;
  }
  gtCache.set(id, data);
  return data;
}

/**
 * Slå upp korpus-id ur en jsonl-basename (index.json skrivs av generatorn).
 * Gör att en konsument som bara har `result.jsonl` ändå hittar rätt facit.
 * @param {string} basename - filnamn
 * @returns {string|null} korpus-id
 */
function idForJsonl(basename) {
  if (!basename) return null;
  const dir = process.env.GT_PASSAGES_DIR || OUT_DIR;
  const file = path.join(dir, 'index.json');
  try {
    if (!fs.existsSync(file)) return null;
    const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hit = (idx.corpora || []).find((c) => c.jsonl === basename);
    return hit ? hit.id : null;
  } catch (e) {
    return null;
  }
}

// =============================================================================
// 6. CLI
// =============================================================================

function parseArgs(argv) {
  const args = {
    corpus: null, jsonl: null, id: null, out: OUT_DIR, check: false, audit: null, samples: 3, compare: null, anchorCheck: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') args.corpus = argv[++i];
    else if (a === '--jsonl') args.jsonl = argv[++i];
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--check') args.check = true;
    else if (a === '--audit') args.audit = argv[++i];
    else if (a === '--samples') args.samples = parseInt(argv[++i], 10);
    else if (a === '--compare') args.compare = argv[++i];
    else if (a === '--anchor-check') args.anchorCheck = true;
  }
  return args;
}

function serialize(passages) {
  return `${JSON.stringify(passages, null, 1)}\n`;
}

/**
 * DIAGNOSTIK: vad säger BRIDGES just nu, jämfört med de frusna stationerna?
 * Ren utskrift — rör aldrig facit (krav iv). Efter C0 (2026-08-10) ligger
 * SAMTLIGA fem broar inom ±7 m längs farleden och ≤15 m i sidled; en stor
 * differens betyder därför numera att någon flyttat en bro utan att ompröva
 * stationen här (skillnaden mot projektionen är metodens egen: stationerna är
 * skärningar mellan broaxeln och farleden, utskriften är en vinkelrät
 * projektion av brokoordinaten).
 */
function anchorCheck() {
  /* eslint-disable global-require */
  const { BRIDGES, TRIGGER_POINTS } = require('../../lib/constants');
  /* eslint-enable global-require */
  const fairway = buildFairway();
  console.log('--- ANKARKONTROLL (diagnostik; facit påverkas ALDRIG) ---');
  for (const st of BRIDGE_STATIONS) {
    const b = BRIDGES[st.id];
    if (!b) continue;
    const p = projectFix(fairway, b.lat, b.lon);
    console.log(`  ${st.name.padEnd(16)} fryst s=${st.s.toFixed(1).padStart(7)}  BRIDGES→s=${p.s.toFixed(1).padStart(7)}  `
      + `Δ=${(p.s - st.s).toFixed(1).padStart(7)} m längs farled, sidled ${p.offsetM.toFixed(1)} m`);
  }
  const k = TRIGGER_POINTS.kanalinfarten;
  const dk = calculateDistance(k.lat, k.lon, KANALINFARTEN.lat, KANALINFARTEN.lon);
  console.log(`  ${'Kanalinfarten'.padEnd(16)} fryst punkt vs TRIGGER_POINTS: Δ=${dk.toFixed(1)} m, `
    + `radie ${KANALINFARTEN.radiusM} vs ${k.radius}`);
}

/**
 * STICKPROV: skriv ut rådatabeviset för N korsningar (första, mittersta,
 * sista) så att en granskare kan följa varje post tillbaka till två rader i
 * jsonl:en.
 */
function audit(job, passages, n) {
  const raw = fs.readFileSync(job.jsonl, 'utf8').split('\n');
  const picks = [];
  const add = (p) => {
    if (p && !picks.includes(p)) picks.push(p);
  };
  const lines = passages.filter((p) => p.kind === 'line');
  const zones = passages.filter((p) => p.kind === 'zone');
  const pool = lines.length ? lines : passages;
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    add(pool[Math.floor((i * (pool.length - 1)) / Math.max(1, take - 1))]);
  }
  add(zones[0]);
  add(passages.find((p) => p.inferred));
  console.log(`--- STICKPROV ${job.id} (${picks.length} poster) ---`);
  for (const p of picks) {
    console.log(`  ${p.iso}  ${p.mmsi} ${p.name} @ ${p.bridge} (${p.kind}, ${p.dir || 'riktning okänd'})`
      + `${p.inferred ? '  [inferred]' : ''}`);
    console.log(`     dp=${p.dp} m dq=${p.dq} m steg=${p.stepM} m glapp=${p.gapS} s `
      + `sidled ${p.offP}/${p.offQ} m källa ${p.fp}/${p.fq}`);
    for (const bound of [p.tFrom, p.tTo]) {
      if (bound === null) {
        console.log('     rå: (ingen sampelrad — vistelsen pågick vid korpusstart)');
        continue;
      }
      const hit = raw.find((l) => l.includes(`"mmsi":"${p.mmsi}"`) && l.includes(`"aisTimestamp":${bound}`));
      console.log(`     rå: ${hit ? hit.slice(0, 200) : `(hittade ingen rad för aisTimestamp ${bound})`}`);
    }
  }
}

/**
 * POST-FÖR-POST-DIFF mot ett annat facit (dirigentens oberoende fil).
 * Matchning på (mmsi, bro) + närmaste tid inom 30 min — en korsning som bara
 * flyttat några sekunder är samma korsning.
 */
function compare(mine, theirsFile) {
  const theirs = JSON.parse(fs.readFileSync(theirsFile, 'utf8'));
  const used = new Set();
  const matched = [];
  const onlyMine = [];
  for (const a of mine) {
    let best = null;
    for (let i = 0; i < theirs.length; i++) {
      if (used.has(i)) continue;
      const b = theirs[i];
      if (String(b.mmsi) !== a.mmsi || b.bridge !== a.bridge) continue;
      const dt = Math.abs(b.t - a.t);
      if (dt > 30 * 60 * 1000) continue;
      if (!best || dt < best.dt) best = { i, b, dt };
    }
    if (best) {
      used.add(best.i);
      matched.push({ a, b: best.b, dt: best.dt });
    } else onlyMine.push(a);
  }
  const onlyTheirs = theirs.filter((_, i) => !used.has(i));
  return { matched, onlyMine, onlyTheirs };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.anchorCheck) {
    anchorCheck();
    return;
  }
  let jobs = resolveJobs();
  if (args.jsonl) {
    jobs = [{
      id: args.id || path.basename(args.jsonl, '.jsonl'),
      jsonl: args.jsonl,
      note: 'ad hoc',
      missing: !fs.existsSync(args.jsonl),
    }];
  } else if (args.corpus) {
    jobs = jobs.filter((j) => j.id === args.corpus);
    if (jobs.length === 0) throw new Error(`Okänd korpus: ${args.corpus}`);
  }

  if (!fs.existsSync(args.out)) fs.mkdirSync(args.out, { recursive: true });

  console.log('=== RÅDATAFACIT (A2) ===');
  const index = { generated: 'makeGtPassages.js', corpora: [] };
  let mismatches = 0;
  let missing = 0;
  for (const job of jobs) {
    if (job.missing) {
      missing++;
      console.log(`  ⚠️ ${job.id.padEnd(24)} KÄLLA SAKNAS: ${job.jsonl}`);
      continue;
    }
    const { passages, stats } = buildFacit(job.jsonl);
    const file = path.join(args.out, `${job.id}.json`);
    const body = serialize(passages);
    if (args.check) {
      const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (old !== body) {
        mismatches++;
        console.log(`  ❌ ${job.id.padEnd(24)} incheckat facit skiljer sig från nygenererat`);
      } else {
        console.log(`  ✅ ${job.id.padEnd(24)} oförändrat (${stats.crossings} korsningar)`);
      }
    } else {
      fs.writeFileSync(file, body);
      const bridges = Object.entries(stats.byBridge)
        .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
      console.log(`  📝 ${job.id.padEnd(24)} ${String(stats.crossings).padStart(4)} korsningar `
        + `(${stats.inferred} inferred) ur ${stats.samples} sampel / ${stats.vessels} fartyg`);
      console.log(`     ${bridges}`);
      if (stats.droppedOutsideCorridor) {
        console.log(`     ${stats.droppedOutsideCorridor} sampel utanför korridoren (${FAIRWAY_MAX_OFFSET_M} m) — ej ändpunkter`);
      }
    }
    index.corpora.push({
      id: job.id, jsonl: path.basename(job.jsonl), crossings: stats.crossings, inferred: stats.inferred,
    });
    if (args.audit === job.id) audit(job, passages, args.samples);
    if (args.compare) {
      const { matched, onlyMine, onlyTheirs } = compare(passages, args.compare);
      console.log(`--- DIFF mot ${path.basename(args.compare)}: ${matched.length} matchade, `
        + `${onlyMine.length} bara mina, ${onlyTheirs.length} bara deras ---`);
      const shifted = matched.filter((m) => m.dt > 1000)
        .sort((a, b) => b.dt - a.dt);
      for (const m of shifted.slice(0, 20)) {
        console.log(`  ~ ${m.a.mmsi} ${m.a.name} @ ${m.a.bridge} ${m.a.iso} — tidsskift ${(m.dt / 1000).toFixed(1)} s`);
      }
      for (const a of onlyMine) {
        console.log(`  + ${a.mmsi} ${a.name} @ ${a.bridge} ${a.iso} (${a.kind}${a.inferred ? ', inferred' : ''}, `
          + `glapp ${a.gapS} s, dp=${a.dp} dq=${a.dq})`);
      }
      for (const b of onlyTheirs) {
        console.log(`  − ${b.mmsi} ${b.name} @ ${b.bridge} ${b.iso || new Date(b.t).toISOString()} `
          + `(deras dp=${b.dp} dq=${b.dq} glapp=${b.gapS})`);
      }
    }
  }
  if (!args.check && !args.jsonl && !args.corpus) {
    fs.writeFileSync(INDEX_FILE, `${JSON.stringify(index, null, 1)}\n`);
    console.log(`  📇 index.json: ${index.corpora.length} korpusar`);
  }
  if (missing) console.log(`\n  ⚠️ ${missing} korpus(ar) utan källfil — se ovan.`);
  if (args.check && mismatches) {
    console.log(`\n❌ ${mismatches} facitfil(er) avviker — generatorn och det incheckade facitet är inte i synk.`);
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`❌ makeGtPassages: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  BRIDGE_STATIONS,
  KANALINFARTEN,
  FAIRWAY_MAX_OFFSET_M,
  DECISIVE_SIDE_M,
  INFERRED_GAP_S,
  MAX_IMPLIED_KN,
  VISIT_TRANSIT_SOG_KN,
  VISIT_TRACK_M,
  buildFairway,
  projectFix,
  loadSamples,
  buildFacit,
  crossingsForVessel,
  visitsForVessel,
  resolveJobs,
  loadGtPassages,
  idForJsonl,
  compare,
};
