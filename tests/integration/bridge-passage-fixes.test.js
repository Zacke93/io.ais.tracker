/* eslint-disable */
'use strict';

const AISBridgeApp = require('../../app');
const Homey = require('../__mocks__/homey');
const WebSocket = require('../__mocks__/ws');

jest.mock('ws');

describe('Bridge Passage Bug Fixes', () => {
  let app;
  let mockWebSocket;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new AISBridgeApp();
    // Get the mock WebSocket instance that was created
    mockWebSocket = WebSocket.mock.results[0]?.value;
  });

  afterEach(async () => {
    await app.onUninit();
  });

  describe('COG-based bridge passage detection', () => {
    it('should not mark vessel as passed when still approaching bridge', async () => {
      await app.onInit();
      
      // First position - approaching Klaffbron from south
      const msg1 = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 265716360,
            Latitude: 58.288,
            Longitude: 12.289,
            Sog: 2.0,
            Cog: 0.0, // Heading north
          },
        },
      };
      mockWebSocket.emit('message', JSON.stringify(msg1));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Second position - within APPROACH_RADIUS but > 50m
      const msg2 = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 265716360,
            Latitude: 58.289,
            Longitude: 12.289,
            Sog: 2.0,
            Cog: 0.0, // Still heading north (approaching)
          },
        },
      };
      mockWebSocket.emit('message', JSON.stringify(msg2));
      await new Promise(resolve => setTimeout(resolve, 50));

      const vessel = app.vesselManager.vessels.get(265716360);
      expect(vessel).toBeDefined();
      expect(vessel.status).not.toBe('passed');
      expect(vessel.targetBridge).toBe('Klaffbron');
    });

    it('should mark vessel as passed when moving away from bridge', async () => {
      await app.onInit();
      
      // First position - at bridge
      const msg1 = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 265716360,
            Latitude: 58.29035, // Very close to Klaffbron
            Longitude: 12.28935,
            Sog: 2.0,
            Cog: 0.0, // Heading north
          },
        },
      };
      mockWebSocket.emit('message', JSON.stringify(msg1));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Second position - past bridge and moving away
      const msg2 = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 265716360,
            Latitude: 58.291,
            Longitude: 12.289,
            Sog: 2.0,
            Cog: 0.0, // Still heading north (away from bridge)
          },
        },
      };
      mockWebSocket.emit('message', JSON.stringify(msg2));
      await new Promise(resolve => setTimeout(resolve, 100));

      const vessel = app.vesselManager.vessels.get(265716360);
      expect(vessel).toBeDefined();
      expect(vessel.status).toBe('passed');
      expect(vessel.targetBridge).toBe('Stridsbergsbron'); // Next user bridge
      expect(vessel.passedBridges).toContain('klaffbron');
    });
  });

  describe('Target bridge assignment after passage', () => {
    it('should not return same bridge after passage', async () => {
      await app.onInit();
      
      const vessel = {
        mmsi: 123456,
        passedBridges: ['klaffbron'],
        cog: 0.0,
      };
      
      const result = app.bridgeMonitor._findTargetBridge(vessel, 'klaffbron');
      expect(result).not.toBe('Klaffbron');
      expect(result).toBe('Stridsbergsbron'); // Next user bridge north
    });

    it('should handle vessels with no more target bridges', async () => {
      await app.onInit();
      
      // Simulate vessel that has passed final user bridge
      const msg = {
        MessageType: 'PositionReport',
        MetaData: { time_utc: new Date().toISOString() },
        Message: {
          PositionReport: {
            UserID: 123456,
            Latitude: 58.295, // North of Stridsbergsbron
            Longitude: 12.290,
            Sog: 2.0,
            Cog: 0.0,
          },
        },
      };
      
      // Manually set up vessel state
      app.vesselManager.updateVessel(123456, {
        lat: 58.295,
        lon: 12.290,
        sog: 2.0,
        cog: 0.0,
        name: 'TEST',
      });
      
      const vessel = app.vesselManager.vessels.get(123456);
      vessel.passedBridges = ['klaffbron', 'stridsbergsbron'];
      vessel.status = 'passed';
      vessel.targetBridge = null;
      
      // Check that vessel is scheduled for removal
      expect(app.vesselManager.cleanupTimers.has(123456)).toBe(true);
    });
  });

  describe('Message generation accuracy', () => {
    it('should correctly count boats approaching same bridge', async () => {
      await app.onInit();
      
      // Add 4 boats approaching Klaffbron
      const boats = [
        { mmsi: 111, targetBridge: 'Klaffbron', etaMinutes: 3, isWaiting: false },
        { mmsi: 222, targetBridge: 'Klaffbron', etaMinutes: 4, isWaiting: false },
        { mmsi: 333, targetBridge: 'Klaffbron', etaMinutes: 2, isWaiting: false },
        { mmsi: 444, targetBridge: 'Klaffbron', etaMinutes: 8, isWaiting: false },
      ];
      
      const text = app.messageGenerator.generateBridgeText(boats);
      expect(text).toContain('En båt närmar sig Klaffbron');
      expect(text).toContain('ytterligare 3 båtar på väg');
      expect(text).toContain('beräknad broöppning om 2 minuter'); // Shortest ETA
    });

    it('should show mellanbro information when relevant', async () => {
      await app.onInit();
      
      const boats = [
        {
          mmsi: 111,
          currentBridge: 'Stallbackabron',
          targetBridge: 'Stridsbergsbron',
          etaMinutes: 10,
          isWaiting: false,
          distanceToCurrent: 250, // Within 300m
        },
      ];
      
      const text = app.messageGenerator.generateBridgeText(boats);
      expect(text).toBe('En båt vid Stallbackabron närmar sig Stridsbergsbron, beräknad broöppning om 10 minuter');
    });
  });
});