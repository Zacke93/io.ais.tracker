/* eslint-disable */
'use strict';

const { VesselStateManager, BridgeMonitor, MessageGenerator, TextFlowManager } = require('../../app.js');

// Real constants from kravspec
const APPROACH_RADIUS = 300;
const GRACE_MISSES = 3;

describe('Kravspec v2.3 - Real Code Tests', () => {
  let vesselManager;
  let bridgeMonitor;
  let messageGenerator;
  let textFlowManager;
  let mockLogger;
  let mockApp;
  let events = [];

  beforeEach(() => {
    // Create minimal logger
    mockLogger = {
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    // Create minimal app mock with event tracking
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

    // Create real instances
    vesselManager = new VesselStateManager(mockLogger);
    bridgeMonitor = new BridgeMonitor(mockLogger, mockApp.bridges);
    messageGenerator = new MessageGenerator(mockLogger, mockApp);
    textFlowManager = new TextFlowManager(mockLogger, mockApp);

    // Connect event listeners
    vesselManager.on('vessel:updated', ({ mmsi, data }) => {
      events.push({ type: 'vessel:updated', mmsi, data });
      bridgeMonitor.updateVesselPosition(mmsi, data);
    });

    vesselManager.on('vessel:removed', ({ mmsi }) => {
      events.push({ type: 'vessel:removed', mmsi });
      bridgeMonitor.removeVessel(mmsi);
    });

    vesselManager.on('vessel:irrelevant', ({ mmsi }) => {
      events.push({ type: 'vessel:irrelevant', mmsi });
    });

    bridgeMonitor.on('bridge:approaching', (data) => {
      events.push({ type: 'bridge:approaching', ...data });
    });

    bridgeMonitor.on('bridge:leaving', (data) => {
      events.push({ type: 'bridge:leaving', ...data });
    });

    vesselManager.on('vessel:status-changed', (data) => {
      events.push({ type: 'vessel:status-changed', ...data });
    });
  });

  describe('§5. Bridge Passage & Target-skifte', () => {
    it('should detect passage when vessel moves >50m after being inside APPROACH_RADIUS', async () => {
      const mmsi = '265573130';
      
      // Position 1: 100m from Stridsbergsbron (inside APPROACH_RADIUS)
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0009, // ~100m south
        lon: 12.29691,
        sog: 5.0,
        cog: 0,
        name: 'ELFKUNGEN'
      });

      // Wait for events to process
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify vessel is approaching
      const vessel1 = vesselManager.vessels.get(mmsi);
      expect(vessel1.nearBridge).toBe('stridsbergsbron');
      expect(vessel1._wasInsideTarget).toBe(true);

      // Position 2: 60m past Stridsbergsbron (>50m from target)
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 + 0.00054, // ~60m north
        lon: 12.29691,
        sog: 5.0,
        cog: 0,
        name: 'ELFKUNGEN'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify passage detection
      const vessel2 = vesselManager.vessels.get(mmsi);
      expect(vessel2.status).toBe('passed');
      expect(events.some(e => e.type === 'vessel:status-changed' && e.status === 'passed')).toBe(true);
    });

    it('should not detect passage if vessel was never inside APPROACH_RADIUS', async () => {
      const mmsi = '265573131';
      
      // Position 1: 350m from bridge (outside APPROACH_RADIUS)
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.00315, // ~350m south
        lon: 12.29691,
        sog: 5.0,
        cog: 0,
        name: 'TEST_VESSEL'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Position 2: 400m past bridge
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 + 0.0036, // ~400m north
        lon: 12.29691,
        sog: 5.0,
        cog: 0,
        name: 'TEST_VESSEL'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should NOT detect passage
      const vessel = vesselManager.vessels.get(mmsi);
      expect(vessel.status).not.toBe('passed');
      expect(vessel._wasInsideTarget).toBeFalsy();
    });
  });

  describe('§1. Hysteresis - 10% regel för nearBridge byte', () => {
    it('should only switch nearBridge if new bridge is ≥10% closer', async () => {
      const mmsi = '265573132';
      
      // Position between Klaffbron and Järnvägsbron
      // Klaffbron: 58.29052, 12.29434
      // Järnvägsbron: 58.29147, 12.29467
      // Place vessel 100m from Klaffbron, 95m from Järnvägsbron
      
      vesselManager.updateVessel(mmsi, {
        lat: 58.29052 + 0.0009, // ~100m north of Klaffbron
        lon: 12.29434,
        sog: 2.0,
        cog: 0,
        name: 'HYSTERESIS_TEST'
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      
      const vessel1 = vesselManager.vessels.get(mmsi);
      expect(vessel1.nearBridge).toBe('klaffbron');

      // Move slightly closer to Järnvägsbron (but not 10% closer)
      // Now 98m from Klaffbron, 92m from Järnvägsbron (only 6% closer)
      vesselManager.updateVessel(mmsi, {
        lat: 58.29052 + 0.00092,
        lon: 12.29434 + 0.00002,
        sog: 2.0,
        cog: 0,
        name: 'HYSTERESIS_TEST'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should NOT switch due to hysteresis
      const vessel2 = vesselManager.vessels.get(mmsi);
      expect(vessel2.nearBridge).toBe('klaffbron');

      // Move to make Järnvägsbron 15% closer
      // Now 105m from Klaffbron, 89m from Järnvägsbron
      vesselManager.updateVessel(mmsi, {
        lat: 58.29052 + 0.00098,
        lon: 12.29434 + 0.00015,
        sog: 2.0,
        cog: 0,
        name: 'HYSTERESIS_TEST'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should switch now
      const vessel3 = vesselManager.vessels.get(mmsi);
      expect(vessel3.nearBridge).toBe('jarnvagsbron');
    });
  });

  describe('§2.2b Waiting Status - 2 min kontinuitetslogik', () => {
    it('should require continuous low speed for 2 minutes to enter waiting status', async () => {
      const mmsi = '265573133';
      jest.useFakeTimers();

      // Position within 300m of bridge with low speed
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0018, // ~200m from Stridsbergsbron
        lon: 12.29691,
        sog: 0.15, // Below 0.20 kn
        cog: 0,
        name: 'WAITING_TEST'
      });

      await Promise.resolve();
      
      // Not waiting yet
      const vessel1 = vesselManager.vessels.get(mmsi);
      expect(vessel1.status).not.toBe('waiting');
      expect(vessel1.speedBelowThresholdSince).toBeTruthy();

      // Advance 90 seconds
      jest.advanceTimersByTime(90000);
      
      // Update position, still low speed
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0018,
        lon: 12.29691,
        sog: 0.10,
        cog: 0,
        name: 'WAITING_TEST'
      });

      await Promise.resolve();

      // Still not waiting (only 90 seconds)
      const vessel2 = vesselManager.vessels.get(mmsi);
      expect(vessel2.status).not.toBe('waiting');

      // Advance to 2+ minutes total
      jest.advanceTimersByTime(40000); // Total 130 seconds

      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0018,
        lon: 12.29691,
        sog: 0.15,
        cog: 0,
        name: 'WAITING_TEST'
      });

      await Promise.resolve();

      // Now should be waiting
      const vessel3 = vesselManager.vessels.get(mmsi);
      expect(vessel3.status).toBe('waiting');

      jest.useRealTimers();
    });

    it('should reset waiting timer if speed increases above 0.20 kn', async () => {
      const mmsi = '265573134';
      jest.useFakeTimers();

      // Start with low speed
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0018, // ~200m from bridge
        lon: 12.29691,
        sog: 0.15,
        cog: 0,
        name: 'WAITING_RESET'
      });

      await Promise.resolve();

      const vessel1 = vesselManager.vessels.get(mmsi);
      const firstTimestamp = vessel1.speedBelowThresholdSince;
      expect(firstTimestamp).toBeTruthy();

      // Advance 90 seconds
      jest.advanceTimersByTime(90000);

      // Speed increases above threshold
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0018,
        lon: 12.29691,
        sog: 0.25, // Above 0.20 kn
        cog: 0,
        name: 'WAITING_RESET'
      });

      await Promise.resolve();

      const vessel2 = vesselManager.vessels.get(mmsi);
      expect(vessel2.speedBelowThresholdSince).toBeNull();

      // Speed drops again
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0018,
        lon: 12.29691,
        sog: 0.10,
        cog: 0,
        name: 'WAITING_RESET'
      });

      await Promise.resolve();

      const vessel3 = vesselManager.vessels.get(mmsi);
      expect(vessel3.speedBelowThresholdSince).toBeGreaterThan(firstTimestamp);

      jest.useRealTimers();
    });
  });

  describe('§2.2c Under-bridge Status', () => {
    it('should set under-bridge status when <50m from targetBridge', async () => {
      const mmsi = '265573135';

      // First establish target bridge by being within APPROACH_RADIUS
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0018, // ~200m from Stridsbergsbron
        lon: 12.29691,
        sog: 2.0,
        cog: 0,
        name: 'UNDER_BRIDGE_TEST'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const vessel1 = vesselManager.vessels.get(mmsi);
      expect(vessel1.targetBridge).toBe('Stridsbergsbron');

      // Move to <50m from targetBridge
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.00036, // ~40m from Stridsbergsbron
        lon: 12.29691,
        sog: 1.0,
        cog: 0,
        name: 'UNDER_BRIDGE_TEST'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const vessel2 = vesselManager.vessels.get(mmsi);
      expect(vessel2.status).toBe('under-bridge');
      expect(vessel2.etaMinutes).toBe(0);

      // Verify status change event
      expect(events.some(e => 
        e.type === 'vessel:status-changed' && 
        e.status === 'under-bridge' &&
        e.mmsi === mmsi
      )).toBe(true);
    });
  });

  describe('§4.1 Timeout Zones', () => {
    it('should apply correct timeout based on distance zones', () => {
      jest.useFakeTimers();

      // Test Brozon (≤300m) - 20 min
      const vessel1 = { _distanceToNearest: 250, status: 'approaching' };
      const timeout1 = vesselManager._calculateTimeout(vessel1);
      expect(timeout1).toBe(20 * 60 * 1000);

      // Test När-zon (300-600m) - 10 min
      const vessel2 = { _distanceToNearest: 450, status: 'approaching' };
      const timeout2 = vesselManager._calculateTimeout(vessel2);
      expect(timeout2).toBe(10 * 60 * 1000);

      // Test Övrigt (>600m) - 2 min
      const vessel3 = { _distanceToNearest: 800, status: 'approaching' };
      const timeout3 = vesselManager._calculateTimeout(vessel3);
      expect(timeout3).toBe(2 * 60 * 1000);

      // Test waiting status - always 20 min
      const vessel4 = { _distanceToNearest: 800, status: 'waiting' };
      const timeout4 = vesselManager._calculateTimeout(vessel4);
      expect(timeout4).toBe(20 * 60 * 1000);

      jest.useRealTimers();
    });
  });

  describe('§4.2 GRACE_MISSES Logic', () => {
    it('should require 3 consecutive irrelevant detections before removal', async () => {
      const mmsi = '265573136';
      jest.useFakeTimers();

      // Position vessel >300m away with low speed
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0036, // ~400m from nearest bridge
        lon: 12.29691,
        sog: 0.1,
        cog: 0,
        name: 'GRACE_TEST'
      });

      await Promise.resolve();

      const vessel = vesselManager.vessels.get(mmsi);
      vessel.status = 'idle'; // Set idle status for grace misses to apply

      // First irrelevant detection (after 2+ minutes)
      jest.advanceTimersByTime(130000);
      vesselManager._checkIrrelevantVessels();
      await Promise.resolve();

      expect(vessel.graceMisses).toBe(1);
      expect(vesselManager.vessels.has(mmsi)).toBe(true);

      // Second irrelevant detection
      jest.advanceTimersByTime(130000);
      vesselManager._checkIrrelevantVessels();
      await Promise.resolve();

      expect(vessel.graceMisses).toBe(2);
      expect(vesselManager.vessels.has(mmsi)).toBe(true);

      // Third irrelevant detection - should remove
      jest.advanceTimersByTime(130000);
      vesselManager._checkIrrelevantVessels();
      await Promise.resolve();

      expect(vesselManager.vessels.has(mmsi)).toBe(false);
      expect(events.some(e => e.type === 'vessel:removed' && e.mmsi === mmsi)).toBe(true);

      jest.useRealTimers();
    });

    it('should only apply grace misses for idle or passed status', async () => {
      const mmsi = '265573137';
      jest.useFakeTimers();

      // Position vessel for irrelevant detection
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.0036, // ~400m away
        lon: 12.29691,
        sog: 0.1,
        cog: 0,
        name: 'GRACE_STATUS_TEST'
      });

      await Promise.resolve();

      const vessel = vesselManager.vessels.get(mmsi);
      vessel.status = 'approaching'; // Not idle or passed

      // Try irrelevant detection 3 times
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(130000);
        vesselManager._checkIrrelevantVessels();
        await Promise.resolve();
      }

      // Should still exist (grace misses don't apply to approaching status)
      expect(vesselManager.vessels.has(mmsi)).toBe(true);

      jest.useRealTimers();
    });
  });

  describe('Message Generation According to Kravspec', () => {
    it('should generate correct messages for all scenarios', async () => {
      // Test scenario a) Single boat (not waiting)
      const boats1 = [{
        mmsi: '265573140',
        currentBridge: 'Stallbackabron',
        targetBridge: 'Stridsbergsbron',
        etaMinutes: 5,
        status: 'approaching',
        waiting: false
      }];

      const message1 = messageGenerator.generateBridgeText(boats1);
      expect(message1).toBe('En båt vid Stallbackabron närmar sig Stridsbergsbron, beräknad öppning om 5 minuter');

      // Test scenario b) Waiting
      const boats2 = [{
        mmsi: '265573141',
        currentBridge: 'Klaffbron',
        targetBridge: 'Klaffbron',
        status: 'waiting',
        waiting: true
      }];

      const message2 = messageGenerator.generateBridgeText(boats2);
      expect(message2).toBe('En båt väntar vid Klaffbron');

      // Test scenario c) Under-bridge
      const boats3 = [{
        mmsi: '265573142',
        targetBridge: 'Stridsbergsbron',
        status: 'under-bridge'
      }];

      const message3 = messageGenerator.generateBridgeText(boats3);
      expect(message3).toBe('Öppning pågår vid Stridsbergsbron');

      // Test scenario d) Plural, not waiting
      const boats4 = [
        {
          mmsi: '265573143',
          targetBridge: 'Klaffbron',
          etaMinutes: 3,
          status: 'approaching',
          waiting: false
        },
        {
          mmsi: '265573144',
          targetBridge: 'Klaffbron',
          status: 'approaching',
          waiting: false
        }
      ];

      const message4 = messageGenerator.generateBridgeText(boats4);
      expect(message4).toBe('En båt närmar sig Klaffbron, ytterligare 1 båtar på väg, beräknad öppning om 3 minuter');

      // Test default message
      const message5 = messageGenerator.generateBridgeText([]);
      expect(message5).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
    });
  });
});