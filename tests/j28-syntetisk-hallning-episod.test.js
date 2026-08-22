'use strict';

jest.mock('homey');

/**
 * J28 (helkodsgranskning RUNDA 2, 2026-08-22) — K16:s SYSTERSTÄLLE: den
 * syntetiska broöppningshållningen startade en NY under-bro-episod utan
 * episodåterställning.
 *
 * MEKANISMEN FÖRE FIXEN: K16 gav hållningen i StatusService._isUnderBridge ett
 * INTRÄDESANKARE, men de tre ÖVRIGA återställningar som BÅDA de riktiga
 * latch-grenarna gör (INTERMEDIATE_UNDER och TARGET_UNDER) togs inte med:
 * _underBridgeSince sattes inte till now, _underBridgeFrozenAccMs nollades inte
 * och _underBridgeCrossedBridge nollades inte. Hållningen returnerar dessutom
 * FÖRE raden som annars nollar _underBridgeSince när låset är släppt, så en
 * AVSLUTAD episods stämpel bars rakt in i den nya.
 *
 * FELUTFALLET (dedupens scenario, här reproducerat genom riktiga tjänster): en
 * båt som legat i kö inom 50 m av Järnvägsbron i ~9,5 min driver ut till 75 m
 * (låset släpps, stämpeln ligger kvar). Bron öppnar, passagen detekteras och
 * VesselDataService._activateBridgeOpening armerar hållningen — som latchar om
 * utan att nolla. När hållningen löper ut ser Bug-5-blocket >10 min ackumulerat,
 * gör force-clear, loggar falskt "[UNDER_BRIDGE_TIMEOUT] Stuck under
 * Järnvägsbron for 10min" och sätter S-3-spärren på bron.
 *
 * FIXEN: spegla de riktiga latch-grenarna — vid NY episod (`!_underBridgeLatched`,
 * exakt samma villkor som grenarna använder) sätts _underBridgeSince = now och
 * _underBridgeFrozenAccMs/_underBridgeCrossedBridge nollas.
 */

const StatusService = require('../lib/services/StatusService');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const { BRIDGES, PASSAGE_TIMING } = require('../lib/constants');

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

// Punkt `meters` rakt SÖDER om bron (nordgående båt på väg upp mot bron).
const southOf = (bridge, meters) => ({
  lat: bridge.lat - meters / 111320,
  lon: bridge.lon,
});

