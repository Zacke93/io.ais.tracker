'use strict';

/**
 * J10b — VARFÖR EN FÖRTÖJD BÅT ÄNDÅ FÅR EN BROÖPPNINGS-ETA.
 * (helkodsgranskning runda 2, fixomgång B, 2026-08-22)
 *
 * FALLET. FRAM 211864690, korpus 20260712-25h: hon korsar Klaffbron norrut
 * 16:38:31, saktar till 3,3 kn 16:40:55 och rapporterar sog 0 både 16:42:53 och
 * 16:45:25 på 886 m från Stridsbergsbron. Därefter ligger hon kvar 880–887 m
 * med sog 0 till minst 20:53 och korsar ALDRIG bron — hon saknas helt i
 * gt-passages för Stridsbergsbron. Ändå kan appen publicera
 * "En båt på väg mot Stridsbergsbron, beräknad broöppning om 10 minuter".
 *
 * HYPOTESEN SOM PRÖVADES OCH FÖLL. Passagegolvet MIN_PASSAGE_ROUTE_SPEED_KNOTS
 * (2,5 kn) gäller så länge hasRecentPassageContext är sant och båten räknas som
 * rörlig. Rörelsetestet läser hela fartbufferten som en KLUMP: vid 16:45:25
 * innehåller 3-slots-bufferten [3,3 / 0 / 0], snittet är 1,1 kn (≥ 1,0) och
 * allBufferedSlow är falskt (3,3 ≥ 1,0) — alltså "rörlig", trots två nollor i
 * rad. Ett FÄRSKHETSKRAV (de två senaste samplen båda under MOVEMENT_SOG_KNOTS
 * ⇒ inte rörlig) implementerades och MÄTTES:
 *   • 25h-raden 16:45:25 ändrades INTE. Rå-ETA gick 11,5 → 26,1 min, men det
 *     PUBLICERADE värdet blev 9,85 min båda gångerna — klämmorna äger raden.
 *   • ETA-noggrannheten över alla 17 låsta korpusar FÖRSÄMRADES:
 *     median |fel| 2,30 → 2,38 min och andelen inom 2 min 47,8 % → 47,1 %
 *     (tests/replay-validation/measureEtaAccuracy.js). Golvet är alltså RÄTT
 *     för den kö-liggande klass det skrevs för — båtar som saktar ned inför en
 *     broöppning och sedan passerar.
 *   • Fem LÅSTA korpusars golden-text hade behövt låsas om.
 * Färskhetskravet levererades därför INTE. Den här sviten bevarar mätningen som
 * körbar kunskap och pekar ut var nästa försök ska sättas in.
 *
 * ROTORSAKEN, som sviten visar genom RIKTIG pipeline: när en båt stannar växer
 * rå-ETA:n korrekt mot oändligheten, men TRE klämmor i serie —
 * ETA_MONOTONIC, ETA_ABSOLUTE_CLAMP och ETA_GROWTH_CAP (den sista uttryckligen
 * "cap further growth to +1 min/cycle when the vessel is genuinely stationary")
 * — plus EMA-utjämningen håller det PUBLICERADE värdet nära det gamla. Effekten
 * är designad ("användaren ska inte vilseledas av ett ständigt växande tal"),
 * men för en båt som FÖRTÖJT blir följden att ett litet, lugnt och FALSKT
 * ETA-tal ligger kvar tills något annat plockar bort henne ur texten. Det är
 * DEN grinden en riktig fix måste öppna — inte passagegolvet.
 */

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const geometry = require('../lib/utils/geometry');
const { BRIDGES, MIN_PASSAGE_ROUTE_SPEED_KNOTS } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;

// FRAM:s RÅDATA ur tests/replay-validation/corpora-data/ais-replay-20260712-174434.jsonl.
// Tidsstämplarna är samplens verkliga inbördes avstånd (152 s / 118 s / 152 s).
const FRAM_SAMPEL = [
  {
    iso: '16:38:23', offsetMs: 0, lat: 58.28389, lon: 12.28402, sog: 4.6, cog: 8.1,
  },
  {
    iso: '16:40:55', offsetMs: 152000, lat: 58.28673166666667, lon: 12.285826666666667, sog: 3.3, cog: 21.6,
  },
  {
    iso: '16:42:53', offsetMs: 270000, lat: 58.28725333333333, lon: 12.285148333333332, sog: 0, cog: null,
  },
  {
    iso: '16:45:25', offsetMs: 422000, lat: 58.287263333333335, lon: 12.285193333333332, sog: 0, cog: null,
  },
];

