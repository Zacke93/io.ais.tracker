'use strict';

/**
 * =============================================================================
 * U29 GENOM RIKTIGA KLIENTER — AISstream-korstystnaden hela vägen från socketen
 * =============================================================================
 *
 * Granskningen av U29 (2026-11-15, anmärkning L5) byggde den här riggen och
 * den är nu ett permanent prov. Inget i perFeed är stubbat:
 *  • riktig AISStreamClient med fejkad `ws` (öppnar, pongar eller inte, eller
 *    är onåbar) — pingvakten, pongstämpeln och återanslutningen är produktionens;
 *  • riktig AISHubClient med fejkad HTTP (två förtöjda båtar, ny TIME varje
 *    poll — vinterns läge: AISHub flödar, ingen båt rör sig);
 *  • riktig AISSourceMultiplexer och appens riktiga _checkAISFeedHealth, en
 *    tick per minut med fejkade timrar.
 * Varje tick bokför riggen om notisvillkoret gällde (anropet
 * _notifyConnectionIssue('aisstream:silent'), före 24 h-dedupen) och vilket
 * värde _applyConnectionDegradedState fick, så B2c (samma villkor för status
 * och notis) jämförs tick för tick.
 *
 * Fallen ur granskningens tabell:
 *  (a) verkligt död men pongande AISstream i ett dygn: vakten 20 min, larm och
 *      "Degraderad" i samma tick vid första ticken över 25 min, ny text,
 *      sedan 1 h / 4 h / 1 dygn;
 *  (b) socketen uppe men pongar inte: pingvakten dödar den, gamla texten;
 *  (c) socketen nere, klienten i backoff: gamla texten;
 *  (d) vaktens återanslutning nollställer inte tystnaden (ingår i a);
 *  (e) ett meddelande var 24:e min: aldrig larm; var 27:e min: korta
 *      "Degraderad" med samma villkor som notisen;
 *  (f) servern stänger socketen 5 min in: larmet före vaktens ingrepp (det
 *      dokumenterade undantaget, upptidsklockan);
 *  skuggläget: 'aisstream:silent:shadow' vid samma gräns;
 *  klocksteg bakåt efter larmet: statusen står kvar (släppet läser 15 min).
 * Tystnaderna är syntetiska; fältets tidsserier ligger inte i repot.
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
      } else {
        ws.readyState = 1;
        ws.emit('open');
      }
    }

    send() {}

    ping() {
      if (!FakeWS.pong) return;
      setTimeout(() => {
        if (this.readyState === 1) this.emit('pong');
      }, FakeWS.pongDelayMs);
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
  FakeWS.pong = true;
  FakeWS.pongDelayMs = 20;
  return FakeWS;
});

const FakeWS = require('ws');
const AISBridgeApp = require('../app');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const AISHubClient = require('../lib/connection/AISHubClient');

const KEY = 'k'.repeat(40);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const NY_TEXT = (n) => `AIS Tracker: AISstream är ansluten men har inte levererat några positioner på ${n} `
  + 'medan AISHub flödar. Appens vakter försöker återansluta automatiskt.';
const GAMMAL_TEXT = (n) => `AIS Tracker: AISstream har inte levererat några positioner på ${n} `
  + 'medan AISHub flödar — anslutningen kan vara halvdöd. Appens vakter försöker återansluta automatiskt.';

/** AISHub-svar: två förtöjda båtar med ny TIME varje poll. */
function hubBody() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
  const rec = (mmsi, lat) => ({
    MMSI: mmsi, TIME: time, LATITUDE: lat, LONGITUDE: 12.267, COG: 200, SOG: 0, NAVSTAT: 5, NAME: `B${mmsi}`,
  });
  return JSON.stringify([
    {
      ERROR: false, USERNAME: 'u', FORMAT: 'HUMAN', RECORDS: 2,
    },
    [rec(265012090, 58.26729), rec(265552060, 58.26801)],
  ]);
}

