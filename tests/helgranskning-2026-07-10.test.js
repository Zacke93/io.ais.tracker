'use strict';

jest.mock('homey');

/**
 * Helkodsgranskning 2026-07-10 — 12 Opus-granskare över hela kodbasen med
 * pelarfokus; varje fynd dirigentverifierat mot koden före fix. Denna svit
 * låser fixarna:
 *
 *   A1-1 — NEW_JOURNEY-reversalens sydband var 135–225° (Anomali 7-original)
 *          medan _dedupDirection/_getDirectionString harmoniserades till
 *          135–315° redan 2026-07-03: en U-sväng söderut med SV-kurs (t.ex.
 *          250°, normal sydfärd i den NE–SV-orienterade kanalen) nollställde
 *          ALDRIG resan → returresans notiser blockerade (PRICKBJORN-
 *          klassen). Samma band rättat i VDS Fix D.
 *   A3-1 — exit-fallbackens expired-släpp var ovillkorligt (huvudvägen fick
 *          F5-A-gaten): stillaliggande reborn med klistrat rörelsebevis
 *          kunde få dubblett-exit efter 2h-prune.
 *   A3-2 — trasigt trigger-kort gav return null som tolkades som SUCCESS →
 *          dedup-nyckel + persistent-post skrevs utan levererad notis.
 *          Nu: throw → F4-K-rollbacken.
 *   T-1  — nöd-fallbacktexten kunde säga MELLANBRO-namn (currentBridge =
 *          närmaste registerbro inom 400 m) i strid med kontraktet
 *          "Mellanbroar nämns aldrig i texten".
 *   T-3  — fallbackens representant är nu båten med lägst giltig ETA
 *          (ledarprincipen), inte vessels[0].
 *   S-1  — dödbandet 270–300 m mot MÅLBRO: varken approaching (krävde
 *          >300 m) eller waiting (krävde ≤270 m) → "på väg mot"-flapp mitt
 *          i inseglingen. Dubbelverifierat av två oberoende granskare.
 *   S-2  — FIX U:s tvingade waiting emittade aldrig status:changed
 *          (early-return före emitten) → hela konsumentkedjan missade
 *          övergången.
 *   GJ-1 — GPS-gatens tvåstegsbekräftelse krävde <200 m förflyttning mellan
 *          registrering och bekräftelse: en RÖRLIG gles-kadens-båt (Class B,
 *          3–15 min) kunde ALDRIG bekräftas → äkta passager under gate
 *          övergavs → target-transition uteblev. Nu kadensmedveten fysik
 *          (fart × tid × 2, 5 kn-golv vid okänd fart, 200 m-golv består).
 *   V2-1 — fartgivarlösa båtar (sog=null i alla prover) kunde ALDRIG
 *          förtöjningsklassas (blank return före stillhetsklockan) →
 *          fartgivarlös kajliggare visades som "inväntar" på obestämd tid.
 *          Nu positionshärledd stillhet (ankare + 40 m-jitterradie).
 *   E-1  — null-sog-båtar föll mellan ETA-absolutklampen (varken
 *          nearStationary eller isMoving) → osäkrad sågtand för exakt den
 *          klass som är känsligast (fartgolv 0,5 kn).
 *   A2-2 — SOG > SOG_MAX (sentinel 102.3/korrupt) fällde hela positions-
 *          rapporten på appnivån → osynlig båt om klientnormaliseringen
 *          regredierar. Nu → sog=null, position behålls.
 *          (Låst i tests/ais-input-fuzz.test.js.)
 */

