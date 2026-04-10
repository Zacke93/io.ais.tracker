'use strict';

/**
 * Regression tests for production log 20260302-234816 bugfixes.
 *
 * Bug 1: Text regression — "precis passerat Klaffbron" → "265m från Klaffbron" (gap before elimination)
 * Bug 3: ETA instability — ETA increased 12→13→14→15 despite vessel approaching
 * Bug 5: Missing "Broöppning pågår" — 0 under-bridge events in entire session
 */

jest.mock('homey');

const AISBridgeApp = require('../app');
const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const constants = require('../lib/constants');

const mockLogger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

// ─── Bug 1: Text regression after terminal bridge passage ──────────────

describe('Bug 1: Terminal bridge _finalTargetBridge', () => {
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
    app.vesselDataService = { removeVessel: jest.fn() };
    app._hasPassedFinalTargetBridge = jest.fn().mockReturnValue(false);
  });

  afterEach(() => {
    // Clean up timers
    for (const timerId of app._vesselRemovalTimers.values()) {
      clearTimeout(timerId);
    }
    jest.useRealTimers();
  });

  test('_finalTargetBridge set on terminal passage (Klaffbron)', async () => {
    const vessel = {
      mmsi: '265517000',
      targetBridge: 'Klaffbron',
      passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'],
      status: 'passed',
      currentBridge: 'Klaffbron',
    };

    await app._onVesselStatusChanged({
      vessel,
      oldStatus: 'under-bridge',
      newStatus: 'passed',
      reason: 'passage_confirmed',
    });

    expect(vessel._finalTargetBridge).toBe('Klaffbron');
  });

  test('removal timer starts for terminal bridge passage', async () => {
    const vessel = {
      mmsi: '265517000',
      targetBridge: 'Klaffbron',
      passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'],
      status: 'passed',
      currentBridge: 'Klaffbron',
    };

    await app._onVesselStatusChanged({
      vessel,
      oldStatus: 'under-bridge',
      newStatus: 'passed',
      reason: 'passage_confirmed',
    });

    expect(app._vesselRemovalTimers.has('265517000')).toBe(true);
  });
});

// ─── Bug 3: ETA increases despite approach ─────────────────────────────

describe('Bug 3: ETA clamped for approaching vessel', () => {
  let calculator;

  beforeEach(() => {
    calculator = new ProgressiveETACalculator(mockLogger, new BridgeRegistry());
    jest.clearAllMocks();
  });

  afterEach(() => {
    calculator.destroy();
  });

  test('ETA does not increase for actively approaching vessel', () => {
    const proximityData = {
      nearestBridge: { id: 'jarnvagsbron', name: 'Järnvägsbron' },
      nearestDistance: 300,
    };

    // First calculation: baseline
    const v1 = {
      mmsi: 'ETA_BUG3',
      targetBridge: 'Stridsbergsbron',
      status: 'approaching',
      lat: constants.BRIDGES.stridsbergsbron.lat - 0.005,
      lon: constants.BRIDGES.stridsbergsbron.lon,
      sog: 4,
    };
    const eta1 = calculator.calculateProgressiveETA(v1, proximityData);
    expect(eta1).toBeGreaterThan(0);

    // Second: closer but slower → raw ETA would spike up
    const v2 = {
      mmsi: 'ETA_BUG3',
      targetBridge: 'Stridsbergsbron',
      status: 'approaching',
      lat: constants.BRIDGES.stridsbergsbron.lat - 0.004,
      lon: constants.BRIDGES.stridsbergsbron.lon,
      sog: 2.5, // slower → higher raw ETA
    };
    const eta2 = calculator.calculateProgressiveETA(v2, {
      ...proximityData,
      nearestDistance: 200,
    });

    // With Bug 3 fix: ETA should NOT increase (clamped at +0)
    // Allow small tolerance for EMA smoothing
    expect(eta2).toBeLessThanOrEqual(eta1 + 0.5);
  });
});

// ─── Bug 5: Missing "Broöppning pågår" ────────────────────────────────

describe('Bug 5a: Bridge opening activation at <50m', () => {
  let vesselDataService;

  beforeEach(() => {
    jest.clearAllMocks();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(mockLogger);
    vesselDataService = new VesselDataService(mockLogger, bridgeRegistry, systemCoordinator);
  });

  test('bridge opening activated at <50m WITH passageResult', () => {
    const vessel = {
      mmsi: '265517000',
      distanceToCurrent: 23,
      status: 'passed',
    };
    const oldVessel = {
      distanceToCurrent: 30,
    };
    const passageResult = {
      method: 'line_crossing',
      details: { previousDistance: 30, currentDistance: 23 },
    };

    vesselDataService._activateBridgeOpening(vessel, 'Klaffbron', oldVessel, passageResult);

    expect(vessel._bridgeOpeningUntil).toBeDefined();
    expect(vessel._bridgeOpeningUntil).toBeGreaterThan(Date.now());
  });

  test('bridge opening NOT activated at <50m WITHOUT passageResult', () => {
    const vessel = {
      mmsi: '265517000',
      distanceToCurrent: 23,
      status: 'approaching',
    };
    const oldVessel = {
      distanceToCurrent: 30,
    };

    vesselDataService._activateBridgeOpening(vessel, 'Klaffbron', oldVessel, null);

    expect(vessel._bridgeOpeningUntil).toBeUndefined();
  });
});

describe('Bug 5b: _isJustPassed during bridge opening window', () => {
  let bridgeTextService;

  beforeEach(() => {
    jest.clearAllMocks();
    const bridgeRegistry = new BridgeRegistry();
    bridgeTextService = new BridgeTextService(bridgeRegistry, mockLogger);
  });

  test('_isJustPassed returns true during bridge opening window (Phase 3 handles display)', () => {
    const vessel = {
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 2000, // 2s ago (within PASSED_HOLD_MS)
      _bridgeOpeningUntil: Date.now() + 6000, // 6s remaining
    };

    // _isJustPassed now always returns true within 60s window
    // Phase 3 vs 4 differentiation is handled by _generateDirectionPhrase
    const result = bridgeTextService._isJustPassed(vessel);
    expect(result).toBe(true);
  });
});
