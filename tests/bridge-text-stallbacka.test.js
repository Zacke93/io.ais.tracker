'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const constants = require('../lib/constants');

const logger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
};

describe('BridgeTextService – Stallbackabron stateless distance-based', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BridgeTextService(new BridgeRegistry(), logger, null, null, null);
  });

  test('shows distance-based text for vessel 160m from Stallbackabron', () => {
    const vessel = {
      mmsi: '111222333',
      name: 'Northbound Test',
      currentBridge: 'Stallbackabron',
      targetBridge: 'Stridsbergsbron',
      distanceToCurrent: 160,
      etaMinutes: 12,
      cog: 10,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toMatch(/En båt 160m från Stallbackabron på väg mot Stridsbergsbron/);
  });

  test('shows "passerar" for vessel <50m from Stallbackabron', () => {
    const vessel = {
      mmsi: '111222333',
      name: 'Under Stallbacka',
      currentBridge: 'Stallbackabron',
      targetBridge: 'Stridsbergsbron',
      distanceToCurrent: 30,
      etaMinutes: 10,
      cog: 10,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toContain('En båt passerar Stallbackabron');
  });

  test('shows "på väg mot" for vessel far from Stallbackabron', () => {
    const vessel = {
      mmsi: '999888777',
      name: 'Far Away',
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 9,
      currentBridge: null,
      distanceToCurrent: null,
      distance: 2000,
      cog: 10,
      sog: 4.5,
      lat: constants.BRIDGES.stallbackabron.lat + 0.01,
      lon: constants.BRIDGES.stallbackabron.lon,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toMatch(/En båt på väg mot Stridsbergsbron/);
  });
});
