'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

describe('BridgeTextService – GPS Hold UI protection', () => {
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };

  test('Returns default message when all vessels are filtered by GPS jump hold', () => {
    const registry = new BridgeRegistry(BRIDGES);
    const vesselDataService = { hasGpsJumpHold: (mmsi) => mmsi === '111111111' };

    const svc = new BridgeTextService(registry, logger, null, vesselDataService);

    const vessels = [{
      mmsi: '111111111',
      name: 'TestBåt',
      status: 'approaching',
      targetBridge: 'Stridsbergsbron',
      lat: 58.29,
      lon: 12.29,
      etaMinutes: 4,
      cog: 25,
    }];

    const text = svc.generateBridgeText(vessels);
    // With all vessels filtered by GPS hold, stateless service returns default
    expect(text).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });
});
