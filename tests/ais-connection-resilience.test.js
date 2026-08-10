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

/** Fejkad OPEN-socket för ping-vaktens tester. */
const pingableSocket = () => ({ readyState: 1, ping: jest.fn(), terminate: jest.fn() });

/**
 * Avvisa handskakningen på klientens AKTUELLA socket (generationsvakten F2-5
 * kräver att `socket === client.ws`). Modulnivå så alla F2-sviter kan dela den.
 */
function rejectHandshakeNow(client, statusCode, headers = {}) {
  const socket = { terminate: jest.fn() };
  client.ws = socket;
  const res = { statusCode, headers, resume: jest.fn() };
  client._onUnexpectedResponse(socket, {}, res);
  return { socket, res };
}

/**
 * Kör `fn(ClientKlass, skapadeSockets)` med ws-modulen utbytt mot en fejk som
 * ALDRIG rör nätverket — för de vägar där connect() faktiskt ska öppna en
 * socket. Samma mönster som "ett nytt anslutningsförsök ärver aldrig
 * föregående utfall" nedan, men återanvändbart. (connect() är `async` utan
 * enda `await` ⇒ hela kroppen körs synkront, så städningen är säker här.)
 */
function withFakeWs(fn) {
  const created = [];
  jest.resetModules();
  jest.doMock('ws', () => {
    // Funktionskonstruktor (inte class) med flit: filen har redan en
    // FakeWebSocket-klass i KX-2-sviten, och eslint tillåter max en klass
    // per fil. Beteendet är identiskt för `new WebSocket(url, opts)`.
    const FakeWebSocket = function FakeWebSocket() {
      this.readyState = 0;
      created.push(this);
    };
    FakeWebSocket.prototype.on = () => {};
    FakeWebSocket.prototype.terminate = () => {};
    FakeWebSocket.prototype.close = () => {};
    FakeWebSocket.prototype.removeAllListeners = () => {};
    FakeWebSocket.OPEN = 1;
    return FakeWebSocket;
  });
  try {
    // eslint-disable-next-line global-require
    const IsolatedClient = require('../lib/connection/AISStreamClient');
    return fn(IsolatedClient, created);
  } finally {
    jest.dontMock('ws');
    jest.resetModules();
  }
}

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

  test('watchdog-ingripande kringgår INTE en pågående cooldown', async () => {
    // Latenta snabbtrapp-återstarten: reconnectWithKey nollställer stegen
    // ("fresh intent"), och utan guarden i connect() hade ett nyckelbyte
    // eller ett watchdog-ingripande startat om 1s/2s/5s mitt i en spärr.
    // En 429 på handskakningen är dessutom IP-bunden — nyckeln hade inte
    // ens skickats än (den går i prenumerationsmeddelandet).
    //
    // F2-4 (2026-08-10): kontraktet DELADES. Watchdogen är appens egen
    // maskinella takt — precis det cooldownen finns till för att strypa — och
    // behåller därför pausen oförändrat. Ett ANVÄNDARINITIERAT nyckelbyte
    // (reason='key-update') bryter den däremot; se F2-4-sviten nedan.
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client._rateLimitedUntil = Date.now() + 15 * MIN;

    await client.reconnectWithKey('NY_NYCKEL', 'watchdog');

    expect(client.ws).toBeNull();
    expect(client.apiKey).toBe('NY_NYCKEL'); // nyckeln sparas ändå
    expect(linesWith(logger.log, 'Rate-limit-cooldown aktiv')).toHaveLength(1);
    expect(client.reconnectTimer).not.toBeNull(); // kedjan lever vidare
    expect(client._rateLimitedUntil).toBeGreaterThan(Date.now()); // pausen står kvar
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

// ===========================================================================
// F2 — ADVERSARIELL EFTERGRANSKNING AV KX-VÅGEN (2026-08-10)
// Fynden nedan är EFTERSPELET till KX-2/KX-4/KX-7/KX-8: de nya vägarna löste
// sina egna fall men öppnade nya. Varje svit namnger fyndets felscenario.
// ===========================================================================

/**
 * F2-1 (KX-4 × ping-vakten): en socket som LEVERERAR men aldrig pongar dödades
 * av appen själv var 60:e sekund (2 × 30 s-tick), medan KX-4:s leveransreset
 * nollställde backoff-räknaren vid 55 s. Cykeln blev ~63 s och självförnyande:
 * ≈1 370 handskakningar/dygn mot stream.aisstream.io — exakt den takt som ger
 * HTTP 429 och därmed 15-20 minuters SJÄLVFÖRVÅLLAD blindhet i sololäge.
 * Rotorsaksfixen: AIS-meddelanden avväpnar pong-vakten.
 */
describe('F2-1: leveransbevis avväpnar ping-vakten (1 370-handskakningsloopen)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('pong-tyst men LEVERERANDE socket termineras aldrig (10 min, 20 cykler)', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    const ws = pingableSocket();
    client.ws = ws;
    client._startPing();

    // Fältets proxy/LB-fall: pong-frames sväljs, AIS-data vidarebefordras.
    for (let i = 0; i < 20; i++) {
      client._onMessage(POSITION_REPORT);
      jest.advanceTimersByTime(30000);
    }

    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.ping).toHaveBeenCalledTimes(20); // vakten är fortfarande AKTIV
    // Diagnosen skrivs EN gång per socket — inte var 30:e sekund.
    expect(linesWith(logger.log, 'ping-vakten avväpnad av leveransbevis')).toHaveLength(1);
    expect(linesWith(logger.log, 'half-open')).toHaveLength(0);
    client._stopPing();
  });

  test('ETT DYGN av leverans-utan-pong ger NOLL självförvållade handskakningar', () => {
    // Fyndets siffra, direkt motbevisad: 2 880 ping-tick på 24 h.
    const client = new AISStreamClient(makeLogger());
    const ws = pingableSocket();
    client.ws = ws;
    client._startPing();

    for (let i = 0; i < 2880; i++) {
      client._onMessage(POSITION_REPORT);
      jest.advanceTimersByTime(30000);
    }

    expect(ws.terminate).toHaveBeenCalledTimes(0); // före fixen: ~1 370
    expect(client._messagesThisSocket).toBe(2880);
    client._stopPing();
  });

  test('deltat mäts PER TICK — leverans i ett gammalt fönster räddar ingen', () => {
    // Kritisk avgränsning: vakten får inte avväpnas av "har någonsin levererat".
    const client = new AISStreamClient(makeLogger());
    const ws = pingableSocket();
    client.ws = ws;
    client._startPing();

    client._onMessage(POSITION_REPORT); // leverans i fönster 1
    jest.advanceTimersByTime(30000); // tick 1: ping ut
    jest.advanceTimersByTime(30000); // tick 2: inget nytt sedan tick 1 ⇒ död

    expect(ws.terminate).toHaveBeenCalledTimes(1);
    client._stopPing();
  });

  test('ett flöde som TYSTNAR dödas fortfarande inom två tick', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    const ws = pingableSocket();
    client.ws = ws;
    client._startPing();

    for (let i = 0; i < 5; i++) { // fem levererande cykler
      client._onMessage(POSITION_REPORT);
      jest.advanceTimersByTime(30000);
    }
    expect(ws.terminate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30000); // tystnad, tick 1
    jest.advanceTimersByTime(30000); // tystnad, tick 2 ⇒ half-open
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(linesWith(logger.log, 'half-open')).toHaveLength(1);
    client._stopPing();
  });

  test('en HELT tyst socket dödas som förut (F1-vakten orörd)', () => {
    const client = new AISStreamClient(makeLogger());
    const ws = pingableSocket();
    client.ws = ws;
    client._startPing();

    jest.advanceTimersByTime(60000);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    client._stopPing();
  });

  test('leveransdeltat hör till EN socket — _stopPing nollställer baslinjen', () => {
    const client = new AISStreamClient(makeLogger());
    client.ws = pingableSocket();
    client._messagesThisSocket = 500; // gammal socket hann leverera mycket
    client._startPing();
    expect(client._pingTickMessages).toBe(500); // baslinje = nuläget, inte 0
    client._stopPing();
    expect(client._pingTickMessages).toBe(0);
    expect(client._ponglessDeliveryLogged).toBe(false);
  });
});

