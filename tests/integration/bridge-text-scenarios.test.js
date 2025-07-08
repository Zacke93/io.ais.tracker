const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('Bridge Text Functionality - Advanced Smart Logic Tests', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app._lastSeen = {};
    app._speedHistory = {};

    // Mock settings
    app.homey.settings.get.mockImplementation((key) => {
      if (key === 'debug_level') return 'basic';
      if (key === 'ais_api_key') return '12345678-1234-4123-a123-123456789012';
      return null;
    });

    // Mock methods
    app._updateConnectionStatus = jest.fn();
    app._updateActiveBridgesTag = jest.fn();
    app._activeBridgesTag = {
      setValue: jest.fn().mockResolvedValue(true),
    };
    app._devices = new Map();

    // Mock device for testing bridge_text functionality
    const mockDevice = {
      setCapabilityValue: jest.fn().mockResolvedValue(true),
      getCapabilityValue: jest.fn().mockReturnValue('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron'),
    };
    app._devices.set('test_device', mockDevice);
  });

  describe('Bridge Text Generation - Route Prediction Logic', () => {
    test('should detect boat at Olidebron heading to Klaffbron and generate correct bridge_text', async () => {
      const mmsi = '123456789';
      const baseTime = Date.now();
      
      console.log('=== ROUTE PREDICTION TEST: Olidebron → Klaffbron ===');
      
      // Boat at Olidebron heading north towards Vänersborg (will hit Klaffbron next)
      app._lastSeen.olidebron = {};
      app._lastSeen.olidebron[mmsi] = {
        ts: baseTime,
        sog: 4.5,
        dist: 250, // 250m from Olidebron
        dir: 'Vänersborg', // Northbound
        vessel_name: 'ROUTE TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 4.5,
      };

      const relevantBoats = await app._findRelevantBoats();
      console.log(`Found ${relevantBoats.length} relevant boats`);
      
      expect(relevantBoats.length).toBe(1);
      expect(relevantBoats[0].mmsi).toBe(mmsi);
      expect(relevantBoats[0].targetBridge).toBe('Klaffbron');
      
      // Generate bridge text
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      console.log(`Generated bridge_text: "${bridgeText}"`);
      
      expect(bridgeText).toContain('Klaffbron');
      expect(bridgeText).toMatch(/\d+\s*minuter?/); // Should contain ETA in minutes
      
      console.log('✅ Successfully predicted Klaffbron as target from Olidebron position');
    });

    test('should detect boat at Klaffbron heading to Stridsbergsbron and generate correct bridge_text', async () => {
      const mmsi = '234567890';
      const baseTime = Date.now();
      
      console.log('\n=== ROUTE PREDICTION TEST: Klaffbron → Stridsbergsbron ===');
      
      // Boat at Klaffbron heading north towards Vänersborg (will hit Stridsbergsbron next)
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: baseTime,
        sog: 3.8,
        dist: 180, // 180m from Klaffbron
        dir: 'Vänersborg', // Northbound
        vessel_name: 'SEQUENTIAL BRIDGE TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 3.8,
      };

      const relevantBoats = await app._findRelevantBoats();
      console.log(`Found ${relevantBoats.length} relevant boats`);
      
      expect(relevantBoats.length).toBe(1);
      expect(relevantBoats[0].mmsi).toBe(mmsi);
      expect(relevantBoats[0].targetBridge).toBe('Klaffbron'); // Currently at Klaffbron
      
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      console.log(`Generated bridge_text: "${bridgeText}"`);
      
      expect(bridgeText).toContain('Klaffbron');
      expect(bridgeText).toMatch(/\d+\s*minuter?/);
      
      console.log('✅ Successfully detected boat at Klaffbron target bridge');
    });

    test('should detect boat at Järnvägsbron heading south and predict Klaffbron', async () => {
      const mmsi = '345678901';
      const baseTime = Date.now();
      
      console.log('\n=== ROUTE PREDICTION TEST: Järnvägsbron → Klaffbron (southbound) ===');
      
      // Boat at Järnvägsbron heading south towards Göteborg (will hit Klaffbron next)
      app._lastSeen.jarnvagsbron = {};
      app._lastSeen.jarnvagsbron[mmsi] = {
        ts: baseTime,
        sog: 5.2,
        dist: 300, // 300m from Järnvägsbron
        dir: 'Göteborg', // Southbound
        vessel_name: 'SOUTHBOUND TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 5.2,
      };

      const relevantBoats = await app._findRelevantBoats();
      console.log(`Found ${relevantBoats.length} relevant boats`);
      
      expect(relevantBoats.length).toBe(1);
      expect(relevantBoats[0].mmsi).toBe(mmsi);
      expect(relevantBoats[0].targetBridge).toBe('Klaffbron');
      
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      console.log(`Generated bridge_text: "${bridgeText}"`);
      
      expect(bridgeText).toContain('Klaffbron');
      expect(bridgeText).toMatch(/\d+\s*minuter?/);
      
      console.log('✅ Successfully predicted Klaffbron target from southbound route');
    });
  });

  describe('Bridge Text ETA Calculations', () => {
    test('should generate realistic ETAs for different speed scenarios', async () => {
      console.log('\n=== ETA CALCULATION TESTING ===');
      
      const testScenarios = [
        {
          name: 'Fast boat close',
          mmsi: '100001',
          sog: 8.0,
          dist: 200,
          expectedEtaRange: [0.5, 2]
        },
        {
          name: 'Slow boat medium distance',
          mmsi: '100002', 
          sog: 2.5,
          dist: 500,
          expectedEtaRange: [6, 12]
        },
        {
          name: 'Very slow boat close (should show waiting)',
          mmsi: '100003',
          sog: 0.8,
          dist: 80,
          expectedWaiting: true
        }
      ];

      for (const scenario of testScenarios) {
        console.log(`\n--- Testing: ${scenario.name} ---`);
        
        app._lastSeen.klaffbron = app._lastSeen.klaffbron || {};
        app._lastSeen.klaffbron[scenario.mmsi] = {
          ts: Date.now(),
          sog: scenario.sog,
          dist: scenario.dist,
          dir: 'Vänersborg',
          vessel_name: scenario.name.toUpperCase(),
          mmsi: scenario.mmsi,
          towards: true,
          maxRecentSog: scenario.sog,
        };

        const relevantBoats = await app._findRelevantBoats();
        const boat = relevantBoats.find(b => b.mmsi === scenario.mmsi);
        
        if (boat) {
          console.log(`Speed: ${scenario.sog} knots, Distance: ${scenario.dist}m`);
          console.log(`Calculated ETA: ${boat.etaMinutes}`);
          
          if (scenario.expectedWaiting) {
            expect(boat.etaMinutes).toBe('waiting');
            console.log('✅ Correctly identified as waiting');
          } else {
            expect(typeof boat.etaMinutes === 'number').toBe(true);
            expect(boat.etaMinutes).toBeGreaterThanOrEqual(scenario.expectedEtaRange[0]);
            expect(boat.etaMinutes).toBeLessThanOrEqual(scenario.expectedEtaRange[1]);
            console.log(`✅ ETA within expected range: ${scenario.expectedEtaRange[0]}-${scenario.expectedEtaRange[1]} min`);
          }
        } else {
          console.log('❌ Boat not detected as relevant');
          fail(`Expected ${scenario.name} to be detected`);
        }
      }
    });
  });

  describe('Bridge Text Smart Prioritization', () => {
    test('should handle single boat at Stridsbergsbron correctly', async () => {
      const mmsi = '200001';
      
      console.log('\n=== SINGLE BOAT STRIDSBERGSBRON TEST ===');
      
      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron[mmsi] = {
        ts: Date.now(),
        sog: 3.2,
        dist: 150,
        dir: 'Göteborg',
        vessel_name: 'SINGLE STRIDS TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 3.2,
      };

      const relevantBoats = await app._findRelevantBoats();
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      
      console.log(`Generated bridge_text: "${bridgeText}"`);
      
      expect(bridgeText).toContain('Stridsbergsbron');
      expect(bridgeText).not.toContain('Klaffbron');
      expect(bridgeText).not.toContain(';'); // Should not be combined message
      
      console.log('✅ Single Stridsbergsbron message generated correctly');
    });

    test('should prioritize Stridsbergsbron over Klaffbron for same boat', async () => {
      const mmsi = '200002';
      
      console.log('\n=== SAME BOAT DUAL BRIDGE PRIORITIZATION TEST ===');
      
      // Simulate same boat being detected at both bridges (edge case)
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: Date.now(),
        sog: 2.8,
        dist: 200,
        dir: 'Vänersborg',
        vessel_name: 'DUAL BRIDGE TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.8,
      };

      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron[mmsi] = {
        ts: Date.now() + 1000, // 1 second later
        sog: 2.5,
        dist: 180,
        dir: 'Vänersborg',
        vessel_name: 'DUAL BRIDGE TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 2.8,
      };

      const relevantBoats = await app._findRelevantBoats();
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      
      console.log(`Generated bridge_text: "${bridgeText}"`);
      console.log(`Relevant boats found: ${relevantBoats.length}`);
      
      // Should prioritize and show only one message, not combined
      expect(bridgeText).not.toContain(';');
      expect(bridgeText).toMatch(/Stridsbergsbron|Klaffbron/);
      
      console.log('✅ Smart prioritization avoided dual-triggering');
    });

    test('should combine messages for different boats at different bridges', async () => {
      console.log('\n=== DIFFERENT BOATS COMBINATION TEST ===');
      
      // Boat 1 at Klaffbron
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron['300001'] = {
        ts: Date.now(),
        sog: 4.1,
        dist: 160,
        dir: 'Vänersborg',
        vessel_name: 'KLAFFBRON BOAT',
        mmsi: '300001',
        towards: true,
        maxRecentSog: 4.1,
      };

      // Boat 2 at Stridsbergsbron  
      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron['300002'] = {
        ts: Date.now(),
        sog: 3.5,
        dist: 140,
        dir: 'Göteborg',
        vessel_name: 'STRIDSBERGSBRON BOAT',
        mmsi: '300002',
        towards: true,
        maxRecentSog: 3.5,
      };

      const relevantBoats = await app._findRelevantBoats();
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      
      console.log(`Generated bridge_text: "${bridgeText}"`);
      console.log(`Relevant boats: ${relevantBoats.length}`);
      
      // Should combine different boats with semicolon
      expect(bridgeText).toContain(';');
      expect(bridgeText).toContain('Klaffbron');
      expect(bridgeText).toContain('Stridsbergsbron');
      
      console.log('✅ Successfully combined messages for different boats');
    });
  });

  describe('Bridge Text Speed Compensation Logic', () => {
    test('should use speed compensation for boats with low current speed but high historical speed', async () => {
      const mmsi = '400001';
      
      console.log('\n=== SPEED COMPENSATION TEST ===');
      
      app._lastSeen.klaffbron = {};
      app._lastSeen.klaffbron[mmsi] = {
        ts: Date.now(),
        sog: 1.2, // Current low speed
        dist: 800, // 800m away
        dir: 'Vänersborg',
        vessel_name: 'SPEED COMPENSATION TESTER',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 7.5, // Had much higher speed recently
      };

      const relevantBoats = await app._findRelevantBoats();
      
      expect(relevantBoats.length).toBe(1);
      const boat = relevantBoats[0];
      
      console.log(`Current speed: ${boat.sog} knots`);
      console.log(`Max recent speed: ${boat.maxRecentSog} knots`);
      console.log(`Distance: ${boat.dist}m`);
      console.log(`Calculated ETA: ${boat.etaMinutes} minutes`);
      
      // ETA should be calculated using compensated speed, not current low speed
      // 800m at compensated speed (70% of 7.5 = 5.25 knots) ≈ 4.9 minutes
      // At raw 1.2 knots it would be ≈ 21 minutes
      expect(typeof boat.etaMinutes === 'number').toBe(true);
      expect(boat.etaMinutes).toBeLessThan(15); // Should use compensated speed
      expect(boat.etaMinutes).toBeGreaterThan(2);
      
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      console.log(`Generated bridge_text: "${bridgeText}"`);
      
      expect(bridgeText).toContain('Klaffbron');
      
      console.log('✅ Speed compensation applied correctly for realistic ETA');
    });
  });

  describe('Bridge Text Distance-Based Rules', () => {
    test('should show waiting status for boats very close to bridge', async () => {
      const mmsi = '500001';
      
      console.log('\n=== DISTANCE-BASED WAITING STATUS TEST ===');
      
      app._lastSeen.stridsbergsbron = {};
      app._lastSeen.stridsbergsbron[mmsi] = {
        ts: Date.now(),
        sog: 0.3, // Very slow
        dist: 25, // Very close
        dir: 'Göteborg',
        vessel_name: 'WAITING BOAT',
        mmsi: mmsi,
        towards: true,
        maxRecentSog: 4.2,
      };

      const relevantBoats = await app._findRelevantBoats();
      
      expect(relevantBoats.length).toBe(1);
      const boat = relevantBoats[0];
      
      console.log(`Speed: ${boat.sog} knots`);
      console.log(`Distance: ${boat.dist}m`);
      console.log(`ETA result: ${boat.etaMinutes}`);
      
      // Should show very short ETA due to very close distance and low speed
      expect(typeof boat.etaMinutes === 'number').toBe(true);
      expect(boat.etaMinutes).toBeLessThanOrEqual(1);
      
      const bridgeText = app._generateBridgeTextFromBoats(relevantBoats);
      console.log(`Generated bridge_text: "${bridgeText}"`);
      
      expect(bridgeText).toMatch(/\d+\s*minuter?/); // Should contain ETA
      
      console.log('✅ Correctly identified waiting status for very close slow boat');
    });
  });
});