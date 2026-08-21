'use strict';

/**
 * K24 (fältprov 10, 2026-08-21) — GRINDEN SOM SAKNADES.
 *
 * Nattkörningen 2026-08-19 skrev 146 [AIS_REPLAY_SAMPLE] i apploggen men bara
 * 99 hela rader i jsonl:en (24 576 B = exakt 6×4096, avhuggen mitt i rad 100).
 * Ingen grind larmade: håldetektorn i run-with-logs.sh läste BARA loggens
 * tidsstämplar och jämförde aldrig jsonl:en mot antalet sampel. En trunkerad
 * korpus KUNDE alltså låsas som facit.
 *
 * Testet låser fast att checkReplayIntegrity.js skiljer de fall åt som avgör
 * om en körning får korpuslåsas. Logikfallen skrivs i en temp-katalog och är
 * medvetet små — det som ska bevisas där är LOGIKEN. Själva fältfallet ligger
 * som BYTE-EXAKTA FIXTURER i tests/replay-validation/fixtures/ (se README.md
 * där); sviten beror inte på ~/.ais-tracker-logs.
 *
 * TILLAGT 2026-08-21 (granskningsfynd på K24 självt): två fall som fäller
 * grinden när den ljuger åt fel håll — ett flerbytetecken på läsbitens gräns
 * (falskt FEL på en hel korpus) och de härledda tvåkälliga korpusarna (bart
 * "OK" trots att 73 % av raderna aldrig jämförts). Samt, i samma omgång,
 * fixturerna ovan och `--dir`-filtret som förr plockade upp appens egen
 * `.appside.jsonl`-fångst.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checker = require('./replay-validation/checkReplayIntegrity');

const LOG_PREFIX = '2026-08-21T10:00:0';

/** En loggrad i exakt det format Homey-CLI:n skriver. */
function logLine(i, payload) {
  return `${LOG_PREFIX}${i % 10}.000Z [log] [AISBridgeApp] [AIS_REPLAY_SAMPLE] ${payload}`;
}

function sample(i) {
  return JSON.stringify({
    mmsi: `26500000${i}`, lat: 58.28 + i / 10000, lon: 12.28, sog: 3.2, feed: 'aishub',
  });
}

