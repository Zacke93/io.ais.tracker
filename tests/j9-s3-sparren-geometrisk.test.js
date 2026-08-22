'use strict';

/**
 * J9 (helkodsgranskning RUNDA 2, 2026-08-22) — S-3-spärren släppte sig själv
 * på OKÄNT avstånd (fail-open på null).
 *
 * MEKANISMEN FÖRE FIXEN: släppvillkoret i StatusService._isUnderBridge mätte
 * avståndet till den spärrade bron BARA via vessel.distanceToCurrent (och bara
 * om currentBridge råkade vara just den bron) eller via målbron. Matchade
 * ingen av dem blev blockedDist null — och villkorsraden läste `null` som
 * SLÄPP. CurrentBridgeManager producerar exakt det läget: Regel 0 rensar
 * currentBridge när en PASSERAD bro ligger bortom UNDER_BRIDGE_SET_DISTANCE
 * (50 m) och Regel 1 vägrar sätta tillbaka den, medan under-bro-hysteresens
 * CLEAR-gräns är 70 m. I bandet 50–70 m fanns alltså varken currentBridge
 * eller (efter TARGET_END) målbro att mäta mot.
 *
 * FELUTFALLET: en FÖRTÖJD sändare 45–55 m bortom en passerad bro jitterar över
 * 50 m ⇒ spärren nollas; jitter tillbaka till 45 m ⇒ SET-grenen latchar om och
 * nollar _underBridgeSince ⇒ NY under-bro-episod var 11:e minut i evighet, med
 * falsk "[UNDER_BRIDGE_TIMEOUT] Stuck under X for 10min" och sågtands-ETA i
 * brotexten. Exakt den 10-minutersflipp S-3 en gång infördes för att stoppa.
 *
 * FIXEN: mät GEOMETRISKT mot bron själv (bridgeRegistry.getBridgeByName +
 * geometry.calculateDistance) och BEHÅLL spärren när avståndet inte kan mätas
 * (fail-closed). CurrentBridgeManagers två nakna 50-or är samtidigt bundna
 * till UNDER_BRIDGE_SET_DISTANCE så banden inte kan glida isär.
 *
 * SVITEN LÅSER:
 *  1. Hela felscenariot genom RIKTIG pipeline (ProximityService →
 *     analyzeVesselStatus): EN timeout, sedan spärren består genom 30 min
 *     jitter och ingen ny under-bro-episod uppstår.
 *  2. Spärren släpps fortfarande när båten bevisligen lämnat zonen (>70 m)
 *     — även när currentBridge är rensad, vilket den gamla koden inte kunde.
 *  3. SR2-1 står kvar: passage EFTER spärrtiden släpper.
 *  4. Fail-closed: omätbar position behåller spärren (gamla koden släppte).
 *  5. CurrentBridgeManagers konstantbindning är värdeidentisk (50 m).
 */

const StatusService = require('../lib/services/StatusService');
const CurrentBridgeManager = require('../lib/services/CurrentBridgeManager');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const {
  BRIDGES, UNDER_BRIDGE_SET_DISTANCE, UNDER_BRIDGE_CLEAR_DISTANCE, APPROACHING_RADIUS,
} = require('../lib/constants');

const REAL_DATE_NOW = Date.now;

const makeLogger = () => {
  const lines = [];
  const push = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    debug: jest.fn(push),
    log: jest.fn(push),
    error: jest.fn(push),
    warn: jest.fn(push),
  };
};

// Punkt `meters` rakt NORR om bron (nordgående båt som passerat bron).
const northOf = (bridge, meters) => ({
  lat: bridge.lat + meters / 111320,
  lon: bridge.lon,
});

