'use strict';

jest.mock('homey');

/**
 * J22 (helkodsgranskning RUNDA 2, 2026-08-22) — C6:s beväpningsbevis
 * `hasArmingMovementEvidence` hade NOLL konsumenter: en MÄTT grind som ingen
 * frågade.
 *
 * MEKANISMEN FÖRE FIXEN: predikatet infördes i etapp 7 fas C för att stoppa
 * enkelsampelsfantomer i öppningsmotorn, och dess docblock säger att just
 * öppningsbeväpningen ska kräva det. Men BridgeOpeningService._canArm gatade
 * bara på `_hasMovementProof` (ett ENDA sampel räcker), och konstruktorn
 * injicerade ingen bevisfunktion. Svep över app.js, lib och drivers gav noll
 * anropare utanför definitionsfilen och C6-sviten.
 *
 * FELUTFALLET (rådataverifierat 2026-08-09): MMSI 211488728 förekommer med
 * EXAKT ETT sampel i korpus 20260804-17h (sog 13 kn, 602 m från
 * Stridsbergsbron) och hann ändå beväpnas och fyra TVÅ öppningsvarningar på
 * fryst position. Samma klass gav 218023240 en varning i 20260713-41h.
 * Predikatet hade stoppat alla tre (323 → 320 varningar) utan att kosta EN
 * enda äkta förvarning — till skillnad från det hårdare
 * `_hasCorroboratedMovement`, som hade kostat 22 av 323 ÄKTA.
 *
 * FIXEN: konstruktoroption `hasArmingMovementEvidence` (samma stil som
 * `isQuayWobbler`), prövad i `_canArm` DIREKT efter `_hasMovementProof`-raden.
 * Saknas optionen ställs INGET nytt krav — bakåtkompatibelt för varje anropare
 * som bygger servicen utan den.
 *
 * OBS: appens injektionsrad i app.js ligger utanför den här filens ägarskap
 * och görs av app-ägaren; sviten låser servicens kontrakt åt BÅDA håll.
 */

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const STRIDS = BRIDGES.stridsbergsbron;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// Punkt `meters` rakt SÖDER om bron — nordgående båt har bron FRAMFÖR sig.
const southOf = (bridge, meters) => ({
  lat: bridge.lat - meters / 111320,
  lon: bridge.lon,
});

