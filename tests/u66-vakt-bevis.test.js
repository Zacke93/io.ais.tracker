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
const { UI_CONSTANTS, CONNECTION_ALERT } = require('../lib/constants');

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
 * var periodMs (en ny rapport); `mode`: 'ok' | 'down' | 'empty' | 'stale'
 * (posterna har en frusen fixtid två timmar bakåt: en död station i AISHubs
 * cache) | 'every' (svarar välformat bara var `every`:e poll, annars nätfel).
 */
const hub = { mode: 'ok', boats: [], every: 1 };
let pollNo = 0;

function hubTime(periodMs, fixedAt = null) {
  const d = new Date(fixedAt !== null ? fixedAt : Math.floor(Date.now() / periodMs) * periodMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
}

function hubResponse() {
  pollNo++;
  if (hub.mode === 'every' && pollNo % hub.every !== 0) {
    const err = new Error('connect ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    return Promise.reject(err);
  }
  if (hub.mode === 'down') {
    const err = new Error('connect ENETUNREACH 1.2.3.4:443');
    err.code = 'ENETUNREACH';
    return Promise.reject(err);
  }
  const stale = hub.mode === 'stale';
  const recs = hub.mode === 'empty' ? [] : hub.boats.map((b) => ({
    MMSI: b.mmsi,
    TIME: stale ? hubTime(DAY, T0 - 2 * HOUR) : hubTime(b.periodMs || SEC),
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

/**
 * @param {string} source
 * @param {{burnNotices?: boolean}} [opts] - burnNotices (standard): AISstream-
 *   tystnadens notisnycklar är redan förbrukade (dygnsspärren), så att provet
 *   mäter vaktens grind ensam. Proven av ordningen vakt före larm bygger utan.
 */
function build(source = 'both', { burnNotices = true } = {}) {
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
  const ev = [];
  const origNotify = app._notifyConnectionIssue.bind(app);
  app._notifyConnectionIssue = (message, key) => {
    const before = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    const p = origNotify(message, key);
    const after = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    if (after !== before) ev.push({ t: Date.now(), k: key, text: message });
    return p;
  };
  if (burnNotices) {
    const keys = ['aisstream:silent', ...CONNECTION_ALERT.ESCALATION_STEPS.map((x) => `aisstream:silent:${x.label}`)];
    app._connectionIssueNotifiedAt = new Map(keys.map((k) => [k, T0 + 7 * DAY]));
  }
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

const mins = (arr, S) => arr.map((t) => Math.round((t - S) / MIN));
const evidence = (rig) => rig.mux.getConnectionStats().perFeed.aisstream.silenceEvidence;

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  jest.spyOn(Math, 'random').mockReturnValue(0);
  jest.spyOn(AISHubClient.prototype, '_httpGet').mockImplementation(() => hubResponse());
  FakeWS.instances.length = 0;
  FakeWS.mode = 'ok';
  hub.mode = 'ok';
  hub.every = 1;
  pollNo = 0;
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

  test('taket: AISHub levererar glest (en ny position var 10:e min) — omstart vid 120 min, sedan dagens trappa', async () => {
    hub.boats = [{ ...MOORED, periodMs: 10 * MIN }];
    const rig = build();
    const S = await warm(rig);
    await run(rig, S + 119 * MIN);
    expect(rig.reconnects).toEqual([]);
    expect(evidence(rig).hubNewFixes).toBeLessThan(UI_CONSTANTS.STALE_FEED_RESTART_MIN_HUB_FIXES);
    await run(rig, S + 3 * HOUR);
    expect(mins(rig.reconnects, S)).toEqual([120, 161]);
    expect(rig.logs.some((l) => l.includes('[U66: tak'))).toBe(true);
  }, 300000);

  test('K1: AISHub svarar tomt — dagens regel (omstart vid 20 min), inte taket', async () => {
    const rig = build();
    const S = await warm(rig);
    hub.mode = 'empty';
    await run(rig, S + 65 * MIN);
    expect(rig.mux.getConnectionStats().perFeed.aishub.isConnected).toBe(true);
    expect(mins(rig.reconnects, S)).toEqual([20, 61]);
    expect(rig.logs.some((l) => l.includes('AISHub levererar inga nya positioner'))).toBe(true);
  }, 300000);

  test('K1: AISHub svarar bara med gamla fixar (död station i cachen) — dagens regel', async () => {
    const rig = build();
    const S = await warm(rig);
    hub.mode = 'stale';
    await run(rig, S + 65 * MIN);
    expect(rig.mux.getConnectionStats().perFeed.aishub.isConnected).toBe(true);
    expect(mins(rig.reconnects, S)).toEqual([20, 61]);
  }, 300000);

  test('K5: byte av AISHub-användarnamn mitt i tystnaden — räkningen börjar om', async () => {
    hub.boats = [0, 1, 2, 3].map((i) => ({
      mmsi: 211000020 + i, lat: 58.28 + i * 0.003, lon: 12.28 + i * 0.002, periodMs: 65 * SEC,
    }));
    const rig = build();
    const S = await warm(rig);
    await run(rig, S + 10 * MIN);
    const fore = evidence(rig);
    expect(fore.hubNewFixes).toBeGreaterThan(30);
    rig.mux.applySourceConfig({ source: 'both', apiKey: KEY, aishubUsername: 'u2' });
    await jest.advanceTimersByTimeAsync(2 * SEC);
    const efter = evidence(rig);
    expect(efter.hubNewFixes).toBeLessThan(5);
    expect(efter.sinceAt).toBe(fore.sinceAt); // tystnadens start står kvar
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

describe('U66: grindens belägg för att AISHub lever (K1, K5)', () => {
  const NOW = T0 + 5 * HOUR;
  const app = new AISBridgeApp();
  app.log = () => {};
  const ev = (fixes, silenceMin = 30) => ({ sinceAt: NOW - silenceMin * MIN, hubNewFixes: fixes });
  const hubOk = (over = {}) => ({
    configured: true, isConnected: true, lastOkResponseAt: NOW - 30 * SEC, lastMessageTime: NOW - 2 * MIN, ...over,
  });
  test.each([
    ['frisk AISHub, för lite bevis', ev(10), hubOk(), false],
    ['frisk AISHub, 31 nya positioner', ev(31), hubOk(), true],
    ['frisk AISHub, taket 120 min', ev(10, 120), hubOk(), true],
    ['isConnected kvar men senaste svar 5 min gammalt', ev(10), hubOk({ lastOkResponseAt: NOW - 5 * MIN }), true],
    ['svar färskt men isConnected nere', ev(10), hubOk({ isConnected: false }), true],
    ['inget svar alls ännu', ev(10), hubOk({ lastOkResponseAt: null }), true],
    ['senaste nya position 16 min gammal', ev(10), hubOk({ lastMessageTime: NOW - 16 * MIN }), true],
    ['aldrig någon ny position', ev(10), hubOk({ lastMessageTime: null }), true],
    ['hubben inte konfigurerad', ev(10), hubOk({ configured: false }), true],
    ['inget beviskonto', null, hubOk(), true],
  ])('%s ⇒ omstart %s', (namn, evidence, hubStats, expected) => {
    expect(app._aisstreamRestartGate(evidence, hubStats, NOW).restart).toBe(expected);
  });
});

/**
 * Ordningen vakt före larm (U66 + U73): tystnadens första AISstream-notis
 * (basnotisen, eller en nivå om den kommer först) ska ha en vaktomstart före
 * sig under tystnaden. Vakten körs före korstystnaden i samma tick, så en
 * omstart i notisens tick räknas som före. Senare nivåer i trappan (1 h, 4 h,
 * dygn) kräver ingen ny omstart: vaktens egen trappa fortsätter (texten säger
 * "Vakterna fortsätter återansluta"). Returnerar de notiser som bryter mot det.
 */
function noticesWithoutRestart(rig, S) {
  const first = rig.ev.find((e) => e.k.startsWith('aisstream:silent') && !e.k.includes('shadow'));
  if (!first) return [];
  return rig.reconnects.some((r) => r > S && r <= first.t) ? [] : [`${first.k}@${Math.round((first.t - S) / MIN)}`];
}

describe('U66 + U73: vakten startar om före larmet', () => {
  test('E3: förtöjd båt var 3:e min, AISstream död ett dygn — första larmet har en omstart före sig', async () => {
    hub.boats = [{ ...MOORED, periodMs: 3 * MIN }];
    const rig = build('both', { burnNotices: false });
    const S = await warm(rig);
    await run(rig, S + DAY + 5 * MIN);
    const sent = rig.ev.filter((e) => e.k.startsWith('aisstream:silent'));
    expect(sent.length).toBeGreaterThanOrEqual(4); // bas, 1 h, 4 h, dygn
    expect(noticesWithoutRestart(rig, S)).toEqual([]);
    // Före första notisen har vakten bara startat om om beviset räckte.
    expect(rig.reconnects[0]).toBeLessThanOrEqual(sent[0].t);
  }, 600000);

  test('D1: källbyte both → aisstream vid 10 min och tillbaka vid 40 min — första larmet har en omstart före sig', async () => {
    hub.boats = [{ ...MOORED, periodMs: 195 * SEC }];
    const rig = build('both', { burnNotices: false });
    const S = await warm(rig);
    await run(rig, S + 10 * MIN);
    rig.mux.applySourceConfig({ source: 'aisstream', apiKey: KEY, aishubUsername: 'u' });
    await run(rig, S + 40 * MIN);
    rig.mux.applySourceConfig({ source: 'both', apiKey: KEY, aishubUsername: 'u' });
    await run(rig, S + 4 * HOUR);
    expect(mins(rig.reconnects, S)[0]).toBe(20); // dagens regel i läget aisstream
    expect(rig.ev.some((e) => e.k.startsWith('aisstream:silent'))).toBe(true);
    expect(noticesWithoutRestart(rig, S)).toEqual([]);
  }, 600000);

  test('E1: AISHub tillbaka efter 40 min avbrott — första larmet har en omstart före sig', async () => {
    hub.boats = [{ ...MOORED, periodMs: 195 * SEC }];
    const rig = build('both', { burnNotices: false });
    const S = await warm(rig);
    hub.mode = 'down';
    await run(rig, S + 40 * MIN);
    hub.mode = 'ok';
    await run(rig, S + 4 * HOUR);
    expect(mins(rig.reconnects, S)[0]).toBe(20); // AISHub nere: dagens regel
    expect(rig.ev.some((e) => e.k.startsWith('aisstream:silent'))).toBe(true);
    expect(noticesWithoutRestart(rig, S)).toEqual([]);
  }, 600000);

  test('A2: AISHub svarar bara var 4:e poll — första larmet har en omstart före sig', async () => {
    const rig = build('both', { burnNotices: false });
    const S = await warm(rig);
    hub.mode = 'every';
    hub.every = 4;
    hub.boats = [{ ...MOORED, periodMs: 195 * SEC }];
    await run(rig, S + 6 * HOUR);
    expect(rig.ev.some((e) => e.k.startsWith('aisstream:silent'))).toBe(true);
    expect(noticesWithoutRestart(rig, S)).toEqual([]);
  }, 600000);

  test('F6: AISHub nere 10 av varje 30 min — första larmet har en omstart före sig', async () => {
    hub.boats = [{ ...MOORED, periodMs: 3 * MIN }];
    const rig = build('both', { burnNotices: false });
    const S = await warm(rig);
    while (Date.now() < S + 6 * HOUR) {
      const i = Math.round((Date.now() - S) / MIN);
      hub.mode = (i % 30) < 10 ? 'down' : 'ok';
      // eslint-disable-next-line no-await-in-loop
      await run(rig, Date.now() + MIN);
    }
    expect(rig.ev.some((e) => e.k.startsWith('aisstream:silent'))).toBe(true);
    expect(noticesWithoutRestart(rig, S)).toEqual([]);
  }, 600000);

  test('F1: tidslinjenotisen avvisas gång på gång — inte fler omstarter än med dagens regel (20, 61, 142)', async () => {
    hub.boats = [{ ...MOORED, periodMs: 3 * MIN }];
    const rig = build('both', { burnNotices: false });
    rig.app.homey.notifications.createNotification = jest.fn().mockRejectedValue(new Error('Too many notifications'));
    const S = await warm(rig);
    await run(rig, S + 3 * HOUR);
    expect(rig.app.homey.notifications.createNotification).toHaveBeenCalled();
    expect(rig.reconnects.length).toBeLessThanOrEqual(3);
    expect(rig.reconnects.every((r) => r - S >= 20 * MIN)).toBe(true);
  }, 600000);

  test('F1b: notisen avvisas medan AISHub har trafik — som dagens regel', async () => {
    hub.boats = [0, 1, 2, 3].map((i) => ({
      mmsi: 211000030 + i, lat: 58.28 + i * 0.003, lon: 12.28 + i * 0.002, sog: 5, periodMs: 30 * SEC,
    }));
    const rig = build('both', { burnNotices: false });
    rig.app.homey.notifications.createNotification = jest.fn().mockRejectedValue(new Error('Too many notifications'));
    const S = await warm(rig);
    await run(rig, S + 3 * HOUR);
    expect(mins(rig.reconnects, S)).toEqual([20, 61, 142]);
  }, 600000);

  test('dagens regel orörd: bara AISstream, notisen ger ingen omstart (vakten startade redan vid 20)', async () => {
    const rig = build('aisstream', { burnNotices: false });
    const S = await warm(rig);
    await run(rig, S + 65 * MIN);
    expect(mins(rig.reconnects, S)).toEqual([20, 61]);
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

  test('samma sändare utan förbrända notiser: 0 omstarter och inga AISstream-notiser på ett dygn (U66 + U73)', async () => {
    hub.boats = [{ ...MOORED, periodMs: 3 * MIN }];
    const rig = build('both', { burnNotices: false });
    const S = Date.now();
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const deliverAt = [];
    for (let t = S + 3 * MIN; t < S + DAY; t += 3 * MIN) if (rnd() < 0.2) deliverAt.push(t + 5 * SEC);
    await run(rig, S + DAY, { deliverAt });
    expect(rig.reconnects).toEqual([]);
    expect(rig.ev.filter((e) => e.k.startsWith('aisstream:silent'))).toEqual([]);
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
