'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGE_TEXT_CONSTANTS, PASSAGE_TIMING } = require('../lib/constants');

describe('BridgeTextService — final bridge passage (Bug 1/5/7)', () => {
  let service;
  const logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn() };
  const registry = new BridgeRegistry();

  beforeEach(() => {
    service = new BridgeTextService(registry, logger);
    jest.clearAllMocks();
  });

  const makeVessel = (overrides) => ({
    mmsi: '265999000',
    name: 'SVITZER EMBLA',
    sog: 4,
    cog: 200, // southbound
    lat: 58.283,
    lon: 12.283,
    currentBridge: 'Klaffbron',
    distanceToCurrent: 400,
    targetBridge: null,
    lastPassedBridge: null,
    lastPassedBridgeTime: null,
    _routeDirection: 'south',
    ...overrides,
  });

  // --- Test 1: Southbound passed Klaffbron → "precis passerat Klaffbron" (NOT default) ---
  test('southbound vessel past Klaffbron shows "precis passerat" text, not default', () => {
    const vessel = makeVessel({
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 5000,
      targetBridge: null,
      currentBridge: null,
      distanceToCurrent: null,
    });

    const text = service.generateBridgeText([vessel]);
    expect(text).not.toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(text).toContain('precis passerat Klaffbron');
  });

  // --- Test 2: Northbound passed Stridsbergsbron → "precis passerat Stridsbergsbron" ---
  test('northbound vessel past Stridsbergsbron shows "precis passerat" text', () => {
    const vessel = makeVessel({
      cog: 20, // northbound
      _routeDirection: 'north',
      lastPassedBridge: 'Stridsbergsbron',
      lastPassedBridgeTime: Date.now() - 5000,
      targetBridge: null,
      currentBridge: null,
      distanceToCurrent: null,
    });

    const text = service.generateBridgeText([vessel]);
    expect(text).not.toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(text).toContain('precis passerat Stridsbergsbron');
  });

  // --- Test 3: Two vessels both passed final bridge → text with "ytterligare" ---
  test('two vessels past final bridge include additional count', () => {
    const v1 = makeVessel({
      mmsi: '265999001',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 5000,
      targetBridge: null,
      currentBridge: null,
      distanceToCurrent: null,
    });
    const v2 = makeVessel({
      mmsi: '265999002',
      name: 'BALTIC EXPRESS',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 3000,
      targetBridge: null,
      currentBridge: null,
      distanceToCurrent: null,
    });

    const text = service.generateBridgeText([v1, v2]);
    expect(text).not.toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(text).toContain('precis passerat Klaffbron');
    expect(text).toContain('ytterligare');
  });

  // --- Test 4: targetBridge=null + lastPassedBridge=Klaffbron → correct text ---
  test('null target bridge with passed Klaffbron still generates valid text', () => {
    const vessel = makeVessel({
      targetBridge: null,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 2000,
      currentBridge: null,
      distanceToCurrent: null,
    });

    const text = service.generateBridgeText([vessel]);
    expect(text).not.toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(text).toContain('passerat Klaffbron');
  });

  // --- Test 5: Expired PASSED_HOLD_MS with completed journey still shows Phase 4 (H2) ---
  test('expired PASSED_HOLD_MS with no targetBridge (completed journey) still shows "precis passerat"', () => {
    const vessel = makeVessel({
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - PASSAGE_TIMING.PASSED_HOLD_MS - 5000,
      targetBridge: null,
      currentBridge: null,
      distanceToCurrent: null,
    });

    const text = service.generateBridgeText([vessel]);
    // H2: completedJourney keeps Phase 4 active until VDS removes the vessel
    expect(text).toContain('precis passerat');
  });

  // --- Test 5b: Expired PASSED_HOLD_MS WITH targetBridge → no "precis passerat" ---
  test('expired PASSED_HOLD_MS with targetBridge does not show "precis passerat"', () => {
    const vessel = makeVessel({
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - PASSAGE_TIMING.PASSED_HOLD_MS - 5000,
      targetBridge: 'Stridsbergsbron',
      currentBridge: null,
      distanceToCurrent: null,
    });

    const text = service.generateBridgeText([vessel]);
    // Normal journey: expired hold window + active target → no Phase 4
    expect(text).not.toContain('precis passerat');
  });

  // --- Test 6: Mixed directions → semicolon separated text ---
  test('mixed directions produce semicolon-separated text', () => {
    const southVessel = makeVessel({
      mmsi: '265999010',
      cog: 200,
      _routeDirection: 'south',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 2000,
      targetBridge: null,
      currentBridge: null,
      distanceToCurrent: null,
    });
    const northVessel = makeVessel({
      mmsi: '265999011',
      name: 'NORTH VESSEL',
      cog: 20,
      _routeDirection: 'north',
      lastPassedBridge: 'Stridsbergsbron',
      lastPassedBridgeTime: Date.now() - 2000,
      targetBridge: null,
      currentBridge: null,
      distanceToCurrent: null,
    });

    const text = service.generateBridgeText([northVessel, southVessel]);
    expect(text).toContain('; ');
    expect(text).toContain('Klaffbron');
    expect(text).toContain('Stridsbergsbron');
  });

  // --- Test 7: _buildPassed with null target → verifies directly ---
  test('_buildPassed with null targetBridge returns text without direction', () => {
    const text = service._buildPassed('Klaffbron', null, null, 0);
    expect(text).toBe('En båt har precis passerat Klaffbron');
  });

  // --- Test 8: _buildPassed with target → includes direction ---
  test('_buildPassed with target bridge includes "på väg mot"', () => {
    const text = service._buildPassed('Järnvägsbron', 'Stridsbergsbron', null, 0);
    expect(text).toContain('på väg mot Stridsbergsbron');
  });

  // --- Test 9: _resolveTargetBridge returns null beyond last bridge (south) ---
  test('_resolveTargetBridge returns null for vessel past final southbound bridge', () => {
    const vessel = makeVessel({
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 2000,
      targetBridge: 'Klaffbron', // same as passed → triggers next lookup
    });

    const result = service._resolveTargetBridge(vessel, null, 'south');
    // Klaffbron is southernmost target, going south → no next target
    expect(result).toBeNull();
  });

  // --- Test 10: _resolveTargetBridge returns null for vessel past final northbound bridge ---
  test('_resolveTargetBridge returns null for vessel past Stridsbergsbron going north', () => {
    const vessel = makeVessel({
      cog: 20,
      _routeDirection: 'north',
      lastPassedBridge: 'Stridsbergsbron',
      lastPassedBridgeTime: Date.now() - 2000,
      targetBridge: 'Stridsbergsbron',
    });

    // getNextBridgeAfter Stridsbergsbron going north → Stallbackabron is not a target bridge
    const result = service._resolveTargetBridge(vessel, null, 'north');
    expect(result).toBeNull();
  });
});
