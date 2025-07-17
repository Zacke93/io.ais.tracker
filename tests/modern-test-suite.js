/**
 * Modern Test Suite for AIS Bridge App
 * 
 * Designed specifically for TestAdapter with all latest updates
 * Tests follow Kravspec v2.3 with bearing-based passage detection
 */

'use strict';

const TestAdapter = require('./test-adapter');
const ScenarioLogger = require('./fixtures/scenario-logger');

// Mock WebSocket
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    readyState: 1,
    OPEN: 1,
    CLOSED: 3,
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  }));
});

// Helper function to create vessel with proper structure
function createVessel(overrides = {}) {
  return {
    mmsi: 123456789,
    name: 'TEST VESSEL',
    lat: 59.31721,
    lon: 18.06700,
    speed: 5.0,
    heading: 90,
    ...overrides
  };
}

// Helper to send AIS data
function sendAISData(app, vessel) {
  // Send static data first if name exists
  if (vessel.name) {
    app._handleAISMessage({
      MessageID: 'ShipStaticData',
      MetaData: { time_utc: new Date().toISOString() },
      Message: {
        ShipStaticData: {
          Name: vessel.name,
          UserID: vessel.mmsi,
          Valid: true,
        },
      },
    });
  }
  
  // Send position report
  app._handleAISMessage({
    MessageID: 'PositionReport',
    MetaData: { time_utc: new Date().toISOString() },
    Message: {
      PositionReport: {
        Cog: vessel.heading || 0,
        TrueHeading: vessel.heading || 0,
        Latitude: vessel.lat,
        Longitude: vessel.lon,
        NavigationalStatus: 'UnderWayUsingEngine',
        Sog: vessel.speed || 0,
        UserID: vessel.mmsi,
        Valid: true,
      },
    },
  });
}

