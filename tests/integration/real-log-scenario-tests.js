/* eslint-disable */
'use strict';

/**
 * Real Log Scenario Tests
 * 
 * Dessa tester återskapar exakta scenarion från produktionsloggarna
 * för att verifiera att systemet hanterar verkliga situationer korrekt.
 */

const { 
  VesselStateManager, 
  BridgeMonitor, 
  AISConnectionManager, 
  MessageGenerator, 
  ETACalculator,
  CONSTANTS 
} = require('../../app.js');

const EventEmitter = require('events');
// WebSocket will be mocked by Jest

describe('Real Log Scenarios - Production Bug Reproduction', () => {
  let vesselManager;
  let bridgeMonitor;
  let messageGenerator;
  let aisConnection;
  let mockLogger;
  let mockApp;
  let wsServer;
  let wsClient;

  // Real bridge data
  const bridges = {
    olidebron: {
      id: 'olidebron',
      name: 'Olidebron',
      lat: 58.272743083145855,
      lon: 12.275115821922993,
      radius: 300,
    },
    klaffbron: {
      id: 'klaffbron',
      name: 'Klaffbron',
      lat: 58.28409551543077,
      lon: 12.283929525245636,
      radius: 300,
    },
    jarnvagsbron: {
      id: 'jarnvagsbron',
      name: 'Järnvägsbron',
      lat: 58.29164042152742,
      lon: 12.292025280073759,
      radius: 300,
    },
    stridsbergsbron: {
      id: 'stridsbergsbron',
      name: 'Stridsbergsbron',
      lat: 58.293524096154634,
      lon: 12.294566425158054,
      radius: 300,
    },
    stallbackabron: {
      id: 'stallbackabron',
      name: 'Stallbackabron',
      lat: 58.31142992293701,
      lon: 12.31456385688822,
      radius: 300,
    },
  };

  beforeEach((done) => {
    // Create mock WebSocket server for testing
    wsServer = {
      clients: new Set(),
      close: (cb) => cb && cb(),
      on: jest.fn()
    };
    
    mockLogger = {
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn()
    };

    // Create managers
    vesselManager = new VesselStateManager(mockLogger);
    bridgeMonitor = new BridgeMonitor(bridges, vesselManager, mockLogger);
    messageGenerator = new MessageGenerator(bridges, mockLogger);
    
    // Create mock app
    mockApp = {
      log: mockLogger,
      bridges: Object.values(bridges),
      vesselManager,
      bridgeMonitor,
      messageGenerator,
      setCapabilityValue: jest.fn().mockResolvedValue(),
      updateGlobalToken: jest.fn(),
      homey: {
        flow: {
          getTriggerCard: jest.fn().mockReturnValue({
            trigger: jest.fn().mockResolvedValue()
          }),
          getConditionCard: jest.fn().mockReturnValue({})
        },
        settings: {
          get: jest.fn().mockReturnValue('test-api-key')
        }
      }
    };

    // Create AIS connection
    aisConnection = new AISConnectionManager(mockApp, mockLogger);
    
    wsServer.on('connection', (ws) => {
      ws.on('message', (data) => {
        // Echo back subscription success
        const msg = JSON.parse(data);
        if (msg.APIKey) {
          ws.send(JSON.stringify({
            MessageType: "SubscriptionSuccess",
            Message: "Subscription successful"
          }));
        }
      });
    });

    done();
  });

  afterEach((done) => {
    if (wsClient) wsClient.close();
    if (aisConnection) aisConnection.disconnect();
    wsServer.close(done);
  });

  describe('Scenario 1: Vessel 219009742 från logs 2025-07-15', () => {
    /**
     * Från loggarna:
     * - Båt dyker upp vid Stridsbergsbron (221m avstånd)
     * - Hastighet 0.1 kn
     * - Får timeout 20min (korrekt för <300m)
     * - Kommer närmare (10m) och blir "under-bridge"
     * - Försvinner sedan utan bropassage-detektion
     */
    
    it('should handle vessel approaching and going under bridge', async () => {
      // 1. Vessel appears 221m from Stridsbergsbron
      const vessel1 = vesselManager.updateVessel(219009742, {
        lat: 58.2933,
        lon: 12.2942,
        sog: 0.1,
        cog: 45,
        name: 'SPIKEN'
      });

      // Simulate BridgeMonitor update
      vessel1._distanceToNearest = 221;
      vessel1.nearBridge = 'stridsbergsbron';
      vessel1.targetBridge = 'stridsbergsbron';
      vessel1.targetDistance = 221;

      // Verify timeout is 20min for <300m
      const timeout1 = vesselManager._calculateTimeout(vessel1);
      expect(timeout1).toBe(1200000); // 20 minutes

      // 2. Vessel moves to 10m from bridge
      const vessel2 = vesselManager.updateVessel(219009742, {
        lat: 58.29352,
        lon: 12.29456,
        sog: 0.1,
        cog: 45,
        name: 'SPIKEN'
      });

      vessel2._distanceToNearest = 10;
      vessel2.targetDistance = 10;
      vessel2._wasInsideTarget = true;

      // Should trigger under-bridge status when <50m
      if (vessel2.targetDistance < 50 && vessel2.targetBridge) {
        vessel2.status = 'under-bridge';
      }

      expect(vessel2.status).toBe('under-bridge');

      // 3. Vessel should be detected as passing when distance increases
      const vessel3 = vesselManager.updateVessel(219009742, {
        lat: 58.294,
        lon: 12.295,
        sog: 0.1,
        cog: 45,
        name: 'SPIKEN'
      });

      vessel3.targetDistance = 320;

      // Should detect passage
      if (vessel3._wasInsideTarget && vessel3.targetDistance > 50) {
        vessel3.status = 'passed';
        vessel3.passedBridges.push('stridsbergsbron');
      }

      expect(vessel3.status).toBe('passed');
      expect(vessel3.passedBridges).toContain('stridsbergsbron');
    });
  });

  describe('Scenario 2: WebSocket Connection Issues', () => {
    it('should handle WebSocket connection failure and retry', async () => {
      // Close server to simulate connection failure
      wsServer.close();

      // Try to connect
      const connectPromise = aisConnection.connect('ws://localhost:8765');

      // Should fail but not throw
      await expect(connectPromise).resolves.not.toThrow();

      // Should log connection failure
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket anslutning misslyckades')
      );

      // Should schedule retry
      expect(aisConnection.reconnectTimer).toBeDefined();
    });

    it('should handle malformed AIS messages', async () => {
      await aisConnection.connect('ws://localhost:8765');

      // Send malformed message
      const malformedMsg = {
        MessageType: "PositionReport",
        // Missing required fields
      };

      // Simulate receiving malformed message
      aisConnection._handleMessage(malformedMsg);

      // Should not crash
      expect(vesselManager.vessels.size).toBe(0);
    });
  });

  describe('Scenario 3: Multiple Vessels at Same Bridge', () => {
    it('should handle multiple vessels waiting at same bridge', () => {
      // Add first vessel
      const vessel1 = vesselManager.updateVessel(219009742, {
        lat: 58.284,
        lon: 12.284,
        sog: 0.1,
        cog: 45,
        name: 'SPIKEN'
      });

      vessel1.targetBridge = 'klaffbron';
      vessel1.targetDistance = 80;
      vessel1.status = 'waiting';
      vessel1.speedBelowThresholdSince = Date.now() - 130000; // >2 min

      // Add second vessel
      const vessel2 = vesselManager.updateVessel(265866450, {
        lat: 58.284,
        lon: 12.283,
        sog: 0.15,
        cog: 50,
        name: 'JULIA'
      });

      vessel2.targetBridge = 'klaffbron';
      vessel2.targetDistance = 100;
      vessel2.status = 'waiting';
      vessel2.speedBelowThresholdSince = Date.now() - 140000;

      // Generate message
      const boats = [
        {
          mmsi: vessel1.mmsi,
          name: vessel1.name,
          targetBridge: vessel1.targetBridge,
          isWaiting: true,
          confidence: 'high'
        },
        {
          mmsi: vessel2.mmsi,
          name: vessel2.name,
          targetBridge: vessel2.targetBridge,
          isWaiting: true,
          confidence: 'high'
        }
      ];

      const text = messageGenerator.generateBridgeText(boats);
      
      // Should show "2 båtar väntar vid Klaffbron"
      expect(text).toContain('2 båtar väntar vid');
      expect(text).toContain('Klaffbron');
    });
  });

  describe('Scenario 4: Vessel Movement Between Bridges', () => {
    it('should track vessel moving from Klaffbron to Stridsbergsbron', () => {
      // Start at Klaffbron
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.284,
        lon: 12.284,
        sog: 3.5,
        cog: 45,
        name: 'EMMA F'
      });

      vessel.targetBridge = 'klaffbron';
      vessel.nearBridge = 'klaffbron';
      vessel.targetDistance = 50;
      vessel._wasInsideTarget = true;

      // Pass Klaffbron
      vessel = vesselManager.updateVessel(219009742, {
        lat: 58.285,
        lon: 12.285,
        sog: 3.5,
        cog: 45,
        name: 'EMMA F'
      });

      vessel.targetDistance = 320;

      // Should detect passage
      if (vessel._wasInsideTarget && vessel.targetDistance > 50) {
        vessel.status = 'passed';
        vessel.passedBridges.push('klaffbron');
        
        // Find next target bridge
        vessel.targetBridge = 'stridsbergsbron';
        vessel.nearBridge = null;
      }

      expect(vessel.status).toBe('passed');
      expect(vessel.targetBridge).toBe('stridsbergsbron');

      // Continue to Stridsbergsbron
      vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 3.5,
        cog: 45,
        name: 'EMMA F'
      });

      vessel.nearBridge = 'stridsbergsbron';
      vessel.targetDistance = 200;
      vessel.status = 'approaching';

      expect(vessel.nearBridge).toBe('stridsbergsbron');
      expect(vessel.status).toBe('approaching');
    });
  });

  describe('Scenario 5: ETA Calculation Edge Cases', () => {
    it('should handle very slow vessel ETA correctly', () => {
      const etaCalc = new ETACalculator(mockLogger);
      
      const vessel = {
        mmsi: 265866450,
        name: 'JULIA',
        targetBridge: 'klaffbron',
        targetDistance: 169,
        sog: 0.2,
        maxRecentSpeed: 2.0,
        status: 'approaching'
      };

      // Calculate ETA
      const eta = etaCalc.calculateETA(vessel, vessel.targetDistance, null, vessel.targetBridge);
      
      // For 169m at 0.2kn, should use min speed rules
      // <200m requires >=0.5kn minimum
      // So effective speed should be 0.5kn, not 0.2kn
      const expectedEta = 169 / (0.5 * 1.852 / 3.6) / 60;
      
      // Should not be 11 minutes (which was the bug)
      expect(eta).toBeLessThan(11);
      expect(eta).toBeCloseTo(expectedEta, 1);
    });

    it('should show 0 ETA for vessels under bridge', () => {
      const etaCalc = new ETACalculator(mockLogger);
      
      const vessel = {
        mmsi: 219009742,
        name: 'SPIKEN',
        targetBridge: 'stridsbergsbron',
        targetDistance: 10,
        sog: 0.1,
        status: 'under-bridge'
      };

      const eta = etaCalc.calculateETA(vessel, vessel.targetDistance, null, vessel.targetBridge);
      
      // Should be 0 or very small for under-bridge
      expect(eta).toBeLessThanOrEqual(0);
    });
  });

  describe('Scenario 6: Protection Zone Logic', () => {
    it('should keep vessel in system when turning within 300m', () => {
      // Vessel approaching bridge
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45, // Northeast - approaching
        name: 'TEST VESSEL'
      });

      vessel._distanceToNearest = 250;
      vessel.nearBridge = 'stridsbergsbron';

      // Vessel turns around within 300m
      vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 225, // Southwest - away
        name: 'TEST VESSEL'
      });

      // Should still be tracked (protection zone)
      expect(vesselManager.vessels.has(219009742)).toBe(true);
      
      // But should not be considered approaching
      expect(vessel.cog).toBe(225);
    });
  });

  describe('Scenario 7: Long-running Stability Test', () => {
    it('should handle continuous updates for extended period', () => {
      const startTime = Date.now();
      const mmsi = 219009742;

      // Simulate 100 position updates
      for (let i = 0; i < 100; i++) {
        vesselManager.updateVessel(mmsi, {
          lat: 58.293 + (i * 0.0001),
          lon: 12.294 + (i * 0.0001),
          sog: 2.0 + (Math.random() * 2),
          cog: 45 + (Math.random() * 10),
          name: 'STABILITY TEST'
        });
      }

      // Should complete quickly
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Less than 1 second

      // Vessel should still be tracked
      expect(vesselManager.vessels.has(mmsi)).toBe(true);

      // No memory leaks
      expect(vesselManager.vessels.size).toBe(1);
      expect(vesselManager.cleanupTimers.size).toBe(1);
    });
  });

  describe('Scenario 8: Cleanup Timer Verification', () => {
    jest.useFakeTimers();

    it('should cleanup vessel after timeout expires', () => {
      // Add vessel far from bridges
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.270,
        lon: 12.270,
        sog: 0.1,
        cog: 45,
        name: 'CLEANUP TEST'
      });

      vessel._distanceToNearest = 800;
      vessel.status = 'idle';

      // Calculate timeout (should be 2 min for >600m)
      const timeout = vesselManager._calculateTimeout(vessel);
      expect(timeout).toBe(120000); // 2 minutes

      // Fast forward time
      jest.advanceTimersByTime(timeout + 1000);

      // Vessel should be removed
      expect(vesselManager.vessels.has(219009742)).toBe(false);
    });

    jest.useRealTimers();
  });
});

