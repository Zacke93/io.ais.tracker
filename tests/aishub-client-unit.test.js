'use strict';

const AISHubClient = require('../lib/connection/AISHubClient');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * Etapp 1 (2026-08-02): AISHubClient — rate-limit-disciplinen är planens
 * hårdaste krav (V2-C1/V2-C2): aldrig < 61 s mellan poll-starter (inte ens
 * vid fel/backoff/omstart/spärr), kedjan får aldrig dö tyst, och spärren
 * persisteras över omstarter. Allt körs under fake timers — ingen nätverks-
 * trafik (_httpGet mockas; en äkta request vore ett testfel i sig).
 */

const CFG = AIS_CONFIG.AISHUB;

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

function makeRecord(overrides = {}) {
  // TIME sätts till aktuell fejkad klocka om inte annat anges.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
  return {
    MMSI: 265001111,
    TIME: time,
    LATITUDE: 58.29,
    LONGITUDE: 12.29,
    COG: 25,
    SOG: 5,
    NAVSTAT: 0,
    NAME: 'POLLBAT',
    ...overrides,
  };
}

describe('Etapp 1: AISHubClient poll-disciplin', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0); // deterministisk jitter (0)
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function makeClient(store = makeStore(), responder = null) {
    client = new AISHubClient(makeLogger(), store);
    const calls = [];
    client._httpGet = jest.fn(async () => {
      calls.push(Date.now());
      if (responder) return responder(calls.length);
      return { statusCode: 200, body: okSweepBody([]) };
    });
    return { client, calls, store };
  }

  test('KADENSDISCIPLIN: exakt en poll per intervall över 24 h simulerad tid — aldrig < 61 s mellan starter', async () => {
    const { calls } = makeClient();
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(24 * 3600 * 1000);

    // 24 h / 65 s ≈ 1329 pollar (jitter=0). Sanitetsintervall + hårda kravet.
    expect(calls.length).toBeGreaterThan(1250);
    expect(calls.length).toBeLessThan(1340);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);
    }
  });

  test('SPÄRR-ÖVERLEVNAD (V2-C1): en spärrad poll bokar om — kedjan dör aldrig', async () => {
    const { calls, store } = makeClient();
    await client.connect('testuser');
    // Fresh installation utan persisterad spärr ⇒ första pollen direkt (t=0),
    // andra vid t=65 s.
    await jest.advanceTimersByTimeAsync(70 * 1000);
    expect(calls.length).toBe(2);

    // "Annan enhet" pollade precis: flytta spärren framåt, mitt i väntan.
    store.set(CFG.LAST_POLL_SETTINGS_KEY, Date.now() + 30000);
    // Nästa schemalagda poll träffar spärren → måste boka om, inte dö.
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    // Kedjan lever: fler pollar har skett efter den undertryckta.
    expect(calls.length).toBeGreaterThan(5);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);
    }
  });

  test('PERSISTERAD SPÄRR (V2-C2): omstart 5 s efter en poll väntar kvarvarande ~56 s', async () => {
    const store = makeStore({ [CFG.LAST_POLL_SETTINGS_KEY]: Date.now() - 5000 });
    const { calls } = makeClient(store);
    await client.connect('testuser');

    await jest.advanceTimersByTimeAsync(50 * 1000); // 5+50=55 s sedan spärren
    expect(calls.length).toBe(0); // fortfarande spärrad

    await jest.advanceTimersByTimeAsync(30 * 1000); // 85 s sedan spärren
    expect(calls.length).toBe(1);
  });

  test('spärren skrivs till settings FÖRE requesten — vid VARJE poll', async () => {
    const store = makeStore();
    client = new AISHubClient(makeLogger(), store);
    const samples = [];
    client._httpGet = jest.fn(async () => {
      samples.push({ at: Date.now(), persisted: store.get(CFG.LAST_POLL_SETTINGS_KEY) });
      return { statusCode: 200, body: okSweepBody([]) };
    });
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(3 * 70 * 1000);
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (const s of samples) {
      expect(s.persisted).toBe(s.at); // skriven i samma tick, före requesten
    }
  });

  test('BACKOFF: tomt svar ⇒ 65→130→260→300-tak; välformat svar återställer basen; aldrig < 61 s', async () => {
    let mode = 'empty';
    const { calls } = makeClient(makeStore(), () => (mode === 'empty'
      ? { statusCode: 200, body: '' }
      : { statusCode: 200, body: okSweepBody([]) }));
    await client.connect('testuser');

    await jest.advanceTimersByTimeAsync(3600 * 1000); // 1 h av tomma svar
    const gaps = [];
    for (let i = 1; i < calls.length; i++) gaps.push(calls[i] - calls[i - 1]);
    // Första gapen ska eskalera: 130, 260, 300…
    expect(gaps[0]).toBe(130000);
    expect(gaps[1]).toBe(260000);
    expect(gaps[2]).toBe(300000);
    // …och ligga kvar på taket.
    expect(gaps[gaps.length - 1]).toBe(300000);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);

    // Servern friskar till: nästa svar är välformat ⇒ basen tillbaka.
    mode = 'ok';
    const before = calls.length;
    await jest.advanceTimersByTimeAsync(300000); // det friska svaret
    await jest.advanceTimersByTimeAsync(2 * 70 * 1000); // två baspollar
    const newGaps = [];
    for (let i = before + 1; i < calls.length; i++) newGaps.push(calls[i] - calls[i - 1]);
    expect(newGaps.length).toBeGreaterThanOrEqual(1);
    for (const g of newGaps) expect(g).toBe(CFG.POLL_INTERVAL_MS);
  });

  test('disconnect() stoppar kedjan och alla emit-timers — inga pollar efteråt', async () => {
    const { calls } = makeClient();
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);
    const at = calls.length;
    client.disconnect();
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(calls.length).toBe(at);
  });
});

