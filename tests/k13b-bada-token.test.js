'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * K13b — "BÅDA" PÅ bridge_opening_soon (ANVÄNDARBESLUT F5, 2026-08-21)
 * =============================================================================
 *
 * Gula batch 1 lade `eventDirection` i öppningsvarningens payload
 * (BridgeOpeningService:1509/1529): riktningen mätt på HELA medlemsmängden —
 * samma lista som vessel_count och mmsis — med värdet 'mixed' när öppningen
 * täcker MÖTANDE båtar. Fältprov 10 har exakt ett sådant fall:
 * Stridsbergsbron#2 09:12:03 med BALTIC JONGLEUR (304028000, norrut) och TONGA
 * (211495920, söderut) i samma händelse. Kortet bar då 'southbound' — LEDARENS
 * riktning, dvs. halva sanningen om en öppning som gäller båda hållen.
 *
 * Granskarna i batch 1 konstaterade att fältet var DÖD KOD: app.js bygger
 * flow-tokens ur en explicit vitlista och läste aldrig `eventDirection`.
 * Den här sviten låser konsumentsidan:
 *
 *   1. 'mixed'  ⇒ tokenen säger 'båda'
 *   2. enig     ⇒ tokenen säger 'norrut'/'söderut'
 *   3. null     ⇒ INGEN UPPGIFT ⇒ fall tillbaka på ledarens `direction`
 *      (servicens eget kontrakt, _eventDirection-dokumentationen)
 *   4. den PERSISTENTA dedup-nyckeln (bro|mmsi|riktning) är MEDVETET kvar på
 *      interna ord — den lever i settings över omstarter och ett språkbyte
 *      hade gjort varje lagrad nyckel omatchbar.
 */

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { toUserDirection, fromUserDirection } = require('../lib/utils/directionTokens');

/** Full appstart via produktionsvägen (samma dans som replay-harnessen). */
const bootApp = async () => {
  const app = new AISBridgeApp();
  app.homey = mockHomey;
  mockHomey.app.settings = { debug_level: 'off', ais_api_key: null };
  mockHomey.settings = {
    get: (key) => mockHomey.app.settings[key] || null,
    set: (key, value) => {
      mockHomey.app.settings[key] = value;
    },
    on: () => {},
    off: () => {},
  };
  global.__TEST_MODE__ = true;
  await app.onInit();
  return app;
};

/**
 * Kringgå testgrinden i _onBridgeOpeningWarning och kör EXAKT produktionens
 * väg (NODE_ENV='production' + TEST_MODE av) — samma teknik som replayRunner
 * och bridge-opening-app-integration.
 */
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

/** Fältets blandriktade händelse: Stridsbergsbron#2 2026-08-19 09:12:03. */
const mixedFieldPayload = (overrides = {}) => ({
  t: Date.now(),
  eventId: 'Stridsbergsbron#2',
  bridge: 'Stridsbergsbron',
  direction: 'southbound', // LEDARENS riktning (TONGA)
  eventDirection: 'mixed', // HÄNDELSENS riktning (BALTIC JONGLEUR + TONGA)
  etaMinutes: 6,
  vesselCount: 2,
  leadVessel: 'TONGA',
  leadMmsi: '211495920',
  firedBy: 'fix',
  mmsis: ['211495920', '304028000'],
  distanceM: 1165,
  ...overrides,
});

