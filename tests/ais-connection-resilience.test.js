'use strict';

const AISStreamClient = require('../lib/connection/AISStreamClient');
const { AIS_CONFIG, MAX_RECONNECT_ATTEMPTS } = require('../lib/constants');

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

/** Alla logger.log-rader som innehåller `needle`. */
const linesWith = (spy, needle) => spy.mock.calls
  .map((args) => args.map(String).join(' '))
  .filter((line) => line.includes(needle));

/** Minimal positionsrapport som tar sig hela vägen genom _extractAISData. */
const POSITION_REPORT = JSON.stringify({
  MessageType: 'PositionReport',
  MetaData: { MMSI: 123456789, Latitude: 58.29, Longitude: 12.29 },
  Message: {
    PositionReport: {
      MMSI: 123456789, Latitude: 58.29, Longitude: 12.29, Sog: 5, Cog: 25,
    },
  },
});

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
  test('disconnect() kopplar av socketen och schemalägger INTE reconnect', () => {
    // Race-fix 2026-06-13: disconnect() detachar numera lyssnarna FÖRE close
    // (samma mönster som reconnectWithKey) — gamla socketens close-event kan
    // aldrig nå _onClose, så ingen zombie-reconnect är möjlig den vägen.
    // Klienten emittar 'disconnected' själv (app-lagret behöver signalen).
    const client = new AISStreamClient(makeLogger());
    client._scheduleReconnect = jest.fn();
    const fakeWs = { close: jest.fn(), removeAllListeners: jest.fn(), on: jest.fn() };
    client.ws = fakeWs;
    const disconnectedEvents = [];
    client.on('disconnected', (e) => disconnectedEvents.push(e));

    client.disconnect();

    expect(fakeWs.removeAllListeners).toHaveBeenCalled(); // detach före close
    expect(fakeWs.close).toHaveBeenCalled();
    expect(client.ws).toBeNull();
    expect(client._scheduleReconnect).not.toHaveBeenCalled();
    expect(client._intentionalClose).toBe(false); // ingen kvardröjande avsiktsflagga
    expect(disconnectedEvents).toHaveLength(1); // app-lagret fick sin signal
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

/**
 * KX-2 (fältprovet 2026-08-09): aisstream avvisade handskakningen med HTTP 429
 * och appen svarade med snabbtrappan — återförsök efter 9,8 s / 10,3 s / 33,7 s
 * (loggrad 112/125/127/140/142/155). Statuskoden fanns bara som fritext i ett
 * felmeddelande som ingen kodväg tolkade: noll träffar på 429/Retry-After i
 * hela kodbasen. Nu läses HTTP-svaret och en 429 får en EGEN cooldown.
 */
describe('KX-2: 429 ger dedikerad rate-limit-cooldown i stället för snabbtrappan', () => {
  const MIN = 60 * 1000;

  function rejectHandshake(client, statusCode, headers = {}) {
    const socket = { terminate: jest.fn() };
    client.ws = socket;
    const res = { statusCode, headers, resume: jest.fn() };
    client._onUnexpectedResponse(socket, {}, res);
    return { socket, res };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0); // deterministiskt jitter
  });
  afterEach(() => {
    jest.useRealTimers();
    Math.random.mockRestore();
  });

  test('429 utan Retry-After ⇒ 15 min cooldown och snabbtrappan står stilla', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client.reconnectAttempts = 3;

    rejectHandshake(client, 429);
    client._onClose(1006, '');

    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS);
    // Kärnan i fyndet: en spärr får inte knuffa en frisk källa nedåt i faserna.
    expect(client.reconnectAttempts).toBe(3);
    const rows = linesWith(logger.log, 'Rate-limitad av servern');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('HTTP 429');
    expect(rows[0]).toContain('cooldown 15.0 min');
    // Fältets sub-11-sekundersrader får ALDRIG skrivas för en 429.
    expect(linesWith(logger.log, 'Reconnecting in')).toHaveLength(0);
    client._clearTimers();
  });

  test('jittret läggs ovanpå basen (0-5 min)', () => {
    Math.random.mockReturnValue(0.999);
    const client = new AISStreamClient(makeLogger());
    rejectHandshake(client, 429);
    client._onClose(1006, '');

    const delay = client._rateLimitedUntil - Date.now();
    expect(delay).toBeGreaterThan(AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS);
    expect(delay).toBeLessThanOrEqual(
      AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS + AIS_CONFIG.RATE_LIMIT_COOLDOWN_JITTER_MS,
    );
    client._clearTimers();
  });

  test('Retry-After i sekunder respekteras rakt av', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    rejectHandshake(client, 429, { 'retry-after': '300' });
    client._onClose(1006, '');

    expect(client._rateLimitedUntil - Date.now()).toBe(5 * MIN);
    expect(linesWith(logger.log, 'Rate-limitad')[0]).toContain('Retry-After 300 s');
    client._clearTimers();
  });

  test('Retry-After klampas: 5 s → 60 s golv, 2 h → 30 min tak', () => {
    const low = new AISStreamClient(makeLogger());
    rejectHandshake(low, 429, { 'retry-after': '5' });
    low._onClose(1006, '');
    expect(low._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_RETRY_AFTER_MIN_MS);
    low._clearTimers();

    const high = new AISStreamClient(makeLogger());
    rejectHandshake(high, 429, { 'retry-after': '7200' });
    high._onClose(1006, '');
    expect(high._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_RETRY_AFTER_MAX_MS);
    high._clearTimers();
  });

  test('Retry-After som HTTP-datum tolkas (RFC 9110:s andra form)', () => {
    const client = new AISStreamClient(makeLogger());
    const when = new Date(Date.now() + 10 * MIN).toUTCString();
    rejectHandshake(client, 429, { 'retry-after': when });
    client._onClose(1006, '');

    // UTC-strängen har sekundupplösning ⇒ tillåt en sekunds avrundning.
    const delay = client._rateLimitedUntil - Date.now();
    expect(Math.abs(delay - 10 * MIN)).toBeLessThanOrEqual(1000);
    client._clearTimers();
  });

  test('skräp i Retry-After faller tillbaka på basvärdet', () => {
    const client = new AISStreamClient(makeLogger());
    rejectHandshake(client, 429, { 'retry-after': 'snart' });
    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS);
    client._clearTimers();
  });

  test('503 UTAN Retry-After är ett vanligt serverfel — snabbtrappan oförändrad', () => {
    // RC-S1:s 503-storm 2026-06-11 måste bete sig EXAKT som förut.
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    rejectHandshake(client, 503);
    client._onClose(1006, '');

    expect(client._rateLimitedUntil).toBe(0);
    expect(client.reconnectAttempts).toBe(1);
    expect(linesWith(logger.log, 'Reconnecting in')).toHaveLength(1);
    client._clearTimers();
  });

  test('503 MED Retry-After ⇒ cooldown (servern säger själv när)', () => {
    const client = new AISStreamClient(makeLogger());
    rejectHandshake(client, 503, { 'retry-after': '600' });
    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now()).toBe(10 * MIN);
    client._clearTimers();
  });

  test('401 rör INTE rate-limit-vägen (auth-hanteringen oförändrad)', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    rejectHandshake(client, 401);
    client._onClose(1006, '');

    expect(client._rateLimitedUntil).toBe(0);
    expect(client.reconnectAttempts).toBe(1); // ordinarie trappa
    expect(linesWith(logger.log, 'Rate-limitad')).toHaveLength(0);
    // AISHubs V6-auth-cooldown är en HELT annan mekanism och ska stå orörd.
    expect(AIS_CONFIG.AISHUB.AUTH_COOLDOWN_MS).toBe(6 * 3600 * 1000);
    client._clearTimers();
  });

  test('connect() under cooldown öppnar ingen socket men håller kedjan vid liv', async () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client._rateLimitedUntil = Date.now() + 15 * MIN;

    await client.connect('KEY');

    expect(client.ws).toBeNull(); // ingen handskakning under pausen
    expect(client.reconnectTimer).not.toBeNull(); // ...men kedjan är bokad
    expect(linesWith(logger.log, 'Rate-limit-cooldown aktiv')).toHaveLength(1);

    // V2-C1-disciplinen i motsvarighet: ingen kodväg får lämna oss utan nästa försök.
    const resumed = jest.fn().mockResolvedValue(undefined);
    client.connect = resumed;
    jest.advanceTimersByTime(15 * MIN);
    expect(resumed).toHaveBeenCalledWith('KEY');
    client._clearTimers();
  });

  test('reconnectWithKey kringgår INTE en pågående cooldown', async () => {
    // Latenta snabbtrapp-återstarten: reconnectWithKey nollställer stegen
    // ("fresh intent"), och utan guarden i connect() hade ett nyckelbyte
    // eller ett watchdog-ingripande startat om 1s/2s/5s mitt i en spärr.
    // En 429 på handskakningen är dessutom IP-bunden — nyckeln hade inte
    // ens skickats än (den går i prenumerationsmeddelandet).
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client._rateLimitedUntil = Date.now() + 15 * MIN;

    await client.reconnectWithKey('NY_NYCKEL', 'key-update');

    expect(client.ws).toBeNull();
    expect(client.apiKey).toBe('NY_NYCKEL'); // nyckeln sparas ändå
    expect(linesWith(logger.log, 'Rate-limit-cooldown aktiv')).toHaveLength(1);
    expect(client.reconnectTimer).not.toBeNull(); // kedjan lever vidare
    client._clearTimers();
  });

  test('accepterad handskakning upphäver cooldownen (V6-paritet)', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client._rateLimitedUntil = Date.now() + 10 * MIN;
    client.ws = {};

    client._onOpen();

    expect(client._rateLimitedUntil).toBe(0);
    expect(linesWith(logger.log, 'Rate-limit-cooldown upphävd')).toHaveLength(1);
    client._clearTimers();
  });

  test('lyssnaren river handskakningen själv — annars uteblir error+close', () => {
    // ws kör sin inbyggda abortHandshake ENBART när ingen lyssnare finns
    // (`!websocket.emit('unexpected-response', ...)`). Utan egen terminate
    // ligger socketen kvar i CONNECTING till 60 s-deadlinen.
    const client = new AISStreamClient(makeLogger());
    const { socket, res } = rejectHandshake(client, 429);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(res.resume).toHaveBeenCalledTimes(1); // svarskroppen dränerad
    client._clearTimers();
  });

  test('backstop: statuskoden plockas ur ws-felsträngen om lyssnaren inte kört', () => {
    const client = new AISStreamClient(makeLogger());
    client.on('error', () => {}); // app-lagret lyssnar alltid; EventEmitter kastar annars
    client._onError(new Error('Unexpected server response: 429'));
    expect(client._lastHandshakeStatus).toBe(429);

    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS);
    client._clearTimers();
  });

  test('ett nytt anslutningsförsök ärver aldrig föregående utfall', async () => {
    // Utan nollställning skulle nästa handskakning ärva 429 och gå rakt in i
    // en cooldown den inte förtjänar (och "Server unreachable" hade fortsatt
    // gatas på ett gammalt utfall). Ett fejkat ws-bibliotek håller testet
    // helt utan nätverk.
    let created = null;
    jest.resetModules();
    jest.doMock('ws', () => {
      class FakeWebSocket {
        constructor() {
          this.readyState = 0;
          created = this;
        }

        on() {}

        terminate() {}
      }
      FakeWebSocket.OPEN = 1;
      return FakeWebSocket;
    });
    // eslint-disable-next-line global-require
    const IsolatedClient = require('../lib/connection/AISStreamClient');
    const client = new IsolatedClient(makeLogger());
    client._lastHandshakeStatus = 429;
    client._lastRetryAfterMs = 90000;
    client._socketOpened = true;
    client._messagesThisSocket = 7;

    await client.connect('KEY');

    expect(created).not.toBeNull(); // handskakningen påbörjades
    expect(client._lastHandshakeStatus).toBeNull();
    expect(client._lastRetryAfterMs).toBeNull();
    expect(client._socketOpened).toBe(false);
    expect(client._messagesThisSocket).toBe(0);

    client._clearTimers();
    jest.dontMock('ws');
    jest.resetModules();
  });
});

