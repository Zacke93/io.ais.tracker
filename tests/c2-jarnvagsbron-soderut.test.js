'use strict';

jest.mock('homey');

/**
 * Fältprovet 2026-11-12/13, körning 2 (familj C, fel C2): JÄRNVÄGSBRON SÖDERUT.
 *
 * Järnvägsbron ligger ~257 m söder om Stridsbergsbron. Den fix som bokför
 * Stridsbergsbron söderut ligger därför redan i Järnvägsbrons 300 m-zon. Tre led
 * höll ändå notisen för Järnvägsbron tills broöppningsfönstret (30 s) gått ut:
 *  1. Phase 3-hållningen håller currentBridge på den passerade Stridsbergsbron.
 *  2. FIX U:s tvingade väntan vid parbron väntar på att fönstret går ut.
 *  3. Kandidatvalet erbjuder target/current/just-passed, och nearest bara när
 *     inget annat finns. Järnvägsbron söderut var ingen av dem.
 * Vakthunden (var 30:e s) tvingade sedan väntan på den gamla fixen och notisen
 * kom 23 s efter till 4 s före passagen (ASPEN, WILSON ALSTER, NORDIC SOLA).
 *
 * Dessutom mätte FIX U bara avståndet till parbron. Låg fixen strax söder om
 * Järnvägsbron (PRICKBJORN 13:56:38, 23 m bortom linjen) tvingade varje
 * statuspass före nästa fix "väntan" vid en bro båten redan passerat, och
 * notisen blev "närmar sig Järnvägsbron, beräknad ankomst strax".
 *
 * Positionerna nedan är egna: de ligger på farledens mittlinje
 * (scenarioGenerator.pointAt), ett givet antal meter från broarna.
 */

const AISBridgeApp = require('../app');
const StatusService = require('../lib/services/StatusService');
const ProximityService = require('../lib/services/ProximityService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');
const { buildPath, pathMetrics, pointAt } = require('./replay-validation/scenarioGenerator');

const PATH = buildPath();
const METRICS = pathMetrics(PATH);
const JVB = BRIDGES.jarnvagsbron;
const STRIDS = BRIDGES.stridsbergsbron;
const MMSI = '265900123';
const T0 = 1794533536115;

// Punkt på mittlinjen `meters` norr (+) eller söder (−) om Järnvägsbron.
const nearJvb = (meters) => {
  const p = pointAt(PATH, METRICS, METRICS.cum[3] + meters);
  return { lat: p.lat, lon: p.lon };
};

const logger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/**
 * Läget i den tick som bokför Stridsbergsbron söderut: FIX U-flaggan och
 * broöppningsfönstret är satta, currentBridge hålls på Stridsbergsbron.
 */
function vesselAfterStridsPassage(jvbOffsetM, extra = {}) {
  return {
    mmsi: MMSI,
    name: 'SYNT-SODER',
    ...nearJvb(jvbOffsetM),
    sog: 6.3,
    _rawPositionSog: 6.3,
    cog: 217,
    timestamp: T0,
    lastPositionUpdate: T0,
    fixTs: T0,
    fixFeed: 'aisstream',
    _routeDirection: 'south',
    _hasMovementProof: true,
    status: 'under-bridge',
    currentBridge: 'Stridsbergsbron',
    targetBridge: 'Klaffbron',
    lastPassedBridge: 'Stridsbergsbron',
    lastPassedBridgeTime: T0,
    passedBridges: ['Stallbackabron', 'Stridsbergsbron'],
    _forceWaitingAtBridge: { bridge: 'Järnvägsbron', until: T0 + 90000, triggeredBy: 'Stridsbergsbron' },
    _bridgeOpeningUntil: T0 + 30000,
    _bridgeOpeningBridgeName: 'Stridsbergsbron',
    ...extra,
  };
}

describe('geometrin i testet', () => {
  test('punkterna ligger där testet säger', () => {
    expect(geometry.bridgeLineOffsetM(nearJvb(196), JVB)).toBeCloseTo(196, -1);
    expect(geometry.bridgeLineOffsetM(nearJvb(-23), JVB)).toBeCloseTo(-23, -1);
    // Fixen 196 m norr om Järnvägsbron ligger söder om Stridsbergsbron.
    expect(geometry.decisiveBridgeSide(nearJvb(196), STRIDS)).toBe(-1);
  });
});

