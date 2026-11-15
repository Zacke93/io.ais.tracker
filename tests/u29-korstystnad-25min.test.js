'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * U29 (ägarbeslut 2026-11-15, fråga F12 i docs/faltgranskning-2026-11-14.md,
 * alternativ b + c) — AISSTREAM-SIDANS KORSTYSTNAD LARMAR EFTER 25 MIN, OCH
 * "HALVDÖD" STÅR BARA KVAR NÄR ANSLUTNINGEN INTE BEVISLIGEN LEVER
 * =============================================================================
 *
 * Fältet: på vintern rör sig ingen båt i området på 15–23 minuter. AISstream
 * levererar då inget, fast anslutningen är frisk, medan AISHub fortsätter att
 * rapportera de förtöjda båtarna. Med K22:s gräns 15 min gav tre fältkörningar
 * elva sådana tystnader, sju "Degraderad" och tre falska notiser "… kan vara
 * halvdöd" (k1/k2 61 h, k3 34 h).
 *
 * Beslutet:
 *  (b) Gränsen för statusen och basnotisen höjs till 25 min, med samma villkor
 *      för båda (B2c). Priset: en verkligt död AISstream syns 10 min senare.
 *  (c) När anslutningen bevisligen lever (socketen öppen och senaste pong
 *      inom pingvaktens fönster, 2 × 30 s) säger texten bara det mätta, utan
 *      diagnosen "halvdöd". Annars står den gamla formuleringen kvar.
 *
 * Proven:
 *  (a) fältets elva tystnader ger varken "Degraderad" eller notis;
 *  (b) en verkligt död AISstream (socketen uppe och pongande, inga data)
 *      larmas vid 25 min, efter feed-vaktens tvångsåteranslutning (20–21 min),
 *      och trappan 1 h / 4 h / 1 dygn går som förut;
 *  (c) textvalet: socketen nere ⇒ gamla texten, socketen pongar ⇒ nya;
 *  (d) samma utfall med statistiken 0/1/2/50 ms före korsvaktens now
 *      (familj F:s läxa N1) — körs genom den riktiga _checkAISFeedHealth.
 */

const AISBridgeApp = require('../app');
const AISStreamClient = require('../lib/connection/AISStreamClient');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const { CONNECTION_ALERT, AIS_CONFIG, UI_CONSTANTS } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();

const NY_TEXT = (n) => `AIS Tracker: AISstream är ansluten men har inte levererat några positioner på ${n} `
  + 'medan AISHub flödar. Appens vakter försöker återansluta automatiskt.';
const GAMMAL_TEXT = (n) => `AIS Tracker: AISstream har inte levererat några positioner på ${n} `
  + 'medan AISHub flödar — anslutningen kan vara halvdöd. Appens vakter försöker återansluta automatiskt.';

/** Statistiken 0, 1, 2 och 50 ms före korsvaktens now (familj F:s testhjälp). */
const LAGS = [[0], [1], [2], [50], [0, 1, 2, 50]];

afterEach(() => {
  Date.now = REAL_DATE_NOW;
});

/**
 * FÄLTETS ELVA TYSTNADER med frisk anslutning och bara förtöjda båtar.
 * k1/k2: glappen mellan AISstreams pipeline-accepterade sampel i ais.jsonl
 * (familj F:s tabell; en övre gräns — appens eget mått, som räknar även
 * meddelanden som fusionen avvisar, är för två av k2:s glapp kortare).
 * k3: appens eget mått ur app.log (accepterade sampel plus avslagsurvalet),
 * k3-driftrapportens fynd 1. Längsta: 23,33 min (k3 14/11 18:21:50).
 */
