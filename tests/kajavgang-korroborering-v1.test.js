'use strict';

const AISBridgeApp = require('../app');
const constants = require('../lib/constants');

const { TRIGGER_POINTS, QUAY_DEPARTURE_GATE } = constants;
const TP = TRIGGER_POINTS.kanalinfarten;

/**
 * V1 (A/B-natten 2026-08-03) — KAJAVGÅNGSKORROBORERINGEN.
 *
 * FYNDET: FP9-grenen (trigger-punkt, riktning nord/okänd) släppte notisen på
 * ETT momentant `sog >= 1.0`. Kring Kanalinfarten låg fem kajliggare PERMANENT
 * inne i 300 m-zonen (119/132/148/211/242 m). Nattens fantom var PRICKBJORN
 * 07:19:11: efter 9 h 41 min vid kaj gav AISHub sog EXAKT 1,0 och cog 128,7°
 * (östbandet ⇒ riktning 'unknown'), båten hade flyttat 3 m — notisen fyrade,
 * och därefter ökade avståndet monotont 119 → 143 → 179 → 297 → 387 → 401 m.
 * Sex loggrader före notisen skrev appen själv "quay wobble, blocking target
 * assignment"; de TRE nästföljande fixarna blockerades korrekt av FP8 (cog
 * hade då hunnit in i sydbandet). Fönstret där båda villkoren höll var ≤ 66 s
 * — glesa aisstream missade det, 2,7× tätare dubbelkälla träffade det.
 *
 * KRAVET: fartyg med FÄRSK kajstabil historik måste korroborera avgången
 * (två på varandra följande rörelsefixar ELLER netto-närmande mot punkten)
 * innan sog-benet får fyra. Fartyg i transit utan kajhistorik och fartyg med
 * målbro berörs INTE — annars faller facit (15 låsta korpusar innehåller 123
 * Kanalinfarten-notiser med riktningstoken).
 */

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeApp(overrides = {}) {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app._quayStableLedger = new Map();
  app.bridgeRegistry = { getBridgeByName: jest.fn(() => null) };
  Object.assign(app, overrides);
  return app;
}

const loggedWith = (fn, needle) => fn.mock.calls.some((c) => String(c[0]).includes(needle));
const proximityData = { bridges: [], nearestBridge: null };

// PRICKBJORN-geometrin: lotskajen ~121 m sydväst om Kanalinfarten-punkten.
// Söder om punkten ⇒ latituden ligger under tp.lat (kajzonen i rådatan).
const QUAY_LAT = 58.26786;
const QUAY_LON = 12.26735;

/** Position på angivet avstånd (m) rakt SÖDER om trigger-punkten. */
function southOfTp(distanceM) {
  return { lat: TP.lat - distanceM / 111320, lon: TP.lon };
}

