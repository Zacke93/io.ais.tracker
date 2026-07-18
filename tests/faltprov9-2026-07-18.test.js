'use strict';

/**
 * Fältprov 9 (2026-07-18) — 41h-körningen 20260713-221737, 388 825 rader,
 * 130 Opus 4.8 xhigh-läsare + dirigentens korsningsfacit (143 zonkorsningar).
 * Sju fixar, alla rådata- och kodverifierade före implementation:
 *
 *  FIX A — SEEBAER III 10:02: N2-journey-resetten rensade dedup utan
 *          riktningsbevis → TP-exit-notisen dubblerades av reborn-svepet.
 *  FIX B — NORFJELL 01:01: multi-passage i samma tick — lastPassedBridge
 *          höll bara sista passagen; målbrons (Strids) failsafe uteblev.
 *  FIX C — VIRGO 11:32: TP-grenen saknade gate för icke-southbound —
 *          kajliggare med drift-cog 330° fick en-route-fantomnotis.
 *  FIX D — RONJA 18:35: persistent-dedupens 2h-utgång var ovillkorlig —
 *          samma sydgående Järnvägsbro-passage re-notifierades 3h21m senare.
 *  FIX I1 — FREE WILLY 12:55: under-SJÄLVA-målbron-dominansen tvingade
 *          "strax" på 600–784 s frusen position i 13 min.
 *  FIX J — NORFJELL 01:06 m.fl.: notistokens ETA var ett AIS-gap gammal
 *          (6 vs 1,3 min) — fysiskt distans/fart-tak.
 *  FIX L — SEEBAER III 09:38 / NORDIC SOLA 09:16: latch-utgång på frusen
 *          position gav retrograd waiting/approaching för passerad bro.
 */

const EventEmitter = require('events');
const AISBridgeApp = require('../app');
const BridgeTextService = require('../lib/services/BridgeTextService');

const makeLogger = () => ({ debug: jest.fn(), error: jest.fn(), log: jest.fn() });

function makeApp(overrides = {}) {
  const app = Object.create(AISBridgeApp.prototype);
  app.debug = jest.fn();
  app.log = jest.fn();
  app.error = jest.fn();
  Object.assign(app, overrides);
  return app;
}

const loggedWith = (fn, needle) => fn.mock.calls.some((c) => String(c[0]).includes(needle));

