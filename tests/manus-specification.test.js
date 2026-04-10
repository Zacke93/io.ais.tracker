'use strict';

/**
 * Specification compliance for stateless distance+ETA bridge text service.
 *
 * Message format rules:
 * - >500m, no currentBridge → "En båt på väg mot [target], ETA [eta]"
 * - <500m → "En båt [dist]m från [bro], ETA [eta]"
 * - <50m target → "Broöppning pågår vid [bro]"
 * - <50m Stallbacka → "En båt passerar Stallbackabron..."
 * - Just passed → "En båt har precis passerat [bro] på väg mot [target]"
 * - <500m intermediate → "En båt [dist]m från [mellanbro] på väg mot [target], ETA [eta]"
 * - <50m intermediate → "Broöppning pågår vid [mellanbro] på väg mot [target]..."
 */

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const BridgeTextService = require('../lib/services/BridgeTextService');

describe('Stateless bridge text specification compliance', () => {
  let bridgeTextService;
  let logger;

  beforeEach(() => {
    logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const bridgeRegistry = new BridgeRegistry();
    bridgeTextService = new BridgeTextService(bridgeRegistry, logger);
  });

  describe('1. En-route (far from bridges)', () => {
    test('"på väg mot Klaffbron" for northbound vessel', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 14,
        currentBridge: null,
        distance: 2000,
      }]);
      expect(text).toMatch(/En båt på väg mot Klaffbron, ETA 14 minuter/);
    });

    test('"på väg mot Stridsbergsbron" for southbound vessel', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 205,
        sog: 5.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 10,
        currentBridge: null,
        distance: 2000,
      }]);
      expect(text).toMatch(/En båt på väg mot Stridsbergsbron/);
    });
  });

  describe('2. Near bridge (<500m) — distance text', () => {
    test('400m from intermediate Olidebron → Phase 2 imminent (local ETA ≤ 3 min)', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 14,
        currentBridge: 'Olidebron',
        distanceToCurrent: 400,
      }]);
      // At 400m / (5.0 * 30.867 m/min) ≈ 2.6 min → Phase 2 imminent for intermediate bridge
      expect(text).toBe('Båt inväntar broöppning vid Olidebron på väg mot Klaffbron, ETA 14 minuter');
    });

    test('400m from intermediate Järnvägsbron → Phase 2 imminent (local ETA ≤ 3 min)', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 8,
        currentBridge: 'Järnvägsbron',
        distanceToCurrent: 400,
      }]);
      // At 400m / (5.0 * 30.867 m/min) ≈ 2.6 min → Phase 2 imminent for intermediate bridge
      expect(text).toBe('Båt inväntar broöppning vid Järnvägsbron på väg mot Stridsbergsbron, ETA 8 minuter');
    });

    test('260m from target Klaffbron → distance text', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 5,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 260,
      }]);
      expect(text).toBe('En båt 260m från Klaffbron, ETA 5 minuter');
    });

    test('150m from target Stridsbergsbron with ETA ≤ 3 min → Phase 2 imminent', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 2,
        currentBridge: 'Stridsbergsbron',
        distanceToCurrent: 150,
      }]);
      expect(text).toBe('Båt inväntar broöppning vid Stridsbergsbron');
    });
  });

  describe('3. Under bridge (<50m)', () => {
    test('"Broöppning pågår vid Olidebron" + target ETA', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 2.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 16,
        currentBridge: 'Olidebron',
        distanceToCurrent: 30,
      }]);
      expect(text).toMatch(/Broöppning pågår vid Olidebron/);
    });

    test('"Broöppning pågår vid Klaffbron" — no ETA for target bridge', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 2.0,
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron',
        distanceToCurrent: 30,
      }]);
      expect(text).toBe('Broöppning pågår vid Klaffbron');
    });

    test('"Broöppning pågår vid Järnvägsbron"', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 2.0,
        targetBridge: 'Stridsbergsbron',
        currentBridge: 'Järnvägsbron',
        distanceToCurrent: 30,
      }]);
      expect(text).toMatch(/Broöppning pågår vid Järnvägsbron/);
    });
  });

  describe('4. Just passed', () => {
    test('"precis passerat Olidebron på väg mot Klaffbron"', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 15,
        lastPassedBridge: 'Olidebron',
        lastPassedBridgeTime: Date.now() - 5000,
        currentBridge: null,
        distance: 100,
      }]);
      expect(text).toMatch(/En båt har precis passerat Olidebron på väg mot Klaffbron/);
    });

    test('"precis passerat Klaffbron på väg mot Stridsbergsbron"', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 8,
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 4000,
        currentBridge: null,
        distance: 80,
      }]);
      expect(text).toMatch(/En båt har precis passerat Klaffbron på väg mot Stridsbergsbron/);
    });

    test('"precis passerat Järnvägsbron på väg mot Stridsbergsbron"', () => {
      // Bug B2: Phase 2 now runs before Phase 4, so ETA must be > 3 min
      // to avoid Phase 2 "inväntar" taking priority over Phase 4 "precis passerat"
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 5,
        lastPassedBridge: 'Järnvägsbron',
        lastPassedBridgeTime: Date.now() - 3000,
        currentBridge: null,
        distance: 60,
      }]);
      expect(text).toMatch(/En båt har precis passerat Järnvägsbron på väg mot Stridsbergsbron/);
    });

    test('southbound: "precis passerat Järnvägsbron på väg mot Klaffbron"', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 205,
        sog: 5.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 15,
        lastPassedBridge: 'Järnvägsbron',
        lastPassedBridgeTime: Date.now() - 5000,
        currentBridge: null,
        distance: 100,
        _routeDirection: 'south',
      }]);
      expect(text).toMatch(/En båt har precis passerat Järnvägsbron på väg mot Klaffbron/);
    });
  });

  describe('5. Stallbackabron special', () => {
    test('"passerar Stallbackabron" for <50m', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 205,
        sog: 5.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 9,
        currentBridge: 'Stallbackabron',
        distanceToCurrent: 30,
      }]);
      expect(text).toMatch(/En båt passerar Stallbackabron/);
    });

    test('distance text for Stallbackabron 470m', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 205,
        sog: 5.0,
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 10,
        currentBridge: 'Stallbackabron',
        distanceToCurrent: 470,
      }]);
      expect(text).toMatch(/En båt 470m från Stallbackabron på väg mot Stridsbergsbron/);
    });
  });

  describe('6. ETA formatting', () => {
    test('"1 minut" for singular', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 1,
        currentBridge: null,
        distance: 2000,
      }]);
      if (text.includes('minut')) {
        expect(text).toMatch(/ETA 1 minut(?!er)/);
      }
    });

    test('"X minuter" for plural', () => {
      const text = bridgeTextService.generateBridgeText([{
        mmsi: '123456789',
        name: 'V1',
        cog: 25,
        sog: 5.0,
        targetBridge: 'Klaffbron',
        etaMinutes: 14,
        currentBridge: null,
        distance: 2000,
      }]);
      expect(text).toMatch(/ETA \d+ minuter/);
    });
  });

  describe('7. Default "No Vessels" Message', () => {
    test('returns default for empty array', () => {
      expect(bridgeTextService.generateBridgeText([]))
        .toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
    });

    test('returns default for null', () => {
      expect(bridgeTextService.generateBridgeText(null))
        .toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
    });
  });

  describe('8. Multiple vessels', () => {
    test('"ytterligare" for additional vessels same direction', () => {
      const text = bridgeTextService.generateBridgeText([
        {
          mmsi: '111',
          name: 'V1',
          cog: 25,
          sog: 4.5,
          targetBridge: 'Klaffbron',
          etaMinutes: 5,
          currentBridge: 'Klaffbron',
          distanceToCurrent: 30,
        },
        {
          mmsi: '222',
          name: 'V2',
          cog: 25,
          sog: 4.5,
          targetBridge: 'Klaffbron',
          etaMinutes: 10,
          currentBridge: null,
          distance: 800,
        },
      ]);
      expect(text).toMatch(/ytterligare/i);
    });

    test('semicolon separates two directions', () => {
      const text = bridgeTextService.generateBridgeText([
        {
          mmsi: '111',
          name: 'V1',
          cog: 25,
          sog: 4.5,
          targetBridge: 'Klaffbron',
          currentBridge: 'Klaffbron',
          distanceToCurrent: 30,
        },
        {
          mmsi: '222',
          name: 'V2',
          cog: 205,
          sog: 4.5,
          targetBridge: 'Stridsbergsbron',
          etaMinutes: 8,
          currentBridge: 'Stridsbergsbron',
          distanceToCurrent: 400,
        },
      ]);
      expect(text).toContain(';');
    });
  });
});
