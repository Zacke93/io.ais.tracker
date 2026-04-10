'use strict';

/**
 * Production Bug Prevention Tests
 *
 * These tests are designed to catch bugs that were discovered in production (live app runs).
 * Each test targets a specific bug that was found in the logs.
 *
 * Bug U: Duplicate passage detections (28 occurrences in log 20251228-144423)
 * Bug Y: Wrong multi-vessel format ("X; Y" instead of "X, ytterligare N båt inväntar")
 * Bug Z: Southbound vessels getting wrong target after Klaffbron
 *
 * --- Log 2026-02-22 (app-20260222-215302.log) ---
 * Bug 1: "passerat X på väg mot X" — same bridge twice (stale targetBridge)
 * Bug 2: "Broöppning pågår" never shown for stopped vessel at 88m
 * Bug 3: Kanalinfarten flow trigger never fires
 * Bug 4: ETA=-1 in flow triggers (missing fallback ETA calculation)
 */

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

describe('Production Bug Prevention Tests', () => {
  let runner;

  beforeAll(async () => {
    runner = new RealAppTestRunner();
    await runner.initializeApp();
    runner.setWaitMultiplier(0.1);
  }, 30000);

  afterAll(async () => {
    await runner?.cleanup();
  });

  beforeEach(() => {
    // Clear all vessels between tests
    if (runner?.app?.vesselDataService) {
      const existing = runner.app.vesselDataService.getAllVessels();
      existing.forEach((v) => runner.app.vesselDataService.removeVessel(v.mmsi, 'test-reset'));
    }
    // Stateless BridgeTextService has no state to reset
  });

  describe('Bug U: Passage Deduplication', () => {
    test('should only detect passage once per AIS update cycle', async () => {
      const MMSI = '265644320';
      const { vesselDataService } = runner.app;

      // Track passage detection calls
      let passageDetectionCount = 0;
      const originalMethod = vesselDataService._hasPassedTargetBridge.bind(vesselDataService);

      vesselDataService._hasPassedTargetBridge = function passageTracker(vessel, oldVessel) {
        const result = originalMethod(vessel, oldVessel);
        if (result) {
          passageDetectionCount++;
        }
        return result;
      };

      try {
        // Create vessel approaching Klaffbron
        await runner._processVesselAsAISMessage({
          mmsi: MMSI,
          name: 'TEST_VESSEL',
          lat: 58.2865,
          lon: 12.2880,
          sog: 5.0,
          cog: 25,
        });

        // Wait a bit
        await new Promise((r) => setTimeout(r, 100));

        // Move vessel to under Klaffbron
        await runner._processVesselAsAISMessage({
          mmsi: MMSI,
          name: 'TEST_VESSEL',
          lat: 58.28784, // Klaffbron lat
          lon: 12.28926, // Klaffbron lon
          sog: 4.5,
          cog: 25,
        });

        // Wait a bit
        await new Promise((r) => setTimeout(r, 100));

        // Move vessel past Klaffbron
        await runner._processVesselAsAISMessage({
          mmsi: MMSI,
          name: 'TEST_VESSEL',
          lat: 58.2895,
          lon: 12.2905,
          sog: 5.0,
          cog: 25,
        });

        // The passage should be detected at most ONCE per bridge
        // With caching, multiple calls to _hasPassedTargetBridge should return cached result
        expect(passageDetectionCount).toBeLessThanOrEqual(1);
      } finally {
        // Restore original method
        vesselDataService._hasPassedTargetBridge = originalMethod;
      }
    }, 30000);

    test('passage cache should prevent duplicate detections within 500ms', async () => {
      const { vesselDataService } = runner.app;

      // Clear cache
      vesselDataService._passageDetectionCache?.clear?.();

      const mockVessel = {
        mmsi: '123456789',
        targetBridge: 'Klaffbron',
        lat: 58.28784,
        lon: 12.28926,
        cog: 25,
        sog: 5.0,
      };

      const mockOldVessel = {
        mmsi: '123456789',
        lat: 58.2865,
        lon: 12.2880,
        cog: 25,
        sog: 5.0,
      };

      // First call
      const result1 = vesselDataService._hasPassedTargetBridge(mockVessel, mockOldVessel);

      // Second call within 500ms should use cache
      const result2 = vesselDataService._hasPassedTargetBridge(mockVessel, mockOldVessel);

      // Results should be the same (cached)
      expect(result1).toBe(result2);

      // Cache should have an entry
      const cacheKey = `${mockVessel.mmsi}:${mockVessel.targetBridge}`;
      const cached = vesselDataService._passageDetectionCache.get(cacheKey);
      expect(cached).toBeDefined();
      expect(cached.result).toBe(result1);
    });
  });

  describe('Bug Y: Multi-Vessel Message Format', () => {
    test('should show "ytterligare X båt inväntar" when one boat is under bridge and another waiting', async () => {
      // Create two vessels at Klaffbron:
      // - One under the bridge
      // - One waiting (within 300m)

      // Vessel 1: Under the bridge
      await runner._processVesselAsAISMessage({
        mmsi: '111111111',
        name: 'UNDER_BRIDGE',
        lat: 58.28784, // Klaffbron lat
        lon: 12.28926, // Klaffbron lon
        sog: 2.0,
        cog: 25,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Vessel 2: Waiting (250m south of Klaffbron)
      await runner._processVesselAsAISMessage({
        mmsi: '222222222',
        name: 'WAITING',
        lat: 58.2855, // ~250m south
        lon: 12.2875,
        sog: 0.1, // Slow - waiting
        cog: 25,
      });

      await new Promise((r) => setTimeout(r, 100));

      const bridgeText = runner.getCurrentBridgeText();

      // Should NOT contain semicolon separator
      expect(bridgeText).not.toContain(';');

      // Should contain "ytterligare" for additional vessels
      if (bridgeText.includes('Broöppning pågår')) {
        // When there's an under-bridge and a waiting vessel, format should be:
        // "Broöppning pågår vid X, ytterligare 1 båt inväntar"
        expect(bridgeText).toMatch(/ytterligare \d+ båt(ar)? (inväntar|på väg)/);
      }
    }, 30000);

    test('should show "ytterligare" when two vessels in same direction', () => {
      const { bridgeTextService } = runner.app;

      const vessels = [
        {
          mmsi: '111111111',
          name: 'UNDER_BRIDGE',
          currentBridge: 'Klaffbron',
          targetBridge: 'Klaffbron',
          distanceToCurrent: 30,
          sog: 2.0,
          cog: 25,
        },
        {
          mmsi: '222222222',
          name: 'WAITING',
          currentBridge: 'Klaffbron',
          targetBridge: 'Klaffbron',
          distanceToCurrent: 250,
          sog: 0.1,
          cog: 25,
        },
      ];

      const text = bridgeTextService.generateBridgeText(vessels);
      // Lead vessel under bridge, additional vessel nearby
      expect(text).toMatch(/Broöppning pågår vid Klaffbron/);
      expect(text).toMatch(/ytterligare 1 båt på väg/);
    });
  });

  describe('Bug Z: Southbound After Klaffbron', () => {
    test('southbound vessel that passed Klaffbron should not get Stridsbergsbron as target', async () => {
      const MMSI = '333333333';
      const { vesselDataService } = runner.app;

      // Create southbound vessel that has already passed Klaffbron
      const vessel = {
        mmsi: MMSI,
        name: 'SOUTHBOUND_TEST',
        lat: 58.2870, // South of Klaffbron
        lon: 12.2885,
        sog: 5.0,
        cog: 205, // Southbound
        _finalTargetDirection: 'south',
        passedBridges: ['Klaffbron'],
      };

      // Call _calculateTargetBridge directly
      const targetBridge = vesselDataService._calculateTargetBridge(vessel);

      // Should return null (leaving canal) not Stridsbergsbron
      expect(targetBridge).toBeNull();
    });

    test('northbound vessel after Klaffbron should get Stridsbergsbron as target', async () => {
      const MMSI = '444444444';
      const { vesselDataService } = runner.app;

      // Create northbound vessel between Klaffbron and Stridsbergsbron
      const vessel = {
        mmsi: MMSI,
        name: 'NORTHBOUND_TEST',
        lat: 58.2900, // Between the target bridges
        lon: 12.2910,
        sog: 5.0,
        cog: 25, // Northbound
        _finalTargetDirection: 'north',
        passedBridges: ['Klaffbron'],
      };

      // Call _calculateTargetBridge directly
      const targetBridge = vesselDataService._calculateTargetBridge(vessel);

      // Should return Stridsbergsbron
      expect(targetBridge).toBe('Stridsbergsbron');
    });
  });

  describe('Phase Regression Prevention', () => {
    test('should not regress from "passed" to "approaching" within 120s', async () => {
      const MMSI = '555555555';

      // Process vessel passing a bridge
      await runner._processVesselAsAISMessage({
        mmsi: MMSI,
        name: 'REGRESSION_TEST',
        lat: 58.28784, // At Klaffbron
        lon: 12.28926,
        sog: 5.0,
        cog: 25,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Move past the bridge
      await runner._processVesselAsAISMessage({
        mmsi: MMSI,
        name: 'REGRESSION_TEST',
        lat: 58.2895, // Past Klaffbron
        lon: 12.2905,
        sog: 5.0,
        cog: 25,
      });

      const text1 = runner.getCurrentBridgeText();

      // Simulate GPS drift back (still within 120s)
      await new Promise((r) => setTimeout(r, 100));

      await runner._processVesselAsAISMessage({
        mmsi: MMSI,
        name: 'REGRESSION_TEST',
        lat: 58.2880, // Slight drift back
        lon: 12.2895,
        sog: 5.0,
        cog: 25,
      });

      const text2 = runner.getCurrentBridgeText();

      // If text1 showed "passerat", text2 should NOT show "närmar sig" for the same bridge
      if (text1.includes('passerat Klaffbron')) {
        expect(text2).not.toMatch(/närmar sig Klaffbron/);
      }
    }, 30000);
  });

  // ==========================================================================
  // Production log 2026-02-22 bugs
  // ==========================================================================

  describe('Bug 1 (2026-02-22): Stale targetBridge — "passerat X på väg mot X"', () => {
    let service;

    beforeEach(() => {
      const bridgeRegistry = new BridgeRegistry();
      const mockLogger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
      const mockVds = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
      service = new BridgeTextService(bridgeRegistry, mockLogger, null, mockVds, null);
    });

    test('_resolveTargetBridge returns "Klaffbron" (not "Stridsbergsbron") when lastPassedBridge === targetBridge === "Stridsbergsbron" and direction=south', () => {
      const vessel = {
        mmsi: '900000001',
        name: 'SVITZER EMBLA',
        lastPassedBridge: 'Stridsbergsbron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: 'Stridsbergsbron', // stale — same as lastPassedBridge
        sog: 4.0,
        cog: 205,
      };
      const result = service._resolveTargetBridge(vessel, null, 'south');
      expect(result).toBe('Klaffbron');
    });

    test('generateBridgeText with lastPassedBridge:"Klaffbron" + targetBridge:"Klaffbron" should NOT contain "på väg mot Klaffbron"', () => {
      const text = service.generateBridgeText([{
        mmsi: '900000002',
        name: 'HELGE',
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 3000,
        targetBridge: 'Klaffbron', // stale
        sog: 4.0,
        cog: 205, // southbound
        currentBridge: null,
        distance: 80,
      }]);
      // Should NOT show "passerat Klaffbron på väg mot Klaffbron"
      expect(text).not.toMatch(/på väg mot Klaffbron/);
    });

    test('_resolveTargetBridge returns "Stridsbergsbron" for northbound when lastPassedBridge === targetBridge', () => {
      const vessel = {
        mmsi: '900000003',
        name: 'NORTHTEST',
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: 'Klaffbron', // stale
        sog: 4.0,
        cog: 25,
      };
      const result = service._resolveTargetBridge(vessel, null, 'north');
      expect(result).toBe('Stridsbergsbron');
    });
  });

  describe('Bug 2 (2026-02-22): Waiting at bridge — "Båt inväntar broöppning" for stopped vessel at 88m', () => {
    let service;

    beforeEach(() => {
      const bridgeRegistry = new BridgeRegistry();
      const mockLogger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
      const mockVds = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
      service = new BridgeTextService(bridgeRegistry, mockLogger, null, mockVds, null);
    });

    test('stationary vessel at 88m from target bridge → "Båt inväntar broöppning vid Stridsbergsbron"', () => {
      const text = service.generateBridgeText([{
        mmsi: '900000010',
        name: 'SVITZER EMBLA',
        currentBridge: 'Stridsbergsbron',
        targetBridge: 'Stridsbergsbron',
        distanceToCurrent: 88,
        sog: 0, // completely stopped
        cog: 25,
      }]);
      expect(text).toBe('Båt inväntar broöppning vid Stridsbergsbron');
    });

    test('moving vessel at 88m from target bridge → Phase 2 imminent (ETA < 3 min)', () => {
      const text = service.generateBridgeText([{
        mmsi: '900000011',
        name: 'FAST VESSEL',
        currentBridge: 'Stridsbergsbron',
        targetBridge: 'Stridsbergsbron',
        distanceToCurrent: 88,
        sog: 3.0, // moving
        cog: 25,
      }]);
      // 88m / (3.0 * 30.867 m/min) ≈ 0.95 min → Phase 2 imminent
      expect(text).toBe('Båt inväntar broöppning vid Stridsbergsbron');
    });

    test('stationary vessel at 88m from intermediate bridge → J2: "inväntar" with target', () => {
      const text = service.generateBridgeText([{
        mmsi: '900000012',
        name: 'AT INTERMEDIATE',
        currentBridge: 'Järnvägsbron',
        targetBridge: 'Stridsbergsbron',
        distanceToCurrent: 88,
        sog: 0, // stopped
        cog: 25,
      }]);
      // J2: Stationary near intermediate bridge → Phase 2 "inväntar" with target bridge
      expect(text).toBe('Båt inväntar broöppning vid Järnvägsbron på väg mot Stridsbergsbron');
    });
  });

  describe('Bug 3 (2026-02-22): Kanalinfarten flow trigger', () => {
    test('_getFlowTriggerCandidates includes Kanalinfarten when vessel is within 300m', () => {
      const { app } = runner;
      // Kanalinfarten coordinates: 58.268, 12.269
      const vessel = {
        mmsi: '900000020',
        name: 'KANAL_TEST',
        lat: 58.268,
        lon: 12.269,
        sog: 4.0,
        cog: 25,
        targetBridge: null,
        currentBridge: null,
      };

      const proximityData = app.proximityService.analyzeVesselProximity(vessel);
      const candidates = app._getFlowTriggerCandidates(vessel, proximityData);

      const kanalCandidate = candidates.find((c) => c.name === 'Kanalinfarten');
      expect(kanalCandidate).toBeDefined();
      expect(kanalCandidate.id).toBe('kanalinfarten');
      expect(kanalCandidate.source).toBe('trigger-point');
    });
  });

  describe('Bug 4 (2026-02-22): ETA=-1 fallback in flow triggers', () => {
    test('flow trigger calculates ETA from distance/speed when vessel.etaMinutes is missing', async () => {
      const { app } = runner;

      // Reset deduplication so trigger fires
      app._triggeredBoatNearKeys.clear();

      // Track triggered tokens
      let capturedTokens = null;
      const originalTrigger = app._triggerBoatNearFlowBest.bind(app);
      app._triggerBoatNearFlowBest = async (tokens, state, vessel) => {
        capturedTokens = { ...tokens };
        return originalTrigger(tokens, state, vessel);
      };

      try {
        const candidate = {
          name: 'Klaffbron',
          id: 'klaffbron',
          distance: 200, // 200m
          source: 'target',
        };

        const vessel = {
          mmsi: '900000030',
          name: 'ETA_TEST',
          sog: 3.0, // ~1.54 m/s
          cog: 25,
          status: 'approaching',
          etaMinutes: undefined, // no ETA available
          _routeDirection: 'northbound',
        };

        await app._triggerBoatNearFlowForBridge(vessel, candidate);

        // ETA should be calculated: 200m / (3 * 0.5144 m/s) / 60 ≈ 2 min
        expect(capturedTokens).toBeDefined();
        expect(capturedTokens.eta_minutes).toBeGreaterThanOrEqual(1);
        expect(capturedTokens.eta_minutes).toBeLessThanOrEqual(5);
        expect(capturedTokens.eta_minutes).not.toBe(-1);
      } finally {
        app._triggerBoatNearFlowBest = originalTrigger;
      }
    }, 30000);

    test('flow trigger still shows -1 when both etaMinutes and speed are unavailable', async () => {
      const { app } = runner;

      app._triggeredBoatNearKeys.clear();

      let capturedTokens = null;
      const originalTrigger = app._triggerBoatNearFlowBest.bind(app);
      app._triggerBoatNearFlowBest = async (tokens, state, vessel) => {
        capturedTokens = { ...tokens };
        return originalTrigger(tokens, state, vessel);
      };

      try {
        const candidate = {
          name: 'Klaffbron',
          id: 'klaffbron',
          distance: 200,
          source: 'target',
        };

        const vessel = {
          mmsi: '900000031',
          name: 'NO_ETA_TEST',
          sog: 0, // stopped
          cog: 25,
          status: 'waiting',
          etaMinutes: undefined,
          _routeDirection: 'northbound',
        };

        await app._triggerBoatNearFlowForBridge(vessel, candidate);

        expect(capturedTokens).toBeDefined();
        expect(capturedTokens.eta_minutes).toBe(-1);
      } finally {
        app._triggerBoatNearFlowBest = originalTrigger;
      }
    }, 30000);
  });

  // ==========================================================================
  // Production log 2026-02-24 bugs
  // ==========================================================================

  describe('Bug A (2026-02-24): Stallbackabron ETA shows wrong bridge', () => {
    let service;

    beforeEach(() => {
      const bridgeRegistry = new BridgeRegistry();
      const mockLogger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
      const mockVds = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
      service = new BridgeTextService(bridgeRegistry, mockLogger, null, mockVds, null);
    });

    test('_buildStallbackaNear with targetBridge → text includes target bridge and ETA', () => {
      const text = service._buildStallbackaNear('Stallbackabron', 341, 'Stridsbergsbron', '9 minuter', 0);
      expect(text).toContain('på väg mot Stridsbergsbron');
      expect(text).toContain('341m från Stallbackabron');
      expect(text).toContain('ETA 9 minuter');
    });

    test('_buildStallbackaPasserar with targetBridge → text includes target bridge and ETA', () => {
      const text = service._buildStallbackaPasserar('Stallbackabron', 'Stridsbergsbron', '5 minuter', 0);
      expect(text).toContain('på väg mot Stridsbergsbron');
      expect(text).toContain('passerar Stallbackabron');
      expect(text).toContain('ETA 5 minuter');
    });
  });

  describe('Bug B (2026-02-24): Waiting threshold 110-137m', () => {
    let service;

    beforeEach(() => {
      const bridgeRegistry = new BridgeRegistry();
      const mockLogger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
      const mockVds = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
      service = new BridgeTextService(bridgeRegistry, mockLogger, null, mockVds, null);
    });

    test('stationary vessel at 137m from target bridge → "Båt inväntar broöppning vid Stridsbergsbron"', () => {
      const text = service.generateBridgeText([{
        mmsi: '900100001',
        name: 'SVITZER EMBLA',
        currentBridge: 'Stridsbergsbron',
        targetBridge: 'Stridsbergsbron',
        distanceToCurrent: 137,
        sog: 0,
        cog: 25,
      }]);
      expect(text).toBe('Båt inväntar broöppning vid Stridsbergsbron');
    });

    test('slow vessel at 110m from Klaffbron → "Båt inväntar broöppning vid Klaffbron"', () => {
      const text = service.generateBridgeText([{
        mmsi: '900100002',
        name: 'NORDIC SIRA',
        currentBridge: 'Klaffbron',
        targetBridge: 'Klaffbron',
        distanceToCurrent: 110,
        sog: 0.3,
        cog: 205,
      }]);
      expect(text).toBe('Båt inväntar broöppning vid Klaffbron');
    });
  });

  describe('Bug C (2026-02-24): Wrong target bridge after passage with null targetBridge', () => {
    let service;

    beforeEach(() => {
      const bridgeRegistry = new BridgeRegistry();
      const mockLogger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
      const mockVds = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
      service = new BridgeTextService(bridgeRegistry, mockLogger, null, mockVds, null);
    });

    test('_resolveTargetBridge with targetBridge=null, lastPassed=Olidebron, direction=north → Klaffbron', () => {
      const vessel = {
        mmsi: '900200001',
        name: 'TEST_VESSEL',
        lastPassedBridge: 'Olidebron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: null,
        sog: 4.0,
        cog: 25,
      };
      const result = service._resolveTargetBridge(vessel, null, 'north');
      expect(result).toBe('Klaffbron');
    });

    test('_resolveTargetBridge with targetBridge="none", lastPassed=Klaffbron, direction=north → Stridsbergsbron', () => {
      const vessel = {
        mmsi: '900200002',
        name: 'TEST_VESSEL',
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 5000,
        targetBridge: 'none',
        sog: 4.0,
        cog: 25,
      };
      const result = service._resolveTargetBridge(vessel, null, 'north');
      expect(result).toBe('Stridsbergsbron');
    });
  });

  describe('Bug D (2026-02-24): Direction flip at passage — stale _routeDirection', () => {
    let service;

    beforeEach(() => {
      const bridgeRegistry = new BridgeRegistry();
      const mockLogger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
      const mockVds = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
      service = new BridgeTextService(bridgeRegistry, mockLogger, null, mockVds, null);
    });

    test('_getDirection with stale _routeDirection=southbound + COG=43 + just-passed → north', () => {
      const vessel = {
        mmsi: '900300001',
        name: 'SVITZER EMBLA',
        _routeDirection: 'southbound',
        cog: 43,
        lastPassedBridge: 'Stridsbergsbron',
        lastPassedBridgeTime: Date.now() - 5000, // within just-passed window
      };
      const result = service._getDirection(vessel);
      expect(result).toBe('north');
    });

    test('_getDirection with _routeDirection=southbound + COG=43 but NOT just-passed → south', () => {
      const vessel = {
        mmsi: '900300002',
        name: 'SOME_VESSEL',
        _routeDirection: 'southbound',
        cog: 43,
        // No lastPassedBridge/Time → not just-passed
      };
      const result = service._getDirection(vessel);
      expect(result).toBe('south');
    });
  });

  describe('Bug E (2026-02-24): Informative fallback text', () => {
    test('generateBridgeText with 2 vessels including just-passed with null target → should not need fallback', () => {
      const bridgeRegistry = new BridgeRegistry();
      const mockLogger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
      const mockVds = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
      const service = new BridgeTextService(bridgeRegistry, mockLogger, null, mockVds, null);

      const text = service.generateBridgeText([
        {
          mmsi: '900400001',
          name: 'VESSEL_A',
          currentBridge: 'Klaffbron',
          targetBridge: 'Klaffbron',
          distanceToCurrent: 200,
          sog: 3.0,
          cog: 25,
        },
        {
          mmsi: '900400002',
          name: 'VESSEL_B',
          lastPassedBridge: 'Olidebron',
          lastPassedBridgeTime: Date.now() - 5000,
          targetBridge: null,
          sog: 4.0,
          cog: 25,
        },
      ]);

      // The text should be meaningful, not a generic fallback
      expect(text).not.toBe('Inga båtar i närheten av broarna');
      expect(text).not.toMatch(/^\d+ båtar är i närheten av broarna$/);
    });

    test('_generateSafeFallbackText with bridge+distance → includes distance info', () => {
      const { app } = runner;
      const vessels = [{
        mmsi: '900400003',
        name: 'FALLBACK_TEST',
        currentBridge: 'Klaffbron',
        targetBridge: 'Klaffbron',
        distanceToCurrent: 250,
      }];

      const text = app._generateSafeFallbackText(vessels);
      expect(text).toContain('250m');
      expect(text).toContain('Klaffbron');
    });
  });
});
