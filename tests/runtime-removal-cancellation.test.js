'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

const MMSI = '265123456';
const removed = (extra = {}) => ({
  mmsi: MMSI,
  reason: 'timeout',
  vessel: {
    mmsi: MMSI,
    name: 'BESOKAREN',
    lat: 58.3,
    lon: 12.29,
    cog: 0,
    passedBridges: [],
    ...extra,
  },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Gammal fartygsborttagning kan inte röra nästa appstart', () => {
  let app;
  let savedTestMode;

  const freshConnection = () => {
    app._isConnected = true;
    jest.spyOn(app, '_evaluateFeedSilence').mockReturnValue({ silent: false, feedSilentMs: 0 });
  };

  beforeEach(async () => {
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
    await app.onInit();
    freshConnection();
  });

  afterEach(async () => {
    if (!app._shuttingDown) await app.onUninit();
    jest.clearAllTimers();
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('ett gammalt tokensvar släcker inte nytt båtlarm och släpper inte den nya borttagningens lås', async () => {
    const oldToken = deferred();
    const newToken = deferred();
    const tokenWrite = jest.spyOn(app, '_setGlobalTokenSafe').mockReturnValueOnce(oldToken.promise);
    const oldRemoval = app._onVesselRemoved(removed());
    expect(app._processingRemoval.has(MMSI)).toBe(true);
    await app.onUninit();
    await app.onInit();
    freshConnection();
    app._lastBridgeAlarm = true;
    tokenWrite.mockReturnValueOnce(newToken.promise);
    const newRemoval = app._onVesselRemoved(removed());
    const newRemovalSet = app._processingRemoval;
    const capabilities = jest.spyOn(app, '_updateDeviceCapability');

    oldToken.resolve();
    await oldRemoval;

    expect(app._lastBridgeAlarm).toBe(true);
    expect(capabilities).not.toHaveBeenCalledWith('alarm_generic', false);
    expect(newRemovalSet.has(MMSI)).toBe(true);
    newToken.resolve();
    await newRemoval;
    expect(newRemovalSet.has(MMSI)).toBe(false);
  });

  test('en sen utfartsnotis rensar inte den återstartade tjänstens status och ETA-historik', async () => {
    const oldExit = deferred();
    jest.spyOn(app, '_triggerExitPointFallback').mockReturnValueOnce(oldExit.promise);
    const oldRemoval = app._onVesselRemoved(removed({
      cog: 180,
      _finalTargetDirection: 'south',
      _finalTargetBridge: 'Klaffbron',
    }));
    expect(app._triggerExitPointFallback).toHaveBeenCalledTimes(1);
    await app.onUninit();
    await app.onInit();
    const etaClear = jest.spyOn(app.statusService, 'clearVesselETAHistory');
    const statusClear = jest.spyOn(app.statusService.statusStabilizer, 'removeVessel');
    const phaseClear = jest.spyOn(app.bridgeTextService, 'clearVesselPhaseTracking');

    oldExit.resolve();
    await oldRemoval;

    expect(etaClear).not.toHaveBeenCalled();
    expect(statusClear).not.toHaveBeenCalled();
    expect(phaseClear).not.toHaveBeenCalled();
  });

  test('gammal setImmediate från en borttagning startar ingen UI-publicering efter återinit', async () => {
    jest.spyOn(app.vesselDataService, 'getVesselCount').mockReturnValue(1);
    await app._onVesselRemoved(removed());
    await app.onUninit();
    await app.onInit();
    const publish = jest.spyOn(app, '_updateUI');

    await jest.advanceTimersByTimeAsync(0);

    expect(publish).not.toHaveBeenCalled();
  });

  test('borttagningscallback efter shutdown skapar inget nytt tillstånd och kastar inte', async () => {
    await app.onUninit();
    const persist = jest.spyOn(app, '_persistLastKnownPositions');

    await expect(app._onVesselRemoved(removed())).resolves.toBeUndefined();

    expect(persist).not.toHaveBeenCalled();
    expect(app._processingRemoval).toBeNull();
  });
});
