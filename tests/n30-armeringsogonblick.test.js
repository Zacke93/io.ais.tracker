'use strict';

const AISHubClient = require('../lib/connection/AISHubClient');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * N30 (helkodsgranskning runda 5, 2026-08-23): ZOMBIEN FÖRE FÖRSTA POLLEN.
 *
 * Felet har två halvor som tillsammans ger en källa som är död i 24 h utan att
 * en enda rad skrivs:
 *
 *  (1) AISHubClient.connect() anropar _readLastPollAt() FÖRE _scheduleNext(),
 *      och läsningen rörde settings.get OSKYDDAT — till skillnad från
 *      systerstället _persistLastPollAt, som redan try/catch:ade sin set().
 *      En kastande store gav därför: _stopped=false (kedjan "startad"),
 *      _pollTimer=null (ingen kedja), noll pollar. Kastet slog dessutom igenom
 *      muxens `await this._hubClient.connect(...)` och avbröt hela
 *      reconcile-svansen (skugg-/hälsotimern + aggregatet).
 *
 *  (2) Feed-vaktens kedjedödsgren (app.js:_checkAishubFeedHealth) kräver ett
 *      FINIT perFeed.lastPollStartedAt, och den stämpeln sätts först när en
 *      poll faktiskt startat. Före första pollen är den null ⇒ grenen är inert.
 *      Tystnadsgrenen strax nedanför kräver isConnected, som kräver ett
 *      välformat svar. Unionen av vaktens båda grenar är alltså blind exakt i
 *      det fönster där (1) dödar kedjan — och ett enda kick hade räckt.
 *
 * Fixen: skydda läsningen där systerstället redan är skyddat, och exponera ett
 * ARMERINGSÖGONBLICK (klientens _armedAt ⇒ perFeed.pollChainArmedAt) som
 * vakten kan falla tillbaka på när lastPollStartedAt saknas. MEDVETET INTE
 * den persisterade configuredSince — den ser gammal ut direkt vid boot och
 * hade gett en falsk kick.
 *
 * DEN HÄR FILEN LÅSER PRODUCENTEN (klient + muxens projektion). KONSUMENTEN —
 * att app.js:_checkAishubFeedHealth faktiskt faller tillbaka på fältet — låses
 * i tests/n30-app-fallback.test.js. Utan den andra halvan var fältet död kod
 * och defekten kvarstod öppen i produktion; håll båda vid liv.
 */

const CFG = AIS_CONFIG.AISHUB;
const CHAIN_DEAD_MS = 2 * CFG.BACKOFF_MAX_MS + 60 * 1000; // 11 min, app.js-spegel

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

/**
 * Store vars get() kastar — Homeys settings-lager under diskfel/korrupt
 * lagring. set() lämnas fungerande: poängen är att ISOLERA läsvägen.
 */
function makeThrowingGetStore() {
  const store = makeStore();
  store.get = () => {
    throw new Error('settings backend unavailable');
  };
  return store;
}

const lines = (fn) => fn.mock.calls.map((c) => c.join(' '));

// ============================================================================
// A) LÄSVÄGEN — en kastande settings.get får aldrig döda kedjan
// ============================================================================
describe('N30-A: kastande settings.get', () => {
  let client;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T10:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    logger = makeLogger();
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('connect ÖVERLEVER och bokar polltimern — zombien uppstår inte', async () => {
    client = new AISHubClient(logger, makeThrowingGetStore());

    await expect(client.connect('testuser')).resolves.toBeUndefined();

    // Kedjan är både startad OCH schemalagd — det var precis kombinationen
    // som saknades: stoppad=false utan timer är zombien.
    expect(client._stopped).toBe(false);
    expect(client._pollTimer).not.toBeNull();
    // Felet tystas inte bort: det ska gå att se i loggen varför spärren föll
    // tillbaka på minnet.
    expect(lines(logger.debug).some((l) => l.includes('Kunde inte läsa poll-spärren'))).toBe(true);
    // MUTATIONSPROV: tas try/catch:en i _readLastPollAt bort kastar connect
    // här och båda expect-raderna ovan blir oåtkomliga.
  });

  test('läsningen faller tillbaka på minnesstämpeln och rör INTE skrivthrotteln', () => {
    client = new AISHubClient(logger, makeThrowingGetStore());
    const stamp = Date.now() - 10 * 1000;
    client._memLastPollAt = stamp;
    client._persistedPollAt = stamp + CFG.LAST_POLL_PERSIST_INTERVAL_MS;

    expect(client._readLastPollAt()).toBe(stamp);
    // Vi vet inget NYTT om nyckeln när läsningen kastar. Att nolla
    // _persistedPollAt (som den främmande-skrivare-grenen gör) hade släppt
    // skrivthrotteln lös mot en store som redan är trasig.
    expect(client._persistedPollAt).toBe(stamp + CFG.LAST_POLL_PERSIST_INTERVAL_MS);
  });

  test('kedjan lever vidare även när läsningen kastar MITT I en poll', async () => {
    const store = makeStore();
    client = new AISHubClient(logger, store);
    client._httpGet = jest.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify([
        {
          ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: 0,
        },
        [],
      ]),
    }));

    await client.connect('testuser');
    // Storen går sönder EFTER schemaläggningen: _poll:s egen läsning drabbas.
    store.get = () => {
      throw new Error('settings backend unavailable');
    };

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Pollen genomfördes (spärren föll tillbaka på minnet = 0 ⇒ släpper) och
    // kedjan bokade nästa. _poll:s anrop var redan skyddat av _scheduleNext:s
    // .catch, men då till priset av en 'Oväntat fel'-rad och en tappad poll.
    expect(client._counters.polls).toBe(1);
    expect(client._pollTimer).not.toBeNull();
    expect(lines(logger.error).some((l) => l.includes('Oväntat fel i pollkedjan'))).toBe(false);
  });
});

