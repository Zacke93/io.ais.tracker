'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const constants = require('../lib/constants');

const logger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
};

describe('BridgeTextService – Stallbackabron synthetic coverage', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BridgeTextService(new BridgeRegistry(), logger, null, null, null);
  });

  test('keeps "passerar Stallbackabron" when synthetic under-bridge hold is active', () => {
    const vessel = {
      mmsi: '111222333',
      name: 'Northbound Test',
      status: 'stallbacka-waiting',
      currentBridge: 'Stallbackabron',
      targetBridge: 'Stridsbergsbron',
      distanceToCurrent: 160,
      etaMinutes: 12,
      _syntheticUnderBridgeUntil: Date.now() + 8000,
      _syntheticUnderBridgeBridgeName: 'Stallbackabron',
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toContain('En båt passerar Stallbackabron');
  });

  test('forces "passerar Stallbackabron" när pending-flagga finns', () => {
    const now = Date.now();
    const vessel = {
      mmsi: '999888777',
      name: 'Pending Sample',
      status: 'stallbacka-waiting',
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 9,
      currentBridge: null,
      distanceToCurrent: null,
      lat: constants.BRIDGES.stallbackabron.lat + 0.01,
      lon: constants.BRIDGES.stallbackabron.lon,
      _pendingUnderBridgeBridgeName: 'Stallbackabron',
      _pendingUnderBridgeSetAt: now - 500,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toContain('passerar Stallbackabron');
  });
});
