'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

describe('Phase 2 (Imminent) boundary — ETA <= 3 min threshold', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(new BridgeRegistry(), logger, null, vesselDataService, null);
  });

  test('1: etaMinutes=3.0 at Klaffbron → Phase 2 "Bat invantar broooppning"', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 3.0,
      targetBridge: 'Klaffbron',
      etaMinutes: 3.0,
      currentBridge: 'Klaffbron',
      distanceToCurrent: 200,
    }]);
    expect(text).toBe('Båt inväntar broöppning vid Klaffbron på väg mot Stridsbergsbron, ETA 3 minuter');
  });

  test('2: etaMinutes=3.1 at Klaffbron → Phase 1 approach text with ETA', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 3.0,
      targetBridge: 'Klaffbron',
      etaMinutes: 3.1,
      currentBridge: 'Klaffbron',
      distanceToCurrent: 200,
    }]);
    expect(text).toMatch(/En båt 200m från Klaffbron/);
    expect(text).toMatch(/ETA/);
    expect(text).not.toContain('inväntar');
  });

  test('3: sog=0.3, dist=120m at Stridsbergsbron → Phase 2 stationary fallback', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 0.3,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: null,
      currentBridge: 'Stridsbergsbron',
      distanceToCurrent: 120,
    }]);
    expect(text).toBe('Båt inväntar broöppning vid Stridsbergsbron på väg mot Klaffbron');
  });

  test('4: etaMinutes=2 at Stallbackabron → "passerar strax" (NOT "invantar broooppning")', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 3.0,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 2,
      currentBridge: 'Stallbackabron',
      distanceToCurrent: 100,
    }]);
    expect(text).toMatch(/passerar strax Stallbackabron/);
    expect(text).not.toContain('inväntar broöppning');
    expect(text).not.toContain('Broöppning');
  });

  test('5: etaMinutes=2, at intermediate Olidebron, target=Klaffbron → Phase 2 waiting at Olidebron', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 3.0,
      targetBridge: 'Klaffbron',
      etaMinutes: 2,
      currentBridge: 'Olidebron',
      distanceToCurrent: 200,
    }]);
    // Phase 2 intermediate: local ETA 200/(3.0*30.867) ≈ 2.2 min → waiting at Olidebron
    expect(text).toBe('Båt inväntar broöppning vid Olidebron på väg mot Klaffbron, ETA 2 minuter');
  });
});
