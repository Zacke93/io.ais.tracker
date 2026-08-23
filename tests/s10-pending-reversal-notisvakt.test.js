'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * S10 (systerställesrundan 2026-08-23) — NOTISEN BAR ETT LÅS SOM BÅTENS EGEN
 * LEVANDE KURS REDAN MOTSADE
 * =============================================================================
 *
 * MEKANISMEN FÖRE FIXEN. `_getDirectionString` läser slutmåls-/ruttlåset
 * (`_finalTargetDirection || _routeDirection`) FÖRE den levande kursen — med
 * goda skäl, en ankrad båts COG är brus. Fix D:s reversalsdebounce i
 * VesselDataService (Anomali 18) kräver TVÅ konsekutiva observationer innan
 * låset släpps, så det FÖRSTA samplet efter en avgång åt motsatt håll bär
 * fortfarande det gamla låset. Någon bro-motsvarighet till H16:s
 * passerad-vakt fanns inte — H16 täcker bara trigger-punkter.
 *
 * FÄLTFALLET I LÅST KORPUS som återskapas här: ELFKUNGEN 265573130 i
 * 20260804-both-21h, 2026-08-05T12:28:49Z. Appens egna rader i samma tick är
 * TARGET_RECALC_PENDING (reversal mot syd, cog 189°) och FLOW_TRIGGER_ATTEMPT
 * Klaffbron 127 m, källa target, riktning NORRUT, ETA 1. Rådata: hon låg
 * 127 m SÖDER om Klaffbron med sog 6,0 och cog 188,8, och nästa fix låg
 * längre söderut — hon gick BORT i 6 knop.
 *
 * VALET "AVSTÅ" FRAMFÖR "BYT TOKEN": alternativet (levande kurs +
 * already_passed) hade producerat ett annat osant påstående, för ELFKUNGEN
 * hade INTE passerat Klaffbron — hon vände 127 m före den. Att avstå raderar
 * heller inte notisen: dedupnyckeln sätts inte på den här vägen. Mätt över
 * alla 20 korpusar tar vakten bort EXAKT EN notis (ELFKUNGEN-fantomen ovan)
 * och SKJUTER UPP en (HAJH-LAIF 265800960 i 20260702-2h: hon vände söderut
 * 130 m före Järnvägsbron, låg still en halvtimme och fick sin notis när hon
 * faktiskt återupptog nordfärden — 133 m från bron i stället för 176 m på väg
 * bort). Ingen äkta notis går förlorad.
 *
 * PIPELINEN ÄR ÄKTA: RIKTIGA VesselDataService.updateVessel sätter både
 * ruttlåset och Fix D:s pendingflagga (testet skriver ingen av dem), riktig
 * ProximityService, appens egen kandidatväg och notisväg.
 *
 * MUTATIONSPROV (körda i isolerade träd, se rapporten):
 *  M1 = HEAD (vakten borttagen)                  ⇒ FÄLTFALLET rött
 *  M2 = vakten utan TTL-ledet                    ⇒ "gammal flagga" rött
 *  M3 = vakten utan kravet på levande kurs       ⇒ "kursen har återgått" rött
 *  M4 = vakten utan "bron bakom"-ledet           ⇒ "bron framför" rött
 *  M5 = vakten utan motsägelsekravet             ⇒ "låset redan omvänt" rött
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const ProximityService = require('../lib/services/ProximityService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES } = require('../lib/constants');

const KLAFFBRON = Object.values(BRIDGES).find((b) => b && b.name === 'Klaffbron');
const M_PER_DEG_LAT = 111320;
const MMSI = '265573130';
const KADENS_MS = 60 * 1000;
const STEG_M = 185; // 6 knop ≈ 3,09 m/s ⇒ 185 m per minutsampel

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
  app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
  return app;
}

