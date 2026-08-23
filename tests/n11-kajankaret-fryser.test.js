'use strict';

jest.mock('homey');

/**
 * N11 (helkodsgranskning RUNDA 5, 2026-08-23) — DET PERSISTERADE KAJANKARET
 * VAR FRYST OCH KUNDE PEKA PÅ FEL KAJ.
 *
 * MEKANISMEN FÖRE FIXEN: _loadOpeningQuayLedger återställde ankaret (lat/lon)
 * OCH rörelseflaggan (`moving: e.moving !== false`). I _noteQuayLedgerEntry
 * flyttas ankaret bara när `entry.moving` är sant ELLER ankaret är inaktuellt
 * (`stillAt` äldre än minnesfönstret) — och stillAt förnyas av VARJE
 * stillasample, så inaktualitet kan aldrig inträffa för en båt som ligger
 * still. En post som laddas i läge "stilla" fryser därför ankaret på FÖRRA
 * kajen hur länge som helst. En levande session kan inte hamna där:
 * mellanliggande transitfixar sätter moving och ankrar om.
 *
 * SKADAN ÄR TVÅSIDIG, och båda sidorna reproduceras nedan genom
 * produktionsmetoderna (_noteQuayStability → _noteQuayLedgerEntry →
 * _isBridgeOpeningQuayWobbler):
 *   (a) FALSK ÖPPNINGSVARNING. Kaj 459 m söder om Klaffbron vid nedstängning,
 *       ny kaj 120 m norr om bron efter 40 min nedtid ⇒ frysta ankaret ger
 *       netto-närmande +339 m ⇒ grinden svarar FALSKT ⇒ beväpning tillåts för
 *       en båt som bara ligger vid kaj.
 *   (b) BLOCKERAD ÄKTA AVGÅNG. Samma frysta ankare åt andra hållet ⇒ en äkta
 *       anflygning från 420 m får netto 39 m (under NET_APPROACH_M) och kan
 *       inte heller falla tillbaka på rörelsebenet, som kräver OKÄNT netto.
 *
 * FIXEN: klockorna (stillAt/bandSince) återställs som förut — de är M11:s hela
 * vinst — men GEOMETRIN ogiltigförklaras (lat/lon = null, moving = true). Då
 * blir netto-benet OKÄNT i stället för falskt, rörelsebenet tar över, och
 * första stillasamplet ankrar om på den VERKLIGA positionen.
 *
 * KONTROLLARMEN nedan återställer geometrin efter laddningen — dvs. exakt
 * HEAD:s beteende — och är i övrigt bit för bit identisk. Utfallsskillnaden
 * kan alltså bara komma från de raderna.
 *
 * MUTATIONSPROV (körs manuellt): sätt tillbaka `lat: Number.isFinite(e.lat) ?
 * e.lat : null` + `moving: e.moving !== false` i _loadOpeningQuayLedger ⇒ båda
 * FIXEN-testerna nedan blir röda (och kontrollarmarna gröna).
 */

const AISBridgeApp = require('../app');
const {
  BRIDGES, BRIDGE_OPENING, QUAY_DEPARTURE_GATE,
} = require('../lib/constants');

const KLAFFBRON = Object.values(BRIDGES).find((b) => b && b.name === 'Klaffbron');
const REAL_DATE_NOW = Date.now;

const north = (m) => ({ lat: KLAFFBRON.lat + m / 111320, lon: KLAFFBRON.lon });
const south = (m) => ({ lat: KLAFFBRON.lat - m / 111320, lon: KLAFFBRON.lon });

const QUAY_SOUTH = south(459); // kajen hon låg vid när appen stängdes ned
const QUAY_NORTH = north(120); // kajen hon ligger vid när appen kommer upp igen
const APPROACH_420 = south(420); // äkta anflygning, 420 m från bron

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeSettingsStore() {
  const store = new Map();
  return {
    store,
    settings: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => store.set(k, JSON.parse(JSON.stringify(v))),
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
  mmsi: '265444222',
  lat: pos.lat,
  lon: pos.lon,
  sog,
  cog: 20.0,
  timestamp: ts,
  fixTs: ts,
  fixFeed: 'aisstream',
  targetBridge: 'Klaffbron',
});

/** HEAD:s laddning: geometrin och rörelseflaggan tas tillbaka ur blobben. */
function restoreGeometryLikeHead(app, mmsi) {
  const stored = app.homey.settings.get('opening_quay_ledger')[mmsi];
  const entry = app._openingQuayLedger.get(mmsi);
  entry.lat = stored.lat;
  entry.lon = stored.lon;
  entry.moving = stored.moving !== false;
}