describe('Etapp 1: AISHubClient anslutningssemantik och felmatris', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function makeClientWithScript(responses) {
    client = new AISHubClient(makeLogger(), makeStore());
    let i = 0;
    client._httpGet = jest.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return typeof r === 'function' ? r() : r;
    });
    return client;
  }

  test('connected-flanken: FÖRSTA välformade svaret (även tom kanal) — Bug#12-motivet', async () => {
    makeClientWithScript([{ statusCode: 200, body: okSweepBody([]) }]);
    const connected = jest.fn();
    client.on('connected', connected);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(client.isConnected).toBe(true);
    expect(client.getConnectionStats().uptime).toBeGreaterThanOrEqual(0);
    // Tomt svep uppdaterar INTE lastMessageTime (positionsdrivna vakter).
    expect(client.lastMessageTime).toBeNull();
  });

  test('disconnected-flanken: 3 raka fel efter etablerad kontakt', async () => {
    makeClientWithScript([
      { statusCode: 200, body: okSweepBody([]) }, // kontakt
      { statusCode: 200, body: '' },
      { statusCode: 200, body: '' },
      { statusCode: 200, body: '' },
    ]);
    const disconnected = jest.fn();
    client.on('disconnected', disconnected);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(3600 * 1000);
    expect(disconnected).toHaveBeenCalled();
    expect(client.isConnected).toBe(false);
  });

  test('auth-klassning (D1-lärdomen): access-text ⇒ auth-error, övrigt ⇒ server-error', async () => {
    makeClientWithScript([
      { statusCode: 200, body: JSON.stringify([{ ERROR: true, ERROR_MESSAGE: 'Access denied for user xyz' }]) },
      { statusCode: 200, body: JSON.stringify([{ ERROR: true, ERROR_MESSAGE: 'Internal database failure' }]) },
    ]);
    const authErrors = [];
    const serverErrors = [];
    client.on('auth-error', (m) => authErrors.push(m));
    client.on('server-error', (m) => serverErrors.push(m));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);
    expect(authErrors).toHaveLength(1);
    expect(authErrors[0]).toContain('Access denied');
    await jest.advanceTimersByTimeAsync(200 * 1000); // backoff-gap + nästa poll
    expect(serverErrors.some((m) => String(m).includes('Internal database failure'))).toBe(true);
  });

  // UPPDATERAT 2026-08-03 (V6, A/B-natten): testet hette tidigare "pollandet
  // STOPPAS" och låste fast att femte 403:an satte _stopped = true. Det var
  // ett DÖDLÄGE, inte ett skydd: ingen kodväg återupplivade klienten utan
  // appomstart eller username-byte, så ett övergående 403 (AISHubs
  // stationskrav mäts löpande) slog ut andrakällan för processens livstid.
  // Kontraktet är nu PAUS + automatisk återupptagning; kravet det gamla
  // testet egentligen skyddade — "indragen access får aldrig spamma ws.php" —
  // asserteras hårdare än förr (noll pollar under hela cooldownen).
  test('HTTP 403 × 5 ⇒ pollandet PAUSAS AUTH_COOLDOWN_MS + EN auth-error (V6)', async () => {
    makeClientWithScript([{ statusCode: 403, body: 'Forbidden' }]);
    const authErrors = [];
    client.on('auth-error', (m) => authErrors.push(m));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(4 * 3600 * 1000);
    expect(client._httpGet).toHaveBeenCalledTimes(5);
    // EN användarnotis per episod — inte en per avvisad poll.
    expect(authErrors).toHaveLength(1);
    expect(client.isConnected).toBe(false);
    expect(client.getConnectionStats().authCooldownMsLeft).toBeGreaterThan(0);

    // Tyst under hela pausen — och kedjan är INTE död (_stopped är kvar false).
    const calls = client._httpGet.mock.calls.length;
    await jest.advanceTimersByTimeAsync(3600 * 1000);
    expect(client._httpGet.mock.calls.length).toBe(calls);
    expect(client._stopped).toBe(false);
  });

  test('V6: kedjan ÅTERUPPTAS av sig själv efter cooldownen — ett övergående 403 dödar inte källan', async () => {
    let mode = 'deny';
    makeClientWithScript([() => (mode === 'deny'
      ? { statusCode: 403, body: 'Forbidden' }
      : { statusCode: 200, body: okSweepBody([]) })]);
    const authErrors = [];
    client.on('auth-error', (m) => authErrors.push(m));
    await client.connect('testuser');

    // Femte 403:an faller vid t≈990 s (65+130+260+300+300 backoff) ⇒ pausen
    // löper till t≈990 s + AUTH_COOLDOWN_MS.
    await jest.advanceTimersByTimeAsync(5 * 3600 * 1000);
    expect(client._httpGet).toHaveBeenCalledTimes(5);

    // Accessen kommer tillbaka under pausen (stationen uppfyller kraven igen).
    mode = 'ok';
    await jest.advanceTimersByTimeAsync(2 * 3600 * 1000); // förbi 6h-pausen
    expect(client._httpGet.mock.calls.length).toBeGreaterThan(5);
    expect(client.isConnected).toBe(true);
    expect(client.getConnectionStats().authCooldownMsLeft).toBe(0);
    expect(client.getConnectionStats().authCooldownUntil).toBeNull();

    // …och kadensen är återställd till baskadensen, aldrig under spärren.
    const at = client._httpGet.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(client._httpGet.mock.calls.length).toBeGreaterThan(at);
  });

  test('V6: forceReschedule (feed-vakten) kan INTE bryta auth-cooldownen', async () => {
    makeClientWithScript([{ statusCode: 403, body: 'Forbidden' }]);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(4 * 3600 * 1000);
    const calls = client._httpGet.mock.calls.length;
    expect(calls).toBe(5);

    // Watchdogen kickar var 20:e minut i 2 h — noll extra pollar mot ws.php.
    // (Femte 403:an föll vid t≈990 s ⇒ pausen löper till t≈6 h 16 min;
    // fönstret nedan slutar vid t = 6 h och ligger alltså helt inuti den.)
    for (let i = 0; i < 6; i++) {
      client.forceReschedule();
      // eslint-disable-next-line no-await-in-loop
      await jest.advanceTimersByTimeAsync(20 * 60 * 1000);
    }
    expect(client.getConnectionStats().authCooldownMsLeft).toBeGreaterThan(0);
    expect(client._httpGet.mock.calls.length).toBe(calls);
  });

  test('V6/granskningsrunda 2: permanent 403 ger INTE en vilseledande server-error per dygn', async () => {
    // _failStreak nollställdes inte när cooldownen sattes, så den FÖRSTA
    // pollen efter varje 6-timmarspaus föll rakt in i "≥3 raka misslyckade
    // pollar" ⇒ server-error ⇒ app-lagrets 24h-dedup per nyckel släppte
    // igenom minst en pushnotis per dygn, för evigt, med FEL diagnos
    // ("serverfel … fortsätter polla med backoff" — kedjan är pausad).
    makeClientWithScript([{ statusCode: 403, body: 'Forbidden' }]);
    const authErrors = [];
    const serverErrors = [];
    client.on('auth-error', (m) => authErrors.push(m));
    client.on('server-error', (m) => serverErrors.push(m));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(48 * 3600 * 1000);
    expect(authErrors).toHaveLength(1);
    expect(serverErrors).toHaveLength(0);
  });

  test('V6/granskningsrunda 2: error-record med access-text går in i SAMMA auth-maskineri', async () => {
    // AISHubs DOKUMENTERADE felväg är HTTP 200 + [{ERROR:true,…}] (se
    // aishubParsers kontraktsblock). Den grenen räknade aldrig
    // _authFailCount, kunde aldrig pausa och emitterade auth-error vid VARJE
    // poll — 288 anrop/dygn mot ett konto som uttryckligen nekats.
    makeClientWithScript([{
      statusCode: 200,
      body: JSON.stringify([{ ERROR: true, ERROR_MESSAGE: 'Access Denied: invalid username' }]),
    }]);
    const authErrors = [];
    client.on('auth-error', (m) => authErrors.push(m));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(48 * 3600 * 1000);
    expect(authErrors).toHaveLength(1);
    expect(client.getConnectionStats().authCooldownMsLeft).toBeGreaterThan(0);
    expect(client.getConnectionStats().counters.authFail).toBeGreaterThan(0);
    // Kadensdisciplinen: 48 h mot ett nekat konto ger 8 cooldowncykler à
    // AUTH_FAIL_STOP bekräftande pollar = 40, dvs. ~20/dygn. Före fixen
    // pollade samma konto 577 gånger (288/dygn, backofftaket 300 s) och
    // emitterade lika många auth-error.
    expect(client._httpGet.mock.calls.length).toBeLessThan(60);
  });

  test('V6: en NY auth-episod efter tillfrisknande notifierar igen (engångsflaggan är per episod)', async () => {
    let mode = 'ok';
    makeClientWithScript([() => (mode === 'deny'
      ? { statusCode: 403, body: 'Forbidden' }
      : { statusCode: 200, body: okSweepBody([]) })]);
    const authErrors = [];
    client.on('auth-error', (m) => authErrors.push(m));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000); // frisk kontakt
    expect(authErrors).toHaveLength(0);

    mode = 'deny';
    await jest.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(authErrors).toHaveLength(1); // episod 1

    mode = 'ok';
    await jest.advanceTimersByTimeAsync(8 * 3600 * 1000); // förbi pausen, frisk
    mode = 'deny';
    await jest.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(authErrors).toHaveLength(2); // episod 2 — inte tystad för alltid
  });

  test('FORMAT-mismatch ⇒ server-error + noll emitterade meddelanden', async () => {
    makeClientWithScript([{
      statusCode: 200,
      body: JSON.stringify([{ ERROR: false, FORMAT: 'AIS', RECORDS: 1 }, [makeRecord()]]),
    }]);
    const serverErrors = [];
    const messages = [];
    client.on('server-error', (m) => serverErrors.push(m));
    client.on('ais-message', (m) => messages.push(m));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);
    expect(serverErrors.some((m) => String(m).includes('FORMAT'))).toBe(true);
    expect(messages).toHaveLength(0);
  });

  test('TIME-larmet: samtliga poster oparsbara 3 svep i rad ⇒ EN server-error', async () => {
    const badSweep = () => ({
      statusCode: 200,
      body: okSweepBody([makeRecord({ TIME: 'skräp' }), makeRecord({ MMSI: 265002222, TIME: 'mer skräp' })]),
    });
    makeClientWithScript([badSweep, badSweep, badSweep, badSweep]);
    const serverErrors = [];
    client.on('server-error', (m) => serverErrors.push(m));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    const timeAlarms = serverErrors.filter((m) => String(m).includes('TIME'));
    expect(timeAlarms).toHaveLength(1); // engångslarm, inte per svep
  });
});

