'use strict';

const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const geometry = require('../lib/utils/geometry');

/**
 * H2 (helkodsgranskning runda 1, 2026-08-22) — FYSIKGRINDEN STÄNGDES AV HELT
 * VID KURSÄNDRING > 45°.
 *
 * F64 lade fysikgrinden på >300 m men villkorade den på noClearTurn. Vid
 * större kursändring fanns INGEN övre gräns: grenen vessel_turning accepterar
 * så snart legitimacyScore ≥ 0,4 — och 0,40 är poängens GOLV, så kravet
 * filtrerade ingenting. Skyddsnätet var därmed dött precis i den klass där
 * utfallet är värst: granskningen körde ett 4773 m-segment genom hela
 * pipelinen och fick passed för FYRA broar, tre fabricerade passager och en
 * felaktig målbrotransition.
 *
 * Grinden gäller nu även vid tydlig sväng när rörelsen överstiger tre gånger
 * den (redan 2,0×-marginalerade) maxsträckan. Det låsta U-svängsfallet från
 * F64 ligger på 2,7× och släpps fortfarande — se sista testerna.
 */

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

// Trollhättan ~58,29°N. Meter → grader latitud (haversine, R = 6371 km).
const M_PER_DEG_LAT = 111194.93;
const BAS = { lat: 58.29, lon: 12.29 };
const norrOm = (meter) => ({ lat: BAS.lat + meter / M_PER_DEG_LAT, lon: BAS.lon });

/** maxRealisticDistanceM som _analyzeLargeMovement räknar den. */
const maxRealistiskM = (sogKn, sekunder) => Math.max(sogKn, 5) * (sekunder / 3600) * 2.0 * 1852;

/**
 * Kör analysen för en rörelse rakt norrut.
 * @param {{meter: number, sekunder: number, sog: number, cogFran: number, cogTill: number}} p
 */
function analysera(analyzer, p) {
  const now = Date.now();
  const fran = BAS;
  const till = norrOm(p.meter);
  const oldVessel = {
    lat: fran.lat, lon: fran.lon, sog: p.sog, cog: p.cogFran, timestamp: now - p.sekunder * 1000,
  };
  const newVessel = {
    lat: till.lat, lon: till.lon, sog: p.sog, cog: p.cogTill, timestamp: now,
  };
  return analyzer.analyzeMovement('265999999', till, fran, newVessel, oldVessel);
}

describe('H2: svängundantaget i fysikgrinden har ett tak', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new GPSJumpAnalyzer(makeLogger());
  });

  test('FÄLTFALLET: 4773 m på 60 s MED U-sväng är fortfarande fysiskt omöjligt', () => {
    // 4773 m på 60 s ⇒ ~155 knop. Kursändringen 10° → 200° (170° efter
    // vinkelvikning) räckte FÖRE H2 för att slippa hela fysikgrinden.
    const r = analysera(analyzer, {
      meter: 4773, sekunder: 60, sog: 5, cogFran: 10, cogTill: 200,
    });
    expect(r.analysis.cogChange).toBeGreaterThan(45); // undantagsvägen var öppen
    expect(r.isGPSJump).toBe(true);
    expect(r.reason).toBe('physically_impossible_movement');
    expect(r.action).toBe('gps_jump_detected');
    expect(r.isLegitimateMovement).toBe(false);
  });

  test('INVERSIONEN ÄR BORTA: sväng gör inte en omöjlighet MER trovärdig', () => {
    // Samma omöjliga rörelse utan sväng dömdes redan förut. Efter H2 ger
    // BÅDA samma verdikt — förut gav svängvarianten naket accept, alltså ett
    // SVAGARE utfall än den flaggade accept_with_caution utan sväng.
    const utanSvang = analysera(analyzer, {
      meter: 4773, sekunder: 60, sog: 5, cogFran: 10, cogTill: 12,
    });
    const medSvang = analysera(analyzer, {
      meter: 4773, sekunder: 60, sog: 5, cogFran: 10, cogTill: 200,
    });
    expect(utanSvang.reason).toBe('physically_impossible_movement');
    expect(medSvang.reason).toBe(utanSvang.reason);
  });

  test('U-SVÄNGEN LEVER: F64:s låsta 666 m-fall ligger under taket och accepteras', () => {
    // 666 m på 30 s vid 8 kn: maxRealistic 246,9 m ⇒ taket 740,8 m. Fallet är
    // 2,7× och passerar alltså fortfarande som manöver, precis som
    // tests/gps-physics-gate.test.js låser det.
    const r = analysera(analyzer, {
      meter: 666, sekunder: 30, sog: 8, cogFran: 10, cogTill: 200,
    });
    expect(r.movementDistance).toBeLessThan(maxRealistiskM(8, 30) * 3);
    expect(r.isGPSJump).toBe(false);
    expect(r.reason).toBe('vessel_turning');
  });

  test('TAKET ÄR 3×: strax under släpps som manöver, strax över döms som hopp', () => {
    const tak = maxRealistiskM(5, 60) * 3; // 926,0 m
    const under = analysera(analyzer, {
      meter: Math.round(tak * 0.97), sekunder: 60, sog: 5, cogFran: 10, cogTill: 200,
    });
    const over = analysera(analyzer, {
      meter: Math.round(tak * 1.03), sekunder: 60, sog: 5, cogFran: 10, cogTill: 200,
    });
    // Bägge ligger över maxRealistic (308,7 m) — det är TAKET som skiljer dem.
    expect(under.movementDistance).toBeGreaterThan(maxRealistiskM(5, 60));
    expect(under.movementDistance).toBeLessThan(tak);
    expect(over.movementDistance).toBeGreaterThan(tak);
    expect(under.isGPSJump).toBe(false);
    expect(under.reason).toBe('vessel_turning');
    expect(over.isGPSJump).toBe(true);
    expect(over.reason).toBe('physically_impossible_movement');
  });

  test('LEGITIM LÅNG FÖRFLYTTNING BERÖRS INTE: 4773 m på 40 min vid 8 kn', () => {
    // 8 kn i 40 min ⇒ maxRealistic 9877 m: rörelsen är inte ens över
    // grundvillkoret, så varken grind eller tak kan fyra.
    const r = analysera(analyzer, {
      meter: 4773, sekunder: 2400, sog: 8, cogFran: 10, cogTill: 200,
    });
    expect(r.movementDistance).toBeLessThan(maxRealistiskM(8, 2400));
    expect(r.isGPSJump).toBe(false);
  });

  test('geometrin i testet stämmer: 4773 m norrut mäts som 4773 m', () => {
    const d = geometry.calculateDistance(BAS.lat, BAS.lon, norrOm(4773).lat, norrOm(4773).lon);
    expect(Math.abs(d - 4773)).toBeLessThan(10);
  });
});
