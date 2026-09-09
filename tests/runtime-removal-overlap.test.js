'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

const OLD_MMSI = '265123456';
const NEW_MMSI = '265654321';
const DEFAULT_TEXT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const removal = (withExit = false) => ({
  mmsi: OLD_MMSI,
  reason: 'timeout',
  vessel: withExit ? {
    mmsi: OLD_MMSI,
    lat: 58.27,
    lon: 12.26,
    cog: 180,
    lastPositionUpdate: Date.now() - 60 * 60 * 1000,
    _finalTargetDirection: 'south',
    _finalTargetBridge: 'Klaffbron',
    passedBridges: ['Klaffbron'],
  } : null,
});
const activeSnapshot = () => ({
  relevantVessels: [{
    mmsi: NEW_MMSI,
    lat: 58.287,
    lon: 12.295,
    targetBridge: 'Stridsbergsbron',
    status: 'en-route',
    etaMinutes: 5,
    sog: 3,
    timestamp: Date.now(),
  }],
  vesselCount: 1,
  vesselsBeingRemoved: new Set(),
  timestamp: Date.now(),
});

describe('Borttagning och nya båtar under samma appstart', () => {
  let app;
  let savedTestMode;

  const arrive = async (mmsi) => {
    app._processAISMessage({
      mmsi,
      msgType: 1,
      lat: 58.283,
      lon: 12.2825,
      sog: 5,
      cog: 0,
      shipName: 'ATERKOMSTEN',
      timestamp: Date.now(),
    });
    await jest.advanceTimersByTimeAsync(1000);
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
    app._isConnected = true;
    app._sourceEverResponded = true;
    jest.spyOn(app, '_evaluateFeedSilence').mockReturnValue({ silent: false, feedSilentMs: 0 });
  });

  afterEach(async () => {
    if (!app._shuttingDown) await app.onUninit();
    jest.clearAllTimers();
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('en ny båt under utfartsnotisens väntan får inte skrivas över med tom kanal', async () => {
    const exit = deferred();
    jest.spyOn(app, '_triggerExitPointFallback').mockReturnValueOnce(exit.promise);
    const oldRemoval = app._onVesselRemoved(removal(true));
    await arrive(NEW_MMSI);
    expect(app.vesselDataService.getVesselCount()).toBe(1);
    expect(app._lastBridgeText).not.toBe(DEFAULT_TEXT);
    expect(app._lastBridgeAlarm).toBe(true);
    const capabilities = jest.spyOn(app, '_updateDeviceCapability');

    exit.resolve();
    await oldRemoval;

    expect(app._lastBridgeText).not.toBe(DEFAULT_TEXT);
    expect(app._lastBridgeAlarm).toBe(true);
    expect(capabilities).not.toHaveBeenCalledWith('bridge_text', DEFAULT_TEXT);
    expect(capabilities).not.toHaveBeenCalledWith('alarm_generic', false);
  });

  test('samma MMSI som återkommer behåller sin nya ETA-historik och visas när gamla borttagningen är klar', async () => {
    const exit = deferred();
    jest.spyOn(app, '_triggerExitPointFallback').mockReturnValueOnce(exit.promise);
    const oldRemoval = app._onVesselRemoved(removal(true));
    await arrive(OLD_MMSI);
    const newVessel = app.vesselDataService.getVessel(OLD_MMSI);
    const calculator = app.statusService.progressiveETACalculator;
    const newHistory = calculator._etaHistory.get(OLD_MMSI);
    expect(newVessel).toMatchObject({ targetBridge: 'Klaffbron', sog: 5 });
    expect(newHistory.length).toBeGreaterThan(0);
    expect(app._processingRemoval.has(OLD_MMSI)).toBe(true);
    const clearStatus = jest.spyOn(app.statusService.statusStabilizer, 'removeVessel');
    const clearETA = jest.spyOn(app.statusService, 'clearVesselETAHistory');
    const clearPhase = jest.spyOn(app.bridgeTextService, 'clearVesselPhaseTracking');

    exit.resolve();
    await oldRemoval;

    expect(app.vesselDataService.getVessel(OLD_MMSI)).toBe(newVessel);
    expect(calculator._etaHistory.get(OLD_MMSI)).toBe(newHistory);
    expect(clearStatus).not.toHaveBeenCalledWith(OLD_MMSI);
    expect(clearETA).not.toHaveBeenCalledWith(OLD_MMSI, 'vessel_removed_timeout');
    expect(clearPhase).not.toHaveBeenCalledWith(OLD_MMSI);
    expect(app._processingRemoval.has(OLD_MMSI)).toBe(false);
    await jest.advanceTimersByTimeAsync(500);
    expect(app._lastBridgeText).not.toBe(DEFAULT_TEXT);
    expect(app._lastBridgeAlarm).toBe(true);
  });

  test('en äldre båttexts tokensvar återaktiverar inte larm efter nyare tom-kanal-text', async () => {
    const token = deferred();
    jest.spyOn(app, '_setGlobalTokenSafe').mockReturnValueOnce(token.promise);
    const oldUpdate = app._processUIUpdate(activeSnapshot());
    await app._onVesselRemoved(removal());
    expect(app._lastBridgeText).toBe(DEFAULT_TEXT);
    expect(app._lastBridgeAlarm).toBe(false);
    const successfulUpdate = app._lastSuccessfulUpdate;
    const capabilities = jest.spyOn(app, '_updateDeviceCapability');

    token.resolve();
    await oldUpdate;

    expect(app._lastBridgeAlarm).toBe(false);
    expect(capabilities).not.toHaveBeenCalledWith('alarm_generic', true);
    expect(app._lastSuccessfulUpdate).toBe(successfulUpdate);
  });

  test('en äldre tom-kanal-texts tokensvar släcker inte larm efter nyare båttext', async () => {
    const token = deferred();
    jest.spyOn(app, '_setGlobalTokenSafe').mockReturnValueOnce(token.promise);
    const oldRemoval = app._onVesselRemoved(removal());
    await app._processUIUpdate(activeSnapshot());
    expect(app._lastBridgeText).not.toBe(DEFAULT_TEXT);
    expect(app._lastBridgeAlarm).toBe(true);
    const capabilities = jest.spyOn(app, '_updateDeviceCapability');

    token.resolve();
    await oldRemoval;

    expect(app._lastBridgeAlarm).toBe(true);
    expect(capabilities).not.toHaveBeenCalledWith('alarm_generic', false);
  });
});
