'use strict';

/**
 * FASSVEPET — stående grind före korpuslåsning (K20, fältprov 10, 2026-08-21).
 *
 * VARFÖR: replayRunner.js ankrar fejkklockan i korpusens FÖRSTA sampel
 * (`FakeTimers.install({ now: samples[0].aisTimestamp })`, ~rad 104). Allt som
 * drivs av appens EGNA periodiska timrar — 30 s-watchdogen, öppningsmotorns
 * tick, coalescing-fönstren — faller därför på ett rutnät vars fas bestäms av
 * exakt en tidsstämpel i jsonl:en. Fältprov 10 visade att utfallet hänger på
 * den fasen: en förskjutning av starttiden med 11,52 s bytte LEDANDE BÅT,
 * riktning och ETA i Stridsbergsbron#2 (fältet: TONGA/southbound/eta 8/deadline
 * — basreplayn: BALTIC JONGLEUR/northbound/eta 11/fix) och lät ett notis-token
 * vandra 2 → 4 min på identiska data. Notisernas NYCKELmultiset var däremot
 * exakt i alla varianter.
 *
 * Grinden svarar på EN fråga: hänger korpusens utfall på var klockan råkade
 * ankras? Är svaret ja får utfallet inte förevigas som facit utan att någon
 * skrivit ned varför (rådatabevis eller ett motiverat undantag).
 *
 * ANVÄNDNING
 *   npm run replay:phase                     # standardsvep (alla OLÅSTA korpusar)
 *   npm run replay:phase -- <jsonl> [...]    # en eller flera enskilda körningar
 *   node tests/replay-validation/runPhaseSweep.js <jsonl> --offsets=-20,-11.52,-5
 *
 * FLAGGOR
 *   --offsets=<lista>   Fasoffsets i SEKUNDER, kommaseparerade (decimaler ok).
 *                       Default: se DEFAULT_OFFSETS_S. Kan också sättas med
 *                       miljövariabeln PHASE_SWEEP_OFFSETS.
 *   --id=<korpus-id>    Nyckel att slå upp undantag under (default: korpusens
 *                       id i corpora.js, annars filnamnet utan .jsonl).
 *   --exceptions=<fil>  Annan undantagsfil än phase-sweep-exceptions.json.
 *   --keep-temp         Behåll fasvarianternas temporära jsonl-filer.
 *
 * EXITKODER (samma skala som checkReplayIntegrity.js, VALIDATION.md steg 3)
 *   0 = GRÖNT  — inga fas-känsliga utfall, eller samtliga dokumenterade som undantag
 *   1 = RÖTT   — minst ett odokumenterat fas-känsligt utfall, ELLER en korpus
 *                där ingen fasvariant kunde köras (OMÄTT är aldrig grönt)
 *   2 = ANROPSFEL — trasiga argument, saknad fil, ogiltig undantagsfil
 *
 * KORPUSFILEN RÖRS ALDRIG. Varje fasvariant skrivs som en TEMPORÄR kopia där
 * enbart ankarraden är utbytt; kopiorna raderas efteråt (--keep-temp behåller).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const corpora = require('./corpora');

const RUNNER = path.join(__dirname, 'replayRunner.js');
const DEFAULT_EXCEPTIONS_FILE = path.join(__dirname, 'phase-sweep-exceptions.json');

/**
 * Standardsvepets offsets i SEKUNDER. Alla NEGATIVA — se härledningen.
 *
 * HÄRLEDNING, tre led:
 *
 * (1) −5 / −11,52 / −20 s är EXAKT de tre värden fältprov 10 använde och som
 *     docs/VALIDATION.md steg 4 föreskriver för handpåläggning. −11,52 s är det
 *     värde som återgav fältets Stridsbergsbron-varning exakt. De ligger kvar
 *     oförändrade så skriptet och körboken mäter samma sak.
 *
 * (2) Appen har TVÅ periodiska rutnät, och det är värt att hålla isär dem:
 *     watchdogen — och därmed öppningsmotorns deadline-tick
 *     (BRIDGE_OPENING.TICK_INTERVAL_MS = 30 s, lib/constants.js) — tickar var
 *     30:e sekund, medan monitoringloopen (UI_CONSTANTS.MONITORING_INTERVAL_MS
 *     = 60 s) går var 60:e. 60 s är en harmonisk av 30 s i PERIOD, men INTE i
 *     fas (granskningsfynd 2026-08-21). Tre extra värden
 *     (−2,5 / −15 / −25) fyller luckorna så att svepet prövar hela 30 s-varvet
 *     i stället för tre punkter på det.
 *
 * (3) POSITIVA offsets är MEDVETET inte med. En senare start måste rymmas i
 *     korpusens första gap (se writePhaseVariant), och i verkliga fältkorpusar
 *     är gapet millisekunder: både 19/8-dygnet (1348 sampel) och 42h-körningen
 *     (3922 sampel) har 149 respektive 148 ms. Ett default med positiva värden
 *     hade alltså tappat halva svepet på precis de körningar grinden finns för.
 *     De är fortfarande STÖDDA via --offsets (och körs på glesa korpusar), och
 *     de går att ERSÄTTA — men bara ett rutnät i taget: mot 30 s-rutnätet
 *     (watchdog/öppningstick) är +δ samma fas som −(30−δ), mot 60 s-loopen
 *     gäller −(60−δ). +5 s täcks alltså av −25 s på 30 s-rutnätet och av −55 s
 *     på 60 s-loopen; vill man täcka BÅDA får man köra båda värdena.
 *
 * Kostnad: en replay av 19/8-dygnet tar ~1,2 s, så bas + sex varianter landar
 * på ~8,4 s; 42h-korpusen (störst, 3922 sampel) tog 18,9 s. Prestandataket
 * (10 min per replay) är långt bort.
 */
const DEFAULT_OFFSETS_S = [-2.5, -5, -11.52, -15, -20, -25];

