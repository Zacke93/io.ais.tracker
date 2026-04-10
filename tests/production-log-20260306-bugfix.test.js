'use strict';

/**
 * Regression tests for production log 20260306-203252 bugfixes.
 *
 * Bug 6: Timer shortening in scheduleCleanup() — premature vessel removal
 * Bug 7: Double Klaffbron triggers — dedup keys cleared on timeout removal
 * Bug 8: _bridgeOpeningUntil missing in bridge text data
 */

jest.mock('homey');

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

const mockLogger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

// ─── Bug 6: scheduleCleanup refuses to shorten timer ────────────────────

describe('Bug 6: scheduleCleanup timer protection', () => {
  let vesselDataService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(mockLogger);
    vesselDataService = new VesselDataService(mockLogger, bridgeRegistry, systemCoordinator);

    // Add a test vessel — position far from all bridges to avoid protection zone reschedule.
    // lastPassedBridgeTime set far in the past to avoid passage protection extending timeouts.
    vesselDataService.vessels.set('244059000', {
      mmsi: '244059000',
      name: 'LURO',
      lat: 59.0,
      lon: 13.0,
      status: 'approaching',
      passedBridges: [],
    });
  });

  afterEach(() => {
    vesselDataService.clearAllTimers();
    jest.useRealTimers();
  });

  test('refuses to shorten existing longer timer', () => {
    // Set a long timer (185s passage protection)
    vesselDataService.scheduleCleanup('244059000', 185000);

    // Try to replace with shorter timer (120s proximity)
    vesselDataService.scheduleCleanup('244059000', 120000);

    // Advance past 120s — vessel must still exist
    jest.advanceTimersByTime(121000);
    expect(vesselDataService.vessels.has('244059000')).toBe(true);

    // Advance to 186s — now vessel should be removed
    jest.advanceTimersByTime(65000); // total: 186s
    expect(vesselDataService.vessels.has('244059000')).toBe(false);
  });

  test('allows extending to a longer timer', () => {
    // Set a short timer (60s)
    vesselDataService.scheduleCleanup('244059000', 60000);

    // Extend with longer timer (120s)
    vesselDataService.scheduleCleanup('244059000', 120000);

    // Advance past 60s — vessel must still exist (longer timer accepted)
    jest.advanceTimersByTime(61000);
    expect(vesselDataService.vessels.has('244059000')).toBe(true);

    // Advance to 121s — now vessel should be removed
    jest.advanceTimersByTime(60000); // total: 121s
    expect(vesselDataService.vessels.has('244059000')).toBe(false);
  });
});

// ─── Bug 7: Dedup keys preserved on timeout with active journey ─────────

describe('Bug 7: Dedup key preservation on timeout removal', () => {
  let app;

  beforeEach(() => {
    jest.useFakeTimers();
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._vesselRemovalTimers = new Map();
    app._updateUI = jest.fn();
    app._devices = []; // Mock devices to prevent iteration error
    app.vesselDataService = {
      removeVessel: jest.fn(),
      getVesselCount: jest.fn().mockReturnValue(2), // >1 to avoid "last vessel" UI path
    };
    app.statusService = {
      statusStabilizer: { removeVessel: jest.fn() },
      clearVesselETAHistory: jest.fn(),
    };
  });

  afterEach(() => {
    for (const timerId of app._vesselRemovalTimers.values()) {
      clearTimeout(timerId);
    }
    jest.useRealTimers();
  });

  test('preserves dedup keys on timeout with active journey', async () => {
    const mmsi = '244059000';
    const vessel = {
      mmsi,
      name: 'LURO',
      passedBridges: ['Stridsbergsbron'],
    };

    // Simulate a trigger key exists
    app._triggeredBoatNearKeys.add(`${mmsi}:Klaffbron`);

    // Vessel removed via timeout with active journey
    await app._onVesselRemoved({ mmsi, vessel, reason: 'timeout' });

    // Dedup key must be preserved
    expect(app._triggeredBoatNearKeys.has(`${mmsi}:Klaffbron`)).toBe(true);
  });

  test('clears dedup keys on non-timeout removal', async () => {
    const mmsi = '244059000';
    const vessel = {
      mmsi,
      name: 'LURO',
      passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'],
    };

    // Simulate a trigger key exists
    app._triggeredBoatNearKeys.add(`${mmsi}:Klaffbron`);

    // Vessel removed via passed-final-bridge (normal completion)
    await app._onVesselRemoved({ mmsi, vessel, reason: 'passed-final-bridge' });

    // Dedup key must be cleared
    expect(app._triggeredBoatNearKeys.has(`${mmsi}:Klaffbron`)).toBe(false);
  });
});

// ─── Bug 8: _bridgeOpeningUntil in bridge text data ──────────────

describe('Bug 8: _bridgeOpeningUntil in bridge text data', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
    app._processingRemoval = new Set();
  });

  test('_findRelevantBoatsForBridgeText includes _bridgeOpeningUntil', () => {
    const syntheticTime = Date.now() + 8000;

    // Mock vesselDataService.getVesselsForBridgeText
    app.vesselDataService = {
      getVesselsForBridgeText: jest.fn().mockReturnValue([{
        mmsi: '244059000',
        name: 'LURO',
        targetBridge: 'Klaffbron',
        status: 'under-bridge',
        lastPassedBridge: 'Järnvägsbron',
        lastPassedBridgeTime: Date.now() - 5000,
        sog: 4,
        cog: 180,
        lat: 58.285,
        lon: 12.290,
        passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron'],
        _routeDirection: 'southbound',
        _finalTargetDirection: null,
        _bridgeOpeningUntil: syntheticTime,
        etaMinutes: 2,
        isWaiting: false,
      }]),
    };

    // Mock proximityService.analyzeVesselProximity
    app.proximityService = {
      analyzeVesselProximity: jest.fn().mockReturnValue({
        nearestBridge: { id: 'klaffbron', name: 'Klaffbron' },
        nearestDistance: 45,
        bridgeDistances: { klaffbron: 45 },
      }),
    };

    // Mock bridgeRegistry for findBridgeIdByName
    app.bridgeRegistry = {
      findBridgeIdByName: jest.fn().mockReturnValue('klaffbron'),
    };

    const result = app._findRelevantBoatsForBridgeText();

    expect(result).toHaveLength(1);
    expect(result[0]._bridgeOpeningUntil).toBe(syntheticTime);
  });
});
