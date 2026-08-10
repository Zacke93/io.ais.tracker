'use strict';

jest.mock('homey');

const { __mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const geometry = require('../lib/utils/geometry');
const constants = require('../lib/constants');

const { FLOW_CONSTANTS, TRIGGER_POINTS } = constants;
const TP = TRIGGER_POINTS.kanalinfarten;
const THRESHOLD = FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD;

/**
 * C0-förarbetet 2026-08-10 (FG-RAD) — BRO-LOKAL NOTISRADIE.
 *
 * BAKGRUND: boat_near-kandidaternas avståndsgrind läste uteslutande den
 * GLOBALA FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD (300 m), medan
 * BRIDGES.radius (också 300 m på alla fem broar) var helt oanvänd av
 * flow-vägen. C0 (Stallbackabrons koordinaträttning) villkoras av att
 * radien KAN sättas per bro. _getFlowTriggerCandidates läser den nu via
 * hjälpfunktionen bridgeThreshold() på EXAKT TVÅ ställen:
 *   1. addCandidate-grinden (target/current/just-passed)
 *   2. nearest-förgrinden (enda kandidatkällan för båtar utan
 *      target/current — kajavgångs- och återfödelseklassen)
 * TRIGGER_POINTS-grenens två ställen (`dist <= threshold` och distansvalet)
 * är MEDVETET globala: Kanalinfarten är ingen bro och finns inte i
 * bridgeRegistry. En tidigare sed-prototyp bytte inte alla fyra ställena
 * och tappade 26+ notiser i mätningen — därav A2.4 och TP-vakten nedan.
 *
 * Suiten bevisar tre saker samtidigt:
 *   • att beteendet i dag är IDENTISKT (A2.1 + ränderna i A2.3),
 *   • att kopplingen ändå är LEVANDE (A2.2 — annars vore hela refaktorn
 *     osynlig för testerna och kunde tyst rullas tillbaka),
 *   • att trigger-punkten inte drogs med (A2.4 + TP-vakten).
 */

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

/** Lättviktig app-instans för direktanrop av _getFlowTriggerCandidates. */
function makeCandidateApp(bridgeRegistry) {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app.bridgeRegistry = bridgeRegistry || new BridgeRegistry();
  return app;
}

/**
 * Registry-attrapp som ger en PÅHITTAD radie per bronamn. Saknar lat/lon
 * med flit: resolveDistance ska då falla tillbaka på proximityData:s
 * distanser, så testet mäter grinden och inte geometrin.
 */
const fakeRegistry = (radiusByName) => ({
  getBridgeByName: (name) => (
    Object.prototype.hasOwnProperty.call(radiusByName, name)
      ? { name, radius: radiusByName[name] }
      : null
  ),
});

/** Position rakt NORR om trigger-punkten på ungefär angivet avstånd. */
const northOfTp = (distanceM) => ({
  lat: TP.lat + distanceM / 111320,
  lon: TP.lon,
});

/** Nordgående båt i/vid Kanalinfartens zon (FRAM-klassen: cog 31°, sog 4,6). */
const tpVessel = (distanceM, over = {}) => ({
  mmsi: '265999001',
  name: 'FG-RAD TP',
  ...northOfTp(distanceM),
  sog: 4.6,
  cog: 31,
  timestamp: Date.now(),
  lastPositionUpdate: Date.now(),
  ...over,
});

describe('A2.1 (FG-RAD): identitetslås — bro-radie === global tröskel', () => {
  // ⚠️ DETTA TEST SKA UPPDATERAS, INTE TAS BORT, när en bro-lokal radie
  // införs på riktigt (C0: Stallbackabron kan behöva en större radie för
  // att rädda terminalfixarna LAMANTIJN/EXCALIBUR X119/SIESTA). Så länge
  // det är grönt är FG-RAD-refaktorn BEVISBART beteendeneutral: varje bro
  // grindar på exakt samma tal som den globala tröskeln gjorde före
  // ändringen. Den dag en radie medvetet avviker ska raden för den bron
  // få ett eget, motiverat förväntat värde — och en konsekvensmätning.
  test('alla broar i bridgeRegistry har radius === FLOW_TRIGGER_DISTANCE_THRESHOLD', () => {
    const registry = new BridgeRegistry();
    const bridgeIds = registry.getAllBridgeIds();

    expect(bridgeIds.length).toBeGreaterThan(0);
    for (const bridgeId of bridgeIds) {
      const bridge = registry.getBridge(bridgeId);
      expect(Number.isFinite(bridge.radius)).toBe(true);
      expect(bridge.radius).toBe(THRESHOLD);
    }
  });

  test('trigger-punkten har egen radie som INTE styr flow-grenen (global tröskel gäller där)', () => {
    // Dokumenterar avsiktligt att TRIGGER_POINTS.kanalinfarten.radius är en
    // separat, i dag oläst storhet i den här kodvägen. Se TP-vakten nedan.
    expect(TP.radius).toBe(THRESHOLD);
    expect(new BridgeRegistry().getBridgeByName(TP.name)).toBeNull();
  });
});

describe('A2.2 (FG-RAD): kopplingen är levande — grinden läser bro-radien', () => {
  // Utan det här testet skulle en tyst återgång till hårdkodad global
  // tröskel passera hela suiten (alla radier är ju 300 i dag).
  test('addCandidate-grinden släpper in 400 m när bron har radius 500', () => {
    const app = makeCandidateApp(fakeRegistry({ Klaffbron: 500 }));
    const vessel = {
      mmsi: '265999010', name: 'Vid bro', currentBridge: 'Klaffbron', sog: 3, cog: 30,
    };
    const proximityData = { bridges: [{ name: 'Klaffbron', distance: 400 }], nearestBridge: null };

    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);
    expect(candidates.map((c) => [c.name, c.source])).toEqual([['Klaffbron', 'current']]);
  });

  test('addCandidate-grinden stänger ute 200 m när bron har radius 150', () => {
    const app = makeCandidateApp(fakeRegistry({ Klaffbron: 150 }));
    const vessel = {
      mmsi: '265999011', name: 'Vid bro', currentBridge: 'Klaffbron', sog: 3, cog: 30,
    };
    const proximityData = { bridges: [{ name: 'Klaffbron', distance: 200 }], nearestBridge: null };

    expect(app._getFlowTriggerCandidates(vessel, proximityData)).toHaveLength(0);
  });

  test('nearest-förgrinden läser samma bro-radie (400 m vid radius 500)', () => {
    const app = makeCandidateApp(fakeRegistry({ Olidebron: 500 }));
    const vessel = {
      mmsi: '265999012', name: 'Kajavgång', sog: 3, cog: 30, targetBridge: null, currentBridge: null,
    };
    const proximityData = { bridges: [], nearestBridge: { name: 'Olidebron', distance: 400 } };

    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);
    expect(candidates.map((c) => [c.name, c.source])).toEqual([['Olidebron', 'nearest']]);
  });

  test('bro utan giltig radius faller tillbaka på den globala tröskeln', () => {
    const app = makeCandidateApp(fakeRegistry({ Klaffbron: null }));
    const vessel = {
      mmsi: '265999013', name: 'Fallback', currentBridge: 'Klaffbron', sog: 3, cog: 30,
    };

    expect(app._getFlowTriggerCandidates(
      vessel, { bridges: [{ name: 'Klaffbron', distance: THRESHOLD - 1 }], nearestBridge: null },
    )).toHaveLength(1);
    expect(app._getFlowTriggerCandidates(
      { ...vessel, mmsi: '265999014' },
      { bridges: [{ name: 'Klaffbron', distance: THRESHOLD + 1 }], nearestBridge: null },
    )).toHaveLength(0);
  });
});

