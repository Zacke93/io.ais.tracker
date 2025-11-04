'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const constants = require('../lib/constants');

const logger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
};

describe('BridgeTextService intermediate bridge messaging', () => {
  let service;
  let vesselDataService;

  beforeEach(() => {
    jest.clearAllMocks();
    const bridgeRegistry = new BridgeRegistry();
    vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(bridgeRegistry, logger, null, vesselDataService, null);
  });

  test('generates "Broöppning pågår" for intermediate under-bridge', () => {
    const vessel = {
      mmsi: '304225000',
      name: 'Test Vessel',
      status: 'under-bridge',
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

  test('generates "precis passerat" for target bridge immediately after passage', () => {
    const vessel = {
      mmsi: '304225000',
      name: 'Test Vessel',
      status: 'passed',
      targetBridge: 'Stridsbergsbron',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 15 * 1000,
      etaMinutes: 70,
      sog: 5,
      cog: 15,
      lat: constants.BRIDGES.klaffbron.lat + 0.01,
      lon: constants.BRIDGES.klaffbron.lon,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toMatch(/En båt har precis passerat Klaffbron på väg mot Stridsbergsbron/);
  });

  test('uses "inväntar broöppning" phrasing when vessel is waiting at intermediate bridge', () => {
    const vessel = {
      mmsi: '304225000',
      name: 'Test Vessel',
      status: 'waiting',
      currentBridge: 'Olidebron',
      targetBridge: 'Klaffbron',
      etaMinutes: 8,
      distanceToCurrent: 120,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toBe('En båt inväntar broöppning av Olidebron på väg mot Klaffbron, beräknad broöppning om 8 minuter');
  });

  test('falls back to "på väg mot" when not actively waiting at intermediate bridge', () => {
    const vessel = {
      mmsi: '304225000',
      name: 'Test Vessel',
      status: 'en-route',
      currentBridge: 'Olidebron',
      targetBridge: 'Klaffbron',
      etaMinutes: 8,
      distanceToCurrent: 120,
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toBe('En båt på väg mot Klaffbron, beräknad broöppning om 8 minuter');
  });
});
