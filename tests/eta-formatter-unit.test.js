'use strict';

const ETAFormatter = require('../lib/utils/ETAFormatter');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES } = require('../lib/constants');

/**
 * Enhetstester för ETAFormatter — validering, formatering och beräkning.
 *
 * OBS (upptäckt vid granskning 2026-07-03): ETAFormatter require:as INTE av
 * någon produktionsfil — produktionens ETA-klausul byggs av
 * formatETABroOpeningClause i etaValidation. Formatets kontrakt här är
 * formatETA:s ("5 minuter", "1 timme", "1h 25min" — UTAN "om"-prefix),
 * vilket skiljer sig från produktionsgrammatiken. Karakteriseringstester.
 */
describe('ETAFormatter — ETA-formatering och beräkning (kontrakt)', () => {
  let formatter;
  let logger;

  // Klaffbrons riktiga koordinater (från lib/constants.js)
  const KLAFF_LAT = BRIDGES.klaffbron.lat;
  const KLAFF_LON = BRIDGES.klaffbron.lon;

  beforeEach(() => {
    logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    formatter = new ETAFormatter(new BridgeRegistry(), logger);
  });

  describe('formatETAWithContext — befintligt etaMinutes (formateringskontraktet)', () => {
    test('under 1 minut ger "strax"', () => {
      expect(formatter.formatETAWithContext({ etaMinutes: 0.5 })).toBe('strax');
    });

    test('exakt/avrundat till 1 ger singular "1 minut"', () => {
      expect(formatter.formatETAWithContext({ etaMinutes: 1 })).toBe('1 minut');
      expect(formatter.formatETAWithContext({ etaMinutes: 1.4 })).toBe('1 minut');
    });

    test('under en timme ger plural "N minuter" (avrundat)', () => {
      expect(formatter.formatETAWithContext({ etaMinutes: 5 })).toBe('5 minuter');
      expect(formatter.formatETAWithContext({ etaMinutes: 5.6 })).toBe('6 minuter');
      expect(formatter.formatETAWithContext({ etaMinutes: 59.4 })).toBe('59 minuter');
    });

    test('jämna timmar: "1 timme" respektive "2 timmar"', () => {
      expect(formatter.formatETAWithContext({ etaMinutes: 60 })).toBe('1 timme');
      // 62 → kvantiseras till 5-minutersbucket → 60 → "1 timme"
      expect(formatter.formatETAWithContext({ etaMinutes: 62 })).toBe('1 timme');
      // 118 → bucket 5 → 120 → "2 timmar"
      expect(formatter.formatETAWithContext({ etaMinutes: 118 })).toBe('2 timmar');
    });

    test('timmar + minuter kvantiseras: "1h 25min" (5-min-bucket under 2h)', () => {
      expect(formatter.formatETAWithContext({ etaMinutes: 87 })).toBe('1h 25min');
    });

    test('över 2 timmar kvantiseras till 10-min-bucket: "2h 30min"', () => {
      expect(formatter.formatETAWithContext({ etaMinutes: 152 })).toBe('2h 30min');
    });

    test('ogiltigt etaMinutes ger null (negativt, noll, NaN, >24h)', () => {
      expect(formatter.formatETAWithContext({ etaMinutes: -5 })).toBe(null);
      expect(formatter.formatETAWithContext({ etaMinutes: 0 })).toBe(null);
      expect(formatter.formatETAWithContext({ etaMinutes: NaN })).toBe(null);
      expect(formatter.formatETAWithContext({ etaMinutes: 1441 })).toBe(null);
    });

    test('saknat etaMinutes utan beräkningsflagga ger null', () => {
      expect(formatter.formatETAWithContext({})).toBe(null);
      expect(formatter.formatETAWithContext({ etaMinutes: null })).toBe(null);
    });

    test('väntande båt ger null när allowWaiting=false, men formateras som standard', () => {
      const vessel = { etaMinutes: 5, isWaiting: true };
      expect(formatter.formatETAWithContext(vessel, { allowWaiting: false })).toBe(null);
      expect(formatter.formatETAWithContext(vessel)).toBe('5 minuter');
    });
  });

  describe('formatETAWithContext — beräkning från position (calculateIfMissing)', () => {
    // Båt 0.01° söder om Klaffbron ≈ 1112 m från bron.
    const vesselNearKlaff = (sog) => ({
      mmsi: '265000001', lat: KLAFF_LAT - 0.01, lon: KLAFF_LON, sog,
    });

    test('beräknar ETA från avstånd och fart: ~1112 m i 5 knop ger "7 minuter"', () => {
      const result = formatter.formatETAWithContext(vesselNearKlaff(5), {
        calculateIfMissing: true, targetBridge: 'Klaffbron',
      });
      expect(result).toBe('7 minuter');
    });

    test('saknad SOG faller tillbaka på standardfarten 3 knop: "12 minuter"', () => {
      const result = formatter.formatETAWithContext(vesselNearKlaff(undefined), {
        calculateIfMissing: true, targetBridge: 'Klaffbron',
      });
      expect(result).toBe('12 minuter');
    });

    test('SOG 0 klampas till 0,5 knop (ingen division med noll): "1h 10min"', () => {
      const result = formatter.formatETAWithContext(vesselNearKlaff(0), {
        calculateIfMissing: true, targetBridge: 'Klaffbron',
      });
      expect(result).toBe('1h 10min');
    });

    test('mycket nära bron (<1 min) ger "strax"', () => {
      const vessel = {
        mmsi: '265000002', lat: KLAFF_LAT - 0.0005, lon: KLAFF_LON, sog: 5,
      };
      expect(formatter.formatETAWithContext(vessel, {
        calculateIfMissing: true, targetBridge: 'Klaffbron',
      })).toBe('strax');
    });

    test('båt exakt på bron (avstånd 0) ger null', () => {
      const vessel = {
        mmsi: '265000003', lat: KLAFF_LAT, lon: KLAFF_LON, sog: 5,
      };
      expect(formatter.formatETAWithContext(vessel, {
        calculateIfMissing: true, targetBridge: 'Klaffbron',
      })).toBe(null);
    });

    test('okänd målbro ger null (loggas, kastar inte)', () => {
      expect(formatter.formatETAWithContext(vesselNearKlaff(5), {
        calculateIfMissing: true, targetBridge: 'Finnsintebron',
      })).toBe(null);
      expect(logger.debug).toHaveBeenCalled();
    });

    test('ogiltiga båtkoordinater ger null', () => {
      const vessel = {
        mmsi: '265000004', lat: null, lon: KLAFF_LON, sog: 5,
      };
      expect(formatter.formatETAWithContext(vessel, {
        calculateIfMissing: true, targetBridge: 'Klaffbron',
      })).toBe(null);
    });

    test('befintlig giltig ETA används FÖRE beräkning (calculateIfMissing rör den inte)', () => {
      const vessel = { ...vesselNearKlaff(5), etaMinutes: 30 };
      expect(formatter.formatETAWithContext(vessel, {
        calculateIfMissing: true, targetBridge: 'Klaffbron',
      })).toBe('30 minuter');
    });

    test('forceCalculation=true ignorerar befintlig ETA och räknar om', () => {
      const vessel = { ...vesselNearKlaff(5), etaMinutes: 30 };
      expect(formatter.formatETAWithContext(vessel, {
        forceCalculation: true, targetBridge: 'Klaffbron',
      })).toBe('7 minuter');
    });

    test('ogiltig befintlig ETA + beräkningsflagga faller tillbaka på beräkning', () => {
      const vessel = { ...vesselNearKlaff(5), etaMinutes: NaN };
      expect(formatter.formatETAWithContext(vessel, {
        calculateIfMissing: true, targetBridge: 'Klaffbron',
      })).toBe('7 minuter');
    });

    test('kastar aldrig — registerfel fångas och ger null + logger.error', () => {
      const throwingRegistry = {
        getBridgeByName: () => {
          throw new Error('boom');
        },
      };
      const f = new ETAFormatter(throwingRegistry, logger);
      expect(f.formatETAWithContext(vesselNearKlaff(5), {
        calculateIfMissing: true, targetBridge: 'Klaffbron',
      })).toBe(null);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('convenience-metoderna (målbro / mellanbro / passerat)', () => {
    test('formatForTargetBridge: null för väntande båt, annars formaterad ETA', () => {
      expect(formatter.formatForTargetBridge({ etaMinutes: 5, isWaiting: true })).toBe(null);
      expect(formatter.formatForTargetBridge({ etaMinutes: 5 })).toBe('5 minuter');
    });

    test('formatForTargetBridge beräknar ALDRIG (ingen målbro-kontext)', () => {
      const vessel = {
        mmsi: '265000005', lat: KLAFF_LAT - 0.01, lon: KLAFF_LON, sog: 5,
      };
      expect(formatter.formatForTargetBridge(vessel)).toBe(null);
    });

    test('formatForIntermediateBridge: visar ETA även för väntande båt', () => {
      expect(formatter.formatForIntermediateBridge({ etaMinutes: 8, isWaiting: true }, 'Klaffbron'))
        .toBe('8 minuter');
    });

    test('formatForIntermediateBridge: beräknar när etaMinutes saknas', () => {
      const vessel = {
        mmsi: '265000006', lat: KLAFF_LAT - 0.01, lon: KLAFF_LON, sog: 5,
      };
      expect(formatter.formatForIntermediateBridge(vessel, 'Klaffbron')).toBe('7 minuter');
    });

    test('formatForPassedMessage: befintlig giltig ETA vinner, annars beräkning', () => {
      const vesselWithEta = {
        mmsi: '265000007', lat: KLAFF_LAT - 0.01, lon: KLAFF_LON, sog: 5, etaMinutes: 30,
      };
      expect(formatter.formatForPassedMessage(vesselWithEta, 'Klaffbron')).toBe('30 minuter');

      const vesselWithoutEta = {
        mmsi: '265000008', lat: KLAFF_LAT - 0.01, lon: KLAFF_LON, sog: 5,
      };
      expect(formatter.formatForPassedMessage(vesselWithoutEta, 'Klaffbron')).toBe('7 minuter');
    });
  });
});