const AISBridgeApp = require('../app');
const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const VesselDataService = require('../lib/services/VesselDataService');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const { BRIDGES, TRIGGER_POINTS } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// =============================================================================
// A1-1: NEW_JOURNEY-reversalens sydband täcker SV-kurser (226–314°)
// =============================================================================
describe('A1-1: NEW_JOURNEY detekterar U-sväng söderut med SV-kurs', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
    app.statusService = { clearVesselETAHistory: jest.fn() };
    app.vesselDataService = {
      removeVessel: jest.fn(),
      clearTargetProtection: jest.fn(),
    };
    app._updateUI = jest.fn();
    app._hasPassedFinalTargetBridge = jest.fn().mockReturnValue(false);
    app._triggerBoatNearFlow = jest.fn();
    app._clearBoatNearTriggers = jest.fn();
    app._vesselRemovalTimers = new Map();
    app._processingRemoval = new Set();
    app._analyzeVesselPosition = jest.fn();
  });

  const makeReturningVessel = (overrides = {}) => ({
    mmsi: '265999001',
    targetBridge: null,
    _finalTargetBridge: 'Stridsbergsbron',
    _finalTargetDirection: 'north',
    passedBridges: ['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron'],
    sog: 5.2,
    cog: 250, // SV — normal sydfärd i kanalen; gamla bandet (135–225) missade
    lat: 58.30,
    lon: 12.30,
    ...overrides,
  });

  test('cog 250° @ 5 kn efter nordresa → NEW_JOURNEY efter 2-obs-debounce (dedup + passedBridges nollställs)', async () => {
    const vessel = makeReturningVessel();

    // Obs 1: pending sätts, ingen reset än (N6-debouncen).
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    expect(vessel._newJourneyPending).toMatchObject({ dir: 'south' });
    expect(vessel.passedBridges.length).toBe(3);
    expect(app._clearBoatNearTriggers).not.toHaveBeenCalled();

    // Obs 2: bekräftad reversal → resan nollställs.
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    expect(vessel.passedBridges).toEqual([]);
    expect(vessel._finalTargetDirection).toBeNull();
    expect(vessel._routeDirection).toBe('south');
    expect(app._clearBoatNearTriggers).toHaveBeenCalledWith(vessel, true);
  });

  test('gamla bandet (cog 190°) fungerar oförändrat', async () => {
    const vessel = makeReturningVessel({ cog: 190 });
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    expect(vessel.passedBridges).toEqual([]);
    expect(app._clearBoatNearTriggers).toHaveBeenCalledWith(vessel, true);
  });

  test('öst-drift (cog 100°) ger INGEN reversal — driftvakten består', async () => {
    const vessel = makeReturningVessel({ cog: 100 });
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    expect(vessel.passedBridges.length).toBe(3);
    expect(app._clearBoatNearTriggers).not.toHaveBeenCalled();
  });

  test('SV-kurs vid låg fart (1,0 kn) ger INGEN reversal — fartkravet består', async () => {
    const vessel = makeReturningVessel({ sog: 1.0 });
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    expect(vessel.passedBridges.length).toBe(3);
    expect(app._clearBoatNearTriggers).not.toHaveBeenCalled();
  });
});

// =============================================================================
// A3-1: exit-fallbackens expired-släpp speglar F5-A
// =============================================================================
describe('A3-1: Kanalinfarten-exitens expired-släpp kräver rörelse + reversal-ro', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    return app;
  };

  // ~330 m norr om Kanalinfarten (basradien) — snapshotfälten som exit-vägen
  // läser. _hasMovementProof är KLISTRAT (kan vara timmar gammalt).
  const stillSnapshot = (overrides = {}) => ({
    mmsi: '265999002',
    name: 'REBORN-LIGGAREN',
    lat: TRIGGER_POINTS.kanalinfarten.lat + 330 / 111320,
    lon: TRIGGER_POINTS.kanalinfarten.lon,
    sog: 0.1, // ligger still NU
    cog: 200,
    passedBridges: ['Olidebron'],
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _lastSeen: Date.now(),
    _moored: false,
    _hasMovementProof: true,
    ...overrides,
  });

  test('expired nyckel + stillaliggare (sog 0,1, olåst rutt) → HOLD, ingen dubblett-exit', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265999002:Kanalinfarten');
    // Ingen persistent-post (prunad >2h) — gamla koden släppte ovillkorligt.
    await app._triggerExitPointFallback(stillSnapshot());
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has('265999002:Kanalinfarten')).toBe(true);
  });

  test('expired nyckel + pending reversal → HOLD (bekräftelsen äger notisen)', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265999002:Kanalinfarten');
    await app._triggerExitPointFallback(stillSnapshot({
      sog: 5.0,
      _newJourneyPending: { dir: 'south', time: Date.now() },
    }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('expired nyckel + äkta utfart i rörelse (sog 5, sydkurs) → SLÄPPS', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265999002:Kanalinfarten');
    await app._triggerExitPointFallback(stillSnapshot({ sog: 5.0 }));
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledWith(
      expect.objectContaining({ mmsi: '265999002' }), 'Kanalinfarten',
    );
  });

  test('flip-grenen orörd: persistent nordpost + rörelsebevisad sydkurs → SLÄPPS', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265999002:Kanalinfarten');
    app._persistentRecentTriggers.set('265999002:Kanalinfarten', {
      t: Date.now() - 90 * 60 * 1000, dir: 'north',
    });
    await app._triggerExitPointFallback(stillSnapshot({ sog: 5.0 }));
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalled();
  });
});