/** En AISstream-positionsrapport från en förtöjd båt. */
function streamMsg(mmsi = 265606970) {
  return JSON.stringify({
    MessageType: 'PositionReport',
    MetaData: {
      MMSI: mmsi, Latitude: 58.2674, Longitude: 12.2669, ShipName: 'PILOT', time_utc: new Date().toISOString(),
    },
    Message: {
      PositionReport: {
        UserID: mmsi, Latitude: 58.2674, Longitude: 12.2669, Sog: 0, Cog: 231, NavigationalStatus: 5, Valid: true,
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
  app.log = () => {};
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
  app.aisClient = mux;
  const ev = []; // skickade notiser och statusskrivningar
  app._updateDeviceCapability = (cap, value) => {
    if (cap === 'connection_status') ev.push({ t: Date.now(), k: 'STATUS', text: value });
  };
  const ticks = [];
  let cur = null;
  const origNotify = app._notifyConnectionIssue.bind(app);
  app._notifyConnectionIssue = (message, key) => {
    const before = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    const p = origNotify(message, key);
    const after = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    if (cur) cur.called.push(key);
    if (after !== before) ev.push({ t: Date.now(), k: key, text: message });
    return p;
  };
  const origApply = app._applyConnectionDegradedState.bind(app);
  app._applyConnectionDegradedState = (d) => {
    if (cur) cur.degraded = !!d;
    return origApply(d);
  };
  const reconnects = []; // feed-vaktens ingrepp
  const origRwk = mux.reconnectWithKey.bind(mux);
  mux.reconnectWithKey = (k, r) => {
    reconnects.push(Date.now());
    return origRwk(k, r);
  };
  mux.applySourceConfig({ source, apiKey: KEY, aishubUsername: 'u' });
  function tick() {
    cur = { t: Date.now(), called: [], degraded: null };
    app._checkAISFeedHealth();
    ticks.push(cur);
    cur = null;
  }
  const rig = {
    app, mux, ev, ticks, reconnects, tick,
  };
  rigs.push(rig);
  return rig;
}

/** Kör minut för minut; AISstream levererar vid tiderna i deliverAt. */
async function run(rig, fromMs, toMs, { deliverAt = [] } = {}) {
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
      if (ws && ws.readyState === 1) ws.emit('message', streamMsg());
    }
    // eslint-disable-next-line no-await-in-loop
    await jest.advanceTimersByTimeAsync(next - Date.now());
    if (Date.now() >= fromMs) rig.tick();
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/** Flöde före tystnaden: ett AISstream-meddelande var 3:e min. Returnerar sista. */
async function warm(rig, minutes = 30) {
  const start = Date.now();
  const deliverAt = [];
  for (let t = start + 2 * MIN; t < start + minutes * MIN; t += 3 * MIN) deliverAt.push(t);
  await run(rig, start + 5 * MIN, start + minutes * MIN, { deliverAt });
  return deliverAt[deliverAt.length - 1];
}

/** Tick där status och notisvillkor skiljer sig (B2c). */
const b2cMismatch = (rig, from = -Infinity) => rig.ticks
  .filter((t) => t.t >= from && t.degraded !== t.called.includes('aisstream:silent'))
  .map((t) => t.t);
const minutesAfter = (t, S) => (t - S) / MIN;

const T0 = Date.parse('2026-11-20T08:00:07.000Z');

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  jest.spyOn(Math, 'random').mockReturnValue(0);
  jest.spyOn(AISHubClient.prototype, '_httpGet')
    .mockImplementation(() => Promise.resolve({ statusCode: 200, body: hubBody() }));
  FakeWS.instances.length = 0;
  FakeWS.mode = 'ok';
  FakeWS.pong = true;
  rigs = [];
});

afterEach(() => {
  for (const rig of rigs) rig.mux.disconnect();
  rigs = [];
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('U29 E2E genom riktiga klienter', () => {
  test('(a)+(d) verkligt död men pongande AISstream ett dygn: vakten 20 min, larm 26 min med ny text, trappan som förut', async () => {
    const rig = build();
    const S = await warm(rig);
    await run(rig, S, S + DAY + 5 * MIN);

    // (d) Feed-vakten återansluter först vid 20 min, sedan med backoff —
    // och återanslutningarna nollställer inte tystnaden.
    expect(rig.reconnects.slice(0, 3).map((r) => minutesAfter(r, S))).toEqual([20, 61, 142]);
    const sent = rig.ev.filter((e) => e.k !== 'STATUS');
    expect(sent.map((e) => [e.k, minutesAfter(e.t, S)])).toEqual([
      ['aisstream:silent', 26],
      ['aisstream:silent:1h', 60],
      ['aisstream:silent:4h', 240],
      ['aisstream:silent:1 dygn', 1440],
    ]);
    // Socketen pongar ⇒ den nya texten, utan "halvdöd".
    expect(sent[0].text).toBe(NY_TEXT('26 min'));
    // "Degraderad" i samma tick som basnotisen, och bara en gång.
    expect(rig.ev.filter((e) => e.k === 'STATUS').map((e) => [e.text, minutesAfter(e.t, S)]))
      .toEqual([['degraded', 26]]);
    expect(b2cMismatch(rig)).toEqual([]);
  }, 300000);

  test('(b) socketen uppe men pongar INTE: pingvakten dödar den, feed-vakten ingriper aldrig, gamla texten vid 26 min', async () => {
    const rig = build();
    const S = await warm(rig);
    FakeWS.pong = false;
    await run(rig, S, S + 90 * MIN);

    expect(FakeWS.instances.length).toBeGreaterThan(10); // en ny socket ungefär varje minut
    expect(rig.reconnects).toEqual([]); // upptiden når aldrig 20 min
    const base = rig.ev.filter((e) => e.k === 'aisstream:silent');
    expect(base.map((e) => minutesAfter(e.t, S))).toEqual([26]);
    expect(base[0].text).toBe(GAMMAL_TEXT('26 min'));
    expect(b2cMismatch(rig)).toEqual([]);
  }, 300000);

  test('(c) socketen nere och klienten i backoff: gamla texten vid 26 min, trappan som förut', async () => {
    const rig = build();
    const S = await warm(rig);
    FakeWS.mode = 'unreachable';
    const { ws } = rig.mux._streamClient;
    ws.readyState = 3;
    ws.emit('close', 1006, Buffer.from(''));
    await run(rig, S, S + 5 * HOUR);

    const sent = rig.ev.filter((e) => e.k !== 'STATUS');
    expect(sent.map((e) => [e.k, minutesAfter(e.t, S)])).toEqual([
      ['aisstream:silent', 26],
      ['aisstream:silent:1h', 60],
      ['aisstream:silent:4h', 240],
    ]);
    expect(sent[0].text).toBe(GAMMAL_TEXT('26 min'));
    expect(rig.reconnects).toEqual([]);
    expect(b2cMismatch(rig)).toEqual([]);
  }, 300000);

  test('(e) ett meddelande var 24:e min i 12 h: aldrig larm; var 27:e min: korta "Degraderad" med samma villkor som notisen', async () => {
    const outcome = {};
    for (const every of [24, 27]) {
      const rig = build();
      // eslint-disable-next-line no-await-in-loop
      const S = await warm(rig);
      const deliverAt = [];
      for (let t = S + every * MIN; t < S + 12 * HOUR; t += every * MIN) deliverAt.push(t);
      // eslint-disable-next-line no-await-in-loop
      await run(rig, S, S + 12 * HOUR, { deliverAt });
      outcome[every] = {
        status: rig.ev.filter((e) => e.k === 'STATUS').length,
        notiser: rig.ev.filter((e) => e.k !== 'STATUS').map((e) => e.k),
        b2c: b2cMismatch(rig),
      };
    }
    expect(outcome[24]).toEqual({ status: 0, notiser: [], b2c: [] });
    // 27 min: varje uppehåll ger en kort episod (sätts vid 26, släpps vid
    // leveransen), notisen går en gång (24 h-dedupen), och villkoren är lika.
    expect(outcome[27].notiser).toEqual(['aisstream:silent']);
    expect(outcome[27].status).toBeGreaterThanOrEqual(2 * 25);
    expect(outcome[27].b2c).toEqual([]);
  }, 300000);

  test('(f) servern stänger socketen 5 min in, klienten återansluter, sedan tyst: larmet före vaktens ingrepp', async () => {
    const rig = build();
    const S = await warm(rig);
    await run(rig, S, S + 5 * MIN + 10 * SEC);
    const { ws } = rig.mux._streamClient;
    ws.readyState = 3;
    ws.emit('close', 1000, Buffer.from('server restart'));
    await run(rig, Date.now(), S + 40 * MIN);

    const base = rig.ev.filter((e) => e.k === 'aisstream:silent');
    expect(base).toHaveLength(1);
    const alarmAt = minutesAfter(base[0].t, S);
    expect(alarmAt).toBeGreaterThan(25);
    expect(alarmAt).toBeLessThan(26);
    // Den nya socketen pongar ⇒ ny text.
    expect(base[0].text).toBe(NY_TEXT('25 min'));
    // Feed-vakten mäter mot den nya socketens upptid och ingriper först efter
    // larmet — det dokumenterade undantaget i ARCHITECTURE §K22/U29.
    expect(rig.reconnects.length).toBeGreaterThanOrEqual(1);
    expect(rig.reconnects[0]).toBeGreaterThan(base[0].t);
    expect(b2cMismatch(rig)).toEqual([]);
  }, 300000);

  test('skuggläget: aisstream:silent:shadow vid samma gräns, oförändrad text, ingen status', async () => {
    const rig = build('shadow');
    const S = await warm(rig);
    await run(rig, S, S + 40 * MIN);

    const sent = rig.ev.filter((e) => e.k !== 'STATUS');
    expect(sent.map((e) => [e.k, minutesAfter(e.t, S)])).toEqual([['aisstream:silent:shadow', 26]]);
    expect(sent[0].text).toContain('AISstream har inte levererat några positioner på 26 min');
    expect(sent[0].text).toContain('inte emot båtdata');
    expect(sent[0].text).not.toContain('halvdöd');
    expect(rig.ev.filter((e) => e.k === 'STATUS')).toEqual([]);
  }, 300000);

  test('klocksteg bakåt 10 min efter larmet: "Degraderad" står kvar (släppet läser 15 min) tills AISstream levererar', async () => {
    // B2c:s likhet förutsätter en klocka som inte går bakåt. Efter steget visar
    // tystnaden 17–23 min: under larmgränsen 25 men över släppgränsen 15.
    // Statusen står då kvar medan notisvillkoret är falskt — åt det försiktiga
    // hållet, den verkliga tystnaden är 27 min. Ett släpp på 25 min hade skrivit
    // "connected" här; provet låser att släppet läser 15.
    const rig = build();
    const S = await warm(rig);
    await run(rig, S, S + 27 * MIN);
    expect(rig.app._connectionFeedDegraded).toBe(true);

    jest.setSystemTime(Date.now() - 10 * MIN);
    const back = Date.now();
    const before = rig.ticks.length; // tickarna efter steget (tiderna upprepas)
    await run(rig, back, back + 6 * MIN);
    const after = rig.ticks.slice(before);
    expect(after.length).toBeGreaterThanOrEqual(5);
    expect(after.every((x) => x.degraded === true)).toBe(true);
    expect(after.some((x) => x.called.includes('aisstream:silent'))).toBe(false);
    expect(rig.ev.filter((e) => e.k === 'STATUS').map((e) => e.text)).toEqual(['degraded']);

    // Leverans släpper statusen.
    const t = Date.now() + 10 * SEC;
    await run(rig, Date.now(), Date.now() + 2 * MIN, { deliverAt: [t] });
    expect(rig.ev.filter((e) => e.k === 'STATUS').map((e) => e.text)).toEqual(['degraded', 'connected']);
  }, 300000);
});
