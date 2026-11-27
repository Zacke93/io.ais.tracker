'use strict';

jest.mock('homey');
const { EventEmitter } = require('events');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

/**
 * Omgång 9, spår R (livscykel): samma app-instans får onInit igen utan onUninit
 * emellan. U58 kräver redan att det inte ger dubbla processlyssnare
 * (log-channel-u58.test.js). Före rättningen levde resten av den första
 * starten kvar: minutloopens setInterval skrevs över utan clearInterval,
 * tjänsternas egna städintervall och inställningslyssnaren fanns kvar, och
 * efter onUninit fortsatte den läckta minutloopen att ta bort båtar ur den nya
 * tjänsten. Testet kör onInit i produktionsläge (tjänsternas timers skapas bara
 * utanför testläge).
 */
describe('En andra onInit utan onUninit', () => {
  let app;
  let settings;
  let stored;
  let savedMode;
  let savedEnv;

  async function init() {
    global.__TEST_MODE__ = undefined;
    process.env.NODE_ENV = 'production';
    try {
      await app.onInit();
    } finally {
      global.__TEST_MODE__ = savedMode;
      process.env.NODE_ENV = savedEnv;
    }
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-26T10:00:00Z') });
    savedMode = global.__TEST_MODE__;
    savedEnv = process.env.NODE_ENV;
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
    if (app._onUncaughtException) process.removeListener('uncaughtException', app._onUncaughtException);
    if (app._onUnhandledRejection) process.removeListener('unhandledRejection', app._onUnhandledRejection);
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedMode;
    process.env.NODE_ENV = savedEnv;
  });

  test('onUninit efter två onInit lämnar inga timers och ingen inställningslyssnare', async () => {
    await init();
    const timersAfterFirst = jest.getTimerCount();
    expect(timersAfterFirst).toBeGreaterThan(0);
    await init();
    expect(jest.getTimerCount()).toBe(timersAfterFirst);
    expect(settings.listenerCount('set')).toBe(1);
    await app.onUninit();
    expect(jest.getTimerCount()).toBe(0);
    expect(settings.listenerCount('set')).toBe(0);
  });

  test('efter två onInit körs minutstädningen en gång per minut', async () => {
    await init();
    await init();
    const prune = jest.spyOn(app, '_pruneDedupCaches');
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  test('den första körningens notisspärr sparas och följer med in i den andra', async () => {
    await init();
    app._persistentRecentTriggers.set('265099301:Klaffbron', { t: Date.now(), dir: 'north' });
    await init();
    expect(stored.persistent_recent_triggers['265099301:Klaffbron']).toBeDefined();
    expect(app._persistentRecentTriggers.has('265099301:Klaffbron')).toBe(true);
  });

  test('motfall: onInit efter onUninit fungerar som förut', async () => {
    await init();
    await app.onUninit();
    expect(jest.getTimerCount()).toBe(0);
    await init();
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    expect(settings.listenerCount('set')).toBe(1);
    await app.onUninit();
    expect(jest.getTimerCount()).toBe(0);
  });
});
