'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES } = require('../lib/constants');

describe('🛡️ BridgeTextService – GPS Hold UI protection', () => {
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };

  test('Returns last bridge text when all vessels are filtered by GPS jump hold', () => {
    const registry = new BridgeRegistry(BRIDGES);
    const systemCoordinator = null; // not needed for this test
    const vesselDataService = { hasGpsJumpHold: (mmsi) => mmsi === '111111111' };

    const svc = new BridgeTextService(registry, logger, systemCoordinator, vesselDataService);
    svc.lastBridgeText = 'En båt närmar sig Stridsbergsbron, beräknad broöppning 4 min';

    const vessels = [{
      mmsi: '111111111',
      name: 'TestBåt',
      status: 'approaching',
      targetBridge: 'Stridsbergsbron',
      lat: 58.29,
      lon: 12.29,
      etaMinutes: 4,
    }];

    const text = svc.generateBridgeText(vessels);
    expect(text).toBe(svc.lastBridgeText);
  });
});
