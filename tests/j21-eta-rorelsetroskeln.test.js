'use strict';

/**
 * J21 (helkodsgranskning RUNDA 2, 2026-08-22) — H22:s SYSTERSTÄLLE:
 * ETA-fartgolvets rörelsevillkor stod på 0,8 kn medan filens EGEN
 * rörelsedefinition är MOVEMENT_SOG_KNOTS (1,0).
 *
 * MEKANISMEN FÖRE FIXEN: i ProgressiveETACalculator._getEffectiveSpeed står
 * fartgolvets stationär-test på TVÅ operander —
 *   vesselIsMoving = avgSpeed > 0,8 ELLER !allBufferedSlow
 * — där allBufferedSlow prövar VARJE buffrat sampel mot MOVEMENT_SOG_KNOTS
 * (1,0). I bandet 0,81–0,99 var allBufferedSlow SANT (alla sampel under 1,0)
 * samtidigt som snittet över 0,8 gjorde vesselIsMoving sant. Passagegolvet
 * MIN_PASSAGE_ROUTE_SPEED_KNOTS (2,5 kn) gällde alltså för en båt som filen
 * själv definierar som icke-rörlig. H22 enade hold-släppet med 1,0 men lämnade
 * den här raden orörd.
 *
 * FELUTFALLET (uppmätt mot HEAD före fixen med samma rigg som i sviten): båt
 * som just passerat Klaffbron med Stridsbergsbron som mål, buffert
 * 0,85/0,85/0,9 ⇒ effektiv fart 2,5 kn ⇒ ETA 15,1 min ("beräknad broöppning om
 * 15 minuter"). Sanningen vid 0,87 kn är ~44 min — och i praktiken förtöjer
 * hon. Kontrollfallet 0,7 kn gav redan före fixen korrekt 53,9 min.
 *
 * FIXEN: avgSpeed >= MOVEMENT_SOG_KNOTS. Bara bandet 0,80–0,99 ändras.
 *
 * SVITEN LÅSER (allt genom RIKTIG pipeline: ProximityService →
 * ProgressiveETACalculator.calculateProgressiveETA, buffert byggd av
 * kalkylatorn själv ur distinkta positionssampel):
 *   • 0,9-bandet ⇒ INTE rörlig ⇒ inget passagegolv ⇒ ärlig lång ETA
 *   • 1,0 ⇒ rörlig ⇒ passagegolvet gäller som förut
 *   • gränsexakthet 0,99 mot 1,00
 *   • 0,7-bandet oförändrat (regressionsvakt: fixen får inte flytta det)
 *   • tröskelbindningen: golvvillkoret läser SAMMA konstant som
 *     allBufferedSlow-grenen bredvid.
 */

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const { BRIDGES, MIN_PASSAGE_ROUTE_SPEED_KNOTS } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// Punkt `meters` rakt NORR om bron.
const northOf = (bridge, meters) => ({
  lat: bridge.lat + meters / 111320,
  lon: bridge.lon,
});

