'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

describe('Stallbackabron — all phases (never shows "Broooppning")', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(new BridgeRegistry(), logger, null, vesselDataService, null);
  });

  test('1: Phase 1 (400m) → "En bat 400m fran Stallbackabron..."', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 12,
      currentBridge: 'Stallbackabron',
      distanceToCurrent: 400,
    }]);
    expect(text).toMatch(/En båt 400m från Stallbackabron på väg mot Stridsbergsbron/);
    expect(text).not.toContain('Broöppning');
  });

  test('2: Phase 2 (ETA<=3) → "passerar strax Stallbackabron"', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 2,
      currentBridge: 'Stallbackabron',
      distanceToCurrent: 100,
    }]);
    expect(text).toMatch(/passerar strax Stallbackabron/);
    expect(text).not.toContain('Broöppning');
    expect(text).not.toContain('inväntar');
  });

  test('3: Phase 3 (opening via _bridgeOpeningUntil) → "passerar Stallbackabron" (NOT "Broooppning pagar")', () => {
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
      distance: 50,
    }]);
    expect(text).toMatch(/passerar Stallbackabron/);
    expect(text).not.toContain('Broöppning pågår');
  });

  test('4: Phase 4 (passed) → "precis passerat Stallbackabron"', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 8,
      _bridgeOpeningUntil: Date.now() - 20000,
      _bridgeOpeningBridgeName: 'Stallbackabron',
      lastPassedBridge: 'Stallbackabron',
      lastPassedBridgeTime: Date.now() - 35000,
      currentBridge: null,
      distanceToCurrent: null,
      distance: 200,
    }]);
    expect(text).toMatch(/precis passerat Stallbackabron/);
  });

  test('5: Multi-vessel Phase 2 → "passerar strax...ytterligare 1 bat"', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 2,
        currentBridge: 'Stallbackabron',
        distanceToCurrent: 80,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 10,
        sog: 3.5,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 10,
        currentBridge: null,
        distance: 1000,
      },
    ]);
    expect(text).toMatch(/passerar strax Stallbackabron/);
    expect(text).toMatch(/ytterligare 1 båt/);
    expect(text).not.toContain('Broöppning');
  });

  test('6: No phase ever produces "Broooppning" together with "Stallbacka"', () => {
    const phases = [
      // Phase 1
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 12,
        currentBridge: 'Stallbackabron',
        distanceToCurrent: 300,
      },
      // Phase 2
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 2,
        currentBridge: 'Stallbackabron',
        distanceToCurrent: 80,
      },
      // Phase 3 (under bridge)
      {
        mmsi: '999000003',
        name: 'V3',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        currentBridge: 'Stallbackabron',
        distanceToCurrent: 25,
      },
      // Phase 3 (opening window)
      {
        mmsi: '999000004',
        name: 'V4',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        _bridgeOpeningUntil: Date.now() + 15000,
        _bridgeOpeningBridgeName: 'Stallbackabron',
        lastPassedBridge: 'Stallbackabron',
        lastPassedBridgeTime: Date.now() - 5000,
        currentBridge: null,
        distance: 50,
      },
    ];

    for (const vessel of phases) {
      const text = service.generateBridgeText([vessel]);
      expect(text).not.toMatch(/Broöppning.*Stallbacka|Stallbacka.*Broöppning/);
    }
  });
});
