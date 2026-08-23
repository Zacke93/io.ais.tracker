'use strict';

const http = require('http');
const https = require('https');
const AISHubClient = require('../lib/connection/AISHubClient');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * M12 (helkodsgranskning runda 4, 2026-08-23): HÄNGD POLL LÅSER _inFlight FÖR ALLTID.
 *
 * Felet: HTTP_TIMEOUT_MS är en SOCKET-timeout som Node nollställer vid varje
 * mottagen datachunk. En server som droppar bytes i evighet utan att avsluta
 * svaret ("trickle") passerar därför aldrig timeouten — löftet settlar aldrig,
 * _poll:s finally körs aldrig, _inFlight fastnar SANT och _pollTimer står null.
 * Feed-vaktens enda ingrepp (kickAishub → forceReschedule) bokade en timer vars
 * _poll returnerade direkt på single-flight-grinden: fältmätt 19 strikes och
 * 19 kicks på 30 min ⇒ 0 nya pollar, dvs. permanent källdöd till appomstart.
 *
 * Fixen har två lager, och båda prövas här:
 *  (a) en ABSOLUT deadline som armeras i samma andetag som _inFlight sätts
 *      (spegling av AISStreamClients connect-deadline),
 *  (b) forceReschedule får BRYTA ett _inFlight som är äldre än feed-vaktens
 *      egen kedjedödsgräns — vaktens dokumenterade uppgift blir verklig.
 *
 * Testfilen kör två sorters bevis:
 *  - RIKTIGA SOCKETS mot en lokal trickle-/stall-server (https.get delegeras
 *    till http.get på loopbacken). Det är enda sättet att bevisa att socket-
 *    timeouten verkligen INTE räddar oss vid trickle — en mockad _httpGet kan
 *    bara anta det.
 *  - FAKE TIMERS genom hela den riktiga _poll-kedjan, för kadens- och
 *    generationslogiken (som kräver 30 min simulerad tid).
 */

const CFG = AIS_CONFIG.AISHUB;
const DEADLINE_MS = 2 * CFG.HTTP_TIMEOUT_MS + CFG.POLL_INTERVAL_MS; // 105 s

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

function okSweepBody(records = []) {
  return JSON.stringify([
    {
      ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: records.length,
    },
    records,
  ]);
}

// ============================================================================
// A) HÄRLEDNINGEN — talen får inte drifta isär från sina två grannar
// ============================================================================
describe('M12-A: deadlinens härledning', () => {
  let client;

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
  });

  test('deadlinen är 2×HTTP_TIMEOUT_MS + POLL_INTERVAL_MS och räknas ur config', () => {
    client = new AISHubClient(makeLogger(), makeStore());
    expect(client._pollDeadlineMs()).toBe(DEADLINE_MS);
    expect(client._pollDeadlineMs()).toBe(105000);

    // Räknas ur this._cfg, inte ur ett eget hårdkodat tal: en flytt av
    // konstanterna måste flytta deadlinen med sig.
    client._cfg = { ...CFG, HTTP_TIMEOUT_MS: 5000, POLL_INTERVAL_MS: 7000 };
    expect(client._pollDeadlineMs()).toBe(2 * 5000 + 7000);
  });

  test('deadlinen ligger MELLAN socket-timeouten och feed-vaktens kedjedödsgräns', () => {
    client = new AISHubClient(makeLogger(), makeStore());
    // Under: socket-timeouten måste hinna först vid ett HELT stallat svar,
    // annars felklassificeras en vanlig död backend som "trickle".
    expect(client._pollDeadlineMs()).toBeGreaterThan(CFG.HTTP_TIMEOUT_MS);
    // Över: deadlinen får aldrig fyra före den tidpunkt då nästa poll ändå
    // varit på tur — den ska rädda kedjan, aldrig korta kadensen.
    expect(client._pollDeadlineMs()).toBeGreaterThan(CFG.POLL_INTERVAL_MS);
    // Långt under vaktens kedjedödsgräns: klienten läker sig själv innan
    // feed-vakten hinner räkna sin första strike.
    expect(client._pollDeadlineMs()).toBeLessThan(client._chainDeadMs());
  });

  test('_chainDeadMs speglar app.js:_checkAishubFeedHealth (2×BACKOFF_MAX_MS + 60 s = 11 min)', () => {
    client = new AISHubClient(makeLogger(), makeStore());
    expect(client._chainDeadMs()).toBe(2 * CFG.BACKOFF_MAX_MS + 60 * 1000);
    expect(client._chainDeadMs()).toBe(11 * 60 * 1000);
  });
});

