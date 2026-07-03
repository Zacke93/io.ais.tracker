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
 * OBS (upptäckt vid granskning 2026-07-03): VesselDataService anropar
 * passageWindowManager.removeVessel(mmsi) bakom en typeof-vakt, men metoden
 * finns inte — anropet är en tyst no-op (harmlöst, modulen är tillståndslös).
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

  describe('getDynamicPassageWindow — dynamiskt fönster från broavstånd', () => {
    // Samma formel som i modulen: restid × 1,5, klampad till [90 s, 300 s].
    const expectedWindow = (gapMeters, speedKnots) => {
      const speedMps = (speedKnots * 1852) / 3600;
      const timeWindow = (gapMeters / speedMps) * 1000 * 1.5;
      return Math.min(Math.max(timeWindow, 90000), 300000);
    };

    test('Järnvägsbron→Stridsbergsbron (420 m) i 5 knop ger restid × 1,5 inom gränserna', () => {
      const vessel = { mmsi: '265000001', sog: 5.0 };
      const result = manager.getDynamicPassageWindow(vessel, 'Järnvägsbron', 'Stridsbergsbron');
      expect(result).toBe(expectedWindow(420, 5.0));
      expect(result).toBeGreaterThan(90000);
      expect(result).toBeLessThan(300000);
    });

    test('omvänd riktning använder samma gap (Stridsbergsbron→Järnvägsbron)', () => {
      const vessel = { mmsi: '265000002', sog: 5.0 };
      expect(manager.getDynamicPassageWindow(vessel, 'Stridsbergsbron', 'Järnvägsbron'))
        .toBe(expectedWindow(420, 5.0));
    });

    test('snabb båt över kort gap klampas till minst 90 s', () => {
      const vessel = { mmsi: '265000003', sog: 15.0 };
      expect(manager.getDynamicPassageWindow(vessel, 'Järnvägsbron', 'Stridsbergsbron')).toBe(90000);
    });

    test('långsam båt över långt gap klampas till högst 300 s', () => {
      const vessel = { mmsi: '265000004', sog: 1.0 };
      expect(manager.getDynamicPassageWindow(vessel, 'Stridsbergsbron', 'Stallbackabron')).toBe(300000);
    });

    test('SOG 0 klampas till 0,5 knop (passerar vakten, ingen division med noll)', () => {
      const vessel = { mmsi: '265000005', sog: 0 };
      expect(manager.getDynamicPassageWindow(vessel, 'Klaffbron', 'Järnvägsbron')).toBe(300000);
    });

    test('okänt bropar faller tillbaka på 800 m-gapet', () => {
      const vessel = { mmsi: '265000006', sog: 8.0 };
      expect(manager.getDynamicPassageWindow(vessel, 'Olidebron', 'Stridsbergsbron'))
        .toBe(expectedWindow(800, 8.0));
    });

    test('ogiltig båt/fart faller tillbaka på interna grace-perioden (180 s)', () => {
      expect(manager.getDynamicPassageWindow(null, 'Klaffbron', 'Järnvägsbron')).toBe(180000);
      expect(manager.getDynamicPassageWindow({ mmsi: '7', sog: NaN }, 'Klaffbron', 'Järnvägsbron')).toBe(180000);
      expect(manager.getDynamicPassageWindow({ mmsi: '8', sog: -1 }, 'Klaffbron', 'Järnvägsbron')).toBe(180000);
    });

    test('saknade eller okända bronamn faller tillbaka på interna grace-perioden', () => {
      const vessel = { mmsi: '265000009', sog: 5.0 };
      expect(manager.getDynamicPassageWindow(vessel, null, 'Klaffbron')).toBe(180000);
      expect(manager.getDynamicPassageWindow(vessel, 'Klaffbron', undefined)).toBe(180000);
      expect(manager.getDynamicPassageWindow(vessel, 'Finnsintebron', 'Klaffbron')).toBe(180000);
    });

    test('kastar aldrig — trasigt registry fångas och ger fallback', () => {
      const throwingRegistry = {
        findBridgeIdByName: () => {
          throw new Error('boom');
        },
      };
      const m = new PassageWindowManager(logger, throwingRegistry);
      expect(m.getDynamicPassageWindow({ mmsi: '10', sog: 5.0 }, 'Klaffbron', 'Järnvägsbron')).toBe(180000);
      expect(logger.error).toHaveBeenCalled();
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