/** Nordgående anflygning mot Klaffbron — låser _routeDirection = north. */
function anflygningNorrut(svc) {
  const step = STEG_M / M_PER_DEG_LAT;
  let v = null;
  for (let i = -8; i <= -1; i++) {
    svc.updateVessel(MMSI, {
      mmsi: MMSI,
      lat: KLAFFBRON.lat + i * step,
      lon: KLAFFBRON.lon,
      sog: 6,
      cog: 20,
      name: 'ELFKUNGEN',
      timestamp: NOW,
    });
    v = svc.vessels.get(MMSI);
    NOW += KADENS_MS;
  }
  return v;
}

/** Vändningssamplet: 127 m söder om bron, cog 188,8°, sog 6,0 — rådatan. */
function vandningssampel(svc, overrides = {}) {
  svc.updateVessel(MMSI, {
    mmsi: MMSI,
    lat: KLAFFBRON.lat - 127 / M_PER_DEG_LAT,
    lon: KLAFFBRON.lon,
    sog: 6.0,
    cog: 188.8,
    name: 'ELFKUNGEN',
    timestamp: NOW,
    ...overrides,
  });
  return svc.vessels.get(MMSI);
}

const skipRader = (app) => app.log.mock.calls
  .map((c) => String(c[0]))
  .filter((s) => s.includes('FLOW_TRIGGER_SKIP_PENDING_REVERSAL'));

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

