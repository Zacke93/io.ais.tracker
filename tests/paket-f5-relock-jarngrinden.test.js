'use strict';

/**
 * PAKET F5 (WS3, 2026-08-10) — vakt för relockGoldenText:s JÄRNGRIND.
 *
 * FYNDET: verktyget som SKRIVER golden-text-facit hade en svagare grind än
 * runAllCorpora. Det kontrollerade notis-, fördelnings-, riktnings- och
 * öppningsmultiset — men INTE processfel, INTE fartygsläckage och INTE de
 * FATALA invarianterna. Dessutom gjorde `distribution[distKey] || {}` en
 * korpus UTAN fördelningspost tyst godkänd så snart den råkade ge noll
 * notiser (R2-1-hålet, återinfört i just det verktyg som skriver facit).
 * Konsekvens: ett kompenserande fel (miss + fantom) eller en krasch i
 * notisvägen kunde passera, och verktyget skrev då om golden-filen — dvs.
 * raderade den ENDA kvarvarande signalen om regressionen.
 *
 * METOD: testet kör det RIKTIGA verktyget som barnprocess med en preload som
 *   (a) mockar child_process.execFileSync så replayRunner ALDRIG körs — i
 *       stället returneras ett syntetiskt resultat som testet muterar, och
 *   (b) blockerar fs.writeFileSync och loggar "WROTE:<sökväg>" i stället.
 * Inget facit och ingen korpusfil rörs; preloaden ligger i os.tmpdir().
 * Basen är den LÅSTA korpusen 20260610-förfix (0 notiser, 0 öppningar,
 * 1 textövergång) — dess facitposter finns i repot, så det syntetiska
 * resultatet passerar alla grindar utan att någon replay behöver köras.
 *
 * VARJE test har formen: mutation ⇒ exit 1 OCH noll skrivningar. Grinden
 * måste alltså både FÄLLA och göra det INNAN facit rörs.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RV = path.join(ROOT, 'tests/replay-validation');
const TOOL = path.join(RV, 'relockGoldenText.js');
const CORPUS = '20260610-förfix';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-relock-'));

// Preloaden skrivs till en temporär katalog — ALDRIG i repot (järnregeln om
// manipulerat facit: inga muterade korpus-/facitkopior får bo i trädet).
const PRELOAD = path.join(TMP, 'preload.js');
fs.writeFileSync(PRELOAD, `
const fs = require('fs');
const cp = require('child_process');
const p = require('path');
const Module = require('module');
const CFG = JSON.parse(fs.readFileSync(process.env.F5_CFG, 'utf8'));

// Facitpost-bortfall: matchas på FILNAMN, inte full sökväg (OneDrive ger
// NFC/NFD-varianter av sökvägen som blir SKILDA require-cachenycklar).
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const m = realLoad.call(this, request, parent, isMain);
  const base = typeof request === 'string' ? p.basename(request) : '';
  if (CFG.drop && base === CFG.drop && m && Object.prototype.hasOwnProperty.call(m, CFG.corpusId)) {
    delete m[CFG.corpusId];
  }
  if (CFG.knownExceptions && (base === 'corpora' || base === 'corpora.js') && Array.isArray(m)) {
    const c = m.find((x) => x.id === CFG.corpusId);
    if (c) c.knownInvariantExceptions = CFG.knownExceptions;
  }
  return m;
};

let call = 0;
const realExec = cp.execFileSync;
cp.execFileSync = function (file, args, opts) {
  if (Array.isArray(args) && args.some((a) => String(a).includes('replayRunner.js'))) {
    const r = CFG.results[Math.min(call, CFG.results.length - 1)];
    call += 1;
    return '__REPLAY_JSON__' + JSON.stringify(r) + '__END__\\n';
  }
  return realExec.call(this, file, args, opts);
};

fs.writeFileSync = function (path_) { console.log('WROTE:' + path_); };
`);

const goldenTransitions = JSON.parse(
  fs.readFileSync(path.join(RV, 'golden-text', `${CORPUS}.json`), 'utf8'),
);

/** Syntetiskt replay-resultat som passerar SAMTLIGA grindar. */
function baseResult() {
  return {
    processErrors: 0,
    leakDiagnostics: { vessels: 0 },
    notificationCount: 0,
    notifications: [],
    openingWarnings: [],
    bridgeTextTransitions: JSON.parse(JSON.stringify(goldenTransitions)),
  };
}

/**
 * Kör verktyget i torrläge.
 * @returns {{status:number, writes:string[], out:string}}
 */
function runTool(cfg, targets = [CORPUS]) {
  const cfgPath = path.join(TMP, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({
    corpusId: CORPUS, drop: null, knownExceptions: null, ...cfg,
  }));
  let status = 0;
  let out = '';
  try {
    out = execFileSync('node', ['-r', PRELOAD, TOOL, ...targets], {
      encoding: 'utf8', env: { ...process.env, F5_CFG: cfgPath }, timeout: 60000,
    });
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : 1;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const writes = out.split('\n').filter((l) => l.startsWith('WROTE:'));
  return { status, writes, out };
}

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // städning är best effort — en kvarlämnad temp-katalog får inte fälla sviten
  }
});

describe('F5: relockGoldenText:s järngrind (baslinje)', () => {
  test('ett rent resultat passerar och skriver PRECIS en golden', () => {
    const r = runTool({ results: [baseResult()] });
    expect(r.status).toBe(0);
    expect(r.writes).toHaveLength(1);
    // Windows-portabilitet (2026-08-10): WROTE-raden bär en path.join-byggd
    // sökväg — backslash på Windows. Normalisera före substring-jämförelsen.
    expect(r.writes[0].replace(/\\/g, '/')).toContain(`golden-text/${CORPUS}.json`);
  }, 30000);
});

