'use strict';

/**
 * Helgranskningen 2026-11-03 (F2-4): ett aktivt källbyte ska häva aisstreams
 * 429-paus. Muxen nollade pausflaggan och loggade "upphävd av
 * användaringrepp", men den återanslutningstimer som pausen bokat stod kvar
 * — nästa handskakning kom först när den gamla timern löpte ut (15–20 min,
 * upp till en timme). Nu handskakar muxen direkt när pausen faktiskt hävdes
 * och ingen socket finns. Automatvägarna respekterar fortfarande pausen.
 */
jest.mock('ws', () => {
  const EventEmitter = require('events');
  class FakeWS extends EventEmitter {
    constructor() {
      super();
      FakeWS.instances.push(this);
      this.readyState = 0;
    }

    send() {}

    ping() {}

    close() {
      this.readyState = 3;
    }

    terminate() {
      this.readyState = 3;
    }
  }
  FakeWS.CONNECTING = 0;
  FakeWS.OPEN = 1;
  FakeWS.CLOSING = 2;
  FakeWS.CLOSED = 3;
  FakeWS.instances = [];
  return FakeWS;
});

const FakeWS = require('ws');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const AISHubClient = require('../lib/connection/AISHubClient');

const KEY = 'k'.repeat(40);
const MIN = 60 * 1000;

describe('Muxen: källbyte under aisstreams 429-paus', () => {
  let mux;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-03T10:00:00Z') });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    jest.spyOn(AISHubClient.prototype, '_httpGet').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify([{ ERROR: false, FORMAT: 'HUMAN', RECORDS: 0 }, []]),
    });
    FakeWS.instances.length = 0;
    const store = {};
    mux = new AISSourceMultiplexer(
      { log: jest.fn(), debug: jest.fn(), error: jest.fn() },
      {
        get: (k) => store[k] ?? null,
        set: (k, v) => {
          store[k] = v;
        },
      },
    );
    mux.on('error', () => {});
  });

  afterEach(() => {
    mux.disconnect();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function rateLimited() {
    mux.applySourceConfig({ source: 'aisstream', apiKey: KEY, aishubUsername: '' });
    await jest.advanceTimersByTimeAsync(10);
    expect(FakeWS.instances).toHaveLength(1);
    const stream = mux._streamClient;
    stream._lastHandshakeStatus = 429;
    stream.ws.emit('close', 1006, Buffer.from(''));
    expect(stream._rateLimitedUntil - Date.now()).toBeGreaterThan(10 * MIN);
    return stream;
  }

  test('användarens källbyte ger en ny handskakning direkt', async () => {
    await rateLimited();
    await jest.advanceTimersByTimeAsync(MIN);
    mux.applySourceConfig({ source: 'both', apiKey: KEY, aishubUsername: 'tester' });
    await jest.advanceTimersByTimeAsync(100);
    expect(FakeWS.instances).toHaveLength(2);
  });

  test('utan användaringrepp respekteras pausen', async () => {
    await rateLimited();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