/**
 * F2-2: den platta rate-limit-cooldownen låg FÖRE fasstegen och skrev över dem
 * rakt av. En server som varit onåbar i över en timme (timfasen, 1
 * handskakning/h) och sedan börjar svara 429 fick därmed 4 handskakningar/h —
 * cooldownen fungerade som TAK i stället för GOLV, tvärtemot sin egen
 * motivering. Nu: delay = max(cooldown, fasens ordinarie delay).
 */
describe('F2-2: cooldownen är ett GOLV, aldrig ett tak', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    jest.useRealTimers();
    Math.random.mockRestore();
  });

  test('timfasen: 429 utan Retry-After ger 60 min, inte 15', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client.reconnectAttempts = 22; // timfasen

    rejectHandshakeNow(client, 429);
    client._onClose(1006, '');

    expect(client._rateLimitedUntil - Date.now()).toBe(60 * 60 * 1000);
    expect(client.reconnectAttempts).toBe(22); // steget står fortfarande stilla
    const row = linesWith(logger.log, 'Rate-limitad av servern')[0];
    expect(row).toContain('cooldown 60.0 min');
    expect(row).toContain('golv: fasens 60.0 min gäller');
    client._clearTimers();
  });

  test('timfasen: en kort Retry-After kan inte förkorta backoffen', () => {
    const client = new AISStreamClient(makeLogger());
    client.reconnectAttempts = 30; // djupt i timfasen
    rejectHandshakeNow(client, 429, { 'retry-after': '120' });
    client._onClose(1006, '');

    expect(client._rateLimitedUntil - Date.now()).toBe(60 * 60 * 1000);
    client._clearTimers();
  });

  test('mediumfasen: 15 min slår fasens 5 min (cooldownen dominerar)', () => {
    const client = new AISStreamClient(makeLogger());
    client.reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // 5-minutersfasen
    rejectHandshakeNow(client, 429);
    client._onClose(1006, '');

    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS);
    client._clearTimers();
  });

  test('snabbfasen: KX-2:s ursprungliga beteende är exakt oförändrat', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client.reconnectAttempts = 3;
    rejectHandshakeNow(client, 429);
    client._onClose(1006, '');

    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS);
    // Ingen golvnotis när cooldownen redan dominerar — raden får inte bli brus.
    expect(linesWith(logger.log, 'golv: fasens')).toHaveLength(0);
    client._clearTimers();
  });

  test('_phaseBaseDelay speglar fasgränserna utan sidoeffekter', () => {
    const client = new AISStreamClient(makeLogger());
    const at = (n) => {
      client.reconnectAttempts = n;
      return client._phaseBaseDelay();
    };
    expect(at(0)).toBe(AIS_CONFIG.RECONNECT_DELAYS[0]);
    expect(at(4)).toBe(AIS_CONFIG.RECONNECT_DELAYS[4]);
    expect(at(9)).toBe(AIS_CONFIG.RECONNECT_DELAYS[4]); // klampat index
    expect(at(MAX_RECONNECT_ATTEMPTS)).toBe(5 * 60 * 1000);
    expect(at(22)).toBe(60 * 60 * 1000);
    expect(client.reconnectAttempts).toBe(22); // ingen räknare rörd av anropet
    expect(client._rateLimitedUntil).toBe(0);
  });
});

