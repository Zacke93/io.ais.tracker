'use strict';

/**
 * checkReplayIntegrity (K24, fältprov 10 — 2026-08-21): bevisar att en
 * replay-jsonl bär HELA loggens facit.
 *
 * MOTIV: nattkörningen 2026-08-19 skrev 146 [AIS_REPLAY_SAMPLE] i apploggen
 * men bara 99 hela rader i jsonl:en (24 576 B = exakt 6×4096 — en oflushad
 * blockbuffert), sista raden avhuggen mitt i JSON-objektet. Ingen grind
 * larmade: håldetektorn i run-with-logs.sh läste BARA loggen, aldrig
 * jsonl:en, trots att VALIDATION.md steg 3 i sin dåvarande lydelse angav
 * "jsonl:en saknar samples" som grindens syfte. En trunkerad korpus KUNDE
 * alltså låsas som facit. Luckan är stängd sedan 2026-08-21: run-with-logs.sh
 * kör den här kontrollen vid varje avslut och körboken beskriver båda
 * grindarna (tidshål + replay-fångst).
 *
 * KONTRAKT: fångstvägen (run-with-logs.sh) skriver exakt en jsonl-rad per
 * [AIS_REPLAY_SAMPLE]-rad i loggen, i samma ordning, med allt före och med
 * "AIS_REPLAY_SAMPLE] " avklippt. Därför gäller tre likheter samtidigt:
 *   1. antal kompletta jsonl-rader === antal sampelrader i loggen
 *   2. varje jsonl-rad === loggens motsvarande sampel, position för position
 *   3. filen slutar med radbrytning och sista raden är komplett JSON
 * Varje avvikelse = tappad eller dubblerad facitdata.
 *
 * UNDANTAGET: de härledda TVÅKÄLLIGA korpusarna (makeFieldFusionCorpus.js)
 * blandar loggbara aisstream-rader med aishub-rader som är parseade ur
 * [AISHUB_RESPONSE_SAMPLE]-svarens kuvert. Bara den första delen kan jämföras
 * mot loggen rad för rad; då blir verdiktet DELVIS (exitkod 0) med siffrorna
 * utskrivna — aldrig ett bart OK som döljer att en majoritet av raderna inte
 * har mätts.
 *
 * Användning:
 *   node tests/replay-validation/checkReplayIntegrity.js <jsonl> [logg]
 *   node tests/replay-validation/checkReplayIntegrity.js --dir <katalog>
 *   node tests/replay-validation/checkReplayIntegrity.js --corpora
 *   Flaggor: --log-dir <katalog> (upprepningsbar), --markdown, --brief,
 *            --json, --quiet
 *
 * Exit-koder (run-with-logs.sh grindar på !== 0):
 *   0 = OK        — allt kontrollerat och komplett
 *   0 = DELVIS    — den loggbara delen är komplett, resten går inte att mäta
 *                   (härledd tvåkällig korpus). Grönt, men texten säger hur
 *                   stor del som faktiskt jämförts.
 *   1 = FEL       — minst en bekräftad avvikelse (facitdata saknas/dubblerad)
 *   2 = ANROPSFEL — saknad fil, oläsbar katalog, felaktiga argument
 *   3 = OKÄNT     — inget fel bevisat, men minst ett par kunde inte verifieras
 *                   (källoggen saknas). Aldrig "OK" på gissning.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

// Samma mönster som fångsten i run-with-logs.sh greppar på — grinden måste
// räkna EXAKT det fångsten räknar, annars mäter den något annat än den vaktar.
const SAMPLE_MARKER = 'AIS_REPLAY_SAMPLE';
// Sed/awk-uttrycket klipper till och med "] " efter markören (girigt, sista
// förekomsten) — samma semantik här.
const SAMPLE_CUT = `${SAMPLE_MARKER}] `;
// AISHubs råa svarskuvert. Räknas bara för att kunna SÄGA hur den härledda
// aishub-delen av en fusionskorpus uppstod — ett svar ger många fartygsrader,
// så antalet är kontext, aldrig en verifiering.
const RESPONSE_MARKER = 'AISHUB_RESPONSE_SAMPLE';

// 4096 = filsystemets blockstorlek. En fil vars längd är en exakt multipel av
// 4096 OCH som slutar mitt i en rad bär blockbuffertens signatur: allt som
// skrevs kom ut i hela block, resten låg kvar i userspace när processen dog.
const BLOCK_SIZE = 4096;
const READ_CHUNK = 4 * 1024 * 1024;

const DEFAULT_LOG_DIRS = [
  // Repots synkade loggmapp (run-with-logs.sh slutsynk).
  path.resolve(__dirname, '../../../logs'),
  // Live-mappen (F4-A: live-loggen skrivs lokalt, immunt mot OneDrive-stall).
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.ais-tracker-logs'),
];

const CORPORA_DATA_DIR = path.join(__dirname, 'corpora-data');

/** Tidsstämpeln som binder ihop app-<ts>.log och ais-replay-<ts>.jsonl. */
function timestampOf(filePath) {
  const m = path.basename(filePath).match(/(\d{8}-\d{6})/);
  return m ? m[1] : null;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Läser en jsonl och skiljer KOMPLETTA rader (avslutade med \n) från ett
 * eventuellt avhugget svansfragment. Skillnaden är hela poängen: en trunkerad
 * fångst slutar mitt i ett JSON-objekt utan radbrytning.
 */
function readJsonl(filePath) {
  const buf = fs.readFileSync(filePath);
  const text = buf.toString('utf8');
  const endsWithNewline = buf.length > 0 && buf[buf.length - 1] === 0x0a;
  const parts = text.split('\n');
  const trailing = endsWithNewline ? '' : parts[parts.length - 1];
  // SAMMA slice i båda fallen — sista elementet är antingen '' (filen slutade
  // med \n) eller svansfragmentet, och båda ska bort; fragmentet bevaras
  // separat i `trailing`. (Stod förr som en ternär med två identiska grenar,
  // vilket påstod en skillnad som inte finns — granskningsfynd 2026-08-21.)
  const lines = parts.slice(0, -1)
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  const invalid = [];
  const feeds = new Map();
  // Feed per rad, i radordning: fusionskorpusarnas aisstream-del måste kunna
  // plockas ut och jämföras mot loggen utan att parsa om filen.
  const lineFeeds = new Array(lines.length).fill(null);
  lines.forEach((line, i) => {
    if (line === '') {
      invalid.push({ index: i + 1, reason: 'tom rad' }); return;
    }
    try {
      const obj = JSON.parse(line);
      const feed = obj && obj.feed ? String(obj.feed) : '(ingen feed)';
      lineFeeds[i] = feed;
      feeds.set(feed, (feeds.get(feed) || 0) + 1);
    } catch (err) {
      invalid.push({ index: i + 1, reason: err.message });
    }
  });

  return {
    path: filePath,
    bytes: buf.length,
    lines,
    complete: lines.length,
    trailing,
    endsWithNewline,
    invalid,
    feeds,
    lineFeeds,
    blockAligned: buf.length > 0 && buf.length % BLOCK_SIZE === 0,
  };
}

/**
 * Strömmar loggen och plockar ut sampelraderna i ordning. Läses i bitar —
 * fältloggarna är upp till 70 MB och ska inte tvinga fram en 70 MB-sträng
 * på en gång.
 *
 * DEKODNINGEN ÄR TILLSTÅNDSBÄRANDE, och det är inte en detalj (granskningsfynd
 * 2026-08-21): den första versionen dekodade varje 4 MiB-bit för sig med
 * `buf.toString('utf8', 0, read)`. Ett tecken som spänner över bitgränsen —
 * å/ä/ö är 2 byte, emoji 4 — delas då i två halvor som var för sig är ogiltig
 * UTF-8 och blir U+FFFD i BÅDA bitarna, medan jsonl:en läses som EN buffert
 * och är korrekt. Rad-för-rad-jämförelsen såg alltså en skillnad som inte
 * fanns och kunde fälla en HEL korpus på ett rent dekodningsfel. Fältloggarna
 * är 15–70 MB (upp till 17 bitgränser) och sampelraderna bär svenska
 * fartygsnamn, så utfallet var en godtycklig men återkommande falsk FEL-dom.
 * StringDecoder håller kvar en ofullständig byte-sekvens till nästa bit;
 * `decoder.end()` släpper ut en eventuell rest efter sista biten.
 */
function readLogSamples(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(READ_CHUNK);
  const decoder = new StringDecoder('utf8');
  let rest = '';
  const samples = [];
  let matched = 0;
  let responses = 0;
  const take = (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.indexOf(RESPONSE_MARKER) !== -1) responses += 1;
    if (line.indexOf(SAMPLE_MARKER) === -1) return;
    matched += 1;
    const cut = line.lastIndexOf(SAMPLE_CUT);
    samples.push(cut === -1 ? line : line.slice(cut + SAMPLE_CUT.length));
  };
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, READ_CHUNK, null);
      if (read <= 0) break;
      // subarray = vy utan kopia; StringDecoder kopierar själv undan de byte
      // den sparar, så det är säkert att återanvända `buf` nästa varv.
      const chunk = rest + decoder.write(buf.subarray(0, read));
      const parts = chunk.split('\n');
      rest = parts.pop();
      for (const raw of parts) take(raw);
    }
    rest += decoder.end();
    // Loggens SISTA rad kan sakna radbrytning (hård stopp mitt i en skrivning).
    if (rest !== '') take(rest);
  } finally {
    fs.closeSync(fd);
  }
  return {
    path: filePath, samples, count: matched, responses, bytes: fs.statSync(filePath).size,
  };
}

