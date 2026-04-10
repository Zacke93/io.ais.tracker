'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

/**
 * Canonical scenarios for the stateless distance+ETA bridge text service.
 * Each vessel snapshot is independent — the service is a pure function.
 */
describe('Bridge text canonical exemplar journeys (stateless)', () => {
  let service;
  let bridgeRegistry;
  let vesselDataService;

  beforeEach(() => {
    jest.clearAllMocks();
    bridgeRegistry = new BridgeRegistry();
    vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(bridgeRegistry, logger, null, vesselDataService, null);
  });

  test('northbound: far from bridges → "på väg mot"', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Klaffbron',
      etaMinutes: 14,
      currentBridge: null,
      distance: 2000,
    }]);
    expect(text).toBe('En båt på väg mot Klaffbron, ETA 14 minuter');
  });

  test('northbound: 400m from intermediate Olidebron → Phase 2 imminent (local ETA ≤ 3 min)', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Klaffbron',
      etaMinutes: 14,
      currentBridge: 'Olidebron',
      distanceToCurrent: 400,
    }]);
    // At 400m / (4.5 * 30.867 m/min) ≈ 2.9 min → Phase 2 imminent for intermediate bridge
    expect(text).toBe('Båt inväntar broöppning vid Olidebron på väg mot Klaffbron, ETA 14 minuter');
  });

  test('northbound: under Olidebron (<50m) → Broöppning pågår', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Klaffbron',
      etaMinutes: 16,
      currentBridge: 'Olidebron',
      distanceToCurrent: 20,
    }]);
    expect(text).toMatch(/Broöppning pågår vid Olidebron/);
  });

  test('northbound: just passed Olidebron → precis passerat', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Klaffbron',
      etaMinutes: 15,
      lastPassedBridge: 'Olidebron',
      lastPassedBridgeTime: Date.now() - 5000,
      currentBridge: null,
      distance: 60,
    }]);
    expect(text).toMatch(/En båt har precis passerat Olidebron på väg mot Klaffbron/);
  });

  test('northbound: 260m from Klaffbron → distance text', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Klaffbron',
      etaMinutes: 5,
      currentBridge: 'Klaffbron',
      distanceToCurrent: 260,
    }]);
    expect(text).toBe('En båt 260m från Klaffbron, ETA 5 minuter');
  });

  test('northbound: under Klaffbron → Broöppning pågår', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Klaffbron',
      etaMinutes: null,
      currentBridge: 'Klaffbron',
      distanceToCurrent: 20,
    }]);
    expect(text).toBe('Broöppning pågår vid Klaffbron');
  });

  test('northbound: just passed Klaffbron → precis passerat', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 8,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 4000,
      currentBridge: null,
      distance: 80,
    }]);
    expect(text).toMatch(/En båt har precis passerat Klaffbron på väg mot Stridsbergsbron/);
  });

  test('northbound: 400m from Järnvägsbron → Phase 2 imminent (local ETA ≤ 3 min)', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: 15,
      currentBridge: 'Järnvägsbron',
      distanceToCurrent: 400,
    }]);
    // At 400m / (4.5 * 30.867 m/min) ≈ 2.9 min → Phase 2 imminent for intermediate bridge
    expect(text).toBe('Båt inväntar broöppning vid Järnvägsbron på väg mot Stridsbergsbron, ETA 15 minuter');
  });

  test('northbound: under Järnvägsbron → Broöppning pågår', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: null,
      currentBridge: 'Järnvägsbron',
      distanceToCurrent: 15,
    }]);
    expect(text).toMatch(/Broöppning pågår vid Järnvägsbron/);
  });

  test('northbound: under Stridsbergsbron → Broöppning pågår', () => {
    const text = service.generateBridgeText([{
      mmsi: '999000001',
      name: 'V1',
      cog: 10,
      sog: 4.5,
      targetBridge: 'Stridsbergsbron',
      etaMinutes: null,
      currentBridge: 'Stridsbergsbron',
      distanceToCurrent: 20,
    }]);
    expect(text).toBe('Broöppning pågår vid Stridsbergsbron');
  });

  test('no vessels → default message', () => {
    const text = service.generateBridgeText([]);
    expect(text).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
  });

  test('multiple vessels same direction → additional count', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.5,
        targetBridge: 'Klaffbron',
        etaMinutes: 5,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 280,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 10,
        sog: 4.5,
        targetBridge: 'Klaffbron',
        etaMinutes: 10,
        currentBridge: null,
        distance: 800,
      },
      {
        mmsi: '999000003',
        name: 'V3',
        cog: 10,
        sog: 4.5,
        targetBridge: 'Klaffbron',
        etaMinutes: 14,
        currentBridge: null,
        distance: 1500,
      },
    ]);
    expect(text).toMatch(/En båt 280m från Klaffbron.*ytterligare.*båt/);
  });

  test('two directions → combined with semicolon', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.5,
        targetBridge: 'Klaffbron',
        etaMinutes: 5,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 30,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 200,
        sog: 4.5,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 8,
        currentBridge: 'Stridsbergsbron',
        distanceToCurrent: 400,
      },
    ]);
    expect(text).toContain(';');
    expect(text).toContain('Broöppning pågår vid Klaffbron');
    expect(text).toMatch(/400m från Stridsbergsbron/);
  });
});
