'use strict';

const AISStreamClient = require('../lib/connection/AISStreamClient');

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

/**
 * F1: half-open WebSocket (server slutar svara, inget close-event) upptäcktes
 * aldrig — _onPong var no-op och ping saknade pong-timeout. Nu terminerar en
 * watchdog anslutningen om pong uteblir, vilket triggar reconnect-kedjan.
 */
describe('F1: pong-watchdog upptäcker half-open WebSocket', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('terminate() körs om pong uteblir mellan två ping-cykler', () => {
    const client = new AISStreamClient(makeLogger());
    const fakeWs = { readyState: 1, ping: jest.fn(), terminate: jest.fn() };
    client.ws = fakeWs;

    client._startPing();

    jest.advanceTimersByTime(30000); // cykel 1: ping skickas
    expect(fakeWs.ping).toHaveBeenCalledTimes(1);
    expect(fakeWs.terminate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30000); // cykel 2: ingen pong → terminate
    expect(fakeWs.terminate).toHaveBeenCalledTimes(1);

    client._stopPing();
  });

  test('pong i tid förhindrar terminate', () => {
    const client = new AISStreamClient(makeLogger());
    const fakeWs = { readyState: 1, ping: jest.fn(), terminate: jest.fn() };
    client.ws = fakeWs;

    client._startPing();
    jest.advanceTimersByTime(30000); // ping 1
    client._onPong(); // pong anländer i tid
    jest.advanceTimersByTime(30000); // ping 2

    expect(fakeWs.terminate).not.toHaveBeenCalled();
    expect(fakeWs.ping).toHaveBeenCalledTimes(2);

    client._stopPing();
  });
});

/**
 * F3: avsiktlig disconnect() gav close-kod 1005/1006 (aldrig 1000), så den gamla
 * `code !== 1000`-checken schemalade en zombie-reconnect som öppnade en ny socket
 * efter shutdown. Nu gateas reconnect på en explicit avsikts-flagga.
 */
describe('F3: avsiktlig disconnect schemalägger ingen reconnect', () => {
  test('disconnect() → _onClose schemalägger INTE reconnect', () => {
    const client = new AISStreamClient(makeLogger());
    client._scheduleReconnect = jest.fn();
    client.ws = { close: jest.fn() };

    client.disconnect();
    expect(client._intentionalClose).toBe(true);

    client._onClose(1006, 'closed by us'); // close-eventet fyrar efteråt
    expect(client._scheduleReconnect).not.toHaveBeenCalled();
    expect(client._intentionalClose).toBe(false);
  });

  test('oväntad close (1006) schemalägger reconnect', () => {
    const client = new AISStreamClient(makeLogger());
    client._scheduleReconnect = jest.fn();

    client._onClose(1006, 'network drop');
    expect(client._scheduleReconnect).toHaveBeenCalledTimes(1);
  });
});

/**
 * F55: serverfel (t.ex. ogiltig API-nyckel) filtrerades bort tyst av
 * message-type-filtret → en dålig nyckel såg ut som "ingen trafik".
 */
describe('F55: serverfel synliggörs', () => {
  test('error-meddelande emittar auth-error och loggar', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    const handler = jest.fn();
    client.on('auth-error', handler);

    client._onMessage(JSON.stringify({ error: 'Invalid API key' }));

    expect(handler).toHaveBeenCalledWith('Invalid API key');
    expect(logger.error).toHaveBeenCalled();
  });

  test('vanlig positionsrapport emittar INTE auth-error', () => {
    const client = new AISStreamClient(makeLogger());
    const authHandler = jest.fn();
    const msgHandler = jest.fn();
    client.on('auth-error', authHandler);
    client.on('ais-message', msgHandler);

    const positionReport = {
      MessageType: 'PositionReport',
      MetaData: { MMSI: 123456789, Latitude: 58.29, Longitude: 12.29 },
      Message: {
        PositionReport: {
          MMSI: 123456789, Latitude: 58.29, Longitude: 12.29, Sog: 5, Cog: 25,
        },
      },
    };
    client._onMessage(JSON.stringify(positionReport));

    expect(authHandler).not.toHaveBeenCalled();
    expect(msgHandler).toHaveBeenCalledTimes(1);
  });
});