/** Letar upp källoggen. Filnamnets tidsstämpel först, byte-identitet sedan. */
function resolveLog(jsonlPath, logDirs) {
  const ts = timestampOf(jsonlPath);
  if (ts) {
    for (const dir of logDirs) {
      const cand = path.join(dir, `app-${ts}.log`);
      if (fs.existsSync(cand)) return { log: cand, method: `filnamn (app-${ts}.log)` };
    }
  }

  // Alias-korpusarna (ais-20260804-17h-dag.jsonl m.fl.) bär inget klockslag.
  // Byte-identitet mot en fångstfil med känd tidsstämpel är BEVIS, inte
  // gissning: samma sha256 = samma fil, alltså samma körning.
  let hash = null;
  for (const dir of logDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith('ais-replay-') || !name.endsWith('.jsonl')) continue;
      const cand = path.join(dir, name);
      try {
        if (fs.statSync(cand).size !== fs.statSync(jsonlPath).size) continue;
        if (hash === null) hash = sha256(jsonlPath);
        if (sha256(cand) !== hash) continue;
      } catch (err) {
        continue;
      }
      const candTs = timestampOf(cand);
      if (!candTs) continue;
      for (const d of logDirs) {
        const log = path.join(d, `app-${candTs}.log`);
        if (fs.existsSync(log)) {
          return { log, method: `byte-identitet sha256 med ${name} → app-${candTs}.log` };
        }
      }
    }
  }

  // Härledda TVÅKÄLLIGA korpusar (makeFieldFusionCorpus.js) har ingen egen
  // fångstfil: de är en sammanslagning av loggens [AIS_REPLAY_SAMPLE]-rader
  // (feed=aisstream) och de parseade [AISHUB_RESPONSE_SAMPLE]-svaren ur SAMMA
  // logg. aisstream-DELEN är därför byte-identisk med körningens fångstfil.
  // Att matcha på den delen är BEVIS (371 identiska rader i rad), inte en
  // gissning — och utan den skulle fusionskorpusarna för alltid rapporteras
  // som "källogg saknas".
  const subsetHash = aisstreamSubsetHash(jsonlPath);
  if (subsetHash) {
    for (const dir of logDirs) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (err) {
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith('ais-replay-') || !name.endsWith('.jsonl')) continue;
        const cand = path.join(dir, name);
        let candHash = null;
        try {
          candHash = sha256(cand);
        } catch (err) {
          continue;
        }
        if (candHash !== subsetHash) continue;
        const candTs = timestampOf(cand);
        if (!candTs) continue;
        for (const d of logDirs) {
          const log = path.join(d, `app-${candTs}.log`);
          if (fs.existsSync(log)) {
            return { log, method: `aisstream-delen byte-identisk med ${name} → app-${candTs}.log (härledd tvåkällig korpus)` };
          }
        }
      }
    }
  }
  return { log: null, method: null };
}

