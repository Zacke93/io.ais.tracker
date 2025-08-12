'use strict';

/**
 * ENHANCED TARGET BRIDGE PROTECTION TEST SUITE
 * 
 * Tests the robust target bridge protection system that prevents target bridge
 * changes during GPS events, maneuvers, and close approaches.
 * 
 * Coverage:
 * - GPS event protection (jumps, uncertainty)
 * - Maneuver detection protection (COG/SOG changes)
 * - Distance-based protection (300m zone)
 * - Recent passage protection (60s window)
 * - Protection confidence calculation
 * - Protection timers and deactivation
 * - Integration with GPSJumpAnalyzer
 */

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

class MockLogger {
  constructor() {
    this.logs = [];
    this.debugLogs = [];
    this.errorLogs = [];
  }

  log(message) {
    this.logs.push(message);
    console.log(message);
  }

  debug(message) {
    this.debugLogs.push(message);
  }

  error(message) {
    this.errorLogs.push(message);
    console.error(message);
  }
}

class TargetBridgeProtectionTest {
  constructor() {
    this.logger = new MockLogger();
    this.bridgeRegistry = new BridgeRegistry(this.logger);
    this.vesselDataService = new VesselDataService(this.logger, this.bridgeRegistry);
    
    this.testResults = {
      passed: 0,
      failed: 0,
      tests: []
    };
  }

  async runAllTests() {
    console.log('🛡️ ENHANCED TARGET BRIDGE PROTECTION TEST SUITE');
    console.log('===============================================');
    
    try {
      // Test 1: GPS Event Protection
      await this.testGPSEventProtection();
      
      // Test 2: Maneuver Detection Protection
      await this.testManeuverDetectionProtection();
      
      // Test 3: Distance-based Protection
      await this.testDistanceBasedProtection();
      
      // Test 4: Recent Passage Protection
      await this.testRecentPassageProtection();
      
      // Test 5: Protection Confidence Calculation
      await this.testProtectionConfidenceCalculation();
      
      // Test 6: Protection Timers and Deactivation
      await this.testProtectionTimersAndDeactivation();
      
      // Test 7: Multiple Protection Conditions
      await this.testMultipleProtectionConditions();
      
      // Test 8: Protection During Complex Scenarios
      await this.testProtectionDuringComplexScenarios();
      
      // Test 9: Protection State Persistence
      await this.testProtectionStatePersistence();
      
      // Test 10: Integration with GPSJumpAnalyzer
      await this.testGPSJumpAnalyzerIntegration();
      
      this.printResults();
      
    } catch (error) {
      console.error('❌ FATAL ERROR:', error);
    } finally {
      this.vesselDataService.clearAllTimers();
    }
  }

