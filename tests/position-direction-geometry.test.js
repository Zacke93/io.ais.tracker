'use strict';

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES } = require('../lib/constants');
const { beforeBridge } = require('../lib/utils/bridgeQueue');

describe('Positionsriktning får inte hoppa över en målbro vid dess sneda brolinje', () => {
  let service;
  let now;

  beforeEach(() => {
    now = Date.parse('2026-09-08T08:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    service = Object.create(VesselDataService.prototype);
    service.bridgeRegistry = new BridgeRegistry();
    service._confirmDirectionReversal = jest.fn();
  });

  afterEach(() => jest.restoreAllMocks());

  function path(bridge, direction, eastM) {
    const sign = direction === 'north' ? 1 : -1;
    return [-210, -95, 20].map((northM, index) => ({
      mmsi: '901009999',
      lat: bridge.lat + sign * northM / 111320,
      lon: bridge.lon + eastM / (111320 * Math.cos(bridge.lat * Math.PI / 180)),
      timestamp: now + index * 180000,
      fixTs: now + index * 180000,
      fixFeed: 'aisstream',
      sog: 1,
      targetBridge: bridge.name,
      _routeDirection: direction === 'north' ? 'south' : 'north',
      _hasMovementProof: true,
      _moored: false,
      _positionUncertain: false,
      _gpsJumpDetected: false,
    }));
  }

  function runLegs(positions) {
    now = positions[1].timestamp;
    expect(service._updatePositionDirectionEvidence(positions[1], positions[0])).toBeNull();
    now = positions[2].timestamp;
    return service._updatePositionDirectionEvidence(positions[2], positions[1]);
  }

  test.each([
    [BRIDGES.klaffbron, 'north', -40],
    [BRIDGES.klaffbron, 'south', 40],
    [BRIDGES.stridsbergsbron, 'north', -40],
    [BRIDGES.stridsbergsbron, 'south', 40],
  ])('%s %s: latituden är förbi mitten men riktig brolinje ligger fortfarande framför', (bridge, direction, eastM) => {
    const positions = path(bridge, direction, eastM);
    expect(beforeBridge(positions[2], bridge, direction)).toBe(true);
    expect(runLegs(positions)).toBeNull();
    expect(service._confirmDirectionReversal).not.toHaveBeenCalled();
  });

  test.each([
    [BRIDGES.klaffbron, 'north', 40],
    [BRIDGES.klaffbron, 'south', -40],
    [BRIDGES.stridsbergsbron, 'north', 40],
    [BRIDGES.stridsbergsbron, 'south', -40],
  ])('%s %s: samma två rena ben räcker när målbron faktiskt ligger bakom', (bridge, direction, eastM) => {
    const positions = path(bridge, direction, eastM);
    const oppositeDirection = direction === 'north' ? 'south' : 'north';
    expect(beforeBridge(positions[2], bridge, oppositeDirection)).toBe(true);
    expect(runLegs(positions)).toBe(direction);
    expect(service._confirmDirectionReversal).toHaveBeenCalledTimes(1);
  });
});
