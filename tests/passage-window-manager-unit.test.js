'use strict';

const PassageWindowManager = require('../lib/utils/PassageWindowManager');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { PASSAGE_TIMING } = require('../lib/constants');

/**
 * Enhetstester för PassageWindowManager — visningsfönster vs interna
 * grace-perioder för bropassager. Modulen används i produktion av
 * StatusService (isWithinInternalGracePeriod) och VesselDataService
 * (shouldShowRecentlyPassed/getDisplayWindow).
 *
 * Städat 2026-07-05: getDynamicPassageWindow raderades (död kod — inga
 * produktionsanropare) tillsammans med sina tester; de typeof-vaktade
 * removeVessel-anropen i VesselDataService raderades samtidigt.
 */
describe('PassageWindowManager — passagefönster (kontrakt)', () => {
  let manager;
  let logger;

  beforeEach(() => {
    logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    manager = new PassageWindowManager(logger, new BridgeRegistry());
  });

  describe('getDisplayWindow — visningsfönstret för "precis passerat"', () => {
    test('är 150 s (PASSED_HOLD_MS: 30 s öppning + 120 s passerat)', () => {
      expect(manager.getDisplayWindow()).toBe(150000);
      expect(manager.getDisplayWindow()).toBe(PASSAGE_TIMING.PASSED_HOLD_MS);
    });
  });

  describe('getInternalGracePeriod — intern grace-period (fartOBEROENDE efter B8-städningen)', () => {
    test('giltig fart ger alltid 3 minuter, oavsett snabb eller långsam båt', () => {
      expect(manager.getInternalGracePeriod({ mmsi: '1', sog: 2.0 })).toBe(180000);
      expect(manager.getInternalGracePeriod({ mmsi: '2', sog: 8.0 })).toBe(180000);
      expect(manager.getInternalGracePeriod({ mmsi: '3', sog: 0 })).toBe(180000);
    });

    test('ogiltig båt/fart faller tillbaka på samma 3 minuter (systemstabilitet)', () => {
      expect(manager.getInternalGracePeriod(null)).toBe(180000);
      expect(manager.getInternalGracePeriod(undefined)).toBe(180000);
      expect(manager.getInternalGracePeriod({ mmsi: '4' })).toBe(180000);
      expect(manager.getInternalGracePeriod({ mmsi: '5', sog: NaN })).toBe(180000);
      expect(manager.getInternalGracePeriod({ mmsi: '6', sog: 'fem' })).toBe(180000);
    });

    test('grace-perioden matchar FAST_VESSEL_PASSED_WINDOW-konstanten', () => {
      expect(manager.getInternalGracePeriod({ mmsi: '7', sog: 4.0 }))
        .toBe(PASSAGE_TIMING.FAST_VESSEL_PASSED_WINDOW);
    });
  });

  describe('shouldShowRecentlyPassed — "precis passerat"-beslutet (visningsfönstret)', () => {
    test('passage för 60 s sedan visas (inom 150 s)', () => {
      const vessel = {
        mmsi: '265000011',
        lastPassedBridge: 'Järnvägsbron',
        lastPassedBridgeTime: Date.now() - 60000,
      };
      expect(manager.shouldShowRecentlyPassed(vessel)).toBe(true);
    });

    test('passage för 200 s sedan visas INTE (utanför 150 s)', () => {
      const vessel = {
        mmsi: '265000012',
        lastPassedBridge: 'Järnvägsbron',
        lastPassedBridgeTime: Date.now() - 200000,
      };
      expect(manager.shouldShowRecentlyPassed(vessel)).toBe(false);
    });

    test('kräver BÅDE lastPassedBridge och lastPassedBridgeTime', () => {
      expect(manager.shouldShowRecentlyPassed(null)).toBe(false);
      expect(manager.shouldShowRecentlyPassed({ mmsi: '13' })).toBe(false);
      expect(manager.shouldShowRecentlyPassed({
        mmsi: '14', lastPassedBridgeTime: Date.now() - 10000,
      })).toBe(false);
      expect(manager.shouldShowRecentlyPassed({
        mmsi: '15', lastPassedBridge: 'Klaffbron',
      })).toBe(false);
    });
  });

  describe('isWithinInternalGracePeriod — systemlogikens fönster (180 s)', () => {
    test('passage för 170 s sedan är inom grace-perioden, 190 s är utanför', () => {
      expect(manager.isWithinInternalGracePeriod({
        mmsi: '265000016', sog: 4.0, lastPassedBridgeTime: Date.now() - 170000,
      })).toBe(true);
      expect(manager.isWithinInternalGracePeriod({
        mmsi: '265000017', sog: 4.0, lastPassedBridgeTime: Date.now() - 190000,
      })).toBe(false);
    });

    test('saknad lastPassedBridgeTime ger false (kräver inte lastPassedBridge)', () => {
      expect(manager.isWithinInternalGracePeriod(null)).toBe(false);
      expect(manager.isWithinInternalGracePeriod({ mmsi: '18', sog: 4.0 })).toBe(false);
    });

    test('fönsterseparationen: 160 s är utanför visningsfönstret men inom grace-perioden', () => {
      const vessel = {
        mmsi: '265000019',
        sog: 4.0,
        lastPassedBridge: 'Järnvägsbron',
        lastPassedBridgeTime: Date.now() - 160000,
      };
      expect(manager.shouldShowRecentlyPassed(vessel)).toBe(false);
      expect(manager.isWithinInternalGracePeriod(vessel)).toBe(true);
    });
  });
});
