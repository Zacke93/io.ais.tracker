'use strict';

jest.mock('homey');

/**
 * M8 (helkodsgranskning RUNDA 4, 2026-08-23) — ÖPPET FYND c från runda 3 (L4).
 *
 * FYNDET: outliergrenen `gps_coordination_active` i _isETAOutlier saknar
 * tidsgrind. Systrarna `dramatic_increase`/`dramatic_decrease` kräver
 * timeDelta < 30 s och kan därför bara dämpa EN glimt; GPS-grenen fyrar vid
 * VARJE beräkningscykel så länge `_underBridgeLatched` eller
 * `lastCoordinationLevel` enhanced/system_wide står kvar. Varje träff går till
 * _getFallbackETA, vars F74-tak är min(blandning, förra publicerade) — den
 * publicerade siffran kan alltså bara HÅLLAS eller SÄNKAS. Utan tak fryser
 * eller ratchetar ETA:n nedåt medan sanningen klättrar.
 *
 * FIXEN (bounded, INTE en absolut 30 s-grind — K6 mätte det fönstret dött vid
 * AISHubs p50-kadens 152 s): högst GPS_FALLBACK_MAX_CONSECUTIVE fallbacks i
 * FÖLJD per fartyg; därefter släpps rå-ETA:n genom det VANLIGA skyddet
 * (monotoni + EMA + positive-jump-limit).
 *
 * Sviten låser: (1) taket biter, (2) det biter inte för tidigt, (3) serien
 * bryts av en icke-GPS-cykel, (4) räknaren är per fartyg, (5) städningen i
 * clearVesselETAHistory / _cleanupOldETAHistory / destroy, (6) att de två
 * dramatic_*-grenarna INTE påverkas av taket.
 */

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

global.__TEST_MODE__ = true;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Fartyg med aktivt GPS-koordinationsläge (grenens egen förutsättning). */
const gpsVessel = (mmsi, sog = 0.2) => ({
  mmsi,
  sog,
  status: 'en-route',
  targetBridge: null, // ⇒ _getDistanceToTarget = null, isolerar outliersteget
  lastCoordinationLevel: 'enhanced',
});

/** Lägg en historikpost `ageMs` millisekunder tillbaka i tiden. */
function seedHistory(calc, mmsi, processedETA, ageMs) {
  calc._recordETAHistory(mmsi, {
    rawETA: processedETA,
    protectedETA: processedETA,
    processedETA,
    timestamp: Date.now() - ageMs,
    targetBridge: null,
    nearestBridge: null,
    vesselSpeed: 0.2,
    distance: null,
    distanceToTarget: null,
    vesselStatus: 'en-route',
  });
}

/**
 * Kör `n` beräkningscykler med `cadenceMs` mellan varje. Historiken seedas
 * först (annars svarar _isETAOutlier 'no_history' på cykel 1 och serien börjar
 * aldrig). Kadensen 150 s är AISHubs uppmätta p50 (152 s) — den håller BÅDA
 * 30 s-fönstren stängda men ligger under gap-återställningens 180 s.
 */
function runCycles(calc, vessel, rawETA, n, cadenceMs = 150000, baseline = 12) {
  seedHistory(calc, vessel.mmsi, baseline, cadenceMs);
  let out = null;
  for (let i = 0; i < n; i++) {
    out = calc._processETAWithProtection(vessel, rawETA, null);
    const h = calc._etaHistory.get(vessel.mmsi);
    h[h.length - 1].timestamp -= cadenceMs;
  }
  return out;
}

const gpsBoundLines = (logger) => logger.debug.mock.calls
  .map((c) => String(c[0]))
  .filter((s) => s.includes('[ETA_GPS_BOUND]'));

const fallbackLines = (logger) => logger.debug.mock.calls
  .map((c) => String(c[0]))
  .filter((s) => s.includes('[ETA_FALLBACK]') && s.includes('Using fallback'));

