'use strict';

/**
 * Regression tests for production log 20260301-233130 bugfixes.
 *
 * Bug A: Race condition — dedup key set AFTER async trigger (dubbla flow triggers)
 * Bug B: Self-referencing text ("passerat Klaffbron på väg mot Klaffbron")
 * Bug C: Spurious triggers after passage (dedup cleared, re-triggered)
 * Bug D: Flow triggers after completed journey (_finalTargetBridge set)
 */

jest.mock('homey');

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const AISBridgeApp = require('../app');

describe('Production log 20260301 bugfixes', () => {
  // ─── Bug A: dedup key timing ───────────────────────────────────────

  describe('Bug A: Race condition in dedup-timing', () => {
    let app;

    beforeEach(() => {
      app = new AISBridgeApp();
      app.debug = jest.fn();
      app.log = jest.fn();
      app.error = jest.fn();
      app._triggeredBoatNearKeys = new Set();
    });

    test('dedup key is set before async trigger to prevent race', async () => {
      const callOrder = [];

      // Mock _triggerBoatNearFlowBest to record call order
      app._triggerBoatNearFlowBest = jest.fn().mockImplementation(async () => {
        // At the time of trigger, dedup key should already be in the set
        callOrder.push('trigger');
      });

      // Spy on the Set.add to record when it's called
      const originalAdd = app._triggeredBoatNearKeys.add.bind(app._triggeredBoatNearKeys);
      app._triggeredBoatNearKeys.add = jest.fn().mockImplementation((key) => {
        callOrder.push('add');
        return originalAdd(key);
      });

      const vessel = {
        mmsi: '265517000',
        status: 'approaching',
        currentBridge: 'Klaffbron',
      };

      // Call _triggerBoatNearFlowForBridge with required params
      await app._triggerBoatNearFlowForBridge(vessel, {
        bridgeId: 'klaffbron',
        bridgeName: 'Klaffbron',
        distance: 200,
        source: 'test',
      });

      // 'add' must come before 'trigger'
      const addIndex = callOrder.indexOf('add');
      const triggerIndex = callOrder.indexOf('trigger');
      expect(addIndex).toBeLessThan(triggerIndex);
    });

    test('dedup key is deleted on trigger failure', async () => {
      app._triggerBoatNearFlowBest = jest.fn().mockRejectedValue(new Error('trigger failed'));

      const vessel = {
        mmsi: '265517000',
        status: 'approaching',
        currentBridge: 'Klaffbron',
      };

      await app._triggerBoatNearFlowForBridge(vessel, {
        bridgeId: 'klaffbron',
        bridgeName: 'Klaffbron',
        distance: 200,
        source: 'test',
      });

      // After failure, the dedup key should be removed
      expect(app._triggeredBoatNearKeys.size).toBe(0);
    });
  });

  // ─── Bug B: Self-referencing text ──────────────────────────────────

  describe('Bug B: No self-reference in passed text', () => {
    let service;

    beforeEach(() => {
      jest.clearAllMocks();
      const bridgeRegistry = new BridgeRegistry();
      const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
      const vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
      service = new BridgeTextService(bridgeRegistry, logger, null, vesselDataService, null);
    });

    test('vessel that just passed Klaffbron should not say "mot Klaffbron"', () => {
      const vessel = {
        mmsi: '265517000',
        name: 'LURO',
        cog: 10,
        sog: 4.0,
        status: 'passed',
        currentBridge: 'Klaffbron',
        distanceToCurrent: 30,
        lastPassedBridge: 'Klaffbron',
        targetBridge: 'Klaffbron',
        passedBridges: ['Klaffbron'],
      };

      const text = service.generateBridgeText([vessel]);
      // Text should NOT contain self-reference "mot Klaffbron" when just passed Klaffbron
      expect(text).not.toMatch(/mot Klaffbron/);
    });
  });

  // ─── Bug C: Spurious triggers after passage ────────────────────────

  describe('Bug C: No trigger for passed vessels', () => {
    let app;

    beforeEach(() => {
      app = new AISBridgeApp();
      app.debug = jest.fn();
      app.log = jest.fn();
      app.error = jest.fn();
      app._analyzeVesselPosition = jest.fn().mockResolvedValue(undefined);
      app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);
      app._updateUIIfNeeded = jest.fn();
      app.statusService = { clearVesselETAHistory: jest.fn() };
    });

    test('vessel with status=passed and currentBridge should NOT trigger proximity flow', async () => {
      const vessel = {
        mmsi: '265517000',
        currentBridge: 'Klaffbron',
        targetBridge: null,
        status: 'passed',
      };

      await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });

      expect(app._triggerBoatNearFlow).not.toHaveBeenCalled();
    });
  });

  // ─── Bug D: Triggers after completed journey ──────────────────────

  describe('Bug D: No trigger for completed journeys', () => {
    let app;

    beforeEach(() => {
      app = new AISBridgeApp();
      app.debug = jest.fn();
      app.log = jest.fn();
      app.error = jest.fn();
      app._analyzeVesselPosition = jest.fn().mockResolvedValue(undefined);
      app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);
      app._updateUIIfNeeded = jest.fn();
      app.statusService = { clearVesselETAHistory: jest.fn() };
    });

    test('vessel with _finalTargetBridge should NOT trigger proximity flow', async () => {
      const vessel = {
        mmsi: '265517000',
        currentBridge: 'Stridsbergsbron',
        targetBridge: 'Stridsbergsbron',
        status: 'approaching',
        _finalTargetBridge: 'Stridsbergsbron',
      };

      await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });

      expect(app._triggerBoatNearFlow).not.toHaveBeenCalled();
    });
  });
});