describe('N11: ankaret får inte bäras över en omstart', () => {
  let now;

  beforeEach(() => {
    jest.clearAllMocks();
    now = new Date(2026, 7, 5, 2, 0, 0).getTime();
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  /** 60 min kajvistelse vid södra kajen, genom produktionens egen bokföring. */
  const stayAtSouthQuay = (settings) => {
    const app = makeApp(settings);
    for (let i = 0; i < 12; i++) {
      app._noteQuayStability(sample(QUAY_SOUTH, 0.2, now));
      now += 5 * 60 * 1000;
    }
    app._persistQuayLedger(true); // onUninit-flushen
    return app;
  };

  test('LADDNINGEN: klockorna överlever, geometrin ogiltigförklaras', () => {
    const { settings, store } = makeSettingsStore();
    stayAtSouthQuay(settings);
    const persisted = store.get('opening_quay_ledger')['265444222'];
    expect(persisted.lat).toBeCloseTo(QUAY_SOUTH.lat, 6); // blobben bär den ändå (diagnostik)

    now += 40 * 60 * 1000; // nedtid
    const restarted = makeApp(settings);
    restarted._loadOpeningQuayLedger();
    const entry = restarted._openingQuayLedger.get('265444222');

    expect(entry.lat).toBeNull();
    expect(entry.lon).toBeNull();
    expect(entry.moving).toBe(true);
    // M11:s vinst är orörd: vistelseklockan lever.
    expect(Date.now() - entry.bandSince).toBeGreaterThan(BRIDGE_OPENING.QUAY_STAY_MIN_MS);
    expect(entry.stillAt).toBeGreaterThan(0);
  });

  test('(a) FIXEN: ny kaj 120 m NORR ⇒ grinden blockerar som kontrollen', () => {
    const { settings } = makeSettingsStore();
    stayAtSouthQuay(settings);
    now += 40 * 60 * 1000;

    const app = makeApp(settings);
    app._loadOpeningQuayLedger();
    let wobbler = null;
    for (const sog of [0.2, 0.3, 0.4]) {
      now += 60 * 1000;
      const msg = sample(QUAY_NORTH, sog, now);
      app._noteQuayStability(msg);
      wobbler = app._isBridgeOpeningQuayWobbler(msg);
    }
    expect(wobbler).toBe(true); // obekräftad kajavgång ⇒ ingen beväpning

    // Ankaret ligger på den VERKLIGA kajen efter första stillasamplet.
    const entry = app._openingQuayLedger.get('265444222');
    expect(entry.lat).toBeCloseTo(QUAY_NORTH.lat, 6);
  });

  test('(a) KONTROLLEN (HEAD): frysta ankaret ⇒ FALSK öppningsvarning tillåts', () => {
    const { settings } = makeSettingsStore();
    stayAtSouthQuay(settings);
    now += 40 * 60 * 1000;

    const app = makeApp(settings);
    app._loadOpeningQuayLedger();
    restoreGeometryLikeHead(app, '265444222');
    let wobbler = null;
    for (const sog of [0.2, 0.3, 0.4]) {
      now += 60 * 1000;
      const msg = sample(QUAY_NORTH, sog, now);
      app._noteQuayStability(msg);
      wobbler = app._isBridgeOpeningQuayWobbler(msg);
    }
    expect(wobbler).toBe(false); // exakt defekten: beväpning 120 m från bron
    expect(app._openingQuayLedger.get('265444222').lat).toBeCloseTo(QUAY_SOUTH.lat, 6);
  });

  test('(a) REFERENSEN: utan persisterad post blockerar grinden efter 5 min', () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      app._noteQuayStability(sample(QUAY_NORTH, 0.2, now));
      now += 60 * 1000;
    }
    const msg = sample(QUAY_NORTH, 0.4, now);
    app._noteQuayStability(msg);
    expect(app._isBridgeOpeningQuayWobbler(msg)).toBe(true);
  });

  test('(b) FIXEN: äkta anflygning släpps igenom på rörelsebenet', () => {
    const { settings } = makeSettingsStore();
    stayAtSouthQuay(settings);
    now += 40 * 60 * 1000;

    const app = makeApp(settings);
    app._loadOpeningQuayLedger();
    let wobbler = null;
    for (let i = 0; i < 2; i++) { // två på varandra följande rörelsefixar
      now += 70 * 1000;
      const msg = sample(APPROACH_420, 3.0, now);
      app._noteQuayStability(msg);
      wobbler = app._isBridgeOpeningQuayWobbler(msg);
    }
    expect(wobbler).toBe(false); // netto OKÄNT ⇒ rörelsebenet bär beviset
  });

  test('(b) KONTROLLEN (HEAD): samma anflygning blockeras av frysta ankaret', () => {
    const { settings } = makeSettingsStore();
    stayAtSouthQuay(settings);
    now += 40 * 60 * 1000;

    const app = makeApp(settings);
    app._loadOpeningQuayLedger();
    restoreGeometryLikeHead(app, '265444222');
    let wobbler = null;
    for (let i = 0; i < 2; i++) {
      now += 70 * 1000;
      const msg = sample(APPROACH_420, 3.0, now);
      app._noteQuayStability(msg);
      wobbler = app._isBridgeOpeningQuayWobbler(msg);
    }
    // 459 − 420 = 39 m < NET_APPROACH_M (40) och nettot är KÄNT ⇒ båda benen
    // faller ⇒ hela den äkta avgången blockeras.
    expect(QUAY_DEPARTURE_GATE.NET_APPROACH_M).toBe(40);
    expect(wobbler).toBe(true);
  });
});
