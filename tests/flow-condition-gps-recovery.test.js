'use strict';

jest.mock('homey');

const { __mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const { BRIDGES, TRIGGER_POINTS } = require('../lib/constants');

describe('Båt vid bro kräver positionsbevis efter GPS-störning', () => {
  let app;
  let condition;
  const start = Date.parse('2026-10-05T10:00:00Z');
  const mmsi = '265123456';

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(start);
    app = new AISBridgeApp();
    app.homey = __mockHomey;
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = new VesselDataService(app, app.bridgeRegistry, new SystemCoordinator(app));
    app.proximityService = new ProximityService(app.bridgeRegistry, app);
    const card = {
      registerRunListener: jest.fn((listener) => {
        condition = listener;
      }),
    };
    jest.spyOn(__mockHomey.flow, 'getConditionCard').mockReturnValue(card);
    await app._setupFlowCards();
  });

  afterEach(() => {
    app.vesselDataService.clearAllTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function update(point, offsetM, elapsedMs) {
    jest.advanceTimersByTime(elapsedMs);
    return app.vesselDataService.updateVessel(mmsi, {
      lat: point.lat + offsetM / 111320,
      lon: point.lon,
      sog: 4.5,
      cog: 35,
      fixTs: Date.now(),
      fixFeed: 'aisstream',
    });
  }

  test.each([
    ['klaffbron', BRIDGES.klaffbron],
    ['any', BRIDGES.klaffbron],
    ['kanalinfarten', TRIGGER_POINTS.kanalinfarten],
  ])('%s: utgånget tidslås friskförklarar inte hoppfixet', async (bridge, point) => {
    update(point, -500, 0);
    const jumped = update(point, -30, 1000);
    expect(GPSJumpAnalyzer.needsPassageConfirmation(jumped)).toBe(true);
    // Samma korta hållning som appens positionsanalys sätter på hoppfixet.
    app.vesselDataService.setGpsJumpHold(mmsi, 2000);
    expect(app.vesselDataService.hasGpsJumpHold(mmsi)).toBe(true);
    expect(await condition({ bridge })).toBe(false);

    jest.advanceTimersByTime(30000);
    expect(app.vesselDataService.hasGpsJumpHold(mmsi)).toBe(false);
    expect(await condition({ bridge })).toBe(false);

    const recovered = update(point, -25, 5000);
    expect(GPSJumpAnalyzer.needsPassageConfirmation(recovered)).toBe(false);
    expect(await condition({ bridge })).toBe(true);
  });

  test('rimlig förflyttning efter AIS-glapp får matcha även med allmän osäkerhet', async () => {
    const vessel = update(BRIDGES.klaffbron, -30, 0);
    vessel._positionUncertain = true;
    vessel._positionAnalysis = { reason: 'large_movement_after_gap' };
    expect(await condition({ bridge: 'klaffbron' })).toBe(true);
  });
});
