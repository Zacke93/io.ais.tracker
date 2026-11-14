'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const StatusService = require('../lib/services/StatusService');
const ProximityService = require('../lib/services/ProximityService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');
const corpora = require('./replay-validation/corpora');

/**
 * F08 (rättningskampanjen 2026-11-04): fasberoendet vid Järnvägsbron.
 *
 * SINE BRES (20260917-16h) passerar Stridsbergsbron söderut 02:26:08 och
 * fixen 02:26:30 ligger 26 m bortom Järnvägsbrons linje. Segmentbeviset för
 * inträdet (A0 362 m norr om bron → 26 m söder om den) prövades först i ett
 * senare statuspass vid samma position: Phase 3-hållningen för Stridsbergsbron
 * returnerade före INTERMEDIATE_UNDER, och FIX U:s tvingade väntan före hela
 * under-bro-analysen. I basen hann UI-passet efter FIX U köra före nästa fix
 * och passagen bokfördes 02:27:17. I fasvarianterna δ −2,5 s och −7 s låg
 * UI-passet kvar bakom en pågående skrivning tills efter fixen 02:27:17, och
 * passagen tappades (buggjägarens M-FAS, kort F08; omgranskningen fann samma
 * sak vid δ −5 s). Rättningen prövar beviset i det pass som gör uppskjutningen.
 */
const ROOT = path.resolve(__dirname, '..');
const JVB = BRIDGES.jarnvagsbron;
const MMSI = '304225000';
// Råfixar ur 20260917-16h (SINE BRES).
const A0 = {
  lat: 58.29427, lon: 12.29567, t: 1789698299377, fixTs: 1789698265000, sog: 6.9,
};
const A = { t: 1789698368016 };
const B = {
  lat: 58.291455, lon: 12.291744999999999, t: 1789698390446, sog: 5.5, cog: 213.3,
};
const C = {
  lat: 58.29084, lon: 12.29099, sog: 5.4, cog: 212.8,
};

function vesselAtB(extra = {}) {
  return {
    mmsi: MMSI,
    lat: B.lat,
    lon: B.lon,
    sog: B.sog,
    _rawPositionSog: B.sog,
    cog: B.cog,
    timestamp: B.t,
    fixTs: B.t,
    fixFeed: 'aisstream',
    lastPositionUpdate: B.t,
    _routeDirection: 'south',
    status: 'under-bridge',
    currentBridge: 'Stridsbergsbron',
    targetBridge: 'Klaffbron',
    lastPassedBridge: 'Stridsbergsbron',
    lastPassedBridgeTime: A.t,
    passedBridges: ['Stallbackabron', 'Stridsbergsbron'],
    _forceWaitingAtBridge: { bridge: 'Järnvägsbron', until: A.t + 5 * 60 * 1000, triggeredBy: 'Stridsbergsbron' },
    _bridgeOpeningUntil: A.t + 30 * 1000,
    _bridgeOpeningBridgeName: 'Stridsbergsbron',
    _underBridgeLatched: true,
    _underBridgeSince: A.t,
    _underBridgeEntryLat: 58.29236,
    _underBridgeEntryLon: 12.29288,
    _underBridgeCrossedBridge: null,
    _underBridgePrevLat: A0.lat,
    _underBridgePrevLon: A0.lon,
    _underBridgePrevSog: A0.sog,
    _underBridgePrevClock: { timestamp: A0.t, fixTs: A0.fixTs, fixFeed: 'aishub' },
    _lastTargetBridgeForHysteresis: 'Stridsbergsbron',
    ...extra,
  };
}

const cleanAnalysis = { gpsJumpDetected: false, positionUncertain: false, analysis: { isGPSJump: false } };

