'use strict';

jest.mock('homey');

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.env.AIS_APP_ROOT || path.resolve(__dirname, '..');
const App = require(path.join(root, 'app'));
const BridgeRegistry = require(path.join(root, 'lib/models/BridgeRegistry'));
const StatusService = require(path.join(root, 'lib/services/StatusService'));
const SystemCoordinator = require(path.join(root, 'lib/services/SystemCoordinator'));
const geometry = require(path.join(root, 'lib/utils/geometry'));
const { UI_CONSTANTS } = require(path.join(root, 'lib/constants'));

const START = Date.parse('2026-07-12T11:47:42.842Z');
const SOFT = UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS;
const HARD = UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS;

describe('September: en utgången prognos återföds inte ur fortsatt låg fart', () => {
  let app;
  let service;
  let vessel;

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    const logger = {
      debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(),
    };
    const registry = new BridgeRegistry();
    service = new StatusService(registry, logger, new SystemCoordinator(logger));
    // Här isoleras appens åldersövergång. Beräkningen och dess fart-/ETA-
    // historik är riktiga tjänster; den oberoende fältåterspelningen nedan
    // kontrollerar samma fel genom hela status- och passagekedjan.
    jest.spyOn(service, 'analyzeVesselStatus').mockReturnValue({ status: 'en-route' });
    vessel = {
      mmsi: '211727200',
      name: 'NICOLINE',
      lat: 58.28700166666667,
      lon: 12.285755,
      sog: 0.9,
      cog: 328.4,
      targetBridge: 'Stridsbergsbron',
      currentBridge: 'Klaffbron',
      _routeDirection: 'north',
      status: 'en-route',
      timestamp: START,
      lastPositionUpdate: START,
      fixTs: START,
      fixFeed: 'aisstream',
      _positionUpdatedSinceLastETA: false,
    };
    vessel.etaMinutes = service.calculateETA({ ...vessel, sog: 4 }, null);
    expect(vessel.etaMinutes).toBeGreaterThan(0);
    app = Object.create(App.prototype);
    Object.assign(app, {
      debug: logger.debug,
      log: logger.log,
      error: logger.error,
      bridgeRegistry: registry,
      statusService: service,
      vesselDataService: { getAllVessels: () => [vessel], hasGpsJumpHold: () => false },
      proximityService: { analyzeVesselProximity: () => null },
    });
  });

  afterEach(() => {
    expect(app.error).not.toHaveBeenCalled();
    service.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function tickAt(t) {
    jest.setSystemTime(t);
    app._reevaluateVesselStatuses();
  }

  function freshFix(sog) {
    jest.setSystemTime(Date.now() + 65000);
    Object.assign(vessel, {
      sog,
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
      fixTs: Date.now(),
      _positionUpdatedSinceLastETA: true,
    });
    app._reevaluateVesselStatuses();
  }

  test.each([0, 0.1, 0.9, null])('fem minuter gamla %s kn ger okänd ETA även vid fortsatt stilla återkomst', (sog) => {
    vessel.sog = sog;
    const history = JSON.stringify(service.progressiveETACalculator._etaHistory.get(vessel.mmsi));
    tickAt(START + SOFT);
    expect(vessel.etaMinutes).toBeGreaterThan(0);
    tickAt(START + SOFT + 1);
    expect(vessel.etaMinutes).toBeNull();
    expect(JSON.stringify(service.progressiveETACalculator._etaHistory.get(vessel.mmsi))).toBe(history);
    tickAt(START + HARD + 1);
    expect(vessel.etaMinutes).toBeNull();
    freshFix(0.1);
    expect(vessel.etaMinutes).toBeNull();
    freshFix(0.9);
    expect(vessel.etaMinutes).toBeNull();
  });

  test('färsk verklig rörelse släpper spärren utan att radera dämpningshistoriken', () => {
    const history = JSON.stringify(service.progressiveETACalculator._etaHistory.get(vessel.mmsi));
    tickAt(START + SOFT + 1);
    expect(vessel.etaMinutes).toBeNull();
    expect(JSON.stringify(service.progressiveETACalculator._etaHistory.get(vessel.mmsi))).toBe(history);
    freshFix(4);
    expect(vessel.etaMinutes).toBeGreaterThan(0);
    expect(service.progressiveETACalculator._etaHistory.get(vessel.mmsi)).toBeDefined();
  });

  test('färsk låg fart under fem minuter får inte oavsiktligt den nya spärren', () => {
    tickAt(START + SOFT);
    freshFix(0.9);
    expect(vessel.etaMinutes).toBeGreaterThan(0);
  });

  test('verklig transit utan mellanbrokö behåller normal extrapolering', () => {
    vessel.sog = 4;
    vessel.etaMinutes = 18;
    vessel._etaExtrapolationBaseMs = START;
    vessel._etaExtrapolationBaseValue = 18;
    tickAt(START + SOFT + 1);
    expect(vessel.etaMinutes).toBeGreaterThan(12);
    expect(vessel.etaMinutes).toBeLessThan(13);
    expect(vessel._etaIsExtrapolated).toBe(true);
  });
});

test('rådata och full app: NICOLINEs 16 min AIS-glapp följs av 12 m kajförflyttning, ingen 57-min-prognos', () => {
  const file = path.join(root, 'tests/replay-validation/corpora-data/ais-replay-20260711-232958.jsonl');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((r) => r.mmsi === '211727200');
  const before = rows.find((r) => r.receivedAt === '2026-07-12T11:47:42.842Z');
  const returned = rows.find((r) => r.receivedAt === '2026-07-12T12:03:42.260Z');
  expect(returned.aisTimestamp - before.aisTimestamp).toBeGreaterThan(HARD);
  expect(geometry.calculateDistance(before.lat, before.lon, returned.lat, returned.lon)).toBeLessThan(13);
  expect(returned.sog).toBe(0.1);
  const out = execFileSync(process.execPath, [path.join(root, 'tests/replay-validation/replayRunner.js'), file], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, NODE_OPTIONS: '', REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
    },
  });
  const replay = JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  const start = Date.parse(returned.receivedAt) + 1000;
  const end = Date.parse('2026-07-12T12:12:50.631Z');
  const textAt = (t) => replay.bridgeTextTransitions.filter((r) => r.t <= t).slice(-1)[0].text;
  expect(textAt(start)).toBe('En båt på väg mot Stridsbergsbron, ETA okänd');
  for (const entry of replay.bridgeTextTransitions.filter((r) => r.t >= start && r.t < end)) {
    expect(entry.text).not.toMatch(/Stridsbergsbron, beräknad broöppning om/);
  }
  expect(replay.processErrors).toBe(0);
  expect(replay.runtimeDiagnostics.timersAfterShutdown).toBe(0);
}, 30000);