describe('V1: kajavgång vid trigger-punkt kräver korroborering', () => {
  test('PRICKBJORN-fantomen: kajstabil båt + EN fix på sog exakt 1,0 → ingen kandidat', () => {
    const app = makeApp();
    // Stillasamplen vid kajen (navstatus 5 i rådatan, sog 0) bokförs.
    app._noteQuayStability({
      mmsi: '265012090', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
    });
    // Rörelsefixen: sog exakt på FP9-tröskeln, 3 m förflyttning, cog i
    // östbandet ⇒ _getDirectionString ger 'unknown' ⇒ FP9-grenen.
    const vessel = {
      mmsi: '265012090',
      lat: QUAY_LAT + 0.00002,
      lon: QUAY_LON + 0.00002,
      sog: 1.0,
      cog: 128.7,
      targetBridge: null,
    };
    app._noteQuayStability(vessel);
    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);

    expect(app._getDirectionString(vessel)).toBe('unknown');
    expect(candidates.some((c) => c.name === 'Kanalinfarten')).toBe(false);
    expect(loggedWith(app.log, 'TRIGGER_POINT_SKIP_QUAY')).toBe(true);
  });

  test('korroborering (a): andra rörelsefixen i rad släpper igenom kandidaten', () => {
    const app = makeApp();
    app._noteQuayStability({
      mmsi: '265012090', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
    });
    const first = {
      mmsi: '265012090', lat: QUAY_LAT + 0.00002, lon: QUAY_LON, sog: 1.0, cog: 128.7, targetBridge: null,
    };
    app._noteQuayStability(first);
    expect(app._getFlowTriggerCandidates(first, proximityData)
      .some((c) => c.name === 'Kanalinfarten')).toBe(false);

    // Andra rörelsefixen — fortfarande liten förflyttning, men nu TVÅ i rad.
    const second = { ...first, lat: QUAY_LAT + 0.00006 };
    app._noteQuayStability(second);
    expect(app._getFlowTriggerCandidates(second, proximityData)
      .some((c) => c.name === 'Kanalinfarten')).toBe(true);
  });

  test('korroborering (b): netto-närmande ≥ NET_APPROACH_M släpper igenom på FÖRSTA fixen', () => {
    const app = makeApp();
    const anchor = southOfTp(200);
    app._noteQuayStability({
      mmsi: '265999001', ...anchor, sog: 0, _moored: true,
    });
    // En pollcykel senare: 120 m närmare punkten (äkta insegling i ~4 knop).
    const moving = {
      mmsi: '265999001', ...southOfTp(80), sog: 4.2, cog: 30, targetBridge: null,
    };
    app._noteQuayStability(moving);
    const candidates = app._getFlowTriggerCandidates(moving, proximityData);
    expect(candidates.some((c) => c.name === 'Kanalinfarten')).toBe(true);
    expect(loggedWith(app.log, 'TRIGGER_POINT_SKIP_QUAY')).toBe(false);
  });

  test('ett stillasample NOLLSTÄLLER rörelseräknaren (kajvobbel kan inte samla på sig bevis)', () => {
    const app = makeApp();
    const vesselAt = (sog) => ({
      mmsi: '265012090', lat: QUAY_LAT, lon: QUAY_LON, sog, cog: 128.7, targetBridge: null,
    });
    app._noteQuayStability({ ...vesselAt(0), _moored: true });
    app._noteQuayStability(vesselAt(1.2)); // rörelsefix 1
    app._noteQuayStability(vesselAt(0.2)); // stillasample → nollställning
    const wobble = vesselAt(1.1); // rörelsefix 1 igen, inte 2
    app._noteQuayStability(wobble);
    expect(app._getFlowTriggerCandidates(wobble, proximityData)
      .some((c) => c.name === 'Kanalinfarten')).toBe(false);
  });

  test('transitör UTAN kajhistorik berörs inte (JUNO/TIM-klassen — facitkravet)', () => {
    const app = makeApp();
    const vessel = {
      mmsi: '219029305', ...southOfTp(140), sog: 7.3, cog: 31.6, targetBridge: null,
    };
    app._noteQuayStability(vessel); // första kontakt sker i fart
    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);
    expect(candidates.some((c) => c.name === 'Kanalinfarten')).toBe(true);
    expect(loggedWith(app.log, 'TRIGGER_POINT_SKIP_QUAY')).toBe(false);
  });

  test('kajhistorik äldre än MEMORY_MS prövas som förut (post-hål-klassen)', () => {
    const app = makeApp();
    app._quayStableLedger.set('265999002', {
      stillAt: Date.now() - (QUAY_DEPARTURE_GATE.MEMORY_MS + 60 * 1000),
      lat: QUAY_LAT,
      lon: QUAY_LON,
      movingFixes: 0,
    });
    const vessel = {
      mmsi: '265999002', ...southOfTp(150), sog: 5.6, cog: 33, targetBridge: null,
    };
    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);
    expect(candidates.some((c) => c.name === 'Kanalinfarten')).toBe(true);
  });

  test('målbro-benet är orört: kajstabil båt MED targetBridge får kandidaten', () => {
    // Målbrotilldelningen har egna förtöjnings-/rörelsebevis-/kajvobbelvakter
    // (de blockerade PRICKBJORN korrekt), så ett satt target ÄR korroborering.
    const app = makeApp();
    app._noteQuayStability({
      mmsi: '265999003', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
    });
    const vessel = {
      mmsi: '265999003', lat: QUAY_LAT, lon: QUAY_LON, sog: 0.4, cog: 20, targetBridge: 'Klaffbron',
    };
    app._noteQuayStability(vessel);
    expect(app._getFlowTriggerCandidates(vessel, proximityData)
      .some((c) => c.name === 'Kanalinfarten')).toBe(true);
  });

  test('sydgrenens FP8-gate är oförändrad (kajstart söderut utan kanalhistorik)', () => {
    const app = makeApp();
    app._noteQuayStability({
      mmsi: '265552060', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
    });
    const vessel = {
      mmsi: '265552060',
      lat: QUAY_LAT,
      lon: QUAY_LON,
      sog: 4.6,
      cog: 139.7, // sydbandet ⇒ FP8-grenen, inte FP9
      targetBridge: null,
      passedBridges: [],
      _firstSeenLat: QUAY_LAT,
    };
    app._noteQuayStability(vessel);
    expect(app._getFlowTriggerCandidates(vessel, proximityData)
      .some((c) => c.name === 'Kanalinfarten')).toBe(false);
    expect(loggedWith(app.debug, 'TRIGGER_POINT_SKIP]')).toBe(true);
    expect(loggedWith(app.log, 'TRIGGER_POINT_SKIP_QUAY')).toBe(false);
  });
});

