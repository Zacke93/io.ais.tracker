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
 */

process.env.NODE_ENV = 'test';
global.__TEST_MODE__ = true;

const AISBridgeApp = require('../app');

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
