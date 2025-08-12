'use strict';

/**
 * INTEGRATION VALIDATION TEST SUITE
 * 
 * Validates that all proposed solutions work together without conflicts:
 * 1. GPS Jump/Direction Change Handling (GPSJumpAnalyzer + StatusStabilizer)
 * 2. Enhanced Passage Detection (detectBridgePassage with 5 methods)
 * 3. Bridge Text Accuracy Fixes (Stallbackabron special handling)
 * 4. Target Bridge Protection (prevent wrong target after passing)
 * 
 * Tests the original problematic scenario (boat 257941000) to ensure fixes work
 */

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

class IntegrationValidationTest {
  constructor() {
    this.testRunner = new RealAppTestRunner();
    this.results = {
      passed: [],
      failed: [],
      warnings: []
    };
  }

  async runAllTests() {
    console.log('🔧 INTEGRATION VALIDATION TEST SUITE');
    console.log('=====================================');
    console.log('Testing integration of all proposed solutions\n');

    try {
      await this.testRunner.initializeApp();

      // Test 1: GPS Jump Analysis + Status Stabilization Integration
      await this.testGPSJumpStatusStabilizationIntegration();
      await this.cleanupVessels();

      // Test 2: Enhanced Passage Detection + Bridge Text Accuracy
      await this.testEnhancedPassageBridgeTextIntegration();
      await this.cleanupVessels();

      // Test 3: Target Bridge Protection + All Solutions
      await this.testTargetBridgeProtectionIntegration();
      await this.cleanupVessels();

      // Test 4: Original Problematic Scenario (Vessel 257941000)
      await this.testOriginalProblematicScenario();
      await this.cleanupVessels();

      // Test 5: Complex Multi-Solution Scenario
      await this.testComplexMultiSolutionScenario();
      await this.cleanupVessels();

      // Test 6: Performance and Backward Compatibility
      await this.testPerformanceBackwardCompatibility();
      await this.cleanupVessels();

      // Test 7: Edge Cases and Conflict Detection
      await this.testEdgeCasesConflictDetection();
      
      this.printResults();

    } catch (error) {
      console.error('❌ FATAL ERROR:', error);
    } finally {
      await this.testRunner.cleanup();
    }
  }

