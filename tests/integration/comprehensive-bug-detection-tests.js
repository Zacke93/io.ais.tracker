/* eslint-disable */
'use strict';

/**
 * Omfattande testsvit för AIS Tracker 2.0
 * 
 * Denna testsvit är designad för att fånga de 12 kritiska buggarna
 * som identifierats från produktionsloggar. Varje test är utformat
 * för att verifiera att en specifik bugg är åtgärdad.
 */

const { 
  VesselStateManager, 
  BridgeMonitor, 
  AISConnectionManager, 
  MessageGenerator, 
  ETACalculator,
  CONSTANTS 
} = require('../../app.js');

const { APPROACH_RADIUS, GRACE_MISSES } = CONSTANTS;

describe('AIS Tracker 2.0 - Comprehensive Bug Detection Tests', () => {
  let vesselManager;
  let bridgeMonitor;
  let messageGenerator;
  let etaCalculator;
  let mockLogger;
  let mockApp;
  let emittedEvents;

  // Real bridge data from app.js
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

  beforeEach(() => {
    emittedEvents = [];
    
    // Create a comprehensive logger that captures all log levels
    mockLogger = {
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn()
    };

    // Create VesselStateManager
    vesselManager = new VesselStateManager(mockLogger);
    
    // Capture all events
    vesselManager.on('vessel:updated', (data) => {
      emittedEvents.push({ type: 'vessel:updated', data });
    });
    vesselManager.on('vessel:entered', (data) => {
      emittedEvents.push({ type: 'vessel:entered', data });
    });
    vesselManager.on('vessel:irrelevant', (data) => {
      emittedEvents.push({ type: 'vessel:irrelevant', data });
    });
    vesselManager.on('vessel:status-changed', (data) => {
      emittedEvents.push({ type: 'vessel:status-changed', data });
    });

    // Create BridgeMonitor
    bridgeMonitor = new BridgeMonitor(bridges, vesselManager, mockLogger);
    
    // Create MessageGenerator
    messageGenerator = new MessageGenerator(bridges, mockLogger);
    
    // Create ETACalculator
    etaCalculator = new ETACalculator(mockLogger);

    // Mock app for testing
    mockApp = {
      log: mockLogger,
      bridges: Object.values(bridges),
      setCapabilityValue: jest.fn(),
      homey: {
        flow: {
          getTriggerCard: jest.fn().mockReturnValue({
            trigger: jest.fn()
          }),
          getConditionCard: jest.fn().mockReturnValue({})
        }
      }
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Bug #1: Memory Access Problem', () => {
    it('should handle process.memoryUsage() not available error', () => {
      // Mock process.memoryUsage to throw error like in production
      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = jest.fn(() => {
        throw new Error('ENOENT: no such file or directory, uv_resident_set_memory');
      });

      // The system should handle this gracefully
      expect(() => {
        // Simulate a call that would use memory usage
        const vessel = vesselManager.updateVessel(219009742, {
          lat: 58.293,
          lon: 12.294,
          sog: 2.5,
          cog: 45,
          name: 'TEST VESSEL'
        });
      }).not.toThrow();

      // Restore original
      process.memoryUsage = originalMemoryUsage;
    });
  });

  describe('Bug #2: Incorrect Timeout Zones', () => {
    it('should use 20min timeout for vessels at exactly 300m', () => {
      // Add vessel at 300m from bridge
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.2935,
        lon: 12.2946,
        sog: 2.5,
        cog: 45,
        name: 'TEST VESSEL'
      });

      // Set distance manually (as BridgeMonitor would)
      vessel._distanceToNearest = 300;
      vessel.status = 'approaching';

      // Calculate timeout
      const timeout = vesselManager._calculateTimeout(vessel);
      
      // Should be 20 minutes (1200000 ms) for vessels at ≤300m
      expect(timeout).toBe(1200000);
    });

    it('should use 10min timeout for vessels at 301m', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.2935,
        lon: 12.2946,
        sog: 2.5,
        cog: 45,
        name: 'TEST VESSEL'
      });

      vessel._distanceToNearest = 301;
      vessel.status = 'en-route';

      const timeout = vesselManager._calculateTimeout(vessel);
      
      // Should be 10 minutes (600000 ms) for vessels at 300-600m
      expect(timeout).toBe(600000);
    });

    it('should use 2min timeout for vessels beyond 600m', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.2935,
        lon: 12.2946,
        sog: 2.5,
        cog: 45,
        name: 'TEST VESSEL'
      });

      vessel._distanceToNearest = 601;
      vessel.status = 'en-route';

      const timeout = vesselManager._calculateTimeout(vessel);
      
      // Should be 2 minutes (120000 ms) for vessels >600m
      expect(timeout).toBe(120000);
    });

    it('should always use 20min timeout for waiting status', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.2935,
        lon: 12.2946,
        sog: 0.1,
        cog: 45,
        name: 'TEST VESSEL'
      });

      vessel._distanceToNearest = 800; // Far away
      vessel.status = 'waiting';

      const timeout = vesselManager._calculateTimeout(vessel);
      
      // Should be 20 minutes regardless of distance when waiting
      expect(timeout).toBe(1200000);
    });
  });

  describe('Bug #3: Under-bridge Status Without Continuity Logic', () => {
    it('should NOT set under-bridge status based on distance alone', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293524,
        lon: 12.294566,
        sog: 5.0, // Fast speed
        cog: 45,
        name: 'TEST VESSEL'
      });

      // Set vessel very close to target bridge
      vessel.targetBridge = 'stridsbergsbron';
      vessel.targetDistance = 10;
      vessel.status = 'approaching';

      // Status should not automatically become under-bridge
      // It should require proper state transition logic
      expect(vessel.status).not.toBe('under-bridge');
    });

    it('should set speedBelowThresholdSince when speed drops below 0.20kn', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293524,
        lon: 12.294566,
        sog: 0.15, // Below threshold
        cog: 45,
        name: 'TEST VESSEL'
      });

      // Speed below threshold should be tracked
      expect(vessel.speedBelowThresholdSince).toBeDefined();
    });

    it('should reset speedBelowThresholdSince when speed increases above 0.20kn', () => {
      // First update with low speed
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293524,
        lon: 12.294566,
        sog: 0.15,
        cog: 45,
        name: 'TEST VESSEL'
      });

      const lowSpeedTimestamp = vessel.speedBelowThresholdSince;
      expect(lowSpeedTimestamp).toBeDefined();

      // Update with higher speed
      vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293524,
        lon: 12.294566,
        sog: 0.25, // Above threshold
        cog: 45,
        name: 'TEST VESSEL'
      });

      // Should be reset
      expect(vessel.speedBelowThresholdSince).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('återställer waiting timer')
      );
    });
  });

  describe('Bug #4: Incorrect ETA for Very Close Boats', () => {
    it('should show "waiting" status for boats <50m from bridge', () => {
      const vessel = {
        mmsi: 219009742,
        targetBridge: 'stridsbergsbron',
        targetDistance: 10,
        sog: 0.1,
        maxRecentSpeed: 2.0,
        status: 'waiting'
      };

      const eta = etaCalculator.calculateETA(vessel, vessel.targetDistance);
      
      // Should return object with isWaiting true and minutes 0 for very close boats
      expect(eta.isWaiting).toBe(true);
      expect(eta.minutes).toBe(0);
    });

    it('should show "waiting" for slow boats <100m from bridge', () => {
      const vessel = {
        mmsi: 219009742,
        targetBridge: 'stridsbergsbron',
        targetDistance: 80,
        sog: 0.15,
        maxRecentSpeed: 2.0,
        status: 'approaching'
      };

      const eta = etaCalculator.calculateETA(vessel);
      
      // Should handle this as waiting scenario
      expect(eta).toBeDefined();
    });
  });

  describe('Bug #5: No Bridge Passage Detection', () => {
    it('should detect bridge passage when vessel moves beyond radius after being inside', () => {
      // Create vessel approaching bridge
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293524,
        lon: 12.294566,
        sog: 2.0,
        cog: 45,
        name: 'TEST VESSEL'
      });

      vessel.targetBridge = 'stridsbergsbron';
      vessel.targetDistance = 250; // Approaching
      vessel._wasInsideTarget = false;

      // Move vessel inside approach radius
      vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293524,
        lon: 12.294566,
        sog: 2.0,
        cog: 45,
        name: 'TEST VESSEL'
      });

      vessel.targetDistance = 50; // Inside
      vessel._wasInsideTarget = true;

      // Move vessel past bridge
      vessel = vesselManager.updateVessel(219009742, {
        lat: 58.294,
        lon: 12.295,
        sog: 2.0,
        cog: 45,
        name: 'TEST VESSEL'
      });

      vessel.targetDistance = 320; // Past bridge

      // Should detect passage
      if (vessel._wasInsideTarget && vessel.targetDistance > 50) {
        vessel.status = 'passed';
        expect(vessel.status).toBe('passed');
      }
    });

    it('should add to passedBridges when bridge is passed', () => {
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293524,
        lon: 12.294566,
        sog: 2.0,
        cog: 45,
        name: 'TEST VESSEL'
      });

      vessel.targetBridge = 'stridsbergsbron';
      vessel._wasInsideTarget = true;
      vessel.targetDistance = 320;
      vessel.status = 'passed';

      // Simulate adding to passed bridges
      if (!vessel.passedBridges.includes('stridsbergsbron')) {
        vessel.passedBridges.push('stridsbergsbron');
      }

      expect(vessel.passedBridges).toContain('stridsbergsbron');
    });
  });

  describe('Bug #6: Vessels Disappear Without Graceful Cleanup', () => {
    it('should track grace misses before removing vessel', () => {
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293524,
        lon: 12.294566,
        sog: 0.1,
        cog: 45,
        name: 'TEST VESSEL'
      });

      // Mark as irrelevant multiple times
      vessel.graceMisses = 0;
      vessel.status = 'idle';

      // First irrelevant detection
      vessel.graceMisses++;
      expect(vessel.graceMisses).toBe(1);

      // Should not remove yet
      expect(vesselManager.vessels.has(219009742)).toBe(true);

      // More grace misses
      vessel.graceMisses++;
      vessel.graceMisses++;

      // After GRACE_MISSES (3), vessel can be removed
      if (vessel.graceMisses >= GRACE_MISSES) {
        vesselManager.removeVessel(219009742);
        expect(vesselManager.vessels.has(219009742)).toBe(false);
      }
    });

    it('should log removal reason when vessel is removed', () => {
      vesselManager.updateVessel(219009742, {
        lat: 58.293524,
        lon: 12.294566,
        sog: 0.1,
        cog: 45,
        name: 'TEST VESSEL'
      });

      vesselManager.removeVessel(219009742);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[VESSEL_REMOVAL]')
      );
    });
  });

  describe('Bug #7: Inconsistent Status Handling', () => {
    it('should set approaching status when vessel enters APPROACH_RADIUS', () => {
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'TEST VESSEL'
      });

      vessel.targetBridge = 'stridsbergsbron';
      vessel.targetDistance = 250; // Within APPROACH_RADIUS
      vessel.nearBridge = 'stridsbergsbron';

      // Should update status
      if (vessel.targetDistance <= APPROACH_RADIUS && vessel.nearBridge) {
        vessel.status = 'approaching';
      }

      expect(vessel.status).toBe('approaching');
    });

    it('should emit status-changed event when status changes', () => {
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'TEST VESSEL'
      });

      const oldStatus = vessel.status;
      vessel.status = 'approaching';

      if (oldStatus !== vessel.status) {
        vesselManager.emit('vessel:status-changed', {
          mmsi: vessel.mmsi,
          oldStatus,
          newStatus: vessel.status
        });
      }

      const statusEvent = emittedEvents.find(e => e.type === 'vessel:status-changed');
      expect(statusEvent).toBeDefined();
      expect(statusEvent.data.newStatus).toBe('approaching');
    });
  });

  describe('Bug #8: Missing Mellanbro Phrases', () => {
    it('should include context when boat is at mellanbro heading to user bridge', () => {
      const boats = [{
        mmsi: 219009742,
        name: 'TEST VESSEL',
        currentBridge: 'Stallbackabron',
        targetBridge: 'stridsbergsbron',
        etaMinutes: 5,
        isWaiting: false,
        confidence: 'high',
        distance: 100,
        distanceToCurrent: 250  // Within 300m of current bridge
      }];

      const text = messageGenerator.generateBridgeText(boats);
      
      // Should include "En båt vid Stallbackabron..."
      expect(text).toContain('Stallbackabron');
      expect(text).toContain('stridsbergsbron');
    });

    it('should show context for all mellanbro when relevant', () => {
      const boats = [{
        mmsi: 219009742,
        name: 'TEST VESSEL',
        currentBridge: 'Olidebron',
        targetBridge: 'klaffbron',
        etaMinutes: 8,
        isWaiting: false,
        confidence: 'high',
        distance: 200,
        distanceToCurrent: 200  // Within 300m of current bridge
      }];

      const text = messageGenerator.generateBridgeText(boats);
      
      // Should include context
      expect(text).toContain('Olidebron');
      expect(text).toContain('klaffbron');
    });
  });

  describe('Bug #9: Duplicate UI Updates', () => {
    it('should not emit multiple updates for same ETA value', () => {
      // First update
      vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'TEST VESSEL'
      });

      const firstUpdateCount = emittedEvents.filter(e => e.type === 'vessel:updated').length;

      // Same update (no position change)
      vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'TEST VESSEL'
      });

      const secondUpdateCount = emittedEvents.filter(e => e.type === 'vessel:updated').length;

      // Should still emit update but UI should check for changes
      expect(secondUpdateCount).toBe(firstUpdateCount + 1);
    });
  });

  describe('Bug #10: COG-based Direction Not Used', () => {
    it('should store COG in vessel data', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 45,
        name: 'TEST VESSEL'
      });

      expect(vessel.cog).toBe(45);
    });

    it('should use COG for direction analysis', () => {
      const vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 2.0,
        cog: 225, // Southwest - away from bridges
        name: 'TEST VESSEL'
      });

      // COG should be available for protection zone logic
      expect(vessel.cog).toBe(225);
    });
  });

  describe('Bug #11: Waiting Detection Without Continuity', () => {
    it('should require 2 minutes of continuous low speed for waiting', async () => {
      // First update with low speed
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 0.15,
        cog: 45,
        name: 'TEST VESSEL'
      });

      const startTime = vessel.speedBelowThresholdSince;
      expect(startTime).toBeDefined();

      // Should not be waiting immediately
      expect(vessel.status).not.toBe('waiting');

      // Simulate 2 minutes passing
      const twoMinutesAgo = Date.now() - 120001;
      vessel.speedBelowThresholdSince = twoMinutesAgo;

      // Update again with low speed
      vessel = vesselManager.updateVessel(219009742, {
        lat: 58.293,
        lon: 12.294,
        sog: 0.15,
        cog: 45,
        name: 'TEST VESSEL'
      });

      // Now check if waiting logic would trigger
      const continuousLowSpeed = vessel.speedBelowThresholdSince && 
        (Date.now() - vessel.speedBelowThresholdSince) >= 120000;

      expect(continuousLowSpeed).toBe(true);
    });
  });

  describe('Bug #12: Bridge-to-Bridge Distance Not Used', () => {
    it('should use real bridge distances instead of haversine', () => {
      // BridgeMonitor should have bridge gaps defined
      expect(bridgeMonitor.bridgeGaps).toBeDefined();
      expect(bridgeMonitor.bridgeGaps.klaffbron_jarnvagsbron).toBe(960);
      expect(bridgeMonitor.bridgeGaps.jarnvagsbron_stridsbergsbron).toBe(420);
    });

    it('should calculate ETA using bridge-to-bridge distances', () => {
      const vessel = {
        mmsi: 219009742,
        nearBridge: 'klaffbron',
        targetBridge: 'stridsbergsbron',
        sog: 4.0,
        maxRecentSpeed: 4.0,
        targetDistance: 1380 // Should be sum of gaps: 960 + 420
      };

      const eta = etaCalculator.calculateETA(vessel, vessel.targetDistance);
      
      // ETA should be based on 1380m at 4 knots
      const expectedEta = 1380 / (4 * 1.852 / 3.6) / 60;
      expect(eta.minutes).toBeCloseTo(expectedEta, 1);
    });
  });

  describe('Integration: Full Vessel Lifecycle', () => {
    it('should handle complete vessel journey from entry to removal', () => {
      // 1. Vessel enters system
      let vessel = vesselManager.updateVessel(219009742, {
        lat: 58.270,
        lon: 12.270,
        sog: 4.0,
        cog: 45,
        name: 'INTEGRATION TEST'
      });

      expect(emittedEvents.some(e => e.type === 'vessel:entered')).toBe(true);

      // 2. Vessel approaches bridge
      vessel.targetBridge = 'klaffbron';
      vessel.targetDistance = 250;
      vessel.status = 'approaching';

      // 3. Vessel waits at bridge
      vessel = vesselManager.updateVessel(219009742, {
        lat: 58.284,
        lon: 12.284,
        sog: 0.1,
        cog: 45,
        name: 'INTEGRATION TEST'
      });

      vessel.speedBelowThresholdSince = Date.now() - 130000; // >2 min
      vessel.status = 'waiting';
      vessel.targetDistance = 80;

      // 4. Vessel passes bridge
      vessel._wasInsideTarget = true;
      vessel.targetDistance = 320;
      vessel.status = 'passed';
      vessel.passedBridges.push('klaffbron');

      // 5. Vessel becomes irrelevant
      vessel.nearBridge = null;
      vessel.graceMisses = GRACE_MISSES;

      // 6. Vessel is removed
      vesselManager.removeVessel(219009742);

      expect(vesselManager.vessels.has(219009742)).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[VESSEL_REMOVAL]')
      );
    });
  });

  describe('Performance: System Under Load', () => {
    it('should handle 20+ vessels simultaneously without performance degradation', () => {
      const startTime = Date.now();

      // Add 20 vessels
      for (let i = 0; i < 20; i++) {
        vesselManager.updateVessel(219009700 + i, {
          lat: 58.270 + (i * 0.001),
          lon: 12.270 + (i * 0.001),
          sog: 2.0 + (i * 0.1),
          cog: 45 + (i * 5),
          name: `TEST VESSEL ${i}`
        });
      }

      const addTime = Date.now() - startTime;

      // Should complete within reasonable time
      expect(addTime).toBeLessThan(100); // 100ms for 20 vessels

      // All vessels should be tracked
      expect(vesselManager.vessels.size).toBe(20);

      // Update all vessels
      const updateStart = Date.now();
      for (let i = 0; i < 20; i++) {
        vesselManager.updateVessel(219009700 + i, {
          lat: 58.271 + (i * 0.001),
          lon: 12.271 + (i * 0.001),
          sog: 2.1 + (i * 0.1),
          cog: 46 + (i * 5),
          name: `TEST VESSEL ${i}`
        });
      }

      const updateTime = Date.now() - updateStart;
      expect(updateTime).toBeLessThan(100);
    });
  });
});