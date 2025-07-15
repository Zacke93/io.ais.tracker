/* eslint-disable */
'use strict';

const { VesselStateManager, BridgeMonitor, MessageGenerator, TextFlowManager } = require('../../app.js');

// Test cases based on real AIS logs from 2025-07-14
describe('Real AIS Log Tests - Actual Bugs from Production', () => {
  let vesselManager;
  let bridgeMonitor;
  let messageGenerator;
  let textFlowManager;
  let mockLogger;
  let mockApp;
  let events = [];

  beforeEach(() => {
    mockLogger = {
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    mockApp = {
      log: mockLogger,
      bridges: [
        { id: 'olidebron', name: 'Olidebron', lat: 58.28616, lon: 12.29281 },
        { id: 'klaffbron', name: 'Klaffbron', lat: 58.29052, lon: 12.29434 },
        { id: 'jarnvagsbron', name: 'Järnvägsbron', lat: 58.29147, lon: 12.29467 },
        { id: 'stridsbergsbron', name: 'Stridsbergsbron', lat: 58.29475, lon: 12.29691 },
        { id: 'stallbackabron', name: 'Stallbackabron', lat: 58.29783, lon: 12.30113 }
      ],
      userBridges: ['klaffbron', 'stridsbergsbron'],
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

    events = [];

    vesselManager = new VesselStateManager(mockLogger);
    bridgeMonitor = new BridgeMonitor(mockLogger, mockApp.bridges);
    messageGenerator = new MessageGenerator(mockLogger, mockApp);
    textFlowManager = new TextFlowManager(mockLogger, mockApp);

    // Connect components
    vesselManager.on('vessel:updated', ({ mmsi, data }) => {
      events.push({ type: 'vessel:updated', mmsi, data });
      bridgeMonitor.updateVesselPosition(mmsi, data);
    });

    vesselManager.on('vessel:removed', ({ mmsi }) => {
      events.push({ type: 'vessel:removed', mmsi });
      bridgeMonitor.removeVessel(mmsi);
    });

    vesselManager.on('vessel:status-changed', (data) => {
      events.push({ type: 'vessel:status-changed', ...data });
    });

    bridgeMonitor.on('bridge:approaching', (data) => {
      events.push({ type: 'bridge:approaching', ...data });
    });
  });

  describe('BUG: ELFKUNGEN at Stridsbergsbron (from app-20250714-142054.log)', () => {
    it('should correctly calculate ETA and generate proper message format', async () => {
      const mmsi = '265573130';
      
      // Real position from log: 183m from Stridsbergsbron, speed 0.3kn
      vesselManager.updateVessel(mmsi, {
        lat: 58.294682,
        lon: 12.296782,
        sog: 0.3,
        cog: 221.8,
        name: 'ELFKUNGEN'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const vessel = vesselManager.vessels.get(mmsi);
      
      // Verify target bridge is set correctly
      expect(vessel.targetBridge).toBe('Stridsbergsbron');
      expect(vessel.nearBridge).toBe('stridsbergsbron');
      
      // Verify ETA calculation (should use min speed 0.5kn at <200m)
      expect(vessel.etaMinutes).toBeDefined();
      expect(vessel.etaMinutes).toBeLessThan(20); // Should be ~12 min, not 20
      
      // Test message generation
      const boats = [{
        mmsi: vessel.mmsi,
        currentBridge: 'Stridsbergsbron',
        targetBridge: vessel.targetBridge,
        etaMinutes: vessel.etaMinutes,
        status: vessel.status,
        waiting: false
      }];
      
      const message = messageGenerator.generateBridgeText(boats);
      
      // Should NOT show "okänd tid" when we have an ETA
      expect(message).not.toContain('okänd tid');
      expect(message).toMatch(/beräknad (öppning|broöppning) om \d+ minuter/);
    });

    it('should handle position updates with changing distance correctly', async () => {
      const mmsi = '265573130';
      jest.useFakeTimers();
      
      // First position: 183m from bridge
      vesselManager.updateVessel(mmsi, {
        lat: 58.294682,
        lon: 12.296782,
        sog: 0.3,
        cog: 221.8,
        name: 'ELFKUNGEN'
      });

      await Promise.resolve();
      
      const vessel1 = vesselManager.vessels.get(mmsi);
      const firstDistance = bridgeMonitor._calculateDistance(
        vessel1.lat, vessel1.lon,
        58.29475, 12.29691 // Stridsbergsbron
      );
      
      // Simulate 30 seconds later - boat closer
      jest.advanceTimersByTime(30000);
      
      vesselManager.updateVessel(mmsi, {
        lat: 58.29470, // Slightly closer
        lon: 12.29678,
        sog: 0.3,
        cog: 221.8,
        name: 'ELFKUNGEN'
      });

      await Promise.resolve();
      
      const vessel2 = vesselManager.vessels.get(mmsi);
      const secondDistance = bridgeMonitor._calculateDistance(
        vessel2.lat, vessel2.lon,
        58.29475, 12.29691
      );
      
      // Verify boat is getting closer
      expect(secondDistance).toBeLessThan(firstDistance);
      
      // Verify ETA is updating
      expect(vessel2.etaMinutes).toBeLessThan(vessel1.etaMinutes);
      
      jest.useRealTimers();
    });
  });

  describe('BUG: Multiple boats scenario with waiting detection', () => {
    it('should handle multiple boats with different states correctly', async () => {
      jest.useFakeTimers();
      
      // Boat 1: Approaching normally
      vesselManager.updateVessel('111111111', {
        lat: 58.29475 - 0.0027, // ~300m south
        lon: 12.29691,
        sog: 3.0,
        cog: 0,
        name: 'APPROACHING_BOAT'
      });

      // Boat 2: Waiting at bridge (low speed)
      vesselManager.updateVessel('222222222', {
        lat: 58.29475 - 0.0009, // ~100m south
        lon: 12.29691,
        sog: 0.1,
        cog: 0,
        name: 'WAITING_BOAT'
      });

      await Promise.resolve();

      // Fast forward 2+ minutes for waiting detection
      jest.advanceTimersByTime(130000);

      // Update positions with same speeds
      vesselManager.updateVessel('111111111', {
        lat: 58.29475 - 0.0018, // Closer
        lon: 12.29691,
        sog: 3.0,
        cog: 0,
        name: 'APPROACHING_BOAT'
      });

      vesselManager.updateVessel('222222222', {
        lat: 58.29475 - 0.0009, // Same position
        lon: 12.29691,
        sog: 0.1,
        cog: 0,
        name: 'WAITING_BOAT'
      });

      await Promise.resolve();

      const boat1 = vesselManager.vessels.get('111111111');
      const boat2 = vesselManager.vessels.get('222222222');

      // Verify different states
      expect(boat1.status).toBe('approaching');
      expect(boat2.status).toBe('waiting');

      // Generate message for both boats
      const boats = [
        {
          mmsi: boat1.mmsi,
          targetBridge: 'Stridsbergsbron',
          etaMinutes: boat1.etaMinutes,
          status: boat1.status,
          waiting: false
        },
        {
          mmsi: boat2.mmsi,
          targetBridge: 'Stridsbergsbron',
          status: boat2.status,
          waiting: true
        }
      ];

      const message = messageGenerator.generateBridgeText(boats);
      
      // Should show both waiting and approaching boats
      expect(message).toContain('väntar');
      expect(message).toContain('ytterligare');

      jest.useRealTimers();
    });
  });

  describe('BUG: Signal loss and recovery', () => {
    it('should handle signal loss within timeout zones correctly', async () => {
      const mmsi = '333333333';
      jest.useFakeTimers();

      // Position within 300m (Brozon - 20 min timeout)
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0018, // ~200m from bridge
        lon: 12.29691,
        sog: 2.0,
        cog: 0,
        name: 'SIGNAL_TEST'
      });

      await Promise.resolve();

      const vessel1 = vesselManager.vessels.get(mmsi);
      expect(vessel1).toBeDefined();
      expect(vessel1._distanceToNearest).toBeLessThanOrEqual(300);

      // Simulate 15 minutes without updates (within 20 min timeout)
      jest.advanceTimersByTime(15 * 60 * 1000);

      // Vessel should still exist
      expect(vesselManager.vessels.has(mmsi)).toBe(true);

      // Update after 15 minutes
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0009, // Moved closer
        lon: 12.29691,
        sog: 1.0,
        cog: 0,
        name: 'SIGNAL_TEST'
      });

      await Promise.resolve();

      const vessel2 = vesselManager.vessels.get(mmsi);
      expect(vessel2).toBeDefined();
      expect(vessel2.timestamp).toBeGreaterThan(vessel1.timestamp);

      jest.useRealTimers();
    });

    it('should remove vessel after timeout expires', async () => {
      const mmsi = '444444444';
      jest.useFakeTimers();

      // Position in När-zon (300-600m, 10 min timeout)
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0045, // ~500m from bridge
        lon: 12.29691,
        sog: 2.0,
        cog: 0,
        name: 'TIMEOUT_TEST'
      });

      await Promise.resolve();

      const vessel = vesselManager.vessels.get(mmsi);
      expect(vessel._distanceToNearest).toBeGreaterThan(300);
      expect(vessel._distanceToNearest).toBeLessThanOrEqual(600);

      // Advance past 10 minute timeout
      jest.advanceTimersByTime(11 * 60 * 1000);

      // Vessel should be removed
      expect(vesselManager.vessels.has(mmsi)).toBe(false);
      expect(events.some(e => e.type === 'vessel:removed' && e.mmsi === mmsi)).toBe(true);

      jest.useRealTimers();
    });
  });

  describe('BUG: Bridge sequence navigation', () => {
    it('should predict next bridge correctly after passage', async () => {
      const mmsi = '555555555';

      // Start south of Klaffbron, heading north
      vesselManager.updateVessel(mmsi, {
        lat: 58.29052 - 0.0018, // ~200m south of Klaffbron
        lon: 12.29434,
        sog: 4.0,
        cog: 0,
        name: 'SEQUENCE_TEST'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const vessel1 = vesselManager.vessels.get(mmsi);
      expect(vessel1.targetBridge).toBe('Klaffbron');

      // Move to within APPROACH_RADIUS
      vesselManager.updateVessel(mmsi, {
        lat: 58.29052 - 0.0009, // ~100m south
        lon: 12.29434,
        sog: 4.0,
        cog: 0,
        name: 'SEQUENCE_TEST'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const vessel2 = vesselManager.vessels.get(mmsi);
      expect(vessel2._wasInsideTarget).toBe(true);

      // Pass Klaffbron (>50m past)
      vesselManager.updateVessel(mmsi, {
        lat: 58.29052 + 0.00054, // ~60m north
        lon: 12.29434,
        sog: 4.0,
        cog: 0,
        name: 'SEQUENCE_TEST'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const vessel3 = vesselManager.vessels.get(mmsi);
      expect(vessel3.status).toBe('passed');
      
      // Should predict Stridsbergsbron as next target
      expect(vessel3.targetBridge).toBe('Stridsbergsbron');
      
      // Verify passed bridges list
      expect(vessel3.passedBridges).toContain('klaffbron');
    });
  });

  describe('Real-time sequence from logs', () => {
    it('should handle the complete ELFKUNGEN journey correctly', async () => {
      const mmsi = '265573130';
      jest.useFakeTimers();

      // Sequence from actual log file
      const positions = [
        { time: 0, lat: 58.294682, lon: 12.296782, sog: 0.3, cog: 221.8 }, // 183m from Stridsbergsbron
        { time: 119, lat: 58.294652, lon: 12.296772, sog: 0.3, cog: 221.5 }, // Getting closer
        { time: 239, lat: 58.294612, lon: 12.296775, sog: 0.4, cog: 222.3 }, // Still approaching
        { time: 479, lat: 58.294567, lon: 12.296768, sog: 0.4, cog: 240.1 }, // Very close now
        { time: 838, lat: 58.294517, lon: 12.296688, sog: 0.5, cog: 231.3 }  // At bridge
      ];

      let lastEta = null;
      let statusChanges = [];

      for (const pos of positions) {
        jest.advanceTimersByTime(pos.time * 1000);
        
        vesselManager.updateVessel(mmsi, {
          lat: pos.lat,
          lon: pos.lon,
          sog: pos.sog,
          cog: pos.cog,
          name: 'ELFKUNGEN'
        });

        await Promise.resolve();

        const vessel = vesselManager.vessels.get(mmsi);
        
        // Track ETA changes
        if (vessel.etaMinutes !== lastEta) {
          lastEta = vessel.etaMinutes;
        }

        // Track status changes
        const statusEvent = events.find(e => 
          e.type === 'vessel:status-changed' && 
          e.mmsi === mmsi &&
          !statusChanges.includes(e.status)
        );
        
        if (statusEvent) {
          statusChanges.push(statusEvent.status);
        }
      }

      // Verify vessel progressed correctly
      const finalVessel = vesselManager.vessels.get(mmsi);
      const finalDistance = bridgeMonitor._calculateDistance(
        finalVessel.lat, finalVessel.lon,
        58.29475, 12.29691 // Stridsbergsbron
      );

      expect(finalDistance).toBeLessThan(50); // Should be very close to bridge
      expect(finalVessel.status).toBe('under-bridge'); // Should detect under-bridge status
      expect(finalVessel.etaMinutes).toBe(0); // ETA should be 0 when under bridge

      jest.useRealTimers();
    });
  });
});