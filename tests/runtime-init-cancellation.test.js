'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flush = async () => {
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('Hela appstarten avbryts när dess livscykel avslutas', () => {
  let app;
  let savedTestMode;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-08T10:00:00Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: () => null,
        set: jest.fn(),
        on: jest.fn(),
        off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
  });

  afterEach(async () => {
    // Även en trasig sen start ska kunna städas när regressionstestet är rött.
    if (!app._vesselRemovalTimers) app._vesselRemovalTimers = new Map();
    await app.onUninit();
    jest.clearAllTimers();
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('sent createToken efter shutdown återansluter inte AIS och skapar inga lyssnare eller timers', async () => {
    const pending = deferred();
    const token = { setValue: jest.fn().mockResolvedValue(undefined) };
    app.homey.flow.createToken = jest.fn(() => pending.promise);
    const connect = jest.spyOn(app, '_startConnection');
    const initializing = app.onInit();
    await flush();
    expect(app.homey.flow.createToken).toHaveBeenCalledTimes(1);

    await app.onUninit();
    pending.resolve(token);
    await initializing;

    expect(connect).not.toHaveBeenCalled();
    expect(app._eventsHooked).toBe(false);
    expect(app.aisClient.listenerCount('ais-message')).toBe(0);
    expect(app._watchdogTimer).toBeFalsy();
    expect(token.setValue).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('den gamla appstarten kan inte starta om tjänster ovanpå en färdig ny start på samma instans', async () => {
    const pending = deferred();
    const oldToken = { setValue: jest.fn().mockResolvedValue(undefined) };
    const currentToken = { setValue: jest.fn().mockResolvedValue(undefined) };
    app.homey.flow.createToken = jest.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(currentToken);
    const connect = jest.spyOn(app, '_startConnection');
    const startMonitoring = jest.spyOn(app, '_setupMonitoring');
    const startCoalescing = jest.spyOn(app, '_initializeCoalescingSystem');
    const oldInitialization = app.onInit();
    await flush();
    await app.onUninit();
    await app.onInit();
    const currentWatchdog = app._watchdogTimer;

    pending.resolve(oldToken);
    await oldInitialization;

    expect(connect).toHaveBeenCalledTimes(1);
    expect(startMonitoring).toHaveBeenCalledTimes(1);
    expect(startCoalescing).toHaveBeenCalledTimes(1);
    expect(app._watchdogTimer).toBe(currentWatchdog);
    expect(app._globalBridgeTextToken).toBe(currentToken);
    expect(oldToken.setValue).not.toHaveBeenCalled();
    expect(app._shuttingDown).toBe(false);
    await app.onUninit();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('avslutad anslutningsstart efter shutdown startar inte monitoring eller watchdog igen', async () => {
    const pending = deferred();
    const originalConnect = app._startConnection.bind(app);
    jest.spyOn(app, '_startConnection').mockImplementation(async () => {
      await originalConnect();
      await pending.promise;
    });
    const startMonitoring = jest.spyOn(app, '_setupMonitoring');
    const startCoalescing = jest.spyOn(app, '_initializeCoalescingSystem');
    const initializing = app.onInit();
    await flush();
    expect(app._startConnection).toHaveBeenCalledTimes(1);

    await app.onUninit();
    pending.resolve();
    await initializing;

    expect(startMonitoring).not.toHaveBeenCalled();
    expect(startCoalescing).not.toHaveBeenCalled();
    expect(app._watchdogTimer).toBeFalsy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
