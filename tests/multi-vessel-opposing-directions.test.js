'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

describe('Multi-vessel opposing directions', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(new BridgeRegistry(), logger, null, vesselDataService, null);
  });

  test('1: V1 northbound→Klaffbron + V2 southbound→Stridsbergsbron — semicolon, correct bridges', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 8,
        currentBridge: 'Olidebron',
        distanceToCurrent: 300,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 200,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 6,
        currentBridge: 'Stallbackabron',
        distanceToCurrent: 400,
      },
    ]);
    expect(text).toContain(';');
    // North phrase: Olidebron (Phase 2 intermediate, local ETA ≤ 3 min)
    // South phrase: Stallbackabron (Phase 2 Stallbacka imminent)
    const parts = text.split(';').map((s) => s.trim());
    const northPart = parts.find((p) => p.includes('Olidebron'));
    const southPart = parts.find((p) => p.includes('Stallbackabron'));
    expect(northPart).toBeTruthy();
    expect(southPart).toBeTruthy();
  });

  test('2: V1 under Klaffbron (Phase 3) + V2 600m from Stridsbergsbron (Phase 1)', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        etaMinutes: null,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 20,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 200,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 7,
        currentBridge: null,
        distance: 600,
      },
    ]);
    expect(text).toContain(';');
    expect(text).toContain('Broöppning pågår vid Klaffbron');
    expect(text).toMatch(/En båt på väg mot Stridsbergsbron/);
  });

  test('3: Both bridges in Phase 3 simultaneously', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        _bridgeOpeningUntil: Date.now() + 15000,
        _bridgeOpeningBridgeName: 'Klaffbron',
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 5000,
        currentBridge: null,
        distance: 40,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 200,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        _bridgeOpeningUntil: Date.now() + 15000,
        _bridgeOpeningBridgeName: 'Stridsbergsbron',
        lastPassedBridge: 'Stridsbergsbron',
        lastPassedBridgeTime: Date.now() - 5000,
        currentBridge: null,
        distance: 40,
      },
    ]);
    expect(text).toContain(';');
    expect(text).toContain('Broöppning pågår vid Klaffbron');
    expect(text).toContain('Broöppning pågår vid Stridsbergsbron');
  });

  test('4: 2 northbound + 1 southbound → north: "ytterligare 1 bat"; south: single vessel', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 5,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 250,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 10,
        sog: 3.5,
        targetBridge: 'Klaffbron',
        etaMinutes: 12,
        currentBridge: null,
        distance: 1200,
      },
      {
        mmsi: '999000003',
        name: 'V3',
        cog: 200,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 8,
        currentBridge: 'Stallbackabron',
        distanceToCurrent: 400,
      },
    ]);
    expect(text).toContain(';');
    // North phrase should have "ytterligare 1 båt"
    const parts = text.split(';').map((s) => s.trim());
    const northPart = parts.find((p) => p.includes('Klaffbron'));
    expect(northPart).toMatch(/ytterligare 1 båt/);
    // South phrase should NOT have "ytterligare"
    const southPart = parts.find((p) => p.includes('Stridsbergsbron'));
    expect(southPart).not.toContain('ytterligare');
  });

  test('5: 3 northbound + 2 southbound (5 total) → both show lead + "ytterligare N"', () => {
    const text = service.generateBridgeText([
      // 3 northbound
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 5,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 200,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 10,
        sog: 3.5,
        targetBridge: 'Klaffbron',
        etaMinutes: 10,
        currentBridge: null,
        distance: 800,
      },
      {
        mmsi: '999000003',
        name: 'V3',
        cog: 10,
        sog: 3.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 15,
        currentBridge: null,
        distance: 1500,
      },
      // 2 southbound
      {
        mmsi: '999000004',
        name: 'V4',
        cog: 200,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 6,
        currentBridge: 'Stridsbergsbron',
        distanceToCurrent: 300,
      },
      {
        mmsi: '999000005',
        name: 'V5',
        cog: 200,
        sog: 3.5,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 12,
        currentBridge: null,
        distance: 1000,
      },
    ]);
    expect(text).toContain(';');
    const parts = text.split(';').map((s) => s.trim());

    // North: lead + ytterligare två
    const northPart = parts.find((p) => p.includes('Klaffbron'));
    expect(northPart).toMatch(/ytterligare två båtar/);

    // South: lead + ytterligare 1
    const southPart = parts.find((p) => p.includes('Stridsbergsbron'));
    expect(southPart).toMatch(/ytterligare 1 båt/);
  });
});