/** sha256 över enbart raderna med feed==='aisstream', i ordning. */
function aisstreamSubsetHash(jsonlPath) {
  let text;
  try {
    text = fs.readFileSync(jsonlPath, 'utf8');
  } catch (err) {
    return null;
  }
  const kept = [];
  let sawOther = false;
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      return null;
    }
    if (obj && obj.feed === 'aisstream') kept.push(line);
    else sawOther = true;
  }
  // Bara meningsfullt för blandade filer — en ren aisstream-fil fångas redan
  // av hela-filen-jämförelsen ovan.
  if (!sawOther || kept.length === 0) return null;
  return crypto.createHash('sha256').update(`${kept.join('\n')}\n`).digest('hex');
}

/** Första positionen där jsonl-raden och loggens sampel skiljer sig åt. */
function firstDivergence(jsonlLines, logSamples) {
  const n = Math.min(jsonlLines.length, logSamples.length);
  for (let i = 0; i < n; i += 1) {
    if (jsonlLines[i] !== logSamples[i]) return i + 1;
  }
  return 0;
}

function checkPair(jsonlPath, logPath, opts) {
  const result = {
    jsonl: jsonlPath,
    log: logPath,
    logMethod: opts && opts.logMethod ? opts.logMethod : null,
    verdict: 'OK',
    // DELVIS: bara en del av filen kunde mätas mot loggen (härledd tvåkällig
    // korpus). Sätts bara när den mätbara delen är komplett OCH felfri.
    partial: false,
    partialNote: null,
    problems: [],
    notes: [],
  };

  let data;
  try {
    data = readJsonl(jsonlPath);
  } catch (err) {
    result.verdict = 'ANROPSFEL';
    result.problems.push(`kan inte läsa jsonl: ${err.message}`);
    return result;
  }
  result.bytes = data.bytes;
  result.jsonlComplete = data.complete;
  result.endsWithNewline = data.endsWithNewline;
  result.trailingBytes = Buffer.byteLength(data.trailing, 'utf8');
  result.feeds = Array.from(data.feeds.entries()).sort((a, b) => b[1] - a[1]);

  if (!data.endsWithNewline && data.bytes > 0) {
    result.problems.push(`sista raden är AVHUGGEN (${result.trailingBytes} byte efter sista radbrytningen, ingen avslutande \\n)`);
  }
  if (data.invalid.length > 0) {
    const first = data.invalid[0];
    result.problems.push(`${data.invalid.length} rad(er) är inte giltig JSON (första: rad ${first.index} — ${first.reason})`);
  }
  if (data.bytes === 0) {
    result.problems.push('jsonl:en är TOM (0 byte) — debug_level var troligen inte "full"');
  }
  if (data.blockAligned && !data.endsWithNewline) {
    result.notes.push(`filstorlek ${data.bytes} B = exakt ${data.bytes / BLOCK_SIZE}×${BLOCK_SIZE} — blockbuffert-signatur (oflushad skrivare)`);
  }

  if (!logPath) {
    result.verdict = result.problems.length > 0 ? 'FEL' : 'OKÄNT';
    result.notes.push('källogg saknas — antalet sampel kan inte jämföras (ingen gissning görs)');
    return result;
  }

  let log;
  try {
    log = readLogSamples(logPath);
  } catch (err) {
    result.verdict = result.problems.length > 0 ? 'FEL' : 'OKÄNT';
    result.problems.push(`kan inte läsa loggen: ${err.message}`);
    return result;
  }
  result.logSamples = log.count;
  result.logBytes = log.bytes;

  if (log.bytes === 0) {
    result.notes.push('källoggen är 0 byte — själva loggen gick förlorad (icke-atomisk synk?)');
  }

  const diff = data.complete - log.count;
  if (diff < 0) {
    const pct = log.count > 0 ? ((-diff / log.count) * 100).toFixed(1) : '100.0';
    result.problems.push(`${-diff} av ${log.count} sampel SAKNAS i jsonl:en (${pct} %)`);
  } else if (diff > 0) {
    // Fler rader än sampel: två skrivare mot samma path, eller en logg som i
    // sin tur är trunkerad. Båda gör korpusen otillförlitlig som facit.
    const derived = result.feeds.length > 1;
    if (derived) {
      result.notes.push(`${diff} fler rader än loggens sampel — fördelning per feed: ${result.feeds.map(([f, c]) => `${f}=${c}`).join(', ')}`);
      const aisstream = data.feeds.get('aisstream') || 0;
      if (aisstream === log.count) {
        // Jämför den loggbara delen på riktigt — annars vore "matchar exakt"
        // ett antagande om antal, inte en mätning av innehåll.
        const streamLines = data.lines.filter((_, i) => data.lineFeeds[i] === 'aisstream');
        const div = firstDivergence(streamLines, log.samples);
        if (div > 0) {
          result.problems.push(`aisstream-delens rad ${div} skiljer sig från loggens motsvarande sampel (innehållet matchar inte)`);
        } else {
          // ÄRLIGT VERDIKT (granskningsfynd 2026-08-21): den här filen fick förr
          // ett bart "✅ OK" trots att bara 27 % av raderna jämförts. Den
          // andra källan finns inte som rader i loggen — bara som kuvert —
          // så den KAN inte mätas här. Då ska verdiktet säga det.
          result.partial = true;
          result.partialNote = `aisstream-delen ${aisstream}/${aisstream} mot logg; aishub-delen ${diff} ej loggbar`;
          result.notes.push(`härledd tvåkällig korpus: aisstream-delens ${aisstream} rader är byte-jämförda mot loggens sampel, position för position`);
          result.notes.push(`aishub-delens ${diff} rader är parseade ur loggens ${log.responses} [${RESPONSE_MARKER}]-svar (ett svar = många fartygsrader) och kan INTE jämföras rad mot rad`);
        }
      } else {
        result.problems.push(`${diff} fler rader än loggens sampel och aisstream-delen (${aisstream}) matchar inte heller (${log.count})`);
      }
    } else {
      result.problems.push(`${diff} FLER rader än loggens sampel — dubbelskrivning eller trunkerad logg`);
    }
  }

  if (diff === 0 && log.count > 0) {
    const div = firstDivergence(data.lines, log.samples);
    if (div > 0) {
      result.problems.push(`rad ${div} skiljer sig från loggens motsvarande sampel (innehållet matchar inte)`);
    } else {
      result.notes.push(`alla ${log.count} rader är identiska med loggens sampel, position för position`);
    }
  } else if (diff < 0 && log.count > 0) {
    const div = firstDivergence(data.lines, log.samples);
    if (div > 0) {
      result.problems.push(`de bevarade raderna är inte ens ett rent prefix — första avvikelsen på rad ${div}`);
    } else if (data.complete > 0) {
      result.notes.push(`de ${data.complete} bevarade raderna är ett byte-exakt PREFIX av loggens sampel (rent avhugg, ingen omkastning)`);
    }
  }

  if (result.problems.length > 0) result.verdict = 'FEL';
  else if (result.partial) result.verdict = 'DELVIS';
  else result.verdict = 'OK';
  return result;
}

