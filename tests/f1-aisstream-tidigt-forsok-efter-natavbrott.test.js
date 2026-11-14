'use strict';

/**
 * F1 (fältprovet 10–13 november 2026, körning 1): AISstream kom tillbaka först
 * 37 minuter efter att nätet återvänt.
 *
 * Förloppet i fält (k1 rad 24102–27167): Homey tappade nätet 02:20:48Z, båda
 * källorna var borta i 4,5 h. AISHub svarade igen 06:54:21Z, men AISstream
 * återanslöt först 07:31:34Z. Ett avbrott på 4,5 h driver strömklienten genom
 * snabbfasen och 5-minutersfasen in i timfasen (SLOW_RECONNECT_INTERVAL), och
 * ingenting drog fram nästa försök när hubben visat att nätet var tillbaka.
 *
 * Rättningen: muxen hör hubbens connected-flank (efter en nedflank, men också
 * vid appstart och när hubbklienten byggs om — ofarligt) och ber
 * strömklienten om ETT framdraget försök (nudgeReconnect). Klienten drar bara
 * fram när senaste försöket aldrig nådde servern (ingen öppnad socket, inget
 * HTTP-svar: ett nätfel eller en server som inte svarar på TCP/TLS-nivå),
 * aldrig under en rate-limit-spärr, bara utanför snabbfasen, och högst en
 * gång per 5 min.
 * Ett framdraget försök som misslyckas faller tillbaka i den vanliga
 * backoffen. Backoffens skydd mot hamring (RC-S1, KX-2) står kvar.
 */

jest.mock('ws', () => {
  const EventEmitter = require('events');
  class FakeWS extends EventEmitter {
    constructor() {
      super();
      FakeWS.instances.push(this);
      FakeWS.createdAt.push(Date.now());
      this.readyState = 0;
      const { mode } = FakeWS;
      // Utfallet bestäms när socketen skapas och spelas upp asynkront, efter
      // att klienten kopplat sina lyssnare (precis som ws).
      setTimeout(() => FakeWS.play(this, mode), 10);
    }

    static play(ws, mode) {
      if (ws.readyState === 3) return;
      if (mode === 'unreachable') {
        // Nätet nere: ingen socket öppnas, inget HTTP-svar.
        const err = new Error('connect ENETUNREACH 1.2.3.4:443');
        err.code = 'ENETUNREACH';
        ws.emit('error', err);
        ws.readyState = 3;
        ws.emit('close', 1006, Buffer.from(''));
      } else if (mode === 'rate-limited') {
        ws.emit('unexpected-response', {}, { statusCode: 429, headers: {}, resume() {} });
      } else if (mode === 'key-rejected') {
        // Spärrad nyckel/policyfel: servern öppnar och svarar med ett fel.
        ws.readyState = 1;
        ws.emit('open');
        ws.emit('message', JSON.stringify({ error: 'Api Key Is Not Valid' }));
      } else {
        ws.readyState = 1;
        ws.emit('open');
      }
    }

    send() {}

    ping() {
      // En frisk socket pongar, annars dödar ping-vakten den efter 60 s.
      setTimeout(() => {
        if (this.readyState === 1) this.emit('pong');
      }, 5);
    }

    close() {
      this.readyState = 3;
    }

    terminate() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.emit('close', 1006, Buffer.from('')), 0);
    }
  }
  FakeWS.CONNECTING = 0;
  FakeWS.OPEN = 1;
  FakeWS.CLOSING = 2;
  FakeWS.CLOSED = 3;
  FakeWS.instances = [];
  FakeWS.createdAt = [];
  FakeWS.mode = 'ok';
  return FakeWS;
});

const FakeWS = require('ws');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const AISHubClient = require('../lib/connection/AISHubClient');
const AISStreamClient = require('../lib/connection/AISStreamClient');
const { MAX_RECONNECT_ATTEMPTS } = require('../lib/constants');

