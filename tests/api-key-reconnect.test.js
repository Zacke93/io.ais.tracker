'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const AISStreamClient = require('../lib/connection/AISStreamClient');

/**
 * F8 (KRITISK): settings-listenern hanterade tidigare ENBART debug_level, så ett
 * byte av API-nyckeln triggade aldrig en återanslutning — datainflödet (text +
 * notiser) låg nere tills appen startades om manuellt.
 */
describe('F8: byte av ais_api_key återansluter AIS-strömmen', () => {
  let app;
  let store;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    store = {};
    app.homey = { settings: { get: (k) => store[k], on: jest.fn() } };
    app.aisClient = {
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
    app._setupSettingsListener();
  });

  test('ny giltig nyckel → reconnectWithKey med (trimmad) ny nyckel', () => {
    store.ais_api_key = '  NEW_KEY_123  ';
    app._onSettingsChanged('ais_api_key', store.ais_api_key);
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledWith('NEW_KEY_123');
  });

  test('tömd/blank nyckel → disconnect, ingen reconnect', () => {
    store.ais_api_key = '   ';
    app._onSettingsChanged('ais_api_key', store.ais_api_key);
    expect(app.aisClient.disconnect).toHaveBeenCalled();
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });

  test('andra settings-nycklar rör inte AIS-anslutningen', () => {
    store.debug_level = 'full';
    app._onSettingsChanged('debug_level', 'full');
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
    expect(app.aisClient.disconnect).not.toHaveBeenCalled();
  });
});

describe('F8: AISStreamClient.reconnectWithKey river ner gamla socketen säkert', () => {
  test('rensar timers, detachar gamla lyssnare och connectar med ny nyckel', () => {
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const client = new AISStreamClient(logger);
    client.connect = jest.fn().mockResolvedValue(undefined); // undvik riktig WebSocket
    const fakeWs = { removeAllListeners: jest.fn(), close: jest.fn() };
    client.ws = fakeWs;
    client.reconnectAttempts = 5;
    client.reconnectTimer = setTimeout(() => {}, 100000);

    client.reconnectWithKey('KEYX');

    expect(fakeWs.removeAllListeners).toHaveBeenCalled();
    expect(fakeWs.close).toHaveBeenCalled();
    expect(client.ws).toBeNull();
    expect(client.reconnectAttempts).toBe(0);
    expect(client.reconnectTimer).toBeNull();
    expect(client.connect).toHaveBeenCalledWith('KEYX');
  });
});
