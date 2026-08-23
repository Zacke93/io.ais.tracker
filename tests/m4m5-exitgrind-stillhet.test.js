'use strict';

jest.mock('homey');

/**
 * M4 + M5 (helkodsgranskning RUNDA 4, 2026-08-23) — EXITGRINDENS STILLHETS-
 * PRÖVNING: FEL KLOCKDOMÄN, OCH INLÅST BAKOM HALVA VILLKORET.
 *
 * M4 (regression införd i L2:s egen nya kod, commit 2da45ed): `stillForMs`
 * räknades som `Date.now() - vessel._stationarySince`. `Date.now()` är
 * REMOVAL-ögonblicket medan `_stationarySince` stämplas vid sista POSITIONEN —
 * hela rensningstimeouten (10–20 min i exit-bandet) ligger emellan. Tystnaden
 * ENSAM översteg alltså tröskeln EXIT_STILLNESS_MIN_MS (155,5 s), som
 * härleddes som OBSERVERAD stillhet, och villkoret degenererade till
 * "_stationarySince är finit över huvud taget". Fail-open-löftet ("kortare
 * stillhet lämnas orörd") var onåbart. Måttet läser nu POSITIONSKLOCKAN
 * (_lastConfirmedPositionMs), samma klocka F63-grinden 140 rader upp använder.
 *
 * M5 ÄR ÅTERTAGEN (dirigentbeslut, fixrunda 4b 2026-08-23) och står kvar som
 * ÖPPEN DESIGNFRÅGA. Runda 4 lyfte prövningen UT ur `if (!exitSpeedKnown)` för
 * att också fånga kajliggare med brusig fartgivare (VIRGO/CAPELLA-klassen), med
 * nettot från `_stillnessAnchor` som diskriminator. Den halvan var INERT BY
 * CONSTRUCTION: det enda objekt grinden någonsin får är REMOVAL-SNAPSHOTTEN,
 * och snapshotten bär `_stationarySince` men INTE `_stillnessAnchor` — nettot
 * var alltid null och skippet togs aldrig (uppmätt: noll rörelse i samtliga 18
 * korpusar). M1 i samma leverans hade dessutom bytt ankarets betydelse (det
 * beskriver numera VISTELSENS ålder, inte klockans), så att bära in fältet
 * hade aktiverat en gren med annan innebörd än den som prövades.
 *
 * OLÖST FRÅGA FÖRE ÅTERINFÖRANDE: ska en ÄKTA avgång som lägger ut i ~1,2 kn
 * och tystnar INOM 50 m från ankaret tystas eller ge notis? Kraven "skippa vid
 * netto < MOVEMENT_PROOF_NET_M" och "den avgången ska ge notis" kan inte båda
 * hålla. Beslut + ON/OFF-mätning krävs innan `_stillnessAnchor` bärs in i
 * snapshotten (fältlist-fällan: _createVesselObject + snapshotten + graven).
 * Se docs/ARCHITECTURE.md §9.
 *
 * SVITEN LÅSER DÄRFÖR TVÅ SAKER OM M5: att snapshotten bevisligen inte bär
 * ankaret (grunden för "inert by construction"), och att fart-känd-halvan
 * följer L2:s kontrakt — H19-raden ovanför äger beslutet och stillhetsklockan
 * konsulteras inte. Skulle någon återinföra M5 utan mätning faller de testerna.
 *
 * MUTATIONSPROV (körs manuellt): byt tillbaka till `Date.now() - stillSince`
 * ⇒ M4-testerna faller. Lyft prövningen ur `if (!exitSpeedKnown)` igen ⇒
 * CAPELLA-testet och fart-känd-testet faller.
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { TRIGGER_POINTS, MOORING_DETECTION, PASSAGE_TIMING } = require('../lib/constants');

const KANAL = TRIGGER_POINTS.kanalinfarten;
const REAL_DATE_NOW = Date.now;
const M_PER_DEG_LAT = 111320;

// Samma härledning som produktionskoden: 40 m jitterradie / (0,5 kn i m/s).
const EXIT_STILLNESS_MIN_MS = Math.round(
  (MOORING_DETECTION.NULL_SOG_STILL_RADIUS_M / (PASSAGE_TIMING.MINIMUM_VIABLE_SPEED * 0.5144)) * 1000,
);

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

const northOfKanal = (meters) => ({
  lat: KANAL.lat + meters / M_PER_DEG_LAT,
  lon: KANAL.lon,
});

function makeExitApp() {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
  return app;
}

const skippedStationary = (app) => app.debug.mock.calls
  .some((c) => String(c[0]).includes('EXIT_TRIGGER_SKIP_STATIONARY'));

describe('M4 + M5 genom riktig pipeline', () => {
  let svc;
  let mockNow;
  let snapshots;

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 7, 23, 9, 0, 0).getTime();
    Date.now = () => mockNow;
    const logger = makeLogger();
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    snapshots = [];
    svc.on('vessel:removed', (payload) => snapshots.push(payload));
  });

  afterEach(() => {
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
    delete global.__TEST_MODE__;
    Date.now = REAL_DATE_NOW;
  });

  const tick = (minutes) => {
    mockNow += minutes * 60 * 1000;
  };

  /** Nio sydgående sampel (rörelsebeviset) + stillhet inom några meter. */
  const approachThenRest = (mmsi, { sog, stillMinutes, restSamples = 6 }) => {
    for (let i = 0; i < 9; i++) {
      const pos = northOfKanal(1200 - i * 100);
      svc.updateVessel(mmsi, {
        lat: pos.lat, lon: pos.lon, sog, cog: 205, shipName: 'EXITGRINDEN',
      });
      tick(2);
    }
    const rest = northOfKanal(320);
    for (let i = 0; i < restSamples; i++) {
      svc.updateVessel(mmsi, {
        lat: rest.lat + ((i % 2 === 0 ? 2 : -2) / M_PER_DEG_LAT),
        lon: rest.lon,
        sog,
        cog: 205,
        shipName: 'EXITGRINDEN',
      });
      tick(stillMinutes / restSamples);
    }
  };

  const removalSnapshot = (mmsi) => {
    svc.removeVessel(mmsi, 'timeout');
    const hit = snapshots.find((s) => s.mmsi === mmsi);
    return hit ? hit.vessel : null;
  };

  // ===========================================================================
  // M4 — KLOCKDOMÄNEN
  // ===========================================================================
  test('M4: KORT stillhet + 12 min rensningstid ⇒ notisen fyrar (fail-open lever)', async () => {
    const mmsi = '265900040';
    approachThenRest(mmsi, { sog: null, stillMinutes: 2 });
    const snap = removalSnapshot(mmsi);
    expect(Number.isFinite(snap._stationarySince)).toBe(true);

    // KÄRNAN I REGRESSIONEN: rensningstimeouten mellan sista position och
    // removal. Före fixen räknades den som STILLHET (2 min + 12 min ≥ 155,5 s
    // ⇒ falskt skip); nu mäts bara den observerade stillheten.
    tick(12);
    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    expect(Date.now() - snap._stationarySince).toBeGreaterThan(EXIT_STILLNESS_MIN_MS);
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
    expect(skippedStationary(app)).toBe(false);
  });

  test('M4: LÅNG stillhet fäller fortfarande efter samma 12 min', async () => {
    const mmsi = '265900041';
    approachThenRest(mmsi, { sog: null, stillMinutes: 18 });
    const snap = removalSnapshot(mmsi);
    tick(12);

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(skippedStationary(app)).toBe(true);
  });

  test('M4: KLÄMNINGEN — ankartid efter positionsstämpeln ger 0, aldrig negativt', async () => {
    const mmsi = '265900042';
    approachThenRest(mmsi, { sog: null, stillMinutes: 18 });
    const snap = removalSnapshot(mmsi);
    // Konstruerad klockinversion (kan uppstå vid källbyte/klockjustering).
    snap._stationarySince = Math.max(snap.timestamp, snap.lastPositionUpdate) + 60 * 1000;

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
  });

  // ===========================================================================
  // M5 — ÅTERTAGEN: fart-känd-halvan prövar INTE stillhetsklockan
  // ===========================================================================
  test('M5 ÅTERTAGEN: CAPELLA-klassen — brusig givare + brusprov 0,8 kn ⇒ notisen FYRAR (öppen designfråga)', async () => {
    const mmsi = '265900043';
    // PROFILEN ÄR CARAT/VIRGO:s (M1/C9b): timmar på samma plats, men en
    // fartgivare som brusar över MOVEMENT_PROOF_SOG_KN med jämna mellanrum.
    // Bruset håller henne UTANFÖR förtöjningsklassen (grinden ovanför får
    // inte vara den som fäller — då hade testet mätt fel sak), medan C9b:s
    // jitterhåll behåller stillhetsklockan. Fönstret 35–115 min är valt av
    // pipelinen själv: under 30 min håller inte jittergrinden (ankarålder),
    // över 120 min latchar 2h-backstoppen _moored.
    for (let i = 0; i < 9; i++) {
      const pos = northOfKanal(1200 - i * 100);
      svc.updateVessel(mmsi, {
        lat: pos.lat, lon: pos.lon, sog: 4.0, cog: 205, shipName: 'CAPELLA-KLASSEN',
      });
      tick(2);
    }
    const rest = northOfKanal(320);
    for (let i = 0; i < 12; i++) {
      svc.updateVessel(mmsi, {
        lat: rest.lat + ((i % 2 === 0 ? 1.5 : -1.5) / M_PER_DEG_LAT),
        lon: rest.lon,
        sog: (i > 0 && i % 6 === 0) ? 0.8 : 0.1,
        cog: 205,
        shipName: 'CAPELLA-KLASSEN',
      });
      tick(5);
    }
    const live = svc.vessels.get(mmsi);
    // Det LEVANDE fartyget bär ankaret...
    expect(live._stillnessAnchor).toBeTruthy();
    expect(live._moored).toBe(false);
    // Sista samplet: ETT brusprov över MIN_VIABLE_SPEED_KN, samma position.
    svc.updateVessel(mmsi, {
      lat: rest.lat, lon: rest.lon, sog: 0.8, cog: 205, shipName: 'CAPELLA-KLASSEN',
    });
    const snap = removalSnapshot(mmsi);
    expect(snap._moored).toBe(false);
    expect(snap.sog).toBe(0.8);
    // Fart KÄND och över H19-tröskeln ⇒ raden ovanför släpper henne vidare.
    expect(snap.sog).toBeGreaterThanOrEqual(PASSAGE_TIMING.MINIMUM_VIABLE_SPEED);
    expect(Number.isFinite(snap._stationarySince)).toBe(true);
    // ...men SNAPSHOTTEN gör det INTE. Det är hela grunden för att M5 var
    // inert: diskriminatorn kunde aldrig mätas på det objekt grinden får.
    expect(snap._stillnessAnchor).toBeUndefined();

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    // DAGENS DOKUMENTERADE BETEENDE (öppen designfråga): fart känd ⇒ H19-raden
    // äger beslutet, stillhetsklockan konsulteras inte, notisen fyrar. Blir
    // frågan avgjord till M5:s fördel ska DEN HÄR raden vändas — medvetet, med
    // ON/OFF-mätning — inte tyst.
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
    expect(skippedStationary(app)).toBe(false);
  });

  test('M5 ÅTERTAGEN: fart känd + 40 min bevisad positionsstillhet ⇒ notisen fyrar ändå', async () => {
    // REGRESSIONSLÅS. Skulle någon lyfta prövningen ur `if (!exitSpeedKnown)`
    // igen faller den här raden — och den ska bara falla tillsammans med ett
    // dokumenterat beslut i docs/ARCHITECTURE.md §9 plus en ON/OFF-mätning.
    const mmsi = '265900045';
    approachThenRest(mmsi, { sog: null, stillMinutes: 40 });
    const snap = removalSnapshot(mmsi);
    snap.sog = 0.8; // brusprov över MIN_VIABLE_SPEED_KN
    expect(Number.isFinite(snap._stationarySince)).toBe(true);
    expect(Date.now() - snap._stationarySince).toBeGreaterThan(EXIT_STILLNESS_MIN_MS);

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
    expect(skippedStationary(app)).toBe(false);
  });

  test('M5 ÅTERTAGEN: ett ankare i snapshotten ändrar INGENTING i dag', async () => {
    // Om A-VDS en dag bär in fältet får det inte tyst aktivera en borttagen
    // gren. Här injiceras ankaret för hand med netto 0 m (kajliggarprofilen) —
    // utfallet ska vara identiskt med testet ovan tills beslutet är fattat.
    const mmsi = '265900044';
    approachThenRest(mmsi, { sog: null, stillMinutes: 40 });
    const snap = removalSnapshot(mmsi);
    snap.sog = 1.2;
    snap._stillnessAnchor = { lat: snap.lat, lon: snap.lon, t: snap._stationarySince };

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
    expect(MOORING_DETECTION.MOVEMENT_PROOF_NET_M).toBe(50);
  });

  test('L2-KONTRAKTET STÅR: fartgivarlös + 40 min stilla ⇒ skip UTAN ankare', async () => {
    const mmsi = '265900046';
    approachThenRest(mmsi, { sog: null, stillMinutes: 40 });
    const snap = removalSnapshot(mmsi);
    expect(snap.sog).toBeNull();

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(skippedStationary(app)).toBe(true);
  });

  test('H19-KONTRAKTET STÅR: finit 0,2 kn i sista samplet fäller som förut', async () => {
    const mmsi = '265900047';
    approachThenRest(mmsi, { sog: null, stillMinutes: 4 });
    const snap = removalSnapshot(mmsi);
    snap.sog = 0.2;

    const app = makeExitApp();
    await app._triggerExitPointFallback(snap);

    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(skippedStationary(app)).toBe(true);
  });
});
