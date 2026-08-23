'use strict';

jest.mock('homey');

/**
 * M2 (helkodsgranskning RUNDA 4, 2026-08-23) — KAJGRINDENS ENKELSAMPEL-
 * UNDANTAG SLÄPPTES AV ETT BRUSIGT SOG-VÄRDE.
 *
 * MEKANISMEN FÖRE FIXEN: _isBridgeOpeningQuayWobbler kortslöt på ett RÅTT
 * `vessel.sog >= BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN` (3,13 kn) FÖRE både
 * kajvistelsekravet (QUAY_STAY_MIN_MS) och _quayDepartureNeedsProof. Ett enda
 * brusigt fartvärde öppnade alltså hela skyddet.
 *
 * RÅDATAFALLET (korpus 20260804-both-21h): CARAT (211452170) låg kajstilla
 * ~415 m norr om Klaffbron och rapporterade 2026-08-05T03:54:04Z ETT sampel på
 * 7,4 kn. Positionen hade då flyttat sig 52,2 m sedan föregående fix 69 s
 * tidigare — implicerat 1,47 knop. Följden blev en bridge_opening_soon på
 * 384 m, 2 h 58 min före hennes verkliga passage 06:52:36.
 *
 * FIXEN: den delade modulen lib/utils/quayTransitProof.js prövar det ensamma
 * fartvärdet mot fartygets EGEN förflyttning. Modulen är FAIL-OPEN — saknas
 * föregående fix, är den äldre än MAX_PREV_FIX_AGE_MS, eller går dt/geometri
 * inte att mäta behålls kortslutningen. Det ledet är lika viktigt som det
 * första: 265726650 (2026-07-02) fick sin ÄKTA varning på ETT sampel över
 * tröskeln, med 70 minuters glapp och 14 m netto.
 *
 * SVITEN KÖR GENOM RIKTIG PIPELINE: kajhistoriken byggs av produktionens egen
 * _noteQuayStability (som i sin tur bokför via _noteQuayLedgerEntry), och
 * grinden frågas via den riktiga _isBridgeOpeningQuayWobbler.
 *
 * MUTATIONSPROV (körs manuellt): flytta tillbaka kortslutningen så den blir
 * ovillkorlig — `if (Number.isFinite(vessel.sog) && vessel.sog >= TRÖSKELN)
 * return false;` — och CARAT-fallet nedan blir false (beväpning tillåten).
 * Sätt i stället MAX_PREV_FIX_AGE_MS till ett dygn och 70-minutersfallet
 * (265726650-klassen) blir true, dvs. den äkta varningen dör.
 */

const AISBridgeApp = require('../app');
const {
  BRIDGES, BRIDGE_OPENING, QUAY_DEPARTURE_GATE, TARGET_BRIDGES,
} = require('../lib/constants');
const {
  isCorroboratedTransit, explainTransitCorroboration, MAX_PREV_FIX_AGE_MS, MISMATCH_FACTOR,
} = require('../lib/utils/quayTransitProof');

const KLAFFBRON = Object.values(BRIDGES).find((b) => b && b.name === 'Klaffbron');
const REAL_DATE_NOW = Date.now;

// CARAT-geometrin ur korpus 20260804-both-21h (rådata, oförändrad).
const CARAT_QUAY = { lat: 58.28769, lon: 12.28584 }; // 415,0 m från Klaffbron
const CARAT_STILL = { lat: 58.28766, lon: 12.28583 }; // 411,6 m — sog 0,4
const CARAT_NOISE = { lat: 58.2875, lon: 12.28499 }; // 383,6 m — sog 7,4 (bruset)

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeApp() {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app._quayStableLedger = new Map();
  app._openingQuayLedger = new Map();
  return app;
}

/** Ett positionsmeddelande som produktionens bokföring kan svälja. */
const sample = (pos, sog, ts) => ({
  mmsi: '211452170',
  lat: pos.lat,
  lon: pos.lon,
  sog,
  cog: 250.6,
  timestamp: ts,
  fixTs: ts,
  fixFeed: 'aishub',
  targetBridge: 'Klaffbron',
});