describe('C2: FIX U tvingar ingen väntan vid en parbro som båten redan passerat', () => {
  let status;
  let proximity;
  let log;

  beforeEach(() => {
    jest.useFakeTimers();
    // Vakthundens pass 44 s efter bokföringen: fönstret har gått ut.
    jest.setSystemTime(T0 + 44000);
    log = logger();
    const registry = new BridgeRegistry();
    status = new StatusService(registry, log, new SystemCoordinator(log));
    proximity = new ProximityService(registry, log);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const pass = (vessel) => {
    const events = [];
    status.on('status:changed', (e) => events.push(e));
    const result = status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), null);
    return { result, events };
  };

  test('PRICKBJORN-fallet: fixen 23 m söder om Järnvägsbron ger ingen tvingad väntan där', () => {
    const vessel = vesselAfterStridsPassage(-23);
    const { result, events } = pass(vessel);
    expect(result.statusReason).not.toBe('FIX_U_forced_waiting_close_bridge_pair');
    expect(events.some((e) => e.reason === 'FIX_U_forced_waiting_close_bridge_pair')).toBe(false);
    expect(vessel._forceWaitingAtBridge).toBeNull();
    expect(vessel.waitingAtBridge).not.toBe('Järnvägsbron');
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('FIX_U_SKIP_PAST_LINE'));
  });

  test('flaggan rensas redan medan fönstret håller den vilande', () => {
    jest.setSystemTime(T0 + 5000);
    const vessel = vesselAfterStridsPassage(-23);
    pass(vessel);
    expect(vessel._forceWaitingAtBridge).toBeNull();
  });

  test.each([
    ['196 m norr om bron (ASPEN-fallet)', 196],
    ['på linjen, inom appens ±10 m', -6],
  ])('%s: väntan tvingas som förut', (_label, offsetM) => {
    const vessel = vesselAfterStridsPassage(offsetM);
    const { result, events } = pass(vessel);
    expect(result.statusReason).toBe('FIX_U_forced_waiting_close_bridge_pair');
    expect(events.some((e) => e.reason === 'FIX_U_forced_waiting_close_bridge_pair')).toBe(true);
    expect(vessel.currentBridge).toBe('Järnvägsbron');
  });

  // Buggjägaren efter sammanslagningen (2026-11-14, familj C3): C2 rensade
  // flaggan redan 10 m bortom linjen, alltså inom en båtlängd. Låg passagefixen
  // 12–31 m bortom Järnvägsbron och bearbetades utan broöppningsfönster (båten
  // låg redan under Stridsbergsbron), gav basen notisen "närmar sig … strax" i
  // samma pass. Efter C2 kom den via failsafen minuter senare (FREJA 2 +367 s,
  // BRISEN +202 s). I fixens eget pass (meddelandevägens rena positionsanalys)
  // och inom UNDER_BRIDGE_SET_DISTANCE behålls väntan som i basen.
  const ownFixAnalysis = { gpsJumpDetected: false, positionUncertain: false, analysis: { isGPSJump: false } };
  const ownFixPass = (vessel) => {
    const events = [];
    status.on('status:changed', (e) => events.push(e));
    const result = status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), ownFixAnalysis);
    return { result, events };
  };

  test.each([
    ['FREJA 2, 12 m bortom linjen', -12],
    ['BRISEN, 31 m bortom linjen', -31],
  ])('%s i fixens eget pass utan broöppningsfönster: väntan tvingas som i basen', (_label, offsetM) => {
    jest.setSystemTime(T0);
    const vessel = vesselAfterStridsPassage(offsetM, {
      _bridgeOpeningUntil: null, _bridgeOpeningBridgeName: null, status: 'under-bridge',
    });
    const { result, events } = ownFixPass(vessel);
    expect(result.statusReason).toBe('FIX_U_forced_waiting_close_bridge_pair');
    expect(events.some((e) => e.reason === 'FIX_U_forced_waiting_close_bridge_pair')).toBe(true);
    expect(vessel.currentBridge).toBe('Järnvägsbron');
    expect(log.debug).not.toHaveBeenCalledWith(expect.stringContaining('FIX_U_SKIP_PAST_LINE'));
  });

  test('mer än 50 m bortom linjen ges ingen tvingad väntan, inte heller i fixens eget pass', () => {
    jest.setSystemTime(T0);
    const vessel = vesselAfterStridsPassage(-60, { _bridgeOpeningUntil: null, _bridgeOpeningBridgeName: null });
    const { result, events } = ownFixPass(vessel);
    expect(result.statusReason).not.toBe('FIX_U_forced_waiting_close_bridge_pair');
    expect(events.some((e) => e.reason === 'FIX_U_forced_waiting_close_bridge_pair')).toBe(false);
    expect(vessel._forceWaitingAtBridge).toBeNull();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('FIX_U_SKIP_PAST_LINE'));
  });

  test('PRICKBJORN med fönstret aktivt: flaggan står vilande i fixens pass, vakthunden efter fönstret rensar den', () => {
    // OSPREY-klassen: basens notis kom från ett senare pass på den gamla fixen
    // och var falsk. Den ska inte komma tillbaka.
    jest.setSystemTime(T0);
    const vessel = vesselAfterStridsPassage(-23);
    let { result } = ownFixPass(vessel);
    expect(result.statusReason).not.toBe('FIX_U_forced_waiting_close_bridge_pair');
    expect(vessel._forceWaitingAtBridge).toMatchObject({ bridge: 'Järnvägsbron' });
    jest.setSystemTime(T0 + 44000);
    const events = [];
    status.on('status:changed', (e) => events.push(e));
    result = status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), null);
    expect(result.statusReason).not.toBe('FIX_U_forced_waiting_close_bridge_pair');
    expect(events.some((e) => e.reason === 'FIX_U_forced_waiting_close_bridge_pair')).toBe(false);
    expect(vessel._forceWaitingAtBridge).toBeNull();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('FIX_U_SKIP_PAST_LINE'));
  });

  test('utan känd utlösande bro avgör ruttriktningen', () => {
    const registry = new BridgeRegistry();
    const past = vesselAfterStridsPassage(-23, {
      _forceWaitingAtBridge: { bridge: 'Järnvägsbron', until: T0 + 90000, triggeredBy: 'passage_Stridsbergsbron' },
    });
    expect(StatusService.isBeyondForcedWaitingBridge(past, past._forceWaitingAtBridge, registry)).toBe(true);
    const ahead = vesselAfterStridsPassage(196, { _forceWaitingAtBridge: past._forceWaitingAtBridge });
    expect(StatusService.isBeyondForcedWaitingBridge(ahead, ahead._forceWaitingAtBridge, registry)).toBe(false);
    const noRoute = vesselAfterStridsPassage(-23, {
      _routeDirection: null, _forceWaitingAtBridge: past._forceWaitingAtBridge,
    });
    expect(StatusService.isBeyondForcedWaitingBridge(noRoute, noRoute._forceWaitingAtBridge, registry)).toBe(false);
  });

  test('en GPS-flaggad position bevisar ingen passage', () => {
    const registry = new BridgeRegistry();
    for (const flag of ['_gpsJumpDetected', '_positionUncertain']) {
      const vessel = vesselAfterStridsPassage(-23, { [flag]: true });
      expect(StatusService.isBeyondForcedWaitingBridge(vessel, vessel._forceWaitingAtBridge, registry)).toBe(false);
    }
  });
});