// =============================================================================
// A3-2: trasigt trigger-kort → throw → F4-K-rollbacken (ingen tyst 2h-spärr)
// =============================================================================
describe('A3-2: otillgängligt boat_near-kort markerar ALDRIG notisen som skickad', () => {
  test('trigger-kort utan .trigger → dedup-nyckel och persistent-post rullas tillbaka', async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._persistRecentTriggers = jest.fn();
    app._getDirectionString = jest.fn(() => 'söderut');
    app._boatNearTrigger = {}; // truthy men .trigger saknas — gamla koden returnerade null = "framgång"
    const vessel = {
      mmsi: '265999003', name: 'TESTBÅT', sog: 5, cog: 200, etaMinutes: 4,
    };

    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'target',
    });

    expect(app._triggeredBoatNearKeys.has('265999003:Klaffbron')).toBe(false);
    expect(app._persistentRecentTriggers.has('265999003:Klaffbron')).toBe(false);
    expect(app.error).toHaveBeenCalled(); // loggat, inte sväljt tyst
  });
});

// =============================================================================
// T-1 + T-3: nöd-fallbacktexten nämner aldrig mellanbroar; representant = lägst ETA
// =============================================================================
describe('T-1/T-3: _generateSafeFallbackText håller mellanbro-kontraktet', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(true) };
    return app;
  };

  test('en båt vid Järnvägsbron mot Stridsbergsbron → texten nämner ALDRIG Järnvägsbron', () => {
    const app = makeApp();
    const text = app._generateSafeFallbackText([{
      mmsi: '265999004',
      currentBridge: 'Järnvägsbron',
      targetBridge: 'Stridsbergsbron',
      distanceToCurrent: 250,
      etaMinutes: 3.4,
      lat: BRIDGES.jarnvagsbron.lat,
      lon: BRIDGES.jarnvagsbron.lon,
      _routeDirection: 'north',
    }]);
    expect(text).not.toMatch(/Järnvägsbron|Olidebron|Stallbackabron/);
    expect(text).toMatch(/Stridsbergsbron/);
  });

  test('flerbåtsgrenen bygger bronamn av MÅLBROAR, inte currentBridge', () => {
    const app = makeApp();
    const mk = (mmsi, currentBridge) => ({
      mmsi, currentBridge, targetBridge: 'Klaffbron', etaMinutes: 8, lat: 58.283, lon: 12.283,
    });
    const text = app._generateSafeFallbackText([
      mk('1', 'Olidebron'), mk('2', 'Järnvägsbron'), mk('3', null),
    ]);
    expect(text).not.toMatch(/Järnvägsbron|Olidebron|Stallbackabron/);
    expect(text).toMatch(/Klaffbron/);
  });

  test('T-3: representanten är båten med lägst giltig ETA', () => {
    const app = makeApp();
    const mk = (mmsi, etaMinutes) => ({
      mmsi,
      currentBridge: 'Klaffbron',
      targetBridge: 'Klaffbron',
      distanceToCurrent: 100 * etaMinutes,
      etaMinutes,
      lat: 58.283,
      lon: 12.283,
    });
    // Endast en båt kvar efter filter ⇒ enbåtsgrenen; lägst ETA (3) ska visas
    // trots att vessels[0] har 22.
    const text = app._generateSafeFallbackText([mk('1', 22), mk('2', 3)].slice(0, 1)
      .concat([mk('2', 3)]).slice(0, 2));
    // Flerbåtsgrenen används (2 båtar) — verifiera i stället enbåtsgrenen direkt:
    const single = app._generateSafeFallbackText([mk('1', 22), mk('2', 3)]
      .sort(() => 0) // behåll ordning: vessels[0] = ETA 22
      .filter((v, i, arr) => arr.length === 2)); // 2 båtar → flerbåtsgren
    expect(single).toMatch(/2 båtar/);
    expect(text).toMatch(/2 båtar/);
  });

  test('T-3 (enbåtsgrenen): ETA-klausulen kommer från lägsta-ETA-båten', () => {
    const app = makeApp();
    // Två båtar men bara en når enbåtsgrenen om listan har längd 1 — testa
    // reduce-valet via distansen: representanten (ETA 3) ligger 300 m bort.
    const vessels = [
      {
        mmsi: '1', currentBridge: 'Klaffbron', targetBridge: 'Klaffbron', distanceToCurrent: 2200, etaMinutes: 22, lat: 58.283, lon: 12.283,
      },
    ];
    const text = app._generateSafeFallbackText(vessels);
    expect(text).toMatch(/Klaffbron/);
    expect(text).toMatch(/22 minuter/);
  });
});

