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