describe('C2: notisen för Järnvägsbron går på fixen som bokför Stridsbergsbron', () => {
  let savedEnv;
  let nowSpy;
  let NOW;

  function makeApp() {
    const registry = new BridgeRegistry();
    const app = Object.create(AISBridgeApp.prototype);
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = registry;
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app.proximityService = new ProximityService(registry, logger());
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._persistRecentTriggers = jest.fn();
    app._quayStableLedger = new Map();
    app._openingQuayLedger = new Map();
    app._lastKnownPositions = new Map();
    app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * 60 * 1000;
    app._boatNearTrigger = { trigger: jest.fn().mockResolvedValue(undefined) };
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
    return app;
  }
  const candidates = (app, vessel) => app._getFlowTriggerCandidates(
    vessel, app.proximityService.analyzeVesselProximity(vessel),
  );
  const jvbNotices = (app) => app._triggerBoatNearFlowBest.mock.calls
    .filter(([tokens]) => tokens.bridge_name === 'Järnvägsbron');

  beforeEach(() => {
    NOW = T0;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => NOW);
    // _triggerBoatNearFlow kortsluter i testläge (samma teknik som S4-sviten).
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;
  });

  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = true;
    nowSpy.mockRestore();
  });

  test('ASPEN-fallet: Järnvägsbron 196 m bort erbjuds och notifieras i passageticken', async () => {
    const app = makeApp();
    const vessel = vesselAfterStridsPassage(196);
    const jvb = candidates(app, vessel).find((c) => c.name === 'Järnvägsbron');
    expect(jvb).toMatchObject({ source: 'current' });
    expect(jvb.distance).toBeGreaterThan(180);
    expect(jvb.distance).toBeLessThan(210);

    await app._triggerBoatNearFlow(vessel);
    const notices = jvbNotices(app);
    expect(notices).toHaveLength(1);
    const [tokens, state] = notices[0];
    expect(tokens.message).toBe('SYNT-SODER närmar sig Järnvägsbron, beräknad ankomst om 1 minut');
    expect(tokens.already_passed).toBe(false);
    expect(state.source).toBe('current');

    // Vakthunden 44 s senare: FIX U har gjort Järnvägsbron till current och
    // statusbytet försöker igen. Ingen andra notis.
    NOW = T0 + 44000;
    Object.assign(vessel, {
      currentBridge: 'Järnvägsbron', status: 'waiting', _forceWaitingAtBridge: null, _bridgeOpeningUntil: null,
    });
    await app._triggerBoatNearFlow(vessel);
    expect(jvbNotices(app)).toHaveLength(1);
  });

  test('PRICKBJORN-fallet: en parbro bakom båten erbjuds inte och får ingen förvarning', async () => {
    const app = makeApp();
    const vessel = vesselAfterStridsPassage(-23);
    expect(candidates(app, vessel).map((c) => c.name)).not.toContain('Järnvägsbron');
    await app._triggerBoatNearFlow(vessel);
    expect(jvbNotices(app)).toHaveLength(0);
  });

  test('utgången flagga eller redan bokförd parbro ger ingen extra kandidat', () => {
    const app = makeApp();
    NOW = T0 + 91000;
    expect(candidates(app, vesselAfterStridsPassage(196)).map((c) => c.name)).not.toContain('Järnvägsbron');
    NOW = T0;
    const booked = vesselAfterStridsPassage(196, {
      passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron'],
    });
    expect(candidates(app, booked).map((c) => c.name)).not.toContain('Järnvägsbron');
  });

  test('loggen säger att parbron erbjuds, en gång per FIX U-flagga (granskningen L-4)', () => {
    const app = makeApp();
    const vessel = vesselAfterStridsPassage(196);
    const pairLines = () => app.debug.mock.calls.filter(([m]) => String(m).includes('FIX_U_PAIR_CANDIDATE'));
    candidates(app, vessel);
    candidates(app, vessel);
    expect(pairLines()).toHaveLength(1);
    expect(pairLines()[0][0]).toContain('currentBridge=Stridsbergsbron');
    // En ny flagga (nästa passage) loggas igen; en parbro bakom båten loggas inte.
    vessel._forceWaitingAtBridge = { ...vessel._forceWaitingAtBridge };
    candidates(app, vessel);
    expect(pairLines()).toHaveLength(2);
    candidates(app, vesselAfterStridsPassage(-23));
    expect(pairLines()).toHaveLength(2);
  });

  test('utan FIX U-flagga är kandidatvalet oförändrat', () => {
    const app = makeApp();
    const vessel = vesselAfterStridsPassage(196, { _forceWaitingAtBridge: null });
    expect(candidates(app, vessel).map((c) => c.name)).not.toContain('Järnvägsbron');
  });
});

