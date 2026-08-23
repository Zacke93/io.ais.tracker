'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * S13 (systerställesrundan 2026-08-23) — OMSTARTSSKYDDET VILADE PÅ
 * DISPLAYTOKENET, INTE PÅ NÅGON PROGNOS OM PASSAGEN
 * =============================================================================
 *
 * MEKANISMEN FÖRE FIXEN. Öppningspostens utgång bildades som
 * avfyrning + konvojfönstret + max(0, etaMinutes), kapat till en timme —
 * där `etaMinutes` är KORTETS token. Tokenet underskattar systematiskt:
 *   • det är -1 (⇒ 0 minuters påslag) så snart B2d-grinden dömer fixet
 *     äldre än STALE_ETA_HARD_MS,
 *   • det är LEDARENS ögonblicksprognos och ser inte att en medlem köar.
 * Ommätt över ALLA 20 korpusar: 366 varningar, 288 med passage inom 120 min,
 * 127 (44,1 %) med skydd KORTARE än verklig ledtid; oskyddad svans median
 * 10,2 min och max 67,2 min. Ledtid median 16,9 min mot ETA-token median
 * 8 min. Skadan är omstartsspecifik: en LEVANDE session varnar aldrig två
 * gånger för samma arm (BridgeOpeningService filtrerar bort armar med
 * warnedAt satt), så kartan är enda vakten efter en omstart.
 *
 * FIXEN RÖR BARA HALVA A. BridgeOpeningService lägger armens FÖRVÄNTADE
 * ankomsttid i payloaden (max över medlemmarna — posten skrivs med EN
 * gemensam utgång, så skyddet måste räcka för den som anländer sist), och
 * app.js bildar utgången som det STÖRSTA av dagens uttryck och förväntad
 * ankomst + konvojfönstret, fortfarande kapat av _OPENING_PERSIST_MAX_MS.
 * DET TVÅDELADE LÄSFÖNSTRET (J15b: bootLoaded väljer fönster) är HELT ORÖRT —
 * det är fyndets andra halva och redan bokförd som medveten avvägning
 * (ARCHITECTURE §9: "en äkta ANDRA öppning … kan tystas").
 *
 * PRODUKTIONSVÄGEN: riktig app.onInit, NODE_ENV='production' och
 * __TEST_MODE__ av — samma dans som j15b/k13b och replayRunner.
 *
 * MUTATIONSPROV (körda i isolerat träd, se rapporten):
 *  M1 = HEAD (utgången ur ETA-tokenen)      ⇒ de tre utgångstesterna + det
 *       omstartsscenariot röda
 *  M2 = max() bytt mot min() i BOS-reduktionen ⇒ "eftersläntraren" rött
 *  M3 = taket borttaget i app.js               ⇒ "taket binder" rött
 *  M4 = fallbacken borttagen (fältet krävs)    ⇒ "utan fältet" rött
 */

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGE_OPENING } = require('../lib/constants');

const MIN = 60 * 1000;
const MMSI = '258177180';
const NYCKEL = 'Klaffbron|258177180|northbound';

const bootApp = async ({ behållSettings = false } = {}) => {
  const app = new AISBridgeApp();
  app.homey = mockHomey;
  if (!behållSettings) {
    mockHomey.app.settings = { debug_level: 'off', ais_api_key: null };
  }
  mockHomey.settings = {
    get: (key) => (key in mockHomey.app.settings ? mockHomey.app.settings[key] : null),
    set: (key, value) => {
      mockHomey.app.settings[key] = value;
    },
    on: () => {},
    off: () => {},
  };
  global.__TEST_MODE__ = true;
  await app.onInit();
  app.log = jest.fn();
  app.error = jest.fn();
  return app;
};

const withRealFlowGate = async (fn) => {
  const savedEnv = process.env.NODE_ENV;
  const savedMode = global.__TEST_MODE__;
  process.env.NODE_ENV = 'production';
  global.__TEST_MODE__ = undefined;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = savedMode;
  }
};