function formatText(r) {
  const out = [];
  out.push(`jsonl: ${r.jsonl}`);
  out.push(`logg:  ${r.log || '(saknas)'}${r.logMethod ? `  [hittad via ${r.logMethod}]` : ''}`);
  out.push(`  sampel i loggen (${SAMPLE_MARKER}): ${r.logSamples === undefined ? '—' : r.logSamples}`);
  out.push(`  kompletta rader i jsonl:          ${r.jsonlComplete === undefined ? '—' : r.jsonlComplete}`);
  out.push(`  storlek: ${r.bytes === undefined ? '—' : `${r.bytes} B`}, slutar med radbrytning: ${r.endsWithNewline ? 'ja' : 'NEJ'}`);
  for (const n of r.notes) out.push(`  · ${n}`);
  for (const p of r.problems) out.push(`  ✗ ${p}`);
  const ICONS = { OK: '✅', DELVIS: '☑️', OKÄNT: '❓' };
  const icon = ICONS[r.verdict] || '🚨';
  // DELVIS bär sina siffror i verdiktraden — den som bara läser sista raden
  // ska inte kunna tro att hela filen är verifierad.
  const SUFFIX = {
    FEL: ' — korpuslåsning EJ tillåten',
    DELVIS: r.partialNote ? ` verifierad (${r.partialNote})` : ' verifierad',
  };
  out.push(`  ${icon} VERDIKT: ${r.verdict}${SUFFIX[r.verdict] || ''}`);
  return out.join('\n');
}