describe('Etapp 1: AISHubClient emission, dedup och boxfilter', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function collect(responses) {
    client = new AISHubClient(makeLogger(), makeStore());
    let i = 0;
    client._httpGet = jest.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return typeof r === 'function' ? r() : r;
    });
    const events = [];
    client.on('static-name', (e) => events.push({ type: 'static-name', at: Date.now(), ...e }));
    client.on('ais-message', (e) => events.push({ type: 'ais-message', at: Date.now(), ...e }));
    return events;
  }

  test('emissionsformen: AISStreamClient-paritet + fixTs/fixFeed/quality + mottagningsstämpel', async () => {
    const events = collect([{ statusCode: 200, body: okSweepBody([makeRecord()]) }]);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);

    const msg = events.find((e) => e.type === 'ais-message');
    expect(msg).toBeDefined();
    expect(msg.mmsi).toBe('265001111');
    expect(msg.msgType).toBe('AISHubPosition');
    expect(msg.fixFeed).toBe('aishub');
    expect(msg.fixTsQuality).toBe('true-fix');
    expect(Number.isFinite(msg.fixTs)).toBe(true);
    expect(msg.timestamp).toBe(msg.at); // mottagningstid = emissionsögonblicket
    // Namnet emitteras FÖRE positionen (B1-mönstret).
    const nameIdx = events.findIndex((e) => e.type === 'static-name' && e.mmsi === '265001111');
    const posIdx = events.findIndex((e) => e.type === 'ais-message' && e.mmsi === '265001111');
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBeLessThan(posIdx);
    expect(client.lastMessageTime).not.toBeNull();
  });

  test('BATCHSPRIDNING: tre poster emitteras i*150 ms isär — aldrig en syntetisk storm', async () => {
    const sweep = okSweepBody([
      makeRecord({ MMSI: 265001111 }),
      makeRecord({ MMSI: 265002222, LATITUDE: 58.30 }),
      makeRecord({ MMSI: 265003333, LATITUDE: 58.31 }),
    ]);
    const events = collect([{ statusCode: 200, body: sweep }]);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);

    const messages = events.filter((e) => e.type === 'ais-message');
    expect(messages).toHaveLength(3);
    // ±1 ms tolerans: fake-timerns async-stegning kan förskjuta den första
    // emissionen en millisekund relativt de schemalagda.
    const gap1 = messages[1].at - messages[0].at;
    const gap2 = messages[2].at - messages[1].at;
    expect(gap1).toBeGreaterThanOrEqual(CFG.EMIT_SPREAD_MS - 1);
    expect(gap1).toBeLessThanOrEqual(CFG.EMIT_SPREAD_MS + 1);
    expect(gap2).toBeGreaterThanOrEqual(CFG.EMIT_SPREAD_MS - 1);
    expect(gap2).toBeLessThanOrEqual(CFG.EMIT_SPREAD_MS + 1);
  });

  test('DEDUP (mmsi, fixTs): re-levererad fix i nästa poll emitteras INTE; ny fixTs emitteras', async () => {
    const t = '2026-08-02 12:00:30 GMT';
    const t2 = '2026-08-02 12:01:30 GMT';
    const responses = [
      { statusCode: 200, body: okSweepBody([makeRecord({ TIME: t })]) },
      { statusCode: 200, body: okSweepBody([makeRecord({ TIME: t })]) }, // samma fix igen
      { statusCode: 200, body: okSweepBody([makeRecord({ TIME: t2 })]) }, // äkta ny
    ];
    const events = collect(responses);
    await client.connect('testuser');
    // Exakt tre pollar: t=0 (ny fix), t=65 s (re-levererad), t=130 s (ny fix).
    await jest.advanceTimersByTimeAsync(150 * 1000);

    const messages = events.filter((e) => e.type === 'ais-message');
    expect(messages).toHaveLength(2);
    expect(messages[0].fixTs).toBe(Date.UTC(2026, 7, 2, 12, 0, 30));
    expect(messages[1].fixTs).toBe(Date.UTC(2026, 7, 2, 12, 1, 30));
    expect(client.getConnectionStats().counters.dupes).toBe(1);
    expect(client.getConnectionStats().dedupSize).toBe(1); // aldrig null (soak-kravet)
  });

  test('BOXFILTER (bälte+hängslen): position utanför BOUNDING_BOX emitteras inte', async () => {
    const events = collect([{
      statusCode: 200,
      body: okSweepBody([makeRecord({ LATITUDE: 59.5, LONGITUDE: 12.29 })]),
    }]);
    await client.connect('testuser');
    // En enda poll (t=0) — nästa kommer först vid t=65 s.
    await jest.advanceTimersByTimeAsync(5 * 1000);
    expect(events.filter((e) => e.type === 'ais-message')).toHaveLength(0);
    expect(client.getConnectionStats().counters.outOfBox).toBe(1);
  });

  test('FÄLTPROV 1-FYNDET (sekretess): USERNAME maskeras i AISHUB_RESPONSE_SAMPLE — usernamet ÄR autentiseringen', async () => {
    client = new AISHubClient(
      {
        log: jest.fn(), debug: jest.fn(), error: jest.fn(), debugLevel: 'full',
      },
      makeStore(),
    );
    client._httpGet = jest.fn(async () => ({ statusCode: 200, body: okSweepBody([makeRecord()]) }));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(5 * 1000);

    const sampleLines = client.logger.log.mock.calls
      .filter((c) => String(c[0]).includes('AISHUB_RESPONSE_SAMPLE'))
      .map((c) => c.join(' '));
    expect(sampleLines.length).toBe(1);
    expect(sampleLines[0]).toContain('"USERNAME\\":\\"***\\"');
    expect(sampleLines[0]).not.toContain('testuser');
  });

  test('FÄLTPROV 1-FYNDET (telemetri): AISHUB_POLL loggar PER-SVEP-dupes + separata livstidstotaler', async () => {
    const t = '2026-08-02 12:00:30 GMT';
    client = new AISHubClient(makeLogger(), makeStore());
    client._httpGet = jest.fn(async () => ({ statusCode: 200, body: okSweepBody([makeRecord({ TIME: t })]) }));
    await client.connect('testuser');
    // Tre pollar med SAMMA fix: p1 färsk, p2 dup (svep 1, total 1), p3 dup (svep 1, total 2).
    await jest.advanceTimersByTimeAsync(150 * 1000);

    const pollLines = client.logger.log.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes('[AISHUB_POLL]'));
    expect(pollLines.length).toBe(3);
    expect(pollLines[0]).toContain('dupes=0');
    expect(pollLines[0]).toContain('dupesTotal=0');
    expect(pollLines[1]).toContain('dupes=1');
    expect(pollLines[1]).toContain('dupesTotal=1');
    // Kärnan i fyndet: per-svep-talet förblir 1 medan totalen växer —
    // tidigare loggades totalen som "dupes" och kvoten var oläsbar.
    expect(pollLines[2]).toContain('dupes=1');
    expect(pollLines[2]).toContain('dupesTotal=2');
  });

  test('FYND 15 (A/B-natten): dedup-taket evicterar ÄLDST KÄNDA FIX — inte det först insatta', () => {
    client = new AISHubClient(makeLogger(), makeStore());
    const now = Date.now();
    // Det AKTIVA fartyget sattes in FÖRST och har den FÄRSKASTE fixen. Den
    // gamla prunen (map.keys().next()) slängde exakt denna — och att tappa
    // dedup-posten för ett aktivt fartyg betyder att nästa polls RE-LEVERANS
    // av samma fix åker in i pipelinen som en ny position.
    client._dedup.set('265000001', now - 1000);
    for (let i = 0; i < CFG.DEDUP_MAX_ENTRIES; i++) {
      client._dedup.set(`2650100${i}`, now - 60000 - i); // äldre fix, inom TTL
    }
    expect(client._dedup.size).toBe(CFG.DEDUP_MAX_ENTRIES + 1);

    client._pruneDedup(now);

    expect(client._dedup.size).toBe(CFG.DEDUP_MAX_ENTRIES);
    expect(client._dedup.has('265000001')).toBe(true);
    // Den evicterade är den med äldst fixtid (i = MAX-1 ⇒ lägst fixTs).
    expect(client._dedup.has(`2650100${CFG.DEDUP_MAX_ENTRIES - 1}`)).toBe(false);
  });

  test('reconnectWithKey är en no-op (ingen extra poll, ingen krasch)', async () => {
    collect([{ statusCode: 200, body: okSweepBody([]) }]);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);
    const calls = client._httpGet.mock.calls.length;
    await client.reconnectWithKey('helt-annan-nyckel');
    await jest.advanceTimersByTimeAsync(1000);
    expect(client._httpGet.mock.calls.length).toBe(calls);
  });
});