/**
 * F2-3: Date.parse-fallbacken var för lenient. V8:s legacy-parser tolkar '-5'
 * som 2001-05-01 och '120.5' som år 120 — båda i det förflutna ⇒ gamla
 * Math.max(0, …) gav 0 ms, vilket är !== null ⇒ Retry-After-grenen togs och
 * klampade till 60 s i stället för 15 min + jitter. Appen kom alltså tillbaka
 * 15 gånger snabbare än designat, precis när servern bad oss backa.
 */
describe('F2-3: Retry-After tolkas strikt (skräp ⇒ basvärdet, inte 60 s-golvet)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    jest.useRealTimers();
    Math.random.mockRestore();
  });

  const JUNK = ['-5', '120.5', '1e3', ' -0', 'snart', '2 minutes', 'Tue, 32 Zzz 2026 25:00:00 GMT'];

  test.each(JUNK)('_parseRetryAfter(%p) === null', (raw) => {
    const client = new AISStreamClient(makeLogger());
    expect(client._parseRetryAfter(raw)).toBeNull();
  });

  test.each(JUNK)('429 med Retry-After %p faller på basvärdet 15 min', (raw) => {
    const client = new AISStreamClient(makeLogger());
    rejectHandshakeNow(client, 429, { 'retry-after': raw });
    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS);
    client._clearTimers();
  });

  test("'2' är en GILTIG delta-sekundsform, inte skräp — 429 klampar den till 60 s", () => {
    // Fyndet listade '2' bland Date.parse-offren, men heltalsgrenen fångar den
    // FÖRE Date.parse: RFC 9110 delta-seconds = 2 s. Klampningen gör resten.
    const client = new AISStreamClient(makeLogger());
    expect(client._parseRetryAfter('2')).toBe(2000);
    rejectHandshakeNow(client, 429, { 'retry-after': '2' });
    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_RETRY_AFTER_MIN_MS);
    client._clearTimers();
  });

  test('HTTP-datum i det FÖRFLUTNA bär ingen information ⇒ basvärdet (inte 0 ⇒ 60 s)', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    const past = new Date(Date.now() - 5 * 60 * 1000).toUTCString();
    expect(client._parseRetryAfter(past)).toBeNull();

    rejectHandshakeNow(client, 429, { 'retry-after': past });
    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS);
    // Den vilseledande raden "Retry-After 0 s klampad" får aldrig skrivas igen.
    expect(linesWith(logger.log, 'Retry-After 0 s')).toHaveLength(0);
    expect(linesWith(logger.log, 'ingen Retry-After')).toHaveLength(1);
    client._clearTimers();
  });

  test('giltigt framtida IMF-fixdate tolkas fortfarande (RFC 9110:s andra form)', () => {
    const client = new AISStreamClient(makeLogger());
    const when = new Date(Date.now() + 8 * 60 * 1000).toUTCString();
    const ms = client._parseRetryAfter(when);
    expect(Math.abs(ms - 8 * 60 * 1000)).toBeLessThanOrEqual(1000);
  });

  test('tomma/saknade headrar är fortfarande null', () => {
    const client = new AISStreamClient(makeLogger());
    expect(client._parseRetryAfter(null)).toBeNull();
    expect(client._parseRetryAfter(undefined)).toBeNull();
    expect(client._parseRetryAfter('   ')).toBeNull();
  });
});