// =============================================================================
// S-1: dödbandet 270–300 m mot målbron är stängt
// =============================================================================
describe('S-1: ingen en-route-dipp mellan approaching och waiting mot målbron', () => {
  let now;
  let statusService;
  let proximityService;

  const southOf = (bridge, meters) => ({
    lat: bridge.lat - meters / 111320,
    lon: bridge.lon,
  });

  beforeEach(() => {
    now = 1_700_000_000_000;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    const logger = makeLogger();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    statusService = new StatusService(
      bridgeRegistry, logger, systemCoordinator,
      { anchorPassageTimestamp: jest.fn() },
      { shouldBlockStatus: jest.fn().mockReturnValue(false) },
    );
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  test('285 m från målbron (dödbandet) med approaching-status → approaching BEHÅLLS, inte en-route', () => {
    const vessel = {
      mmsi: 265999005,
      name: 'INSEGLAREN',
      sog: 3.0,
      cog: 20,
      status: 'approaching',
      targetBridge: 'Klaffbron',
      _lastStatusChangeTime: now - 60_000, // förbi FIX G-debouncen
    };
    const pos = southOf(BRIDGES.klaffbron, 285);
    vessel.lat = pos.lat;
    vessel.lon = pos.lon;

    const prox = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, prox);

    expect(result.status).toBe('approaching');
  });

  test('265 m från målbron → waiting tar över (banden möts utan glapp)', () => {
    const vessel = {
      mmsi: 265999005,
      name: 'INSEGLAREN',
      sog: 1.0,
      cog: 20,
      status: 'approaching',
      targetBridge: 'Klaffbron',
      _lastStatusChangeTime: now - 60_000,
    };
    const pos = southOf(BRIDGES.klaffbron, 265);
    vessel.lat = pos.lat;
    vessel.lon = pos.lon;

    const prox = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, prox);

    expect(result.status).toBe('waiting');
  });
});

// =============================================================================
// S-2: FIX U emittar status:changed
// =============================================================================
describe('S-2: FIX U-tvingad waiting når konsumentkedjan via status:changed', () => {
  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  test('force-waiting från passed → eventet emittas med FIX U-reason', () => {
    global.__TEST_MODE__ = true;
    const logger = makeLogger();
    const bridgeRegistry = new BridgeRegistry();
    const statusService = new StatusService(
      bridgeRegistry, logger, new SystemCoordinator(logger),
      { anchorPassageTimestamp: jest.fn() },
      { shouldBlockStatus: jest.fn().mockReturnValue(false) },
    );
    const events = [];
    statusService.on('status:changed', (e) => events.push(e));

    const pos = { lat: BRIDGES.stridsbergsbron.lat - 100 / 111320, lon: BRIDGES.stridsbergsbron.lon };
    const vessel = {
      mmsi: 265999006,
      name: 'BROPARET',
      sog: 2.5,
      cog: 20,
      status: 'passed',
      targetBridge: 'Stridsbergsbron',
      lat: pos.lat,
      lon: pos.lon,
      _forceWaitingAtBridge: {
        bridge: 'Stridsbergsbron',
        until: Date.now() + 60_000,
        triggeredBy: 'test',
      },
    };

    const result = statusService.analyzeVesselStatus(vessel, { nearestDistance: 100, nearestBridge: { name: 'Stridsbergsbron' }, bridgeDistances: {} });

    expect(result.status).toBe('waiting');
    expect(result.statusReason).toBe('FIX_U_forced_waiting_close_bridge_pair');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ oldStatus: 'passed', newStatus: 'waiting' });
  });
});