describe('A2.3 (FG-RAD): randfall 299/301 m — oförändrade i dag', () => {
  test('bro-grenen (current): 299 m ⇒ kandidat, 301 m ⇒ ingen', () => {
    const app = makeCandidateApp();
    const vessel = {
      mmsi: '265999020', name: 'Rand bro', currentBridge: 'Klaffbron', sog: 3, cog: 30,
    };

    expect(app._getFlowTriggerCandidates(
      vessel, { bridges: [{ name: 'Klaffbron', distance: 299 }], nearestBridge: null },
    ).map((c) => c.name)).toEqual(['Klaffbron']);

    expect(app._getFlowTriggerCandidates(
      vessel, { bridges: [{ name: 'Klaffbron', distance: 301 }], nearestBridge: null },
    )).toHaveLength(0);
  });

  test('bro-grenen (target): 299 m ⇒ kandidat, 301 m ⇒ ingen', () => {
    const app = makeCandidateApp();
    const vessel = {
      mmsi: '265999021', name: 'Rand target', targetBridge: 'Stridsbergsbron', sog: 3, cog: 30,
    };

    expect(app._getFlowTriggerCandidates(
      vessel, { bridges: [{ name: 'Stridsbergsbron', distance: 299 }], nearestBridge: null },
    ).map((c) => c.source)).toEqual(['target']);

    expect(app._getFlowTriggerCandidates(
      vessel, { bridges: [{ name: 'Stridsbergsbron', distance: 301 }], nearestBridge: null },
    )).toHaveLength(0);
  });

  test('nearest-grenen: 299 m ⇒ kandidat, 301 m ⇒ ingen (båt utan target/current)', () => {
    const app = makeCandidateApp();
    const vessel = {
      mmsi: '265999022', name: 'Rand nearest', sog: 3, cog: 30, targetBridge: null, currentBridge: null,
    };

    expect(app._getFlowTriggerCandidates(
      vessel, { bridges: [], nearestBridge: { name: 'Järnvägsbron', distance: 299 } },
    ).map((c) => c.source)).toEqual(['nearest']);

    expect(app._getFlowTriggerCandidates(
      vessel, { bridges: [], nearestBridge: { name: 'Järnvägsbron', distance: 301 } },
    )).toHaveLength(0);
  });

  test('TRIGGER_POINTS-grenen (Kanalinfarten): 299 m ⇒ kandidat, 301 m ⇒ ingen', () => {
    const app = makeCandidateApp();
    const proximityData = { bridges: [], nearestBridge: null };

    const inside = tpVessel(299);
    const outside = tpVessel(301, { mmsi: '265999031' });
    // Riggen är självkontrollerande: latitudoffseten ska ge äkta 299/301 m.
    expect(geometry.calculateDistance(inside.lat, inside.lon, TP.lat, TP.lon)).toBeLessThan(THRESHOLD);
    expect(geometry.calculateDistance(outside.lat, outside.lon, TP.lat, TP.lon)).toBeGreaterThan(THRESHOLD);

    expect(app._getFlowTriggerCandidates(inside, proximityData)
      .filter((c) => c.source === 'trigger-point').map((c) => c.name)).toEqual(['Kanalinfarten']);
    expect(app._getFlowTriggerCandidates(outside, proximityData)
      .filter((c) => c.source === 'trigger-point')).toHaveLength(0);
  });

  test('TP-VAKT: en stor BRO-radie får INTE läcka in i trigger-punktens grind', () => {
    // Direkt skydd mot att någon "rättar" de två TP-ställena till
    // bridgeThreshold(). Registry-attrappen ger radius 1000 för ALLA namn
    // (inklusive 'Kanalinfarten'): bron på 400 m blir kandidat, men
    // trigger-punkten på 400 m ska fortfarande falla på den globala 300:an.
    const app = makeCandidateApp(fakeRegistry({ Kanalinfarten: 1000, Olidebron: 1000 }));
    const vessel = tpVessel(400, { mmsi: '265999032', currentBridge: 'Olidebron' });
    const proximityData = { bridges: [{ name: 'Olidebron', distance: 400 }], nearestBridge: null };

    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);
    expect(candidates.map((c) => c.name)).toEqual(['Olidebron']);
    expect(candidates.some((c) => c.source === 'trigger-point')).toBe(false);
  });
});

