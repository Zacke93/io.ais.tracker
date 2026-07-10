'use strict';

/**
 * Beteendetester för StatusService — kompletterar statusService-synthetic-hold
 * (broöppningsfönstret håller status) och hysteresis-corruption-fix
 * (latch-reset) med de tidigare otäckta vägarna:
 *  - statusklassificering per zon (approaching/waiting/under-bridge/passed/
 *    stallbacka-waiting/en-route) via analyzeVesselStatus med RIKTIG
 *    BridgeRegistry + ProximityService
 *  - broöppningsfönstrets avståndsventil, utgång och ETA-hantering
 *  - ETA-vägarna (delegering till ProgressiveETACalculator, 0.1-regeln under
 *    målbron, bevarad ETA under annan bro — teleportfixen 2026-07-02b)
 *  - osäkra positioner → StatusStabilizer (GPS-hopp håller föregående status,
 *    uncertain kräver konsistens)
 *  - _isActuallyApproaching-metoderna (kurs/avstånd/fartfallback) via
 *    Stallbacka-fallbacken
 *  - zonskydd och zontransitioner (analyzeZoneProtectionNeeds,
 *    hasActiveCriticalTransition, getHighestPriorityTransition)
 *  - waiting-blockerare (passage-cooldown, passage-latch) och väntetimern
 *  - rörelseanalys (isStationary/analyzeMovement) och determineStatus
 *
 * Tidsstyrning: Date.now mockas manuellt och återställs i afterEach.
 */

global.__TEST_MODE__ = true;

const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const { BRIDGES } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;
const T0 = 1_700_000_000_000;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// ~1 grad latitud = 111 320 m → punkt X meter söder om bron (verifierat mot
// geometry.calculateDistance: avvikelse <0.5 m för avstånden nedan)
const southOf = (bridge, meters) => ({
  lat: bridge.lat - meters / 111320,
  lon: bridge.lon,
});