describe('J21: ETA-fartgolvets rörelsevillkor använder filens egen rörelsedefinition', () => {
  let now;
  let calculator;
  let proximityService;

  beforeEach(() => {
    now = 1_700_000_000_000;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    const logger = makeLogger();
    const bridgeRegistry = new BridgeRegistry();
    calculator = new ProgressiveETACalculator(logger, bridgeRegistry);
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    calculator.destroy();
    Date.now = REAL_DATE_NOW;
    delete global.__TEST_MODE__;
  });

  /**
   * Kör tre RIKTIGA ETA-beräkningar med distinkta positionssampel så att
   * kalkylatorns egen fartbuffert fylls via _getAveragedSpeed (sampelnyckeln
   * är position+fart+kurs — samma position hade svalts som dubblett).
   * Returnerar sista publicerade ETA och den effektiva farten.
   */
  const koerTreSampel = (sogs) => {
    const vessel = {
      mmsi: '265902101',
      name: 'BANDBÅTEN',
      sog: sogs[0],
      cog: 20,
      status: 'en-route',
      targetBridge: 'Stridsbergsbron',
      // FÄRSK passagekontext (< 15 min) — den enda situation där
      // passagegolvet 2,5 kn över huvud taget kan gälla.
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: now - 2 * 60 * 1000,
      passedBridges: ['Klaffbron'],
    };
    let eta = null;
    sogs.forEach((sog, i) => {
      const pos = northOf(BRIDGES.klaffbron, 60 + i * 3);
      vessel.lat = pos.lat;
      vessel.lon = pos.lon;
      vessel.sog = sog;
      const prox = proximityService.analyzeVesselProximity(vessel);
      eta = calculator.calculateProgressiveETA(vessel, prox);
    });
    return { eta, effektivFart: calculator._getEffectiveSpeed(vessel), vessel };
  };

  test('buffert 0,9/0,9/0,9 ⇒ INTE rörlig ⇒ inget passagegolv (ärlig lång ETA)', () => {
    const { eta, effektivFart } = koerTreSampel([0.9, 0.9, 0.9]);
    expect(effektivFart).toBeCloseTo(0.9, 5);
    expect(effektivFart).toBeLessThan(MIN_PASSAGE_ROUTE_SPEED_KNOTS);
    // 42 min mot fabrikatets 15 — texten får inte längre lova "om 15 minuter".
    expect(eta).toBeGreaterThan(30);
  });

  test('dedupens fältfall 0,85/0,85/0,9 (snitt 0,867) ⇒ inget golv', () => {
    const { eta, effektivFart } = koerTreSampel([0.85, 0.85, 0.9]);
    expect(effektivFart).toBeCloseTo(0.8666666666666667, 6);
    expect(eta).toBeGreaterThan(30);
  });

  test('buffert 1,0/1,0/1,0 ⇒ RÖRLIG ⇒ passagegolvet gäller som förut', () => {
    const { eta, effektivFart } = koerTreSampel([1.0, 1.0, 1.0]);
    expect(effektivFart).toBe(MIN_PASSAGE_ROUTE_SPEED_KNOTS);
    expect(eta).toBeLessThan(20);
  });

  test('gränsexakthet: 0,99 är INTE rörlig, 1,00 är det', () => {
    expect(koerTreSampel([0.99, 0.99, 0.99]).effektivFart).toBeCloseTo(0.99, 5);
    expect(koerTreSampel([1.0, 1.0, 1.0]).effektivFart).toBe(MIN_PASSAGE_ROUTE_SPEED_KNOTS);
  });

  test('regressionsvakt: 0,7-bandet är oförändrat (fixen får inte flytta det)', () => {
    const { eta, effektivFart } = koerTreSampel([0.7, 0.7, 0.7]);
    expect(effektivFart).toBeCloseTo(0.7, 5);
    expect(eta).toBeGreaterThan(45);
  });

  test('ETT enda sampel ≥ 1,0 i bufferten räcker för att båten ska räknas som rörlig', () => {
    // allBufferedSlow-grenen (andra operanden) är orörd av J21 — låses här så
    // en framtida "förenkling" av villkoret syns.
    const { effektivFart } = koerTreSampel([0.5, 0.9, 1.5]);
    expect(effektivFart).toBe(MIN_PASSAGE_ROUTE_SPEED_KNOTS);
  });

  test('utan färsk passagekontext gäller inget golv alls, oavsett fart', () => {
    const vessel = {
      mmsi: '265902102',
      sog: 0.9,
      cog: 20,
      status: 'en-route',
      targetBridge: 'Stridsbergsbron',
      lastPassedBridge: null,
      lastPassedBridgeTime: null,
      passedBridges: [],
      ...northOf(BRIDGES.klaffbron, 60),
    };
    expect(calculator._getEffectiveSpeed(vessel)).toBeCloseTo(0.9, 5);
  });
});
