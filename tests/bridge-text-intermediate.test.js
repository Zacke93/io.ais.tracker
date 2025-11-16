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

  test('generates "precis passerat" för målbro efter att broöppning visats', () => {
    const now = Date.now();
    const baseVessel = {
      mmsi: '304225000',
      name: 'Test Vessel',
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 70,
      sog: 5,
      cog: 15,
      lat: constants.BRIDGES.klaffbron.lat + 0.01,
      lon: constants.BRIDGES.klaffbron.lon,
    };

    // Först registreras under-bro-stadiet
    const underStage = {
      ...baseVessel,
      status: 'under-bridge',
      currentBridge: 'Klaffbron',
      distanceToCurrent: 25,
      _pendingUnderBridgeBridgeName: 'Klaffbron',
      _pendingUnderBridgeSetAt: now - 500,
    };
    service.generateBridgeText([underStage]);

    const vessel = {
      ...baseVessel,
      status: 'passed',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: now - 15 * 1000,
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

  test('shows "Broöppning pågår" when synthetic under-bridge hold is active', () => {
    const now = Date.now();
    const vessel = {
      mmsi: '304225000',
      name: 'Synthetic Hold',
      status: 'waiting',
      currentBridge: 'Järnvägsbron',
      targetBridge: 'Stridsbergsbron',
      distanceToCurrent: 180,
      etaMinutes: 5,
      _syntheticUnderBridgeUntil: now + 5000,
      _syntheticUnderBridgeBridgeName: 'Järnvägsbron',
    };

    const text = service.generateBridgeText([vessel]);
    expect(text).toContain('Broöppning pågår vid Järnvägsbron');
  });

  test('delays "precis passerat" until "Broöppning pågår" har visats', () => {
    const now = Date.now();
    const vessel = {
      mmsi: '555666777',
      name: 'Sequence Vessel',
      status: 'passed',
      targetBridge: 'Stridsbergsbron',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: now - 4000,
      etaMinutes: 17,
      lat: constants.BRIDGES.klaffbron.lat,
      lon: constants.BRIDGES.klaffbron.lon,
      currentBridge: 'Klaffbron',
      distanceToCurrent: 120,
      _pendingUnderBridgeBridgeName: 'Klaffbron',
      _pendingUnderBridgeSetAt: now - 500,
    };

    const first = service.generateBridgeText([vessel]);
    expect(first).toContain('Broöppning pågår vid Klaffbron');

    const second = service.generateBridgeText([vessel]);
    expect(second).toMatch(/En båt har precis passerat Klaffbron/);
  });
});
