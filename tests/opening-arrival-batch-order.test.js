'use strict';

jest.mock('homey');
const { __mockHomey: homey } = require('homey');
const App = require('../app');
const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

const START = Date.parse('2026-09-12T10:00:00Z');
const MMSI = '258177180';
const KEY = `Klaffbron|${MMSI}|southbound`;
const vessel = (now, extra = {}) => ({
  mmsi: MMSI,
  name: 'HERA II',
  lat: 58.28713,
  lon: 12.28559,
  sog: 4,
  cog: 180,
  _hasMovementProof: true,
  _plausibleMovementSeen: true,
  targetBridge: 'Klaffbron',
  _routeDirection: 'south',
  _finalTargetDirection: 'south',
  timestamp: now,
  lastPositionUpdate: now,
  fixTs: now,
  fixFeed: 'aishub',
  etaMinutes: 4,
  status: 'approaching',
  passedBridges: [],
  ...extra,
});

// Verkliga App/BOS/Flow-anrop och deras vanliga Promise-fortsättningar.
// Ingen artificiell väntan eller ersatt positionsanalys skapar ordningen.
describe('Kajavgång använder sin nya observation även i en gemensam AIS-batch', () => {
  let app;
  let now;
  let savedEnv;
  let warnings;

  beforeEach(async () => {
    now = START;
    jest.useFakeTimers({ now });
    global.__TEST_MODE__ = true;
    homey.app.settings = { debug_level: 'off', ais_api_key: null };
    homey.settings = {
      get: (key) => homey.app.settings[key] ?? null,
      set: (key, value) => {
        homey.app.settings[key] = JSON.parse(JSON.stringify(value));
      },
      on: () => {},
      off: () => {},
    };
    app = new App(); app.homey = homey;
    await app.onInit();
    app.log = jest.fn(); app.error = jest.fn();
    warnings = [];
    const originalWarning = app._onBridgeOpeningWarning.bind(app);
    app._onBridgeOpeningWarning = (payload) => {
      warnings.push(payload);
      return originalWarning(payload);
    };
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = false;
  });
  afterEach(async () => {
    await app.onUninit();
    process.env.NODE_ENV = savedEnv;
    delete global.__TEST_MODE__;
    jest.useRealTimers();
  });

  const step = () => {
    now += 60000; jest.setSystemTime(now);
  };
  async function stopAtQuay() {
    const service = app.bridgeOpeningService;
    service.observeVessel(vessel(now));
    await Promise.resolve();
    expect(warnings).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      step();
      const stopped = vessel(now, { sog: 0.1 });
      app._observeOpeningArrivals(stopped);
      service.observeVessel(stopped);
    }
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    return vessel(now, { sog: 0.1 });
  }

  test.each([true, false])('avgång norrut ger inget nytt Klaffkort, annan båt först=%s', async (otherFirst) => {
    const oldVessel = await stopAtQuay();
    step();
    const departing = vessel(now, {
      lat: 58.28860,
      lon: 12.28845,
      sog: 4,
      cog: 30,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      _finalTargetDirection: 'north',
    });
    const other = vessel(now, {
      mmsi: '258177181',
      lat: BRIDGES.klaffbron.lat + 1100 / 111320,
      lon: BRIDGES.klaffbron.lon,
      etaMinutes: 7,
    });
    app.vesselDataService.vessels.set(departing.mmsi, departing);
    app.vesselDataService.vessels.set(other.mmsi, other);
    const tasks = [
      () => app._onVesselUpdated({ mmsi: departing.mmsi, vessel: departing, oldVessel }),
      () => app._onVesselUpdated({ mmsi: other.mmsi, vessel: other, oldVessel: { ...other } }),
    ];
    if (otherFirst) tasks.reverse();
    await Promise.all(tasks.map((run) => run()));

    const hers = warnings.filter((warning) => warning.mmsis.includes(MMSI));
    expect(hers.map((warning) => [warning.bridge, warning.direction])).toEqual([
      ['Klaffbron', 'southbound'], ['Stridsbergsbron', 'northbound'],
    ]);
    expect(hers.every((warning) => Number.isFinite(warning.originalDueMs))).toBe(true);
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(2);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('avgång söderut varnas en gång med den nya positionen och deadlinen', async () => {
    const oldVessel = await stopAtQuay();
    step();
    const departing = vessel(now, { lat: 58.28634, lon: 12.28526, sog: 3.7 });
    const other = vessel(now, {
      mmsi: '258177181',
      lat: BRIDGES.klaffbron.lat + 1100 / 111320,
      lon: BRIDGES.klaffbron.lon,
      etaMinutes: 7,
    });
    app.vesselDataService.vessels.set(departing.mmsi, departing);
    app.vesselDataService.vessels.set(other.mmsi, other);
    const first = app._onVesselUpdated({ mmsi: other.mmsi, vessel: other, oldVessel: { ...other } });
    const second = app._onVesselUpdated({ mmsi: departing.mmsi, vessel: departing, oldVessel });
    await Promise.all([first, second]);
    const hers = warnings.filter((warning) => warning.mmsis.includes(MMSI));
    expect(hers).toHaveLength(2);
    expect(hers[1]).toMatchObject({ bridge: 'Klaffbron', direction: 'southbound', fixAgeMs: 0 });
    expect(hers[1].distanceM).toBe(Math.round(geometry.calculateDistance(
      departing.lat, departing.lon, BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon,
    )));
    expect(Number.isFinite(hers[1].originalDueMs)).toBe(true);
    expect(app.error).not.toHaveBeenCalled();
  });
});

describe('Återöppnad arm väntar på en tillämplig observation', () => {
  let service;
  let warning;
  let now;
  beforeEach(() => {
    now = START;
    warning = jest.fn();
    service = new Service({ now: () => now, onWarning: warning, targetBridges: ['Klaffbron'] });
    service.observeVessel(vessel(now));
    expect(warning).toHaveBeenCalledTimes(1);
    now += 60000;
    service.restartArrival(MMSI, 'Klaffbron');
  });
  afterEach(() => service.destroy());

  test('watchdog kan inte avfyra gamla kajfixen; färsk fix återställer vanlig engångsvarning', () => {
    service.tick(); service.restartArrival(MMSI, 'Klaffbron'); service.tick();
    expect(warning).toHaveBeenCalledTimes(1);
    service.observeVessel(vessel(now, { lat: 58.28634, lon: 12.28526 }));
    service.tick(); service.tick();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0].fixAgeMs).toBe(0);
  });

  test.each([
    ['saknad position', { lat: null }],
    ['GPS-hopp', { _gpsJumpDetected: true }],
    ['osäker position', { _positionUncertain: true }],
    ['gammalt AIS-ankare', { fixTs: START - 30 * 60000 }],
    ['tappad målbro', { targetBridge: null }],
  ])('%s frigör inte den gamla varningen', (_name, extra) => {
    service.observeVessel(vessel(now, extra));
    service.tick();
    expect(warning).toHaveBeenCalledTimes(1);
    service.observeVessel(vessel(now));
    service.tick();
    expect(warning).toHaveBeenCalledTimes(2);
  });

  test('pending-armen kan inte låna en annan gammal konvojvarning', () => {
    // En andra avfyrad öppning står kvar, men den väntande armens nya
    // ankomst har ännu ingen position att jämföra med den.
    const other = vessel(now, { mmsi: '258177181', etaMinutes: 20 });
    service.observeVessel(other);
    expect(warning).toHaveBeenCalledTimes(2);
    const otherArm = service._arms.get('258177181::Klaffbron');
    otherArm.expectedArrivalMs = now + 4 * 60000;
    const otherEvent = service._eventsAt('Klaffbron').find((event) => event.id === otherArm.eventId);
    otherEvent.referenceArrivalMs = otherArm.expectedArrivalMs;
    service.tick();
    const pending = service._arms.get(`${MMSI}::Klaffbron`);
    expect(pending.absorbedAt).toBeNull();
    expect(pending.eventId).toBeNull();
    expect(pending.warnedAt).toBeNull();
  });
});