describe('F5: grinden fäller det runAllCorpora fäller på', () => {
  test('processfel > 0 ⇒ ABORT utan skrivning', () => {
    const res = baseResult();
    res.processErrors = 3;
    const r = runTool({ results: [res] });
    expect(r.status).toBe(1);
    expect(r.writes).toHaveLength(0);
    expect(r.out).toMatch(/processfel/);
  }, 30000);

  test('fartyg kvar efter efterspel ⇒ ABORT utan skrivning', () => {
    const res = baseResult();
    res.leakDiagnostics.vessels = 2;
    const r = runTool({ results: [res] });
    expect(r.status).toBe(1);
    expect(r.writes).toHaveLength(0);
    expect(r.out).toMatch(/fartyg kvar efter efterspel/);
  }, 30000);

  test('leakDiagnostics.vessels SAKNAS ⇒ ABORT (undefined får inte tolkas som grönt)', () => {
    const res = baseResult();
    delete res.leakDiagnostics.vessels;
    const r = runTool({ results: [res] });
    expect(r.status).toBe(1);
    expect(r.writes).toHaveLength(0);
  }, 30000);

  test('notisantal ≠ facit ⇒ ABORT utan skrivning', () => {
    const res = baseResult();
    res.notificationCount = 1;
    const r = runTool({ results: [res] });
    expect(r.status).toBe(1);
    expect(r.writes).toHaveLength(0);
    expect(r.out).toMatch(/notiser 1 ≠ 0/);
  }, 30000);
});

describe('F5: FATALA invarianter fäller innan golden skrivs', () => {
  // KÄRNSCENARIOT: texten är trasig men INGA notiser/öppningar rörs ⇒ alla
  // multiset står stilla. Före härdningen skrev verktyget om golden här.
  test('trasig bridge_text ⇒ ABORT, och utslaget skrivs ut', () => {
    const res = baseResult();
    res.bridgeTextTransitions.unshift({
      iso: '2026-06-09T21:00:00.000Z',
      text: 'Nio båtar undefined vid Klaffbron',
    });
    const r = runTool({ results: [res] });
    expect(r.status).toBe(1);
    expect(r.writes).toHaveLength(0);
    expect(r.out).toMatch(/FATALA invariantbrott/);
    expect(r.out).toMatch(/TRASIG TEXT: 2026-06-09T21:00:00\.000Z/);
  }, 30000);

  test('samma utslag SLÄPPS IGENOM om korpusen bär det som knownInvariantException', () => {
    const res = baseResult();
    res.bridgeTextTransitions.unshift({
      iso: '2026-06-09T21:00:00.000Z',
      text: 'Nio båtar undefined vid Klaffbron',
    });
    const r = runTool({
      results: [res],
      knownExceptions: ['TRASIG TEXT: 2026-06-09T21:00:00.000Z'],
    });
    expect(r.status).toBe(0);
    expect(r.writes).toHaveLength(1);
    expect(r.out).toMatch(/KÄNDA invariantutslag/);
  }, 30000);
});

describe('F5: saknad facitpost är HÅRT fel, inte tyst överhoppad gate', () => {
  // R2-1-hålet: med 0 notiser blev `distribution[distKey] || {}` en TOM
  // förväntan som matchade det tomma utfallet — gaten "passerade" utan att
  // finnas. Samma sak för riktnings- och öppningsposten.
  test.each([
    ['fördelningspost', 'corpora-distribution.json', /FÖRDELNINGSPOST SAKNAS/],
    ['riktningspost', 'corpora-direction-distribution.json', /RIKTNINGSPOST SAKNAS/],
    ['öppningspost', 'opening-distribution.json', /ÖPPNINGSPOST SAKNAS/],
  ])('%s saknas ⇒ ABORT utan skrivning', (_namn, fil, re) => {
    const r = runTool({ results: [baseResult()], drop: fil });
    expect(r.status).toBe(1);
    expect(r.writes).toHaveLength(0);
    expect(r.out).toMatch(re);
  }, 30000);
});

describe('F5: skrivningen är ATOMISK över flera mål', () => {
  test('mål 1 grönt + mål 2 fällt ⇒ INGEN fil skrivs', () => {
    const bad = baseResult();
    bad.processErrors = 1;
    const r = runTool({ results: [baseResult(), bad] }, [CORPUS, CORPUS]);
    expect(r.status).toBe(1);
    expect(r.writes).toHaveLength(0);
  }, 30000);
});

describe('F5: grinden får inte glida isär från runAllCorpora', () => {
  // Källsvep (samma mönster som harness-vakter.test.js): båda filerna måste
  // läsa SAMMA fält. Byter runAllCorpora fält utan att verktyget följer med
  // blir verktygets grind tyst svagare igen — precis det fyndet handlade om.
  const toolSrc = fs.readFileSync(TOOL, 'utf8');
  const gateSrc = fs.readFileSync(path.join(RV, 'runAllCorpora.js'), 'utf8');

  test.each([
    ['result.processErrors', /result\.processErrors \|\| 0/],
    ['leakDiagnostics.vessels', /leaks\.vessels/],
    ['validateInvariants', /validateInvariants\(result\)/],
    ['knownInvariantExceptions', /corpus\.knownInvariantExceptions/],
  ])('%s läses av BÅDA', (_namn, re) => {
    expect(gateSrc).toMatch(re);
    expect(toolSrc).toMatch(re);
  });
});