describe('F08: inträdesbeviset prövas i passet som skjuter upp under-bro-grenen', () => {
  let status;
  let proximity;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(B.t);
    logger = {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const registry = new BridgeRegistry();
    status = new StatusService(registry, logger, new SystemCoordinator(logger));
    proximity = new ProximityService(registry, logger);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const passageAtC = (vessel) => geometry.detectBridgePassage({ ...vessel, ...C, _rawPositionSog: C.sog }, vessel, JVB);

  // Fältprovet 2026-11-13 (familj C, C2) och buggjägaren 2026-11-14 (familj
  // C3): B ligger 26 m bortom Järnvägsbrons linje, inom under-bro-bandet
  // (UNDER_BRIDGE_SET_DISTANCE, 50 m). I fixens EGET pass (meddelandevägens rena
  // positionsanalys) behålls FIX U:s väntan, som i basen: vilande medan
  // Phase 3-hållningen gäller, tvingad när den löpt ut. Ett SENARE pass på
  // samma fix (vakthunden, positionsanalys saknas) rensar den
  // (FIX_U_SKIP_PAST_LINE) och går den ordinarie vägen genom INTERMEDIATE_UNDER.
  // Alla tre vägarna ska bevisa inträdet så att utgångsfixen bokför passagen.
  test.each([
    ['Phase 3-hållningen för Stridsbergsbron i fixens eget pass (flaggan står vilande)', {}, cleanAnalysis, 'hold'],
    ['FIX U:s tvingade väntan i fixens eget pass (B inom under-bro-bandet, som i basen)',
      { _bridgeOpeningUntil: B.t - 1 }, cleanAnalysis, 'fixu'],
    ['ett senare pass på samma fix (vakthunden): FIX U rensas, ordinarie INTERMEDIATE_UNDER',
      { _bridgeOpeningUntil: B.t - 1 }, null, 'ordinary'],
  ])('%s: utgångsfixen bokför passagen utan något mellanliggande pass', (_label, extra, analysis, path) => {
    const vessel = vesselAtB(extra);
    const result = status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), analysis);

    if (path === 'hold') {
      expect(vessel._forceWaitingAtBridge).toMatchObject({ bridge: 'Järnvägsbron' });
      expect(result.statusReason).not.toBe('FIX_U_forced_waiting_close_bridge_pair');
    } else if (path === 'fixu') {
      expect(result.statusReason).toBe('FIX_U_forced_waiting_close_bridge_pair');
      expect(vessel._forceWaitingAtBridge).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('FIX_U_KEEP_UNDER_BRIDGE'));
    } else {
      expect(result.statusReason).not.toBe('FIX_U_forced_waiting_close_bridge_pair');
      expect(vessel._forceWaitingAtBridge).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('FIX_U_SKIP_PAST_LINE'));
    }
    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeEntryLat).toBe(A0.lat);
    // Föregående observation förbrukas inte av uppskjutningen.
    expect(vessel._underBridgePrevLat).toBe(A0.lat);
    expect(passageAtC(vessel)).toMatchObject({ passed: true, method: 'traditional_close_passage' });
  });

  test('FIX U:s tvingade väntan med fixen i ±10 m-bandet: FIX U-passet noterar inträdets epsilonkandidat', () => {
    // Granskningen av familj C (M-1): efter C2 tar FIX U-grenen bara fixar som
    // inte ligger entydigt bortom parbron, alltså på ankomstsidan eller inom
    // ±10 m från linjen. Här ligger fixen 6 m bortom linjen, på inflygningslinjen
    // A0→B. Segmentet från A0 har ett verkligt teckenbyte men slutar i
    // epsilonbandet, så F08-anropet i FIX U-grenen ska spara P1:s
    // epsilonkandidat med startpunkten på närsidan (A0), utan att förbruka
    // föregående observation. Utan anropet (mutationen M4) sparas inget.
    const oA0 = geometry.bridgeLineOffsetM(A0, JVB);
    const oB = geometry.bridgeLineOffsetM(B, JVB);
    const f = (oA0 + 6) / (oA0 - oB);
    const onLine = { lat: A0.lat + (B.lat - A0.lat) * f, lon: A0.lon + (B.lon - A0.lon) * f };
    expect(geometry.bridgeLineOffsetM(onLine, JVB)).toBeCloseTo(-6, 0);
    expect(geometry.decisiveBridgeSide(onLine, JVB)).toBe(0);

    const vessel = vesselAtB({ ...onLine, _bridgeOpeningUntil: B.t - 1 });
    const result = status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), cleanAnalysis);

    expect(result.statusReason).toBe('FIX_U_forced_waiting_close_bridge_pair');
    expect(vessel._underBridgePendingCross).toMatchObject({ bridge: 'Järnvägsbron', lat: A0.lat, lon: A0.lon });
    expect(vessel._underBridgeCrossedBridge).toBeNull();
    expect(vessel._underBridgePrevLat).toBe(A0.lat);
    expect(passageAtC(vessel)).toMatchObject({ passed: true });
  });

  test('rensningspasset (NINA B 20260918-7h): nästa bros inträde prövas i samma pass', () => {
    // Fixen 17:31:26 (47 m söder om Stridsbergsbron) är föregående observation;
    // fixen 17:32:34 ligger 19 m bortom Järnvägsbron, och Regel 0 rensar den
    // passerade Stridsbergsbron i samma pass. Hållning och FIX U är förbrukade.
    const prev = {
      lat: 58.293189999999996, lon: 12.294071666666667, t: 1789752686104, sog: 6.6,
    };
    const at = {
      lat: 58.29150333333334, lon: 12.29182, t: 1789752754469, sog: 6.2,
    };
    jest.setSystemTime(at.t);
    const vessel = vesselAtB({
      mmsi: '209982000',
      lat: at.lat,
      lon: at.lon,
      sog: at.sog,
      _rawPositionSog: at.sog,
      cog: 213.1,
      timestamp: at.t,
      fixTs: at.t,
      lastPositionUpdate: at.t,
      lastPassedBridgeTime: prev.t,
      _forceWaitingAtBridge: null,
      _bridgeOpeningUntil: null,
      _bridgeOpeningBridgeName: null,
      _underBridgeSince: prev.t + 30000,
      _underBridgeEntryLat: prev.lat,
      _underBridgeEntryLon: prev.lon,
      _underBridgePrevLat: prev.lat,
      _underBridgePrevLon: prev.lon,
      _underBridgePrevSog: prev.sog,
      _underBridgePrevClock: { timestamp: prev.t, fixTs: prev.t, fixFeed: 'aisstream' },
      _lastTargetBridgeForHysteresis: 'Klaffbron',
      _lastCurrentBridgeForHysteresis: 'Stridsbergsbron',
    });
    status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), cleanAnalysis);

    expect(vessel.currentBridge).toBeNull();
    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeEntryLat).toBe(prev.lat);
    const exit = {
      ...vessel, lat: 58.28917, lon: 12.28889, sog: 5.6, _rawPositionSog: 5.6,
    };
    expect(geometry.detectBridgePassage(exit, vessel, JVB)).toMatchObject({
      passed: true, method: 'traditional_close_passage',
    });
  });

  test.each([
    ['GPS-osäker fix', { _positionUncertain: true }, cleanAnalysis],
    ['för långt segment', { _underBridgePrevLat: JVB.lat + 450 / 111320, _underBridgePrevLon: JVB.lon }, cleanAnalysis],
    ['redan passerad bro', { passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron'] }, cleanAnalysis],
    ['utanför zonen', { lat: JVB.lat - 70 / 111320, lon: JVB.lon }, cleanAnalysis],
  ])('inget bevis vid %s', (_label, extra, analysis) => {
    const vessel = vesselAtB(extra);
    status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), analysis);
    expect(vessel._underBridgeCrossedBridge).not.toBe('Järnvägsbron');
  });
});

