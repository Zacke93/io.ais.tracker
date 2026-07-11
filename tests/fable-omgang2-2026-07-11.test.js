'use strict';

jest.mock('homey');

/**
 * Fable-granskningen OMGÅNG 2 (2026-07-11, mot b17da05) — 16 granskare körde
 * exakt samma paketindelning som omgång 1 som VERIFIERING; ~31 unika fynd
 * (5 hittade av 2–4 oberoende granskare). Denna svit låser fixarna:
 *
 *   RE-CROSS (P2R2-1/-2, V2R2-1, A4R2-2 — gemensam rot): VDS:4030-skippet
 *     gjorde att en bro i passedBridges ALDRIG kunde ge nytt korsningsbevis,
 *     samtidigt som alla reset-vägar kräver target/finalDir/completed —
 *     klassen "mållös/oavslutad + vänd" (kajvändaren; U-sväng i kadensgap)
 *     fick hela returresan onotifierad. Nu: re-cross-bevis före skip →
 *     reversal + dedup-släpp + ordinarie registrering. GPS-SUSPECT-GATAD
 *     (echo-sampel fällde scenariobatteriet vid införandet).
 *   V1R2-1: sog-arvet (sticky finit) förgiftade mooring-maskineriet — ETT
 *     förirrat finit prov gjorde null-sog-grenen permanent oåtkomlig
 *     (evigt förtöjd ELLER aldrig förtöjd). Nu läser _updateMooringEvidence
 *     RÅ sampel-sog.
 *   GR2-1/DIVR2-1: stable-grenen saknade TTL-check — kandidat >20 min
 *     bekräftades i test/replay men var prod-raderad (C1-klassens divergens).
 *   GR2-2: konsumtionen (bekräfta/refutera) skippas på GPS-flaggade ticks —
 *     en outlier kunde annars refutera en ÄKTA kandidat permanent.
 *   GR2-4: kandidatregistrering ruttordningsvalideras (kringgicks helt).
 *   GR2-5: latch/validator föredrar korsningsbeviset över stale ruttlås.
 *   GR2-6: latch-/validatorsydbanden A1-1-harmoniserade (135–<315).
 *   SR2-1: S-3-spärrens släpp kräver passage EFTER spärrtidsstämpeln.
 *   BR2-1: CBM Regel 0 fick samma passedBridges-villkor som Regel 1
 *     (sätt/rensa-oscillationen på U-svängens returben, empiriskt
 *     reproducerad i omgång 2).
 *   A3R2-1/P1R2-3: exhausted-seedad imminent-flagga får INTE hysteres —
 *     B4/F10:s 90 s-tak äger 301–350 m-bandet igen.
 *   A3R2-2/-3: fallbackens räkning/bronamn/DEFAULT använder renderable-
 *     mängden (motorns filter), ETA-gaten enbart för variant1-omkallet.
 *   A4R2-1/A1R2-2/P2R2-3 (3×): Kanalinfarten behåller 15-min-flipgränsen
 *     (60-min-höjningen gällde BRO-returer; entry/exit är två notiser).
 *   A4R2-3: exit-fallbacken skippas vid reversal-motbevis (pending eller
 *     entydigt nordlig sista-kurs).
 *   A1R2-1: F5-B-radien använder maxRecentSpeed när sog=null (fartgivarlösa).
 *   SYSR2-1: _deleted-spärr på TRY-vägens addDevice (zombie efter radering
 *     mitt i onInit-awaits).
 *   A2R2-1/SYSR2-2/P1R2-2/DIVR2-2 (4×): sen-landande timeout-släppt
 *     skrivning nollar sentinelen vid settling.
 *   A2R2-3/P1R2-4: UI-cykelns DEFAULT gatas av feed-stall (P8-spegeln).
 *   DIVR2-3: trigger-rollbacken rör inte tillstånd en nyare notis skrivit.
 *   DIVR2-4: lat spegel av monitoring-prunen (orphan-nycklar).
 *   P2R2-4: flip-släppet behåller nyckeln när persistentgaten blockerar.
 *   ER2-1/-2: decay-golvet otakat; wait-clampen enbart äkta 'waiting'.
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const PassageLatchService = require('../lib/services/PassageLatchService');
const RouteOrderValidator = require('../lib/services/RouteOrderValidator');
const CurrentBridgeManager = require('../lib/services/CurrentBridgeManager');

const REAL_DATE_NOW = Date.now;
global.__TEST_MODE__ = true;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// =============================================================================
// RE-CROSS-familjen (P2R2-1/-2)
// =============================================================================
describe('RE-CROSS: bro i passedBridges kan ge nytt korsningsbevis', () => {
  let svc;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.app = {
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      gpsJumpGateService: null,
      passageLatchService: { registerPassage: jest.fn() },
      routeOrderValidator: { registerPassage: jest.fn(), validatePassageOrder: jest.fn(() => ({ valid: true })) },
    };
  });

  afterEach(() => {
    svc.clearAllTimers();
  });

  const JVB_LAT = 58.29164;

  test('mållös kajvändare: sydgående återkorsning av Jvb (i passedBridges) → reversal + journey-reset + ny registrering', () => {
    const resets = [];
    svc.on('vessel:journey-reset', (e) => resets.push(e));
    const vessel = {
      mmsi: '265992001',
      lat: JVB_LAT - 200 / 111320, // SÖDER om Jvb
      lon: 12.2939,
      sog: 4.5,
      cog: 195,
      targetBridge: null, // mållös (MOORED_DEMOTE rensade)
      _routeDirection: 'north', // STALE lås från nordresan
      passedBridges: ['Klaffbron', 'Järnvägsbron'],
      passedAt: {},
    };
    const oldVessel = {
      lat: JVB_LAT + 200 / 111320, // NORR om Jvb — segmentet korsar bron
      lon: 12.2939,
      sog: 4.5,
      cog: 195,
      lastPassedBridge: null,
    };

    svc._handleIntermediateBridgePassage(vessel, oldVessel);

    expect(vessel._routeDirection).toBe('south'); // reversalen låste om
    expect(resets.some((r) => Array.isArray(r.bridges) && r.bridges.includes('Järnvägsbron'))).toBe(true);
    expect(vessel.lastPassedBridge).toBe('Järnvägsbron'); // nya passagen registrerad
    expect(vessel.passedBridges).toContain('Järnvägsbron'); // återbokförd av registreringen
  });

  test('GPS-SUSPECT-GATEN: echo-flaggad tick ger INGEN reversal (scenariofällan)', () => {
    const vessel = {
      mmsi: '265992002',
      lat: JVB_LAT - 200 / 111320,
      lon: 12.2939,
      sog: 4.5,
      cog: 195,
      targetBridge: null,
      _routeDirection: 'north',
      _gpsJumpDetected: true, // ECHO
      passedBridges: ['Klaffbron', 'Järnvägsbron'],
      passedAt: {},
    };
    const oldVessel = {
      lat: JVB_LAT + 200 / 111320, lon: 12.2939, sog: 4.5, cog: 195,
    };

    svc._handleIntermediateBridgePassage(vessel, oldVessel);

    expect(vessel._routeDirection).toBe('north'); // orörd
    expect(vessel.passedBridges).toContain('Järnvägsbron'); // skip som förut
  });

  test('vobbel-skyddet: stillaliggare vid brolinjen (null-sog, <100 m segment) reverserar ALDRIG', () => {
    const vessel = {
      mmsi: '265992003',
      lat: JVB_LAT - 30 / 111320,
      lon: 12.2939,
      sog: null,
      cog: 200,
      targetBridge: null,
      _routeDirection: 'north',
      passedBridges: ['Järnvägsbron'],
      passedAt: {},
    };
    const oldVessel = {
      lat: JVB_LAT + 30 / 111320, lon: 12.2939, sog: null, cog: 20,
    };

    svc._handleIntermediateBridgePassage(vessel, oldVessel);

    expect(vessel._routeDirection).toBe('north');
  });
});

// =============================================================================
// V1R2-1: rå sampel-sog till mooring-maskineriet
// =============================================================================
describe('V1R2-1: sog-arvet förgiftar inte längre mooring-klassningen', () => {
  let svc;
  let mockNow;
  const QUAY = { lat: 58.286059, lon: 12.285651 };

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 6, 11, 8, 0, 0).getTime();
    Date.now = () => mockNow;
    svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.app = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  });

  afterEach(() => {
    svc.clearAllTimers();
    Date.now = REAL_DATE_NOW;
  });

  const tick = (min) => {
    mockNow += min * 60 * 1000;
  };

  test('förirrat finit 0,2 kn-prov hos fartgivarlös förtöjd → efterföljande null-rörelse SLÄPPER ändå', () => {
    const mmsi = '265992004';
    // Etablera förtöjning via 2h-backstopen (null-sog stillhet)
    svc.updateVessel(mmsi, {
      lat: QUAY.lat, lon: QUAY.lon, sog: null, cog: 210, shipName: 'BLANDSÄNDAREN',
    });
    for (let i = 0; i < 45; i++) {
      tick(3);
      svc.updateVessel(mmsi, {
        lat: QUAY.lat + 0.00004, lon: QUAY.lon, sog: null, cog: 210, shipName: 'BLANDSÄNDAREN',
      });
    }
    expect(svc.vessels.get(mmsi)._moored).toBe(true);

    // Det förirrade FINITA provet (0,2 kn — under STATIONARY-tröskeln)
    tick(3);
    svc.updateVessel(mmsi, {
      lat: QUAY.lat, lon: QUAY.lon, sog: 0.2, cog: 210, shipName: 'BLANDSÄNDAREN',
    });
    expect(svc.vessels.get(mmsi)._moored).toBe(true);

    // Avgång med enbart null-sog: gamla koden läste ärvda 0,2 (sticky) →
    // sampleStationary för evigt → aldrig släppt. Nu: rå null → positions-
    // ankaret ser ≥50 m-stegen → släpp.
    for (let i = 1; i <= 3; i++) {
      tick(3);
      svc.updateVessel(mmsi, {
        lat: QUAY.lat + i * 0.0014, lon: QUAY.lon, sog: null, cog: 20, shipName: 'BLANDSÄNDAREN',
      });
    }
    expect(svc.vessels.get(mmsi)._moored).toBe(false);
  });
});

// =============================================================================
// GR2-1 + GR2-2 + GR2-4: gate-kandidaternas livscykel
// =============================================================================
describe('GR2: kandidat-TTL, flaggade ticks och ordningsvalidering', () => {
  let now;
  let gate;

  beforeEach(() => {
    now = 1700000000000;
    Date.now = () => now;
    gate = new GPSJumpGateService(makeLogger(), null);
  });

  afterEach(() => {
    gate.destroy();
    Date.now = REAL_DATE_NOW;
  });

  test('GR2-1: kandidat äldre än 20 min bekräftas ALDRIG — även om fysiken säger "stabil"', () => {
    gate.registerCandidatePassage('265992005', 'Klaffbron', { passed: true }, {
      lat: 58.284, lon: 12.285, cog: 20, sog: 5.0,
    });
    now += 25 * 60 * 1000; // fysikfönstret @5 kn ≈ 7,7 km — allt är "stabilt"
    const confirmed = gate.confirmStableCandidates('265992005', {
      lat: 58.284 + 900 / 111320, lon: 12.285, cog: 22, sog: 5.0,
    });
    expect(confirmed).toHaveLength(0);
    expect(gate._candidatePassages.has('265992005')).toBe(false); // övergavs
  });

  test('GR2-2 (via app-lagret): flaggad tick skippar konsumtionen — kandidaten överlever till nästa rena sample', async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.proximityService = {
      analyzeVesselProximity: () => ({ nearestBridge: null, nearestDistance: 999, bridgeDistances: {} }),
      calculateProximityTimeout: () => 60000,
    };
    app.statusService = { analyzeVesselStatus: () => ({ status: 'en-route' }), calculateETA: () => null };
    app.vesselDataService = {
      setGpsJumpHold: jest.fn(), scheduleCleanup: jest.fn(), _handleTargetBridgeTransition: jest.fn(),
    };
    app.passageLatchService = { handleGPSJump: jest.fn() };
    app.routeOrderValidator = { clearVesselHistory: jest.fn() };
    app.gpsJumpGateService = { confirmStableCandidates: jest.fn(() => []), clearGate: jest.fn() };

    const vessel = {
      mmsi: '265992006', lat: 58.29, lon: 12.29, sog: 4, cog: 20, _gpsJumpDetected: true,
    };
    await app._analyzeVesselPosition(vessel);
    expect(app.gpsJumpGateService.confirmStableCandidates).not.toHaveBeenCalled();

    vessel._gpsJumpDetected = false;
    await app._analyzeVesselPosition(vessel);
    expect(app.gpsJumpGateService.confirmStableCandidates).toHaveBeenCalledTimes(1);
  });

  test('GR2-4: kandidat med ogiltig ruttordning registreras INTE', () => {
    const svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.app = {
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      gpsJumpGateService: {
        shouldBlockPassageDetection: () => true,
        registerCandidatePassage: jest.fn(),
      },
      routeOrderValidator: {
        validatePassageOrder: jest.fn(() => ({ valid: false, reason: 'backwards_sequence' })),
      },
      passageLatchService: null,
    };
    const JVB = 58.29164;
    const vessel = {
      mmsi: '265992007',
      lat: JVB - 150 / 111320,
      lon: 12.2939,
      sog: 4,
      cog: 200,
      targetBridge: null,
      _routeDirection: 'south',
      passedBridges: [],
      passedAt: {},
    };
    const oldVessel = {
      lat: JVB + 150 / 111320, lon: 12.2939, sog: 4, cog: 200,
    };

    const bridge = svc.bridgeRegistry.getBridgeByName('Järnvägsbron');
    const result = svc._hasPassedBridge(vessel, oldVessel, bridge);

    expect(result).toBe(false);
    expect(svc.app.gpsJumpGateService.registerCandidatePassage).not.toHaveBeenCalled();
    svc.clearAllTimers();
  });
});

// =============================================================================
// GR2-5 + GR2-6: riktningsbeviset i latch/validator + breddade sydband
// =============================================================================
describe('GR2-5/GR2-6: evidensriktning och A1-1-harmoniserade band', () => {
  test('GR2-5: validatorhistoriken föredrar evidencedDir över stale ruttlås', () => {
    const v = new RouteOrderValidator(makeLogger(), new BridgeRegistry());
    v.registerPassage('265992008', 'Klaffbron', {
      cog: 20, sog: 4, lat: 58.284, lon: 12.284, _routeDirection: 'north',
    }, 'south'); // korsningsbeviset säger SÖDER
    expect(v._vesselPassageHistory.get('265992008')[0].direction).toBe('south');
  });

  test('GR2-6: SV-kurs 250° är sydlig i både latch och validator', () => {
    const latch = new PassageLatchService(makeLogger());
    const v = new RouteOrderValidator(makeLogger(), new BridgeRegistry());
    expect(latch._directionFromCog(250)).toBe('south');
    expect(v._determineDirection(250)).toBe('south');
    // Nordbandet orört
    expect(latch._directionFromCog(20)).toBe('north');
    expect(v._determineDirection(90)).toBeNull(); // NO-kröken fortsatt tvetydig
  });
});

// =============================================================================
// SR2-1: spärrsläppet kräver passage EFTER spärrtiden
// =============================================================================
describe('SR2-1: under-bridge-spärren är inte retroaktiv', () => {
  test('historisk lastPassedBridge (före spärren) släpper INTE; ny passage gör det', () => {
    const StatusService = require('../lib/services/StatusService');
    const registry = new BridgeRegistry();
    const statusService = new StatusService(registry, makeLogger(), new SystemCoordinator(makeLogger()), null);
    const KLAFF = registry.getBridgeByName('Klaffbron');
    const now = Date.now();
    const vessel = {
      mmsi: '265992009',
      lat: KLAFF.lat + 40 / 111320, // 40 m — inom SET-zonen
      lon: KLAFF.lon,
      sog: 0,
      cog: 20,
      targetBridge: 'Klaffbron',
      currentBridge: 'Klaffbron',
      distanceToCurrent: 40,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: now - 60 * 60 * 1000, // passage för 1h sedan
      _underBridgeTimeoutBlockedBridge: 'Klaffbron',
      _underBridgeTimeoutBlockedAt: now - 10 * 1000, // spärrad nyss
      passedBridges: ['Klaffbron'],
    };

    // Historisk passage: spärren SKA bestå → ingen om-latchning
    const under = statusService._isUnderBridge(vessel);
    expect(under).toBe(false);
    expect(vessel._underBridgeTimeoutBlockedBridge).toBe('Klaffbron');

    // NY passage (efter spärrtiden) → släpp
    vessel.lastPassedBridgeTime = now + 1000;
    statusService._isUnderBridge(vessel);
    expect(vessel._underBridgeTimeoutBlockedBridge).toBeNull();
  });
});

// =============================================================================
// BR2-1: Regel 0-oscillationen stängd
// =============================================================================
describe('BR2-1: currentBridge stabil på U-svängens returben', () => {
  test('lastPassedBridge satt men bron EJ i passedBridges → Regel 0 rensar inte det Regel 1 satte', () => {
    const registry = new BridgeRegistry();
    const cbm = new CurrentBridgeManager(registry, makeLogger());
    const vessel = {
      mmsi: '265992010',
      lastPassedBridge: 'Järnvägsbron',
      passedBridges: [], // reversalen rensade
      currentBridge: null,
      distanceToCurrent: null,
    };
    const prox = (dist) => ({
      nearestBridge: { name: 'Järnvägsbron', distance: dist },
      bridges: [{ name: 'Järnvägsbron', distance: dist }],
      bridgeDistances: { jarnvagsbron: dist },
    });

    // Fem tickar genom 450→250 m — ska sätta och BEHÅLLA
    const seen = [];
    for (const d of [450, 400, 350, 300, 250]) {
      cbm.updateCurrentBridge(vessel, prox(d));
      seen.push(vessel.currentBridge);
    }
    expect(seen).toEqual(Array(5).fill('Järnvägsbron')); // ingen oscillation
  });
});

// =============================================================================
// A3R2-1: exhausted-seedad imminent utan hysteres
// =============================================================================
describe('A3R2-1: 90s-taket äger 301–350 m-bandet', () => {
  test('exhausted-SET på 340 m + nästa tick efter 91 s → flaggan FALLER (ingen hysteres-återsättning)', () => {
    let mockNow = 1700000000000;
    Date.now = () => mockNow;
    try {
      const app = new AISBridgeApp();
      app.log = jest.fn();
      app.debug = jest.fn();
      app.error = jest.fn();
      app.bridgeRegistry = new BridgeRegistry();
      app.proximityService = { analyzeVesselProximity: () => ({ nearestBridge: null, nearestDistance: 999, bridgeDistances: {} }) };
      app.statusService = { analyzeVesselStatus: jest.fn(() => ({ status: 'en-route' })) };
      const KLAFF = app.bridgeRegistry.getBridgeByName('Klaffbron');
      const vessel = {
        mmsi: '265992011',
        lat: KLAFF.lat + 340 / 111320,
        lon: KLAFF.lon,
        sog: 4,
        cog: 200,
        status: 'en-route',
        targetBridge: 'Klaffbron',
        timestamp: mockNow - 6 * 60 * 1000,
        lastPositionUpdate: mockNow - 6 * 60 * 1000,
        _etaExtrapolationExhausted: true,
        _etaExhaustedAtMs: mockNow - 10 * 1000, // uttömd för 10 s sedan
      };
      app.vesselDataService = { getAllVessels: () => [vessel], hasGpsJumpHold: () => false };

      app._reevaluateVesselStatuses();
      expect(vessel._isImminentAtTargetBridge).toBe(true); // inom 90 s-fönstret
      expect(vessel._imminentFromExhausted).toBe(true);

      mockNow += 91 * 1000; // 90s-taket passerat
      app._reevaluateVesselStatuses();
      expect(vessel._isImminentAtTargetBridge).toBe(false); // gamla koden: true till HARD
    } finally {
      Date.now = REAL_DATE_NOW;
    }
  });
});

// =============================================================================
// A4R2-1 (3×): Kanalinfarten-flipgränsen 15 min
// =============================================================================
describe('A4R2-1: retroaktivgaten — 15 min för Kanalinfarten, 60 för broar', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._persistentRecentTriggers = new Map();
    return app;
  };

  test('Kanalinfarten-flip vid 45 min ålder → SLÄPPS (rundtursklassen)', () => {
    const app = makeApp();
    app._persistentRecentTriggers.set('1:Kanalinfarten', { t: Date.now() - 45 * 60 * 1000, dir: 'north' });
    const vessel = {
      mmsi: '1', sog: 5, cog: 200, _routeDirection: 'south',
    };
    const res = app._persistentDedupCheck('1:Kanalinfarten', vessel, { retroactiveSource: true });
    expect(res.blocked).toBe(false);
  });

  test('bro-flip vid 45 min ålder → fortsatt BLOCKERAD (A4-2-kalibreringen)', () => {
    const app = makeApp();
    app._persistentRecentTriggers.set('1:Järnvägsbron', { t: Date.now() - 45 * 60 * 1000, dir: 'north' });
    const vessel = {
      mmsi: '1', sog: 5, cog: 200, _routeDirection: 'south',
    };
    const res = app._persistentDedupCheck('1:Järnvägsbron', vessel, { retroactiveSource: true });
    expect(res.blocked).toBe(true);
  });
});

// =============================================================================
// A4R2-2 + DIVR2-4 + P2R2-4: expired-gaternas nya släpp/spärrar
// =============================================================================
describe('Expired-gaterna: freshlyRecrossed, orphan-spegeln och flip-behållning', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._persistRecentTriggers = jest.fn();
    app._getDirectionString = jest.fn(() => 'söderut');
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
    return app;
  };
  const candidate = {
    name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'passage-fallback',
  };

  test('A4R2-2: FÄRSK återkorsning (passedBridges + stämpel <2 min) → expired-släppet ÖPPNAR', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265992012:Klaffbron');
    const vessel = {
      mmsi: '265992012',
      name: 'ÅTERKORSAREN',
      sog: 4.0,
      cog: 200,
      etaMinutes: 2,
      _routeDirection: 'south',
      passedBridges: ['Klaffbron'],
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 30 * 1000,
      _trackingEpisodeStartTs: Date.now() - 4 * 60 * 60 * 1000,
    };
    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('#44-gaten består: GAMMAL stämpel (2h21) + passedBridges → HOLD (PILOT-resume)', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265992013:Klaffbron');
    const vessel = {
      mmsi: '265992013',
      name: 'PILOTEN',
      sog: 5.0,
      cog: 200,
      etaMinutes: 2,
      _routeDirection: 'south',
      passedBridges: ['Klaffbron'],
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 141 * 60 * 1000,
      _trackingEpisodeStartTs: Date.now() - 4 * 60 * 60 * 1000,
    };
    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
  });

  test('DIVR2-4: orphan-nyckel (episoden yngre än postens utgång) behandlas som frånvarande', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265992014:Klaffbron');
    // Posten är 3h gammal (utgången); episoden började för 20 min sedan
    app._persistentRecentTriggers.set('265992014:Klaffbron', { t: Date.now() - 3 * 60 * 60 * 1000, dir: 'north' });
    const vessel = {
      mmsi: '265992014',
      name: 'FARTGIVARLÖSA RETUREN',
      sog: null, // fartgivarlös — expired-gatens movingNow hade blockerat!
      cog: 200,
      etaMinutes: 4,
      _routeDirection: 'south',
      _hasMovementProof: true,
      passedBridges: [],
      _trackingEpisodeStartTs: Date.now() - 20 * 60 * 1000,
    };
    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    // Nyckeln orphan-raderad → ren väg → notisen avfyras (prod-beteendet)
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('DEDUPE_ORPHAN'))).toBe(true);
  });

  test('P2R2-4: flip som blockeras av persistentgaten behåller sessionsnyckeln', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265992015:Klaffbron');
    // FÄRSK post (30 min) med motsatt riktning + retroaktiv källa → gaten blockerar
    app._persistentRecentTriggers.set('265992015:Klaffbron', { t: Date.now() - 30 * 60 * 1000, dir: 'north' });
    const vessel = {
      mmsi: '265992015',
      name: 'VOBBLAREN',
      sog: 5,
      cog: 200,
      etaMinutes: 3,
      _routeDirection: 'south',
      passedBridges: [],
      _trackingEpisodeStartTs: Date.now() - 2 * 60 * 60 * 1000,
    };
    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has('265992015:Klaffbron')).toBe(true); // nyckeln KVAR
  });
});

// =============================================================================
// A4R2-3 + A1R2-1: exit-vakterna
// =============================================================================
describe('Exit-fallbacken: reversal-motbevis och fartgivarlös-radien', () => {
  const KANAL = { lat: 58.268, lon: 12.2693 };

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

  test('A1R2-1: fartgivarlös (sog=null) med maxRecentSpeed 5,2 → utökade radien gäller (546 m)', async () => {
    const app = makeApp();
    const snapshot = {
      mmsi: '265992016',
      name: 'FARTGIVARLÖSA EXITEN',
      lat: KANAL.lat + 546 / 111320,
      lon: KANAL.lon,
      sog: null,
      cog: 213,
      maxRecentSpeed: 5.2,
      _moored: false,
      _hasMovementProof: true,
      _routeDirection: 'south',
      passedBridges: ['Olidebron'],
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
      _lastSeen: Date.now(),
    };
    await app._triggerExitPointFallback(snapshot);
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledWith(
      expect.objectContaining({ mmsi: '265992016' }), 'Kanalinfarten',
      expect.objectContaining({ detectionTs: expect.any(Number) }),
    );
  });

  test('A4R2-3: nordlig sista-kurs (20°) → removal-gaten skippar exit-anropet', async () => {
    const app = makeApp();
    app._triggerExitPointFallback = jest.fn();
    app.statusService = {
      statusStabilizer: { removeVessel: jest.fn() },
      clearVesselETAHistory: jest.fn(),
    };
    app.bridgeTextService = { clearVesselPhaseTracking: jest.fn() };
    app.vesselDataService = { getVesselCount: () => 1, getAllVessels: () => [] };
    app._clearBoatNearTriggers = jest.fn();
    app._updateUI = jest.fn();
    app._processingRemoval = new Set();
    app._vesselRemovalTimers = new Map();
    app._skippedBridgesSweepSeen = new Map();
    app._isConnected = true;
    app.aisClient = { getConnectionStats: () => ({ timeSinceLastMessage: 1000 }) };

    await app._onVesselRemoved({
      mmsi: '265992017',
      reason: 'timeout',
      vessel: {
        mmsi: '265992017',
        lat: KANAL.lat + 300 / 111320,
        lon: KANAL.lon,
        sog: 4,
        cog: 20, // NORDLIG — U-sväng osedd
        _routeDirection: 'south',
        _finalTargetDirection: 'south',
        _finalTargetBridge: 'Klaffbron',
        passedBridges: ['Olidebron'],
        timestamp: Date.now(),
        lastPositionUpdate: Date.now(),
      },
    });
    expect(app._triggerExitPointFallback).not.toHaveBeenCalled();
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('EXIT_TRIGGER_SKIP_REVERSAL'))).toBe(true);
  });

  test('A1R2-3 (alt. 1): tom passedBridges men avfyrad Olidebron-notis → exit-anropet körs (scenario A-klassen)', async () => {
    const app = makeApp();
    app._triggerExitPointFallback = jest.fn();
    app.statusService = {
      statusStabilizer: { removeVessel: jest.fn() },
      clearVesselETAHistory: jest.fn(),
    };
    app.bridgeTextService = { clearVesselPhaseTracking: jest.fn() };
    app.vesselDataService = { getVesselCount: () => 1, getAllVessels: () => [] };
    app._clearBoatNearTriggers = jest.fn();
    app._updateUI = jest.fn();
    app._processingRemoval = new Set();
    app._vesselRemovalTimers = new Map();
    app._skippedBridgesSweepSeen = new Map();
    app._isConnected = true;
    app.aisClient = { getConnectionStats: () => ({ timeSinceLastMessage: 1000 }) };
    // Svepets scenario A notifierade Olidebron (inferredFlush) UTAN bokföring
    app._triggeredBoatNearKeys.add('265992020:Olidebron');

    const snapshot = {
      mmsi: '265992020',
      lat: KANAL.lat + 350 / 111320,
      lon: KANAL.lon,
      sog: 4,
      cog: 210, // sydlig — inga motbevis
      _routeDirection: 'south',
      _finalTargetDirection: null,
      passedBridges: [], // TOM — svepet bokför inte
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
    };
    await app._onVesselRemoved({ mmsi: '265992020', reason: 'timeout', vessel: snapshot });
    expect(app._triggerExitPointFallback).toHaveBeenCalledTimes(1);
  });

  test('A1R2-3-negativ: tom passedBridges + ENDAST Kanalinfarten-nyckel → gaten fäller (dök-bara-upp-klassen)', async () => {
    const app = makeApp();
    app._triggerExitPointFallback = jest.fn();
    app.statusService = {
      statusStabilizer: { removeVessel: jest.fn() },
      clearVesselETAHistory: jest.fn(),
    };
    app.bridgeTextService = { clearVesselPhaseTracking: jest.fn() };
    app.vesselDataService = { getVesselCount: () => 1, getAllVessels: () => [] };
    app._clearBoatNearTriggers = jest.fn();
    app._updateUI = jest.fn();
    app._processingRemoval = new Set();
    app._vesselRemovalTimers = new Map();
    app._skippedBridgesSweepSeen = new Map();
    app._isConnected = true;
    app.aisClient = { getConnectionStats: () => ({ timeSinceLastMessage: 1000 }) };
    // Endast entry-notisen vid punkten — inget transitbevis
    app._triggeredBoatNearKeys.add('265992021:Kanalinfarten');

    await app._onVesselRemoved({
      mmsi: '265992021',
      reason: 'timeout',
      vessel: {
        mmsi: '265992021',
        lat: KANAL.lat + 350 / 111320,
        lon: KANAL.lon,
        sog: 4,
        cog: 210,
        _routeDirection: 'south',
        _finalTargetDirection: null,
        passedBridges: [],
        timestamp: Date.now(),
        lastPositionUpdate: Date.now(),
      },
    });
    expect(app._triggerExitPointFallback).not.toHaveBeenCalled();
  });
});

// =============================================================================
// A2R2-1 (4×) + A2R2-3 (2×): publiceringsvägens läkning
// =============================================================================
describe('Publiceringsvägen: sen landning och feed-stall-guarden', () => {
  const flush = () => new Promise((resolve) => {
    setImmediate(resolve);
  });

  test('A2R2-1: timeout-släppt skrivning som landar SENT med success → sentinelen nollas igen', async () => {
    jest.useFakeTimers();
    try {
      const app = new AISBridgeApp();
      app.log = jest.fn();
      app.debug = jest.fn();
      app.error = jest.fn();
      app._devices = new Set();
      let releaseWrite;
      const hang = new Promise((resolve) => {
        releaseWrite = resolve;
      });
      app._devices.add({
        getName: () => 'ENHET',
        setCapabilityValue: () => hang, // hänger tills släppt
      });

      const race = app._writeCapabilityWithTimeout('bridge_text', 'text A');
      jest.advanceTimersByTime(31 * 1000); // timeout fyrar → sentinel null
      await race;
      expect(app._lastBridgeTextHash).toBeNull();

      app._lastBridgeTextHash = 'hash-B'; // nyare skrivning satte ny hash
      releaseWrite(); // A landar SENT med success
      // Flush hela mikrotask-kedjan (per-device .then → Promise.all →
      // guarded.then — flera nivåer)
      for (let i = 0; i < 10; i++) await Promise.resolve(); // eslint-disable-line no-await-in-loop
      expect(app._lastBridgeTextHash).toBeNull(); // sen landning → nollad igen
      expect(app.error.mock.calls.some((c) => String(c[0]).includes('LATE_LANDING'))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('A2R2-3: 0 båtar + döv feed → DEFAULT ersätts av senaste texten (P8-spegeln)', async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._devices = new Set();
    app._isConnected = true; // ansluten-men-döv
    app.aisClient = { getConnectionStats: () => ({ timeSinceLastMessage: 6 * 60 * 1000 }) };
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
    app._lastBridgeTextHash = 'x';
    app.bridgeTextService = { generateBridgeText: () => 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron' };
    app._validateBridgeTextSummary = () => ({ isValid: true });
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app._globalBridgeTextToken = { setValue: jest.fn().mockResolvedValue(undefined) };

    const result = await app._processUIUpdate({
      vesselCount: 0, relevantVessels: [], vesselsBeingRemoved: new Set(),
    });
    await flush();
    expect(result.bridgeText).toBe('En båt på väg mot Klaffbron, beräknad broöppning strax');
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('UI_FEED_STALE_GUARD'))).toBe(true);
  });
});

// =============================================================================
// DIVR2-3: rollbacken rör inte nyare tillstånd
// =============================================================================
describe('DIVR2-3: trigger-rollback endast av eget tillstånd', () => {
  test('nyare post skriven under awaiten → rollback skippas', async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._persistRecentTriggers = jest.fn();
    app._getDirectionString = jest.fn(() => 'norrut');
    const newerEntry = { t: Date.now(), dir: 'north' };
    app._triggerBoatNearFlowBest = jest.fn().mockImplementation(async () => {
      // under awaiten: en NYARE notis skriver om tillståndet
      app._persistentRecentTriggers.set('265992018:Klaffbron', newerEntry);
      app._triggeredBoatNearKeys.add('265992018:Klaffbron');
      throw new Error('trigger failed');
    });
    const vessel = {
      mmsi: '265992018', name: 'X', sog: 4, cog: 20, etaMinutes: 3, _routeDirection: 'north', passedBridges: [],
    };
    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'target',
    });
    // Rollbacken får INTE ha klobbat nyare posten/nyckeln
    expect(app._persistentRecentTriggers.get('265992018:Klaffbron')).toBe(newerEntry);
    expect(app._triggeredBoatNearKeys.has('265992018:Klaffbron')).toBe(true);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('ROLLBACK_SKIPPED'))).toBe(true);
  });
});

// =============================================================================
// SYSR2-1: try-vägens _deleted-spärr
// =============================================================================
describe('SYSR2-1: radering under onInit-awaits ger ingen zombie', () => {
  test('_deleted satt efter _ensureAppReady → addDevice körs aldrig', async () => {
    const BridgeStatusDevice = require('../drivers/bridge_status/device');
    const device = Object.create(BridgeStatusDevice.prototype);
    device.log = jest.fn();
    device.error = jest.fn();
    const addDevice = jest.fn();
    device.homey = { app: { _devices: new Set(), addDevice, _lastBridgeText: null } };
    device._ensureAppReady = jest.fn().mockImplementation(async () => {
      device._deleted = true; // onDeleted hann köra under awaiten
      return true;
    });
    device.hasCapability = jest.fn(() => true);
    device.setCapabilityValue = jest.fn().mockResolvedValue(undefined);
    device.setStoreValue = jest.fn().mockResolvedValue(undefined);

    await device.onInit();

    expect(addDevice).not.toHaveBeenCalled();
    expect(device.setCapabilityValue).not.toHaveBeenCalled();
  });
});

// =============================================================================
// ER2-1: decay-golvet otakat
// =============================================================================
describe('ER2-1: idle-decayns distansgolv följer fysiken över 12 min', () => {
  test('stallbacka-avstånd 2400 m → golvet ≈19,5 min (inte 12)', () => {
    const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
    const calc = new ProgressiveETACalculator(makeLogger(), new BridgeRegistry());
    const mmsi = '265992019';
    const now = Date.now();
    calc._recordETAHistory(mmsi, {
      rawETA: 21,
      protectedETA: 21,
      processedETA: 21,
      timestamp: now - 2 * 60 * 1000,
      targetBridge: 'Stridsbergsbron',
      nearestBridge: null,
      vesselSpeed: 0.4,
      distance: 250,
      distanceToTarget: 2400,
      vesselStatus: 'stallbacka-waiting',
    });
    const vessel = { mmsi, status: 'stallbacka-waiting', sog: 0.4 };
    const result = calc._applyIdleDecay(vessel, 21, calc._etaHistory.get(mmsi), now, 2400);
    // decay: 21 - 2 = 19; golv = 2400/123 ≈ 19,5 → golvet vinner (>12!)
    expect(result).toBeGreaterThan(15);
  });
});