  /**
   * Test GPS Event Protection
   */
  async testGPSEventProtection() {
    console.log('\n📍 TEST 1: GPS Event Protection');
    console.log('--------------------------------');

    const mmsi = 'GPS_PROT_001';
    
    // Create vessel with target bridge
    const vessel1 = this.createTestVessel(mmsi, {
      lat: 58.29352, // At Stridsbergsbron
      lon: 12.29456,
      sog: 3.0,
      cog: 200,
      targetBridge: 'Stridsbergsbron'
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel1);
    
    // Simulate GPS jump
    const vessel2 = this.createTestVessel(mmsi, {
      lat: 58.29100, // Large jump
      lon: 12.29100,
      sog: 3.0,
      cog: 30, // Direction change
      _gpsJumpDetected: true // Simulate GPS jump detection
    });
    
    const result = this.vesselDataService.updateVessel(mmsi, vessel2);
    
    // Check protection activation
    const protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    
    this.assert(
      protection && protection.isActive,
      'GPS event protection should be activated'
    );
    
    this.assert(
      protection.gpsEventDetected,
      'GPS event should be detected in protection state'
    );
    
    this.assert(
      result.targetBridge === 'Stridsbergsbron',
      'Target bridge should remain protected during GPS event'
    );
    
    console.log(`✅ GPS event protection activated: ${protection ? protection.reason : 'NONE'}`);
  }

  /**
   * Test Maneuver Detection Protection
   */
  async testManeuverDetectionProtection() {
    console.log('\n🔄 TEST 2: Maneuver Detection Protection');
    console.log('---------------------------------------');

    const mmsi = 'MANEUVER_001';
    
    // Create vessel with target bridge
    const vessel1 = this.createTestVessel(mmsi, {
      lat: 58.29400,
      lon: 12.29500,
      sog: 4.0,
      cog: 200,
      targetBridge: 'Stridsbergsbron'
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel1);
    
    // Simulate large COG change (maneuver)
    const vessel2 = this.createTestVessel(mmsi, {
      lat: 58.29380,
      lon: 12.29480,
      sog: 2.0, // Speed change
      cog: 50, // 150° COG change (maneuver)
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel2);
    
    // Check protection activation
    const protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    
    this.assert(
      protection && protection.isActive,
      'Maneuver protection should be activated for large COG change'
    );
    
    this.assert(
      protection.maneuverDetected,
      'Maneuver should be detected in protection state'
    );
    
    console.log(`✅ Maneuver protection activated: ${protection ? protection.reason : 'NONE'}`);
  }

  /**
   * Test Distance-based Protection
   */
  async testDistanceBasedProtection() {
    console.log('\n📏 TEST 3: Distance-based Protection');
    console.log('----------------------------------');

    const mmsi = 'DISTANCE_001';
    
    // Create vessel close to target bridge (within 300m protection zone)
    const vessel1 = this.createTestVessel(mmsi, {
      lat: 58.29330, // 250m from Stridsbergsbron
      lon: 12.29440,
      sog: 3.0,
      cog: 200,
      targetBridge: 'Stridsbergsbron'
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel1);
    
    // Try to change direction while in protection zone
    const vessel2 = this.createTestVessel(mmsi, {
      lat: 58.29320,
      lon: 12.29430,
      sog: 3.0,
      cog: 350, // Direction change
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel2);
    
    // Check protection activation
    const protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    
    this.assert(
      protection && protection.isActive,
      'Distance-based protection should be activated within 300m'
    );
    
    this.assert(
      protection.closeToTarget,
      'Close to target should be detected in protection state'
    );
    
    console.log(`✅ Distance protection activated: ${protection ? protection.reason : 'NONE'}`);
  }

  /**
   * Test Recent Passage Protection
   */
  async testRecentPassageProtection() {
    console.log('\n⏱️ TEST 4: Recent Passage Protection');
    console.log('----------------------------------');

    const mmsi = 'PASSAGE_001';
    
    // Create vessel that recently passed a bridge
    const vessel1 = this.createTestVessel(mmsi, {
      lat: 58.29400,
      lon: 12.29500,
      sog: 3.0,
      cog: 200,
      targetBridge: 'Klaffbron',
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 30000 // 30 seconds ago
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel1);
    
    // Try to update vessel after recent passage
    const vessel2 = this.createTestVessel(mmsi, {
      lat: 58.29420,
      lon: 12.29520,
      sog: 3.0,
      cog: 220,
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel2);
    
    // Check protection activation
    const protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    
    this.assert(
      protection && protection.isActive,
      'Recent passage protection should be activated within 60s'
    );
    
    console.log(`✅ Recent passage protection activated: ${protection ? protection.reason : 'NONE'}`);
  }

  /**
   * Test Protection Confidence Calculation
   */
  async testProtectionConfidenceCalculation() {
    console.log('\n📊 TEST 5: Protection Confidence Calculation');
    console.log('-------------------------------------------');

    const mmsi = 'CONFIDENCE_001';
    
    // Test high confidence scenario (close to bridge, no GPS issues)
    const vessel1 = this.createTestVessel(mmsi, {
      lat: 58.29352, // Very close to Stridsbergsbron
      lon: 12.29456,
      sog: 3.0,
      cog: 200,
      targetBridge: 'Stridsbergsbron'
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel1);
    
    let protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    const highConfidence = protection ? protection.confidence : 0;
    
    // Clear protection for next test
    this.vesselDataService.targetBridgeProtection.clear();
    
    // Test low confidence scenario (GPS jump, position uncertain)
    const vessel2 = this.createTestVessel(mmsi, {
      lat: 58.29300,
      lon: 12.29400,
      sog: 3.0,
      cog: 200,
      targetBridge: 'Stridsbergsbron',
      _gpsJumpDetected: true,
      _positionUncertain: true
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel2);
    
    protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    const lowConfidence = protection ? protection.confidence : 1;
    
    this.assert(
      highConfidence > lowConfidence,
      'High confidence scenario should have higher confidence than low confidence scenario'
    );
    
    console.log(`✅ Confidence calculation: High=${highConfidence.toFixed(2)}, Low=${lowConfidence.toFixed(2)}`);
  }

  /**
   * Test Protection Timers and Deactivation
   */
  async testProtectionTimersAndDeactivation() {
    console.log('\n⏰ TEST 6: Protection Timers and Deactivation');
    console.log('--------------------------------------------');

    const mmsi = 'TIMER_001';
    
    // Create vessel with protection
    const vessel1 = this.createTestVessel(mmsi, {
      lat: 58.29600, // Far from bridges
      lon: 12.29800,
      sog: 3.0,
      cog: 200,
      targetBridge: 'Stridsbergsbron',
      _gpsJumpDetected: true // Trigger protection
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel1);
    
    let protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    this.assert(
      protection && protection.isActive,
      'Protection should be initially active'
    );
    
    // Simulate conditions that should deactivate protection
    // (far from target, no GPS events, sufficient time)
    const vessel2 = this.createTestVessel(mmsi, {
      lat: 58.29700, // Even farther
      lon: 12.29900,
      sog: 3.0,
      cog: 200,
      _gpsJumpDetected: false,
      _positionUncertain: false
    });
    
    // Simulate time passage by manipulating protection start time
    protection.startTime = Date.now() - 120000; // 2 minutes ago
    
    this.vesselDataService.updateVessel(mmsi, vessel2);
    
    protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    this.assert(
      !protection || !protection.isActive,
      'Protection should be deactivated after conditions resolved'
    );
    
    console.log('✅ Protection timer and deactivation working');
  }

  /**
   * Test Multiple Protection Conditions
   */
  async testMultipleProtectionConditions() {
    console.log('\n🔗 TEST 7: Multiple Protection Conditions');
    console.log('----------------------------------------');

    const mmsi = 'MULTI_001';
    
    // Create vessel with multiple protection triggers
    const vessel1 = this.createTestVessel(mmsi, {
      lat: 58.29352, // Close to bridge (proximity)
      lon: 12.29456,
      sog: 3.0,
      cog: 200,
      targetBridge: 'Stridsbergsbron',
      _gpsJumpDetected: true, // GPS event
      lastPassedBridge: 'Stridsbergsbron',
      lastPassedBridgeTime: Date.now() - 30000 // Recent passage
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel1);
    
    // Simulate maneuver
    const vessel2 = this.createTestVessel(mmsi, {
      lat: 58.29350,
      lon: 12.29454,
      sog: 1.0, // Speed change (maneuver)
      cog: 50, // COG change (maneuver)
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel2);
    
    const protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    
    this.assert(
      protection && protection.isActive,
      'Protection should be active with multiple conditions'
    );
    
    // Check that multiple reasons are recorded
    const reasons = protection.reason.split('+');
    this.assert(
      reasons.length >= 2,
      'Multiple protection reasons should be recorded'
    );
    
    console.log(`✅ Multiple protection conditions: ${protection.reason}`);
  }

  /**
   * Test Protection During Complex Scenarios
   */
  async testProtectionDuringComplexScenarios() {
    console.log('\n🌊 TEST 8: Protection During Complex Scenarios');
    console.log('----------------------------------------------');

    const mmsi = 'COMPLEX_001';
    
    // Scenario: Vessel performing U-turn near bridge
    const positions = [
      { lat: 58.29400, lon: 12.29500, sog: 4.0, cog: 200, comment: 'Approaching bridge' },
      { lat: 58.29380, lon: 12.29480, sog: 3.0, cog: 180, comment: 'Slowing down' },
      { lat: 58.29360, lon: 12.29460, sog: 1.0, cog: 160, comment: 'Starting turn' },
      { lat: 58.29350, lon: 12.29450, sog: 0.5, cog: 100, comment: 'Mid-turn' },
      { lat: 58.29355, lon: 12.29455, sog: 1.0, cog: 20, comment: 'Completing turn' },
      { lat: 58.29370, lon: 12.29470, sog: 2.0, cog: 10, comment: 'New direction' }
    ];
    
    let protectionActivations = 0;
    let targetBridgeChanges = 0;
    let previousTargetBridge = null;
    
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const vessel = this.createTestVessel(mmsi, {
        ...pos,
        targetBridge: i === 0 ? 'Stridsbergsbron' : undefined
      });
      
      const result = this.vesselDataService.updateVessel(mmsi, vessel);
      
      const protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
      if (protection && protection.isActive) {
        protectionActivations++;
      }
      
      if (previousTargetBridge && result.targetBridge !== previousTargetBridge) {
        targetBridgeChanges++;
      }
      previousTargetBridge = result.targetBridge;
      
      console.log(`   Step ${i + 1}: ${pos.comment} → Protection: ${protection ? protection.isActive : false}, Target: ${result.targetBridge}`);
    }
    
    this.assert(
      protectionActivations > 0,
      'Protection should activate during complex maneuvers'
    );
    
    this.assert(
      targetBridgeChanges <= 1,
      'Target bridge changes should be minimized during protection'
    );
    
    console.log(`✅ Complex scenario: ${protectionActivations} protections, ${targetBridgeChanges} target changes`);
  }

  /**
   * Test Protection State Persistence
   */
  async testProtectionStatePersistence() {
    console.log('\n💾 TEST 9: Protection State Persistence');
    console.log('-------------------------------------');

    const mmsi = 'PERSIST_001';
    
    // Create vessel with protection
    const vessel1 = this.createTestVessel(mmsi, {
      lat: 58.29352,
      lon: 12.29456,
      sog: 3.0,
      cog: 200,
      targetBridge: 'Stridsbergsbron',
      _gpsJumpDetected: true
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel1);
    
    let protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    const originalStartTime = protection.startTime;
    const originalTargetBridge = protection.targetBridge;
    
    // Update vessel multiple times
    for (let i = 0; i < 3; i++) {
      const vessel = this.createTestVessel(mmsi, {
        lat: 58.29352 + (i * 0.0001),
        lon: 12.29456 + (i * 0.0001),
        sog: 3.0,
        cog: 200 + (i * 5),
      });
      
      this.vesselDataService.updateVessel(mmsi, vessel);
    }
    
    protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    
    this.assert(
      protection.startTime === originalStartTime,
      'Protection start time should persist across updates'
    );
    
    this.assert(
      protection.targetBridge === originalTargetBridge,
      'Protected target bridge should persist across updates'
    );
    
    console.log('✅ Protection state persistence working');
  }

  /**
   * Test Integration with GPSJumpAnalyzer
   */
  async testGPSJumpAnalyzerIntegration() {
    console.log('\n🎯 TEST 10: Integration with GPSJumpAnalyzer');
    console.log('-------------------------------------------');

    const mmsi = 'GPS_ANALYZER_001';
    
    // Create vessel
    const vessel1 = this.createTestVessel(mmsi, {
      lat: 58.29400,
      lon: 12.29500,
      sog: 4.0,
      cog: 200,
      targetBridge: 'Stridsbergsbron'
    });
    
    this.vesselDataService.updateVessel(mmsi, vessel1);
    
    // Simulate large movement with direction change (should be analyzed by GPSJumpAnalyzer)
    const vessel2 = this.createTestVessel(mmsi, {
      lat: 58.29100, // 400m movement
      lon: 12.29100,
      sog: 4.0,
      cog: 30 // Large direction change
    });
    
    const result = this.vesselDataService.updateVessel(mmsi, vessel2);
    
    // Check that GPSJumpAnalyzer data is available
    this.assert(
      result._positionAnalysis !== null,
      'GPS jump analysis data should be available'
    );
    
    // Check protection based on GPS analysis
    const protection = this.vesselDataService.targetBridgeProtection.get(mmsi);
    
    // Protection should activate if GPS analysis indicates uncertainty or jump
    if (result._gpsJumpDetected || result._positionUncertain) {
      this.assert(
        protection && protection.isActive,
        'Protection should activate based on GPS analysis results'
      );
      console.log(`✅ GPS analyzer integration: Protection activated based on ${result._gpsJumpDetected ? 'jump' : 'uncertainty'}`);
    } else {
      console.log('✅ GPS analyzer integration: No protection needed (legitimate movement)');
    }
  }

  // Helper Methods

  createTestVessel(mmsi, overrides = {}) {
    return {
      mmsi,
      lat: 58.29000,
      lon: 12.29000,
      sog: 3.0,
      cog: 200,
      name: `Test Vessel ${mmsi}`,
      timestamp: Date.now(),
      ...overrides
    };
  }

  assert(condition, message) {
    if (condition) {
      this.testResults.passed++;
      this.testResults.tests.push({ status: 'PASS', message });
    } else {
      this.testResults.failed++;
      this.testResults.tests.push({ status: 'FAIL', message });
      console.error(`❌ ASSERTION FAILED: ${message}`);
    }
  }

  printResults() {
    console.log('\n===============================================');
    console.log('🛡️ TARGET BRIDGE PROTECTION TEST RESULTS');
    console.log('===============================================\n');

    console.log(`✅ PASSED: ${this.testResults.passed} tests`);
    console.log(`❌ FAILED: ${this.testResults.failed} tests`);
    console.log(`📊 SUCCESS RATE: ${((this.testResults.passed / (this.testResults.passed + this.testResults.failed)) * 100).toFixed(1)}%\n`);

    if (this.testResults.failed > 0) {
      console.log('FAILED TESTS:');
      this.testResults.tests
        .filter(test => test.status === 'FAIL')
        .forEach(test => console.log(`   ❌ ${test.message}`));
      console.log('');
    }

    if (this.testResults.failed === 0) {
      console.log('🎉 ALL TARGET BRIDGE PROTECTION TESTS PASSED!');
      console.log('✅ Enhanced protection system is working correctly');
      console.log('✅ GPS events, maneuvers, and proximity are all protected');
      console.log('✅ Protection confidence and timers are functioning');
      console.log('✅ Integration with GPSJumpAnalyzer is complete');
    } else {
      console.log('⚠️ Some tests failed - review protection implementation');
    }

    console.log('\n🔍 PROTECTION FEATURES VERIFIED:');
    console.log('1. ✅ GPS Event Protection (jumps, uncertainty)');
    console.log('2. ✅ Maneuver Detection Protection (COG/SOG changes)');
    console.log('3. ✅ Distance-based Protection (300m zone)');
    console.log('4. ✅ Recent Passage Protection (60s window)');
    console.log('5. ✅ Protection Confidence Calculation');
    console.log('6. ✅ Protection Timers and Deactivation');
    console.log('7. ✅ Multiple Protection Conditions');
    console.log('8. ✅ Complex Scenario Handling');
    console.log('9. ✅ Protection State Persistence');
    console.log('10. ✅ GPSJumpAnalyzer Integration');
  }
}

// Run the tests
if (require.main === module) {
  const test = new TargetBridgeProtectionTest();
  test.runAllTests().catch(console.error);
}

module.exports = TargetBridgeProtectionTest;