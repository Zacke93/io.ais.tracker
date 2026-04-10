'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const constants = require('../lib/constants');

const logger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
};

describe('BridgeTextService intermediate bridge messaging (stateless)', () => {
  let service;
  let vesselDataService;

  beforeEach(() => {
    jest.clearAllMocks();
    const bridgeRegistry = new BridgeRegistry();
    vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(bridgeRegistry, logger, null, vesselDataService, null);
  });

  test('generates "Broöppning pågår" for intermediate under-bridge (<50m)', () => {
    const vessel = {
      mmsi: '304225000',
      name: 'Test Vessel',
      currentBridge: 'Olidebron',
      targetBridge: 'Klaffbron',
      etaMinutes: 9,
      distanceToCurrent: 25,
      sog: 0.4,
      cog: 12,
      lat: constants.BRIDGES.olidebron.lat,
      lon: constants.BRIDGES.olidebron.lon,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toContain('Broöppning pågår vid Olidebron');
  });

  test('generates "precis passerat" for target bridge', () => {
    const now = Date.now();
    const vessel = {
      mmsi: '304225000',
      name: 'Test Vessel',
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 70,
      sog: 5,
      cog: 15,
      lat: constants.BRIDGES.klaffbron.lat + 0.01,
      lon: constants.BRIDGES.klaffbron.lon,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: now - 15000,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toMatch(/En båt har precis passerat Klaffbron på väg mot Stridsbergsbron/);
  });

  test('shows distance-based text for vessel near intermediate bridge', () => {
    const vessel = {
      mmsi: '304225000',
      name: 'Test Vessel',
      currentBridge: 'Olidebron',
      targetBridge: 'Klaffbron',
      etaMinutes: 8,
      distanceToCurrent: 120,
      cog: 12,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toMatch(/En båt 120m från Olidebron på väg mot Klaffbron/);
  });

  test('shows "på väg mot" for far vessel with intermediate currentBridge', () => {
    const vessel = {
      mmsi: '304225000',
      name: 'Test Vessel',
      currentBridge: 'Olidebron',
      targetBridge: 'Klaffbron',
      etaMinutes: 8,
      distanceToCurrent: 600,
      cog: 12,
    };

    const text = service.generateBridgeText([vessel]);
    // >=500m → "på väg mot [target]"
    expect(text).toMatch(/En båt på väg mot Klaffbron/);
  });

  test('shows "Broöppning pågår vid Järnvägsbron" for <50m', () => {
    const vessel = {
      mmsi: '304225000',
      name: 'Synthetic Hold',
      currentBridge: 'Järnvägsbron',
      targetBridge: 'Stridsbergsbron',
      distanceToCurrent: 25,
      etaMinutes: 5,
      cog: 10,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toContain('Broöppning pågår vid Järnvägsbron');
  });
});
