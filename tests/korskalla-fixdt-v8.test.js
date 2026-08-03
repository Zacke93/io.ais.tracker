'use strict';

jest.mock('homey');

const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const constants = require('../lib/constants');

/**
 * V8 (A/B-nattkörningen 2026-08-03) — KORSKÄLLEPAR OCH FIXTIDS-FYSIKEN.
 *
 * Etapp 0 införde fixtids-dt men BARA inom samma källa; korskällepar föll
 * tillbaka på MOTTAGNINGSTID — exakt den blandning klockdomändoktrinen
 * förbjuder. Nattkörningen visade att det inte är ett teoretiskt hål:
 *   - 554 av 1131 konsekutiva accepterade fixpar (49,0 %) i 'both'-läget
 *     bytte källa, alltså nästan varannan uppdatering.
 *   - JUNO 265576720 kl. 05:54:47 (aishub→aisstream) flyttade 245 m mellan
 *     två fixar som MOTTOGS 17 s isär men vars FIXTIDER låg 51 s isär.
 *     Mottagnings-dt ⇒ 28,6 kn implicerat mot verkliga 9,4 ⇒ enda
 *     accept_with_caution-domen i hela 100–500 m-bandet (95 par) ⇒
 *     vessel._positionUncertain ⇒ _shouldAssignTargetBridge avvisar mål.
 *   - Nordprogressgrinden söder om Kanalinfarten mätte samma sak: TIM
 *     212571000 kl. 21:50:22 fick 0,259 m/s på mottagnings-dt (19 s) men
 *     0,146 m/s på den äkta separationen (33 s) — grinden släppte igenom
 *     på en nordfart som aldrig funnits.
 *
 * BEVISKRAV (samma som etapp 0): fallbacken är annars oskiljbar från korrekt
 * implementation. Varje test nedan konstruerar därför ett fall där fixtids-dt
 * och mottagningstids-dt ger OLIKA beslut.
 *
 * FACITSÄKERHET: reglerna nedan kan per konstruktion bara fyra när två
 * konsekutiva sampel bär OLIKA fixFeed. Alla 15 låsta korpusar (och natt-A)
 * är enkällade — där är fixFeed alltid 'aisstream' och koden identisk med
 * före ändringen. Verifierat i körning: 83/83 anrop enkälliga i natt-A,
 * 124 korskälleanvändningar i natt-B.
 */

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

const MIN_DT = constants.AIS_CONFIG.FUSION.CROSS_FEED_MIN_FIX_DT_MS;

