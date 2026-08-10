'use strict';

/**
 * B2 (etapp 7, 2026-08-05): källdödslarmet — totaltystnadsgrenen + den
 * eskalerande notistrappan i _checkCrossFeedSilence.
 *
 * Bakgrund (both-dygn 1): aisstream dog i 4,5 h utan att användaren fick
 * någon signal — en ofarlig 16-minutersblink hade bränt den platta
 * 24 h-dedupen, och "ALLA källor tysta" saknade gren helt (båda
 * korstystnadsgrenarna kräver en FRISK granne; enkälleläget täcktes inte
 * alls av den tidiga config-guarden). Testerna låser:
 *   1. totalgrenen fyrar när alla pipeline-matande källor tystnat
 *   2. trappan (1h/4h) ger EN notis per nivå och dygn (dedup per nyckel)
 *   3. enkälleläge + skuggläge täcks (relevanta källor = pipeline-matande)
 *   4. en blink-bränd basnyckel tystar INTE nivånycklarna
 *   5. rollback vid leveransfel (svälj-fällan: asserta app.error + omförsök)
 *   6. befintliga korstystnadsgrenar oförändrade + eskalerade
 *
 * FÄLTPROVET 2026-08-08 (42 h) fällde tre av larmets fyra mekanismer. B2e/B2f/
 * B2g/B2c-blocken nedan är de RIKTADE SYNTETISKA PROV flaggskeppsfunktionen
 * saknade — den var fältoprövad i den enda riktning som betyder något:
 *   7.  B2e: aldrig-levererat-fallet (timeSinceLastMessage null) fanns INTE i
 *       den här filen; sentinelen Infinity uppfyllde båda eskaleringsstegen och
 *       brände alla tre 24h-nycklarna 15 min efter appstart
 *   8.  B2f: en källa som flappar snabbare än 15 min kunde aldrig dömas, för
 *       grinden läste SOCKETENS uptime (nollställs vid varje omanslutning)
 *   9.  B2g: totaltystnadsgrenen nåddes aldrig vid ett äkta totalavbrott, och
 *       en enda flappande källa avväpnade hela larmet
 *   10. B2c: connection_status speglar degraderat läge (enum + skrivväg)
 *
 * SÖNDAGSFÄLTET 2026-08-09 (P3) fällde B2c:s FÄRSKHETSSIDA. Enheten skrev
 * "connected — båda konfigurerade AIS-källor levererar igen" kl 09:47:03 mitt
 * i aisstreams totala tystnad, och tillbaka till degraded 09:49:03. Orsak:
 * hFresh mätte ACCEPTERADE emissioner mot 2 min, men AISHubs 65s-poll dedupar
 * oförändrade poster ⇒ 130-210 s mellan accepterade är NORMALDRIFT. P3-blocket
 * längst ned låser de tre delarna av fixen:
 *   11. pollkällans färskhet mäts på senaste VÄLFORMADE SVAR (FRESH_POLL_MS)
 *   12. asymmetrisk hysteres: degraderat släpps bara av att den TYSTA källan
 *       levererar igen — aldrig av att grannens färskhet dippar
 *   13. startgrinden: 'connected' kräver en accepterad position i pipelinen
 *
 * ADVERSARIELL GRANSKNING 2026-08-10 (F1) fällde två av P3:s tre delar som
 * SANNINGSPÅSTÅENDEN, och blocken längst ned låser den nya semantiken:
 *   14. KX-1: 'degraded' + aisstream-notisen kräver att grannen LEVERERAT
 *       (hSilence <= SILENT_MS), inte bara svarat. En tom natt (båda tysta,
 *       hubben svarar var 65:e s) skrev annars "halverad redundans" medan
 *       appen var blind, skickade pushen "medan AISHub flödar" och brände
 *       alla tre 24h-nycklarna varje lugn natt.
 *   15. STARTGRINDEN mäter KÄLLSVAR (öppnad socket / välformat AISHub-svar /
 *       accepterad position), inte trafik: kravet på en position lämnade en
 *       HELT frisk app på "Frånkopplad" i timmar i en tom kanal, utan timeout
 *       och utan skyddsnät. Skyddssyftet (död kedja ⇒ aldrig 'connected')
 *       provas separat.
 *
 * ANVÄNDARBESLUT U12 (2026-08-10) drar samma gräns i TOTALGRENEN. F1 skilde
 * "svarar" från "levererar" på hubbsidan, men "appen är blind" dömde fortfarande
 * på ren leverans — och en tom kanal är NORMALDRIFT nattetid (korpusbanken:
 * värsta normala trafikuppehåll 198,7 min över 336,6 h inspelad drift). Larmet
 * fyrade alltså varje lugn natt och brände sina 24h-nycklar i förskott:
 *   16. feeds:silent + eskaleringen kräver ÄKTA BLINDHET — ingen konfigurerad
 *       källa SVARAR ens (aisstream: socketen nere/429-cooldown; aishub:
 *       pollklockan ofärsk). Svarande källor ⇒ grenen är TYST.
 *   17. SKYDDSNÄTET: alla källor svarar men noll data på 4 h ⇒ EN notis på egen
 *       nyckel ('feeds:empty:4h', FEED_SILENCE.EMPTY_CHANNEL_ALERT_MS) — fångar
 *       bbox-/kontofel utan att spamma lugna nätter.
 * TOM NATT-familjen längst ned är omskriven efter U12; dess SKYDDSSYFTE (äkta
 * blindhet larmar, och larmar direkt även efter en tyst natt) är kvar och
 * skärpt.
 */

process.env.NODE_ENV = 'test';
global.__TEST_MODE__ = true;

const fs = require('fs');
const path = require('path');
const AISBridgeApp = require('../app');
const AISStreamClient = require('../lib/connection/AISStreamClient');
const { AIS_CONFIG, CONNECTION_ALERT, FEED_SILENCE } = require('../lib/constants');

const MIN = 60 * 1000;

