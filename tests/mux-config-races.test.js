'use strict';

const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('Muxens källomställning: en gammal await får inte ändra ett nyare beslut', () => {
  let mux;

  beforeEach(() => {
    jest.useFakeTimers();
    mux = new AISSourceMultiplexer(
      { log: jest.fn(), debug: jest.fn(), error: jest.fn() },
      { get: () => null, set: jest.fn() },
    );
    mux._streamClient.disconnect = jest.fn();
  });

  afterEach(() => {
    mux.disconnect();
    jest.useRealTimers();
  });

  test('both→aisstream under anslutning får aldrig återstarta den bortvalda hubben', async () => {
    const connecting = deferred();
    mux._streamClient.connect = jest.fn(() => connecting.promise);
    mux.applySourceConfig({ source: 'both', apiKey: 'key', aishubUsername: 'hub-user' });
    mux.applySourceConfig({ source: 'aisstream', apiKey: 'key', aishubUsername: 'hub-user' });

    connecting.resolve();
    await flushMicrotasks();
    expect(mux._hubClient).toBeNull();
    expect(mux.getConnectionStats().perFeed.aishub.configured).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('disconnect och nytt connect under väntan behåller den nya hubbens pollkedja', async () => {
    const connecting = deferred();
    mux._streamClient.connect = jest.fn(() => connecting.promise);
    mux.applySourceConfig({ source: 'aisstream', apiKey: 'key', aishubUsername: 'hub-user' });
    mux.disconnect();
    mux.applySourceConfig({ source: 'aishub', apiKey: 'key', aishubUsername: 'hub-user' });
    await flushMicrotasks();
    const newHub = mux._hubClient;
    expect(newHub).not.toBeNull();

    connecting.resolve();
    await flushMicrotasks();
    expect(mux._hubClient).toBe(newHub);
    expect(newHub._stopped).toBe(false);
    expect(mux._hubHealthTimer).not.toBeNull();
  });

  test('ett ersatt nyckelbyte får inte lämna hubben med föregående användarnamn', async () => {
    mux._streamClient.connect = jest.fn().mockResolvedValue(undefined);
    mux.applySourceConfig({ source: 'both', apiKey: 'key', aishubUsername: 'old-user' });
    await flushMicrotasks();
    const oldHub = mux._hubClient;
    expect(oldHub.username).toBe('old-user');

    const reconnecting = deferred();
    mux._streamClient.reconnectWithKey = jest.fn(() => reconnecting.promise);
    mux.applySourceConfig({ source: 'both', apiKey: 'new-key', aishubUsername: 'new-user' });
    mux.applySourceConfig({ source: 'shadow', apiKey: 'new-key', aishubUsername: 'new-user' });
    await flushMicrotasks();
    expect(mux._hubClient.username).toBe('new-user');
    expect(oldHub._stopped).toBe(true);
    const newHub = mux._hubClient;

    reconnecting.resolve();
    await flushMicrotasks();
    expect(mux._hubClient).toBe(newHub);
    expect(newHub._stopped).toBe(false);
  });
});
