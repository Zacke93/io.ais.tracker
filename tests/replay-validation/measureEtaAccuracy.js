'use strict';

/**
 * measureEtaAccuracy.js — MÄTHARNESS för appens PUBLICERADE ETA:er (röda etappen, 2026-08-22)
 *
 * VARFÖR: K6/K8/K25 handlar alla om att ETA-pipelinen publicerar fel siffra.
 * Ingen befintlig gate mäter FELET — golden-text låser bara att siffran är
 * OFÖRÄNDRAD, och F-13:s metodvarning (docs/VALIDATION.md) säger att en
 * ETA-ändring måste bedömas mot |publicerad − faktisk passagetid|, aldrig mot
 * ett låst facit. Det här skriptet är den mätaren. Det RÖR INGET FACIT och
 * ändrar ingen produktkod — det kör replayharnessen och räknar.
 *
 * ANVÄNDNING
 *   npm run measure:eta                        # alla LÅSTA korpusar →
 *                                              #   <os.tmpdir()>/ais-tracker-eta
 *                                              #   (%TEMP% på Windows)
 *   npm run measure:eta -- <utkatalog>         # egen utkatalog
 *   npm run measure:eta -- --out=<utkatalog>   # samma sak, namngiven flagga
 *   npm run measure:eta -- --corpus=20260806-42h,20260804-17h
 *   npm run measure:eta -- --include-unlocked  # ta med olåsta korpusar också
 *   npm run measure:eta -- --label="HEAD före K6"
 *   npm run measure:eta -- --no-stamp          # utan stderr-tidsstämpling (fallback)
 *
 * Utdata (två filer i utkatalogen):
 *   eta-accuracy.json  — maskinläsbart: varje påstående + alla aggregat
 *   eta-accuracy.txt   — läsbar rapport (samma tal)
 *
 * ARBETSGÅNGEN FÖR EN ETA-ÄNDRING (t.ex. K6-memoiseringen)
 *   1. Kör på HEAD FÖRE ändringen → spara som baslinje. Ge den en EGEN
 *      --out=<katalog>: defaultkatalogen är EN fast plats som skrivs över av
 *      nästa körning, så en baslinje som lämnas där överlever inte steg 3.
 *   2. Gör ändringen.
 *   3. Kör igen till en ANNAN katalog och jämför `total`-blocken.
 *      Sjunkande median/p90 |fel| och en bias närmare 0 = ändringen förbättrar.
 *      Ett oförändrat facit bevisar INGENTING om ETA-kvalitet; det här gör det.
 *
 * SÅ HÄR MÄTS DET
 *   PÅSTÅENDE = varje ETA-siffra appen publicerar, av tre slag:
 *     (a) brotext — "beräknad broöppning om [cirka] N minuter" per målbro,
 *         hämtad ur bridgeTextTransitions (den RIKTIGA publiceringsvägen).
 *         Texten nämner inget fartygsnamn. Den skrivskyddade förladdningen
 *         fångar därför BridgeTextService:s faktiska ledarval, formaterings-
 *         argument och returtext. Exakt text/tid måste matcha publiceringen.
 *         Det inkluderar extrapolering, köurval och hållet textunderlag som
 *         inte går att återskapa ur gamla [ETA_CALC_V2]-loggrader.
 *         Gruppdominant "strax" kan styras av en annan båt än ETA-ledaren;
 *         utan entydigt MMSI redovisas den därför separat och omätt.
 *         Utpekningsmixen redovisas som `textAttribution`; ett påstående
 *         som INTE kunde knytas till ett mmsi lämnas OMÄTT (status
 *         'oattribuerad') i stället för att gissa.
 *     (b) boat_near-notisens eta_minutes (mmsi + bro står i tokenen).
 *     (c) bridge_opening_soon-kortets eta_minutes (leadMmsi + bro i state).
 *   SANNING = nästa FAKTISKA brolinjekorsning för samma (mmsi, bro) i
 *     rådatafacit gt-passages/<korpus>.json EFTER påståendets tidpunkt t:
 *         sanning_minuter = (t_passage − t) / 60000
 *         fel             = publicerad − sanning        (+ = för sent lovat)
 *   `inferred: true`-korsningar används ALDRIG som punktstämpel (README i
 *   gt-passages) — de hamnar i status 'inferred' och hålls utanför
 *   felstatistiken. Påståenden utan efterföljande LINJEkorsning hamnar i
 *   'ingen-korsning' (båten vände, korpusen tog slut) och Kanalinfartens
 *   ZONbesök i 'zon-ej-linjefacit'; ingen av dem räknas i felen.
 *
 *   TVÅ TOTALER redovisas: hela mängden, och delmängden där passagen faktiskt
 *   kom inom 60 min (`measuredWithin60`). Den senare är det JÄMFÖRBARA måttet
 *   mellan två körningar — en handfull båtar som lade till i timmar ger
 *   hundratals minuters "fel" som annars dränker allt annat i summan.
 *
 * TIDSSTÄMPLADE DEBUGRADER (hur ledaren och K6-måttet blir exakta)
 *   replayRunner kör appen på en FEJKKLOCKA och skickar appens loggar till
 *   stderr (REPLAY_VERBOSE=1 + REPLAY_DEBUG_LEVEL=full). Raderna saknar
 *   tidsstämpel. Skriptet laddar därför SIG SJÄLV som `--require`-förladdning i
 *   barnprocessen (ETA_MEASURE_STAMP=1) och prefixar varje stderr-rad med
 *   "@<Date.now()>\t". Eftersom @sinonjs/fake-timers byter ut globala Date
 *   EFTER förladdningen läser hooken FEJKklockan — alltså exakt den tid appen
 *   själv såg. Textfångsten bär också sin egen exakta klocka och är aktiv
 *   även med --no-stamp. Ingen produktkod eller replayRunner ändras.
 *   MÄTKONTROLL (2026-09-09): alla 20 korpusar ger samma replayresultat
 *   med och utan mätfångst. Endast processens varierande heapUsedMB undantas;
 *   text, händelser, processfel och timerstädning jämförs exakt.
 *
 * K6-BEVISET (dubbelkörningsfrekvensen)
 *   Räknar par av [ETA_CALC_V2]/[ETA_START] för SAMMA mmsi inom < 200 ms
 *   (fejkklockan). I harnessen ligger meddelandevägens och snapshotvägens
 *   beräkningar i samma sampelfönster (≤ 60 ms isär), medan två riktiga fixar
 *   ligger tiotals sekunder isär — 200 ms skiljer dem med bred marginal.
 *   Rapporterar också hur många av paren som gav OLIKA värde (dubbel EMA) och
 *   hur många [ETA_OUTLIER] som mätts mot en < 200 ms gammal egen baslinje.
 *
 * ÄGARSKAP/GRÄNSER: skriptet skriver ENDAST i angiven utkatalog. Det läser
 * corpora.js och gt-passages/ men rör dem aldrig.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// FÖRLADDNINGSLÄGET (--require): tidsstämpla stderr med FEJKKLOCKANS Date.now.
// Normal require utan mätflaggor installerar inga hooks.
// ---------------------------------------------------------------------------
function installStderrTimestamper() {
  const origWrite = process.stderr.write.bind(process.stderr);
  let atLineStart = true;
  process.stderr.write = function stampedWrite(chunk, encoding, callback) {
    let enc = encoding;
    let cb = callback;
    if (typeof enc === 'function') {
      cb = enc;
      enc = undefined;
    }
    if (typeof chunk !== 'string') return origWrite(chunk, enc, cb);
    // Date slås upp vid ANROPET → fake-timers' Date, inte den äkta.
    const ts = Date.now();
    let out = '';
    let i = 0;
    while (i < chunk.length) {
      const nl = chunk.indexOf('\n', i);
      const end = nl === -1 ? chunk.length : nl + 1;
      const seg = chunk.slice(i, end);
      if (atLineStart) out += `@${ts}\t`;
      out += seg;
      atLineStart = seg.endsWith('\n');
      i = end;
    }
    return origWrite(out, enc, cb);
  };
}

/**
 * Skrivskyddad mätning av textmotorns verkliga val. En ETA-beräkningslogg
 * saknar senare extrapolering, köurval och hållet presentationsunderlag.
 * Originalmetoderna körs exakt en gång; inga fartyg eller appfält skrivs.
 * Frasen och hela returtexten binds till samma synkrona renderingsanrop.
 */