function makeApp({ hubFeedsPipeline = true } = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app.homey = {
    settings: { get: () => null, on: jest.fn() },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  app._hubFeedsPipeline = jest.fn().mockReturnValue(hubFeedsPipeline);
  return app;
}

const feed = (silenceMs, { configured = true, uptime = 10 * 60 * MIN } = {}) => ({
  configured,
  timeSinceLastMessage: silenceMs,
  uptime,
});

const flush = () => new Promise((resolve) => {
  setImmediate(resolve);
});
const sentKeys = (app) => [...(app._connectionIssueNotifiedAt || new Map()).keys()];
const notisCount = (app) => app.homey.notifications.createNotification.mock.calls.length;

describe('B2: totaltystnadsgrenen ("appen är blind")', () => {
  test('båda källorna tysta 16 min i both-läge → basnotis feeds:silent, ingen nivånyckel', async () => {
    const app = makeApp();
    app._checkCrossFeedSilence({ aisstream: feed(16 * MIN), aishub: feed(17 * MIN) });
    await flush();

    expect(sentKeys(app)).toContain('feeds:silent');
    expect(sentKeys(app)).not.toContain('feeds:silent:1h');
    // Korstystnadsgrenarna kräver frisk granne — ingen av dem får ha fyrat.
    expect(sentKeys(app)).not.toContain('aisstream:silent');
    expect(sentKeys(app)).not.toContain('aishub:silent');
    const logged = app.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[FEED_SILENT]');
    expect(logged).toContain('INGEN aktiv AIS-källa');
  });

  test('61 min → bas + 1h-nivån; upprepad kontroll ger inga dubbletter', async () => {
    const app = makeApp();
    const perFeed = { aisstream: feed(61 * MIN), aishub: feed(61 * MIN) };
    app._checkCrossFeedSilence(perFeed);
    await flush();

    expect(sentKeys(app)).toEqual(expect.arrayContaining(['feeds:silent', 'feeds:silent:1h']));
    expect(sentKeys(app)).not.toContain('feeds:silent:4h');
    const after = notisCount(app);

    app._checkCrossFeedSilence(perFeed);
    await flush();
    expect(notisCount(app)).toBe(after); // 24h-dedup per nyckel
  });

  test('4 h 1 min → alla tre nivåerna (bas, 1h, 4h)', async () => {
    const app = makeApp();
    app._checkCrossFeedSilence({ aisstream: feed(241 * MIN), aishub: feed(241 * MIN) });
    await flush();
    expect(sentKeys(app)).toEqual(
      expect.arrayContaining(['feeds:silent', 'feeds:silent:1h', 'feeds:silent:4h']),
    );
  });

  test('ENKÄLLELÄGE (ingen aishub konfigurerad) täcks — guarden får inte svälja larmet', async () => {
    const app = makeApp();
    app._checkCrossFeedSilence({ aisstream: feed(20 * MIN), aishub: undefined });
    await flush();
    expect(sentKeys(app)).toContain('feeds:silent');
  });

  test('SKUGGLÄGE: AISHub är mätinstrument — totalgrenen dömer på aisstream ensam', async () => {
    const app = makeApp({ hubFeedsPipeline: false });
    // aisstream tyst 20 min, hubben FLÖDAR (färsk) men matar inte pipelinen.
    app._checkCrossFeedSilence({ aisstream: feed(20 * MIN), aishub: feed(1 * MIN) });
    await flush();
    expect(sentKeys(app)).toContain('feeds:silent');
  });

  test('källa utan upptid döms inte (nystartad app ger inget falsklarm)', async () => {
    const app = makeApp();
    app._checkCrossFeedSilence({
      aisstream: feed(20 * MIN, { uptime: 2 * MIN }),
      aishub: feed(20 * MIN, { uptime: 2 * MIN }),
    });
    await flush();
    expect(sentKeys(app)).toHaveLength(0);
    expect(notisCount(app)).toBe(0);
  });

  test('BLINK-BRÄND basnyckel tystar inte nivånyckeln (both-dygn 1-hålet)', async () => {
    const app = makeApp();
    // En tidigare 16-minutersblink brände basnyckeln för 30 min sedan.
    app._connectionIssueNotifiedAt = new Map([['feeds:silent', Date.now() - 30 * MIN]]);
    app._checkCrossFeedSilence({ aisstream: feed(61 * MIN), aishub: feed(61 * MIN) });
    await flush();

    expect(notisCount(app)).toBe(1); // endast 1h-nivån — basen är dedupad
    expect(sentKeys(app)).toContain('feeds:silent:1h');
    expect(app.homey.notifications.createNotification.mock.calls[0][0].excerpt)
      .toContain('1h');
  });

  test('rollback vid leveransfel: nyckeln släpps och nästa kontroll försöker igen', async () => {
    const app = makeApp();
    app.homey.notifications.createNotification
      .mockRejectedValueOnce(new Error('timeline down'))
      .mockResolvedValue(undefined);

    app._checkCrossFeedSilence({ aisstream: feed(16 * MIN), aishub: feed(16 * MIN) });
    await flush();
    // Svälj-fällan: felet ska LOGGAS, inte försvinna tyst.
    expect(app.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create timeline notification'),
      expect.anything(),
    );
    expect(sentKeys(app)).not.toContain('feeds:silent'); // rollback

    app._checkCrossFeedSilence({ aisstream: feed(16 * MIN), aishub: feed(16 * MIN) });
    await flush();
    expect(sentKeys(app)).toContain('feeds:silent'); // omförsöket gick fram
  });
});

describe('B2: korstystnadsgrenarna — oförändrat basbeteende + eskalering', () => {
  test('aisstream tyst 70 min medan hubben flödar → bas + 1h, INTE totalgrenen', async () => {
    const app = makeApp();
    app._checkCrossFeedSilence({ aisstream: feed(70 * MIN), aishub: feed(1 * MIN) });
    await flush();
    expect(sentKeys(app)).toEqual(
      expect.arrayContaining(['aisstream:silent', 'aisstream:silent:1h']),
    );
    expect(sentKeys(app)).not.toContain('feeds:silent');
  });

  test('AISHub tyst 5 h i BOTH-läge → bas + 1h + 4h', async () => {
    const app = makeApp();
    app._checkCrossFeedSilence({ aisstream: feed(1 * MIN), aishub: feed(300 * MIN) });
    await flush();
    expect(sentKeys(app)).toEqual(
      expect.arrayContaining(['aishub:silent', 'aishub:silent:1h', 'aishub:silent:4h']),
    );
  });

  test('AISHub tyst i SKUGGLÄGE → logg men INGEN notis (fynd 17-principen orörd)', async () => {
    const app = makeApp({ hubFeedsPipeline: false });
    app._checkCrossFeedSilence({ aisstream: feed(1 * MIN), aishub: feed(20 * MIN) });
    await flush();
    expect(notisCount(app)).toBe(0);
    const logged = app.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('skuggläge');
  });
});

// ===========================================================================
// FÄLTPROVET 2026-08-08 — B2e/B2f/B2g/B2c
// ===========================================================================

/** Bygger en app som drivs via den RIKTIGA ingången _checkAISFeedHealth. */
function makeHealthApp({
  source = 'both',
  aishubUsername = 'station',
  isConnected = true,
  storedLedger = null,
} = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  const store = new Map([
    ['ais_api_key', 'KEY'],
    ['ais_source', source],
    ['aishub_username', aishubUsername],
  ]);
  if (storedLedger) store.set('feed_silence_ledger', storedLedger);
  app.homey = {
    settings: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: jest.fn((k, v) => store.set(k, v)),
      on: jest.fn(),
    },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  app._updateDeviceCapability = jest.fn();
  app._isConnected = isConnected;
  // P3-STARTGRINDEN (2026-08-09): blocken nedan modellerar en app som REDAN
  // tagit emot data (källorna bär lastMessageTime, fartyg spåras). Utan den
  // här markeringen håller startgrinden tillbaka varje 'connected'-skrivning
  // — grinden har egna prov i P3-blocket längst ned.
  // F1 (2026-08-10): grinden mäter numera KÄLLSVAR (öppnad socket / välformat
  // AISHub-svar / accepterad position), inte trafik — flaggan bytte namn.
  app._sourceEverResponded = true;
  app.aisClient = {
    isConnected,
    getConnectionStats: jest.fn(),
    reconnectWithKey: jest.fn().mockResolvedValue(undefined),
    kickAishub: jest.fn(),
  };
  return app;
}

/**
 * perFeed-post i klientens format. `lastMessageTime = null` = källan har ALDRIG
 * levererat (fältets fall: timeSinceLastMessage blir då null hos klienten).
 */
function perFeedEntry({
  configured = true, isConnected = true, lastMessageTime = null, uptime = 0,
}) {
  const now = Date.now();
  return {
    configured,
    isConnected,
    lastMessageTime,
    timeSinceLastMessage: lastMessageTime ? now - lastMessageTime : null,
    uptime,
    lastOkResponseAt: lastMessageTime,
  };
}

/**
 * OBS: flush() ovan använder setImmediate, som är FAKAT i blocken nedan
 * (jest.useFakeTimers). Mikrotask-flush är den enda som fungerar i båda
 * världarna — notisvägen sätter dessutom dedup-nyckeln FÖRE sitt await.
 */
const microFlush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const logText = (app) => app.log.mock.calls.map((c) => c.join(' ')).join('\n');
/** Endast källdödslarmets egna rader — det är de som bar "Infinity min" i fält. */
const feedSilentLines = (app) => logText(app).split('\n').filter((l) => l.includes('[FEED_SILENT]')).join('\n');

/** En hub som aldrig svarat kan inte vara ansluten (_flankUp kräver ett OK-svar). */
const deadHub = (extra = {}) => perFeedEntry({ isConnected: false, ...extra });
/**
 * U12: en aisstream som inte SVARAR — socketen är nere (nätfel, 429-cooldown,
 * ogiltig nyckel). Det är den enda källformen som får utlösa "appen är blind";
 * en ÖPPEN socket som aldrig levererar räknas som ett svar (aisstreams
 * serverdödsläge ägs av korstystnads-/watchdoggrenarna).
 */
const deadStream = (extra = {}) => perFeedEntry({ isConnected: false, ...extra });

describe('B2e: eskaleringstrappan kollapsar inte (F-9)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  test('ALDRIG levererat (timeSinceLastMessage null) → observerad tystnad, aldrig "Infinity"', async () => {
    const app = makeHealthApp();
    // U12: BÅDA källorna är svarslösa — annars äger tomkanalgrenen läget och
    // eskaleringstrappan berörs aldrig. Provet gäller MÅTTET, inte grinden.
    const stats = () => ({
      isConnected: true,
      perFeed: {
        aisstream: deadStream({ uptime: Date.now() - Date.parse('2026-08-08T00:00:00.000Z') }),
        aishub: deadHub({ uptime: Date.now() - Date.parse('2026-08-08T00:00:00.000Z') }),
      },
    });
    app.aisClient.getConnectionStats.mockImplementation(stats);

    app._checkAISFeedHealth(); // t0 — ankaret sätts
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toContain('feeds:silent');
    // KÄRNAN: 16 minuters observation får inte uppfylla 1h- eller 4h-steget.
    expect(sentKeys(app)).not.toContain('feeds:silent:1h');
    expect(sentKeys(app)).not.toContain('feeds:silent:4h');
    expect(feedSilentLines(app)).toContain('16 min');
    expect(feedSilentLines(app)).not.toContain('Infinity');
  });

  test('nivåerna nås EN I TAGET medan tystnaden växer (24h-nycklarna bränns inte i förskott)', async () => {
    const app = makeHealthApp();
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: {
        aisstream: deadStream({ uptime: 5 * MIN }), // kort uptime: irrelevant nu
        aishub: deadHub({ uptime: 5 * MIN }),
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();
    expect(sentKeys(app)).toEqual(['feeds:silent']);

    jest.advanceTimersByTime(45 * MIN); // 61 min observerad tystnad
    app._checkAISFeedHealth();
    await microFlush();
    expect(sentKeys(app)).toEqual(['feeds:silent', 'feeds:silent:1h']);

    jest.advanceTimersByTime(180 * MIN); // 4 h 1 min
    app._checkAISFeedHealth();
    await microFlush();
    expect(sentKeys(app)).toEqual(['feeds:silent', 'feeds:silent:1h', 'feeds:silent:4h']);
  });

  test('OMSTART mitt i ett 50h-avbrott: bokförd historik får inte kollapsa trappan', async () => {
    // Fältets exakta scenario: appen startar om medan aisstream varit tyst i
    // 50 h. Persisterad lastMessageAt finns — men observationsfönstret är nytt.
    const ancient = Date.now() - 50 * 60 * MIN;
    const app = makeHealthApp({
      storedLedger: {
        aisstream: { lastMessageAt: ancient, configuredSince: ancient },
        aishub: { lastMessageAt: ancient, configuredSince: ancient },
      },
    });
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: { aisstream: deadStream(), aishub: deadHub() },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toEqual(['feeds:silent']); // INTE bas+1h+4h i samma stund
  });

  test('observationsankaret persisteras ALDRIG (annars återkommer kollapsen efter omstart)', () => {
    const app = makeHealthApp();
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: { aisstream: deadStream(), aishub: deadHub() },
    }));
    app._checkAISFeedHealth();
    app._persistFeedSilenceLedger(true);

    const written = app.homey.settings.set.mock.calls
      .filter((c) => c[0] === 'feed_silence_ledger').pop();
    expect(written).toBeDefined();
    expect(JSON.stringify(written[1])).not.toContain('observedSince');
  });

  test('SENTINEL-VAKTEN: _escalateSilenceNotices vägrar ett icke-ändligt mått (svälj-fällan)', async () => {
    const app = makeApp();
    app._escalateSilenceNotices('feeds:silent', Infinity, (l) => l);
    await microFlush();
    expect(notisCount(app)).toBe(0);
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining('ogiltigt tystnadsmått'));
  });
});

