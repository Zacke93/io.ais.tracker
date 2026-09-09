'use strict';

/**
 * FASSVEPETS DOMARE — enhetsprov (granskningsfynd 2026-08-21, K20).
 *
 * runPhaseSweep.js är en GRIND, och en grind utan eget test är ett påstående
 * ingen prövat. Systerverktyget checkReplayIntegrity.js har
 * tests/replay-integrity.test.js; fassvepet hade noll tester — och det första
 * granskningsfyndet mot det (GRÖNT med exitkod 0 när NOLL fasvarianter kunde
 * köras) är exakt vad ett test av verdiktvalet hade fångat direkt.
 *
 * Här prövas domarna UTAN att köra en replay: verdiktvalet, undantagens
 * uppslagning och matchning, undantagsfilens formkrav, skyddsnäten mellan bas
 * och variant, och det typbevarande tidsskiftet. De två CLI-fallen längst ned
 * kör skriptet på riktigt men aldrig en replay — de faller redan på argumenten,
 * så sviten är snabb och maskinoberoende.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sweep = require('./replay-validation/runPhaseSweep');

const SCRIPT = path.join(__dirname, 'replay-validation', 'runPhaseSweep.js');

test('fasvarianten bevarar inspelat startminne och flyttar bara startklockan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-state-phase-'));
  try {
    const file = path.join(dir, 'input.jsonl');
    fs.writeFileSync(file, JSON.stringify({ mmsi: '265000001', aisTimestamp: 1000000 }));
    const state = { version: 1, capturedAt: 999000, settings: { learned_mooring_spots: [{ lat: 58.26, lon: 12.26, t: 900000 }] } };
    fs.writeFileSync(path.join(dir, 'input.state.json'), JSON.stringify(state));
    const output = path.join(dir, 'variant.jsonl');
    expect(sweep.writePhaseVariant(sweep.readCorpus(file), -5000, output).ok).toBe(true);
    const restored = JSON.parse(fs.readFileSync(path.join(dir, 'variant.state.json'), 'utf8'));
    expect(restored.settings).toEqual(state.settings);
    expect(restored.capturedAt).toBe(994000);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).aisTimestamp).toBe(995000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** En sammanfattning i det skick sweepCorpus lämnar den. */
