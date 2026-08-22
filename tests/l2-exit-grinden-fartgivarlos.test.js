'use strict';

jest.mock('homey');

/**
 * L2 (helkodsgranskning RUNDA 3, 2026-08-22) — J20-REGRESSIONEN: EXIT-GRINDENS
 * STILLALIGGARKRAV HOPPADES ÖVER FÖR HELA DEN FARTGIVARLÖSA KLASSEN.
 *
 * MEKANISMEN FÖRE FIXEN: H19 (fixrunda 1) lade rörelsekravet
 * `effectiveTransitSpeed >= MIN_VIABLE_SPEED_KN` på HELA exit-vägen, gatat på
 * `exitSpeedKnown = finit sog || finit maxRecentSpeed`. J20 (runda 2) lät
 * `_calculateMaxRecentSpeed` returnera null i stället för en fabricerad nolla —
 * rätt i sak, men för en båt som ALDRIG rapporterat fart blir `exitSpeedKnown`
 * då falsk, och hela villkoret HOPPAS ÖVER i stället för att blockera.
 * Snapshotten bar ingen positionshärledd stillhet att falla tillbaka på.
 *
 * FELUTFALLET (reproducerat i granskningen): fartgivarlös båt, nio sydgående
 * sampel och därefter sex sampel stilla inom 5 m under 18 min, 320 m från
 * Kanalinfarten ⇒ EN falsk boat_near med texten "… var på väg ut ur kanalen när
 * AIS-kontakten bröts", plus 2h persistent dedup som tystar hennes ÄKTA utfart.
 * Exakt den felklass H19 stängde.
 *
 * FIXEN: J20 behålls (null = okänt). När farten är okänd MÄTER grinden i
 * stället stillheten ur POSITIONEN — `_stationarySince` ur removal-snapshoten,
 * med tidskravet härlett ur samma tröskel som finit-halvan (en båt i
 * MIN_VIABLE_SPEED_KN lämnar jitterradien på 155,5 s).
 *
 * SVITEN KÖR GENOM RIKTIG PIPELINE: bevisfälten skrivs av den RIKTIGA
 * VesselDataService._updateMooringEvidence och plockas ur den RIKTIGA
 * removal-snapshoten (`vessel:removed`) — inga handsatta stillhetsfält.
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { TRIGGER_POINTS, MOORING_DETECTION, PASSAGE_TIMING } = require('../lib/constants');

const KANAL = TRIGGER_POINTS.kanalinfarten;
const REAL_DATE_NOW = Date.now;
const M_PER_DEG_LAT = 111320;

// Samma härledning som produktionskoden: 40 m jitterradie / (0,5 kn i m/s).
const EXPECTED_STILLNESS_MIN_MS = Math.round(
  (MOORING_DETECTION.NULL_SOG_STILL_RADIUS_M / (PASSAGE_TIMING.MINIMUM_VIABLE_SPEED * 0.5144)) * 1000,
);

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

const northOfKanal = (meters) => ({
  lat: KANAL.lat + meters / M_PER_DEG_LAT,
  lon: KANAL.lon,
});

function makeExitApp() {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
  return app;
}

const skippedStationary = (app) => app.debug.mock.calls
  .some((c) => String(c[0]).includes('EXIT_TRIGGER_SKIP_STATIONARY'));

// =============================================================================
// L2 (a) — RIKTIG PIPELINE: sog=null hela vägen, riktig removal-snapshot
// =============================================================================
describe('L2 (a): fartgivarlös klass genom riktig pipeline', () => {
  let svc;
  let mockNow;
  let snapshots;

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 7, 22, 9, 0, 0).getTime();
    Date.now = () => mockNow;
    const logger = makeLogger();
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    snapshots = [];
    svc.on('vessel:removed', (payload) => snapshots.push(payload));
  });

  afterEach(() => {
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
    delete global.__TEST_MODE__;
    Date.now = REAL_DATE_NOW;
  });

  const tick = (minutes) => {
    mockNow += minutes * 60 * 1000;
  };

  /**
   * Nio sydgående sampel (ger rörelsebeviset genom positionsgrenen) och
   * därefter `stillMinutes` minuters stillhet inom några meter — allt med
   * sog=null, alltså den ALDRIG-finita klassen.
   */
  const runSensorlessApproach = (mmsi, stillMinutes) => {
    for (let i = 0; i < 9; i++) {
      const pos = northOfKanal(1200 - i * 100);
      svc.updateVessel(mmsi, {
        lat: pos.lat, lon: pos.lon, sog: null, cog: 205, shipName: 'FARTGIVARLÖSA UTFARTEN',
      });
      tick(2);
    }
    const rest = northOfKanal(320);
    for (let i = 0; i < 6; i++) {
      svc.updateVessel(mmsi, {
        // ±2 m jitter — långt inom NULL_SOG_STILL_RADIUS_M (40 m).
        lat: rest.lat + ((i % 2 === 0 ? 2 : -2) / M_PER_DEG_LAT),
        lon: rest.lon,
        sog: null,
        cog: 205,
        shipName: 'FARTGIVARLÖSA UTFARTEN',
      });
      tick(stillMinutes / 6);
    }
  };

  const removalSnapshot = (mmsi) => {
    svc.removeVessel(mmsi, 'timeout');
    const hit = snapshots.find((s) => s.mmsi === mmsi);
    return hit ? hit.vessel : null;
  };

  test('ÖVERLEVNADSTEST (fältlist-fällan): snapshotten BÄR _stationarySince', () => {
    const mmsi = '265900030';
    runSensorlessApproach(mmsi, 18);
    const snap = removalSnapshot(mmsi);

    expect(snap).not.toBeNull();
    expect(snap.sog).toBeNull();
    expect(snap.maxRecentSpeed).toBeNull();
    expect(Number.isFinite(snap._stationarySince)).toBe(true);
  });

  test('FÄLTFALLET: 18 min positionsstilla 320 m från punkten ⇒ INGEN exit-notis', async () => {
    const mmsi = '265900031';
    runSensorlessApproach(mmsi, 18);
    const snap = removalSnapshot(mmsi);
    // Grinden ovanför (förtöjning) får inte vara den som fäller — då hade
    // testet mätt fel sak.
    expect(snap._moored).toBe(false);

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(skippedStationary(app)).toBe(true);
  });

  test('RÖRLIG UTAN FART: samma klass i färd ⇒ exit-notisen fyrar som förut', async () => {
    const mmsi = '265900032';
    // Fortsätter söderut ända in i sista samplet — ankaret bryts varje gång,
    // så stillhetsklockan startar aldrig.
    for (let i = 0; i < 12; i++) {
      const pos = northOfKanal(1500 - i * 100);
      svc.updateVessel(mmsi, {
        lat: pos.lat, lon: pos.lon, sog: null, cog: 205, shipName: 'FARTGIVARLÖSA I FÄRD',
      });
      tick(2);
    }
    const snap = removalSnapshot(mmsi);
    expect(snap.sog).toBeNull();
    expect(snap._stationarySince).toBeNull();

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
    expect(skippedStationary(app)).toBe(false);
  });

  test('KORT STILLHET (under tröskeln) fäller INTE — grinden är fail-open', async () => {
    const mmsi = '265900033';
    // Två minuters stillhet = 120 s < 155,5 s-tröskeln.
    runSensorlessApproach(mmsi, 2);
    const snap = removalSnapshot(mmsi);
    expect(Number.isFinite(snap._stationarySince)).toBe(true);
    expect(Date.now() - snap._stationarySince).toBeLessThan(EXPECTED_STILLNESS_MIN_MS);

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// L2 (b) — kontrakten som INTE fick röras
// =============================================================================
describe('L2 (b): H19- och A1R2-1-kontrakten står kvar', () => {
  const nearExit = (overrides = {}) => ({
    mmsi: '265900034',
    name: 'KONTRAKTSBÅTEN',
    lat: KANAL.lat + 330 / M_PER_DEG_LAT,
    lon: KANAL.lon,
    sog: 0.2,
    cog: 205,
    passedBridges: ['Olidebron'],
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _lastSeen: Date.now(),
    _moored: false,
    _hasMovementProof: true,
    ...overrides,
  });

  test('H19: finit 0,2 kn fäller fortfarande (finit-halvan orörd)', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(nearExit());
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(skippedStationary(app)).toBe(true);
  });

  test('F5-B: 1,2 kn på basradien fyrar fortfarande (tröskeln får inte höjas)', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(nearExit({ sog: 1.2 }));
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
  });

  test('A1R2-1: sog=null + finit maxRecentSpeed bedöms på maxRecentSpeed', async () => {
    const rorlig = makeExitApp();
    await rorlig._triggerExitPointFallback(nearExit({ sog: null, maxRecentSpeed: 5.2 }));
    expect(rorlig._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);

    const stilla = makeExitApp();
    await stilla._triggerExitPointFallback(nearExit({ sog: null, maxRecentSpeed: 0.3 }));
    expect(stilla._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('CLABBYDOO: snapshot helt utan fart- OCH stillhetsfält ⇒ grinden avstår', async () => {
    const app = makeExitApp();
    const snapshot = nearExit();
    delete snapshot.sog;
    await app._triggerExitPointFallback(snapshot);
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
  });

  test('DISKRIMINATORN: _hasCorroboratedMovement duger INTE (sann även för stillaliggaren)', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(nearExit({
      sog: null,
      _hasCorroboratedMovement: true, // klistrande — sann för en båt som lagt sig still
      _stationarySince: Date.now() - (EXPECTED_STILLNESS_MIN_MS + 60 * 1000),
    }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(skippedStationary(app)).toBe(true);
  });

  test('ANKARSTÄMPELN duger INTE som stillhetsbevis (den stämplas om vid varje rörelse)', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(nearExit({
      sog: null,
      _stationarySince: null,
      _nullSogStillAnchorT: Date.now() - 30 * 60 * 1000, // gammalt ankare, men i färd
    }));
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
  });
});