function installBridgeTextCapture(BridgeTextService, emit) {
  const proto = BridgeTextService.prototype;
  const originals = {};
  const contexts = new WeakMap();
  for (const name of ['generateBridgeText', '_buildGroupPhrase', '_selectLeadVessel', '_formatETAAsBroOpening']) {
    originals[name] = proto[name];
  }
  proto.generateBridgeText = function measuredText(...args) {
    const previous = contexts.get(this);
    const context = { groups: [], group: null };
    contexts.set(this, context);
    try {
      const text = originals.generateBridgeText.apply(this, args);
      try {
        emit({ t: Date.now(), text, groups: context.groups });
      } catch (_) { /* en trasig mätmottagare får inte ändra appens returtext */ }
      return text;
    } finally {
      if (previous) contexts.set(this, previous);
      else contexts.delete(this);
    }
  };
  proto._buildGroupPhrase = function measuredGroup(...args) {
    const [vessels, bridge] = args;
    const context = contexts.get(this);
    if (!context) return originals._buildGroupPhrase.apply(this, args);
    const previous = context.group;
    const group = {
      bridge, members: [], mmsi: null, eta: null,
    };
    context.group = group;
    try {
      const phrase = originals._buildGroupPhrase.apply(this, args);
      try {
        group.members = vessels.map((v) => String(v.mmsi));
      } catch (_) { /* oläsbar identitet lämnas obestyrkt */ }
      group.phrase = phrase;
      context.groups.push(group);
      return phrase;
    } finally {
      context.group = previous;
    }
  };
  proto._selectLeadVessel = function measuredLead(...args) {
    const lead = originals._selectLeadVessel.apply(this, args);
    const group = contexts.get(this)?.group;
    if (group) {
      try {
        group.mmsi = lead?.mmsi ? String(lead.mmsi) : null;
      } catch (_) { /* oläsbar identitet lämnas obestyrkt */ }
    }
    return lead;
  };
  proto._formatETAAsBroOpening = function measuredClause(...args) {
    const clause = originals._formatETAAsBroOpening.apply(this, args);
    const group = contexts.get(this)?.group;
    if (group) {
      [group.eta, group.extrapolated, group.imminent] = args;
    }
    return clause;
  };
  return () => {
    for (const [name, original] of Object.entries(originals)) proto[name] = original;
  };
}

if (require.main !== module) {
  if (process.env.ETA_MEASURE_STAMP === '1') installStderrTimestamper();
  if (process.env.ETA_MEASURE_CAPTURE === '1') {
    // eslint-disable-next-line global-require
    const BridgeTextService = require('../../lib/services/BridgeTextService');
    installBridgeTextCapture(BridgeTextService, (rendering) => {
      process.stderr.write(`[ETA_MEASURE_RENDER] ${JSON.stringify(rendering)}\n`);
    });
    process.stderr.write('[ETA_MEASURE_CAPTURE_READY]\n');
  }
}

// ---------------------------------------------------------------------------
// Konstanter med härledning
// ---------------------------------------------------------------------------
const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const RUNNER = path.join(HERE, 'replayRunner.js');
const GT_DIR = path.join(HERE, 'gt-passages');

// Utkatalog när --out saknas. Måste vara PORTABEL: mätharnessen är ett
// permanent valideringsverktyg som körs på både Mac och Windows-jobbdatorn.
// Fram till 2026-08-22 stod här en hårdkodad absolut macOS-sökväg med ett
// Claude-sessions-UUID i; på Windows (och på vilken annan Mac som helst)
// skapade mkdirSync tyst en bogus katalog i stället för att skriva dit någon
// letade. os.tmpdir() löser %TEMP% respektive $TMPDIR och ligger utanför
// repot, så inget behöver gitignoreras. --out=<katalog> (eller ett bart
// positionsargument) styr fortfarande allt.
const DEFAULT_OUT_DIR = path.join(os.tmpdir(), 'ais-tracker-eta');

// Dubbelkörningsfönstret. Härledning: i replayRunner ligger meddelandevägens
// och snapshotvägens ETA-beräkning i SAMMA sampelsteg — mellan dem tickar
// klockan som mest 60 ms (grace-tick:et efter _processAISMessage). Två skilda
// AIS-fixar ligger 30–90 s isär (aisstream 30 s / AISHub ~70 s poll). 200 ms
// ligger 3,3× över det inre avståndet och 150× under det yttre.
const DOUBLE_RUN_WINDOW_MS = 200;

// Hur länge ett rekonstruerat per-fartygs-ETA-tillstånd får bära vid
// ledarutpekningen. Härledning: appens egen hårda staleness-gräns för ETA är
// UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS = 10 min (efter den nollas ETA:n
// och texten faller till "ETA okänd"), plus en omvärderingscykel (30 s) och
// marginal för glesa Class B-sändare ⇒ 15 min.
const STATE_TTL_MS = 15 * 60 * 1000;

// Målbroarna är de enda broar som nämns i bridge_text (bridgeTextFormat.md).
const TEXT_BRIDGES = ['Klaffbron', 'Stridsbergsbron'];

// -1 är appens sentinel för "ETA okänd" i Flow-tokens (etaMinutesForDisplay).
const ETA_UNKNOWN_TOKEN = -1;

// ---------------------------------------------------------------------------
// Små statistikhjälpare (deterministiska, dokumenterade definitioner)
// ---------------------------------------------------------------------------
function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/** Nearest-rank-percentil (ingen interpolation) — stabil mot små n. */
function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.ceil(p * n);
  return sortedAsc[Math.min(n - 1, Math.max(0, rank - 1))];
}

function round2(x) {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}

/**
 * Aggregat över en lista påståenden som HAR en giltig sanning.
 * @param {Array<{error:number}>} items
 */
function summarize(items) {
  const abs = items.map((c) => Math.abs(c.error)).sort((a, b) => a - b);
  const n = abs.length;
  if (n === 0) {
    return {
      n: 0, sumAbsErr: 0, medianAbsErr: null, p90AbsErr: null, meanAbsErr: null, bias: null, within2: null, within2Count: 0,
    };
  }
  const sum = abs.reduce((a, b) => a + b, 0);
  const bias = items.reduce((a, c) => a + c.error, 0) / n;
  const within2Count = abs.filter((x) => x <= 2).length;
  return {
    n,
    sumAbsErr: round2(sum),
    medianAbsErr: round2(median(abs)),
    p90AbsErr: round2(percentile(abs, 0.9)),
    meanAbsErr: round2(sum / n),
    bias: round2(bias),
    within2: round2((within2Count / n) * 100),
    within2Count,
  };
}

