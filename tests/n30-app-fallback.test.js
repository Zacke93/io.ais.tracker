'use strict';

jest.mock('homey');

/**
 * N30 (helkodsgranskning RUNDA 5, 2026-08-23) — ANDRA HALVAN: KONSUMENTEN.
 *
 * Systerfilen tests/n30-armeringsogonblick.test.js låser PRODUCENTEN (klientens
 * _armedAt och muxens projektion pollChainArmedAt) och emulerar där bara det
 * uttryck som app-lagret borde använda. Den här filen låser att app-lagret
 * FAKTISKT använder det — utan den var fältet död kod och den diagnostiserade
 * defekten kvarstod i produktion:
 *
 *   Feed-vaktens kedjedödsgren (_checkAishubFeedHealth) läste bara
 *   perFeed.lastPollStartedAt, som är null ända tills en poll faktiskt startat.
 *   Fönstret mellan connect() och första pollen var därför blint i BÅDA
 *   vaktens grenar — tystnadsgrenen strax nedanför returnerar på isConnected,
 *   som kräver ett välformat svar. En kedja som dog just där (tappad timer)
 *   var alltså osynlig i EVIGHET, inte i 11 minuter, och ETT kick hade räckt.
 *
 * FIXEN: chainClock = finit lastPollStartedAt, annars finit pollChainArmedAt.
 * Fallbacken är STRIKT UNDERORDNAD (har en poll någonsin startat är den
 * sannare) och båda leden går via Number.isFinite, så äldre mux-kontrakt och
 * teststubbar utan fältet beter sig exakt som förut.
 *
 * PIPELINEN ÄR ÄKTA: feedStats kommer ur en RIKTIG AISSourceMultiplexer med ett
 * riktigt AISHubClient-barn (bara HTTP-vägen neutraliserad), och kicken går
 * hela vägen ned till klientens forceReschedule.
 *
 * MUTATIONSPROV (dokumenterat, kört): tas `else if`-grenen för
 * pollChainArmedAt bort ur _checkAishubFeedHealth blir 2 tester röda
 * (kick-testet och loggtextens test). Byts fallbackens ordning så armeringen
 * vinner över lastPollStartedAt blir subordinationstestet rött.
 */

const AISBridgeApp = require('../app');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const { AIS_CONFIG } = require('../lib/constants');

const CFG = AIS_CONFIG.AISHUB;
const CHAIN_DEAD_MS = 2 * CFG.BACKOFF_MAX_MS + 60 * 1000; // 11 min

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

/** App-skal med bara det _checkAishubFeedHealth faktiskt rör. */
function makeApp(mux) {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.log = logger.log;
  app.debug = logger.debug;
  app.error = logger.error;
  app.aisClient = mux;
  app._aishubWatchdogStrikes = 0;
  return app;
}

const lines = (fn) => fn.mock.calls.map((c) => c.join(' '));

/**
 * KONTROLLARM — HEAD:s läsare, ordagrant. Finns i samma fil så A/B:n syns
 * bredvid varandra: samma feedStats, två läsare, olika svar.
 */
const headWouldKick = (feed, now) => Number.isFinite(feed.lastPollStartedAt)
  && now - feed.lastPollStartedAt > CHAIN_DEAD_MS;

