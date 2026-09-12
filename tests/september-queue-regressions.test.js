'use strict';

jest.mock('homey');
const App = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const BridgeTextService = require('../lib/services/BridgeTextService');
const { waitingBridge } = require('../lib/utils/bridgeQueue');
const { BRIDGES } = require('../lib/constants');

describe('Fältprov september: manövrering, rörelse och vänttext', () => {
  let now;
  let service;
  let app;
  const position = (distance) => ({
    lat: BRIDGES.jarnvagsbron.lat - distance / 111320, lon: BRIDGES.jarnvagsbron.lon,
  });
  const fix = (distance, sog, extra = {}) => ({
    mmsi: '265679440',
    ...position(distance),
    sog,
    targetBridge: 'Stridsbergsbron',
    _routeDirection: 'north',
    status: 'waiting',
    isWaiting: true,
    etaMinutes: 4,
    timestamp: now,
    lastPositionUpdate: now,
    fixTs: now,
    fixFeed: 'aisstream',
    passedBridges: ['Klaffbron'],
    ...extra,
  });
  beforeEach(() => {
    now = Date.parse('2026-09-10T15:48:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const logger = {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    service = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    app = new App(); app.debug = jest.fn(); app._updateUI = jest.fn();
  });
  afterEach(() => {
    service.clearAllTimers(); jest.restoreAllMocks();
  });
  function step(old, distance, sog, extra = {}) {
    now += 65000;
    const vessel = fix(distance, sog, { _bridgeQueueApproaches: old?._bridgeQueueApproaches, ...extra });
    service._noteBridgeQueueApproach(vessel, old);
    return vessel;
  }
  function startQueue() {
    let v = step(null, 400, 3);
    v = step(v, 280, 2);
    v = step(v, 184, 0.7);
    v = step(v, 169, 0.4);
    return step(v, 159, 0.1);
  }
  test('verklig anflygning och långsam manövrering ger väntan utan minuter', () => {
    let v = startQueue();
    expect(waitingBridge(v)).toBe('Järnvägsbron');
    for (let minute = 0; minute < 150; minute++) v = step(v, 169 + minute % 20, minute % 2 ? 0.9 : 0.1);
    expect(waitingBridge(v)).toBe('Järnvägsbron');
    const text = new BridgeTextService(new BridgeRegistry(), { error: jest.fn() }).generateBridgeText([v]);
    expect(text).toBe('En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron');
  });
  test('avgång uppdaterar texten även med oförändrad status och ETA', () => {
    const old = startQueue();
    const v = step(old, 140, 3.9);
    expect(waitingBridge(old)).toBe('Järnvägsbron');
    expect(waitingBridge(v)).toBeNull();
    app._updateUIIfNeeded(v, old);
    expect(app._updateUI).toHaveBeenCalledTimes(1);
  });
  test.each([
    ['tystnad', {}], ['positionslöst livstecken', { _lastSeen: Number.MAX_SAFE_INTEGER }],
    ['GPS-hopp', { _gpsJumpDetected: true }], ['osäker position', { _positionUncertain: true }],
  ])('%s kan inte hålla kön färsk', (_label, extra) => {
    const v = startQueue();
    now += 11 * 60000;
    expect(waitingBridge({ ...v, ...extra })).toBeNull();
  });
  test('ensam låg fart eller upprepat gammalt fix bekräftar ingen kö', () => {
    let v = step(null, 184, 0.7);
    const oldTime = v.fixTs;
    for (let i = 0; i < 5; i++) v = step(v, 169, 0.4, { fixTs: oldTime });
    expect(waitingBridge(v)).toBeNull();
  });
});