describe('M2 (a): den delade modulen quayTransitProof', () => {
  test('CARAT-bruset: 7,4 kn men 52,2 m på 69 s ⇒ INTE korroborerat', () => {
    const detail = explainTransitCorroboration({
      sogKn: 7.4,
      prevFix: {
        lat: CARAT_STILL.lat, lon: CARAT_STILL.lon, ts: 1785901975448, fixTs: 1785901918000, feed: 'aishub',
      },
      curFix: {
        lat: CARAT_NOISE.lat, lon: CARAT_NOISE.lon, ts: 1785902044372, fixTs: 1785902040000, feed: 'aishub',
      },
    });
    expect(detail.corroborated).toBe(false);
    expect(detail.reason).toBe('speed_uncorroborated');
    // Rådatan: 52,2 m på 68,9 s ⇒ 1,47 kn implicerat (kvot 5,0 mot 7,4).
    expect(Math.round(detail.netM)).toBe(52);
    expect(detail.impliedKn).toBeCloseTo(1.47, 1);
    // ÅLDERN mäts på den STÖRSTA separationen (fixklockan, 122 s) och FARTEN
    // på den MINSTA (mottagningsklockan, 68,9 s) — båda valen är fail-open.
    expect(detail.prevAgeMs).toBe(122000);
    expect(detail.dtMs).toBe(68924);
  });

  test('265726650-klassen: föregående fix 70 min gammal ⇒ kortslutningen BEHÅLLS', () => {
    const now = 1785902044372;
    const detail = explainTransitCorroboration({
      sogKn: 3.8,
      // 14 m netto — hade fällts direkt om åldern inte prövades först.
      prevFix: {
        lat: CARAT_QUAY.lat, lon: CARAT_QUAY.lon, ts: now - 70 * 60 * 1000, fixTs: now - 70 * 60 * 1000, feed: 'aishub',
      },
      curFix: {
        lat: CARAT_QUAY.lat + 14 / 111320, lon: CARAT_QUAY.lon, ts: now, fixTs: now, feed: 'aishub',
      },
    });
    expect(detail.corroborated).toBe(true);
    expect(detail.reason).toBe('prev_fix_stale');
    expect(detail.prevAgeMs).toBeGreaterThan(MAX_PREV_FIX_AGE_MS);
  });

  test('ÄKTA AVGÅNG: 7,4 kn och 260 m på 69 s ⇒ korroborerat', () => {
    const now = 1785902044372;
    expect(isCorroboratedTransit({
      sogKn: 7.4,
      prevFix: {
        lat: CARAT_QUAY.lat, lon: CARAT_QUAY.lon, ts: now - 69000, fixTs: now - 69000, feed: 'aishub',
      },
      curFix: {
        lat: CARAT_QUAY.lat - 260 / 111320, lon: CARAT_QUAY.lon, ts: now, fixTs: now, feed: 'aishub',
      },
    })).toBe(true);
  });

  test('FAIL-OPEN: saknad föregående fix, omätbar dt och saknad geometri ⇒ true', () => {
    const now = 1785902044372;
    const cur = {
      lat: CARAT_NOISE.lat, lon: CARAT_NOISE.lon, ts: now, fixTs: now, feed: 'aishub',
    };
    expect(explainTransitCorroboration({ sogKn: 7.4, prevFix: null, curFix: cur }).reason).toBe('no_prev_fix');
    // Identisk tidsstämpel i BÅDA domänerna = ingen positiv separation.
    expect(explainTransitCorroboration({
      sogKn: 7.4,
      prevFix: {
        lat: CARAT_STILL.lat, lon: CARAT_STILL.lon, ts: now, fixTs: now, feed: 'aishub',
      },
      curFix: cur,
    }).reason).toBe('no_dt');
    expect(explainTransitCorroboration({
      sogKn: 7.4,
      prevFix: {
        lat: null, lon: null, ts: now - 60000, fixTs: now - 60000, feed: 'aishub',
      },
      curFix: cur,
    }).reason).toBe('no_geometry');
    expect(isCorroboratedTransit({ sogKn: 7.4, prevFix: null, curFix: cur })).toBe(true);
  });

  test('KORSKÄLLA: fixklockan används inte över källgränsen (GPSJumpAnalyzer-regeln)', () => {
    const now = 1785902044372;
    const detail = explainTransitCorroboration({
      sogKn: 7.4,
      prevFix: {
        lat: CARAT_STILL.lat, lon: CARAT_STILL.lon, ts: now - 69000, fixTs: now - 200000, feed: 'aisstream',
      },
      curFix: {
        lat: CARAT_NOISE.lat, lon: CARAT_NOISE.lon, ts: now, fixTs: now, feed: 'aishub',
      },
    });
    // Bara mottagningsklockan får bidra ⇒ både ålder och dt = 69 s.
    expect(detail.prevAgeMs).toBe(69000);
    expect(detail.dtMs).toBe(69000);
  });

  test('KONSTANTERNA ÄR EXPORTERADE (grindfilen får aldrig hårdkoda en kopia)', () => {
    expect(MAX_PREV_FIX_AGE_MS).toBe(4 * 60 * 1000);
    expect(MISMATCH_FACTOR).toBe(4);
  });
});

