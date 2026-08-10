'use strict';

/**
 * Fable-granskningen 2026-08-10 (FG-S1b) — statusdödbandet 270–300 m vid
 * MELLANBROAR och i Stallbacka-fallbacken.
 *
 * Helgranskningens S-1 (2026-07-10) stängde exakt samma dödband mot MÅLBRON:
 * approaching-grenens nedre gräns var APPROACH_RADIUS (300) medan waiting-SET
 * är STATUS_HYSTERESIS.WAITING_SET_DISTANCE (270), så 270 < d ≤ 300 var varken
 * approaching eller waiting → 'en-route'. S-1 rörde BARA målbrogrenen.
 *
 * FG-S1b: mellanbrogrenen (_isApproaching, Priority 2) och Stallbacka-
 * fallbacken (Priority 3 i samma metod) hade kvar APPROACH_RADIUS som nedre
 * gräns, medan deras waiting-motsvarigheter (intermediateWaitingThreshold i
 * _isWaiting resp. stallbackaThreshold i _isStallbackabraBridgeWaiting) sätter
 * på 270. Samma icke-monotona trappa uppstod därför vid Olidebron/
 * Järnvägsbron/Stallbackabron: "närmar sig" → "på väg mot" → "inväntar".
 * Den gamla ursäkten "FIX H kompenserar mellanbroarna" håller inte: FIX H
 * sätter bara currentBridge/distanceToCurrent i en-route-grenen — statusfältet
 * (och därmed statuskonsumenterna) förblev 'en-route'.
 *
 * Sviten låser: dödbandet stängt (285 m ⇒ approaching), waiting-vägen ≤270 m
 * opåverkad, Stallbacka-fallbacken med, och gränsexaktheten 270/271.
 */

const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const { BRIDGES, STATUS_HYSTERESIS, APPROACH_RADIUS } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// Punkt `meters` rakt söder om bron (samma hjälpare som S-1-sviten).
const southOf = (bridge, meters) => ({
  lat: bridge.lat - meters / 111320,
  lon: bridge.lon,
});

describe('FG-S1b: statusdödbandet 270–300 m vid mellanbroar', () => {
  let now;
  let statusService;
  let proximityService;

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

  // Nordgående båt söder om Olidebron (mellanbro) med Klaffbron som mål —
  // målbron ligger ~1,6 km bort, så bara mellanbrogrenen kan svara.
  const makeIntermediateVessel = (meters, overrides = {}) => {
    const pos = southOf(BRIDGES.olidebron, meters);
    return {
      mmsi: 265999101,
      name: 'MELLANFARAREN',
      sog: 3.0,
      cog: 20,
      status: 'en-route',
      targetBridge: 'Klaffbron',
      lat: pos.lat,
      lon: pos.lon,
      _lastStatusChangeTime: now - 60_000, // förbi FIX G-debouncen
      ...overrides,
    };
  };

  test('285 m från Olidebron (dödbandet) → approaching, inte en-route', () => {
    const vessel = makeIntermediateVessel(285);
    const prox = proximityService.analyzeVesselProximity(vessel);

    // Förutsättning: mellanbron är närmaste bro och målbron är långt bort.
    expect(prox.nearestBridge.name).toBe('Olidebron');
    expect(prox.nearestDistance).toBeGreaterThan(STATUS_HYSTERESIS.WAITING_SET_DISTANCE);
    expect(prox.nearestDistance).toBeLessThan(APPROACH_RADIUS);

    const result = statusService.analyzeVesselStatus(vessel, prox);

    expect(result.status).toBe('approaching');
    expect(result.isApproaching).toBe(true);
    expect(vessel.currentBridge).toBe('Olidebron');
  });

  test('250 m från Olidebron → waiting-vägen opåverkad (mellanbro-waiting)', () => {
    const vessel = makeIntermediateVessel(250);
    const prox = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, prox);

    expect(result.status).toBe('waiting');
    expect(result.isWaiting).toBe(true);
  });

  test('trappan 320 → 285 → 250 m är monoton: approaching, approaching, waiting', () => {
    const observed = [];
    const vessel = makeIntermediateVessel(320);

    for (const meters of [320, 285, 250]) {
      const pos = southOf(BRIDGES.olidebron, meters);
      vessel.lat = pos.lat;
      vessel.lon = pos.lon;
      const prox = proximityService.analyzeVesselProximity(vessel);
      const result = statusService.analyzeVesselStatus(vessel, prox);
      // Speglar app.js: statusen skrivs tillbaka på fartyget mellan ticks.
      vessel.status = result.status;
      observed.push(result.status);
      now += 60_000; // förbi FIX G-debouncen
    }

    expect(observed).toEqual(['approaching', 'approaching', 'waiting']);
    expect(observed).not.toContain('en-route');
  });

  test('gränsexakthet: nearestDistance = 270 ger INTE approaching (waiting tar över)', () => {
    const vessel = makeIntermediateVessel(270);
    const prox = {
      nearestBridge: { id: 'olidebron', name: 'Olidebron', distance: STATUS_HYSTERESIS.WAITING_SET_DISTANCE },
      nearestDistance: STATUS_HYSTERESIS.WAITING_SET_DISTANCE, // exakt 270
      bridgeDistances: {},
    };

    expect(statusService._isApproaching(vessel, prox)).toBe(false);
    expect(statusService._isWaiting(vessel, prox)).toBe(true);
    expect(statusService.analyzeVesselStatus(vessel, prox).status).toBe('waiting');
  });

  test('gränsexakthet: nearestDistance = 271 ger approaching', () => {
    const vessel = makeIntermediateVessel(271);
    const prox = {
      nearestBridge: { id: 'olidebron', name: 'Olidebron', distance: STATUS_HYSTERESIS.WAITING_SET_DISTANCE + 1 },
      nearestDistance: STATUS_HYSTERESIS.WAITING_SET_DISTANCE + 1, // exakt 271
      bridgeDistances: {},
    };

    expect(statusService._isWaiting(vessel, prox)).toBe(false);
    expect(statusService._isApproaching(vessel, prox)).toBe(true);
    expect(statusService.analyzeVesselStatus(vessel, prox).status).toBe('approaching');
  });
});