describe('N30: feed-vaktens kedjedödsgren faller tillbaka på armeringen', () => {
  let mux;
  let logger;

  /**
   * Solo-'aishub': enda läget som ger ett hub-barn UTAN att ett stream-barn
   * försöker öppna en riktig websocket. HTTP-vägen neutraliseras.
   */
  const settleHub = async (store = makeStore()) => {
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

  /** Kedjan dör före sin första poll: timern tappas, klienten tror den lever. */
  const killChainBeforeFirstPoll = () => {
    clearTimeout(mux._hubClient._pollTimer);
    mux._hubClient._pollTimer = null;
  };

  const feed = () => mux.getConnectionStats().perFeed.aishub;

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

  test('FIXEN: armerad, aldrig pollad, 11 min död ⇒ vakten kickar', async () => {
    await settleHub();
    const kick = jest.spyOn(mux, 'kickAishub');
    killChainBeforeFirstPoll();
    jest.setSystemTime(new Date(Date.now() + CHAIN_DEAD_MS + 1000));

    const app = makeApp(mux);
    const stats = feed();
    // Exakt det blinda fönstret: ingen poll har startat.
    expect(stats.lastPollStartedAt).toBeNull();
    expect(Number.isFinite(stats.pollChainArmedAt)).toBe(true);

    app._checkAishubFeedHealth(stats);

    expect(kick).toHaveBeenCalledTimes(1);
    expect(app._aishubWatchdogStrikes).toBe(1);
    // Kicken gick hela vägen: klienten har en timer igen.
    expect(mux._hubClient._pollTimer).not.toBeNull();
  });

  test('KONTROLLARM (HEAD): samma feedStats, gamla läsaren ⇒ ingen kick alls', async () => {
    await settleHub();
    killChainBeforeFirstPoll();
    jest.setSystemTime(new Date(Date.now() + CHAIN_DEAD_MS + 1000));

    // Detta ÄR defekten: HEAD:s uttryck är falskt för evigt i det här fönstret.
    expect(headWouldKick(feed(), Date.now())).toBe(false);
    jest.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
    expect(headWouldKick(feed(), Date.now())).toBe(false);
  });

  test('LOGGRADEN säger att klockan är armeringens, inte en polls', async () => {
    await settleHub();
    killChainBeforeFirstPoll();
    jest.setSystemTime(new Date(Date.now() + CHAIN_DEAD_MS + 1000));

    const app = makeApp(mux);
    app._checkAishubFeedHealth(feed());

    const watchdogLines = lines(app.log).filter((l) => l.includes('[FEED_WATCHDOG] aishub'));
    expect(watchdogLines).toHaveLength(1);
    expect(watchdogLines[0]).toContain('sedan kedjan armerades');
    expect(watchdogLines[0]).toContain('före sin första poll');
  });

  test('TRÖSKELN GÄLLER ÄVEN FALLBACKEN: 10 min efter armering ⇒ tyst', async () => {
    await settleHub();
    const kick = jest.spyOn(mux, 'kickAishub');
    killChainBeforeFirstPoll();
    jest.setSystemTime(new Date(Date.now() + CHAIN_DEAD_MS - 60 * 1000));

    const app = makeApp(mux);
    app._checkAishubFeedHealth(feed());

    expect(kick).not.toHaveBeenCalled();
    expect(app._aishubWatchdogStrikes).toBe(0);
  });

  test('SUBORDINATIONEN: färsk poll + gammal armering ⇒ ingen falsk kick', async () => {
    await settleHub();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const armedAt = feed().pollChainArmedAt;
    expect(Number.isFinite(feed().lastPollStartedAt)).toBe(true);

    // En LÅNGLIVAD, FRISK kedja: armeringen är timmar gammal, medan både
    // pollen och det senaste lyckade svaret är en minut gammalt. Utan strikt
    // ordning hade fallbacken kickat vid varje tick i evighet.
    jest.setSystemTime(new Date(Date.now() + 3 * 60 * 60 * 1000));
    mux._hubClient._memLastPollAt = Date.now() - 60 * 1000; // klientens kadensklocka
    mux._hubClient._lastOkResponseAt = Date.now() - 60 * 1000; // tystnadsgrenens klocka
    const kick = jest.spyOn(mux, 'kickAishub');

    const app = makeApp(mux);
    const stats = feed();
    expect(Date.now() - armedAt).toBeGreaterThan(CHAIN_DEAD_MS);
    expect(Date.now() - stats.lastPollStartedAt).toBeLessThan(CHAIN_DEAD_MS);
    app._checkAishubFeedHealth(stats);

    // Ingen gren fyrar: kedjan är frisk. Att armeringen är 3 h gammal får
    // alltså ingen konsekvens — den är STRIKT underordnad.
    expect(kick).not.toHaveBeenCalled();
    expect(app._aishubWatchdogStrikes).toBe(0);
    expect(lines(app.log).filter((l) => l.includes('[FEED_WATCHDOG]'))).toHaveLength(0);
  });

  test('ÄLDRE KONTRAKT/STUBB utan fältet ⇒ exakt oförändrat beteende', async () => {
    mux = new AISSourceMultiplexer(logger, makeStore());
    mux._hubClient = {
      isConnected: false,
      _memLastPollAt: 0,
      getConnectionStats: () => ({}),
      forceReschedule: jest.fn(),
      disconnect: () => {},
      removeAllListeners: () => {},
    };
    const kick = jest.spyOn(mux, 'kickAishub');
    jest.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));

    const app = makeApp(mux);
    const stats = feed();
    expect(stats.configured).toBe(true);
    expect(stats.lastPollStartedAt).toBeNull();
    expect(stats.pollChainArmedAt).toBeNull();

    app._checkAishubFeedHealth(stats);

    expect(kick).not.toHaveBeenCalled();
    expect(app._aishubWatchdogStrikes).toBe(0);
  });

  test('AUTH-PAUSEN VINNER FORTFARANDE (FG-A1 orörd av fallbacken)', async () => {
    await settleHub();
    const kick = jest.spyOn(mux, 'kickAishub');
    killChainBeforeFirstPoll();
    jest.setSystemTime(new Date(Date.now() + CHAIN_DEAD_MS + 1000));
    // 6h-pausen är en AVSIKTLIG paus, inte en död kedja.
    mux._hubClient._authCooldownUntil = Date.now() + 5 * 60 * 60 * 1000;

    const app = makeApp(mux);
    app._aishubWatchdogStrikes = 3;
    const stats = feed();
    expect(stats.authCooldownMsLeft).toBeGreaterThan(0);

    app._checkAishubFeedHealth(stats);

    expect(kick).not.toHaveBeenCalled();
    expect(app._aishubWatchdogStrikes).toBe(0);
  });

  test('EN STOPPAD KLIENT väcks aldrig av fallbacken (avarmerad)', async () => {
    await settleHub();
    mux._hubClient.disconnect();
    const kick = jest.spyOn(mux, 'kickAishub');
    jest.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));

    const app = makeApp(mux);
    const stats = feed();
    expect(stats.pollChainArmedAt).toBeNull();

    app._checkAishubFeedHealth(stats);

    expect(kick).not.toHaveBeenCalled();
  });
});
