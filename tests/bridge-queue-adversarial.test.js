'use strict';

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES, MOORING_DETECTION } = require('../lib/constants');

// Positionsförlopp vid förtöjningsgränsen. StatusService äger waitingAtBridge;
// här modelleras dess redan bekräftade beslut, medan VDS självt måste kräva
// oberoende anflygning och låta gammal information åldras ut.
describe('Lång brokö: motbevis, källtid och resgränser', () => {
  let now;
  let service;
  let logger;
  const mmsi = '902009089';
  const point = (bridge, direction, beforeM) => ({
    lat: bridge.lat + (direction === 'south' ? 1 : -1) * beforeM / 111320,
    lon: bridge.lon,
  });

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    now = Date.parse('2026-09-06T08:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    logger = {
      debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(),
    };
    service = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });

  afterEach(() => {
    service.clearAllTimers();
    jest.restoreAllMocks();
    delete global.__TEST_MODE__;
  });

  function seed(bridge = BRIDGES.stridsbergsbron, direction = 'north', distance = 450) {
    const vessel = service.updateVessel(mmsi, {
      ...point(bridge, direction, distance),
      sog: 2,
      cog: direction === 'south' ? 180 : 0,
      fixFeed: 'aishub',
      fixTs: now,
      name: 'KÖPROV',
    });
    Object.assign(vessel, {
      targetBridge: bridge.name,
      _routeDirection: direction,
      waitingAtBridge: null,
      status: 'approaching',
      passedBridges: [],
      _bridgeQueueApproaches: {},
      _moored: false,
      _gpsJumpDetected: false,
      _positionUncertain: false,
    });
    service._noteBridgeQueueApproach(vessel, null);
    return vessel;
  }

  function step(previous, overrides = {}, minutes = 1) {
    now += minutes * 60000;
    const vessel = {
      ...previous,
      timestamp: now,
      fixTs: now,
      ...overrides,
    };
    if (vessel.lat !== previous.lat || vessel.lon !== previous.lon) vessel.lastPositionUpdate = now;
    service._noteBridgeQueueApproach(vessel, previous);
    service._updateMooringEvidence(vessel, vessel.sog);
    service.vessels.set(mmsi, vessel);
    return vessel;
  }

  function queue(bridge = BRIDGES.stridsbergsbron, direction = 'north') {
    let vessel = seed(bridge, direction);
    vessel = step(vessel, { ...point(bridge, direction, 320), sog: 2 });
    vessel = step(vessel, {
      ...point(bridge, direction, 200), sog: 0, waitingAtBridge: bridge.name, status: 'waiting',
    });
    return vessel;
  }

  test.each([
    [BRIDGES.olidebron, 'north'], [BRIDGES.olidebron, 'south'],
    [BRIDGES.klaffbron, 'north'], [BRIDGES.klaffbron, 'south'],
    [BRIDGES.jarnvagsbron, 'north'], [BRIDGES.jarnvagsbron, 'south'],
    [BRIDGES.stridsbergsbron, 'north'], [BRIDGES.stridsbergsbron, 'south'],
  ])('%s %s: verklig anflygning följd av färska stillafixar får vänta över två timmar', (bridge, direction) => {
    let vessel = queue(bridge, direction);
    for (let minute = 0; minute < 125; minute += 1) vessel = step(vessel);
    expect(vessel._moored).toBe(false);
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(true);
    expect(vessel.targetBridge).toBe(bridge.name);
  });

  test('nyupptäckt stillabåt blir inte en evig köare av status och två fartspikar', () => {
    let vessel = seed(BRIDGES.stridsbergsbron, 'north', 200);
    vessel = step(vessel, { sog: 0.8, waitingAtBridge: 'Stridsbergsbron' });
    vessel = step(vessel, { sog: 1.1 });
    vessel = step(vessel, { sog: 0 });
    vessel = step(vessel, {}, 121);
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
    expect(vessel._moored).toBe(true);
  });

  test('Olidebron söderut får ha lång kö efter sista målbron utan en ny målbro', () => {
    let vessel = seed(BRIDGES.olidebron, 'south');
    Object.assign(vessel, { targetBridge: null, passedBridges: ['Stridsbergsbron', 'Klaffbron'] });
    vessel = step(vessel, { ...point(BRIDGES.olidebron, 'south', 200), sog: 0, waitingAtBridge: 'Olidebron' });
    vessel = step(vessel, {}, 125);
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(true);
    expect(vessel._moored).toBe(false);
    expect(vessel.targetBridge).toBeNull();
  });

  test.each([1, 5])('navstatus %i prioriterar verklig ankring/förtöjning efter anflygning', (navStatus) => {
    const vessel = step(queue(), { navStatus });
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
    expect(vessel._moored).toBe(true);
  });

  test('en tidigare köare som går in till känd kaj klassas fortfarande som förtöjd', () => {
    let vessel = queue(BRIDGES.klaffbron, 'south');
    vessel = step(vessel, { lat: 58.2861, lon: 12.2857 });
    vessel = step(vessel, {}, 16);
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
    expect(vessel._moored).toBe(true);
  });

  test('samma gamla AISHub-fix får inte skapa anflygning av en ny mottagning', () => {
    const old = seed();
    const vessel = step(old, {
      ...point(BRIDGES.stridsbergsbron, 'north', 200),
      fixTs: old.fixTs,
      sog: 0,
      waitingAtBridge: 'Stridsbergsbron',
    });
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
  });

  test('äldre AISHub-fix efter stream får inte skapa anflygning vid källbyte', () => {
    const old = seed();
    old.fixFeed = 'aisstream';
    const vessel = step(old, {
      ...point(BRIDGES.stridsbergsbron, 'north', 200),
      fixFeed: 'aishub',
      fixTs: old.fixTs - 1000,
      sog: 0,
      waitingAtBridge: 'Stridsbergsbron',
    });
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
  });

  test('positionslösa AISHub-livstecken förnyar varken köbevis eller 30-minutersliv', () => {
    const vessel = queue();
    const confirmedAt = vessel.timestamp;
    now += 10 * 60000 + 1;
    service.noteVesselSeen(mmsi);
    expect(vessel.timestamp).toBe(confirmedAt);
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
    expect(service.sweepStaleVessels()).toBe(0);
    now += 20 * 60000;
    service.noteVesselSeen(mmsi);
    expect(service.sweepStaleVessels()).toBe(1);
    expect(service.vessels.has(mmsi)).toBe(false);
  });

  test('verkliga uppdateringar i Järnvägsbrons kö behåller en avlägsen målbro efter passage av Stridsbergsbron', () => {
    let vessel = queue(BRIDGES.jarnvagsbron, 'south');
    Object.assign(vessel, { targetBridge: 'Klaffbron', passedBridges: ['Stridsbergsbron'] });
    const mooringSpots = jest.fn();
    service.on('vessel:mooring-spot', mooringSpots);
    for (let minute = 0; minute < 125; minute += 1) {
      now += 60000;
      vessel = service.updateVessel(mmsi, {
        lat: vessel.lat,
        lon: vessel.lon,
        sog: 0,
        cog: 180,
        fixFeed: 'aishub',
        fixTs: now,
        name: 'KÖPROV',
      });
      expect(vessel.targetBridge).toBe('Klaffbron');
      expect(vessel._moored).toBe(false);
    }
    expect(mooringSpots).not.toHaveBeenCalled();
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(true);
  });

  test.each([
    { _positionUncertain: true },
    { _gpsJumpDetected: true },
    { fixTs: Date.parse('2026-09-06T08:00:00Z') },
  ])('ett osäkert eller gammalt prov efter lång kö ger ingen klistrande kajklassning: %j', (uncertain) => {
    let vessel = queue();
    vessel = step(vessel, {}, 125);
    expect(vessel._moored).toBe(false);
    vessel = step(vessel, uncertain);
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
    expect(vessel._moored).toBe(false);
    vessel = step(vessel, { _gpsJumpDetected: false, _positionUncertain: false });
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(true);
    expect(vessel._moored).toBe(false);
  });

  test('överlappande zon behåller kön vid nästa bro när systerbron har passerats', () => {
    let vessel = queue(BRIDGES.stridsbergsbron, 'south');
    vessel = step(vessel, {
      ...point(BRIDGES.stridsbergsbron, 'south', -130),
      waitingAtBridge: 'Stridsbergsbron',
      passedBridges: ['Stridsbergsbron'],
    });
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(true);
    expect(vessel._bridgeQueueApproaches.Järnvägsbron.confirmedAt).toBeTruthy();
    expect(vessel._bridgeQueueApproaches.Stridsbergsbron).toBeUndefined();
  });

  test('reflekterad kurs som ändrar resriktning kan inte återanvända gammal anflygning', () => {
    const vessel = step(queue(), { _routeDirection: 'south', cog: 180 });
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
  });

  test('resa som avslutats och ankrats om kan inte återanvända gammal kö', () => {
    const vessel = queue();
    service._anchorJourneyOrigin(vessel, 'test: ny resa');
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
  });

  test('passage och nytt stopp under AIS-glapp nollar köklockan före förtöjningsklassning', () => {
    let vessel = queue();
    vessel = step(vessel, {}, 125);
    expect(now - vessel._stationarySince).toBeGreaterThan(MOORING_DETECTION.MAX_STATIONARY_WAIT_MS);
    vessel = step(vessel, { ...point(BRIDGES.stridsbergsbron, 'north', -150), sog: 0 }, 5);
    expect(service._hasFreshBridgeQueueEvidence(vessel)).toBe(false);
    expect(vessel._moored).toBe(false);
    expect(vessel._stationarySince).toBe(now);
  });

  test('långsamma delsteg över brolinjen med kvarstående nollfart får inte bli kajvistelse', () => {
    let vessel = queue();
    vessel = step(vessel, {}, 125);
    // AIS kan fortsätta rapportera noll knop vid långsam förhalning. Ren
    // nettoförflyttning måste hinna bryta den gamla stillheten före bron,
    // också när inget enskilt delsteg når 50-metersgränsen.
    for (let beforeM = 180; beforeM >= -100; beforeM -= 20) {
      vessel = step(vessel, { ...point(BRIDGES.stridsbergsbron, 'north', beforeM), sog: 0 });
      expect(vessel._moored).toBe(false);
    }
  });
});
