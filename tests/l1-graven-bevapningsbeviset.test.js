'use strict';

/**
 * L1 (helkodsgranskning RUNDA 3, 2026-08-22, major) — GRAVEN BAR INTE
 * BEVÄPNINGSBEVISET. Fältlist-fällans 13:e offer, gravvarianten.
 *
 * MEKANISMEN. J22 kopplade in `hasArmingMovementEvidence()` i öppningsmotorns
 * `_canArm`. Predikatet är `_hasCorroboratedMovement ELLER
 * _plausibleMovementSeen`. Gravens fältlista i `_buryVessel` bar bara den
 * FÖRSTA halvan, och `_applyGraveInheritance` återställde bara den — trots att
 * removal-snapshotten redan bar `_plausibleMovementSeen`. En återfödd båt
 * kunde därför inte beväpnas förrän ett HELT NYTT plausibelt sampel kom.
 *
 * VARFÖR DET BLEV PERMANENT för den fartgivarlösa klassen: det ÄRVDA
 * `_hasMovementProof` stänger positionsgrenen i `_updateMooringEvidence`
 * (hela blocket ligger inne i `if (!vessel._hasMovementProof)`), och den
 * grenen är enda vägen till `_hasCorroboratedMovement` för ett fartyg som
 * aldrig rapporterar fart — C6-blocket kräver finit sog. Efter ett enda
 * 4,2 kn-sampel, sedan sog=null, timeout och återfödelse var beväpningen
 * alltså avstängd för resten av båtens liv: `bridge_opening_soon` uteblev
 * HELT för hennes målbro.
 *
 * FIXEN. Både `_plausibleMovementSeen` och C6:s hysteres-räknare
 * `_corroboratedMovementPending` ligger nu i graven och ärvs ADDITIVT (OR),
 * precis som grannbevisen. Grinden kan bara TA BORT armar, aldrig skapa
 * falska — fixen adderar bevis och kan därför bara ge FLER armar.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { VESSEL_GRAVE, MOORING_DETECTION, TIMEOUT_SETTINGS } = require('../lib/constants');

// ~460 m söder om Klaffbron (58.284096, 12.283930): utanför 300 m-skyddszonen,
// så timeout-raderingen inte skjuts upp, men långt inom gravens 200 m-radie
// mätt mot återfödelsepositionen.
const POS = { lat: 58.27995, lon: 12.28393 };

function makeLogger() {
  return {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };
}

describe('L1: beväpningsbeviset överlever graven', () => {
  let svc;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-22T08:00:00.000Z'));
    logger = makeLogger();
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = { gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null };
    // Eliminationsvägen hör inte hit — den här filen provar graven.
    svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  /**
   * Ett AIS-meddelande genom den RIKTIGA ingången (updateVessel) plus samma
   * cleanup-schemaläggning som app.js gör efter varje uppdatering (app.js:3605
   * → vesselDataService.scheduleCleanup med ProximityService-timeouten).
   * FAR_DISTANCE (120 s) är precis den nivå graven finns för: den understiger
   * klass B:s stillaliggarkadens (180 s) och ger kadensglappets felradering.
   */
  function feed(mmsi, sog, dLat = 0) {
    const v = svc.updateVessel(mmsi, {
      mmsi,
      lat: POS.lat + dLat,
      lon: POS.lon,
      sog,
      cog: 20,
      name: 'L1-PROV',
      timestamp: Date.now(),
    });
    svc.scheduleCleanup(mmsi, TIMEOUT_SETTINGS.FAR_DISTANCE);
    return v;
  }

  /** Låter appens EGEN cleanup-timer brinna (120 s + marginal). */
  function waitForTimeoutRemoval(mmsi) {
    jest.advanceTimersByTime(TIMEOUT_SETTINGS.FAR_DISTANCE + 5000);
    return !svc.vessels.has(mmsi);
  }

  test('KÄRNAN: 4,2 kn → sog=null → timeout → återfödelse ⇒ beväpningsbevis kvar', () => {
    const mmsi = '265573131';

    // (1) ETT plausibelt rörelsesampel (4,2 kn ligger över MOVEMENT_PROOF_SOG_KN
    //     och under öppningsmotorns 10 kn-tak ⇒ _plausibleMovementSeen).
    const first = feed(mmsi, 4.2);
    expect(first._plausibleMovementSeen).toBe(true);
    expect(first._hasMovementProof).toBe(true);
    // Ett enda sampel räcker inte till korroborering — bara till hysteresen.
    expect(first._hasCorroboratedMovement).toBe(false);
    expect(first._corroboratedMovementPending).toBe(true);
    expect(svc.hasArmingMovementEvidence(first)).toBe(true);

    // (2) Fartgivaren tystnar (sog saknas i meddelandet). S-F7: informationslöst
    //     sampel rör varken klassning eller C6-kedjan.
    jest.advanceTimersByTime(60 * 1000);
    const second = feed(mmsi, null);
    expect(second._plausibleMovementSeen).toBe(true);
    expect(second._corroboratedMovementPending).toBe(true);

    // (3) TIMEOUT genom appens EGEN cleanup-timer (inte ett direktanrop).
    expect(waitForTimeoutRemoval(mmsi)).toBe(true);
    const grave = svc._vesselGraves.get(mmsi);
    expect(grave).toBeDefined();
    expect(grave.fields._plausibleMovementSeen).toBe(true);
    expect(grave.fields._corroboratedMovementPending).toBe(true);

    // (4) ÅTERFÖDELSEN inom gravens radie, fortfarande utan fartgivare.
    const reborn = feed(mmsi, null, 0.00030); // ~33 m — långt inom 200 m
    expect(reborn._plausibleMovementSeen).toBe(true);
    expect(svc.hasArmingMovementEvidence(reborn)).toBe(true);

    // (5) PERMANENSEN: fler fartgivarlösa sampel ändrar ingenting — utan arvet
    //     hade grinden stått stängd här för resten av båtens liv.
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(60 * 1000);
      feed(mmsi, null, 0.00030 + i * 0.00002);
    }
    expect(svc.hasArmingMovementEvidence(svc.vessels.get(mmsi))).toBe(true);
  });

  test('POSITIONSGRENEN ÄR STÄNGD efter arvet — därför är plausible-halvan enda vägen', () => {
    const mmsi = '265573132';
    // Ärvt _hasMovementProof stänger `if (!vessel._hasMovementProof)`-blocket,
    // som är den fartgivarlösa klassens ENDA väg till _hasCorroboratedMovement
    // (C6-blocket kräver finit sog). Beviset för att grenen är stängd: ett
    // fartyg med bara ärvda bevis och enbart null-sampel når ALDRIG
    // korroborering, hur långt det än rör sig.
    const vessel = {
      mmsi,
      lat: POS.lat,
      lon: POS.lon,
      _hasMovementProof: true,
      _hasCorroboratedMovement: false,
      _corroboratedMovementPending: false,
      _plausibleMovementSeen: false,
      _firstSeenLat: POS.lat,
      _firstSeenLon: POS.lon,
    };
    for (let i = 0; i < 10; i++) {
      vessel.lat = POS.lat + i * 0.002; // ~222 m per steg, långt över 50 m
      svc._updateMooringEvidence(vessel, null);
    }
    expect(vessel._hasCorroboratedMovement).toBe(false);
    expect(svc.hasArmingMovementEvidence(vessel)).toBe(false);
    // …och med den ärvda plausible-halvan på plats är grinden öppen igen.
    vessel._plausibleMovementSeen = true;
    expect(svc.hasArmingMovementEvidence(vessel)).toBe(true);
  });

  test('ARVET ÄR ADDITIVT: graven får aldrig sänka ett bevis objektet redan satt', () => {
    const mmsi = '265573133';
    svc._vesselGraves.set(mmsi, {
      t: Date.now(),
      lat: POS.lat,
      lon: POS.lon,
      fields: {
        _stationarySince: null,
        _mooredReleasePending: 0,
        _nullSogStillAnchorLat: null,
        _nullSogStillAnchorLon: null,
        _nullSogStillAnchorT: null,
        _hasMovementProof: false,
        _hasCorroboratedMovement: false,
        _plausibleMovementSeen: false,
        _corroboratedMovementPending: false,
        _firstSeenLat: null,
        _firstSeenLon: null,
        _trackingEpisodeStartTs: null,
      },
    });
    const vessel = {
      mmsi,
      lat: POS.lat,
      lon: POS.lon,
      _plausibleMovementSeen: true,
      _corroboratedMovementPending: true,
    };
    expect(svc._applyGraveInheritance(mmsi, vessel)).toBe(true);
    expect(vessel._plausibleMovementSeen).toBe(true);
    expect(vessel._corroboratedMovementPending).toBe(true);
  });

  test('HYSTERESEN överlever: halvfärdig korroborering fullbordas av första nya sampel', () => {
    const mmsi = '265573134';
    // Ett rörelsesampel före raderingen (pending), ett efter återfödelsen —
    // C6:s tvåsamplingskrav uppfyllt över gravens gräns.
    feed(mmsi, 4.2);
    expect(svc.vessels.get(mmsi)._corroboratedMovementPending).toBe(true);
    expect(waitForTimeoutRemoval(mmsi)).toBe(true);
    const reborn = feed(mmsi, 4.0, 0.00030);
    expect(reborn._hasCorroboratedMovement).toBe(true);
  });

  test('GRAVENS RADIE + TTL gäller fortfarande — ingen av halvorna smiter förbi dem', () => {
    const mmsiFar = '265573135';
    feed(mmsiFar, 4.2);
    expect(waitForTimeoutRemoval(mmsiFar)).toBe(true);
    // 500 m norrut — bortom MAX_REBIRTH_DIST_M (200 m).
    const far = feed(mmsiFar, null, 500 / 111320);
    expect(far._plausibleMovementSeen).toBe(false);
    expect(svc.hasArmingMovementEvidence(far)).toBe(false);

    const mmsiOld = '265573136';
    feed(mmsiOld, 4.2);
    expect(waitForTimeoutRemoval(mmsiOld)).toBe(true);
    jest.advanceTimersByTime(VESSEL_GRAVE.TTL_MS + 1000);
    const old = feed(mmsiOld, null, 0.00030);
    expect(old._plausibleMovementSeen).toBe(false);
    expect(svc.hasArmingMovementEvidence(old)).toBe(false);
  });

  test('RIMLIGHETSVAKTEN står kvar: ett orimligt sampel ger inget beväpningsbevis via graven', () => {
    const mmsi = '265573137';
    // Över DEADLINE_MAX_SPEED_KN (10 kn) utan positionsstöd ⇒ varken
    // _plausibleMovementSeen eller korroborering. Graven får inte tvätta det.
    feed(mmsi, 13);
    const v = svc.vessels.get(mmsi);
    expect(v._plausibleMovementSeen).toBe(false);
    expect(MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN).toBe(0.5); // härledningens golv
    expect(waitForTimeoutRemoval(mmsi)).toBe(true);
    const grave = svc._vesselGraves.get(mmsi);
    expect(grave.fields._plausibleMovementSeen).toBe(false);
    const reborn = feed(mmsi, null, 0.00030);
    expect(svc.hasArmingMovementEvidence(reborn)).toBe(false);
  });
});