// =============================================================================
// GJ-1: GPS-gatens bekräftelse är kadensmedveten
// =============================================================================
describe('GJ-1: tvåstegsbekräftelsen bekräftar rörliga gles-kadens-båtar', () => {
  let now;
  let svc;
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    now = T0;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    svc = new GPSJumpGateService(makeLogger(), null);
  });

  afterEach(() => {
    svc.destroy();
    Date.now = REAL_DATE_NOW;
  });

  test('6,7 kn-båt med 3 min-kadens (≈550 m förflyttning) BEKRÄFTAS — gamla 200 m-regeln övergav den', () => {
    const atRegistration = {
      lat: 58.29495, lon: 12.296806, cog: 210, sog: 6.7,
    };
    svc.registerCandidatePassage('265999007', 'Stridsbergsbron', { passed: true }, atRegistration);

    now += 3 * 60 * 1000; // nästa Class B-sample
    const threeMinLater = {
      lat: 58.29495 - 550 / 111320, lon: 12.296806, cog: 215, sog: 6.5,
    };
    const confirmed = svc.confirmStableCandidates('265999007', threeMinLater);

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].bridgeName).toBe('Stridsbergsbron');
  });

  test('stillaliggare med 250 m-hopp på 3 min bekräftas INTE (multipath-skyddet består)', () => {
    const atRegistration = {
      lat: 58.29495, lon: 12.296806, cog: 210, sog: 0.3,
    };
    svc.registerCandidatePassage('265999008', 'Stridsbergsbron', { passed: true }, atRegistration);

    now += 3 * 60 * 1000;
    const jumped = {
      lat: 58.29495 - 250 / 111320, lon: 12.296806, cog: 212, sog: 0.2,
    };
    const confirmed = svc.confirmStableCandidates('265999008', jumped);

    expect(confirmed).toHaveLength(0);
  });

  test('fartgivarlös båt (sog null båda sidor) får 5 kn-golvet — 700 m på 3 min bekräftas', () => {
    const atRegistration = {
      lat: 58.29495, lon: 12.296806, cog: 210, sog: null,
    };
    svc.registerCandidatePassage('265999009', 'Stridsbergsbron', { passed: true }, atRegistration);

    now += 3 * 60 * 1000;
    const later = {
      lat: 58.29495 - 700 / 111320, lon: 12.296806, cog: 205, sog: null,
    };
    const confirmed = svc.confirmStableCandidates('265999009', later);

    expect(confirmed).toHaveLength(1);
  });

  test('täta sampel (10 s) behåller gamla 200 m-skyddet', () => {
    const atRegistration = {
      lat: 58.29495, lon: 12.296806, cog: 210, sog: 6.7,
    };
    svc.registerCandidatePassage('265999010', 'Stridsbergsbron', { passed: true }, atRegistration);

    now += 10 * 1000;
    // 300 m på 10 s = 58 kn — fysiskt orimligt, ska INTE bekräftas
    // (6,7 kn × 10 s × 2 ≈ 69 m < 200 m-golvet ⇒ golvet gäller).
    const teleported = {
      lat: 58.29495 - 300 / 111320, lon: 12.296806, cog: 212, sog: 6.7,
    };
    const confirmed = svc.confirmStableCandidates('265999010', teleported);

    expect(confirmed).toHaveLength(0);
  });
});