describe('J9: S-3-spärren mäter geometriskt och är fail-closed', () => {
  let now;
  let logger;
  let statusService;
  let proximityService;

  beforeEach(() => {
    now = 1_700_000_000_000;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    logger = makeLogger();
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
    delete global.__TEST_MODE__;
  });

  /**
   * Förtöjd, SÄNDANDE båt strax norr om en redan passerad Klaffbron.
   * Målbron är nollad (TARGET_END efter passagen) — precis fältfallet.
   */
  const makeMooredBeyondKlaffbron = (meters) => {
    const pos = northOf(BRIDGES.klaffbron, meters);
    return {
      mmsi: 265900901,
      name: 'FÖRTÖJDA FLICKAN',
      sog: 0,
      cog: 20,
      status: 'en-route',
      targetBridge: null,
      lat: pos.lat,
      lon: pos.lon,
      timestamp: now,
      lastPositionUpdate: now,
      lastPassedBridge: 'Klaffbron',
      // Passagen ligger LÅNGT bakåt — SR2-1:s retroaktivitetsspärr ska inte
      // kunna släppa spärren, och _hasRecentlyPassed (180 s) ska inte bita.
      lastPassedBridgeTime: now - 2 * 60 * 60 * 1000,
      passedBridges: ['Klaffbron'],
      _lastStatusChangeTime: now - 60_000,
    };
  };

  // Ett "AIS-tick": flytta båten, uppdatera klockorna, kör RIKTIG pipeline.
  const tick = (vessel, meters, stepMs) => {
    now += stepMs;
    const pos = northOf(BRIDGES.klaffbron, meters);
    vessel.lat = pos.lat;
    vessel.lon = pos.lon;
    vessel.timestamp = now;
    vessel.lastPositionUpdate = now;
    const prox = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, prox);
    vessel.status = result.status;
    return result;
  };

  test('förtöjd 48 m bortom passerad bro, jitter 45↔55 m i 30 min: spärren består, ingen ny under-bro-episod', () => {
    const vessel = makeMooredBeyondKlaffbron(48);

    // FAS 1 — bygg upp den ÄKTA under-bro-episoden och låt Bug-5-timeouten
    // (10 min) sätta S-3-spärren. 48 m ligger inom SET-zonen (50 m).
    let sawUnderBridge = false;
    for (let i = 0; i < 12; i += 1) {
      const r = tick(vessel, 48, 60_000);
      if (r.status === 'under-bridge') sawUnderBridge = true;
    }
    expect(sawUnderBridge).toBe(true);
    expect(vessel._underBridgeTimeoutBlockedBridge).toBe('Klaffbron');
    expect(vessel._underBridgeLatched).toBe(false);

    const timeoutsEfterFas1 = logger.lines.filter((l) => l.includes('[UNDER_BRIDGE_TIMEOUT]')).length;
    expect(timeoutsEfterFas1).toBe(1);

    // FAS 2 — 30 min GPS-jitter i bandet 45↔55 m. Vid 55 m rensar
    // CurrentBridgeManagers Regel 0 currentBridge (passerad bro > 50 m), och
    // målbron är null — alltså exakt det läge där gamla koden svarade
    // blockedDist=null och SLÄPPTE spärren.
    const jitter = [55, 45, 55, 45, 55, 45, 55, 45, 55, 45, 55, 45, 55, 45, 55];
    const statusar = [];
    for (const meters of jitter) {
      const r = tick(vessel, meters, 2 * 60_000);
      statusar.push(r.status);
      // INVARIANTEN: spärren får aldrig släppas medan båten ligger kvar i
      // bandet, och ingen ny under-bro-episod får startas.
      expect(vessel._underBridgeTimeoutBlockedBridge).toBe('Klaffbron');
      expect(vessel._underBridgeLatched).toBe(false);
      expect(vessel._underBridgeSince).toBeNull();
    }

    // Ingen sågtand: 'under-bridge' återkom aldrig under jittret.
    expect(statusar).not.toContain('under-bridge');
    // Och därmed ingen NY falsk "Stuck under ... for 10min".
    const timeoutsTotalt = logger.lines.filter((l) => l.includes('[UNDER_BRIDGE_TIMEOUT]')).length;
    expect(timeoutsTotalt).toBe(1);
  });

  test('bevisad utgång ur zonen (>70 m) släpper spärren ÄVEN när currentBridge är rensad', () => {
    const vessel = makeMooredBeyondKlaffbron(48);
    for (let i = 0; i < 12; i += 1) tick(vessel, 48, 60_000);
    expect(vessel._underBridgeTimeoutBlockedBridge).toBe('Klaffbron');

    // 120 m > UNDER_BRIDGE_CLEAR_DISTANCE (70 m). Regel 0 har rensat
    // currentBridge (passerad bro > 50 m) och målbron är null — den gamla
    // koden hade "släppt" här av fel skäl (null), den nya av RÄTT skäl.
    tick(vessel, 120, 60_000);
    expect(vessel._underBridgeTimeoutBlockedBridge).toBeNull();
    expect(vessel._underBridgeTimeoutBlockedAt).toBeNull();
    // Släppet måste ske av RÄTT skäl: loggen ska bära det GEOMETRISKT mätta
    // avståndet (~120 m), inte den gamla nollan som ett omätt null gav.
    const releaseLine = logger.lines.find((l) => l.includes('[UNDER_BRIDGE_BLOCK_RELEASED]'));
    expect(releaseLine).toBeDefined();
    const matched = /(\d+)m > /.exec(releaseLine);
    expect(matched).not.toBeNull();
    expect(Number(matched[1])).toBeGreaterThan(100);
  });

  test('SR2-1 står kvar: passage EFTER spärrtiden släpper spärren', () => {
    const vessel = makeMooredBeyondKlaffbron(48);
    for (let i = 0; i < 12; i += 1) tick(vessel, 48, 60_000);
    const blockedAt = vessel._underBridgeTimeoutBlockedAt;
    expect(vessel._underBridgeTimeoutBlockedBridge).toBe('Klaffbron');

    // En NY passage av samma bro, bokförd efter spärrtiden.
    now += 60_000;
    vessel.lastPassedBridgeTime = blockedAt + 30_000;
    tick(vessel, 45, 0);
    expect(vessel._underBridgeTimeoutBlockedBridge).toBeNull();
  });

  test('FAIL-CLOSED: omätbar position behåller spärren (gamla koden släppte)', () => {
    const vessel = makeMooredBeyondKlaffbron(48);
    vessel._underBridgeTimeoutBlockedBridge = 'Klaffbron';
    vessel._underBridgeTimeoutBlockedAt = now - 30_000;
    // Positionen går förlorad (icke-finit) — avståndet kan inte mätas.
    vessel.lat = NaN;
    vessel.lon = NaN;

    statusService._isUnderBridge(vessel, { nearestBridge: null, bridgeDistances: {} });

    expect(vessel._underBridgeTimeoutBlockedBridge).toBe('Klaffbron');
    expect(logger.lines.some((l) => l.includes('[UNDER_BRIDGE_BLOCK_HELD]'))).toBe(true);
  });

  test('okänt bronamn i spärren kan inte mätas ⇒ spärren behålls (fail-closed)', () => {
    const vessel = makeMooredBeyondKlaffbron(48);
    vessel._underBridgeTimeoutBlockedBridge = 'Bro som inte finns';
    vessel._underBridgeTimeoutBlockedAt = now - 30_000;

    const prox = proximityService.analyzeVesselProximity(vessel);
    statusService._isUnderBridge(vessel, prox);

    expect(vessel._underBridgeTimeoutBlockedBridge).toBe('Bro som inte finns');
  });
});

