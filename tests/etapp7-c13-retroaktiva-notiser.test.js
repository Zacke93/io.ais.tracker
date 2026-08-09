'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { BRIDGES } = require('../lib/constants');

/**
 * ETAPP 7, FAS C ETAPP V — C13/U7: retroaktiva notiser.
 *
 * C13 ÄR ÅTERKALLAD EFTER MÄTNING (princip 5). Filen är regressionslåset som
 * håller den återkallad: den låser (i) att FORM (b) redan finns och biter,
 * (ii) att FORM (a) inte finns — de nio fältfallen i korpus #18 måste fortsatt
 * fyra — och (iii) att ingen framtida granskare smyger in en avståndsgrind i
 * failsafe-grenen.
 *
 * MÄTNINGEN som motiverar låset (18 korpusar, ~320 h, 337 passage-fallback-
 * notiser, 1 048 korsningar i A2-rådatafacitet):
 *   • FORM (b) "tysta bara när en ANNAN notis för samma passage redan gått ut"
 *     ⇒ 0 av 337. Formen ÄR redan implementerad i _persistentDedupCheck
 *     (retroactiveSource: true). Fältloggen för 42h-provet visar 104
 *     FALLBACK_TRIGGER_PERSISTENT_DEDUP + 3 PERSISTENT_DEDUP_SAME_DIR_LATE,
 *     där de tre senare är C13:s EGNA skurmedlemmar (NIGE-O + AGULHAS @
 *     Stridsbergsbron, redan target-notifierade 09:15:06 resp. 09:13:57).
 *   • FORM (a) ren avståndströskel ⇒ 1:1-byte notis mot täckningsmiss. >2 000 m
 *     tar 23 notiser i 11 korpusar (10 LÅSTA) och skapar 22 nya korsningar utan
 *     notis. Ingen av de 337 är redundant.
 *   • Distans är fel storhet: r(distans, försening) = 0,28 (n = 237).
 *
 * Rådataverifierade fixturer nedan kommer ur
 * corpora-data/ais-20260806-42h.jsonl + gt-passages/20260806-42h.json.
 */

const KLAFF = Object.values(BRIDGES).find((b) => b.name === 'Klaffbron');
const JVB = Object.values(BRIDGES).find((b) => b.name === 'Järnvägsbron');
const STRIDS = Object.values(BRIDGES).find((b) => b.name === 'Stridsbergsbron');

/** Punkt `meters` norr (+) eller söder (−) om en bro, samma longitud. */
const offsetLat = (pt, meters) => ({
  lat: pt.lat + (meters / 111320),
  lon: pt.lon,
});

const BRIDGE_BY_NAME = {
  Klaffbron: KLAFF,
  Järnvägsbron: JVB,
  Stridsbergsbron: STRIDS,
};

const riggFailsafe = () => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._boatNearTrigger = { trigger: jest.fn() };
  app.vesselDataService = { hasGpsJumpHold: () => false };
  app.bridgeRegistry = {
    bridges: { klaffbron: KLAFF, jarnvagsbron: JVB, stridsbergsbron: STRIDS },
    getBridgeByName: (n) => BRIDGE_BY_NAME[n] || null,
  };
  // Notisleveransen mockas — testerna mäter GRINDEN, inte flow-kortet.
  app._triggerBoatNearFlowForBridge = jest.fn(async () => {});
  app._persistentRecentTriggers = new Map();
  app._persistRecentTriggers = jest.fn();
  app._PERSISTENT_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;
  app._PERSISTENT_DEDUP_RETENTION_MS = 6 * 60 * 60 * 1000;
  return app;
};

/** Fartyg som just dykt upp efter AIS-tystnad, `meters` förbi `bridge`. */
const rebornPast = (mmsi, bridge, meters, dir, sog) => {
  // Sydgående ligger SÖDER om bron efter passagen, nordgående norr om.
  const p = offsetLat(bridge, dir === 'south' ? -meters : meters);
  return {
    mmsi,
    lat: p.lat,
    lon: p.lon,
    sog,
    cog: dir === 'south' ? 200 : 20,
    _routeDirection: dir,
    lastPosition: null, // reborn ⇒ ingen spårhistorik (C5:s klass)
    passedAt: {},
    lastPassedBridge: null,
    lastPassedBridgeTime: null,
  };
};

const loggedWith = (fn, needle) => fn.mock.calls.some(
  (c) => typeof c[0] === 'string' && c[0].includes(needle),
);

