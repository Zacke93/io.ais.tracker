'use strict';

jest.mock('homey');

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const App = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const StatusService = require('../lib/services/StatusService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-08-04T14:08:42.508Z');
const PAPOU = {
  mmsi: '269123420',
  name: 'PAPOU',
  lat: 58.286098333333335,
  lon: 12.284956666666666,
  sog: 0.6,
  cog: 219.4,
  targetBridge: 'Klaffbron',
  currentBridge: null,
  _routeDirection: 'south',
  passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron'],
  timestamp: NOW,
  lastPositionUpdate: NOW,
  fixTs: NOW,
  fixFeed: 'aisstream',
};
const candidate = {
  name: 'Klaffbron',
  id: 'klaffbron',
  source: 'target',
  distance: geometry.calculateDistance(PAPOU.lat, PAPOU.lon, BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon),
};

describe('Notisens reservprognos respekterar kalkylatorns uttryckliga spärr', () => {
  let app;
  let service;
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    const logger = {
      debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(),
    };
    service = new StatusService(new BridgeRegistry(), logger, new SystemCoordinator(logger));
    app = new App();
    Object.assign(app, {
      statusService: service,
      debug: logger.debug,
      log: logger.log,
      error: logger.error,
      _triggeredBoatNearKeys: new Set(),
      _persistentRecentTriggers: new Map(),
      _triggerBoatNearFlowBest: jest.fn().mockResolvedValue(undefined),
    });
  });
  afterEach(() => {
    expect(app.error).not.toHaveBeenCalled();
    service.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
  const delivered = () => app._triggerBoatNearFlowBest.mock.calls[0][0];

  test.each(['target', 'current', 'nearest'])('PAPOUs spärrade mål med källa %s saknar minuter och påhittad vänttext', async (source) => {
    const vessel = { ...PAPOU };
    service.armStationaryETAHold(vessel.mmsi, 'eta_stale_soft');
    vessel.etaMinutes = service.calculateETA(vessel, null);
    expect(vessel.etaMinutes).toBeNull();
    await app._triggerBoatNearFlowForBridge(vessel, { ...candidate, source });
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    expect(delivered()).toMatchObject({
      eta_minutes: -1,
      eta_available: false,
      already_passed: false,
      message: 'PAPOU närmar sig Klaffbron',
    });
  });

  test('mål-ETA som saknas utan uttrycklig spärr behåller befintlig avstånd/fart-fallback', async () => {
    const vessel = { ...PAPOU, etaMinutes: null };
    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    expect(delivered()).toMatchObject({
      eta_minutes: 12,
      eta_available: true,
      message: 'PAPOU närmar sig Klaffbron, beräknad ankomst om 12 minuter',
    });
  });

  test('spärrat mål påverkar inte prognosen för en annan notifierad bro', async () => {
    const vessel = { ...PAPOU, sog: 4.9, etaMinutes: null };
    service.armStationaryETAHold(vessel.mmsi, 'eta_stale_soft');
    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Järnvägsbron', id: 'jarnvagsbron', source: 'current', distance: 188,
    });
    expect(delivered()).toMatchObject({ eta_minutes: 1, eta_available: true });
  });

  test('verklig rörelse släpper spärren och bevarar numerisk målprognos', async () => {
    const vessel = { ...PAPOU, sog: 4.9 };
    service.armStationaryETAHold(vessel.mmsi, 'eta_stale_soft');
    vessel.etaMinutes = service.calculateETA(vessel, null);
    expect(vessel.etaMinutes).toBeGreaterThan(0);
    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    expect(delivered().eta_available).toBe(true);
    expect(delivered().eta_minutes).toBeGreaterThanOrEqual(0);
    expect(delivered().message).toContain('beräknad ankomst');
  });

  test('en annan båts spärr blockerar inte den aktuella båtens reservprognos', async () => {
    service.armStationaryETAHold('265700360', 'eta_stale_soft');
    await app._triggerBoatNearFlowForBridge({ ...PAPOU, etaMinutes: null }, candidate);
    expect(delivered()).toMatchObject({ eta_minutes: 12, eta_available: true });
  });
});

function replay(name) {
  const file = path.join(ROOT, 'tests/replay-validation/corpora-data', name);
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), file], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, NODE_OPTIONS: '', REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
    },
  });
  const result = JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  expect(result.processErrors).toBe(0);
  expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  return result;
}

test('rå PAPOU genom hela appen: 10 min AIS-gap ger ingen ny 12-minutersprognos', () => {
  const name = 'ais-20260804-17h-dag.jsonl';
  const rows = fs.readFileSync(path.join(ROOT, 'tests/replay-validation/corpora-data', name), 'utf8')
    .trim().split('\n').map(JSON.parse)
    .filter((r) => r.mmsi === PAPOU.mmsi);
  const before = rows.find((r) => r.aisTimestamp === Date.parse('2026-08-04T13:58:41.642Z'));
  const returned = rows.find((r) => r.aisTimestamp === NOW);
  expect(returned.aisTimestamp - before.aisTimestamp).toBe(600866);
  expect(returned.sog).toBe(0.6);
  const notices = replay(name).notifications.filter((n) => n.mmsi === PAPOU.mmsi && n.bridge === 'Klaffbron');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    t: NOW,
    distance: 231,
    source: 'target',
    eta: -1,
    success: true,
    message: 'PAPOU närmar sig Klaffbron',
    alreadyPassed: false,
  });
}, 30000);

test('rå ARESTEL genom hela appen: färsk rörelse behåller sin aktuella prognos', () => {
  const notices = replay('ais-20260804-both-21h.jsonl').notifications
    .filter((n) => n.mmsi === '265700360' && n.bridge === 'Stridsbergsbron');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    t: 1785934221699,
    distance: 126,
    source: 'target',
    eta: 3,
    success: true,
    message: 'ARESTEL närmar sig Stridsbergsbron, beräknad ankomst om 3 minuter',
    alreadyPassed: false,
  });
}, 30000);
