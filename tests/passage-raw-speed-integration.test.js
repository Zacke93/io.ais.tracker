'use strict';

const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');

const START = Date.parse('2026-10-05T08:00:00Z');
const MMSI = '265123456';

describe('Passagebevis använder råfarten från rätt positionsfix', () => {
  let service;
  let gate;
  let bridge;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    logger = {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    service = new VesselDataService(logger, registry, coordinator);
    gate = new GPSJumpGateService(logger, coordinator);
    service.app = { gpsJumpGateService: gate };
    bridge = registry.getBridgeByName('Klaffbron');
  });

  afterEach(() => {
    service.clearAllTimers();
    gate.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function seed(direction = 'north') {
    // En etablerad resa före bron; efterföljande fixar går genom den
    // riktiga objektombyggnaden, fartminnet och passagedetekteringen.
    const before = direction === 'north' ? -20 : 20;
    service.vessels.set(MMSI, {
      mmsi: MMSI,
      lat: bridge.lat + before / 111320,
      lon: bridge.lon,
      sog: 0.1,
      _rawPositionSog: 0.1,
      cog: direction === 'north' ? 30 : 210,
      timestamp: START,
      lastPositionUpdate: START,
      lastPositionChange: START,
      fixTs: START,
      fixFeed: 'aisstream',
      targetBridge: bridge.name,
      _routeDirection: direction,
      _hasMovementProof: true,
      passedBridges: [],
      passedAt: {},
    });
    return before;
  }

  function update(offsetM, sog, elapsedMs = 60000) {
    jest.setSystemTime(Date.now() + elapsedMs);
    return service.updateVessel(MMSI, {
      lat: bridge.lat + offsetM / 111320,
      lon: bridge.lon,
      sog,
      cog: service.getVessel(MMSI).cog,
      fixTs: Date.now(),
      fixFeed: 'aisstream',
    });
  }

  test.each([
    ['north', 0.1, null],
    ['north', null, 0.1],
    ['north', null, null],
    ['south', 0.1, null],
    ['south', null, 0.1],
    ['south', null, null],
  ])('%s: tidigare råfart %s och ny råfart %s får inte bli två stillhetsbevis', (direction, previousSog, currentSog) => {
    const before = seed(direction);
    const previous = update(before, previousSog);
    const current = update(-before, currentSog);

    expect(previous.sog).toBe(0.1);
    expect(previous._rawPositionSog).toBe(previousSog);
    expect(current.sog).toBe(0.1);
    expect(current._rawPositionSog).toBe(currentSog);
    expect(current.passedBridges).toContain(bridge.name);
    expect(current.lastPassedBridge).toBe(bridge.name);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each(['north', 'south'])('%s: två rapporterade låga farter spärrar fortfarande jitterpassagen', (direction) => {
    const before = seed(direction);
    update(before, 0.1);
    const current = update(-before, 0.2);

    expect(current.targetBridge).toBe(bridge.name);
    expect(current.passedBridges).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('okänd fart i det rena ankaret överlever ett senare GPS-hopp med känd låg fart', () => {
    seed();
    update(-20, null);
    const jump = update(300, 0.1, 1000);
    expect(jump._positionUncertain).toBe(true);
    expect(jump.passedBridges).toEqual([]);
    expect(GPSJumpAnalyzer.passageSegmentStart(jump)._rawPositionSog).toBeNull();

    const recovered = update(20, 0.1, 400000);
    expect(recovered._positionUncertain).toBe(false);
    expect(recovered._gpsJumpDetected).toBe(false);
    expect(recovered.passedBridges).toContain(bridge.name);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('okänd fart i GPS-hoppet får inte upphäva två rena stillhetsbevis', () => {
    seed();
    const jump = update(300, null, 1000);
    expect(jump._positionUncertain).toBe(true);
    expect(jump.passedBridges).toEqual([]);
    expect(GPSJumpAnalyzer.passageSegmentStart(jump)._rawPositionSog).toBe(0.1);

    const recovered = update(20, 0.1, 120000);
    expect(recovered._positionUncertain).toBe(false);
    expect(recovered._gpsJumpDetected).toBe(false);
    expect(recovered.targetBridge).toBe(bridge.name);
    expect(recovered.passedBridges).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
