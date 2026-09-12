'use strict';

jest.mock('homey');
const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { BRIDGES } = require('../lib/constants');

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};
const KEY = '265000111:Klaffbron';
const NEWKEY = '265000222:Klaffbron';
describe('Sena AIS- och Homey-fortsättningar följer appens livscykel', () => {
  let apps; let store; let settings; let savedEnv; let savedMode;
  const boot = async () => {
    global.__TEST_MODE__ = true; process.env.NODE_ENV = 'test';
    const app = new App(); app.log = jest.fn(); app.error = jest.fn(); app.debug = jest.fn();
    app.homey = { ...mockHomey, settings };
    apps.push(app); await app.onInit();
    global.__TEST_MODE__ = false; process.env.NODE_ENV = 'production';
    return app;
  };
  const vessel = (mmsi) => ({
    mmsi,
    name: 'PROVBAT',
    lat: BRIDGES.klaffbron.lat - 200 / 111320,
    lon: BRIDGES.klaffbron.lon,
    sog: 4,
    cog: 0,
    _routeDirection: 'north',
    _hasMovementProof: true,
    _plausibleMovementSeen: true,
    targetBridge: 'Klaffbron',
    etaMinutes: 3,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aisstream',
    passedBridges: [],
  });
  const candidate = {
    name: 'Klaffbron', id: 'klaffbron', distance: 200, source: 'target',
  };
  beforeEach(() => {
    jest.useFakeTimers(); jest.setSystemTime(new Date('2026-09-12T08:00:00Z'));
    savedEnv = process.env.NODE_ENV; savedMode = global.__TEST_MODE__;
    apps = []; store = {}; settings = {
      get: (name) => clone(store[name]),
      set: jest.fn((name, value) => {
        store[name] = clone(value);
      }),
      on: jest.fn(),
      off: jest.fn(),
    };
  });
  afterEach(async () => {
    for (const app of apps) if (!app._shuttingDown) await app.onUninit();
    await jest.advanceTimersByTimeAsync(0); expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedMode; process.env.NODE_ENV = savedEnv; jest.useRealTimers();
  });
  test('sen nekad boat_near efter onUninit skriver inte lagring som ägs av nästa app', async () => {
    const app = await boot(); let reject;
    jest.spyOn(app._boatNearTrigger, 'trigger').mockImplementationOnce(() => new Promise((resolve, fail) => {
      reject = fail;
    }));
    const pending = app._triggerBoatNearFlowForBridge(vessel('265000111'), candidate);
    expect(store.persistent_recent_triggers[KEY]).toBeDefined();
    await app.onUninit();
    const newer = await boot();
    await newer._triggerBoatNearFlowForBridge(vessel('265000222'), candidate);
    expect(store.persistent_recent_triggers[NEWKEY]).toBeDefined();
    const before = clone(store); const writes = settings.set.mock.calls.length;
    reject(new Error('Gammalt SDK-avslag efter byte av app')); await pending; await flush();
    expect(settings.set.mock.calls).toHaveLength(writes);
    expect(store).toEqual(before);
  });
  test('ny app efter gammal catch måste behålla nya båtens faktiska leverans och besök', async () => {
    const old = await boot(); let reject;
    jest.spyOn(old._boatNearTrigger, 'trigger').mockImplementationOnce(() => new Promise((resolve, fail) => {
      reject = fail;
    }));
    const pending = old._triggerBoatNearFlowForBridge(vessel('265000111'), candidate);
    await old.onUninit();
    const live = await boot(); await live._triggerBoatNearFlowForBridge(vessel('265000222'), candidate);
    reject(new Error('Nekat gamla kortet')); await pending; await flush();
    const persistedAfterFailure = clone(store);
    expect(persistedAfterFailure.persistent_recent_triggers[NEWKEY]).toBeDefined();
    expect(persistedAfterFailure.trigger_point_visits.entries[NEWKEY]).toBeDefined();
  });

  test.each(['shutdown', 'återinit'])('väntande tvåbroloop fortsätter inte efter %s', async (mode) => {
    const app = await boot(); let resolve;
    const boat = {
      ...vessel('265000111'),
      targetBridge: 'Stridsbergsbron',
      currentBridge: 'Järnvägsbron',
      lat: (BRIDGES.jarnvagsbron.lat + BRIDGES.stridsbergsbron.lat) / 2,
      lon: (BRIDGES.jarnvagsbron.lon + BRIDGES.stridsbergsbron.lon) / 2,
    };
    const trigger = jest.spyOn(app._boatNearTrigger, 'trigger')
      .mockImplementationOnce(() => new Promise((done) => {
        resolve = done;
      }));
    const work = app._triggerBoatNearFlow(boat);
    expect(trigger).toHaveBeenCalledTimes(1);
    await app.onUninit();
    let current = trigger;
    if (mode === 'återinit') {
      global.__TEST_MODE__ = true; process.env.NODE_ENV = 'test';
      await app.onInit(); global.__TEST_MODE__ = false; process.env.NODE_ENV = 'production';
      current = jest.spyOn(app._boatNearTrigger, 'trigger');
    }
    const expected = current.mock.calls.length;
    resolve(); await work; await flush();
    expect(current).toHaveBeenCalledTimes(expected);
  });

  test.each(['entered', 'updated'])('gammal %s-fortsättning kan inte återföra gamla öppningsarmar efter återinit', async (type) => {
    const app = await boot(); let resolve;
    jest.spyOn(app, '_analyzeVesselPosition').mockImplementationOnce(() => new Promise((done) => {
      resolve = done;
    }));
    const boat = vessel('265000111');
    const event = { mmsi: boat.mmsi, vessel: boat, oldVessel: { ...boat } };
    const work = type === 'entered' ? app._onVesselEntered(event) : app._onVesselUpdated(event);
    await flush(); expect(resolve).toEqual(expect.any(Function));
    await app.onUninit();
    global.__TEST_MODE__ = true; process.env.NODE_ENV = 'test';
    await app.onInit(); global.__TEST_MODE__ = false; process.env.NODE_ENV = 'production';
    const observeOpening = jest.spyOn(app, '_observeBridgeOpening');
    const trigger = jest.spyOn(app._boatNearTrigger, 'trigger');
    resolve(); await work; await flush();
    expect(observeOpening).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });
  test('levande tvåbroloop behåller båda verkliga närnotiserna', async () => {
    const app = await boot();
    const boat = {
      ...vessel('265000111'),
      targetBridge: 'Stridsbergsbron',
      currentBridge: 'Järnvägsbron',
      lat: (BRIDGES.jarnvagsbron.lat + BRIDGES.stridsbergsbron.lat) / 2,
      lon: (BRIDGES.jarnvagsbron.lon + BRIDGES.stridsbergsbron.lon) / 2,
    };
    const trigger = jest.spyOn(app._boatNearTrigger, 'trigger');
    await app._triggerBoatNearFlow(boat);
    expect(trigger.mock.calls.map(([tokens]) => tokens.bridge_name).sort()).toEqual(['Järnvägsbron', 'Stridsbergsbron']);
    expect(app._triggerPointVisits.holds(boat.mmsi, 'Järnvägsbron')).toBe(true);
    expect(app._triggerPointVisits.holds(boat.mmsi, 'Stridsbergsbron')).toBe(true);
  });
  test('nekad leverans under samma appstart återställer besöket och tillåter nytt försök', async () => {
    const app = await boot();
    const trigger = jest.spyOn(app._boatNearTrigger, 'trigger').mockRejectedValueOnce(new Error('Nekat kort'));
    await app._triggerBoatNearFlowForBridge(vessel('265000111'), candidate);
    expect(app._triggerPointVisits.holds('265000111', 'Klaffbron')).toBe(false);
    expect(store.persistent_recent_triggers[KEY]).toBeUndefined();
    await app._triggerBoatNearFlowForBridge(vessel('265000111'), candidate);
    expect(trigger).toHaveBeenCalledTimes(2);
    expect(app._triggerPointVisits.holds('265000111', 'Klaffbron')).toBe(true);
  });
  test.each(['entered', 'updated'])('gammal %s-handler avbryter sina fallbacksteg efter ett verkligt väntande Homey-anrop', async (type) => {
    const app = await boot();
    // Kortet ska tillhöra handlerns egen await, inte en sidoemitterad statusändring.
    jest.spyOn(app, '_analyzeVesselPosition').mockResolvedValue();
    let resolve;
    jest.spyOn(app._boatNearTrigger, 'trigger').mockImplementationOnce(() => new Promise((done) => {
      resolve = done;
    }));
    const boat = vessel('265000111');
    const event = { mmsi: boat.mmsi, vessel: boat, oldVessel: { ...boat } };
    const work = type === 'entered' ? app._onVesselEntered(event) : app._onVesselUpdated(event);
    await flush();
    expect(resolve).toEqual(expect.any(Function));
    await app.onUninit();
    global.__TEST_MODE__ = true; process.env.NODE_ENV = 'test';
    await app.onInit(); global.__TEST_MODE__ = false; process.env.NODE_ENV = 'production';
    const fallback = jest.spyOn(app, '_checkSkippedBridgesFallback');
    resolve(); await work; await flush();
    expect(fallback).not.toHaveBeenCalled();
  });
  test('statushandler från gammal appstart begär ingen publicering efter sent kortkvitto', async () => {
    const app = await boot();
    let resolve;
    jest.spyOn(app._boatNearTrigger, 'trigger').mockImplementationOnce(() => new Promise((done) => {
      resolve = done;
    }));
    const boat = vessel('265000111');
    const work = app._onVesselStatusChanged({ vessel: boat, oldStatus: 'approaching', newStatus: 'waiting' });
    await flush(); expect(resolve).toEqual(expect.any(Function));
    await app.onUninit();
    global.__TEST_MODE__ = true; process.env.NODE_ENV = 'test';
    await app.onInit(); global.__TEST_MODE__ = false; process.env.NODE_ENV = 'production';
    const update = jest.spyOn(app, '_updateUI');
    resolve(); await work; await flush();
    expect(update).not.toHaveBeenCalled();
  });

});
