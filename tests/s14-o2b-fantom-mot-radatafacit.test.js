'use strict';

/**
 * S14 (systerställesrundan 2026-08-23) — O2b: FANTOMTAKET MOT RÅDATAFACIT.
 *
 * O2 matchade varje öppningsvarning mot APPENS EGNA passager (target ∪
 * intermediate) och hade ingen parallell rådataserie, till skillnad från O1b,
 * H-4 och H-4b som alla läser gt-passages. Blindfläcken satt alltså inne i den
 * grind som äger exitkoden för röda fantomer: en varning som appen själv
 * bokfört som passage kallades BEKRÄFTAD även när rådatafacit inte känner
 * någon korsning.
 *
 * Testerna kör grindens EGNA exporterade pipeline (analysePhantoms och
 * O2b-rapporten reportGtPhantoms) — samma funktioner som `npm run
 * replay:openings` anropar, inte en kopia av logiken.
 *
 * Asserterar åt BÅDA hållen: att facitserien fångar det appserien missar OCH
 * att appserien är oförändrad när inget facit skickas in (O2 ska vara
 * byte-identisk), samt att `inferred`-poster ALDRIG bär hinkindelningen.
 */

const {
  analysePhantoms,
  reportGtPhantoms,
  PHANTOM_WINDOW_MS,
} = require('./replay-validation/runOpeningGates');
const { BRIDGES } = require('../lib/constants');

const KLAFF = BRIDGES.klaffbron;
const T0 = Date.UTC(2026, 7, 3, 10, 0, 0);
const M_PER_DEG_LAT = 111320;
const MMSI = '265000111';

/** Sampel `meters` söder om Klaffbron vid tiden t (samma format som korpusarnas jsonl). */
function southOf(meters, t, sog = 4.5) {
  return {
    mmsi: MMSI, lat: KLAFF.lat - meters / M_PER_DEG_LAT, lon: KLAFF.lon, sog, aisTimestamp: t,
  };
}

/** En bevisad anflygning: 20 fix som närmar sig bron i 4,5 kn. */
function movingSamples() {
  const list = [];
  for (let i = 20; i >= 1; i--) list.push(southOf(120 * i, T0 - i * 60000));
  return new Map([[MMSI, list]]);
}

function warning(t = T0, overrides = {}) {
  return {
    t,
    iso: new Date(t).toISOString(),
    bridge: 'Klaffbron',
    direction: 'northbound',
    etaMin: 5,
    vesselCount: 1,
    leadVessel: 'TESTBÅT',
    leadMmsi: MMSI,
    mmsis: [MMSI],
    firedBy: 'deadline',
    eventId: 'Klaffbron#1',
    distance: 900,
    success: true,
    ...overrides,
  };
}

/** Appens egen passagebokföring. */
function appPassage(t, overrides = {}) {
  return {
    mmsi: MMSI, bridge: 'Klaffbron', t, iso: new Date(t).toISOString(), ...overrides,
  };
}

/** En post ur rådatafacit (gtTargetPassages-formen). */
function gtPassage(t, overrides = {}) {
  return {
    t,
    iso: new Date(t).toISOString(),
    mmsi: MMSI,
    bridge: 'Klaffbron',
    inferred: false,
    tFrom: null,
    tTo: null,
    source: 'gt',
    ...overrides,
  };
}

function resultWith(passages = [], intermediate = []) {
  return {
    openingWarnings: [warning()],
    targetPassages: passages,
    intermediatePassages: intermediate,
    openingCoverage: [],
  };
}

