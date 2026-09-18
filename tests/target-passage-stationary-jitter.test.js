'use strict';

const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const RouteOrderValidator = require('../lib/services/RouteOrderValidator');
const PassageLatchService = require('../lib/services/PassageLatchService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const geometry = require('../lib/utils/geometry');

const NOW = Date.parse('2026-09-18T08:00:00Z');
const MMSI = '265123456';

describe('Målbrons avståndsfallback respekterar geometrins stillhetsbevis', () => {
  let service;
  let registry;
  let route;
  let latch;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const logger = {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    registry = new BridgeRegistry();
    route = new RouteOrderValidator(logger, registry);
    latch = new PassageLatchService(logger);
    service = new VesselDataService(logger, registry, new SystemCoordinator(logger));
    service.app = { routeOrderValidator: route, passageLatchService: latch };
  });

  afterEach(() => {
    service.clearAllTimers();
    route.destroy();
    latch.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function sample(bridge, offsetM, sog, time) {
    return {
      mmsi: MMSI,
      lat: bridge.lat + offsetM / 111320,
      lon: bridge.lon,
      sog,
      cog: 30,
      timestamp: time,
      lastPositionUpdate: time,
      lastPositionChange: time,
      fixTs: time,
      fixFeed: 'aisstream',
      targetBridge: bridge.name,
      _routeDirection: 'north',
      _hasMovementProof: true,
      passedBridges: [],
      passedAt: {},
    };
  }

  test.each(['Klaffbron', 'Stridsbergsbron'])(
    '%s: två stilla fixar på var sin sida får varken passage eller latch',
    (bridgeName) => {
      const bridge = registry.getBridgeByName(bridgeName);
      const previous = sample(bridge, -20, 0.1, NOW - 60000);
      const current = sample(bridge, 20, 0.2, NOW);
      expect(geometry.detectBridgePassage(current, previous, bridge)).toMatchObject({
        passed: false, method: 'stationary_jitter_no_passage',
      });

      expect(service._hasPassedTargetBridge(current, previous)).toBe(false);
      expect(current.passedBridges).toEqual([]);
      expect(current.lastPassedBridge).toBeUndefined();
      expect(route._getPassageHistory(MMSI)).toEqual([]);
      expect(latch.getStatus().totalLatches).toBe(0);
    },
  );

  test('uppdateringskedjan behåller målbron för en väntande båt som GPS-vobblar', () => {
    const bridge = registry.getBridgeByName('Klaffbron');
    const previous = sample(bridge, -20, 0.1, NOW - 60000);
    service.vessels.set(MMSI, previous);

    const current = service.updateVessel(MMSI, sample(bridge, 20, 0.2, NOW));
    expect(current.targetBridge).toBe('Klaffbron');
    expect(current.passedBridges).toEqual([]);
    expect(current._finalTargetBridge).toBeNull();
    expect(route._getPassageHistory(MMSI)).toEqual([]);
  });

  test('riktig infart under bron med tidigare rörelse får fortfarande avståndsfallback', () => {
    const bridge = registry.getBridgeByName('Klaffbron');
    const previous = sample(bridge, -100, 4, NOW - 60000);
    const current = sample(bridge, 0, 0.1, NOW);
    expect(geometry.detectBridgePassage(current, previous, bridge)).toMatchObject({
      passed: false, method: 'no_passage_detected',
    });
    expect(service._hasPassedTargetBridge(current, previous)).toBe(true);
    expect(current.lastPassedBridge).toBe('Klaffbron');
  });

  test('okänd fart behandlas inte som bevisad stillhet', () => {
    const bridge = registry.getBridgeByName('Klaffbron');
    const previous = sample(bridge, -20, null, NOW - 60000);
    const current = sample(bridge, 20, null, NOW);
    expect(service._hasPassedTargetBridge(current, previous)).toBe(true);
  });
});