describe('A2.4 (FG-RAD): negativtest mot sed-prototypens 26+ tappade notiser', () => {
  test('~250 m från Kanalinfarten utan bro inom 300 m ⇒ fortfarande kandidat via trigger-punkten', () => {
    const app = makeCandidateApp();
    const vessel = tpVessel(250, { mmsi: '265999040' });

    // Verkligheten i rådatan: närmaste bro (Olidebron) ligger ~625 m bort,
    // dvs. HELA notisen hänger på trigger-punktsgrenen.
    const { olidebron } = constants.BRIDGES;
    const distToOlide = geometry.calculateDistance(vessel.lat, vessel.lon, olidebron.lat, olidebron.lon);
    expect(distToOlide).toBeGreaterThan(THRESHOLD);

    const candidates = app._getFlowTriggerCandidates(vessel, {
      bridges: [],
      nearestBridge: { name: 'Olidebron', distance: distToOlide },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: 'Kanalinfarten', source: 'trigger-point' });
  });

  test('samma båt med en avlägsen målbro: målbron faller på avstånd, TP-kandidaten står kvar', () => {
    const app = makeCandidateApp();
    const vessel = tpVessel(250, { mmsi: '265999041', targetBridge: 'Klaffbron' });

    const candidates = app._getFlowTriggerCandidates(vessel, { bridges: [], nearestBridge: null });

    expect(candidates.map((c) => c.name)).toEqual(['Kanalinfarten']);
  });
});

