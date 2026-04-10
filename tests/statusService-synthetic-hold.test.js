'use strict';

const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const constants = require('../lib/constants');

const mockLogger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

describe('StatusService bridge opening handling', () => {
  let statusService;
  let proximityService;
  let vessel;

  beforeEach(() => {
    jest.clearAllMocks();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(mockLogger);
    const vesselDataService = { anchorPassageTimestamp: jest.fn() };
    const passageLatchService = { shouldBlockStatus: jest.fn().mockReturnValue(false) };

    statusService = new StatusService(
      bridgeRegistry,
      mockLogger,
      systemCoordinator,
      vesselDataService,
      passageLatchService,
    );
    proximityService = new ProximityService(bridgeRegistry, mockLogger);

    const olide = constants.BRIDGES.olidebron;
    vessel = {
      mmsi: 'TEST304225000',
      name: 'Test Vessel',
      lat: olide.lat + 0.00005,
      lon: olide.lon,
      sog: 3,
      cog: 10,
      status: 'en-route',
      targetBridge: 'Klaffbron',
      currentBridge: 'Olidebron',
      lastPassedBridge: 'Olidebron',
      lastPassedBridgeTime: Date.now() - 15 * 1000,
      _bridgeOpeningUntil: Date.now() + 4000,
    };
  });

  test('holds status during bridge opening window', () => {
    const proximityData = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, proximityData);

    expect(result.status).not.toBe('passed');
    expect(result.statusReason).not.toBe('vessel_recently_passed');
  });

  test('returns to passed once bridge opening window expires', () => {
    const proximityDataHold = proximityService.analyzeVesselProximity(vessel);
    statusService.analyzeVesselStatus(vessel, proximityDataHold);

    vessel._bridgeOpeningUntil = Date.now() - 1000;
    vessel.lat += 0.001; // Move ~110m away to exit under-bridge zone
    // FIX G: Återställ debounce-timer för att tillåta status-ändring
    vessel._lastStatusChangeTime = Date.now() - 10000; // 10 sekunder sedan
    const proximityDataAfter = proximityService.analyzeVesselProximity(vessel);
    const resultAfter = statusService.analyzeVesselStatus(vessel, proximityDataAfter);

    expect(resultAfter.status).toBe('passed');
    expect(resultAfter.statusReason).toBe('vessel_recently_passed');
  });
});
