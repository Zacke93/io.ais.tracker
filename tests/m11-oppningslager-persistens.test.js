'use strict';

jest.mock('homey');

/**
 * M11 (helkodsgranskning RUNDA 4, 2026-08-23) — ÖPPNINGSLAGRETS KAJVOBBELGRIND
 * VAR BLIND I FEM MINUTER EFTER OMSTART, OCH EFTER ETT ENDA FIX UTANFÖR BANDET.
 *
 * MEKANISMEN FÖRE FIXEN: _isBridgeOpeningQuayWobbler tillåter beväpning så
 * länge `stayMs` räknad från `entry.bandSince` understiger
 * BRIDGE_OPENING.QUAY_STAY_MIN_MS (5 min). `bandSince` sätts när POSTEN
 * skapas, och _openingQuayLedger byggdes tom i konstruktorn utan persistens —
 * en appomstart nollställde alltså en kajvistelse på timmar. Reproducerat:
 * fem AIS-meddelanden på identisk position 400 m från Klaffbron med sog-brus
 * 0,1–1,3 kn gav ett avfyrat Flow-kort ~1 min efter boot.
 *
 * STARKARE SYSTERSTÄLLE: _noteQuayStability raderade posten på ETT ENDA fix
 * utanför 500 m-bandet, vilket gav samma femminutersblindhet UTAN omstart
 * (mätt: 115 min vistelse till 0).
 *
 * FIXEN: (1) öppningslagret persisteras i settings-nyckeln
 * `opening_quay_ledger` under V1-kartans egen strypta skrivtakt, med tvingad
 * flush i onUninit; (2) bandgränsen har hysteres med TOLERANS EN (1) FIX —
 * nivån är QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES, projektets egen regel att ett
 * enstaka prov aldrig är bevis och två i följd är det.
 *
 * N11-TILLÄGGET (RUNDA 5, 2026-08-23): laddningen återställer KLOCKORNA men
 * ogiltigförklarar GEOMETRIN (lat/lon = null, moving = true). Ett återställt
 * ankare kunde aldrig bytas ut medan båten låg still och frös därför på förra
 * kajen. Omstartstestet nedan är oförändrat — vinsten (bandSince) sitter i
 * klockan, inte i koordinaterna.
 *
 * N13-TILLÄGGET (RUNDA 5): TTL:n mäts på en DELAD hjälpare
 * (_openingLedgerTtlClock) i persist, load OCH prune. Prunen läste tidigare
 * bara stillAt och raderade en post som ännu bara hunnit få bandSince — se
 * tests/n13-oppningslager-ttlklocka.test.js.
 *
 * MUTATIONSPROV (körs manuellt): ta bort `this._loadOpeningQuayLedger()` ur
 * konstruktorn ⇒ omstartsfallet nedan blir false (beväpning tillåten). Sänk
 * toleransen till 1 (`>= 1`) ⇒ enfixfallet blir false. Höj den till 3 ⇒
 * tvåfixfallet behåller posten.
 */

const AISBridgeApp = require('../app');
const {
  BRIDGES, BRIDGE_OPENING, QUAY_DEPARTURE_GATE,
} = require('../lib/constants');

const KLAFFBRON = Object.values(BRIDGES).find((b) => b && b.name === 'Klaffbron');
const REAL_DATE_NOW = Date.now;

// Kajläget ur CARAT-rådatan: 415 m från Klaffbron (inne i 500 m-bandet),
// 825 m från Stridsbergsbron och 2392 m från Kanalinfarten.
const QUAY = { lat: 58.28769, lon: 12.28584 };
// 699 m SÖDER om Klaffbron — utanför SAMTLIGA bokföringspunkters band
// (699 / 1383 / 1855 m). Enda vägen ut ur bandet som inte råkar hamna i
// Stridsbergsbrons.
const OUTSIDE = { lat: KLAFFBRON.lat - 699 / 111320, lon: KLAFFBRON.lon };

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeSettingsStore() {
  const store = new Map();
  let writes = 0;
  return {
    store,
    writes: () => writes,
    settings: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => {
        writes++;
        store.set(k, JSON.parse(JSON.stringify(v)));
      },
    },
  };
}

function makeApp(settings = null) {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app._quayStableLedger = new Map();
  app._openingQuayLedger = new Map();
  app._quayLedgerPersistedAt = 0;
  if (settings) app.homey = { settings };
  return app;
}

