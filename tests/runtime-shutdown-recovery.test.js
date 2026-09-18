'use strict';

jest.mock('homey');
const { EventEmitter } = require('events');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

describe('Avstängning efter ofullständig start och upprepad avstängning', () => {
  let app;
  let settings;
  let stored;
  let savedMode;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-18T10:00:00Z'));
    savedMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    stored = {};
    settings = new EventEmitter();
    settings.get = jest.fn((key) => stored[key] ?? null);
    settings.set = jest.fn((key, value) => {
      stored[key] = JSON.parse(JSON.stringify(value));
    });
    app = new AISBridgeApp();
    app.homey = { ...mockHomey, settings, flow: { ...mockHomey.flow } };
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
  });

  afterEach(async () => {
    if (!app._shuttingDown) await app.onUninit();
    // Även den röda regressionen får inte lämna processlyssnare i Jest.
    if (app._onUncaughtException) process.removeListener('uncaughtException', app._onUncaughtException);
    if (app._onUnhandledRejection) process.removeListener('unhandledRejection', app._onUnhandledRejection);
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedMode;
  });

  test('två avstängningar bevarar lagrat kajminne och lämnar inga timers eller lyssnare', async () => {
    await app.onInit();
    app._quayStableLedger.set('265552060', { stillAt: Date.now(), lat: 58.26804, lon: 12.26709 });
    await app.onUninit();
    expect(stored.quay_stable_ledger['265552060']).toBeDefined();
    const persisted = JSON.parse(JSON.stringify(stored));
    settings.set.mockClear();

    await expect(app.onUninit()).resolves.toBeUndefined();

    expect(stored).toEqual(persisted);
    expect(settings.set).not.toHaveBeenCalled();
    expect(settings.listenerCount('set')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('läsfel före tjänstestart kan städas utan att skriva över befintliga inställningar', async () => {
    stored.quay_stable_ledger = { 265552060: { stillAt: Date.now(), lat: 58.26804, lon: 12.26709 } };
    const before = JSON.parse(JSON.stringify(stored));
    settings.get.mockImplementationOnce(() => {
      throw new Error('Inställningar tillfälligt otillgängliga');
    });
    await expect(app.onInit()).rejects.toThrow('Inställningar tillfälligt otillgängliga');
    const exceptionHandler = app._onUncaughtException;
    const rejectionHandler = app._onUnhandledRejection;

    await expect(app.onUninit()).resolves.toBeUndefined();

    expect(process.listeners('uncaughtException')).not.toContain(exceptionHandler);
    expect(process.listeners('unhandledRejection')).not.toContain(rejectionHandler);
    expect(settings.set).not.toHaveBeenCalled();
    expect(stored).toEqual(before);
    expect(app.error).not.toHaveBeenCalled();
    await app.onInit();
    expect(app._quayStableLedger.has('265552060')).toBe(true);
    await app.onUninit();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('avbruten återstart får inte flusha den förra körningens tömda eller gamla minne', async () => {
    await app.onInit();
    app._quayStableLedger.set('265552060', { stillAt: Date.now(), lat: 58.26804, lon: 12.26709 });
    app._persistentRecentTriggers.set('265552060:Klaffbron', { t: Date.now(), dir: 'north' });
    await app.onUninit();
    // En annan körning kan ha uppdaterat lagringen innan samma instans återanvänds.
    stored.persistent_recent_triggers['265000111:Klaffbron'] = { t: Date.now(), dir: 'south' };
    const persisted = JSON.parse(JSON.stringify(stored));
    settings.set.mockClear();
    settings.get.mockImplementationOnce(() => {
      throw new Error('Läsfel under återstart');
    });
    await expect(app.onInit()).rejects.toThrow('Läsfel under återstart');

    await app.onUninit();

    expect(settings.set).not.toHaveBeenCalled();
    expect(stored).toEqual(persisted);
    expect(settings.listenerCount('set')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(app.error).not.toHaveBeenCalled();
  });
});