function formatMarkdown(r, brief) {
  const out = [];
  // --brief: run-with-logs.sh skriver redan antal/storlek med skalverktyg;
  // då ska node-delen bara lägga till det skalet INTE kan se (radvis
  // jämförelse och JSON-validering), inte upprepa samma tre rader.
  if (!brief) {
    out.push(`- Sampel i loggen (\`${SAMPLE_MARKER}\`): **${r.logSamples === undefined ? 'okänt (källogg saknas)' : r.logSamples}**`);
    out.push(`- Kompletta rader i jsonl: **${r.jsonlComplete === undefined ? 'okänt' : r.jsonlComplete}**`);
    out.push(`- Filstorlek: ${r.bytes === undefined ? 'okänd' : `${r.bytes} B`} — slutar med radbrytning: ${r.endsWithNewline ? 'ja' : '**NEJ (avhuggen)**'}`);
  }
  for (const n of r.notes) out.push(`- ${n}`);
  for (const p of r.problems) out.push(`- ⚠️ ${p}`);
  if (r.verdict === 'OK') {
    out.push('');
    out.push('✅ **Replay-integritet: OK** — jsonl:en bär hela loggens facit.');
  } else if (r.verdict === 'DELVIS') {
    out.push('');
    out.push(`☑️ **Replay-integritet: DELVIS verifierad** (${r.partialNote}) — den loggbara delen är komplett och byte-identisk; resten går inte att mäta mot loggen.`);
  } else if (r.verdict === 'OKÄNT') {
    out.push('');
    out.push('❓ **Replay-integritet: OKÄNT** — kunde inte verifieras mot källoggen. **korpuslåsning EJ tillåten**');
  } else {
    out.push('');
    out.push('🚨 **Replay-integritet: FEL** — facitdata saknas eller är skadad. **korpuslåsning EJ tillåten**');
  }
  return out.join('\n');
}

