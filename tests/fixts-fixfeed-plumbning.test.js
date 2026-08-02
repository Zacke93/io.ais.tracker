'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const VesselDataService = require('../lib/services/VesselDataService');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');

/**
 * Etapp 0 AISHub-förberedelse (2026-08-02): fixtid (fixTs) + källa (fixFeed)
 * ska följa varje meddelande genom hela kedjan app._processAISMessage →
 * vesselPatch → VesselDataService._createVesselObject → syntetiska
 * currentVessel i _handleGPSJumpDetection → GPSJumpAnalyzer, och fysik-dt
 * ska räknas på FIXSEPARATION när båda samplen bär fixtid från samma källa.
 *
 * BEVISKRAV (slutplanens etapp 0): fallbacken (mottagningstid) är annars
 * oskiljbar från korrekt implementation — testerna här konstruerar därför
 * fall där fixtids-dt och mottagningstids-dt ger OLIKA beslut, och låser
 * att fixtiden faktiskt används respektive att fallbacken tar över när
 * källorna skiljer sig eller fixtid saknas.
 */

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

describe('Etapp 0: fixTs/fixFeed genom app._processAISMessage → vesselPatch', () => {
  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._replayCaptureFile = null;
    app.vesselDataService = { updateVessel: jest.fn() };
    return app;
  }

  test('meddelande MED fixTs/fixFeed → patchen bär dem oförändrade', () => {
    const app = makeApp();
    app._processAISMessage({
      mmsi: '265001111', lat: 58.29, lon: 12.29, sog: 5.0, cog: 25, fixTs: 1754100000000, fixFeed: 'aishub',
    });
    expect(app.vesselDataService.updateVessel).toHaveBeenCalledTimes(1);
    const [, patch] = app.vesselDataService.updateVessel.mock.calls[0];
    expect(patch.fixTs).toBe(1754100000000);
    expect(patch.fixFeed).toBe('aishub');
  });

  test('meddelande UTAN fälten (aisstream idag) → identitet: fixTs = message.timestamp, fixFeed aisstream', () => {
    const app = makeApp();
    app._processAISMessage({
      mmsi: '265001111', lat: 58.29, lon: 12.29, sog: 5.0, cog: 25, timestamp: 1754100005000,
    });
    const [, patch] = app.vesselDataService.updateVessel.mock.calls[0];
    expect(patch.fixTs).toBe(1754100005000);
    expect(patch.fixFeed).toBe('aisstream');
  });

  test('varken fixTs eller timestamp → Date.now()-fallback (aldrig NaN/undefined)', () => {
    const app = makeApp();
    const before = Date.now();
    app._processAISMessage({
      mmsi: '265001111', lat: 58.29, lon: 12.29, sog: 5.0, cog: 25,
    });
    const after = Date.now();
    const [, patch] = app.vesselDataService.updateVessel.mock.calls[0];
    expect(patch.fixTs).toBeGreaterThanOrEqual(before);
    expect(patch.fixTs).toBeLessThanOrEqual(after);
    expect(patch.fixFeed).toBe('aisstream');
  });
});