const sample = (pos, sog, ts) => ({
  mmsi: '211452170',
  lat: pos.lat,
  lon: pos.lon,
  sog,
  cog: 250.6,
  timestamp: ts,
  fixTs: ts,
  fixFeed: 'aishub',
  targetBridge: 'Klaffbron',
});

describe('M11 (a): omstart mitt i en kajvistelse', () => {
  let now;

  beforeEach(() => {
    jest.clearAllMocks();
    now = new Date(2026, 7, 5, 1, 0, 0).getTime();
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  /** 115 minuters kajvistelse genom produktionens egen bokföring. */
  const stay115min = (app) => {
    for (let i = 0; i < 24; i++) {
      app._noteQuayStability(sample(QUAY, 0.2, now));
      now += 5 * 60 * 1000; // 24 × 5 min ≈ 115 min in i vistelsen
    }
  };

  test('OMSTART: bandSince överlever ⇒ grinden håller direkt efter boot', () => {
    const { settings, store } = makeSettingsStore();
    const first = makeApp(settings);
    stay115min(first);
    first._persistQuayLedger(true); // onUninit-flushen
    expect(store.get('opening_quay_ledger')['211452170'].bandSince).toBeGreaterThan(0);

    // Ny process: tom karta, samma settings.
    const restarted = makeApp(settings);
    restarted._loadOpeningQuayLedger();
    const entry = restarted._openingQuayLedger.get('211452170');
    expect(entry).toBeTruthy();
    expect(Date.now() - entry.bandSince).toBeGreaterThan(BRIDGE_OPENING.QUAY_STAY_MIN_MS);

    // Repro: fem meddelanden på identisk position med sog-brus 0,1–1,3.
    let wobbler = null;
    for (const sog of [0.1, 0.4, 1.3, 0.2, 1.1]) {
      now += 12 * 1000;
      const msg = sample(QUAY, sog, now);
      restarted._noteQuayStability(msg);
      wobbler = restarted._isBridgeOpeningQuayWobbler(msg);
    }
    expect(wobbler).toBe(true); // obekräftad kajavgång ⇒ beväpna INTE
  });

  test('KONTROLLEN: utan den återställda posten är grinden blind i 5 min', () => {
    const { settings } = makeSettingsStore();
    const first = makeApp(settings);
    stay115min(first);
    first._persistQuayLedger(true);

    // Samma boot, men laddningen hoppas över = beteendet före M11.
    const blind = makeApp(settings);
    let wobbler = null;
    for (const sog of [0.1, 0.4, 1.3, 0.2, 1.1]) {
      now += 12 * 1000;
      const msg = sample(QUAY, sog, now);
      blind._noteQuayStability(msg);
      wobbler = blind._isBridgeOpeningQuayWobbler(msg);
    }
    expect(wobbler).toBe(false); // exakt defekten
  });

  test('TTL: en post äldre än minnesfönstret bärs inte över', () => {
    const { settings, store } = makeSettingsStore();
    store.set('opening_quay_ledger', {
      211452170: {
        bandSince: Date.now() - 5 * 60 * 60 * 1000,
        stillAt: Date.now() - QUAY_DEPARTURE_GATE.MEMORY_MS - 1000,
        lat: QUAY.lat,
        lon: QUAY.lon,
        moving: false,
      },
    });
    const app = makeApp(settings);
    app._loadOpeningQuayLedger();
    expect(app._openingQuayLedger.has('211452170')).toBe(false);
  });

  test('SESSIONSPÅSTÅENDEN ÅTERSTÄLLS INTE: movingFixes, prevFix, lastFix, GEOMETRIN', () => {
    const { settings, store } = makeSettingsStore();
    store.set('opening_quay_ledger', {
      211452170: {
        bandSince: Date.now() - 60 * 60 * 1000,
        stillAt: Date.now() - 60 * 1000,
        lat: QUAY.lat,
        lon: QUAY.lon,
        moving: false,
      },
    });
    const app = makeApp(settings);
    app._loadOpeningQuayLedger();
    const entry = app._openingQuayLedger.get('211452170');
    expect(entry.movingFixes).toBe(0);
    expect(entry.prevFix).toBeNull();
    expect(entry.lastFix).toBeNull();
    expect(entry.outOfBandFixes).toBe(0);
    // N11 (RUNDA 5): ankaret och rörelseflaggan hör till samma klass av
    // sessionspåståenden. Återställda gav de ett FRYST ankare — posten laddas
    // med moving=false, och _noteQuayLedgerEntry byter då aldrig ankare medan
    // hon ligger still, så det pekade på förra kajen hur länge som helst
    // (falsk ELLER blockerad öppningsvarning; se n11-kajankaret-fryser.test.js).
    // Klockorna är M11:s vinst och återställs oförändrat.
    expect(entry.lat).toBeNull();
    expect(entry.lon).toBeNull();
    expect(entry.moving).toBe(true);
    expect(entry.bandSince).toBeGreaterThan(0);
    expect(entry.stillAt).toBeGreaterThan(0);
  });

  test('SKRIVVÄGEN LEVER vid MÅLBRO: blobben skrivs trots att V1-vägen returnerar tidigt', () => {
    const { settings, store } = makeSettingsStore();
    const app = makeApp(settings);
    // Kajläget ligger 2392 m från Kanalinfarten ⇒ _noteQuayStability
    // returnerar innan V1-blocket. Utan den egna skrivningen hade
    // persistensen varit tyst död kod för exakt målbrofallet.
    app._noteQuayStability(sample(QUAY, 0.2, now));
    expect(store.has('opening_quay_ledger')).toBe(true);
    expect(store.get('opening_quay_ledger')['211452170'].bandSince).toBeGreaterThan(0);
  });
});

describe('M11 (b): hysteres vid bandgränsen', () => {
  let now;

  beforeEach(() => {
    jest.clearAllMocks();
    now = new Date(2026, 7, 5, 1, 0, 0).getTime();
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  const buildStay = (app, minutes) => {
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      app._noteQuayStability(sample(QUAY, 0.2, now));
      now += (minutes * 60 * 1000) / steps;
    }
    return app._openingQuayLedger.get('211452170').bandSince;
  };

  test('ETT fix utanför 500 m behåller posten OCH bandSince', () => {
    const app = makeApp();
    const bandSince = buildStay(app, 115);
    now += 60 * 1000;
    app._noteQuayStability(sample(OUTSIDE, 2.0, now));

    const entry = app._openingQuayLedger.get('211452170');
    expect(entry).toBeTruthy();
    expect(entry.bandSince).toBe(bandSince);
    expect(entry.outOfBandFixes).toBe(1);

    // Tillbaka i bandet: vistelsen är fortfarande 115+ min, grinden håller.
    now += 60 * 1000;
    const back = sample(QUAY, 1.3, now);
    app._noteQuayStability(back);
    expect(app._openingQuayLedger.get('211452170').bandSince).toBe(bandSince);
    expect(app._isBridgeOpeningQuayWobbler(back)).toBe(true);
  });

  test('TVÅ fix i följd utanför bandet raderar posten (bevisad avfärd)', () => {
    const app = makeApp();
    buildStay(app, 115);
    now += 60 * 1000;
    app._noteQuayStability(sample(OUTSIDE, 2.0, now));
    now += 60 * 1000;
    app._noteQuayStability(sample(OUTSIDE, 2.5, now));

    expect(app._openingQuayLedger.has('211452170')).toBe(false);
    expect(QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES).toBe(2);
  });

  test('RÄKNAREN NOLLAS av varje fix inne i bandet (konsekutivitet, inte summa)', () => {
    const app = makeApp();
    buildStay(app, 115);
    for (let i = 0; i < 4; i++) {
      now += 60 * 1000;
      app._noteQuayStability(sample(OUTSIDE, 2.0, now));
      now += 60 * 1000;
      app._noteQuayStability(sample(QUAY, 0.2, now));
    }
    const entry = app._openingQuayLedger.get('211452170');
    expect(entry).toBeTruthy();
    expect(entry.outOfBandFixes).toBe(0);
  });

  test('UTGÅNGEN HISTORIK släpps direkt vid bandgränsen (inget onödigt minne)', () => {
    const app = makeApp();
    buildStay(app, 10);
    now += QUAY_DEPARTURE_GATE.MEMORY_MS + 60 * 1000;
    app._noteQuayStability(sample(OUTSIDE, 2.0, now));
    expect(app._openingQuayLedger.has('211452170')).toBe(false);
  });
});