const payloadFor = (overrides = {}) => ({
  t: Date.now(),
  eventId: 'Klaffbron#1',
  bridge: 'Klaffbron',
  direction: 'northbound',
  etaMinutes: 45,
  vesselCount: 1,
  leadVessel: 'HERA II',
  leadMmsi: MMSI,
  firedBy: 'fix',
  mmsis: [MMSI],
  distanceM: 1454,
  ...overrides,
});

let app = null;
let nowMs = 0;

beforeEach(() => {
  nowMs = 1767225600000;
  jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
});

afterEach(async () => {
  if (app) await app.onUninit();
  app = null;
  Date.now.mockRestore();
  delete global.__TEST_MODE__;
});

const avfyra = async (instans, payload) => {
  instans._bridgeOpeningTrigger.clearTriggerCalls();
  await withRealFlowGate(async () => {
    instans._onBridgeOpeningWarning(payload);
    await Promise.resolve();
  });
  return instans._bridgeOpeningTrigger.getTriggerCalls();
};

describe('S13: utgången bärs av förväntad ankomst', () => {
  test('GAMMALT FIX (eta-token -1) skyddas ändå fram till ankomsten', async () => {
    // B2d-grinden nollar tokenen när fixet är äldre än STALE_ETA_HARD_MS.
    // Dagens uttryck ger då RENT konvojfönster (10 min) trots att prognosen
    // säger 40 min kvar — det är den vanligaste formen av oskyddad svans.
    app = await bootApp();
    await avfyra(app, payloadFor({
      etaMinutes: -1,
      expectedArrivalMs: nowMs + 40 * MIN,
    }));

    const post = app._persistentOpeningWarnings.get(NYCKEL);
    expect(post.expiresAt).toBe(nowMs + 40 * MIN + BRIDGE_OPENING.CONVOY_WINDOW_MS);
  });

  test('EFTERSLÄNTRAREN: max över medlemmarna, inte ledarens siffra', async () => {
    // Ledaren är närmast bron och har den KORTASTE prognosen; posten skrivs
    // med EN gemensam utgång för alla medlemmar. BridgeOpeningService skickar
    // därför max över medlemmarnas expectedArrivalMs.
    app = await bootApp();
    await avfyra(app, payloadFor({
      etaMinutes: 5, // ledaren
      expectedArrivalMs: nowMs + 28 * MIN, // sista medlemmen
    }));

    const post = app._persistentOpeningWarnings.get(NYCKEL);
    expect(post.expiresAt).toBe(nowMs + 28 * MIN + BRIDGE_OPENING.CONVOY_WINDOW_MS);
  });

  test('DAGENS UTTRYCK VINNER när det är störst (aldrig en FÖRKORTNING)', async () => {
    app = await bootApp();
    await avfyra(app, payloadFor({
      etaMinutes: 30,
      expectedArrivalMs: nowMs + 2 * MIN,
    }));

    const post = app._persistentOpeningWarnings.get(NYCKEL);
    expect(post.expiresAt).toBe(nowMs + BRIDGE_OPENING.CONVOY_WINDOW_MS + 30 * MIN);
  });

  test('TAKET BINDER fortfarande (_OPENING_PERSIST_MAX_MS)', async () => {
    app = await bootApp();
    await avfyra(app, payloadFor({
      etaMinutes: -1,
      expectedArrivalMs: nowMs + 5 * 60 * MIN, // 5 timmar
    }));

    const post = app._persistentOpeningWarnings.get(NYCKEL);
    expect(post.expiresAt).toBe(nowMs + app._OPENING_PERSIST_MAX_MS);
  });

  test('SKRÄPVÄRDE (-Infinity / NaN / sträng) behandlas som INGEN UPPGIFT', async () => {
    // Två spärrar i serie mot samma sak: BridgeOpeningService normaliserar en
    // tom reduktion till null, och app.js kräver ändå Number.isFinite. Den
    // andra spärren är den som mäts här — utan den hade -Infinity gjort
    // Math.max() till -Infinity + fönstret, dvs. en utgång i det förflutna,
    // och HELA omstartsskyddet hade fallit tyst.
    app = await bootApp();
    const dagensUttryck = nowMs + BRIDGE_OPENING.CONVOY_WINDOW_MS + 15 * MIN;

    for (const skräp of [-Infinity, NaN, 'imorgon', null]) {
      app._persistentOpeningWarnings.clear();
      // eslint-disable-next-line no-await-in-loop
      await avfyra(app, payloadFor({
        eventId: `Klaffbron#skrap-${String(skräp)}`,
        etaMinutes: 15,
        expectedArrivalMs: skräp,
      }));
      expect(app._persistentOpeningWarnings.get(NYCKEL).expiresAt).toBe(dagensUttryck);
    }
  });

  test('UTAN FÄLTET är utgången BYTE-IDENTISK med före fixen', async () => {
    // Uppgraderingsgränsen: en payload från en äldre BridgeOpeningService (och
    // hela j15b-sviten) saknar fältet — dagens uttryck ska stå ensamt kvar.
    app = await bootApp();
    await avfyra(app, payloadFor({ etaMinutes: 15 }));

    const post = app._persistentOpeningWarnings.get(NYCKEL);
    expect(post.expiresAt).toBe(nowMs + BRIDGE_OPENING.CONVOY_WINDOW_MS + 15 * MIN);
    const blob = mockHomey.settings.get('persistent_opening_warnings');
    expect(blob[NYCKEL]).toEqual({
      firedAt: nowMs, expiresAt: nowMs + BRIDGE_OPENING.CONVOY_WINDOW_MS + 15 * MIN,
    });
  });
});