/**
 * KX-4 (fältprovet 2026-08-09): STABLE_CONNECTION_MS (120 s) ligger ÖVER
 * ping-vaktens dödsgräns (2 × 30 s = 60 s), så en källa som levererar data men
 * aldrig pongar kan per konstruktion aldrig bli "stabil". Fältet: fyra av fyra
 * pingade sockets dog på 60,0 s och räknaren gick 1→15 utan en enda
 * nollställning. Nu finns en andra väg som kräver LEVERANS.
 */
describe('KX-4: en levererande anslutning nollställer räknaren före 60 s', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const fakeSocket = () => ({ readyState: 1, ping: jest.fn(), terminate: jest.fn() });

  test('data + 55 s uppe ⇒ räknaren nollställs (före ping-vaktens 60 s)', () => {
    const client = new AISStreamClient(makeLogger());
    client.reconnectAttempts = 7;
    client.ws = fakeSocket();

    client._onOpen();
    jest.advanceTimersByTime(3000);
    client._onMessage(POSITION_REPORT); // leveransbevis
    jest.advanceTimersByTime(52 * 1000); // t = 55 s

    expect(client.reconnectAttempts).toBe(0);
    client._clearTimers();
  });

  test('tyst socket vid 55 s behåller räknaren (RC-S1:s flappband skyddat)', () => {
    const client = new AISStreamClient(makeLogger());
    client.reconnectAttempts = 7;
    client.ws = fakeSocket();

    client._onOpen();
    jest.advanceTimersByTime(59 * 1000); // ingen data alls

    expect(client.reconnectAttempts).toBe(7);
    // ...och den gamla 120-sekundersvägen står kvar oförändrad.
    jest.advanceTimersByTime(62 * 1000);
    expect(client.reconnectAttempts).toBe(0);
    client._clearTimers();
  });

  test('10 cykler leverans-utan-pong håller källan kvar i SNABBFASEN', () => {
    const client = new AISStreamClient(makeLogger());
    client.apiKey = 'KEY';
    client.connect = jest.fn().mockResolvedValue(undefined); // ingen riktig socket

    for (let i = 0; i < 10; i++) {
      client.ws = fakeSocket();
      client._onOpen();
      client._onMessage(POSITION_REPORT);
      jest.advanceTimersByTime(55 * 1000); // levererande ⇒ reset
      jest.advanceTimersByTime(5 * 1000); // ping-vakten dödar vid 60 s
      client._onClose(1006, '');
      jest.advanceTimersByTime(10 * 1000); // låt reconnect-timern fyra
    }

    expect(client.reconnectAttempts).toBeLessThan(MAX_RECONNECT_ATTEMPTS);
    client._clearTimers();
  });

  test('samma 10 cykler UTAN data eskalerar som förut (fyndets fältfall)', () => {
    const client = new AISStreamClient(makeLogger());
    client.apiKey = 'KEY';
    client.connect = jest.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 10; i++) {
      client.ws = fakeSocket();
      client._onOpen();
      jest.advanceTimersByTime(60 * 1000);
      client._onClose(1006, '');
      jest.advanceTimersByTime(40 * 1000);
    }

    expect(client.reconnectAttempts).toBeGreaterThanOrEqual(MAX_RECONNECT_ATTEMPTS);
    client._clearTimers();
  });
});