describe('B2f: upptidsgrinden släcker inte längre larmet vid omanslutning (F-10)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  test('aisstream flappar (uptime nollställs var 30:e s) medan hubben flödar → larmet fyrar ändå', async () => {
    const app = makeHealthApp();
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: {
        // Socketen är alltid nyfödd — exakt 503-stormens signatur (max 34,6 s).
        aisstream: perFeedEntry({ uptime: 30 * 1000 }),
        aishub: perFeedEntry({ lastMessageTime: Date.now(), uptime: 60 * MIN }),
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toContain('aisstream:silent');
    expect(logText(app)).toContain('aisstream har inte levererat');
  });

  test('SYMMETRIN: AISHub-pollen startas om men är tyst → hub-grenen fyrar', async () => {
    const app = makeHealthApp();
    const hubLast = Date.now() - 40 * MIN;
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: {
        aisstream: perFeedEntry({ lastMessageTime: Date.now(), uptime: 60 * MIN }),
        aishub: perFeedEntry({ lastMessageTime: hubLast, uptime: 20 * 1000 }),
      },
    }));

    app._checkAISFeedHealth();
    // Observationsfönstret måste passeras — ankaret kan aldrig hävda längre
    // tystnad än vi faktiskt bevakat källan (det är grinden, inte uptime).
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toContain('aishub:silent');
  });
});

