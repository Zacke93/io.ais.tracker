'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { PASSAGE_TIMING } = require('../lib/constants');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

describe('Phase 3 -> Phase 4 transition timing', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(new BridgeRegistry(), logger, null, vesselDataService, null);
  });

  test('1: 10s after passage, opening still active → Phase 3 "Broooppning pagar"', () => {
    const passageTime = Date.now() - 10000; // 10s ago
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      _bridgeOpeningUntil: passageTime + PASSAGE_TIMING.BRIDGE_OPENING_DURATION, // still in future
      _bridgeOpeningBridgeName: 'Klaffbron',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: passageTime,
      currentBridge: null,
      distanceToCurrent: null,
      distance: 80,
    }]);
    expect(text).toMatch(/Broöppning pågår vid Klaffbron/);
  });

  test('2: 35s after passage, opening expired but within 60s → Phase 4 "precis passerat"', () => {
    const passageTime = Date.now() - 35000; // 35s ago
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      _bridgeOpeningUntil: passageTime + PASSAGE_TIMING.BRIDGE_OPENING_DURATION, // expired
      _bridgeOpeningBridgeName: 'Klaffbron',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: passageTime,
      currentBridge: null,
      distanceToCurrent: null,
      distance: 200,
    }]);
    expect(text).toMatch(/precis passerat Klaffbron/);
    expect(text).toMatch(/på väg mot Stridsbergsbron/);
  });

  test('3: 155s after passage, both windows expired → Phase 1 normal approach', () => {
    const passageTime = Date.now() - 155000; // 155s ago (beyond 150s PASSED_HOLD_MS)
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.0,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 5,
      _bridgeOpeningUntil: passageTime + PASSAGE_TIMING.BRIDGE_OPENING_DURATION,
      _bridgeOpeningBridgeName: 'Klaffbron',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: passageTime,
      currentBridge: 'Järnvägsbron',
      distanceToCurrent: 400,
    }]);
    // Both opening (30s) and passed (150s) windows have expired
    expect(text).not.toContain('Broöppning pågår');
    expect(text).not.toContain('precis passerat');
    expect(text).toMatch(/En båt.*Järnvägsbron.*Stridsbergsbron/);
  });
});