const FIELD_SILENCES = [
  ['k1', '2026-11-11T07:59:48.470Z', '2026-11-11T08:18:29.438Z'], // 18,7 min
  ['k1', '2026-11-11T08:32:49.053Z', '2026-11-11T08:49:09.551Z'], // 16,3 min
  ['k1', '2026-11-12T00:04:26.699Z', '2026-11-12T00:21:39.345Z'], // 17,2 min
  ['k2', '2026-11-12T21:48:23.828Z', '2026-11-12T22:06:26.972Z'], // 18,1 min
  ['k2', '2026-11-13T08:36:20.012Z', '2026-11-13T08:55:10.222Z'], // 18,8 min
  ['k2', '2026-11-13T13:16:27.457Z', '2026-11-13T13:36:10.017Z'], // 19,7 min
  ['k3', '2026-11-14T11:48:19.987Z', '2026-11-14T12:03:59.814Z'], // 15,7 min
  ['k3', '2026-11-14T14:00:10.721Z', '2026-11-14T14:15:40.717Z'], // 15,5 min
  ['k3', '2026-11-14T18:21:50.461Z', '2026-11-14T18:45:10.445Z'], // 23,3 min (feed-vakten 18:42:50)
  ['k3', '2026-11-15T06:44:20.712Z', '2026-11-15T06:59:39.198Z'], // 15,3 min
  ['k3', '2026-11-15T18:00:40.499Z', '2026-11-15T18:16:49.418Z'], // 16,1 min
];

/**
 * App med riktig _checkAISFeedHealth och en klientstub som räknar som klienterna.
 *
 * AISstream: socketen öppnas vid `openedAt`, pongar 30,02 s efter varje ping
 * (första pingen 30 s efter öppningen) — som AISStreamClient._startPing.
 * reconnectWithKey (feed-vaktens enda ingrepp) river socketen och öppnar en
 * ny 0,5 s senare; pongstämpeln hör till socketen och börjar om.
 * AISHub: pollar var 65:e s och levererar de förtöjda båtarna.
 *
 * `lags` stegar klockan mellan getConnectionStats() och vaktens now.
 */
