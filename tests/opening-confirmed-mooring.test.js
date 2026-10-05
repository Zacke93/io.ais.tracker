'use strict';

jest.mock('homey');
const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { BRIDGES } = require('../lib/constants');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');

const MMSI = '245057000';
const KEY = `Stridsbergsbron|${MMSI}|southbound`;
const START = Date.parse('2026-09-21T20:30:00Z');
// KINNEs råa förtöjnings- och avgångspositioner 21–23 september. Platsen
// ligger 802 m från Stridsbergsbron, utanför samtliga ritade kajzoner.
const STOP = { lat: 58.29854, lon: 12.30443 };
const LEAVING = { lat: 58.29841, lon: 12.30413 };
const DEPARTED = { lat: 58.29779, lon: 12.30317 };

describe('Bekräftad förtöjning och fysisk avgång skapar en ny öppningsankomst', () => {
  let app;
  let store;
  let savedEnv;
  let savedMode;
  let cards;

  async function boot() {
    global.__TEST_MODE__ = true;
    app = new App();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => store[key] ?? null,
        set: (key, value) => {
          store[key] = JSON.parse(JSON.stringify(value));
        },
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    app.log = jest.fn(); app.error = jest.fn(); app.debug = jest.fn();
    await app.onInit();
    app._isConnected = true;
    app._lastConnectionLost = null;
    app._bridgeOpeningTrigger.clearTriggerCalls();
    cards.push(app._bridgeOpeningTrigger);
    global.__TEST_MODE__ = false;
  }

  beforeEach(async () => {
    jest.useFakeTimers({ now: START });
    savedEnv = process.env.NODE_ENV;
    savedMode = global.__TEST_MODE__;
    process.env.NODE_ENV = 'production';
    store = {};
    cards = [];
    await boot();
  });
  afterEach(async () => {
    await app.onUninit();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = savedMode;
    jest.useRealTimers();
  });

  async function fix(position, sog, navStatus, dt = 60000) {
    jest.setSystemTime(Date.now() + dt);
    app._processAISMessage({
      mmsi: MMSI,
      shipName: 'KINNE',
      ...position,
      sog,
      cog: 210,
      navStatus,
      fixTs: Date.now(),
      fixFeed: 'aisstream',
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return app.vesselDataService.getVessel(MMSI);
  }

  const warnings = () => cards.flatMap((card) => card.getTriggerCalls())
    .filter((call) => call.tokens.bridge_name === 'Stridsbergsbron');

  async function warnedArrival(position = STOP) {
    await fix({ lat: position.lat + 0.001, lon: position.lon + 0.001 }, 4, 0);
    await fix(position, 4, 0);
    expect(warnings()).toHaveLength(1);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    expect(app.vesselDataService.isNearMooringZone(position.lat, position.lon)).toBe(false);
  }

  async function moor(navStatus = 5, position = STOP) {
    const first = await fix(position, 0, navStatus);
    expect(first._moored).toBe(true);
    const second = await fix(position, 0, navStatus);
    expect(second._moored).toBe(true);
    return second;
  }

  test.each([
    [1, false], [5, false], [1, true], [5, true],
  ])('navstatus %s, omstart=%s: avgången får ett nytt kort först efter 50 m', async (navStatus, restart) => {
    await warnedArrival();
    await moor(navStatus);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    if (restart) {
      await app.onUninit();
      await boot();
      expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    }
    await fix(LEAVING, 1.2, 0, 40 * 3600000);
    expect(warnings()).toHaveLength(1);
    const departed = await fix(DEPARTED, 2.9, 0);
    expect(departed._moored).toBe(false);
    expect(warnings()).toHaveLength(2);
    expect(app._persistentOpeningWarnings.get(KEY).firedAt).toBe(Date.now());
    await fix({ lat: 58.29703, lon: 12.30181 }, 2.7, 0);
    expect(warnings()).toHaveLength(2);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('vanligt stopp utan förtöjningsbevis är samma ankomst', async () => {
    await warnedArrival();
    await fix(STOP, 0, 0);
    const still = await fix(STOP, 0, 0, 20 * 60000);
    expect(still._moored).toBe(false);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop).toBeUndefined();
    await fix(DEPARTED, 2.9, 0);
    expect(warnings()).toHaveLength(1);
  });

  test('förtöjningsklassning i brokön under 600 m bryter inte ankomsten', async () => {
    const close = { lat: BRIDGES.stridsbergsbron.lat + 450 / 111320, lon: BRIDGES.stridsbergsbron.lon };
    await warnedArrival(close);
    await moor(5, close);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop).toBeUndefined();
    await fix({ ...close, lat: close.lat - 120 / 111320 }, 2.9, 0, 3600000);
    expect(warnings()).toHaveLength(1);
  });

  test('en ensam förtöjningsfix eller radiotystnad bekräftar inget nytt stopp', async () => {
    await warnedArrival();
    await fix(STOP, 0, 5);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(false);
    await fix(DEPARTED, 2.9, 0, 40 * 3600000);
    expect(warnings()).toHaveLength(1);
  });

  test('kajvobbel och ett verkligt detekterat GPS-hopp frigör inte dedupen', async () => {
    await warnedArrival();
    await moor();
    const { firedAt } = app._persistentOpeningWarnings.get(KEY);
    await fix(STOP, 0, 5, 40 * 3600000);
    await fix(LEAVING, 3.5, 0);
    expect(app._persistentOpeningWarnings.get(KEY).firedAt).toBe(firedAt);
    expect(warnings()).toHaveLength(1);

    const jumped = await fix({ ...DEPARTED, lat: DEPARTED.lat - 200 / 111320 }, 0.1, 0, 1000);
    expect(GPSJumpAnalyzer.needsPassageConfirmation(jumped)).toBe(true);
    expect(app._persistentOpeningWarnings.get(KEY).firedAt).toBe(firedAt);
    expect(warnings()).toHaveLength(1);

    await fix(STOP, 0, 5, 120000);
    expect(warnings()).toHaveLength(1);
  });
});