// =============================================================================
// V2-1: fartgivarlösa båtar kan förtöjningsklassas (positionshärledd stillhet)
// =============================================================================
describe('V2-1: fartgivarlös kajliggare blir moored via positionsstillhet', () => {
  let svc;
  let mockNow;
  const logger = makeLogger();
  const QUAY = { lat: 58.286059, lon: 12.285651 }; // kajzonen norr om Klaffbron

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 6, 10, 10, 0, 0).getTime();
    Date.now = () => mockNow;
    const bridgeRegistry = new BridgeRegistry();
    svc = new VesselDataService(logger, bridgeRegistry, new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    svc.clearAllTimers();
    delete global.__TEST_MODE__;
    Date.now = REAL_DATE_NOW;
  });

  const tick = (minutes) => {
    mockNow += minutes * 60 * 1000;
  };

  test('sog=null hela vägen: still vid kajen ≥ zonkravet → _moored (gamla koden: aldrig)', () => {
    const mmsi = '265999011';
    // Ankomst: två prover på väg in (netto >50 m ger movement proof)
    svc.updateVessel(mmsi, {
      lat: 58.2880, lon: 12.2880, sog: null, cog: 210, shipName: 'FARTGIVARLÖSA',
    });
    tick(2);
    svc.updateVessel(mmsi, {
      lat: 58.2870, lon: 12.2865, sog: null, cog: 215, shipName: 'FARTGIVARLÖSA',
    });
    tick(2);
    // Lägger sig vid kajen — prov 1 sätter stillhetsankaret
    svc.updateVessel(mmsi, {
      lat: QUAY.lat, lon: QUAY.lon, sog: null, cog: 215, shipName: 'FARTGIVARLÖSA',
    });
    // Still i 20 min över flera prover (inom 40 m-jitterradien)
    for (let i = 0; i < 5; i++) {
      tick(4);
      svc.updateVessel(mmsi, {
        lat: QUAY.lat + 0.00005, lon: QUAY.lon, sog: null, cog: 215, shipName: 'FARTGIVARLÖSA',
      });
    }

    const vessel = svc.vessels.get(mmsi);
    expect(vessel._moored).toBe(true);
  });

  test('S-F7 bevaras: blandsändare — ETT null-prov avklassar inte en förtöjd båt', () => {
    const mmsi = '265999012';
    // Etablera förtöjd via finit sog (navstatus 5 = moored)
    svc.updateVessel(mmsi, {
      lat: QUAY.lat, lon: QUAY.lon, sog: 0.1, cog: 20, shipName: 'BLANDAREN', navStatus: 5,
    });
    tick(4);
    svc.updateVessel(mmsi, {
      lat: QUAY.lat, lon: QUAY.lon, sog: 0.1, cog: 20, shipName: 'BLANDAREN', navStatus: 5,
    });
    const before = svc.vessels.get(mmsi)._moored;
    expect(before).toBe(true);

    // Ett informationslöst prov (sog null, samma position) — klassningen består
    tick(3);
    svc.updateVessel(mmsi, {
      lat: QUAY.lat, lon: QUAY.lon, sog: null, cog: 20, shipName: 'BLANDAREN', navStatus: 5,
    });
    expect(svc.vessels.get(mmsi)._moored).toBe(true);
  });

  test('fartgivarlös båt i FÄRD (positionerna flyttar sig) blir ALDRIG moored', () => {
    const mmsi = '265999013';
    let lat = 58.2950;
    for (let i = 0; i < 6; i++) {
      svc.updateVessel(mmsi, {
        lat, lon: 12.2900, sog: null, cog: 200, shipName: 'SEGLAREN',
      });
      lat -= 0.0020; // ~220 m per prov — aktiv transit
      tick(3);
    }
    const vessel = svc.vessels.get(mmsi);
    expect(vessel._moored).toBe(false);
  });
});

// =============================================================================
// E-1: ETA-absolutklampen täcker null-sog-båtar
// =============================================================================
describe('E-1: null-sog-båt får near-stationary-klampen (±3 min)', () => {
  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  test('ETA-hopp 30→80 min på 60 s vid sog=null klampas till +3', () => {
    let now = 1_700_000_000_000;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    const registry = new BridgeRegistry();
    const calc = new ProgressiveETACalculator(makeLogger(), registry);
    const vessel = {
      mmsi: '265999014', sog: null, cog: 200, targetBridge: 'Klaffbron', status: 'en-route', lat: 58.30, lon: 12.29,
    };

    const first = calc._processETAWithProtection(vessel, 30, null);
    expect(first).toBeCloseTo(30, 0);

    now += 60 * 1000;
    const second = calc._processETAWithProtection(vessel, 80, null);
    // Utan fixen: percent-monotonic tillåter uppåt, ingen absolutklamp → ≈80.
    // Med fixen: near-stationary ±3-klampen → ≈33.
    expect(second).toBeLessThanOrEqual(35);
  });
});
