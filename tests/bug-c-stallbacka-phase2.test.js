'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

describe('Bug C — Stallbackabron Phase 2 "passerar strax" via local ETA', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(new BridgeRegistry(), logger, null, vesselDataService, null);
  });

  test('1: 150m from Stallbackabron, SOG 3.0 (ETA ~1.6 min ≤ 3) → "passerar strax"', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 3.0,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 15,
      currentBridge: 'Stallbackabron',
      distanceToCurrent: 150,
    }]);
    expect(text).toMatch(/passerar strax Stallbackabron/);
  });

  test('2: 400m from Stallbackabron, SOG 2.0 (ETA ~6.5 min > 3) → Phase 1 distance text', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 2.0,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 20,
      currentBridge: 'Stallbackabron',
      distanceToCurrent: 400,
    }]);
    expect(text).not.toMatch(/passerar strax/);
    expect(text).toMatch(/400m/);
  });

  test('3: 50m from Stallbackabron with bridge opening active → Phase 3 takes priority', () => {
    const now = Date.now();
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 3.0,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 15,
      currentBridge: 'Stallbackabron',
      distanceToCurrent: 50,
      _bridgeOpeningUntil: now + 20000,
      _bridgeOpeningBridgeName: 'Stallbackabron',
    }]);
    // Phase 3 (bridge opening) should take priority over Phase 2
    expect(text).not.toMatch(/passerar strax/);
    expect(text).toMatch(/passerar Stallbackabron/);
  });

  test('4: Stationary (SOG 0.2) 100m from Stallbackabron → SOG guard prevents Phase 2', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 0.2,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 30,
      currentBridge: 'Stallbackabron',
      distanceToCurrent: 100,
    }]);
    expect(text).not.toMatch(/passerar strax/);
    // Should fall through to Phase 1 (distance text)
    expect(text).toMatch(/100m/);
  });

  test('5: 180m from Klaffbron (target bridge), SOG 3.0 → uses normal etaMinutes Phase 2, not local ETA', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 3.0,
      targetBridge: 'Klaffbron',
      etaMinutes: 2,
      currentBridge: 'Klaffbron',
      distanceToCurrent: 180,
    }]);
    // Should use normal Phase 2 for target bridge (etaMinutes=2 ≤ 3)
    expect(text).not.toMatch(/passerar strax/);
    expect(text).toMatch(/Klaffbron/);
  });
});