/**
 * Familj C3 (2026-11-14): MOTFALLET SOM LÅSER C2:S VINST I BANKEN. OSPREY
 * (20260601-41h) bokförde Stridsbergsbron 09:59:39 på en fix 19 m bortom
 * Järnvägsbron, med broöppningsfönstret aktivt. Basen tvingade väntan i
 * vakthundens senare pass på den fixen (10:00:30) och skickade "närmar sig
 * Järnvägsbron, beräknad ankomst strax" för en bro hon passerat. C3 behåller
 * väntan bara i fixens eget pass inom 50 m; vakthundens pass rensar den som i
 * C2, så notisen blir passerad form.
 */
describe('C3: OSPREY-klassen i banken får ingen förvarning för den passerade bron', () => {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const corpora = require('./replay-validation/corpora');
  let notices;

  beforeAll(() => {
    const corpus = corpora.find((entry) => entry.id === '20260601-41h');
    const stdout = execFileSync(process.execPath, [
      path.join(__dirname, 'replay-validation/replayRunner.js'), corpus.jsonl,
    ], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: '', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
      },
    });
    notices = JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]).notifications
      .filter((n) => String(n.mmsi) === '265035480' && n.bridge === 'Järnvägsbron');
  }, 70000);

  test('Järnvägsbron söderut kommer i passerad form, aldrig som "närmar sig"', () => {
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ direction: 'southbound', alreadyPassed: true });
    expect(notices[0].message).not.toMatch(/närmar sig/);
  });
});