describe('K24 replay-integritet', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-integritet-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Skriver ett par (logg, jsonl) där jsonl:en innehåller de `kept` första
   * sampel-raderna av `total`, valfritt avhuggen mitt i nästa rad.
   */
  function writePair(total, kept, opts = {}) {
    const logPath = path.join(dir, 'app-20260821-100000.log');
    const jsonlPath = path.join(dir, 'ais-replay-20260821-100000.jsonl');
    const samples = [];
    const logLines = ['2026-08-21T09:59:59.000Z [log] [AISBridgeApp] appen startar'];
    for (let i = 0; i < total; i += 1) {
      const s = sample(i);
      samples.push(s);
      logLines.push(logLine(i, s));
    }
    fs.writeFileSync(logPath, `${logLines.join('\n')}\n`);

    let body = samples.slice(0, kept).map((s) => `${s}\n`).join('');
    if (opts.truncatedTail && kept < total) {
      // Blockbuffertens signatur: filen slutar mitt i nästa JSON-objekt.
      body += samples[kept].slice(0, 40);
    }
    if (opts.extraLines) body += opts.extraLines;
    fs.writeFileSync(jsonlPath, body);
    return { logPath, jsonlPath };
  }

  test('komplett fångst ger OK — lika många rader som sampel, identiska i ordning', () => {
    const { logPath, jsonlPath } = writePair(25, 25);
    const r = checker.checkPair(jsonlPath, logPath, {});
    expect(r.verdict).toBe('OK');
    expect(r.problems).toEqual([]);
    expect(r.logSamples).toBe(25);
    expect(r.jsonlComplete).toBe(25);
  });

  test('trunkerad fångst med avhuggen sista rad ger FEL (nattkörningens signatur)', () => {
    const { logPath, jsonlPath } = writePair(25, 17, { truncatedTail: true });
    const r = checker.checkPair(jsonlPath, logPath, {});
    expect(r.verdict).toBe('FEL');
    expect(r.jsonlComplete).toBe(17);
    expect(r.logSamples).toBe(25);
    expect(r.problems.join(' ')).toMatch(/AVHUGGEN/);
    expect(r.problems.join(' ')).toMatch(/8 av 25 sampel SAKNAS/);
    // Rent avhugg = prefixet är intakt; det skiljer tappad svans från kaos.
    expect(r.notes.join(' ')).toMatch(/PREFIX/);
  });

  test('tappade rader UTAN avhuggen svans fångas ändå (radantalet är beviset)', () => {
    // Den lömska varianten: filen slutar snyggt med radbrytning och SER
    // komplett ut. Bara jämförelsen mot loggen avslöjar att facit saknas.
    const { logPath, jsonlPath } = writePair(25, 20);
    const r = checker.checkPair(jsonlPath, logPath, {});
    expect(r.verdict).toBe('FEL');
    expect(r.endsWithNewline).toBe(true);
    expect(r.problems.join(' ')).toMatch(/5 av 25 sampel SAKNAS/);
  });

  test('dubbelskrivning (fler rader än sampel) ger FEL', () => {
    // Två skrivare mot samma path — den risk som app.js egen fångstväg bar
    // så länge run-with-logs.sh gav den samma filnamn som skalfångsten.
    const { logPath, jsonlPath } = writePair(25, 25, { extraLines: `${sample(3)}\n` });
    const r = checker.checkPair(jsonlPath, logPath, {});
    expect(r.verdict).toBe('FEL');
    expect(r.problems.join(' ')).toMatch(/FLER rader än loggens sampel/);
  });

  test('omkastade rader ger FEL även när antalet stämmer', () => {
    const { logPath, jsonlPath } = writePair(10, 10);
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    const swapped = lines.slice();
    [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    fs.writeFileSync(jsonlPath, `${swapped.join('\n')}\n`);
    const r = checker.checkPair(jsonlPath, logPath, {});
    expect(r.verdict).toBe('FEL');
    expect(r.problems.join(' ')).toMatch(/rad 4 skiljer sig/);
  });

  test('tom jsonl ger FEL (debug_level var inte "full")', () => {
    const { logPath, jsonlPath } = writePair(25, 0);
    const r = checker.checkPair(jsonlPath, logPath, {});
    expect(r.verdict).toBe('FEL');
    expect(r.problems.join(' ')).toMatch(/TOM \(0 byte\)/);
  });

  test('saknad källogg ger OKÄNT — aldrig OK på gissning', () => {
    const { jsonlPath } = writePair(25, 25);
    const r = checker.checkPair(jsonlPath, null, {});
    expect(r.verdict).toBe('OKÄNT');
    expect(r.notes.join(' ')).toMatch(/källogg saknas/);
  });

  test('resolveLog parar ihop jsonl och logg på filnamnets tidsstämpel', () => {
    const { logPath, jsonlPath } = writePair(5, 5);
    const found = checker.resolveLog(jsonlPath, [dir]);
    expect(found.log).toBe(logPath);
    expect(checker.timestampOf(jsonlPath)).toBe('20260821-100000');
  });

  test('main() returnerar exitkod 1 för trunkerad och 0 för komplett', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const bad = writePair(25, 17, { truncatedTail: true });
      expect(checker.main(['node', 'check', bad.jsonlPath, bad.logPath])).toBe(1);
      fs.rmSync(bad.jsonlPath);
      fs.rmSync(bad.logPath);
      const good = writePair(25, 25);
      expect(checker.main(['node', 'check', good.jsonlPath, good.logPath])).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * REGRESSIONSPROV MOT FÄLTFALLET — men mot FIXTURER I REPOT, inte hemkatalogen.
 *
 * Provet körde förr mot ~/.ais-tracker-logs och låste `jsonlComplete === 99`.
 * Samtidigt föreskriver docs/VALIDATION.md steg 2 att en trunkerad jsonl byggs
 * OM ur den hela loggen (`grep 'AIS_REPLAY_SAMPLE' … | sed …`). Byggdes den om
 * PÅ PLATS blev 99 → 146 och testet föll: provet kodade in ett tillstånd
 * projektet uttryckligen vill lämna, i en katalog utanför repot som ingen
 * granskning ser. `existsSync && size > 0` fångade bara att filen FÖRSVANN,
 * aldrig att den ÄNDRADES. (Granskningsfynd 2026-08-21.)
 *
 * Beviset ligger nu fruset i tests/replay-validation/fixtures/ (se README.md
 * där för proveniens och de exakta byggkommandona):
 *   • ais-replay-20260819-003935.truncated.jsonl — BYTE-EXAKT kopia av fältets
 *     trunkerade fångst (24 576 B = 6×4096, 99 rader, avhuggen svans)
 *   • app-20260819-003935.samples.log — exakt de 146 [AIS_REPLAY_SAMPLE]-raderna
 *     ur den 1,5 MB stora apploggen, byte-äkta och i ordning (verktyget läser
 *     bara sampelraderna). Ingen kommentarrad: filen är ett rent utsnitt.
 *   • *.first20.* — ett KOMPLETT par ur samma körning för OK-fallet, härlett med
 *     projektets egen extraktion.
 * Sviten beror alltså inte längre på den här maskinen.
 */
describe('K24 fältfallet 2026-08-19 (fixturer i repot)', () => {
  const FIX = path.join(__dirname, 'replay-validation', 'fixtures');
  const truncatedJsonl = path.join(FIX, 'ais-replay-20260819-003935.truncated.jsonl');
  const samplesLog = path.join(FIX, 'app-20260819-003935.samples.log');
  const completeJsonl = path.join(FIX, 'ais-replay-20260819-003935.first20.jsonl');
  const completeLog = path.join(FIX, 'app-20260819-003935.first20.log');

  test('den trunkerade nattfångsten ger FEL — 99 kompletta rader mot 146 sampel', () => {
    const r = checker.checkPair(truncatedJsonl, samplesLog, {});
    expect(r.verdict).toBe('FEL');
    expect(r.jsonlComplete).toBe(99);
    expect(r.logSamples).toBe(146);
    expect(r.bytes).toBe(24576);
    expect(r.endsWithNewline).toBe(false);
    expect(r.problems.join(' ')).toMatch(/AVHUGGEN/);
    expect(r.problems.join(' ')).toMatch(/47 av 146 sampel SAKNAS i jsonl:en \(32\.2 %\)/);
    // Blockbuffertens signatur — 24 576 = 6×4096, allt som skrevs kom ut i hela
    // block och resten låg kvar i userspace när processen dog.
    expect(r.notes.join(' ')).toMatch(/24576 B = exakt 6×4096/);
    // Rent avhugg, ingen omkastning: de 99 raderna ÄR loggens 99 första sampel.
    expect(r.notes.join(' ')).toMatch(/byte-exakt PREFIX/);
  });

  test('ett KOMPLETT par ur samma körning ger OK — 20 rader mot 20 sampel', () => {
    const r = checker.checkPair(completeJsonl, completeLog, {});
    expect(r.verdict).toBe('OK');
    expect(r.jsonlComplete).toBe(20);
    expect(r.logSamples).toBe(20);
    expect(r.problems).toEqual([]);
    expect(r.endsWithNewline).toBe(true);
  });

  test('fixturerna är byte-låsta (sha256) — en ombyggnad ska SYNAS, inte smyga', () => {
    // Utan det här låset kan någon "städa" fixturerna och testet ovan skulle
    // fortsätta vara grönt mot något annat än fältets faktiska bevis.
    const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    expect(sha(truncatedJsonl)).toBe('e90f4056c29d63cd6a966003fc6d45bb6aa75f3c4c79cebf021081a2c3f6ad5d');
    expect(sha(samplesLog)).toBe('bd70000b0d86464014238a1ab01ccdb48643fe68b2d4c5bdafa29beccebb50bd');
    expect(sha(completeLog)).toBe('2fecc80e177e3bc87c51fd6232437d9e4fd6c54beec894dc3616fff29f5f0137');
    expect(sha(completeJsonl)).toBe('f654539b59ee3011765094edc1ed1befd4220623253ce85fa13bb20e7618663e');
  });

  test('den trunkerade fixturen är byte-identisk med fältfilen den kopierades från', () => {
    // Bevisar att fixturen ÄR fältfilen och inte en efterhandskonstruktion.
    // Hoppas inte över: när fältfilen är borta eller ombyggd (det förväntade
    // slutläget) står påståendet kvar som en not, inte som en grind.
    const live = path.join(os.homedir(), '.ais-tracker-logs', 'ais-replay-20260819-003935.jsonl');
    if (!fs.existsSync(live)) return;
    const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (sha(live) !== 'e90f4056c29d63cd6a966003fc6d45bb6aa75f3c4c79cebf021081a2c3f6ad5d') return;
    expect(sha(live)).toBe(sha(truncatedJsonl));
  });
});

/**
 * DE SKARPA FÄLTFILERNA — kvar som körbara prov, men BARA när filerna står
 * exakt som de gjorde när fyndet skrevs (sha256-lås). Byggs 003935-jsonl:en om
 * ur den hela loggen — vilket VALIDATION.md steg 2 rekommenderar — blir det en
 * synlig SKIP med förklaring i stället för ett oförklarligt rött test.
 * Fixturproven ovan är den bindande regressionen; de här är en bonus.
 */
describe('K24 skarpa fältfilerna (~/.ais-tracker-logs, sha256-låsta)', () => {
  const liveDir = path.join(os.homedir(), '.ais-tracker-logs');
  const cases = [
    {
      ts: '20260819-003935',
      verdict: 'FEL',
      jsonl: 99,
      log: 146,
      sha: 'e90f4056c29d63cd6a966003fc6d45bb6aa75f3c4c79cebf021081a2c3f6ad5d',
    },
    {
      ts: '20260819-081250',
      verdict: 'OK',
      jsonl: 1348,
      log: 1348,
      sha: '5393faf053ba7f4ce476f578544f3b77594837af036797806be0f0a3722ae854',
    },
  ];

  for (const c of cases) {
    const jsonlPath = path.join(liveDir, `ais-replay-${c.ts}.jsonl`);
    const logPath = path.join(liveDir, `app-${c.ts}.log`);
    let locked = false;
    try {
      locked = fs.existsSync(jsonlPath)
        && fs.existsSync(logPath)
        && fs.statSync(logPath).size > 0
        && crypto.createHash('sha256').update(fs.readFileSync(jsonlPath)).digest('hex') === c.sha;
    } catch (err) {
      locked = false;
    }
    const maybe = locked ? test : test.skip;

    maybe(`${c.ts} ger ${c.verdict} (${c.jsonl} rader mot ${c.log} sampel)`, () => {
      const r = checker.checkPair(jsonlPath, logPath, {});
      expect(r.jsonlComplete).toBe(c.jsonl);
      expect(r.logSamples).toBe(c.log);
      expect(r.verdict).toBe(c.verdict);
    }, 60000);
  }
});

/**
 * `--dir` PLOCKAR INTE UPP APPENS EGEN FÅNGSTFIL (granskningsfynd 2026-08-21).
 *
 * run-with-logs.sh:69 lägger appens egen fångstväg som
 * `ais-replay-<ts>.appside.jsonl` (AIS_REPLAY_CAPTURE_FILE, app.js:232) i samma
 * katalog som skalfångsten. Med det gamla breda `.jsonl`-filtret matchade den
 * både filnamnsfiltret och `timestampOf`-regexet, parades mot app-<ts>.log och
 * hade rapporterats FEL för en fil som aldrig var en korpuskandidat.
 * `--corpora` läser en KONTROLLERAD katalog och behåller det breda filtret —
 * där finns alias-korpusar (`ais-20260804-17h-dag.jsonl`) och härledda
 * fusionsfiler (`ais-fusion-*.jsonl`) som inte heter `ais-replay-`.
 */
describe('K24 --dir-filtret', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-dirfilter-'));
    fs.writeFileSync(path.join(dir, 'ais-replay-20260821-100000.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'ais-replay-20260821-100000.appside.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'ais-fusion-20260821-100000.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'nagot-annat.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'app-20260821-100000.log'), 'inget sampel här\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('--dir-läget tar bara ais-replay-*.jsonl och hoppar över .appside.jsonl', () => {
    const names = checker.collectPairsFromDir(dir, { dirMode: true }).map((p) => path.basename(p));
    expect(names).toEqual(['ais-replay-20260821-100000.jsonl']);
  });

  test('--corpora-läget behåller det breda filtret (alias- och fusionskorpusar)', () => {
    const names = checker.collectPairsFromDir(dir).map((p) => path.basename(p));
    expect(names).toContain('ais-fusion-20260821-100000.jsonl');
    expect(names).toContain('nagot-annat.jsonl');
    expect(names).toContain('ais-replay-20260821-100000.appside.jsonl');
  });
});

/**
 * FLERBYTETECKEN PÅ LÄSBITENS GRÄNS — falskt FEL på en HEL korpus.
 *
 * readLogSamples strömmar loggen i 4 MiB-bitar. Dekodades varje bit för sig
 * (buf.toString) delades ett tecken som låg över gränsen i två halvor som var
 * för sig är ogiltig UTF-8 ⇒ U+FFFD i båda bitarna, medan jsonl:en läses som
 * EN buffert och är korrekt. Rad-för-rad-jämförelsen såg då en skillnad som
 * inte fanns och dömde en byte-exakt korpus till FEL. Fältloggarna är 15–70 MB
 * (upp till 17 bitgränser) och sampelraderna bär svenska fartygsnamn — felet
 * var alltså godtyckligt men återkommande.
 */
describe('K24 flerbytetecken på läsbitens gräns', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-bitgrans-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Ö delat över 4 MiB-gränsen ger OK — inte ett falskt FEL', () => {
    const chunk = checker.READ_CHUNK;
    const head = '2026-08-21T11:00:00.000Z [log] [AISBridgeApp] [AIS_REPLAY_SAMPLE] ';
    const pre = '{"mmsi":"265000123","name":"L';
    const post = 'VGRUND","feed":"aisstream"}';
    // Fyllnad av ren ASCII så att Ö:s FÖRSTA byte (0xC3) hamnar på exakt sista
    // positionen i första biten och fortsättningsbyten (0x96) först i nästa.
    const fillerBytes = chunk - 1 - Buffer.byteLength(head + pre, 'utf8');
    expect(fillerBytes).toBeGreaterThan(0);
    const whole = Math.floor(fillerBytes / 64);
    const rest = fillerBytes % 64;
    let filler = `${'x'.repeat(63)}\n`.repeat(whole);
    if (rest === 1) filler += '\n';
    else if (rest > 1) filler += `${'y'.repeat(rest - 1)}\n`;

    const first = `${pre}Ö${post}`;
    const second = '{"mmsi":"265000999","name":"NÄSTA BÅT","feed":"aisstream"}';
    const logBuf = Buffer.from(`${filler}${head}${first}\n${head}${second}\n`, 'utf8');
    // Självkontroll: utan den här ligger tecknet inte på gränsen och testet
    // skulle bli grönt utan att bevisa något.
    expect(logBuf[chunk - 1]).toBe(0xC3);
    expect(logBuf[chunk]).toBe(0x96);

    const logPath = path.join(dir, 'app-20260821-110000.log');
    const jsonlPath = path.join(dir, 'ais-replay-20260821-110000.jsonl');
    fs.writeFileSync(logPath, logBuf);
    fs.writeFileSync(jsonlPath, `${first}\n${second}\n`);

    const r = checker.checkPair(jsonlPath, logPath, {});
    expect(r.logSamples).toBe(2);
    expect(r.jsonlComplete).toBe(2);
    expect(r.problems).toEqual([]);
    expect(r.verdict).toBe('OK');
  }, 30000);
});

