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
 */

process.env.NODE_ENV = 'test';
global.__TEST_MODE__ = true;

const fs = require('fs');
const path = require('path');
const AISBridgeApp = require('../app');
const { AIS_CONFIG } = require('../lib/constants');

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
  app._pipelineEverDelivered = true;
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

describe('B2e: eskaleringstrappan kollapsar inte (F-9)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  test('ALDRIG levererat (timeSinceLastMessage null) → observerad tystnad, aldrig "Infinity"', async () => {
    const app = makeHealthApp();
    const stats = () => ({
      isConnected: true,
      perFeed: {
        aisstream: perFeedEntry({ uptime: Date.now() - Date.parse('2026-08-08T00:00:00.000Z') }),
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
        aisstream: perFeedEntry({ uptime: 5 * MIN }), // kort uptime: irrelevant nu
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
      perFeed: { aisstream: perFeedEntry({}), aishub: deadHub() },
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
      perFeed: { aisstream: perFeedEntry({}), aishub: deadHub() },
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

  test('(c) EN FLAPPANDE + EN DÖD → en enda ung socket avväpnar inte larmet', async () => {
    const app = makeHealthApp();
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true, // "ansluten men döv" — aggregatet ser friskt ut
      perFeed: {
        aisstream: perFeedEntry({ uptime: 30 * 1000 }), // flappar, aldrig levererat
        aishub: deadHub({ uptime: 90 * MIN }), // död, aldrig levererat
      },
    }));

    app._checkAISFeedHealth();
    jest.advanceTimersByTime(20 * MIN);
    app._checkAISFeedHealth();
    await microFlush();

    expect(sentKeys(app)).toContain('feeds:silent');
  });

  test('(d) enkälleläge: aisstream ensam och död från start → blindhetslarmet fyrar', async () => {
    const app = makeHealthApp({ source: 'aisstream', aishubUsername: '' });
    app.aisClient.getConnectionStats.mockImplementation(() => ({
      isConnected: true,
      perFeed: {
        aisstream: perFeedEntry({ uptime: 40 * MIN }),
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
    // Totalgrenen äger scenariot och ska ha sagt det rakt ut.
    expect(rader).toContain('appen är blind');
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

describe('P3: startgrinden — "connected" kräver en accepterad position', () => {
  const validFix = {
    mmsi: '265533390', lat: 58.2818, lon: 12.2861, sog: 4.3, cog: 39.1, timestamp: Date.now(),
  };

  const gateApp = () => {
    const app = makeHealthApp();
    app._pipelineEverDelivered = false; // kallstart: pipelinen har sett noll
    // Samma boot-tillstånd som onInit sätter i produktion (annars ser första
    // gatade skrivningen ut som en flank i provet).
    app._lastConnectionStatus = 'disconnected';
    app.vesselDataService = { updateVessel: jest.fn().mockReturnValue(null) };
    return app;
  };

  const statusWrites = (app) => app._updateDeviceCapability.mock.calls
    .filter((c) => c[0] === 'connection_status')
    .map((c) => c[1]);

  test('FÄLTFALLET: handskakning utan en enda position ⇒ INTE "connected"', () => {
    const app = gateApp();
    app._onAISConnected();

    expect(statusWrites(app)).not.toContain('connected');
    expect(app._lastConnectionStatus).not.toBe('connected');
    expect(app.connectionStatusValue()).toBe('disconnected');
    expect(logText(app)).toContain('startgrinden');
  });

  test('första accepterade positionen öppnar grinden — och skriver statusen själv', () => {
    const app = gateApp();
    app._onAISConnected();
    expect(statusWrites(app)).not.toContain('connected');

    app._processAISMessage({ ...validFix, timestamp: Date.now() });
    expect(app._pipelineEverDelivered).toBe(true);
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
    expect(app._pipelineEverDelivered).toBe(false);
    expect(app.connectionStatusValue()).toBe('disconnected');
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
});