describe('FG-S1b: statusdödbandet 270–300 m i Stallbacka-fallbacken', () => {
  let now;
  let statusService;

  beforeEach(() => {
    now = 1_700_000_000_000;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    const logger = makeLogger();
    statusService = new StatusService(
      new BridgeRegistry(), logger, new SystemCoordinator(logger),
      { anchorPassageTimestamp: jest.fn() },
      { shouldBlockStatus: jest.fn().mockReturnValue(false) },
    );
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  // Målbrolös båt norr om Stridsbergsbron. proximityData pekar medvetet ut
  // Stridsbergsbron (~2 km) som närmaste bro så att MELLANBROGRENEN inte kan
  // svara — då är Stallbacka-FALLBACKEN enda vägen till approaching.
  const makeStallbackaVessel = (meters, overrides = {}) => {
    const pos = southOf(BRIDGES.stallbackabron, meters);
    return {
      mmsi: 265999102,
      name: 'STALLBACKAFARAREN',
      sog: 3.0,
      cog: 0, // bäring till bron är 0° — _isActuallyApproaching släpper igenom
      status: 'en-route',
      targetBridge: null,
      lat: pos.lat,
      lon: pos.lon,
      _lastStatusChangeTime: now - 60_000,
      ...overrides,
    };
  };

  const farProximity = () => ({
    nearestBridge: { id: 'stridsbergsbron', name: 'Stridsbergsbron', distance: 2068 },
    nearestDistance: 2068,
    bridgeDistances: {},
  });

  test('285 m från Stallbackabron (dödbandet) → approaching via fallbacken', () => {
    const vessel = makeStallbackaVessel(285);
    const result = statusService.analyzeVesselStatus(vessel, farProximity());

    expect(result.status).toBe('approaching');
    expect(vessel.currentBridge).toBe('Stallbackabron');
  });

  test('265 m från Stallbackabron → stallbacka-waiting tar över (fallbacken stjäl inte)', () => {
    const vessel = makeStallbackaVessel(265);
    const result = statusService.analyzeVesselStatus(vessel, farProximity());

    expect(result.status).toBe('stallbacka-waiting');
    expect(statusService._isApproaching(vessel, farProximity())).toBe(false);
  });
});

/**
 * FG-PB: bortfärdsvakt mot REDAN PASSERAD mellanbro.
 *
 * Mellanbrogrenarnas passagespärrar var alla tidsbegränsade (_hasRecentlyPassed
 * 180 s, intern grace 3 min, passage-cooldown 3 min, passage-latch 10 min TTL)
 * eller bet bara på FRUSEN position (FP9-retrograden). En LÅNGSAM båt ligger
 * kvar i bandet 270–550 m BORTOM bron när de löpt ut och fick därför
 * "närmar sig [bron]" — och under 280 m "inväntar broöppning av [bron]" — för
 * en bro den redan passerat och rör sig BORT ifrån.
 *
 * Vakten är RÖRELSEVILLKORAD, inte en rå passedBridges-spärr: listan rensas
 * bara vid BEKRÄFTAD vändning (Fix D / re-cross-bevis / NEW_JOURNEY — samtliga
 * kräver sog ≥ 2,0 kn), så en långsam legitim returresa har bron kvar i listan
 * hela vägen fram till den nya korsningen och hade blivit statuslös av en
 * permanent spärr.
 */
describe('FG-PB: bortfärdsvakt mot redan passerad mellanbro', () => {
  let now;
  let statusService;
  let proximityService;

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
      { shouldBlockStatus: jest.fn().mockReturnValue(false) }, // latch-TTL:n har löpt ut
    );
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  const northOf = (bridge, meters) => ({
    lat: bridge.lat + meters / 111320,
    lon: bridge.lon,
  });

  // Nordgående båt NORR om Olidebron som redan passerat den för 10 min sedan:
  // 180 s-fönstret, grace (3 min), cooldown (3 min) och latchen (10 min) är
  // alla ute. Färsk position efter passagen ⇒ FP9-retrograden biter inte.
  // Bäringen till bron är 180° härifrån: cog 20 = BORT, cog 200 = MOT.
  const makePassedOlidebronVessel = (meters, overrides = {}) => {
    const pos = northOf(BRIDGES.olidebron, meters);
    return {
      mmsi: 265999103,
      name: 'LÅNGSAMFARAREN',
      sog: 0.9, // för långsam för Fix D/NEW_JOURNEY-resetten (kräver ≥ 2,0 kn)
      cog: 20,
      status: 'en-route',
      targetBridge: 'Klaffbron',
      lat: pos.lat,
      lon: pos.lon,
      passedBridges: ['Olidebron'],
      passedAt: { Olidebron: now - 600_000 },
      lastPassedBridge: 'Olidebron',
      lastPassedBridgeTime: now - 600_000,
      lastPositionUpdate: now - 30_000, // färsk position EFTER passagen
      lastPosition: northOf(BRIDGES.olidebron, meters - 20), // +20 m = bortfärd
      _lastStatusChangeTime: now - 60_000,
      ...overrides,
    };
  };

  // Samma båt som vänt: kursen mot bron OCH krympande avstånd.
  const returning = (meters) => ({
    cog: 200,
    lastPosition: northOf(BRIDGES.olidebron, meters + 30), // −30 m = närfärd
  });

  test('BUGGEN: 350 m bortom nyss passerad Olidebron, på väg BORT ⇒ INTE approaching', () => {
    const vessel = makePassedOlidebronVessel(350);
    const prox = proximityService.analyzeVesselProximity(vessel);

    // Förutsättningar: mellanbrogrenen är enda vägen och alla tidsspärrar ute.
    expect(prox.nearestBridge.name).toBe('Olidebron');
    expect(prox.nearestDistance).toBeGreaterThan(STATUS_HYSTERESIS.WAITING_SET_DISTANCE);
    expect(prox.nearestDistance).toBeLessThan(STATUS_HYSTERESIS.APPROACHING_SET_DISTANCE);
    expect(statusService._hasRecentlyPassed(vessel)).toBe(false);
    expect(statusService._isStaleRepassOfPassedBridge(vessel, 'Olidebron')).toBe(false);

    expect(statusService._isApproaching(vessel, prox)).toBe(false);

    const result = statusService.analyzeVesselStatus(vessel, prox);
    expect(result.status).toBe('en-route');
    expect(result.isApproaching).toBe(false);
    expect(vessel.currentBridge).not.toBe('Olidebron');
  });

  test('LEGITIM RETURRESA: samma bro i passedBridges men båten närmar sig bevisligen ⇒ approaching', () => {
    const vessel = makePassedOlidebronVessel(350, returning(350));
    const prox = proximityService.analyzeVesselProximity(vessel);

    expect(statusService._isDepartingPassedBridge(vessel, 'Olidebron', prox.nearestDistance)).toBe(false);

    const result = statusService.analyzeVesselStatus(vessel, prox);
    expect(result.status).toBe('approaching');
    expect(vessel.currentBridge).toBe('Olidebron');
  });

  test('returresa med ENBART kursbevis (avståndsdelta saknas) släpps också igenom', () => {
    const vessel = makePassedOlidebronVessel(350, { cog: 200, lastPosition: null });
    const prox = proximityService.analyzeVesselProximity(vessel);

    expect(statusService._isApproaching(vessel, prox)).toBe(true);
  });

  test('KVARLIGGARE utan rörelsebevis spärras INTE (status quo, ingen flapp-risk)', () => {
    // sog under stillaståendetröskeln ⇒ COG är brus och används inte;
    // oförändrad position ⇒ varken när- eller bortfärdsbevis.
    const vessel = makePassedOlidebronVessel(350, {
      sog: 0.05,
      lastPosition: northOf(BRIDGES.olidebron, 350),
    });
    const prox = proximityService.analyzeVesselProximity(vessel);

    expect(statusService._isDepartingPassedBridge(vessel, 'Olidebron', prox.nearestDistance)).toBe(false);
    expect(statusService._isApproaching(vessel, prox)).toBe(true);
  });

  test('vakten är NARROW: bro som INTE ligger i passedBridges rörs inte', () => {
    const vessel = makePassedOlidebronVessel(350, {
      passedBridges: [],
      passedAt: {},
      lastPassedBridge: null,
      lastPassedBridgeTime: null,
    });
    const prox = proximityService.analyzeVesselProximity(vessel);

    expect(statusService._isDepartingPassedBridge(vessel, 'Olidebron', prox.nearestDistance)).toBe(false);
    expect(statusService._isApproaching(vessel, prox)).toBe(true);
  });

  test('180 s-fönstret oförändrat: inom fönstret ger "passed", inte approaching', () => {
    const vessel = makePassedOlidebronVessel(350, {
      lastPassedBridgeTime: now - 60_000, // 60 s sedan passagen
    });
    const prox = proximityService.analyzeVesselProximity(vessel);

    expect(statusService._hasRecentlyPassed(vessel)).toBe(true);
    expect(statusService._isApproaching(vessel, prox)).toBe(false);
    expect(statusService.analyzeVesselStatus(vessel, prox).status).toBe('passed');
  });

  test('FP9-retrograden oförändrad: frusen position spärrar även med närfärdsbevis', () => {
    const vessel = makePassedOlidebronVessel(350, {
      ...returning(350),
      lastPositionUpdate: now - 700_000, // ingen ny position sedan passagen
      timestamp: now - 700_000,
    });
    const prox = proximityService.analyzeVesselProximity(vessel);

    expect(statusService._isStaleRepassOfPassedBridge(vessel, 'Olidebron')).toBe(true);
    expect(statusService._isApproaching(vessel, prox)).toBe(false);
  });

  test('SYMMETRI: mellanbro-waiting får samma vakt (250 m, på väg bort ⇒ inte waiting)', () => {
    const vessel = makePassedOlidebronVessel(250);
    const prox = proximityService.analyzeVesselProximity(vessel);

    expect(prox.nearestDistance).toBeLessThanOrEqual(STATUS_HYSTERESIS.WAITING_SET_DISTANCE);
    expect(statusService._isWaiting(vessel, prox)).toBe(false);
    expect(statusService.analyzeVesselStatus(vessel, prox).status).toBe('en-route');
  });

  test('SYMMETRI: mellanbro-waiting släpper igenom den legitima returresan', () => {
    const vessel = makePassedOlidebronVessel(250, returning(250));
    const prox = proximityService.analyzeVesselProximity(vessel);

    expect(statusService._isWaiting(vessel, prox)).toBe(true);
    expect(statusService.analyzeVesselStatus(vessel, prox).status).toBe('waiting');
  });

  test('Stallbacka-fallbacken: bortfärd från passerad Stallbackabron slår fartfallbacken (sog > 2 kn)', () => {
    const pos = { lat: BRIDGES.stallbackabron.lat - 350 / 111320, lon: BRIDGES.stallbackabron.lon };
    const vessel = {
      mmsi: 265999104,
      name: 'STALLBACKAAVFARAREN',
      sog: 3.0, // _isActuallyApproaching Method 3 hade annars sagt "annalkande"
      cog: 180, // bäringen till bron är 0° härifrån ⇒ kursen pekar BORT
      status: 'en-route',
      targetBridge: null,
      lat: pos.lat,
      lon: pos.lon,
      passedBridges: ['Stallbackabron'],
      passedAt: { Stallbackabron: now - 600_000 },
      lastPassedBridge: 'Stallbackabron',
      lastPassedBridgeTime: now - 600_000,
      lastPositionUpdate: now - 30_000,
      lastPosition: { lat: BRIDGES.stallbackabron.lat - 330 / 111320, lon: BRIDGES.stallbackabron.lon },
      _lastStatusChangeTime: now - 60_000,
    };
    const farProx = {
      nearestBridge: { id: 'stridsbergsbron', name: 'Stridsbergsbron', distance: 2068 },
      nearestDistance: 2068,
      bridgeDistances: {},
    };

    expect(statusService._isApproaching(vessel, farProx)).toBe(false);
    expect(statusService.analyzeVesselStatus(vessel, farProx).status).toBe('en-route');
  });
});