// =============================================================================
// FORM (b) — REDAN IMPLEMENTERAD: samma passage tystas, ensam passage inte
// =============================================================================
describe('C13 form (b): retro-dedupen tystar redan de ÖVERFLÖDIGA (0 kvar att ta)', () => {
  test('NIGE-O @ Stridsbergsbron — target-notis 193 min tidigare ⇒ failsafen BLOCKERAS', async () => {
    // Rådata (korpus #18): 211216440 fick target-notis 2026-08-07T09:15:06 på
    // 237 m; hennes retroaktiva svep 12:28:24 (193 min senare, samma riktning)
    // blockerades i produktion av PERSISTENT_DEDUP_SAME_DIR_LATE.
    const app = riggFailsafe();
    app._persistentRecentTriggers.set('211216440:Stridsbergsbron', {
      t: Date.now() - 193 * 60 * 1000,
      dir: 'south',
    });
    const nigeO = rebornPast('211216440', STRIDS, 2117, 'south', 5.8);

    await app._triggerBoatNearFlowFallback(nigeO, 'Stridsbergsbron', {
      detectionTs: Date.now(),
      inferredFlush: true,
    });

    expect(app._triggerBoatNearFlowForBridge).not.toHaveBeenCalled();
    expect(loggedWith(app.log, 'FALLBACK_TRIGGER_PERSISTENT_DEDUP')).toBe(true);
    // SVÄLJ-FÄLLAN: en tystad notis får aldrig gå via felkanalen.
    expect(app.error).not.toHaveBeenCalled();
  });

  test('NIGE-O @ Järnvägsbron — INGEN tidigare notis ⇒ failsafen FYRAR (1 844 m)', async () => {
    // Samma skur, samma sekund, samma fartyg: den enda skillnaden är att
    // Järnvägsbrons korsning aldrig notifierats. Formen (b) kan alltså per
    // konstruktion inte nå den — och den är den ENDA notisen för korsningen
    // 2026-08-07T09:57:10 (A2-facit).
    const app = riggFailsafe();
    app._persistentRecentTriggers.set('211216440:Stridsbergsbron', {
      t: Date.now() - 193 * 60 * 1000,
      dir: 'south',
    });
    const nigeO = rebornPast('211216440', JVB, 1844, 'south', 5.8);

    await app._triggerBoatNearFlowFallback(nigeO, 'Järnvägsbron', {
      detectionTs: Date.now(),
      inferredFlush: true,
    });

    expect(app._triggerBoatNearFlowForBridge).toHaveBeenCalledTimes(1);
    expect(app._triggerBoatNearFlowForBridge.mock.calls[0][1]).toMatchObject({
      name: 'Järnvägsbron',
      source: 'passage-fallback',
    });
    expect(app.error).not.toHaveBeenCalled();
  });
});

