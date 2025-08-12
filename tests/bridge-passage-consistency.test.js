'use strict';

/**
 * Bridge Passage Consistency Tests
 * 
 * Tests that bridge passages are consistently tracked for all bridge types:
 * - Target bridges (Klaffbron, Stridsbergsbron)
 * - Intermediate bridges (Olidebron, Järnvägsbron) 
 * - Special bridges (Stallbackabron)
 * 
 * Verifies that lastPassedBridge is set correctly and persistently.
 */

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

// Simple mock logger for tests
class MockLogger {
  constructor() {
    this.logs = [];
  }
  
  log(message) {
    this.logs.push(String(message));
  }
  
  debug(message) {
    this.logs.push(String(message));
  }
  
  error(message) {
    this.logs.push(String(message));
  }
}

describe('Bridge Passage Consistency Tests', () => {
  let vesselDataService;
  let bridgeRegistry;
  let logger;

  beforeEach(() => {
    logger = new MockLogger();
    bridgeRegistry = new BridgeRegistry();
    vesselDataService = new VesselDataService(logger, bridgeRegistry);
  });

  afterEach(() => {
    vesselDataService.clearAllTimers();
  });

  describe('Target Bridge Passage Recording', () => {
    test('should record Klaffbron passage and transition to Stridsbergsbron', () => {
      const mmsi = '265TEST001';
      
      // Step 1: Vessel approaches Klaffbron from south (northbound)
      const vessel1 = vesselDataService.updateVessel(mmsi, {
        lat: 58.28300, // South of Klaffbron (58.28409)
        lon: 12.28390,
        sog: 4.5,
        cog: 25, // Northbound
        name: 'Test Vessel 1'
      });
      
      expect(vessel1.targetBridge).toBe('Klaffbron');
      expect(vessel1.lastPassedBridge).toBeFalsy();

      // Step 2: Vessel passes very close to Klaffbron  
      const vessel2 = vesselDataService.updateVessel(mmsi, {
        lat: 58.28409, // Exactly at Klaffbron bridge
        lon: 12.28393,
        sog: 4.5,
        cog: 25
      });

      // Step 3: Vessel moves well north, triggering passage detection
      const vessel3 = vesselDataService.updateVessel(mmsi, {
        lat: 58.28600, // Well north of Klaffbron (200m)
        lon: 12.28393,
        sog: 4.5,
        cog: 25
      });

      // Should transition to Stridsbergsbron and record Klaffbron passage
      expect(vessel3.targetBridge).toBe('Stridsbergsbron');
      expect(vessel3.lastPassedBridge).toBe('Klaffbron');
      expect(vessel3.lastPassedBridgeTime).toBeTruthy();
      
      // Log should show passage detection
      const passageLogs = logger.logs.filter(log => 
        log.includes('TARGET_BRIDGE_PASSED') || log.includes('TARGET_PASSAGE_RECORDED')
      );
      expect(passageLogs.length).toBeGreaterThan(0);
    });

    test('should record Stridsbergsbron passage and mark for removal', () => {
      const mmsi = '265TEST002';
      
      // Start vessel north of Stridsbergsbron, heading south
      const vessel1 = vesselDataService.updateVessel(mmsi, {
        lat: 58.29450, // North of Stridsbergsbron (58.29352)
        lon: 12.29456,
        sog: 4.5,
        cog: 200, // Southbound
        name: 'Test Vessel 2'
      });
      
      expect(vessel1.targetBridge).toBe('Stridsbergsbron');

      // Vessel passes through Stridsbergsbron
      const vessel2 = vesselDataService.updateVessel(mmsi, {
        lat: 58.29352, // Exactly at Stridsbergsbron bridge
        lon: 12.29456,
        sog: 4.5,
        cog: 200
      });

      // Vessel moves further south, triggering passage detection
      const vessel3 = vesselDataService.updateVessel(mmsi, {
        lat: 58.29100, // Well south of Stridsbergsbron (250m+)
        lon: 12.29456,
        sog: 4.5,
        cog: 200
      });

      // Should transition to Klaffbron and record Stridsbergsbron passage
      expect(vessel3.targetBridge).toBe('Klaffbron');
      expect(vessel3.lastPassedBridge).toBe('Stridsbergsbron');
      expect(vessel3.lastPassedBridgeTime).toBeTruthy();
    });
  });

  describe('Intermediate Bridge Passage Recording', () => {
    test('should record Olidebron passage while maintaining target bridge', () => {
      const mmsi = '265TEST003';
      
      // Start vessel south of Olidebron, targeting Klaffbron
      const vessel1 = vesselDataService.updateVessel(mmsi, {
        lat: 58.31900, // South of Olidebron
        lon: 12.28900,
        sog: 4.5,
        cog: 25, // Northbound
        name: 'Test Vessel 3'
      });
      
      expect(vessel1.targetBridge).toBe('Klaffbron');
      expect(vessel1.lastPassedBridge).toBeFalsy();

      // Pass through Olidebron area
      const vessel2 = vesselDataService.updateVessel(mmsi, {
        lat: 58.31970, // Through Olidebron
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      // Move north of Olidebron
      const vessel3 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32020, // North of Olidebron, approaching Klaffbron
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      // Should maintain target bridge but record intermediate passage
      expect(vessel3.targetBridge).toBe('Klaffbron');
      expect(vessel3.lastPassedBridge).toBe('Olidebron');
      expect(vessel3.lastPassedBridgeTime).toBeTruthy();
      
      // Verify intermediate passage was detected and recorded
      const intermediateLogs = logger.logs.filter(log => 
        log.includes('INTERMEDIATE_PASSAGE') && log.includes('Olidebron')
      );
      expect(intermediateLogs.length).toBeGreaterThan(0);
    });

    test('should record Järnvägsbron passage for northbound vessel', () => {
      const mmsi = '265TEST004';
      
      // Start vessel between Klaffbron and Järnvägsbron, targeting Stridsbergsbron
      const vessel1 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32150, // Between bridges
        lon: 12.28900,
        sog: 4.5,
        cog: 25, // Northbound
        name: 'Test Vessel 4'
      });
      
      expect(vessel1.targetBridge).toBe('Stridsbergsbron');

      // Pass through Järnvägsbron
      const vessel2 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32240, // Through Järnvägsbron
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      // Move north of Järnvägsbron  
      const vessel3 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32320, // North of Järnvägsbron
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      // Should maintain target bridge and record intermediate passage
      expect(vessel3.targetBridge).toBe('Stridsbergsbron');
      expect(vessel3.lastPassedBridge).toBe('Järnvägsbron');
      expect(vessel3.lastPassedBridgeTime).toBeTruthy();
    });
  });

  describe('Stallbackabron Special Handling', () => {
    test('should record Stallbackabron passage as intermediate bridge', () => {
      const mmsi = '265TEST005';
      
      // Start vessel north of Stallbackabron
      const vessel1 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32800, // North of Stallbackabron
        lon: 12.28900,
        sog: 4.5,
        cog: 200, // Southbound, targeting Stridsbergsbron
        name: 'Test Vessel 5'
      });
      
      expect(vessel1.targetBridge).toBe('Stridsbergsbron');

      // Pass through Stallbackabron area
      const vessel2 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32720, // Through Stallbackabron
        lon: 12.28900,
        sog: 4.5,
        cog: 200
      });

      // Move south of Stallbackabron
      const vessel3 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32650, // South of Stallbackabron, approaching Stridsbergsbron
        lon: 12.28900,
        sog: 4.5,
        cog: 200
      });

      // Should maintain target bridge and record Stallbackabron passage
      expect(vessel3.targetBridge).toBe('Stridsbergsbron');
      expect(vessel3.lastPassedBridge).toBe('Stallbackabron');
      expect(vessel3.lastPassedBridgeTime).toBeTruthy();
      
      // Verify Stallbackabron was added to passed bridges list
      expect(vessel3.passedBridges).toContain('Stallbackabron');
    });
  });

  describe('Passage Priority and Overwriting', () => {
    test('should prioritize target bridge passages over intermediate ones', () => {
      const mmsi = '265TEST006';
      
      // Start with vessel that has passed target bridge recently
      let vessel = vesselDataService.updateVessel(mmsi, {
        lat: 58.32100,
        lon: 12.28900,
        sog: 4.5,
        cog: 25,
        name: 'Test Vessel 6'
      });
      
      // Manually set recent target bridge passage
      vessel.lastPassedBridge = 'Klaffbron';
      vessel.lastPassedBridgeTime = Date.now() - 30000; // 30 seconds ago
      vessel.targetBridge = 'Stridsbergsbron';
      
      // Now pass intermediate bridge within grace period
      const vessel2 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32250, // Through Järnvägsbron
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      const vessel3 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32320, // Past Järnvägsbron
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      // Should NOT overwrite recent target bridge passage
      expect(vessel3.lastPassedBridge).toBe('Klaffbron');
      
      // But should log the skipped intermediate passage
      const skippedLogs = logger.logs.filter(log => 
        log.includes('INTERMEDIATE_PASSAGE_SKIPPED')
      );
      expect(skippedLogs.length).toBeGreaterThan(0);
    });

    test('should allow intermediate bridge to overwrite old target bridge passage', () => {
      const mmsi = '265TEST007';
      
      // Start with vessel that has old target bridge passage
      let vessel = vesselDataService.updateVessel(mmsi, {
        lat: 58.32100,
        lon: 12.28900,
        sog: 4.5,
        cog: 25,
        name: 'Test Vessel 7'
      });
      
      // Set old target bridge passage (beyond grace period)
      vessel.lastPassedBridge = 'Klaffbron';
      vessel.lastPassedBridgeTime = Date.now() - 120000; // 2 minutes ago
      vessel.targetBridge = 'Stridsbergsbron';
      
      // Pass intermediate bridge
      const vessel2 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32250, // Through Järnvägsbron
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      const vessel3 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32320, // Past Järnvägsbron
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      // Should overwrite old target bridge passage
      expect(vessel3.lastPassedBridge).toBe('Järnvägsbron');
      expect(vessel3.lastPassedBridgeTime).toBeGreaterThan(Date.now() - 5000); // Recent
    });
  });

  describe('Enhanced Passage Detection Usage', () => {
    test('should use enhanced detectBridgePassage function', () => {
      const mmsi = '265TEST008';
      
      // Create a scenario where enhanced detection would catch passage
      // but simple distance-based might miss it
      const vessel1 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32040, // Near Klaffbron
        lon: 12.28900,
        sog: 4.5,
        cog: 25,
        name: 'Test Vessel 8'
      });

      // Large movement that crosses bridge line (simulating sparse AIS data)
      const vessel2 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32120, // Past Klaffbron
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      // Verify passage was detected using enhanced method
      const enhancedLogs = logger.logs.filter(log => 
        log.includes('TARGET_BRIDGE_PASSED') && log.includes('method:')
      );
      expect(enhancedLogs.length).toBeGreaterThan(0);
      
      // Should have detected passage and recorded it
      expect(vessel2.lastPassedBridge).toBeTruthy();
    });
  });

  describe('Comprehensive Audit Logging', () => {
    test('should provide detailed passage tracking audit logs', () => {
      const mmsi = '265TEST009';
      
      const vessel1 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32000,
        lon: 12.28900,
        sog: 4.5,
        cog: 25,
        name: 'Test Vessel 9'
      });

      const vessel2 = vesselDataService.updateVessel(mmsi, {
        lat: 58.32100,
        lon: 12.28900,
        sog: 4.5,
        cog: 25
      });

      // Check for audit logging
      const auditLogs = logger.logs.filter(log => 
        log.includes('PASSAGE_AUDIT') || 
        log.includes('PASSAGE_TRACKING_SUMMARY') ||
        log.includes('PASSED_BRIDGES_UPDATED')
      );
      
      // Should have comprehensive logging
      expect(auditLogs.length).toBeGreaterThan(0);
    });
  });
});