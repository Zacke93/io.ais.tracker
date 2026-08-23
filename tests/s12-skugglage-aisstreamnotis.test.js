'use strict';

jest.mock('homey');

/**
 * S12 (systerställesrundan 2026-08-23) — AISSTREAM-GRENEN SAKNADE FYND 17.
 *
 * MEKANISMEN PÅ HEAD: `streamSilentHubFresh` (app.js ~11985) är
 * bothConfigured && aisstream tyst && hFresh — ingen term för om AISHub
 * faktiskt matar pipelinen. Degraderingen tjugo rader längre ned gatar på
 * `hubFeedsPipeline`, och tvillinggrenen för AISHub kräver den med uttrycklig
 * fynd 17-motivering. I SKUGGLÄGE kastar muxen varje hubbfix men lämnar
 * hubbens RÅVÄRDEN i perFeed (AISSourceMultiplexer.getConnectionStats:
 * `const hubFeeds = this._hubFeedsPipeline() ? hub : null;` rör bara
 * aggregatet), så hFresh är sann medan appen inte får en enda position.
 *
 * SKADAN: den lugnande texten "AISstream har inte levererat … medan AISHub
 * flödar … appen kör på halverad redundans" gick ut medan appen var HELT
 * blind — samma tick som totalgrenen skrev att appen inte har någon källa.
 * Med socketen nere i 5 h blev det SEX notiser i samma tick: tre om blindhet
 * och tre om halverad redundans.
 *
 * PIPELINEN ÄR ÄKTA: perFeed kommer ur en RIKTIG AISSourceMultiplexer i
 * shadow (barnens HTTP/WS-vägar neutraliserade, projektionen orörd), och
 * appen läser sitt läge genom sin EGNA _hubFeedsPipeline() mot settings.
 *
 * MUTATIONSPROV (kört): tas `&& hubFeedsPipeline` bort ur villkoret vid
 * app.js ~12059 blir de två första testerna röda. Tas skuggparentesen bort ur
 * loggraden blir loggtestet rött. Ändras villkoret i stället till att gata
 * HELA `if (streamSilentHubResponding)`-blocket försvinner loggraden och
 * fältdiagnostiken — då blir loggtestet rött.
 */

const AISBridgeApp = require('../app');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');

const MIN = 60 * 1000;

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
    unset: (k) => {
      delete data[k];
    },
  };
}

/**
 * Riktig mux i det läge fyndet gäller. Barnens I/O neutraliseras, men
 * projektionen getConnectionStats() (och därmed perFeed) är produktionens.
 */
async function makeShadowMux(logger, { streamSilentMs, hubSilentMs }) {
  const mux = new AISSourceMultiplexer(logger, makeStore());
  // WS-vägen bort INNAN konfigurationen appliceras — _reconcile anropar connect.
  mux._streamClient.connect = jest.fn().mockResolvedValue(undefined);
  mux._streamClient.disconnect = jest.fn();
  mux.applySourceConfig({ source: 'shadow', apiKey: 'testnyckel', aishubUsername: 'testuser' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const now = Date.now();
  mux._streamClient.getConnectionStats = () => ({
    lastMessageTime: now - streamSilentMs,
    timeSinceLastMessage: streamSilentMs,
    uptime: 6 * 60 * MIN,
    reconnectAttempts: 0,
  });
  if (mux._hubClient) {
    mux._hubClient._httpGet = jest.fn().mockResolvedValue({ statusCode: 200, body: '[]' });
    mux._hubClient.getConnectionStats = () => ({
      lastMessageTime: now - hubSilentMs,
      timeSinceLastMessage: hubSilentMs,
      uptime: 6 * 60 * MIN,
      lastOkResponseAt: now - 30 * 1000, // hubben SVARAR (pollklockan färsk)
      pollChainArmedAt: now - 6 * 60 * MIN,
      dedupSize: 0,
      counters: null,
    });
  }
  return mux;
}

/** App med RIKTIG _hubFeedsPipeline() — läget kommer ur settings, som i drift. */
function makeApp(settings) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app.homey = {
    settings: { get: (k) => (k in settings ? settings[k] : null), on: jest.fn() },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  return app;
}

const flush = () => new Promise((resolve) => {
  setImmediate(resolve);
});
const sentKeys = (app) => [...(app._connectionIssueNotifiedAt || new Map()).keys()];
const excerpts = (app) => app.homey.notifications.createNotification.mock.calls
  .map((c) => c[0].excerpt);
const logLines = (app) => app.log.mock.calls.map((c) => c.join(' '));

const SHADOW_SETTINGS = {
  ais_source: 'shadow',
  ais_api_key: 'testnyckel',
  aishub_username: 'testuser',
};

describe('S12: skuggläget får ingen lugnande aisstream-notis', () => {
  let mux;
  let logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
    jest.restoreAllMocks();
  });

  test('SKUGGLÄGE, aisstream tyst 25 min, hubben svarar och levererar ⇒ INGEN aisstream:silent', async () => {
    mux = await makeShadowMux(logger, { streamSilentMs: 25 * MIN, hubSilentMs: 40 * 1000 });
    const { perFeed } = mux.getConnectionStats();
    // PREMISSEN som gör fyndet möjligt: muxen lämnar hubbens RÅVÄRDEN i
    // perFeed även i shadow — det är just därför hFresh blir sann.
    expect(perFeed.aishub.configured).toBe(true);
    expect(perFeed.aishub.timeSinceLastMessage).toBe(40 * 1000);

    const app = makeApp(SHADOW_SETTINGS);
    expect(app._hubFeedsPipeline()).toBe(false);
    app._checkCrossFeedSilence(perFeed);
    await flush();

    expect(sentKeys(app)).not.toContain('aisstream:silent');
    // Ingen användarsynlig text får påstå halverad redundans i skuggläge.
    expect(excerpts(app).join('\n')).not.toContain('halverad redundans');
    expect(excerpts(app).join('\n')).not.toContain('medan AISHub flödar');
  });

  test('SKUGGLÄGE, socketen nere 5 h ⇒ bara blindhetsfamiljen, inga redundansnotiser', async () => {
    mux = await makeShadowMux(logger, { streamSilentMs: 5 * 60 * MIN, hubSilentMs: 40 * 1000 });
    const app = makeApp(SHADOW_SETTINGS);
    app._checkCrossFeedSilence(mux.getConnectionStats().perFeed);
    await flush();

    const keys = sentKeys(app);
    expect(keys).toEqual(expect.arrayContaining(['feeds:silent', 'feeds:silent:1h', 'feeds:silent:4h']));
    expect(keys).not.toContain('aisstream:silent');
    expect(keys).not.toContain('aisstream:silent:1h');
    expect(keys).not.toContain('aisstream:silent:4h');
    // HEAD gav SEX notiser i samma tick (tre blinda + tre redundanta).
    expect(app.homey.notifications.createNotification).toHaveBeenCalledTimes(3);
  });

  test('LOGGRADEN behålls men markerar skuggläget (fältdiagnostiken lever)', async () => {
    mux = await makeShadowMux(logger, { streamSilentMs: 25 * MIN, hubSilentMs: 40 * 1000 });
    const app = makeApp(SHADOW_SETTINGS);
    app._checkCrossFeedSilence(mux.getConnectionStats().perFeed);
    await flush();

    const rad = logLines(app).find((l) => l.includes('aisstream har inte levererat'));
    expect(rad).toBeDefined();
    expect(rad).toContain('skuggläge');
    expect(rad).toContain('AISHub matar inte appen');
  });

  test('KONTROLLARM both-läge: samma perFeed ⇒ notisen är SANN och går ut', async () => {
    mux = await makeShadowMux(logger, { streamSilentMs: 25 * MIN, hubSilentMs: 40 * 1000 });
    const app = makeApp({ ...SHADOW_SETTINGS, ais_source: 'both' });
    expect(app._hubFeedsPipeline()).toBe(true);
    app._checkCrossFeedSilence(mux.getConnectionStats().perFeed);
    await flush();

    expect(sentKeys(app)).toContain('aisstream:silent');
    expect(excerpts(app).join('\n')).toContain('medan AISHub flödar');
    const rad = logLines(app).find((l) => l.includes('aisstream har inte levererat'));
    expect(rad).not.toContain('skuggläge');
  });

  test('KONTROLLARM: AISHub-tvillingen är oförändrad (fynd 17 gäller som förut)', async () => {
    mux = await makeShadowMux(logger, { streamSilentMs: 40 * 1000, hubSilentMs: 25 * MIN });
    const app = makeApp(SHADOW_SETTINGS);
    app._checkCrossFeedSilence(mux.getConnectionStats().perFeed);
    await flush();

    expect(sentKeys(app)).not.toContain('aishub:silent');
    const rad = logLines(app).find((l) => l.includes('AISHub har inte levererat'));
    expect(rad).toContain('skuggläge');
  });
});