// =============================================================================
// FORM (a) — INTE INFÖRD: de nio fältfallen måste fortsatt fyra
// =============================================================================
describe('C13 form (a): ingen avståndsgrind — annars byts notis mot täckningsmiss', () => {
  // Alla fyra är rådataverifierade i korpus #18 och var var för sig den ENDA
  // notisen för sin korsning i A2-facitet.
  const FALL = [
    // [namn, mmsi, bro, distans, riktning, sog, gt-korsning, försening]
    ['UTOPIA', '265810170', 'Klaffbron', 894, 'north', 0.7, '08:14:08', 7.5],
    ['ELFKUNGEN', '265573130', 'Klaffbron', 1056, 'north', 6.3, '10:17:26', 9.2],
    ['AGULHAS', '211349700', 'Järnvägsbron', 1597, 'south', 4.6, '10:24:45', 123.7],
    ['LENYA', '250004362', 'Klaffbron', 2294, 'south', 0.0, '13:56:08', 45.0],
  ];

  test.each(FALL)(
    '%s @ %s (%s) — %i m förbi bron fyrar ändå (ensam notis för korsningen)',
    async (namn, mmsi, bro, dist, dir, sog) => {
      const app = riggFailsafe();
      const v = rebornPast(mmsi, BRIDGE_BY_NAME[bro], dist, dir, sog);
      // LENYA stod still (sog 0) när hon dök upp igen: låg-sog-grinden
      // (500 m) får inte bita, för passagen är geometriskt belagd mellan de
      // två observerade positionerna ⇒ inferredFlush.
      await app._triggerBoatNearFlowFallback(v, bro, {
        detectionTs: Date.now(),
        inferredFlush: true,
      });

      expect(app._triggerBoatNearFlowForBridge).toHaveBeenCalledTimes(1);
      expect(Math.round(app._triggerBoatNearFlowForBridge.mock.calls[0][1].distance))
        .toBeGreaterThan(600); // en 600 m-grind hade tystat samtliga fyra
      expect(app.error).not.toHaveBeenCalled();
    },
  );

  test('LENYA-skurens tre broar ger tre notiser — ingen är en dublett av en annan', async () => {
    // 2026-08-07T13:32:44 lat 58.29344 (sog 1,0) → 68 min AIS-tystnad →
    // 14:41:09 lat 58.26606 (sog 0). Klaffbron, Olidebron och Kanalinfarten
    // ligger ALLA mellan de två observerade positionerna ⇒ tre skilda,
    // fysiskt belagda korsningar, inte tre kort om samma passage.
    const app = riggFailsafe();
    const olide = Object.values(BRIDGES).find((b) => b.name === 'Olidebron');
    app.bridgeRegistry.bridges.olidebron = olide;
    const prevMap = { ...BRIDGE_BY_NAME, Olidebron: olide };
    app.bridgeRegistry.getBridgeByName = (n) => prevMap[n] || null;

    const lenya = {
      mmsi: '250004362',
      lat: 58.26606,
      lon: 12.26488,
      sog: 0,
      cog: 289.8,
      _routeDirection: 'south',
      lastPosition: null,
      passedAt: {},
    };
    for (const bro of ['Klaffbron', 'Olidebron', 'Kanalinfarten']) {
      // eslint-disable-next-line no-await-in-loop
      await app._triggerBoatNearFlowFallback(lenya, bro, {
        detectionTs: Date.now(),
        inferredFlush: true,
      });
    }

    const fired = app._triggerBoatNearFlowForBridge.mock.calls.map((c) => c[1].name);
    expect(fired).toEqual(['Klaffbron', 'Olidebron', 'Kanalinfarten']);
    expect(new Set(fired).size).toBe(3);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('den enda grind som FINNS är sanity-taket (10 km), inte en C13-tröskel', async () => {
    const app = riggFailsafe();
    // 4 892 m (ELFKUNGEN @ Stallbackabron, korpus 20260711-16h) är den största
    // observerade distansen i alla 18 korpusar — den ska fortsatt släppas.
    const v = rebornPast('265573130', KLAFF, 4892, 'south', 5.0);
    await app._triggerBoatNearFlowFallback(v, 'Klaffbron', {
      detectionTs: Date.now(),
      inferredFlush: true,
    });
    expect(app._triggerBoatNearFlowForBridge).toHaveBeenCalledTimes(1);

    // ...men 10 km-sanityn biter (GPS-artefaktskyddet är oförändrat).
    const app2 = riggFailsafe();
    const far = rebornPast('265573130', KLAFF, 11000, 'south', 5.0);
    await app2._triggerBoatNearFlowFallback(far, 'Klaffbron', {
      detectionTs: Date.now(),
      inferredFlush: true,
    });
    expect(app2._triggerBoatNearFlowForBridge).not.toHaveBeenCalled();
    expect(loggedWith(app2.log, 'FALLBACK_TRIGGER_TOO_FAR')).toBe(true);
  });
});

// =============================================================================
// KÄLLÅS — ingen avståndsgrind får smygas in i failsafe-grenen
// =============================================================================
describe('C13 källås: failsafe-grenen bär inget nytt avståndsbeslut', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'app.js'),
    'utf8',
  );
  const fnStart = src.indexOf('async _triggerBoatNearFlowFallback(');
  const fnEnd = src.indexOf('_triggerBoatNearFlowForBridge(vessel, candidate)', fnStart);
  const body = src.slice(fnStart, fnEnd);

  test('funktionen finns och kunde isoleras (annars mäter låset ingenting)', () => {
    expect(fnStart).toBeGreaterThan(0);
    expect(fnEnd).toBeGreaterThan(fnStart);
  });

  test('exakt de sex historiska tröskelkonstanterna — ingen sjunde', () => {
    // Hela uppsättningen låses, inte bara distansnamnen: en C13-grind kan lika
    // gärna smygas in som t.ex. RETRO_MAX_DISTANCE eller MAX_LAG_MS.
    const konstanter = (body.match(/const ([A-Z][A-Z0-9_]{3,})\s*=/g) || [])
      .map((s) => s.replace(/^const\s+/, '').replace(/\s*=$/, ''))
      .sort();
    expect(konstanter).toEqual([
      'FALLBACK_HARD_MAX_DISTANCE',
      'FALLBACK_LOW_SOG_MAX_DISTANCE',
      'FALLBACK_TIME_SINCE_PASSAGE_MAX_S',
      'INFERRED_FLUSH_MAX_POSITION_AGE_MS',
      'INFERRED_FLUSH_SANITY_MAX_M',
      'SOG_MOTION_THRESHOLD',
    ]);
    expect(body).toContain('FALLBACK_HARD_MAX_DISTANCE = 2000');
    expect(body).toContain('FALLBACK_LOW_SOG_MAX_DISTANCE = 500');
    expect(body).toContain('INFERRED_FLUSH_SANITY_MAX_M = 10000');
  });

  test('C13-verdiktet är dokumenterat i grenen (så det inte återuppfinns)', () => {
    expect(body).toContain('C13/U7');
    expect(body).toContain('MEDVETET INTE INFÖRD');
  });
});