describe('Etapp 0: GPSJumpAnalyzer räknar dt på fixtid inom samma källa', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Geometri: ~300 m nordförflyttning vid 58.29°N.
  const OLD_POS = { lat: 58.29, lon: 12.29 };
  const NEW_POS = { lat: 58.29 + 300 / 111320, lon: 12.29 };

  test('medium-grenen: fixtids-dt (3 min) friar rörelse som mottagningstids-dt (1 s) hade dömt', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const now = Date.now();
    // Mottagningstid säger 1 s sedan (fysiskt omöjligt för 300 m @ 3 kn) —
    // men fixen är 3 min gammal (helt rimligt). Fixtiden MÅSTE vinna.
    const oldVessel = {
      sog: 3, cog: 0, timestamp: now - 1000, fixTs: now - 180000, fixFeed: 'aisstream',
    };
    const currentVessel = {
      sog: 3, cog: 0, timestamp: now, fixTs: now, fixFeed: 'aisstream',
    };
    const result = analyzer.analyzeMovement('265001111', NEW_POS, OLD_POS, currentVessel, oldVessel);
    expect(result.action).toBe('accept');
    expect(result.reason).toBe('medium_movement');
  });

  test('medium-grenen: OLIKA källor → fallback till mottagningstid → suspect (negativ kontroll)', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const now = Date.now();
    const oldVessel = {
      sog: 3, cog: 0, timestamp: now - 1000, fixTs: now - 180000, fixFeed: 'aishub',
    };
    const currentVessel = {
      sog: 3, cog: 0, timestamp: now, fixTs: now, fixFeed: 'aisstream',
    };
    const result = analyzer.analyzeMovement('265001111', NEW_POS, OLD_POS, currentVessel, oldVessel);
    expect(result.action).toBe('accept_with_caution');
    expect(result.reason).toBe('medium_movement_speed_mismatch');
  });

  test('medium-grenen: fixTs saknas (null) → fallback till mottagningstid → suspect', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const now = Date.now();
    const oldVessel = {
      sog: 3, cog: 0, timestamp: now - 1000, fixTs: null, fixFeed: 'aisstream',
    };
    const currentVessel = {
      sog: 3, cog: 0, timestamp: now, fixTs: now, fixFeed: 'aisstream',
    };
    const result = analyzer.analyzeMovement('265001111', NEW_POS, OLD_POS, currentVessel, oldVessel);
    expect(result.action).toBe('accept_with_caution');
    expect(result.reason).toBe('medium_movement_speed_mismatch');
  });

  test('negativ fixtids-dt (klockbakhopp mellan fix) klampas som förut till 60 s', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const now = Date.now();
    // fixTs går BAKÅT 30 s: klampen ger 60 s ⇒ 6 kn × 60 s × 2.0 ≈ 370 m
    // tillåtet → 300 m frias. Hade koden i stället fallit till mottagnings-
    // tid (1 s → 0.001 h-golvet ⇒ ~22 m) hade rörelsen dömts — utfallet
    // skiljer alltså klampvägen från receipt-fallbacken.
    const oldVessel = {
      sog: 6, cog: 0, timestamp: now - 1000, fixTs: now + 30000, fixFeed: 'aisstream',
    };
    const currentVessel = {
      sog: 6, cog: 0, timestamp: now, fixTs: now, fixFeed: 'aisstream',
    };
    const result = analyzer.analyzeMovement('265001111', NEW_POS, OLD_POS, currentVessel, oldVessel);
    expect(result.action).toBe('accept');
    expect(result.reason).toBe('medium_movement');
  });

  test('storgrenen (>500 m): fixtids-dt friar det mottagningstids-dt dömt som GPS-hopp', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const now = Date.now();
    const FAR_POS = { lat: 58.29 + 700 / 111320, lon: 12.29 }; // ~700 m norrut
    // 700 m på 5 min @ 5 kn (fix-dt) är legitimt (~1543 m tillåtet);
    // på 2 s (receipt-dt) är det fysiskt omöjligt → gps_jump_detected.
    const oldVessel = {
      sog: 5, cog: 0, timestamp: now - 2000, fixTs: now - 300000, fixFeed: 'aisstream',
    };
    const currentVessel = {
      sog: 5, cog: 0, timestamp: now, fixTs: now, fixFeed: 'aisstream',
    };
    const withFix = analyzer.analyzeMovement('265001111', FAR_POS, OLD_POS, currentVessel, oldVessel);
    expect(withFix.isGPSJump).toBe(false);

    const noFixOld = { ...oldVessel, fixTs: null };
    const withoutFix = analyzer.analyzeMovement('265001111', FAR_POS, OLD_POS, currentVessel, noFixOld);
    expect(withoutFix.action).toBe('gps_jump_detected');
    expect(withoutFix.reason).toBe('physically_impossible_movement');
  });

  test('_checkSpeedConsistency (nya signaturen) räknar implied speed över fixtids-dt', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const now = Date.now();
    const oldVessel = {
      sog: 5, cog: 0, timestamp: now - 2000, fixTs: now - 300000, fixFeed: 'aisstream',
    };
    const currentVessel = {
      sog: 5, cog: 0, timestamp: now, fixTs: now, fixFeed: 'aisstream',
    };
    // 700 m på 300 s ⇒ ~4.5 kn implied — konsistent med sog 5.
    const res = analyzer._checkSpeedConsistency(700, currentVessel, oldVessel);
    expect(res.isConsistent).toBe(true);
    expect(res.impliedSpeed).toBeCloseTo((700 / 1852) / (300000 / 3600000), 1);
  });
});

