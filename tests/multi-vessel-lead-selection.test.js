'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

describe('Multi-vessel lead selection (_vesselPriority)', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    service = new BridgeTextService(new BridgeRegistry(), logger, null, vesselDataService, null);
  });

  test('1: V1 at 400m, V2 under bridge (50m) → V2 is lead, Phase 3 text', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 5,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 400,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        etaMinutes: null,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 30,
      },
    ]);
    // Under-bridge (priority 0) beats close (priority 1)
    expect(text).toMatch(/Broöppning pågår vid Klaffbron/);
    expect(text).toMatch(/ytterligare 1 båt/);
  });

  test('2: V1 just-passed, V2 at 200m → V2 is lead, approach text', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 5,
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 10000,
        currentBridge: null,
        distance: 100,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 4,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 200,
      },
    ]);
    // Close (priority 1) beats just-passed (priority 3)
    // V2 at 200m should be lead
    expect(text).toMatch(/En båt 200m från Klaffbron/);
    expect(text).toMatch(/ytterligare 1 båt/);
  });

  test('3: V1 at 100m, V2 at 300m → V1 is lead (closer)', () => {
    const text = service.generateBridgeText([
      {
        mmsi: '999000001',
        name: 'V1',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 2,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 100,
      },
      {
        mmsi: '999000002',
        name: 'V2',
        cog: 10,
        sog: 4.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 4,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 300,
      },
    ]);
    // Both close (priority 1), V1 is closer → lead
    // V1 has etaMinutes=2 → Phase 2 imminent
    expect(text).toMatch(/Båt inväntar broöppning vid Klaffbron/);
    expect(text).toMatch(/ytterligare 1 båt/);
  });
});
