'use strict';

jest.mock('homey');

/**
 * S2 (systerställesrundan 2026-08-23) — KAJGRINDENS LÄSSIDA MÄTTE PÅ EN
 * GPS-FLAGGAD POSITION.
 *
 * MEKANISMEN FÖRE FIXEN: N5 gatade FIXSKIFTET i _noteQuayLedgerEntry, men
 * _quayDepartureNeedsProof mätte netto-närmandet från bokföringsankaret till
 * vessel-positionen utan att fråga någon GPS-flagga — och positionen ÄR den
 * råa hoppositionen (VesselDataService sätter flaggan men behåller
 * currentPosition). ETT osäkert sampel uppfyllde därför netto-benet (b) och
 * stängde av HELA kajvobbelskyddet: både trigger-punktens (notisvägen) och
 * öppningsmotorns. Under 600 m är skyddet dessutom ensamt — C9-stillhetsbenet
 * i BridgeOpeningService kräver avstånd över DISARM_MOORED_MIN_DISTANCE_M
 * medan kajvobbelbenet saknar avståndsgolv.
 *
 * FIXEN: på ett GPS-flaggat sampel lämnas netto-benet på null (N11-mönstret:
 * ogiltigförklara geometrin i stället för att gissa). Det är fail-open åt rätt
 * håll — rörelsebenet (a) KRÄVER att nettot är okänt, så en äkta avgång med
 * två rörelsefixar räddas medan en stilla kajliggare inte kan kortslutas av
 * ett enda flaggat hopp.
 *
 * SVITEN KÖR PRODUKTIONSVÄGEN (N5-sviterna som förlaga): bokföringen byggs av
 * _noteQuayStability, öppningsgrinden frågas via _isBridgeOpeningQuayWobbler
 * och notisvägen via _getFlowTriggerCandidates.
 *
 * MUTATIONSPROV (KÖRDA i isolerat träd): tas `!gpsSuspect` bort ur villkoret i
 * _quayDepartureNeedsProof blir de tre FIXEN-testerna röda. Görs grinden i
 * stället fail-CLOSED (returnera alltid ett skäl på flaggan) blir
 * "ÄKTA AVGÅNG"-testet rött, eftersom en bevisad avgång då fastnar.
 */

const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const {
  BRIDGES, TRIGGER_POINTS, QUAY_DEPARTURE_GATE, MOORING_DETECTION,
} = require('../lib/constants');

const KLAFFBRON = Object.values(BRIDGES).find((b) => b && b.name === 'Klaffbron');
const TP = TRIGGER_POINTS.kanalinfarten;
const REAL_DATE_NOW = Date.now;

const southOf = (ref, m) => ({ lat: ref.lat - m / 111320, lon: ref.lon });

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeApp() {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app._quayStableLedger = new Map();
  app._openingQuayLedger = new Map();
  app.bridgeRegistry = new BridgeRegistry();
  app.vesselDataService = {
    hasGpsJumpHold: () => false,
    isNearMooringZone: () => false,
    applyInferredPassage: jest.fn(),
  };
  app._lastKnownPositions = new Map();
  app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * 60 * 1000;
  return app;
}

const sample = (pos, sog, ts, extra = {}) => ({
  mmsi: '265444555',
  lat: pos.lat,
  lon: pos.lon,
  sog,
  cog: 10.0,
  timestamp: ts,
  fixTs: ts,
  fixFeed: 'aisstream',
  targetBridge: 'Klaffbron',
  passedBridges: [],
  ...extra,
});

const proximityData = { bridges: [], nearestBridge: null };