describe('FG-RAD: hela notisvägen (rörelsebevis, färskhet, dedup) — oförändrad', () => {
  let originalGetTriggerCard;
  let originalGetConditionCard;
  let originalEnv;
  let originalTestMode;

  beforeEach(() => {
    jest.clearAllMocks();
    originalGetTriggerCard = __mockHomey.flow.getTriggerCard;
    originalGetConditionCard = __mockHomey.flow.getConditionCard;
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    originalTestMode = global.__TEST_MODE__;
    delete global.__TEST_MODE__;
  });

  afterEach(() => {
    __mockHomey.flow.getTriggerCard = originalGetTriggerCard;
    __mockHomey.flow.getConditionCard = originalGetConditionCard;
    process.env.NODE_ENV = originalEnv;
    if (originalTestMode === undefined) {
      delete global.__TEST_MODE__;
    } else {
      global.__TEST_MODE__ = originalTestMode;
    }
  });

  // Husets mockmönster (tests/flow-trigger-bridges.test.js): riktiga
  // flow-kort ur homey-mocken, riktig BridgeRegistry/ProximityService och
  // tomma dedup-strukturer. Vessels nedan bär sog ≥ 0,5 (rörelsebevis,
  // RC-S3) och färsk timestamp (F5) så bara avståndsgrinden avgör.
  const setupApp = async () => {
    const TriggerPrototype = originalGetTriggerCard('boat_near').constructor;
    const ConditionPrototype = originalGetConditionCard('boat_at_bridge').constructor;

    const triggerCard = new TriggerPrototype();
    const conditionCard = new ConditionPrototype();

    __mockHomey.flow.getTriggerCard = jest.fn(() => triggerCard);
    __mockHomey.flow.getConditionCard = jest.fn(() => conditionCard);

    const logger = makeLogger();
    const app = new AISBridgeApp();
    app.homey = __mockHomey;
    app.log = logger.log;
    app.debug = logger.debug;
    app.error = logger.error;

    app.bridgeRegistry = new BridgeRegistry();
    app.proximityService = new ProximityService(app.bridgeRegistry, logger);
    app.vesselDataService = { getAllVessels: jest.fn(() => []) };
    app._triggeredBoatNearKeys = new Set();
    app._devices = new Set();

    jest.useFakeTimers();
    app._testTriggerFunctionality = jest.fn().mockResolvedValue(undefined);
    await app._setupFlowCards();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();

    triggerCard.clearTriggerCalls();

    return { app, triggerCard };
  };

  const bridgeVessel = (over = {}) => {
    const klaff = constants.BRIDGES.klaffbron;
    return {
      mmsi: '265999050',
      name: 'FG-RAD Bro',
      lat: klaff.lat - 0.001,
      lon: klaff.lon,
      sog: 3,
      cog: 30,
      status: 'waiting',
      targetBridge: 'Klaffbron',
      currentBridge: 'Klaffbron',
      etaMinutes: 4,
      timestamp: Date.now(),
      ...over,
    };
  };

  test('299 m från bron ⇒ notis avfyras (radius 300 = global tröskel)', async () => {
    const { app, triggerCard } = await setupApp();
    jest.spyOn(app.proximityService, 'analyzeVesselProximity').mockReturnValue({
      bridges: [{ name: 'Klaffbron', distance: 299 }],
      nearestBridge: { name: 'Klaffbron', distance: 299 },
    });

    await app._triggerBoatNearFlow(bridgeVessel());

    const calls = triggerCard.getTriggerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tokens.bridge_name).toBe('Klaffbron');
  });

  test('301 m från bron ⇒ ingen notis', async () => {
    const { app, triggerCard } = await setupApp();
    jest.spyOn(app.proximityService, 'analyzeVesselProximity').mockReturnValue({
      bridges: [{ name: 'Klaffbron', distance: 301 }],
      nearestBridge: { name: 'Klaffbron', distance: 301 },
    });

    await app._triggerBoatNearFlow(bridgeVessel({ mmsi: '265999051' }));

    expect(triggerCard.getTriggerCalls()).toHaveLength(0);
  });

  test('nearest-grenen: båt utan target/current på 299 m ⇒ notis (kajavgångsklassen)', async () => {
    const { app, triggerCard } = await setupApp();
    jest.spyOn(app.proximityService, 'analyzeVesselProximity').mockReturnValue({
      bridges: [],
      nearestBridge: { name: 'Olidebron', distance: 299 },
    });

    await app._triggerBoatNearFlow(bridgeVessel({
      mmsi: '265999052', targetBridge: null, currentBridge: null, etaMinutes: null,
    }));

    const calls = triggerCard.getTriggerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tokens.bridge_name).toBe('Olidebron');
  });

  test('A2.4 i notisvägen: 250 m från Kanalinfarten utan bro inom 300 m ⇒ notis', async () => {
    const { app, triggerCard } = await setupApp();
    jest.spyOn(app.proximityService, 'analyzeVesselProximity').mockReturnValue({
      bridges: [],
      nearestBridge: { name: 'Olidebron', distance: 625 },
    });

    await app._triggerBoatNearFlow(tpVessel(250, { mmsi: '265999053', status: 'approaching' }));

    const calls = triggerCard.getTriggerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tokens.bridge_name).toBe('Kanalinfarten');
  });
});