function makeRig({
  silenceStart, silenceEnd = null, socketDownFrom = null, lags = [0], startAt,
}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  const settings = { ais_api_key: 'k'.repeat(40), ais_source: 'both', aishub_username: 'u' };
  const store = {};
  app.homey = {
    settings: {
      get: (k) => settings[k] ?? store[k] ?? null,
      set: (k, v) => {
        store[k] = JSON.parse(JSON.stringify(v));
      },
      on: () => {},
    },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  app._isConnected = true;
  app._sourceEverResponded = true;
  app._lastConnectionStatus = 'connected';
  // Händelserna bokförs på TICKENS tid (vaktens klocka går lags ms före).
  let tickAt = startAt;
  app._statusWrites = [];
  app._updateDeviceCapability = (cap, value) => {
    if (cap === 'connection_status') app._statusWrites.push({ t: tickAt, value });
  };
  app._sent = [];
  const orig = app._notifyConnectionIssue.bind(app);
  app._notifyConnectionIssue = (message, key) => {
    const before = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    const p = orig(message, key);
    const after = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    if (after !== before) app._sent.push({ k: key, t: tickAt, text: message });
    return p;
  };

  const BOOT = startAt - 6 * HOUR;
  const sock = { openedAt: BOOT };
  const reconnects = [];
  let mockNow = startAt;
  Date.now = () => mockNow;
  let i = 0;

  const streamLastMessage = (now) => {
    if (now < silenceStart) return now - 20 * SEC; // flödar före tystnaden
    if (silenceEnd !== null && now >= silenceEnd) return silenceEnd;
    return silenceStart;
  };
  const lastPong = (now) => {
    const firstPong = sock.openedAt + AIS_CONFIG.PING_INTERVAL_MS + 20;
    if (now < firstPong) return null;
    const k = Math.floor((now - firstPong) / AIS_CONFIG.PING_INTERVAL_MS);
    return firstPong + k * AIS_CONFIG.PING_INTERVAL_MS;
  };

  app.aisClient = {
    isConnected: true,
    kickAishub: jest.fn(),
    reconnectWithKey: jest.fn(() => {
      reconnects.push(tickAt);
      sock.openedAt = Date.now() + 500;
      return Promise.resolve();
    }),
    getConnectionStats() {
      const now = Date.now();
      const up = now >= sock.openedAt && (socketDownFrom === null || now < socketDownFrom);
      const streamLast = streamLastMessage(now);
      const lastOk = BOOT + Math.floor((now - BOOT) / 65000) * 65000;
      const stats = {
        isConnected: true,
        perFeed: {
          aisstream: {
            configured: true,
            isConnected: up,
            lastMessageTime: streamLast,
            timeSinceLastMessage: now - streamLast,
            lastPongAt: up ? lastPong(now) : null,
            uptime: up ? now - sock.openedAt : 0,
            reconnectAttempts: 0,
          },
          aishub: {
            configured: true,
            isConnected: true,
            lastMessageTime: lastOk,
            timeSinceLastMessage: now - lastOk,
            uptime: now - BOOT,
            lastOkResponseAt: lastOk,
            lastPollStartedAt: lastOk,
            pollChainArmedAt: BOOT,
            authCooldownMsLeft: 0,
          },
        },
      };
      mockNow += lags[i % lags.length];
      i++;
      return stats;
    },
  };

  async function run(fromMs, toMs) {
    for (let t = fromMs; t <= toMs; t += MIN) {
      mockNow = t;
      tickAt = t;
      app._checkAISFeedHealth();
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  }
  return { app, run, reconnects };
}

describe('U29 (a): fältets elva tystnader ger varken "Degraderad" eller notis', () => {
  test('underlaget: elva tystnader, alla 15–25 min, längsta 23,33 min', () => {
    const lengths = FIELD_SILENCES.map(([, s, e]) => at(e) - at(s));
    expect(lengths).toHaveLength(11);
    for (const ms of lengths) {
      expect(ms).toBeGreaterThan(15 * MIN);
      expect(ms).toBeLessThan(CONNECTION_ALERT.AISSTREAM_CROSS_SILENCE_ALERT_MS);
    }
    expect(Math.max(...lengths)).toBe(1399984); // 23,33 min, k3 14/11
  });

  test.each(FIELD_SILENCES)('%s %s → %s: ingen degradering, ingen notis, i fyra tickfaser och med 0/1/2/50 ms eftersläpning', async (run, startIso, endIso) => {
    const S = at(startIso);
    const E = at(endIso);
    for (const phase of [0, 17 * SEC, 41 * SEC, 59 * SEC]) {
      for (const lags of LAGS) {
        const rig = makeRig({
          silenceStart: S, silenceEnd: E, lags, startAt: S - 10 * MIN + phase,
        });
        // eslint-disable-next-line no-await-in-loop
        await rig.run(S - 10 * MIN + phase, E + 10 * MIN);
        const label = {
          run, startIso, phase, lags: lags.join('/'),
        };
        expect({ ...label, sent: rig.app._sent.map((x) => x.k) }).toEqual({ ...label, sent: [] });
        expect({ ...label, status: rig.app._statusWrites.map((x) => x.value) }).toEqual({ ...label, status: [] });
        // Feed-vakten ingriper bara i tystnaden över 20 min (k3 18:21:50),
        // som i fält (18:42:50, "sinceMessage=21 min"); de övriga är kortare.
        const expectedReconnects = E - S > UI_CONSTANTS.STALE_FEED_RECONNECT_MS ? 1 : 0;
        expect({ ...label, reconnects: rig.reconnects.length }).toEqual({ ...label, reconnects: expectedReconnects });
      }
    }
  });

  test('loggraden visar fortfarande tystnaden från 15 min och säger att larmgränsen är 25 min', async () => {
    const S = at('2026-11-14T18:21:50.461Z');
    const E = at('2026-11-14T18:45:10.445Z');
    const rig = makeRig({ silenceStart: S, silenceEnd: E, startAt: S - 10 * MIN });
    await rig.run(S - 10 * MIN, E + 5 * MIN);
    const rows = rig.app.log.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[FEED_SILENT] aisstream'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Tickarna ligger på tystnadens egen fas: 15 min 0 s är inte "över 15",
    // så första raden kommer i ticken 16 min in — som k3 18:37:50 ("på 16 min").
    expect(rows[0]).toContain('aisstream har inte levererat på 16 min medan AISHub flödar');
    expect(rows[0]).toContain('[under larmgränsen 25 min (U29)]');
  });
});

describe('U29 (b): en verkligt död AISstream larmas vid 25 min, efter feed-vaktens återanslutning', () => {
  const S = at('2026-11-20T09:00:00.000Z');

  test.each(LAGS.map((l) => [l.join('/'), l]))('socketen uppe och pongande, inga data (eftersläpning %s ms): vakt 20 min → larm 25 min → 1 h → 4 h → 1 dygn', async (_label, lags) => {
    const rig = makeRig({ silenceStart: S, lags, startAt: S - 5 * MIN + 9 * SEC });
    await rig.run(S - 5 * MIN + 9 * SEC, S + DAY + 5 * MIN);
    const { app, reconnects } = rig;

    // ORDNINGEN: feed-vakten först (första tick med ≥ 20 min tystnad) …
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
    expect(iso(reconnects[0])).toBe('2026-11-20T09:20:09.000Z');
    // … och larmet först vid första tick ÖVER 25 min — status och notis i
    // SAMMA tick (B2c), med den nya texten: socketen pongar.
    const base = app._sent.filter((x) => x.k === 'aisstream:silent');
    expect(base.map((x) => iso(x.t))).toEqual(['2026-11-20T09:25:09.000Z']);
    expect(base[0].text).toBe(NY_TEXT('25 min'));
    expect(app._statusWrites.map((x) => [iso(x.t), x.value])).toEqual([
      ['2026-11-20T09:25:09.000Z', 'degraded'],
    ]);
    // Fem monitoringtick mellan vaktens ingrepp och larmet.
    expect(base[0].t - reconnects[0]).toBe(5 * MIN);
    expect(app._sent.filter((x) => x.t < base[0].t)).toEqual([]);

    // TRAPPAN går som förut: 1 h, 4 h och 1 dygn, med den uppmätta tiden.
    expect(app._sent.map((x) => [x.k, iso(x.t)])).toEqual([
      ['aisstream:silent', '2026-11-20T09:25:09.000Z'],
      ['aisstream:silent:1h', '2026-11-20T10:00:09.000Z'],
      ['aisstream:silent:4h', '2026-11-20T13:00:09.000Z'],
      ['aisstream:silent:1 dygn', '2026-11-21T09:00:09.000Z'],
    ]);
    expect(app._sent[1].text).toBe(
      'AIS Tracker: AISstream har varit tyst i över 1 h medan AISHub flödar — appen kör på halverad '
      + 'redundans. Vakterna fortsätter återansluta; kontrollera din AISstream-nyckel om det består.',
    );
    expect(app._sent[3].text).toContain('har varit tyst i över 1 dygn medan AISHub flödar');
  });

  test('ingen notis och ingen statusändring vid 24 min 59 s — larmet kräver att 25 min passerats', async () => {
    const rig = makeRig({ silenceStart: S, startAt: S + 24 * MIN + 59 * SEC });
    await rig.run(S + 24 * MIN + 59 * SEC, S + 24 * MIN + 59 * SEC);
    expect(rig.app._sent).toEqual([]);
    expect(rig.app._statusWrites).toEqual([]);
    const rig2 = makeRig({ silenceStart: S, startAt: S + 25 * MIN + 1 * SEC });
    await rig2.run(S + 25 * MIN + 1 * SEC, S + 25 * MIN + 1 * SEC);
    expect(rig2.app._sent.map((x) => x.k)).toEqual(['aisstream:silent']);
    expect(rig2.app._statusWrites.map((x) => x.value)).toEqual(['degraded']);
  });
});

describe('U29 (c): textvalet följer den uttryckliga livssignalen', () => {
  const S = at('2026-11-20T09:00:00.000Z');

  test.each(LAGS.map((l) => [l.join('/'), l]))('socketen NERE hela tystnaden (eftersläpning %s ms) ⇒ gamla texten med "halvdöd" vid 25 min', async (_label, lags) => {
    const rig = makeRig({
      silenceStart: S, socketDownFrom: S, lags, startAt: S - 5 * MIN + 9 * SEC,
    });
    await rig.run(S - 5 * MIN + 9 * SEC, S + 30 * MIN);
    const base = rig.app._sent.filter((x) => x.k === 'aisstream:silent');
    expect(base.map((x) => iso(x.t))).toEqual(['2026-11-20T09:25:09.000Z']);
    expect(base[0].text).toBe(GAMMAL_TEXT('25 min'));
    // Socketen är nere: feed-vakten är inte dess väg (klientens egen backoff är).
    expect(rig.reconnects).toEqual([]);
  });

  /** Direkt mot korsvakten: AISstream tyst 30 min, hubben levererar. */
  function textFor(streamExtra) {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = {
      settings: { get: () => null, set: jest.fn(), on: jest.fn() },
      notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
    };
    app._hubFeedsPipeline = jest.fn().mockReturnValue(true);
    const now = Date.now();
    app._checkCrossFeedSilence({
      aisstream: {
        configured: true,
        isConnected: true,
        lastMessageTime: now - 30 * MIN,
        timeSinceLastMessage: 30 * MIN,
        uptime: 6 * HOUR,
        ...streamExtra,
      },
      aishub: {
        configured: true,
        isConnected: true,
        lastMessageTime: now - 40 * SEC,
        timeSinceLastMessage: 40 * SEC,
        uptime: 6 * HOUR,
        lastOkResponseAt: now - 40 * SEC,
      },
    });
    const calls = app.homey.notifications.createNotification.mock.calls.map((c) => c[0].excerpt);
    return calls.find((t) => t.includes('AISstream') && !t.includes('i över'));
  }

  test('öppen socket och pong för 10 s sedan ⇒ ny text, ordagrant', () => {
    Date.now = () => at('2026-11-20T10:00:00.000Z');
    expect(textFor({ lastPongAt: Date.now() - 10 * SEC })).toBe(NY_TEXT('30 min'));
  });

  test('öppen socket men ingen pong på socketen än (null) ⇒ gamla texten', () => {
    Date.now = () => at('2026-11-20T10:00:00.000Z');
    expect(textFor({ lastPongAt: null })).toBe(GAMMAL_TEXT('30 min'));
  });

  test('äldre stub utan fältet ⇒ gamla texten', () => {
    Date.now = () => at('2026-11-20T10:00:00.000Z');
    expect(textFor({})).toBe(GAMMAL_TEXT('30 min'));
  });

  test('pong inom fönstret men socketen nere ⇒ gamla texten', () => {
    Date.now = () => at('2026-11-20T10:00:00.000Z');
    expect(textFor({ isConnected: false, lastPongAt: Date.now() - 10 * SEC })).toBe(GAMMAL_TEXT('30 min'));
  });

  test('fönstrets kant: 59,9 s ⇒ ny text; 60 s och äldre ⇒ gamla (pingvakten hade då dödat socketen)', () => {
    Date.now = () => at('2026-11-20T10:00:00.000Z');
    const W = CONNECTION_ALERT.AISSTREAM_PONG_PROOF_WINDOW_MS;
    expect(W).toBe(2 * AIS_CONFIG.PING_INTERVAL_MS);
    expect(textFor({ lastPongAt: Date.now() - (W - 100) })).toBe(NY_TEXT('30 min'));
    expect(textFor({ lastPongAt: Date.now() - W })).toBe(GAMMAL_TEXT('30 min'));
    expect(textFor({ lastPongAt: Date.now() - 10 * MIN })).toBe(GAMMAL_TEXT('30 min'));
  });

  test('ordet "halvdöd" finns bara i den gamla texten', () => {
    expect(NY_TEXT('25 min')).not.toContain('halvdöd');
    expect(GAMMAL_TEXT('25 min')).toContain('halvdöd');
  });
});

describe('U29 (c): klientens pongstämpel hör till EN socket och når korsvakten via muxen', () => {
  const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

  test('AISStreamClient: pong stämplar, ny socket och stängd socket nollställer', () => {
    const client = new AISStreamClient(makeLogger());
    expect(client.getConnectionStats().lastPongAt).toBeNull();
    Date.now = () => at('2026-11-20T10:00:00.000Z');
    client._onPong();
    expect(client.getConnectionStats().lastPongAt).toBe(at('2026-11-20T10:00:00.000Z'));
    // Ny socket (_onOpen → _startPing): en pong från förra socketen intygar inget.
    jest.useFakeTimers();
    try {
      client._startPing();
      expect(client.lastPongAt).toBeNull();
      client._onPong();
      expect(client.lastPongAt).toBe(Date.now());
      // Stängd socket (_onClose/_clearTimers → _stopPing).
      client._stopPing();
      expect(client.lastPongAt).toBeNull();
    } finally {
      client._stopPing();
      jest.useRealTimers();
    }
  });

  test('muxens perFeed.aisstream bär lastPongAt (null när stämpel saknas)', async () => {
    const store = {};
    const mux = new AISSourceMultiplexer(makeLogger(), {
      get: (k) => (k in store ? store[k] : null),
      set: (k, v) => {
        store[k] = v;
      },
      unset: (k) => {
        delete store[k];
      },
    });
    mux._streamClient.connect = jest.fn().mockResolvedValue(undefined);
    mux._streamClient.disconnect = jest.fn();
    mux.applySourceConfig({ source: 'aisstream', apiKey: 'testnyckel', aishubUsername: '' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    try {
      mux._streamClient.getConnectionStats = () => ({
        lastMessageTime: null, timeSinceLastMessage: null, uptime: 0, reconnectAttempts: 0, lastPongAt: 1794000000000,
      });
      expect(mux.getConnectionStats().perFeed.aisstream.lastPongAt).toBe(1794000000000);
      mux._streamClient.getConnectionStats = () => ({
        lastMessageTime: null, timeSinceLastMessage: null, uptime: 0, reconnectAttempts: 0,
      });
      expect(mux.getConnectionStats().perFeed.aisstream.lastPongAt).toBeNull();
    } finally {
      mux.disconnect();
    }
  });
});

describe('U29: konstanterna och vad som INTE följde med', () => {
  test('gränsen är 25 min och ligger efter feed-vaktens senaste ingrepp (20 min + en monitoringtick)', () => {
    const alert = CONNECTION_ALERT.AISSTREAM_CROSS_SILENCE_ALERT_MS;
    expect(alert).toBe(25 * MIN);
    expect(alert).toBeGreaterThan(UI_CONSTANTS.STALE_FEED_RECONNECT_MS + UI_CONSTANTS.MONITORING_INTERVAL_MS);
  });

  test('trappans steg är oförändrade (1 h, 4 h, 1 dygn) och ligger alla över den nya gränsen', () => {
    expect(CONNECTION_ALERT.ESCALATION_STEPS.map((s) => [s.label, s.ms])).toEqual([
      ['1h', HOUR], ['4h', 4 * HOUR], ['1 dygn', DAY],
    ]);
    for (const step of CONNECTION_ALERT.ESCALATION_STEPS) {
      expect(step.ms).toBeGreaterThan(CONNECTION_ALERT.AISSTREAM_CROSS_SILENCE_ALERT_MS);
    }
  });
});