describe('J28: syntetiska hållningen speglar latch-grenarnas episodåterställning', () => {
  let now;
  let logger;
  let statusService;
  let proximityService;
  let vesselDataService;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 1_700_000_000_000;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    logger = makeLogger();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    vesselDataService = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
    vesselDataService.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    statusService = new StatusService(
      bridgeRegistry, logger, systemCoordinator,
      vesselDataService,
      { shouldBlockStatus: jest.fn().mockReturnValue(false) },
    );
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    vesselDataService.clearAllTimers();
    Date.now = REAL_DATE_NOW;
    delete global.__TEST_MODE__;
  });

  const makeQueuingVessel = (meters) => {
    const pos = southOf(BRIDGES.jarnvagsbron, meters);
    return {
      mmsi: 265902801,
      name: 'KÖANDE KATTEN',
      sog: 0.4,
      cog: 20,
      status: 'en-route',
      targetBridge: 'Stridsbergsbron',
      lat: pos.lat,
      lon: pos.lon,
      timestamp: now,
      lastPositionUpdate: now,
      // Klaffbron, inte Stridsbergsbron — annars biter FIX O:s närbro-par-krav.
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: now - 30 * 60 * 1000,
      passedBridges: ['Klaffbron'],
      _lastStatusChangeTime: now - 60_000,
    };
  };

  const tick = (vessel, meters, stepMs) => {
    now += stepMs;
    const pos = southOf(BRIDGES.jarnvagsbron, meters);
    vessel.lat = pos.lat;
    vessel.lon = pos.lon;
    vessel.timestamp = now;
    vessel.lastPositionUpdate = now;
    const prox = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, prox);
    vessel.status = result.status;
    return result;
  };

  test('kö 9,5 min → utdrift → RIKTIG broöppningshållning ⇒ ingen falsk 10-minuterstimeout', () => {
    const vessel = makeQueuingVessel(40);

    // FAS 1 — 9,5 min i kö inom SET-zonen (40 m). Låset sätts av den RIKTIGA
    // INTERMEDIATE_UNDER-grenen och Bug-5-klockan börjar ticka.
    let sawUnderBridge = false;
    for (let i = 0; i < 19; i += 1) {
      const r = tick(vessel, 40, 30_000);
      if (r.status === 'under-bridge') sawUnderBridge = true;
    }
    expect(sawUnderBridge).toBe(true);
    expect(vessel._underBridgeLatched).toBe(true);
    const stampelFore = vessel._underBridgeSince;
    expect(Number.isFinite(stampelFore)).toBe(true);
    expect(now - stampelFore).toBeGreaterThanOrEqual(9 * 60 * 1000);

    // FAS 2 — driver ut till 75 m: låset släpps (>70 m) men stämpeln lämnas kvar.
    tick(vessel, 75, 30_000);
    expect(vessel._underBridgeLatched).toBe(false);
    expect(vessel._underBridgeSince).toBe(stampelFore); // den STALE stämpeln

    // FAS 3 — bron öppnar och passagen bokförs: RIKTIGA _activateBridgeOpening
    // armerar hållningen (30 s).
    now += 5_000;
    vesselDataService._activateBridgeOpening(
      vessel,
      'Järnvägsbron',
      { currentBridge: null, _underBridgeLatched: false, status: 'en-route' },
      { method: 'geometry', details: {} },
    );
    expect(vessel._bridgeOpeningUntil).toBe(now + PASSAGE_TIMING.BRIDGE_OPENING_DURATION);

    // FAS 4 — ett pass INNE i hållningen: hållningen latchar om.
    const hallningsTid = now + 1_000;
    tick(vessel, 75, 1_000);
    expect(vessel._underBridgeLatched).toBe(true);
    // KÄRNAN I J28: episoden är NY ⇒ stämpeln ska vara omankrad till nu.
    expect(vessel._underBridgeSince).toBe(hallningsTid);
    expect(vessel._underBridgeFrozenAccMs).toBeNull();
    expect(vessel._underBridgeCrossedBridge).toBeNull();

    // FAS 5 — hållningen löper ut. Utan fixen ser Bug-5-blocket >10 min och
    // force-clearar med falsk logg + S-3-spärr.
    // +60 s marginal: den STALE stämpeln passerar då 10-minutersgränsen med
    // god marginal, så mutationsprovet inte hänger på en sekund.
    const r = tick(vessel, 75, PASSAGE_TIMING.BRIDGE_OPENING_DURATION + 60_000);
    expect(r.status).not.toBe('under-bridge');
    expect(vessel._underBridgeTimeoutBlockedBridge).toBeUndefined();
    expect(logger.lines.some((l) => l.includes('[UNDER_BRIDGE_TIMEOUT]'))).toBe(false);
  });

  test('hållningen nollar en stale frysackumulator och ett stale segmentbevis', () => {
    const vessel = makeQueuingVessel(75);
    // Fält som bärs över meddelandegränser av _createVesselObject-fältlistan
    // och som därför kan nå hållningen från en AVSLUTAD episod.
    vessel._underBridgeLatched = false;
    vessel._underBridgeSince = now - 9 * 60 * 1000;
    vessel._underBridgeFrozenAccMs = 8 * 60 * 1000;
    vessel._underBridgeCrossedBridge = 'Järnvägsbron';
    vessel._bridgeOpeningUntil = now + PASSAGE_TIMING.BRIDGE_OPENING_DURATION;
    vessel._bridgeOpeningBridgeName = 'Järnvägsbron';

    const hallningsTid = now + 1_000;
    tick(vessel, 75, 1_000);

    expect(vessel._underBridgeLatched).toBe(true);
    expect(vessel._underBridgeSince).toBe(hallningsTid);
    expect(vessel._underBridgeFrozenAccMs).toBeNull();
    expect(vessel._underBridgeCrossedBridge).toBeNull();
  });

  test('en PÅGÅENDE episod får INTE sin 10-minutersklocka omstartad av hållningen', () => {
    const vessel = makeQueuingVessel(40);

    // Bygg en äkta, LEVANDE episod via den riktiga latch-grenen.
    for (let i = 0; i < 6; i += 1) tick(vessel, 40, 30_000);
    expect(vessel._underBridgeLatched).toBe(true);
    const levandeStampel = vessel._underBridgeSince;

    // Hållningen armeras MEDAN låset lever (samma episod).
    vessel._bridgeOpeningUntil = now + PASSAGE_TIMING.BRIDGE_OPENING_DURATION;
    vessel._bridgeOpeningBridgeName = 'Järnvägsbron';
    tick(vessel, 40, 1_000);

    expect(vessel._underBridgeLatched).toBe(true);
    // Samma episod ⇒ stämpeln står stilla (annars kunde en upprepad hållning
    // förlänga stuck-fönstret i evighet — precis vad Bug-5 finns för).
    expect(vessel._underBridgeSince).toBe(levandeStampel);
  });

  test('LEVANDE lås UTAN ändligt inträdesankare räknas ändå som PÅGÅENDE episod', () => {
    // Villkorsvalet i fixen: `!vessel._underBridgeLatched` (de riktiga
    // latch-grenarnas villkor) — INTE `!holdsLiveEntryAnchor`. Skillnaden
    // gäller exakt det här läget: låset lever men ankaret saknas (fältlistan
    // bär `_underBridgeEntryLat` som null medan `_underBridgeLatched` är true).
    // Med holdsLiveEntryAnchor som villkor hade Bug-5-klockan startats om mitt
    // i en pågående episod och 10-minutersvakten kunnat skjutas upp i evighet.
    const vessel = makeQueuingVessel(40);
    vessel._underBridgeLatched = true;
    vessel._underBridgeSince = now - 4 * 60 * 1000;
    vessel._underBridgeEntryLat = null;
    vessel._underBridgeEntryLon = null;
    vessel._bridgeOpeningUntil = now + PASSAGE_TIMING.BRIDGE_OPENING_DURATION;
    vessel._bridgeOpeningBridgeName = 'Järnvägsbron';
    const stampelFore = vessel._underBridgeSince;

    tick(vessel, 40, 1_000);

    expect(vessel._underBridgeLatched).toBe(true);
    expect(vessel._underBridgeSince).toBe(stampelFore);
    // Ankaret (K16) sätts däremot fortfarande — det är en ANNAN fråga.
    expect(Number.isFinite(vessel._underBridgeEntryLat)).toBe(true);
  });
});