describe('J10b: passagegolvet saknar färskhetskrav (dokumenterat, ej åtgärdat)', () => {
  let nu;
  let start;
  let rader;
  let calculator;
  let proximityService;
  let vessel;

  beforeEach(() => {
    nu = 1_700_000_000_000;
    start = nu;
    rader = [];
    Date.now = () => nu;
    global.__TEST_MODE__ = true;
    const logger = {
      debug: (m) => rader.push(String(m)), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const bridgeRegistry = new BridgeRegistry();
    calculator = new ProgressiveETACalculator(logger, bridgeRegistry);
    proximityService = new ProximityService(bridgeRegistry, logger);
    vessel = {
      mmsi: '211864690',
      name: 'FRAM',
      status: 'en-route',
      targetBridge: 'Stridsbergsbron',
      // Klaffbron passerad vid t0 — färsk passagekontext (< 15 min) är den
      // enda situation där 2,5 kn-golvet över huvud taget kan gälla.
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: start,
      passedBridges: ['Klaffbron'],
    };
  });

  afterEach(() => {
    calculator.destroy();
    Date.now = REAL_DATE_NOW;
    delete global.__TEST_MODE__;
  });

  /** Spelar upp FRAM:s första N rådatasampel genom den RIKTIGA kedjan. */
  const spelaUpp = (antal) => {
    let eta = null;
    FRAM_SAMPEL.slice(0, antal).forEach((s) => {
      nu = start + s.offsetMs;
      vessel.lat = s.lat;
      vessel.lon = s.lon;
      vessel.sog = s.sog;
      vessel.cog = s.cog;
      const prox = proximityService.analyzeVesselProximity(vessel);
      eta = calculator.calculateProgressiveETA(vessel, prox);
    });
    return eta;
  };

  test('RÅDATAT: FRAM ligger 886 m från Stridsbergsbron och står still', () => {
    const sista = FRAM_SAMPEL[FRAM_SAMPEL.length - 1];
    const avstand = geometry.calculateDistance(
      sista.lat, sista.lon, BRIDGES.stridsbergsbron.lat, BRIDGES.stridsbergsbron.lon,
    );
    expect(Math.round(avstand)).toBe(886);
    // De två senaste samplen är båda 0 kn, 152 s isär.
    expect(FRAM_SAMPEL[2].sog).toBe(0);
    expect(sista.sog).toBe(0);
    expect(sista.offsetMs - FRAM_SAMPEL[2].offsetMs).toBe(152000);
  });

  test('DEFEKTEN: två nollor i rad räcker inte — passagegolvet 2,5 kn gäller ändå', () => {
    spelaUpp(4);
    // Fartbufferten (byggd av kalkylatorn själv ur distinkta sampel) är
    // [3,3 / 0 / 0]: snittet 1,1 kn passerar rörelsetröskeln och 3,3 gör
    // allBufferedSlow falskt, så båten räknas som rörlig trots sog 0.
    expect(calculator._speedBuffers.get(vessel.mmsi)).toEqual([3.3, 0, 0]);
    expect(vessel.sog).toBe(0);
    expect(calculator._getEffectiveSpeed(vessel)).toBe(MIN_PASSAGE_ROUTE_SPEED_KNOTS);
    // Golvet är HELA förklaringen till att en stillaliggande båt får ett tal:
    // 886 m vid 2,5 kn är 11,5 min.
    const raRader = rader.filter((r) => r.includes('[ETA_RAW]'));
    expect(raRader[raRader.length - 1]).toContain('11.5min');
  });

  test('MEN GOLVET ÄGER INTE DET PUBLICERADE TALET — klämmorna gör det', () => {
    const eta = spelaUpp(4);
    // Rå 11,5 min, publicerat under 9: skillnaden är monotoni-/klämm-/EMA-
    // kedjan. Det är därför ett färskhetskrav på golvet (rå 11,5 → 26,1) inte
    // ändrade 25h-raden: det publicerade värdet styrs inte av rå-ETA:n.
    expect(eta).toBeLessThan(9);
    expect(eta).toBeGreaterThan(8);
  });

  test('J21-REGRESSIONSVAKT: 0,9-bandet ger fortfarande INGET golv', () => {
    // Fixomgång B rörde inte J21. Buffert 0,9/0,9/0,9 ⇒ snittet under
    // MOVEMENT_SOG_KNOTS OCH alla sampel under den ⇒ inte rörlig ⇒ ingen
    // golvfabricering.
    [0.9, 0.9, 0.9].forEach((sog, i) => {
      nu = start + i * 60000;
      vessel.lat = BRIDGES.klaffbron.lat + (60 + i * 3) / 111320;
      vessel.lon = BRIDGES.klaffbron.lon;
      vessel.sog = sog;
      vessel.cog = 20;
      const prox = proximityService.analyzeVesselProximity(vessel);
      calculator.calculateProgressiveETA(vessel, prox);
    });
    expect(calculator._getEffectiveSpeed(vessel)).toBeCloseTo(0.9, 5);
    expect(calculator._getEffectiveSpeed(vessel)).toBeLessThan(MIN_PASSAGE_ROUTE_SPEED_KNOTS);
  });
});

describe('J10b: ROTORSAKEN — klämmorna håller kvar ett gammalt ETA-tal', () => {
  let nu;
  let rader;
  let calculator;
  let proximityService;

  beforeEach(() => {
    nu = 1_700_000_000_000;
    rader = [];
    Date.now = () => nu;
    global.__TEST_MODE__ = true;
    const logger = {
      debug: (m) => rader.push(String(m)), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const bridgeRegistry = new BridgeRegistry();
    calculator = new ProgressiveETACalculator(logger, bridgeRegistry);
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    calculator.destroy();
    Date.now = REAL_DATE_NOW;
    delete global.__TEST_MODE__;
  });

  test('en båt som saktar in till stillastående får rå-ETA 120 min men publicerad ~26', () => {
    // ~900 m söder om Stridsbergsbron, UTAN passagekontext (så inget golv alls
    // är inblandat — det här är enbart klämmornas verk). Farten faller
    // 3,0 → 0,3 kn medan båten i praktiken står kvar.
    const bas = {
      lat: BRIDGES.stridsbergsbron.lat - 0.0081,
      lon: BRIDGES.stridsbergsbron.lon,
    };
    const vessel = {
      mmsi: '265900999',
      name: 'KLÄMPROV',
      status: 'en-route',
      targetBridge: 'Stridsbergsbron',
      lastPassedBridge: null,
      lastPassedBridgeTime: null,
      passedBridges: [],
      cog: 20,
    };
    const publicerade = [];
    [3.0, 2.0, 1.2, 0.7, 0.5, 0.4, 0.3].forEach((sog, i) => {
      nu += 60000;
      vessel.lat = bas.lat + i * 0.00001;
      vessel.lon = bas.lon;
      vessel.sog = sog;
      const prox = proximityService.analyzeVesselProximity(vessel);
      publicerade.push(calculator.calculateProgressiveETA(vessel, prox));
    });

    const raRader = rader.filter((r) => r.includes('[ETA_RAW]'));
    // Rå-ETA:n gör RÄTT: den växer mot taket (120 min) när farten går mot noll.
    expect(raRader[raRader.length - 1]).toContain('120.0min');
    // Det publicerade talet gör det INTE: det kryper uppåt ~0,4 min per cykel.
    const sista = publicerade[publicerade.length - 1];
    const nastSista = publicerade[publicerade.length - 2];
    expect(sista).toBeLessThan(30);
    expect(sista - nastSista).toBeLessThan(1);

    // Och de tre klämmorna är namngivna i loggen — det är DEM en riktig fix
    // för den förtöjda klassen måste adressera.
    expect(rader.some((r) => r.includes('[ETA_GROWTH_CAP]'))).toBe(true);
    expect(rader.some((r) => r.includes('[ETA_ABSOLUTE_CLAMP]'))).toBe(true);
    expect(rader.some((r) => r.includes('[ETA_MONOTONIC]'))).toBe(true);
  });
});