describe('V8: GPSJumpAnalyzer.fixDtMs — kanonisk klockdomänregel', () => {
  const base = 1785736000000;

  test('SAMMA källa: fixseparationen returneras oförändrat (etapp 0, oförändrat)', () => {
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + 60000, fixFeed: 'aisstream' },
      { fixTs: base, fixFeed: 'aisstream' },
    )).toBe(60000);
  });

  test('SAMMA källa: NEGATIV separation lämnas kvar åt anroparens klamp (får inte bli null)', () => {
    // Regressionsvakt: skulle korskällevakten råka gälla samma källa hade
    // klockbakhoppsklampen (60 s) i analyzern tystats och en NTP-korrigering
    // hade fallit till mottagningstid i stället.
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base - 30000, fixFeed: 'aisstream' },
      { fixTs: base, fixFeed: 'aisstream' },
    )).toBe(-30000);
  });

  test('KORSKÄLLA: framåt separation som VIDGAR mottagningsfönstret används (V8:s kärna)', () => {
    // JUNO-fallet: mottogs 17 s isär, fixarna låg 51 s isär ⇒ hubbens
    // pollfördröjning tryckte ihop leveranserna och 51 s ÄR den sanna dt:n.
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + 51000, fixFeed: 'aisstream', timestamp: base + 51000 },
      { fixTs: base, fixFeed: 'aishub', timestamp: base + 34000 },
    )).toBe(51000);
  });

  test('KORSKÄLLA: separation som KRYMPER fönstret ⇒ null (granskningsrunda 2)', () => {
    // TIDAN 231907000 23:56:56→23:57:05: fixseparation 2491 ms mot 9 s
    // mottagning. Ett kortare fönster INFLATERAR varje härledd fart (9,7-11,5
    // kn implicerat mot rapporterade 5,1) och släpper kajvobbelgrindar som
    // finns för att stoppa PRICKBJORN-klassen. V8 får bara VIDGA.
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + 2491, fixFeed: 'aishub', timestamp: base + 9000 },
      { fixTs: base, fixFeed: 'aisstream', timestamp: base },
    )).toBeNull();
  });

  test('KORSKÄLLA: vidgning bortom sanitetstaket ⇒ null (klock-/dataanomali)', () => {
    const cap = constants.AIS_CONFIG.FUSION.CROSS_FEED_MAX_FIX_DT_EXCESS_MS;
    // Precis på taket accepteras …
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + 10000 + cap, fixFeed: 'aisstream', timestamp: base + 10000 },
      { fixTs: base, fixFeed: 'aishub', timestamp: base },
    )).toBe(10000 + cap);
    // … en millisekund över förkastas.
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + 10000 + cap + 1, fixFeed: 'aisstream', timestamp: base + 10000 },
      { fixTs: base, fixFeed: 'aishub', timestamp: base },
    )).toBeNull();
  });

  test('KORSKÄLLA: mottagningstid saknas på någon sida ⇒ null (inget att jämföra mot)', () => {
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + 51000, fixFeed: 'aisstream' },
      { fixTs: base, fixFeed: 'aishub', timestamp: base + 34000 },
    )).toBeNull();
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + 51000, fixFeed: 'aisstream', timestamp: base + 51000 },
      { fixTs: base, fixFeed: 'aishub' },
    )).toBeNull();
  });

  test('KORSKÄLLA: separation ≤ 0 ⇒ null (släpande hub-fix får aldrig backa fysiken)', () => {
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base - 1, fixFeed: 'aishub', timestamp: base + 1000 },
      { fixTs: base, fixFeed: 'aisstream', timestamp: base },
    )).toBeNull();
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base, fixFeed: 'aishub', timestamp: base + 1000 },
      { fixTs: base, fixFeed: 'aisstream', timestamp: base },
    )).toBeNull();
  });

  test('KORSKÄLLA: separation under sekundgolvet ⇒ null (AISHubs TIME är sekundupplöst)', () => {
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + MIN_DT - 1, fixFeed: 'aishub', timestamp: base + MIN_DT - 1 },
      { fixTs: base, fixFeed: 'aisstream', timestamp: base },
    )).toBeNull();
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + MIN_DT, fixFeed: 'aishub', timestamp: base + MIN_DT },
      { fixTs: base, fixFeed: 'aisstream', timestamp: base },
    )).toBe(MIN_DT);
  });

  test('okänd källa på NÅGON sida ⇒ null (kan inte avgöra samma/kors)', () => {
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + 60000, fixFeed: null, timestamp: base + 60000 },
      { fixTs: base, fixFeed: 'aisstream', timestamp: base },
    )).toBeNull();
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: base + 60000, fixFeed: 'aisstream', timestamp: base + 60000 },
      { fixTs: base, fixFeed: null, timestamp: base },
    )).toBeNull();
  });

  test('saknad/icke-finit fixTs ⇒ null (defensivt, aldrig NaN i fysiken)', () => {
    expect(GPSJumpAnalyzer.fixDtMs(
      { fixTs: null, fixFeed: 'aishub' },
      { fixTs: base, fixFeed: 'aisstream' },
    )).toBeNull();
    expect(GPSJumpAnalyzer.fixDtMs(null, { fixTs: base, fixFeed: 'aisstream' })).toBeNull();
  });
});

