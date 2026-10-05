'use strict';

jest.mock('homey');

const { EventEmitter } = require('events');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const AISHubClient = require('../lib/connection/AISHubClient');

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('Inställningar under appstart får inte starta AIS före eventmottagarna', () => {
  let app;
  let settings;
  let stored;
  let request;
  let savedNodeEnv;
  let savedTestMode;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    savedNodeEnv = process.env.NODE_ENV;
    savedTestMode = global.__TEST_MODE__;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = false;
    stored = { ais_source: 'aishub', aishub_username: 'old-user', debug_level: 'off' };
    settings = new EventEmitter();
    settings.get = jest.fn((key) => stored[key] ?? null);
    settings.set = jest.fn((key, value) => {
      stored[key] = value;
      settings.emit('set', key);
    });
    app = new AISBridgeApp();
    app.homey = { ...mockHomey, settings, flow: { ...mockHomey.flow } };
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    request = jest.spyOn(AISHubClient.prototype, '_httpGet').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify([{ ERROR: false, FORMAT: 'HUMAN', RECORDS: 0 }, []]),
    });
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    global.__TEST_MODE__ = savedTestMode;
  });

  const pendingToken = () => {
    let resolve;
    app.homey.flow.createToken = jest.fn(() => new Promise((done) => {
      resolve = done;
    }));
    return () => resolve({ setValue: jest.fn().mockResolvedValue(undefined) });
  };

  test.each([
    ['aishub_username', 'new-user'],
    ['ais_source', 'aishub'],
    ['ais_api_key', 'new-key'],
  ])('%s sparas under tokeninit: senaste värdet används och första källsvaret når appen', async (key, value) => {
    if (key === 'ais_source') stored.ais_source = 'aisstream';
    const finishToken = pendingToken();
    const initializing = app.onInit();
    await flush();
    expect(app.homey.flow.createToken).toHaveBeenCalledTimes(1);

    settings.set(key, value);
    await jest.advanceTimersByTimeAsync(1);
    expect(request).not.toHaveBeenCalled();
    expect(app.aisClient.getConnectionStats().perFeed.aishub.configured).toBe(false);

    finishToken();
    await initializing;
    await jest.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(app.aisClient._hubClient.username).toBe(stored.aishub_username);
    expect(app.aisClient._config.apiKey).toBe(stored.ais_api_key || null);
    expect(app.connectionStatusValue()).toBe('connected');

    // Friska tomma svep ger ingen ny connected-flank. Statusen måste redan
    // ha blivit rätt på första svaret och förbli rätt utan fartygsdata.
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(request).toHaveBeenCalledTimes(5);
    expect(app.connectionStatusValue()).toBe('connected');

    // Efter färdig init ska samma listener omedelbart ställa om källan.
    const oldHub = app.aisClient._hubClient;
    settings.set('aishub_username', 'latest-user');
    await flush();
    expect(oldHub._stopped).toBe(true);
    expect(app.aisClient._hubClient.username).toBe('latest-user');
  });

  test('ändring efter ett tidigt initfel startar inte en källa utan mottagare', async () => {
    // Jest/source-map behöver vanlig slump när det förväntade felet formateras.
    Math.random.mockRestore();
    const initializeServices = app._initializeServices.bind(app);
    jest.spyOn(app, '_initializeServices').mockImplementationOnce(async () => {
      await initializeServices();
      throw new Error('Init avbruten före eventkoppling');
    });
    await expect(app.onInit()).rejects.toThrow('Init avbruten');
    settings.set('aishub_username', 'new-user');
    await jest.advanceTimersByTimeAsync(1);
    expect(request).not.toHaveBeenCalled();
    await app.onUninit();
    expect(jest.getTimerCount()).toBe(0);
    expect(settings.listenerCount('set')).toBe(0);
  });

  test('avbruten väntan återupplivar ingen gammal källa; nästa start läser sparade värden', async () => {
    const finishToken = pendingToken();
    const initializing = app.onInit();
    await flush();
    settings.set('aishub_username', 'new-user');
    await jest.advanceTimersByTimeAsync(1);
    expect(request).not.toHaveBeenCalled();
    await app.onUninit();
    finishToken();
    await initializing;
    expect(jest.getTimerCount()).toBe(0);

    app.homey.flow.createToken = jest.fn().mockResolvedValue({ setValue: jest.fn().mockResolvedValue(undefined) });
    await app.onInit();
    await jest.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(app.aisClient._hubClient.username).toBe('new-user');
    expect(app.connectionStatusValue()).toBe('connected');
    expect(settings.listenerCount('set')).toBe(1);
  });
});
