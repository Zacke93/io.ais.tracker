'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

/**
 * =============================================================================
 * J30 (helkodsgranskning runda 2, 2026-08-22)
 * =============================================================================
 * OMÄTBAR FEEDTYSTNAD AVVÄPNADE P8-VAKTEN PÅ BÅDA STÄLLEN.
 *
 * Både removal-vägen (_onVesselRemoved) och UI-vägen (_processUIUpdate) satte
 * feedSilentMs = null när aggregatets timeSinceLastMessage inte var finit, och
 * provade sedan `feedSilentMs !== null && feedSilentMs > gränsen`. Ett OKÄNT
 * tystnadsmått räknades därmed som "INTE tyst" ⇒ vakten föll igenom och
 * DEFAULT-texten ("Inga båtar…") publicerades som SANNING trots att appen inte
 * visste något alls om kanalen. Ingen loggrad avslöjade avväpningen.
 *
 * NÅBART MOT RIKTIG KOD: efter källbyte / byte av aishub-användarnamn
 * återskapas hubbklienten färsk — isConnected tänds av första OK-pollen medan
 * lastMessageTime bara bumpas av FÄRSKA poster. Aggregatet ger då
 * isConnected=true och timeSinceLastMessage=null, och sista båten kan
 * STALE-timeoutas utan att ett enda meddelande kommit in.
 *
 * Sviten låser TRE saker:
 *   1. omätbart mått ⇒ texten HÅLLS på båda ställen (+ loggrad),
 *   2. gränsen är EN konstant (systerställena kan inte glida isär),
 *   3. P8-sviternas gamla beteende står kvar när aisClient saknas HELT.
 */

const HELD_TEXT = 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter';
const DEFAULT_TEXT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve(); // eslint-disable-line no-await-in-loop
};

// ---------------------------------------------------------------------------
// REMOVAL-VÄGEN (samma rigg som p8-stale-guard-sviten)
// ---------------------------------------------------------------------------
function makeRemovalApp({ isConnected = true, stats } = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app._isConnected = isConnected;
  app._lastBridgeText = HELD_TEXT;
  app._lastBridgeAlarm = true;
  app._vesselRemovalTimers = new Map();
  app._processingRemoval = new Set();
  app._triggeredBoatNearKeys = new Set();
  app.vesselDataService = { getVesselCount: jest.fn().mockReturnValue(0) };
  app.statusService = {
    statusStabilizer: { removeVessel: jest.fn() },
    clearVesselETAHistory: jest.fn(),
  };
  app.bridgeTextService = { clearVesselPhaseTracking: jest.fn() };
  app._clearBoatNearTriggers = jest.fn();
  app._updateDeviceCapability = jest.fn();
  app._globalBridgeTextToken = { setValue: jest.fn().mockResolvedValue(undefined) };
  if (stats !== undefined) app.aisClient = { getConnectionStats: stats };
  return app;
}

const removedEvent = {
  mmsi: '265001111',
  vessel: { mmsi: '265001111', passedBridges: [] },
  reason: 'stale_ais',
};

const logRows = (app) => app.log.mock.calls.map((c) => String(c[0]));