/**
 * S12b (dirigentens rättelse i fixrunda 6, 2026-08-23): S12:s grind lämnade ett
 * GLAPP i skuggläge — socketen UPPE men tyst kanal gav ingen signal mellan
 * 15 min och 4 h. Hubbens färskhet bevisar att trafik finns (U12:s "tom natt"
 * utesluten), så tystnaden är BLINDHET: en sann text går ut på EGEN nyckel
 * ('aisstream:silent:shadow' — motsatt text får inte dela dygnsfönster med
 * both-lägets "halverad redundans"). Socketen NERE ägs av totalgrenen.
 */
describe('S12b: skuggläge med svarande socket och tyst kanal ⇒ blindhetstext på egen nyckel', () => {
  let mux;
  let logger;
  beforeEach(() => {
    logger = makeLogger();
  });
  afterEach(() => {
    if (mux) mux.disconnect(); mux = null; jest.restoreAllMocks();
  });

  test('socket UPPE, aisstream tyst 25 min, hubben ser trafik ⇒ aisstream:silent:shadow med sann text', async () => {
    mux = await makeShadowMux(logger, { streamSilentMs: 25 * MIN, hubSilentMs: 40 * 1000 });
    const { perFeed } = mux.getConnectionStats();
    // Riggens socket är nere; S12b gäller den UPPE-men-tysta kanalen — tvinga
    // projektionen (samma fält som produktionen läser: perFeed.aisstream.isConnected).
    perFeed.aisstream.isConnected = true;
    const app = makeApp(SHADOW_SETTINGS);
    app._checkCrossFeedSilence(perFeed);
    await flush();
    expect(sentKeys(app)).toContain('aisstream:silent:shadow');
    expect(sentKeys(app)).not.toContain('aisstream:silent');
    const text = excerpts(app).join('\n');
    expect(text).toContain('inte emot båtdata');
    expect(text).not.toContain('halverad redundans');
  });

  test('socket NERE ⇒ totalgrenen äger larmet, ingen shadow-notis (ingen dubblett)', async () => {
    mux = await makeShadowMux(logger, { streamSilentMs: 25 * MIN, hubSilentMs: 40 * 1000 });
    const { perFeed } = mux.getConnectionStats();
    perFeed.aisstream.isConnected = false;
    const app = makeApp(SHADOW_SETTINGS);
    app._checkCrossFeedSilence(perFeed);
    await flush();
    expect(sentKeys(app)).not.toContain('aisstream:silent:shadow');
    expect(sentKeys(app)).not.toContain('aisstream:silent');
  });
});