const KEY = 'k'.repeat(40);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const OK_BODY = JSON.stringify([{ ERROR: false, FORMAT: 'HUMAN', RECORDS: 0 }, []]);

function unreachableError() {
  const err = new Error('connect ENETUNREACH 144.76.105.244:443');
  err.code = 'ENETUNREACH';
  return err;
}

/** Stega fejkad tid i minutsteg så att varje timer får köra i sin ordning. */
async function advance(ms, step = MIN) {
  let left = ms;
  while (left > 0) {
    const d = Math.min(step, left);
    // eslint-disable-next-line no-await-in-loop
    await jest.advanceTimersByTimeAsync(d);
    left -= d;
  }
}

const handshakesSince = (t) => FakeWS.createdAt.filter((c) => c >= t);

describe('F1: muxen drar fram AISstream-försöket när AISHub visat att nätet är tillbaka', () => {
  let mux;
  let net;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-10T21:44:03Z') });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    FakeWS.instances.length = 0;
    FakeWS.createdAt.length = 0;
    FakeWS.mode = 'ok';
    net = { hubUp: true };
    jest.spyOn(AISHubClient.prototype, '_httpGet').mockImplementation(() => (
      net.hubUp
        ? Promise.resolve({ statusCode: 200, body: OK_BODY })
        : Promise.reject(unreachableError())
    ));
    const store = {};
    logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    mux = new AISSourceMultiplexer(logger, {
      get: (k) => store[k] ?? null,
      set: (k, v) => {
        store[k] = v;
      },
    });
    mux.on('error', () => {});
  });

  afterEach(() => {
    mux.disconnect();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function startBoth() {
    mux.applySourceConfig({ source: 'both', apiKey: KEY, aishubUsername: 'tester' });
    await advance(2 * MIN, 10 * SEC);
    expect(mux._streamClient.isConnected).toBe(true);
    expect(mux._hubClient.isConnected).toBe(true);
  }

  /** Nätavbrott: båda källorna onåbara. Den öppna socketen dör som i fält. */
  function networkDown() {
    net.hubUp = false;
    FakeWS.mode = 'unreachable';
    const { ws } = mux._streamClient;
    if (ws) {
      ws.readyState = 3;
      ws.emit('close', 1006, Buffer.from(''));
    }
  }

  function networkUp() {
    net.hubUp = true;
    FakeWS.mode = 'ok';
  }

  /** Tidpunkten då hubben flankar upp nästa gång. */
  function watchHubFlankUp() {
    const seen = { at: null };
    mux._hubClient.once('connected', () => {
      seen.at = Date.now();
    });
    return seen;
  }

  test('k1-förloppet: 4,5 h nätavbrott ⇒ AISstream handskakar inom sekunder efter hubbens återkomst', async () => {
    await startBoth();
    networkDown();
    await advance(4.5 * HOUR);
    const stream = mux._streamClient;
    expect(stream.isConnected).toBe(false);
    expect(mux._hubClient.isConnected).toBe(false);
    // Timfasen: det väntande försöket bokades med 60 min.
    expect(stream.reconnectAttempts).toBeGreaterThan(22);

    networkUp();
    const flank = watchHubFlankUp();
    const upAt = Date.now();
    await advance(6 * MIN, 5 * SEC);

    expect(flank.at).not.toBeNull();
    const after = handshakesSince(flank.at);
    expect(after.length).toBeGreaterThanOrEqual(1);
    // Före rättningen: nästa handskakning först vid timfasens tick (här
    // ~33 min efter att nätet kommit tillbaka). Efter: 5 s + jitter.
    expect(after[0] - flank.at).toBeLessThanOrEqual(10 * SEC);
    expect(stream.isConnected).toBe(true);
    expect(flank.at - upAt).toBeLessThanOrEqual(5 * MIN + 10 * SEC);
    const logs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).toContain('drar fram nästa försök');
  });

  test('AISstream nere medan AISHub svarar hela tiden: exakt dagens backoff, inga extra försök', async () => {
    await startBoth();
    // Bara AISstream är onåbar (nätet fungerar, hubben svarar varje poll).
    FakeWS.mode = 'unreachable';
    mux._streamClient.ws.readyState = 3;
    mux._streamClient.ws.emit('close', 1006, Buffer.from(''));
    const t0 = Date.now();
    await advance(5 * HOUR);

    const attempts = handshakesSince(t0);
    const gaps = attempts.slice(1).map((t, i) => t - attempts[i]);
    // Snabbfasen (10 försök), mediumfasen (12 × 5 min), sedan en gång i
    // timmen — och inget däremellan.
    const medium = gaps.slice(MAX_RECONNECT_ATTEMPTS, MAX_RECONNECT_ATTEMPTS + 11);
    expect(medium.every((g) => g >= 5 * MIN)).toBe(true);
    const slow = gaps.slice(MAX_RECONNECT_ATTEMPTS + 12);
    expect(slow.length).toBeGreaterThan(0);
    expect(slow.every((g) => g >= HOUR)).toBe(true);
    const logs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).not.toContain('drar fram nästa försök');
  });

  test('spärrad nyckel/policyfel: hubbens återkomst drar inte fram något försök', async () => {
    await startBoth();
    // AISstream öppnar men avvisar nyckeln vid varje försök.
    FakeWS.mode = 'key-rejected';
    mux._streamClient.ws.readyState = 3;
    mux._streamClient.ws.emit('close', 1006, Buffer.from(''));
    await advance(1.5 * HOUR);
    const stream = mux._streamClient;
    expect(stream.reconnectAttempts).toBeGreaterThan(22);
    expect(stream._neverReachedServer()).toBe(false);

    // Hubben har ett eget avbrott och kommer tillbaka.
    net.hubUp = false;
    await advance(15 * MIN);
    expect(mux._hubClient.isConnected).toBe(false);
    // Timfasens nästa försök: en timme efter det senaste.
    const nextHourly = FakeWS.createdAt[FakeWS.createdAt.length - 1] + HOUR;
    net.hubUp = true;
    const flank = watchHubFlankUp();
    await advance(6 * MIN, 5 * SEC);
    expect(flank.at).not.toBeNull();
    expect(nextHourly - flank.at).toBeGreaterThan(6 * MIN);
    // Inget framdraget försök: nästa handskakning står kvar på timfasens tid.
    expect(handshakesSince(flank.at).filter((t) => t < nextHourly)).toHaveLength(0);
    const logs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).not.toContain('drar fram nästa försök');
  });

  test('429-spärr: hubbens återkomst bryter aldrig cooldownen', async () => {
    await startBoth();
    networkDown();
    await advance(1.5 * HOUR);
    const stream = mux._streamClient;
    // Sista försöket före återkomsten fick 429 (servern nåddes och bad oss backa).
    FakeWS.mode = 'rate-limited';
    stream.rescheduleReconnect(KEY, 1000);
    await advance(10 * SEC, SEC);
    expect(stream._rateLimitedUntil).toBeGreaterThan(Date.now());
    const until = stream._rateLimitedUntil;

    networkUp();
    FakeWS.mode = 'ok';
    const flank = watchHubFlankUp();
    await advance(6 * MIN, 5 * SEC);
    expect(flank.at).not.toBeNull();
    expect(handshakesSince(flank.at).filter((t) => t < until)).toHaveLength(0);
  });

  test('hubben flappar medan AISstream förblir onåbar: aldrig tätare än 5 min, ingen omstart av snabbfasen', async () => {
    await startBoth();
    networkDown();
    await advance(2.5 * HOUR);
    const stream = mux._streamClient;
    expect(stream.reconnectAttempts).toBeGreaterThan(22);

    // AISstream förblir onåbar (t.ex. tjänsten vägrar TCP) medan hubbens
    // väg flappar: 10 min nere, 6 min uppe, i tre timmar.
    const t0 = Date.now();
    const flanks = [];
    mux._hubClient.on('connected', () => flanks.push(Date.now()));
    for (let i = 0; i < 11; i++) {
      net.hubUp = false;
      // eslint-disable-next-line no-await-in-loop
      await advance(10 * MIN, 5 * SEC);
      net.hubUp = true;
      // eslint-disable-next-line no-await-in-loop
      await advance(6 * MIN, 5 * SEC);
    }
    const attempts = handshakesSince(t0);
    expect(flanks.length).toBeGreaterThanOrEqual(8);
    // Aldrig tätare än mediumfasens takt.
    const gaps = attempts.slice(1).map((t, i) => t - attempts[i]);
    expect(gaps.every((g) => g >= 5 * MIN)).toBe(true);
    // Högst ett försök per hubbåterkomst utöver timfasens egna.
    expect(attempts.length).toBeLessThanOrEqual(flanks.length + 4);
    // Varje misslyckat försök faller tillbaka i timfasen: ingen ny snabbfas.
    expect(stream.reconnectAttempts).toBeGreaterThan(22);
  });

  test('nätet flappar för båda: högst en handskakning som når servern per period med nät', async () => {
    await startBoth();
    networkDown();
    await advance(2.5 * HOUR);
    const stream = mux._streamClient;
    expect(stream.reconnectAttempts).toBeGreaterThan(22);

    // 10 min utan nät, 5 min med, i tre timmar. Handskakningar under
    // perioderna utan nät når aldrig servern (ENETUNREACH lokalt).
    const reached = [];
    let windows = 0;
    let connectedWindows = 0;
    for (let i = 0; i < 12; i++) {
      networkDown();
      // eslint-disable-next-line no-await-in-loop
      await advance(10 * MIN, 5 * SEC);
      networkUp();
      windows++;
      const n0 = FakeWS.instances.length;
      // eslint-disable-next-line no-await-in-loop
      await advance(5 * MIN, 5 * SEC);
      reached.push(FakeWS.instances.length - n0);
      if (stream.isConnected) connectedWindows++;
    }
    expect(windows).toBe(12);
    expect(reached.every((n) => n <= 1)).toBe(true);
    // Med rättningen ansluter AISstream i de flesta fönstren med nät.
    expect(connectedWindows).toBeGreaterThanOrEqual(10);
  });
});