describe('Etapp 0: GPSJumpGateService — fysikfönstret mäter fixseparation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    global.__TEST_MODE__ = true;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.__TEST_MODE__ = undefined;
  });

  test('_isVesselStable: fixElapsedMs (5 min) vidgar fönstret som mottagningsåldern (5 s) inte ger', () => {
    const gate = new GPSJumpGateService(makeLogger(), null);
    const oldState = {
      lat: 58.29, lon: 12.29, cog: 0, sog: 3,
    };
    const newState = {
      lat: 58.29 + 400 / 111320, lon: 12.29, cog: 0, sog: 3,
    };
    // Utan fixseparation: age 5 s ⇒ 200 m-golvet ⇒ 400 m är instabilt.
    expect(gate._isVesselStable(oldState, newState, 5000)).toBe(false);
    // Med fixseparation 5 min: 3 kn × 5 min × 2.0 ≈ 926 m ⇒ 400 m stabilt.
    expect(gate._isVesselStable(oldState, newState, 5000, 300000)).toBe(true);
  });

  test('confirmStableCandidates skickar fixseparationen när snapshot + vessel bär samma källa', () => {
    const gate = new GPSJumpGateService(makeLogger(), null);
    const now = Date.now();
    const vesselAtRegistration = {
      lat: 58.29, lon: 12.29, cog: 0, sog: 3, fixTs: now - 300000, fixFeed: 'aisstream',
    };
    gate.registerCandidatePassage('265001111', 'Klaffbron', { passed: true }, vesselAtRegistration);
    // Snapshotten ska bära fixtid/källa (etapp 0-fältet i vesselState).
    const candidate = gate._candidatePassages.get('265001111')[0];
    expect(candidate.vesselState.fixTs).toBe(now - 300000);
    expect(candidate.vesselState.fixFeed).toBe('aisstream');

    // 6 s senare (age > _confirmationPeriod 5 s), 400 m bort — bara den
    // äkta fixseparationen (5 min) kan bekräfta; mottagningsåldern 6 s
    // hade givit 200 m-golvet och övergivit en äkta passage.
    jest.advanceTimersByTime(6000);
    const confirmed = gate.confirmStableCandidates('265001111', {
      lat: 58.29 + 400 / 111320, lon: 12.29, cog: 0, sog: 3, fixTs: Date.now(), fixFeed: 'aisstream',
    });
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].bridgeName).toBe('Klaffbron');
  });
});

describe('Etapp 0: hela VDS-kedjan — fixTs når GPSJumpAnalyzer (beviskravet)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('updateVessel × 2 → analyzeMovement får currentVessel/oldVessel med fixTs+fixFeed, och vessel-objektet bär syskonfälten', () => {
    const logger = makeLogger();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
    const spy = jest.spyOn(service.gpsJumpAnalyzer, 'analyzeMovement');

    const t0 = Date.now();
    service.updateVessel('265001111', {
      lat: 58.29, lon: 12.29, sog: 3, cog: 0, name: 'FIXPROV', fixTs: t0 - 120000, fixFeed: 'aisstream',
    });
    const stored = service.vessels.get('265001111');
    expect(stored.fixTs).toBe(t0 - 120000);
    expect(stored.fixFeed).toBe('aisstream');
    // timestamp förblir mottagningstid (domän M) — INTE fixtiden.
    expect(stored.timestamp).toBe(t0);

    jest.advanceTimersByTime(1000);
    service.updateVessel('265001111', {
      lat: 58.29 + 150 / 111320, lon: 12.29, sog: 3, cog: 0, name: 'FIXPROV', fixTs: t0 + 1000, fixFeed: 'aisstream',
    });

    // Andra updaten har oldVessel → analyzern anropas; VDS:3779-3783-
    // plumbningen MÅSTE ha lagt fixTs/fixFeed i syntetiska currentVessel,
    // annars no-op:ar hela fixtids-dt-kedjan tyst (beviskravet).
    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    const [, , , currentVesselArg, oldVesselArg] = lastCall;
    expect(currentVesselArg.fixTs).toBe(t0 + 1000);
    expect(currentVesselArg.fixFeed).toBe('aisstream');
    expect(oldVesselArg.fixTs).toBe(t0 - 120000);
    expect(oldVesselArg.fixFeed).toBe('aisstream');
  });

  test('patch utan fixTs → vessel-objektet får Date.now()-identitet (defensivt, aldrig NaN)', () => {
    const logger = makeLogger();
    const service = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    service.updateVessel('265002222', {
      lat: 58.29, lon: 12.29, sog: 3, cog: 0, name: 'UTANFIX',
    });
    const stored = service.vessels.get('265002222');
    expect(stored.fixTs).toBe(Date.now());
    expect(stored.fixFeed).toBe('aisstream');
  });
});