describe('J22: BridgeOpeningService frågar C6:s beväpningsbevis', () => {
  let logger;
  let vds;
  let warnings;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    global.__TEST_MODE__ = true;
    logger = makeLogger();
    warnings = [];
    vds = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });

  afterEach(() => {
    try {
      vds.clearAllTimers();
    } catch (_) { /* tomt */ }
    jest.clearAllTimers();
    jest.useRealTimers();
    delete global.__TEST_MODE__;
  });

  const makeService = (medPredikat) => new BridgeOpeningService({
    logger,
    onWarning: (p) => warnings.push(p),
    ...(medPredikat
      ? { hasArmingMovementEvidence: (v) => vds.hasArmingMovementEvidence(v) }
      : {}),
  });

  /**
   * Fartygsobjekt vars rörelsebokföring skrivs av den RIKTIGA
   * VesselDataService._updateMooringEvidence — inga handsatta bevisfält.
   */
  const makeVesselWithRealEvidence = (mmsi, sogSamples, meters = 602) => {
    const pos = southOf(STRIDS, meters);
    const vessel = {
      mmsi,
      name: 'FANTOMEN',
      lat: pos.lat,
      lon: pos.lon,
      _firstSeenLat: pos.lat,
      _firstSeenLon: pos.lon,
      sog: sogSamples[0],
      cog: 20,
      timestamp: Date.now(),
      fixTs: Date.now(),
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      _finalTargetDirection: null,
      _moored: false,
      _stationarySince: null,
      navStatus: null,
      etaMinutes: null,
      passedAt: {},
      passedBridges: [],
      _hasMovementProof: false,
      _movementProofPending: false,
      _hasCorroboratedMovement: false,
      _corroboratedMovementPending: false,
      _plausibleMovementSeen: false,
    };
    for (const sog of sogSamples) {
      vessel.sog = sog;
      vds._updateMooringEvidence(vessel, sog);
    }
    return vessel;
  };

  test('M3-FANTOMEN (ett enda ORIMLIGT sampel, sog 13) beväpnas INTE när predikatet är injicerat', () => {
    const vessel = makeVesselWithRealEvidence('211488728', [13]);
    // Förutsättningarna: den GAMLA grinden släpper igenom, den nya inte.
    expect(vessel._hasMovementProof).toBe(true);
    expect(vds.hasArmingMovementEvidence(vessel)).toBe(false);

    const svc = makeService(true);
    svc.observeVessel(vessel);

    expect(svc.getStats().armed).toBe(0);
    expect(warnings).toHaveLength(0);
    svc.destroy();
  });

  test('SAMMA fartyg beväpnas som förut när optionen SAKNAS (bakåtkompatibelt)', () => {
    const vessel = makeVesselWithRealEvidence('211488728', [13]);
    const svc = makeService(false);
    svc.observeVessel(vessel);

    expect(svc.getStats().armed).toBeGreaterThanOrEqual(1);
    svc.destroy();
  });

  test('ÄKTA anflygning (rimligt sampel 5,2 kn) beväpnas ÄVEN med predikatet', () => {
    const vessel = makeVesselWithRealEvidence('265999123', [5.2], 1500);
    expect(vds.hasArmingMovementEvidence(vessel)).toBe(true);

    const svc = makeService(true);
    svc.observeVessel(vessel);

    expect(svc.getStats().armed).toBeGreaterThanOrEqual(1);
    svc.destroy();
  });

  test('två konsekutiva rörelsesampel duger också (korroborerad rörelse)', () => {
    const vessel = makeVesselWithRealEvidence('265999124', [13], 1500);
    expect(vds.hasArmingMovementEvidence(vessel)).toBe(false);
    // Sampel 2 med nettoförflyttning gör rörelsen TROVÄRDIG (pending), sampel 3
    // korroborerar den — exakt C6-kedjans två-observationsben.
    vessel.lat += 2000 / 111320;
    vessel.sog = 12;
    vds._updateMooringEvidence(vessel, 12);
    expect(vessel._corroboratedMovementPending).toBe(true);
    expect(vds.hasArmingMovementEvidence(vessel)).toBe(false);

    vessel.lat += 500 / 111320;
    vessel.sog = 11;
    vds._updateMooringEvidence(vessel, 11);
    expect(vessel._hasCorroboratedMovement).toBe(true);
    expect(vds.hasArmingMovementEvidence(vessel)).toBe(true);
  });

  test('_canArm: predikatet prövas EFTER _hasMovementProof och kan ensamt fälla', () => {
    const vessel = makeVesselWithRealEvidence('265999125', [6], 1200);
    const bara = new BridgeOpeningService({
      logger,
      hasArmingMovementEvidence: () => false,
    });
    expect(vessel._hasMovementProof).toBe(true);
    expect(bara._canArm(vessel, 1200, 'Stridsbergsbron')).toBe(false);
    bara.destroy();

    const utan = new BridgeOpeningService({ logger });
    expect(utan._canArm(vessel, 1200, 'Stridsbergsbron')).toBe(true);
    utan.destroy();

    const med = new BridgeOpeningService({
      logger,
      hasArmingMovementEvidence: () => true,
    });
    expect(med._canArm(vessel, 1200, 'Stridsbergsbron')).toBe(true);
    med.destroy();
  });

  test('predikatets svar tolkas STRIKT: bara exakt true släpper igenom', () => {
    const vessel = makeVesselWithRealEvidence('265999126', [6], 1200);
    for (const svar of [undefined, null, 0, '', 'ja', 1]) {
      const svc = new BridgeOpeningService({
        logger,
        hasArmingMovementEvidence: () => svar,
      });
      expect(svc._canArm(vessel, 1200, 'Stridsbergsbron')).toBe(svar === true);
      svc.destroy();
    }
  });

  test('en icke-funktion i optionen ignoreras (ingen krasch, gammalt beteende)', () => {
    const vessel = makeVesselWithRealEvidence('265999127', [13], 1200);
    const svc = new BridgeOpeningService({
      logger,
      hasArmingMovementEvidence: 'inte en funktion',
    });
    expect(svc._canArm(vessel, 1200, 'Stridsbergsbron')).toBe(true);
    svc.destroy();
  });

  test('grinden ligger INNAN kajvobblargrinden och rör inte ARM_MAX_DISTANCE_M', () => {
    const vessel = makeVesselWithRealEvidence('265999128', [13], 1200);
    const svc = new BridgeOpeningService({
      logger,
      hasArmingMovementEvidence: () => false,
      isQuayWobbler: () => {
        throw new Error('kajvobblargrinden ska aldrig nås när beväpningsbeviset saknas');
      },
    });
    expect(svc._canArm(vessel, 1200, 'Stridsbergsbron')).toBe(false);
    // Avståndsgrinden är orörd av J22.
    expect(svc._canArm(vessel, BRIDGE_OPENING.ARM_MAX_DISTANCE_M + 1, 'Stridsbergsbron')).toBe(false);
    svc.destroy();
  });
});
