'use strict';

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const VesselDataService = require('../lib/services/VesselDataService');

describe('VesselDataService scheduleCleanup', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('does not shorten cleanup timeout during "precis passerat" window', () => {
    const logger = {
      log: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, bridgeRegistry, systemCoordinator);

    // Ensure the test targets the passage protection path only
    service.vesselLifecycleManager.shouldEliminateVessel = () => false;

    const mmsi = '220018000';
    const now = Date.now();
    service.vessels.set(mmsi, {
      mmsi,
      lat: 0,
      lon: 0,
      sog: 6.0,
      cog: 180,
      status: 'passed',
      lastPositionUpdate: now,
      timestamp: now,
      lastPassedBridge: 'Stallbackabron',
      lastPassedBridgeTime: now - 2 * 60 * 1000, // within 3-minute display window
    });

    const baseTimeout = 5 * 60 * 1000; // 5 minutes
    service.scheduleCleanup(mmsi, baseTimeout);

    // Regression: passage protection must NEVER shorten an existing longer timeout
    jest.advanceTimersByTime(70 * 1000);
    expect(service.vessels.has(mmsi)).toBe(true);

    jest.advanceTimersByTime(baseTimeout - 70 * 1000 + 10);
    expect(service.vessels.has(mmsi)).toBe(false);
  });
});
