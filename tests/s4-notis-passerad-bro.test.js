'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * S4 (systerställesrundan 2026-08-23) — NOTISEN SA "NÄRMAR SIG" OM EN BRO
 * BÅTEN KORSAT I SAMMA TICK
 * =============================================================================
 *
 * MEKANISMEN FÖRE FIXEN. `_getFlowTriggerCandidates` pushar `targetBridge` och
 * `currentBridge` FÖRE just-passed-blocket, och `addCandidate` returnerar
 * tidigt på `seen.has(bridgeName)`. Är den nyss passerade bron samma bro som
 * current/target vinner alltså etiketten 'current'/'target' — och källsträngen
 * är enda ingången till `_isRetroactiveNotificationSource`, som styr
 * ETA-sentinelen (-1), `already_passed` och meningsvalet i
 * `_buildBoatNearMessage`. Fältmätning över fyra korpusar och 568 avfyrade
 * notiser: 35 gick ut högst 15 s efter att passagen bokförts (34 'current',
 * 1 'target'); källan 'just-passed' avfyrade 0 av 568.
 *
 * FÄLTFALLET som återskapas här: ADA 265625860, korpus 20260804-17h,
 * 17:10:28 — BRIDGE_PASSED Järnvägsbron och i SAMMA tick en notis
 * "ADA närmar sig Järnvägsbron, beräknad ankomst om 1 minut" med källa
 * 'current' och already_passed=false. Bron låg bakom henne.
 *
 * FIXEN följer H16-mönstret: källsträngen RÖRS INTE (den bär dedupsemantiken
 * — flyttad kandidatordning kostade en notis i 20260806-42h), utan en boolean
 * bredvid `passedTriggerPoint` styr eta, already_passed och texten.
 *
 * PIPELINEN ÄR ÄKTA: fartyget byggs av RIKTIGA VesselDataService.updateVessel
 * (passagen bokförs alltså av produktionskoden, inte av testet), proximity
 * räknas av en RIKTIG ProximityService, kandidaterna av appens egen
 * `_getFlowTriggerCandidates`, och notisen går hela vägen genom
 * `_triggerBoatNearFlow` → `_triggerBoatNearFlowForBridge`. Bara sista ledet
 * (leveransen till Homey-kortet) spioneras.
 *
 * MUTATIONSPROV (körda i isolerade träd, se rapporten):
 *  M1 = HEAD (vakten helt borttagen)            ⇒ FÄLTFALLET rött
 *  M2 = vakten utan tidsfönstret (ingen TTL)    ⇒ "gammal stämpel" rött
 *  M3 = vakten utan namnjämförelsen             ⇒ "annan bro" rött
 *  M4 = texten kvar i förvarningsform           ⇒ FÄLTFALLET rött
 *  M5 = flaggan ej OR:ad in i passedBridgeSource ⇒ FÄLTFALLET rött
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const ProximityService = require('../lib/services/ProximityService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES } = require('../lib/constants');

const JARNVAGSBRON = Object.values(BRIDGES).find((b) => b && b.name === 'Järnvägsbron');
const M_PER_DEG_LAT = 111320;
const MMSI = '265625860';
const KADENS_MS = 60 * 1000;
// 5 knop ≈ 2,57 m/s ⇒ 154 m per minutsampel.
const STEG_M = 154;

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

const liveServices = [];
let NOW = 0;
let nowSpy = null;
let savedEnv;

function makeVDS() {
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.app = {
    gpsJumpGateService: null,
    passageLatchService: null,
    routeOrderValidator: null,
    debug: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  liveServices.push(svc);
  return svc;
}

function makeApp(svc) {
  const app = Object.create(AISBridgeApp.prototype);
  app.debug = jest.fn();
  app.log = jest.fn();
  app.error = jest.fn();
  app.bridgeRegistry = svc.bridgeRegistry;
  app.vesselDataService = svc;
  app.proximityService = new ProximityService(svc.bridgeRegistry, logger);
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._persistRecentTriggers = jest.fn();
  app._quayStableLedger = new Map();
  app._openingQuayLedger = new Map();
  app._lastKnownPositions = new Map();
  app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * 60 * 1000;
  app._boatNearTrigger = { trigger: jest.fn().mockResolvedValue(undefined) };
  // Sista ledet (leveransen) spioneras — allt före det är produktionskod.
  app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
  return app;
}

/**
 * Nordgående transitör som korsar Järnvägsbron. Sista samplet ligger 154 m
 * NORR om bron — samma tick som passagen bokförs.
 * @param {Object} svc - VesselDataService
 * @returns {Object} fartygsobjektet efter passagesamplet
 */
function nordgaendePassage(svc) {
  const step = STEG_M / M_PER_DEG_LAT;
  let v = null;
  for (let i = -6; i <= 1; i++) {
    svc.updateVessel(MMSI, {
      mmsi: MMSI,
      lat: JARNVAGSBRON.lat + i * step,
      lon: JARNVAGSBRON.lon,
      sog: 5,
      cog: 20,
      name: 'ADA',
      timestamp: NOW,
    });
    v = svc.vessels.get(MMSI);
    if (i < 1) NOW += KADENS_MS;
  }
  return v;
}

const notiserFor = (app, bro) => app._triggerBoatNearFlowBest.mock.calls
  .filter((c) => c[0].bridge_name === bro);

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

beforeEach(() => {
  NOW = 1787000000000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => NOW);
  // _triggerBoatNearFlow kortsluter i testläge — stäng av det (samma teknik
  // som replay-harnessen och S6-sviten).
  savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  global.__TEST_MODE__ = undefined;
});

afterEach(() => {
  process.env.NODE_ENV = savedEnv;
  global.__TEST_MODE__ = true;
  while (liveServices.length > 0) {
    const svc = liveServices.pop();
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  if (nowSpy) nowSpy.mockRestore();
  jest.clearAllMocks();
});

describe('S4: en bro som just passerats får aldrig förvarningsform', () => {
  test('FÄLTFALLET (ADA): källan är current, men notisen säger "har precis passerat"', async () => {
    const svc = makeVDS();
    const vessel = nordgaendePassage(svc);
    const app = makeApp(svc);

    // RIGGKONTROLL — annars mäter testet fel sak: produktionskoden ska ha
    // bokfört passagen i DENNA tick, och kandidatvägen ska ge källan 'current'
    // (det är hela defekten — 'just-passed' blockeras av seen-mängden).
    expect(vessel.lastPassedBridge).toBe('Järnvägsbron');
    expect(NOW - vessel.lastPassedBridgeTime).toBe(0);
    const kandidater = app._getFlowTriggerCandidates(
      vessel, app.proximityService.analyzeVesselProximity(vessel),
    );
    const jvb = kandidater.find((c) => c.name === 'Järnvägsbron');
    expect(jvb.source).toBe('current');

    await app._triggerBoatNearFlow(vessel);

    const [tokens, state] = notiserFor(app, 'Järnvägsbron')[0];
    expect(tokens.message).toBe('ADA har precis passerat Järnvägsbron');
    expect(tokens.already_passed).toBe(true);
    expect(tokens.eta_minutes).toBe(-1);
    expect(tokens.eta_available).toBe(false);
    expect(tokens.message).not.toMatch(/närmar sig/);
    // KÄLLSTRÄNGEN OCH DISTANSEN STÅR STILL: källan bär dedupsemantiken
    // (retroactiveSource) och distansen läses av INV-11.
    expect(state.source).toBe('current');
    expect(state.distance).toBe(154);
    expect(app._isRetroactiveNotificationSource('current')).toBe(false);
  });

  test('NOTISEN FILTRERAS INTE BORT — och facitbärarna är orörda', async () => {
    const svc = makeVDS();
    const vessel = nordgaendePassage(svc);
    const app = makeApp(svc);

    await app._triggerBoatNearFlow(vessel);

    // Vakten byter text, den tar aldrig bort en notis: mätt över alla 20
    // korpusar är notisantalet identiskt i varje enskild korpus.
    expect(notiserFor(app, 'Järnvägsbron')).toHaveLength(1);
    const [tokens] = notiserFor(app, 'Järnvägsbron')[0];
    // Fördelningsmultiseten läser bridge_name, riktningsmultiseten direction.
    expect(tokens.bridge_name).toBe('Järnvägsbron');
    expect(tokens.direction).toBe('norrut');
    expect(tokens.vessel_name).toBe('ADA');
  });

  test('DEDUP-NYCKLARNA är identiska med förvarningsvägens', async () => {
    const svc = makeVDS();
    const vessel = nordgaendePassage(svc);
    const app = makeApp(svc);

    await app._triggerBoatNearFlow(vessel);

    expect(app._triggeredBoatNearKeys.has(`${MMSI}:Järnvägsbron`)).toBe(true);
    expect(app._persistentRecentTriggers.has(`${MMSI}:Järnvägsbron`)).toBe(true);
    // Riktningen i den persistenta posten är dedupens egen (rörelsebevisad),
    // inte notistokenens — och den får inte flytta sig.
    expect(app._persistentRecentTriggers.get(`${MMSI}:Järnvägsbron`).dir).toBe('north');
  });

  test('MÅLBRON FRAMFÖR (Stridsbergsbron) behåller förvarningsformen', async () => {
    const svc = makeVDS();
    const vessel = nordgaendePassage(svc);
    const app = makeApp(svc);

    await app._triggerBoatNearFlow(vessel);

    // Kontrollarm: samma tick, samma fartyg, en bro hon INTE passerat.
    const [tokens] = notiserFor(app, 'Stridsbergsbron')[0];
    expect(tokens.already_passed).toBe(false);
    expect(tokens.eta_minutes).toBeGreaterThanOrEqual(0);
    expect(tokens.message).toMatch(/^ADA närmar sig Stridsbergsbron/);
  });
});

describe('S4: vaktens gränser', () => {
  test('STÄMPELN ÄLDRE ÄN NÅDAN (15 s) ⇒ förvarningsform som förut', async () => {
    const svc = makeVDS();
    const vessel = nordgaendePassage(svc);
    // Ett sampel till, 60 s senare: passagen är fortfarande bokförd men
    // stämpeln är 60 s gammal — utanför PASSAGE_TRIGGER_GRACE_MS.
    NOW += KADENS_MS;
    svc.updateVessel(MMSI, {
      mmsi: MMSI,
      lat: vessel.lat + STEG_M / M_PER_DEG_LAT,
      lon: JARNVAGSBRON.lon,
      sog: 5,
      cog: 20,
      name: 'ADA',
      timestamp: NOW,
    });
    const senare = svc.vessels.get(MMSI);
    const app = makeApp(svc);

    expect(senare.lastPassedBridge).toBe('Järnvägsbron');
    expect(NOW - senare.lastPassedBridgeTime).toBe(KADENS_MS);
    expect(app._hasJustPassedNotifiedBridge(
      senare, { name: 'Järnvägsbron', id: 'jarnvagsbron', source: 'current' }, 'current',
    )).toBe(false);
  });

  test('EN ANNAN BRO än den passerade rörs inte', async () => {
    const svc = makeVDS();
    const vessel = nordgaendePassage(svc);
    const app = makeApp(svc);

    expect(app._hasJustPassedNotifiedBridge(
      vessel, { name: 'Stridsbergsbron', id: 'stridsbergsbron', source: 'target' }, 'target',
    )).toBe(false);
  });

  test('REDAN RETROAKTIV KÄLLA räknas inte dubbelt', async () => {
    const svc = makeVDS();
    const vessel = nordgaendePassage(svc);
    const app = makeApp(svc);

    // 'just-passed' är redan retroaktiv via källsträngen — vakten ska stå still
    // så att de två vägarna inte kan ge olika svar om samma tick.
    expect(app._hasJustPassedNotifiedBridge(
      vessel, { name: 'Järnvägsbron', id: 'jarnvagsbron', source: 'just-passed' }, 'just-passed',
    )).toBe(false);
    expect(app._isRetroactiveNotificationSource('just-passed')).toBe(true);
  });

  test('SAKNAD STÄMPEL (aldrig passerat något) ⇒ vakten är inert', async () => {
    const svc = makeVDS();
    const app = makeApp(svc);
    const orörd = { mmsi: MMSI, lastPassedBridge: null, lastPassedBridgeTime: null };

    expect(app._hasJustPassedNotifiedBridge(
      orörd, { name: 'Järnvägsbron', id: 'jarnvagsbron', source: 'current' }, 'current',
    )).toBe(false);
  });
});