beforeEach(() => {
  NOW = 1787000000000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => NOW);
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

describe('S10: fältfallet ELFKUNGEN', () => {
  test('FÄLTFALLET: ingen norrut-notis om Klaffbron i 6 knop söderut', async () => {
    const svc = makeVDS();
    anflygningNorrut(svc);
    const vessel = vandningssampel(svc);
    const app = makeApp(svc);

    // RIGGKONTROLL — produktionskoden ska ha satt BÅDA sidorna av motsägelsen.
    expect(vessel._routeDirection).toBe('north');
    expect(vessel._fixDPendingReversal).toEqual({ dir: 'south', time: NOW });
    expect(app._getDirectionString(vessel)).toBe('northbound');
    // …och kandidatvägen ska fortfarande erbjuda Klaffbron (annars mäter
    // testet en helt annan grind).
    const kandidater = app._getFlowTriggerCandidates(
      vessel, app.proximityService.analyzeVesselProximity(vessel),
    );
    expect(kandidater.map((c) => c.name)).toContain('Klaffbron');

    await app._triggerBoatNearFlow(vessel);

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(skipRader(app)).toHaveLength(1);
    expect(skipRader(app)[0]).toContain('Klaffbron');
    expect(skipRader(app)[0]).toContain('BAKOM');
  });

  test('INGEN DEDUPNYCKEL SÄTTS vid skip — notisen är uppskjuten, inte tappad', async () => {
    const svc = makeVDS();
    anflygningNorrut(svc);
    const vessel = vandningssampel(svc);
    const app = makeApp(svc);

    await app._triggerBoatNearFlow(vessel);

    expect(app._triggeredBoatNearKeys.size).toBe(0);
    expect(app._persistentRecentTriggers.size).toBe(0);
  });
});

describe('S10: vaktens fyra krav — var och en nödvändig', () => {
  test('(1) EN GAMMAL FLAGGA blockerar inte (TTL:n gäller)', async () => {
    const svc = makeVDS();
    anflygningNorrut(svc);
    const vessel = vandningssampel(svc);
    const app = makeApp(svc);

    // Flaggan nollställs bara INNE i Fix D-blockets yttre villkor, så den kan
    // ligga kvar på en båt som saktat ner. 16 min > FIX_D_PENDING_MAX_AGE_MS.
    vessel._fixDPendingReversal = { dir: 'south', time: NOW - 16 * 60 * 1000 };

    expect(app._fixDReversalContradictsNotification(
      vessel, { name: 'Klaffbron', id: 'klaffbron', source: 'target' }, 'northbound',
    ).skip).toBe(false);
  });

  test('(2) INGEN MOTSÄGELSE ⇒ vakten står still', async () => {
    const svc = makeVDS();
    anflygningNorrut(svc);
    const vessel = vandningssampel(svc);
    const app = makeApp(svc);

    // Tokenriktningen är redan den reversalen pekar på — inget att skydda mot.
    expect(app._fixDReversalContradictsNotification(
      vessel, { name: 'Klaffbron', id: 'klaffbron', source: 'target' }, 'southbound',
    ).skip).toBe(false);
    // Okänd riktning bär ingen falsk uppgift.
    expect(app._fixDReversalContradictsNotification(
      vessel, { name: 'Klaffbron', id: 'klaffbron', source: 'target' }, 'unknown',
    ).skip).toBe(false);
  });

  test('(3) KURSEN HAR ÅTERGÅTT ⇒ notisen går fram som förut', async () => {
    const svc = makeVDS();
    anflygningNorrut(svc);
    const vessel = vandningssampel(svc);
    const app = makeApp(svc);

    // Samma pendingflagga, men detta sampels kurs pekar norrut igen (wobblen
    // var brus). Då finns inget levande bevis och vakten ska vara inert.
    vessel.cog = 20;

    expect(app._fixDReversalContradictsNotification(
      vessel, { name: 'Klaffbron', id: 'klaffbron', source: 'target' }, 'northbound',
    ).skip).toBe(false);
  });

  test('(3b) FART UNDER MIN_VIABLE_SPEED_KN ⇒ COG är brus, vakten inert', async () => {
    const svc = makeVDS();
    anflygningNorrut(svc);
    const vessel = vandningssampel(svc);
    const app = makeApp(svc);

    vessel.sog = 0.3;

    expect(app._fixDReversalContradictsNotification(
      vessel, { name: 'Klaffbron', id: 'klaffbron', source: 'target' }, 'northbound',
    ).skip).toBe(false);
  });

  test('(4) BRON LIGGER FRAMFÖR ⇒ ingen skip (hon närmar sig faktiskt)', async () => {
    const svc = makeVDS();
    anflygningNorrut(svc);
    const vessel = vandningssampel(svc);
    const app = makeApp(svc);

    // Olidebron ligger SÖDER om henne — på en sydgående kurs är den framför.
    expect(app._fixDReversalContradictsNotification(
      vessel, { name: 'Olidebron', id: 'olidebron', source: 'current' }, 'northbound',
    ).skip).toBe(false);
    // Kontroll: Klaffbron NORR om henne på samma sampel ⇒ bakom ⇒ skip.
    expect(app._fixDReversalContradictsNotification(
      vessel, { name: 'Klaffbron', id: 'klaffbron', source: 'target' }, 'northbound',
    ).skip).toBe(true);
  });

  test('OKÄND KANDIDAT (varken bro eller trigger-punkt) ⇒ vakten inert', async () => {
    const svc = makeVDS();
    anflygningNorrut(svc);
    const vessel = vandningssampel(svc);
    const app = makeApp(svc);

    expect(app._fixDReversalContradictsNotification(
      vessel, { name: 'Ingen bro alls', id: 'xyz', source: 'nearest' }, 'northbound',
    ).skip).toBe(false);
  });
});

describe('S10: kontrollarm — en ren anflygning rörs inte', () => {
  test('utan pendingflagga går notisen ut precis som förut', async () => {
    const svc = makeVDS();
    const vessel = anflygningNorrut(svc);
    const app = makeApp(svc);

    expect(vessel._fixDPendingReversal).toBeFalsy();

    await app._triggerBoatNearFlow(vessel);

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalled();
    expect(skipRader(app)).toHaveLength(0);
    const [tokens] = app._triggerBoatNearFlowBest.mock.calls[0];
    expect(tokens.direction).toBe('norrut');
  });
});