/**
 * Tak för replay-utdata. runAllCorpora.js använder 64 MiB för samma runner;
 * samma tak här eftersom svepet kör exakt samma korpusar.
 */
const MAX_BUFFER = 64 * 1024 * 1024;
/** Tak per replay. Samma 10 min som runAllCorpora.js — en replay som hänger är ett fel. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** Så många diffrader skrivs ut per dimension innan resten summeras. */
const MAX_DIFF_ROWS = 12;

// ---------------------------------------------------------------------------
// Argument
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const files = [];
  const opts = {
    offsetsS: null, id: null, exceptionsFile: DEFAULT_EXCEPTIONS_FILE, keepTemp: false,
  };
  for (const a of argv) {
    if (a === '--keep-temp') opts.keepTemp = true;
    else if (a.startsWith('--offsets=')) opts.offsetsS = a.slice('--offsets='.length);
    else if (a.startsWith('--id=')) opts.id = a.slice('--id='.length);
    else if (a.startsWith('--exceptions=')) opts.exceptionsFile = path.resolve(a.slice('--exceptions='.length));
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`Okänd flagga: ${a}`);
    else files.push(a);
  }
  return { files, opts };
}

function parseOffsets(spec) {
  const raw = String(spec).split(',').map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const r of raw) {
    const v = Number(r);
    if (!Number.isFinite(v)) throw new Error(`Ogiltig offset: "${r}" (förväntade sekunder, t.ex. -11.52)`);
    const ms = Math.round(v * 1000);
    // 0 ms vore basen en gång till — ingen fasförskjutning, ingen information.
    if (ms === 0) throw new Error('Offset 0 s är basen själv — utelämna den');
    if (!out.some((o) => o.ms === ms)) out.push({ s: v, ms });
  }
  if (out.length === 0) throw new Error('Tom offsetlista');
  return out;
}

// ---------------------------------------------------------------------------
// Fasvarianter: skifta ANKARET, aldrig korpusfilen
// ---------------------------------------------------------------------------

/**
 * Läser en jsonl RADVIS (rådata bevaras byte för byte) och pekar ut ankarraden.
 *
 * replayRunner sorterar samplen på aisTimestamp och ankrar klockan i det
 * minsta värdet — ankarraden är alltså raden (eller raderna, vid lika värden)
 * med lägst aisTimestamp, oavsett var i filen den ligger.
 */
function readCorpus(jsonlPath) {
  const text = fs.readFileSync(jsonlPath, 'utf8');
  const lines = text.split('\n');
  const parsed = [];
  let minTs = null;
  let nextTs = null; // näst lägsta DISTINKTA tidsstämpel
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`${path.basename(jsonlPath)} rad ${i + 1}: ogiltig JSON (${e.message})`);
    }
    if (!Number.isFinite(obj.aisTimestamp)) {
      throw new Error(`${path.basename(jsonlPath)} rad ${i + 1}: saknar numerisk aisTimestamp`);
    }
    parsed.push({ index: i, obj });
    if (minTs === null || obj.aisTimestamp < minTs) {
      if (minTs !== null && (nextTs === null || minTs < nextTs)) nextTs = minTs;
      minTs = obj.aisTimestamp;
    } else if (obj.aisTimestamp > minTs && (nextTs === null || obj.aisTimestamp < nextTs)) {
      nextTs = obj.aisTimestamp;
    }
  }
  if (parsed.length === 0) throw new Error(`${path.basename(jsonlPath)}: inga sampel`);
  const anchors = parsed.filter((p) => p.obj.aisTimestamp === minTs).map((p) => p.index);
  return {
    lines, parsed, minTs, nextTs, anchors, sampleCount: parsed.length,
  };
}

/**
 * Skriver en fasvariant till `outPath`: ankarraden (alla rader med lägst
 * aisTimestamp) får sin tidsstämpel förskjuten `shiftMs`, ALLA andra rader
 * kopieras oförändrade.
 *
 * VARFÖR JUST ANKARRADEN: att flytta HELA strömmen är en ren translation —
 * gapen är oförändrade och rutnätet följer med, alltså ingen fasändring alls.
 * Ankaret är den enda fas-knappen som finns i datat: flyttas det δ tidigare
 * ligger varje efterföljande sampel δ SENARE i rutnätets fas, medan alla
 * inbördes gap är exakt oförändrade. Det är också precis vad fältprov 10 gjorde
 * ("EXAKT 1 ändrad rad") och vad VALIDATION.md steg 4 föreskriver för hand.
 *
 * ALLA TRE TIDSFÄLTEN skiftas MED aisTimestamp på samma rad: `fixTs` och
 * `receivedAt`. Annars ändras fixens ÅLDER vid inmatning (AISHub-korpusar bär
 * en fixTs som ligger minuter före mottagningen) respektive leveranslatensen
 * (`receivedAt − aisTimestamp`), och då mäter svepet två saker samtidigt — fas
 * OCH datafärskhet. Med alla tre skiftade är varianten en ren fasförskjutning:
 * relativt det nya ankaret är ankarsamplets egna fält identiska med basens.
 *
 * receivedAt togs med 2026-08-21 (granskningsfynd): fältet SKRIVS av app.js men
 * lästes inte i replayvägen just då, så varianten var ren fas ändå — men etapp
 * 5:s metrologiarbete gör leveranslatensen fullt tänkbar som konsument, och då
 * hade svepet blivit tyst fel utan att någon rört svepet. TYPEN BEVARAS: fältet
 * förekommer både som epok-ms (number) och som ISO-8601-sträng i korpusarna, och
 * en typändring vore en dataändring — alltså inte längre ren fas.
 *
 * @returns {{ok: true, changedLines: number}|{ok: false, reason: string}}
 */
