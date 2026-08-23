'use strict';

jest.mock('homey');

/**
 * N13 (helkodsgranskning RUNDA 5, 2026-08-23) — ÖPPNINGSLAGRETS PRUNE LÄSTE EN
 * ANNAN KLOCKA ÄN GRINDEN, OCH DÖDADE KAJVISTELSEN PÅ EN 60-SEKUNDERSTICK.
 *
 * MEKANISMEN FÖRE FIXEN: M11 införde tvåklocksregeln (stillAt när ett
 * stillasample finns, annars bandSince) i persistensen och laddningen — men
 * PRUNE-blocket i monitoringloopen (_pruneDedupCaches) läste kvar
 * `entry.stillAt` med 0 som reserv. En post som ännu bara hunnit få bandSince
 * fick därför stämpeln 0, alltså "äldre än hela minnesfönstret", och raderades
 * vid FÖRSTA städtick där mmsi:t inte fanns bland aktiva fartyg. Nästa fix
 * skapade en ny post med bandSince = nu ⇒ stayMs 0 ⇒ kajvobbelgrinden
 * (_isBridgeOpeningQuayWobbler) blind i fem minuter. Exakt den blindhet M11
 * byggdes för att stänga, fast utan omstart.
 *
 * PROFILEN SOM UTLÖSER: en kajliggare vars brusprofil aldrig ger ett enda
 * stillasample (varje fix ≥ MOVEMENT_PROOF_SOG_KN och hon är inte klassad
 * _moored) medan hon ligger kvar inne i bandet. Posten har då bandSince men
 * stillAt = 0.
 *
 * TESTET KÖR PRODUKTIONSVÄGARNA: bokföringen byggs av _noteQuayStability och
 * städningen körs av det RIKTIGA _pruneDedupCaches (samma metod
 * monitoringloopen anropar varje minut). Kontrollarmen ersätter ENBART
 * ttlClock-hjälparen med HEAD:s formel — inget annat skiljer armarna åt, så
 * utfallsskillnaden kan bara komma från den raden.
 *
 * MUTATIONSPROV (körs manuellt): låt _openingLedgerTtlClock returnera
 * `Number.isFinite(entry.stillAt) ? entry.stillAt : 0` ⇒ "posten överlever"
 * nedan blir rött. Låt den returnera bandSince även när stillAt är satt ⇒
 * TTL-testet i m11-sviten (post äldre än minnesfönstret) blir rött.
 */

const AISBridgeApp = require('../app');
const {
  BRIDGES, BRIDGE_OPENING, QUAY_DEPARTURE_GATE, MOORING_DETECTION,
} = require('../lib/constants');

const KLAFFBRON = Object.values(BRIDGES).find((b) => b && b.name === 'Klaffbron');
const REAL_DATE_NOW = Date.now;

// 380 m norr om Klaffbron: inne i bokföringsbandet (500 m), utanför alla andra
// bokföringspunkters band.
const QUAY = { lat: KLAFFBRON.lat + 380 / 111320, lon: KLAFFBRON.lon };

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeApp() {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app._quayStableLedger = new Map();
  app._openingQuayLedger = new Map();
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._firedOpeningEvents = new Map();
  // Inga aktiva fartyg = städningens förutsättning (hon har timeout-tagits bort
  // ur fartygskartan men bokföringen ska överleva minnesfönstret ut).
  app.vesselDataService = { getAllVessels: () => [] };
  return app;
}

/** Ett fix i bandet UTAN stillasample: sog över rörelsebeviströskeln. */
const movingSample = (ts, sog = 1.4) => ({
  mmsi: '265999111',
  lat: QUAY.lat,
  lon: QUAY.lon,
  sog,
  cog: 12.0,
  timestamp: ts,
  fixTs: ts,
  fixFeed: 'aisstream',
  targetBridge: 'Klaffbron',
});

const stillSample = (ts) => ({ ...movingSample(ts, 0.2) });

describe('N13: ttlClock-hjälparen är EN sanning', () => {
  test('stillAt vinner när den är finit och > 0, annars bandSince', () => {
    const app = makeApp();
    expect(app._openingLedgerTtlClock({ stillAt: 500, bandSince: 100 })).toBe(500);
    expect(app._openingLedgerTtlClock({ stillAt: 0, bandSince: 100 })).toBe(100);
    expect(app._openingLedgerTtlClock({ bandSince: 100 })).toBe(100);
    expect(app._openingLedgerTtlClock({ stillAt: NaN, bandSince: 100 })).toBe(100);
    // Ingen klocka alls ⇒ 0 (posten är utgången per definition).
    expect(app._openingLedgerTtlClock({})).toBe(0);
    expect(app._openingLedgerTtlClock(null)).toBe(0);
  });

  test('rörelsebeviströskeln gör profilen möjlig (dokumenterar utlösaren)', () => {
    expect(MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN).toBe(0.5);
    expect(QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN).toBe(1.0);
  });
});