/**
 * KX-7 (fältprovet 2026-08-09): "Server unreachable after 10 fast attempts"
 * skrevs fyra gånger på anslutningar som FAKTISKT öppnade och prenumererade
 * (rad 807-811, 2156-2519, 4021-4164) och en gång 3 ms efter ett HTTP 429 —
 * en statuskod BEVISAR att servern var nåbar.
 */
describe('KX-7: fasövergångens loggtext beskriver det faktiska utfallet', () => {
  function atFastPhaseEnd() {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client.reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
    return { logger, client };
  }

  test('aldrig öppnad socket ⇒ historiska texten står kvar ordagrant', () => {
    const { logger, client } = atFastPhaseEnd();
    client._scheduleReconnect();
    expect(linesWith(logger.log, 'Server unreachable after 10 fast attempts')).toHaveLength(1);
    client._clearTimers();
  });

  test('öppnade men tyst ⇒ ingen "unreachable", utfallet namnges', () => {
    const { logger, client } = atFastPhaseEnd();
    client._socketOpened = true;
    client._scheduleReconnect();

    expect(linesWith(logger.log, 'unreachable')).toHaveLength(0);
    const row = linesWith(logger.log, 'Snabbfasen uttömd')[0];
    expect(row).toContain('öppnade men levererade ingenting');
    client._clearTimers();
  });

  test('öppnade och levererade ⇒ leveransen räknas i texten', () => {
    const { logger, client } = atFastPhaseEnd();
    client._socketOpened = true;
    client._messagesThisSocket = 42;
    client._scheduleReconnect();

    expect(linesWith(logger.log, 'Snabbfasen uttömd')[0]).toContain('levererade 42 meddelanden');
    client._clearTimers();
  });

  test('avvisad med HTTP-status ⇒ statuskoden står i raden, aldrig "unreachable"', () => {
    const { logger, client } = atFastPhaseEnd();
    client._lastHandshakeStatus = 403; // 429 tar cooldown-grenen, 403 fasgrenen
    client._scheduleReconnect();

    expect(linesWith(logger.log, 'unreachable')).toHaveLength(0);
    expect(linesWith(logger.log, 'Snabbfasen uttömd')[0]).toContain('avvisad med HTTP 403');
    client._clearTimers();
  });

  test('timfasen får samma behandling', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client.reconnectAttempts = 22;
    client._socketOpened = true;
    client._scheduleReconnect();

    expect(linesWith(logger.log, 'Still unreachable')).toHaveLength(0);
    expect(linesWith(logger.log, 'Mediumfasen uttömd')).toHaveLength(1);
    client._clearTimers();
  });

  test('timfasen behåller historiska texten när servern verkligen var onåbar', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client.reconnectAttempts = 22;
    client._scheduleReconnect();

    expect(linesWith(logger.log, 'Still unreachable — switching to hourly reconnect')).toHaveLength(1);
    client._clearTimers();
  });
});