describe('Modern AIS Bridge Test Suite', () => {
  let app;
  let scenarioLogger;
  let bridgeText = '';
  
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    // Create app instance
    app = new TestAdapter();
    scenarioLogger = new ScenarioLogger();
    bridgeText = '';
    
    // Mock Homey
    app.homey = {
      settings: {
        get: jest.fn((key) => {
          if (key === 'ais_api_key') return 'test-api-key';
          return null;
        }),
        set: jest.fn(),
        on: jest.fn(),
      },
      flow: {
        getConditionCard: jest.fn(() => ({
          registerRunListener: jest.fn(),
        })),
        getTriggerCard: jest.fn(() => ({
          trigger: jest.fn((args, state) => {
            scenarioLogger.logFlowTrigger('boat_near', args, state);
            return Promise.resolve();
          }),
        })),
        createToken: jest.fn(() => Promise.resolve({
          setValue: jest.fn(() => Promise.resolve()),
        })),
        getToken: jest.fn(() => Promise.resolve({
          setValue: jest.fn(() => Promise.resolve()),
        })),
      },
      __: jest.fn((key) => key),
      api: {
        getOwnerName: jest.fn(() => Promise.resolve('Test User')),
      },
      drivers: {
        getDriver: jest.fn(() => ({
          getDevices: jest.fn(() => []),
        })),
      },
    };
    
    // Mock device driver
    app._bridgeStatusDriver = {
      getDevices: jest.fn(() => [{
        setCapabilityValue: jest.fn((capability, value) => {
          if (capability === 'bridge_text') {
            const oldText = bridgeText;
            bridgeText = value;
            scenarioLogger.logBridgeTextChange(oldText, value, app._boats);
          }
        }),
      }]),
    };
    
    // Initialize app
    app.onInit();
  });
  
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    
    if (scenarioLogger.events.length > 0) {
      scenarioLogger.printScenario();
    }
  });
  
  describe('Basic Vessel Tracking', () => {
    test('should track vessel with name from static data', () => {
      const vessel = createVessel({
        mmsi: 265512280,
        name: 'EMMA F',
        lat: 59.31850,
        lon: 18.06700,
      });
      
      sendAISData(app, vessel);
      
      expect(app._boats.length).toBe(1);
      expect(app._boats[0].name).toBe('EMMA F');
      expect(app._boats[0].mmsi).toBe(265512280);
    });
    
    test('should update vessel position without losing name', () => {
      const vessel = createVessel({
        name: 'JULIA',
        lat: 59.31850,
      });
      
      // Send initial position
      sendAISData(app, vessel);
      expect(app._boats[0].name).toBe('JULIA');
      
      // Update position
      vessel.lat = 59.31860;
      sendAISData(app, vessel);
      
      expect(app._boats.length).toBe(1);
      expect(app._boats[0].name).toBe('JULIA');
      expect(app._boats[0].lat).toBe(59.31860);
    });
  });
  
  describe('Bridge Detection and Status', () => {
    test('should detect vessel approaching Klaffbron', () => {
      const vessel = createVessel({
        lat: 59.31650, // Just north of Klaffbron, closer than Stridsbergsbron
        lon: 18.06700,
        speed: 4.0,
        heading: 180, // Southbound
      });
      
      sendAISData(app, vessel);
      
      const boat = app._boats[0];
      expect(boat.nearBridge).toBe('Klaffbron');
      expect(boat.targetBridge).toBe('Klaffbron');
      expect(boat.status).toBe('approaching');
      expect(boat.targetDistance).toBeLessThan(300);
    });
    
    test('should show under-bridge status when very close', () => {
      const vessel = createVessel({
        lat: 59.31721, // Exactly at Klaffbron
        lon: 18.06700,
        speed: 1.0,
      });
      
      sendAISData(app, vessel);
      
      const boat = app._boats[0];
      expect(boat.status).toBe('under-bridge');
      expect(boat.targetDistance).toBeLessThan(50);
      expect(bridgeText).toBe('Öppning pågår vid Klaffbron');
    });
    
    test('should detect waiting status after 2 minutes slow speed', () => {
      const vessel = createVessel({
        lat: 59.31750, // Near Klaffbron
        speed: 0.15, // Below threshold
      });
      
      sendAISData(app, vessel);
      
      const boat = app._boats[0];
      expect(boat.status).toBe('approaching');
      
      // Maintain low speed for 2+ minutes
      for (let i = 0; i < 13; i++) {
        jest.advanceTimersByTime(10000); // 10 seconds
        vessel.speed = 0.1;
        sendAISData(app, vessel);
      }
      
      expect(boat.status).toBe('waiting');
      expect(boat.speedBelowThresholdSince).toBeDefined();
    });
  });
  
  describe('Bridge Passage Detection', () => {
    test('should detect passage when boat moves past bridge', () => {
      const vessel = createVessel({
        name: 'PASSAGE TEST',
        lat: 59.31721,
        lon: 18.06650, // West of Klaffbron
        speed: 5.0,
        heading: 90, // Eastbound
      });
      
      // Approach bridge
      sendAISData(app, vessel);
      const boat = app._boats[0];
      expect(boat.wasInsideTarget).toBe(true);
      expect(boat.status).toBe('approaching');
      
      // Pass bridge
      vessel.lon = 18.06800; // East of Klaffbron
      sendAISData(app, vessel);
      
      expect(boat.status).toBe('passed');
      expect(boat.passedBridges).toContain('Klaffbron');
      expect(boat.targetBridge).toBe('Stridsbergsbron'); // Next user bridge
    });
    
    test('should track vessel through multiple bridges', () => {
      const vessel = createVessel({
        name: 'MULTI BRIDGE',
        lat: 59.31553,
        lon: 18.05400, // West of Olidebron
        speed: 6.0,
        heading: 90,
      });
      
      // Start at Olidebron
      sendAISData(app, vessel);
      const boat = app._boats[0];
      expect(boat.nearBridge).toBe('Olidebron');
      
      // Pass Olidebron
      vessel.lon = 18.05700;
      sendAISData(app, vessel);
      expect(boat.targetBridge).toBe('Klaffbron');
      
      // Approach and pass Klaffbron
      vessel.lat = 59.31721;
      vessel.lon = 18.06650;
      sendAISData(app, vessel);
      expect(boat.targetBridge).toBe('Klaffbron');
      
      vessel.lon = 18.06800;
      sendAISData(app, vessel);
      expect(boat.passedBridges).toContain('Klaffbron');
      expect(boat.targetBridge).toBe('Stridsbergsbron');
    });
  });
  
  describe('Protection Zone Logic', () => {
    test('should activate protection zone for incoming vessels', () => {
      const vessel = createVessel({
        name: 'PROTECTION TEST',
        lat: 59.31900, // 200m north of Klaffbron
        lon: 18.06700,
        speed: 3.0,
        heading: 180, // Southbound (incoming)
      });
      
      sendAISData(app, vessel);
      
      const boat = app._boats[0];
      expect(boat.protectionZone).toBe(true);
      expect(boat.protectionZoneEnteredAt).toBeDefined();
    });
    
    test('should not activate protection zone for outgoing vessels', () => {
      const vessel = createVessel({
        lat: 59.31900, // North of Klaffbron
        lon: 18.06700,
        speed: 3.0,
        heading: 0, // Northbound (outgoing)
      });
      
      sendAISData(app, vessel);
      
      const boat = app._boats[0];
      expect(boat.protectionZone).toBe(false);
    });
  });
  
  describe('ETA Calculations', () => {
    test('should show waiting for very close slow boats', () => {
      const vessel = createVessel({
        name: 'JULIA',
        lat: 59.32420, // At Stridsbergsbron
        lon: 18.05043,
        speed: 0.2,
      });
      
      sendAISData(app, vessel);
      
      const boat = app._boats[0];
      expect(boat.eta).toBe(0);
      expect(bridgeText).toBe('JULIA väntar vid Stridsbergsbron');
    });
    
    test('should apply minimum speed rules for ETA', () => {
      const vessel = createVessel({
        lat: 59.31721,
        lon: 18.06000, // ~500m from Klaffbron
        speed: 0.5, // Very slow
        heading: 90,
      });
      
      sendAISData(app, vessel);
      
      const boat = app._boats[0];
      // Should use 1.5 kn minimum for 200-500m distance
      expect(boat.eta).toBeGreaterThan(5);
      expect(boat.eta).toBeLessThan(15);
    });
  });
  
  describe('Adaptive Speed Thresholds', () => {
    test('should track very slow boats when close to bridge', () => {
      const vessel = createVessel({
        lat: 59.31730, // ~50m from Klaffbron
        lon: 18.06680,
        speed: 0.08, // Very slow but > 0.05 kn
      });
      
      sendAISData(app, vessel);
      
      expect(app._boats.length).toBe(1);
      expect(app._boats[0].status).not.toBe('idle');
    });
    
    test('should filter slow boats far from bridges', () => {
      const vessel = createVessel({
        lat: 59.31721,
        lon: 18.06000, // ~500m from Klaffbron
        speed: 0.15, // Too slow for distance
      });
      
      sendAISData(app, vessel);
      
      // Boat should be filtered out
      const activeBoats = app._boats.filter(b => b.targetBridge !== null);
      expect(activeBoats.length).toBe(0);
    });
  });
  
  describe('Timeout Zones', () => {
    test('should apply correct timeout based on distance zones', () => {
      // Test all three zones
      const zones = [
        { distance: 250, expectedMinutes: 20 }, // Brozon
        { distance: 450, expectedMinutes: 10 }, // När-zon
        { distance: 800, expectedMinutes: 2 },  // Övrigt
      ];
      
      zones.forEach(zone => {
        const lat = 59.31721 + (zone.distance / 111000);
        const vessel = createVessel({
          mmsi: 100000 + zone.distance,
          lat: lat,
          speed: 3.0,
        });
        
        sendAISData(app, vessel);
        
        const boat = app._boats.find(b => b.mmsi === vessel.mmsi);
        const timeout = app._getSpeedAdjustedTimeout(boat);
        expect(timeout).toBe(zone.expectedMinutes * 60 * 1000);
      });
    });
  });
  
  describe('Bridge Text Generation', () => {
    test('should show multiple boats approaching', () => {
      // First boat
      sendAISData(app, createVessel({
        mmsi: 111111,
        name: 'EMMA F',
        lat: 59.31650,
        lon: 18.06700,
        speed: 4.0,
        heading: 180,
      }));
      
      // Second boat
      sendAISData(app, createVessel({
        mmsi: 222222,
        name: 'JULIA',
        lat: 59.31600,
        lon: 18.06700,
        speed: 3.5,
        heading: 0,
      }));
      
      expect(app._boats.length).toBe(2);
      
      // Trigger bridge text update
      app._updateActiveBridgesTag();
      
      // Get the actual bridge text
      const devices = app._bridgeStatusDriver.getDevices();
      const lastCall = devices[0].setCapabilityValue.mock.calls[devices[0].setCapabilityValue.mock.calls.length - 1];
      const actualBridgeText = lastCall ? lastCall[1] : '';
      
      expect(actualBridgeText).toContain('2 båtar');
    });
    
    test('should show context for boats at intermediate bridges', () => {
      const vessel = createVessel({
        name: 'CONTEXT TEST',
        lat: 59.32280, // At Järnvägsbron
        lon: 18.05700,
        speed: 5.0,
        heading: 270, // Westbound toward Stridsbergsbron
      });
      
      sendAISData(app, vessel);
      
      // Move closer to trigger context
      vessel.lon = 18.05600;
      sendAISData(app, vessel);
      
      const boat = app._boats[0];
      expect(boat.nearBridge).toBe('Järnvägsbron');
      expect(boat.targetBridge).toBe('Stridsbergsbron');
      
      // Should show context about being at Järnvägsbron
      expect(bridgeText).toContain('Järnvägsbron');
      expect(bridgeText).toContain('Stridsbergsbron');
    });
  });
  
  describe('System Stability', () => {
    test('should handle vessels with invalid data gracefully', () => {
      expect(() => {
        app._handleAISMessage({
          MessageID: 'PositionReport',
          MetaData: { time_utc: new Date().toISOString() },
          Message: {
            PositionReport: {
              Latitude: null,
              Longitude: undefined,
              UserID: 999999,
              Valid: true,
            },
          },
        });
      }).not.toThrow();
      
      expect(app._boats.length).toBe(0);
    });
    
    test('should track vessels through signal gaps', () => {
      const vessel = createVessel({
        name: 'GAP TEST',
        lat: 59.31800,
      });
      
      sendAISData(app, vessel);
      expect(app._boats.length).toBe(1);
      
      // Simulate 8 minute gap (under 10 min timeout)
      jest.advanceTimersByTime(8 * 60 * 1000);
      app._cleanup();
      
      // Vessel should still be tracked
      expect(app._boats.length).toBe(1);
      expect(app._boats[0].name).toBe('GAP TEST');
    });
    
    test('should handle rapid status changes', () => {
      const vessel = createVessel({
        name: 'RAPID CHANGE',
      });
      
      sendAISData(app, vessel);
      const boat = app._boats[0];
      
      // Rapidly change speed
      for (let i = 0; i < 20; i++) {
        vessel.speed = i % 2 === 0 ? 0.1 : 5.0;
        sendAISData(app, vessel);
        jest.advanceTimersByTime(1000);
      }
      
      expect(app._boats.length).toBe(1);
      expect(boat.speedHistory).toBeDefined();
      expect(boat.speedHistory.length).toBeLessThanOrEqual(20);
    });
  });
  
  describe('Performance', () => {
    test('should handle 20 vessels efficiently', () => {
      const vessels = [];
      
      // Create 20 vessels
      for (let i = 0; i < 20; i++) {
        vessels.push(createVessel({
          mmsi: 200000 + i,
          name: `VESSEL ${i}`,
          lat: 59.31000 + (i * 0.001),
          lon: 18.06000 + (i * 0.001),
          speed: 3 + (i * 0.2),
          heading: i * 18, // Different headings
        }));
      }
      
      // Send all vessels
      const startTime = Date.now();
      vessels.forEach(vessel => sendAISData(app, vessel));
      const loadTime = Date.now() - startTime;
      
      expect(app._boats.length).toBe(20);
      expect(loadTime).toBeLessThan(100);
      
      // Test update performance
      const updateStart = Date.now();
      app._updateActiveBridgesTag();
      const updateTime = Date.now() - updateStart;
      
      expect(updateTime).toBeLessThan(50);
    });
  });
});