/**
 * Plockar upp jsonl-kandidaterna i en katalog.
 *
 * `--corpora` läser corpora-data/, en KONTROLLERAD katalog där varenda fil är
 * ett facit — där gäller det breda filtret (även alias-korpusarna
 * `ais-20260804-17h-dag.jsonl` och de härledda `ais-fusion-*.jsonl`, som inte
 * heter `ais-replay-`).
 *
 * `--dir` pekar däremot på en MÄNNISKOKÖRD katalog, och den naturliga är
 * ~/.ais-tracker-logs. Där lägger run-with-logs.sh:69 appens EGEN fångstväg
 * `ais-replay-<ts>.appside.jsonl` (AIS_REPLAY_CAPTURE_FILE, app.js:232).
 * Vaknar den vägen någonsin — hela skälet till att den fick ett eget filnamn —
 * matchar den både `.jsonl`-filtret och `timestampOf`-regexet, och verktyget
 * hade parat den mot app-<ts>.log och rapporterat FEL för en fil som aldrig var
 * en korpuskandidat (granskningsfynd 2026-08-21). Ingen bindande grind rördes
 * — run-with-logs.sh anropar med explicit <jsonl> <logg> — men fällbenägenheten
 * är borta nu. Filtret kräver därför `ais-replay-`-prefixet OCH utesluter
 * appside-filen i --dir-läget.
 */
function collectPairsFromDir(dir, opts) {
  const dirMode = Boolean(opts && opts.dirMode);
  const entries = fs.readdirSync(dir);
  return entries
    .filter((n) => {
      if (!n.endsWith('.jsonl')) return false;
      if (!dirMode) return true;
      return n.startsWith('ais-replay-') && !n.endsWith('.appside.jsonl');
    })
    .sort()
    .map((n) => path.join(dir, n));
}