/**
 * HÄRLEDDA TVÅKÄLLIGA KORPUSAR — verdiktet ska bära hur mycket som mätts.
 *
 * ais-fusion-*.jsonl blandar loggbara aisstream-rader med aishub-rader som är
 * parseade ur [AISHUB_RESPONSE_SAMPLE]-kuvert. Bara den första delen kan
 * jämföras rad för rad. Förr fick filen ett bart "✅ OK" trots att 1014 av
 * 1385 rader (73 %) aldrig jämförts.
 */
describe('K24 tvåkälliga korpusar ger DELVIS, inte OK', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-fusion-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const STREAM = 5;
  const HUB = 12;

  /** Logg med både sampelrader och två AISHub-svarskuvert + en fusions-jsonl. */
  function writeFusion() {
    const logPath = path.join(dir, 'app-20260821-120000.log');
    const jsonlPath = path.join(dir, 'ais-fusion-20260821-120000.jsonl');
    const streamRows = [];
    const logLines = [];
    for (let i = 0; i < STREAM; i += 1) {
      const row = JSON.stringify({
        mmsi: `26510000${i}`, lat: 58.28, lon: 12.28, feed: 'aisstream',
      });
      streamRows.push(row);
      logLines.push(`${LOG_PREFIX}${i % 10}.000Z [log] [AISBridgeApp] [AIS_REPLAY_SAMPLE] ${row}`);
    }
    const hubRows = [];
    for (let i = 0; i < HUB; i += 1) {
      hubRows.push(JSON.stringify({
        mmsi: `26520000${i}`, lat: 58.29, lon: 12.29, feed: 'aishub',
      }));
    }
    // Två kuvert i loggen — ett svar bär många fartygsrader, så antalet är
    // kontext och aldrig en 1:1-verifiering.
    for (let i = 0; i < 2; i += 1) {
      logLines.push(`${LOG_PREFIX}${i}.000Z [log] [AISBridgeApp] [AISHUB_RESPONSE_SAMPLE] {"vessels":${HUB / 2}}`);
    }
    fs.writeFileSync(logPath, `${logLines.join('\n')}\n`);
    // Fusionsfilen är tidssorterad ⇒ källorna ligger om vartannat.
    const merged = [];
    for (let i = 0; i < Math.max(STREAM, HUB); i += 1) {
      if (i < HUB) merged.push(hubRows[i]);
      if (i < STREAM) merged.push(streamRows[i]);
    }
    fs.writeFileSync(jsonlPath, `${merged.join('\n')}\n`);
    return { logPath, jsonlPath, streamRows };
  }

  test('verdiktet är DELVIS med siffrorna utskrivna — inte ett bart OK', () => {
    const { logPath, jsonlPath } = writeFusion();
    const r = checker.checkPair(jsonlPath, logPath, {});
    expect(r.verdict).toBe('DELVIS');
    expect(r.partial).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.partialNote).toBe(`aisstream-delen ${STREAM}/${STREAM} mot logg; aishub-delen ${HUB} ej loggbar`);
    expect(r.notes.join(' ')).toMatch(/byte-jämförda mot loggens sampel/);
    expect(r.notes.join(' ')).toMatch(/parseade ur loggens 2 \[AISHUB_RESPONSE_SAMPLE\]-svar/);
  });

  test('DELVIS ger exitkod 0 och verdiktraden bär nyansen till den som bara läser sista raden', () => {
    const { logPath, jsonlPath } = writeFusion();
    const rader = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => rader.push(a.join(' ')));
    try {
      expect(checker.main(['node', 'check', jsonlPath, logPath])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const ut = rader.join('\n');
    expect(ut).toMatch(/VERDIKT: DELVIS verifierad \(aisstream-delen 5\/5 mot logg; aishub-delen 12 ej loggbar\)/);
    expect(ut).not.toMatch(/VERDIKT: OK/);
  });

  test('en ändrad aisstream-rad fäller ändå filen (delen som KAN mätas mäts på riktigt)', () => {
    const { logPath, jsonlPath, streamRows } = writeFusion();
    const body = fs.readFileSync(jsonlPath, 'utf8');
    const trasig = body.replace(streamRows[2], streamRows[2].replace('58.28', '58.99'));
    expect(trasig).not.toBe(body);
    fs.writeFileSync(jsonlPath, trasig);
    const r = checker.checkPair(jsonlPath, logPath, {});
    expect(r.verdict).toBe('FEL');
    expect(r.partial).toBe(false);
    expect(r.problems.join(' ')).toMatch(/aisstream-delens rad 3 skiljer sig/);
  });
});