// ============================================================================
// B) ARMERINGSÖGONBLICKET — vaktens enda fönster mot en kedja som aldrig pollat
// ============================================================================
describe('N30-B: armeringsögonblicket', () => {
  let client;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T10:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    logger = makeLogger();
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('oarmerad klient rapporterar null — ALDRIG 0', () => {
    client = new AISHubClient(logger, makeStore());
    expect(client._armedAt).toBe(0);
    // 0 är finit: en läsare som mäter `now - stämpeln` hade tolkat det som
    // 1970 och kickat kedjan direkt vid varje boot.
    expect(client.getConnectionStats().pollChainArmedAt).toBeNull();
  });

  test('connect armerar; disconnect avarmerar', async () => {
    client = new AISHubClient(logger, makeStore());
    const t0 = Date.now();

    await client.connect('testuser');
    expect(client.getConnectionStats().pollChainArmedAt).toBe(t0);

    client.disconnect();
    expect(client.getConnectionStats().pollChainArmedAt).toBeNull();

    // Åter-connect på samma instans armerar om (mux-teardown river normalt
    // barnet, men klienten får inte förlita sig på det).
    jest.advanceTimersByTime(5000);
    await client.connect('testuser');
    expect(client.getConnectionStats().pollChainArmedAt).toBe(t0 + 5000);
  });

  test('armeringen sätts FÖRE resten av connect — vakten ser kedjan även om något kastar', async () => {
    client = new AISHubClient(logger, makeStore());
    // Simulerar VILKET som helst framtida kast mellan armeringen och
    // schemaläggningen (det historiska var settings.get; raden är nu skyddad,
    // men ordningen är andra försvarslinjen och ska vara låst).
    client._readLastPollAt = () => {
      throw new Error('oväntat fel i spärrläsningen');
    };

    await expect(client.connect('testuser')).rejects.toThrow('oväntat fel i spärrläsningen');

    // Zombiens signatur: startad men utan kedja.
    expect(client._stopped).toBe(false);
    expect(client._pollTimer).toBeNull();
    // ... men vakten KAN se den, och kicken väcker den. Det är hela poängen
    // med att armeringen ligger före: utan stämpeln är kedjan osynlig för
    // vakten i evighet.
    expect(client.getConnectionStats().pollChainArmedAt).toBe(Date.now());
    delete client._readLastPollAt; // storen är hel — bara connect var trasig
    client.forceReschedule();
    expect(client._pollTimer).not.toBeNull();
    // MUTATIONSPROV: flyttas `this._armedAt = now` ned efter
    // _readLastPollAt() blir stämpeln null här och testet faller.
  });
});

