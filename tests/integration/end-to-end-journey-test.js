/**
 * End-to-End Journey Tests
 * 
 * These tests verify complete boat journeys from Olidebron to Järnvägsbron
 * with proper bridge passage detection and targetBridge updates,
 * preventing the LECKO scenario where boats get stuck with wrong targets.
 */

const AISBridgeApp = require('../../app');
const { setupMockHomey } = require('../__mocks__/homey');

describe('End-to-End Journey Tests', () => {
  let app;

  beforeEach(async () => {
    const mockHomey = setupMockHomey();
    app = new AISBridgeApp();
    app.homey = mockHomey;
    app.debug = jest.fn();
    app.error = jest.fn();
    app.log = jest.fn();

    await app.onInit();
  });

  afterEach(async () => {
    if (app) {
      await app.onUninit();
    }
  });

  test('should complete LECKO-style journey: Olidebron → Klaffbron → Järnvägsbron', async () => {
    // Simulate complete 26-minute LECKO journey from the log
    const mmsi = 244063000;
    const name = 'LECKO';

    // Stage 1: Start at Olidebron (21:12:58)
    let vesselData = {
      mmsi,
      name,
      lat: 58.272812,
      lon: 12.275323,
      sog: 3.1,
      cog: 40.7,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(mmsi, vesselData);
    let vessel = app.vesselManager.vessels.get(mmsi);
    
    // Should get proactive target assignment
    expect(vessel.targetBridge).toBeDefined();
    expect(['Klaffbron', 'Stridsbergsbron']).toContain(vessel.targetBridge);
    
    // Simulate being very close to Olidebron
    vessel.nearBridge = 'olidebron';
    const initialTarget = vessel.targetBridge;

    // Stage 2: Move toward Klaffbron (21:25:09)
    vesselData = {
      ...vesselData,
      lat: 58.280000, // Near Klaffbron
      lon: 12.280000,
      sog: 2.0,
      cog: 45.0,
      timestamp: Date.now() + 12 * 60 * 1000 // +12 minutes
    };

    app.vesselManager.updateVessel(mmsi, vesselData);
    vessel = app.vesselManager.vessels.get(mmsi);
    vessel.nearBridge = 'klaffbron';

    // Should maintain consistent target
    expect(vessel.targetBridge).toBe(initialTarget);

    // Simulate under-bridge at Klaffbron
    vessel.status = 'under-bridge';
    const relevantBoatsKlaff = app._findRelevantBoats();
    
    if (relevantBoatsKlaff.length > 0) {
      const boat = relevantBoatsKlaff[0];
      expect(boat.currentBridge).toBe('Klaffbron');
      expect(boat.status).toBe('under-bridge');
    }

    // Stage 3: Pass Klaffbron and move to Järnvägsbron
    vessel.status = 'approaching';
    vessel.nearBridge = null;
    vessel.passedBridges = ['olidebron', 'klaffbron'];

    // Simulate bridge passage event
    const passageEvent = {
      vessel,
      bridgeId: 'klaffbron',
      bridge: { name: 'Klaffbron' }
    };
    app._onBridgePassed(passageEvent);

    // Stage 4: At Järnvägsbron (21:32:38 - 21:38:48)
    vesselData = {
      ...vesselData,
      lat: 58.285000, // Near Järnvägsbron
      lon: 12.282000,
      sog: 0.8,
      cog: 37.2,
      timestamp: Date.now() + 20 * 60 * 1000 // +20 minutes total
    };

    app.vesselManager.updateVessel(mmsi, vesselData);
    vessel = app.vesselManager.vessels.get(mmsi);
    vessel.nearBridge = 'jarnvagsbron';

    // Simulate approaching Järnvägsbron with detected target Stridsbergsbron
    const approachingEvent = {
      vessel,
      bridgeId: 'jarnvagsbron',
      bridge: { name: 'Järnvägsbron' },
      distance: 224,
      targetBridge: 'Stridsbergsbron'
    };

    app._onBridgeApproaching(approachingEvent);

    // Target should now be updated to Stridsbergsbron
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(vessel._detectedTargetBridge).toBe('Stridsbergsbron');

    // Final verification
    const finalRelevantBoats = app._findRelevantBoats();
    if (finalRelevantBoats.length > 0) {
      const finalBoat = finalRelevantBoats[0];
      expect(finalBoat.currentBridge).toBe('Järnvägsbron');
      expect(finalBoat.targetBridge).toBe('Stridsbergsbron');
      expect(finalBoat.etaMinutes).toBeGreaterThan(0);
    }
  });

  test('should handle fast boats that do not qualify for waiting status', async () => {
    // Test fast boat that passes through quickly without triggering waiting
    const mmsi = 123456789;
    const vesselData = {
      mmsi,
      name: 'FAST_BOAT',
      lat: 58.272812,
      lon: 12.275323,
      sog: 4.5, // Fast speed
      cog: 45.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(mmsi);
    vessel.nearBridge = 'olidebron';
    vessel.targetBridge = 'Klaffbron';

    // Fast boat should not enter waiting status even when near bridge
    expect(vessel.status).not.toBe('waiting');
    expect(vessel.isWaiting).toBe(false);

    // Move quickly through bridges
    for (let i = 0; i < 10; i++) {
      const updatedData = {
        ...vesselData,
        sog: 4.5,
        timestamp: Date.now() + i * 10000 // 10 second intervals
      };
      app.vesselManager.updateVessel(mmsi, updatedData);
    }

    const relevantBoats = app._findRelevantBoats();
    if (relevantBoats.length > 0) {
      const boat = relevantBoats[0];
      expect(boat.isWaiting).toBe(false);
    }
  });

  test('should handle multi-boat journey with different speeds', async () => {
    // Test multiple boats on different parts of the journey
    const boats = [
      {
        mmsi: 111111111,
        name: 'SLOW_BOAT',
        lat: 58.272000,
        lon: 12.275000,
        sog: 1.0,
        cog: 40.0
      },
      {
        mmsi: 222222222,
        name: 'MEDIUM_BOAT',
        lat: 58.280000,
        lon: 12.280000,
        sog: 2.5,
        cog: 45.0
      },
      {
        mmsi: 333333333,
        name: 'FAST_BOAT',
        lat: 58.285000,
        lon: 12.282000,
        sog: 4.0,
        cog: 50.0
      }
    ];

    // Add all boats
    boats.forEach(boat => {
      app.vesselManager.updateVessel(boat.mmsi, boat);
    });

    // Set different bridges and targets
    const slow = app.vesselManager.vessels.get(111111111);
    const medium = app.vesselManager.vessels.get(222222222);
    const fast = app.vesselManager.vessels.get(333333333);

    slow.nearBridge = 'olidebron';
    slow.targetBridge = 'Klaffbron';
    
    medium.nearBridge = 'klaffbron';
    medium.targetBridge = 'Klaffbron';
    
    fast.nearBridge = 'jarnvagsbron';  
    fast.targetBridge = 'Stridsbergsbron';

    // Generate relevant boats
    const relevantBoats = app._findRelevantBoats();
    
    // Should handle all boats without errors
    relevantBoats.forEach(boat => {
      expect(boat.mmsi).toBeDefined();
      expect(boat.targetBridge).toBeDefined();
      expect(boat.targetBridge).not.toBe('Unknown');
      expect(boat.etaMinutes).toBeGreaterThanOrEqual(0);
      expect(typeof boat.isWaiting).toBe('boolean');
    });
  });

  test('should detect bridge passages correctly during journey', async () => {
    // Test bridge passage detection mechanisms
    const mmsi = 444444444;
    const vesselData = {
      mmsi,
      name: 'PASSAGE_TEST',
      lat: 58.272000,
      lon: 12.275000,
      sog: 2.0,
      cog: 45.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(mmsi);
    vessel.nearBridge = 'olidebron';
    vessel.targetBridge = 'Klaffbron';

    // Record initial approach bearing
    vessel.approachBearing = 40.0;
    vessel._lastApproachSave = Date.now();

    // Simulate passage by moving far from bridge
    const passedData = {
      ...vesselData,
      lat: 58.280000, // Far from Olidebron
      lon: 12.280000,
      timestamp: Date.now() + 60000 // 1 minute later
    };

    app.vesselManager.updateVessel(mmsi, passedData);
    
    // Should detect passage and update accordingly
    const updatedVessel = app.vesselManager.vessels.get(mmsi);
    // Bridge passage detection should have occurred
    expect(updatedVessel.passedBridges).toContain('olidebron');
  });

  test('should maintain ETA accuracy throughout journey', async () => {
    // Test ETA calculations remain realistic during journey
    const mmsi = 555555555;
    const vesselData = {
      mmsi,
      name: 'ETA_TEST',
      lat: 58.275000,
      lon: 12.276000,
      sog: 1.5,
      cog: 40.0,
      timestamp: Date.now()
    };

    app.vesselManager.updateVessel(mmsi, vesselData);
    const vessel = app.vesselManager.vessels.get(mmsi);
    vessel.targetBridge = 'Klaffbron';

    // Generate boats at different distances
    const positions = [
      { lat: 58.275000, lon: 12.276000, expectedETA: 'high' },
      { lat: 58.279000, lon: 12.279000, expectedETA: 'medium' },
      { lat: 58.281000, lon: 12.281000, expectedETA: 'low' }
    ];

    for (const pos of positions) {
      const updatedData = {
        ...vesselData,
        lat: pos.lat,
        lon: pos.lon,
        timestamp: Date.now()
      };

      app.vesselManager.updateVessel(mmsi, updatedData);
      const relevantBoats = app._findRelevantBoats();
      
      if (relevantBoats.length > 0) {
        const boat = relevantBoats[0];
        expect(boat.etaMinutes).toBeGreaterThanOrEqual(0);
        expect(boat.etaMinutes).toBeLessThan(60); // Reasonable upper bound
      }
    }
  });

  test('should handle journey interruption and recovery', async () => {
    // Test boat that disappears and reappears (signal loss scenario)
    const mmsi = 666666666;
    const vesselData = {
      mmsi,
      name: 'INTERRUPTED',
      lat: 58.275000,
      lon: 12.276000,
      sog: 2.0,
      cog: 40.0,
      timestamp: Date.now()
    };

    // Initial journey
    app.vesselManager.updateVessel(mmsi, vesselData);
    let vessel = app.vesselManager.vessels.get(mmsi);
    vessel.targetBridge = 'Klaffbron';
    vessel.nearBridge = 'olidebron';

    // Simulate signal loss (no updates for period)
    // Then reappear at different bridge
    const recoveryData = {
      ...vesselData,
      lat: 58.285000, // Now at Järnvägsbron
      lon: 12.282000,
      timestamp: Date.now() + 5 * 60 * 1000 // 5 minutes later
    };

    app.vesselManager.updateVessel(mmsi, recoveryData);
    vessel = app.vesselManager.vessels.get(mmsi);
    
    // Should handle recovery gracefully
    expect(vessel).toBeDefined();
    expect(vessel.targetBridge).toBeDefined();
  });
});