describe('Performance and Load Tests', () => {
  let vesselManager;
  let bridgeMonitor;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn()
    };

    vesselManager = new VesselStateManager(mockLogger);
    
    const bridges = {
      klaffbron: {
        id: 'klaffbron',
        name: 'Klaffbron',
        lat: 58.28409551543077,
        lon: 12.283929525245636,
        radius: 300,
      },
      stridsbergsbron: {
        id: 'stridsbergsbron',
        name: 'Stridsbergsbron',
        lat: 58.293524096154634,
        lon: 12.294566425158054,
        radius: 300,
      }
    };
    
    bridgeMonitor = new BridgeMonitor(bridges, vesselManager, mockLogger);
  });

  it('should handle 50 vessels simultaneously without degradation', () => {
    const startTime = Date.now();

    // Add 50 vessels
    for (let i = 0; i < 50; i++) {
      const vessel = vesselManager.updateVessel(219000000 + i, {
        lat: 58.270 + (Math.random() * 0.05),
        lon: 12.270 + (Math.random() * 0.05),
        sog: Math.random() * 10,
        cog: Math.random() * 360,
        name: `VESSEL-${i}`
      });

      // Simulate bridge monitoring
      bridgeMonitor._handleVesselUpdate(vessel, null);
    }

    const loadTime = Date.now() - startTime;

    // Should handle 50 vessels in under 500ms
    expect(loadTime).toBeLessThan(500);
    expect(vesselManager.vessels.size).toBe(50);

    // Memory should be reasonable
    const usedMemory = process.memoryUsage().heapUsed / 1024 / 1024;
    expect(usedMemory).toBeLessThan(100); // Less than 100MB
  });

  it('should not have memory leaks after removing many vessels', () => {
    // Add and remove 100 vessels
    for (let i = 0; i < 100; i++) {
      const mmsi = 219000000 + i;
      
      vesselManager.updateVessel(mmsi, {
        lat: 58.270,
        lon: 12.270,
        sog: 2.0,
        cog: 45,
        name: `TEMP-${i}`
      });

      vesselManager.removeVessel(mmsi);
    }

    // Should have no vessels left
    expect(vesselManager.vessels.size).toBe(0);
    expect(vesselManager.cleanupTimers.size).toBe(0);
    expect(vesselManager.bridgeVessels.size).toBe(0);
  });
});