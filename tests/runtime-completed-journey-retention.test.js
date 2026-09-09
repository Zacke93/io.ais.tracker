'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES } = require('../lib/constants');

const START = Date.parse('2026-09-08T08:00:07.123Z');
const MINUTE = 60000;
const MMSI = '902009076';
const NEAR_KEY = `${MMSI}:Klaffbron`;
const OPENING_KEY = `Klaffbron|${MMSI}|northbound`;
const data = (returning = false) => ({
  lat: BRIDGES.stallbackabron.lat + (returning ? -0.003 : 0.001),
  lon: BRIDGES.stallbackabron.lon,
  name: 'RETURBESOKAREN',
  sog: 3,
  cog: returning ? 180 : 0,
  fixTs: Date.now(),
  fixFeed: 'aisstream',
});
const markComplete = (vessel) => Object.assign(vessel, {
  targetBridge: null,
  _routeDirection: 'north',
  passedBridges: ['Klaffbron', 'Stridsbergsbron', 'Stallbackabron'],
});

describe('Avslutad resas befintliga 15-minutersminne gäller oavsett städningens fas', () => {
  let savedMode;
  let services;
  let apps;
  const create = () => {
    const logger = {
      log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
    };
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, new BridgeRegistry(), coordinator);
    services.push({ service, coordinator });
    return service;
  };
  const sweep = (service, mode, returnAt) => {
    if (mode !== 'inget svep') {
      jest.setSystemTime(START + 30 * MINUTE);
      expect(service.sweepStaleVessels()).toBe(1);
    }
    jest.setSystemTime(returnAt);
    if (mode === 'svep och pruning') service._runCleanupValidation();
  };
  const boot = async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: () => null, set: jest.fn(), on: jest.fn(), off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    await app.onInit();
    apps.push(app);
    app._processAISMessage({ mmsi: MMSI, ...data(), timestamp: START });
    await jest.advanceTimersByTimeAsync(1000);
    markComplete(app.vesselDataService.getVessel(MMSI));
    app._triggeredBoatNearKeys.add(NEAR_KEY);
    app._persistentRecentTriggers.set(NEAR_KEY, { t: START, dir: 'north' });
    app._persistentOpeningWarnings.set(OPENING_KEY, { firedAt: START, arrivalActive: true });
    return app;
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    savedMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    services = [];
    apps = [];
  });
  afterEach(async () => {
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      await app.onUninit();
    }
    for (const { service, coordinator } of services) {
      service.clearAllTimers();
      coordinator.destroy();
    }
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedMode;
    jest.useRealTimers();
  });

  test.each([
    [40 * MINUTE - 1, true, 0],
    [40 * MINUTE, false, 1],
    [45 * MINUTE, false, 1],
    [45 * MINUTE + 1, false, 0],
    [60 * MINUTE, false, 0],
  ])('återkomst efter %s ms: spärr=%s och reset=%s i alla städfaser', (gap, blocked, resetCount) => {
    for (const mode of ['inget svep', 'enbart svep', 'svep och pruning']) {
      jest.setSystemTime(START);
      const service = create();
      markComplete(service.updateVessel(MMSI, data()));
      const reset = jest.fn();
      service.on('vessel:journey-reset', reset);
      sweep(service, mode, START + gap);

      const returned = service.updateVessel(MMSI, data(true));

      expect({ mode, blocked: returned === null, resets: reset.mock.calls.length })
        .toEqual({ mode, blocked, resets: resetCount });
      if (!blocked) expect(returned.targetBridge).toBe('Stridsbergsbron');
      if (resetCount > 0) expect(reset.mock.calls[0][0].prevJourneyDirection).toBe('north');
    }
  });

  test.each([45 * MINUTE + 1, 60 * MINUTE])('sen borttagning efter %s ms skapar ingen redan utgången completed-post', (gap) => {
    const service = create();
    markComplete(service.updateVessel(MMSI, data()));
    jest.setSystemTime(START + gap);

    service.removeVessel(MMSI, 'timeout');

    expect(service.getVessel(MMSI)).toBeNull();
    expect(service._completedJourneys.has(MMSI)).toBe(false);
    expect(service._vesselGraves.has(MMSI)).toBe(false);
  });

  test.each(['inget svep', 'enbart svep', 'svep och pruning'])('%s: utgången resa rensar inte appens äldre notisminne vid återkomst', async (mode) => {
    const app = await boot();
    const reset = jest.fn();
    app.vesselDataService.on('vessel:journey-reset', reset);
    sweep(app.vesselDataService, mode, START + 60 * MINUTE);

    app._processAISMessage({ mmsi: MMSI, ...data(true), timestamp: Date.now() });

    expect({
      resets: reset.mock.calls.length,
      sessionReserved: app._triggeredBoatNearKeys.has(NEAR_KEY),
      persistent: app._persistentRecentTriggers.get(NEAR_KEY),
    }).toEqual({ resets: 0, sessionReserved: true, persistent: { t: START, dir: 'north' } });
    // Öppningars ankomstminne ägs av passage/bortfärd, inte completed-resetten.
    expect(app._persistentOpeningWarnings.get(OPENING_KEY).arrivalActive).toBe(true);
  });

  test('giltig motsatt återkomst efter 10 min frigör appens gamla boat_near-minne som förut', async () => {
    const app = await boot();
    const reset = jest.fn();
    app.vesselDataService.on('vessel:journey-reset', reset);
    sweep(app.vesselDataService, 'inget svep', START + 40 * MINUTE);

    app._processAISMessage({ mmsi: MMSI, ...data(true), timestamp: Date.now() });

    expect(reset).toHaveBeenCalledTimes(1);
    expect(app._triggeredBoatNearKeys.has(NEAR_KEY)).toBe(false);
    expect(app._persistentRecentTriggers.has(NEAR_KEY)).toBe(false);
    expect(app._persistentOpeningWarnings.get(OPENING_KEY).arrivalActive).toBe(true);
  });
});