describe('F1: AISStreamClient.nudgeReconnect avgör själv om ett försök får dras fram', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T06:00:00Z') });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    FakeWS.instances.length = 0;
    FakeWS.createdAt.length = 0;
    FakeWS.mode = 'unreachable';
    client = new AISStreamClient({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });
    client.on('error', () => {});
  });

  afterEach(() => {
    client.disconnect();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Kör klienten mot ett onåbart nät tills den står i önskad fas. */
  async function failUntilAttempts(n) {
    await client.connect(KEY);
    while (client.reconnectAttempts < n) {
      // eslint-disable-next-line no-await-in-loop
      await jest.advanceTimersByTimeAsync(30 * SEC);
    }
    await jest.advanceTimersByTimeAsync(20);
  }

  test('timfasen efter nätfel: försöket dras fram, och ett misslyckat försök faller tillbaka i timfasen', async () => {
    await failUntilAttempts(24);
    const attemptsBefore = client.reconnectAttempts;
    expect(client._reconnectDueAt - Date.now()).toBeGreaterThan(30 * MIN);
    const n0 = FakeWS.instances.length;

    expect(client.nudgeReconnect('test')).toBe(true);
    await jest.advanceTimersByTimeAsync(5 * SEC + 50);
    expect(FakeWS.instances.length).toBe(n0 + 1);

    // Försöket misslyckas (nätet fortfarande nere) ⇒ vanlig backoff: räknaren
    // ökar med ett och nästa försök bokas om en timme.
    expect(client.reconnectAttempts).toBe(attemptsBefore + 1);
    expect(client._reconnectDueAt - Date.now()).toBeGreaterThan(59 * MIN);
    await jest.advanceTimersByTimeAsync(59 * MIN);
    expect(FakeWS.instances.length).toBe(n0 + 1);
  });

  test('ett andra framdraget försök inom 5 min avvisas', async () => {
    await failUntilAttempts(24);
    expect(client.nudgeReconnect('test')).toBe(true);
    await jest.advanceTimersByTimeAsync(10 * SEC);
    expect(client.nudgeReconnect('test')).toBe(false);
    await jest.advanceTimersByTimeAsync(5 * MIN);
    expect(client.nudgeReconnect('test')).toBe(true);
  });

  test('snabbfasen: inget att dra fram', async () => {
    await failUntilAttempts(3);
    const due = client._reconnectDueAt;
    expect(client.nudgeReconnect('test')).toBe(false);
    expect(client._reconnectDueAt).toBe(due);
  });

  test('mediumfasen efter nätfel: försöket dras fram', async () => {
    await failUntilAttempts(MAX_RECONNECT_ATTEMPTS + 2);
    expect(client._reconnectDueAt - Date.now()).toBeGreaterThan(4 * MIN);
    expect(client.nudgeReconnect('test')).toBe(true);
  });

  test('senaste försöket nådde servern (HTTP-svar): ingen ändring', async () => {
    await failUntilAttempts(24);
    client._lastHandshakeStatus = 503;
    const due = client._reconnectDueAt;
    expect(client.nudgeReconnect('test')).toBe(false);
    expect(client._reconnectDueAt).toBe(due);
  });

  test('senaste försöket öppnade socketen: ingen ändring', async () => {
    await failUntilAttempts(24);
    client._socketOpened = true;
    expect(client.nudgeReconnect('test')).toBe(false);
  });

  test('pågående rate-limit-spärr: ingen ändring', async () => {
    await failUntilAttempts(24);
    client._rateLimitedUntil = Date.now() + 10 * MIN;
    expect(client.nudgeReconnect('test')).toBe(false);
  });

  test('L3 (M1e): ett väntande försök som redan ligger närmare än det framdragna skjuts aldrig upp', async () => {
    await failUntilAttempts(MAX_RECONNECT_ATTEMPTS + 2);
    // Mediumfasens försök ligger 3 s bort; ett framdraget försök skulle ta 5 s.
    await jest.advanceTimersByTimeAsync(client._reconnectDueAt - Date.now() - 3000);
    const due = client._reconnectDueAt;
    const n0 = FakeWS.instances.length;
    expect(client.nudgeReconnect('test')).toBe(false);
    expect(client._reconnectDueAt).toBe(due);
    await jest.advanceTimersByTimeAsync(3000 + 5);
    expect(FakeWS.instances.length).toBe(n0 + 1);
  });

  test('L3 (M1h): det framdragna försöket väntar 5 s plus jitter (spridning mellan enheter bakom samma nät)', async () => {
    await failUntilAttempts(24);
    Math.random.mockReturnValue(0.5); // 5 s + 0,5 × 5 s = 7,5 s
    const n0 = FakeWS.instances.length;
    expect(client.nudgeReconnect('test')).toBe(true);
    expect(client._reconnectDueAt - Date.now()).toBe(7500);
    await jest.advanceTimersByTimeAsync(7400);
    expect(FakeWS.instances.length).toBe(n0);
    await jest.advanceTimersByTimeAsync(200);
    expect(FakeWS.instances.length).toBe(n0 + 1);
  });

  test('ansluten klient eller klient utan väntande försök: ingen ändring', async () => {
    FakeWS.mode = 'ok';
    await client.connect(KEY);
    await jest.advanceTimersByTimeAsync(50);
    expect(client.isConnected).toBe(true);
    expect(client.nudgeReconnect('test')).toBe(false);
    client.disconnect();
    expect(client.nudgeReconnect('test')).toBe(false);
  });
});
