'use strict';

/**
 * Spår K (omgång 9): felinjektion i AISstream-klientens återanslutningsväg.
 *
 * Fältprov 3 (november 2026) gav 102 handskakningar som löpte ut efter 15 s
 * (servern svarade inte på uppgraderingen) och 37 omstarter från feed-vakten.
 * Proven här bygger samma lägen med en låtsad websocket och kontrollerar att
 * klienten aldrig har två levande sockets, att inga timers blir kvar efter
 * nedstängning och att trappan (snabbfas, 5 min, timvis) håller. Inget av
 * proven fällde koden när de skrevs (omgång 9): de är regressionsskydd.
 *
 * U67 (dirigentens beslut 2026-11-27): handskakningen får 30 s. Lyckade
 * handskakningar tog 11,5 s i median i fältprov 3 (p90 14,4 s, längst 16,2 s
 * räknat från loggraden), och 73 % av försöken löpte ut vid 15 s.
 */

jest.mock('ws', () => {
  const EventEmitter = require('events');
  class FakeWS extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts;
      this.readyState = 0;
      this.sent = [];
      this._timers = [];
      FakeWS.instances.push(this);
      const plan = FakeWS.plan.length ? FakeWS.plan.shift() : FakeWS.defaultPlan;
      this.plan = plan;
      if (plan.typ === 'timeout') {
        // ws: handshakeTimeout ⇒ abortHandshake ⇒ 'error' + 'close'.
        this._timers.push(setTimeout(() => {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.emit('error', new Error('Opening handshake has timed out'));
          this.emit('close', 1006, Buffer.from(''));
        }, opts && opts.handshakeTimeout ? opts.handshakeTimeout : 15000));
      } else if (plan.typ === 'open') {
        this._timers.push(setTimeout(() => {
          if (this.readyState === 3) return;
          this.readyState = 1;
          this.emit('open');
          if (plan.stangEfterMs) {
            this._timers.push(setTimeout(() => {
              if (this.readyState !== 1) return;
              this.readyState = 3;
              this.emit('close', 1000, Buffer.from(''));
            }, plan.stangEfterMs));
          }
        }, plan.efterMs || 1000));
      }
    }

    send(data) {
      if (this.plan.sendKastar) throw new Error('send failed');
      this.sent.push(data);
    }

    ping() {
      setTimeout(() => {
        if (this.readyState === 1) this.emit('pong');
      }, 5);
    }

    close() {
      // Avkopplad socket: ws avbryter handskakningen och emittar 'error' på
      // nästa tick (klienten har en felsänka). Inga fler händelser i övrigt.
      for (const t of this._timers) clearTimeout(t);
      const varAnslutande = this.readyState === 0;
      this.readyState = 3;
      if (varAnslutande) setTimeout(() => this.emit('error', new Error('closed before established')), 0);
    }

    terminate() {
      if (this.readyState === 3) return;
      for (const t of this._timers) clearTimeout(t);
      this.readyState = 3;
      setTimeout(() => this.emit('close', 1006, Buffer.from('')), 0);
    }
  }
  FakeWS.CONNECTING = 0;
  FakeWS.OPEN = 1;
  FakeWS.CLOSING = 2;
  FakeWS.CLOSED = 3;
  FakeWS.instances = [];
  FakeWS.plan = [];
  FakeWS.defaultPlan = { typ: 'timeout' };
  return FakeWS;
});

const FakeWS = require('ws');
const AISStreamClient = require('../lib/connection/AISStreamClient');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const AISHubClient = require('../lib/connection/AISHubClient');

const KEY = 'a'.repeat(40);
const KEY2 = 'b'.repeat(40);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

async function advance(ms, step = SEC) {
  let left = ms;
  while (left > 0) {
    const d = Math.min(step, left);
    // eslint-disable-next-line no-await-in-loop
    await jest.advanceTimersByTimeAsync(d);
    left -= d;
  }
}

const levande = () => FakeWS.instances.filter((w) => w.readyState !== 3);