/**
 * F2-4: en 429 är IP-/kvotbunden, men användaren vet inte det. Hen ser att
 * appen står still, skapar en ny nyckel — och möts av upp till 20 minuters
 * tystnad med bara en debugrad som signal. Ett AKTIVT användaringrepp bryter
 * därför cooldownen; watchdogen (appens egen maskinella takt) gör det inte.
 */
describe('F2-4: aktivt användaringrepp bryter rate-limit-cooldownen', () => {
  const MIN = 60 * 1000;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("reason='key-update' upphäver pausen OCH öppnar handskakningen direkt", () => {
    withFakeWs((IsolatedClient, created) => {
      const logger = makeLogger();
      const client = new IsolatedClient(logger);
      client._rateLimitedUntil = Date.now() + 15 * MIN;
      client._rateLimitCount = 3;

      client.reconnectWithKey('NY_NYCKEL', 'key-update');

      expect(client._rateLimitedUntil).toBe(0);
      expect(client._rateLimitCount).toBe(0);
      expect(created).toHaveLength(1); // handskakningen påbörjades NU
      expect(client.apiKey).toBe('NY_NYCKEL');
      const row = linesWith(logger.log, 'upphävd av användaringrepp')[0];
      expect(row).toContain('key-update');
      expect(row).toContain('15.0 min återstod'); // pausen redovisas, inte sväljs
      expect(linesWith(logger.log, 'Rate-limit-cooldown aktiv')).toHaveLength(0);
      client._clearTimers();
    });
  });

  test("reason='watchdog' respekterar pausen (automatvägen strypt som förut)", () => {
    withFakeWs((IsolatedClient, created) => {
      const client = new IsolatedClient(makeLogger());
      const until = Date.now() + 15 * MIN;
      client._rateLimitedUntil = until;

      client.reconnectWithKey('SAMMA_NYCKEL', 'watchdog');

      expect(created).toHaveLength(0); // ingen handskakning under pausen
      expect(client._rateLimitedUntil).toBe(until);
      client._clearTimers();
    });
  });

  test('defaultanropet (app.js:s legacy-nyckelbytesväg) räknas som användaringrepp', () => {
    withFakeWs((IsolatedClient, created) => {
      const client = new IsolatedClient(makeLogger());
      client._rateLimitedUntil = Date.now() + 10 * MIN;
      client.reconnectWithKey('NY'); // reason utelämnad ⇒ 'key-update'
      expect(client._rateLimitedUntil).toBe(0);
      expect(created).toHaveLength(1);
      client._clearTimers();
    });
  });

  test('clearRateLimitCooldown är tyst och falsk när ingen paus pågår', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    expect(client.clearRateLimitCooldown('key-update')).toBe(false);
    expect(linesWith(logger.log, 'upphävd av användaringrepp')).toHaveLength(0);
  });

  test('en PASSERAD rest städas utan att låtsas vara ett ingripande', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    client._rateLimitedUntil = Date.now() - 1000; // löpt ut men aldrig städad
    expect(client.clearRateLimitCooldown('source-config')).toBe(false);
    expect(client._rateLimitedUntil).toBe(0);
    expect(linesWith(logger.log, 'upphävd av användaringrepp')).toHaveLength(0);
  });
});