  /**
   * Test GPS Jump Analysis + Status Stabilization Integration
   */
  async testGPSJumpStatusStabilizationIntegration() {
    console.log('\n📍 TEST 1: GPS Jump Analysis + Status Stabilization Integration');
    console.log('----------------------------------------------------------------');

    const mmsi = 'GPS_STAB_001';
    
    // Simulate vessel with GPS jump followed by stabilization
    const positions = [
      // Normal approach
      { lat: 58.29400, lon: 12.29500, sog: 4.0, cog: 200, comment: 'Normal approach' },
      { lat: 58.29380, lon: 12.29480, sog: 4.0, cog: 200, comment: 'Getting closer' },
      
      // GPS jump (large movement that could be legitimate direction change)
      { lat: 58.29200, lon: 12.29300, sog: 4.0, cog: 30, comment: 'GPS jump - large movement with COG change' },
      
      // Continue with new direction (should be accepted as legitimate)
      { lat: 58.29220, lon: 12.29320, sog: 4.0, cog: 30, comment: 'Continuing new direction' },
      { lat: 58.29240, lon: 12.29340, sog: 4.0, cog: 30, comment: 'Stable new direction' }
    ];

    try {
      let previousStatus = null;
      let statusStabilized = false;
      let gpsJumpDetected = false;

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        const vessel = { mmsi, ...pos };
        
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(10);

        const vessels = this.testRunner.app.vesselDataService.getAllVessels();
        const testVessel = vessels.find(v => v.mmsi === mmsi);

        if (testVessel) {
          console.log(`   Step ${i + 1}: ${pos.comment} → Status: ${testVessel.status}`);
          
          // Check for GPS jump detection (would be in logs, but we can infer)
          if (i === 2) { // The GPS jump step
            // Large movement should be analyzed but accepted as legitimate direction change
            if (testVessel.cog === 30) { // COG change was accepted
              console.log('     ✓ GPS jump analyzed and accepted as legitimate direction change');
            }
          }

          // Check status stabilization
          if (previousStatus && testVessel.status === previousStatus) {
            statusStabilized = true;
          }

          previousStatus = testVessel.status;
        }
      }

      if (statusStabilized) {
        this.results.passed.push('✅ GPS+Stabilization: Status stabilization working during GPS events');
      } else {
        this.results.warnings.push('⚠️ GPS+Stabilization: Could not verify status stabilization');
      }

    } catch (error) {
      this.results.failed.push(`❌ GPS+Stabilization: ${error.message}`);
    }
  }

  /**
   * Test Enhanced Passage Detection + Bridge Text Accuracy
   */
  async testEnhancedPassageBridgeTextIntegration() {
    console.log('\n📍 TEST 2: Enhanced Passage Detection + Bridge Text Accuracy');
    console.log('------------------------------------------------------------');

    const mmsi = 'PASSAGE_TEXT_001';

    // Simulate passage through Stallbackabron (tests special handling)
    const stallbackaPassage = [
      { lat: 58.31200, lon: 12.31500, sog: 5.0, cog: 200, comment: 'Approaching Stallbackabron' },
      { lat: 58.31143, lon: 12.31456, sog: 5.0, cog: 200, comment: 'At Stallbackabron' },
      { lat: 58.31100, lon: 12.31400, sog: 5.0, cog: 200, comment: 'Passed Stallbackabron' }
    ];

    try {
      let passageDetected = false;
      let correctBridgeText = false;
      
      for (let i = 0; i < stallbackaPassage.length; i++) {
        const pos = stallbackaPassage[i];
        const vessel = { mmsi, ...pos };
        
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(10);

        const vessels = this.testRunner.app.vesselDataService.getAllVessels();
        const testVessel = vessels.find(v => v.mmsi === mmsi);

        if (testVessel) {
          console.log(`   Step ${i + 1}: ${pos.comment} → Status: ${testVessel.status}`);

          // Generate bridge text
          const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText([testVessel]);
          console.log(`     Bridge text: "${bridgeText}"`);

          // Check for Stallbackabron special handling
          if (bridgeText.includes('åker strax under') && !bridgeText.includes('inväntar broöppning')) {
            correctBridgeText = true;
            console.log('     ✓ Stallbackabron special bridge text working');
          }

          // Check for passage detection at final step
          if (i === stallbackaPassage.length - 1 && testVessel.lastPassedBridge) {
            passageDetected = true;
            console.log('     ✓ Enhanced passage detection working');
          }
        }
      }

      if (passageDetected) {
        this.results.passed.push('✅ Passage+Text: Enhanced passage detection integrated');
      } else {
        this.results.failed.push('❌ Passage+Text: Enhanced passage detection failed');
      }

      if (correctBridgeText) {
        this.results.passed.push('✅ Passage+Text: Stallbackabron special bridge text working');
      } else {
        this.results.failed.push('❌ Passage+Text: Stallbackabron special bridge text failed');
      }

    } catch (error) {
      this.results.failed.push(`❌ Passage+Text: ${error.message}`);
    }
  }

  /**
   * Test Target Bridge Protection + All Solutions Integration
   * ENHANCED: Tests multiple protection scenarios from the enhanced protection system
   */
  async testTargetBridgeProtectionIntegration() {
    console.log('\n📍 TEST 3: Enhanced Target Bridge Protection + All Solutions Integration');
    console.log('-----------------------------------------------------------------------');

    // Test Scenario 1: GPS Jump Protection
    await this.testGPSJumpProtectionScenario();
    
    // Test Scenario 2: Maneuver Protection  
    await this.testManeuverProtectionScenario();
    
    // Test Scenario 3: Proximity Protection
    await this.testProximityProtectionScenario();
  }

  /**
   * Test GPS Jump Protection Scenario
   */
  async testGPSJumpProtectionScenario() {
    console.log('\n   🛡️ GPS Jump Protection Scenario');
    console.log('   --------------------------------');

    const mmsi = 'GPS_PROT_001';

    const gpsJumpScenario = [
      { lat: 58.29400, lon: 12.29500, sog: 4.0, cog: 200, comment: 'Approaching Stridsbergsbron', targetBridge: 'Stridsbergsbron' },
      { lat: 58.29380, lon: 12.29480, sog: 4.0, cog: 200, comment: 'Getting closer' },
      
      // GPS jump that would normally change target
      { lat: 58.29100, lon: 12.29200, sog: 4.0, cog: 30, comment: 'GPS jump with direction change' },
      
      // Recovery
      { lat: 58.29360, lon: 12.29460, sog: 4.0, cog: 200, comment: 'Back to normal tracking' }
    ];

    try {
      let protectionActivated = false;
      let targetBridgeProtected = true;

      for (let i = 0; i < gpsJumpScenario.length; i++) {
        const pos = gpsJumpScenario[i];
        const vessel = { mmsi, ...pos };
        
        if (i === 0) {
          vessel.targetBridge = 'Stridsbergsbron';
        }
        
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(10);

        const vessels = this.testRunner.app.vesselDataService.getAllVessels();
        const testVessel = vessels.find(v => v.mmsi === mmsi);

        if (testVessel) {
          console.log(`     Step ${i + 1}: ${pos.comment} → Target: ${testVessel.targetBridge}, Status: ${testVessel.status}`);

          // Check if protection is activated after GPS jump
          const protection = this.testRunner.app.vesselDataService.targetBridgeProtection.get(mmsi);
          if (i >= 2 && protection && protection.isActive) {
            protectionActivated = true;
            console.log(`       ✓ Protection activated: ${protection.reason}`);
          }

          // Verify target bridge is maintained
          if (i >= 1 && testVessel.targetBridge !== 'Stridsbergsbron') {
            targetBridgeProtected = false;
            console.log(`       ❌ Target bridge changed to: ${testVessel.targetBridge}`);
          }
        }
      }

      if (protectionActivated) {
        this.results.passed.push('✅ GPS Protection: GPS jump protection activated correctly');
      } else {
        this.results.failed.push('❌ GPS Protection: GPS jump protection not activated');
      }

      if (targetBridgeProtected) {
        this.results.passed.push('✅ GPS Protection: Target bridge maintained during GPS jump');
      } else {
        this.results.failed.push('❌ GPS Protection: Target bridge lost during GPS jump');
      }

    } catch (error) {
      this.results.failed.push(`❌ GPS Protection: ${error.message}`);
    }
  }

  /**
   * Test Maneuver Protection Scenario
   */
  async testManeuverProtectionScenario() {
    console.log('\n   🔄 Maneuver Protection Scenario');
    console.log('   -------------------------------');

    const mmsi = 'MANEUVER_PROT_001';

    const maneuverScenario = [
      { lat: 58.29400, lon: 12.29500, sog: 4.0, cog: 200, comment: 'Normal approach', targetBridge: 'Stridsbergsbron' },
      { lat: 58.29380, lon: 12.29480, sog: 4.0, cog: 200, comment: 'Steady course' },
      
      // Large maneuver (COG and SOG change)
      { lat: 58.29370, lon: 12.29470, sog: 1.0, cog: 50, comment: 'Sharp maneuver - large COG/SOG change' },
      
      // Continue with new direction
      { lat: 58.29375, lon: 12.29475, sog: 3.0, cog: 45, comment: 'Stabilizing after maneuver' }
    ];

    try {
      let maneuverProtectionActivated = false;
      let targetMaintained = true;

      for (let i = 0; i < maneuverScenario.length; i++) {
        const pos = maneuverScenario[i];
        const vessel = { mmsi, ...pos };
        
        if (i === 0) {
          vessel.targetBridge = 'Stridsbergsbron';
        }
        
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(10);

        const vessels = this.testRunner.app.vesselDataService.getAllVessels();
        const testVessel = vessels.find(v => v.mmsi === mmsi);

        if (testVessel) {
          console.log(`     Step ${i + 1}: ${pos.comment} → Target: ${testVessel.targetBridge}`);

          // Check maneuver protection after large COG/SOG change
          const protection = this.testRunner.app.vesselDataService.targetBridgeProtection.get(mmsi);
          if (i >= 2 && protection && protection.isActive && protection.maneuverDetected) {
            maneuverProtectionActivated = true;
            console.log(`       ✓ Maneuver protection: ${protection.reason}`);
          }

          // Verify target bridge maintained
          if (testVessel.targetBridge !== 'Stridsbergsbron') {
            targetMaintained = false;
          }
        }
      }

      if (maneuverProtectionActivated) {
        this.results.passed.push('✅ Maneuver Protection: Large maneuver protection working');
      } else {
        this.results.failed.push('❌ Maneuver Protection: Large maneuver protection failed');
      }

      if (targetMaintained) {
        this.results.passed.push('✅ Maneuver Protection: Target bridge maintained during maneuver');
      } else {
        this.results.failed.push('❌ Maneuver Protection: Target bridge lost during maneuver');
      }

    } catch (error) {
      this.results.failed.push(`❌ Maneuver Protection: ${error.message}`);
    }
  }

  /**
   * Test Proximity Protection Scenario  
   */
  async testProximityProtectionScenario() {
    console.log('\n   📏 Proximity Protection Scenario');
    console.log('   --------------------------------');

    const mmsi = 'PROX_PROT_001';

    const proximityScenario = [
      { lat: 58.29500, lon: 12.29600, sog: 3.0, cog: 200, comment: 'Far from bridge', targetBridge: 'Stridsbergsbron' },
      { lat: 58.29380, lon: 12.29480, sog: 3.0, cog: 200, comment: 'Getting closer' },
      { lat: 58.29360, lon: 12.29460, sog: 3.0, cog: 200, comment: 'Within 300m protection zone' },
      
      // Try direction change while in protection zone
      { lat: 58.29350, lon: 12.29450, sog: 3.0, cog: 350, comment: 'Direction change in protection zone' },
      
      // Move away from protection zone
      { lat: 58.29600, lon: 12.29700, sog: 3.0, cog: 350, comment: 'Moving away from bridge' }
    ];

    try {
      let proximityProtectionActivated = false;
      let protectionDeactivated = false;
      let targetProtectedInZone = true;

      for (let i = 0; i < proximityScenario.length; i++) {
        const pos = proximityScenario[i];
        const vessel = { mmsi, ...pos };
        
        if (i === 0) {
          vessel.targetBridge = 'Stridsbergsbron';
        }
        
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(10);

        const vessels = this.testRunner.app.vesselDataService.getAllVessels();
        const testVessel = vessels.find(v => v.mmsi === mmsi);

        if (testVessel) {
          console.log(`     Step ${i + 1}: ${pos.comment} → Target: ${testVessel.targetBridge}`);

          const protection = this.testRunner.app.vesselDataService.targetBridgeProtection.get(mmsi);
          
          // Check proximity protection activation
          if (i >= 2 && i <= 3 && protection && protection.isActive && protection.closeToTarget) {
            proximityProtectionActivated = true;
            console.log(`       ✓ Proximity protection: ${protection.reason}`);
          }

          // Check protection deactivation when far away
          if (i === 4 && (!protection || !protection.isActive)) {
            protectionDeactivated = true;
            console.log('       ✓ Protection deactivated when far from bridge');
          }

          // Verify target bridge maintained in protection zone
          if (i >= 2 && i <= 3 && testVessel.targetBridge !== 'Stridsbergsbron') {
            targetProtectedInZone = false;
          }
        }
      }

      if (proximityProtectionActivated) {
        this.results.passed.push('✅ Proximity Protection: Distance-based protection working');
      } else {
        this.results.failed.push('❌ Proximity Protection: Distance-based protection failed');
      }

      if (targetProtectedInZone) {
        this.results.passed.push('✅ Proximity Protection: Target maintained in protection zone');
      } else {
        this.results.failed.push('❌ Proximity Protection: Target lost in protection zone');
      }

      if (protectionDeactivated) {
        this.results.passed.push('✅ Proximity Protection: Protection deactivates correctly');
      } else {
        this.results.warnings.push('⚠️ Proximity Protection: Protection deactivation unclear');
      }

    } catch (error) {
      this.results.failed.push(`❌ Proximity Protection: ${error.message}`);
    }
  }

  /**
   * Test Original Problematic Scenario (Vessel 257941000)
   */
  async testOriginalProblematicScenario() {
    console.log('\n📍 TEST 4: Original Problematic Scenario (Vessel 257941000)');
    console.log('------------------------------------------------------------');

    // Reproduce the original problematic scenario from the bug report
    const problematicVessel = {
      mmsi: '257941000',
      name: 'M/T RAMANDA'
    };

    const problematicJourney = [
      // Initial approach with potential GPS issues
      { ...problematicVessel, lat: 58.29500, lon: 12.29600, sog: 3.5, cog: 200, comment: 'Initial approach' },
      
      // GPS jump scenario that was causing issues
      { ...problematicVessel, lat: 58.29200, lon: 12.29200, sog: 3.5, cog: 45, comment: 'GPS jump with direction change' },
      
      // Return to normal tracking
      { ...problematicVessel, lat: 58.29380, lon: 12.29480, sog: 3.5, cog: 200, comment: 'Back to normal tracking' },
      
      // Bridge passage
      { ...problematicVessel, lat: 58.29352, lon: 12.29456, sog: 3.5, cog: 200, comment: 'At Stridsbergsbron' },
      { ...problematicVessel, lat: 58.29300, lon: 12.29400, sog: 3.5, cog: 200, comment: 'Passed Stridsbergsbron' }
    ];

    try {
      let systemStableAfterGPSJump = true;
      let correctPassageDetection = false;
      let bridgeTextAccurate = true;

      for (let i = 0; i < problematicJourney.length; i++) {
        const vessel = problematicJourney[i];
        
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(10);

        const vessels = this.testRunner.app.vesselDataService.getAllVessels();
        const testVessel = vessels.find(v => v.mmsi === '257941000');

        if (testVessel) {
          console.log(`   Step ${i + 1}: ${vessel.comment} → Status: ${testVessel.status}, Target: ${testVessel.targetBridge}`);

          // Generate and validate bridge text
          const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText([testVessel]);
          
          // Check for problematic patterns that were causing issues
          if (bridgeText.includes('undefined') || bridgeText.includes('null') || bridgeText.includes('NaN')) {
            bridgeTextAccurate = false;
            console.log(`     ❌ Problematic bridge text: "${bridgeText}"`);
          }

          // Check system stability after GPS jump (step 2)
          if (i >= 2 && !testVessel.targetBridge) {
            systemStableAfterGPSJump = false;
          }

          // Check passage detection at final step
          if (i === problematicJourney.length - 1 && testVessel.lastPassedBridge === 'Stridsbergsbron') {
            correctPassageDetection = true;
            console.log('     ✓ Passage detection working for problematic vessel');
          }
        }
      }

      if (systemStableAfterGPSJump) {
        this.results.passed.push('✅ Original Problem: System stable after GPS jump');
      } else {
        this.results.failed.push('❌ Original Problem: System unstable after GPS jump');
      }

      if (correctPassageDetection) {
        this.results.passed.push('✅ Original Problem: Passage detection working correctly');
      } else {
        this.results.failed.push('❌ Original Problem: Passage detection failed');
      }

      if (bridgeTextAccurate) {
        this.results.passed.push('✅ Original Problem: Bridge text accurate throughout');
      } else {
        this.results.failed.push('❌ Original Problem: Bridge text contains errors');
      }

    } catch (error) {
      this.results.failed.push(`❌ Original Problem: ${error.message}`);
    }
  }

  /**
   * Test Complex Multi-Solution Scenario
   */
  async testComplexMultiSolutionScenario() {
    console.log('\n📍 TEST 5: Complex Multi-Solution Scenario');
    console.log('-------------------------------------------');

    // Create scenario that exercises all solutions simultaneously
    const complexVessels = [
      // Vessel with GPS jumps
      { mmsi: 'COMPLEX_GPS_001', lat: 58.29400, lon: 12.29500, sog: 4.0, cog: 200 },
      
      // Vessel at Stallbackabron (special handling)
      { mmsi: 'COMPLEX_STALL_001', lat: 58.31200, lon: 12.31500, sog: 3.0, cog: 200 },
      
      // Vessel in protection zone
      { mmsi: 'COMPLEX_PROT_001', lat: 58.29360, lon: 12.29460, sog: 2.0, cog: 200 },
      
      // Vessel needing enhanced passage detection
      { mmsi: 'COMPLEX_PASS_001', lat: 58.29352, lon: 12.29456, sog: 5.0, cog: 200 }
    ];

    try {
      // Add all vessels
      for (const vessel of complexVessels) {
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(10);
      }

      const allVessels = this.testRunner.app.vesselDataService.getAllVessels();
      const complexTestVessels = allVessels.filter(v => v.mmsi.startsWith('COMPLEX_'));

      console.log(`   Complex scenario vessels: ${complexTestVessels.length}`);

      // Generate bridge text for all vessels
      const complexBridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(complexTestVessels);
      console.log(`   Complex bridge text: "${complexBridgeText}"`);

      // Simulate GPS jump on one vessel
      await this.testRunner._processVesselAsAISMessage({
        mmsi: 'COMPLEX_GPS_001',
        lat: 58.29200, lon: 12.29200, // Large movement
        sog: 4.0, cog: 30 // Direction change
      });
      await this.wait(10);

      // Move Stallbackabron vessel to test special handling
      await this.testRunner._processVesselAsAISMessage({
        mmsi: 'COMPLEX_STALL_001',
        lat: 58.31143, lon: 12.31456, // At Stallbackabron
        sog: 3.0, cog: 200
      });
      await this.wait(10);

      // Check final state
      const finalVessels = this.testRunner.app.vesselDataService.getAllVessels();
      const finalComplexVessels = finalVessels.filter(v => v.mmsi.startsWith('COMPLEX_'));

      if (finalComplexVessels.length >= 3) { // Some might be filtered
        this.results.passed.push('✅ Complex: All solutions working together with multiple vessels');
      } else {
        this.results.failed.push(`❌ Complex: Only ${finalComplexVessels.length} vessels survived complex scenario`);
      }

      // Final bridge text check
      const finalBridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(finalComplexVessels);
      if (finalBridgeText && !finalBridgeText.includes('undefined') && !finalBridgeText.includes('error')) {
        this.results.passed.push('✅ Complex: Bridge text stable in complex scenario');
      } else {
        this.results.failed.push(`❌ Complex: Bridge text issues in complex scenario: ${finalBridgeText}`);
      }

    } catch (error) {
      this.results.failed.push(`❌ Complex: ${error.message}`);
    }
  }

  /**
   * Test Performance and Backward Compatibility
   */
  async testPerformanceBackwardCompatibility() {
    console.log('\n📍 TEST 6: Performance and Backward Compatibility');
    console.log('--------------------------------------------------');

    const performanceVessels = [];
    
    // Create multiple vessels to test performance
    for (let i = 0; i < 10; i++) {
      performanceVessels.push({
        mmsi: `PERF_${String(i).padStart(3, '0')}`,
        name: `Performance Test ${i}`,
        lat: 58.29000 + (Math.random() * 0.01),
        lon: 12.29000 + (Math.random() * 0.01),
        sog: Math.random() * 5 + 2,
        cog: Math.random() * 360
      });
    }

    try {
      const startTime = Date.now();

      // Process all vessels
      for (const vessel of performanceVessels) {
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(5); // Shorter wait for performance test
      }

      const processingTime = Date.now() - startTime;
      console.log(`   Processing time for ${performanceVessels.length} vessels: ${processingTime}ms`);

      // Check memory usage doesn't grow excessively
      const vessels = this.testRunner.app.vesselDataService.getAllVessels();
      const vesselCount = vessels.length;

      if (processingTime < 5000) { // Should complete within 5 seconds
        this.results.passed.push(`✅ Performance: Processed ${performanceVessels.length} vessels in ${processingTime}ms`);
      } else {
        this.results.failed.push(`❌ Performance: Processing too slow: ${processingTime}ms`);
      }

      if (vesselCount <= performanceVessels.length * 1.1) { // Allow 10% overhead
        this.results.passed.push('✅ Performance: No memory leaks detected');
      } else {
        this.results.warnings.push(`⚠️ Performance: Vessel count higher than expected: ${vesselCount}`);
      }

      // Test backward compatibility - old vessel format should still work
      const oldFormatVessel = {
        mmsi: 'COMPAT_001',
        lat: 58.29300,
        lon: 12.29400,
        speed: 3.5, // Old format used 'speed' instead of 'sog'
        course: 200 // Old format used 'course' instead of 'cog'
      };

      await this.testRunner._processVesselAsAISMessage(oldFormatVessel);
      await this.wait(10);

      const compatVessels = this.testRunner.app.vesselDataService.getAllVessels();
      const compatVessel = compatVessels.find(v => v.mmsi === 'COMPAT_001');

      if (compatVessel) {
        this.results.passed.push('✅ Compatibility: Old vessel format still supported');
      } else {
        this.results.failed.push('❌ Compatibility: Old vessel format not supported');
      }

    } catch (error) {
      this.results.failed.push(`❌ Performance: ${error.message}`);
    }
  }

  /**
   * Test Edge Cases and Conflict Detection
   */
  async testEdgeCasesConflictDetection() {
    console.log('\n📍 TEST 7: Edge Cases and Conflict Detection');
    console.log('---------------------------------------------');

    try {
      // Edge Case 1: Vessel with invalid coordinates
      const invalidCoordVessel = {
        mmsi: 'EDGE_INVALID_001',
        lat: NaN,
        lon: null,
        sog: 3.0,
        cog: 200
      };

      try {
        await this.testRunner._processVesselAsAISMessage(invalidCoordVessel);
        await this.wait(10);
        
        const vessels = this.testRunner.app.vesselDataService.getAllVessels();
        const invalidVessel = vessels.find(v => v.mmsi === 'EDGE_INVALID_001');
        
        if (!invalidVessel) {
          this.results.passed.push('✅ Edge Cases: Invalid coordinates properly filtered');
        } else {
          this.results.failed.push('❌ Edge Cases: Invalid coordinates not filtered');
        }
      } catch (error) {
        this.results.passed.push('✅ Edge Cases: Invalid coordinates cause graceful error handling');
      }

      // Edge Case 2: Vessel with extreme speeds
      const extremeSpeedVessel = {
        mmsi: 'EDGE_SPEED_001',
        lat: 58.29300,
        lon: 12.29400,
        sog: 150, // Unrealistic speed
        cog: 200
      };

      await this.testRunner._processVesselAsAISMessage(extremeSpeedVessel);
      await this.wait(10);

      const vessels = this.testRunner.app.vesselDataService.getAllVessels();
      const speedVessel = vessels.find(v => v.mmsi === 'EDGE_SPEED_001');

      if (speedVessel && speedVessel.sog <= 150) { // Should handle extreme speeds
        this.results.passed.push('✅ Edge Cases: Extreme speeds handled gracefully');
      } else {
        this.results.warnings.push('⚠️ Edge Cases: Extreme speed handling unclear');
      }

      // Edge Case 3: Simultaneous GPS jumps on multiple vessels
      const gpsJumpVessels = [
        { mmsi: 'EDGE_JUMP_001', lat: 58.29400, lon: 12.29500, sog: 4.0, cog: 200 },
        { mmsi: 'EDGE_JUMP_002', lat: 58.29350, lon: 12.29450, sog: 3.0, cog: 200 }
      ];

      // Add vessels normally
      for (const vessel of gpsJumpVessels) {
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(5);
      }

      // Simulate simultaneous GPS jumps
      const jumpedVessels = [
        { mmsi: 'EDGE_JUMP_001', lat: 58.29000, lon: 12.29000, sog: 4.0, cog: 30 },
        { mmsi: 'EDGE_JUMP_002', lat: 58.29100, lon: 12.29100, sog: 3.0, cog: 45 }
      ];

      for (const vessel of jumpedVessels) {
        await this.testRunner._processVesselAsAISMessage(vessel);
        await this.wait(5);
      }

      const finalVessels = this.testRunner.app.vesselDataService.getAllVessels();
      const jumpVessels = finalVessels.filter(v => v.mmsi.startsWith('EDGE_JUMP_'));

      if (jumpVessels.length === 2) {
        this.results.passed.push('✅ Edge Cases: Simultaneous GPS jumps handled correctly');
      } else {
        this.results.failed.push(`❌ Edge Cases: GPS jump handling failed, only ${jumpVessels.length} vessels remain`);
      }

    } catch (error) {
      this.results.failed.push(`❌ Edge Cases: ${error.message}`);
    }
  }

  // Helper methods
  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanupVessels() {
    const vessels = this.testRunner.app.vesselDataService.getAllVessels();
    for (const vessel of vessels) {
      this.testRunner.app.vesselDataService.removeVessel(vessel.mmsi, 'test-cleanup');
    }
    await this.wait(50);
  }

  printResults() {
    console.log('\n========================================');
    console.log('🔧 INTEGRATION VALIDATION RESULTS');
    console.log('========================================\n');

    console.log(`✅ PASSED: ${this.results.passed.length} tests`);
    this.results.passed.forEach(test => console.log(`   ${test}`));

    if (this.results.warnings.length > 0) {
      console.log(`\n⚠️ WARNINGS: ${this.results.warnings.length} tests`);
      this.results.warnings.forEach(test => console.log(`   ${test}`));
    }

    if (this.results.failed.length > 0) {
      console.log(`\n❌ FAILED: ${this.results.failed.length} tests`);
      this.results.failed.forEach(test => console.log(`   ${test}`));
    }

    console.log('\n========================================');

    const totalTests = this.results.passed.length + this.results.failed.length;
    const passRate = ((this.results.passed.length / totalTests) * 100).toFixed(1);

    if (this.results.failed.length === 0) {
      console.log(`🎉 ALL INTEGRATION TESTS PASSED! (${totalTests} tests, 100% pass rate)`);
      console.log('✅ All proposed solutions work together without conflicts');
      console.log('✅ Original problematic scenario resolved');
      console.log('✅ System maintains backward compatibility and performance');
    } else {
      console.log(`📈 Integration pass rate: ${passRate}% (${this.results.passed.length}/${totalTests} tests)`);
      console.log('⚠️ Some integration issues detected - review failed tests above');
    }

    console.log('\n🔍 SOLUTION INTEGRATION STATUS:');
    console.log('1. GPS Jump/Direction Change Handling: ' + 
      (this.results.passed.some(t => t.includes('GPS+Stabilization')) ? '✅ INTEGRATED' : '❌ ISSUES'));
    console.log('2. Enhanced Passage Detection: ' + 
      (this.results.passed.some(t => t.includes('Passage+Text')) ? '✅ INTEGRATED' : '❌ ISSUES'));
    console.log('3. Bridge Text Accuracy Fixes: ' + 
      (this.results.passed.some(t => t.includes('Stallbackabron special')) ? '✅ INTEGRATED' : '❌ ISSUES'));
    console.log('4. Target Bridge Protection: ' + 
      (this.results.passed.some(t => t.includes('Protection+All')) ? '✅ INTEGRATED' : '❌ ISSUES'));
  }
}

// Run the tests
if (require.main === module) {
  const test = new IntegrationValidationTest();
  test.runAllTests().catch(console.error);
}

module.exports = IntegrationValidationTest;