describe('StatusService — beteende', () => {
  let now;
  let statusService;
  let proximityService;
  let vesselDataService;
  let passageLatchService;

  const advance = (ms) => {
    now += ms;
  };

  const makeVessel = (overrides = {}) => ({
    mmsi: 265123000,
    name: 'TESTBÅT',
    sog: 3.5,
    cog: 20,
    status: 'en-route',
    targetBridge: 'Klaffbron',
    ...overrides,
  });

  const placeAt = (vessel, bridge, meters) => {
    const pos = southOf(bridge, meters);
    vessel.lat = pos.lat;
    vessel.lon = pos.lon;
  };

  // Kör en full analys-tick som verkliga anroparen (VesselDataService):
  // proximity → analyzeVesselStatus. Returnerar { result, prox }.
  const analyze = (vessel, positionAnalysis = null) => {
    const prox = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, prox, positionAnalysis);
    return { result, prox };
  };

  // Spegla anroparens tillämpning av resultatet på vessel-objektet
  const apply = (vessel, result) => {
    vessel.status = result.status;
    vessel.isWaiting = result.isWaiting;
    vessel.isApproaching = result.isApproaching;
  };

  beforeEach(() => {
    now = T0;
    Date.now = () => now;
    global.__TEST_MODE__ = true;

    const logger = makeLogger();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    vesselDataService = { anchorPassageTimestamp: jest.fn() };
    passageLatchService = { shouldBlockStatus: jest.fn().mockReturnValue(false) };

    statusService = new StatusService(
      bridgeRegistry, logger, systemCoordinator, vesselDataService, passageLatchService,
    );
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  describe('konstruktorkrav', () => {
    test('kastar utan SystemCoordinator', () => {
      expect(() => new StatusService(new BridgeRegistry(), makeLogger(), null))
        .toThrow('SystemCoordinator is required');
    });
  });

  describe('statusklassificering per zon', () => {
    test('ogiltig input ger unknown/invalid_input utan krasch', () => {
      const result = statusService.analyzeVesselStatus(null, {});
      expect(result).toMatchObject({
        status: 'unknown',
        isWaiting: false,
        statusReason: 'invalid_input',
        etaMinutes: null,
      });
      expect(statusService.analyzeVesselStatus(makeVessel(), null).status).toBe('unknown');
    });

    test('400 m från målbron → approaching + status:changed-event', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 400);
      const events = [];
      statusService.on('status:changed', (e) => events.push(e));

      const { result } = analyze(vessel);

      expect(result.status).toBe('approaching');
      expect(result.isApproaching).toBe(true);
      expect(result.isWaiting).toBe(false);
      expect(result.statusChanged).toBe(true);
      expect(result.statusReason).toBe('vessel_approaching_bridge');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ oldStatus: 'en-route', newStatus: 'approaching' });
    });

    test('250 m från målbron → waiting, waitSince sätts och FIX O-spårningen uppdateras', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 250);

      const { result } = analyze(vessel);

      expect(result.status).toBe('waiting');
      expect(result.isWaiting).toBe(true);
      expect(result.statusReason).toBe('vessel_waiting_at_bridge');
      expect(vessel.waitSince).toBe(now);
      expect(vessel._lastWaitingShownAt.Klaffbron).toBe(now); // FIX O
    });

    test('30 m från målbron → under-bridge med ETA 0.1 och currentBridge satt', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 30);

      const { result } = analyze(vessel);

      expect(result.status).toBe('under-bridge');
      expect(result.statusReason).toBe('vessel_under_bridge');
      expect(result.etaMinutes).toBe(0.1);
      expect(vessel.currentBridge).toBe('Klaffbron');
      expect(vessel._underBridgeLatched).toBe(true);
    });

    test('lämnar under-bridge på ANDRA sidan (korsning) → latch släpper och passagen ankras', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 30); // in söderifrån
      apply(vessel, analyze(vessel).result); // under-bridge, latch + entry-position satt

      advance(6_000); // förbi FIX G-debouncen
      // Ut på NORRA sidan (> clear-gränsen 70 m) = verkligt sidbyte
      vessel.lat = BRIDGES.klaffbron.lat + 80 / 111320;
      vessel.lon = BRIDGES.klaffbron.lon;
      const { result } = analyze(vessel);

      expect(vessel._underBridgeLatched).toBe(false);
      expect(result.status).not.toBe('under-bridge');
      expect(vesselDataService.anchorPassageTimestamp)
        .toHaveBeenCalledWith(vessel, 'Klaffbron', now);
    });

    test('lämnar under-bridge på SAMMA sida (kö-drift) → latch släpper UTAN falsk passage-ankring', () => {
      // Produktionsredo (2026-07-03): ovillkorlig ankring vid zonutgång gav
      // en falsk passage-tidsstämpel för köande båtar som kröp in och
      // driftade ut söderut igen — 3-min-guarden blockerade sedan den
      // ÄKTA passagens registrering.
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 30); // in söderifrån
      apply(vessel, analyze(vessel).result); // under-bridge, latch + entry-position satt

      advance(6_000);
      placeAt(vessel, BRIDGES.klaffbron, 80); // ut SÖDERUT — samma sida
      const { result } = analyze(vessel);

      expect(vessel._underBridgeLatched).toBe(false);
      expect(result.status).not.toBe('under-bridge');
      expect(vesselDataService.anchorPassageTimestamp).not.toHaveBeenCalled();
    });

    test('nyss passerad bro (<180 s) → passed', () => {
      const vessel = makeVessel({
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: T0 - 60_000,
      });
      placeAt(vessel, BRIDGES.klaffbron, 800);

      const { result } = analyze(vessel);

      expect(result.status).toBe('passed');
      expect(result.statusReason).toBe('vessel_recently_passed');
      expect(result.isWaiting).toBe(false);
      expect(result.isApproaching).toBe(false);
    });

    test('passage äldre än 180 s → inte längre passed utan en-route', () => {
      const vessel = makeVessel({
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: T0 - 181_000,
      });
      placeAt(vessel, BRIDGES.klaffbron, 800);

      const { result } = analyze(vessel);

      expect(result.status).toBe('en-route');
      expect(result.statusReason).toBe('vessel_en_route');
    });

    test('250 m från Stallbackabron → stallbacka-waiting (ALDRIG vanlig waiting)', () => {
      const vessel = makeVessel({ targetBridge: 'Stridsbergsbron' });
      placeAt(vessel, BRIDGES.stallbackabron, 250);

      const { result } = analyze(vessel);

      expect(result.status).toBe('stallbacka-waiting');
      expect(result.isWaiting).toBe(false); // specialhantering, inte "inväntar"
      expect(result.statusReason).toBe('vessel_approaching_stallbacka_under_bridge');
    });

    test('redan passerad Stallbackabron → ingen återgång till stallbacka-waiting', () => {
      const vessel = makeVessel({
        targetBridge: 'Stridsbergsbron',
        passedBridges: ['Stallbackabron'],
      });
      placeAt(vessel, BRIDGES.stallbackabron, 250);

      const { result } = analyze(vessel);

      expect(result.status).not.toBe('stallbacka-waiting');
      expect(result.status).toBe('en-route');
    });

    test('FIX H: en-route nära mellanbro (≤600 m) sätter currentBridge för "närmar sig"-text', () => {
      const vessel = makeVessel(); // target Klaffbron ~1.9 km bort
      placeAt(vessel, BRIDGES.olidebron, 590);

      const { result } = analyze(vessel);

      expect(result.status).toBe('en-route');
      expect(vessel.currentBridge).toBe('Olidebron');
      expect(vessel.distanceToCurrent).toBeCloseTo(590, -1);
    });

    test('FIX H hoppar över redan passerad mellanbro', () => {
      const vessel = makeVessel({ passedBridges: ['Olidebron'] });
      placeAt(vessel, BRIDGES.olidebron, 590);

      const { result } = analyze(vessel);

      expect(result.status).toBe('en-route');
      expect(vessel.currentBridge).toBeFalsy();
    });

    test('250 m från MELLANBRO (Järnvägsbron) → waiting med currentBridge satt för brotexten', () => {
      const vessel = makeVessel({ targetBridge: 'Stridsbergsbron' });
      placeAt(vessel, BRIDGES.jarnvagsbron, 250); // ~480 m kvar till målbron

      const { result } = analyze(vessel);

      expect(result.status).toBe('waiting');
      expect(result.isWaiting).toBe(true);
      expect(vessel.currentBridge).toBe('Järnvägsbron');
      expect(vessel.distanceToCurrent).toBeCloseTo(250, -1);
      expect(vessel._lastWaitingShownAt['Järnvägsbron']).toBe(now); // FIX O-spårning
    });

    test('400 m från MELLANBRO → approaching med currentBridge satt', () => {
      const vessel = makeVessel({ targetBridge: 'Stridsbergsbron' });
      placeAt(vessel, BRIDGES.jarnvagsbron, 400); // ~630 m kvar till målbron

      const { result } = analyze(vessel);

      expect(result.status).toBe('approaching');
      expect(vessel.currentBridge).toBe('Järnvägsbron');
      expect(vessel.distanceToCurrent).toBeCloseTo(400, -1);
    });

    test('under-bridge nås via MÅLBRO-avståndet även när proximitetsdata saknar nearestBridge', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 30);
      const glitchProx = { nearestBridge: null, nearestDistance: Infinity, bridges: [] };

      const result = statusService.analyzeVesselStatus(vessel, glitchProx);

      expect(result.status).toBe('under-bridge');
      expect(result.etaMinutes).toBe(0.1);
      expect(vessel.currentBridge).toBe('Klaffbron'); // TARGET_UNDER sätter currentBridge
      expect(vessel.distanceToCurrent).toBeCloseTo(30, 0);
    });
  });

  describe('FIX U: tvingad waiting vid nära bro-par', () => {
    test('aktiv force-flagga inom 500 m ger omedelbar waiting och konsumerar flaggan', () => {
      const vessel = makeVessel({
        targetBridge: 'Stridsbergsbron',
        _forceWaitingAtBridge: {
          bridge: 'Stridsbergsbron',
          until: T0 + 10_000,
          triggeredBy: 'passage_Järnvägsbron',
        },
      });
      placeAt(vessel, BRIDGES.stridsbergsbron, 200);

      const { result } = analyze(vessel);

      expect(result.status).toBe('waiting');
      expect(result.isWaiting).toBe(true);
      expect(result.statusReason).toBe('FIX_U_forced_waiting_close_bridge_pair');
      expect(vessel._forceWaitingAtBridge).toBeNull(); // engångsflagga
      expect(vessel.currentBridge).toBe('Stridsbergsbron');
      expect(vessel._lastWaitingShownAt.Stridsbergsbron).toBe(now);
    });

    test('utgången force-flagga rensas och ordinarie logik styr', () => {
      const vessel = makeVessel({
        _forceWaitingAtBridge: { bridge: 'Stridsbergsbron', until: T0 - 1, triggeredBy: 'x' },
      });
      placeAt(vessel, BRIDGES.klaffbron, 400);

      const { result } = analyze(vessel);

      expect(vessel._forceWaitingAtBridge).toBeNull();
      expect(result.status).toBe('approaching');
    });
  });

  describe('FIX O: fas-sekvensen passed → inväntar → under-bridge vid nära bro-par', () => {
    // Järnvägsbron↔Stridsbergsbron ligger ~420 m isär — utan spärren skulle
    // "Broöppning pågår" kunna visas innan "inväntar" hunnit visas alls.
    const makePairVessel = () => {
      const vessel = makeVessel({
        targetBridge: 'Stridsbergsbron',
        lastPassedBridge: 'Järnvägsbron',
        lastPassedBridgeTime: T0 - 6_000,
      });
      placeAt(vessel, BRIDGES.stridsbergsbron, 30);
      return vessel;
    };

    test('under-bridge blockeras tills "inväntar" visats efter parbrons passage', () => {
      const vessel = makePairVessel(); // inget _lastWaitingShownAt ännu

      const { result } = analyze(vessel);

      expect(result.status).not.toBe('under-bridge');
      expect(result.status).toBe('passed'); // precis passerat Järnvägsbron visas i stället
    });

    test('när "inväntar" har visats släpps under-bridge fram', () => {
      const vessel = makePairVessel();
      vessel._lastWaitingShownAt = { Stridsbergsbron: T0 - 1_000 }; // efter passagen

      const { result } = analyze(vessel);

      expect(result.status).toBe('under-bridge');
      expect(result.statusReason).toBe('vessel_under_bridge');
    });
  });

  describe('FIX G: debounce av snabba statusbyten', () => {
    test('statusbyte inom 5 s efter förra bytet ignoreras', () => {
      const vessel = makeVessel({
        status: 'approaching',
        _lastStatusChangeTime: T0 - 2_000,
      });
      placeAt(vessel, BRIDGES.klaffbron, 250); // waiting-zonen

      const { result } = analyze(vessel);

      expect(result.status).toBe('approaching'); // behållen
      expect(result.statusChanged).toBe(false);
    });

    test('efter 5 s tillåts bytet och event emitteras', () => {
      const vessel = makeVessel({
        status: 'approaching',
        _lastStatusChangeTime: T0 - 6_000,
      });
      placeAt(vessel, BRIDGES.klaffbron, 250);
      const events = [];
      statusService.on('status:changed', (e) => events.push(e));

      const { result } = analyze(vessel);

      expect(result.status).toBe('waiting');
      expect(result.statusChanged).toBe(true);
      expect(events[0]).toMatchObject({ oldStatus: 'approaching', newStatus: 'waiting' });
    });
  });

  describe('broöppningsfönstret (_bridgeOpeningUntil)', () => {
    test('aktivt fönster vid målbron håller under-bridge med ETA 0.1', () => {
      const vessel = makeVessel({
        _bridgeOpeningUntil: T0 + 5_000,
        _bridgeOpeningBridgeName: 'Klaffbron',
      });
      placeAt(vessel, BRIDGES.klaffbron, 100); // fysiskt >70 m — bara fönstret håller

      const { result } = analyze(vessel);

      expect(result.status).toBe('under-bridge');
      expect(result.etaMinutes).toBe(0.1);
      expect(vessel.currentBridge).toBe('Klaffbron');
    });

    test('fönster på ANNAN bro än målbron bevarar ordinarie ETA (teleportfixen)', () => {
      const vessel = makeVessel({
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 7.5,
        _bridgeOpeningUntil: T0 + 5_000,
        _bridgeOpeningBridgeName: 'Järnvägsbron',
      });
      placeAt(vessel, BRIDGES.jarnvagsbron, 100);

      const { result } = analyze(vessel);

      expect(result.status).toBe('under-bridge');
      expect(result.etaMinutes).toBe(7.5); // INTE 0.1 — målet är Stridsbergsbron
    });

    test('avståndsventilen rensar fönstret när båten är >300 m från öppningsbron', () => {
      const vessel = makeVessel({
        _bridgeOpeningUntil: T0 + 60_000,
        _bridgeOpeningBridgeName: 'Klaffbron',
      });
      placeAt(vessel, BRIDGES.klaffbron, 400);

      const { result } = analyze(vessel);

      expect(vessel._bridgeOpeningUntil).toBeNull();
      expect(vessel._bridgeOpeningBridgeName).toBeNull();
      expect(result.status).toBe('approaching'); // faller igenom till fysisk logik
    });

    test('utgånget fönster städas och ordinarie logik tar över', () => {
      const vessel = makeVessel({
        _bridgeOpeningUntil: T0 - 1_000,
        _bridgeOpeningBridgeName: 'Klaffbron',
      });
      placeAt(vessel, BRIDGES.klaffbron, 400);

      const { result } = analyze(vessel);

      expect(vessel._bridgeOpeningUntil).toBeNull();
      expect(vessel._bridgeOpeningBridgeName).toBeNull();
      expect(result.status).toBe('approaching');
    });
  });

  describe('ETA-vägar', () => {
    test('calculateETA returnerar progressiv ETA när kalkylatorn lyckas', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 400);
      const prox = proximityService.analyzeVesselProximity(vessel);
      statusService.progressiveETACalculator = {
        calculateProgressiveETA: jest.fn().mockReturnValue(4.2),
      };

      expect(statusService.calculateETA(vessel, prox)).toBe(4.2);
      expect(statusService.progressiveETACalculator.calculateProgressiveETA)
        .toHaveBeenCalledWith(vessel, prox);
    });

    test('calculateETA returnerar null när kalkylatorn misslyckas (ingen fallback-gissning)', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 400);
      const prox = proximityService.analyzeVesselProximity(vessel);
      statusService.progressiveETACalculator = {
        calculateProgressiveETA: jest.fn().mockReturnValue(null),
      };

      expect(statusService.calculateETA(vessel, prox)).toBeNull();
    });

    test('under mellanbro (≠ målbron) bevaras ETA mot målet i stället för 0.1', () => {
      const vessel = makeVessel({ targetBridge: 'Stridsbergsbron', etaMinutes: 7.3 });
      placeAt(vessel, BRIDGES.jarnvagsbron, 30);

      const { result } = analyze(vessel);

      expect(result.status).toBe('under-bridge');
      expect(result.etaMinutes).toBe(7.3);
    });
  });

  describe('osäkra positioner → stabilisering', () => {
    const gpsJump = {
      gpsJumpDetected: true,
      analysis: { isGPSJump: true, movementDistance: 800 },
    };

    test('GPS-hopp håller föregående status och nollställer under-bridge-latchen', () => {
      const vessel = makeVessel({ status: 'approaching', _underBridgeLatched: true });
      placeAt(vessel, BRIDGES.klaffbron, 250); // föreslagen status: waiting

      const { result } = analyze(vessel, gpsJump);

      expect(result.status).toBe('approaching'); // hålls under stabiliseringen
      expect(result.stabilized).toBe(true);
      expect(result.statusReason).toBe('gps_jump_stabilization');
      expect(result.statusChanged).toBe(false);
      expect(vessel._underBridgeLatched).toBe(false);
    });

    test('efter 30 s stabilisering accepteras den nya statusen', () => {
      const vessel = makeVessel({ status: 'approaching' });
      placeAt(vessel, BRIDGES.klaffbron, 250);
      apply(vessel, analyze(vessel, gpsJump).result); // startar stabiliseringen

      advance(31_000);
      const { result } = analyze(vessel, gpsJump);

      expect(result.status).toBe('waiting');
      expect(result.statusReason).toBe('vessel_waiting_at_bridge');
    });

    test('osäker position kräver två konsistenta läsningar före statusbyte', () => {
      const uncertain = { positionUncertain: true };
      const vessel = makeVessel({ status: 'approaching' });
      placeAt(vessel, BRIDGES.klaffbron, 250);

      const first = analyze(vessel, uncertain).result;
      expect(first.status).toBe('approaching'); // hålls — bara 1 läsning
      expect(first.stabilized).toBe(true);
      expect(first.statusReason).toBe('uncertain_position_consistency');

      const second = analyze(vessel, uncertain).result;
      expect(second.status).toBe('waiting'); // 2 konsistenta → accepteras
    });
  });

  describe('_isActuallyApproaching via Stallbacka-fallbacken', () => {
    // Fallbacken nås när proximityData saknar nearestBridge (t.ex. ogiltig
    // proximitetsanalys) men båten fysiskt är 300–480 m från Stallbackabron.
    const emptyProx = { nearestBridge: null, nearestDistance: Infinity, bridges: [] };

    const makeStallbackaVessel = (overrides) => {
      const vessel = makeVessel({ targetBridge: null, ...overrides });
      placeAt(vessel, BRIDGES.stallbackabron, 400);
      return vessel;
    };

    test('kurs mot bron räcker (metod 1) trots låg fart', () => {
      const vessel = makeStallbackaVessel({ cog: 0, sog: 1.0 }); // norrut, mot bron
      const result = statusService.analyzeVesselStatus(vessel, emptyProx);

      expect(result.status).toBe('approaching');
      expect(vessel.currentBridge).toBe('Stallbackabron');
    });

    test('minskande avstånd räcker (metod 2) när kursen är obrukbar', () => {
      const prev = southOf(BRIDGES.stallbackabron, 450);
      // Fable-granskningen 2026-07-10b (V1-3): fältet heter lastPosition —
      // testet fabricerade tidigare previousPosition (som produktionen
      // aldrig skriver) och "verifierade" därmed en död kodväg.
      const vessel = makeStallbackaVessel({
        cog: undefined, // metod 1 faller bort
        sog: 1.0, // under fartfallbackens 2 kn
        lastPosition: { lat: prev.lat, lon: prev.lon }, // var 450 m bort, nu 400 m
      });

      const result = statusService.analyzeVesselStatus(vessel, emptyProx);

      expect(result.status).toBe('approaching');
    });

    test('rimlig fart räcker som fallback (metod 3) utan kurs och historik', () => {
      const vessel = makeStallbackaVessel({ cog: undefined, sog: 3.0 });
      const result = statusService.analyzeVesselStatus(vessel, emptyProx);

      expect(result.status).toBe('approaching');
    });

    test('kurs bort + ökande avstånd + låg fart → INTE approaching', () => {
      const prev = southOf(BRIDGES.stallbackabron, 380);
      const vessel = makeStallbackaVessel({
        cog: 180, // söderut, bort från bron
        sog: 1.0,
        lastPosition: { lat: prev.lat, lon: prev.lon }, // var 380 m, nu 400 m — glider bort (V1-3: rätt fältnamn)
      });

      const result = statusService.analyzeVesselStatus(vessel, emptyProx);

      expect(result.status).toBe('en-route');
    });

    test('fel i beräkningen är konservativt: tillåt approaching', () => {
      const vessel = makeStallbackaVessel({ cog: 20 });
      // bridge=null → TypeError inne i try-blocket → catch → true
      expect(statusService._isActuallyApproaching(vessel, null, 400)).toBe(true);
    });
  });

  describe('zonskydd (analyzeZoneProtectionNeeds) och zontransitioner', () => {
    test('kritisk under-bridge-transition ger högsta skyddsprioritet i 3 s', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 30);
      const { prox } = analyze(vessel); // under-bridge → kritisk transition

      expect(statusService.hasActiveCriticalTransition(vessel)).toBe(true);
      const protection = statusService.analyzeZoneProtectionNeeds(vessel, prox);
      expect(protection).toMatchObject({
        needsProtection: true,
        reason: 'critical_transition_hold',
        priority: 100,
        bridgeName: 'Klaffbron',
        hysteresisActive: true,
      });
    });

    test('utgången kritisk hold faller tillbaka till waiting-zonens skydd', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 30);
      const { prox } = analyze(vessel);

      advance(3_001); // CRITICAL_TRANSITION_HOLD_MS = 3000

      expect(statusService.hasActiveCriticalTransition(vessel)).toBe(false);
      expect(vessel._criticalTransitionHoldUntil).toBeUndefined(); // städad
      const protection = statusService.analyzeZoneProtectionNeeds(vessel, prox);
      expect(protection).toMatchObject({
        reason: 'waiting_zone_hysteresis',
        priority: 80,
        bridgeName: 'Klaffbron',
      });
    });

    test('approaching-zonen (≤580 m till målbron) ger skydd med prioritet 70', () => {
      const vessel = makeVessel({ status: 'approaching' });
      placeAt(vessel, BRIDGES.klaffbron, 450);
      const prox = proximityService.analyzeVesselProximity(vessel);

      const protection = statusService.analyzeZoneProtectionNeeds(vessel, prox);

      expect(protection).toMatchObject({
        needsProtection: true,
        reason: 'approaching_zone_hysteresis',
        priority: 70,
        bridgeName: 'Klaffbron',
        hysteresisActive: true,
      });
    });

    test('mellanbro utan målbro ger skydd med prioritet 75', () => {
      const vessel = makeVessel({ targetBridge: null, currentBridge: 'Järnvägsbron' });
      placeAt(vessel, BRIDGES.jarnvagsbron, 300);
      const prox = {
        nearestBridge: { name: 'Järnvägsbron', distance: 300 },
        nearestDistance: 300,
      };

      const protection = statusService.analyzeZoneProtectionNeeds(vessel, prox);

      expect(protection).toMatchObject({
        reason: 'intermediate_bridge_hysteresis',
        priority: 75,
        bridgeName: 'Järnvägsbron',
        hysteresisActive: true,
      });
    });

    test('långt från alla zoner → inget skydd', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 2000);
      const prox = proximityService.analyzeVesselProximity(vessel);

      const protection = statusService.analyzeZoneProtectionNeeds(vessel, prox);

      expect(protection.needsProtection).toBe(false);
      expect(protection.priority).toBe(0);
    });

    test('getHighestPriorityTransition väljer under-bridge (100) före waiting (80) och åldras ut', () => {
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 250);
      apply(vessel, analyze(vessel).result); // waiting-transition registreras

      placeAt(vessel, BRIDGES.klaffbron, 30);
      analyze(vessel); // under-bridge-transition registreras (statusbytet debouncas, transitionen inte)

      const highest = statusService.getHighestPriorityTransition(vessel);
      expect(highest.status).toBe('under-bridge');
      expect(highest.priority).toBe(100);
      expect(highest.isCritical).toBe(true);

      advance(1_600); // > ZONE_TRANSITION_GRACE_MS (1500)
      expect(statusService.getHighestPriorityTransition(vessel)).toBeNull();
    });
  });

  describe('waiting-blockerare', () => {
    test('aktiv passage-cooldown blockerar waiting vid bron', () => {
      const vessel = makeVessel({
        _passageCooldowns: { Klaffbron: T0 + 60_000 },
      });
      placeAt(vessel, BRIDGES.klaffbron, 250);

      const { result } = analyze(vessel);

      expect(result.status).toBe('en-route'); // 250 m är för nära för approaching (>300 krävs)
      expect(result.isWaiting).toBe(false);
    });

    test('utgången cooldown raderas och waiting tillåts igen', () => {
      const vessel = makeVessel({
        _passageCooldowns: { Klaffbron: T0 - 1 },
      });
      placeAt(vessel, BRIDGES.klaffbron, 250);

      const { result } = analyze(vessel);

      expect(result.status).toBe('waiting');
      expect(vessel._passageCooldowns.Klaffbron).toBeUndefined();
    });

    test('passage-latchen konsulteras med rätt kontrakt och kan blockera waiting', () => {
      passageLatchService.shouldBlockStatus.mockReturnValue(true);
      const vessel = makeVessel();
      placeAt(vessel, BRIDGES.klaffbron, 250);

      const { result } = analyze(vessel);

      expect(result.status).toBe('en-route');
      // G-4 (Fable 2026-07-10b): kontraktet bär numera sampeltidsstämpeln
      // (lastPositionUpdate ?? timestamp ?? null) som 5:e argument så
      // reversal-bekräftelsen kräver två OLIKA positionssampel.
      expect(passageLatchService.shouldBlockStatus)
        .toHaveBeenCalledWith('265123000', 'Klaffbron', 'waiting', 20, null);
    });
  });

  describe('väntetimern (_updateWaitingTimer)', () => {
    test('låg fart i waiting-zonen startar båda timers; fart+utsegling nollställer', () => {
      const vessel = makeVessel({ sog: 0.1 });
      placeAt(vessel, BRIDGES.klaffbron, 250);
      apply(vessel, analyze(vessel).result);

      expect(vessel.speedBelowThresholdSince).toBe(now);
      expect(vessel.waitSince).toBe(now);

      advance(6_000);
      vessel.sog = 3.0;
      placeAt(vessel, BRIDGES.klaffbron, 400); // utanför clear-gränsen 350 m
      const { result } = analyze(vessel);

      expect(result.status).toBe('approaching');
      expect(vessel.speedBelowThresholdSince).toBeNull();
      expect(vessel.waitSince).toBeNull();
    });
  });

  describe('rörelseanalys (isStationary/analyzeMovement)', () => {
    test('fart under 0.1 kn → stillastående', () => {
      expect(statusService.isStationary(makeVessel({ sog: 0.05 }))).toBe(true);
    });

    test('ingen positionsändring på >60 s → stillastående trots fart i meddelandet', () => {
      const vessel = makeVessel({ sog: 3.0, lastPositionChange: T0 - 61_000 });
      expect(statusService.isStationary(vessel)).toBe(true);
    });

    test('färsk rörelse + fart → inte stillastående', () => {
      const vessel = makeVessel({ sog: 3.0, lastPositionChange: T0 - 5_000 });
      expect(statusService.isStationary(vessel)).toBe(false);
    });

    test('snabb och accelererande båt klassas fast/increasing med färsk rörelse', () => {
      const vessel = makeVessel({
        sog: 7.5,
        lastPositionChange: T0 - 30_000,
        speedHistory: [{ speed: 6.0 }, { speed: 6.5 }, { speed: 7.5 }],
      });

      const analysis = statusService.analyzeMovement(vessel);

      expect(analysis).toMatchObject({
        isStationary: false,
        movementPattern: 'fast',
        speedTrend: 'increasing',
        hasRecentMovement: true,
      });
    });

    test('inbromsande båt i normalfart klassas normal/decreasing', () => {
      const vessel = makeVessel({
        sog: 2.5,
        lastPositionChange: T0 - 61_000,
        speedHistory: [{ speed: 4.0 }, { speed: 3.5 }, { speed: 2.5 }],
      });

      const analysis = statusService.analyzeMovement(vessel);

      expect(analysis).toMatchObject({
        movementPattern: 'normal',
        speedTrend: 'decreasing',
        hasRecentMovement: false,
      });
    });

    test('krypfart i historiken klassas stationary', () => {
      const vessel = makeVessel({
        sog: 0.05,
        speedHistory: [{ speed: 0.05 }, { speed: 0.08 }, { speed: 0.05 }],
      });

      expect(statusService.analyzeMovement(vessel).movementPattern).toBe('stationary');
    });
  });

  describe('shouldTriggerPrecisPasseratUpdates', () => {
    test('passed-status inom fönstret → true', () => {
      const vessel = makeVessel({ status: 'passed', lastPassedBridgeTime: T0 - 60_000 });
      expect(statusService.shouldTriggerPrecisPasseratUpdates(vessel)).toBe(true);
    });

    test('passed-status utanför 180 s-fönstret → false', () => {
      const vessel = makeVessel({ status: 'passed', lastPassedBridgeTime: T0 - 181_000 });
      expect(statusService.shouldTriggerPrecisPasseratUpdates(vessel)).toBe(false);
    });

    test('annan status → false även med färsk passage', () => {
      const vessel = makeVessel({ status: 'waiting', lastPassedBridgeTime: T0 - 60_000 });
      expect(statusService.shouldTriggerPrecisPasseratUpdates(vessel)).toBe(false);
    });
  });

  describe('determineStatus (enkel avståndsmappning)', () => {
    test.each([
      [30, 'under-bridge'],
      [50, 'under-bridge'], // gräns: ≤ UNDER_BRIDGE_SET_DISTANCE
      [200, 'waiting'],
      [300, 'waiting'], // gräns: ≤ APPROACH_RADIUS
      [400, 'approaching'],
      [500, 'approaching'], // gräns: ≤ APPROACHING_RADIUS
      [900, 'en-route'],
    ])('%i m → %s', (distance, expected) => {
      expect(statusService.determineStatus(makeVessel(), 'Klaffbron', distance)).toBe(expected);
    });
  });
});