/**
 * F08 efter granskningen (2026-11-04): beviset överlever det nya zonbesöket.
 *
 * Granskaren lade en extra fix C' 45 m söder om linjen mellan B och C. Det
 * första ordinarie passet vid C' gör HYSTERESIS_RESET (målbytet i passagepasset
 * sågs aldrig av hållningen eller FIX U) och startar ett nytt INTERMEDIATE_UNDER.
 * Båda nollar beviset, och segmentet A0→C' är 407 m, alltså längre än
 * UNDER_BRIDGE_CROSS_SEGMENT_MAX_M. Utan sparat bevis tappades passagen vid C,
 * utom när ett UI-pass hann köra vid B före C' (fasberoende). Rättningen sparar
 * beviset och återställer det när zonbesöket vid samma bro startar.
 */
describe('F08: beviset från det uppskjutande passet överlever nästa zonbesök', () => {
  // C' ligger på linjen B→C, 45 m söder om Järnvägsbrons linje (inne i zonen).
  const Cp = {
    lat: B.lat + (C.lat - B.lat) * 0.23, lon: B.lon + (C.lon - B.lon) * 0.23, sog: 5.4, cog: 213,
  };
  let status;
  let proximity;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(B.t);
    const logger = {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const registry = new BridgeRegistry();
    status = new StatusService(registry, logger, new SystemCoordinator(logger));
    proximity = new ProximityService(registry, logger);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const pass = (vessel, analysis = cleanAnalysis) => {
    status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), analysis);
  };
  // En ny AIS-fix på samma fartygsobjekt; returnerar föregående läge.
  const moveTo = (vessel, pos, t) => {
    jest.setSystemTime(t);
    const before = { ...vessel };
    Object.assign(vessel, {
      lat: pos.lat,
      lon: pos.lon,
      sog: pos.sog,
      _rawPositionSog: pos.sog,
      cog: pos.cog,
      timestamp: t,
      fixTs: t,
      fixFeed: 'aisstream',
      lastPositionUpdate: t,
    });
    return before;
  };
  // Hållningspasset vid B och FIX U-passet när hållningen löpt ut. Båda bär
  // fixens rena positionsanalys (pass()), och B ligger inom under-bro-bandet,
  // så FIX U:s väntan står vilande i det första och tvingas i det andra, som i
  // basen (familj C3, 2026-11-14; under C2 rensades den i hållningspasset).
  const holdThenExpiredPass = () => {
    const vessel = vesselAtB({ _lastCurrentBridgeForHysteresis: 'Stridsbergsbron' });
    pass(vessel);
    jest.setSystemTime(B.t + 9600);
    pass(vessel);
    return vessel;
  };

  test.each([
    ['med ett UI-pass vid B före C\'', true],
    ['utan UI-pass vid B (förut tappad)', false],
  ])('extra fix inne i zonen, %s: utgångsfixen bokför passagen', (_label, uiPassAtB) => {
    const vessel = holdThenExpiredPass();
    if (uiPassAtB) {
      jest.setSystemTime(B.t + 9700);
      pass(vessel);
    }
    moveTo(vessel, Cp, B.t + 20000);
    expect(geometry.calculateDistance(vessel.lat, vessel.lon, JVB.lat, JVB.lon)).toBeLessThan(50);
    pass(vessel);

    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeEntryLat).toBe(A0.lat);
    expect(vessel._underBridgeLatched).toBe(true);
    const atCp = moveTo(vessel, C, B.t + 47332);
    expect(geometry.detectBridgePassage(vessel, atCp, JVB)).toMatchObject({
      passed: true, method: 'traditional_close_passage',
    });
  });

  test('TARGET_UNDER återställer beviset på samma sätt när bron är målbron', () => {
    const vessel = holdThenExpiredPass();
    moveTo(vessel, Cp, B.t + 20000);
    Object.assign(vessel, {
      targetBridge: 'Järnvägsbron',
      currentBridge: null,
      distanceToCurrent: null,
      _underBridgeLatched: false,
      _underBridgeCrossedBridge: null,
    });
    const underBridge = status._isUnderBridge(vessel, proximity.analyzeVesselProximity(vessel), cleanAnalysis);

    expect(underBridge).toBe(true);
    expect(vessel.currentBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeEntryLat).toBe(A0.lat);
  });

  test('U-sväng inne i zonen: det återställda beviset ger ingen passage söderut', () => {
    const vessel = holdThenExpiredPass();
    moveTo(vessel, Cp, B.t + 20000);
    pass(vessel);
    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
    // Båten vänder, korsar tillbaka norrut inne i zonen och lämnar den norrut.
    // Punkterna ligger på inflygningslinjen A0→B (linjen korsas vid ~93 %).
    const along = (f, sog) => ({
      lat: A0.lat + (B.lat - A0.lat) * f, lon: A0.lon + (B.lon - A0.lon) * f, sog, cog: 33,
    });
    moveTo(vessel, along(0.856, 4.0), B.t + 60000);
    pass(vessel);
    const inZoneNorth = moveTo(vessel, along(0.655, 4.5), B.t + 90000);
    expect(geometry.detectBridgePassage(vessel, inZoneNorth, JVB).passed).toBe(false);
  });

  test('FIX O-spärren prövar inträdesbeviset (passet efter FIX U i samma millisekund)', () => {
    // Bankens mönster (20260804-both-21h): passagen av parbron och FIX U:s
    // väntstämpel har samma tid, så FIX O spärrar under-bro i nästa pass.
    const vessel = vesselAtB({
      currentBridge: 'Järnvägsbron',
      lastPassedBridgeTime: B.t,
      _forceWaitingAtBridge: null,
      _bridgeOpeningUntil: null,
      _bridgeOpeningBridgeName: null,
      _underBridgeLatched: false,
      _underBridgeSince: null,
      _underBridgeEntryLat: null,
      _underBridgeEntryLon: null,
      _lastWaitingShownAt: { Järnvägsbron: B.t },
      _lastTargetBridgeForHysteresis: 'Klaffbron',
      _lastCurrentBridgeForHysteresis: 'Järnvägsbron',
    });
    jest.setSystemTime(B.t + 25);
    pass(vessel);

    expect(vessel._underBridgeLatched).toBe(false); // spärren höll under-bro
    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeEntryLat).toBe(A0.lat);
  });

  test('FIX O-spärren återställer ett bevis som ett ordinarie pass har nollat', () => {
    // FIX U-passet vid B sätter beviset (fixens eget pass, B inom
    // under-bro-bandet; familj C3). C' kommer inom FIX O:s 20 s, och samma pass
    // gör HYSTERESIS_RESET (målbytet) och spärrar sedan under-bro. A0→C' är
    // 407 m, så beviset kan inte prövas om från segmentet.
    const vessel = vesselAtB({
      lastPassedBridgeTime: B.t,
      _bridgeOpeningUntil: null,
      _bridgeOpeningBridgeName: null,
      _forceWaitingAtBridge: { bridge: 'Järnvägsbron', until: B.t + 5 * 60 * 1000, triggeredBy: 'Stridsbergsbron' },
    });
    pass(vessel);
    expect(vessel._forceWaitingAtBridge).toBeNull();
    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
    moveTo(vessel, Cp, B.t + 15000);
    vessel._lastWaitingShownAt = { Järnvägsbron: B.t };
    pass(vessel);

    expect(vessel._underBridgeLatched).toBe(false);
    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
    expect(vessel._underBridgeEntryLat).toBe(A0.lat);
  });

  // Varje fall: vad som händer före fixen C' och vid den. Utan villkoret hade
  // passet vid C' återställt beviset (se första testet).
  test.each([
    ['båten har lämnat zonen', {
      before: (vessel) => {
        moveTo(vessel, { ...C, lat: JVB.lat - 80 / 111320, lon: JVB.lon }, B.t + 15000);
        pass(vessel);
      },
    }],
    ['positionen är GPS-osäker', {
      atCp: (vessel) => {
        vessel._positionUncertain = true;
      },
    }],
    ['bron är bokförd', {
      atCp: (vessel) => {
        vessel.passedBridges = [...vessel.passedBridges, 'Järnvägsbron'];
      },
    }],
    ['en passage av bron har registrerats efter posten (listan nollad av en vändning)', {
      atCp: (vessel) => {
        vessel.lastPassedBridge = 'Järnvägsbron';
        vessel.lastPassedBridgeTime = B.t + 15000;
      },
    }],
    ['beviset är äldre än två minuter', { tCp: B.t + 2 * 60 * 1000 + 1000 }],
    ['ett bevis för en annan bro har satts', {
      atCp: (vessel) => {
        vessel._underBridgeCrossedBridge = 'Stridsbergsbron';
      },
    }],
  ])('posten släpps när %s', (_label, { before, atCp, tCp = B.t + 20000 }) => {
    const vessel = holdThenExpiredPass();
    expect(vessel._underBridgeDeferredProof).toMatchObject({ bridge: 'Järnvägsbron', lat: A0.lat });
    if (before) before(vessel);
    moveTo(vessel, Cp, tCp);
    if (atCp) atCp(vessel);
    pass(vessel);

    expect(vessel._underBridgeDeferredProof).toBeNull();
    expect(vessel._underBridgeCrossedBridge).not.toBe('Järnvägsbron');
  });

  test('posten följer med när VesselDataService bygger om fartygsobjektet', () => {
    global.__TEST_MODE__ = true;
    const logger = {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null,
    };
    try {
      const proof = {
        bridge: 'Järnvägsbron', lat: A0.lat, lon: A0.lon, at: B.t,
      };
      const rebuilt = svc._createVesselObject(MMSI, {
        lat: Cp.lat, lon: Cp.lon, sog: Cp.sog, cog: Cp.cog, name: 'SINE BRES',
      }, { ...vesselAtB(), _underBridgeDeferredProof: proof });
      expect(rebuilt._underBridgeDeferredProof).toEqual(proof);
    } finally {
      svc.clearAllTimers();
    }
  });
});

