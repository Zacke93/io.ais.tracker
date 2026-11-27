'use strict';

/**
 * =============================================================================
 * U66 (dirigentens beslut 2026-11-27): VAKTEN STARTAR OM AISSTREAM FÖRST NÄR
 * DET FINNS SKÄL
 * =============================================================================
 *
 * Fältprov 2 och 3 (november 2026): feed-vakten startade om en ansluten men
 * tyst AISstream 52 gånger (15 på 133 h, 37 på 56 h). Ingen gång lagade det
 * något: socketen levde (pong kom), AISstream hör bara var fjärde–femte
 * rapport från en förtöjd båt, och nästa position kom inte fortare efter en
 * omstart än från en slumpvis tidpunkt. I fältprov 3 kostade omstarterna 93
 * handskakningar som löpte ut och 66 minuter utan socket.
 *
 * Regeln: i läget 'both' kräver omstarten, utöver dagens tystnadströskel och
 * trappa, att AISHub under AISstream-tystnaden levererat minst 31 NYA
 * positioner (med AISstreams uppmätta täckning, 20–28 % per rapport, missar en
 * frisk AISstream 31 rapporter i rad med under 0,1 % sannolikhet). Undantag:
 * bara AISstream (eller skuggläge), och AISHub som inte svarar — då gäller
 * dagens regel. Tak: efter 120 min tystnad startas anslutningen om ändå.
 *
 * Riggen är U29-riggens: riktig AISStreamClient (fejkad ws), riktig
 * AISHubClient (fejkad HTTP), riktig mux och appens riktiga
 * _checkAISFeedHealth, en tick per minut. Ankomsterna är syntetiska.
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
const { UI_CONSTANTS } = require('../lib/constants');

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
  app._updateDeviceCapability = () => {};
  app.aisClient = mux;
  const reconnects = [];
  const origRwk = mux.reconnectWithKey.bind(mux);
  mux.reconnectWithKey = (k, r) => {
    reconnects.push(Date.now());
    return origRwk(k, r);
  };
  mux.applySourceConfig({ source, apiKey: KEY, aishubUsername: 'u' });
  const rig = {
    app, mux, reconnects, logs, tick: () => app._checkAISFeedHealth(),
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

const mins = (arr, S) => arr.map((t) => Math.round((t - S) / MIN));
const evidence = (rig) => rig.mux.getConnectionStats().perFeed.aisstream.silenceEvidence;

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

describe('U66: vaktens omstart kräver belägg från AISHub', () => {
  test('konstanterna: 31 nya positioner, tak 120 min', () => {
    expect(UI_CONSTANTS.STALE_FEED_RESTART_MIN_HUB_FIXES).toBe(31);
    expect(UI_CONSTANTS.STALE_FEED_RESTART_MAX_SILENCE_MS).toBe(120 * MIN);
  });

  test('31-gränsen räknar bara NYA positioner: en förtöjd båt med ny rapport var 195:e s ger omstart först vid ~100 min', async () => {
    // Pollen går var 65:e s; fixtiden byts var tredje poll. Hade dubbletterna
    // räknats hade 31 nåtts efter ~34 min.
    hub.boats = [{ ...MOORED, periodMs: 195 * SEC }];
    const rig = build();
    const S = await warm(rig);
    await run(rig, S + 50 * MIN);
    const ev = evidence(rig);
    expect(ev.hubNewFixes).toBeGreaterThanOrEqual(14);
    expect(ev.hubNewFixes).toBeLessThanOrEqual(16);
    expect(rig.reconnects).toEqual([]);
    await run(rig, S + 110 * MIN);
    expect(rig.reconnects).toHaveLength(1);
    const at = (rig.reconnects[0] - S) / MIN;
    expect(at).toBeGreaterThanOrEqual(98);
    expect(at).toBeLessThanOrEqual(104);
  }, 300000);

  test('beviskontot nollställs när AISstream levererar', async () => {
    hub.boats = [{ ...MOORED, periodMs: 65 * SEC }]; // en ny position per poll
    const rig = build();
    const S = await warm(rig);
    await run(rig, S + 30 * MIN);
    expect(evidence(rig).hubNewFixes).toBeGreaterThan(20);
    // AISstream levererar en gång 30 min in, sedan tystnad igen.
    await run(rig, S + 31 * MIN, { deliverAt: [S + 30 * MIN + 10 * SEC] });
    expect(evidence(rig).hubNewFixes).toBeLessThanOrEqual(1);
    expect(evidence(rig).sinceAt).toBe(S + 30 * MIN + 10 * SEC);
    await run(rig, S + 80 * MIN);
    // Dagens tröskel nås 50 min in (20 min efter leveransen) men beviset
    // (31 nya positioner sedan leveransen) först ~64 min in.
    expect(rig.reconnects).toHaveLength(1);
    const at = (rig.reconnects[0] - S) / MIN;
    expect(at).toBeGreaterThanOrEqual(62);
    expect(at).toBeLessThanOrEqual(66);
  }, 300000);

  test('AISHub nere och AISstream tyst: dagens regel (omstart vid 20 min)', async () => {
    const rig = build();
    const S = await warm(rig);
    hub.mode = 'down';
    await run(rig, S + 25 * MIN);
    expect(rig.mux.getConnectionStats().perFeed.aishub.isConnected).toBe(false);
    expect(mins(rig.reconnects, S)).toEqual([20]);
  }, 300000);

  test('bara AISstream: dagens regel, inget beviskonto', async () => {
    const rig = build('aisstream');
    const S = await warm(rig);
    await run(rig, S + 65 * MIN);
    expect(evidence(rig)).toBeNull();
    expect(mins(rig.reconnects, S)).toEqual([20, 61]);
  }, 300000);

  test('skuggläget räknas som bara AISstream: dagens regel', async () => {
    const rig = build('shadow');
    const S = await warm(rig);
    await run(rig, S + 25 * MIN);
    expect(evidence(rig)).toBeNull();
    expect(mins(rig.reconnects, S)).toEqual([20]);
  }, 300000);

  test('taket: AISHub svarar men levererar inget — omstart vid 120 min, sedan dagens trappa', async () => {
    const rig = build();
    const S = await warm(rig);
    hub.mode = 'empty';
    await run(rig, S + 119 * MIN);
    expect(rig.reconnects).toEqual([]);
    expect(rig.mux.getConnectionStats().perFeed.aishub.isConnected).toBe(true);
    await run(rig, S + 3 * HOUR);
    expect(mins(rig.reconnects, S)).toEqual([120, 161]);
    expect(rig.logs.some((l) => l.includes('tak'))).toBe(true);
  }, 300000);

  test('vakten agerar inte på en nedkopplad socket, hur starkt beviset än är', async () => {
    const rig = build();
    const S = await warm(rig);
    FakeWS.mode = 'unreachable';
    const { ws } = rig.mux._streamClient;
    ws.readyState = 3;
    ws.emit('close', 1006, Buffer.from(''));
    await run(rig, S + 3 * HOUR);
    expect(evidence(rig).hubNewFixes).toBeGreaterThan(31);
    expect(rig.reconnects).toEqual([]);
  }, 300000);

  test('ingen dubbel omstart medan en återanslutning pågår', async () => {
    const rig = build();
    const S = await warm(rig);
    FakeWS.mode = 'hang'; // nästa socket öppnar aldrig
    await run(rig, S + 60 * MIN);
    expect(mins(rig.reconnects, S)).toEqual([20]);
    expect(rig.mux._streamClient.isConnected).toBe(false);
  }, 300000);

  test('loggraden när vakten avstår skrivs en gång per tystnad', async () => {
    hub.boats = [{ ...MOORED, periodMs: 195 * SEC }];
    const rig = build();
    const S = await warm(rig);
    await run(rig, S + 60 * MIN);
    const held = rig.logs.filter((l) => l.includes('[FEED_WATCHDOG]') && l.includes('U66'));
    expect(held).toHaveLength(1);
    expect(held[0]).toContain('31');
  }, 300000);
});

describe('U66: fältets två lägen, syntetiska ankomster', () => {
  test('en förtöjd sändare som AISstream hör var femte gång: 0 omstarter på ett dygn', async () => {
    // Rapport var 3:e min. AISHub får varje rapport; AISstream hör var femte
    // i snitt (fast frö, så att tystnader på över 20 min förekommer).
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
    // Fröet ger tystnader över dagens tröskel (annars prövar fallet inget).
    expect(longest).toBeGreaterThan(UI_CONSTANTS.STALE_FEED_RECONNECT_MS + 5 * MIN);
    expect(longest).toBeLessThan(UI_CONSTANTS.STALE_FEED_RESTART_MAX_SILENCE_MS);
    await run(rig, S + DAY, { deliverAt });
    expect(rig.reconnects).toEqual([]);
  }, 600000);

  test('AISstream dör mitt i trafik: omstart vid 20 min', async () => {
    const moving = [0, 1, 2, 3].map((i) => ({
      mmsi: 211000010 + i, lat: 58.28 + i * 0.003, lon: 12.28 + i * 0.002, sog: 5, periodMs: 30 * SEC,
    }));
    hub.boats = moving;
    const rig = build();
    const S0 = Date.now();
    const deliverAt = [];
    for (let t = S0 + MIN; t < S0 + 30 * MIN; t += 40 * SEC) deliverAt.push(t);
    await run(rig, S0 + 30 * MIN, { deliverAt, boat: moving[0] });
    const S = deliverAt[deliverAt.length - 1];
    await run(rig, S + 30 * MIN);
    expect(mins(rig.reconnects, S)).toEqual([20]);
    expect(rig.logs.some((l) => l.includes('[FEED_WATCHDOG] aisstream: no messages'))).toBe(true);
  }, 300000);
});
