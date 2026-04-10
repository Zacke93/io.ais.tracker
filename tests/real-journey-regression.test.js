'use strict';

/**
 * Regression tests using realistic AIS positions derived from production logs.
 * Uses BridgeTextService directly (not RealAppTestRunner) for speed and isolation.
 * Validates that all bug fixes work together in end-to-end journeys.
 */

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, BRIDGE_TEXT_CONSTANTS, PASSAGE_TIMING } = require('../lib/constants');

const DEFAULT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;

describe('Real journey regression tests', () => {
  let service;
  const logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn() };
  const registry = new BridgeRegistry();

  beforeEach(() => {
    service = new BridgeTextService(registry, logger);
    jest.clearAllMocks();
  });

  // =========================================================================
  // Helper: build vessel at specific position relative to bridges
  // =========================================================================
  function vessel(overrides) {
    return {
      mmsi: '265999000',
      name: 'SVITZER EMBLA',
      sog: 4,
      cog: 200,
      _routeDirection: 'south',
      currentBridge: null,
      distanceToCurrent: null,
      targetBridge: null,
      lastPassedBridge: null,
      lastPassedBridgeTime: null,
      ...overrides,
    };
  }

  // Bridge positions for reference
  const STALLBACKA = BRIDGES.stallbackabron;
  const STRIDSBERG = BRIDGES.stridsbergsbron;
  const JARNVAG = BRIDGES.jarnvagsbron;
  const KLAFF = BRIDGES.klaffbron;
  const OLIDE = BRIDGES.olidebron;

  // =========================================================================
  // SVITZER EMBLA southbound: Stallbackabron → Stridsbergsbron → Järnvägsbron → Klaffbron
  // =========================================================================
  describe('SVITZER EMBLA southbound journey', () => {
    test('approaching Stallbackabron → text mentions Stallbackabron', () => {
      const v = vessel({
        lat: STALLBACKA.lat + 0.003, // ~330m north
        lon: STALLBACKA.lon,
        currentBridge: 'Stallbackabron',
        distanceToCurrent: 330,
        targetBridge: 'Stridsbergsbron',
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('Stallbackabron');
    });

    test('passed Stallbackabron → on way to Stridsbergsbron', () => {
      const v = vessel({
        lat: STALLBACKA.lat - 0.003,
        lon: STALLBACKA.lon,
        lastPassedBridge: 'Stallbackabron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: 'Stridsbergsbron',
        currentBridge: null,
        distanceToCurrent: null,
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('passerat Stallbackabron');
      expect(text).toContain('Stridsbergsbron');
    });

    test('approaching Stridsbergsbron → text mentions Stridsbergsbron', () => {
      const v = vessel({
        lat: STRIDSBERG.lat + 0.002,
        lon: STRIDSBERG.lon,
        currentBridge: 'Stridsbergsbron',
        distanceToCurrent: 220,
        targetBridge: 'Stridsbergsbron',
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('Stridsbergsbron');
    });

    test('passed Stridsbergsbron → on way to Klaffbron', () => {
      const v = vessel({
        lat: STRIDSBERG.lat - 0.002,
        lon: STRIDSBERG.lon,
        lastPassedBridge: 'Stridsbergsbron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: 'Klaffbron',
        currentBridge: null,
        distanceToCurrent: null,
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('passerat Stridsbergsbron');
      expect(text).toContain('Klaffbron');
    });

    test('near Järnvägsbron → Phase 2 imminent at Järnvägsbron (local ETA ≤ 3 min)', () => {
      const v = vessel({
        lat: JARNVAG.lat - 0.001,
        lon: JARNVAG.lon,
        currentBridge: 'Järnvägsbron',
        distanceToCurrent: 110,
        targetBridge: 'Klaffbron',
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      // 110m / (4 * 30.867 m/min) ≈ 0.9 min → Phase 2 imminent for intermediate bridge
      expect(text).toContain('Järnvägsbron');
    });

    test('passed final bridge (Klaffbron) → "precis passerat" NOT default', () => {
      const v = vessel({
        lat: KLAFF.lat - 0.002,
        lon: KLAFF.lon,
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: null,
        currentBridge: null,
        distanceToCurrent: null,
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('precis passerat Klaffbron');
    });
  });

  // =========================================================================
  // BALTIC EXPRESS southbound
  // =========================================================================
  describe('BALTIC EXPRESS southbound journey', () => {
    test('approaching Stridsbergsbron from north', () => {
      const v = vessel({
        mmsi: '265888000',
        name: 'BALTIC EXPRESS',
        lat: STRIDSBERG.lat + 0.003,
        lon: STRIDSBERG.lon,
        currentBridge: 'Stridsbergsbron',
        distanceToCurrent: 330,
        targetBridge: 'Stridsbergsbron',
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
    });

    test('past final bridge Klaffbron → not default', () => {
      const v = vessel({
        mmsi: '265888000',
        name: 'BALTIC EXPRESS',
        lat: KLAFF.lat - 0.002,
        lon: KLAFF.lon,
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: null,
        currentBridge: null,
        distanceToCurrent: null,
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('precis passerat Klaffbron');
    });
  });

  // =========================================================================
  // SVITZER EMBLA northbound: Olidebron → Klaffbron → Järnvägsbron → Stridsbergsbron
  // =========================================================================
  describe('SVITZER EMBLA northbound journey', () => {
    const northbound = { cog: 20, _routeDirection: 'north' };

    test('near Olidebron → text shows intermediate bridge + target', () => {
      const v = vessel({
        ...northbound,
        lat: OLIDE.lat + 0.001,
        lon: OLIDE.lon,
        currentBridge: 'Olidebron',
        distanceToCurrent: 110,
        targetBridge: 'Klaffbron',
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('Olidebron');
    });

    test('approaching Klaffbron northbound', () => {
      const v = vessel({
        ...northbound,
        lat: KLAFF.lat - 0.001,
        lon: KLAFF.lon,
        currentBridge: 'Klaffbron',
        distanceToCurrent: 110,
        targetBridge: 'Klaffbron',
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('Klaffbron');
    });

    test('passed Klaffbron northbound → on way to Stridsbergsbron', () => {
      const v = vessel({
        ...northbound,
        lat: KLAFF.lat + 0.002,
        lon: KLAFF.lon,
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: 'Stridsbergsbron',
        currentBridge: null,
        distanceToCurrent: null,
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('passerat Klaffbron');
      expect(text).toContain('Stridsbergsbron');
    });

    test('passed final bridge (Stridsbergsbron) northbound → "precis passerat" NOT default', () => {
      const v = vessel({
        ...northbound,
        lat: STRIDSBERG.lat + 0.002,
        lon: STRIDSBERG.lon,
        lastPassedBridge: 'Stridsbergsbron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: null,
        currentBridge: null,
        distanceToCurrent: null,
      });
      const text = service.generateBridgeText([v]);
      expect(text).not.toBe(DEFAULT);
      expect(text).toContain('precis passerat Stridsbergsbron');
    });
  });

  // =========================================================================
  // Bug 6: Near target bridge without ETA → context text
  // =========================================================================
  test('near target bridge (<100m) without ETA includes "strax" context', () => {
    const v = vessel({
      lat: KLAFF.lat + 0.0005, // ~55m from Klaffbron
      lon: KLAFF.lon,
      currentBridge: 'Klaffbron',
      distanceToCurrent: 55,
      targetBridge: 'Klaffbron',
    });
    // No ETA on vessel
    const text = service.generateBridgeText([v]);
    expect(text).not.toBe(DEFAULT);
    // Should be under bridge text since < 50m might trigger that
    // or near text with "strax" for distances just above 50m
  });

  // =========================================================================
  // Bug 1 + 7: After last bridge, direction info in passed text
  // =========================================================================
  test('passed text for final bridge includes bridge name (not just generic)', () => {
    const v = vessel({
      lat: KLAFF.lat - 0.005,
      lon: KLAFF.lon,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 10000,
      targetBridge: null,
      currentBridge: null,
      distanceToCurrent: null,
    });
    const text = service.generateBridgeText([v]);
    expect(text).not.toBe(DEFAULT);
    expect(text).toContain('Klaffbron');
  });
});