describe('B2g: totaltystnadsgrenen är nåbar och kan inte avväpnas', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  test('(a) BÅDA KÄLLORNA NERE FRÅN START + frånkopplat aggregat → blindhetslarmet fyrar', async () => {
    const app = makeHealthApp({ isConnected: false });
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: false,
      perFeed: {
        aisstream: perFeedEntry({ isConnected: false }),
        aishub: perFeedEntry({ isConnected: false }),
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toContain('feeds:silent');
    expect(logText(app)).toContain('appen är blind');
    // Ingripandena ligger kvar bakom isConnected — klientens egen backoff äger
    // återanslutningen; vakten får inte konkurrera med den.
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
    expect(app.aisClient.kickAishub).not.toHaveBeenCalled();
  });

  test('(b) BÅDA NERE EFTER ATT HA LEVERERAT (frånkopplat aggregat) → blindhetslarmet fyrar', async () => {
    const app = makeHealthApp({ isConnected: false });
    const last = Date.now();
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: false,
      perFeed: {
        aisstream: perFeedEntry({ isConnected: false, lastMessageTime: last, uptime: 30 * MIN }),
        aishub: perFeedEntry({ isConnected: false, lastMessageTime: last, uptime: 30 * MIN }),
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(70 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toEqual(expect.arrayContaining(['feeds:silent', 'feeds:silent:1h']));
    expect(logText(app)).toContain('70 min');
  });

  test('(c) EN FLAPPANDE (nere just nu) + EN DÖD → en ung socket avväpnar inte larmet', async () => {
    const app = makeHealthApp();
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true, // "ansluten men döv" — aggregatet ser friskt ut
      // 503-stormens signatur: socketen är alltid nyfödd (max 34,6 s upptid).
      // U12 flyttar frågan från UPPTID till SVAR — här är socketen NERE i
      // mätögonblicket (mellan två flappar), alltså äkta blindhet. Att uptime
      // är 30 s får fortfarande inte rädda källan: B2g(2):s hela poäng.
      perFeed: {
        aisstream: deadStream({ uptime: 30 * 1000 }),
        aishub: deadHub({ uptime: 90 * MIN }), // död, aldrig levererat
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(20 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toContain('feeds:silent');
  });

  test('(c2) U12-SPEGELN: samma flapp men socketen UPPE ⇒ tyst tills 4h-nätet', async () => {
    const app = makeHealthApp();
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: {
        // Socketen är öppen i mätögonblicket = källan SVARAR. Enligt U12 är
        // det inte blindhet utan aisstreams serverdödsläge — det ägs av
        // watchdogen/korstystnadsgrenarna, inte av "appen är blind".
        aisstream: perFeedEntry({ uptime: 30 * 1000 }),
        aishub: {
          configured: true,
          isConnected: true,
          lastMessageTime: null, // tom kanal: hubben levererar aldrig …
          timeSinceLastMessage: null,
          uptime: 90 * MIN,
          lastOkResponseAt: Date.now(), // … men pollen svarar välformat
        },
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(20 * MIN);
    app._checkAISFeedHealth();
    await microFlush();
    expect(sentKeys(app)).toHaveLength(0); // ingen notis under 4 h

    jest.advanceTimersByTime(4 * 60 * MIN);
    app._checkAISFeedHealth();
    await microFlush();
    expect(sentKeys(app)).toEqual(['feeds:empty:4h']); // skyddsnätet fångar
  });

  test('(d) enkälleläge: aisstream ensam och död från start → blindhetslarmet fyrar', async () => {
    const app = makeHealthApp({ source: 'aisstream', aishubUsername: '' });
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: {
        aisstream: deadStream({ uptime: 40 * MIN }), // "död" = socketen nere
        aishub: deadHub({ configured: false }),
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toContain('feeds:silent');
  });

  test('FRISK TRAFIK: inget larm, ingen degradering (falsklarmsvakten)', async () => {
    const app = makeHealthApp();
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: {
        aisstream: perFeedEntry({ lastMessageTime: Date.now(), uptime: 60 * MIN }),
        aishub: perFeedEntry({ lastMessageTime: Date.now(), uptime: 60 * MIN }),
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(30 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toHaveLength(0);
    expect(app._updateDeviceCapability).not.toHaveBeenCalled();
  });
});

describe('B2c: connection_status speglar degraderat läge (användarbeslut U8)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  const halfDeadStats = (streamAlive) => () => ({
    isConnected: true,
    perFeed: {
      aisstream: streamAlive
        ? perFeedEntry({ lastMessageTime: Date.now(), uptime: 60 * MIN })
        : perFeedEntry({ uptime: 60 * MIN }),
      aishub: perFeedEntry({ lastMessageTime: Date.now(), uptime: 60 * MIN }),
    },
  });

  test('halv redundans → EN skrivning av "degraded"; återhämtning → "connected"', async () => {
    const app = makeHealthApp();
    app.aisClient.getConnectionStats.mockImplementation(halfDeadStats(false));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(app._updateDeviceCapability).toHaveBeenCalledWith('connection_status', 'degraded');
    expect(app._connectionFeedDegraded).toBe(true);
    // Flankcachen måste följa med, annars skriver _updateUI omedelbart tillbaka.
    expect(app._lastConnectionStatus).toBe('degraded');

    app._updateDeviceCapability.mockClear();
    app._checkAISFeedHealth(); // oförändrat läge → ingen omskrivning
    expect(app._updateDeviceCapability).not.toHaveBeenCalled();

    app.aisClient.getConnectionStats.mockImplementation(halfDeadStats(true));
    app._checkAISFeedHealth();
    expect(app._updateDeviceCapability).toHaveBeenCalledWith('connection_status', 'connected');
    expect(app._connectionFeedDegraded).toBe(false);
  });

  test('SKUGGLÄGE: tyst skugghub är inte degradering (fynd 17-principen)', async () => {
    const app = makeHealthApp({ source: 'shadow' });
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: {
        aisstream: perFeedEntry({ lastMessageTime: Date.now(), uptime: 60 * MIN }),
        aishub: deadHub({ uptime: 60 * MIN }),
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(app._connectionFeedDegraded).toBeFalsy();
    expect(app._updateDeviceCapability).not.toHaveBeenCalled();
  });

  test('FRÅNKOPPLAT AGGREGAT: flaggan sätts men skrivs inte — disconnected äger fältet', async () => {
    const app = makeHealthApp({ isConnected: false });
    app._isConnected = false;
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: false,
      perFeed: {
        aisstream: perFeedEntry({ isConnected: false, uptime: 60 * MIN }),
        aishub: perFeedEntry({ isConnected: false, lastMessageTime: Date.now(), uptime: 60 * MIN }),
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(16 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(app._connectionFeedDegraded).toBe(true); // flaggan sätts …
    expect(app._updateDeviceCapability).not.toHaveBeenCalled(); // … men skrivs inte
  });

  test('KONTRAKTET: enum-tillägget och versionsbumpen ligger i samma version', () => {
    const root = path.join(__dirname, '..');
    const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
    const source = readJson('.homeycompose/capabilities/connection_status.json');
    const generated = readJson('app.json').capabilities.connection_status;

    const ids = (c) => c.values.map((v) => v.id);
    expect(ids(source)).toEqual(['disconnected', 'connected', 'degraded']);
    // Homey-compose GENERERAR app.json — de två får aldrig glida isär, för det
    // är app.json enheten validerar skrivna värden mot.
    expect(ids(generated)).toEqual(ids(source));
    for (const v of generated.values) {
      expect(typeof v.title.en).toBe('string');
      expect(typeof v.title.sv).toBe('string');
    }

    // Ett Homey med gammal app.json som får 'degraded' KASTAR — därför måste
    // enum och skrivväg landa i samma appversion (U8).
    const { version } = readJson('app.json');
    expect(readJson('package.json').version).toBe(version);
    expect(readJson('.homeycompose/app.json').version).toBe(version);
    expect(version).toBe('5.4.0');
  });
});

// ===========================================================================
// SÖNDAGSFÄLTET 2026-08-09 — P3: CONNECTION_STATUS-SANNINGEN
// ===========================================================================

describe('P3: pollkällans färskhet + hysteres + startgrind', () => {
  const MINUTE_TICK_MS = 60 * 1000; // monitoring-loopens takt (hälsotickens)

  /**
   * FÄLTETS RÅDATA (app-20260809-112256.log, 09:33-09:56): glappen mellan
   * AISHubs ACCEPTERADE emissioner under normaldrift, medan varje poll
   * svarade välformat (HTTP 200, records=4). Fem av dem överstiger den gamla
   * FRESH_MS-tröskeln på 120 s — det var där enheten flippade till 'connected'.
   */
  const FIELD_ACCEPT_GAPS_MS = [134440, 131403, 133161, 134817, 206916];
  const HUB_POLL_MS = AIS_CONFIG.AISHUB.POLL_INTERVAL_MS; // 65 s

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  const statusWrites = (app) => app._updateDeviceCapability.mock.calls
    .filter((c) => c[0] === 'connection_status')
    .map((c) => c[1]);

  /**
   * Fältriggen: aisstream har ALDRIG levererat (socketen lever, 429-flappar),
   * AISHub pollar oavbrutet med välformade svar men släpper igenom accepterade
   * positioner enligt fältets glapp. `state` gör körningen styrbar:
   *   • streamLastMessageAt — sätt för att låta aisstream vakna
   *   • hubPollsFrozenAt    — frys pollklockan (hubben slutar svara)
   */
  function fieldRig({ streamSilentAtStart = 16 * MIN } = {}) {
    const app = makeHealthApp();
    const t0 = Date.now();
    const accepts = [t0];
    FIELD_ACCEPT_GAPS_MS.reduce((acc, gap) => {
      const next = acc + gap;
      accepts.push(next);
      return next;
    }, t0);
    const state = { streamLastMessageAt: null, hubPollsFrozenAt: null };
    const acceptAges = []; // ålder på senaste ACCEPTERADE emission vid varje tick

    app.aisClient.getConnectionStats.mockImplementation(() => {
      const now = Date.now();
      const lastAccept = accepts.filter((t) => t <= now).pop() ?? null;
      acceptAges.push(now - lastAccept);
      const lastPollAt = state.hubPollsFrozenAt !== null
        ? state.hubPollsFrozenAt
        : t0 + Math.floor((now - t0) / HUB_POLL_MS) * HUB_POLL_MS;
      return {
        isConnected: true,
        perFeed: {
          aisstream: {
            configured: true,
            isConnected: true,
            lastMessageTime: state.streamLastMessageAt,
            timeSinceLastMessage: state.streamLastMessageAt
              ? now - state.streamLastMessageAt : null,
            // Socketen har levt (utan att leverera) sedan före t0.
            uptime: (now - t0) + streamSilentAtStart,
          },
          aishub: {
            configured: true,
            isConnected: true,
            lastMessageTime: lastAccept,
            timeSinceLastMessage: now - lastAccept,
            uptime: (now - t0) + 60 * MIN,
            // FIXENS GRUNDDATA: senaste VÄLFORMADE SVAR (oavsett dedup).
            lastOkResponseAt: lastPollAt,
          },
        },
      };
    });
    return {
      app, t0, state, acceptAges,
    };
  }

  const tickMinutes = (app, minutes) => {
    for (let i = 0; i < minutes; i++) {
      jest.advanceTimersByTime(MINUTE_TICK_MS);
      app._checkAISFeedHealth();
    }
  };

  test('FLAPP-SCENARIOT: 130-210 s mellan accepterade ⇒ STABIL degraded, aldrig "connected"', async () => {
    const { app, acceptAges } = fieldRig();
    app._checkAISFeedHealth(); // t0: aisstream redan tyst 16 min ⇒ degraderas
    await microFlush();
    expect(statusWrites(app)).toEqual(['degraded']);

    tickMinutes(app, 25); // hela fältfönstret, en hälsotick i minuten
    await microFlush();

    // KÄRNAN: EN skrivning totalt. Före fixen skrev samma sekvens
    // degraded → connected → degraded → … i cykler.
    expect(statusWrites(app)).toEqual(['degraded']);
    expect(app._connectionFeedDegraded).toBe(true);
    expect(app._lastConnectionStatus).toBe('degraded');
    // VAKT: provet är bara skarpt om någon tick verkligen landade i ett glapp
    // > gamla FRESH_MS (2 min) sedan senaste ACCEPTERADE emission.
    expect(Math.max(...acceptAges)).toBeGreaterThan(2 * MIN);
    // …och HELA korstystnadsgrenen måste köra varje tick. Fältets starkaste
    // fingeravtryck var att dedupraden för 'aisstream:silent' SAKNADES på
    // exakt de två ticksen 09:47:03 och 09:48:03 — grenen (logg + notis +
    // eskalering) var avväpnad, inte bara capability-skrivningen. En rad per
    // tick efter den första (som skickade basnotisen).
    expect(sentKeys(app)).toContain('aisstream:silent');
    const dedupRader = app.debug.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes("nyckel 'aisstream:silent',"));
    // KX-14 (fältprovet 2026-08-09): raden STRYPS numera till var 5:e minut
    // (1 440 → ~288 rader/dygn). Beviset ovan får INTE försvinna med den —
    // det flyttar bara från radantalet till KONTROLLRÄKNAREN: 25 ticks ⇒
    // rader vid kontroll 1, 6, 11, 16, 21 och räknaren står på 25.
    expect(dedupRader).toHaveLength(5);
    expect(dedupRader.map((l) => l.match(/kontroll #(\d+)/)[1])).toEqual(['1', '6', '11', '16', '21']);
    expect(app._connectionIssueDedupCount.get('aisstream:silent')).toBe(25);
  });

  test('KX-14: en avväpnad korstystnadsgren syns i kontrollräknaren trots strypningen', async () => {
    // Fältets starkaste fingeravtryck var att dedupraden SAKNADES på exakt två
    // ticks. Med 5-minutersstrypningen finns ingen rad per tick att sakna —
    // beviset måste därför bäras av räknaren. Här hoppas två ticks över
    // (grenen kördes inte) och serien avslöjar det.
    const { app } = fieldRig();
    app._checkAISFeedHealth(); // basnotisen går iväg
    await microFlush();

    tickMinutes(app, 3);
    // Två "avväpnade" minuter: klockan går, men grenen körs aldrig.
    jest.advanceTimersByTime(2 * MINUTE_TICK_MS);
    tickMinutes(app, 3);
    await microFlush();

    const dedupRader = app.debug.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes("nyckel 'aisstream:silent',"));
    // 8 minuter har passerat men bara 6 kontroller kördes ⇒ raden vid
    // 5-minutersgränsen (minut 6) bär #4, inte #6. Skillnaden är exakt de två
    // tappade ticksen.
    expect(dedupRader.map((l) => l.match(/kontroll #(\d+)/)[1])).toEqual(['1', '4']);
    expect(app._connectionIssueDedupCount.get('aisstream:silent')).toBe(6);
  });

  test('SLÄPP-SCENARIOT: aisstream levererar igen ⇒ connected (och först då)', async () => {
    const { app, state } = fieldRig();
    app._checkAISFeedHealth();
    tickMinutes(app, 10);
    await microFlush();
    expect(statusWrites(app)).toEqual(['degraded']);

    state.streamLastMessageAt = Date.now(); // den TYSTA källan vaknar
    tickMinutes(app, 1);
    await microFlush();

    expect(statusWrites(app)).toEqual(['degraded', 'connected']);
    expect(app._connectionFeedDegraded).toBe(false);
    expect(app._connectionDegradedSilentFeed).toBeNull();
    // Texten är sann per konstruktion: den tysta källan HAR levererat.
    expect(logText(app)).toContain('båda konfigurerade AIS-källor levererar igen');
  });

  test('HYSTERESEN: grannens färskhet dippar (pollklockan fryser) ⇒ degraded HÅLLS', async () => {
    const { app, state } = fieldRig();
    app._checkAISFeedHealth();
    await microFlush();
    expect(statusWrites(app)).toEqual(['degraded']);

    // Hubben slutar svara helt — dess färskhet faller långt under tröskeln.
    // Före fixen släpptes degraderingen av EXAKT detta (läget blev sämre).
    state.hubPollsFrozenAt = Date.now();
    tickMinutes(app, 12);
    await microFlush();

    expect(statusWrites(app)).toEqual(['degraded']);
    expect(app._connectionFeedDegraded).toBe(true);
    expect(app._connectionDegradedSilentFeed).toBe('aisstream');
  });

  test('POLLKLOCKAN: 205 s sedan svar (12 min sedan accepterad) ⇒ frisk granne; 260 s ⇒ inte', () => {
    const now = Date.now();
    const hub = (okAgeMs) => ({
      configured: true,
      isConnected: true,
      lastMessageTime: now - 12 * MIN, // dedupade svep: inga NYA fix på 12 min
      timeSinceLastMessage: 12 * MIN,
      uptime: 60 * MIN,
      lastOkResponseAt: now - okAgeMs,
    });
    const stream = {
      configured: true,
      isConnected: true,
      lastMessageTime: now - 20 * MIN,
      timeSinceLastMessage: 20 * MIN,
      uptime: 60 * MIN,
    };

    // 205 s < 3 pollcykler (210 s) ⇒ källan svarar ⇒ halverad redundans.
    const fresh = makeApp();
    fresh._checkCrossFeedSilence({ aisstream: stream, aishub: hub(205 * 1000) });
    expect(fresh._connectionFeedDegraded).toBe(true);

    // 260 s ⇒ fyra uteblivna pollar: hubben svarar inte längre, och eftersom
    // ingen degradering var satt sedan tidigare finns inget att hålla kvar.
    const stale = makeApp();
    stale._checkCrossFeedSilence({ aisstream: stream, aishub: hub(260 * 1000) });
    expect(stale._connectionFeedDegraded).toBeFalsy();
  });

  test('TOM KANAL: hubben svarar men levererar inget ⇒ loggraden påstår inte "flödar"', () => {
    const now = Date.now();
    const app = makeApp();
    app._checkCrossFeedSilence({
      aisstream: {
        configured: true, isConnected: true, lastMessageTime: now - 20 * MIN, timeSinceLastMessage: 20 * MIN, uptime: 60 * MIN,
      },
      aishub: {
        configured: true,
        isConnected: true,
        lastMessageTime: now - 40 * MIN, // nattkanal: inga fartyg i bbox
        timeSinceLastMessage: 40 * MIN,
        uptime: 60 * MIN,
        lastOkResponseAt: now - 10 * 1000, // …men pollen svarar välformat
      },
    });
    const rader = logText(app);
    expect(rader).toContain('AISHub svarar men inte levererar något');
    expect(rader).not.toContain('medan AISHub flödar');
    // U12: totalgrenen loggar fortfarande läget — men den påstår INTE blindhet
    // när båda källorna svarar. Diagnostiken finns kvar, sanningspåståendet
    // bytte innebörd (och notisen uteblir helt före 4h-nätet).
    expect(rader).toContain('kanalen är tom, inte appen blind');
    expect(rader).not.toContain('— ingen av dem svarar heller');
    expect(sentKeys(app)).toHaveLength(0);
  });

  test('ALDRIG SVARAT (lastOkResponseAt null) är ingen frisk granne', () => {
    const now = Date.now();
    const app = makeApp();
    app._checkCrossFeedSilence({
      aisstream: {
        configured: true, isConnected: true, lastMessageTime: now - 20 * MIN, timeSinceLastMessage: 20 * MIN, uptime: 60 * MIN,
      },
      aishub: {
        configured: true, isConnected: false, lastMessageTime: null, timeSinceLastMessage: null, uptime: 60 * MIN, lastOkResponseAt: null,
      },
    });
    expect(app._connectionFeedDegraded).toBeFalsy();
  });

  test('DIMENSIONERINGEN: 3 pollcykler täcker fältets värsta accepterade-glapp', () => {
    const { POLL_INTERVAL_MS, POLL_JITTER_MS, SILENT_FEED_MS } = AIS_CONFIG.AISHUB;
    const freshPollMs = 3 * (POLL_INTERVAL_MS + POLL_JITTER_MS);
    // Härledningen ska hålla mot RÅDATAT, inte bara mot sig själv.
    expect(freshPollMs).toBeGreaterThan(Math.max(...FIELD_ACCEPT_GAPS_MS)); // 210 000 > 206 916
    // Klienten ger upp först (sätter sig 'disconnected' vid SILENT_FEED_MS) —
    // vi får aldrig döma en källa som klienten själv anser levande.
    expect(freshPollMs).toBeGreaterThanOrEqual(SILENT_FEED_MS);
  });
});

/**
 * F1 (adversariell granskning 2026-08-10): STARTGRINDEN BYTTE SIGNAL.
 * P3:s första version krävde en accepterad POSITION — vilket bytte fältets
 * lögn ("Uppkopplad" under 10 min 38 s startblindhet) mot dess spegelbild:
 * i en tom kanal (natt, noll sändare i bboxen — AISHubClient dokumenterar det
 * som normalt) stod enhetens ENDA hälsoindikator på "Frånkopplad" i timmar
 * med två friska källor, utan timeout och utan skyddsnät.
 * Grinden mäter därför KÄLLSVAR: öppnad aisstream-socket eller välformat
 * AISHub-svar (= muxens aggregerade 'connected'-flank) eller en accepterad
 * position. SKYDDSSYFTET ÄR BEVARAT och provas nedan: en HELT död kedja
 * svarar aldrig ⇒ 'disconnected' står kvar.
 */
describe('P3+F1: startgrinden — "connected" kräver ett bevisat KÄLLSVAR', () => {
  const validFix = {
    mmsi: '265533390', lat: 58.2818, lon: 12.2861, sog: 4.3, cog: 39.1, timestamp: Date.now(),
  };

  const gateApp = () => {
    const app = makeHealthApp();
    app._sourceEverResponded = false; // kallstart: ingen källa har svarat
    // Samma boot-tillstånd som onInit sätter i produktion (annars ser första
    // gatade skrivningen ut som en flank i provet).
    app._lastConnectionStatus = 'disconnected';
    app.vesselDataService = { updateVessel: jest.fn().mockReturnValue(null) };
    return app;
  };

  const statusWrites = (app) => app._updateDeviceCapability.mock.calls
    .filter((c) => c[0] === 'connection_status')
    .map((c) => c[1]);

  test('TOM KANAL: handskakning utan en enda position ⇒ "connected" (förbindelsen ÄR uppe)', () => {
    const app = gateApp();
    app._onAISConnected();

    // Muxens flank betyder "minst en pipeline-matande källa har kontakt"
    // (socket öppen ELLER välformat AISHub-svar) — det är sant, och det är
    // vad capabilityn påstår.
    expect(statusWrites(app)).toEqual(['connected']);
    expect(app._lastConnectionStatus).toBe('connected');
    expect(app.connectionStatusValue()).toBe('connected');
    expect(app._sourceEverResponded).toBe(true);
    // Grinden ska INTE ha loggat att den håller tillbaka något.
    expect(logText(app)).not.toContain('hålls tillbaka');
  });

  test('SKYDDSSYFTET: HELT DÖD KEDJA (inget källsvar) ⇒ "connected" hålls tillbaka', () => {
    const app = gateApp();
    // Ingen connect-flank, ingen position — men något försöker ändå skriva
    // det lugnande värdet (t.ex. en UI-cykel eller en framtida self-heal).
    const wrote = app._writeConnectionStatus('connected', 'UI-cykelns statusflank');

    expect(wrote).toBe(false); // cachen står redan på 'disconnected'
    expect(statusWrites(app)).not.toContain('connected');
    expect(app._lastConnectionStatus).toBe('disconnected');
    expect(app.connectionStatusValue()).toBe('disconnected');
    expect(logText(app)).toContain('startgrinden');
    expect(logText(app)).toContain('ingen AIS-källa har svarat sedan appstart');
  });

  test('LOGGRADEN MOTSÄGER SIG INTE när grinden ingriper (fynd 37)', () => {
    const app = gateApp();
    app._lastConnectionStatus = 'degraded'; // ⇒ skrivningen går fram som flank
    app._writeConnectionStatus('connected', 'båda konfigurerade AIS-källor levererar igen');

    const rad = logText(app).split('\n').find((l) => l.includes('🌐 [CONNECTION_STATUS]'));
    expect(rad).toContain('disconnected');
    // Kärnan: raden får inte sluta i ett påstående som motsäger värdet.
    expect(rad).toContain("men startgrinden höll tillbaka 'connected'");
  });

  test('första accepterade positionen öppnar grinden — och skriver statusen själv', () => {
    const app = gateApp();
    // Ingen connect-flank i det här provet: replay-riggar och en framtida
    // källa utan 'connected'-event når hit ändå.
    expect(statusWrites(app)).toEqual([]);

    app._processAISMessage({ ...validFix, timestamp: Date.now() });
    expect(app._sourceEverResponded).toBe(true);
    expect(app.connectionStatusValue()).toBe('connected');
    // Flanken får inte vänta på nästa UI-cykel: ett fartyg utanför
    // bevakningsområdet ger varken vessel-event eller watchdog-cykel.
    expect(statusWrites(app)).toEqual(['connected']);
    expect(app._lastConnectionStatus).toBe('connected');

    // Andra positionen skriver inte om (flanken är engångs).
    app._processAISMessage({ ...validFix, timestamp: Date.now() });
    expect(statusWrites(app)).toEqual(['connected']);
  });

  test('AVVISAT meddelande öppnar INTE grinden (0,0-artefakten)', () => {
    const app = gateApp();
    app._processAISMessage({
      mmsi: '265533390', lat: 0, lon: 0, sog: 0, cog: 0,
    });
    expect(app._sourceEverResponded).toBe(false);
    expect(app.connectionStatusValue()).toBe('disconnected');
  });

  test('KÄLLSVEP: connection_status skrivs bara av _writeConnectionStatus', () => {
    // KX-10-invarianten är bara sann så länge ingen råskrivning smyger tillbaka
    // (fyndet: _startConnections tomnyckelgren skrev förbi flankcachen).
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const rawWrites = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((r) => r.line.includes("_updateDeviceCapability('connection_status'"));
    expect(rawWrites).toHaveLength(1);
    // …och den enda raden ligger INUTI _writeConnectionStatus.
    const owner = src.slice(src.indexOf('  _writeConnectionStatus(value, reason) {'));
    expect(owner.slice(0, owner.indexOf('\n  }\n')))
      .toContain("this._updateDeviceCapability('connection_status', next);");
  });

  test('"degraded" gatas INTE — halverad redundans ska synas direkt', async () => {
    const app = gateApp();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:00.000Z'));
    try {
      const now = () => Date.now();
      app.aisClient.getConnectionStats.mockImplementation(() => ({
        isConnected: true,
        perFeed: {
          aisstream: {
            configured: true, isConnected: true, lastMessageTime: null, timeSinceLastMessage: null, uptime: 60 * MIN,
          },
          aishub: {
            configured: true,
            isConnected: true,
            lastMessageTime: now() - 3 * MIN,
            timeSinceLastMessage: 3 * MIN,
            uptime: 60 * MIN,
            lastOkResponseAt: now() - 10 * 1000,
          },
        },
      }));

      app._checkAISFeedHealth();
      jest.advanceTimersByTime(16 * MIN);
      app._checkAISFeedHealth();
      await Promise.resolve();

      expect(statusWrites(app)).toContain('degraded');
      expect(statusWrites(app)).not.toContain('connected');
    } finally {
      jest.useRealTimers();
    }
  });

  test('KX-10: connect/disconnect håller flankcachen i synk med enheten', () => {
    const app = makeHealthApp(); // pipelinen har levererat (helper-default)
    app._lastConnectionStatus = 'connected';

    app._onAISDisconnected({ code: 1006, reason: '' });
    expect(app._lastConnectionStatus).toBe('disconnected');
    expect(statusWrites(app)).toEqual(['disconnected']);

    app._onAISConnected();
    expect(app._lastConnectionStatus).toBe('connected');
    expect(statusWrites(app)).toEqual(['disconnected', 'connected']);
  });

  test('KX-10-spegeln: tomnyckelgrenen skriver genom ägaren (cachen kan aldrig glida)', async () => {
    const app = makeHealthApp({ source: 'aisstream', aishubUsername: '' });
    app.homey.settings.set('ais_api_key', '');
    app._lastConnectionStatus = 'connected'; // som efter en tidigare uppkoppling
    // Grenen är gatad på test-läget — båda spärrarna måste släppas för att den
    // ska gå att pröva alls (och återställas direkt efteråt).
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = false;
    try {
      await app._startConnection();
    } finally {
      process.env.NODE_ENV = 'test';
      global.__TEST_MODE__ = true;
    }

    expect(app._lastConnectionStatus).toBe('disconnected'); // cachen FÖLJDE med
    expect(statusWrites(app)).toEqual(['disconnected']);
    expect(logText(app)).toContain('ingen API-nyckel och ingen AISHub-källa konfigurerad');
  });
});

// ===========================================================================
// F1 (adversariell granskning 2026-08-10) — KX-1: DEGRADED KRÄVER BEVISAD
// ASYMMETRI. En tom natt (båda källorna tysta, hubben SVARAR) är inte
// halverad redundans; den är precis vad totalgrenen redan säger.
// ===========================================================================

describe('F1/KX-1: "degraded" och notisen kräver att grannen LEVERERAR', () => {
  const statusWrites = (app) => app._updateDeviceCapability.mock.calls
    .filter((c) => c[0] === 'connection_status')
    .map((c) => c[1]);
  const notisTexter = (app) => app.homey.notifications.createNotification.mock.calls
    .map((c) => c[0].excerpt);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-10T02:00:00.000Z')); // natt
  });
  afterEach(() => jest.useRealTimers());

  /**
   * Nattkanalen: AISHub svarar välformat var 65:e s (ERROR:false, 0 poster —
   * AISHubClient stämplar lastOkResponseAt FÖRE records===0-returen), men
   * ingen av källorna har levererat en position. `hubDeliveredMsAgo = null`
   * = hubben har aldrig levererat under fönstret.
   */
  const nattPerFeed = ({
    streamSilentMs = 20 * MIN,
    hubDeliveredMsAgo = 40 * MIN,
    hubOkAgeMs = 10 * 1000,
    // Observationsfönstret KLÄMMER tystnaden (_observedFeedSilence): en källa
    // kan aldrig dömas för längre tystnad än vi bevakat den. Fönstret måste
    // därför vara vidare än den tystnad provet vill mäta.
    uptimeMs = 6 * 60 * MIN,
  } = {}) => {
    const now = Date.now();
    return {
      aisstream: {
        configured: true,
        isConnected: true,
        lastMessageTime: now - streamSilentMs,
        timeSinceLastMessage: streamSilentMs,
        uptime: uptimeMs,
      },
      aishub: {
        configured: true,
        isConnected: true,
        lastMessageTime: hubDeliveredMsAgo === null ? null : now - hubDeliveredMsAgo,
        timeSinceLastMessage: hubDeliveredMsAgo,
        uptime: uptimeMs,
        lastOkResponseAt: now - hubOkAgeMs,
      },
    };
  };

  test('TOM NATT: ingen degradering, ingen aisstream-notis, nycklarna OBRÄNDA', async () => {
    const app = makeHealthApp();
    app._checkCrossFeedSilence(nattPerFeed());
    await microFlush();

    // (1) Enheten påstår inte "halverad redundans" när appen är blind.
    expect(app._connectionFeedDegraded).toBeFalsy();
    expect(statusWrites(app)).not.toContain('degraded');
    // (2) Ingen av de tre 24h-nycklarna bränns ⇒ en ÄKTA halvdöd socket nästa
    //     förmiddag får fortfarande sin notis (F-9-klassen).
    expect(sentKeys(app)).not.toContain('aisstream:silent');
    expect(sentKeys(app)).not.toContain('aisstream:silent:1h');
    expect(sentKeys(app)).not.toContain('aisstream:silent:4h');
    // (3) Ingen användarsynlig text påstår att hubben flödar.
    expect(notisTexter(app).join('\n')).not.toContain('medan AISHub flödar');
    // (4) U12: INGEN notis alls — varken korstystnadsgrenen ELLER totalgrenen.
    //     Båda källorna SVARAR, alltså är appen inte blind; den ser en tom
    //     kanal. Sanningen ligger i loggen tills 4h-nätet tar över.
    expect(sentKeys(app)).toHaveLength(0);
    expect(notisCount(app)).toBe(0);
    expect(logText(app)).not.toContain('appen är blind');
    expect(logText(app)).toContain('kanalen är tom, inte appen blind');
    // (5) Loggens diagnostikrad finns kvar och är villkorad (P3:s hubPhrase).
    expect(logText(app)).toContain('AISHub svarar men inte levererar något');
    expect(logText(app)).not.toContain('medan AISHub flödar');
  });

  test('HELA TOMNATTSKEDJAN: källsvar ⇒ "connected", och natten ändrar inget', async () => {
    const app = makeHealthApp();
    app._sourceEverResponded = false; // kallstart
    app._lastConnectionStatus = 'disconnected';

    app._onAISConnected(); // socket öppnad / välformat AISHub-svar
    expect(statusWrites(app)).toEqual(['connected']);

    // Sex timmar tom kanal: en hälsokontroll i timmen.
    for (let i = 0; i < 6; i++) {
      jest.advanceTimersByTime(60 * MIN);
      app._checkCrossFeedSilence(nattPerFeed({
        streamSilentMs: (i + 1) * 60 * MIN,
        hubDeliveredMsAgo: (i + 1) * 60 * MIN,
        uptimeMs: 12 * 60 * MIN,
      }));
    }
    await microFlush();

    // ENDA skrivningen är den sanna: förbindelsen är uppe.
    expect(statusWrites(app)).toEqual(['connected']);
    expect(app._connectionFeedDegraded).toBeFalsy();
    expect(sentKeys(app).filter((k) => k.startsWith('aisstream:'))).toEqual([]);
  });

  test('TOM NATT i 5 h: ENDAST skyddsnätet fyrar — inga aisstream-/feeds:silent-nycklar', async () => {
    const app = makeHealthApp();
    // 5 h tystnad på BÅDA källorna, hubben svarar hela tiden.
    app._checkCrossFeedSilence(nattPerFeed({
      streamSilentMs: 5 * 60 * MIN,
      hubDeliveredMsAgo: 5 * 60 * MIN,
      uptimeMs: 8 * 60 * MIN, // observationsfönstret måste rymma 5 h
    }));
    await microFlush();

    expect(sentKeys(app).filter((k) => k.startsWith('aisstream:'))).toEqual([]);
    // U12: blindhetsnycklarna rörs INTE (det var hela poängen) — men den grova
    // 4h-grenen har fyrat exakt en gång, för kanalen har varit tom för länge.
    expect(sentKeys(app)).toEqual(['feeds:empty:4h']);
    expect(notisCount(app)).toBe(1);
  });

  test('ÄKTA HALVDÖD: hubben LEVERERAR ⇒ degraded + notis med "medan AISHub flödar"', async () => {
    const app = makeHealthApp();
    // Samma tysta aisstream — men nu har hubben levererat inom SILENT_MS.
    app._checkCrossFeedSilence(nattPerFeed({ hubDeliveredMsAgo: 3 * MIN }));
    await microFlush();

    expect(app._connectionFeedDegraded).toBe(true);
    expect(app._connectionDegradedSilentFeed).toBe('aisstream');
    expect(statusWrites(app)).toEqual(['degraded']);
    expect(sentKeys(app)).toContain('aisstream:silent');
    // TEXTEN: byte-identisk med den tidigare hårdkodade formuleringen.
    expect(notisTexter(app)).toContain(
      'AIS Tracker: AISstream har inte levererat några positioner på 15 min '
      + 'medan AISHub flödar — anslutningen kan vara halvdöd. Appens vakter '
      + 'försöker återansluta automatiskt.',
    );
    expect(logText(app)).toContain('medan AISHub flödar');
    // Totalgrenen ska INTE ha fyrat: hubben levererar, appen är inte blind.
    expect(logText(app)).not.toContain('appen är blind');
  });

  test('ESKALERINGSTEXTEN härleds ur mätningen (BT-12) och fyrar bara med leveransbevis', async () => {
    const app = makeHealthApp();
    app._checkCrossFeedSilence(nattPerFeed({
      streamSilentMs: 70 * MIN,
      hubDeliveredMsAgo: 2 * MIN,
    }));
    await microFlush();

    expect(sentKeys(app)).toContain('aisstream:silent:1h');
    expect(notisTexter(app)).toContain(
      'AIS Tracker: AISstream har varit tyst i över 1h medan AISHub flödar '
      + '— appen kör på halverad redundans. Vakterna fortsätter återansluta; '
      + 'kontrollera din AISstream-nyckel om det består.',
    );
  });

  test('GRÄNSEN: hubbens leveransbevis håller till SILENT_MS, inte längre', () => {
    const nyss = makeHealthApp();
    nyss._checkCrossFeedSilence(nattPerFeed({ hubDeliveredMsAgo: 15 * MIN }));
    expect(nyss._connectionFeedDegraded).toBe(true); // 15 min = precis inom

    const forSent = makeHealthApp();
    forSent._checkCrossFeedSilence(nattPerFeed({ hubDeliveredMsAgo: 15 * MIN + 1 }));
    expect(forSent._connectionFeedDegraded).toBeFalsy(); // en ms över ⇒ tyst
  });

  test('UNGT FÖNSTER: en hubb som ALDRIG levererat är ingen frisk granne', () => {
    const app = makeHealthApp();
    // Nykonfigurerad hub (kort uptime, aldrig levererat) som svarar välformat.
    const pf = nattPerFeed({ hubDeliveredMsAgo: null });
    pf.aishub.uptime = 30 * 1000;
    app._checkCrossFeedSilence(pf);
    expect(app._connectionFeedDegraded).toBeFalsy();
  });

  test('HYSTERESEN ÖVERLEVER: satt degradering hålls när hubben sedan också tystnar', async () => {
    const app = makeHealthApp();
    app._checkCrossFeedSilence(nattPerFeed({ hubDeliveredMsAgo: 3 * MIN }));
    await microFlush();
    expect(statusWrites(app)).toEqual(['degraded']);

    // Hubben slutar leverera (kanalen tömdes) — appen är nu blind. Att SLÄPPA
    // degraderingen hade skrivit 'connected', appens mest lugnande värde, i
    // exakt det ögonblicket. Den hålls därför kvar; totalgrenen bär sanningen.
    jest.advanceTimersByTime(30 * MIN);
    app._checkCrossFeedSilence(nattPerFeed({ streamSilentMs: 50 * MIN, hubDeliveredMsAgo: 33 * MIN }));
    await microFlush();

    expect(statusWrites(app)).toEqual(['degraded']); // ingen 'connected'
    expect(app._connectionFeedDegraded).toBe(true);
    // U12: totalgrenen säger fortfarande sanningen om läget — men båda källorna
    // SVARAR, så sanningen är "tom kanal", inte "blind app".
    expect(logText(app)).toContain('kanalen är tom, inte appen blind');
    expect(sentKeys(app)).not.toContain('feeds:silent');
  });
});

// ===========================================================================
// ANVÄNDARBESLUT U12 (2026-08-10) — TOM KANAL ≠ BLIND APP
//
// Totalgrenen dömde på LEVERANS. I Trollhätte kanal är noll fartyg i bboxen
// normaldrift nattetid (korpusbanken 2026-08-10: 336,6 h inspelad drift, värsta
// normala trafikuppehåll 198,7 min natten 2026-07-08 02:52–06:11 UTC), så
// "appen är blind" fyrade varje lugn natt och brände sina 24h-nycklar i
// förskott — samma F-9-klass larmet självt finns för att förhindra.
//
// EFTER U12 finns TVÅ grenar:
//   • ÄKTA BLINDHET  — ingen konfigurerad källa SVARAR (aisstream: socketen
//     nere/429-cooldown; aishub: pollklockan ofärsk) ⇒ 'feeds:silent' + trappan.
//   • TOM KANAL      — alla svarar men noll data på 4 h ⇒ EN notis på egen
//     nyckel 'feeds:empty:4h'. Ingen trappa: nivån ÄR trappans grövsta steg.
// B2:s existensberättigande (both-dygn 1: 4,5 h källdöd utan en enda signal)
// provas oförändrat nedan — och skärpt: det måste larma OMEDELBART även efter
// en tyst natt, alltså får natten aldrig bränna blindhetsnycklarna.
// ===========================================================================

describe('U12: "appen är blind" kräver ÄKTA blindhet — tom kanal fångas av 4h-nätet', () => {
  const EMPTY_TEXT = 'AIS Tracker: AIS-källorna svarar men ingen båtdata på 4 timmar '
    + '— kontrollera bevakningsområdet/kontona.';
  const notisTexter = (app) => app.homey.notifications.createNotification.mock.calls
    .map((c) => c[0].excerpt);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-10T22:00:00.000Z')); // natt
  });
  afterEach(() => jest.useRealTimers());

  /**
   * Kanalrigg med EN ratt per källa: SVARAR den? Ingen av källorna levererar
   * någonsin en position — det är exakt vad en tom kanal (och ett bbox-fel)
   * ser ut som. Rattarna kan vridas mitt i en körning, så natt→blindhet kan
   * spelas upp i ETT app-objekt med sitt riktiga observationsankare.
   */
  function channelRig({
    stream = true, hub = true, source = 'both', aishubUsername = 'station',
  } = {}) {
    const app = makeHealthApp({ source, aishubUsername });
    const t0 = Date.now();
    const state = { stream, hub, hubFrozenAt: null };
    app.aisClient.getConnectionStats.mockImplementation(() => {
      const now = Date.now();
      // Pollklockan följer hubbens svarsratt: så länge den svarar är senaste
      // välformade svar färskt (65 s-kadensen), annars fryser klockan där den
      // slutade svara — precis som AISHubClient._lastOkResponseAt gör i fält.
      if (!state.hub && state.hubFrozenAt === null) state.hubFrozenAt = now;
      if (state.hub) state.hubFrozenAt = null;
      return {
        isConnected: state.stream || state.hub,
        perFeed: {
          aisstream: {
            configured: true,
            isConnected: state.stream,
            lastMessageTime: null,
            timeSinceLastMessage: null,
            uptime: now - t0,
          },
          aishub: {
            configured: aishubUsername !== '',
            isConnected: state.hub,
            lastMessageTime: null,
            timeSinceLastMessage: null,
            uptime: now - t0,
            lastOkResponseAt: state.hub ? now : state.hubFrozenAt,
          },
        },
      };
    });
    return { app, state, t0 };
  }

  const tick = async (app, minutes) => {
    jest.advanceTimersByTime(minutes * MIN);
    app._checkAISFeedHealth();
    await microFlush();
  };

  test('TOM NATT under 4 h: INGEN notis alls — varken blindhet eller skyddsnät', async () => {
    const { app } = channelRig();
    app._checkAISFeedHealth(); // t0: ankaret sätts
    for (let h = 0; h < 3; h++) await tick(app, 60); // 3 h tom kanal
    await tick(app, 59); // 3 h 59 min — en minut under tröskeln

    expect(sentKeys(app)).toHaveLength(0);
    expect(notisCount(app)).toBe(0);
    expect(logText(app)).not.toContain('appen är blind');
    expect(logText(app)).toContain('kanalen är tom, inte appen blind');
  });

  test('4 h tom kanal ⇒ EXAKT EN notis med exakt text, och den upprepas inte', async () => {
    const { app } = channelRig();
    app._checkAISFeedHealth();
    await tick(app, 4 * 60); // 4 h jämnt = tröskeln nådd

    expect(sentKeys(app)).toEqual(['feeds:empty:4h']);
    expect(notisTexter(app)).toEqual([EMPTY_TEXT]);

    // Skyddsnätet är GROVT: ingen trappa, ingen upprepning inom 24h-fönstret.
    for (let h = 0; h < 6; h++) await tick(app, 60);
    expect(notisCount(app)).toBe(1);
    expect(sentKeys(app)).toEqual(['feeds:empty:4h']);
  });

  test('ÄKTA BLINDHET (ingen källa svarar): feeds:silent + hela trappan, som förut', async () => {
    const { app } = channelRig({ stream: false, hub: false });
    app._checkAISFeedHealth();

    await tick(app, 16);
    expect(sentKeys(app)).toEqual(['feeds:silent']);
    expect(logText(app)).toContain('appen är blind');
    expect(logText(app)).toContain('ingen av dem svarar heller');

    await tick(app, 45); // 61 min
    expect(sentKeys(app)).toEqual(['feeds:silent', 'feeds:silent:1h']);

    await tick(app, 180); // 4 h 1 min
    expect(sentKeys(app)).toEqual(['feeds:silent', 'feeds:silent:1h', 'feeds:silent:4h']);
    // Grenarna är ömsesidigt uteslutande — blindhet larmar aldrig som tom kanal.
    expect(sentKeys(app)).not.toContain('feeds:empty:4h');
  });

  test('TOM NATT FÖLJD AV ÄKTA BLINDHET: larmet fyrar OMEDELBART, nycklarna obrända', async () => {
    const { app, state } = channelRig();
    app._checkAISFeedHealth();
    for (let h = 0; h < 3; h++) await tick(app, 60); // 3 h lugn natt

    // KÄRNAN I U12: natten får inte ha bränt EN ENDA blindhetsnyckel.
    expect(sentKeys(app)).toHaveLength(0);

    // Kl 01:00 dör nätet: socketen faller och pollen slutar svara.
    state.stream = false;
    state.hub = false;
    await tick(app, 1);
    // Ännu inte: pollklockan är färsk i FRESH_POLL_MS (210 s) efter sista
    // välformade svaret — hubben har inte HUNNIT sluta svara. Fönstret är
    // P3:s och rörs inte av U12.
    expect(sentKeys(app)).toHaveLength(0);

    await tick(app, 4); // pollklockan har hunnit bli ofärsk ⇒ äkta blindhet

    // KÄRNAN: ingen ny 15-minutersklocka. Tystnaden är redan 3 h, så basen OCH
    // 1h-nivån fyrar direkt — hade natten bränt nycklarna vore det här tyst.
    expect(sentKeys(app)).toEqual(['feeds:silent', 'feeds:silent:1h']);
    expect(notisTexter(app)[0]).toContain('broöppningsvakten är i praktiken blind');
    expect(logText(app)).toContain('appen är blind');
  });

  test('429-COOLDOWN räknas som icke-svarande (enkälleläge ⇒ blindhetslarm)', async () => {
    // Klientkontraktet först: en 429 stänger socketen OCH sätter cooldown, så
    // isConnected=false är den bevisade signalen app-lagret läser via perFeed.
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const client = new AISStreamClient(logger);
    client.isConnected = true; // socketen levde när servern sade 429
    const socket = { terminate: jest.fn() };
    client.ws = socket;
    client._onUnexpectedResponse(socket, {}, { statusCode: 429, headers: {}, resume: jest.fn() });
    client._onClose(1006, '');
    expect(client.isConnected).toBe(false);
    expect(client.getConnectionStats().rateLimitMsLeft).toBeGreaterThan(0);
    client.disconnect();

    // Och app-lagret: aisstream ensam i cooldown ⇒ ingen källa svarar ⇒ blind.
    const { app } = channelRig({ stream: false, source: 'aisstream', aishubUsername: '' });
    app._checkAISFeedHealth();
    await tick(app, 16);
    expect(sentKeys(app)).toContain('feeds:silent');
  });

  test('DELVIS SVARANDE (en uppe, en nere, noll data): ingen notis — men loggen namnger båda', async () => {
    const { app } = channelRig({ stream: false, hub: true });
    app._checkAISFeedHealth();
    await tick(app, 5 * 60); // 5 h: över BÅDA trösklarna

    // Varken blindhet (hubben svarar) eller tom-kanal-nätet (alla svarar inte).
    expect(sentKeys(app)).toHaveLength(0);
    const rad = logText(app).split('\n').find((l) => l.includes('INGEN aktiv AIS-källa'));
    expect(rad).toContain('aishub svarar men levererar inget');
    expect(rad).toContain('aisstream svarar inte');
    expect(rad).not.toContain('appen är blind');
  });

  test('SKUGGLÄGE: skugghubben räknas inte som svarande källa (fynd 17-principen)', async () => {
    // Hubben svarar men matar inte pipelinen ⇒ relevanta källor = aisstream
    // ensam. Är den nere är appen blind, oavsett hur pigg mätinstrumentet är.
    const { app } = channelRig({ stream: false, hub: true, source: 'shadow' });
    app._checkAISFeedHealth();
    await tick(app, 16);
    expect(sentKeys(app)).toContain('feeds:silent');
  });

  test('KONSTANTEN: 4h-nivån ligger över fältets värsta uppehåll och speglar trappan', () => {
    const { EMPTY_CHANNEL_ALERT_MS } = FEED_SILENCE;
    // Härledningens undre gräns: värsta NORMALA trafikuppehåll i korpusbanken
    // (198,7 min, 2026-07-08). Under det larmar en lugn natt igen.
    expect(EMPTY_CHANNEL_ALERT_MS).toBeGreaterThan(198.7 * 60 * 1000);
    // …och nivån är trappans grövsta steg, inte en tredje tidsskala.
    const grovsta = CONNECTION_ALERT.ESCALATION_STEPS[CONNECTION_ALERT.ESCALATION_STEPS.length - 1];
    expect(EMPTY_CHANNEL_ALERT_MS).toBe(grovsta.ms);
  });
});