describe('S2 (öppningsvägen): ett GPS-flaggat sampel får inte kortsluta kajgrinden', () => {
  let now;

  beforeEach(() => {
    jest.clearAllMocks();
    now = new Date(2026, 7, 23, 9, 0, 0).getTime();
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  // 400 m söder om Klaffbron: inne i bokföringsradien (500 m) och långt under
  // C9:s avståndsgolv (600 m), dvs. exakt bandet där kajvobbelbenet är ensamt.
  const QUAY = southOf(KLAFFBRON, 400);
  // 300 m från bron ⇒ netto-närmande 100 m, alltså långt över NET_APPROACH_M.
  const JUMPED = southOf(KLAFFBRON, 300);

  /** 12 stillasampel i 2-minuterskadens = 22 min vistelse (> QUAY_STAY_MIN_MS). */
  const stay = (app) => {
    for (let i = 0; i < 12; i++) {
      app._noteQuayStability(sample(QUAY, 0.2, now));
      now += 2 * 60 * 1000;
    }
  };

  test('PREMISSEN: predikatet är sant medan hon ligger kvar', () => {
    const app = makeApp();
    stay(app);
    expect(app._isBridgeOpeningQuayWobbler(sample(QUAY, 0.2, now))).toBe(true);
  });

  test('FIXEN: flaggat sampel 100 m närmare bron ⇒ grinden håller (ingen beväpning)', () => {
    const app = makeApp();
    stay(app);
    const flagged = sample(JUMPED, 0.2, now, { _positionUncertain: true });
    app._noteQuayStability(flagged);

    // Netto-benet är OGILTIGFÖRKLARAT, inte uppfyllt.
    const reason = app._quayDepartureNeedsProof(flagged, KLAFFBRON, app._openingQuayLedger);
    expect(reason).not.toBeNull();
    expect(reason.approachM).toBeNull();
    expect(app._isBridgeOpeningQuayWobbler(flagged)).toBe(true);
  });

  test('FIXEN gäller båda flaggorna: _gpsJumpDetected ger samma utfall', () => {
    const app = makeApp();
    stay(app);
    const flagged = sample(JUMPED, 0.2, now, { _gpsJumpDetected: true });
    app._noteQuayStability(flagged);
    expect(app._isBridgeOpeningQuayWobbler(flagged)).toBe(true);
  });

  test('KONTROLLARM: samma geometri UTAN flagga ⇒ nettot räknas som förut', () => {
    const app = makeApp();
    stay(app);
    const clean = sample(JUMPED, 0.2, now);
    app._noteQuayStability(clean);

    const reason = app._quayDepartureNeedsProof(clean, KLAFFBRON, app._openingQuayLedger);
    expect(reason).toBeNull(); // (b) uppfylld — oförändrat beteende
    expect(app._isBridgeOpeningQuayWobbler(clean)).toBe(false);
  });

  test('ÄKTA AVGÅNG fördröjs en fix, förloras inte: flaggade rörelsefixar håller, första rena öppnar (S2 ben a)', () => {
    // OMLÅST (granskarfynd fixrunda 6, 2026-08-23). Låste förut att två
    // FLAGGADE rörelsefixar öppnade ben (a) — men ett netto som är okänt PÅ
    // GRUND AV flaggan får inte räknas som "ingen geometri att kräva": då
    // öppnar ett enda flaggat sampel ben (a) för LADYBIRD-klassen (0–39 m
    // känt netto / reträtt) som K4/F3 stängde. Fail-open-löftet står kvar i
    // sin sanna form: skyddet FÖRDRÖJER (tills nästa rena fix), det förlorar
    // inte — dedupnyckeln sätts inte vid skip.
    const app = makeApp();
    stay(app);
    for (let i = 0; i < QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES; i++) {
      now += 2 * 60 * 1000;
      app._noteQuayStability(sample(JUMPED, 3.0, now, { _positionUncertain: true }));
    }
    const flaggedMoving = sample(JUMPED, 3.0, now, { _positionUncertain: true });
    expect(app._quayDepartureNeedsProof(flaggedMoving, KLAFFBRON, app._openingQuayLedger)).not.toBeNull();
    // Nästa RENA fix: nettot blir känt (eller ben a utan flagga) ⇒ grinden öppnar.
    now += 2 * 60 * 1000;
    const cleanMoving = sample(JUMPED, 3.0, now);
    app._noteQuayStability(cleanMoving);
    expect(app._quayDepartureNeedsProof(cleanMoving, KLAFFBRON, app._openingQuayLedger)).toBeNull();
  });
});

describe('S2 (notisvägen): samma lässida bär trigger-punktens kajgrind', () => {
  let now;

  beforeEach(() => {
    jest.clearAllMocks();
    now = new Date(2026, 7, 23, 9, 0, 0).getTime();
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  const QUAY = southOf(TP, 250); // kaj inne i 300 m-zonen (nattens kajliggarklass)
  const JUMPED = southOf(TP, 120); // 130 m närmare punkten = netto över 40 m

  const tpSample = (pos, sog, extra = {}) => sample(pos, sog, now, {
    targetBridge: null, cog: 10.0, ...extra,
  });

  const kanalCandidate = (app, vessel) => app._getFlowTriggerCandidates(vessel, proximityData)
    .find((c) => c.name === 'Kanalinfarten') || null;

  test('FIXEN: flaggat sampel med sog över TRANSIT_SOG_KN ⇒ ingen kandidat', () => {
    const app = makeApp();
    for (let i = 0; i < 6; i++) {
      app._noteQuayStability(tpSample(QUAY, 0.2));
      now += 2 * 60 * 1000;
    }
    // sog 1,0 klarar FP9-benet (transitindikation) och lämnar V1-grinden ensam.
    const flagged = tpSample(JUMPED, QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN, { _positionUncertain: true });
    app._noteQuayStability(flagged);

    expect(kanalCandidate(app, flagged)).toBeNull();
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('TRIGGER_POINT_SKIP_QUAY'));
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('netto mot punkten=okänt'));
  });

  test('KONTROLLARM: samma sampel utan flagga ⇒ kandidaten släpps som förut', () => {
    const app = makeApp();
    for (let i = 0; i < 6; i++) {
      app._noteQuayStability(tpSample(QUAY, 0.2));
      now += 2 * 60 * 1000;
    }
    const clean = tpSample(JUMPED, QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN);
    app._noteQuayStability(clean);

    expect(kanalCandidate(app, clean)).not.toBeNull();
  });

  test('STORHETERNA: tröskeln som kortslutningen passerade är 40 m', () => {
    expect(QUAY_DEPARTURE_GATE.NET_APPROACH_M).toBe(40);
    expect(MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN).toBe(0.5);
  });
});