function summaryOf(over = {}) {
  return {
    corpusId: 'prov',
    ran: 3,
    skipped: [],
    sensitivities: [],
    known: [],
    hardFail: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('verdictFor — noll körda varianter är ALDRIG grönt', () => {
  test('ran === 0 ger OMÄTT och räknas som rött', () => {
    // FYNDET SJÄLVT: blev varje offset "ej tillämpbar" skrev den gamla
    // else-grenen "GRÖNT" och exitkod 0. Reproducerat i fält:
    // PHASE_SWEEP_OFFSETS=5 mot en korpus vars första gap är 149 ms.
    const v = sweep.verdictFor(summaryOf({ ran: 0, skipped: [{ label: '+5 s', reason: 'gapet' }] }));
    expect(v.level).toBe('OMÄTT');
    expect(v.red).toBe(true);
  });

  test('ran === 0 slår igenom även när det inte finns några avvikelser alls', () => {
    // Just den kombinationen (inga känsligheter, inga undantag, noll körda)
    // är den som föll ned i else-grenen.
    const v = sweep.verdictFor(summaryOf({
      ran: 0, sensitivities: [], known: [], hardFail: null,
    }));
    expect(v.level).not.toBe('GRÖNT');
    expect(v.red).toBe(true);
  });

  test('hardFail väger tyngre än OMÄTT — ett brutet svep säger BRÖTS', () => {
    const v = sweep.verdictFor(summaryOf({ ran: 0, hardFail: 'fas -5 s: replayn misslyckades' }));
    expect(v.level).toBe('BRÖTS');
    expect(v.red).toBe(true);
  });

  test('minst en körd variant utan avvikelser ger GRÖNT och inte rött', () => {
    const v = sweep.verdictFor(summaryOf({ ran: 1 }));
    expect(v.level).toBe('GRÖNT');
    expect(v.red).toBe(false);
  });

  test('odokumenterad känslighet ger FAS-KÄNSLIGT (rött), dokumenterad ger GRÖNT-UNDANTAG', () => {
    const rod = sweep.verdictFor(summaryOf({ sensitivities: [{ dim: 'notiser', key: 'x' }] }));
    expect(rod.level).toBe('FAS-KÄNSLIGT');
    expect(rod.red).toBe(true);

    const gron = sweep.verdictFor(summaryOf({ known: [{ dim: 'notiser', key: 'x' }] }));
    expect(gron.level).toBe('GRÖNT-UNDANTAG');
    expect(gron.red).toBe(false);
  });

  test('en känslighet väger tyngre än ett känt undantag i samma svep', () => {
    const v = sweep.verdictFor(summaryOf({
      sensitivities: [{ dim: 'brotext', key: 'a' }],
      known: [{ dim: 'notiser', key: 'b' }],
    }));
    expect(v.level).toBe('FAS-KÄNSLIGT');
    expect(v.red).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('matchException — prefix och wildcard', () => {
  const entries = [
    { utfall: 'Stridsbergsbron#', motivering: 'knivsegg i ledande båt', datum: '2026-08-21' },
  ];

  test('snävt undantag gäller bara uppmätt antalsskillnad och angivna faser', () => {
    const limited = [{ utfall: 'ETA okänd', detalj: 'bas 2 → variant 3', faser: [-20, -25] }];
    expect(sweep.matchException(limited, 'ETA okänd', 'bas 2 → variant 3', -20)).toBe(limited[0]);
    expect(sweep.matchException(limited, 'ETA okänd', 'bas 2 → variant 4', -20)).toBeNull();
    expect(sweep.matchException(limited, 'ETA okänd', 'bas 2 → variant 3', -15)).toBeNull();
    expect(sweep.matchException(limited, 'ETA okänd')).toBeNull();
  });

  test('utfall matchas som PREFIX mot avvikelsens nyckel', () => {
    expect(matchKey(entries, 'Stridsbergsbron#2')).toBe(entries[0]);
    expect(matchKey(entries, 'Stridsbergsbron#11')).toBe(entries[0]);
  });

  test('prefixet biter inte på en ANNAN bro — grinden får inte öppnas för brett', () => {
    expect(matchKey(entries, 'Klaffbron#2')).toBeNull();
    // Prefix, inte delsträng: nyckeln måste BÖRJA med utfallet.
    expect(matchKey(entries, 'X Stridsbergsbron#2')).toBeNull();
  });

  test('"*" matchar hela dimensionen', () => {
    const star = [{ utfall: '*', motivering: 'hela dimensionen är känd', datum: '2026-08-21' }];
    expect(matchKey(star, 'vad som helst')).toBe(star[0]);
    expect(matchKey(star, '265000001:Klaffbron:northbound')).toBe(star[0]);
  });

  test('ingen lista alls ger null i stället för att kasta', () => {
    expect(sweep.matchException(undefined, 'Klaffbron#1')).toBeNull();
    expect(sweep.matchException(null, 'Klaffbron#1')).toBeNull();
  });

  function matchKey(list, key) {
    return sweep.matchException(list, key);
  }
});

// ---------------------------------------------------------------------------

describe('exceptionsFor — uppslagning och varning vid fel korpusnyckel', () => {
  const dims = { notiser: [{ utfall: '*', motivering: 'prov för uppslagning', datum: '2026-08-21' }] };

  test('slår upp på korpus-id, filnamn ELLER filnamn utan ändelse', () => {
    const pathen = '/x/y/ais-replay-20260819-081250.jsonl';
    expect(sweep.exceptionsFor({ data: { '20260819-24h': dims } }, '20260819-24h', pathen).key)
      .toBe('20260819-24h');
    expect(sweep.exceptionsFor({ data: { 'ais-replay-20260819-081250.jsonl': dims } }, 'annat', pathen).key)
      .toBe('ais-replay-20260819-081250.jsonl');
    expect(sweep.exceptionsFor({ data: { 'ais-replay-20260819-081250': dims } }, 'annat', pathen).key)
      .toBe('ais-replay-20260819-081250');
  });

  test('en träff ger INGEN varning', () => {
    const r = sweep.exceptionsFor({ data: { prov: dims } }, 'prov', '/x/prov.jsonl');
    expect(r.warning).toBeNull();
    expect(r.dims).toBe(dims);
  });

  test('poster som INTE matchar ger en varning som namnger både nycklarna och korpusen', () => {
    // FYNDET: granskarens första prov skrev nyckeln "20260819-081250" för filen
    // ais-replay-20260819-081250.jsonl — hela undantagsblocket ignorerades utan
    // ett ord, och svepet gick rött utan att säga varför.
    const r = sweep.exceptionsFor(
      { data: { '20260819-081250': dims } },
      'ais-replay-20260819-081250',
      '/x/ais-replay-20260819-081250.jsonl',
    );
    expect(r.key).toBeNull();
    expect(r.dims).toEqual({});
    expect(r.warning).toMatch(/Undantagsfilen har poster för/);
    expect(r.warning).toContain('"20260819-081250"');
    expect(r.warning).toContain('ais-replay-20260819-081250');
  });

  test('en TOM undantagsfil varnar inte — det finns inget att missa', () => {
    const r = sweep.exceptionsFor({ data: {} }, 'prov', '/x/prov.jsonl');
    expect(r.warning).toBeNull();
  });

  test('_-nycklar är dokumentation och räknas aldrig som poster', () => {
    const r = sweep.exceptionsFor(
      { data: { _om: 'text', _format: {}, _exempel_ej_aktivt: { x: dims } } },
      'prov',
      '/x/prov.jsonl',
    );
    expect(r.warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('loadExceptions — motivering och datum är OBLIGATORISKA', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fassvep-undantag-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(obj) {
    const p = path.join(dir, 'undantag.json');
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  }

  const ok = { utfall: 'Klaffbron#1', motivering: 'känd defekt i ledande båt', datum: '2026-08-21' };

  test('en komplett post går igenom', () => {
    const r = sweep.loadExceptions(write({ prov: { oppningar: [ok] } }));
    expect(r.exists).toBe(true);
    expect(r.data.prov.oppningar[0]).toEqual(ok);
  });

  test('SAKNAD motivering kastar — ett omotiverat undantag är en tyst avstängd grind', () => {
    const p = write({ prov: { oppningar: [{ utfall: 'Klaffbron#1', datum: '2026-08-21' }] } });
    expect(() => sweep.loadExceptions(p)).toThrow(/motivering/);
  });

  test('för KORT motivering kastar också (minst 10 tecken)', () => {
    const p = write({ prov: { oppningar: [{ ...ok, motivering: 'nja' }] } });
    expect(() => sweep.loadExceptions(p)).toThrow(/minst 10 tecken/);
  });

  test('SAKNAT datum kastar, och fel datumformat likaså', () => {
    expect(() => sweep.loadExceptions(write({ prov: { oppningar: [{ utfall: 'Klaffbron#1', motivering: 'en giltig motivering' }] } })))
      .toThrow(/datum/);
    expect(() => sweep.loadExceptions(write({ prov: { oppningar: [{ ...ok, datum: '21/8 2026' }] } })))
      .toThrow(/ÅÅÅÅ-MM-DD/);
  });

  test('okänd dimension kastar och räknar upp de giltiga', () => {
    const p = write({ prov: { notiiser: [ok] } });
    expect(() => sweep.loadExceptions(p)).toThrow(/okänd dimension "notiiser"/);
    const dimIds = sweep.DIMENSIONS.map((d) => d.id);
    expect(() => sweep.loadExceptions(p)).toThrow(new RegExp(dimIds[0]));
  });

  test('post utan "utfall" kastar', () => {
    const p = write({ prov: { notiser: [{ motivering: 'en giltig motivering', datum: '2026-08-21' }] } });
    expect(() => sweep.loadExceptions(p)).toThrow(/kräver ett "utfall"/);
  });

  test('trasig JSON kastar med filnamnet i meddelandet', () => {
    const p = path.join(dir, 'undantag.json');
    fs.writeFileSync(p, '{ inte json');
    expect(() => sweep.loadExceptions(p)).toThrow(/går inte att läsa/);
  });

  test('filen behöver inte finnas — då finns inga undantag', () => {
    const r = sweep.loadExceptions(path.join(dir, 'finns-inte.json'));
    expect(r.exists).toBe(false);
    expect(r.data).toEqual({});
  });

  test('projektets EGEN undantagsfil validerar', () => {
    // Regressionsskydd: en handredigerad phase-sweep-exceptions.json som bryter
    // formkraven gör `npm run replay:phase` till ANROPSFEL för alla korpusar.
    const real = path.join(__dirname, 'replay-validation', 'phase-sweep-exceptions.json');
    expect(() => sweep.loadExceptions(real)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('unusedExceptionWarnings — en post som inte bet ska synas', () => {
  test('oanvänd post ger en varning som namnger dimension och utfall', () => {
    const dims = {
      notiser: [{ utfall: '265000999:', motivering: 'uppträdde en gång', datum: '2026-08-21' }],
    };
    const w = sweep.unusedExceptionWarnings(dims, new Set());
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/OANVÄNT UNDANTAG \(notiser: "265000999:"\)/);
  });

  test('en post som ANVÄNTS varnar inte', () => {
    const dims = { notiser: [{ utfall: '*', motivering: 'känd känslighet', datum: '2026-08-21' }] };
    expect(sweep.unusedExceptionWarnings(dims, new Set(['notiser|*']))).toEqual([]);
  });

  test('nyckeln är dimension|utfall — samma utfall i EN ANNAN dimension räknas inte som använd', () => {
    const dims = { brotext: [{ utfall: '*', motivering: 'känd känslighet', datum: '2026-08-21' }] };
    expect(sweep.unusedExceptionWarnings(dims, new Set(['notiser|*']))).toHaveLength(1);
  });

  test('_-nycklar och icke-listor hoppas över utan att kasta', () => {
    const dims = { _kommentar: 'text', notiser: 'inte en lista' };
    expect(sweep.unusedExceptionWarnings(dims, new Set())).toEqual([]);
    expect(sweep.unusedExceptionWarnings(undefined, new Set())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('hardFailFor — skyddsnäten mellan bas och variant', () => {
  test('sampelantal som SKILJER SIG fäller svepet', () => {
    const msg = sweep.hardFailFor({ sampleCount: 1348 }, { sampleCount: 1347 }, '-11.52 s');
    expect(msg).toMatch(/1347 sampel mot basens 1348/);
    expect(msg).toMatch(/skiftet ändrade datamängden/);
    // …och den domen är röd hela vägen ut.
    expect(sweep.verdictFor(summaryOf({ ran: 1, hardFail: msg })).red).toBe(true);
  });

  test('lika sampelantal och lika processfel ger null (jämförbart)', () => {
    expect(sweep.hardFailFor(
      { sampleCount: 10, processErrors: 0 },
      { sampleCount: 10, processErrors: 0 },
      '-5 s',
    )).toBeNull();
  });

  test('FLER processfel i varianten fäller — fasen framkallar en krasch', () => {
    const msg = sweep.hardFailFor(
      { sampleCount: 10, processErrors: 1 },
      { sampleCount: 10, processErrors: 3 },
      '-20 s',
    );
    expect(msg).toMatch(/3 processfel mot basens 1/);
  });

  test('FÄRRE processfel i varianten fäller INTE — basen är taket, inte golvet', () => {
    expect(sweep.hardFailFor(
      { sampleCount: 10, processErrors: 2 },
      { sampleCount: 10, processErrors: 0 },
      '-20 s',
    )).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('shiftTimeField / writePhaseVariant — fasen skiftas, TYPEN bevaras', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fassvep-variant-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('epok-ms förblir number', () => {
    const obj = { fixTs: 1781171793817 };
    expect(sweep.shiftTimeField(obj, 'fixTs', -11520)).toBe(true);
    expect(typeof obj.fixTs).toBe('number');
    expect(obj.fixTs).toBe(1781171793817 - 11520);
  });

  test('ISO-sträng förblir ISO-sträng — och bär det nya klockslaget', () => {
    // Korpusarnas receivedAt skrivs som new Date().toISOString() (app.js).
    const obj = { receivedAt: '2026-06-11T09:56:33.818Z' };
    expect(sweep.shiftTimeField(obj, 'receivedAt', -11520)).toBe(true);
    expect(typeof obj.receivedAt).toBe('string');
    expect(obj.receivedAt).toBe('2026-06-11T09:56:22.298Z');
  });

  test('fält som saknas, är null eller är oparsbara lämnas orörda och rapporteras som ohanterade', () => {
    const obj = {
      a: null, b: undefined, c: 'inte ett datum', d: NaN, e: '',
    };
    for (const k of ['a', 'b', 'c', 'd', 'e']) expect(sweep.shiftTimeField(obj, k, 1000)).toBe(false);
    expect(obj.a).toBeNull();
    expect(obj.c).toBe('inte ett datum');
  });

  test('ALLA TRE tidsfälten skiftas på ankarraden, och bara ankarraden ändras', () => {
    // Granskningsfyndet: writePhaseVariant flyttade bara två av tre tidsfält,
    // så leveranslatensen (receivedAt − aisTimestamp) vandrade med fasen.
    expect(sweep.SHIFTED_TIME_FIELDS).toEqual(['aisTimestamp', 'fixTs', 'receivedAt']);

    const src = path.join(dir, 'korpus.jsonl');
    const rows = [
      {
        mmsi: '1', aisTimestamp: 1000000, fixTs: 999000, receivedAt: '2026-06-11T09:56:33.818Z',
      },
      {
        mmsi: '2', aisTimestamp: 1060000, fixTs: 1059000, receivedAt: '2026-06-11T09:57:33.818Z',
      },
    ];
    fs.writeFileSync(src, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const corpus = sweep.readCorpus(src);
    const out = path.join(dir, 'variant.jsonl');
    const w = sweep.writePhaseVariant(corpus, -11520, out);
    expect(w.ok).toBe(true);
    expect(w.changedLines).toBe(1);
    expect(w.shiftedFields.sort()).toEqual(['aisTimestamp', 'fixTs', 'receivedAt']);
    expect(w.unshiftedFields).toEqual([]);

    const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
    const ankare = JSON.parse(lines[0]);
    expect(ankare.aisTimestamp).toBe(1000000 - 11520);
    expect(ankare.fixTs).toBe(999000 - 11520);
    expect(typeof ankare.receivedAt).toBe('string');
    expect(ankare.receivedAt).toBe('2026-06-11T09:56:22.298Z');
    // Rad 2 är byte-identisk — svepet skiftar ANKARET, aldrig strömmen.
    expect(lines[1]).toBe(JSON.stringify(rows[1]));
    // …och de inbördes gapen krymper med exakt skiftet (= en fasförskjutning).
    expect(JSON.parse(lines[1]).aisTimestamp - ankare.aisTimestamp).toBe(60000 + 11520);
  });

  test('ett tidsfält som FINNS men inte går att skifta rapporteras som ohanterat', () => {
    const src = path.join(dir, 'korpus.jsonl');
    fs.writeFileSync(src, `${JSON.stringify({ mmsi: '1', aisTimestamp: 1000000, receivedAt: null })}\n`
      + `${JSON.stringify({ mmsi: '2', aisTimestamp: 1060000 })}\n`);
    const w = sweep.writePhaseVariant(sweep.readCorpus(src), -5000, path.join(dir, 'v.jsonl'));
    expect(w.unshiftedFields).toEqual(['receivedAt']);
  });

  test('ett POSITIVT skift som inte ryms i första gapet avvisas (ingen omkastad ström)', () => {
    const src = path.join(dir, 'tat.jsonl');
    fs.writeFileSync(src, `${JSON.stringify({ mmsi: '1', aisTimestamp: 1000000 })}\n`
      + `${JSON.stringify({ mmsi: '2', aisTimestamp: 1000149 })}\n`);
    const w = sweep.writePhaseVariant(sweep.readCorpus(src), 5000, path.join(dir, 'v.jsonl'));
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/första gapet är 149 ms < 5000 ms/);
    // Det är EXAKT det utfallet som gör verdiktet OMÄTT i stället för GRÖNT.
    expect(sweep.verdictFor(summaryOf({ ran: 0, skipped: [{ label: '+5 s', reason: w.reason }] })).level)
      .toBe('OMÄTT');
  });
});

// ---------------------------------------------------------------------------

describe('diffMultiset — antalet är en del av utfallet', () => {
  test('samma multiset i annan ordning ger ingen avvikelse', () => {
    expect(sweep.diffMultiset(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([]);
  });

  test('ett annat ANTAL av samma nyckel är en avvikelse', () => {
    const d = sweep.diffMultiset(['a', 'a'], ['a']);
    expect(d).toHaveLength(1);
    expect(d[0]).toEqual({ key: 'a', detail: 'bas 2 → variant 1' });
  });

  test('en nyckel som bara finns i den ena räknas åt rätt håll', () => {
    expect(sweep.diffMultiset([], ['x'])).toEqual([{ key: 'x', detail: 'bas 0 → variant 1' }]);
    expect(sweep.diffMultiset(['x'], [])).toEqual([{ key: 'x', detail: 'bas 1 → variant 0' }]);
  });
});

// ---------------------------------------------------------------------------

describe('parseOffsets / parseArgs — felvägarna är en del av kontraktet', () => {
  test('offset 0 avvisas — det vore basen en gång till', () => {
    expect(() => sweep.parseOffsets('0')).toThrow(/basen själv/);
  });

  test('ogiltig offset avvisas med värdet i meddelandet', () => {
    expect(() => sweep.parseOffsets('-11,abc')).toThrow(/Ogiltig offset: "abc"/);
  });

  test('dubbletter i millisekunder faller bort, decimaler behålls', () => {
    expect(sweep.parseOffsets('-11.52,-11.52,-5')).toEqual([{ s: -11.52, ms: -11520 }, { s: -5, ms: -5000 }]);
  });

  test('tom lista avvisas', () => {
    expect(() => sweep.parseOffsets(' , ')).toThrow(/Tom offsetlista/);
  });

  test('okänd flagga avvisas, kända flaggor tolkas', () => {
    expect(() => sweep.parseArgs(['--vad'])).toThrow(/Okänd flagga: --vad/);
    const { files, opts } = sweep.parseArgs(['a.jsonl', '--offsets=-5', '--id=x', '--keep-temp']);
    expect(files).toEqual(['a.jsonl']);
    expect(opts.offsetsS).toBe('-5');
    expect(opts.id).toBe('x');
    expect(opts.keepTemp).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * CLI-vägarna som INTE kör en replay: de faller på argumenten eller skriver
 * bara hjälptexten, så de är snabba och beroende av ingenting utanför repot.
 */
describe('CLI — exitkoder utan replay', () => {
  function run(args, env) {
    try {
      const stdout = execFileSync('node', [SCRIPT, ...args], {
        encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out: stdout };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  }

  test('--help ger exitkod 0 och nämner OMÄTT-vägen', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/omätt/i);
  }, 30000);

  test('en undantagsfil utan motivering ger ANROPSFEL (2), inte ett tyst grönt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fassvep-cli-'));
    try {
      const p = path.join(dir, 'undantag.json');
      fs.writeFileSync(p, JSON.stringify({ prov: { notiser: [{ utfall: '*', datum: '2026-08-21' }] } }));
      const korpus = path.join(__dirname, 'replay-validation', 'corpora-data', 'ais-replay-20260611-115443.jsonl');
      const r = run([`--exceptions=${p}`, '--offsets=-5', korpus]);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/motivering/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('okänd flagga ger ANROPSFEL (2) med användningen utskriven', () => {
    const r = run(['--jaha']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Okänd flagga: --jaha/);
  }, 30000);
});
