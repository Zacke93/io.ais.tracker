'use strict';

const StatusService = require('../lib/services/StatusService');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const { BRIDGES } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const southOf = (bridge, meters) => ({ lat: bridge.lat - meters / 111320, lon: bridge.lon });

describe('väntestatusens brobindning för notiser', () => {
  let now;
  let logger;
  let bridgeRegistry;
  let systemCoordinator;
  let statusService;
  let proximityService;
  let vesselDataService;

  const makeVessel = (overrides = {}) => ({
    mmsi: '265123000',
    name: 'TESTBÅT',
    sog: 1.8, // PHOENIX: befintlig väntestatus gäller även innan båten står still.
    cog: 20,
    status: 'en-route',
    targetBridge: 'Klaffbron',
    timestamp: now,
    lastPositionUpdate: now,
    ...southOf(BRIDGES.klaffbron, 250),
    ...overrides,
  });

  const analyze = (vessel, uncertainty = null) => statusService.analyzeVesselStatus(
    vessel, proximityService.analyzeVesselProximity(vessel), uncertainty,
  );

  beforeEach(() => {
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    logger = {
      debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    bridgeRegistry = new BridgeRegistry();
    systemCoordinator = new SystemCoordinator(logger);
    statusService = new StatusService(
      bridgeRegistry, logger, systemCoordinator,
      { anchorPassageTimestamp: jest.fn() },
      { shouldBlockStatus: jest.fn().mockReturnValue(false) },
    );
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    vesselDataService?.clearAllTimers();
    vesselDataService = null;
    jest.restoreAllMocks();
  });

  test('målbron är beslutad före synkron status-emit trots att vessel.status ännu är gammal', () => {
    const vessel = makeVessel();
    let observed;
    statusService.on('status:changed', ({ vessel: emittedVessel, newStatus }) => {
      observed = {
        status: emittedVessel.status,
        waitingAtBridge: emittedVessel.waitingAtBridge,
        newStatus,
      };
    });

    const result = analyze(vessel);

    expect(observed).toEqual({
      status: 'en-route', waitingAtBridge: 'Klaffbron', newStatus: 'waiting',
    });
    expect(result).toMatchObject({ status: 'waiting', waitingAtBridge: 'Klaffbron' });
  });

  test('väntan vid Olidebron binds till mellanbron, inte målbron Klaffbron', () => {
    const vessel = makeVessel(southOf(BRIDGES.olidebron, 200));

    expect(analyze(vessel)).toMatchObject({ status: 'waiting', waitingAtBridge: 'Olidebron' });
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel.waitingAtBridge).toBe('Olidebron');
  });

  test('i överlappande zoner följer bindningen målbrogrenen även när currentBridge är en annan bro', () => {
    const target = BRIDGES.stridsbergsbron;
    const intermediate = BRIDGES.jarnvagsbron;
    const vessel = makeVessel({
      targetBridge: 'Stridsbergsbron',
      lat: target.lat * 0.45 + intermediate.lat * 0.55,
      lon: target.lon * 0.45 + intermediate.lon * 0.55,
    });

    expect(analyze(vessel)).toMatchObject({ status: 'waiting', waitingAtBridge: 'Stridsbergsbron' });
    expect(vessel.currentBridge).toBe('Järnvägsbron');
  });

  test('FIX U binder den tvingade bron före emit och tar inte den bortre målbron', () => {
    const vessel = makeVessel({
      status: 'passed',
      ...southOf(BRIDGES.jarnvagsbron, 200),
      _forceWaitingAtBridge: { bridge: 'Järnvägsbron', until: now + 10_000 },
    });
    let observed;
    statusService.on('status:changed', (event) => {
      observed = [event.newStatus, event.vessel.waitingAtBridge, event.vessel.status];
    });

    expect(analyze(vessel)).toMatchObject({
      status: 'waiting',
      waitingAtBridge: 'Järnvägsbron',
      statusReason: 'FIX_U_forced_waiting_close_bridge_pair',
    });
    expect(observed).toEqual(['waiting', 'Järnvägsbron', 'passed']);
    expect(vessel.targetBridge).toBe('Klaffbron');
  });

  test('debounce som stoppar inträde i väntestatus får inte publicera en väntbro', () => {
    const vessel = makeVessel({ status: 'approaching', _lastStatusChangeTime: now - 1000 });
    const onChange = jest.fn();
    statusService.on('status:changed', onChange);

    expect(analyze(vessel)).toMatchObject({ status: 'approaching', waitingAtBridge: null });
    expect(vessel.waitingAtBridge).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('debounce som håller kvar väntestatus bevarar dess bro', () => {
    const vessel = makeVessel({
      status: 'waiting',
      waitingAtBridge: 'Klaffbron',
      _lastStatusChangeTime: now - 1000,
      ...southOf(BRIDGES.klaffbron, 400),
    });

    expect(analyze(vessel)).toMatchObject({ status: 'waiting', waitingAtBridge: 'Klaffbron' });
    expect(vessel.waitingAtBridge).toBe('Klaffbron');
  });

  test('GPS-stabilisering som stoppar inträde publicerar ingen väntbro', () => {
    const vessel = makeVessel({ status: 'approaching' });

    expect(analyze(vessel, { gpsJumpDetected: true })).toMatchObject({
      status: 'approaching', waitingAtBridge: null, stabilized: true,
    });
    expect(vessel.waitingAtBridge).toBeNull();
  });

  test('GPS-stabilisering från under-bro-förslag tillbaka till waiting bevarar väntbron', () => {
    const vessel = makeVessel({
      status: 'waiting',
      waitingAtBridge: 'Klaffbron',
      ...southOf(BRIDGES.klaffbron, 30),
    });

    expect(analyze(vessel, { gpsJumpDetected: true })).toMatchObject({
      status: 'waiting', waitingAtBridge: 'Klaffbron', stabilized: true,
    });
  });

  test.each([{ positionUncertain: true }, { gpsJumpDetected: true }])(
    'samma waiting-status på osäkert fix flyttar inte bron; nästa rent fix får göra det (%j)',
    (uncertainty) => {
      const vessel = makeVessel({ status: 'waiting', waitingAtBridge: 'Olidebron' });

      expect(analyze(vessel, uncertainty)).toMatchObject({
        status: 'waiting', waitingAtBridge: 'Olidebron',
      });
      expect(vessel.currentBridge).toBe('Klaffbron');
      expect(vessel.waitingAtBridge).toBe('Olidebron');

      now += 6000;
      expect(analyze(vessel)).toMatchObject({ status: 'waiting', waitingAtBridge: 'Klaffbron' });
      expect(vessel.waitingAtBridge).toBe('Klaffbron');
    },
  );

  test.each([
    ['approaching', southOf(BRIDGES.klaffbron, 400)],
    ['under-bridge', southOf(BRIDGES.klaffbron, 30)],
    ['stallbacka-waiting', southOf(BRIDGES.stallbackabron, 200)],
  ])('övergång till %s nollar väntbron före emit', (expectedStatus, position) => {
    const vessel = makeVessel({ status: 'waiting', waitingAtBridge: 'Klaffbron', ...position });
    const observed = [];
    statusService.on('status:changed', (event) => observed.push(event.vessel.waitingAtBridge));

    expect(analyze(vessel)).toMatchObject({ status: expectedStatus, waitingAtBridge: null });
    expect(vessel.waitingAtBridge).toBeNull();
    expect(observed).toEqual([null]);
  });

  test('nyss passerad bro har ingen kvarhängande väntbindning', () => {
    const vessel = makeVessel({
      status: 'waiting',
      waitingAtBridge: 'Klaffbron',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: now - 1000,
      passedBridges: ['Klaffbron'],
    });

    expect(analyze(vessel)).toMatchObject({ status: 'passed', waitingAtBridge: null });
    expect(vessel.waitingAtBridge).toBeNull();
  });

  test('ombyggnad vid AIS-fix bevarar bindningen genom stabilisering; annan status rensar den', () => {
    vesselDataService = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
    const previous = makeVessel({ status: 'waiting', waitingAtBridge: 'Olidebron' });
    const data = {
      lat: previous.lat, lon: previous.lon, sog: previous.sog, cog: previous.cog,
    };
    const rebuilt = vesselDataService._createVesselObject(previous.mmsi, data, previous);

    expect(rebuilt.waitingAtBridge).toBe('Olidebron');
    expect(analyze(rebuilt, { positionUncertain: true })).toMatchObject({
      status: 'waiting', waitingAtBridge: 'Olidebron',
    });

    const noLongerWaiting = vesselDataService._createVesselObject(previous.mmsi, data, {
      ...rebuilt, status: 'passed',
    });
    expect(noLongerWaiting.waitingAtBridge).toBeNull();
    vesselDataService._cleanupVesselState(rebuilt);
    expect(rebuilt.waitingAtBridge).toBeNull();
  });
});