describe('M8: GPS-outliergrenen är boundad', () => {
  let calc; let logger;

  beforeEach(() => {
    logger = makeLogger();
    calc = new ProgressiveETACalculator(logger, new BridgeRegistry());
  });

  afterEach(() => calc.destroy());

  test('grenen fyrar utan tidsgrind — förutsättningen fyndet vilar på', () => {
    // 200 s sedan förra posten: BÅDA dramatic_*-grenarna är stängda (30 s),
    // men GPS-grenen svarar ändå outlier. Det är just den asymmetrin fyndet
    // beskriver, och den ska stå kvar (fixen tar inte bort skyddet).
    const v = gpsVessel('100000001');
    seedHistory(calc, v.mmsi, 12, 200000);
    const r = calc._isETAOutlier(60, calc._etaHistory.get(v.mmsi), v);
    expect(r).toEqual({ isOutlier: true, reason: 'gps_coordination_active' });
  });

  test('de tre första cyklerna skyddas, den fjärde släpper rå-ETA:n', () => {
    const v = gpsVessel('100000002');
    const out = runCycles(calc, v, 60, 4);
    expect(gpsBoundLines(logger)).toHaveLength(1);
    expect(gpsBoundLines(logger)[0]).toContain('3 GPS-fallbacks i följd');
    // Efter släppet: fyra fallbackrader hade blivit tre.
    expect(fallbackLines(logger)).toHaveLength(3);
    // Och den fjärde publicerade siffran har KLÄTTRAT (rå släpps genom det
    // vanliga skyddet i stället för att hållas nere av F74-taket).
    expect(out).toBeGreaterThan(0);
  });

  test('taket biter INTE på tredje cykeln (av-med-ett-vakt)', () => {
    const v = gpsVessel('100000003');
    runCycles(calc, v, 60, 3);
    expect(gpsBoundLines(logger)).toHaveLength(0);
    expect(calc._gpsFallbackStreak.get('100000003')).toBe(3);
  });

  test('en cykel utan GPS-fallback bryter serien och nollar räknaren', () => {
    const v = gpsVessel('100000004');
    runCycles(calc, v, 60, 2);
    expect(calc._gpsFallbackStreak.get('100000004')).toBe(2);

    // Samma fartyg, men koordinationsläget har släppt ⇒ ingen GPS-gren.
    const calm = {
      ...v, lastCoordinationLevel: 'normal', _underBridgeLatched: false,
    };
    calc._processETAWithProtection(calm, 60, null);
    expect(calc._gpsFallbackStreak.has('100000004')).toBe(false);
  });

  test('räknaren är per fartyg — grannens serie påverkar inte min', () => {
    const a = gpsVessel('100000005');
    const b = gpsVessel('100000006');
    runCycles(calc, a, 60, 4);
    runCycles(calc, b, 60, 2);
    expect(calc._gpsFallbackStreak.get('100000006')).toBe(2);
    expect(gpsBoundLines(logger).filter((s) => s.includes('100000006'))).toHaveLength(0);
  });

  test('dramatic_increase påverkas INTE av taket (30 s-grinden äger den)', () => {
    const v = {
      mmsi: '100000007', sog: 5, status: 'en-route', targetBridge: null,
    };
    // Fyra cykler med 10 s kadens och 10x-spik: alla ska skyddas, ingen släppas.
    runCycles(calc, v, 100, 4, 10000, 10);
    expect(gpsBoundLines(logger)).toHaveLength(0);
    expect(calc._gpsFallbackStreak.has('100000007')).toBe(false);
  });

  test('clearVesselETAHistory nollar räknaren (ingen baslinje kvar att hålla)', () => {
    const v = gpsVessel('100000008');
    runCycles(calc, v, 60, 1);
    expect(calc._gpsFallbackStreak.get('100000008')).toBe(1);
    calc.clearVesselETAHistory('100000008', 'target_transition_A_to_B');
    expect(calc._gpsFallbackStreak.has('100000008')).toBe(false);
  });

  test('_cleanupOldETAHistory städar räknare utan ETA-historik', () => {
    calc._gpsFallbackStreak.set('100000009', 2);
    expect(calc._etaHistory.has('100000009')).toBe(false);
    calc._cleanupOldETAHistory();
    expect(calc._gpsFallbackStreak.has('100000009')).toBe(false);
  });

  test('destroy() tömmer räknaren (städparitet enligt FG-D4)', () => {
    calc._gpsFallbackStreak.set('100000010', 3);
    calc.destroy();
    expect(calc._gpsFallbackStreak.size).toBe(0);
  });
});
