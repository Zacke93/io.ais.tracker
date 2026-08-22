'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * =============================================================================
 * H18 (helkodsgranskning 2026-08-22) — BLINDHETSLARMETS AISSTREAM-SIDA
 * =============================================================================
 *
 * ASYMMETRIN. I totaltystnadsgrenen är HUBBENS svarssida fönstermätt
 * (hubResponding: pollklockan yngre än FRESH_POLL_MS = 210 s) medan
 * AISSTREAMS var ett rent ÖGONBLICKSPROV av socketflaggan (`!!s.isConnected`),
 * utan hysteres och utan minne. En enda tick där socketen låg i
 * reconnect-backoff samtidigt som hubben missat ~3,5 min pollar gav därför
 * trulyBlind: notisen "appen är blind", hela eskaleringstrappan — och
 * 24h-nycklarna brändes, så ett ÄKTA totalavbrott samma dygn gav NOLL notis.
 *
 * Reproducerat i två oberoende körningar: 3–4,5 h lugn natt plus en kort
 * blink bränner feeds:silent samt 1h- och 4h-nycklarna. AKUT i dagens läge:
 * aisstream har varit serverdöd sedan ~5/8, vilket gör aisstream-sidan
 * permanent falsk och varje 3,5-minuters hubbglapp till en avfyrning.
 *
 * FIXEN speglar hubbens fönster på aisstream ENSIDIGT (hubbsidans 210 s ÄR
 * redan hysteresen och lämnas orörd — att latcha båda hade flyttat det
 * låsta tom-natt-provet i kalldodslarm-eskalering.test.js). Latchen bor i
 * tystnadsbokföringen och är MINNESBASERAD.
 *
 * TVÅ GRÄNSFALL SOM MÅSTE HÅLLA:
 *   • KALLSTART utan sedd övergång (socketen nere redan från appstart) ankras
 *     i observationsfönstret, inte i now — annars hade varje kallstart gett
 *     210 s amnesti och de låsta blindhetsproven tystnat.
 *   • FLAPP (503-stormen: upptid aldrig över 34,6 s) får inte ge evig
 *     amnesti; latchen nollas bara av en STABIL anslutning.
 */

const REAL_DATE_NOW = Date.now;
const MIN = 60 * 1000;
const FRESH_POLL_MS = 3 * (AIS_CONFIG.AISHUB.POLL_INTERVAL_MS + AIS_CONFIG.AISHUB.POLL_JITTER_MS);

const makeApp = () => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app.homey = {
    settings: { get: () => null, set: jest.fn(), on: jest.fn() },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  app._hubFeedsPipeline = jest.fn().mockReturnValue(true);
  return app;
};

// aisstream i SERVERDÖDSLÄGE: socketen öppen (eller nere), noll levererade
// meddelanden — tystnaden mäts därför från observationsankaret (= uptime).
const stream = (connected, { uptimeMs = 60 * MIN, configured = true } = {}) => ({
  configured,
  isConnected: connected,
  lastMessageTime: null,
  timeSinceLastMessage: null,
  uptime: uptimeMs,
});

const hub = (lastOkAgeMs, { uptimeMs = 60 * MIN } = {}) => ({
  configured: true,
  isConnected: lastOkAgeMs !== null,
  lastMessageTime: null,
  timeSinceLastMessage: null,
  uptime: uptimeMs,
  lastOkResponseAt: lastOkAgeMs === null ? null : Date.now() - lastOkAgeMs,
});

const flush = () => new Promise((resolve) => {
  setImmediate(resolve);
});
const sentKeys = (app) => [...(app._connectionIssueNotifiedAt || new Map()).keys()];
const logText = (app) => app.log.mock.calls.map((c) => c.join(' ')).join('\n');