describe('V1 (granskningsrunda 2): hålen som gjorde grinden nästan verkningslös', () => {
  test('RIKTNING: två rörelsefixar BORT från punkten öppnar inte längre grinden', () => {
    // (a)-benet var riktningsblint och benen är ett ELLER, så netto-kravet
    // band aldrig — grinden blev en enpolls fördröjning. PRICKBJORN överlevde
    // bara för att cog rullade in i sydbandet på nästa fix; låg den kvar i
    // östbandet hade fantomen fyrat medan båten gick 119 → 143 m.
    const app = makeApp();
    const anchor = southOfTp(120);
    app._noteQuayStability({
      mmsi: '265012090', ...anchor, sog: 0, _moored: true,
    });
    const away1 = {
      mmsi: '265012090', ...southOfTp(140), sog: 1.2, cog: 128.7, targetBridge: null,
    };
    app._noteQuayStability(away1);
    const away2 = {
      mmsi: '265012090', ...southOfTp(165), sog: 1.1, cog: 128.7, targetBridge: null,
    };
    app._noteQuayStability(away2);
    expect(app._quayStableLedger.get('265012090').movingFixes).toBe(2);
    expect(app._getFlowTriggerCandidates(away2, proximityData)
      .some((c) => c.name === 'Kanalinfarten')).toBe(false);
    expect(loggedWith(app.log, 'TRIGGER_POINT_SKIP_QUAY')).toBe(true);
  });

  test('DÖDBANDET 0,5-1,0 kn nollställer räknaren ("på varandra följande" är sant nu)', () => {
    // Sekvensen 1,2 / 0,7 / 1,1 kn gav förut movingFixes = 2 — mellansamplet
    // varken räknade upp eller nollade. Det är kajvobbelns naturliga profil.
    const app = makeApp();
    app._noteQuayStability({
      mmsi: '265012091', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
    });
    const base = {
      mmsi: '265012091', lat: QUAY_LAT, lon: QUAY_LON, cog: 128.7, targetBridge: null,
    };
    app._noteQuayStability({ ...base, sog: 1.2 });
    app._noteQuayStability({ ...base, sog: 0.7 });
    expect(app._quayStableLedger.get('265012091').movingFixes).toBe(0);
    app._noteQuayStability({ ...base, sog: 1.1 });
    expect(app._quayStableLedger.get('265012091').movingFixes).toBe(1);
  });

  test('VESSEL_ENTERED-vägen bokför kajstabiliteten (grinden var inert för återfödare)', async () => {
    // Kajliggarna kring Kanalinfarten ligger >600 m från närmaste bro ⇒ 120 s
    // timeout mot Class B:s 180 s kadens ⇒ nästan varje fix blir en
    // VESSEL_ENTERED (PRICKBJORN 72 cykler på tio timmar). Bokföringen låg
    // bara i _onVesselUpdated.
    const app = makeApp({
      _initializeTargetBridge: jest.fn(),
      _analyzeVesselPosition: jest.fn(),
      _triggerBoatNearFlow: jest.fn(),
      _checkSkippedBridgesFallback: jest.fn(),
      _checkNearbyVesselTrigger: jest.fn(),
      _updateUI: jest.fn(),
      _updateUIIfNeeded: jest.fn(),
    });
    const vessel = {
      mmsi: '265012090', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
    };
    await app._onVesselEntered({ mmsi: '265012090', vessel });
    expect(app._quayStableLedger.get('265012090').stillAt).toBeGreaterThan(0);
  });

  test('PERSISTENS: bokföringen överlever en omstart (settings-blob, TTL-prövad)', () => {
    const store = new Map();
    const settings = { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => store.set(k, v) };
    const app = makeApp({ homey: { settings } });
    app._quayLedgerPersistedAt = 0;
    app._noteQuayStability({
      mmsi: '265012090', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
    });
    app._persistQuayLedger(true);
    expect(store.get('quay_stable_ledger')['265012090'].stillAt).toBeGreaterThan(0);

    // Ny process: samma settings, tom karta.
    const restarted = makeApp({ homey: { settings } });
    restarted._loadQuayLedger();
    const entry = restarted._quayStableLedger.get('265012090');
    expect(entry.stillAt).toBeGreaterThan(0);
    // Rörelseräknaren återställs ALDRIG — konsekutivitet är ett påstående om
    // den här sessionens observationer.
    expect(entry.movingFixes).toBe(0);

    // …och en post äldre än minnesfönstret bärs inte över.
    store.set('quay_stable_ledger', {
      265012099: { stillAt: Date.now() - QUAY_DEPARTURE_GATE.MEMORY_MS - 1000, lat: QUAY_LAT, lon: QUAY_LON },
    });
    const stale = makeApp({ homey: { settings } });
    stale._loadQuayLedger();
    expect(stale._quayStableLedger.has('265012099')).toBe(false);
  });

  test('PERSISTENS: skrivtakten är strypt (flash-slitage)', () => {
    let writes = 0;
    const store = new Map();
    const settings = {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => {
        writes++; store.set(k, v);
      },
    };
    const app = makeApp({ homey: { settings } });
    app._quayLedgerPersistedAt = 0;
    for (let i = 0; i < 50; i++) {
      app._noteQuayStability({
        mmsi: '265012090', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
      });
    }
    expect(writes).toBe(1); // en skrivning, resten strypta av intervallet
  });
});

