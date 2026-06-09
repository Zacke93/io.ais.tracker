'use strict';

jest.mock('homey');

const WebSocket = require('ws');
const AISBridgeApp = require('../app');
const AISStreamClient = require('../lib/connection/AISStreamClient');

/**
 * B1 (2026-06-09): misslyckad subscription-send lämnade en "uppkopplad men
 * döv" socket — connected var redan emittat, ingen retry, ingen reconnect.
 * Nu termineras socketen → 'close' → ordinarie reconnect-väg.
 *
 * B2: stale-feed-watchdog i monitoring-loopen — fångar tyst datadöd som
 * ping/pong inte ser (tappad subscription, server slutat skicka).
 *
 * B3: timeline-notis vid nyckel-/anslutningsproblem (deduped 1/24h).
 */
describe('B1: misslyckad subscription terminerar socketen', () => {
  function makeClient() {
    return new AISStreamClient({ log: jest.fn(), error: jest.fn(), debug: jest.fn() });
  }

  test('ws.send kastar → ws.terminate anropas (triggar reconnect-vägen)', () => {
    const client = makeClient();
    client.apiKey = 'test-key';
    client.ws = {
      readyState: WebSocket.OPEN,
      send: jest.fn(() => {
        throw new Error('buffer full');
      }),
      terminate: jest.fn(),
    };

    client._subscribe();

    expect(client.ws.terminate).toHaveBeenCalled();
  });

  test('lyckad send → ingen terminate', () => {
    const client = makeClient();
    client.apiKey = 'test-key';
    client.ws = {
      readyState: WebSocket.OPEN,
      send: jest.fn(),
      terminate: jest.fn(),
    };

    client._subscribe();

    expect(client.ws.send).toHaveBeenCalled();
    expect(client.ws.terminate).not.toHaveBeenCalled();
  });
});

describe('B2: stale-feed-watchdog (_checkAISFeedHealth)', () => {
  function makeApp({
    timeSinceLastMessage, uptime, isConnected = true, apiKey = 'KEY',
  }) {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = { settings: { get: () => apiKey, on: jest.fn() } };
    app.aisClient = {
      isConnected,
      getConnectionStats: jest.fn().mockReturnValue({ timeSinceLastMessage, uptime }),
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
    };
    return app;
  }

  const MIN = 60 * 1000;

  test('tyst >20 min på etablerad anslutning → tvingad omanslutning', () => {
    const app = makeApp({ timeSinceLastMessage: 25 * MIN, uptime: 60 * MIN });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledWith('KEY');
  });

  test('aldrig fått meddelande (null) men uppe >20 min → omanslutning', () => {
    const app = makeApp({ timeSinceLastMessage: null, uptime: 25 * MIN });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledWith('KEY');
  });

  test('nyligen omansluten (kort uptime) → fullt nytt fönster, ingen ny omanslutning', () => {
    // lastMessageTime kan vara gammal från FÖRRA anslutningen — uptime skyddar
    const app = makeApp({ timeSinceLastMessage: 45 * MIN, uptime: 5 * MIN });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });

  test('meddelanden flödar → ingen åtgärd', () => {
    const app = makeApp({ timeSinceLastMessage: 2 * MIN, uptime: 60 * MIN });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });

  test('frånkopplad → ingen åtgärd (reconnect sköts av ordinarie väg)', () => {
    const app = makeApp({ timeSinceLastMessage: 60 * MIN, uptime: 60 * MIN, isConnected: false });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });

  test('ingen API-nyckel → ingen åtgärd, ingen krasch', () => {
    const app = makeApp({ timeSinceLastMessage: 60 * MIN, uptime: 60 * MIN, apiKey: '' });
    expect(() => app._checkAISFeedHealth()).not.toThrow();
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });
});

describe('B3: användarsignal vid nyckel-/anslutningsproblem', () => {
  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._updateDeviceCapability = jest.fn();
    app.homey = {
      settings: { get: jest.fn(), on: jest.fn() },
      notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
    };
    return app;
  }

  test('timeline-notis skickas och dedupas till 1 per 24h', async () => {
    const app = makeApp();
    await app._notifyConnectionIssue('första felet');
    await app._notifyConnectionIssue('andra felet inom 24h');
    expect(app.homey.notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(app.homey.notifications.createNotification).toHaveBeenCalledWith({ excerpt: 'första felet' });
  });

  test('auth-error → timeline-notis', () => {
    const app = makeApp();
    app._notifyConnectionIssue = jest.fn().mockResolvedValue(undefined);
    app._onAISAuthError('invalid api key');
    expect(app._notifyConnectionIssue).toHaveBeenCalled();
  });

  test('max-reconnects → timeline-notis', () => {
    const app = makeApp();
    app._notifyConnectionIssue = jest.fn().mockResolvedValue(undefined);
    app._onAISMaxReconnects();
    expect(app._notifyConnectionIssue).toHaveBeenCalled();
  });

  test('reconnect-needed utan nyckel → notis + connection_status disconnected', () => {
    const app = makeApp();
    app._notifyConnectionIssue = jest.fn().mockResolvedValue(undefined);
    app.aisClient = { connect: jest.fn() };
    app.homey.settings.get = jest.fn().mockReturnValue(undefined); // ingen nyckel

    app._onAISReconnectNeeded();

    expect(app.aisClient.connect).not.toHaveBeenCalled();
    expect(app._notifyConnectionIssue).toHaveBeenCalled();
    expect(app._updateDeviceCapability).toHaveBeenCalledWith('connection_status', 'disconnected');
  });

  test('defensiv: saknat notifications-API kraschar inte', async () => {
    const app = makeApp();
    delete app.homey.notifications;
    await expect(app._notifyConnectionIssue('x')).resolves.toBeUndefined();
  });
});
