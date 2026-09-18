'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, UI_CONSTANTS } = require('../lib/constants');

describe('publicerad ETA efter bevisad avgång från mellanbro', () => {
  let app;
  let now;

  beforeEach(() => {
    now = Date.parse('2026-08-07T12:13:52Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
  });

  afterEach(() => jest.restoreAllMocks());

  function vessel(overrides = {}) {
    return {
      mmsi: '219025192',
      targetBridge: 'Klaffbron',
      lat: BRIDGES.jarnvagsbron.lat - 0.001,
      lon: BRIDGES.jarnvagsbron.lon,
      timestamp: now,
      lastPositionUpdate: now,
      _etaPublishTarget: 'Klaffbron',
      _etaPublishedValue: 70,
      _etaPublishedAtMs: now,
      _etaBurstAtMs: now,
      _etaBurstBase: 70,
      _etaBurstGapMin: 0,
      _etaWaitingBaselineRelease: { targetBridge: 'Klaffbron', positionAt: now },
      ...overrides,
    };
  }

  test('avgångsbeviset släpper gammal väntprognos och dess burst exakt en gång', () => {
    const moving = vessel();
    expect(app._reconcilePublishedETA(moving, 10)).toBe(10);
    expect(moving._etaWaitingBaselineRelease).toBeNull();
    expect(moving._etaPublishedValue).toBe(10);
    expect(moving._etaBurstAtMs).toBeNull();
    expect(moving._etaBurstBase).toBeNull();
    expect(moving._etaBurstGapMin).toBeNull();
    // Ett senare oskyddat hopp får inte återanvända avgångsbeviset.
    expect(app._reconcilePublishedETA(moving, 90)).toBe(13);
  });

  test.each([
    ['annan målbro', () => ({ _etaWaitingBaselineRelease: { targetBridge: 'Stridsbergsbron', positionAt: now } })],
    ['annat fix', () => ({ _etaWaitingBaselineRelease: { targetBridge: 'Klaffbron', positionAt: now - 1 } })],
    ['saknad fixtid', () => ({ lastPositionUpdate: undefined, timestamp: undefined, _etaWaitingBaselineRelease: { targetBridge: 'Klaffbron' } })],
    ['gammalt fix', () => {
      const staleAt = now - UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS - 1;
      return { timestamp: staleAt, lastPositionUpdate: staleAt, _etaWaitingBaselineRelease: { targetBridge: 'Klaffbron', positionAt: staleAt } };
    }],
    ['GPS-hopp', () => ({ _gpsJumpDetected: true })],
    ['osäker position', () => ({ _positionUncertain: true })],
    ['förhöjd GPS-koordinering', () => ({ lastCoordinationLevel: 'enhanced' })],
    ['systemomfattande GPS-koordinering', () => ({ lastCoordinationLevel: 'system_wide' })],
  ])('%s får inte släppa publiceringsskyddet', (_name, overrides) => {
    const moving = vessel(overrides());
    expect(app._reconcilePublishedETA(moving, 10)).toBeGreaterThan(10);
    expect(moving._etaWaitingBaselineRelease).toBeNull();
  });

  test('signal för avgång får inte legitimera en stigande prognos', () => {
    const moving = vessel();
    expect(app._reconcilePublishedETA(moving, 120)).toBeLessThan(120);
    expect(moving._etaWaitingBaselineRelease).toBeNull();
  });

  test('ordinarie publiceringsskydd består utan avgångsbevis', () => {
    expect(app._reconcilePublishedETA(vessel({ _etaWaitingBaselineRelease: null }), 10)).toBeGreaterThan(10);
  });
});