/**
 * Skiftar ETT tidsfält på ett sampelobjekt och BEVARAR FÄLTETS TYP.
 *
 * `aisTimestamp` och `fixTs` är epok-ms (number) i alla korpusar, medan
 * `receivedAt` skrivs som ISO-8601 (`new Date().toISOString()`, app.js — grep receivedAt; radnummer utelämnade med flit, de driver)
 * — men fältet kan bära vilken som helst av formerna i en handgjord korpus, och
 * att skriva tillbaka fel typ vore en DATAändring, inte en fasförskjutning.
 * Därför: number in ⇒ number ut, sträng in ⇒ ISO-sträng ut. Allt annat
 * (undefined, null, NaN, ett oparsbart datum) lämnas orört och rapporteras som
 * ohanterat, så en tyst utebliven skiftning inte kan gömma sig.
 *
 * @returns {boolean} true om fältet fanns OCH skiftades
 */
function shiftTimeField(obj, field, shiftMs) {
  const v = obj[field];
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return false;
    obj[field] = v + shiftMs;
    return true;
  }
  if (typeof v === 'string' && v !== '') {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) return false;
    obj[field] = new Date(ms + shiftMs).toISOString();
    return true;
  }
  return false;
}

/** Tidsfälten som följer med ankarraden. Ordningen styr bara utskrifter. */
const SHIFTED_TIME_FIELDS = ['aisTimestamp', 'fixTs', 'receivedAt'];

function writePhaseVariant(corpus, shiftMs, outPath) {
  // Ett POSITIVT skift flyttar ankaret FRAMÅT. Ryms det inte i första gapet
  // hamnar ankarsamplet efter sina grannar när replayRunner sorterar — då är
  // det inte längre en fasförskjutning utan en OMKASTAD ström, och varianten
  // skulle mäta fel sak. Negativa skift är alltid säkra (ankaret förblir minst).
  if (shiftMs > 0) {
    if (corpus.nextTs === null) {
      return {
        ok: false,
        reason: 'alla sampel delar samma tidsstämpel — ett senare ankare blir en ren translation',
      };
    }
    const gap = corpus.nextTs - corpus.minTs;
    if (shiftMs > gap) {
      return {
        ok: false,
        reason: `första gapet är ${gap} ms < ${shiftMs} ms — en senare start skulle kasta om samplen`,
      };
    }
  }

  const anchorSet = new Set(corpus.anchors);
  const shiftedFields = new Set();
  const unshiftedFields = new Set();
  const out = corpus.lines.map((line, i) => {
    if (!anchorSet.has(i)) return line;
    const obj = JSON.parse(line);
    for (const f of SHIFTED_TIME_FIELDS) {
      if (!(f in obj)) continue;
      if (shiftTimeField(obj, f, shiftMs)) shiftedFields.add(f);
      else unshiftedFields.add(f);
    }
    return JSON.stringify(obj);
  });
  fs.writeFileSync(outPath, out.join('\n'), 'utf8');
  return {
    ok: true,
    changedLines: corpus.anchors.length,
    shiftedFields: [...shiftedFields],
    unshiftedFields: [...unshiftedFields],
  };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Kör replayRunner mot en jsonl och plockar ut JSON:en mellan markörerna.
 * Samma anropsmönster som runAllCorpora.js:runCorpus — den funktionen är lokal
 * i sin fil och kan inte importeras (att require:a runAllCorpora skulle KÖRA
 * hela korpusbatteriet, dess kod ligger på toppnivå).
 */
function runReplay(jsonlPath) {
  const t0 = Date.now();
  const stdout = execFileSync('node', [RUNNER, jsonlPath], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: RUN_TIMEOUT_MS,
  });
  const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
  if (!m) throw new Error(`Ingen __REPLAY_JSON__-markör i replay-utdata för ${path.basename(jsonlPath)}`);
  const result = JSON.parse(m[1]);
  if (result.fatal) throw new Error(`replayRunner kastade: ${result.fatal}`);
  if (result.error) throw new Error(`replayRunner: ${result.error}`);
  result.__elapsedMs = Date.now() - t0;
  return result;
}

// ---------------------------------------------------------------------------
// Dimensioner: hur ett utfall görs jämförbart
// ---------------------------------------------------------------------------

/** Multiset som Map(nyckel → antal). */
function countBy(keys) {
  const m = new Map();
  for (const k of keys) m.set(k, (m.get(k) || 0) + 1);
  return m;
}

/**
 * NOTISMULTISET — mmsi:bro:riktning.
 * Exakt samma nyckel som riktningsfacit (corpora-direction-distribution.json,
 * runAllCorpora.js TA2). ETA ingår MEDVETET inte: K20 visade att notisens
 * eta_minutes vandrar med fasen medan nyckelmultiseten står stilla, och det är
 * nyckelmultiseten som är facit. ETA:n rapporteras separat som information.
 */
function notificationKeys(result) {
  return (result.notifications || [])
    .map((n) => `${n.mmsi}:${n.bridge}:${n.direction || 'unknown'}`);
}

/** NOTIS-ETA (endast information) — mmsi:bro:eta. K20:s tredje utfall. */
function notificationEtaKeys(result) {
  return (result.notifications || [])
    .map((n) => `${n.mmsi}:${n.bridge}:eta=${n.eta === undefined ? 'null' : n.eta}`);
}

/**
 * MÅLBROPASSAGER — mmsi:bro.
 * docs/VALIDATION.md steg 4 räknar passagerna som en egen grön-dimension.
 */
function passageKeys(result) {
  return (result.targetPassages || []).map((p) => `${p.mmsi}:${p.bridge}`);
}

