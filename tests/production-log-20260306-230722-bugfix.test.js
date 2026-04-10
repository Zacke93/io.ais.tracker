'use strict';

/**
 * Regression tests for production log 20260306-230722 bugfixes.
 *
 * Bug 9: _isJustPassed() suppressas felaktigt för intermediärbroar
 * Bug 10: Status-transition rensar ALLA dedup-nycklar → dubbla triggers
 * Bug 11: getVesselsForBridgeText() exkluderar fartyg utan targetBridge i passage-fönster
 */

jest.mock('homey');

const AISBridgeApp = require('../app');
const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

const mockLogger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

// ─── Bug 9: _isJustPassed only suppresses for target bridges ─────────────

describe('Bug 9: _isJustPassed synthetic suppress scoping', () => {
  let bridgeTextService;

  beforeEach(() => {
    jest.clearAllMocks();
    const bridgeRegistry = new BridgeRegistry();
    bridgeTextService = new BridgeTextService(bridgeRegistry, mockLogger);
  });

  test('returns true for intermediate bridge during bridge opening window', () => {
    // Stallbackabron is an intermediate bridge — should NOT be suppressed
    const vessel = {
      lastPassedBridge: 'Stallbackabron',
      lastPassedBridgeTime: Date.now() - 2000, // 2s ago — within JUST_PASSED_WINDOW
      _bridgeOpeningUntil: Date.now() + 6000, // bridge opening window active
    };

    expect(bridgeTextService._isJustPassed(vessel)).toBe(true);
  });

  test('returns true for target bridge during bridge opening window (Phase 3 handles display)', () => {
    // Klaffbron is a target bridge — _isJustPassed always returns true within 60s
    // Phase 3 vs 4 differentiation is in _generateDirectionPhrase
    const vessel = {
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 2000,
      _bridgeOpeningUntil: Date.now() + 6000,
    };

    expect(bridgeTextService._isJustPassed(vessel)).toBe(true);
  });
});

// ─── Bug 10: Dedup keys preserved on status transition during journey ────

describe('Bug 10: Dedup key preservation on status transition', () => {
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
    app._devices = [];
    app.vesselDataService = {
      removeVessel: jest.fn(),
      getVesselCount: jest.fn().mockReturnValue(2),
    };
    app.statusService = {
      statusStabilizer: { removeVessel: jest.fn() },
      clearVesselETAHistory: jest.fn(),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('preserves dedup keys on status transition during active journey', async () => {
    const vessel = {
      mmsi: '210548000',
      name: 'SKAGERN',
      passedBridges: ['Stallbackabron'],
      targetBridge: 'Klaffbron',
    };

    // Simulate existing dedup key for Klaffbron
    app._triggeredBoatNearKeys.add('210548000:Klaffbron');

    // Status transition waiting → en-route during active journey
    await app._onVesselStatusChanged({
      vessel,
      oldStatus: 'waiting',
      newStatus: 'en-route',
      reason: 'distance-change',
    });

    // Dedup key must be preserved (vessel has passedBridges)
    expect(app._triggeredBoatNearKeys.has('210548000:Klaffbron')).toBe(true);
  });

  test('clears dedup keys on status transition without journey', async () => {
    const vessel = {
      mmsi: '210548000',
      name: 'SKAGERN',
      passedBridges: [],
      targetBridge: 'Klaffbron',
    };

    // Simulate existing dedup key
    app._triggeredBoatNearKeys.add('210548000:Klaffbron');

    // Status transition waiting → en-route without active journey
    await app._onVesselStatusChanged({
      vessel,
      oldStatus: 'waiting',
      newStatus: 'en-route',
      reason: 'distance-change',
    });

    // Dedup key must be cleared (no active journey)
    expect(app._triggeredBoatNearKeys.has('210548000:Klaffbron')).toBe(false);
  });
});

// ─── Bug 11: getVesselsForBridgeText includes vessel in passage window ───

describe('Bug 11: getVesselsForBridgeText passage window inclusion', () => {
  let vesselDataService;

  beforeEach(() => {
    jest.clearAllMocks();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(mockLogger);
    vesselDataService = new VesselDataService(mockLogger, bridgeRegistry, systemCoordinator);
  });

  test('includes vessel in passage window without targetBridge', () => {
    // Vessel has just passed Klaffbron — targetBridge is null but within passage window
    vesselDataService.vessels.set('210548000', {
      mmsi: '210548000',
      name: 'SKAGERN',
      lat: 58.284,
      lon: 12.290,
      targetBridge: null,
      _bridgeTextDerivedTarget: null,
      status: 'passed',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 5000, // 5s ago — within 180s window
      passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'],
      sog: 4,
      cog: 180,
      _routeDirection: 'southbound',
    });

    const result = vesselDataService.getVesselsForBridgeText();
    expect(result).toHaveLength(1);
    expect(result[0].mmsi).toBe('210548000');
  });
});