function worstN(items, n) {
  return [...items]
    .sort((a, b) => (Math.abs(b.error) - Math.abs(a.error)) || (a.t - b.t))
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Brotextparsern
// ---------------------------------------------------------------------------
// Räkneorden kommer ur lib/utils/CountTextHelper (1–10 som ord, därefter
// siffra). Antalet är en OBEROENDE kontroll av att rätt filterpass matchas
// mot rätt text — se attributeClaim.
const COUNT_WORDS = {
  En: 1, Ett: 1, Två: 2, Tre: 3, Fyra: 4, Fem: 5, Sex: 6, Sju: 7, Åtta: 8, Nio: 9, Tio: 10,
};
const RE_TEXT_COUNT = /^(\S+)\s+(?:båt|båtar)\b/;
const RE_TEXT_NUM = /beräknad broöppning om (cirka )?(\d+) minuter/;
const RE_TEXT_STRAX = /beräknad broöppning strax/;
const RE_TEXT_UNKNOWN = /ETA okänd/;

/**
 * Plocka ut ETA-klausulerna ur en publicerad bridge_text.
 * Formatet är "<antal> båt(ar) på väg mot <målbro>, <klausul>" (flera broar
 * separerade med "; "), plus nödfallbacken "En båt <N>m från <målbro> ...".
 * @param {string} text
 * @returns {Array<{bridge:string, clause:string, minutes:(number|null), approx:boolean}>}
 */
function parseBridgeTextClaims(text) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  if (text.startsWith('__PROCESS_ERROR__')) return out;
  for (const raw of text.split(';')) {
    const phrase = raw.trim();
    if (phrase.length === 0) continue;
    // Exakt EN målbro får nämnas — DEFAULT_MESSAGE ("… Klaffbron eller
    // Stridsbergsbron") nämner båda och bär ingen klausul.
    const named = TEXT_BRIDGES.filter((b) => phrase.includes(b));
    if (named.length !== 1) continue;
    const bridge = named[0];
    const cw = phrase.match(RE_TEXT_COUNT);
    let count = null;
    if (cw) {
      count = COUNT_WORDS[cw[1]] ?? (/^\d+$/.test(cw[1]) ? Number(cw[1]) : null);
    }
    const num = phrase.match(RE_TEXT_NUM);
    if (num) {
      out.push({
        bridge, clause: 'minuter', minutes: Number(num[2]), approx: Boolean(num[1]), count,
      });
    } else if (RE_TEXT_STRAX.test(phrase)) {
      out.push({
        bridge, clause: 'strax', minutes: null, approx: false, count,
      });
    } else if (RE_TEXT_UNKNOWN.test(phrase)) {
      out.push({
        bridge, clause: 'okänd', minutes: null, approx: false, count,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// stderr-parsern: appens egna debugrader → tidsordnad tillståndsström
// ---------------------------------------------------------------------------
const RE_STAMP = /^@(\d+)\t/;
const RE_SAMPLE = /\[AIS_REPLAY_SAMPLE\] (\{.*\})\s*$/;
const RE_ETA_CALC_OK = /\[ETA_CALC_V2\] (\d+): Progressive ETA to (.+?) = ([\d.]+)min/;
const RE_ETA_CALC_FAIL = /\[ETA_CALC_V2\] (\d+): Progressive ETA calculation failed/;
const RE_ETA_START = /\[ETA_START\] (\d+): Calculating ETA to (.+?) \(/;
const RE_ETA_OUTLIER = /\[ETA_OUTLIER\] (\d+): Suspicious ETA ([\d.]+)min detected \((.+?)\)/;
const RE_ETA_SMOOTHING = /\[ETA_SMOOTHING\] (\d+):/;
const RE_POSITION_ANALYSIS = /\[POSITION_ANALYSIS\] (\d+): status=[^,]*, distance=[^,]*, ETA=(null|[\d.]+min)/;
const RE_TARGET_CHANGE = /\[TARGET_CHANGE\] (\d+): "(.*?)" → "(.*?)"/;
const RE_VESSEL_REMOVED = /\[VESSEL_REMOVED\] Vessel: (\d+)/;
// Brotextfiltrets EGNA rader (VesselDataService:1990/1994). De namnger exakt
// vilka fartyg som gick in i texten och mot vilken målbro — den enda direkta
// kopplingen mellan en publicerad brotext och ett mmsi.
const RE_FILTER_INCLUDED = /✅ \[BRIDGE_TEXT_FILTER\] (\d+)(?:\/([^:]*))?: Included in bridge text \(([^,]+), ([^)]*)\)/;
const RE_FILTER_DONE = /📊 \[BRIDGE_TEXT_FILTER\] Filtered (\d+)\/(\d+) vessels for bridge text/;

function makeStderrCollector() {
  const events = []; // tillståndsändringar (bridge/eta per mmsi)
  const etaCalcs = []; // [ETA_CALC_V2] (alla, även null)
  const etaStarts = [];
  const outliers = [];
  const renderings = [];
  let renderCapture = false;
  let smoothingLines = 0;
  let seq = 0;
  let anchorMs = null; // fallback när --no-stamp används
  let pendingIncluded = []; // fartygen i ett pågående brotextfilter-pass
  let stamped = 0;
  let unstamped = 0;

  function push(list, obj) {
    list.push(obj);
  }

  function line(text) {
    seq += 1;
    let rest = text;
    let t = null;
    const stamp = rest.match(RE_STAMP);
    if (stamp) {
      t = Number(stamp[1]);
      rest = rest.slice(stamp[0].length);
      stamped += 1;
    } else {
      unstamped += 1;
    }
    if (rest === '[ETA_MEASURE_CAPTURE_READY]') {
      renderCapture = true;
      return;
    }
    const rendered = rest.match(/^\[ETA_MEASURE_RENDER\] (\{.*\})$/);
    if (rendered) {
      try {
        const r = JSON.parse(rendered[1]);
        if (Number.isFinite(r.t) && typeof r.text === 'string' && Array.isArray(r.groups)) {
          renderings.push(r);
        }
      } catch (_) { /* oläsbar proveniens får aldrig bli ett gissat mätvärde */ }
      return;
    }
    const sample = rest.match(RE_SAMPLE);
    if (sample) {
      try {
        const s = JSON.parse(sample[1]);
        if (Number.isFinite(s.aisTimestamp)) anchorMs = s.aisTimestamp;
      } catch (_) { /* trasig rad — ignorera ankaret */ }
      return;
    }
    if (t === null) t = anchorMs;
    if (t === null) return; // före första ankaret och utan stämpel: obrukbar

    const calcOk = rest.match(RE_ETA_CALC_OK);
    if (calcOk) {
      const e = {
        t, seq, mmsi: calcOk[1], bridge: calcOk[2], eta: Number(calcOk[3]),
      };
      push(etaCalcs, e);
      push(events, {
        t, seq, kind: 'eta', mmsi: e.mmsi, bridge: e.bridge, eta: e.eta,
      });
      return;
    }
    const calcFail = rest.match(RE_ETA_CALC_FAIL);
    if (calcFail) {
      const e = {
        t, seq, mmsi: calcFail[1], bridge: null, eta: null,
      };
      push(etaCalcs, e);
      push(events, {
        t, seq, kind: 'eta-null', mmsi: e.mmsi, bridge: null, eta: null,
      });
      return;
    }
    const start = rest.match(RE_ETA_START);
    if (start) {
      push(etaStarts, {
        t, seq, mmsi: start[1], bridge: start[2],
      });
      return;
    }
    const outlier = rest.match(RE_ETA_OUTLIER);
    if (outlier) {
      push(outliers, {
        t, seq, mmsi: outlier[1], raw: Number(outlier[2]), reason: outlier[3],
      });
      return;
    }
    if (RE_ETA_SMOOTHING.test(rest)) {
      smoothingLines += 1;
      return;
    }
    const pa = rest.match(RE_POSITION_ANALYSIS);
    if (pa) {
      const v = pa[2] === 'null' ? null : Number(pa[2].replace('min', ''));
      push(events, {
        t, seq, kind: 'pa', mmsi: pa[1], eta: v,
      });
      return;
    }
    const tc = rest.match(RE_TARGET_CHANGE);
    if (tc) {
      const to = tc[3] === 'none' || tc[3] === '' ? null : tc[3];
      push(events, {
        t, seq, kind: 'target', mmsi: tc[1], bridge: to,
      });
      return;
    }
    const rm = rest.match(RE_VESSEL_REMOVED);
    if (rm) {
      push(events, {
        t, seq, kind: 'remove', mmsi: rm[1],
      });
      return;
    }
    const inc = rest.match(RE_FILTER_INCLUDED);
    if (inc) {
      const reason = inc[4] || '';
      pendingIncluded.push({
        mmsi: inc[1],
        name: (inc[2] || '').trim() || null,
        bridge: reason.startsWith('target=') ? reason.slice('target='.length) : null,
      });
      return;
    }
    const done = rest.match(RE_FILTER_DONE);
    if (done) {
      push(events, {
        t, seq, kind: 'filterpass', included: pendingIncluded, kept: Number(done[1]),
      });
      pendingIncluded = [];
    }
  }

  function result() {
    events.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
    etaCalcs.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
    etaStarts.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
    outliers.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
    return {
      events,
      etaCalcs,
      etaStarts,
      outliers,
      smoothingLines,
      stamped,
      unstamped,
      renderings,
      renderCapture,
    };
  }

  return { line, result };
}

// ---------------------------------------------------------------------------
// Kör EN replay per korpus och samla både JSON-resultatet och stderr-strömmen
// ---------------------------------------------------------------------------
function runCorpus(corpus, opts) {
  return new Promise((resolve, reject) => {
    const args = ['--require', __filename];
    args.push(RUNNER, corpus.jsonl);
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        REPLAY_VERBOSE: '1',
        REPLAY_DEBUG_LEVEL: 'full',
        ETA_MEASURE_STAMP: opts.stamp ? '1' : '0',
        ETA_MEASURE_CAPTURE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const collector = makeStderrCollector();
    let stdout = '';
    let pending = '';
    let failure = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        collector.line(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
    });
    child.on('error', (err) => {
      failure = err;
    });
    child.on('close', (code) => {
      if (pending.length > 0) collector.line(pending);
      if (failure) {
        reject(failure); return;
      }
      const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
      if (!m) {
        reject(new Error(`Ingen JSON-markör för ${corpus.id} (exitkod ${code})`));
        return;
      }
      let json;
      try {
        json = JSON.parse(m[1]);
      } catch (e) {
        reject(new Error(`Trasig replay-JSON för ${corpus.id}: ${e.message}`));
        return;
      }
      if (json.fatal) {
        reject(new Error(`replayRunner kraschade för ${corpus.id}: ${json.fatal}`));
        return;
      }
      const debug = collector.result();
      if (!debug.renderCapture) {
        reject(new Error(`Textens mätfångst installerades inte för ${corpus.id}`));
        return;
      }
      resolve({ replay: json, debug, exitCode: code });
    });
  });
}

// ---------------------------------------------------------------------------
// Rådatafacit → uppslagsindex
// ---------------------------------------------------------------------------
function loadGtIndex(corpusId) {
  const file = path.join(GT_DIR, `${corpusId}.json`);
  if (!fs.existsSync(file)) return { index: new Map(), count: 0, missing: true };
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  const index = new Map();
  for (const p of Array.isArray(arr) ? arr : []) {
    if (!Number.isFinite(p.t)) continue;
    const key = `${p.mmsi}|${p.bridge}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      t: p.t, inferred: p.inferred === true, kind: p.kind, name: p.name,
    });
  }
  for (const list of index.values()) list.sort((a, b) => a.t - b.t);
  return { index, count: Array.isArray(arr) ? arr.length : 0, missing: false };
}

/**
 * Nästa faktiska BROLINJEKORSNING för (mmsi, bro) vid eller efter t.
 * Endast kind === 'line'. Kanalinfarten är en ZON (300 m radie) och inte en
 * brolinje — ett zonbesök besvarar inte frågan "när passerade båten bron", och
 * en båt som redan ligger INNE i zonen när påståendet görs skulle få nästa
 * INTRÄDE (timmar senare) som falsk sanning. Zonträffar rapporteras i stället
 * som egen status.
 */
function nextCrossing(gt, mmsi, bridge, t) {
  const list = gt.index.get(`${mmsi}|${bridge}`);
  if (!list) return null;
  for (const c of list) {
    if (c.kind === 'line' && c.t >= t) return c;
  }
  return null;
}

/** Finns ett zonbesök (men ingen linjekorsning) för (mmsi, bro) efter t? */
function hasZoneAfter(gt, mmsi, bridge, t) {
  const list = gt.index.get(`${mmsi}|${bridge}`);
  if (!list) return false;
  return list.some((c) => c.kind === 'zone' && c.t >= t);
}

// ---------------------------------------------------------------------------
// Historisk loggrekonstruktion: behålls för jämförelse av gamla mätningar.
// CLI kräver nu direkt renderingsfångst; dessa uppskattningar ersätter den aldrig.
// ---------------------------------------------------------------------------
function applyEvent(state, ev) {
  if (ev.kind === 'remove') {
    state.delete(ev.mmsi);
    return;
  }
  const prev = state.get(ev.mmsi) || { bridge: null, eta: null, t: ev.t };
  if (ev.kind === 'eta') {
    state.set(ev.mmsi, { bridge: ev.bridge, eta: ev.eta, t: ev.t });
  } else if (ev.kind === 'eta-null') {
    state.set(ev.mmsi, { bridge: prev.bridge, eta: null, t: ev.t });
  } else if (ev.kind === 'pa') {
    state.set(ev.mmsi, { bridge: prev.bridge, eta: ev.eta, t: ev.t });
  } else if (ev.kind === 'target') {
    state.set(ev.mmsi, { bridge: ev.bridge, eta: prev.eta, t: ev.t });
  }
}

/** Appens egen giltighetsregel (lib/utils/etaValidation.isValidETA). */
function isValidEta(x) {
  return Number.isFinite(x) && x > 0 && x <= 1440;
}

/**
 * Matchar ett rekonstruerat etaMinutes den publicerade minutsiffran?
 * Klausulen bildas som Math.round(etaMinutes), alltså N ⇔ eta ∈ [N−0,5, N+0,5).
 * Men det rekonstruerade värdet kommer ur en LOGGRAD som skrivits med
 * toFixed(1) — det sanna värdet ligger i eta ± 0,05. Fönstret vidgas därför
 * till [N−0,55, N+0,55): utan det föll t.ex. loggens "5.5" (sant 5,49 →
 * publicerat 5) ut som en avvikelse. Undantaget är den extrapolerade
 * strax-zonen som skriver fast "om cirka 2 minuter" för ALLA värden < 3
 * (formatETABroOpeningClause).
 */
const LOG_ROUNDING_SLACK_MIN = 0.05;

function roundsTo(eta, minutes, approx) {
  const lo = minutes - 0.5 - LOG_ROUNDING_SLACK_MIN;
  const hi = minutes + 0.5 + LOG_ROUNDING_SLACK_MIN;
  if (eta >= lo && eta < hi) return true;
  return approx === true && minutes === 2 && eta < 3;
}

/**
 * Peka ut den båt brotexten gäller.
 * minutes === null (klausulen "strax") ⇒ ingen värdekontroll är möjlig, då
 * gäller enbart appens ledarregel (lägst giltig etaMinutes i brogruppen).
 */
function attributeLead(state, bridge, minutes, approx, tNow, restrictTo = null) {
  const cands = [];
  for (const [mmsi, s] of state) {
    if (restrictTo ? !restrictTo.has(mmsi) : s.bridge !== bridge) continue;
    if (!isValidEta(s.eta)) continue;
    if (tNow - s.t > STATE_TTL_MS) continue;
    cands.push({ mmsi, eta: s.eta });
  }
  cands.sort((a, b) => (a.eta - b.eta) || (a.mmsi < b.mmsi ? -1 : 1));
  if (cands.length === 0) return { mmsi: null, confidence: 'ingen-kandidat', candidates: 0 };
  const lead = cands[0];
  if (minutes === null) {
    return {
      mmsi: lead.mmsi, confidence: 'ledare', candidates: cands.length, eta: lead.eta,
    };
  }
  if (roundsTo(lead.eta, minutes, approx)) {
    return {
      mmsi: lead.mmsi, confidence: 'ledare', candidates: cands.length, eta: lead.eta,
    };
  }
  const matches = cands.filter((c) => roundsTo(c.eta, minutes, approx));
  if (matches.length === 1) {
    return {
      mmsi: matches[0].mmsi, confidence: 'värde', candidates: cands.length, eta: matches[0].eta,
    };
  }
  if (matches.length > 1) {
    return {
      mmsi: matches[0].mmsi, confidence: 'värde-tvetydig', candidates: cands.length, eta: matches[0].eta,
    };
  }
  return {
    mmsi: lead.mmsi, confidence: 'ledare-avviker', candidates: cands.length, eta: lead.eta,
  };
}

/**
 * Peka ut båten bakom EN brotextfras.
 *
 * Bästa källan är appens EGEN filterrad (VesselDataService:1990): den listar
 * exakt vilka fartyg som gick in i texten och mot vilken målbro. Passet
 * godtas bara när dess gruppstorlek stämmer med textens räkneord ("En båt",
 * "Två båtar", …) — en oberoende kontroll av att rätt pass matchats mot rätt
 * text. Håller det, och gruppen har EN medlem, är identiteten bevisad utan
 * att någon ETA behöver stämma (det räddar de EXTRAPOLERADE "om cirka N
 * minuter"-nedräkningarna, som inte lämnar någon [ETA_CALC_V2]-rad alls).
 * Annars faller utpekningen tillbaka på ledarregeln.
 *
 * @param {Object} args
 * @returns {{mmsi:(string|null), confidence:string, candidates:number, eta?:number}}
 */
function attributeClaim({
  state, pass, bridge, count, minutes, approx, t,
}) {
  const group = pass && Array.isArray(pass.included)
    ? pass.included.filter((v) => v.bridge === bridge)
    : null;
  if (group && Number.isFinite(count) && group.length === count && count > 0) {
    if (count === 1) {
      return { mmsi: group[0].mmsi, confidence: 'grupp-ensam', candidates: 1 };
    }
    const members = new Set(group.map((v) => v.mmsi));
    const att = attributeLead(state, bridge, minutes, approx, t, members);
    if (att.confidence === 'ledare-avviker') {
      // Identiteten är begränsad till en KÄND grupp men siffran matchar
      // ingen medlem (extrapolerad nedräkning i flerbåtsgrupp) — appens
      // ledarregel pekar ändå ut rätt båt bland just dessa.
      return { ...att, confidence: 'grupp-ledare' };
    }
    if (att.confidence === 'ingen-kandidat') {
      return { mmsi: null, confidence: 'grupp-utan-eta', candidates: group.length };
    }
    return att;
  }
  return attributeLead(state, bridge, minutes, approx, t);
}

// Vilka utpekningar som får bära ett mätvärde. 'ledare-avviker' och
// 'ingen-kandidat' betyder att rekonstruktionen INTE kunde bevisa vilken båt
// texten gällde — de räknas som oattribuerade i stället för att gissa en
// sanning ur fel fartygs passagetid.
const TRUSTED_ATTRIBUTION = new Set([
  'grupp-ensam', 'grupp-ledare', 'ledare', 'värde', 'värde-tvetydig',
  'renderad-ledare',
]);

/**
 * Matcha bara faktisk returtext vid publiceringens exakta fejkklockslag.
 * Ett övergivet renderingsförslag, en äldre lika text eller två olika
 * ledare i samma millisekund får inte frikännas genom att gissa på logg-ETA.
 */
function attributeRenderedClaim(renderings, transition, phrase) {
  const absent = { mmsi: null, confidence: 'rendering-saknas', candidates: 0 };
  const matches = renderings.filter((r) => r.t === transition.t && r.text === transition.text);
  if (!matches.length) return absent;
  const choices = [];
  for (const rendering of matches) {
    const groups = rendering.groups.filter((g) => g && g.bridge === phrase.bridge
      && Array.isArray(g.members) && g.members.length === phrase.count
      && transition.text.split(';').some((part) => part.trim() === g.phrase));
    if (groups.length !== 1) return absent;
    const group = groups[0];
    if (!group.mmsi || !group.members.includes(group.mmsi)) return absent;
    // En annan gruppmedlems närhet kan styra "strax". Formateraren anger
    // dominansen men inte dess MMSI; den utpekas därför inte som ETA-ledaren.
    if (group.imminent && group.members.length > 1) {
      choices.push({ mmsi: null, confidence: 'renderad-gruppdominans', candidates: group.members.length });
    } else {
      choices.push({
        mmsi: group.mmsi, confidence: 'renderad-ledare', candidates: group.members.length, eta: group.eta,
      });
    }
  }
  const first = choices[0];
  if (choices.some((c) => c.mmsi !== first.mmsi || c.confidence !== first.confidence)) {
    return { mmsi: null, confidence: 'rendering-tvetydig', candidates: first.candidates };
  }
  // Identiteten kan vara entydig trots två olika oavrundade ETA-värden.
  return { ...first, eta: choices.every((c) => c.eta === first.eta) ? first.eta : undefined };
}

// ---------------------------------------------------------------------------
// K6: dubbelkörningsfrekvens
// ---------------------------------------------------------------------------
function measureDoubleRuns(list) {
  const byMmsi = new Map();
  for (const e of list) {
    if (!byMmsi.has(e.mmsi)) byMmsi.set(e.mmsi, []);
    byMmsi.get(e.mmsi).push(e);
  }
  let pairs = 0;
  let pairsChangedValue = 0;
  // Riktningen på andra passets skift. K6:s mekanism är att pass 2 kör EMA en
  // gång till mot pass 1:s FÄRSKA värde — andra passet dras därför tillbaka
  // mot den gamla historiken. Efter en K6-fix ska pairs gå mot 0 och båda
  // dessa räknare med.
  let pairsSecondLower = 0;
  let pairsSecondHigher = 0;
  let sumAbsPairDelta = 0;
  let maxDtInPair = 0;
  // Härledning av hinkarna: 0 ms = båda passen i SAMMA sampelsteg innan
  // grace-tick:et; 1–60 ms = snapshotpasset efter clock.tick(60); 61–199 ms =
  // två sampel som levererades under 200 ms isär (kan vara ÄKTA skilda fixar
  // — redovisas separat så talet är granskningsbart).
  const dtBuckets = { 0: 0, '1-60': 0, '61-199': 0 };
  const mmsiSet = new Set();
  for (const [mmsi, evs] of byMmsi) {
    evs.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
    for (let i = 1; i < evs.length; i += 1) {
      const dt = evs[i].t - evs[i - 1].t;
      if (dt >= 0 && dt < DOUBLE_RUN_WINDOW_MS) {
        pairs += 1;
        mmsiSet.add(mmsi);
        if (dt > maxDtInPair) maxDtInPair = dt;
        if (dt === 0) dtBuckets['0'] += 1;
        else if (dt <= 60) dtBuckets['1-60'] += 1;
        else dtBuckets['61-199'] += 1;
        if (evs[i].eta !== evs[i - 1].eta) {
          pairsChangedValue += 1;
          if (Number.isFinite(evs[i].eta) && Number.isFinite(evs[i - 1].eta)) {
            if (evs[i].eta < evs[i - 1].eta) pairsSecondLower += 1;
            else pairsSecondHigher += 1;
            sumAbsPairDelta += Math.abs(evs[i].eta - evs[i - 1].eta);
          }
        }
      }
    }
  }
  return {
    lines: list.length,
    pairs,
    pairsChangedValue,
    pairsSecondLower,
    pairsSecondHigher,
    sumAbsPairDeltaMin: round2(sumAbsPairDelta),
    meanAbsPairDeltaMin: pairsChangedValue > 0 ? round2(sumAbsPairDelta / pairsChangedValue) : null,
    mmsiWithPairs: mmsiSet.size,
    maxDtInPairMs: maxDtInPair,
    pairsByDt: dtBuckets,
    shareOfLinesInPair: list.length > 0 ? round2(((pairs * 2) / list.length) * 100) : null,
  };
}

function measureSelfCausedOutliers(outliers, etaCalcs) {
  const byMmsi = new Map();
  for (const e of etaCalcs) {
    if (!byMmsi.has(e.mmsi)) byMmsi.set(e.mmsi, []);
    byMmsi.get(e.mmsi).push(e.t);
  }
  for (const list of byMmsi.values()) list.sort((a, b) => a - b);
  let selfCaused = 0;
  const byReason = {};
  for (const o of outliers) {
    // Skälssträngen bär kvoten ("dramatic_increase_5.00x") — gruppera på
    // FAMILJEN så aggregatet blir läsbart; hela strängen finns kvar per rad.
    const family = o.reason.replace(/_[\d.]+x$/, '');
    byReason[family] = (byReason[family] || 0) + 1;
    const times = byMmsi.get(o.mmsi) || [];
    if (times.some((t) => t < o.t && o.t - t < DOUBLE_RUN_WINDOW_MS)) selfCaused += 1;
  }
  const sortedReasons = {};
  for (const k of Object.keys(byReason).sort()) sortedReasons[k] = byReason[k];
  return { lines: outliers.length, selfCaused, byReason: sortedReasons };
}

// ---------------------------------------------------------------------------
// Bygg påståendelistan för EN korpus
// ---------------------------------------------------------------------------
function collectClaims(corpus, run, gt) {
  const { replay, debug } = run;
  const names = new Map();
  for (const v of replay.vessels || []) {
    const idx = v.indexOf(':');
    if (idx === -1) continue;
    const mmsi = v.slice(0, idx);
    const nm = v.slice(idx + 1);
    if (nm && nm !== 'Unknown') names.set(mmsi, nm);
  }

  const claims = [];
  const textStats = {
    phrases: 0, numeric: 0, strax: 0, unknown: 0, byConfidence: {}, straxByConfidence: {},
  };
  const straxClaims = [];

  // ---- (a) brotextens påståenden -----------------------------------------
  const transitions = (replay.bridgeTextTransitions || [])
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const state = new Map();
  let pass = null;
  let si = 0;
  const stream = debug.events;
  const renderingsByTime = new Map();
  for (const rendering of debug.renderings || []) {
    if (!renderingsByTime.has(rendering.t)) renderingsByTime.set(rendering.t, []);
    renderingsByTime.get(rendering.t).push(rendering);
  }
  for (const tr of transitions) {
    while (si < stream.length && stream[si].t <= tr.t) {
      if (stream[si].kind === 'filterpass') pass = stream[si];
      else applyEvent(state, stream[si]);
      si += 1;
    }
    for (const phrase of parseBridgeTextClaims(tr.text)) {
      textStats.phrases += 1;
      if (phrase.clause === 'okänd') {
        textStats.unknown += 1; continue;
      }
      const att = debug.renderCapture
        ? attributeRenderedClaim(renderingsByTime.get(tr.t) || [], tr, phrase)
        : attributeClaim({
          state,
          pass,
          bridge: phrase.bridge,
          count: phrase.count,
          minutes: phrase.minutes,
          approx: phrase.approx,
          t: tr.t,
        });
      if (phrase.clause === 'strax') {
        const sc = textStats.straxByConfidence;
        sc[att.confidence] = (sc[att.confidence] || 0) + 1;
        textStats.strax += 1;
        // "strax" bär inget tal men ett LÖFTE (< 3 min). Mäts separat.
        if (att.mmsi && TRUSTED_ATTRIBUTION.has(att.confidence)) {
          const cross = nextCrossing(gt, att.mmsi, phrase.bridge, tr.t);
          if (cross && !cross.inferred) {
            straxClaims.push({ truth: (cross.t - tr.t) / 60000 });
          }
        }
        continue;
      }
      textStats.byConfidence[att.confidence] = (textStats.byConfidence[att.confidence] || 0) + 1;
      textStats.numeric += 1;
      claims.push({
        kind: 'brotext',
        corpus: corpus.id,
        t: tr.t,
        iso: new Date(tr.t).toISOString(),
        bridge: phrase.bridge,
        mmsi: att.mmsi,
        name: att.mmsi ? (names.get(att.mmsi) || null) : null,
        published: phrase.minutes,
        approx: phrase.approx,
        source: 'bridge_text',
        attribution: att.confidence,
        candidates: att.candidates,
        leadEta: round2(att.eta),
        text: tr.text,
      });
    }
  }

  // ---- (b) boat_near-notisernas eta_minutes ------------------------------
  for (const n of replay.notifications || []) {
    if (!Number.isFinite(n.t) || !n.bridge || !n.mmsi) continue;
    if (!Number.isFinite(n.eta) || n.eta === ETA_UNKNOWN_TOKEN) continue;
    claims.push({
      kind: 'notis',
      corpus: corpus.id,
      t: n.t,
      iso: new Date(n.t).toISOString(),
      bridge: n.bridge,
      mmsi: String(n.mmsi),
      name: n.name || names.get(String(n.mmsi)) || null,
      published: n.eta,
      approx: false,
      source: n.source || 'okänd',
      attribution: 'token',
      candidates: null,
      leadEta: null,
      distance: Number.isFinite(n.distance) ? n.distance : null,
    });
  }

  // ---- (c) öppningskortets eta_minutes -----------------------------------
  for (const w of replay.openingWarnings || []) {
    if (!Number.isFinite(w.t) || !w.bridge || !w.leadMmsi) continue;
    if (!Number.isFinite(w.etaMin) || w.etaMin === ETA_UNKNOWN_TOKEN) continue;
    claims.push({
      kind: 'öppningskort',
      corpus: corpus.id,
      t: w.t,
      iso: new Date(w.t).toISOString(),
      bridge: w.bridge,
      mmsi: String(w.leadMmsi),
      name: w.leadVessel || names.get(String(w.leadMmsi)) || null,
      published: w.etaMin,
      approx: false,
      source: w.firedBy ? `öppning:${w.firedBy}` : 'öppning',
      attribution: 'token',
      candidates: null,
      leadEta: null,
      distance: Number.isFinite(w.distance) ? w.distance : null,
      eventId: w.eventId || null,
    });
  }

  // ---- sanning per påstående ---------------------------------------------
  for (const c of claims) {
    const attributed = c.attribution === 'token' || TRUSTED_ATTRIBUTION.has(c.attribution);
    if (!c.mmsi || !attributed) {
      c.status = 'oattribuerad';
      continue;
    }
    const cross = nextCrossing(gt, c.mmsi, c.bridge, c.t);
    if (!cross) {
      c.status = hasZoneAfter(gt, c.mmsi, c.bridge, c.t) ? 'zon-ej-linjefacit' : 'ingen-korsning';
      continue;
    }
    if (cross.inferred) {
      c.status = 'inferred';
      c.truth = round2((cross.t - c.t) / 60000);
      continue;
    }
    c.status = 'mätt';
    c.truthKind = cross.kind;
    c.truth = round2((cross.t - c.t) / 60000);
    c.error = round2(c.published - (cross.t - c.t) / 60000);
  }

  claims.sort((a, b) => (a.t - b.t) || (a.kind < b.kind ? -1 : 1));
  return { claims, textStats, straxClaims };
}

// ---------------------------------------------------------------------------
// Aggregering
// ---------------------------------------------------------------------------
function groupBy(items, keyFn) {
  const out = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(it);
  }
  return out;
}

const CLAIM_STATUSES = ['mätt', 'inferred', 'ingen-korsning', 'zon-ej-linjefacit', 'oattribuerad'];

function statusCounts(claims) {
  const acc = {};
  for (const st of CLAIM_STATUSES) acc[st] = 0;
  for (const c of claims) acc[c.status] = (acc[c.status] || 0) + 1;
  return acc;
}

// Robustfönstret. Härledning: ett påstående vars faktiska passage kom först
// efter en TIMME beskriver en båt som lade till, ankrade eller vände — felet
// är äkta men storleksordningen (hundratals minuter) dränker medelvärdet för
// alla andra. Delmängden truth ≤ 60 min är det jämförbara måttet mellan två
// körningar; hela mängden redovisas alltid bredvid.
const ROBUST_TRUTH_WINDOW_MIN = 60;

function breakdown(measured, keyFn) {
  const g = groupBy(measured, keyFn);
  const res = {};
  for (const k of [...g.keys()].sort()) res[k] = summarize(g.get(k));
  return res;
}

function mergeCounts(list) {
  const acc = {};
  for (const obj of list) {
    for (const [k, v] of Object.entries(obj)) acc[k] = (acc[k] || 0) + v;
  }
  const sorted = {};
  for (const k of Object.keys(acc).sort()) sorted[k] = acc[k];
  return sorted;
}

function buildReport(corpusResults, opts) {
  const allMeasured = [];
  const allClaims = [];
  for (const r of corpusResults) {
    allClaims.push(...r.claims);
    allMeasured.push(...r.claims.filter((c) => c.status === 'mätt'));
  }
  const emptyDouble = () => ({
    lines: 0,
    pairs: 0,
    pairsChangedValue: 0,
    pairsSecondLower: 0,
    pairsSecondHigher: 0,
    sumAbsPairDeltaMin: 0,
    mmsiWithPairs: 0,
    maxDtInPairMs: 0,
    pairsByDt: { 0: 0, '1-60': 0, '61-199': 0 },
  });
  const totalDouble = {
    etaCalcV2: emptyDouble(),
    etaStart: emptyDouble(),
    outliers: { lines: 0, selfCaused: 0, byReason: {} },
    smoothingLines: 0,
  };
  for (const r of corpusResults) {
    for (const key of ['etaCalcV2', 'etaStart']) {
      totalDouble[key].lines += r.doubleRuns[key].lines;
      totalDouble[key].pairs += r.doubleRuns[key].pairs;
      totalDouble[key].pairsChangedValue += r.doubleRuns[key].pairsChangedValue;
      totalDouble[key].pairsSecondLower += r.doubleRuns[key].pairsSecondLower;
      totalDouble[key].pairsSecondHigher += r.doubleRuns[key].pairsSecondHigher;
      totalDouble[key].sumAbsPairDeltaMin += r.doubleRuns[key].sumAbsPairDeltaMin;
      totalDouble[key].mmsiWithPairs += r.doubleRuns[key].mmsiWithPairs;
      totalDouble[key].maxDtInPairMs = Math.max(
        totalDouble[key].maxDtInPairMs, r.doubleRuns[key].maxDtInPairMs,
      );
      for (const bucket of Object.keys(totalDouble[key].pairsByDt)) {
        totalDouble[key].pairsByDt[bucket] += r.doubleRuns[key].pairsByDt[bucket] || 0;
      }
    }
    totalDouble.outliers.lines += r.doubleRuns.outliers.lines;
    totalDouble.outliers.selfCaused += r.doubleRuns.outliers.selfCaused;
    for (const [k, v] of Object.entries(r.doubleRuns.outliers.byReason)) {
      totalDouble.outliers.byReason[k] = (totalDouble.outliers.byReason[k] || 0) + v;
    }
    totalDouble.smoothingLines += r.doubleRuns.smoothingLines;
  }
  for (const key of ['etaCalcV2', 'etaStart']) {
    totalDouble[key].shareOfLinesInPair = totalDouble[key].lines > 0
      ? round2(((totalDouble[key].pairs * 2) / totalDouble[key].lines) * 100) : null;
    totalDouble[key].sumAbsPairDeltaMin = round2(totalDouble[key].sumAbsPairDeltaMin);
    totalDouble[key].meanAbsPairDeltaMin = totalDouble[key].pairsChangedValue > 0
      ? round2(totalDouble[key].sumAbsPairDeltaMin / totalDouble[key].pairsChangedValue) : null;
  }

  const straxAll = corpusResults.flatMap((r) => r.straxClaims);
  const straxTruths = straxAll.map((s) => s.truth).sort((a, b) => a - b);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      label: opts.label,
      corpora: corpusResults.map((r) => r.id),
      doubleRunWindowMs: DOUBLE_RUN_WINDOW_MS,
      stateTtlMs: STATE_TTL_MS,
      stampMode: opts.stamp ? 'fejkklock-stämplad stderr' : 'sampelankrad stderr',
      runner: path.relative(ROOT, RUNNER),
      note: 'Sanningen är gt-passages (rådatafacit). inferred-korsningar används aldrig som punktstämpel.',
    },
    total: {
      claims: allClaims.length,
      measured: summarize(allMeasured),
      measuredWithin60: summarize(allMeasured.filter((c) => c.truth <= ROBUST_TRUTH_WINDOW_MIN)),
      status: statusCounts(allClaims),
      byKind: breakdown(allMeasured, (c) => c.kind),
      byBridge: breakdown(allMeasured, (c) => c.bridge),
      bySource: breakdown(allMeasured, (c) => c.source),
      textAttribution: mergeCounts(corpusResults.map((r) => r.textStats.byConfidence)),
      straxAttribution: mergeCounts(corpusResults.map((r) => r.textStats.straxByConfidence)),
      textClauses: mergeCounts(corpusResults.map((r) => ({
        fraser: r.textStats.phrases,
        minutsiffra: r.textStats.numeric,
        strax: r.textStats.strax,
        'ETA okänd': r.textStats.unknown,
      }))),
      straxPromise: {
        n: straxTruths.length,
        medianTruthMin: round2(median(straxTruths)),
        p90TruthMin: round2(percentile(straxTruths, 0.9)),
        within3Min: straxTruths.length > 0
          ? round2((straxTruths.filter((x) => x <= 3).length / straxTruths.length) * 100) : null,
      },
      doubleRuns: totalDouble,
      worst10: worstN(allMeasured, 10),
    },
    corpora: corpusResults.map((r) => ({
      id: r.id,
      locked: r.locked,
      hours: r.hours,
      jsonl: path.basename(r.jsonl),
      gtCrossings: r.gtCrossings,
      replay: {
        sampleCount: r.sampleCount,
        processErrors: r.processErrors,
        bridgeTextTransitions: r.transitions,
        notifications: r.notifications,
        openingWarnings: r.openings,
      },
      claims: r.claims.length,
      status: statusCounts(r.claims),
      measured: summarize(r.claims.filter((c) => c.status === 'mätt')),
      measuredWithin60: summarize(r.claims.filter(
        (c) => c.status === 'mätt' && c.truth <= ROBUST_TRUTH_WINDOW_MIN,
      )),
      byKind: breakdown(r.claims.filter((c) => c.status === 'mätt'), (c) => c.kind),
      textStats: r.textStats,
      doubleRuns: r.doubleRuns,
      worst10: worstN(r.claims.filter((c) => c.status === 'mätt'), 10),
      allClaims: r.claims,
    })),
  };
}

// ---------------------------------------------------------------------------
// Läsbar rapport
// ---------------------------------------------------------------------------
function fmt(x, width, digits) {
  let s;
  if (x === null || x === undefined) s = '–';
  else if (typeof x === 'number') s = x.toFixed(digits ?? 2);
  else s = String(x);
  return s.padStart(width);
}

function renderText(report) {
  const L = [];
  L.push('ETA-NOGGRANNHET — publicerade ETA:er mot rådatafacit (gt-passages)');
  L.push('='.repeat(78));
  L.push(`Etikett       : ${report.meta.label || '(ingen)'}`);
  L.push(`Genererad     : ${report.meta.generatedAt}`);
  L.push(`Korpusar      : ${report.meta.corpora.length} st`);
  L.push(`Tidsstämpling : ${report.meta.stampMode}`);
  L.push('');
  L.push('FELDEFINITION: fel = publicerad ETA − (nästa faktiska brolinjekorsning');
  L.push('för samma mmsi+bro − påståendets tid). Positivt fel = appen lovade');
  L.push('SENARE än verkligheten (för pessimistisk); negativt = för optimistisk.');
  L.push('Sanningen kommer ur gt-passages (rådatafacit, kind=line). inferred-');
  L.push('korsningar och Kanalinfartens zonbesök bär ingen punktstämpel och');
  L.push('ligger utanför felstatistiken (redovisas som egna hinkar).');
  L.push('');
  L.push('PER KORPUS');
  L.push('-'.repeat(78));
  L.push([
    'korpus'.padEnd(20), 'mätta'.padStart(6), 'summa|f|'.padStart(10),
    'median'.padStart(8), 'p90'.padStart(8), 'bias'.padStart(8), '≤2min%'.padStart(8),
  ].join(' '));
  for (const c of report.corpora) {
    const m = c.measured;
    L.push([
      c.id.padEnd(20), fmt(m.n, 6, 0), fmt(m.sumAbsErr, 10, 1),
      fmt(m.medianAbsErr, 8, 2), fmt(m.p90AbsErr, 8, 2), fmt(m.bias, 8, 2), fmt(m.within2, 8, 1),
    ].join(' '));
  }
  const t = report.total.measured;
  const t60 = report.total.measuredWithin60;
  L.push('-'.repeat(78));
  L.push([
    'TOTALT'.padEnd(20), fmt(t.n, 6, 0), fmt(t.sumAbsErr, 10, 1),
    fmt(t.medianAbsErr, 8, 2), fmt(t.p90AbsErr, 8, 2), fmt(t.bias, 8, 2), fmt(t.within2, 8, 1),
  ].join(' '));
  L.push([
    `TOT (sanning≤${ROBUST_TRUTH_WINDOW_MIN}min)`.padEnd(20), fmt(t60.n, 6, 0), fmt(t60.sumAbsErr, 10, 1),
    fmt(t60.medianAbsErr, 8, 2), fmt(t60.p90AbsErr, 8, 2), fmt(t60.bias, 8, 2), fmt(t60.within2, 8, 1),
  ].join(' '));
  L.push('');
  L.push(`Påståenden totalt: ${report.total.claims}  `
    + `(mätta ${report.total.status.mätt}, `
    + `inferred-sanning ${report.total.status.inferred}, `
    + `ingen korsning ${report.total.status['ingen-korsning']}, `
    + `zon utan linjefacit ${report.total.status['zon-ej-linjefacit']}, `
    + `oattribuerade ${report.total.status.oattribuerad})`);
  L.push('');
  L.push('PER PÅSTÅENDETYP (mätta)');
  L.push('-'.repeat(78));
  for (const [k, v] of Object.entries(report.total.byKind)) {
    L.push(`  ${k.padEnd(14)} n=${fmt(v.n, 5, 0)}  summa|f|=${fmt(v.sumAbsErr, 9, 1)}`
      + `  median=${fmt(v.medianAbsErr, 6, 2)}  p90=${fmt(v.p90AbsErr, 6, 2)}`
      + `  bias=${fmt(v.bias, 7, 2)}  ≤2min=${fmt(v.within2, 6, 1)}%`);
  }
  L.push('');
  L.push('PER BRO (mätta)');
  L.push('-'.repeat(78));
  for (const [k, v] of Object.entries(report.total.byBridge)) {
    L.push(`  ${k.padEnd(16)} n=${fmt(v.n, 5, 0)}  median=${fmt(v.medianAbsErr, 6, 2)}`
      + `  p90=${fmt(v.p90AbsErr, 6, 2)}  bias=${fmt(v.bias, 7, 2)}  ≤2min=${fmt(v.within2, 6, 1)}%`);
  }
  L.push('');
  L.push('PER KÄLLA (mätta)');
  L.push('-'.repeat(78));
  for (const [k, v] of Object.entries(report.total.bySource)) {
    L.push(`  ${k.padEnd(16)} n=${fmt(v.n, 5, 0)}  median=${fmt(v.medianAbsErr, 6, 2)}`
      + `  p90=${fmt(v.p90AbsErr, 6, 2)}  bias=${fmt(v.bias, 7, 2)}  ≤2min=${fmt(v.within2, 6, 1)}%`);
  }
  L.push('');
  L.push('BROTEXTENS KLAUSULER OCH LEDARUTPEKNING');
  L.push('-'.repeat(78));
  L.push(`  klausuler: ${Object.entries(report.total.textClauses)
    .map(([k, v]) => `${k}=${v}`).join('  ')}`);
  L.push('  utpekning av MINUTSIFFRANS båt (mätbara påståenden):');
  for (const [k, v] of Object.entries(report.total.textAttribution)) {
    L.push(`     ${k.padEnd(18)} ${v}`);
  }
  L.push('  utpekning för "strax" (gruppdominans utan entydig båt hålls omätt):');
  for (const [k, v] of Object.entries(report.total.straxAttribution)) {
    L.push(`     ${k.padEnd(18)} ${v}`);
  }
  const sp = report.total.straxPromise;
  L.push('');
  L.push('"STRAX"-LÖFTET (klausulen utan siffra — utlovar < 3 min)');
  L.push('-'.repeat(78));
  L.push(`  n=${sp.n}  median faktisk tid till passage=${fmt(sp.medianTruthMin, 6, 2)} min`
    + `  p90=${fmt(sp.p90TruthMin, 6, 2)} min  andel ≤3 min=${fmt(sp.within3Min, 6, 1)}%`);
  L.push('');
  L.push('K6-BEVIS: DUBBELKÖRNINGSFREKVENS (par för samma mmsi inom '
    + `<${DOUBLE_RUN_WINDOW_MS} ms fejkklocka)`);
  L.push('-'.repeat(78));
  const d = report.total.doubleRuns;
  L.push(`  [ETA_CALC_V2] rader=${d.etaCalcV2.lines}  par=${d.etaCalcV2.pairs}`
    + `  varav ÄNDRAT värde=${d.etaCalcV2.pairsChangedValue}`
    + `  andel rader i par=${fmt(d.etaCalcV2.shareOfLinesInPair, 5, 1)}%`
    + `  största dt i par=${d.etaCalcV2.maxDtInPairMs} ms`);
  L.push(`                dt-fördelning i paren: ${Object.entries(d.etaCalcV2.pairsByDt)
    .map(([k, v]) => `${k} ms=${v}`).join('  ')}`);
  L.push(`                pass 2 SÄNKTE=${d.etaCalcV2.pairsSecondLower}`
    + `  pass 2 HÖJDE=${d.etaCalcV2.pairsSecondHigher}`
    + `  medelskift=${fmt(d.etaCalcV2.meanAbsPairDeltaMin, 5, 2)} min`
    + `  summa skift=${fmt(d.etaCalcV2.sumAbsPairDeltaMin, 8, 1)} min`);
  L.push(`  [ETA_START]   rader=${d.etaStart.lines}  par=${d.etaStart.pairs}`
    + `  andel rader i par=${fmt(d.etaStart.shareOfLinesInPair, 5, 1)}%`);
  L.push(`  [ETA_SMOOTHING] rader=${d.smoothingLines}`);
  L.push(`  [ETA_OUTLIER] rader=${d.outliers.lines}`
    + `  varav mot < ${DOUBLE_RUN_WINDOW_MS} ms gammal EGEN baslinje=${d.outliers.selfCaused}`);
  L.push(`                skäl: ${Object.entries(d.outliers.byReason)
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') || '(inga)'}`);
  L.push('');
  L.push('  per korpus:');
  for (const c of report.corpora) {
    L.push(`   ${c.id.padEnd(20)} calc=${String(c.doubleRuns.etaCalcV2.lines).padStart(6)}`
      + ` par=${String(c.doubleRuns.etaCalcV2.pairs).padStart(6)}`
      + ` ändrade=${String(c.doubleRuns.etaCalcV2.pairsChangedValue).padStart(6)}`
      + ` outlier=${String(c.doubleRuns.outliers.lines).padStart(4)}`
      + ` självorsakade=${String(c.doubleRuns.outliers.selfCaused).padStart(4)}`);
  }
  L.push('');
  L.push('DE 10 VÄRSTA PÅSTÅENDENA (totalt)');
  L.push('-'.repeat(78));
  for (const c of report.total.worst10) {
    L.push(`  ${c.iso}  ${c.kind.padEnd(12)} ${c.bridge.padEnd(15)} `
      + `${(c.name || c.mmsi || '?').padEnd(18)} publ=${fmt(c.published, 5, 0)} min  `
      + `sanning=${fmt(c.truth, 8, 1)} min  fel=${fmt(c.error, 8, 1)} min  [${c.corpus}, ${c.source}]`);
  }
  L.push('');
  L.push('DE 5 VÄRSTA PER KORPUS');
  L.push('-'.repeat(78));
  for (const c of report.corpora) {
    L.push(`  ${c.id}`);
    for (const w of c.worst10.slice(0, 5)) {
      L.push(`     ${w.iso} ${w.kind.padEnd(12)} ${w.bridge.padEnd(15)} `
        + `${(w.name || w.mmsi || '?').padEnd(18)} publ=${fmt(w.published, 5, 0)}  `
        + `sanning=${fmt(w.truth, 8, 1)}  fel=${fmt(w.error, 8, 1)}`);
    }
  }
  L.push('');
  return `${L.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    outDir: null, only: null, includeUnlocked: false, label: null, stamp: true,
  };
  for (const a of argv) {
    if (a === '--include-unlocked') opts.includeUnlocked = true;
    else if (a === '--no-stamp') opts.stamp = false;
    else if (a.startsWith('--corpus=')) {
      opts.only = a.slice('--corpus='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--label=')) opts.label = a.slice('--label='.length);
    else if (a.startsWith('--out=')) opts.outDir = a.slice('--out='.length);
    else if (a.startsWith('--')) throw new Error(`Okänd flagga: ${a}`);
    else if (!opts.outDir) opts.outDir = a;
    else throw new Error(`Oväntat argument: ${a}`);
  }
  if (!opts.outDir) opts.outDir = DEFAULT_OUT_DIR;
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line global-require
  const corpora = require('./corpora');
  let selected = corpora.filter((c) => opts.includeUnlocked || c.locked);
  if (opts.only) {
    selected = corpora.filter((c) => opts.only.includes(c.id));
    const missing = opts.only.filter((id) => !corpora.some((c) => c.id === id));
    if (missing.length > 0) throw new Error(`Okänd korpus: ${missing.join(', ')}`);
  }
  fs.mkdirSync(opts.outDir, { recursive: true });

  const corpusResults = [];
  for (const corpus of selected) {
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const run = await runCorpus(corpus, opts);
    const gt = loadGtIndex(corpus.id);
    const { claims, textStats, straxClaims } = collectClaims(corpus, run, gt);
    const doubleRuns = {
      etaCalcV2: measureDoubleRuns(run.debug.etaCalcs),
      etaStart: measureDoubleRuns(run.debug.etaStarts),
      outliers: measureSelfCausedOutliers(run.debug.outliers, run.debug.etaCalcs),
      smoothingLines: run.debug.smoothingLines,
      stderrStamped: run.debug.stamped,
      stderrUnstamped: run.debug.unstamped,
    };
    corpusResults.push({
      id: corpus.id,
      locked: corpus.locked === true,
      hours: corpus.hours ?? null,
      jsonl: corpus.jsonl,
      gtCrossings: gt.count,
      sampleCount: run.replay.sampleCount,
      processErrors: run.replay.processErrors || 0,
      transitions: (run.replay.bridgeTextTransitions || []).length,
      notifications: run.replay.notificationCount || 0,
      openings: (run.replay.openingWarnings || []).length,
      claims,
      textStats,
      straxClaims,
      doubleRuns,
    });
    const measured = claims.filter((c) => c.status === 'mätt').length;
    process.stdout.write(`OK ${corpus.id.padEnd(20)} påståenden=${String(claims.length).padStart(5)}`
      + ` mätta=${String(measured).padStart(5)}`
      + ` calc=${String(doubleRuns.etaCalcV2.lines).padStart(6)}`
      + ` par=${String(doubleRuns.etaCalcV2.pairs).padStart(6)}`
      + ` (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
  }

  const report = buildReport(corpusResults, opts);
  const jsonPath = path.join(opts.outDir, 'eta-accuracy.json');
  const txtPath = path.join(opts.outDir, 'eta-accuracy.txt');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 1)}\n`);
  fs.writeFileSync(txtPath, renderText(report));
  process.stdout.write(`\n${renderText(report)}\n`);
  process.stdout.write(`Skrev ${jsonPath}\n`);
  process.stdout.write(`Skrev ${txtPath}\n`);
}

module.exports = {
  installBridgeTextCapture,
  makeStderrCollector,
  collectClaims,
  attributeRenderedClaim,
  parseBridgeTextClaims,
  attributeLead,
  attributeClaim,
  applyEvent,
  roundsTo,
  isValidEta,
  measureDoubleRuns,
  measureSelfCausedOutliers,
  summarize,
  median,
  percentile,
  nextCrossing,
  DOUBLE_RUN_WINDOW_MS,
  STATE_TTL_MS,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`MÄTFEL: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
