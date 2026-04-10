'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

describe('Bug A regression — southbound target bridge derivation', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(new BridgeRegistry(), logger, null, vesselDataService, null);
  });

  test('1: Southbound at Stallbackabron, no passedBridges → target=Stridsbergsbron', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 4.0,
      targetBridge: null,
      etaMinutes: 10,
      currentBridge: 'Stallbackabron',
      distanceToCurrent: 450,
    }]);
    expect(text).toMatch(/Stridsbergsbron/);
    expect(text).not.toMatch(/Klaffbron/);
  });

  test('2: Southbound at Jarnvagsbron → Phase 2 imminent at Järnvägsbron (local ETA ≤ 3 min)', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 4.0,
      targetBridge: null,
      etaMinutes: 5,
      currentBridge: 'Järnvägsbron',
      distanceToCurrent: 200,
    }]);
    // Phase 2 intermediate: local ETA 200/(4.0*30.867) ≈ 1.6 min → waiting at Järnvägsbron
    expect(text).toMatch(/Järnvägsbron/);
  });

  test('3: Northbound at Olidebron → Phase 2 imminent at Olidebron (local ETA ≤ 3 min)', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: null,
      etaMinutes: 8,
      currentBridge: 'Olidebron',
      distanceToCurrent: 200,
    }]);
    // Phase 2 intermediate: local ETA 200/(4.0*30.867) ≈ 1.6 min → waiting at Olidebron
    expect(text).toMatch(/Olidebron/);
  });

  test('4: Southbound vessel text says "mot Stridsbergsbron" (full pipeline format)', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 4.0,
      _routeDirection: 'southbound',
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 10,
      currentBridge: 'Stallbackabron',
      distanceToCurrent: 450,
    }]);
    expect(text).toMatch(/mot Stridsbergsbron/);
  });
});
