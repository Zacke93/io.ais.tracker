/* eslint-disable */
'use strict';

const Homey = require('homey');
const AISBridgeApp = require('../../app.js');

// Mock WebSocket to prevent real connections
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    readyState: 1,
    OPEN: 1,
    CLOSED: 3
  }));
});

describe('AIS Bridge App - Real Behavior Tests', () => {
  let app;
  let flowTriggers;
  let capabilityValues;
  let mockWs;

  beforeEach(async () => {
    flowTriggers = [];
    capabilityValues = {};

    // Create app instance
    app = new AISBridgeApp();
    
    // Mock Homey methods
    app.homey = {
      settings: {
        get: jest.fn((key) => {
          if (key === 'apiKey') return 'test-api-key';
          return null;
        }),
        set: jest.fn(),
        on: jest.fn() // Add missing method
      },
      flow: {
        getTriggerCard: jest.fn((name) => ({
          registerRunListener: jest.fn(),
          trigger: jest.fn((tokens, state) => {
            flowTriggers.push({ card: name, tokens, state, timestamp: Date.now() });
          })
        })),
        getConditionCard: jest.fn((name) => ({
          registerRunListener: jest.fn()
        })),
        createToken: jest.fn().mockResolvedValue({
          setValue: jest.fn()
        })
      },
      __ : jest.fn((key) => key)
    };

    app.log = jest.fn();
    app.error = jest.fn();
    
    app.setCapabilityValue = jest.fn((capability, value) => {
      capabilityValues[capability] = value;
    });

    // Initialize app
    await app.onInit();

    // Get WebSocket mock
    const WS = require('ws');
    mockWs = WS.mock.results[0].value;
  });

  afterEach(() => {
    if (app.ws) {
      app.ws.close();
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('Vessel Management and Bridge Detection', () => {
    it('should track vessel approaching user bridge and generate correct message', async () => {
      // Simulate AIS message for vessel approaching Klaffbron
      const aisMessage = {
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: '265573130',
          ShipName: 'ELFKUNGEN',
          time_utc: new Date().toISOString()
        },
        Message: {
          PositionReport: {
            Latitude: 58.29052 - 0.0018, // ~200m south of Klaffbron
            Longitude: 12.29434,
            Sog: 3.0,
            Cog: 0 // Heading north
          }
        }
      };

      // Trigger WebSocket message handler
      const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
      onMessage(JSON.stringify(aisMessage));

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify vessel was added
      expect(app.vesselManager.vessels.has('265573130')).toBe(true);

      // Verify flow trigger
      expect(flowTriggers.some(t => 
        t.card === 'boat_near' && 
        t.tokens.bridge === 'Klaffbron'
      )).toBe(true);

      // Verify capability updates
      expect(capabilityValues.alarm_generic).toBe(true);
      expect(capabilityValues.bridge_text).toContain('Klaffbron');
    });

    it('should handle vessel passage detection correctly', async () => {
      jest.useFakeTimers();

      // First position: approaching Stridsbergsbron
      const aisMessage1 = {
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: '265573131',
          ShipName: 'PASSAGE_TEST',
          time_utc: new Date().toISOString()
        },
        Message: {
          PositionReport: {
            Latitude: 58.29475 - 0.0009, // ~100m south
            Longitude: 12.29691,
            Sog: 4.0,
            Cog: 0
          }
        }
      };

      const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
      onMessage(JSON.stringify(aisMessage1));

      await Promise.resolve();

      // Verify vessel is tracked
      const vessel1 = app.vesselManager.vessels.get('265573131');
      expect(vessel1).toBeDefined();
      expect(vessel1._wasInsideTarget).toBe(true);

      // Second position: past bridge
      jest.advanceTimersByTime(30000);

      const aisMessage2 = {
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: '265573131',
          ShipName: 'PASSAGE_TEST',
          time_utc: new Date(Date.now() + 30000).toISOString()
        },
        Message: {
          PositionReport: {
            Latitude: 58.29475 + 0.00054, // ~60m north
            Longitude: 12.29691,
            Sog: 4.0,
            Cog: 0
          }
        }
      };

      onMessage(JSON.stringify(aisMessage2));

      await Promise.resolve();

      // Verify passage detected
      const vessel2 = app.vesselManager.vessels.get('265573131');
      expect(vessel2.status).toBe('passed');

      jest.useRealTimers();
    });

    it('should apply waiting status after 2 minutes of low speed', async () => {
      jest.useFakeTimers();

      const mmsi = '265573132';
      
      // Position within 300m with low speed
      const aisMessage = {
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: mmsi,
          ShipName: 'WAITING_TEST',
          time_utc: new Date().toISOString()
        },
        Message: {
          PositionReport: {
            Latitude: 58.29475 - 0.0018, // ~200m from Stridsbergsbron
            Longitude: 12.29691,
            Sog: 0.15, // Below 0.20 kn
            Cog: 0
          }
        }
      };

      const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
      onMessage(JSON.stringify(aisMessage));

      await Promise.resolve();

      // Verify not waiting yet
      const vessel1 = app.vesselManager.vessels.get(mmsi);
      expect(vessel1.status).not.toBe('waiting');

      // Fast forward and send updates
      for (let i = 0; i < 9; i++) {
        jest.advanceTimersByTime(15000); // 15 seconds each
        
        const updateMessage = {
          ...aisMessage,
          MetaData: {
            ...aisMessage.MetaData,
            time_utc: new Date(Date.now() + (i + 1) * 15000).toISOString()
          }
        };
        
        onMessage(JSON.stringify(updateMessage));
        await Promise.resolve();
      }

      // After 2+ minutes, should be waiting
      const vessel2 = app.vesselManager.vessels.get(mmsi);
      expect(vessel2.status).toBe('waiting');

      // Verify message shows waiting
      expect(capabilityValues.bridge_text).toContain('väntar');

      jest.useRealTimers();
    });

    it('should detect under-bridge status when vessel is very close', async () => {
      const mmsi = '265573133';

      // First establish near bridge
      const aisMessage1 = {
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: mmsi,
          ShipName: 'UNDER_BRIDGE_TEST',
          time_utc: new Date().toISOString()
        },
        Message: {
          PositionReport: {
            Latitude: 58.29475 - 0.0009, // ~100m from Stridsbergsbron
            Longitude: 12.29691,
            Sog: 1.0,
            Cog: 0
          }
        }
      };

      const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
      onMessage(JSON.stringify(aisMessage1));

      await Promise.resolve();

      // Move to <50m from bridge
      const aisMessage2 = {
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: mmsi,
          ShipName: 'UNDER_BRIDGE_TEST',
          time_utc: new Date(Date.now() + 30000).toISOString()
        },
        Message: {
          PositionReport: {
            Latitude: 58.29475 - 0.00036, // ~40m from bridge
            Longitude: 12.29691,
            Sog: 0.5,
            Cog: 0
          }
        }
      };

      onMessage(JSON.stringify(aisMessage2));

      await Promise.resolve();

      // Verify under-bridge status
      const vessel = app.vesselManager.vessels.get(mmsi);
      expect(vessel.status).toBe('under-bridge');
      expect(vessel.etaMinutes).toBe(0);

      // Verify message
      expect(capabilityValues.bridge_text).toContain('Öppning pågår');
    });

    it('should apply correct timeout zones', async () => {
      jest.useFakeTimers();

      // Test vessel in När-zon (300-600m)
      const mmsi = '265573134';
      const aisMessage = {
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: mmsi,
          ShipName: 'TIMEOUT_TEST',
          time_utc: new Date().toISOString()
        },
        Message: {
          PositionReport: {
            Latitude: 58.29475 - 0.0045, // ~500m from bridge
            Longitude: 12.29691,
            Sog: 2.0,
            Cog: 0
          }
        }
      };

      const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
      onMessage(JSON.stringify(aisMessage));

      await Promise.resolve();

      // Verify vessel exists
      expect(app.vesselManager.vessels.has(mmsi)).toBe(true);

      // Fast forward 9 minutes (within 10 min timeout)
      jest.advanceTimersByTime(9 * 60 * 1000);

      // Should still exist
      expect(app.vesselManager.vessels.has(mmsi)).toBe(true);

      // Fast forward past 10 minutes
      jest.advanceTimersByTime(2 * 60 * 1000);

      // Should be removed
      expect(app.vesselManager.vessels.has(mmsi)).toBe(false);

      jest.useRealTimers();
    });

    it('should handle multiple boats with correct prioritization', async () => {
      // Add multiple boats
      const boats = [
        { mmsi: '111111111', name: 'BOAT1', lat: 58.29052 - 0.0018, lon: 12.29434, sog: 3.0 }, // Klaffbron
        { mmsi: '222222222', name: 'BOAT2', lat: 58.29475 - 0.0009, lon: 12.29691, sog: 0.1 }, // Stridsbergsbron
        { mmsi: '333333333', name: 'BOAT3', lat: 58.29475 - 0.00036, lon: 12.29691, sog: 0.5 } // Under bridge
      ];

      const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];

      for (const boat of boats) {
        const message = {
          MessageType: 'PositionReport',
          MetaData: {
            MMSI: boat.mmsi,
            ShipName: boat.name,
            time_utc: new Date().toISOString()
          },
          Message: {
            PositionReport: {
              Latitude: boat.lat,
              Longitude: boat.lon,
              Sog: boat.sog,
              Cog: 0
            }
          }
        };
        
        onMessage(JSON.stringify(message));
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Set boat 3 as under-bridge
      const boat3 = app.vesselManager.vessels.get('333333333');
      if (boat3) {
        boat3.status = 'under-bridge';
        boat3.targetBridge = 'Stridsbergsbron';
      }

      // Trigger update
      app._updateUI();

      // Under-bridge should take priority in message
      expect(capabilityValues.bridge_text).toContain('Öppning pågår');
    });
  });

  describe('Connection and Error Handling', () => {
    it('should handle WebSocket disconnection and reconnection', async () => {
      jest.useFakeTimers();

      // Verify initial connection
      expect(mockWs.readyState).toBe(1); // OPEN

      // Simulate disconnect
      const onClose = mockWs.on.mock.calls.find(call => call[0] === 'close')[1];
      mockWs.readyState = 3; // CLOSED
      onClose();

      // Verify connection status update
      expect(capabilityValues.connection_status).toBe('disconnected');

      // Wait for reconnection attempt
      jest.advanceTimersByTime(5000);

      // New WebSocket should be created
      const WS = require('ws');
      expect(WS).toHaveBeenCalledTimes(2); // Initial + reconnect

      jest.useRealTimers();
    });

    it('should validate hysteresis rule for bridge switching', async () => {
      const mmsi = '265573135';

      // Position between two bridges
      const baseMessage = {
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: mmsi,
          ShipName: 'HYSTERESIS_TEST',
          time_utc: new Date().toISOString()
        }
      };

      const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];

      // Initial position closer to Klaffbron
      onMessage(JSON.stringify({
        ...baseMessage,
        Message: {
          PositionReport: {
            Latitude: 58.29052 + 0.0009, // Slightly north of Klaffbron
            Longitude: 12.29434,
            Sog: 2.0,
            Cog: 0
          }
        }
      }));

      await Promise.resolve();

      const vessel1 = app.vesselManager.vessels.get(mmsi);
      const firstBridge = vessel1.nearBridge;

      // Move slightly (but not 10% closer to next bridge)
      onMessage(JSON.stringify({
        ...baseMessage,
        Message: {
          PositionReport: {
            Latitude: 58.29052 + 0.00095,
            Longitude: 12.29434 + 0.00005,
            Sog: 2.0,
            Cog: 0
          }
        }
      }));

      await Promise.resolve();

      const vessel2 = app.vesselManager.vessels.get(mmsi);
      // Should not switch due to hysteresis
      expect(vessel2.nearBridge).toBe(firstBridge);
    });
  });

  describe('GRACE_MISSES and Irrelevant Detection', () => {
    it('should apply grace misses before removing irrelevant vessels', async () => {
      jest.useFakeTimers();
      
      const mmsi = '265573136';

      // Add vessel far from bridges with low speed
      const aisMessage = {
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: mmsi,
          ShipName: 'GRACE_TEST',
          time_utc: new Date().toISOString()
        },
        Message: {
          PositionReport: {
            Latitude: 58.29475 - 0.0036, // ~400m from nearest bridge
            Longitude: 12.29691,
            Sog: 0.1,
            Cog: 0
          }
        }
      };

      const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
      onMessage(JSON.stringify(aisMessage));

      await Promise.resolve();

      const vessel = app.vesselManager.vessels.get(mmsi);
      vessel.status = 'idle'; // Set idle for grace misses

      // Trigger irrelevant checks multiple times
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(130000); // 2+ minutes
        app.vesselManager._checkIrrelevantVessels();
        await Promise.resolve();

        if (i < 2) {
          // Should still exist (grace misses)
          expect(app.vesselManager.vessels.has(mmsi)).toBe(true);
        }
      }

      // After 3rd miss, should be removed
      expect(app.vesselManager.vessels.has(mmsi)).toBe(false);

      jest.useRealTimers();
    });
  });
});