/**
 * Hela kedjan genom appen, i basen och i fasvarianterna: korpusen och dess
 * starttillstånd flyttas δ (aisTimestamp, fixTs och receivedAt typbevarande;
 * alla epok-ms i starttillståndet), precis som buggjägarens M-FAS-relation.
 */
describe('F08: SINE BRES Järnvägspassage oberoende av klockfasen', () => {
  const corpus = corpora.find((c) => c.id === '20260917-16h');
  const statePath = corpus.jsonl.replace(/\.jsonl$/, '.state.json');
  const EPOCH_MIN = 1.5e12;
  const EPOCH_MAX = 4.1e12;
  // Rå-GT: korsning 02:26:08.016–02:26:30.446; bokförd vid utgångsfixen.
  const BOOKED = Date.parse('2026-09-18T02:27:17.778Z');
  const shiftDeep = (v, d) => {
    if (typeof v === 'number') return (Number.isFinite(v) && v >= EPOCH_MIN && v <= EPOCH_MAX) ? v + d : v;
    if (Array.isArray(v)) return v.map((x) => shiftDeep(x, d));
    if (v && typeof v === 'object') {
      return Object.keys(v).reduce((acc, k) => {
        acc[k] = shiftDeep(v[k], d);
        return acc;
      }, {});
    }
    return v;
  };
  let dir;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-f08-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const corpusRows = () => fs.readFileSync(corpus.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  // Skriver raderna och starttillståndet flyttade δ sekunder.
  const writeVariant = (name, rows, deltaS) => {
    const d = Math.round(deltaS * 1000);
    const shifted = rows.map((r0) => {
      const r = { ...r0 };
      if (Number.isFinite(r.aisTimestamp)) r.aisTimestamp += d;
      if (Number.isFinite(r.fixTs)) r.fixTs += d;
      if (typeof r.receivedAt === 'string' && Number.isFinite(Date.parse(r.receivedAt))) {
        r.receivedAt = new Date(Date.parse(r.receivedAt) + d).toISOString();
      }
      return JSON.stringify(r);
    });
    const jsonl = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(jsonl, `${shifted.join('\n')}\n`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    fs.writeFileSync(jsonl.replace(/\.jsonl$/, '.state.json'), JSON.stringify(shiftDeep(state, d)));
    return jsonl;
  };

  const replay = (jsonl) => new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), jsonl], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
      },
    }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]));
    });
  });

  // SINE BRES Järnvägspassager, tillbakaflyttade δ.
  const jvbPassages = (result, deltaS) => result.intermediatePassages
    .filter((p) => p.mmsi === MMSI && p.bridge === 'Järnvägsbron')
    .map((p) => p.t - Math.round(deltaS * 1000));

  // Basen tappade passagen vid δ −2,5, −5 och −7 s (buggjägarens M-FAS gav
  // −2,5 och −7; omgranskningen fann även −5).
  test.each([0, -2.5, -5, -7])('δ = %s s', async (deltaS) => {
    const result = await replay(writeVariant(`fas${deltaS}`, corpusRows(), deltaS));
    expect(jvbPassages(result, deltaS)).toEqual([BOOKED]);
  }, 120000);

  /**
   * Granskningens prov: samma data med EN extra fix C' 45 m söder om linjen,
   * mellan B (02:26:30) och utgångsfixen C (02:27:17), med fart som i datat.
   * Med C' 02:26:41,6 tappades passagen i alla faser, med C' 02:27:05 vid
   * δ −2,5, −5 och −7 s, i både 7699cbe och den första prototypen.
   */
  test('en extra fix inne i zonen: passagen bokförs i alla faser', async () => {
    const rows = corpusRows();
    const rowB = rows.find((r) => r.mmsi === MMSI && r.aisTimestamp === B.t);
    const rowC = rows.find((r) => r.mmsi === MMSI && r.aisTimestamp === 1789698437778);
    const variants = [];
    for (const tIso of ['2026-09-18T02:26:41.600Z', '2026-09-18T02:27:05.000Z']) {
      const t = Date.parse(tIso);
      const extra = {
        ...rowB,
        lat: rowB.lat + (rowC.lat - rowB.lat) * 0.23,
        lon: rowB.lon + (rowC.lon - rowB.lon) * 0.23,
        sog: 5.4,
        cog: 213,
        aisTimestamp: t,
        fixTs: t,
        receivedAt: tIso,
      };
      const at = rows.findIndex((r) => Date.parse(r.receivedAt) > t);
      const withExtra = [...rows.slice(0, at), extra, ...rows.slice(at)];
      for (const deltaS of [0, -2.5, -5, -7]) {
        variants.push({ tIso, deltaS, jsonl: writeVariant(`extra-${t}-${deltaS}`, withExtra, deltaS) });
      }
    }
    const outcomes = [];
    for (let i = 0; i < variants.length; i += 4) {
      const batch = variants.slice(i, i + 4);
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(batch.map((v) => replay(v.jsonl)));
      results.forEach((result, k) => {
        const v = batch[k];
        outcomes.push(`${v.tIso} δ ${v.deltaS}: ${jvbPassages(result, v.deltaS).map((t) => new Date(t).toISOString()).join(',') || 'tappad'}`);
      });
    }
    expect(outcomes).toEqual(variants.map((v) => `${v.tIso} δ ${v.deltaS}: ${new Date(BOOKED).toISOString()}`));
  }, 300000);

  /**
   * KÄND LUCKA (omgranskningen av revision 1, låg; ingen kodändring i R2): en
   * extra fix 50–60 m efter linjen bryter METHOD 1 i detectBridgePassage
   * (geometry.js). Steget dit från B (26 m) når inte "mer än 60 m", och steget
   * därifrån till C (108 m) börjar inte "högst 50 m" från bron. Inget steg
   * efter B korsar linjen, så ingen annan metod bokför heller. Passagen tappas
   * i alla faser, i både 7699cbe och prototypen. Testet visar dagens beteende
   * så att luckan syns; den som rättar den vänder mittenfallet.
   *
   * Kanterna är regressionsfall för R2: med en extra fix på 49 m bokförs
   * passagen vid C, och med 60–63 m vid den extra fixen. 7699cbe tappar båda,
   * eftersom beviset från det uppskjutna passet nollades i nästa zonbesök.
   */
  test('KÄND LUCKA: en extra fix 50–60 m efter linjen tappar passagen; kanterna bokförs', async () => {
    const rows = corpusRows();
    const rowB = rows.find((r) => r.mmsi === MMSI && r.aisTimestamp === B.t);
    const rowC = rows.find((r) => r.mmsi === MMSI && r.aisTimestamp === 1789698437778);
    const tIso = '2026-09-18T02:26:41.600Z';
    const t = Date.parse(tIso);
    const cases = [
      { frac: 0.28, expected: [BOOKED] }, // 49 m: bokförs vid C
      { frac: 0.40, expected: [] }, // 58,8 m: KÄND LUCKA (granskarens v4)
      { frac: 0.42, expected: [t] }, // 60,4 m: bokförs vid den extra fixen
    ];
    const variants = cases.map(({ frac, expected }) => {
      const extra = {
        ...rowB,
        lat: rowB.lat + (rowC.lat - rowB.lat) * frac,
        lon: rowB.lon + (rowC.lon - rowB.lon) * frac,
        sog: 5.4,
        cog: 213,
        aisTimestamp: t,
        fixTs: t,
        receivedAt: tIso,
      };
      const distanceM = geometry.calculateDistance(extra.lat, extra.lon, JVB.lat, JVB.lon);
      const at = rows.findIndex((r) => Date.parse(r.receivedAt) > t);
      const withExtra = [...rows.slice(0, at), extra, ...rows.slice(at)];
      return {
        frac, expected, distanceM, jsonl: writeVariant(`lucka-${frac}`, withExtra, 0),
      };
    });
    // Bandet mäts, så att testet inte glider om geometrin ändras.
    expect(variants.map((v) => Math.round(v.distanceM * 10) / 10)).toEqual([49.1, 58.8, 60.4]);
    const results = await Promise.all(variants.map((v) => replay(v.jsonl)));
    expect(results.map((result) => jvbPassages(result, 0))).toEqual(variants.map((v) => v.expected));
  }, 120000);
});