describe('S14 O2b: fantomanalysen kan köras mot rådatafacit', () => {
  test('appserien säger BEKRÄFTAD, rådataserien säger FANTOM — blindfläcken', () => {
    // Appen bokförde en passage 10 min efter varningen; rådatafacit känner
    // ingen korsning alls. HEAD kallade detta BEKRÄFTAD i BÅDA fallen.
    const res = resultWith([appPassage(T0 + 10 * 60000)]);
    const s = movingSamples();

    const app = analysePhantoms(res, s);
    expect(app.confirmed).toBe(1);
    expect(app.phantoms).toHaveLength(0);

    const gt = analysePhantoms(res, s, []);
    expect(gt.confirmed).toBe(0);
    expect(gt.phantoms).toHaveLength(1);
    expect(gt.byWarning[0].hink).toBe('FANTOM');
  });

  test('facitets passage räknas även när appen aldrig bokförde den', () => {
    // Motsatt håll: appen missade korsningen (källtystnadens fyndklass), men
    // rådatan har den — då är varningen BEKRÄFTAD i rådataserien.
    const res = resultWith([]);
    const gt = analysePhantoms(res, movingSamples(), [gtPassage(T0 + 6 * 60000)]);
    expect(gt.confirmed).toBe(1);
    expect(gt.phantoms).toHaveLength(0);
    expect(gt.inferredTime).toHaveLength(0);
  });

  test('INTERMEDIATE-bokförd målbrokorsning förblir en passage i facitserien', () => {
    // INV-13:s klass: appen bokförde målbrokorsningen som intermediate.
    // Facitserien innehåller bara MÅLBROAR, så korsningen finns där oavsett
    // hur appen bokförde den — designenliga förlopp får inte bli fantomer.
    const res = resultWith([], [appPassage(T0 + 5 * 60000)]);
    const gt = analysePhantoms(res, movingSamples(), [gtPassage(T0 + 5 * 60000)]);
    expect(gt.confirmed).toBe(1);
    expect(gt.phantoms).toHaveLength(0);
  });

  test('`inferred`-post bär ALDRIG hinkindelningen — egen hink INFERRERAD_TID', () => {
    // Korsningen är bevisad men tidpunkten är bara ett fönster; hinkarna ÄR
    // en tidsfönstermätning (20 min / 120 min) och kan inte avgöras.
    const res = resultWith([]);
    const gt = analysePhantoms(res, movingSamples(), [
      gtPassage(T0 + 5 * 60000, { inferred: true, tFrom: T0 + 60000, tTo: T0 + 40 * 60000 }),
    ]);
    expect(gt.confirmed).toBe(0);
    expect(gt.latePassages).toHaveLength(0);
    expect(gt.phantoms).toHaveLength(0);
    expect(gt.inferredTime).toHaveLength(1);
    expect(gt.byWarning[0].hink).toBe('INFERRERAD_TID');
  });

  test('inferrerat fönster FÖRE den säkra passagen gör hinken omätbar', () => {
    // Den säkra passagen ligger 45 min bort (SEN_PASSAGE), men en inferrerad
    // korsning kan ha skett inom kontraktsfönstret. Ordningen är okänd ⇒
    // varningen får ingen hink i stället för en gissad.
    const res = resultWith([]);
    const gt = analysePhantoms(res, movingSamples(), [
      gtPassage(T0 + 10 * 60000, { inferred: true, tFrom: T0 + 2 * 60000, tTo: T0 + 18 * 60000 }),
      gtPassage(T0 + 45 * 60000),
    ]);
    expect(gt.inferredTime).toHaveLength(1);
    expect(gt.latePassages).toHaveLength(0);
    expect(gt.confirmed).toBe(0);
  });

  test('inferrerad post EFTER den säkra passagen stör inte hinken', () => {
    // Motprovet mot testet ovan: kan den inferrerade posten omöjligt ha varit
    // först, ska den säkra passagen avgöra hinken som vanligt.
    const res = resultWith([]);
    const gt = analysePhantoms(res, movingSamples(), [
      gtPassage(T0 + 8 * 60000),
      gtPassage(T0 + 90 * 60000, { inferred: true, tFrom: T0 + 80 * 60000, tTo: T0 + 100 * 60000 }),
    ]);
    expect(gt.confirmed).toBe(1);
    expect(gt.inferredTime).toHaveLength(0);
  });

  test('inferrerad korsning EFTER hela mätfönstret göms inte som omätbar', () => {
    // Fönstret börjar långt efter de 120 min hinkarna sträcker sig över —
    // korsningen kan omöjligt ha avgjort någon hink, så varningen ska klassas
    // som fantom i stället för att döljas i INFERRERAD_TID.
    const res = resultWith([]);
    const gt = analysePhantoms(res, movingSamples(), [
      gtPassage(T0 + 300 * 60000, { inferred: true, tFrom: T0 + 280 * 60000, tTo: T0 + 320 * 60000 }),
    ]);
    expect(gt.inferredTime).toHaveLength(0);
    expect(gt.phantoms).toHaveLength(1);
  });

  test('O2 (appserien) är oförändrad när inget facit skickas in', () => {
    // Grinden ligger kvar på appserien i den här etappen: samma hinkar, samma
    // klasser, samma antal som före S14.
    const s = movingSamples();
    expect(analysePhantoms(resultWith([appPassage(T0 + 10 * 60000)]), s).confirmed).toBe(1);
    const late = analysePhantoms(resultWith([appPassage(T0 + 45 * 60000)]), s);
    expect(late.confirmed).toBe(0);
    expect(late.latePassages).toHaveLength(1);
    expect(late.latePassages[0].delayMs).toBe(45 * 60000);
    const phantom = analysePhantoms(resultWith([]), s);
    expect(phantom.phantoms).toHaveLength(1);
    expect(phantom.phantoms[0].klass).toBe('AVBRUTEN_APPROACH');
    // Appens passager har ingen `inferred`-flagga ⇒ hinken är alltid mätbar.
    expect(phantom.inferredTime).toHaveLength(0);
    expect(PHANTOM_WINDOW_MS).toBe(20 * 60 * 1000);
  });
});