describe('J30 removal-vägen: omätbart tystnadsmått räknas som TYST', () => {
  // Tre former av "omätbart" — alla tre kommer ur riktiga klienter:
  //  null      : muxens minOfNullable när ingen matande källa har lastMessageTime
  //  undefined : ett stats-objekt utan fältet (äldre/annan klient)
  //  NaN       : en klocka som aldrig satts (Date.now() - undefined)
  const OMATBARA = [
    ['null', () => ({ isConnected: true, timeSinceLastMessage: null, uptime: 1000 })],
    ['undefined (fältet saknas)', () => ({ isConnected: true, uptime: 1000 })],
    ['NaN', () => ({ isConnected: true, timeSinceLastMessage: NaN, uptime: 1000 })],
  ];

  test.each(OMATBARA)('ansluten + timeSinceLastMessage=%s ⇒ texten hålls, DEFAULT publiceras INTE', async (_label, stats) => {
    const app = makeRemovalApp({ isConnected: true, stats });

    await app._onVesselRemoved(removedEvent);

    expect(app._lastBridgeText).toBe(HELD_TEXT);
    expect(app._updateDeviceCapability).not.toHaveBeenCalledWith('bridge_text', DEFAULT_TEXT);
    expect(app._globalBridgeTextToken.setValue).not.toHaveBeenCalled();
  });

  test('avväpningen SYNS i loggen (FEED_SILENCE_UNMEASURABLE + ärlig vaktrad)', async () => {
    const app = makeRemovalApp({
      isConnected: true,
      stats: () => ({ isConnected: true, timeSinceLastMessage: null }),
    });

    await app._onVesselRemoved(removedEvent);

    const rows = logRows(app);
    const unmeasurable = rows.find((r) => r.includes('[FEED_SILENCE_UNMEASURABLE]'));
    expect(unmeasurable).toBeDefined();
    expect(unmeasurable).toContain('VESSEL_REMOVAL_STALE_GUARD');
    // Den gamla vaktraden hade skrivit "0s without messages" — en lögn: måttet
    // SAKNADES, det var inte noll.
    const guard = rows.find((r) => r.includes('[VESSEL_REMOVAL_STALE_GUARD]'));
    expect(guard).toBeDefined();
    expect(guard).toContain('tystnadsmåttet saknas');
    expect(guard).not.toContain('0s without messages');
  });

  test('ett KASTANDE getConnectionStats loggas men fäller inte vakten (dagens beteende)', async () => {
    // En klient som kastar ger INGEN uppgift alls — varken mått eller
    // anslutningsflagga. Då är app._isConnected enda kunskapskällan, precis som
    // när klienten saknas. Det som ändrats är att tystnaden inte längre sväljs
    // helt tyst.
    const app = makeRemovalApp({
      isConnected: true,
      stats: () => {
        throw new Error('klienten river ner sig');
      },
    });

    await app._onVesselRemoved(removedEvent);

    expect(app._lastBridgeText).toBe(DEFAULT_TEXT);
    expect(logRows(app).some((r) => r.includes('[FEED_SILENCE_UNMEASURABLE]'))).toBe(true);
    expect(app.error).not.toHaveBeenCalled(); // svälj-fällan åt andra hållet
  });

  test('GRÄNSEN MOT REPLAY/UPPSTART: omätbart mått + klienten EJ ansluten ⇒ DEFAULT som förut', async () => {
    // Facit-kritisk gräns, uppmätt: replay-harnessen matar sampel direkt till
    // _processAISMessage, så muxen har alltid lastMessageTime=null, uptime=0
    // OCH isConnected=false. Utan den här grenen blir vakten permanent armad i
    // replay och fryser ett fartygspåstående i upp till 30 min (uppmätt i
    // 20260707-14h) — precis den klass pelare 1 finns till för att jaga.
    const app = makeRemovalApp({
      isConnected: true,
      stats: () => ({ isConnected: false, timeSinceLastMessage: null, uptime: 0 }),
    });

    await app._onVesselRemoved(removedEvent);

    expect(app._lastBridgeText).toBe(DEFAULT_TEXT);
  });

  test('P8-GRÄNSEN STÅR KVAR: utan aisClient publiceras DEFAULT som förut', async () => {
    // Dagens beteende BEHÅLLS medvetet när klienten saknas helt — då är
    // _isConnected enda kunskapskällan, och P8-sviten låser den vägen.
    const app = makeRemovalApp({ isConnected: true });

    await app._onVesselRemoved(removedEvent);

    expect(app._lastBridgeText).toBe(DEFAULT_TEXT);
    expect(logRows(app).some((r) => r.includes('[FEED_SILENCE_UNMEASURABLE]'))).toBe(false);
  });

  test('KOSTNADSSIDAN: färsk feed släpper igenom DEFAULT precis som förut', async () => {
    const app = makeRemovalApp({
      isConnected: true,
      stats: () => ({ timeSinceLastMessage: 20 * 1000 }),
    });

    await app._onVesselRemoved(removedEvent);

    expect(app._lastBridgeText).toBe(DEFAULT_TEXT);
  });
});

// ---------------------------------------------------------------------------
// UI-VÄGEN (samma rigg som fable-omgang2 A2R2-3)
// ---------------------------------------------------------------------------
function makeUiApp({ isConnected = true, stats } = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._devices = new Set();
  app._isConnected = isConnected;
  app._lastBridgeText = HELD_TEXT;
  app._lastBridgeTextHash = 'x';
  app.bridgeTextService = { generateBridgeText: () => DEFAULT_TEXT };
  app._validateBridgeTextSummary = () => ({ isValid: true });
  app.vesselDataService = { hasGpsJumpHold: () => false };
  app._globalBridgeTextToken = { setValue: jest.fn().mockResolvedValue(undefined) };
  if (stats !== undefined) app.aisClient = { getConnectionStats: stats };
  return app;
}

const emptySnapshot = () => ({
  vesselCount: 0, relevantVessels: [], vesselsBeingRemoved: new Set(),
});