describe('J9: CurrentBridgeManagers spärrband är bundet till UNDER_BRIDGE_SET_DISTANCE', () => {
  let cbm;
  let registry;

  beforeEach(() => {
    registry = new BridgeRegistry();
    cbm = new CurrentBridgeManager(registry, makeLogger());
  });

  test('bindningen är VÄRDEIDENTISK med den gamla literalen 50 och ligger under CLEAR-gränsen', () => {
    expect(UNDER_BRIDGE_SET_DISTANCE).toBe(50);
    expect(UNDER_BRIDGE_SET_DISTANCE).toBeLessThan(UNDER_BRIDGE_CLEAR_DISTANCE);
    // Bandet 50–70 m är precis det hål J9 stängde — dokumenteras här så en
    // framtida ändring av endera konstanten syns i testet.
    expect(UNDER_BRIDGE_CLEAR_DISTANCE - UNDER_BRIDGE_SET_DISTANCE).toBeGreaterThan(0);
  });

  test('Regel 0 rensar passerad bro precis ÖVER bandets nedre gräns, inte på den', () => {
    const pos = northOf(BRIDGES.klaffbron, UNDER_BRIDGE_SET_DISTANCE + 5);
    const vessel = {
      mmsi: 265900902,
      lat: pos.lat,
      lon: pos.lon,
      currentBridge: 'Klaffbron',
      distanceToCurrent: UNDER_BRIDGE_SET_DISTANCE + 5,
      lastPassedBridge: 'Klaffbron',
      passedBridges: ['Klaffbron'],
    };
    cbm.updateCurrentBridge(vessel, {
      nearestBridge: { id: 'klaffbron', name: 'Klaffbron', distance: UNDER_BRIDGE_SET_DISTANCE + 5 },
      nearestDistance: UNDER_BRIDGE_SET_DISTANCE + 5,
      bridgeDistances: { klaffbron: UNDER_BRIDGE_SET_DISTANCE + 5 },
    });
    expect(vessel.currentBridge).toBeNull();

    // ...men exakt PÅ gränsen står den kvar (> är strikt, oförändrat).
    const vessel2 = {
      mmsi: 265900903,
      lat: northOf(BRIDGES.klaffbron, UNDER_BRIDGE_SET_DISTANCE).lat,
      lon: BRIDGES.klaffbron.lon,
      currentBridge: 'Klaffbron',
      distanceToCurrent: UNDER_BRIDGE_SET_DISTANCE,
      lastPassedBridge: 'Klaffbron',
      passedBridges: ['Klaffbron'],
    };
    cbm.updateCurrentBridge(vessel2, {
      nearestBridge: { id: 'klaffbron', name: 'Klaffbron', distance: UNDER_BRIDGE_SET_DISTANCE },
      nearestDistance: UNDER_BRIDGE_SET_DISTANCE,
      bridgeDistances: { klaffbron: UNDER_BRIDGE_SET_DISTANCE },
    });
    expect(vessel2.currentBridge).toBe('Klaffbron');
    // SET_DISTANCE-hysteresen (500 m) är orörd av J9.
    expect(cbm.SET_DISTANCE).toBe(APPROACHING_RADIUS);
  });
});