describe('N13: en monitoringtick under glappet får inte döda kajvistelsen', () => {
  let now;

  beforeEach(() => {
    jest.clearAllMocks();
    now = new Date(2026, 7, 6, 3, 0, 0).getTime();
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  /** 40 min i bandet, ENBART rörelsefixar ⇒ posten har bandSince men stillAt 0. */
  const buildBandOnlyStay = (app) => {
    for (let i = 0; i < 8; i++) {
      app._noteQuayStability(movingSample(now));
      now += 5 * 60 * 1000;
    }
    const entry = app._openingQuayLedger.get('265999111');
    expect(entry).toBeTruthy();
    expect(entry.stillAt).toBe(0);
    expect(entry.bandSince).toBeLessThan(Date.now() - BRIDGE_OPENING.QUAY_STAY_MIN_MS);
    return entry.bandSince;
  };

  test('FIXEN: posten överlever städningen och grinden håller vid avgången', () => {
    const app = makeApp();
    const bandSince = buildBandOnlyStay(app);

    app._pruneDedupCaches(); // monitoringloopens tick, inga aktiva fartyg

    const entry = app._openingQuayLedger.get('265999111');
    expect(entry).toBeTruthy();
    expect(entry.bandSince).toBe(bandSince);

    // Hon lägger sig still ett ögonblick och gör sedan sin avgång: vistelsen är
    // fortfarande 40+ min, så grinden kräver korroborering.
    now += 60 * 1000;
    app._noteQuayStability(stillSample(now));
    now += 60 * 1000;
    const departure = movingSample(now, 1.2);
    app._noteQuayStability(departure);
    expect(app._isBridgeOpeningQuayWobbler(departure)).toBe(true);
  });

  test('KONTROLLEN (HEAD:s formel): samma ström raderar posten ⇒ grinden släpper', () => {
    const app = makeApp();
    buildBandOnlyStay(app);
    // ENDA skillnaden mot armen ovan: prunens klocka är HEAD:s.
    app._openingLedgerTtlClock = (e) => (e && Number.isFinite(e.stillAt) ? e.stillAt : 0);

    app._pruneDedupCaches();

    expect(app._openingQuayLedger.has('265999111')).toBe(false);

    now += 60 * 1000;
    app._noteQuayStability(stillSample(now));
    now += 60 * 1000;
    const departure = movingSample(now, 1.2);
    app._noteQuayStability(departure);
    // Ny post ⇒ stayMs ≈ 1 min < QUAY_STAY_MIN_MS ⇒ ingen grindkraft alls.
    expect(app._isBridgeOpeningQuayWobbler(departure)).toBe(false);
  });

  test('EN ÄKTA UTGÅNGEN POST släpps fortfarande (fixen är ingen läcka)', () => {
    const app = makeApp();
    buildBandOnlyStay(app);
    now += QUAY_DEPARTURE_GATE.MEMORY_MS + 60 * 1000;

    app._pruneDedupCaches();

    expect(app._openingQuayLedger.has('265999111')).toBe(false);
  });

  test('AKTIVT FARTYG städas aldrig, oavsett klocka (oförändrat villkor)', () => {
    const app = makeApp();
    buildBandOnlyStay(app);
    app.vesselDataService = { getAllVessels: () => [{ mmsi: '265999111' }] };
    now += QUAY_DEPARTURE_GATE.MEMORY_MS + 60 * 1000;

    app._pruneDedupCaches();

    expect(app._openingQuayLedger.has('265999111')).toBe(true);
  });

  test('V1-KARTAN RÖRS INTE av fixen (egen klocka, egna poster)', () => {
    const app = makeApp();
    app._quayStableLedger.set('265999111', {
      stillAt: 0, lat: QUAY.lat, lon: QUAY.lon, movingFixes: 0,
    });

    app._pruneDedupCaches();

    // V1-posten saknar bandSince och prunas på stillAt=0 precis som förut.
    expect(app._quayStableLedger.has('265999111')).toBe(false);
  });
});
