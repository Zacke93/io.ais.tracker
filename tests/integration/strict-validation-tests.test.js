/* eslint-disable */
'use strict';

const AISBridgeApp = require('../../app');
const Homey = require('../__mocks__/homey');
const WebSocket = require('../__mocks__/ws');

jest.mock('ws');

describe('Strict Validation Tests', () => {
  let app;
  let mockWebSocket;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = new AISBridgeApp();
    
    // Mock the settings to avoid API key error
    app.homey.settings.get = jest.fn((key) => {
      if (key === 'apiKey') return 'test-api-key';
      return null;
    });
    
    await app.onInit();
    
    // Get the mock WebSocket instance that was created
    mockWebSocket = WebSocket.mock.instances[0];
  });

  afterEach(async () => {
    await app.onUninit();
  });

  describe('Target bridge assignment validation', () => {
    it('should not assign target bridge to vessel 400m away moving at 0.2kn', async () => {
      
      // Vessel 400m from Klaffbron, moving very slowly
      const msg = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 261008927,
            Latitude: 58.287595, // 400m from Klaffbron
            Longitude: 12.285548,
            Sog: 0.2, // Very slow
            Cog: 360.0, // Heading north
          },
        },
      };
      
      mockWebSocket.emit('message', JSON.stringify(msg));
      await new Promise(resolve => setTimeout(resolve, 50));

      const vessel = app.vesselManager.vessels.get(261008927);
      expect(vessel).toBeDefined();
      // Should NOT have targetBridge assigned due to distance + slow speed
      expect(vessel.targetBridge).toBeNull();
    });

    it('should assign target bridge to vessel 250m away moving at 2kn', async () => {
      
      // Vessel 250m from Klaffbron, moving normally
      const msg = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 123456,
            Latitude: 58.2885, // ~250m from Klaffbron
            Longitude: 12.289,
            Sog: 2.0, // Normal speed
            Cog: 0.0, // Heading north towards bridge
          },
        },
      };
      
      mockWebSocket.emit('message', JSON.stringify(msg));
      await new Promise(resolve => setTimeout(resolve, 50));

      const vessel = app.vesselManager.vessels.get(123456);
      expect(vessel).toBeDefined();
      // Should have targetBridge assigned
      expect(vessel.targetBridge).toBe('Klaffbron');
    });

    it('should not assign target bridge to vessel heading away from bridge', async () => {
      
      // Vessel near Klaffbron but heading south (away)
      const msg = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 789012,
            Latitude: 58.289, // Near Klaffbron
            Longitude: 12.289,
            Sog: 2.0,
            Cog: 180.0, // Heading south (away from bridge)
          },
        },
      };
      
      mockWebSocket.emit('message', JSON.stringify(msg));
      await new Promise(resolve => setTimeout(resolve, 50));

      const vessel = app.vesselManager.vessels.get(789012);
      expect(vessel).toBeDefined();
      // Should NOT have targetBridge since heading away
      expect(vessel.targetBridge).toBeNull();
    });
  });

  describe('Status transition after bridge passage', () => {
    it('should reset status to en-route when getting new target after passage', async () => {
      
      // First position - approaching Klaffbron
      const msg1 = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 211819720,
            Latitude: 58.29030, // Very close to Klaffbron
            Longitude: 12.28935,
            Sog: 2.0,
            Cog: 0.0,
          },
        },
      };
      mockWebSocket.emit('message', JSON.stringify(msg1));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Second position - past bridge
      const msg2 = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 211819720,
            Latitude: 58.2915, // 150m past Klaffbron
            Longitude: 12.289,
            Sog: 2.0,
            Cog: 0.0,
          },
        },
      };
      mockWebSocket.emit('message', JSON.stringify(msg2));
      await new Promise(resolve => setTimeout(resolve, 100));

      const vessel = app.vesselManager.vessels.get(211819720);
      expect(vessel).toBeDefined();
      // Should have new target and status should be en-route, not passed
      expect(vessel.targetBridge).toBe('Stridsbergsbron');
      expect(vessel.status).toBe('en-route');
    });
  });

  describe('Relevant boats filtering', () => {
    it('should filter out vessels with status passed', async () => {
      
      // Create a vessel and manually set it as passed
      app.vesselManager.updateVessel(123456, {
        lat: 58.295,
        lon: 12.290,
        sog: 2.0,
        cog: 0.0,
        name: 'TEST',
      });
      
      const vessel = app.vesselManager.vessels.get(123456);
      vessel.status = 'passed';
      vessel.targetBridge = 'Klaffbron';
      
      const relevantBoats = app._findRelevantBoats();
      expect(relevantBoats).toHaveLength(0);
    });

    it('should filter out distant slow vessels not heading towards bridge', async () => {
      
      // Vessel 350m away, slow, not heading towards bridge
      const msg = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 999888,
            Latitude: 58.287, // ~350m from Klaffbron
            Longitude: 12.289,
            Sog: 0.8,
            Cog: 270.0, // Heading west, not towards bridge
          },
        },
      };
      
      mockWebSocket.emit('message', JSON.stringify(msg));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Manually set targetBridge to test filtering
      const vessel = app.vesselManager.vessels.get(999888);
      vessel.targetBridge = 'Klaffbron';
      
      const relevantBoats = app._findRelevantBoats();
      expect(relevantBoats).toHaveLength(0);
    });
  });

  describe('Target bridge validation during updates', () => {
    it('should clear targetBridge when vessel moves far away and slows down', async () => {
      
      // First position - close to bridge with target
      const msg1 = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 555666,
            Latitude: 58.289, // Near Klaffbron
            Longitude: 12.289,
            Sog: 2.0,
            Cog: 0.0,
          },
        },
      };
      mockWebSocket.emit('message', JSON.stringify(msg1));
      await new Promise(resolve => setTimeout(resolve, 50));

      let vessel = app.vesselManager.vessels.get(555666);
      expect(vessel.targetBridge).toBe('Klaffbron');

      // Second position - far away and slow
      const msg2 = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 555666,
            Latitude: 58.283, // ~900m from Klaffbron
            Longitude: 12.289,
            Sog: 0.2, // Very slow
            Cog: 180.0,
          },
        },
      };
      mockWebSocket.emit('message', JSON.stringify(msg2));
      await new Promise(resolve => setTimeout(resolve, 50));

      vessel = app.vesselManager.vessels.get(555666);
      // Target should be cleared due to distance + slow speed
      expect(vessel.targetBridge).toBeNull();
    });
  });
});