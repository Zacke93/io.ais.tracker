'use strict';

jest.mock('homey');
const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { AIS_CONFIG } = require('../lib/constants');
const { hasFreshPosition } = require('../lib/utils/bridgeQueue');

const MMSI = '265000111';
const KEY = `Klaffbron|${MMSI}|southbound`;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

describe('Kajstopp följer samma accepterade råklocka över omstart', () => {
  let app;
  let store;
  let savedMode;
  const boot = async () => {
    global.__TEST_MODE__ = true;
    app = new App();
    app.log = jest.fn(); app.error = jest.fn(); app.debug = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (name) => clone(store[name]),
        set: (name, value) => {
          store[name] = clone(value);
        },
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
  };
  const fix = (offsetMs = 60000) => ({
    mmsi: MMSI,
    lat: 58.28729833333333,
    lon: 12.285721666666666,
    sog: 0.1,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now() + offsetMs,
    fixFeed: 'aishub',
  });

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-12T08:00:00Z'));
    savedMode = global.__TEST_MODE__;
    store = {};
    await boot();
    app._persistentOpeningWarnings.set(KEY, { arrivalActive: true, firedAt: Date.now() - 60000 });
  });
  afterEach(async () => {
    if (!app._shuttingDown) await app.onUninit();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedMode;
    jest.useRealTimers();
  });

  test('accepterad +60 s-fix bevarar stoppet och frigör nästa observerade avgång', async () => {
    expect(hasFreshPosition(fix())).toBe(true);
    app._observeOpeningArrivals(fix());
    jest.setSystemTime(Date.now() + 30000);
    app._observeOpeningArrivals(fix());
    const stop = clone(app._persistentOpeningWarnings.get(KEY).quayStop);
    expect(stop.confirmed).toBe(true);
    await app.onUninit();
    await boot();
    expect(app._persistentOpeningWarnings.get(KEY).quayStop).toEqual(stop);

    jest.setSystemTime(Date.now() + 120000);
    app._observeOpeningArrivals({
      ...fix(), lat: 58.28634, lon: 12.28526, sog: 2.5,
    });
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
  });

  test('en ensam framtidsfix blir inte bekräftat stopp av lagring och omstart', async () => {
    app._observeOpeningArrivals(fix());
    const stop = clone(app._persistentOpeningWarnings.get(KEY).quayStop);
    expect(stop.confirmed).toBe(false);
    await app.onUninit();
    await boot();
    expect(app._persistentOpeningWarnings.get(KEY).quayStop).toEqual(stop);
    jest.setSystemTime(Date.now() + 120000);
    app._observeOpeningArrivals({
      ...fix(), lat: 58.28634, lon: 12.28526, sog: 2.5,
    });
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
  });

  test('lagrad kajklocka bortom accepterad skevhetsmarginal avvisas fortsatt', () => {
    const firstFixTs = Date.now();
    const lastFixTs = Date.now() + AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS + 1;
    store.persistent_opening_warnings = {
      [KEY]: {
        arrivalActive: true,
        firedAt: Date.now() - 60000,
        quayStop: {
          lat: fix().lat, lon: fix().lon, firstFixTs, lastFixTs, confirmed: true,
        },
      },
    };
    app._persistentOpeningWarnings.clear();
    app._loadPersistentOpeningWarnings();
    expect(app._persistentOpeningWarnings.get(KEY).quayStop).toBeUndefined();
  });
});