describe('U67: handskakningens tidsgräns', () => {
  test('socketen skapas med handshakeTimeout 30 s, under connect-deadlinen 60 s', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-26T12:00:00Z') });
    FakeWS.instances.length = 0;
    FakeWS.defaultPlan = { typ: 'timeout' };
    const c = new AISStreamClient({ log: () => {}, debug: () => {}, error: () => {} });
    c.on('error', () => {});
    await c.connect(KEY);
    expect(FakeWS.instances[0].opts.handshakeTimeout).toBe(30000);
    // Ingen timeout efter 20 s (gamla gränsen 15 s), men efter 30 s.
    await jest.advanceTimersByTimeAsync(20000);
    expect(FakeWS.instances[0].readyState).toBe(0);
    await jest.advanceTimersByTimeAsync(10500);
    expect(FakeWS.instances[0].readyState).toBe(3);
    c.disconnect();
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('K: felinjektion i återanslutningsvägen', () => {
  let logger;
  let maxLevande;
  let vakt;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-26T12:00:00Z') });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWS.instances.length = 0;
    FakeWS.plan.length = 0;
    FakeWS.defaultPlan = { typ: 'timeout' };
    logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    maxLevande = 0;
    // Räkna det största antalet samtidigt levande sockets varje sekund.
    vakt = setInterval(() => {
      maxLevande = Math.max(maxLevande, levande().length);
    }, 500);
  });

  afterEach(() => {
    clearInterval(vakt);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  }, 120000);

  test('handskakningen löper ut gång på gång i 3 h: trappan håller, en socket åt gången', async () => {
    const c = new AISStreamClient(logger);
    c.on('error', () => {});
    await c.connect(KEY);
    await advance(3 * HOUR, 5 * SEC);
    // 1 + 10 snabba + 12 i 5-minutersfasen + 1–2 timvisa
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(23);
    expect(FakeWS.instances.length).toBeLessThanOrEqual(26);
    expect(maxLevande).toBeLessThanOrEqual(1);
    expect(c.reconnectAttempts).toBeGreaterThan(22);
    c.disconnect();
    expect(c.reconnectTimer).toBeNull();
    expect(c._connectDeadlineTimer).toBeNull();
    const fore = FakeWS.instances.length;
    await advance(2 * HOUR, MIN);
    expect(FakeWS.instances.length).toBe(fore);
  }, 120000);

  test('vaktens omstart mitt i en handskakning: gamla socketens timeout rör inte den nya', async () => {
    FakeWS.plan.push({ typ: 'open', efterMs: 500 });
    const c = new AISStreamClient(logger);
    c.on('error', () => {});
    await c.connect(KEY);
    await advance(3 * SEC);
    expect(c.isConnected).toBe(true);
    // Vakten startar om; första nya försöket hänger, och mitt i det startar
    // vakten (eller ett nyckelbyte) om igen.
    FakeWS.plan.push({ typ: 'timeout' }, { typ: 'open', efterMs: 2000 });
    c.reconnectWithKey(KEY, 'watchdog');
    await advance(8 * SEC);
    const hangande = c.ws;
    expect(hangande.readyState).toBe(0);
    c.reconnectWithKey(KEY2, 'key-update');
    await advance(30 * SEC);
    expect(c.isConnected).toBe(true);
    expect(c.ws).not.toBe(hangande);
    expect(levande().length).toBe(1);
    expect(maxLevande).toBeLessThanOrEqual(2); // den gamla stängs i samma tick
    expect(c.reconnectTimer).toBeNull();
    // Prenumerationen gick ut med den nya nyckeln.
    expect(JSON.parse(c.ws.sent[0]).APIKey).toBe(KEY2);
    c.disconnect();
  }, 120000);

  test('omstart var femte sekund under en timme med hängande server: inga läckta sockets eller timers', async () => {
    const c = new AISStreamClient(logger);
    c.on('error', () => {});
    await c.connect(KEY);
    for (let i = 0; i < 720; i++) {
      c.reconnectWithKey(KEY, 'watchdog');
      // eslint-disable-next-line no-await-in-loop
      await advance(5 * SEC, 5 * SEC);
    }
    expect(maxLevande).toBeLessThanOrEqual(2);
    c.disconnect();
    await advance(MIN);
    expect(levande().length).toBe(0);
    expect(c.reconnectTimer).toBeNull();
    expect(c.pingTimer).toBeNull();
  }, 120000);

  test('onUninit mitt i handskakning och mitt i backoff: inga försök efteråt', async () => {
    for (const mitt of [5 * SEC, 20 * SEC]) {
      FakeWS.instances.length = 0;
      const c = new AISStreamClient(logger);
      c.on('error', () => {});
      // eslint-disable-next-line no-await-in-loop
      await c.connect(KEY);
      // eslint-disable-next-line no-await-in-loop
      await advance(mitt);
      c.disconnect();
      const n = FakeWS.instances.length;
      // eslint-disable-next-line no-await-in-loop
      await advance(3 * HOUR, MIN);
      expect(FakeWS.instances.length).toBe(n);
      expect(c.reconnectTimer).toBeNull();
      expect(c._stableTimer == null).toBe(true);
    }
  }, 120000);

  test('prenumerationen går inte att skicka: socketen rivs och trappan räknar vidare', async () => {
    FakeWS.defaultPlan = { typ: 'open', efterMs: 200, sendKastar: true };
    const c = new AISStreamClient(logger);
    c.on('error', () => {});
    await c.connect(KEY);
    await advance(10 * MIN, SEC);
    expect(maxLevande).toBeLessThanOrEqual(1);
    // Varje försök öppnar och rivs direkt; räknaren nollställs aldrig.
    expect(c.reconnectAttempts).toBeGreaterThanOrEqual(10);
    expect(logger.debug.mock.calls.some((a) => String(a[0]).includes('Connection stable'))).toBe(false);
    c.disconnect();
  }, 120000);

  test('OBSERVATION: server som accepterar, levererar inget och stänger efter 125 s nollställer trappan varje gång', async () => {
    FakeWS.defaultPlan = { typ: 'open', efterMs: 200, stangEfterMs: 125 * SEC };
    const c = new AISStreamClient(logger);
    c.on('error', () => {});
    await c.connect(KEY);
    await advance(HOUR, 5 * SEC);
    // Dokumenterar beteendet (RC-S1: 120 s överlevnad räknas som stabil, även
    // utan data). Ingen eskalering till 5-minutersfasen: cirka 28 handskakningar
    // i timmen så länge servern beter sig så.
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(25);
    expect(c.reconnectAttempts).toBeLessThanOrEqual(1);
    c.disconnect();
  }, 120000);

  test('muxen: båda källorna nere och AISHub svarar med skräp — inga kast, aggregatet nere, nedstängning städar', async () => {
    jest.spyOn(AISHubClient.prototype, '_httpGet').mockImplementation(() => Promise.resolve({ statusCode: 200, body: '<html>fel</html>' }));
    const store = {};
    const mux = new AISSourceMultiplexer(logger, {
      get: (k) => store[k] ?? null,
      set: (k, v) => {
        store[k] = v;
      },
    });
    mux.on('error', () => {});
    mux.on('server-error', () => {});
    const flanker = [];
    mux.on('connected', () => flanker.push('upp'));
    mux.on('disconnected', () => flanker.push('ned'));
    mux.applySourceConfig({ source: 'both', apiKey: KEY, aishubUsername: 'tester' });
    await advance(30 * MIN, 5 * SEC);
    expect(mux.isConnected).toBe(false);
    expect(flanker.includes('upp')).toBe(false);
    // Nyckelbyte mitt i återanslutningen.
    mux.applySourceConfig({ source: 'both', apiKey: KEY2, aishubUsername: 'tester' });
    await advance(2 * MIN, 5 * SEC);
    expect(maxLevande).toBeLessThanOrEqual(2);
    mux.disconnect();
    const n = FakeWS.instances.length;
    await advance(2 * HOUR, MIN);
    expect(FakeWS.instances.length).toBe(n);
    expect(mux._hubClient).toBeNull();
  }, 120000);
});