// ============================================================================
// C) PROJEKTIONEN — feed-vaktens enda fönster mot klienten
// ============================================================================
describe('N30-C: perFeed bär armeringsögonblicket', () => {
  let mux;
  let logger;

  /**
   * Solo-'aishub': enda läget som ger ett hub-barn UTAN att ett stream-barn
   * försöker öppna en riktig websocket. HTTP-vägen neutraliseras.
   */
  const settleHub = async (store) => {
    mux = new AISSourceMultiplexer(logger, store);
    mux.applySourceConfig({ source: 'aishub', apiKey: null, aishubUsername: 'testuser' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    if (mux._hubClient) {
      mux._hubClient._httpGet = jest.fn(async () => ({
        statusCode: 200,
        body: JSON.stringify([
          {
            ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: 0,
          },
          [],
        ]),
      }));
    }
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T10:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    logger = makeLogger();
  });

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('utan hub-barn: fältet finns och är null — en tyst undefined vore samma blindhet', () => {
    mux = new AISSourceMultiplexer(logger, makeStore());
    const feed = mux.getConnectionStats().perFeed.aishub;
    expect(feed.configured).toBe(false);
    expect('pollChainArmedAt' in feed).toBe(true);
    expect(feed.pollChainArmedAt).toBeNull();
  });

  test('äldre/stubbat hub-barn utan fältet projiceras som null — aldrig undefined', () => {
    mux = new AISSourceMultiplexer(logger, makeStore());
    // Samma anda som FG-B1:s guard i app.js: projektionen får inte anta att
    // barnet redan känner till fältet (kontraktstester, framtida klienter).
    mux._hubClient = {
      isConnected: false,
      _memLastPollAt: 0,
      getConnectionStats: () => ({}),
      disconnect: () => {},
      removeAllListeners: () => {},
    };
    const feed = mux.getConnectionStats().perFeed.aishub;
    expect(feed.configured).toBe(true);
    expect(feed.pollChainArmedAt).toBeNull();
  });

  test('FÖNSTRET: armerad men ingen poll startad ⇒ lastPollStartedAt null, armeringen finit', async () => {
    await settleHub(makeStore());
    const t0 = Date.now();
    const feed = mux.getConnectionStats().perFeed.aishub;

    expect(feed.configured).toBe(true);
    // Exakt det blinda fönstret: vaktens kedjedödsgren har inget att mäta på ...
    expect(feed.lastPollStartedAt).toBeNull();
    // ... men armeringen ger den ett ankare.
    expect(feed.pollChainArmedAt).toBe(t0);
  });

  test('efter första pollen tar lastPollStartedAt över; armeringen ligger kvar som kedjans ålder', async () => {
    await settleHub(makeStore());
    const t0 = Date.now();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const feed = mux.getConnectionStats().perFeed.aishub;
    expect(Number.isFinite(feed.lastPollStartedAt)).toBe(true);
    expect(feed.pollChainArmedAt).toBe(t0); // oförändrad — armering ≠ polltid
  });

  test('E2E: kastande settings.get ger inte längre en zombie i muxen', async () => {
    await settleHub(makeThrowingGetStore());

    expect(mux._hubClient).not.toBeNull();
    expect(mux._hubClient._stopped).toBe(false);
    expect(mux._hubClient._pollTimer).not.toBeNull();
    // Reconcile-svansen körde klart. Före fixen kastade `await connect()` här
    // och hälsotimern (solo-lägets bärare av [AISHUB_HEALTH]) skapades aldrig.
    expect(mux._hubHealthTimer).not.toBeNull();
    expect(lines(logger.error).some((l) => l.includes('Källomställning misslyckades'))).toBe(false);
    expect(mux.getConnectionStats().perFeed.aishub.pollChainArmedAt).toBe(Date.now());
  });

  test('vaktens FALLBACK-uttryck: armerad + noll pollar i 11 min ⇒ kick (datat räcker)', async () => {
    await settleHub(makeStore());
    // Kedjan dog före första pollen (timern tappad, t.ex. ett kast i connect).
    clearTimeout(mux._hubClient._pollTimer);
    mux._hubClient._pollTimer = null;

    jest.setSystemTime(new Date(Date.now() + CHAIN_DEAD_MS + 1000));
    const feed = mux.getConnectionStats().perFeed.aishub;

    // Emulering av raden i app.js:_checkAishubFeedHealth. KONSUMENTEN HAR
    // LANDAT (2026-08-23) och låses i tests/n30-app-fallback.test.js genom
    // riktig mux + riktigt app-anrop; här låses bara att DATAT räcker för den,
    // så producentens kontrakt kan brytas oberoende av app-lagret.
    const anchor = Number.isFinite(feed.lastPollStartedAt)
      ? feed.lastPollStartedAt
      : feed.pollChainArmedAt;
    expect(Number.isFinite(anchor)).toBe(true);
    expect(Date.now() - anchor).toBeGreaterThan(CHAIN_DEAD_MS);

    // Och kicken väcker faktiskt kedjan (kickAishub → forceReschedule).
    mux.kickAishub();
    expect(mux._hubClient._pollTimer).not.toBeNull();
  });

  test('en STOPPAD klient ser aldrig ut som armerad-men-tyst', async () => {
    await settleHub(makeStore());
    mux._hubClient.disconnect();
    expect(mux.getConnectionStats().perFeed.aishub.pollChainArmedAt).toBeNull();
    // MUTATIONSPROV: tas avarmeringen bort ur disconnect() rapporteras en
    // gammal stämpel och vaktens fallback hade kickat en kedja som med flit
    // står still — strike-trappan räknar upp och trubbar av vakten.
  });
});