// Additional integration tests
describe('Integration Scenarios', () => {
  let app;
  let scenarioLogger;
  
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    app = new TestAdapter();
    scenarioLogger = new ScenarioLogger();
    
    // Minimal mocking for integration tests
    app._bridgeStatusDriver = {
      getDevices: jest.fn(() => [{
        setCapabilityValue: jest.fn(),
      }]),
    };
    
    app.onInit();
  });
  
  test('Complete journey: Olidebron to Stridsbergsbron', () => {
    const vessel = createVessel({
      mmsi: 266023000,
      name: 'SKAGERN',
      lat: 59.31553,
      lon: 18.05300, // West of Olidebron
      speed: 6.0,
      heading: 90, // Eastbound
    });
    
    // Start journey
    sendAISData(app, vessel);
    scenarioLogger.logBoatUpdate(vessel.mmsi, vessel.name, 
      { lat: vessel.lat, lon: vessel.lon }, vessel.speed, vessel.heading, 'start');
    
    // Pass each bridge
    const waypoints = [
      { lon: 18.05700, bridge: 'Olidebron' },
      { lon: 18.06500, lat: 59.31721, bridge: 'approach Klaffbron' },
      { lon: 18.06900, bridge: 'passed Klaffbron' },
      { lon: 18.05200, lat: 59.32420, bridge: 'approach Stridsbergsbron' },
    ];
    
    waypoints.forEach((wp, index) => {
      jest.advanceTimersByTime(60000); // 1 minute
      
      if (wp.lat) vessel.lat = wp.lat;
      vessel.lon = wp.lon;
      sendAISData(app, vessel);
      
      const boat = app._boats[0];
      scenarioLogger.logBoatUpdate(vessel.mmsi, vessel.name,
        { lat: vessel.lat, lon: vessel.lon }, vessel.speed, vessel.heading, 
        `${wp.bridge} - status: ${boat.status}`);
    });
    
    const boat = app._boats[0];
    expect(boat.passedBridges).toContain('Klaffbron');
    expect(boat.targetBridge).toBe('Stridsbergsbron');
  });
});