describe('V8: JUNO-fallet i medium-grenen (100–500 m)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-03T05:54:47.412Z'));
  });
  afterEach(() => jest.useRealTimers());

  // Nattens verkliga tal: 245 m, mottagningsseparation 17 s, fixseparation
  // 51 s, sog 9,6 → 9,4 kn.
  const OLD_POS = { lat: 58.29, lon: 12.29 };
  const NEW_POS = { lat: 58.29 + 245 / 111320, lon: 12.29 };

  function junoPair(overrides = {}) {
    const now = Date.now();
    return {
      oldVessel: {
        sog: 9.6, cog: 0, timestamp: now - 17000, fixTs: now - 51000, fixFeed: 'aishub', ...(overrides.old || {}),
      },
      currentVessel: {
        sog: 9.4, cog: 0, timestamp: now, fixTs: now, fixFeed: 'aisstream', ...(overrides.cur || {}),
      },
    };
  }

  test('korskälla med framåt fixseparation friar 245 m som mottagnings-dt dömde', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const { oldVessel, currentVessel } = junoPair();
    const result = analyzer.analyzeMovement('265576720', NEW_POS, OLD_POS, currentVessel, oldVessel);
    expect(result.action).toBe('accept');
    expect(result.reason).toBe('medium_movement');
  });

  test('negativ kontroll: SAMMA par utan fixtid ⇒ mottagnings-dt ⇒ accept_with_caution', () => {
    // Beviskravet: utfallet ovan kan bara komma från fixseparationen.
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const { oldVessel, currentVessel } = junoPair({ old: { fixTs: null } });
    const result = analyzer.analyzeMovement('265576720', NEW_POS, OLD_POS, currentVessel, oldVessel);
    expect(result.action).toBe('accept_with_caution');
    expect(result.reason).toBe('medium_movement_speed_mismatch');
  });

  test('negativ kontroll: korskälla där hub-fixen är ÄLDRE ⇒ fallback ⇒ accept_with_caution', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const now = Date.now();
    const oldVessel = {
      sog: 9.6, cog: 0, timestamp: now - 17000, fixTs: now, fixFeed: 'aisstream',
    };
    const currentVessel = {
      sog: 9.4, cog: 0, timestamp: now, fixTs: now - 51000, fixFeed: 'aishub',
    };
    const result = analyzer.analyzeMovement('265576720', NEW_POS, OLD_POS, currentVessel, oldVessel);
    expect(result.action).toBe('accept_with_caution');
  });

  test('_checkSpeedConsistency: 9,3 kn implicerat över fixseparation mot 28,6 kn över mottagningstid', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const { oldVessel, currentVessel } = junoPair();
    const withFix = analyzer._checkSpeedConsistency(245, currentVessel, oldVessel);
    expect(withFix.impliedSpeed).toBeCloseTo(9.3, 0);
    expect(withFix.isConsistent).toBe(true);

    const withoutFix = analyzer._checkSpeedConsistency(245, currentVessel, { ...oldVessel, fixTs: null });
    expect(withoutFix.impliedSpeed).toBeCloseTo(28.0, 0);
    expect(withoutFix.isConsistent).toBe(false);
  });
});

describe('V8: storgrenen (>500 m) räknar korskällepar på fixseparation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-03T06:17:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  const OLD_POS = { lat: 58.29, lon: 12.29 };
  const FAR_POS = { lat: 58.29 + 700 / 111320, lon: 12.29 };

  test('700 m på 5 min fixseparation är legitimt trots 2 s mottagningsseparation', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const now = Date.now();
    const oldVessel = {
      sog: 5, cog: 0, timestamp: now - 2000, fixTs: now - 300000, fixFeed: 'aishub',
    };
    const currentVessel = {
      sog: 5, cog: 0, timestamp: now, fixTs: now, fixFeed: 'aisstream',
    };
    expect(analyzer.analyzeMovement('219001291', FAR_POS, OLD_POS, currentVessel, oldVessel).isGPSJump)
      .toBe(false);

    // Utan användbar korskälleseparation (bakåt) gäller dagens dom.
    const backwards = analyzer.analyzeMovement(
      '219001291', FAR_POS, OLD_POS,
      { ...currentVessel, fixTs: now - 600000, fixFeed: 'aishub' },
      { ...oldVessel, fixTs: now, fixFeed: 'aisstream' },
    );
    expect(backwards.action).toBe('gps_jump_detected');
    expect(backwards.reason).toBe('physically_impossible_movement');
  });
});

describe('V8: GPSJumpGateService bekräftar kandidater över källgränsen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-03T00:00:00.000Z'));
    global.__TEST_MODE__ = true;
  });
  afterEach(() => {
    jest.useRealTimers();
    global.__TEST_MODE__ = undefined;
  });

  function register(gate, fixFeed, fixTs) {
    gate.registerCandidatePassage('212571000', 'Klaffbron', { passed: true }, {
      lat: 58.29, lon: 12.29, cog: 0, sog: 3, fixTs, fixFeed, timestamp: Date.now(),
    });
  }

  test('kandidat på aisstream-fix + bekräftelse på AISHub-fix ⇒ fixseparationen (5 min) gäller', () => {
    const gate = new GPSJumpGateService(makeLogger(), null);
    const t0 = Date.now();
    register(gate, 'aisstream', t0 - 300000);
    jest.advanceTimersByTime(6000);
    const confirmed = gate.confirmStableCandidates('212571000', {
      lat: 58.29 + 400 / 111320,
      lon: 12.29,
      cog: 0,
      sog: 3,
      fixTs: t0,
      fixFeed: 'aishub',
      timestamp: Date.now(),
    });
    // 3 kn × 5 min × 2,0 ≈ 926 m ⇒ 400 m stabilt. Mottagningsåldern (6 s)
    // hade givit 200 m-golvet och övergivit en äkta passage.
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].bridgeName).toBe('Klaffbron');
  });

  test('negativ kontroll: korskälla med BAKÅT separation ⇒ 200 m-golvet ⇒ ingen bekräftelse', () => {
    const gate = new GPSJumpGateService(makeLogger(), null);
    const t0 = Date.now();
    register(gate, 'aisstream', t0);
    jest.advanceTimersByTime(6000);
    const confirmed = gate.confirmStableCandidates('212571000', {
      lat: 58.29 + 400 / 111320, lon: 12.29, cog: 0, sog: 3, fixTs: t0 - 300000, fixFeed: 'aishub',
    });
    expect(confirmed).toHaveLength(0);
  });
});