describe('S13: den omstartsspecifika skadan', () => {
  test('OMSTART 20 min efter ett gammalt fix ⇒ INGET andra kort', async () => {
    // Fältets form: varningen fyrar på ett fix äldre än 10 min (token -1),
    // men prognosen säger 35 min till ankomst. Homey uppdaterar appen 20 min
    // senare. Dagens uttryck skyddade i 10 min — kortet kom två gånger.
    app = await bootApp();
    await avfyra(app, payloadFor({
      etaMinutes: -1,
      expectedArrivalMs: nowMs + 35 * MIN,
    }));
    await app.onUninit();
    app = null;

    nowMs += 20 * MIN;
    app = await bootApp({ behållSettings: true });
    const post = app._persistentOpeningWarnings.get(NYCKEL);
    expect(post.bootLoaded).toBe(true);

    const kort = await avfyra(app, payloadFor({ eventId: 'Klaffbron#7', etaMinutes: 12 }));
    expect(kort).toHaveLength(0);
  });

  test('DEDUPEN ÄR ÄNDÅ INTE EVIG: efter ankomst + konvojfönster varnar den nya instansen', async () => {
    app = await bootApp();
    await avfyra(app, payloadFor({
      etaMinutes: -1,
      expectedArrivalMs: nowMs + 35 * MIN,
    }));
    await app.onUninit();
    app = null;

    nowMs += 46 * MIN; // 35 (ankomst) + 10 (konvojfönster) + 1 marginal
    app = await bootApp({ behållSettings: true });
    expect(app._persistentOpeningWarnings.size).toBe(0);

    const kort = await avfyra(app, payloadFor({ eventId: 'Klaffbron#9' }));
    expect(kort).toHaveLength(1);
  });

  test('LÄSFÖNSTRET ÄR ORÖRT: in-session-posten läses fortfarande med konvojfönstret', async () => {
    // J15b:s halva. En omvarning i SAMMA session efter lång radiotystnad ska
    // fortfarande släppas igenom, hur lång utgången än är.
    app = await bootApp();
    await avfyra(app, payloadFor({
      etaMinutes: -1,
      expectedArrivalMs: nowMs + 50 * MIN,
    }));

    nowMs += 11 * MIN; // > CONVOY_WINDOW_MS, men långt inom expiresAt
    const kort = await avfyra(app, payloadFor({ eventId: 'Klaffbron#3' }));
    expect(kort).toHaveLength(1);
  });
});
