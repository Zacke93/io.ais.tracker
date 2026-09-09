'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

const FIRST_MMSI = '265123456';
const SECOND_MMSI = '265654321';
const keyFor = (mmsi) => `Klaffbron|${mmsi}|northbound`;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const deferred = () => {
  let reject;
  const promise = new Promise((resolve, fail) => {
    reject = fail;
  });
  return { promise, reject };
};
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('Nekad öppningsvarning reserverar inte samma ankomst för alltid', () => {
  let app;
  let store;
  let apps;
  let savedTestMode;

  const boot = async () => {
    const started = new AISBridgeApp();
    started.log = jest.fn();
    started.debug = jest.fn();
    started.error = jest.fn();
    started.homey = {
      ...mockHomey,
      settings: {
        get: (key) => clone(store[key]),
        set: jest.fn((key, value) => {
          store[key] = clone(value);
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await started.onInit();
    apps.push(started);
    jest.spyOn(started._bridgeOpeningTrigger, 'trigger');
    return started;
  };

  const warn = (eventId = 'Klaffbron#1', mmsis = [FIRST_MMSI]) => {
    const savedEnv = process.env.NODE_ENV;
    const savedMode = global.__TEST_MODE__;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = false;
    try {
      return app._onBridgeOpeningWarning({
        eventId,
        bridge: 'Klaffbron',
        direction: 'northbound',
        etaMinutes: 3,
        vesselCount: mmsis.length,
        leadVessel: 'BESOKAREN',
        leadMmsi: mmsis[0],
        mmsis,
        firedBy: 'fix',
      });
    } finally {
      process.env.NODE_ENV = savedEnv;
      global.__TEST_MODE__ = savedMode;
    }
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-08T10:00:00Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    store = {};
    apps = [];
    app = await boot();
  });

  afterEach(async () => {
    for (const started of apps) {
      // eslint-disable-next-line no-await-in-loop
      if (!started._shuttingDown) await started.onUninit();
    }
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('reservationen spärrar parallella varningar under await men tas bort vid uttryckligt leveransfel', async () => {
    const pending = deferred();
    app._bridgeOpeningTrigger.trigger.mockImplementationOnce(() => pending.promise);
    warn();
    expect(store.persistent_opening_warnings[keyFor(FIRST_MMSI)]).toBeDefined();
    expect(warn('Klaffbron#2').suppressed).toBe('same-arrival');
    expect(app._bridgeOpeningTrigger.trigger).toHaveBeenCalledTimes(1);

    pending.reject(new Error('Homey nekade leveransen'));
    await flush();
    expect(app._persistentOpeningWarnings.has(keyFor(FIRST_MMSI))).toBe(false);
    expect(store.persistent_opening_warnings[keyFor(FIRST_MMSI)]).toBeUndefined();
    // Händelsens engångsskydd står kvar; ingen ny automatisk retry-loop införs.
    warn();
    expect(app._bridgeOpeningTrigger.trigger).toHaveBeenCalledTimes(1);
    warn('Klaffbron#3');
    await flush();
    expect(app._bridgeOpeningTrigger.trigger).toHaveBeenCalledTimes(2);
  });

  test.each(['synkront kast', 'avvisat löfte'])('%s sparas inte som levererad varning vid nästa appstart', async (failure) => {
    app._bridgeOpeningTrigger.trigger.mockImplementationOnce(() => {
      if (failure === 'synkront kast') throw new Error('Homey nekade');
      return Promise.reject(new Error('Homey nekade'));
    });
    warn();
    await flush();
    await app.onUninit();
    app = await boot();
    warn();
    await flush();

    expect(app._bridgeOpeningTrigger.trigger).toHaveBeenCalledTimes(1);
    expect(store.persistent_opening_warnings[keyFor(FIRST_MMSI)].arrivalActive).toBe(true);
  });

  test('misslyckad konvojvarning tar endast bort den nya medlemmen och behåller redan levererad varning', async () => {
    warn();
    await flush();
    const deliveredEntry = app._persistentOpeningWarnings.get(keyFor(FIRST_MMSI));
    app._bridgeOpeningTrigger.trigger.mockRejectedValueOnce(new Error('Konvojkortet nekades'));
    warn('Klaffbron#2', [FIRST_MMSI, SECOND_MMSI]);
    await flush();

    expect(app._persistentOpeningWarnings.get(keyFor(FIRST_MMSI))).toBe(deliveredEntry);
    expect(app._persistentOpeningWarnings.has(keyFor(SECOND_MMSI))).toBe(false);
    expect(store.persistent_opening_warnings[keyFor(FIRST_MMSI)]).toEqual(deliveredEntry);
    expect(store.persistent_opening_warnings[keyFor(SECOND_MMSI)]).toBeUndefined();
    expect(warn('Klaffbron#3').suppressed).toBe('same-arrival');
  });

  test('sent fel från en tidigare ankomst kan inte radera en senare lyckad varning med samma nyckel', async () => {
    const pending = deferred();
    app._bridgeOpeningTrigger.trigger.mockImplementationOnce(() => pending.promise);
    warn();
    app._consumeOpeningDedupForPassage(FIRST_MMSI, 'Klaffbron');
    warn('Klaffbron#2');
    await flush();
    const currentEntry = app._persistentOpeningWarnings.get(keyFor(FIRST_MMSI));

    pending.reject(new Error('Gamla leveransen misslyckades sent'));
    await flush();
    expect(app._persistentOpeningWarnings.get(keyFor(FIRST_MMSI))).toBe(currentEntry);
    expect(store.persistent_opening_warnings[keyFor(FIRST_MMSI)]).toEqual(currentEntry);
  });

  test('sent fel från förra livscykeln skriver inte till en återstartad apps varningsminne', async () => {
    const pending = deferred();
    app._bridgeOpeningTrigger.trigger.mockImplementationOnce(() => pending.promise);
    warn();
    await app.onUninit();
    await app.onInit();
    app._consumeOpeningDedupForPassage(FIRST_MMSI, 'Klaffbron');
    jest.spyOn(app._bridgeOpeningTrigger, 'trigger');
    warn();
    await flush();
    const currentEntry = app._persistentOpeningWarnings.get(keyFor(FIRST_MMSI));
    app.homey.settings.set.mockClear();

    pending.reject(new Error('Förra livscykelns leverans misslyckades sent'));
    await flush();
    expect(app._persistentOpeningWarnings.get(keyFor(FIRST_MMSI))).toBe(currentEntry);
    expect(app.homey.settings.set).not.toHaveBeenCalled();
  });
});
