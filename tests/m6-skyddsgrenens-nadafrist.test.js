'use strict';

/**
 * M6 (helkodsgranskning RUNDA 4, 2026-08-23, major) — L5:s TREDJE SYSTERSTÄLLE:
 * TARGET_PROTECTION_ACTIVE hoppar över HELA nådafrist-blocket.
 *
 * MEKANISMEN. Nådafristens fyra operationer (skapandet, kö-undantagets släpp,
 * PROTECTION_ZONE_SAVE:s släpp och S-F8-rensningen vid lyckad omvalidering)
 * ligger allihop inne i grenen där manöverskyddet är AVSTÄNGT
 * (`if (!protectionActive)`). Är skyddet PÅ körs bara mellanbropassagerna och
 * en loggrad — posten i `_targetRemovalGrace` varken skapas, stämplas om eller
 * raderas. Den ÅLDRAS alltså genom hela skyddsfönstret (upp till 5 min,
 * `_shouldDeactivateProtection`), och första valideringsmissen efter att
 * skyddet släppt ser en frist på flera minuter ⇒ `TARGET_CHANGE → "none"` i
 * SAMMA tick i stället för en ny 60-sekunders nedräkning. Fällan är dubbel:
 * manöverskyddet armeras av samma in-/utbromsning (`_detectManeuverProtection`,
 * Δsog > 2 kn eller ΔCOG > 45°) som fäller `_shouldAssignTargetBridge`, så
 * S-F8 sätts ur spel exakt när den behövs.
 *
 * FIXEN STÄMPLAR OM, RADERAR INTE. Radering mättes över alla 18 korpusar och
 * gav REGRESSION i 20260601-41h (161 → 163 textövergångar); omstämpling gav
 * 41h byte-identisk och tog bort en falsk "Inga båtar" i 20260804-both-21h.
 * `_touchTargetGrace` skapar aldrig en post — bara nedräkningar som redan
 * startat slutar åldras.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

// lib/constants.js BRIDGES — Klaffbron.
const KLAFF = { lat: 58.28409551543077, lon: 12.283929525245636 };
// Startavstånd söder om målbron. Anflygningen slutar på 1 080 m — långt
// utanför både målbroskyddets 300 m-zon och kö-zonsvaktens 600 m, så
// protection kan bara komma från MANÖVERledet och kö-undantaget kan aldrig
// maskera resultatet.
const SOUTH_M = 1200;
const M_PER_DEG_LAT = 111320; // meridiangraden, samma konstant som _northProgressMps

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

const liveServices = [];
let NOW = 0;
let nowSpy = null;

function makeVDS() {
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.app = {
    gpsJumpGateService: null,
    passageLatchService: null,
    routeOrderValidator: null,
    debug: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  liveServices.push(svc);
  return svc;
}

const graceKey = (mmsi) => `${mmsi}:Klaffbron`;
const graceValue = (svc, mmsi) => (svc._targetRemovalGrace || new Map()).get(graceKey(mmsi));

function loggedLines() {
  return [...logger.log.mock.calls, ...logger.debug.mock.calls].map((args) => String(args[0]));
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

beforeEach(() => {
  // Fristen mäts i väggklocka — samma Date.now-mock som J12- och L5-sviterna.
  NOW = 1754000000000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => NOW);
});

afterEach(() => {
  while (liveServices.length > 0) {
    const svc = liveServices.pop();
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  if (nowSpy) nowSpy.mockRestore();
  jest.clearAllMocks();
});

describe('M6: manöverskyddets gren åldrar inte nådafristen', () => {
  /**
   * Kör hela scenariot genom RIKTIG pipeline (updateVessel) och returnerar
   * mätpunkterna. Geometrin ligger 1,2 km söder om Klaffbron hela tiden.
   */
  function korScenario(svc, mmsi) {
    const step = (dSouthM, sog, cog, dt) => {
      NOW += dt;
      logger.log.mockClear();
      logger.debug.mockClear();
      svc.updateVessel(mmsi, {
        mmsi,
        lat: KLAFF.lat - dSouthM / M_PER_DEG_LAT,
        lon: KLAFF.lon,
        sog,
        cog,
        name: 'M6-TEST',
        timestamp: NOW,
      });
      return svc.vessels.get(mmsi);
    };

    // (1)–(3) Norrgående anflygning i 4 kn, 60 m närmare per 30 s (≈3,9 kn) ⇒
    //         målbron Klaffbron tilldelas och 2-READINGS-valideringen håller.
    const v1 = step(SOUTH_M, 4.0, 30, 0);
    step(SOUTH_M - 60, 4.0, 30, 30000);
    step(SOUTH_M - 120, 4.0, 30, 30000);

    // (4) ANFLYGNINGEN STANNAR AV på 1 080 m: samma position som förra provet
    //     ⇒ INSUFFICIENT_MOVEMENT ⇒ FÖRSTA valideringsmissen startar fristen.
    //     Fartsänkningen är 1,8 kn (< 2,0) så manöverskyddet armeras INTE här.
    step(SOUTH_M - 120, 2.2, 30, 30000);
    const graceStart = graceValue(svc, mmsi);

    // (5) MANÖVERN: ΔCOG 60° > 45° armerar manöverskyddet 30 s in i fristen.
    //     Farten hålls låg så valideringen fortsätter missa — det är hela
    //     poängen: skyddet armeras av samma manöver som fäller valideringen.
    step(SOUTH_M - 120, 1.8, 90, 30000);
    const protLines = loggedLines();
    const graceUnderProtection = graceValue(svc, mmsi);

    // (6) Ett skyddat meddelande till (ΔCOG 2° ⇒ ingen ny manöver, men skyddet
    //     lever kvar tills minimitiden 60 s passerats).
    step(SOUTH_M - 120, 1.8, 92, 35000);
    const graceLateProtection = graceValue(svc, mmsi);

    // (7) SKYDDET SLÄPPER: >60 s skyddstid, >500 m från målbron, ingen manöver
    //     kvar ⇒ _shouldDeactivateProtection ⇒ grace-blocket körs SAMMA tick.
    const vEnd = step(SOUTH_M - 120, 1.8, 92, 35000);
    return {
      v1,
      graceStart,
      protLines,
      graceUnderProtection,
      graceLateProtection,
      vEnd,
      endLines: loggedLines(),
    };
  }

  test('SKYDDSFÖNSTRET STÄMPLAR OM POSTEN — målet överlever skyddets slut', () => {
    const svc = makeVDS();
    const mmsi = '211999601';
    const r = korScenario(svc, mmsi);

    // Förutsättningarna som gör fyndet nåbart.
    expect(r.v1.targetBridge).toBe('Klaffbron');
    expect(Number.isFinite(r.graceStart)).toBe(true);
    expect(r.protLines.some((l) => l.includes('TARGET_PROTECTION_ACTIVE'))).toBe(true);
    // Kö-undantaget får inte vara det som räddar målet (1,2 km > 600 m).
    expect(r.protLines.some((l) => l.includes('TARGET_QUEUE_ZONE'))).toBe(false);

    // KÄRNAN 1: posten stämplas OM under skyddet — den varken raderas …
    expect(Number.isFinite(r.graceUnderProtection)).toBe(true);
    expect(r.graceUnderProtection).toBeGreaterThan(r.graceStart);
    // … eller står kvar och åldras (HEAD lämnade den på graceStart).
    expect(r.graceLateProtection).toBeGreaterThan(r.graceUnderProtection);

    // KÄRNAN 2: när skyddet släpper är fristen FÄRSK (35 s sedan senaste
    // skyddade meddelande), inte 100 s ⇒ ingen borttagning i samma tick.
    expect(r.vEnd.targetBridge).toBe('Klaffbron');
    expect(r.endLines.some((l) => l.includes('"Klaffbron" → "none"'))).toBe(false);
    expect(r.endLines.some((l) => l.includes('Grace period active'))).toBe(true);
  });

  test('FRISTEN LEVER VIDARE: nedräkningen fortsätter, den nollställs inte', () => {
    const svc = makeVDS();
    const mmsi = '211999602';
    korScenario(svc, mmsi);

    // Nästa miss 70 s efter skyddets slut ⇒ fristen HAR löpt ut och målet tas
    // bort. Omstämplingen skjuter alltså upp borttagningen ETT fönster; den
    // avskaffar den inte (skillnaden mot en radering, som ger ett HELT nytt
    // 60 s-fönster och mättes som regression i 41h-korpusen).
    NOW += 70000;
    logger.log.mockClear();
    logger.debug.mockClear();
    svc.updateVessel(mmsi, {
      mmsi,
      lat: KLAFF.lat - (SOUTH_M - 120) / M_PER_DEG_LAT,
      lon: KLAFF.lon,
      sog: 1.8,
      cog: 92,
      name: 'M6-TEST',
      timestamp: NOW,
    });
    expect(svc.vessels.get(mmsi).targetBridge).toBeNull();
    expect(loggedLines().some((l) => l.includes('"Klaffbron" → "none"'))).toBe(true);
  });

  test('_touchTargetGrace SKAPAR ALDRIG en post (bara nedräkningar som redan startat)', () => {
    const svc = makeVDS();
    svc._targetRemovalGrace = new Map();
    svc._touchTargetGrace('123456789', 'Klaffbron');
    expect([...svc._targetRemovalGrace.keys()]).toEqual([]);
    // Tolerant kontrakt (spegel av _clearTargetGrace): saknade argument ⇒ no-op.
    expect(() => svc._touchTargetGrace(null, 'Klaffbron')).not.toThrow();
    expect(() => svc._touchTargetGrace('123456789', null)).not.toThrow();
    // Finns posten sätts den till nu.
    svc._targetRemovalGrace.set('123456789:Klaffbron', NOW - 999000);
    svc._touchTargetGrace('123456789', 'Klaffbron');
    expect(svc._targetRemovalGrace.get('123456789:Klaffbron')).toBe(NOW);
  });
});
