'use strict';

/**
 * Varv 2 (familj A, 2026-11-09): MÅLBRON I SAMMA TICK SOM EN BEKRÄFTAD VÄNDNING.
 *
 * Två vägar bekräftade en vändning men lämnade måltilldelningen åt nästa fix:
 *  (M1) app-lagrets NEW_JOURNEY i _onVesselUpdated, som körs EFTER att
 *       updateVessel redan kört målbrokedjan för samma fix;
 *  (M2) RE_CROSS_EVIDENCED (eller korsningsbeviset) inne i målbrogrenen, där
 *       ACCELERATED-grenen ligger i samma else-if-kedja och hoppas över.
 * Med gles AIS kom öppningsarmen och returvarningen därför 10–46 s före
 * passagen eller inte alls (buggjägarens värld 936, 1208, 1274, 1316, 1317
 * och 1918). Båda vägarna kör nu ACCELERATED-grenens tilldelning för samma fix
 * via VesselDataService.assignTargetAfterReversal, med samma grindar som när
 * Fix D bekräftar en vändning i ticken. Inom målbrons under-bro-band (70 m)
 * avgör nästa fix, som förut (under-bro-vakten). En återkorsning ankrar
 * reseankaret i segmentets start (B2).
 *
 * Helkedjan (gles AIS, ledtid mot den sanna korsningen) prövas av de
 * syntetiska scenarierna "(M1, värld 936)", "(M1, värld 1208)" och
 * "(M2, värld 1317)" i runSyntheticScenarios.js; negativtestet för
 * under-bro-vakten är varningstaket i U14-scenariot
 * "vänder-bromsar-väntar-3m-tät-10s-i-1kn-brus-30m-ge-upp".
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const AISBridgeApp = require('../app');
const { BRIDGES, UNDER_BRIDGE_CLEAR_DISTANCE } = require('../lib/constants');

const KLAFF = BRIDGES.klaffbron;
const JVB = BRIDGES.jarnvagsbron;
// Meter längs meridianen; broarnas linjer är snedställda, men här räcker
// avståndet till bropunkten och latitudsidan (_calculateTargetBridge).
const northOf = (bridge, metres) => ({ lat: bridge.lat + metres / 111320, lon: bridge.lon });

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};
const liveServices = [];

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

const logged = (fn, marker) => fn.mock.calls.some((args) => String(args[0]).includes(marker));

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

afterEach(() => {
  while (liveServices.length > 0) {
    try {
      liveServices.pop().clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  jest.clearAllMocks();
});

// Läget direkt efter NEW_JOURNEY-resetten i app-lagret: resan söderut slutade
// vid Klaffbron, båten har vänt och går norrut 300 m söder om bron.
const afterNewJourneyReset = (overrides = {}) => ({
  mmsi: '903600001',
  ...northOf(KLAFF, -300),
  sog: 5,
  cog: 20,
  targetBridge: null,
  passedBridges: [],
  _finalTargetBridge: null,
  _finalTargetDirection: null,
  _routeDirection: 'north',
  _hasMovementProof: true,
  _moored: false,
  timestamp: Date.now(),
  lastPositionUpdate: Date.now(),
  ...overrides,
});

describe('assignTargetAfterReversal: ACCELERATED-tilldelningen för samma fix', () => {
  test('NEW_JOURNEY-läget: målbron sätts i bekräftelseticken', () => {
    const svc = makeVDS();
    const vessel = afterNewJourneyReset();

    const assigned = svc.assignTargetAfterReversal(vessel, null, 'new-journey');

    expect(assigned).toBe('Klaffbron');
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel._routeDirection).toBe('north');
    expect(logged(logger.log, 'REVERSAL_SAME_TICK (new-journey)')).toBe(true);
  });

  test('samma grindar som ACCELERATED efter en Fix D-bekräftelse i ticken', () => {
    const svc = makeVDS();
    const vessel = afterNewJourneyReset();
    const oldVessel = { ...vessel, ...northOf(KLAFF, -480) };
    const gate = jest.spyOn(svc, '_shouldAssignTargetBridge');
    const select = jest.spyOn(svc, '_selectAcceleratedTarget');
    const apply = jest.spyOn(svc, '_applyAcceleratedTarget');

    svc.assignTargetAfterReversal(vessel, oldVessel, 'new-journey');

    // Det gamla målet är ogiltigt (tredje argumentet), precis som
    // fixDReversalConfirmed ger i ACCELERATED-grenen.
    expect(gate).toHaveBeenCalledWith(vessel, oldVessel, true);
    expect(select).toHaveBeenCalledWith(vessel, oldVessel, { positionDirection: null, reversalConfirmed: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test('ACCELERATED-grenen använder samma utbrutna val och tillämpning', () => {
    const svc = makeVDS();
    const mmsi = '903600002';
    const t0 = Date.now() - 60000;
    const first = svc.updateVessel(mmsi, {
      ...northOf(KLAFF, -900), sog: 5, cog: 20, name: 'ACC', fixTs: t0, fixFeed: 'aisstream',
    });
    expect(first.targetBridge).toBe('Klaffbron');
    svc.getVessel(mmsi).targetBridge = null; // målbron tappad, ACCELERATED ska ta den
    const select = jest.spyOn(svc, '_selectAcceleratedTarget');
    const apply = jest.spyOn(svc, '_applyAcceleratedTarget');

    const after = svc.updateVessel(mmsi, {
      ...northOf(KLAFF, -750), sog: 5, cog: 20, name: 'ACC', fixTs: t0 + 60000, fixFeed: 'aisstream',
    });

    expect(after.targetBridge).toBe('Klaffbron');
    expect(select).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(logged(logger.log, 'Reason: ACCELERATED |')).toBe(true);
  });

  test(`UNDER-BRO-VAKTEN: inom ${UNDER_BRIDGE_CLEAR_DISTANCE} m avgör nästa fix, som förut`, () => {
    const svc = makeVDS();
    const vessel = afterNewJourneyReset(northOf(KLAFF, -40));

    expect(svc.assignTargetAfterReversal(vessel, null, 'new-journey')).toBeNull();
    expect(vessel.targetBridge).toBeNull();
    expect(logged(logger.debug, 'REVERSAL_TARGET_DEFERRED')).toBe(true);

    // Strax utanför bandet tilldelas målbron i samma tick.
    const outside = afterNewJourneyReset(northOf(KLAFF, -(UNDER_BRIDGE_CLEAR_DISTANCE + 15)));
    expect(svc.assignTargetAfterReversal(outside, null, 'new-journey')).toBe('Klaffbron');
  });

  test('RIKTNINGSKONTROLLEN: kursen motsäger vändningen i ≥ 2 kn — nästa fix avgör', () => {
    const svc = makeVDS();
    // Utliggarläget (granskningen H1): RE_CROSS har vänt båten söderut på ett
    // fix 90 m söder om Klaffbron, men kursen säger norr i 4,4 kn. Kursen
    // hade valt bron hon nyss passerat.
    const vessel = afterNewJourneyReset({
      ...northOf(KLAFF, -90), _routeDirection: 'south', sog: 4.4, cog: 20,
    });

    expect(svc.assignTargetAfterReversal(vessel, null, 'vändning-i-målbrogrenen')).toBeNull();
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBe('south');
    expect(logged(logger.debug, 'kurs och positionsbevis är oense')).toBe(true);

    // Positiv kontroll: samma läge, men vändningen och kursen är eniga.
    const agreeing = afterNewJourneyReset({ ...northOf(KLAFF, -90), sog: 4.4, cog: 20 });
    expect(svc.assignTargetAfterReversal(agreeing, null, 'new-journey')).toBe('Klaffbron');
  });

  test('grindarna: befintlig målbro, förtöjd båt och osäker kurs i låg fart ger ingen tilldelning', () => {
    const svc = makeVDS();

    const withTarget = afterNewJourneyReset({ targetBridge: 'Stridsbergsbron' });
    expect(svc.assignTargetAfterReversal(withTarget, null, 'new-journey')).toBeNull();
    expect(withTarget.targetBridge).toBe('Stridsbergsbron');

    const moored = afterNewJourneyReset({ _moored: true });
    expect(svc.assignTargetAfterReversal(moored, null, 'new-journey')).toBeNull();
    expect(moored.targetBridge).toBeNull();

    // Anomali 16: tvärställd kurs i låg fart, samma avslag som ACCELERATED.
    const uncertain = afterNewJourneyReset({ cog: 90, sog: 1.0 });
    expect(svc.assignTargetAfterReversal(uncertain, null, 'new-journey')).toBeNull();
    expect(uncertain.targetBridge).toBeNull();
  });
});

describe('M2: vändning inne i målbrogrenen tilldelar i samma updateVessel', () => {
  // 1317-mönstret: söderut genom Stridsbergsbron och Järnvägsbron (målbro
  // Klaffbron), vändning söder om Järnvägsbron, och återkorsningen syns först
  // i ett fix 7 m norr om bron. Det förra fixet gick i 1 kn, så Fix D
  // bekräftar inte; RE_CROSS_EVIDENCED gör det inne i målbrogrenen.
  function reCrossSetup() {
    const svc = makeVDS();
    const mmsi = '903600003';
    const t0 = Date.now() - 220000;
    const segmentStart = northOf(JVB, -260);
    svc.updateVessel(mmsi, {
      ...segmentStart, sog: 1, cog: 30, name: 'RETUR', fixTs: t0, fixFeed: 'aisstream',
    });
    const v = svc.getVessel(mmsi);
    v.targetBridge = 'Klaffbron';
    v.passedBridges = ['Stridsbergsbron', 'Järnvägsbron'];
    v._routeDirection = 'south';
    v._hasMovementProof = true;
    v._journeyStartLat = northOf(BRIDGES.stridsbergsbron, 400).lat;
    return {
      svc, mmsi, t0, segmentStart,
    };
  }

  test('målbron Stridsbergsbron sätts i återkorsningsticken', () => {
    const { svc, mmsi, t0 } = reCrossSetup();

    const after = svc.updateVessel(mmsi, {
      ...northOf(JVB, 7), sog: 3, cog: 30, name: 'RETUR', fixTs: t0 + 220000, fixFeed: 'aisstream',
    });

    expect(logged(logger.log, 'RE_CROSS_EVIDENCED')).toBe(true);
    expect(after._routeDirection).toBe('north');
    expect(after.targetBridge).toBe('Stridsbergsbron');
    expect(logged(logger.log, 'REVERSAL_SAME_TICK (vändning-i-målbrogrenen)')).toBe(true);
  });

  test('B2: reseankaret ligger i återkorsningssegmentets start, inte bortom bron', () => {
    const {
      svc, mmsi, t0, segmentStart,
    } = reCrossSetup();

    const after = svc.updateVessel(mmsi, {
      ...northOf(JVB, 7), sog: 3, cog: 30, name: 'RETUR', fixTs: t0 + 220000, fixFeed: 'aisstream',
    });

    expect(after._journeyStartLat).toBeCloseTo(segmentStart.lat, 6);
    // Den nya resan började söder om Järnvägsbron: TARGET_END:s geometriska
    // inferens (S-F6) kan bokföra bron om tickens detektering missade den.
    expect(after._journeyStartLat).toBeLessThan(JVB.lat);
  });

  test('B2-UNDANTAGET: kursen i ≥ 2 kn motsäger återkorsningen — ankaret i nuet, målbron väntar', () => {
    const {
      svc, mmsi, t0, segmentStart,
    } = reCrossSetup();
    const crossing = northOf(JVB, 7);

    // Positionerna korsar bron norrut, men kursen säger söder i 3 kn. Det är
    // brusfixet hos en båt som egentligen fortsätter söderut.
    const after = svc.updateVessel(mmsi, {
      ...crossing, sog: 3, cog: 210, name: 'RETUR', fixTs: t0 + 220000, fixFeed: 'aisstream',
    });

    expect(logged(logger.log, 'RE_CROSS_EVIDENCED')).toBe(true);
    expect(after._journeyStartLat).toBeCloseTo(crossing.lat, 6);
    expect(after._journeyStartLat).not.toBeCloseTo(segmentStart.lat, 6);
    expect(after.targetBridge).toBeNull();
    expect(logged(logger.debug, 'kurs och positionsbevis är oense')).toBe(true);
  });
});

describe('M1: app-lagrets NEW_JOURNEY tilldelar i samma _onVesselUpdated', () => {
  function makeJourneyApp(assignTargetAfterReversal) {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._analyzeVesselPosition = jest.fn().mockResolvedValue(undefined);
    app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);
    app._checkSkippedBridgesFallback = jest.fn().mockResolvedValue(undefined);
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    // Granskningen (L5): fånga målbron i det ögonblick öppningslagret anropas.
    // Objektet muteras senare, så ett toHaveBeenCalledWith(vessel) visar inte
    // vad öppningslagret såg.
    app.openingTargetsSeen = [];
    app._observeBridgeOpening = jest.fn((v) => {
      app.openingTargetsSeen.push(v.targetBridge);
    });
    app._updateUIIfNeeded = jest.fn();
    app._clearBoatNearTriggers = jest.fn();
    app.statusService = { clearVesselETAHistory: jest.fn() };
    app.vesselDataService = {
      clearTargetProtection: jest.fn(),
      hasGpsJumpHold: () => false,
      anchorJourneyOrigin: jest.fn(),
      assignTargetAfterReversal,
    };
    app._vesselRemovalTimers = new Map();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    return app;
  }

  // Sydresan slutade vid Klaffbron, båten går norrut i 5 kn och den väntande
  // nordflaggan är färsk: bekräftelsen går igenom.
  const reversingNorth = () => ({
    mmsi: '903600004',
    ...northOf(KLAFF, -300),
    sog: 5,
    cog: 20,
    targetBridge: null,
    passedBridges: ['Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'],
    _finalTargetBridge: 'Klaffbron',
    _finalTargetDirection: 'south',
    _newJourneyPending: { dir: 'north', time: Date.now() - 60000 },
  });

  test('tilldelningen körs efter resetten och får samma bokföring som nästa fix gav', async () => {
    const seen = {};
    const assign = jest.fn((vessel, oldVessel, reason) => {
      seen.passedBridges = [...vessel.passedBridges];
      seen.routeDirection = vessel._routeDirection;
      seen.finalTargetDirection = vessel._finalTargetDirection;
      seen.reason = reason;
      vessel.targetBridge = 'Klaffbron';
      return 'Klaffbron';
    });
    const app = makeJourneyApp(assign);
    const vessel = reversingNorth();
    const removalTimer = setTimeout(() => {}, 60000);
    app._vesselRemovalTimers.set(vessel.mmsi, removalTimer);

    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    clearTimeout(removalTimer);

    expect(assign).toHaveBeenCalledTimes(1);
    // Resetten hade körts när tilldelningen prövades.
    expect(seen).toEqual({
      passedBridges: [], routeDirection: 'north', finalTargetDirection: null, reason: 'new-journey',
    });
    expect(vessel.targetBridge).toBe('Klaffbron');
    // STEG 1:s bokföring (_noteTargetBridgeChange) för samma byte.
    expect(app.statusService.clearVesselETAHistory)
      .toHaveBeenCalledWith(vessel.mmsi, 'target_bridge_change_none_to_Klaffbron');
    expect(app._vesselRemovalTimers.has(vessel.mmsi)).toBe(false);
    // Öppningslagret såg målbron i samma hanterare. På c14938f är den null här:
    // tilldelningen väntade på nästa fix.
    expect(app.openingTargetsSeen).toEqual(['Klaffbron']);
  });

  test('ingen tilldelning (vakten eller grindarna) lämnar resten av flödet orört', async () => {
    const app = makeJourneyApp(jest.fn(() => null));
    const vessel = reversingNorth();

    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });

    expect(vessel.passedBridges).toEqual([]);
    expect(vessel.targetBridge).toBeNull();
    expect(app.statusService.clearVesselETAHistory).not.toHaveBeenCalled();
    expect(app.openingTargetsSeen).toEqual([null]);
  });
});
