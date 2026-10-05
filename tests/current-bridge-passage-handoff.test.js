'use strict';

const StatusService = require('../lib/services/StatusService');
const ProximityService = require('../lib/services/ProximityService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const geometry = require('../lib/utils/geometry');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const { BRIDGES } = require('../lib/constants');

const START = Date.parse('2026-10-05T08:00:00Z');

describe('Byte av aktuell bro bevarar nästa bros inträdessegment', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test.each([
    ['south', 'stridsbergsbron', 'Klaffbron', 1],
    ['north', 'klaffbron', 'Stridsbergsbron', -1],
  ])('%s: statuskedjan bevarar beviset tills nästa rena fix bekräftar passage', (direction, previousId, target, sign) => {
    const logger = {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const registry = new BridgeRegistry();
    const status = new StatusService(registry, logger, new SystemCoordinator(logger));
    const proximity = new ProximityService(registry, logger);
    const bridge = BRIDGES.jarnvagsbron;
    const previous = BRIDGES[previousId];
    const before = { lat: bridge.lat + sign * 100 / 111320, lon: bridge.lon };
    const vessel = {
      mmsi: '265123456',
      lat: bridge.lat - sign * 20 / 111320,
      lon: bridge.lon,
      sog: 3.7,
      _rawPositionSog: 3.7,
      cog: direction === 'north' ? 30 : 210,
      timestamp: START,
      fixTs: START,
      fixFeed: 'aisstream',
      lastPositionUpdate: START,
      _routeDirection: direction,
      currentBridge: previous.name,
      targetBridge: target,
      lastPassedBridge: previous.name,
      lastPassedBridgeTime: START - 90000,
      passedBridges: [previous.name],
      _underBridgeLatched: true,
      _underBridgeSince: START - 90000,
      _underBridgeEntryLat: previous.lat,
      _underBridgeEntryLon: previous.lon,
      _underBridgeCrossedBridge: previous.name,
      _underBridgePrevLat: before.lat,
      _underBridgePrevLon: before.lon,
      _underBridgePrevSog: 3.7,
      _underBridgePrevClock: { timestamp: START - 60000, fixTs: START - 60000, fixFeed: 'aisstream' },
    };

    status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel));

    // Rensningspasset ska bevara Flow/fallback-ordningen och den tidigare
    // rena fixen. Nästa analys av samma AIS-fix får sedan pröva segmentet.
    expect(vessel.currentBridge).toBeNull();
    expect(vessel._underBridgePrevLat).toBe(before.lat);
    expect(vessel._underBridgePrevClock.fixTs).toBe(START - 60000);
    status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel));

    expect(vessel.currentBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeEntryLat).toBe(before.lat);
    expect(vessel._underBridgePrevLat).toBe(vessel.lat);
    const next = { ...vessel, lat: bridge.lat - sign * 110 / 111320 };
    expect(geometry.detectBridgePassage(next, vessel, bridge)).toMatchObject({
      passed: true, method: 'traditional_close_passage',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each([
    ['för gammal observation', { age: GPSJumpAnalyzer.PASSAGE_RECOVERY_MAX_AGE_MS + 1 }],
    ['råklocka som inte avancerat', { age: 0 }],
    ['för långt segment', { beforeM: 450 }],
    ['första observation utan föregångare', { beforeM: null }],
    ['GPS-hopp', { analysis: { gpsJumpDetected: true } }],
    ['osäker position', { uncertain: true }],
  ])('bevarandet godkänner inte %s', (_description, options) => {
    const logger = {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const registry = new BridgeRegistry();
    const status = new StatusService(registry, logger, new SystemCoordinator(logger));
    const proximity = new ProximityService(registry, logger);
    const bridge = BRIDGES.jarnvagsbron;
    const beforeM = options.beforeM === undefined ? 100 : options.beforeM;
    const priorTime = START - (options.age ?? 60000);
    const vessel = {
      mmsi: '265123456',
      lat: bridge.lat - 20 / 111320,
      lon: bridge.lon,
      sog: 3.7,
      _rawPositionSog: 3.7,
      cog: 210,
      timestamp: START,
      fixTs: START,
      fixFeed: 'aisstream',
      lastPositionUpdate: START,
      _routeDirection: 'south',
      currentBridge: 'Stridsbergsbron',
      targetBridge: 'Klaffbron',
      lastPassedBridge: 'Stridsbergsbron',
      lastPassedBridgeTime: START - 90000,
      passedBridges: ['Stridsbergsbron'],
      _positionUncertain: options.uncertain || false,
      _underBridgePrevLat: beforeM === null ? null : bridge.lat + beforeM / 111320,
      _underBridgePrevLon: beforeM === null ? null : bridge.lon,
      _underBridgePrevSog: 3.7,
      _underBridgePrevClock: { timestamp: priorTime, fixTs: priorTime, fixFeed: 'aisstream' },
    };

    status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), options.analysis);
    expect(vessel.currentBridge).toBeNull();
    status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), options.analysis);

    expect(vessel.currentBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeCrossedBridge).not.toBe('Järnvägsbron');
    expect(vessel._underBridgeEntryLat).toBe(vessel.lat);
    const next = { ...vessel, lat: bridge.lat - 110 / 111320 };
    expect(geometry.detectBridgePassage(next, vessel, bridge).passed).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
