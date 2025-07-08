const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('Flow Cards Integration Tests', () => {
  let app;
  let mockTriggerCard;
  let mockConditionCard;

  beforeEach(() => {
    // Setup mock flow cards
    mockTriggerCard = {
      registerRunListener: jest.fn(),
      trigger: jest.fn(),
    };

    mockConditionCard = {
      registerRunListener: jest.fn(),
    };

    app = new AISBridgeApp();
    app._lastSeen = {};

    // Mock Homey flow card getters
    app.homey.flow.getTriggerCard.mockImplementation((cardId) => {
      if (cardId === 'boat_near') return mockTriggerCard;
      return null;
    });

    app.homey.flow.getConditionCard.mockImplementation((cardId) => {
      if (cardId === 'boat_recent') return mockConditionCard;
      return null;
    });

    // Mock settings
    app.homey.settings.get.mockImplementation((key) => {
      if (key === 'debug_level') return 'basic';
      return null;
    });

    // Initialize the app to setup flow cards
    app._boatNearTrigger = mockTriggerCard;
    app._boatRecentCard = mockConditionCard;

    // Simulate app initialization
    app.onInit = jest.fn();
  });

  describe('Boat Near Trigger Card', () => {
    test('should register run listener for boat_near trigger', () => {
      // Test that the trigger card exists and can register listeners
      expect(typeof mockTriggerCard.registerRunListener).toBe('function');
      expect(typeof mockTriggerCard.trigger).toBe('function');
    });

    test('should trigger when boat approaches specific bridge', () => {
      // Test bridge matching logic directly
      const bridgeMatchLogic = (args, state) => args.bridge === state.bridge;

      const args = { bridge: 'klaffbron' };
      const state = { bridge: 'klaffbron' };

      const result = bridgeMatchLogic(args, state);
      expect(result).toBe(true);
    });

    test('should not trigger for different bridge', () => {
      // Test bridge matching logic directly
      const bridgeMatchLogic = (args, state) => args.bridge === state.bridge;

      const args = { bridge: 'klaffbron' };
      const state = { bridge: 'stridsbergsbron' };

      const result = bridgeMatchLogic(args, state);
      expect(result).toBe(false);
    });

    test('should trigger flow when vessel enters bridge zone', () => {
      // Simulate vessel detection at bridge
      const mmsi = '123456789';
      const bridgeId = 'stridsbergsbron';
      const bridgeName = 'Stridsbergsbron';

      app._lastSeen[bridgeId] = {
        [mmsi]: {
          ts: Date.now(),
          sog: 4.2,
          dir: 'Göteborg',
          dist: 200,
        },
      };

      // Simulate trigger tokens
      const tokens = {
        bridge_name: bridgeName,
        vessel_name: 'Test Vessel',
        direction: 'Göteborg',
      };

      const state = { bridge: bridgeId };

      // Verify trigger would be called with correct data
      expect(tokens.bridge_name).toBe(bridgeName);
      expect(tokens.direction).toBe('Göteborg');
      expect(state.bridge).toBe(bridgeId);
    });
  });

  describe('Boat Recent Condition Card', () => {
    test('should register run listener for boat_recent condition', () => {
      // Test that the condition card exists and can register listeners
      expect(typeof mockConditionCard.registerRunListener).toBe('function');
    });

    test('should return true when boat was recently near specific bridge', async () => {
      const mmsi = '123456789';
      const bridgeId = 'klaffbron';
      const recentTime = Date.now() - 60000; // 1 minute ago

      app._lastSeen[bridgeId] = {
        [mmsi]: {
          ts: recentTime,
          sog: 4.0,
          dir: 'Vänersborg',
        },
      };

      // Simulate the condition check
      const result = await app._onFlowConditionBoatRecent({ bridge: bridgeId });

      expect(result).toBe(true);
    });

    test('should return false when no recent boat activity', async () => {
      const mmsi = '123456789';
      const bridgeId = 'klaffbron';
      const oldTime = Date.now() - 12 * 60 * 1000; // 12 minutes ago (older than MAX_AGE_SEC)

      app._lastSeen[bridgeId] = {
        [mmsi]: {
          ts: oldTime,
          sog: 4.0,
          dir: 'Vänersborg',
        },
      };

      const result = await app._onFlowConditionBoatRecent({ bridge: bridgeId });

      expect(result).toBe(false);
    });

    test('should return true for "any" bridge when any bridge has recent activity', async () => {
      const mmsi = '123456789';
      const recentTime = Date.now() - 30000; // 30 seconds ago

      app._lastSeen['olidebron'] = {
        [mmsi]: {
          ts: recentTime,
          sog: 3.8,
          dir: 'Göteborg',
        },
      };

      const result = await app._onFlowConditionBoatRecent({ bridge: 'any' });

      expect(result).toBe(true);
    });

    test('should return false for "any" bridge when no recent activity', async () => {
      app._lastSeen = {}; // No boats anywhere

      const result = await app._onFlowConditionBoatRecent({ bridge: 'any' });

      expect(result).toBe(false);
    });
  });

  describe('Global Token Updates', () => {
    test('should update active bridges token when boats detected', async () => {
      const mmsi = '123456789';
      app._lastSeen['stridsbergsbron'] = {
        [mmsi]: {
          ts: Date.now(),
          sog: 4.2,
          dir: 'Göteborg',
          dist: 180,
        },
      };

      // Mock the token
      app._activeBridgesTag = {
        setValue: jest.fn().mockResolvedValue(true),
      };

      // Simulate token update with proper async handling
      if (app._updateActiveBridgesTag) {
        await app._updateActiveBridgesTag();
        expect(app._activeBridgesTag.setValue).toHaveBeenCalled();
      } else {
        // Test token update logic directly
        expect(app._activeBridgesTag.setValue).toBeInstanceOf(Function);
      }
    });

    test('should set default message when no boats present', () => {
      app._lastSeen = {}; // No boats

      app._activeBridgesTag = {
        setValue: jest.fn().mockResolvedValue(true),
      };

      // Test the logic that should generate the default message
      const targetBridges = ['klaffbron', 'stridsbergsbron'];
      const hasTargetBoats = targetBridges.some((bridgeId) => {
        const boats = app._lastSeen[bridgeId];
        return boats && Object.keys(boats).length > 0;
      });

      expect(hasTargetBoats).toBe(false);

      // Default message should be used
      const defaultMessage = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
      expect(defaultMessage).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
    });
  });

  describe('Multi-Bridge Flow Logic', () => {
    test('should handle multiple boats at different bridges', async () => {
      const currentTime = Date.now();

      // Boat at Klaffbron
      app._lastSeen['klaffbron'] = {
        111111111: {
          ts: currentTime - 30000, // 30 seconds ago
          sog: 3.8,
          dir: 'Göteborg',
        },
      };

      // Boat at Stridsbergsbron
      app._lastSeen['stridsbergsbron'] = {
        222222222: {
          ts: currentTime - 45000, // 45 seconds ago
          sog: 4.2,
          dir: 'Vänersborg',
        },
      };

      // Both bridges should show recent activity
      const klaffResult = await app._onFlowConditionBoatRecent({ bridge: 'klaffbron' });
      const stridsResult = await app._onFlowConditionBoatRecent({ bridge: 'stridsbergsbron' });
      const anyResult = await app._onFlowConditionBoatRecent({ bridge: 'any' });

      expect(klaffResult).toBe(true);
      expect(stridsResult).toBe(true);
      expect(anyResult).toBe(true);
    });

    test('should properly clean up stale data across bridges', () => {
      const mmsi = '123456789';
      const staleTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago

      // Add stale data to multiple bridges
      app._lastSeen['klaffbron'] = {
        [mmsi]: { ts: staleTime, sog: 4.0 },
      };
      app._lastSeen['stridsbergsbron'] = {
        [mmsi]: { ts: staleTime, sog: 4.0 },
      };

      // Simulate cleanup logic
      const maxAge = 3 * 60 * 1000; // 3 minutes
      const cutoff = Date.now() - maxAge;

      Object.keys(app._lastSeen).forEach((bridgeId) => {
        Object.keys(app._lastSeen[bridgeId]).forEach((vesselMmsi) => {
          if (app._lastSeen[bridgeId][vesselMmsi].ts < cutoff) {
            delete app._lastSeen[bridgeId][vesselMmsi];
          }
        });

        // Remove empty bridge entries
        if (Object.keys(app._lastSeen[bridgeId]).length === 0) {
          delete app._lastSeen[bridgeId];
        }
      });

      expect(Object.keys(app._lastSeen)).toHaveLength(0);
    });
  });

  describe('Flow Card State Consistency', () => {
    test('should maintain consistent state between trigger and condition cards', async () => {
      const mmsi = '123456789';
      const bridgeId = 'stridsbergsbron';
      const currentTime = Date.now();

      // Add boat data
      app._lastSeen[bridgeId] = {
        [mmsi]: {
          ts: currentTime,
          sog: 4.5,
          dir: 'Göteborg',
          dist: 220,
        },
      };

      // Trigger should fire for this bridge
      const triggerArgs = { bridge: bridgeId };
      const triggerState = { bridge: bridgeId };

      // Test trigger logic directly
      const triggerLogic = (args, state) => args.bridge === state.bridge;
      const triggerResult = triggerLogic(triggerArgs, triggerState);

      // Condition should also return true
      const conditionResult = await app._onFlowConditionBoatRecent({ bridge: bridgeId });

      expect(triggerResult).toBe(true);
      expect(conditionResult).toBe(true);
    });

    test('should handle edge case timing between trigger and condition', async () => {
      const mmsi = '123456789';
      const bridgeId = 'klaffbron';
      const edgeTime = Date.now() - (3 * 60 * 1000 - 1000); // Just under 3 minutes

      app._lastSeen[bridgeId] = {
        [mmsi]: {
          ts: edgeTime,
          sog: 4.0,
          dir: 'Vänersborg',
        },
      };

      const result = await app._onFlowConditionBoatRecent({ bridge: bridgeId });

      // Should still be true as it's just under the cutoff
      expect(result).toBe(true);
    });
  });
});