/**
 * F2-5 (WS-1): _onUnexpectedResponse skrev KLIENT-globala statusfält utan att
 * jämföra socketen mot this.ws. En sen 429-callback från en övergiven socket
 * kunde därför lägga 15 minuters cooldown över en ny, fungerande anslutning —
 * ett självförvållat leveransavbrott med aisstream som primärkälla.
 */
describe('F2-5: socketgenerationsvakt i unexpected-response', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('sen 429 från en ÖVERGIVEN socket rör inte den aktiva anslutningens status', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    const gammal = { terminate: jest.fn() };
    const ny = { terminate: jest.fn() };
    client.ws = ny; // connect() hann installera en ny socket
    const res = { statusCode: 429, headers: { 'retry-after': '600' }, resume: jest.fn() };

    client._onUnexpectedResponse(gammal, {}, res);

    expect(client._lastHandshakeStatus).toBeNull();
    expect(client._lastRetryAfterMs).toBeNull();
    expect(gammal.terminate).toHaveBeenCalledTimes(1); // gamla socketen rivs ändå
    expect(res.resume).toHaveBeenCalledTimes(1); // svarskroppen dräneras ändå
    expect(ny.terminate).not.toHaveBeenCalled(); // den friska rörs ALDRIG
    expect(linesWith(logger.log, 'Handskakningen avvisad')).toHaveLength(0);

    // ...och nästa stängning ger ordinarie trappa, ingen cooldown.
    client._onClose(1006, '');
    expect(client._rateLimitedUntil).toBe(0);
    expect(linesWith(logger.log, 'Rate-limitad av servern')).toHaveLength(0);
    client._clearTimers();
  });

  test('AKTUELL socket behandlas exakt som förut (KX-2-vägen orörd)', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    const { socket } = rejectHandshakeNow(client, 429, { 'retry-after': '300' });

    expect(client._lastHandshakeStatus).toBe(429);
    expect(client._lastRetryAfterMs).toBe(300000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(linesWith(logger.log, 'Handskakningen avvisad')).toHaveLength(1);
    client._clearTimers();
  });
});

/**
 * F2-6: 60 s-golvet är 429-specifikt. En 503 med "Retry-After: 2" är en
 * rullande omstart — att klampa UPP serverns egen begäran till 60 s gjorde tre
 * 503 under en treminutersdeploy till 3 minuters blindhet i stället för ~10 s.
 */
