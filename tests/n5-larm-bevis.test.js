'use strict';

/**
 * =============================================================================
 * N5 (förslag till ägaren, omgång 9 spår K): TIDSLINJEMEDDELANDET OCH STATUSEN
 * "DEGRADERAD" FÖR AISSTREAM-TYSTNAD KRÄVER BELÄGG FRÅN AISHUB
 * =============================================================================
 *
 * U29 (ägarbeslut 2026-11-15): basnotisen 'aisstream:silent', trappan (1 h,
 * 4 h, dygn) och statusen 'degraded' går ut när AISstream varit tyst i 25 min
 * medan AISHub levererar. På 476 h inspelad trafik gav villkoret 9
 * meddelanden; 2 pekade på verkliga fel, 7 kom när bara förtöjda båtar fanns
 * och AISstream levererade igen inom 1–14 min. N5 kräver dessutom minst 40
 * nya AISHub-positioner under tystnaden (2 meddelanden, båda verkliga).
 * Samma villkor för notisen, trappan och statusen (B2c). Utan beviskonto
 * (bara AISstream, skuggläge) gäller U29 som förut.
 *
 * Riggen är U66-provets (riktiga klienter, en tick per minut).
 */

jest.mock('homey');

jest.mock('ws', () => {
  const EventEmitter = require('events');
  class FakeWS extends EventEmitter {
    constructor() {
      super();
      FakeWS.instances.push(this);
      this.readyState = 0;
      const { mode } = FakeWS;
      setTimeout(() => FakeWS.play(this, mode), 300);
    }

    static play(ws, mode) {
      if (ws.readyState === 3) return;
      if (mode === 'unreachable') {
        const err = new Error('connect ENETUNREACH 1.2.3.4:443');
        err.code = 'ENETUNREACH';
        ws.emit('error', err);
        ws.readyState = 3;
        ws.emit('close', 1006, Buffer.from(''));
      } else if (mode === 'hang') {
        // Servern svarar aldrig på uppgraderingen (klientens deadline river).
      } else {
        ws.readyState = 1;
        ws.emit('open');
      }
    }

    send() {}

    ping() {
      setTimeout(() => {
        if (this.readyState === 1) this.emit('pong');
      }, 20);
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
  FakeWS.mode = 'ok';
  return FakeWS;
});

const FakeWS = require('ws');
const AISBridgeApp = require('../app');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const AISHubClient = require('../lib/connection/AISHubClient');
const { CONNECTION_ALERT } = require('../lib/constants');

const KEY = 'k'.repeat(40);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-27T08:00:07.000Z');

// Syntetiska fartyg (inga verkliga MMSI eller positioner).
const MOORED = { mmsi: 211000001, lat: 58.2701, lon: 12.2702 };
const MOORED2 = { mmsi: 211000002, lat: 58.2711, lon: 12.2712 };

/**
 * AISHub-läget. `boats`: [{ mmsi, lat, lon, sog, periodMs }], där fixtiden byts
 * var periodMs (en ny rapport); `mode`: 'ok' | 'down' | 'empty'.
 */
const hub = { mode: 'ok', boats: [] };

function hubTime(periodMs) {
  const d = new Date(Math.floor(Date.now() / periodMs) * periodMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
}

function hubResponse() {
  if (hub.mode === 'down') {
    const err = new Error('connect ENETUNREACH 1.2.3.4:443');
    err.code = 'ENETUNREACH';
    return Promise.reject(err);
  }
  const recs = hub.mode === 'empty' ? [] : hub.boats.map((b) => ({
    MMSI: b.mmsi,
    TIME: hubTime(b.periodMs || SEC),
    LATITUDE: b.lat,
    LONGITUDE: b.lon,
    COG: 200,
    SOG: b.sog || 0,
    NAVSTAT: b.sog ? 0 : 5,
    NAME: `TEST${b.mmsi % 1000}`,
  }));
  const body = JSON.stringify([
    {
      ERROR: false, USERNAME: 'u', FORMAT: 'HUMAN', RECORDS: recs.length,
    },
    recs,
  ]);
  return Promise.resolve({ statusCode: 200, body });
}

function streamMsg(b = MOORED) {
  return JSON.stringify({
    MessageType: 'PositionReport',
    MetaData: {
      MMSI: b.mmsi, Latitude: b.lat, Longitude: b.lon, ShipName: 'TEST', time_utc: new Date().toISOString(),
    },
    Message: {
      PositionReport: {
        UserID: b.mmsi, Latitude: b.lat, Longitude: b.lon, Sog: b.sog || 0, Cog: 200, NavigationalStatus: 5, Valid: true,
      },
    },
  });
}

let rigs = [];

function build(source = 'both') {
  const store = {};
  const mux = new AISSourceMultiplexer(
    { log: () => {}, debug: () => {}, error: () => {} },
    {
      get: (k) => store[k] ?? null,
      set: (k, v) => {
        store[k] = v;
      },
      unset: (k) => {
        delete store[k];
      },
    },
  );
  mux.on('error', () => {});
  const app = new AISBridgeApp();
  const logs = [];
  app.log = (...a) => logs.push(a.join(' '));
  app.error = () => {};
  app.debug = () => {};
  const settings = { ais_api_key: KEY, ais_source: source, aishub_username: 'u' };
  const astore = {};
  app.homey = {
    settings: {
      get: (k) => settings[k] ?? astore[k] ?? null,
      set: (k, v) => {
        astore[k] = JSON.parse(JSON.stringify(v));
      },
      on: () => {},
    },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  app._isConnected = true;
  app._sourceEverResponded = true;
  app._lastConnectionStatus = 'connected';
  const ev = [];
  app._updateDeviceCapability = (cap, value) => {
    if (cap === 'connection_status') ev.push({ t: Date.now(), k: 'STATUS', text: value });
  };
  const origNotify = app._notifyConnectionIssue.bind(app);
  app._notifyConnectionIssue = (message, key) => {
    const before = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    const p = origNotify(message, key);
    const after = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    if (after !== before) ev.push({ t: Date.now(), k: key, text: message });
    return p;
  };
  app.aisClient = mux;
  const reconnects = [];
  const origRwk = mux.reconnectWithKey.bind(mux);
  mux.reconnectWithKey = (k, r) => {
    reconnects.push(Date.now());
    return origRwk(k, r);
  };
  mux.applySourceConfig({ source, apiKey: KEY, aishubUsername: 'u' });
  const rig = {
    app, mux, reconnects, logs, ev, tick: () => app._checkAISFeedHealth(),
  };
  rigs.push(rig);
  return rig;
}

/** Minut för minut; AISstream levererar (från `boat`) vid tiderna i deliverAt. */
async function run(rig, toMs, { deliverAt = [], boat = MOORED } = {}) {
  const pending = [...deliverAt].sort((a, b) => a - b);
  while (Date.now() < toMs) {
    const next = Math.min(Date.now() + MIN, toMs);
    while (pending.length && pending[0] <= next) {
      const t = pending.shift();
      if (t > Date.now()) {
        // eslint-disable-next-line no-await-in-loop
        await jest.advanceTimersByTimeAsync(t - Date.now());
      }
      const { ws } = rig.mux._streamClient;
      if (ws && ws.readyState === 1) ws.emit('message', streamMsg(boat));
    }
    // eslint-disable-next-line no-await-in-loop
    await jest.advanceTimersByTimeAsync(next - Date.now());
    rig.tick();
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/** 30 min med AISstream var 3:e min. Returnerar tiden för sista leveransen. */
async function warm(rig) {
  const start = Date.now();
  const deliverAt = [];
  for (let t = start + 2 * MIN; t < start + 30 * MIN; t += 3 * MIN) deliverAt.push(t);
  await run(rig, start + 30 * MIN, { deliverAt });
  return deliverAt[deliverAt.length - 1];
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  jest.spyOn(Math, 'random').mockReturnValue(0);
  jest.spyOn(AISHubClient.prototype, '_httpGet').mockImplementation(() => hubResponse());
  FakeWS.instances.length = 0;
  FakeWS.mode = 'ok';
  hub.mode = 'ok';
  hub.boats = [MOORED, MOORED2];
  rigs = [];
});

afterEach(() => {
  for (const rig of rigs) rig.mux.disconnect();
  rigs = [];
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const sent = (rig) => rig.ev.filter((e) => e.k !== 'STATUS');
const status = (rig) => rig.ev.filter((e) => e.k === 'STATUS');

describe('N5: AISstream-larmet kräver 40 nya AISHub-positioner under tystnaden', () => {
  test('konstanten är 40', () => {
    expect(CONNECTION_ALERT.AISSTREAM_SILENCE_ALERT_MIN_HUB_FIXES).toBe(40);
  });

  test('en förtöjd båt var 3:e min: inget larm och ingen "Degraderad" vid 26 min, larm när beviset når 40', async () => {
    hub.boats = [{ ...MOORED, periodMs: 3 * MIN }];
    const rig = build();
    const S = await warm(rig);
    await run(rig, S + 60 * MIN);
    expect(sent(rig)).toEqual([]);
    expect(status(rig)).toEqual([]);
    // 40 nya positioner med en rapport var 3:e min: cirka 120 min.
    await run(rig, S + 2 * HOUR + 10 * MIN);
    const base = sent(rig).filter((e) => e.k === 'aisstream:silent');
    expect(base).toHaveLength(1);
    const at = (base[0].t - S) / MIN;
    expect(at).toBeGreaterThanOrEqual(117);
    expect(at).toBeLessThanOrEqual(124);
    // Statusen i samma tick (B2c), och trappans 1 h-nivå (redan passerad)
    // kommer i samma tick, efter basnotisen.
    expect(status(rig).map((e) => [e.text, Math.round((e.t - S) / MIN)])).toEqual([['degraded', Math.round(at)]]);
    expect(sent(rig).map((e) => e.k)).toEqual(['aisstream:silent', 'aisstream:silent:1h']);
  }, 300000);

  test('trafik med flera båtar: larmet vid 26 min som med U29', async () => {
    // Två båtar med ny position varje poll: 40 nya positioner efter ~22 min.
    const rig = build();
    const S = await warm(rig);
    await run(rig, S + 30 * MIN);
    expect(sent(rig).map((e) => [e.k, Math.round((e.t - S) / MIN)])).toEqual([['aisstream:silent', 26]]);
    expect(status(rig).map((e) => e.text)).toEqual(['degraded']);
  }, 300000);

  test('skuggläget: U29 som förut (inget beviskonto)', async () => {
    hub.boats = [{ ...MOORED, periodMs: 3 * MIN }];
    const rig = build('shadow');
    const S = await warm(rig);
    await run(rig, S + 30 * MIN);
    expect(sent(rig).map((e) => [e.k, Math.round((e.t - S) / MIN)])).toEqual([['aisstream:silent:shadow', 26]]);
  }, 300000);

  test('en förtöjd sändare som AISstream hör var femte gång: inga meddelanden och ingen "Degraderad" på ett dygn', async () => {
    hub.boats = [{ ...MOORED, periodMs: 3 * MIN }];
    const rig = build();
    const S = Date.now();
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const deliverAt = [];
    let last = S;
    let longest = 0;
    for (let t = S + 3 * MIN; t < S + DAY; t += 3 * MIN) {
      if (rnd() < 0.2) {
        deliverAt.push(t + 5 * SEC);
        longest = Math.max(longest, t - last);
        last = t;
      }
    }
    // Fröet ger minst en tystnad över U29:s gräns (annars prövar fallet inget).
    expect(longest).toBeGreaterThan(CONNECTION_ALERT.AISSTREAM_CROSS_SILENCE_ALERT_MS + 2 * MIN);
    await run(rig, S + DAY, { deliverAt });
    expect(sent(rig)).toEqual([]);
    expect(status(rig)).toEqual([]);
  }, 600000);
});
