/**
 * Startup Scenario Tests
 * 
 * These tests verify critical startup scenarios where boats are already 
 * near bridges when the app starts, similar to the LECKO scenario.
 */

const AISBridgeApp = require('../../app');
const { setupMockHomey } = require('../__mocks__/homey');

describe('Startup Scenario Tests', () => {
  let app;

  beforeEach(async () => {
    // Setup mock environment
    const mockHomey = setupMockHomey();
    app = new AISBridgeApp();
    app.homey = mockHomey;
    app.debug = jest.fn();
    app.error = jest.fn();
    app.log = jest.fn();

    // Initialize app
    await app.onInit();
  });

  afterEach(async () => {
    if (app) {
      await app.onUninit();
    }
  });

  test('should handle boat very close to bridge at startup', async () => {
    // Simulate LECKO scenario: boat starts at 14m from Olidebron
    const vesselData = {
      mmsi: 244063000,
      name: 'LECKO',
      lat: 58.272812,
      lon: 12.275323,
      sog: 3.1,
      cog: 40.7,
      timestamp: Date.now()
    };

    // Add vessel to system (simulating startup discovery)
    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);

    // Process vessel through bridge monitoring system
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);
    expect(vessel).toBeDefined();

    // Should assign proactive target bridge
    expect(vessel.targetBridge).toBeDefined();
    expect(['Klaffbron', 'Stridsbergsbron']).toContain(vessel.targetBridge);

    // Should detect proximity to Olidebron  
    expect(vessel.nearBridge).toBe('olidebron');

    // Generate bridge text
    const relevantBoats = app._findRelevantBoats();
    expect(relevantBoats).toHaveLength(1);

    const boat = relevantBoats[0];
    expect(boat.currentBridge).toBe('Olidebron');
    expect(boat.targetBridge).toBeDefined();
    expect(boat.targetBridge).not.toBe('Unknown');
    expect(boat.etaMinutes).toBeGreaterThan(0);

    // Verify bridge text format
    const bridgeText = await app._generateBridgeTextFromBoats();
    expect(bridgeText).toContain('LECKO vid Olidebron är på väg mot');
    expect(bridgeText).toMatch(/beräknad broöppning om \\d+ minuter?/);
  });

  test('should not show "inväntar broöppning" for fast-moving boats at startup', async () => {
    // Test case: Boat moving at 3+ knots should not immediately show waiting status
    const vesselData = {
      mmsi: 123456789,
      name: 'FAST_BOAT',
      lat: 58.272812,
      lon: 12.275323,
      sog: 3.5,
      cog: 40.7,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);

    // Should not be in waiting status initially
    expect(vessel.status).not.toBe('waiting');
    expect(vessel.isWaiting).toBe(false);

    const relevantBoats = app._findRelevantBoats();
    if (relevantBoats.length > 0) {
      const boat = relevantBoats[0];
      expect(boat.isWaiting).toBe(false);
      
      const bridgeText = await app._generateBridgeTextFromBoats();
      expect(bridgeText).not.toContain('inväntar broöppning');
      expect(bridgeText).not.toContain('väntar vid');
    }
  });

  test('should handle boat at startup with undefined targetBridge', async () => {
    // Test recovery from undefined targetBridge scenario
    const vesselData = {
      mmsi: 987654321,
      name: 'RECOVERY_TEST',
      lat: 58.280000, // Near Klaffbron
      lon: 12.280000,
      sog: 1.5,
      cog: 30.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(vesselData.mmsi);

    // Simulate undefined targetBridge scenario
    vessel.targetBridge = undefined;

    // Should recover when generating relevant boats
    const relevantBoats = app._findRelevantBoats();
    
    // Either no boats (filtered out) or recovered targetBridge
    if (relevantBoats.length > 0) {
      const boat = relevantBoats[0];
      expect(boat.targetBridge).toBeDefined();
      expect(boat.targetBridge).not.toBe('Unknown');
      expect(boat.targetBridge).not.toBe('undefined');
    }
  });

  test('should assign correct proactive target bridge based on position and COG', async () => {
    // Test proactive target assignment for different scenarios
    const testCases = [
      {
        name: 'NORTH_BOUND',
        lat: 58.270000, // South of all bridges
        lon: 12.275000,
        cog: 45.0, // Northbound
        expectedTargets: ['Klaffbron', 'Stridsbergsbron']
      },
      {
        name: 'SOUTH_BOUND', 
        lat: 58.290000, // North of most bridges
        lon: 12.275000,
        cog: 225.0, // Southbound
        expectedTargets: ['Klaffbron', 'Stridsbergsbron']
      }
    ];

    for (const testCase of testCases) {
      const vesselData = {
        mmsi: 100000000 + testCases.indexOf(testCase),
        name: testCase.name,
        lat: testCase.lat,
        lon: testCase.lon,
        sog: 2.0,
        cog: testCase.cog,
        timestamp: Date.now()
      };

      app.vesselManager.updateVessel(vesselData.mmsi, vesselData);
      const vessel = app.vesselManager.vessels.get(vesselData.mmsi);

      if (vessel.targetBridge) {
        expect(testCase.expectedTargets).toContain(vessel.targetBridge);
      }
    }
  });

  test('should handle startup with multiple boats at different bridges', async () => {
    // Test multiple boats startup scenario
    const boats = [
      {
        mmsi: 111111111,
        name: 'BOAT_1',
        lat: 58.272812, // Near Olidebron
        lon: 12.275323,
        sog: 2.0,
        cog: 40.0
      },
      {
        mmsi: 222222222,
        name: 'BOAT_2', 
        lat: 58.280000, // Near Klaffbron
        lon: 12.280000,
        sog: 1.5,
        cog: 35.0
      }
    ];

    // Add all boats
    boats.forEach(boat => {
      app.vesselManager.updateVessel(boat.mmsi, boat);
    });

    // Generate relevant boats
    const relevantBoats = app._findRelevantBoats();
    
    // Should handle all boats without errors
    relevantBoats.forEach(boat => {
      expect(boat.mmsi).toBeDefined();
      expect(boat.currentBridge).toBeDefined();
      expect(boat.targetBridge).toBeDefined();
      expect(boat.targetBridge).not.toBe('Unknown');
      expect(boat.etaMinutes).toBeGreaterThanOrEqual(0);
      expect(typeof boat.isWaiting).toBe('boolean');
      expect(typeof boat.isApproaching).toBe('boolean');
    });

    // Should generate valid bridge text
    const bridgeText = await app._generateBridgeTextFromBoats();
    if (bridgeText) {
      expect(bridgeText).not.toContain('undefined');
      expect(bridgeText).not.toContain('null');
      expect(bridgeText).not.toContain('Unknown');
    }
  });
});