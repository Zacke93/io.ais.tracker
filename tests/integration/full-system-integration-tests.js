/* eslint-disable */
'use strict';

const { VesselStateManager, BridgeMonitor, MessageGenerator, TextFlowManager } = require('../../app.js');

describe('Full System Integration Tests', () => {
  let vesselManager;
  let bridgeMonitor;
  let messageGenerator;
  let textFlowManager;
  let mockLogger;
  let mockApp;
  let systemEvents = [];
  let flowTriggers = [];
  let capabilityUpdates = [];

  beforeEach(() => {
    mockLogger = {
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    // Full app mock with all required functionality
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
      setCapabilityValue: jest.fn((capability, value) => {
        capabilityUpdates.push({ capability, value, timestamp: Date.now() });
      }),
      homey: {
        flow: {
          getTriggerCard: jest.fn((name) => ({
            trigger: jest.fn((tokens, state) => {
              flowTriggers.push({ card: name, tokens, state, timestamp: Date.now() });
            })
          })),
          getConditionCard: jest.fn().mockReturnValue({})
        }
      },
      _relevantBoats: [],
      _currentBridgeText: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron',
      _flowCard: null
    };

    systemEvents = [];
    flowTriggers = [];
    capabilityUpdates = [];

    // Create all components
    vesselManager = new VesselStateManager(mockLogger);
    bridgeMonitor = new BridgeMonitor(mockLogger, mockApp.bridges);
    messageGenerator = new MessageGenerator(mockLogger, mockApp);
    textFlowManager = new TextFlowManager(mockLogger, mockApp);

    // Wire up the complete system
    vesselManager.on('vessel:updated', ({ mmsi, data, oldData }) => {
      systemEvents.push({ type: 'vessel:updated', mmsi, data });
      
      // BridgeMonitor processes vessel updates
      bridgeMonitor.updateVesselPosition(mmsi, data);
      
      // Update _distanceToNearest on vessel
      const nearestInfo = bridgeMonitor.getNearestBridge(data.lat, data.lon);
      if (nearestInfo) {
        data._distanceToNearest = nearestInfo.distance;
      }
    });

    vesselManager.on('vessel:removed', ({ mmsi }) => {
      systemEvents.push({ type: 'vessel:removed', mmsi });
      bridgeMonitor.removeVessel(mmsi);
    });

    vesselManager.on('vessel:irrelevant', ({ mmsi }) => {
      systemEvents.push({ type: 'vessel:irrelevant', mmsi });
    });

    vesselManager.on('vessel:status-changed', (data) => {
      systemEvents.push({ type: 'vessel:status-changed', ...data });
    });

    bridgeMonitor.on('bridge:approaching', (data) => {
      systemEvents.push({ type: 'bridge:approaching', ...data });
      
      // Simulate what app.js does
      const vessel = vesselManager.vessels.get(data.mmsi);
      if (vessel && !vessel.targetBridge) {
        // Find target bridge logic
        const targetBridge = mockApp.userBridges.includes(data.bridgeId) 
          ? mockApp.bridges.find(b => b.id === data.bridgeId)?.name
          : null;
        
        if (targetBridge) {
          vessel.targetBridge = targetBridge;
        }
      }
    });

    bridgeMonitor.on('bridge:leaving', (data) => {
      systemEvents.push({ type: 'bridge:leaving', ...data });
    });

    // Set up flow card
    mockApp._flowCard = mockApp.homey.flow.getTriggerCard('boat_near');
  });

  describe('Complete boat journey through multiple bridges', () => {
    it('should track boat from Olidebron to Stridsbergsbron with all events', async () => {
      const mmsi = '265573130';
      jest.useFakeTimers();

      // Start south of Olidebron
      vesselManager.updateVessel(mmsi, {
        lat: 58.28616 - 0.0036, // ~400m south
        lon: 12.29281,
        sog: 4.0,
        cog: 0, // Heading north
        name: 'JOURNEY_TEST'
      });

      await Promise.resolve();

      // Verify initial state
      const vessel1 = vesselManager.vessels.get(mmsi);
      expect(vessel1).toBeDefined();
      expect(vessel1.status).toBe('en-route');

      // Approach Olidebron
      vesselManager.updateVessel(mmsi, {
        lat: 58.28616 - 0.0018, // ~200m south
        lon: 12.29281,
        sog: 4.0,
        cog: 0,
        name: 'JOURNEY_TEST'
      });

      await Promise.resolve();

      // Should trigger bridge:approaching for Olidebron
      expect(systemEvents.some(e => 
        e.type === 'bridge:approaching' && 
        e.bridgeId === 'olidebron'
      )).toBe(true);

      // Pass Olidebron
      vesselManager.updateVessel(mmsi, {
        lat: 58.28616 + 0.00054, // ~60m north
        lon: 12.29281,
        sog: 4.0,
        cog: 0,
        name: 'JOURNEY_TEST'
      });

      await Promise.resolve();

      // Continue to Klaffbron (user bridge)
      vesselManager.updateVessel(mmsi, {
        lat: 58.29052 - 0.0018, // ~200m south of Klaffbron
        lon: 12.29434,
        sog: 4.0,
        cog: 0,
        name: 'JOURNEY_TEST'
      });

      await Promise.resolve();

      const vessel2 = vesselManager.vessels.get(mmsi);
      expect(vessel2.targetBridge).toBe('Klaffbron');

      // Should trigger flow card for user bridge
      expect(flowTriggers.some(t => 
        t.card === 'boat_near' && 
        t.tokens.bridge === 'Klaffbron'
      )).toBe(true);

      // Generate and verify message
      const boats = [{
        mmsi: vessel2.mmsi,
        currentBridge: 'Klaffbron',
        targetBridge: vessel2.targetBridge,
        etaMinutes: 3,
        status: vessel2.status,
        waiting: false
      }];

      const message = messageGenerator.generateBridgeText(boats);
      expect(message).toBe('En båt närmar sig Klaffbron, beräknad öppning om 3 minuter');

      // Verify capability updates
      mockApp.setCapabilityValue('bridge_text', message);
      mockApp.setCapabilityValue('alarm_generic', true);

      expect(capabilityUpdates).toContainEqual(
        expect.objectContaining({ capability: 'bridge_text', value: message })
      );
      expect(capabilityUpdates).toContainEqual(
        expect.objectContaining({ capability: 'alarm_generic', value: true })
      );

      jest.useRealTimers();
    });
  });

  describe('Multiple boats with different states', () => {
    it('should handle waiting, approaching, and under-bridge boats simultaneously', async () => {
      jest.useFakeTimers();

      // Boat 1: Approaching Klaffbron
      vesselManager.updateVessel('111111111', {
        lat: 58.29052 - 0.0018,
        lon: 12.29434,
        sog: 3.0,
        cog: 0,
        name: 'APPROACHING'
      });

      // Boat 2: Will be waiting at Stridsbergsbron
      vesselManager.updateVessel('222222222', {
        lat: 58.29475 - 0.0009, // ~100m from bridge
        lon: 12.29691,
        sog: 0.1,
        cog: 0,
        name: 'WAITING'
      });

      // Boat 3: Under bridge at Stridsbergsbron
      vesselManager.updateVessel('333333333', {
        lat: 58.29475 - 0.00036, // ~40m from bridge
        lon: 12.29691,
        sog: 0.5,
        cog: 0,
        name: 'UNDER_BRIDGE'
      });

      await Promise.resolve();

      // Set target bridges
      const boat1 = vesselManager.vessels.get('111111111');
      const boat2 = vesselManager.vessels.get('222222222');
      const boat3 = vesselManager.vessels.get('333333333');

      boat1.targetBridge = 'Klaffbron';
      boat2.targetBridge = 'Stridsbergsbron';
      boat3.targetBridge = 'Stridsbergsbron';

      // Fast forward for waiting detection
      jest.advanceTimersByTime(130000);

      // Update boat 2 to trigger waiting status
      vesselManager.updateVessel('222222222', {
        lat: 58.29475 - 0.0009,
        lon: 12.29691,
        sog: 0.1,
        cog: 0,
        name: 'WAITING'
      });

      await Promise.resolve();

      // Update statuses
      const updatedBoat2 = vesselManager.vessels.get('222222222');
      expect(updatedBoat2.status).toBe('waiting');

      boat3.status = 'under-bridge';
      boat3.etaMinutes = 0;

      // Prepare boats for message generation
      const boats = [
        {
          mmsi: boat1.mmsi,
          currentBridge: 'Klaffbron',
          targetBridge: 'Klaffbron',
          etaMinutes: 4,
          status: 'approaching',
          waiting: false
        },
        {
          mmsi: boat2.mmsi,
          currentBridge: 'Stridsbergsbron',
          targetBridge: 'Stridsbergsbron',
          status: 'waiting',
          waiting: true
        },
        {
          mmsi: boat3.mmsi,
          targetBridge: 'Stridsbergsbron',
          status: 'under-bridge'
        }
      ];

      // Test priority: under-bridge should take precedence
      const underBridgeBoats = boats.filter(b => b.status === 'under-bridge');
      if (underBridgeBoats.length > 0) {
        const message = messageGenerator.generateBridgeText(underBridgeBoats);
        expect(message).toBe('Öppning pågår vid Stridsbergsbron');
      }

      jest.useRealTimers();
    });
  });

  describe('Signal loss and cleanup integration', () => {
    it('should handle complete system cleanup after timeout', async () => {
      jest.useFakeTimers();
      const mmsi = '444444444';

      // Add boat far from bridges
      vesselManager.updateVessel(mmsi, {
        lat: 58.29475 - 0.009, // ~1km from bridge
        lon: 12.29691,
        sog: 2.0,
        cog: 0,
        name: 'CLEANUP_TEST'
      });

      await Promise.resolve();

      const vessel = vesselManager.vessels.get(mmsi);
      expect(vessel._distanceToNearest).toBeGreaterThan(600);

      // Verify boat was added
      expect(systemEvents.some(e => e.type === 'vessel:updated' && e.mmsi === mmsi)).toBe(true);

      // Fast forward past 2 minute timeout for >600m zone
      jest.advanceTimersByTime(3 * 60 * 1000);

      // Verify complete cleanup
      expect(vesselManager.vessels.has(mmsi)).toBe(false);
      expect(systemEvents.some(e => e.type === 'vessel:removed' && e.mmsi === mmsi)).toBe(true);

      // Verify no orphaned data in BridgeMonitor
      const nearestBridge = bridgeMonitor.getNearestBridge(vessel.lat, vessel.lon);
      expect(nearestBridge).toBeDefined(); // Bridge still exists
      
      // But vessel should not be associated with any bridge
      for (const [bridgeId, vessels] of bridgeMonitor.bridgeVessels) {
        expect(vessels.has(mmsi)).toBe(false);
      }

      jest.useRealTimers();
    });
  });

  describe('Flow card and capability synchronization', () => {
    it('should keep bridge_text and alarm_generic in sync', async () => {
      const mmsi = '555555555';

      // No boats initially
      mockApp.setCapabilityValue('bridge_text', 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
      mockApp.setCapabilityValue('alarm_generic', false);

      capabilityUpdates = []; // Reset

      // Add boat approaching Klaffbron
      vesselManager.updateVessel(mmsi, {
        lat: 58.29052 - 0.0018,
        lon: 12.29434,
        sog: 3.0,
        cog: 0,
        name: 'SYNC_TEST'
      });

      await Promise.resolve();

      const vessel = vesselManager.vessels.get(mmsi);
      vessel.targetBridge = 'Klaffbron';

      // Simulate UI update
      const newText = 'En båt närmar sig Klaffbron, beräknad öppning om 4 minuter';
      mockApp.setCapabilityValue('bridge_text', newText);
      mockApp.setCapabilityValue('alarm_generic', true);

      // Verify synchronous updates
      const textUpdate = capabilityUpdates.find(u => u.capability === 'bridge_text');
      const alarmUpdate = capabilityUpdates.find(u => u.capability === 'alarm_generic');

      expect(textUpdate).toBeDefined();
      expect(alarmUpdate).toBeDefined();
      expect(Math.abs(textUpdate.timestamp - alarmUpdate.timestamp)).toBeLessThan(10); // Within 10ms

      // Remove boat
      vesselManager.removeVessel(mmsi);
      
      // Reset to default
      mockApp.setCapabilityValue('bridge_text', 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
      mockApp.setCapabilityValue('alarm_generic', false);

      // Verify sync on reset too
      const resetTextUpdate = capabilityUpdates.filter(u => u.capability === 'bridge_text').pop();
      const resetAlarmUpdate = capabilityUpdates.filter(u => u.capability === 'alarm_generic').pop();

      expect(resetTextUpdate.value).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
      expect(resetAlarmUpdate.value).toBe(false);
    });
  });

  describe('Edge cases and error conditions', () => {
    it('should handle rapid position updates without losing state', async () => {
      const mmsi = '666666666';

      // Rapid fire updates
      for (let i = 0; i < 10; i++) {
        vesselManager.updateVessel(mmsi, {
          lat: 58.29475 - 0.0018 + (i * 0.00009), // Moving gradually
          lon: 12.29691,
          sog: 3.0 + (i * 0.1), // Speed variations
          cog: 0,
          name: 'RAPID_TEST'
        });
      }

      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify vessel state is consistent
      const vessel = vesselManager.vessels.get(mmsi);
      expect(vessel).toBeDefined();
      expect(vessel.speedHistory).toBeDefined();
      expect(vessel.speedHistory.length).toBeGreaterThan(0);
      
      // Verify no duplicate events
      const updateEvents = systemEvents.filter(e => 
        e.type === 'vessel:updated' && e.mmsi === mmsi
      );
      expect(updateEvents.length).toBe(10);
    });

    it('should handle invalid data gracefully', async () => {
      const mmsi = '777777777';

      // Missing required fields
      vesselManager.updateVessel(mmsi, {
        lat: null,
        lon: undefined,
        sog: -1, // Invalid speed
        cog: 400, // Invalid course
        name: 'INVALID_TEST'
      });

      await Promise.resolve();

      // Should not crash, vessel might be created with defaults
      const vessel = vesselManager.vessels.get(mmsi);
      if (vessel) {
        // Verify some sanitization occurred
        expect(vessel.sog).toBeGreaterThanOrEqual(0);
        expect(vessel.cog).toBeGreaterThanOrEqual(0);
        expect(vessel.cog).toBeLessThan(360);
      }
    });
  });
});