/**
 * KX-8 (fältprovet 2026-08-09): 0,53-sekundersanslutningen 09:33:55 gick inte
 * att förklara — samtliga 16 stängningar loggades "1006 - " med tom reason,
 * utan livslängd, utan leveransräkning och utan felkod.
 */
describe('KX-8: close- och felrader bär det som gör felklassen avgörbar', () => {
  test('close-raden bär livslängd, meddelanderäkning och HTTP-status', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client._scheduleReconnect = jest.fn();
    client.openedAt = Date.now() - 532;
    client._messagesThisSocket = 0;
    client._lastHandshakeStatus = 429;

    client._onClose(1006, '');

    const row = linesWith(logger.log, 'Connection closed:')[0];
    expect(row).toContain('(tom reason)');
    expect(row).toContain('0 meddelanden');
    expect(row).toContain('HTTP 429');
    expect(row).toMatch(/öppen 0\.5\d s/);
  });

  test('close utan föregående open säger "öppnade aldrig"', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client._scheduleReconnect = jest.fn();

    client._onClose(1006, '');

    expect(linesWith(logger.log, 'Connection closed:')[0]).toContain('öppnade aldrig');
  });

  test('felraden bär err.code (ECONNRESET vs EPROTO vs ETIMEDOUT)', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client.on('error', () => {});
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

    client._onError(err);

    expect(linesWith(logger.error, 'WebSocket error')[0]).toContain('[ECONNRESET]');
  });

  test('felraden kraschar inte på ett fel utan message', () => {
    const client = new AISStreamClient(makeLogger());
    client.on('error', () => {});
    expect(() => client._onError(undefined)).not.toThrow();
  });
});
