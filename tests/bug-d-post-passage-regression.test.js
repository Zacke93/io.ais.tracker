'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

describe('Bug D — post-passage text regression to same bridge', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(new BridgeRegistry(), logger, null, vesselDataService, null);
  });

  test('1: _resolveTargetBridge does NOT return Klaffbron when already passed (90s elapsed)', () => {
    const vessel = {
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 4.0,
      targetBridge: 'Klaffbron',
      passedBridges: ['Klaffbron'],
      lastPassedBridge: 'Klaffbron',
      _passageTimestamp: Date.now() - 90000,
    };
    const result = service._resolveTargetBridge(vessel, null, 'southbound');
    expect(result).not.toBe('Klaffbron');
  });

  test('2: Full text after passing Klaffbron says "mot Stridsbergsbron", NOT "mot Klaffbron"', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 4.0,
      targetBridge: 'Klaffbron',
      etaMinutes: 1,
      passedBridges: ['Klaffbron'],
      lastPassedBridge: 'Klaffbron',
      _passageTimestamp: Date.now() - 90000,
      currentBridge: null,
      distanceToCurrent: null,
    }]);
    expect(text).not.toMatch(/mot Klaffbron/);
  });

  test('3: vessel.targetBridge=Stridsbergsbron, never passed → returns Stridsbergsbron normally', () => {
    const vessel = {
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      passedBridges: [],
      lastPassedBridge: null,
    };
    const result = service._resolveTargetBridge(vessel, null, 'southbound');
    expect(result).toBe('Stridsbergsbron');
  });

  test('4: lastPassedBridge=Klaffbron, passedBridges=[], 120s elapsed → does NOT return Klaffbron', () => {
    const vessel = {
      mmsi: '999000001',
      name: 'V1',
      cog: 200,
      sog: 4.0,
      targetBridge: 'Klaffbron',
      passedBridges: [],
      lastPassedBridge: 'Klaffbron',
      _passageTimestamp: Date.now() - 120000,
    };
    const result = service._resolveTargetBridge(vessel, null, 'southbound');
    expect(result).not.toBe('Klaffbron');
  });
});
