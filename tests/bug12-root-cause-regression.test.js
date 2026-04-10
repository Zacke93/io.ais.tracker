'use strict';

/**
 * Root cause regression tests for Bug 12: targetBridge regression to passed bridge.
 *
 * Three interacting problems caused the text to show "på väg mot Klaffbron" after
 * a northbound vessel had already passed it:
 *
 * A. currentBridge set to already-passed bridge (PASSAGE_CLEAR_WINDOW expired)
 * B. _resolveTargetBridge overrides vessel.targetBridge with currentBridge
 * C. _calculateTargetBridge assigns bridge already in passedBridges
 */

jest.mock('homey');

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const AISBridgeApp = require('../app');

describe('Bug 12 root cause: no regression to passed bridges', () => {
  // =========================================================================
  // Fix A: currentBridge must not be set to a bridge in passedBridges
  // =========================================================================
  describe('Fix A: _findRelevantBoatsForBridgeText currentBridge guard', () => {
    let app;

    beforeEach(() => {
      app = new AISBridgeApp();
      app.debug = jest.fn();
      app.log = jest.fn();
      app.error = jest.fn();
      app._vesselRemovalTimers = new Map();
      app._processingRemoval = new Set();

      app.vesselDataService = {
        getVesselsForBridgeText: jest.fn(),
      };
      app.proximityService = {
        analyzeVesselProximity: jest.fn(),
      };
      app.bridgeRegistry = new BridgeRegistry();
    });

    test('currentBridge not set to bridge in passedBridges even after PASSAGE_CLEAR_WINDOW', () => {
      const vessel = {
        mmsi: '257941000',
        name: 'NORDIC SIRA',
        targetBridge: 'Stridsbergsbron',
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 120000, // 120s ago — well past 60s window
        passedBridges: ['Olidebron', 'Klaffbron'],
        sog: 3.5,
        cog: 20,
        lat: 58.287,
        lon: 12.287,
        status: 'en-route',
      };

      app.vesselDataService.getVesselsForBridgeText.mockReturnValue([vessel]);
      app.proximityService.analyzeVesselProximity.mockReturnValue({
        nearestBridge: { name: 'Klaffbron' },
        nearestDistance: 314,
        bridgeDistances: {},
      });

      const result = app._findRelevantBoatsForBridgeText();

      expect(result[0].currentBridge).toBeNull();
      expect(result[0].targetBridge).toBe('Stridsbergsbron');
    });

    test('currentBridge IS set when bridge not in passedBridges', () => {
      const vessel = {
        mmsi: '257941000',
        name: 'NORDIC SIRA',
        targetBridge: 'Klaffbron',
        lastPassedBridge: null,
        lastPassedBridgeTime: null,
        passedBridges: [],
        sog: 3.5,
        cog: 20,
        lat: 58.282,
        lon: 12.283,
        status: 'approaching',
      };

      app.vesselDataService.getVesselsForBridgeText.mockReturnValue([vessel]);
      app.proximityService.analyzeVesselProximity.mockReturnValue({
        nearestBridge: { name: 'Klaffbron' },
        nearestDistance: 200,
        bridgeDistances: {},
      });

      const result = app._findRelevantBoatsForBridgeText();

      expect(result[0].currentBridge).toBe('Klaffbron');
    });
  });

  // =========================================================================
  // Fix B: _resolveTargetBridge must not return passed bridge as target
  // =========================================================================
  describe('Fix B: _resolveTargetBridge passedBridges guard', () => {
    let service;
    const logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn() };
    const registry = new BridgeRegistry();

    beforeEach(() => {
      service = new BridgeTextService(registry, logger);
      jest.clearAllMocks();
    });

    test('returns vessel.targetBridge when currentBridge is in passedBridges', () => {
      const vessel = {
        targetBridge: 'Stridsbergsbron',
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 120000,
        passedBridges: ['Olidebron', 'Klaffbron'],
        _bridgeOpeningUntil: null,
      };

      const result = service._resolveTargetBridge(vessel, 'Klaffbron', 'north');

      expect(result).toBe('Stridsbergsbron');
    });

    test('returns bridgeName when currentBridge is NOT in passedBridges', () => {
      const vessel = {
        targetBridge: 'Klaffbron',
        lastPassedBridge: null,
        lastPassedBridgeTime: null,
        passedBridges: [],
        _bridgeOpeningUntil: null,
      };

      const result = service._resolveTargetBridge(vessel, 'Klaffbron', 'north');

      expect(result).toBe('Klaffbron');
    });
  });

  // =========================================================================
  // Fix C: _calculateTargetBridge must not assign passed bridges
  // =========================================================================
  describe('Fix C: _calculateTargetBridge passedBridges guard', () => {
    let vesselDataService;
    const logger = {
      debug: jest.fn(), error: jest.fn(), log: jest.fn(), warn: jest.fn(),
    };

    beforeEach(() => {
      global.__TEST_MODE__ = true;
      const bridgeRegistry = new BridgeRegistry();
      const systemCoordinator = new SystemCoordinator(logger);
      vesselDataService = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
    });

    afterEach(() => {
      vesselDataService.clearAllTimers();
      delete global.__TEST_MODE__;
    });

    test('northbound vessel south of Klaffbron with Klaffbron passed gets Stridsbergsbron', () => {
      const vessel = {
        mmsi: '257941000',
        lat: 58.282, // south of Klaffbron (58.284)
        lon: 12.283,
        sog: 3.5,
        cog: 20,
        passedBridges: ['Olidebron', 'Klaffbron'],
      };

      const result = vesselDataService._calculateTargetBridge(vessel);

      expect(result).toBe('Stridsbergsbron');
    });

    test('northbound vessel south of Klaffbron WITHOUT passage gets Klaffbron', () => {
      const vessel = {
        mmsi: '257941001',
        lat: 58.282,
        lon: 12.283,
        sog: 3.5,
        cog: 20,
        passedBridges: [],
      };

      const result = vesselDataService._calculateTargetBridge(vessel);

      expect(result).toBe('Klaffbron');
    });

    test('southbound vessel north of Stridsbergsbron with Stridsbergsbron passed gets Klaffbron', () => {
      const vessel = {
        mmsi: '257941002',
        lat: 58.295, // north of Stridsbergsbron (58.294)
        lon: 12.295,
        sog: 3.5,
        cog: 200,
        passedBridges: ['Stridsbergsbron'],
      };

      const result = vesselDataService._calculateTargetBridge(vessel);

      expect(result).toBe('Klaffbron');
    });

    test('northbound vessel between bridges with both passed returns null', () => {
      const vessel = {
        mmsi: '257941003',
        lat: 58.290,
        lon: 12.290,
        sog: 3.5,
        cog: 20,
        passedBridges: ['Klaffbron', 'Stridsbergsbron'],
      };

      const result = vesselDataService._calculateTargetBridge(vessel);

      expect(result).toBeNull();
    });
  });
});