describe('F2-6: 503 med Retry-After får respektera serverns korta paus', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    jest.useRealTimers();
    Math.random.mockRestore();
  });

  test('503 + "Retry-After: 2" ⇒ 5 s (503-golvet), inte 60 s', () => {
    const client = new AISStreamClient(makeLogger());
    rejectHandshakeNow(client, 503, { 'retry-after': '2' });
    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now())
      .toBe(AIS_CONFIG.RATE_LIMIT_RETRY_AFTER_MIN_503_MS);
    client._clearTimers();
  });

  test('503 + "Retry-After: 20" respekteras rakt av (över golvet)', () => {
    const client = new AISStreamClient(makeLogger());
    rejectHandshakeNow(client, 503, { 'retry-after': '20' });
    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now()).toBe(20000);
    client._clearTimers();
  });

  test('429 + "Retry-After: 2" behåller 60 s-golvet (spärren är en annan sak)', () => {
    const client = new AISStreamClient(makeLogger());
    rejectHandshakeNow(client, 429, { 'retry-after': '2' });
    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RATE_LIMIT_RETRY_AFTER_MIN_MS);
    client._clearTimers();
  });

  test('en FLAPPANDE 503-server hamras inte: fasgolvet tar över när trappan eskalerat', () => {
    const client = new AISStreamClient(makeLogger());
    client.reconnectAttempts = 4; // snabbtrappans sista steg = 30 s
    rejectHandshakeNow(client, 503, { 'retry-after': '2' });
    client._onClose(1006, '');
    expect(client._rateLimitedUntil - Date.now()).toBe(AIS_CONFIG.RECONNECT_DELAYS[4]);
    client._clearTimers();
  });

  test('503 UTAN Retry-After är fortfarande ett vanligt serverfel', () => {
    const logger = makeLogger();
    const client = new AISStreamClient(logger);
    rejectHandshakeNow(client, 503);
    client._onClose(1006, '');
    expect(client._rateLimitedUntil).toBe(0);
    expect(client.reconnectAttempts).toBe(1);
    expect(linesWith(logger.log, 'Reconnecting in')).toHaveLength(1);
    client._clearTimers();
  });
});

/**
 * F2-8: _rateLimitedUntil nollställdes BARA av en lyckad handskakning. Ett rent
 * nätfel efter cooldownen (ECONNREFUSED, ingen HTTP-status) lämnade ett
 * passerat värde kvar resten av processens liv — getConnectionStats() påstod
 * "rate-limitad" om en källa som inte var det.
 */
describe('F2-8: hälsoraden skiljer "pausad nu" från "var pausad förut"', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('en utlöpt cooldown städas vid nästa connect()', () => {
    withFakeWs((IsolatedClient) => {
      const client = new IsolatedClient(makeLogger());
      client._rateLimitedUntil = Date.now() - 30 * 1000; // löpte ut nyss
      client._rateLimitCount = 2;

      client.connect('KEY');

      expect(client._rateLimitedUntil).toBe(0);
      expect(client.getConnectionStats().rateLimitedUntil).toBeNull();
      // Tät återkomst = SAMMA episod ⇒ räknaren lever vidare (loggens "nr N").
      expect(client._rateLimitCount).toBe(2);
      client._clearTimers();
    });
  });

  test('en tyst timme avslutar episoden (räknaren summerar inte orelaterade fall)', () => {
    withFakeWs((IsolatedClient) => {
      const client = new IsolatedClient(makeLogger());
      client._rateLimitedUntil = Date.now() - (AIS_CONFIG.RATE_LIMIT_EPISODE_RESET_MS + 1000);
      client._rateLimitCount = 5;

      client.connect('KEY');

      expect(client._rateLimitedUntil).toBe(0);
      expect(client._rateLimitCount).toBe(0);
      client._clearTimers();
    });
  });

  test('en PÅGÅENDE cooldown städas aldrig av misstag', () => {
    withFakeWs((IsolatedClient, created) => {
      const client = new IsolatedClient(makeLogger());
      const until = Date.now() + 5 * 60 * 1000;
      client._rateLimitedUntil = until;

      client.connect('KEY');

      expect(client._rateLimitedUntil).toBe(until);
      expect(created).toHaveLength(0); // ingen handskakning under pausen
      client._clearTimers();
    });
  });
});