describe('H18: en socketblink bränner inte blindhetsnycklarna', () => {
  let mockNow;
  beforeEach(() => {
    mockNow = 1700000000000;
    Date.now = () => mockNow;
  });
  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  test('MUTATIONSPROVET: blink + hubbglapp ⇒ TYST, och det ÄKTA avbrottet larmar sedan', async () => {
    const app = makeApp();

    // Läge: aisstream serverdöd (socket öppen, noll data i 60 min), hubben
    // svarar men kanalen är tom. Ingen notis — det är U12:s tom-kanal.
    app._checkCrossFeedSilence({ aisstream: stream(true), aishub: hub(10 * 1000) });
    await flush();
    expect(sentKeys(app)).toHaveLength(0);

    // BLINKEN: socketen faller in i reconnect-backoff exakt när hubben
    // missat ~3,5 min pollar. Före fixen: trulyBlind ⇒ feeds:silent bränd.
    mockNow += MIN;
    app._checkCrossFeedSilence({ aisstream: stream(false), aishub: hub(220 * 1000) });
    await flush();
    expect(sentKeys(app)).toHaveLength(0);
    expect(logText(app)).not.toContain('appen är blind');
    expect(logText(app)).toContain('hysteresfönstret');

    // Socketen är tillbaka inom fönstret — blinken var just en blink.
    mockNow += 60 * 1000;
    app._checkCrossFeedSilence({ aisstream: stream(true), aishub: hub(5 * 1000) });
    await flush();
    expect(sentKeys(app)).toHaveLength(0);

    // ETT DYGN SENARE (samma 24h-fönster): ÄKTA totalavbrott. Nycklarna är
    // obrända, så larmet fyrar — det var precis detta som gick förlorat.
    mockNow += 60 * MIN;
    app._checkCrossFeedSilence({ aisstream: stream(false), aishub: hub(null) });
    await flush();
    expect(sentKeys(app)).toContain('feeds:silent');
    expect(logText(app)).toContain('appen är blind');
  });

  test('ihållande nedsläckning: larmet fyrar när latchen passerat fönstret', async () => {
    const app = makeApp();
    app._checkCrossFeedSilence({ aisstream: stream(true), aishub: hub(10 * 1000) });
    await flush();

    // Nedsläckning. Inom fönstret: tyst.
    mockNow += MIN;
    app._checkCrossFeedSilence({ aisstream: stream(false), aishub: hub(null) });
    await flush();
    expect(sentKeys(app)).toHaveLength(0);

    // Bortom fönstret (210 s): blind.
    mockNow += FRESH_POLL_MS + 1000;
    app._checkCrossFeedSilence({ aisstream: stream(false), aishub: hub(null) });
    await flush();
    expect(sentKeys(app)).toContain('feeds:silent');
  });

  test('KALLSTART med nere socket: ingen amnesti (ankaret, inte now)', async () => {
    // Ingen övergång har observerats — appen startade med källan nere. Då
    // ska tystnadens egen klocka gälla, precis som före fixen.
    const app = makeApp();
    app._checkCrossFeedSilence({ aisstream: stream(false), aishub: hub(null) });
    await flush();

    expect(sentKeys(app)).toContain('feeds:silent');
    expect(logText(app)).toContain('appen är blind');
  });

  test('FLAPP snabbare än fönstret avväpnar INTE larmet (B2g(2)-skyddet)', async () => {
    const app = makeApp();
    // Sex cykler à 35 s uppe / 35 s nere — upptiden når aldrig 210 s.
    for (let i = 0; i < 6; i++) {
      app._checkCrossFeedSilence({
        aisstream: stream(true, { uptimeMs: 35 * 1000 }), aishub: hub(null),
      });
      mockNow += 35 * 1000;
      app._checkCrossFeedSilence({ aisstream: stream(false), aishub: hub(null) });
      mockNow += 35 * 1000;
    }
    await flush();

    // Latchen sattes vid FÖRSTA nedslaget och har aldrig nollats av en
    // stabil anslutning ⇒ den nedsläckta ticken döms som förut.
    expect(sentKeys(app)).toContain('feeds:silent');
  });

  test('en STABIL anslutning nollar latchen (hysteresen armas om)', async () => {
    const app = makeApp();
    app._checkCrossFeedSilence({ aisstream: stream(false), aishub: hub(null) });
    await flush();
    expect(sentKeys(app)).toContain('feeds:silent'); // aldrig sedd svara

    // Stabil socket i 20 min ⇒ latchen nollas.
    mockNow += 20 * MIN;
    app._checkCrossFeedSilence({
      aisstream: stream(true, { uptimeMs: 20 * MIN }), aishub: hub(10 * 1000),
    });
    const ledger = app._getFeedSilenceLedger();
    expect(Number.isFinite(ledger.aisstream.lastRespondingAt)).toBe(true);

    // Nästa nedslag får därmed ett helt nytt hysteresfönster.
    mockNow += MIN;
    app._checkCrossFeedSilence({ aisstream: stream(false), aishub: hub(null) });
    expect(logText(app)).toContain('hysteresfönstret');
  });
});

describe('H18: speglingen är ENSIDIG', () => {
  let mockNow;
  beforeEach(() => {
    mockNow = 1700000000000;
    Date.now = () => mockNow;
  });
  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  test('hubbsidan får ingen latch — dess 210 s-fönster ÄR redan hysteresen', async () => {
    const app = makeApp();
    // Hubben slutar svara medan aisstream-socketen är uppe.
    app._checkCrossFeedSilence({ aisstream: stream(true), aishub: hub(10 * 1000) });
    mockNow += MIN;
    app._checkCrossFeedSilence({ aisstream: stream(true), aishub: hub(220 * 1000) });
    await flush();

    const ledger = app._getFeedSilenceLedger();
    expect(ledger.aishub.lastRespondingAt).toBeUndefined();
    // "delvis": aisstream svarar, hubben inte ⇒ ingen notis, men loggen namnger båda.
    const rader = logText(app).split('\n').filter((l) => l.includes('INGEN aktiv AIS-källa'));
    const rad = rader[rader.length - 1];
    expect(rad).toContain('aishub svarar inte');
    expect(sentKeys(app)).toHaveLength(0);
  });

  test('avkonfigurerad aisstream lämnar ingen latch efter sig', () => {
    const app = makeApp();
    app._checkCrossFeedSilence({
      aisstream: stream(true, { uptimeMs: 60 * MIN }), aishub: hub(10 * 1000),
    });
    expect(Number.isFinite(app._getFeedSilenceLedger().aisstream.lastRespondingAt)).toBe(true);
    app._checkCrossFeedSilence({
      aisstream: stream(false, { configured: false }), aishub: hub(10 * 1000),
    });
    const ledger = app._getFeedSilenceLedger();
    expect(ledger.aisstream.lastRespondingAt).toBeUndefined();
  });

  test('latchen persisteras ALDRIG (den ska inte överleva en omstart)', () => {
    const app = makeApp();
    app._checkCrossFeedSilence({ aisstream: stream(true), aishub: hub(null) });
    app._feedSilenceLedgerDirty = true;
    app._persistFeedSilenceLedger(true);

    const [nyckel, blob] = app.homey.settings.set.mock.calls[0];
    expect(nyckel).toBe('feed_silence_ledger');
    for (const post of Object.values(blob)) {
      expect(post.lastRespondingAt).toBeUndefined();
    }
  });
});