/**
 * ÖPPNINGSVARNINGAR — nyckel "Bro#n" (n:te varningen vid den bron, i tidsordning),
 * jämfört värde "ledande=… riktning=… eta=… källa=…".
 *
 * VARFÖR EGEN ORDNINGSNYCKEL och inte servicens eventId: eventId är
 * `${bro}#${globalt löpnummer}` (BridgeOpeningService.js:1368) och räknaren tickar
 * för VARJE öppnad händelse — även sådana som aldrig varnar. Ett fasbyte som
 * enbart flyttar en tyst händelse skulle då numrera om alla efterföljande id:n,
 * och HELA öppningsdimensionen hade sett ut att byta innehåll fast ingen varning
 * ändrats. Ordningsnyckeln per bro är stabil mot det.
 *
 * OBS för den som läser fältprov 10:s anteckningar: K20 skriver
 * "Stridsbergsbron#2" och menar då servicens GLOBALA eventId. Här är samma
 * varning "Stridsbergsbron#1" (bronens FÖRSTA varning). Servicens id följer med
 * i utskriften som `app-id` så raden går att greppa fram i applogg en, men det
 * är ordningsnyckeln undantagen skrivs mot.
 */
function openingEntries(result) {
  const perBridge = new Map();
  const out = new Map();
  for (const w of (result.openingWarnings || [])) {
    const bridge = w.bridge || 'okänd';
    const n = (perBridge.get(bridge) || 0) + 1;
    perBridge.set(bridge, n);
    out.set(`${bridge}#${n}`, {
      v: `ledande=${w.leadVessel || 'okänd'} riktning=${w.direction || 'unknown'} `
        + `eta=${w.etaMin === null || w.etaMin === undefined ? 'null' : w.etaMin} `
        + `källa=${w.firedBy || 'okänd'}`,
      id: w.eventId || 'okänt',
    });
  }
  return out;
}

/**
 * BROTEXT — transitionsströmmen, dedupad i följd.
 * bridgeTextLog i replayRunner loggar redan bara ÄNDRINGAR, men dedupen görs om
 * här så dimensionen är korrekt även om den fångsten någon gång luckras upp.
 */