describe('J30 UI-vägen: samma doktrin, samma gräns', () => {
  test('ansluten + omätbart mått + 0 båtar ⇒ senaste texten behålls', async () => {
    const app = makeUiApp({ stats: () => ({ isConnected: true, timeSinceLastMessage: null }) });

    const result = await app._processUIUpdate(emptySnapshot());
    await flush();

    expect(result.bridgeText).toBe(HELD_TEXT);
    const rows = logRows(app);
    expect(rows.some((r) => r.includes('[UI_FEED_STALE_GUARD]'))).toBe(true);
    const unmeasurable = rows.find((r) => r.includes('[FEED_SILENCE_UNMEASURABLE]'));
    expect(unmeasurable).toBeDefined();
    expect(unmeasurable).toContain('UI_FEED_STALE_GUARD');
  });

  test('KOSTNADSSIDAN: färsk feed ⇒ DEFAULT publiceras (vakten är inte klistrig)', async () => {
    const app = makeUiApp({ stats: () => ({ isConnected: true, timeSinceLastMessage: 20 * 1000 }) });

    const result = await app._processUIUpdate(emptySnapshot());
    await flush();

    expect(result.bridgeText).toBe(DEFAULT_TEXT);
    expect(logRows(app).some((r) => r.includes('[UI_FEED_STALE_GUARD]'))).toBe(false);
  });

  test('GRÄNSEN MOT REPLAY: omätbart mått + klienten EJ ansluten ⇒ DEFAULT som förut', async () => {
    const app = makeUiApp({ stats: () => ({ isConnected: false, timeSinceLastMessage: null }) });

    const result = await app._processUIUpdate(emptySnapshot());
    await flush();

    expect(result.bridgeText).toBe(DEFAULT_TEXT);
  });

  test('P8-GRÄNSEN STÅR KVAR: utan aisClient + ansluten ⇒ DEFAULT som förut', async () => {
    const app = makeUiApp();

    const result = await app._processUIUpdate(emptySnapshot());
    await flush();

    expect(result.bridgeText).toBe(DEFAULT_TEXT);
  });
});

// ---------------------------------------------------------------------------
// SYSTERSTÄLLESLÅSET: en gräns, inte två
// ---------------------------------------------------------------------------
describe('J30: removal- och UI-vakten delar EXAKT samma tystnadsgräns', () => {
  const GRANS_MS = 5 * 60 * 1000;

  // UI-vägen bar gränsen hårdkodad (5 * 60 * 1000) medan removal-vägen hade en
  // egen lokal konstant. Testet mäter BÅDA vakterna på var sin sida av samma
  // millisekund — glider talen isär i framtiden rodnar exakt en rad här.
  test.each([
    ['strax UNDER gränsen ⇒ båda släpper DEFAULT', GRANS_MS - 1, DEFAULT_TEXT],
    ['strax ÖVER gränsen ⇒ båda håller texten', GRANS_MS + 1, HELD_TEXT],
  ])('%s', async (_label, silentMs, expected) => {
    const stats = () => ({ isConnected: true, timeSinceLastMessage: silentMs });

    const removalApp = makeRemovalApp({ isConnected: true, stats });
    await removalApp._onVesselRemoved(removedEvent);
    expect(removalApp._lastBridgeText).toBe(expected);

    const uiApp = makeUiApp({ stats });
    const result = await uiApp._processUIUpdate(emptySnapshot());
    await flush();
    expect(result.bridgeText).toBe(expected);
  });

  test('hjälpmetoden är EN funktion med ett entydigt kontrakt', () => {
    const app = Object.create(AISBridgeApp.prototype);
    app.log = jest.fn();

    // Ingen klient alls ⇒ inget mått, ingen tystnad, ingen loggrad.
    expect(app._evaluateFeedSilence('T')).toEqual({
      hasStats: false, feedSilentMs: null, silent: false, unmeasurable: false,
    });

    app.aisClient = { getConnectionStats: () => ({ isConnected: true, timeSinceLastMessage: 7 * 60 * 1000 }) };
    expect(app._evaluateFeedSilence('T')).toEqual({
      hasStats: true, feedSilentMs: 7 * 60 * 1000, silent: true, unmeasurable: false,
    });

    // Ansluten men stum ⇒ tyst (och loggad).
    app.aisClient = { getConnectionStats: () => ({ isConnected: true }) };
    expect(app._evaluateFeedSilence('T')).toEqual({
      hasStats: true, feedSilentMs: null, silent: true, unmeasurable: true,
    });
    expect(app.log).toHaveBeenCalledTimes(1);

    // Stats-objektet självt saknas ⇒ ingen anslutningsuppgift ⇒ dagens beteende.
    app.aisClient = { getConnectionStats: () => null };
    expect(app._evaluateFeedSilence('T')).toEqual({
      hasStats: true, feedSilentMs: null, silent: false, unmeasurable: true,
    });
  });
});