describe('S14 O2b-rapporten: egen rubrik bredvid O2, utan makt över exitkoden', () => {
  /** Kör rapporten på ett syntetiskt runs-fält och fånga utskriften. */
  function runReport(runs) {
    const lines = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit anropades av O2b');
    });
    try {
      reportGtPhantoms(runs);
    } finally {
      spy.mockRestore();
      exitSpy.mockRestore();
    }
    return lines.join('\n');
  }

  test('rubriken, hinkbytet och den informativa markeringen skrivs ut', () => {
    const res = resultWith([appPassage(T0 + 10 * 60000)]);
    const app = analysePhantoms(res, movingSamples());
    const out = runReport([{
      job: { id: 'testkorpus', locked: true },
      result: res,
      analysis: { samples: movingSamples() },
      gtPassages: [],
      o2App: app,
    }]);
    expect(out).toMatch(/O2b: FANTOMTAK MOT RÅDATAFACIT/);
    // Appserien sade BEKRÄFTAD, rådataserien FANTOM — bytet ska synas, och
    // det ska pekas ut som det farliga hållet.
    expect(out).toMatch(/HINKBYTEN mot O2 \(appserien\): 1 av 1 varningar/);
    expect(out).toMatch(/BEKRÄFTAD→FANTOM=1/);
    expect(out).toMatch(/FARLIGT HÅLL testkorpus/);
    expect(out).toMatch(/INFORMATIV: O2b ändrar INTE exitkoden/);
  });

  test('BEKRÄFTAD→INFERRERAD_TID är ett OMÄTBART byte, inte ett farligt', () => {
    // Korsningen är bevisad i rådatan, bara tidpunkten är ett fönster. Räknas
    // den som farlig drunknar det enda äkta motsägande fallet i falsklarm.
    const res = resultWith([appPassage(T0 + 10 * 60000)]);
    const app = analysePhantoms(res, movingSamples());
    const out = runReport([{
      job: { id: 'testkorpus', locked: true },
      result: res,
      analysis: { samples: movingSamples() },
      gtPassages: [
        gtPassage(T0 + 9 * 60000, { inferred: true, tFrom: T0 + 60000, tTo: T0 + 30 * 60000 }),
      ],
      o2App: app,
    }]);
    expect(out).toMatch(/BEKRÄFTAD→INFERRERAD_TID=1/);
    expect(out).not.toMatch(/FARLIGT HÅLL/);
    expect(out).toMatch(/1 utan mätbar hink/);
  });

  test('körningar utan rådatafacit hoppas över i stället för att fälla något', () => {
    const out = runReport([{
      job: { id: 'utan-facit' }, result: resultWith([]), analysis: { samples: new Map() }, gtPassages: null,
    }]);
    expect(out).toMatch(/RÅDATAFACIT SAKNAS/);
    expect(out).not.toMatch(/O2b: FANTOMTAK/);
  });
});