function bridgeTexts(result) {
  const out = [];
  for (const t of (result.bridgeTextTransitions || [])) {
    if (out.length === 0 || out[out.length - 1] !== t.text) out.push(t.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Jämförelse
// ---------------------------------------------------------------------------

/** Multisetdiff → lista av läsbara avvikelser ({key, detail}). */
function diffMultiset(baseKeys, varKeys) {
  const b = countBy(baseKeys);
  const v = countBy(varKeys);
  const diffs = [];
  for (const k of [...new Set([...b.keys(), ...v.keys()])].sort()) {
    const bc = b.get(k) || 0;
    const vc = v.get(k) || 0;
    if (bc !== vc) diffs.push({ key: k, detail: `bas ${bc} → variant ${vc}` });
  }
  return diffs;
}

/**
 * Nyckel-för-nyckel-diff av öppningsvarningarna (Map "Bro#n" → {v, id}).
 * Endast `v` jämförs; servicens eventId följer med i texten som `app-id` så
 * varningen går att slå upp i applogg en, utan att en ren omnumrering av id:n
 * kan fälla grinden.
 */
function diffOpenings(baseMap, varMap) {
  const diffs = [];
  for (const k of [...new Set([...baseMap.keys(), ...varMap.keys()])].sort()) {
    const b = baseMap.get(k);
    const v = varMap.get(k);
    if (b && v && b.v === v.v) continue;
    if (!b) diffs.push({ key: k, detail: `SAKNAS i bas → variant: ${v.v} [app-id ${v.id}]` });
    else if (!v) diffs.push({ key: k, detail: `bas: ${b.v} [app-id ${b.id}] → SAKNAS i variant` });
    else {
      diffs.push({
        key: k,
        detail: `bas: ${b.v} → variant: ${v.v}  [app-id ${b.id === v.id ? b.id : `${b.id}→${v.id}`}]`,
      });
    }
  }
  return diffs;
}

/**
 * Dimensionerna som avgör verdiktet, i den ordning de skrivs ut.
 * `gate: false` = rapporteras men fäller aldrig (K20: ETA-token är inte facit).
 */
const DIMENSIONS = [
  { id: 'notiser', label: 'Notismultiset (mmsi:bro:riktning)', gate: true },
  { id: 'passager', label: 'Målbropassager (mmsi:bro)', gate: true },
  { id: 'oppningar', label: 'Öppningsvarningar (bro#n → ledande/riktning/eta/källa)', gate: true },
  { id: 'brotext', label: 'Brotextmultiset (dedupad i följd)', gate: true },
  { id: 'notis-eta', label: 'Notisernas ETA-token (information, fäller inte)', gate: false },
];

function compareRun(base, variant) {
  const byDim = {};
  byDim.notiser = diffMultiset(notificationKeys(base), notificationKeys(variant));
  byDim.passager = diffMultiset(passageKeys(base), passageKeys(variant));
  byDim.oppningar = diffOpenings(openingEntries(base), openingEntries(variant));
  const baseTexts = bridgeTexts(base);
  const varTexts = bridgeTexts(variant);
  byDim.brotext = diffMultiset(baseTexts, varTexts);
  byDim['notis-eta'] = diffMultiset(notificationEtaKeys(base), notificationEtaKeys(variant));
  // Ordningsbyte utan multisetskillnad: rent tick-brus i publiceringsordningen,
  // rapporteras som information (multiseten är dimensionen som fäller).
  const orderOnly = byDim.brotext.length === 0
    && JSON.stringify(baseTexts) !== JSON.stringify(varTexts);
  return { byDim, orderOnly };
}

// ---------------------------------------------------------------------------
// Undantagsfilen
// ---------------------------------------------------------------------------

/**
 * phase-sweep-exceptions.json:
 *   { "<korpus-id eller filnamn>": { "<dimension>": [
 *       { "utfall": "Stridsbergsbron#2", "motivering": "...", "datum": "2026-08-21" } ] } }
 *
 * `utfall` matchas som PREFIX mot avvikelsens nyckel (samma konvention som
 * knownInvariantExceptions i runAllCorpora.js) — "*" matchar hela dimensionen.
 * Motivering och datum är OBLIGATORISKA: ett undantag utan skriven anledning är
 * en tyst avstängd grind, och den klassen av fel är just vad grinden finns för.
 */
function loadExceptions(file) {
  if (!fs.existsSync(file)) return { data: {}, path: file, exists: false };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Undantagsfilen går inte att läsa: ${file} (${e.message})`);
  }
  const dimIds = new Set(DIMENSIONS.map((d) => d.id));
  for (const [corpusKey, dims] of Object.entries(data)) {
    if (corpusKey.startsWith('_')) continue; // _kommentar o.d.
    if (!dims || typeof dims !== 'object') throw new Error(`Undantag "${corpusKey}": förväntade ett objekt med dimensioner`);
    for (const [dim, entries] of Object.entries(dims)) {
      if (dim.startsWith('_')) continue;
      if (!dimIds.has(dim)) {
        throw new Error(`Undantag "${corpusKey}": okänd dimension "${dim}" `
          + `(giltiga: ${[...dimIds].join(', ')})`);
      }
      if (!Array.isArray(entries)) throw new Error(`Undantag "${corpusKey}.${dim}": förväntade en lista`);
      for (const e of entries) {
        if (!e || typeof e.utfall !== 'string' || !e.utfall) {
          throw new Error(`Undantag "${corpusKey}.${dim}": varje post kräver ett "utfall"`);
        }
        if (typeof e.motivering !== 'string' || e.motivering.trim().length < 10) {
          throw new Error(`Undantag "${corpusKey}.${dim}.${e.utfall}": "motivering" saknas `
            + '(minst 10 tecken — ett omotiverat undantag är en tyst avstängd grind)');
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.datum || ''))) {
          throw new Error(`Undantag "${corpusKey}.${dim}.${e.utfall}": "datum" saknas eller `
            + 'har fel format (ÅÅÅÅ-MM-DD)');
        }
      }
    }
  }
  return { data, path: file, exists: true };
}

/**
 * Slår upp korpusens undantag på id, filnamn eller filnamn utan ändelse.
 *
 * VARNAR när filen har poster men INGEN av dem matchar (granskningsfynd
 * 2026-08-21): förr försvann ett undantag under fel korpusnyckel spårlöst —
 * ingen varning, ingen "OANVÄNT UNDANTAG", inget. Grinden felade STÄNGT (rött),
 * men den som skrev posten fick ingen ledtråd om varför den inte bet.
 * Nycklar som börjar med `_` är dokumentationsblock och räknas aldrig.
 *
 * @returns {{key: string|null, dims: object, warning: string|null}}
 */
function exceptionsFor(exceptions, corpusId, jsonlPath) {
  const base = path.basename(jsonlPath);
  const candidates = [corpusId, base, base.replace(/\.jsonl$/, '')];
  const data = (exceptions && exceptions.data) || {};
  for (const c of candidates) {
    if (c && Object.prototype.hasOwnProperty.call(data, c)) {
      return { key: c, dims: data[c], warning: null };
    }
  }
  const available = Object.keys(data).filter((k) => !k.startsWith('_'));
  const warning = available.length > 0
    ? `⚠️ Undantagsfilen har poster för ${available.map((k) => `"${k}"`).join(', ')} — `
      + `ingen matchar "${corpusId}" / "${base}". Posterna läses INTE för den här korpusen.`
    : null;
  return { key: null, dims: {}, warning };
}

function matchException(entries, key) {
  if (!Array.isArray(entries)) return null;
  return entries.find((e) => e.utfall === '*' || key.startsWith(e.utfall)) || null;
}

// ---------------------------------------------------------------------------
// Verdiktet
// ---------------------------------------------------------------------------

/**
 * VERDIKTVALET som en REN funktion — samma dom i korpusens egen utskrift och i
 * sammanfattningen, och prövbar utan att köra en enda replay
 * (tests/phase-sweep-unit.test.js).
 *
 * NOLL KÖRDA VARIANTER ÄR INTE ETT GRÖNT SVAR (granskningsfynd 2026-08-21):
 * blev varenda offset "ej tillämpbar" har grinden inte MÄTT någonting, och den
 * gamla else-grenen skrev ändå "GRÖNT" med exitkod 0 — en ny grind som ljuger
 * grönt, exakt den defektklass grinden finns för. REPRODUCERAT före fixen:
 * `PHASE_SWEEP_OFFSETS=5 node runPhaseSweep.js <tät korpus>` ⇒ "0 fasvariant(er)
 * körda, 1 ej tillämpbara", "✅ FASSVEP: OK", EXIT 0 — samma korpus är RÖD med
 * standardoffsets. docs/VALIDATION.md:388 lovar motsatsen: en ej tillämpbar
 * offset "räknas ALDRIG som godkänd". Samma hållning som checkReplayIntegrity,
 * som svarar OKÄNT (3) hellre än OK på gissning.
 *
 * @returns {{level: string, red: boolean}}
 */
function verdictFor(summary) {
  const s = summary || {};
  if (s.hardFail) return { level: 'BRÖTS', red: true };
  if ((s.ran || 0) === 0) return { level: 'OMÄTT', red: true };
  if ((s.sensitivities || []).length > 0) return { level: 'FAS-KÄNSLIGT', red: true };
  if ((s.known || []).length > 0) return { level: 'GRÖNT-UNDANTAG', red: false };
  return { level: 'GRÖNT', red: false };
}

/** Rådet som skrivs när en offset inte rymdes i korpusens första gap. */
const GRID_ADVICE = 'Mot 30 s-rutnätet (watchdog/öppningstick) är +δ samma fas som −(30−δ); '
  + 'mot 60 s-monitoringloopen (MONITORING_INTERVAL_MS) gäller −(60−δ). '
  + 'Vill du täcka båda: kör −(30−δ) OCH −(60−δ).';

/**
 * SKYDDSNÄTEN mellan bas och variant, som en ren funktion.
 *
 * Varianten MÅSTE bära exakt samma datamängd som basen. Gör den inte det har
 * skiftet ändrat mer än fasen och jämförelsen mäter fel sak (t.ex. en omkastad
 * ström som slunkit förbi gap-vakten). Ett fasbyte får inte heller framkalla
 * fler processfel än basen redan hade — då är det en krasch, inte en dom.
 *
 * @returns {string|null} felmeningen, eller null när varianten är jämförbar
 */
function hardFailFor(base, variant, label) {
  if (variant.sampleCount !== base.sampleCount) {
    return `fas ${label}: varianten har ${variant.sampleCount} sampel `
      + `mot basens ${base.sampleCount} — skiftet ändrade datamängden`;
  }
  if ((variant.processErrors || 0) > (base.processErrors || 0)) {
    return `fas ${label}: ${variant.processErrors} processfel mot basens `
      + `${base.processErrors || 0} — fasen framkallar en krasch`;
  }
  return null;
}

/**
 * OANVÄNDA UNDANTAG: en post som inte matchade något är ett påstående som inte
 * längre stämmer. Den FÄLLER inte (fixen kan ha landat) men ska synas.
 *
 * @returns {string[]} en varningsrad per oanvänd post
 */
function unusedExceptionWarnings(corpusExceptions, usedExceptionKeys) {
  const out = [];
  for (const [dim, entries] of Object.entries(corpusExceptions || {})) {
    if (dim.startsWith('_') || !Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!usedExceptionKeys.has(`${dim}|${e.utfall}`)) {
        out.push(`⚠️ OANVÄNT UNDANTAG (${dim}: "${e.utfall}") — känsligheten uppträdde inte. `
          + 'Ta bort posten eller notera varför den står kvar.');
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Svepet för EN korpus
// ---------------------------------------------------------------------------

function sweepCorpus(jsonlPath, corpusId, offsets, exceptions, opts) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`FASSVEP: ${corpusId}`);
  console.log(`  fil: ${jsonlPath}`);

  const corpus = readCorpus(jsonlPath);
  const firstGapMs = corpus.nextTs === null ? null : corpus.nextTs - corpus.minTs;
  console.log(`  ${corpus.sampleCount} sampel, ankare ${new Date(corpus.minTs).toISOString()}`
    + ` (${corpus.anchors.length} rad(er)), första gap ${firstGapMs === null ? 'n/a' : `${firstGapMs} ms`}`);

  const tmpBase = process.env.PHASE_SWEEP_TMPDIR || os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'phase-sweep-'));
  const t0 = Date.now();
  const summary = {
    corpusId,
    jsonlPath,
    ran: 0,
    skipped: [],
    sensitivities: [],
    known: [],
    hardFail: null,
    usedExceptionKeys: new Set(),
  };

  try {
    const base = runReplay(jsonlPath);
    console.log(`  BAS: ${base.notificationCount} notiser, ${(base.targetPassages || []).length} målbropassager, `
      + `${base.openingWarningCount} öppningsvarningar, ${bridgeTexts(base).length} brotexter `
      + `(${(base.__elapsedMs / 1000).toFixed(1)} s)`);
    if (base.processErrors) {
      console.log(`  ⚠️ basen har ${base.processErrors} processfel — svepet mäter ändå fas, men `
        + 'körningen är inte grön i replay:all-mening');
    }

    const { dims: corpusExceptions, warning: exWarning } = exceptionsFor(exceptions, corpusId, jsonlPath);
    if (exWarning) console.log(`  ${exWarning}`);

    for (const off of offsets) {
      const label = `${off.s > 0 ? '+' : ''}${off.s} s`;
      const outPath = path.join(tmpDir, `fas${off.ms > 0 ? '+' : ''}${off.ms}ms.jsonl`);
      const written = writePhaseVariant(corpus, off.ms, outPath);
      if (!written.ok) {
        summary.skipped.push({ label, reason: written.reason });
        console.log(`\n  ── fas ${label}: ⏭️  EJ TILLÄMPBAR — ${written.reason}`);
        continue;
      }
      if (written.unshiftedFields.length > 0) {
        // Ett tidsfält som FINNS men inte gick att skifta gör varianten till
        // något annat än ren fas — det ska synas, inte gömmas.
        console.log(`\n  ⚠️ fas ${label}: tidsfält som inte kunde skiftas på ankarraden: `
          + `${written.unshiftedFields.join(', ')} (varianten mäter då fas OCH datafärskhet)`);
      }

      let variant;
      try {
        variant = runReplay(outPath);
      } catch (e) {
        summary.hardFail = `fas ${label}: replayn misslyckades — ${e.message}`;
        console.log(`\n  ── fas ${label}: 💥 ${e.message}`);
        break;
      }
      summary.ran++;

      // Skyddsnäten (sampelantal, processfel) — se hardFailFor.
      const guard = hardFailFor(base, variant, label);
      if (guard) {
        summary.hardFail = guard;
        console.log(`\n  ── fas ${label}: 💥 ${guard}`);
        break;
      }

      const { byDim, orderOnly } = compareRun(base, variant);
      const changedDims = DIMENSIONS.filter((d) => byDim[d.id].length > 0);
      if (changedDims.length === 0 && !orderOnly) {
        console.log(`\n  ── fas ${label}: ✅ identiskt utfall (${written.changedLines} ändrad rad, `
          + `${(variant.__elapsedMs / 1000).toFixed(1)} s)`);
        continue;
      }

      console.log(`\n  ── fas ${label}: (${written.changedLines} ändrad rad, `
        + `${(variant.__elapsedMs / 1000).toFixed(1)} s)`);
      if (orderOnly) {
        console.log('     ℹ️ brotexterna är samma multiset men publiceras i annan ORDNING '
          + '(tick-brus — fäller inte)');
      }
      for (const dim of changedDims) {
        const diffs = byDim[dim.id];
        const exEntries = corpusExceptions[dim.id];
        const marker = dim.gate ? '🚨' : 'ℹ️';
        console.log(`     ${marker} ${dim.label}: ${diffs.length} avvikelse(r)`);
        for (const d of diffs.slice(0, MAX_DIFF_ROWS)) {
          const hit = dim.gate ? matchException(exEntries, d.key) : null;
          if (hit) {
            summary.known.push({
              label, dim: dim.id, key: d.key, entry: hit,
            });
            summary.usedExceptionKeys.add(`${dim.id}|${hit.utfall}`);
            console.log(`        ✔ KÄNT UNDANTAG  ${d.key}: ${d.detail}`);
            console.log(`           ${hit.motivering} (${hit.datum})`);
          } else {
            if (dim.gate) {
              summary.sensitivities.push({
                label, dim: dim.id, key: d.key, detail: d.detail,
              });
            }
            console.log(`        ${d.key}: ${d.detail}`);
          }
        }
        if (diffs.length > MAX_DIFF_ROWS) {
          for (const d of diffs.slice(MAX_DIFF_ROWS)) {
            const hit = dim.gate ? matchException(exEntries, d.key) : null;
            if (hit) {
              summary.known.push({
                label, dim: dim.id, key: d.key, entry: hit,
              });
              summary.usedExceptionKeys.add(`${dim.id}|${hit.utfall}`);
            } else if (dim.gate) {
              summary.sensitivities.push({
                label, dim: dim.id, key: d.key, detail: d.detail,
              });
            }
          }
          console.log(`        … +${diffs.length - MAX_DIFF_ROWS} till (räknade i verdiktet)`);
        }
      }
    }
  } finally {
    if (!opts.keepTemp) fs.rmSync(tmpDir, { recursive: true, force: true });
    else console.log(`\n  (fasvarianterna sparade i ${tmpDir})`);
  }

  summary.elapsedMs = Date.now() - t0;

  // Oanvända undantag — se unusedExceptionWarnings. Hoppas över om svepet BRÖTS
  // eller om ingen variant kördes: då prövades aldrig alla varianter och
  // "oanvänd" vore ett falskt påstående.
  if (!summary.hardFail && summary.ran > 0) {
    const { dims: corpusExceptions } = exceptionsFor(exceptions, corpusId, jsonlPath);
    for (const w of unusedExceptionWarnings(corpusExceptions, summary.usedExceptionKeys)) {
      console.log(`\n  ${w}`);
    }
  }

  summary.verdict = verdictFor(summary);

  console.log('');
  if (summary.verdict.level === 'BRÖTS') {
    console.log(`  🚨 VERDIKT: ${corpusId} — SVEPET BRÖTS: ${summary.hardFail}`);
  } else if (summary.verdict.level === 'OMÄTT') {
    console.log(`  ⏭️ VERDIKT: ${corpusId} — OMÄTT — ingen fasvariant kunde köras`);
    console.log('     Grinden har inte mätt någonting och säger därför inte GRÖNT. '
      + 'Välj offsets som ryms i korpusens första gap (negativa ryms alltid).');
    console.log(`     ${GRID_ADVICE}`);
  } else if (summary.verdict.level === 'FAS-KÄNSLIGT') {
    const dims = [...new Set(summary.sensitivities.map((s) => s.dim))].join(', ');
    console.log(`  🚨 VERDIKT: ${corpusId} — FAS-KÄNSLIGT (${summary.sensitivities.length} `
      + `odokumenterade avvikelser i: ${dims})`);
    console.log('     Korpusen får låsas först när utfallet belagts i rådata ELLER skrivits '
      + 'som undantag (VALIDATION.md steg 4).');
  } else if (summary.verdict.level === 'GRÖNT-UNDANTAG') {
    console.log(`  ✅ VERDIKT: ${corpusId} — GRÖNT (${summary.known.length} avvikelse(r) täcks `
      + 'av dokumenterade undantag)');
  } else {
    console.log(`  ✅ VERDIKT: ${corpusId} — GRÖNT (utfallet hänger inte på klockans fas)`);
  }
  console.log(`  ${summary.ran} fasvariant(er) körda, ${summary.skipped.length} ej tillämpbara, `
    + `${(summary.elapsedMs / 1000).toFixed(1)} s`);
  if (summary.skipped.length > 0) {
    for (const s of summary.skipped) console.log(`     ⏭️  ${s.label}: ${s.reason}`);
    console.log('     (Ryms inte en SENARE start i första gapet finns ingen fasförskjutning att '
      + `göra åt det hållet. ${GRID_ADVICE} `
      + 'För +5 / +11,52 / +20 s: −25 / −18,48 / −10 s täcker 30 s-rutnätet, '
      + '−55 / −48,48 / −40 s täcker 60 s-loopen.)');
  }
  return summary;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const USAGE = `Fassvepet — grind före korpuslåsning (K20).

  npm run replay:phase                   standardsvep: alla OLÅSTA korpusar i corpora.js
  npm run replay:phase -- <jsonl> [...]  svep en eller flera namngivna korpusfiler

  --offsets=-20,-11.52,-5   fasoffsets i sekunder (default ${DEFAULT_OFFSETS_S.join(',')})
  --id=<korpus-id>          nyckel för undantagsuppslagningen
  --exceptions=<fil>        annan undantagsfil
  --keep-temp               behåll fasvarianternas temporära jsonl-filer

Exitkod: 0 grönt, 1 fas-känsligt utan dokumenterat undantag ELLER omätt
         (ingen fasvariant kunde köras), 2 anropsfel.`;

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`🚨 ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { files, opts } = parsed;
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  let offsets;
  let exceptions;
  try {
    offsets = parseOffsets(opts.offsetsS || process.env.PHASE_SWEEP_OFFSETS || DEFAULT_OFFSETS_S.join(','));
    exceptions = loadExceptions(opts.exceptionsFile);
  } catch (e) {
    console.error(`🚨 ${e.message}`);
    process.exit(2);
  }

  // Vilka korpusar? Utan argument sveps de OLÅSTA posterna i corpora.js — det
  // är exakt de körningar som står näst i tur att låsas, och grinden finns för
  // låsningsögonblicket. Finns ingen olåst korpus körs den MINSTA låsta som
  // självtest av grinden (och det sägs rakt ut).
  const targets = [];
  if (files.length > 0) {
    for (const f of files) {
      const abs = path.resolve(f);
      if (!fs.existsSync(abs)) {
        console.error(`🚨 Filen finns inte: ${abs}`);
        process.exit(2);
      }
      const hit = corpora.find((c) => path.resolve(c.jsonl) === abs);
      targets.push({ jsonl: abs, id: opts.id || (hit && hit.id) || path.basename(abs, '.jsonl') });
    }
  } else {
    const unlocked = corpora.filter((c) => c.locked === false && fs.existsSync(c.jsonl));
    if (unlocked.length > 0) {
      for (const c of unlocked) targets.push({ jsonl: path.resolve(c.jsonl), id: c.id });
      console.log(`Standardsvep: ${unlocked.length} OLÅST(A) korpus(ar) i corpora.js.`);
    } else {
      const locked = corpora.filter((c) => c.locked && fs.existsSync(c.jsonl))
        .map((c) => ({ c, size: fs.statSync(c.jsonl).size }))
        .sort((a, b) => a.size - b.size);
      if (locked.length === 0) {
        console.error('🚨 Hittade ingen korpusfil att svepa.');
        process.exit(2);
      }
      targets.push({ jsonl: path.resolve(locked[0].c.jsonl), id: locked[0].c.id });
      console.log('Standardsvep: ingen OLÅST korpus finns — kör den MINSTA LÅSTA '
        + `(${locked[0].c.id}) som självtest av grinden.`);
    }
  }

  console.log(`Offsets: ${offsets.map((o) => `${o.s > 0 ? '+' : ''}${o.s} s`).join(', ')}`);
  console.log(`Undantagsfil: ${exceptions.path}${exceptions.exists ? '' : ' (finns inte — inga undantag)'}`);

  const t0 = Date.now();
  const summaries = [];
  for (const t of targets) {
    try {
      summaries.push(sweepCorpus(t.jsonl, t.id, offsets, exceptions, opts));
    } catch (e) {
      console.error(`\n🚨 ${t.id}: ${e.message}`);
      summaries.push({
        corpusId: t.id, hardFail: e.message, sensitivities: [], known: [], skipped: [], ran: 0,
      });
    }
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log('SAMMANFATTNING — FASSVEPET');
  let red = 0;
  let unmeasured = 0;
  for (const s of summaries) {
    // SAMMA domarfunktion som korpusens egen verdiktrad — de två kan inte
    // glida isär (det var precis så "GRÖNT på 0 körda varianter" uppstod).
    const { level, red: isRed } = verdictFor(s);
    let verdict;
    if (level === 'BRÖTS') verdict = `💥 BRÖTS (${s.hardFail})`;
    else if (level === 'OMÄTT') verdict = '⏭️ OMÄTT — ingen fasvariant kunde köras';
    else if (level === 'FAS-KÄNSLIGT') verdict = `🚨 FAS-KÄNSLIGT — ${s.sensitivities.length} odokumenterade avvikelser`;
    else if (level === 'GRÖNT-UNDANTAG') verdict = `✅ GRÖNT (${s.known.length} avvikelse(r) täcks av undantag)`;
    else verdict = '✅ GRÖNT';
    if (isRed) red++;
    if (level === 'OMÄTT') unmeasured++;
    console.log(`  ${s.corpusId}: ${verdict} — ${s.ran} varianter, `
      + `${(s.skipped || []).length} ej tillämpbara`);
  }
  const totalRuns = summaries.reduce((n, s) => n + (s.ran || 0), 0) + summaries.length;
  console.log(`  ${totalRuns} replays totalt på ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (red > 0) {
    console.log(`\n🚨 FASSVEP: FEL — ${red} av ${summaries.length} korpus(ar) är fas-känsliga `
      + `eller OMÄTTA${unmeasured > 0 ? ` (${unmeasured} omätt(a))` : ''}: `
      + 'korpuslåsning kräver rådatabevis eller ett skrivet undantag (VALIDATION.md steg 4).');
    if (unmeasured > 0) console.log(`   ${GRID_ADVICE}`);
    process.exit(1);
  }
  console.log(`\n✅ FASSVEP: OK — ${summaries.length} korpus(ar), inget odokumenterat fasberoende.`);
  process.exit(0);
}

// KÖRS BARA SOM CLI. Guarden gör domarfunktionerna nedan importerbara utan att
// ett `require` startar ett fassvep (tests/phase-sweep-unit.test.js) — samma
// mönster som checkReplayIntegrity.js. CLI-beteendet är oförändrat.
if (require.main === module) main();

module.exports = {
  // Domarna — prövbara utan replay.
  verdictFor,
  hardFailFor,
  unusedExceptionWarnings,
  matchException,
  exceptionsFor,
  loadExceptions,
  diffMultiset,
  diffOpenings,
  // Fasvarianten och dess typbevarande tidsskift.
  shiftTimeField,
  writePhaseVariant,
  readCorpus,
  // Argument- och offsettolkning (felvägarna är en del av kontraktet).
  parseArgs,
  parseOffsets,
  // Konstanter som testerna låser mot i stället för att skriva av dem.
  DIMENSIONS,
  DEFAULT_OFFSETS_S,
  SHIFTED_TIME_FIELDS,
  GRID_ADVICE,
};