// ---------------------------------------------------------------------------
// FIX A: N2-resettens riktningsvillkor (journey-reset-lyssnaren)
// ---------------------------------------------------------------------------
describe('FP9 FIX A: N2-journey-reset kräver riktningsbyte (SEEBAER III-dubbletten)', () => {
  function makeResetApp() {
    const app = makeApp();
    app.vesselDataService = new EventEmitter();
    app._triggeredBoatNearKeys = new Set(['211327190:Kanalinfarten']);
    app._persistentRecentTriggers = new Map([
      ['211327190:Kanalinfarten', { t: Date.now() - 15 * 60 * 1000, dir: 'south' }],
    ]);
    app._persistRecentTriggers = jest.fn();
    app._clearBoatNearTriggers = jest.fn();
    // Registrera ENDAST journey-reset-lyssnaren (samma kropp som
    // _setupEventHandlers binder) genom att plocka den via en riktig
    // registrering vore idealt, men _setupEventHandlers kräver hela
    // tjänstegrafen — vi anropar i stället lyssnarkroppen via emit efter
    // manuell bindning av exakt samma handler som prod använder.
    return app;
  }

  // Prod-lyssnaren är inline i _setupEventHandlers; vi binder den via en
  // minimal tjänstegraf och plockar callbacken med listeners().
  function bindProdListener(app) {
    const noopEmitter = new EventEmitter();
    app.statusService = noopEmitter;
    app.aisClient = noopEmitter;
    app.homey = {
      settings: { get: jest.fn(), set: jest.fn(), on: jest.fn() },
      flow: { getDeviceTriggerCard: jest.fn(), getTriggerCard: jest.fn(), getConditionCard: jest.fn(() => ({ registerRunListener: jest.fn() })) },
    };
    try {
      app._setupEventHandlers();
    } catch (err) {
      // Senare registreringar i metoden kan falla på stubbarna — lyssnaren
      // vi behöver binds tidigt; verifiera att den finns.
    }
    const ls = app.vesselDataService.listeners('vessel:journey-reset');
    expect(ls.length).toBeGreaterThan(0);
    return ls[0];
  }

  test('reborn i SAMMA riktning som förra resan behåller dedup-nycklarna', () => {
    const app = makeResetApp();
    const listener = bindProdListener(app);
    listener({
      mmsi: '211327190',
      vessel: {
        mmsi: '211327190', cog: 243.7, sog: 2.7, _routeDirection: null,
      },
      prevJourneyDirection: 'south',
    });
    expect(loggedWith(app.log, 'JOURNEY_RESET_SAME_DIRECTION')).toBe(true);
    expect(app._clearBoatNearTriggers).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has('211327190:Kanalinfarten')).toBe(true);
    expect(app._persistentRecentTriggers.has('211327190:Kanalinfarten')).toBe(true);
  });

  test('reborn i MOTSATT riktning (äkta retur) rensar som förut', () => {
    const app = makeResetApp();
    const listener = bindProdListener(app);
    listener({
      mmsi: '211327190',
      vessel: {
        mmsi: '211327190', cog: 30, sog: 4.0, _routeDirection: null,
      },
      prevJourneyDirection: 'south',
    });
    expect(loggedWith(app.log, 'JOURNEY_RESET_SAME_DIRECTION')).toBe(false);
    expect(app._clearBoatNearTriggers).toHaveBeenCalled();
  });

  test('okänd reborn-riktning (låg fart) behåller också nycklarna (ELFKUNGEN 14:56)', () => {
    // ELFKUNGEN reborn:ade med sog 0 → riktning obevisbar (F4-C) → gamla
    // okänd-grenen rensade och dubbletten släpptes i replay-harnessen
    // (prods completedJourneys-prune hade råkat maskera vägen). Äkta
    // returer täcks av flip-släppet/NEW_JOURNEY — rensning kräver nu
    // BEVISAD motsatt riktning.
    const app = makeResetApp();
    const listener = bindProdListener(app);
    listener({
      mmsi: '211327190',
      vessel: {
        mmsi: '211327190', cog: 243.7, sog: 0.5, _routeDirection: null,
      },
      prevJourneyDirection: 'south',
    });
    expect(loggedWith(app.log, 'JOURNEY_RESET_SAME_DIRECTION')).toBe(true);
    expect(app._clearBoatNearTriggers).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has('211327190:Kanalinfarten')).toBe(true);
  });

  test('N1-vägen (bridges-lista, korsningsbevisad reversal) berörs inte av riktningsvillkoret', () => {
    const app = makeResetApp();
    const listener = bindProdListener(app);
    listener({
      mmsi: '211327190',
      vessel: {
        mmsi: '211327190', cog: 30, sog: 4.0, _routeDirection: 'north',
      },
      bridges: ['Kanalinfarten'],
    });
    expect(app._triggeredBoatNearKeys.has('211327190:Kanalinfarten')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX B: multi-passage i samma tick → failsafe för varje nytillkommen bro
// ---------------------------------------------------------------------------
describe('FP9 FIX B: multi-passage-diffen (NORFJELL Strids-missen)', () => {
  function makeUpdateApp() {
    const app = makeApp();
    app.statusService = { clearVesselETAHistory: jest.fn() };
    app.vesselDataService = { hasGpsJumpHold: jest.fn(() => false) };
    app._vesselRemovalTimers = new Map();
    app._analyzeVesselPosition = jest.fn(async () => {});
    app._triggerBoatNearFlow = jest.fn(async () => {});
    app._checkSkippedBridgesFallback = jest.fn(async () => {});
    app._triggerBoatNearFlowFallback = jest.fn(async () => {});
    app._updateUIIfNeeded = jest.fn();
    return app;
  }

  test('två broar ankrade i samma tick → failsafe begärs för BÅDA (delad-array-immun)', async () => {
    const app = makeUpdateApp();
    const now = Date.now();
    // NORFJELL-geometrin: Strids (target, trajectory) + Järnvägsbron
    // (intermediate) ankrade i samma tick; lastPassedBridge slutade som
    // Järnvägsbron. REGRESSIONSKRAV: passedBridges-arrayen DELAS by
    // reference mellan vessel och oldVessel (_createVesselObject) — first
    // fix-varianten diffade old-listan och var därför död i produktion
    // (replayfynd). Testet speglar delningen exakt.
    const sharedPassed = ['Stridsbergsbron', 'Järnvägsbron'];
    const vessel = {
      mmsi: '257076850',
      targetBridge: 'Klaffbron',
      lastPassedBridge: 'Järnvägsbron',
      lastPassedBridgeTime: now,
      passedBridges: sharedPassed,
      passedAt: { Stridsbergsbron: now - 20, Järnvägsbron: now - 10 },
      lat: 58.29096,
      lon: 12.29106,
    };
    const oldVessel = {
      targetBridge: 'Stridsbergsbron',
      lastPassedBridge: null,
      lastPassedBridgeTime: null,
      passedBridges: sharedPassed, // samma referens som prod
      passedAt: vessel.passedAt, // delas också (rad 3045-mönstret)
    };
    await app._onVesselUpdated({ mmsi: '257076850', vessel, oldVessel });
    const requested = app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
    expect(requested).toContain('Järnvägsbron'); // BUG C-vägen (senast stämplad)
    expect(requested).toContain('Stridsbergsbron'); // FP9-diffen (målbron)
    expect(loggedWith(app.log, 'MULTI_PASSAGE_FALLBACK')).toBe(true);
  });

  test('en enda färsk ankring per tick → ingen dubbelprövning av samma bro', async () => {
    const app = makeUpdateApp();
    const now = Date.now();
    const vessel = {
      mmsi: '257076850',
      targetBridge: 'Klaffbron',
      lastPassedBridge: 'Järnvägsbron',
      lastPassedBridgeTime: now,
      passedBridges: ['Järnvägsbron'],
      passedAt: { Järnvägsbron: now - 10 },
      lat: 58.29,
      lon: 12.29,
    };
    const oldVessel = { targetBridge: 'Klaffbron', passedBridges: vessel.passedBridges };
    await app._onVesselUpdated({ mmsi: '257076850', vessel, oldVessel });
    const requested = app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
    expect(requested.filter((b) => b === 'Järnvägsbron')).toHaveLength(1);
    expect(loggedWith(app.log, 'MULTI_PASSAGE_FALLBACK')).toBe(false);
  });

  test('gamla ankringar (U-svängens historik) triggar inget', async () => {
    const app = makeUpdateApp();
    const vessel = {
      mmsi: '257076850',
      targetBridge: 'Klaffbron',
      lastPassedBridge: null,
      lastPassedBridgeTime: null,
      passedBridges: ['Stridsbergsbron', 'Järnvägsbron'],
      passedAt: {
        Stridsbergsbron: Date.now() - 40 * 60 * 1000,
        Järnvägsbron: Date.now() - 35 * 60 * 1000,
      },
      lat: 58.29,
      lon: 12.29,
    };
    const oldVessel = { targetBridge: 'Klaffbron', passedBridges: vessel.passedBridges };
    await app._onVesselUpdated({ mmsi: '257076850', vessel, oldVessel });
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FIX C: TP-grenens transitindikationskrav för icke-southbound
// ---------------------------------------------------------------------------
describe('FP9 FIX C: TP-nordgaten (VIRGO-fantomen)', () => {
  // VIRGO-geometrin: lotskajen ~142 m från Kanalinfarten-punkten.
  const VIRGO_LAT = 58.26749;
  const VIRGO_LON = 12.26713;

  function makeTpApp() {
    const app = makeApp();
    app.bridgeRegistry = { getBridgeByName: jest.fn(() => null) };
    return app;
  }

  const proximityData = { bridges: [], nearestBridge: null };

  test('förtöjd drift-nordlig båt utan target och under 1 kn får INGEN TP-kandidat', () => {
    const app = makeTpApp();
    const vessel = {
      mmsi: '265552100',
      lat: VIRGO_LAT,
      lon: VIRGO_LON,
      sog: 0.6,
      cog: 330.1,
      targetBridge: null,
    };
    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);
    expect(candidates.some((c) => c.name === 'Kanalinfarten')).toBe(false);
    expect(loggedWith(app.debug, 'TRIGGER_POINT_SKIP_IDLE')).toBe(true);
  });

  test('äkta nordgående transitör (sog ≥ 1) får TP-kandidaten', () => {
    const app = makeTpApp();
    const vessel = {
      mmsi: '219029305',
      lat: VIRGO_LAT,
      lon: VIRGO_LON,
      sog: 7.3,
      cog: 31.6,
      targetBridge: null,
    };
    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);
    expect(candidates.some((c) => c.name === 'Kanalinfarten')).toBe(true);
  });

  test('långsam nordgående MED målbro får TP-kandidaten (väntande inkommande)', () => {
    const app = makeTpApp();
    const vessel = {
      mmsi: '219029305',
      lat: VIRGO_LAT,
      lon: VIRGO_LON,
      sog: 0.4,
      cog: 20,
      targetBridge: 'Klaffbron',
    };
    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);
    expect(candidates.some((c) => c.name === 'Kanalinfarten')).toBe(true);
  });

  test('sydgrenens kanalhistorik-gate är orörd (FP8-1-regressionen)', () => {
    const app = makeTpApp();
    const vessel = {
      mmsi: '265552060',
      lat: VIRGO_LAT,
      lon: VIRGO_LON,
      sog: 4.6,
      cog: 139.7,
      targetBridge: null,
      passedBridges: [],
      _firstSeenLat: VIRGO_LAT,
    };
    const candidates = app._getFlowTriggerCandidates(vessel, proximityData);
    expect(candidates.some((c) => c.name === 'Kanalinfarten')).toBe(false);
    expect(loggedWith(app.debug, 'TRIGGER_POINT_SKIP]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX D: persistent-dedup — samma riktning blockerar retro-källor bortom 2h
// ---------------------------------------------------------------------------
describe('FP9 FIX D: samma-riktnings-gaten bortom 2h-fönstret (RONJA-dubbletten)', () => {
  function makeDedupApp(entryAgeMs, dir) {
    const app = makeApp();
    app._PERSISTENT_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;
    app._PERSISTENT_DEDUP_RETENTION_MS = 6 * 60 * 60 * 1000;
    app._persistentRecentTriggers = new Map([
      ['219029789:Järnvägsbron', { t: Date.now() - entryAgeMs, dir }],
    ]);
    return app;
  }
  const ronja = { mmsi: '219029789', _routeDirection: 'south', sog: 0 };

  test('retroaktiv källa + samma riktning + 3h21m gammal post → BLOCKERAD', () => {
    const app = makeDedupApp(201 * 60 * 1000, 'south');
    const verdict = app._persistentDedupCheck('219029789:Järnvägsbron', ronja, { retroactiveSource: true });
    expect(verdict.blocked).toBe(true);
    expect(loggedWith(app.log, 'PERSISTENT_DEDUP_SAME_DIR_LATE')).toBe(true);
  });

  test('live-källa (retroactiveSource=false) släpps som förut bortom 2h', () => {
    const app = makeDedupApp(201 * 60 * 1000, 'south');
    const verdict = app._persistentDedupCheck('219029789:Järnvägsbron', ronja, {});
    expect(verdict.blocked).toBe(false);
  });

  test('motsatt riktning (äkta retur) släpps bortom 2h', () => {
    const app = makeDedupApp(201 * 60 * 1000, 'south');
    const north = { mmsi: '219029789', _routeDirection: 'north', sog: 4 };
    const verdict = app._persistentDedupCheck('219029789:Järnvägsbron', north, { retroactiveSource: true });
    expect(verdict.blocked).toBe(false);
  });

  test('post äldre än retention (6h) släpps även för retro + samma riktning', () => {
    const app = makeDedupApp(6 * 60 * 60 * 1000 + 60000, 'south');
    const verdict = app._persistentDedupCheck('219029789:Järnvägsbron', ronja, { retroactiveSource: true });
    expect(verdict.blocked).toBe(false);
  });

  test('riktningslös post (äldre format) släpps bortom 2h (dagens beteende)', () => {
    const app = makeDedupApp(201 * 60 * 1000, null);
    const verdict = app._persistentDedupCheck('219029789:Järnvägsbron', ronja, { retroactiveSource: true });
    expect(verdict.blocked).toBe(false);
  });

  test('inom 2h-fönstret: samma riktning blockerar precis som förut', () => {
    const app = makeDedupApp(51 * 60 * 1000, 'south');
    const verdict = app._persistentDedupCheck('219029789:Järnvägsbron', ronja, { retroactiveSource: true });
    expect(verdict.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX I1: under-målbron-dominansens färskhetsgate
// ---------------------------------------------------------------------------
describe('FP9 FIX I1: under-målbron kräver färsk position (FREE WILLY-strax-spöket)', () => {
  const svc = new BridgeTextService(null, makeLogger());

  const underBridgeVessel = (positionAgeMs) => ({
    mmsi: '211367520',
    targetBridge: 'Klaffbron',
    etaMinutes: null,
    status: 'under-bridge',
    currentBridge: 'Klaffbron',
    passedBridges: [],
    timestamp: Date.now() - positionAgeMs,
    lastPositionUpdate: Date.now() - positionAgeMs,
  });

  test('färsk under-målbron-position tvingar "strax" (NATHALIE-hörnfallet orört)', () => {
    const text = svc.generateBridgeText([underBridgeVessel(30 * 1000)]);
    expect(text).toContain('strax');
  });

  test('>10 min frusen under-målbron-position ger INTE "strax" (ETA okänd äger)', () => {
    const text = svc.generateBridgeText([underBridgeVessel(13 * 60 * 1000)]);
    expect(text).not.toContain('strax');
    expect(text).toContain('ETA okänd');
  });

  test('positionslös båt (fält saknas) behåller failsafe-öppet beteende', () => {
    const vessel = underBridgeVessel(0);
    delete vessel.timestamp;
    delete vessel.lastPositionUpdate;
    const text = svc.generateBridgeText([vessel]);
    expect(text).toContain('strax');
  });
});

// ---------------------------------------------------------------------------
// FIX J: notistokens ETA-tak (rå restid + 3 min)
// ---------------------------------------------------------------------------
describe('FP9 FIX J: target-notisens ETA-tak (NORFJELL 6-vs-1,3)', () => {
  function makeTokenApp() {
    const app = makeApp();
    app._boatNearTrigger = { trigger: jest.fn(async () => {}) };
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._persistRecentTriggers = jest.fn();
    app.vesselDataService = { hasGpsJumpHold: jest.fn(() => false) };
    app.bridgeRegistry = {
      getBridgeByName: jest.fn(() => ({ lat: 58.28410, lon: 12.283 })),
    };
    app._lookupVesselName = jest.fn(() => null);
    app._getDirectionString = jest.fn(() => 'southbound');
    app._rememberNotifiedPosition = jest.fn();
    return app;
  }

  test('grovt föråldrad lagrad ETA cappas till rå restid', async () => {
    const app = makeTokenApp();
    // NORFJELL-fallet: lagrad 6,26 min men 175 m @ 4,2 kn ≈ 1,3 min.
    const vessel = {
      mmsi: '257076850',
      name: 'NORFJELL',
      etaMinutes: 6.26,
      sog: 4.2,
      cog: 200,
      lat: 58.28568,
      lon: 12.283,
      passedBridges: [],
    };
    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Klaffbron', id: 'klaffbron', distance: 175, source: 'target',
    });
    expect(loggedWith(app.debug, 'FLOW_TRIGGER_ETA_CAP')).toBe(true);
    const tokens = app._boatNearTrigger.trigger.mock.calls[0][0];
    expect(tokens.eta_minutes).toBeLessThanOrEqual(2);
    expect(tokens.eta_minutes).toBeGreaterThanOrEqual(0);
  });

  test('lagrad ETA under taket lämnas orörd', async () => {
    const app = makeTokenApp();
    const vessel = {
      mmsi: '257076850',
      name: 'NORFJELL',
      etaMinutes: 4,
      sog: 0.5, // rå restid blir STÖRRE än lagrat värde → inget tak
      cog: 200,
      lat: 58.28568,
      lon: 12.283,
      passedBridges: [],
    };
    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Klaffbron', id: 'klaffbron', distance: 251, source: 'target',
    });
    expect(loggedWith(app.debug, 'FLOW_TRIGGER_ETA_CAP')).toBe(false);
    const tokens = app._boatNearTrigger.trigger.mock.calls[0][0];
    expect(tokens.eta_minutes).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// FIX H': kajvobbel-vakten söder om Kanalinfarten (ANVÄNDARBESLUT 2026-07-18)
// ---------------------------------------------------------------------------
describe('FP9 FIX H\': target söder om kanalinfarten kräver nordprogress (HEY JOE-kajvobblet)', () => {
  jest.mock('homey');
  // eslint-disable-next-line global-require
  const VesselDataService = require('../lib/services/VesselDataService');
  // eslint-disable-next-line global-require
  const BridgeRegistry = require('../lib/models/BridgeRegistry');
  // eslint-disable-next-line global-require
  const SystemCoordinator = require('../lib/services/SystemCoordinator');

  const logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn() };
  let svc;
  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    const registry = new BridgeRegistry();
    svc = new VesselDataService(logger, registry, new SystemCoordinator(logger));
  });
  afterEach(() => {
    svc.clearAllTimers();
    delete global.__TEST_MODE__;
  });

  const QUAY_LAT = 58.26604; // HEY JOE-liggplatsen, söder om TP 58.26800
  const now = () => Date.now();

  const quayVessel = (over = {}) => ({
    mmsi: '211881090',
    lat: QUAY_LAT,
    lon: 12.26466,
    sog: 1.0,
    cog: 357,
    passedBridges: [],
    lastPositionUpdate: now(),
    timestamp: now(),
    ...over,
  });

  test('kajvobblare (15 m drift på 6 min, sog-spik) nekas target', () => {
    const oldVessel = quayVessel({
      lat: QUAY_LAT - 0.00013, // ~14 m söder
      sog: 0.2,
      lastPositionUpdate: now() - 6 * 60 * 1000,
      timestamp: now() - 6 * 60 * 1000,
    });
    const vessel = quayVessel({ sog: 1.0 }); // spiken som förr kvalade
    expect(svc._shouldAssignTargetBridge(vessel, oldVessel)).toBe(false);
    expect(logger.debug.mock.calls.some((c) => String(c[0]).includes('quay wobble'))).toBe(true);
  });

  test('äkta inkommande (4,6 kn norrut) släpps av vakten', () => {
    const oldVessel = quayVessel({
      lat: QUAY_LAT - 0.00127, // ~141 m söder
      sog: 4.6,
      lastPositionUpdate: now() - 60 * 1000,
      timestamp: now() - 60 * 1000,
    });
    const vessel = quayVessel({ sog: 4.6, cog: 30 });
    // Vakten släpper; helhetsutfallet avgörs av resten av valideringen —
    // kravet här är att quay wobble-blocket INTE fällde henne.
    svc._shouldAssignTargetBridge(vessel, oldVessel);
    expect(logger.debug.mock.calls.some((c) => String(c[0]).includes('quay wobble'))).toBe(false);
  });

  test('ny vessel UTAN lastKnown-post (äkta första kontakt, HERALD-klassen) prövas inte', () => {
    // HERALD 12:31 (25h-korpusen): äkta 4,5 kn-inkommande, enda samplet
    // söder om punkten före 16-min-gap — den breda "alla nya söder om
    // TP"-varianten fällde hans golden och ÅTERKALLADES.
    const vessel = quayVessel({ sog: 7.5 });
    svc._shouldAssignTargetBridge(vessel, null);
    expect(logger.debug.mock.calls.some((c) => String(c[0]).includes('quay wobble'))).toBe(false);
  });

  test('reborn PÅ PLATS (färsk lastKnown <200 m, HEY JOE 15:04/16:49) nekas target', () => {
    svc.app = {
      _lastKnownPositions: new Map([
        ['211881090', { lat: QUAY_LAT + 0.0001, lon: 12.26466, t: Date.now() - 8 * 60 * 1000 }],
      ]),
    };
    const vessel = quayVessel({ sog: 7.5 }); // reborn-spiken som förr kvalade
    expect(svc._shouldAssignTargetBridge(vessel, null)).toBe(false);
    expect(logger.debug.mock.calls.some((c) => String(c[0]).includes('Reborn in place south of canal entry'))).toBe(true);
  });

  test('reborn LÅNGT från lastKnown (äkta transitör i rörelse) prövas inte', () => {
    svc.app = {
      _lastKnownPositions: new Map([
        ['211881090', { lat: QUAY_LAT - 0.005, lon: 12.2600, t: Date.now() - 8 * 60 * 1000 }],
      ]),
    };
    const vessel = quayVessel({ sog: 4.6 });
    svc._shouldAssignTargetBridge(vessel, null);
    expect(logger.debug.mock.calls.some((c) => String(c[0]).includes('Reborn in place south of canal entry'))).toBe(false);
  });

  test('norr om kanalinfarten (kö-väntare i systemet) berörs inte', () => {
    const oldVessel = quayVessel({
      lat: 58.2830, // norr om TP, vid Klaffbron-kön
      sog: 0.2,
      lastPositionUpdate: now() - 5 * 60 * 1000,
      timestamp: now() - 5 * 60 * 1000,
    });
    const vessel = quayVessel({ lat: 58.2830, sog: 0.3 });
    svc._shouldAssignTargetBridge(vessel, oldVessel);
    expect(logger.debug.mock.calls.some((c) => String(c[0]).includes('quay wobble'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX L: retrograd-vakten i StatusService
// ---------------------------------------------------------------------------
describe('FP9 FIX L: retrograd status på frusen position (SEEBAER III/NORDIC SOLA)', () => {
  // eslint-disable-next-line global-require
  const StatusService = require('../lib/services/StatusService');
  const svc = Object.create(StatusService.prototype);

  test('passerad bro + ingen position sedan passagen → blockeras', () => {
    const passedAt = Date.now() - 11 * 60 * 1000;
    const vessel = {
      passedBridges: ['Olidebron'],
      passedAt: { Olidebron: passedAt },
      lastPositionUpdate: passedAt, // frusen sedan passagen
      timestamp: passedAt,
    };
    expect(svc._isStaleRepassOfPassedBridge(vessel, 'Olidebron')).toBe(true);
  });

  test('färsk position EFTER passagen (äkta U-sväng/kvarliggare) → släpps', () => {
    const passedAt = Date.now() - 11 * 60 * 1000;
    const vessel = {
      passedBridges: ['Olidebron'],
      passedAt: { Olidebron: passedAt },
      lastPositionUpdate: Date.now() - 30 * 1000,
      timestamp: Date.now() - 30 * 1000,
    };
    expect(svc._isStaleRepassOfPassedBridge(vessel, 'Olidebron')).toBe(false);
  });

  test('bro som inte passerats → släpps (RONJA:s äkta Järnvägsbro-väntan)', () => {
    const vessel = {
      passedBridges: ['Stridsbergsbron'],
      passedAt: { Stridsbergsbron: Date.now() - 5 * 60 * 1000 },
      lastPositionUpdate: Date.now() - 5 * 60 * 1000,
      timestamp: Date.now() - 5 * 60 * 1000,
    };
    expect(svc._isStaleRepassOfPassedBridge(vessel, 'Järnvägsbron')).toBe(false);
  });

  test('passerad bro utan ankrad passedAt-tid → släpps (konservativt)', () => {
    const vessel = {
      passedBridges: ['Olidebron'],
      passedAt: {},
      lastPositionUpdate: Date.now() - 60 * 1000,
      timestamp: Date.now() - 60 * 1000,
    };
    expect(svc._isStaleRepassOfPassedBridge(vessel, 'Olidebron')).toBe(false);
  });
});