describe('K13b — bridge_opening_soon: riktningstokenen beskriver ÖPPNINGEN', () => {
  let app = null;

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    delete global.__TEST_MODE__;
  });

  const fireAndRead = async (payload) => {
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payload);
      await Promise.resolve();
    });
    const calls = card.getTriggerCalls();
    expect(calls).toHaveLength(1);
    return calls[0];
  };

  test('MÖTANDE konvoj (eventDirection "mixed") ⇒ tokenen säger "båda"', async () => {
    app = await bootApp();
    const call = await fireAndRead(mixedFieldPayload());

    // Fältet: kortet sa 'southbound' (ledaren TONGA) fast öppningen gällde
    // BÅDA hållen. Det påståendet får inte komma tillbaka.
    expect(call.tokens.direction).toBe('båda');
    expect(call.tokens.vessel_count).toBe(2);
    expect(call.tokens.vessel_name).toBe('TONGA'); // ledaren är fortsatt ledaren
  });

  test('ENIG konvoj ⇒ svensk riktning, inte ledarens interna ord', async () => {
    app = await bootApp();

    const north = await fireAndRead(mixedFieldPayload({
      eventId: 'Klaffbron#1', bridge: 'Klaffbron', direction: 'northbound', eventDirection: 'northbound',
    }));
    expect(north.tokens.direction).toBe('norrut');

    const south = await fireAndRead(mixedFieldPayload({
      eventId: 'Klaffbron#2', bridge: 'Klaffbron', direction: 'southbound', eventDirection: 'southbound',
    }));
    expect(south.tokens.direction).toBe('söderut');
  });

  test('eventDirection null = INGEN UPPGIFT ⇒ ledarens direction bär tokenen', async () => {
    app = await bootApp();

    // Servicens kontrakt (_eventDirection): null betyder att ingen MEDLEM har
    // hunnit låsa ruttriktning. `direction` har en egen COG-fallback och är då
    // den bästa uppgiften som finns.
    const call = await fireAndRead(mixedFieldPayload({
      eventId: 'Klaffbron#3', bridge: 'Klaffbron', direction: 'northbound', eventDirection: null,
    }));
    expect(call.tokens.direction).toBe('norrut');
  });

  test('saknas BÅDA fälten ⇒ "okänd" (aldrig ett engelskt ord i tokenen)', async () => {
    app = await bootApp();
    const call = await fireAndRead(mixedFieldPayload({
      eventId: 'Klaffbron#4', bridge: 'Klaffbron', direction: undefined, eventDirection: null,
    }));
    expect(call.tokens.direction).toBe('okänd');
    expect(['northbound', 'southbound', 'unknown', 'mixed'])
      .not.toContain(call.tokens.direction);
  });

  test('"mixed" får inte falla igenom ?? — ledarens riktning vinner ALDRIG över den', async () => {
    app = await bootApp();
    // Mutationsvakt: byts `??` mot `||` beter sig 'mixed' likadant, men byts
    // ordningen (direction före eventDirection) blir svaret 'söderut'.
    const call = await fireAndRead(mixedFieldPayload({ eventId: 'Stridsbergsbron#9' }));
    expect(call.tokens.direction).not.toBe('söderut');
    expect(call.tokens.direction).toBe('båda');
  });

  test('DIR_TOKEN-VAKTEN: ett ord utanför den interna vokabulären LOGGAS', async () => {
    app = await bootApp();
    // toUserDirection sväljer skräp och svarar 'okänd' — rätt för användaren,
    // men det gör en framtida stavfelsretur TYST hela vägen förbi INV-2
    // (adaptern gör 'okänd' → 'unknown', som står i giltighetslistan). Vakten
    // i app.js loggar innan översättningen; tokenvärdet är oförändrat.
    const errSpy = jest.spyOn(app, 'error').mockImplementation(() => {});
    const call = await fireAndRead(mixedFieldPayload({
      eventId: 'Klaffbron#7', bridge: 'Klaffbron', eventDirection: 'northboud',
    }));

    expect(call.tokens.direction).toBe('okänd');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[DIR_TOKEN]'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('northboud'));
    errSpy.mockRestore();
  });

  test('DIR_TOKEN-VAKTEN tiger när riktningen SAKNAS (ingen uppgift ≠ regression)', async () => {
    app = await bootApp();
    // En payload utan riktning är ett legitimt "ingen medlem har låst rutt" —
    // vakten får inte spamma fältloggen för det (allowMissing).
    const errSpy = jest.spyOn(app, 'error').mockImplementation(() => {});
    const call = await fireAndRead(mixedFieldPayload({
      eventId: 'Klaffbron#8', bridge: 'Klaffbron', direction: undefined, eventDirection: null,
    }));

    expect(call.tokens.direction).toBe('okänd');
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('[DIR_TOKEN]'));
    errSpy.mockRestore();
  });

  test('den PERSISTENTA dedup-nyckeln förblir INTERN (bro|mmsi|riktning)', async () => {
    app = await bootApp();
    await fireAndRead(mixedFieldPayload({ eventId: 'Stridsbergsbron#5' }));

    const keys = [...app._persistentOpeningWarnings.keys()];
    // Nyckeln byggs av payload.direction (ledarens INTERNA värde) — den lever
    // i settings över omstarter, och ett språkbyte där hade gjort varje lagrad
    // nyckel omatchbar och släppt fram dubbelvarningar efter uppdateringen.
    expect(keys).toContain('Stridsbergsbron|211495920|southbound');
    expect(keys).toContain('Stridsbergsbron|304028000|southbound');
    for (const key of keys) {
      expect(key).not.toMatch(/norrut|söderut|okänd|båda/);
    }
  });
});

describe('F5 — översättningens uppslag går ALDRIG via prototypkedjan', () => {
  // INTERNAL_TO_USER/USER_TO_INTERNAL är objektliteraler och ärver
  // Object.prototype. Med ett rått `if (KARTA[värde])`-uppslag är
  // `KARTA['constructor']` funktionen Object — sanningsvärde true — och
  // toUserDirection hade returnerat en FUNKTION som användarsynlig token.
  // Uppslagen använder därför hasOwnProperty.
  test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'toUserDirection(%p) ⇒ "okänd", aldrig ett ärvt värde',
    (key) => {
      const out = toUserDirection(key);
      expect(out).toBe('okänd');
      expect(typeof out).toBe('string');
    },
  );

  test.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'fromUserDirection(%p) returneras ORÖRT (INV-2 ska fortsatt se skräpet)',
    (key) => {
      expect(fromUserDirection(key)).toBe(key);
    },
  );

  test('de fyra äkta paren är oförändrade i båda riktningarna', () => {
    const pairs = [['northbound', 'norrut'], ['southbound', 'söderut'],
      ['mixed', 'båda'], ['unknown', 'okänd']];
    for (const [internal, user] of pairs) {
      expect(toUserDirection(internal)).toBe(user);
      expect(fromUserDirection(user)).toBe(internal);
      // Idempotens (safeTokens gör ett andra pass).
      expect(toUserDirection(user)).toBe(user);
      expect(fromUserDirection(internal)).toBe(internal);
    }
  });
});