describe('V1: bokföringen av kajstabil historik', () => {
  test('sog=null rör ingenting (S-F7: okänd fart är inget bevis åt något håll)', () => {
    const app = makeApp();
    app._noteQuayStability({
      mmsi: '265999004', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
    });
    const before = { ...app._quayStableLedger.get('265999004') };
    app._noteQuayStability({
      mmsi: '265999004', lat: QUAY_LAT, lon: QUAY_LON, sog: null, cog: 100,
    });
    const after = app._quayStableLedger.get('265999004');
    expect(after.movingFixes).toBe(before.movingFixes);
    expect(after.lat).toBe(before.lat);
  });

  test('fartgivarlös förtöjd båt (sog=null + _moored) bokförs som kajstabil', () => {
    const app = makeApp();
    app._noteQuayStability({
      mmsi: '265999005', lat: QUAY_LAT, lon: QUAY_LON, sog: null, _moored: true,
    });
    const entry = app._quayStableLedger.get('265999005');
    expect(entry.stillAt).toBeGreaterThan(0);
    expect(entry.lat).toBeCloseTo(QUAY_LAT, 6);
  });

  test('utanför LEDGER_RADIUS_M släpps posten (bounded minne, transit prövas som förut)', () => {
    const app = makeApp();
    app._noteQuayStability({
      mmsi: '265999006', lat: QUAY_LAT, lon: QUAY_LON, sog: 0, _moored: true,
    });
    expect(app._quayStableLedger.has('265999006')).toBe(true);
    app._noteQuayStability({
      mmsi: '265999006',
      ...southOfTp(QUAY_DEPARTURE_GATE.LEDGER_RADIUS_M + 200),
      sog: 0,
      _moored: true,
    });
    expect(app._quayStableLedger.has('265999006')).toBe(false);
  });

  test('_pruneDedupCaches släpper utgången historik för inaktiva mmsi', () => {
    const app = makeApp({
      vesselDataService: { getAllVessels: () => [] },
      _triggeredBoatNearKeys: new Set(),
      _persistentRecentTriggers: new Map(),
      _persistRecentTriggers: jest.fn(),
    });
    app._quayStableLedger.set('265999007', {
      stillAt: Date.now() - (QUAY_DEPARTURE_GATE.MEMORY_MS + 60 * 1000),
      lat: QUAY_LAT,
      lon: QUAY_LON,
      movingFixes: 0,
    });
    app._quayStableLedger.set('265999008', {
      stillAt: Date.now(), lat: QUAY_LAT, lon: QUAY_LON, movingFixes: 0,
    });
    app._pruneDedupCaches();
    expect(app._quayStableLedger.has('265999007')).toBe(false);
    expect(app._quayStableLedger.has('265999008')).toBe(true);
  });
});

/**
 * V3 (fältlistoffer nr 13): navStatus bars av vesselPatch men fångades inte av
 * replay-inspelningen. Alla 371 aisstream-rader i A/B-korpusarna saknade
 * fältet medan AISHub-generatorn skrev det för 793 av 1014 poster — arm B fick
 * ett förtöjningslager arm A strukturellt inte kunde ha.
 */
