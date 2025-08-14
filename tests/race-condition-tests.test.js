'use strict';

/**
 * Race Condition Test Suite
 * Validates that the implemented race condition fixes work correctly
 */

const AISBridgeApp = require('../app');

const { VesselDataService } = AISBridgeApp;

describe('Race Condition Tests', () => {
  let mockLogger;
  let mockBridgeRegistry;
  let vesselDataService;
  let app;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };

    mockBridgeRegistry = {
      bridges: {},
      getBridgeByName: jest.fn(),
    };

    vesselDataService = new VesselDataService(mockLogger, mockBridgeRegistry);
  });

  afterEach(() => {
    // Clear all timers from services
    if (vesselDataService) {
      vesselDataService.clearAllTimers();
    }

    // Clear any app instance and its timers
    if (app) {
      if (app.monitoringInterval) {
        clearInterval(app.monitoringInterval);
      }
      if (app.uiDebounceTimer) {
        clearTimeout(app.uiDebounceTimer);
      }
      if (app.vesselDataService) {
        app.vesselDataService.clearAllTimers();
      }
      if (app.systemCoordinator) {
        app.systemCoordinator.cleanup();
      }
      app = null;
    }

    // Clear all Jest timers
    jest.clearAllTimers();
  });

  describe('Timer Race Conditions', () => {
    test('scheduleCleanup prevents timer leaks', async () => {
      const mmsi = 'TEST001';

      // Schedule multiple cleanups rapidly
      vesselDataService.scheduleCleanup(mmsi, 1000);
      vesselDataService.scheduleCleanup(mmsi, 2000);
      vesselDataService.scheduleCleanup(mmsi, 3000);

      // Only one timer should exist
      expect(vesselDataService.cleanupTimers.size).toBe(1);
    });

    test('vessel removal during cleanup timer', async () => {
      const mmsi = 'TEST002';
      const vessel = {
        mmsi, lat: 1, lon: 1, sog: 5, cog: 45,
      };

      // Add vessel and schedule cleanup
      vesselDataService.updateVessel(mmsi, vessel);
      vesselDataService.scheduleCleanup(mmsi, 100);

      // Remove vessel before timer fires
      vesselDataService.removeVessel(mmsi, 'manual');

      // Wait for timer
      await new Promise((resolve) => setTimeout(resolve, 150));

      // No errors should occur
      expect(vesselDataService.getVessel(mmsi)).toBeNull();
    });

    test('rapid UI updates are debounced correctly', async () => {
      app = new AISBridgeApp();

      // Mock Homey instance to prevent real initialization
      app.homey = {
        settings: { get: jest.fn(), set: jest.fn() },
        flow: { getTriggerTokens: jest.fn(), setTriggerTokens: jest.fn() },
      };

      const updateSpy = jest.spyOn(app, '_actuallyUpdateUI').mockImplementation();

      // Rapid fire updates
      app._updateUI();
      app._updateUI();
      app._updateUI();

      // Should only trigger once after debounce
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(updateSpy).toHaveBeenCalledTimes(1);

      updateSpy.mockRestore();
    });
  });

  describe('Simultaneous Operations', () => {
    test('concurrent vessel updates and removals', async () => {
      const mmsi = 'TEST003';
      const vessel = {
        mmsi, lat: 1, lon: 1, sog: 5, cog: 45,
      };

      // Start concurrent operations
      const updatePromise = Promise.resolve(vesselDataService.updateVessel(mmsi, vessel));
      const removePromise = Promise.resolve(vesselDataService.removeVessel(mmsi, 'test'));

      await Promise.all([updatePromise, removePromise]);

      // Should not crash and state should be consistent
      expect(vesselDataService.vessels.size).toBe(0);
    });

    test('multiple timer operations on same vessel', () => {
      const mmsi = 'TEST004';

      // Multiple operations
      vesselDataService.scheduleCleanup(mmsi, 1000);
      vesselDataService.clearCleanup(mmsi);
      vesselDataService.scheduleCleanup(mmsi, 2000);

      // Should have exactly one timer
      expect(vesselDataService.cleanupTimers.has(mmsi)).toBe(true);
      expect(vesselDataService.cleanupTimers.size).toBe(1);
    });
  });

  describe('SystemCoordinator Race Conditions', () => {
    test('bridge text debounce prevents multiple timers', () => {
      const SystemCoordinator = require('../lib/services/SystemCoordinator');
      const coordinator = new SystemCoordinator(mockLogger);

      const mmsi = 'TEST005';
      const currentTime = Date.now();

      // Multiple debounce activations
      coordinator._activateBridgeTextDebounce(mmsi, currentTime);
      coordinator._activateBridgeTextDebounce(mmsi, currentTime);

      // Should have exactly one debounce entry
      expect(coordinator.bridgeTextDebounce.size).toBe(1);
    });

    test('cleanup handles orphaned timers', () => {
      const SystemCoordinator = require('../lib/services/SystemCoordinator');
      const coordinator = new SystemCoordinator(mockLogger);

      // Create stale coordination state
      coordinator.vesselCoordinationState.set('OLD001', {
        lastUpdateTime: Date.now() - (2 * 60 * 60 * 1000), // 2 hours ago
      });

      // Cleanup should remove stale entries
      coordinator.cleanup();

      expect(coordinator.vesselCoordinationState.has('OLD001')).toBe(false);
    });
  });

  describe('Memory Leak Prevention', () => {
    test('clearAllTimers prevents memory leaks', () => {
      const mmsi1 = 'LEAK001';
      const mmsi2 = 'LEAK002';

      // Create multiple timers
      vesselDataService.scheduleCleanup(mmsi1, 10000);
      vesselDataService.scheduleCleanup(mmsi2, 10000);

      expect(vesselDataService.cleanupTimers.size).toBe(2);

      // Clear all timers
      vesselDataService.clearAllTimers();

      expect(vesselDataService.cleanupTimers.size).toBe(0);
      expect(vesselDataService.protectionTimers.size).toBe(0);
    });

    test('app shutdown clears all resources', async () => {
      app = new AISBridgeApp();

      // Mock Homey instance with settings
      app.homey = {
        settings: {
          get: jest.fn().mockReturnValue('basic'),
          on: jest.fn(), // Add the missing 'on' method
          off: jest.fn(), // Add the missing 'off' method
        },
        app: {
          on: jest.fn(),
        },
        flow: {
          getTriggerCard: jest.fn().mockReturnValue({ registerRunListener: jest.fn() }),
          getConditionCard: jest.fn().mockReturnValue({ registerRunListener: jest.fn() }),
        },
        api: {
          realtime: jest.fn().mockReturnValue({ register: jest.fn() }),
        },
        manager: jest.fn().mockReturnValue({
          getDevices: jest.fn().mockReturnValue([]),
        }),
      };

      // Mock logger methods
      app.log = jest.fn();
      app.error = jest.fn();
      app.debug = jest.fn();

      await app.onInit();

      // Setup some state
      app._vesselRemovalTimers.set('TEST', setTimeout(() => {}, 10000));
      app._uiUpdateTimer = setTimeout(() => {}, 10000);

      // Shutdown
      await app.onUninit();

      expect(app._vesselRemovalTimers).toBeNull();
      expect(app._uiUpdateTimer).toBeNull();
    });
  });
});

/**
 * Helper function for timer testing
 */
function waitForTimers(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { waitForTimers };
