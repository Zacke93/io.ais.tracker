/**
 * TargetBridge Consistency Tests
 * 
 * These tests verify that vessel.targetBridge stays synchronized with
 * detectedTargetBridge throughout the boat's journey, preventing the
 * LECKO scenario where targetBridge=Klaffbron but detectedTargetBridge=Stridsbergsbron.
 */

const AISBridgeApp = require('../../app');
const { setupMockHomey } = require('../__mocks__/homey');

describe('TargetBridge Consistency Tests', () => {
  let app;

  beforeEach(async () => {
    const mockHomey = setupMockHomey();
    app = new AISBridgeApp();
    app.homey = mockHomey;
    app.debug = jest.fn();
    app.error = jest.fn();  
    app.log = jest.fn();

    await app.onInit();
  });

  afterEach(async () => {
    if (app) {
      await app.onUninit();
    }
  });

  test('should synchronize vessel.targetBridge when detectedTargetBridge differs', async () => {
    // Simulate LECKO scenario: initial target Klaffbron, but later detected as Stridsbergsbron
    const vesselData = {
      mmsi: 244063000,
      name: 'LECKO',
      lat: 58.275000, // Near Järnvägsbron
      lon: 12.275000,
      sog: 1.5,
      cog: 37.2,
      timestamp: Date.now()
    };

    // Add vessel with initial target
    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);
    vessel.targetBridge = 'Klaffbron';  // Initial assignment
    vessel.nearBridge = 'jarnvagsbron'; // At Järnvägsbron

    // Simulate bridge:approaching event with different target
    const mockEvent = {
      vessel,
      bridgeId: 'jarnvagsbron',
      bridge: { name: 'Järnvägsbron' },
      distance: 224,
      targetBridge: 'Stridsbergsbron' // Different from vessel.targetBridge
    };

    // Trigger the event handler
    app._onBridgeApproaching(mockEvent);

    // Verify synchronization occurred
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(vessel._detectedTargetBridge).toBe('Stridsbergsbron');
  });

  test('should maintain consistency during multi-bridge journey', async () => {
    // Test complete journey with target bridge updates
    const vesselData = {
      mmsi: 123456789,
      name: 'JOURNEY_TEST',
      lat: 58.270000, // Start south
      lon: 12.275000,
      sog: 2.0,
      cog: 45.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);

    // Stage 1: At Olidebron, target Klaffbron
    vessel.nearBridge = 'olidebron';
    vessel.targetBridge = 'Klaffbron';

    const event1 = {
      vessel,
      bridgeId: 'olidebron',
      bridge: { name: 'Olidebron' },
      distance: 50,
      targetBridge: 'Klaffbron'
    };

    app._onBridgeApproaching(event1);
    expect(vessel.targetBridge).toBe('Klaffbron');

    // Stage 2: At Klaffbron, now targeting Stridsbergsbron  
    vessel.nearBridge = 'klaffbron';
    
    const event2 = {
      vessel,
      bridgeId: 'klaffbron', 
      bridge: { name: 'Klaffbron' },
      distance: 30,
      targetBridge: 'Stridsbergsbron' // Target changed
    };

    app._onBridgeApproaching(event2);
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(vessel._detectedTargetBridge).toBe('Stridsbergsbron');

    // Stage 3: At Järnvägsbron, still targeting Stridsbergsbron
    vessel.nearBridge = 'jarnvagsbron';

    const event3 = {
      vessel,
      bridgeId: 'jarnvagsbron',
      bridge: { name: 'Järnvägsbron' },
      distance: 200,
      targetBridge: 'Stridsbergsbron'
    };

    app._onBridgeApproaching(event3);
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
  });

  test('should not update targetBridge when detected target is the same', async () => {
    // Test that no unnecessary updates happen
    const vesselData = {
      mmsi: 987654321,
      name: 'STABLE_TARGET',
      lat: 58.280000,
      lon: 12.280000,
      sog: 1.8,
      cog: 40.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);
    vessel.targetBridge = 'Klaffbron';

    const event = {
      vessel,
      bridgeId: 'klaffbron',
      bridge: { name: 'Klaffbron' },
      distance: 100,
      targetBridge: 'Klaffbron' // Same as current
    };

    // Should not trigger debug message about update
    app._onBridgeApproaching(event);
    
    expect(vessel.targetBridge).toBe('Klaffbron');
    // Should not have set _detectedTargetBridge if same
    expect(vessel._detectedTargetBridge).toBeUndefined();
  });

  test('should handle undefined detected target gracefully', async () => {
    const vesselData = {
      mmsi: 555555555,
      name: 'UNDEFINED_TARGET',
      lat: 58.275000,
      lon: 12.275000,
      sog: 1.0,
      cog: 30.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);
    vessel.targetBridge = 'Klaffbron';

    const event = {
      vessel,
      bridgeId: 'olidebron',
      bridge: { name: 'Olidebron' },
      distance: 150,
      targetBridge: undefined // No detected target
    };

    app._onBridgeApproaching(event);

    // Should maintain original target
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel._detectedTargetBridge).toBeUndefined();
  });

  test('should clean up _detectedTargetBridge on bridge passage', async () => {
    const vesselData = {
      mmsi: 666666666,
      name: 'CLEANUP_TEST',
      lat: 58.275000,
      lon: 12.275000,  
      sog: 2.5,
      cog: 45.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);
    vessel.targetBridge = 'Klaffbron';
    vessel._detectedTargetBridge = 'Stridsbergsbron';

    // Simulate bridge passage
    const passageEvent = {
      vessel,
      bridgeId: 'klaffbron',
      bridge: { name: 'Klaffbron' }
    };

    app._onBridgePassed(passageEvent);

    // Should clean up temporary detected target
    expect(vessel._detectedTargetBridge).toBeUndefined();
    expect(vessel.nearBridge).toBeNull();
  });

  test('should validate targetBridge consistency in relevant boats generation', async () => {
    // Test that _findRelevantBoats produces consistent data
    const vesselData = {
      mmsi: 777777777,
      name: 'RELEVANT_CONSISTENCY',
      lat: 58.280000,
      lon: 12.280000,
      sog: 1.5,
      cog: 35.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);
    vessel.targetBridge = 'Klaffbron';
    vessel.nearBridge = 'klaffbron';
    vessel.status = 'approaching';

    // Generate relevant boats
    const relevantBoats = app._findRelevantBoats();
    
    if (relevantBoats.length > 0) {
      const boat = relevantBoats[0];
      
      // TargetBridge should never be undefined/null in output
      expect(boat.targetBridge).toBeDefined();
      expect(boat.targetBridge).not.toBe('Unknown');
      expect(boat.targetBridge).not.toBe('undefined');
      expect(boat.targetBridge).not.toBeNull();

      // Should match vessel's current targetBridge
      expect(boat.targetBridge).toBe(vessel.targetBridge);
    }
  });

  test('should handle rapid target bridge changes', async () => {
    // Test multiple rapid changes to ensure consistency
    const vesselData = {
      mmsi: 888888888,
      name: 'RAPID_CHANGES',
      lat: 58.275000,
      lon: 12.275000,
      sog: 3.0,
      cog: 40.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);
    vessel.targetBridge = 'Klaffbron';

    // Rapid sequence of target changes
    const changes = [
      { bridge: 'olidebron', target: 'Klaffbron' },
      { bridge: 'klaffbron', target: 'Stridsbergsbron' },
      { bridge: 'jarnvagsbron', target: 'Stridsbergsbron' }
    ];

    for (const change of changes) {
      const event = {
        vessel,
        bridgeId: change.bridge,
        bridge: { name: change.bridge },
        distance: 100,
        targetBridge: change.target
      };

      app._onBridgeApproaching(event);
      expect(vessel.targetBridge).toBe(change.target);
    }

    // Final state should be consistent
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(vessel._detectedTargetBridge).toBe('Stridsbergsbron');
  });
});