describe('V3: _captureAISReplaySample fångar navStatus', () => {
  function makeCaptureApp() {
    const app = Object.create(AISBridgeApp.prototype);
    const logger = makeLogger();
    app.debug = logger.debug;
    app.log = logger.log;
    app.error = logger.error;
    app._captureAISReplaySample = jest.fn();
    app._rememberVesselName = jest.fn();
    app._lookupVesselName = jest.fn(() => null);
    app.vesselDataService = { updateVessel: jest.fn(() => null) };
    return app;
  }

  const baseMessage = {
    mmsi: 265012090,
    msgType: 'PositionReport',
    lat: 58.26786,
    lon: 12.26735,
    sog: 0,
    cog: 42.3,
    shipName: 'PRICKBJORN',
    timestamp: 1785706773608,
  };

  test('navStatus följer med i inspelningen', () => {
    const app = makeCaptureApp();
    app._processAISMessage({ ...baseMessage, navStatus: 5 });
    expect(app._captureAISReplaySample).toHaveBeenCalledTimes(1);
    const sample = app._captureAISReplaySample.mock.calls[0][0];
    expect(sample.navStatus).toBe(5);
    // Klockdomänen orörd: aisTimestamp är fortfarande mottagningsstämpeln.
    expect(sample.aisTimestamp).toBe(baseMessage.timestamp);
  });

  test('saknad/ogiltig navStatus fångas som null (Class B sänder aldrig fältet)', () => {
    const app = makeCaptureApp();
    app._processAISMessage({ ...baseMessage, navStatus: 99 });
    expect(app._captureAISReplaySample.mock.calls[0][0].navStatus).toBeNull();
    app._processAISMessage(baseMessage);
    expect(app._captureAISReplaySample.mock.calls[1][0].navStatus).toBeNull();
  });
});

/**
 * FYND 17: [FEED_SILENT]-notisen om AISHub-tystnad gatades bara på
 * `configured` — i SKUGGLÄGE är hubben ett mätinstrument som varken påverkar
 * brotext eller notiser, och en pushnotis ("kontrollera användarnamnet") vore
 * ren brusdebitering.
 */
describe('FYND 17: AISHub-tystnadsnotisen kräver att hubben matar pipelinen', () => {
  function makeSilenceApp(source, username = 'stationsnamn') {
    const app = Object.create(AISBridgeApp.prototype);
    const logger = makeLogger();
    app.debug = logger.debug;
    app.log = logger.log;
    app.error = logger.error;
    app._notifyConnectionIssue = jest.fn();
    app._feedSilentLogTimes = new Map();
    app.homey = {
      settings: {
        get: jest.fn((key) => {
          if (key === 'ais_source') return source;
          if (key === 'aishub_username') return username;
          return null;
        }),
      },
    };
    return app;
  }

  const perFeed = {
    aisstream: {
      configured: true, timeSinceLastMessage: 30 * 1000, uptime: 60 * 60 * 1000,
    },
    aishub: {
      configured: true, timeSinceLastMessage: 20 * 60 * 1000, uptime: 60 * 60 * 1000,
    },
  };

  test('skuggläge: loggas men INGEN användarnotis', () => {
    const app = makeSilenceApp('shadow');
    app._checkCrossFeedSilence(perFeed);
    expect(loggedWith(app.log, 'FEED_SILENT')).toBe(true);
    expect(loggedWith(app.log, 'skuggläge')).toBe(true);
    expect(app._notifyConnectionIssue).not.toHaveBeenCalled();
  });

  test("'both': notis skickas som förut", () => {
    const app = makeSilenceApp('both');
    app._checkCrossFeedSilence(perFeed);
    expect(loggedWith(app.log, 'FEED_SILENT')).toBe(true);
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(
      expect.stringContaining('AISHub'),
      'aishub:silent',
    );
  });

  test("'both' utan username degraderas till aisstream ⇒ ingen notis", () => {
    const app = makeSilenceApp('both', '');
    app._checkCrossFeedSilence(perFeed);
    expect(app._notifyConnectionIssue).not.toHaveBeenCalled();
  });

  test('aisstream-tystnad notifieras i BÅDA lägena (aisstream matar alltid pipelinen)', () => {
    const app = makeSilenceApp('shadow');
    app._checkCrossFeedSilence({
      aisstream: {
        configured: true, timeSinceLastMessage: 20 * 60 * 1000, uptime: 60 * 60 * 1000,
      },
      aishub: {
        configured: true, timeSinceLastMessage: 30 * 1000, uptime: 60 * 60 * 1000,
      },
    });
    expect(app._notifyConnectionIssue).toHaveBeenCalledWith(
      expect.stringContaining('AISstream'),
      'aisstream:silent',
    );
  });
});