describe('M2 (b): grinden genom riktig pipeline', () => {
  let now;

  beforeEach(() => {
    jest.clearAllMocks();
    now = new Date(2026, 7, 5, 3, 40, 0).getTime();
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  /** Bygger CARAT:s kajvistelse med produktionens egen bokföring. */
  const buildQuayStay = (app, { stayMinutes = 40 } = {}) => {
    const step = (stayMinutes * 60 * 1000) / 8;
    for (let i = 0; i < 8; i++) {
      app._noteQuayStability(sample(CARAT_QUAY, 0.2, now));
      now += step;
    }
  };

  test('FÄLTFALLET: ETT brusprov på 7,4 kn efter 69 s / 52 m ⇒ INGEN beväpning', () => {
    const app = makeApp();
    buildQuayStay(app);
    // Sista stillasamplet (rådatans 0,4 kn) och därefter bruset 69 s senare.
    app._noteQuayStability(sample(CARAT_STILL, 0.4, now));
    now += 68924;
    const noise = sample(CARAT_NOISE, 7.4, now);
    app._noteQuayStability(noise);

    expect(app._isBridgeOpeningQuayWobbler(noise)).toBe(true);
    expect(app.debug.mock.calls.some(
      (c) => String(c[0]).includes('OPENING_QUAY_SOG_UNCORROBORATED'),
    )).toBe(true);
  });

  test('KORTSLUTNINGEN LEVER: samma sampel efter 70 minuters tystnad ⇒ beväpning tillåts', () => {
    const app = makeApp();
    buildQuayStay(app);
    app._noteQuayStability(sample(CARAT_STILL, 0.4, now));
    now += 70 * 60 * 1000;
    const lone = sample(CARAT_NOISE, 7.4, now);
    app._noteQuayStability(lone);

    expect(app._isBridgeOpeningQuayWobbler(lone)).toBe(false);
  });

  test('ÄKTA AVGÅNG: 7,4 kn med 260 m förflyttning på 69 s ⇒ beväpning tillåts', () => {
    const app = makeApp();
    buildQuayStay(app);
    app._noteQuayStability(sample(CARAT_STILL, 0.4, now));
    now += 68924;
    const moved = sample(
      { lat: CARAT_QUAY.lat - 260 / 111320, lon: CARAT_QUAY.lon },
      7.4,
      now,
    );
    app._noteQuayStability(moved);

    expect(app._isBridgeOpeningQuayWobbler(moved)).toBe(false);
  });

  test('UNDER TRÖSKELN: kortslutningen prövas aldrig (AKIRA-klassens 1,1 kn)', () => {
    const app = makeApp();
    buildQuayStay(app);
    now += 60000;
    const wobble = sample(CARAT_NOISE, 1.1, now);
    app._noteQuayStability(wobble);

    expect(wobble.sog).toBeLessThan(BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN);
    expect(app._isBridgeOpeningQuayWobbler(wobble)).toBe(true);
    // Ingen korroboreringsrad — grenen nåddes inte.
    expect(app.debug.mock.calls.some(
      (c) => String(c[0]).includes('OPENING_QUAY_SOG_UNCORROBORATED'),
    )).toBe(false);
  });

  test('ÖVERLEVNADSTEST: bokföringen bär prevFix/lastFix och skiftar dem per fix', () => {
    const app = makeApp();
    buildQuayStay(app, { stayMinutes: 8 });
    const entry = app._openingQuayLedger.get('211452170');
    expect(entry.lastFix).toMatchObject({ lat: CARAT_QUAY.lat, feed: 'aishub' });
    expect(entry.prevFix).toMatchObject({ lat: CARAT_QUAY.lat, feed: 'aishub' });

    now += 60000;
    app._noteQuayStability(sample(CARAT_NOISE, 0.3, now));
    const shifted = app._openingQuayLedger.get('211452170');
    expect(shifted.prevFix.lat).toBe(CARAT_QUAY.lat);
    expect(shifted.lastFix.lat).toBe(CARAT_NOISE.lat);
    expect(shifted.lastFix.ts).toBe(now);
  });

  test('GEOGRAFIN: öppningslagret bokför målbroarna (V1-kartan gör det inte)', () => {
    const app = makeApp();
    buildQuayStay(app, { stayMinutes: 8 });
    expect(app._openingQuayLedger.has('211452170')).toBe(true);
    // Klaffbron ligger 1982 m från Kanalinfarten ⇒ V1-kartan är tom här.
    expect(app._quayStableLedger.has('211452170')).toBe(false);
    expect(TARGET_BRIDGES).toContain('Klaffbron');
    expect(QUAY_DEPARTURE_GATE.LEDGER_RADIUS_M).toBe(500);
    expect(KLAFFBRON).toBeTruthy();
  });
});
