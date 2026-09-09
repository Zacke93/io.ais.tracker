'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const Device = require('../drivers/bridge_status/device');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

const flush = async () => {
  for (let i = 0; i < 30; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('Enhetens initfel självläker även när kanalen är tom', () => {
  let app;
  let device;
  let savedTestMode;
  let values;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-08T10:00:00Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = new App();
    app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: () => null, set: jest.fn(), on: jest.fn(), off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    await app.onInit();
    // Appen har redan publicerat tom kanal. Oförändrade värden ska normalt
    // dedupliceras; återhämtningen får alltså inte kräva ny båttrafik.
    await app._processUIUpdate({
      vesselCount: 0, relevantVessels: [], vesselsBeingRemoved: new Set(), timestamp: Date.now(),
    });
    await flush();

    values = new Map();
    device = new Device();
    device.homey = { app };
    device.log = jest.fn(); device.error = jest.fn();
    device.getName = jest.fn(() => 'Brostatus');
    device.hasCapability = jest.fn(() => true);
    device.setCapabilityValue = jest.fn(async (key, value) => {
      values.set(key, value);
    });
    device.getCapabilityValue = jest.fn((key) => values.get(key));
    device.setStoreValue = jest.fn().mockRejectedValueOnce(new Error('Tillfälligt Homey-fel'));
    device.setUnavailable = jest.fn().mockResolvedValue(undefined);
    device.setAvailable = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (device) await device.onDeleted();
    if (app) await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
  });

  test('ett tillfälligt initfel får en ny skrivning och återställd tillgänglighet utan ändrad brotext', async () => {
    await device.onInit();
    expect(device._initFailed).toBe(true);
    expect(device.setUnavailable).toHaveBeenCalledTimes(1);
    device.setCapabilityValue.mockClear();

    await jest.advanceTimersByTimeAsync(2000);
    await flush();

    expect(device.setCapabilityValue).toHaveBeenCalledWith('bridge_text', BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(device.setAvailable).toHaveBeenCalled();
    expect(device._initFailed).toBe(false);
    expect(values.get('alarm_generic')).toBe(false);
    expect(values.get('connection_status')).toBe('disconnected');
  });

  test('radering under väntan på återhämtning avbokar alla nya skrivningar', async () => {
    await device.onInit();
    expect(device._initFailed).toBe(true);
    await device.onDeleted();
    device.setCapabilityValue.mockClear();
    await jest.advanceTimersByTimeAsync(2000);
    await flush();
    expect(device.setCapabilityValue).not.toHaveBeenCalled();
    expect(app._devices.has(device)).toBe(false);
  });

  test('ett sent unavailable-svar följs av en ny synkning och kan inte frysa felstatusen', async () => {
    let finishUnavailable;
    device.setUnavailable.mockImplementation(() => new Promise((resolve) => {
      finishUnavailable = resolve;
    }));
    const initializing = device.onInit();
    await flush();
    expect(device.setUnavailable).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2000);

    finishUnavailable();
    await initializing;
    device.setCapabilityValue.mockClear();
    await jest.advanceTimersByTimeAsync(2000);
    await flush();

    expect(device.setCapabilityValue).toHaveBeenCalledWith('bridge_text', BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(device.setAvailable).toHaveBeenCalled();
    expect(device._initFailed).toBe(false);
  });
});
