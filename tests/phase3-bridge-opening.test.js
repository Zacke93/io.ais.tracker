'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

describe('Phase 3 (Bridge Opening) text output', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(new BridgeRegistry(), logger, null, vesselDataService, null);
  });

  test('1: _bridgeOpeningUntil=future, bridge=Klaffbron → "Broooppning pagar vid Klaffbron"', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Klaffbron',
      _bridgeOpeningUntil: Date.now() + 15000,
      _bridgeOpeningBridgeName: 'Klaffbron',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 5000,
      currentBridge: null,
      distanceToCurrent: null,
      distance: 60,
    }]);
    expect(text).toBe('Broöppning pågår vid Klaffbron');
  });

  test('2: _bridgeOpeningUntil=future, bridge=Stallbackabron → "passerar" (NOT "Broooppning pagar")', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      _bridgeOpeningUntil: Date.now() + 15000,
      _bridgeOpeningBridgeName: 'Stallbackabron',
      lastPassedBridge: 'Stallbackabron',
      lastPassedBridgeTime: Date.now() - 5000,
      currentBridge: null,
      distanceToCurrent: null,
      distance: 60,
    }]);
    expect(text).toMatch(/passerar Stallbackabron/);
    expect(text).not.toContain('Broöppning pågår');
  });

  test('3: _bridgeOpeningUntil=past, dist=30m from bridge → falls through to Phase 3 distance fallback or Phase 4', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      _bridgeOpeningUntil: Date.now() - 5000,
      _bridgeOpeningBridgeName: 'Klaffbron',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 10000,
      currentBridge: 'Klaffbron',
      distanceToCurrent: 30,
      distance: 30,
    }]);
    // With dist<50 and currentBridge set, this triggers Phase 3 via distance fallback
    expect(text).toMatch(/Broöppning pågår vid Klaffbron/);
  });

  test('4: _bridgeOpeningUntil=future + 2 additional vessels → count text', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        _bridgeOpeningUntil: Date.now() + 15000,
        _bridgeOpeningBridgeName: 'Stridsbergsbron',
        lastPassedBridge: 'Stridsbergsbron',
        lastPassedBridgeTime: Date.now() - 5000,
        currentBridge: null,
        distanceToCurrent: null,
        distance: 40,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 10,
        sog: 3.5,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 8,
        currentBridge: null,
        distance: 800,
      },
      {
        mmsi: '999000003',
        name: 'V3',
        cog: 10,
        sog: 3.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 12,
        currentBridge: null,
        distance: 1500,
      },
    ]);
    expect(text).toMatch(/Broöppning pågår vid Stridsbergsbron/);
    expect(text).toMatch(/ytterligare två båtar på väg/);
  });

  test('5: dist<50m WITHOUT _bridgeOpeningUntil → Phase 3 via distance fallback', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Klaffbron',
      etaMinutes: null,
      currentBridge: 'Klaffbron',
      distanceToCurrent: 25,
    }]);
    expect(text).toBe('Broöppning pågår vid Klaffbron');
  });
});
