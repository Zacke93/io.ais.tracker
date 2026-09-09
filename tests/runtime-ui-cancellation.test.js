'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Avslutad UI-publicering får inte röra nästa appstart', () => {
  let app;
  let savedTestMode;

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
  });

  afterEach(async () => {
    if (!app._shuttingDown) await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
  });

  const snapshot = (vessels = []) => ({
    relevantVessels: vessels,
    vesselCount: vessels.length,
    vesselsBeingRemoved: new Set(),
    timestamp: Date.now(),
  });

  test('sent tokensvar får inte aktivera gammalt båtlarm efter ny tom-kanal-publicering', async () => {
    const oldTokenWrite = deferred();
    jest.spyOn(app, '_setGlobalTokenSafe').mockReturnValueOnce(oldTokenWrite.promise);
    const oldUpdate = app._processUIUpdate(snapshot([{
      mmsi: '265000123',
      lat: 58.287,
      lon: 12.295,
      targetBridge: 'Stridsbergsbron',
      status: 'en-route',
      etaMinutes: 5,
      sog: 3,
      timestamp: Date.now(),
    }]));
    await app.onUninit();
    await app.onInit();
    await app._processUIUpdate(snapshot());
    expect(app._lastBridgeText).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(app._lastBridgeAlarm).toBe(false);
    const successful = app._lastSuccessfulUpdate;

    oldTokenWrite.resolve();
    await oldUpdate;

    expect(app._lastBridgeAlarm).toBe(false);
    expect(app._lastSuccessfulUpdate).toBe(successful);
  });

  test('en gammal 200 ms-väntan publicerar inte efter shutdown', async () => {
    jest.spyOn(app, '_shouldApplyMicroGrace').mockReturnValue(true);
    const publish = jest.spyOn(app, '_processUIUpdate');
    const oldUpdate = app._actuallyUpdateUI();
    await app.onUninit();
    await jest.advanceTimersByTimeAsync(250);
    await oldUpdate;
    expect(publish).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('gammal finally får inte släppa nästa appstarts pågående publiceringslås', async () => {
    const oldWork = deferred();
    const newWork = deferred();
    jest.spyOn(app, '_actuallyUpdateUI')
      .mockReturnValueOnce(oldWork.promise)
      .mockReturnValueOnce(newWork.promise);
    const oldPublish = app._publishUpdate(app._updateVersion, 'global', ['old']);
    expect(app._inFlightUpdates.has('global')).toBe(true);
    await app.onUninit();
    await app.onInit();
    const newPublish = app._publishUpdate(app._updateVersion, 'global', ['new']);
    expect(app._inFlightUpdates.has('global')).toBe(true);

    oldWork.resolve();
    await oldPublish;
    expect(app._inFlightUpdates.has('global')).toBe(true);

    newWork.resolve();
    await newPublish;
    expect(app._inFlightUpdates.size).toBe(0);
  });
});