// ============================================================================
// B) RIKTIGA SOCKETS — trickle, stall och normalsvar
// ============================================================================
describe('M12-B: riktiga sockets (trickle / stall / normalsvar)', () => {
  let server;
  let client;
  let sockets;
  let tickers;
  let getSpy;

  // Nedskalad kadens: hela poängen är väggtid, och de riktiga talen (20 s
  // socket-timeout, 105 s deadline) skulle göra testet 2 min långt. Kvoterna
  // bevaras EXAKT — deadlinen räknas ur samma uttryck som i produktion.
  const FAST = {
    HTTP_TIMEOUT_MS: 250,
    POLL_INTERVAL_MS: 300,
    POLL_JITTER_MS: 1,
    MIN_POLL_SPACING_MS: 10,
    START_JITTER_MAX_MS: 1,
    BACKOFF_MAX_MS: 800,
  };
  const FAST_DEADLINE_MS = 2 * FAST.HTTP_TIMEOUT_MS + FAST.POLL_INTERVAL_MS; // 800 ms

  beforeEach(() => {
    sockets = new Set();
    tickers = new Set();
  });

  afterEach(async () => {
    if (client) client.disconnect();
    client = null;
    for (const t of tickers) clearInterval(t);
    tickers.clear();
    if (getSpy) getSpy.mockRestore();
    getSpy = null;
    if (server) {
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  /**
   * Startar en lokal HTTP-server och får AISHubClient att prata med den:
   * https.get delegeras till http.get mot loopbacken. Requesten, chunkarna,
   * socket-timeouten och destroy() är därmed ÄKTA Node-beteende — bara
   * transportlagret är utbytt.
   */
  async function startServer(handler) {
    server = http.createServer(handler);
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    getSpy = jest.spyOn(https, 'get').mockImplementation((url, opts, cb) => {
      const rewritten = String(url).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`);
      return http.get(rewritten, opts, cb);
    });
    return port;
  }

  function makeFastClient() {
    client = new AISHubClient(makeLogger(), makeStore());
    client._cfg = { ...CFG, ...FAST };
    // Produktionens mux lyssnar på 'error'; utan lyssnare KASTAR EventEmitter
    // på _handleNetError-vägen (stall-testet).
    client.on('error', jest.fn());
    client.on('server-error', jest.fn());
    return client;
  }

  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  test('TRICKLE: svaret droppar bytes i evighet — socket-timeouten räddar INTE, deadlinen gör det', async () => {
    let responsesOpened = 0;
    let clientGaveUp = false;
    await startServer((req, res) => {
      responsesOpened++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[{"ERROR":false'); // aldrig avslutat JSON
      // En byte var 40:e ms ⇒ socketen är ALDRIG inaktiv 250 ms i sträck,
      // så req 'timeout' kan per konstruktion inte fyra. Detta ÄR premissen.
      const t = setInterval(() => {
        if (!res.writableEnded) res.write(' ');
      }, 40);
      tickers.add(t);
      res.on('close', () => {
        clearInterval(t);
        tickers.delete(t);
        if (!res.writableEnded) clientGaveUp = true;
      });
    });
    makeFastClient();

    await client.connect('testuser');
    // Halvvägs: pollen är ute, grinden är stängd, vakthunden är armerad.
    await sleep(FAST_DEADLINE_MS / 2);
    expect(responsesOpened).toBe(1);
    expect(client._inFlight).toBe(true);
    expect(client._inFlightDeadlineTimer).not.toBeNull();
    expect(client._counters.pollDeadlines).toBe(0); // socket-timeouten har INTE fyrat

    // Förbi deadlinen: grinden släpper, socketen rivs, kedjan bokas om.
    await sleep(FAST_DEADLINE_MS);
    expect(client._counters.pollDeadlines).toBe(1);
    expect(client._counters.netErrors).toBe(1);
    expect(client._inFlight).toBe(false);
    expect(client._inFlightDeadlineTimer).toBeNull();
    expect(client._activeReq).toBeNull();
    expect(client._pollTimer).not.toBeNull(); // NÄSTA POLL ÄR BOKAD
    expect(clientGaveUp).toBe(true); // socketen revs — servern matar ingen spökklient

    // Och kedjan lever vidare: en ny poll når verkligen servern.
    await sleep(FAST.BACKOFF_MAX_MS + FAST_DEADLINE_MS);
    expect(responsesOpened).toBeGreaterThanOrEqual(2);
  });

  test('STALL: svar utan en enda byte ⇒ socket-timeouten fyrar som förut, deadlinen rörs inte', async () => {
    await startServer(() => {
      // Aldrig writeHead, aldrig end: en helt tyst backend.
    });
    makeFastClient();

    await client.connect('testuser');
    await sleep(FAST.HTTP_TIMEOUT_MS + 200);

    expect(client._counters.netErrors).toBe(1);
    expect(client._counters.pollDeadlines).toBe(0); // deadlinen behövdes aldrig
    expect(client._inFlight).toBe(false);
    expect(client._inFlightDeadlineTimer).toBeNull();
    expect(client._pollTimer).not.toBeNull();
    const timeoutLogged = client.logger.error.mock.calls
      .map((c) => c.join(' ')).some((l) => l.includes('HTTP-timeout'));
    expect(timeoutLogged).toBe(true);
  });

  test('NORMALSVAR: oförändrat — deadlinen armeras, rensas och räknar inget', async () => {
    let served = 0;
    await startServer((req, res) => {
      served++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okSweepBody([]));
    });
    makeFastClient();
    const connected = jest.fn();
    client.on('connected', connected);

    await client.connect('testuser');
    await sleep(FAST.POLL_INTERVAL_MS * 2 + 200);

    expect(served).toBeGreaterThanOrEqual(2);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(client._counters.pollDeadlines).toBe(0);
    expect(client._counters.netErrors).toBe(0);
    expect(client._inFlight).toBe(false);
    expect(client._inFlightDeadlineTimer).toBeNull(); // ingen läckt vakthund
    expect(client._activeReq).toBeNull(); // inget läckt requesthandtag
  });
});

// ============================================================================
// C) KEDJAN — fake timers genom hela den riktiga _poll-vägen
// ============================================================================
describe('M12-C: kedjan överlever en hängd poll', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function makeHangingClient() {
    client = new AISHubClient(makeLogger(), makeStore());
    client.on('server-error', jest.fn());
    // Ett löfte som ALDRIG settlar — exakt vad en trickle ger _poll.
    client._httpGet = jest.fn(() => new Promise(() => {}));
    return client;
  }

  test('BUGGENS KÄRNA: en poll som aldrig settlar släpper ändå grinden och bokar om', async () => {
    makeHangingClient();
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(1000);

    expect(client._httpGet).toHaveBeenCalledTimes(1);
    expect(client._inFlight).toBe(true);
    expect(client._pollTimer).toBeNull(); // grinden håller kedjan — före fixen FÖR ALLTID

    await jest.advanceTimersByTimeAsync(DEADLINE_MS + 1000);
    expect(client._inFlight).toBe(false);
    expect(client._counters.pollDeadlines).toBe(1);
    expect(client._counters.netErrors).toBe(1);
    expect(client._pollTimer).not.toBeNull();
  });

  test('30 MIN MED HÄNGDA POLLAR: kedjan levererar nya pollförsök (fältet mätte 0)', async () => {
    makeHangingClient();
    await client.connect('testuser');

    // LEVANDE-INVARIANTEN, provad var 30:e sekund genom hela halvtimmen:
    // kedjan har ALLTID antingen en bokad poll ELLER en poll ute under
    // bevakning. Ett läge utan endera är exakt den permanenta källdöd M12
    // beskriver (_inFlight sant, _pollTimer null, ingen vakthund).
    for (let elapsed = 0; elapsed < 30 * 60 * 1000; elapsed += 30 * 1000) {
      // eslint-disable-next-line no-await-in-loop
      await jest.advanceTimersByTimeAsync(30 * 1000);
      const alive = client._pollTimer !== null
        || (client._inFlight && client._inFlightDeadlineTimer !== null);
      expect(alive).toBe(true);
    }

    // Varje varv kostar deadline (105 s) + backoff (130→260→300 s tak):
    // ~5-6 försök på 30 min. Före fixen: exakt 1, för evigt.
    expect(client._httpGet.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(client._counters.pollDeadlines).toBe(client._httpGet.mock.calls.length);
  });

  test('kadensspärren gäller ovillkorligt även när deadlinen driver kedjan', async () => {
    client = new AISHubClient(makeLogger(), makeStore());
    client.on('server-error', jest.fn());
    const starts = [];
    client._httpGet = jest.fn(() => {
      starts.push(Date.now());
      return new Promise(() => {});
    });
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(starts.length).toBeGreaterThan(3);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);
    }
  });

  test('SPÖKSVARET: en övergiven polls sena resultat bokförs inte och rör inte kadensen', async () => {
    client = new AISHubClient(makeLogger(), makeStore());
    client.on('server-error', jest.fn());
    let settleLate = null;
    client._httpGet = jest.fn(() => new Promise((resolve) => {
      settleLate = resolve;
    }));
    const connected = jest.fn();
    client.on('connected', connected);

    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(DEADLINE_MS + 1000); // övergiven
    expect(client._counters.pollDeadlines).toBe(1);

    const scheduleSpy = jest.spyOn(client, '_scheduleNext');
    const pollsBefore = client._counters.polls;

    // Trickle-servern avslutar till slut sitt svar — LÅNGT efter att vi gett upp.
    settleLate({ statusCode: 200, body: okSweepBody([]) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(connected).not.toHaveBeenCalled(); // ingen flank ur ett dött svar
    expect(client._lastOkResponseAt).toBeNull();
    expect(scheduleSpy).not.toHaveBeenCalled(); // kadensen ombokades INTE av spöket
    expect(client._counters.polls).toBe(pollsBefore);
    expect(client._inFlight).toBe(false); // spöket får inte stänga grinden igen
  });

  test('NORMALDRIFT: 1 h oförändrad kadens, noll deadlines, ingen läckt vakthund', async () => {
    client = new AISHubClient(makeLogger(), makeStore());
    const starts = [];
    client._httpGet = jest.fn(async () => {
      starts.push(Date.now());
      return { statusCode: 200, body: okSweepBody([]) };
    });
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    // 3600 s / 65 s ≈ 56 pollar (jitter mockat till 0).
    expect(starts.length).toBeGreaterThan(50);
    expect(starts.length).toBeLessThan(60);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);
    }
    expect(client._counters.pollDeadlines).toBe(0);
    expect(client._counters.netErrors).toBe(0);
    expect(client._inFlightDeadlineTimer).toBeNull();
    expect(client.isConnected).toBe(true);
  });
});

// ============================================================================
// D) ANDRA FÖRSVARSLINJEN — feed-vaktens brytare
// ============================================================================
describe('M12-D: forceReschedule bryter ett inaktuellt _inFlight', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    client = new AISHubClient(makeLogger(), makeStore());
    client.on('server-error', jest.fn());
    client._httpGet = jest.fn(() => new Promise(() => {}));
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /**
   * Sätter klienten i det läge fältet mätte: en poll ute sedan `ageMs`, UTAN
   * armerad vakthund. (Deadlinen rivs medvetet — brytaren är andra
   * försvarslinjen och ska hålla även om första lagret gått förlorat, t.ex. en
   * timer som Homey-runtimen tappat.)
   */
  async function hangWithoutDeadline(ageMs) {
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(1000);
    expect(client._inFlight).toBe(true);
    client._clearInFlightDeadline();
    await jest.advanceTimersByTimeAsync(ageMs);
    expect(client._inFlight).toBe(true); // ingen vakthund kvar ⇒ grinden står kvar
  }

  test('äldre än kedjedödsgränsen (11 min) ⇒ grinden bryts och en poll körs faktiskt', async () => {
    await hangWithoutDeadline(12 * 60 * 1000);
    const before = client._httpGet.mock.calls.length;

    client.forceReschedule();
    expect(client._inFlight).toBe(false);
    expect(client._counters.pollDeadlines).toBe(1);

    // Före fixen: kicken bokade en timer vars _poll returnerade direkt på
    // grinden — 19 kicks gav 0 nya pollar.
    await jest.advanceTimersByTimeAsync(2000);
    expect(client._httpGet.mock.calls.length).toBe(before + 1);
    const brokeLogged = client.logger.error.mock.calls
      .map((c) => c.join(' ')).some((l) => l.includes('bryter INAKTUELL poll'));
    expect(brokeLogged).toBe(true);
  });

  test('en FÄRSK poll bryts aldrig — brytaren får inte bli en single-flight-kringgång', async () => {
    await hangWithoutDeadline(5 * 60 * 1000); // < 11 min
    const before = client._httpGet.mock.calls.length;

    client.forceReschedule();
    expect(client._inFlight).toBe(true);
    expect(client._counters.pollDeadlines).toBe(0);

    await jest.advanceTimersByTimeAsync(5000);
    expect(client._httpGet.mock.calls.length).toBe(before); // ingen parallell poll
  });

  test('auth-cooldownen står över brytaren (V6 oförändrad)', async () => {
    await hangWithoutDeadline(12 * 60 * 1000);
    client._authCooldownUntil = Date.now() + 60 * 60 * 1000;

    client.forceReschedule();
    expect(client._inFlight).toBe(true); // ingen brytning bakom en auth-paus
    expect(client._counters.pollDeadlines).toBe(0);
  });

  test('disconnect() släpper grinden TYST så en åter-connect inte startar död', async () => {
    let settleLate = null;
    client._httpGet = jest.fn(() => new Promise((resolve) => {
      settleLate = resolve;
    }));
    const serverError = jest.fn();
    client.on('server-error', serverError);

    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(1000);
    expect(client._inFlight).toBe(true);

    client.disconnect();
    expect(client._inFlight).toBe(false);
    expect(client._inFlightDeadlineTimer).toBeNull();
    // TYST: ett avsiktligt stopp är inget fel — varken räknare eller larm.
    expect(client._counters.pollDeadlines).toBe(0);
    expect(client._counters.netErrors).toBe(0);
    expect(serverError).not.toHaveBeenCalled();

    // Kedjan startar om och lever.
    const before = client._httpGet.mock.calls.length;
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(3 * 60 * 1000);
    const afterRestart = client._httpGet.mock.calls.length;
    expect(afterRestart).toBeGreaterThan(before);

    // Den STOPPADE pollens svar landar först nu — det får inte boka om den
    // nystartade kedjan (generationen invaliderades vid disconnect).
    const scheduleSpy = jest.spyOn(client, '_scheduleNext');
    settleLate({ statusCode: 200, body: okSweepBody([]) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(client._httpGet.mock.calls.length).toBe(afterRestart);
  });
});