describe('V8: nordprogressgrinden söder om Kanalinfarten (TIM-fallet)', () => {
  const ENTRY_LAT = constants.TRIGGER_POINTS.kanalinfarten.lat;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T21:50:22.960Z'));
  });
  afterEach(() => jest.useRealTimers());

  function makeService(logger) {
    return new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  }

  // Nattens verkliga geometri: 4,8 m nordförflyttning, mottagnings-dt 19 s
  // (0,259 m/s ⇒ SLÄPPS IGENOM), fixseparation 33 s (0,146 m/s ⇒ BLOCKERAS).
  function timPair({
    oldFeed, curFeed, oldFixTs, curFixTs,
  }) {
    const now = Date.now();
    const oldLat = ENTRY_LAT - 0.002;
    return {
      oldVessel: {
        mmsi: '212571000',
        lat: oldLat,
        lon: 12.28,
        sog: 3.2,
        timestamp: now - 19000,
        lastPositionUpdate: now - 19000,
        fixTs: oldFixTs,
        fixFeed: oldFeed,
        _hasMovementProof: true,
        passedBridges: [],
      },
      vessel: {
        mmsi: '212571000',
        lat: oldLat + 4.8 / 111320,
        lon: 12.28,
        sog: 3.3,
        timestamp: now,
        lastPositionUpdate: now,
        fixTs: curFixTs,
        fixFeed: curFeed,
        _hasMovementProof: true,
        passedBridges: [],
      },
    };
  }

  function blockedForWobble(logger) {
    return logger.debug.mock.calls
      .some((args) => String(args[0]).includes('quay wobble, blocking target assignment'));
  }

  test('korskälla: äkta fixseparation (33 s) avslöjar 0,15 m/s och BLOCKERAR', () => {
    const logger = makeLogger();
    const service = makeService(logger);
    const now = Date.now();
    const { vessel, oldVessel } = timPair({
      oldFeed: 'aishub', curFeed: 'aisstream', oldFixTs: now - 33000, curFixTs: now,
    });
    expect(service._shouldAssignTargetBridge(vessel, oldVessel)).toBe(false);
    expect(blockedForWobble(logger)).toBe(true);
  });

  test('negativ kontroll: samma par utan fixtid ⇒ mottagnings-dt (19 s) ⇒ INTE blockerad av grinden', () => {
    // Beviskravet: 0,259 m/s > 0,25-tröskeln, alltså exakt den falska
    // nordfart som pollfördröjningen fabricerade.
    const logger = makeLogger();
    const service = makeService(logger);
    const now = Date.now();
    const { vessel, oldVessel } = timPair({
      oldFeed: 'aishub', curFeed: 'aisstream', oldFixTs: null, curFixTs: now,
    });
    service._shouldAssignTargetBridge(vessel, oldVessel);
    expect(blockedForWobble(logger)).toBe(false);
  });

  test('negativ kontroll: korskälla med BAKÅT separation ⇒ dagens mottagnings-dt gäller', () => {
    const logger = makeLogger();
    const service = makeService(logger);
    const now = Date.now();
    const { vessel, oldVessel } = timPair({
      oldFeed: 'aisstream', curFeed: 'aishub', oldFixTs: now, curFixTs: now - 33000,
    });
    service._shouldAssignTargetBridge(vessel, oldVessel);
    expect(blockedForWobble(logger)).toBe(false);
  });

  test('SAMMA källa: oförändrat beteende (fixseparationen gällde redan i etapp 0)', () => {
    const logger = makeLogger();
    const service = makeService(logger);
    const now = Date.now();
    const { vessel, oldVessel } = timPair({
      oldFeed: 'aisstream', curFeed: 'aisstream', oldFixTs: now - 33000, curFixTs: now,
    });
    expect(service._shouldAssignTargetBridge(vessel, oldVessel)).toBe(false);
    expect(blockedForWobble(logger)).toBe(true);
  });
});
