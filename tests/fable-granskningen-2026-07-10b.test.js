'use strict';

jest.mock('homey');

/**
 * Fable-granskningen 2026-07-10b — 16 Fable 5-granskare (13 delsystempaket +
 * 3 tvärgående: pelare 1-kedjan, pelare 2-kedjan, test/prod-divergens+racen);
 * varje fynd dirigentverifierat mot koden/rådata före fix. Denna svit låser
 * de fixar som inte redan täcks av omlåsta enhetstester, scenario #44,
 * comprehensive-goldens eller korpusgaterna:
 *
 *   V1-1  — (KRITISK, regression från V2-1/b9d4b15) null-sog-grenens
 *           rörelseväg returnerade FÖRE _classifyMooring — enda stället
 *           _moored=false skrivs. En fartgivarlös båt som förtöjts var
 *           förtöjd för evigt: ingen målbro, ingen text, noll notiser under
 *           hela avresan + falska kajkarteposter längs rutten.
 *   V1-4  — 40–49 m-bandet (utanför jitterradien 40, under rörelsebeviset
 *           50) flyttade ankaret men behöll stillhetsklockan → kryp-kön
 *           ackumulerade "stillhet" över bevisade förflyttningar.
 *   V2-1b — FIX Z-NORDSPEGELN: partiell NORDresa (TARGET_END Strids utan
 *           Klaffbron i passedBridges) + U-sväng söderut fick ny målbro via
 *           ACCELERATED i SAMMA tick som sydkursen sågs — före NEW_JOURNEY
 *           (kräver target=null). Stale _finalTargetDirection='north' gav
 *           sedan target=Stridsbergsbron BAKOM den sydgående båten och
 *           returpassagerna blev onotifierade.
 *   G-1   — SIDOKONTRAKTET: GJ-1-fysikens fönster växer linjärt med
 *           kandidatens ålder medan en falsk kandidats offset (snapshot =
 *           hopp-position, båten kvar) är konstant → varje falsk kandidat
 *           "stabiliserades" inom C1:s 20-min-TTL → falsk målbrotransition.
 *           En bekräftad kandidat vars fartyg ligger ENTYDIGT på motsatt
 *           sida brolinjen mot snapshotten är motbevisad och droppas.
 *   G-2   — ensidig sog=null fick 1 kn-golvet i _isVesselStable (GJ-2
 *           fixade exakt klassen i analyzern) → äkta passage hos avgående
 *           väntare med null-svit övergavs.
 *   G-4   — latch-reversalens pending räknade ANROP: waiting+approaching i
 *           samma tick (samma cog) bekräftade varandra på ETT brusigt
 *           sampel, medan gles Class B-kadens (>2 min) aldrig kunde
 *           bekräfta alls (F13-releasen död). Nu sampelbaserad (sampleTs)
 *           med 20-min-fönster.
 *   G-5   — RouteOrderValidator-historiken lagrade momentan cog-riktning
 *           (null i tvetydiga band) → vändningsundantaget för sammabro-
 *           retur dödades. Nu samma fallbackkedja som latchen.
 *   S-1   — StatusStabilizern förbigicks av timer-/snapshotvägen
 *           (analyzeVesselStatus utan positionAnalysis + ovillkorlig
 *           statusskrivning) → GPS-/osäkerhetshold revs inom ≤30 s.
 *   P2-1  — N2-reentry-resetten rensade dedup positionsblint: bro
 *           notifierad UNDER 10-min-cooldownen (nya benet) fick sina
 *           nycklar raderade medan båten stod kvar i 300 m-zonen →
 *           dubblett för samma fysiska passage. Nu bevaras färska poster.
 *   A2-1  — alarm_generic/connection_status hade cache-före-skrivning utan
 *           C4a-läkning: misslyckad skrivning + värde-dedup frös enheten på
 *           fel värde tills nästa äkta värdeväxling. Nu null-sentinel.
 *   P1-1b — synkrona kast ur setCapabilityValue sattes inte anyRejected →
 *           självläkningen såg aldrig felet.
 *   A1-1  — kajkartans TTL-förnyelse persisterade settings per AIS-
 *           meddelande från förtöjd båt (~480 skrivningar/dygn/kajliggare).
 *           Nu 24h-guard (namncachens beprövade mall).
 *   #44   — (LATENT sedan C3, avslöjad av scenario #44 mot baslinjen):
 *           expired-släppet öppnade för en båt som PASSERAT bron på
 *           innevarande resa, parkerat >2h och sedan återupptagit färden
 *           BORT från bron → fantomnotis. Ny gate: bro i passedBridges
 *           släpps aldrig via expired-vägen (ny resa = journey-reset).
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const PassageLatchService = require('../lib/services/PassageLatchService');
const RouteOrderValidator = require('../lib/services/RouteOrderValidator');
const geometry = require('../lib/utils/geometry');

const REAL_DATE_NOW = Date.now;
global.__TEST_MODE__ = true;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

const KLAFFBRON = { lat: 58.28409551, lon: 12.28393243 };

// =============================================================================
// V1-1 + V1-4: null-sog-grenens rörelseväg släpper förtöjningen
// =============================================================================
describe('V1-1/V1-4: fartgivarlös förtöjd båt släpps vid bevisad avgång', () => {
  let svc;
  let mockNow;
  const QUAY = { lat: 58.286059, lon: 12.285651 };

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 6, 10, 10, 0, 0).getTime();
    Date.now = () => mockNow;
    svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
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
    Date.now = REAL_DATE_NOW;
  });

  const tick = (minutes) => {
    mockNow += minutes * 60 * 1000;
  };

  const mooredNullSogVessel = (mmsi) => {
    // Etablera förtöjning: still vid kajen >2h (backstopen)
    svc.updateVessel(mmsi, {
      lat: QUAY.lat, lon: QUAY.lon, sog: null, cog: 215, shipName: 'NULLSOG',
    });
    for (let i = 0; i < 45; i++) {
      tick(3);
      svc.updateVessel(mmsi, {
        lat: QUAY.lat + 0.00005, lon: QUAY.lon, sog: null, cog: 215, shipName: 'NULLSOG',
      });
    }
    return svc.vessels.get(mmsi);
  };

  test('V1-1: bevisad förflyttning (≥50 m netto) släpper _moored — gamla koden: förtöjd för evigt', () => {
    let vessel = mooredNullSogVessel('265991001');
    expect(vessel._moored).toBe(true);

    // Avgång: varje sample flyttar ~150 m — rörelsegrenen tas varje tick
    for (let i = 1; i <= 3; i++) {
      tick(3);
      svc.updateVessel('265991001', {
        lat: QUAY.lat + i * 0.00135, lon: QUAY.lon, sog: null, cog: 20, shipName: 'NULLSOG',
      });
    }
    vessel = svc.vessels.get('265991001');
    expect(vessel._moored).toBe(false);
  });

  test('V1-4: 40–49 m-steg nollställer stillhetsklockan men rör INTE klassningen', () => {
    let vessel = mooredNullSogVessel('265991002');
    expect(vessel._moored).toBe(true);

    // 45 m-steg: utanför jitterradien (40) men under rörelsebeviset (50)
    tick(3);
    svc.updateVessel('265991002', {
      lat: QUAY.lat + 0.0004, lon: QUAY.lon, sog: null, cog: 215, shipName: 'NULLSOG',
    });
    vessel = svc.vessels.get('265991002');
    expect(vessel._moored).toBe(true); // släpp kräver fullt rörelsebevis
    expect(vessel._stationarySince).toBeNull(); // men klockan börjar om
  });
});

// =============================================================================
// V2-1b: FIX Z-nordspegeln
// =============================================================================
describe('V2-1b: FIX Z-nordspegeln stoppar ACCELERATED-target efter nordavslutad resa', () => {
  let svc;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.app = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  });

  afterEach(() => {
    svc.clearAllTimers();
  });

  test('partiell nordresa (Strids passerad, Klaffbron EJ) + rak sydkurs → INGEN målbro (NEW_JOURNEY äger)', () => {
    // U-svängd retur norr om Stridsbergsbron med rak sydkurs i marschfart —
    // gamla koden gav target='Klaffbron' i samma tick (före NEW_JOURNEY).
    const vessel = {
      mmsi: '265991003',
      lat: 58.2960,
      lon: 12.2945,
      cog: 190,
      sog: 4.0,
      _finalTargetDirection: 'north',
      _finalTargetBridge: 'Stridsbergsbron',
      passedBridges: ['Järnvägsbron', 'Stridsbergsbron'],
      _routeDirection: 'north',
    };
    expect(svc._calculateTargetBridge(vessel)).toBeNull();
  });

  test('kontroll: samma läge UTAN nordavslut (ingen _finalTargetDirection) får sydlig målbro som förut', () => {
    const vessel = {
      mmsi: '265991004',
      lat: 58.2960,
      lon: 12.2945,
      cog: 190,
      sog: 4.0,
      _finalTargetDirection: null,
      passedBridges: [],
      _routeDirection: null,
    };
    expect(svc._calculateTargetBridge(vessel)).toBe('Stridsbergsbron');
  });
});

// =============================================================================
// G-1: sidokontraktet
// =============================================================================
describe('G-1: sidokontraktet motbeviser falska gate-kandidater', () => {
  const bridge = { lat: KLAFFBRON.lat, lon: KLAFFBRON.lon, axisBearing: 130 };
  const M = 1 / 111320; // ≈ grader per meter i lat

  test('isDecisivelyOppositeBridgeSide: entydigt motsatta sidor → true', () => {
    const north = { lat: KLAFFBRON.lat + 200 * M, lon: KLAFFBRON.lon };
    const south = { lat: KLAFFBRON.lat - 200 * M, lon: KLAFFBRON.lon };
    expect(geometry.isDecisivelyOppositeBridgeSide(north, south, bridge)).toBe(true);
  });

  test('isDecisivelyOppositeBridgeSide: samma sida / på linjen → false (oavgörbart blockerar inte)', () => {
    const a = { lat: KLAFFBRON.lat + 200 * M, lon: KLAFFBRON.lon };
    const b = { lat: KLAFFBRON.lat + 400 * M, lon: KLAFFBRON.lon };
    const onLine = { lat: KLAFFBRON.lat + 3 * M, lon: KLAFFBRON.lon };
    expect(geometry.isDecisivelyOppositeBridgeSide(a, b, bridge)).toBe(false);
    expect(geometry.isDecisivelyOppositeBridgeSide(a, onLine, bridge)).toBe(false);
  });

  describe('STEG 5-konsumtionen droppar motbevisad kandidat', () => {
    let app;

    beforeEach(() => {
      app = new AISBridgeApp();
      app.log = jest.fn();
      app.debug = jest.fn();
      app.error = jest.fn();
      app.bridgeRegistry = new BridgeRegistry();
      app.proximityService = {
        analyzeVesselProximity: () => ({ nearestBridge: null, nearestDistance: 1234, bridgeDistances: {} }),
        calculateProximityTimeout: () => 60000,
      };
      app.statusService = {
        analyzeVesselStatus: () => ({ status: 'en-route' }),
        calculateETA: () => null,
      };
      app.vesselDataService = {
        setGpsJumpHold: jest.fn(),
        scheduleCleanup: jest.fn(),
        _handleTargetBridgeTransition: jest.fn(),
        registerConfirmedIntermediatePassage: jest.fn(),
      };
      app.passageLatchService = { handleGPSJump: jest.fn() };
      app.routeOrderValidator = { clearVesselHistory: jest.fn() };
    });

    test('falsk kandidat (snapshot norr, båt kvar söder) → INGEN transition + refuted-logg', async () => {
      app.gpsJumpGateService = {
        confirmStableCandidates: jest.fn(() => [{
          bridgeName: 'Klaffbron',
          passageResult: { passed: true },
          confirmedAt: Date.now(),
          vesselState: {
            lat: KLAFFBRON.lat + 400 / 111320, lon: KLAFFBRON.lon, cog: 20, sog: 0.3,
          },
        }]),
        clearGate: jest.fn(),
      };
      const vessel = {
        mmsi: '265991005',
        lat: KLAFFBRON.lat - 150 / 111320, // kvar SÖDER om brolinjen
        lon: KLAFFBRON.lon,
        targetBridge: 'Klaffbron',
        sog: 0.3,
        cog: 20,
      };

      await app._analyzeVesselPosition(vessel);

      expect(app.vesselDataService._handleTargetBridgeTransition).not.toHaveBeenCalled();
      expect(app.log.mock.calls.some((c) => String(c[0]).includes('GPS_GATE_REFUTED'))).toBe(true);
    });

    test('äkta kandidat (båt kvar på snapshotens sida) → transition appliceras', async () => {
      app.gpsJumpGateService = {
        confirmStableCandidates: jest.fn(() => [{
          bridgeName: 'Klaffbron',
          passageResult: { passed: true },
          confirmedAt: Date.now(),
          vesselState: {
            lat: KLAFFBRON.lat + 200 / 111320, lon: KLAFFBRON.lon, cog: 20, sog: 5.0,
          },
        }]),
        clearGate: jest.fn(),
      };
      const vessel = {
        mmsi: '265991006',
        lat: KLAFFBRON.lat + 600 / 111320, // fortsatt NORR — konsistent färd
        lon: KLAFFBRON.lon,
        targetBridge: 'Klaffbron',
        sog: 5.0,
        cog: 20,
      };

      await app._analyzeVesselPosition(vessel);

      expect(app.vesselDataService._handleTargetBridgeTransition)
        .toHaveBeenCalledWith(vessel, expect.anything(), { confirmedPassage: true });
    });
  });
});

// =============================================================================
// G-2: ensidig sog=null får 5 kn-golvet
// =============================================================================
describe('G-2: _isVesselStable speglar GJ-2 vid ensidig sog=null', () => {
  let svc;
  let now;

  beforeEach(() => {
    now = 1700000000000;
    Date.now = () => now;
    svc = new GPSJumpGateService(makeLogger(), null);
  });

  afterEach(() => {
    svc.destroy();
    Date.now = REAL_DATE_NOW;
  });

  test('snapshot-sog 0,5 + null-svit: 5 kn-fysiken täcker verklig marschfart → bekräftas', () => {
    svc.registerCandidatePassage('265991007', 'Klaffbron', { passed: true }, {
      lat: 58.284, lon: 12.285, cog: 20, sog: 0.5,
    });
    now += 6 * 60 * 1000; // 6 min — båt i 5 kn har flyttat ~925 m
    const confirmed = svc.confirmStableCandidates('265991007', {
      lat: 58.284 + 925 / 111320, lon: 12.285, cog: 22, sog: null,
    });
    // Gamla golvet max(0.5, 1)=1 kn tillät bara ~370 m → övergavs för evigt.
    expect(confirmed).toHaveLength(1);
  });
});

// =============================================================================
// G-4: latch-reversalens sampelbaserade bekräftelse
// =============================================================================
describe('G-4: pendingReversal kräver två OLIKA positionssampel', () => {
  let svc;
  let now;

  beforeEach(() => {
    now = 1700000000000;
    Date.now = () => now;
    svc = new PassageLatchService(makeLogger());
    svc.registerPassage('265991008', 'Järnvägsbron', 'north');
  });

  afterEach(() => {
    if (svc.destroy) svc.destroy();
    Date.now = REAL_DATE_NOW;
  });

  test('samma tick (samma sampleTs): waiting+approaching bekräftar INTE varandra', () => {
    const ts = now - 1000;
    // anrop 1 (waiting-prövningen) — sätter pending, blockerar
    expect(svc.shouldBlockStatus('265991008', 'Järnvägsbron', 'waiting', 180, ts)).toBe(true);
    // anrop 2 i SAMMA tick (approaching-prövningen, samma sampel) — får inte släppa
    expect(svc.shouldBlockStatus('265991008', 'Järnvägsbron', 'approaching', 180, ts)).toBe(true);
  });

  test('gles kadens (5 min mellan samplen): andra motsatta samplet SLÄPPER (F13 levde inte förut)', () => {
    expect(svc.shouldBlockStatus('265991008', 'Järnvägsbron', 'waiting', 180, now - 1000)).toBe(true);
    now += 5 * 60 * 1000; // nästa Class B-sample
    expect(svc.shouldBlockStatus('265991008', 'Järnvägsbron', 'waiting', 180, now - 1000)).toBe(false);
  });
});

// =============================================================================
// G-5: validatorhistoriken lagrar låst riktning
// =============================================================================
describe('G-5: RouteOrderValidator-historiken bär resans riktning, inte momentan cog', () => {
  test('cog i NO-kröken (50°) men låst _routeDirection=north → direction=north i historiken', () => {
    const v = new RouteOrderValidator(makeLogger(), new BridgeRegistry());
    v.registerPassage('265991009', 'Järnvägsbron', {
      cog: 50, sog: 4, lat: 58.2916, lon: 12.2939, _routeDirection: 'north',
    });
    const history = v._vesselPassageHistory.get('265991009');
    expect(history[0].direction).toBe('north'); // gamla koden: null (46–134° = tvetydigt)
  });
});

// =============================================================================
// S-1: timer-/snapshotvägen syntetiserar positionAnalysis
// =============================================================================
describe('S-1: _reevaluateVesselStatuses ger stabilizern osäkerhetskontext', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.proximityService = {
      analyzeVesselProximity: () => ({ nearestBridge: null, nearestDistance: 999, bridgeDistances: {} }),
    };
    app.statusService = {
      analyzeVesselStatus: jest.fn(() => ({ status: 'waiting', isWaiting: true, isApproaching: false })),
    };
    app.vesselDataService = {
      getAllVessels: () => [{
        mmsi: '265991010',
        lat: 58.284,
        lon: 12.284,
        sog: 0.5,
        cog: 20,
        status: 'waiting',
        _positionUncertain: true,
        _gpsJumpDetected: false,
      }],
    };
  });

  test('flaggad båt → analyzeVesselStatus får syntetisk positionAnalysis (stabilizern kan hålla)', () => {
    app._reevaluateVesselStatuses();
    const call = app.statusService.analyzeVesselStatus.mock.calls[0];
    expect(call[2]).toEqual({ gpsJumpDetected: false, positionUncertain: true });
  });

  test('ren båt → ingen syntetisk analys (null, som förut)', () => {
    app.vesselDataService.getAllVessels = () => [{
      mmsi: '265991011', lat: 58.284, lon: 12.284, sog: 5, cog: 20, status: 'en-route',
    }];
    app._reevaluateVesselStatuses();
    const call = app.statusService.analyzeVesselStatus.mock.calls[0];
    expect(call[2]).toBeNull();
  });
});

// =============================================================================
// P2-1: N2-resetten bevarar färska poster
// =============================================================================
describe('P2-1: journey-reset utan brolista bevarar nya benets färska dedup-poster', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._persistRecentTriggers = jest.fn();
    return app;
  };

  test('post 40 s gammal (notifierad under cooldownen) ÖVERLEVER; gamla resans post (>10 min) rensas', () => {
    const app = makeApp();
    const vessel = { mmsi: '265991012' };
    app._triggeredBoatNearKeys.add('265991012:Olidebron'); // nya benet, 40 s
    app._triggeredBoatNearKeys.add('265991012:Stridsbergsbron'); // gamla resan
    app._persistentRecentTriggers.set('265991012:Olidebron', { t: Date.now() - 40 * 1000, dir: 'south' });
    app._persistentRecentTriggers.set('265991012:Stridsbergsbron', { t: Date.now() - 25 * 60 * 1000, dir: 'north' });

    app._clearBoatNearTriggers(vessel, true, { preserveFreshPersistentMs: 10 * 60 * 1000 });

    expect(app._triggeredBoatNearKeys.has('265991012:Olidebron')).toBe(true);
    expect(app._persistentRecentTriggers.has('265991012:Olidebron')).toBe(true);
    expect(app._triggeredBoatNearKeys.has('265991012:Stridsbergsbron')).toBe(false);
    expect(app._persistentRecentTriggers.has('265991012:Stridsbergsbron')).toBe(false);
  });

  test('utan preserve-option (N1/NEW_JOURNEY-vägarna): fullrensning som förut', () => {
    const app = makeApp();
    const vessel = { mmsi: '265991013' };
    app._triggeredBoatNearKeys.add('265991013:Olidebron');
    app._persistentRecentTriggers.set('265991013:Olidebron', { t: Date.now() - 40 * 1000, dir: 'south' });

    app._clearBoatNearTriggers(vessel, true);

    expect(app._triggeredBoatNearKeys.has('265991013:Olidebron')).toBe(false);
    expect(app._persistentRecentTriggers.has('265991013:Olidebron')).toBe(false);
  });
});

// =============================================================================
// A2-1 + P1-1b: systerkanalernas självläkning
// =============================================================================
describe('A2-1/P1-1b: alarm-/statusskrivfel nollställer dedup-sentinelerna', () => {
  const flush = () => new Promise((resolve) => {
    setImmediate(resolve);
  });

  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._devices = new Set();
    return app;
  };

  test('alarm_generic-reject → _lastBridgeAlarm=null (nästa jämförelse skriver om)', async () => {
    const app = makeApp();
    app._lastBridgeAlarm = false;
    app._devices.add({
      getName: () => 'ENHET',
      setCapabilityValue: jest.fn().mockRejectedValue(new Error('offline')),
    });

    await app._writeCapabilityToDevices('alarm_generic', false);

    expect(app._lastBridgeAlarm).toBeNull();
  });

  test('connection_status-reject → _lastConnectionStatus=null', async () => {
    const app = makeApp();
    app._lastConnectionStatus = 'connected';
    app._devices.add({
      getName: () => 'ENHET',
      setCapabilityValue: jest.fn().mockRejectedValue(new Error('offline')),
    });

    await app._writeCapabilityToDevices('connection_status', 'connected');

    expect(app._lastConnectionStatus).toBeNull();
  });

  test('P1-1b: SYNKRONT kast räknas som misslyckad skrivning (hash nollställs)', async () => {
    const app = makeApp();
    app._lastBridgeTextHash = 'abc';
    app._devices.add({
      getName: () => 'ENHET',
      setCapabilityValue: () => {
        throw new Error('sync boom');
      },
    });

    await app._writeCapabilityToDevices('bridge_text', 'text');
    await flush();

    expect(app._lastBridgeTextHash).toBeNull();
  });
});

// =============================================================================
// A1-1: kajkartans 24h-persistguard
// =============================================================================
describe('A1-1: TTL-förnyelsen persisterar högst en gång per dygn', () => {
  test('dedup-träff inom 24h → INGEN settings-skrivning; äldre post → förnyad + persisterad', () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app._persistLearnedMooringSpots = jest.fn();
    const spotLat = 58.2876;
    const spotLon = 12.2900;

    app._learnedMooringSpots = [{ lat: spotLat, lon: spotLon, t: Date.now() - 60 * 1000 }];
    app._learnMooringSpot(spotLat, spotLon, '265991014');
    expect(app._persistLearnedMooringSpots).not.toHaveBeenCalled(); // färsk post: spam-vägen stängd

    app._learnedMooringSpots[0].t = Date.now() - 25 * 60 * 60 * 1000;
    app._learnMooringSpot(spotLat, spotLon, '265991014');
    expect(app._persistLearnedMooringSpots).toHaveBeenCalledTimes(1); // dygnsförnyelsen består
  });
});

// =============================================================================
// #44-gaten: expired-släppet och redan passerad bro
// =============================================================================
describe('Scenario #44-gaten: expired-släpp aldrig för bro i passedBridges', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._getDirectionString = jest.fn(() => 'norrut');
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
    return app;
  };
  const candidate = {
    name: 'Stallbackabron', id: 'stallbackabron', distance: 82, source: 'nearest',
  };

  test('PILOT-resume: passerad bro + utgången post + rörelse → HOLD (fantomen)', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265991015:Stallbackabron');
    const vessel = {
      mmsi: '265991015',
      name: 'SYNT-PILOT',
      sog: 5.0,
      cog: 20,
      etaMinutes: 1,
      _routeDirection: 'north',
      passedBridges: ['Klaffbron', 'Stridsbergsbron', 'Stallbackabron'],
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has('265991015:Stallbackabron')).toBe(true);
  });

  test('kontroll: EJ passerad bro + utgången post + rörelse → SLÄPPS (C2-klassen intakt)', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265991016:Stallbackabron');
    const vessel = {
      mmsi: '265991016',
      name: 'NY-ANLÖPAREN',
      sog: 5.0,
      cog: 20,
      etaMinutes: 2,
      _routeDirection: 'north',
      passedBridges: ['Klaffbron', 'Stridsbergsbron'],
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });
});