// DELVIS ger 0 — den loggbara delen är mätt och komplett, och run-with-logs.sh
// grindar på exitkoden. Nyansen bärs av texten, inte av en fällande kod.
function worstExit(results) {
  if (results.some((r) => r.verdict === 'ANROPSFEL')) return 2;
  if (results.some((r) => r.verdict === 'FEL')) return 1;
  if (results.some((r) => r.verdict === 'OKÄNT')) return 3;
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  const logDirs = [];
  const positionals = [];
  let mode = 'pair';
  let format = 'text';
  let quiet = false;
  let brief = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--markdown') format = 'markdown';
    else if (a === '--brief') {
      format = 'markdown'; brief = true;
    } else if (a === '--json') format = 'json';
    else if (a === '--quiet') quiet = true;
    else if (a === '--corpora') mode = 'corpora';
    else if (a === '--dir') {
      mode = 'dir'; positionals.push(args[i += 1]);
    } else if (a === '--log-dir') logDirs.push(args[i += 1]);
    else if (a === '--help' || a === '-h') {
      console.log('Användning: node checkReplayIntegrity.js <jsonl> [logg] | --dir <katalog> | --corpora');
      console.log('Flaggor: --log-dir <katalog> (upprepningsbar), --markdown, --brief, --json, --quiet');
      return 0;
    } else if (a.startsWith('--')) {
      console.error(`Okänd flagga: ${a}`);
      return 2;
    } else positionals.push(a);
  }

  const searchDirs = logDirs.concat(DEFAULT_LOG_DIRS).filter((d) => d && fs.existsSync(d));

  let targets = [];
  if (mode === 'corpora') {
    targets = collectPairsFromDir(CORPORA_DATA_DIR).map((j) => ({ jsonl: j, log: null }));
  } else if (mode === 'dir') {
    if (!positionals[0] || !fs.existsSync(positionals[0])) {
      console.error('--dir kräver en befintlig katalog');
      return 2;
    }
    targets = collectPairsFromDir(positionals[0], { dirMode: true }).map((j) => ({ jsonl: j, log: null }));
  } else {
    if (positionals.length === 0) {
      console.error('Ange en jsonl-fil (eller --dir/--corpora). --help visar användningen.');
      return 2;
    }
    targets = [{ jsonl: positionals[0], log: positionals[1] || null }];
  }

  const results = [];
  for (const t of targets) {
    if (!fs.existsSync(t.jsonl)) {
      results.push({
        jsonl: t.jsonl, log: null, verdict: 'ANROPSFEL', problems: ['jsonl-filen finns inte'], notes: [],
      });
      continue;
    }
    let logPath = t.log;
    let logMethod = logPath ? 'angiven på kommandoraden' : null;
    if (!logPath) {
      const dirs = [path.dirname(t.jsonl)].concat(searchDirs);
      const found = resolveLog(t.jsonl, dirs);
      logPath = found.log;
      logMethod = found.method;
    }
    results.push(checkPair(t.jsonl, logPath, { logMethod }));
  }

  if (!quiet) {
    if (format === 'json') {
      console.log(JSON.stringify(results, null, 2));
    } else if (format === 'markdown') {
      console.log(results.map((r) => formatMarkdown(r, brief)).join('\n\n'));
    } else {
      console.log(results.map(formatText).join('\n\n'));
      if (results.length > 1) {
        const n = (v) => results.filter((r) => r.verdict === v).length;
        console.log(`\nSAMMANFATTNING: ${results.length} filer — OK ${n('OK')}, DELVIS ${n('DELVIS')}, FEL ${n('FEL')}, OKÄNT ${n('OKÄNT')}, ANROPSFEL ${n('ANROPSFEL')}`);
      }
    }
  }
  return worstExit(results);
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  checkPair,
  readJsonl,
  readLogSamples,
  resolveLog,
  timestampOf,
  collectPairsFromDir,
  main,
  aisstreamSubsetHash,
  // Exporteras så att multibyte-testet kan lägga ett tecken EXAKT på
  // bitgränsen utan att hårdkoda 4 MiB på två ställen.
  READ_CHUNK,
};
