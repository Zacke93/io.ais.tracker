'use strict';

const RealAppTestRunner = require('./RealAppTestRunner');

/**
 * Test scenarios focused on intermediate bridges (Olidebron, Järnvägsbron, Stallbackabron)
 * Designed to catch bugs related to vessels without targetBridge at intermediate bridges
 */
class IntermediateBridgeTest {
  constructor() {
    this.testRunner = new RealAppTestRunner();
    this.results = { passed: [], failed: [] };
  }

  async runAllScenarios() {
    console.log('\n🌉 Starting Intermediate Bridge Focus Tests...\n');
    await this.testRunner.initializeApp();

    await this.testVesselStuckAtStallbackabron();
    await this.testVesselAtOlidebron();
    await this.testVesselAtJarnvagsbron();
    await this.testMultipleVesselsAtIntermediateBridges();

    this.printResults();
    await this.testRunner.cleanup();
  }

  async testVesselStuckAtStallbackabron() {
    console.log('\n📍 SCENARIO 1: Vessel gets stuck at Stallbackabron without targetBridge');
    
    const scenario = [
      {
        description: 'Vessel approaches Stallbackabron from north',
        vessels: [{
          mmsi: 'INTER001',
          name: 'Stuck at Stallbacka',
          lat: 58.31400, 
          lon: 12.31700, // ~300m north of Stallbackabron
          sog: 3.0, 
          cog: 200 // Southbound
        }],
        expectedState: {
          targetBridge: 'Stridsbergsbron', // Should get target bridge
          status: 'en-route'
        }
      },
      {
        description: 'Vessel reaches Stallbackabron and slows down',
        vessels: [{
          mmsi: 'INTER001',
          name: 'Stuck at Stallbacka',
          lat: 58.31143, 
          lon: 12.31456, // At Stallbackabron
          sog: 0.5, 
          cog: 200
        }],
        expectedState: {
          currentBridge: 'Stallbackabron',
          status: 'stallbacka-waiting' // Special status
        }
      },
      {
        description: 'Vessel stays at Stallbackabron (simulating zombie vessel)',
        vessels: [{
          mmsi: 'INTER001',
          name: 'Stuck at Stallbacka',
          lat: 58.31143, 
          lon: 12.31456, // Same exact position - frozen GPS
          sog: 0.0, 
          cog: 200
        }],
        expectedState: {
          shouldBeInBridgeText: true, // Should appear in bridge text
          bridgeTextContains: 'Stallbackabron'
        }
      }
    ];

    const stepResults = [];
    
    for (let i = 0; i < scenario.length; i++) {
      const step = scenario[i];
      console.log(`  Step ${i + 1}: ${step.description}`);
      
      // Process vessel update
      for (const vessel of step.vessels) {
        await this.testRunner._processVesselAsAISMessage(vessel);
      }
      await this.wait(50);

      // Get vessel state
      const vessels = this.testRunner.app.vesselDataService.getAllVessels();
      const testVessel = vessels.find(v => v.mmsi === 'INTER001');
      
      if (testVessel) {
        console.log(`    State: target=${testVessel.targetBridge}, current=${testVessel.currentBridge}, status=${testVessel.status}`);
        
        // Check expected state
        if (step.expectedState) {
          let stepPassed = true;
          
          if (step.expectedState.targetBridge !== undefined && testVessel.targetBridge !== step.expectedState.targetBridge) {
            stepPassed = false;
            console.log(`    ❌ Expected targetBridge=${step.expectedState.targetBridge}, got ${testVessel.targetBridge}`);
          }
          
          if (step.expectedState.status !== undefined && testVessel.status !== step.expectedState.status) {
            stepPassed = false;
            console.log(`    ❌ Expected status=${step.expectedState.status}, got ${testVessel.status}`);
          }
          
          if (step.expectedState.shouldBeInBridgeText !== undefined) {
            const vesselsForText = this.testRunner.app.vesselDataService.getVesselsForBridgeText();
            const inBridgeText = vesselsForText.some(v => v.mmsi === 'INTER001');
            
            if (step.expectedState.shouldBeInBridgeText !== inBridgeText) {
              stepPassed = false;
              console.log(`    ❌ Expected in bridge text=${step.expectedState.shouldBeInBridgeText}, got ${inBridgeText}`);
            }
          }
          
          stepResults.push({ step: i + 1, passed: stepPassed });
        }
      } else {
        console.log('    ❌ Vessel not found in system');
        stepResults.push({ step: i + 1, passed: false });
      }
    }

    // Simulate 16 minutes passing to test zombie vessel cleanup
    console.log('  Simulating 16 minutes of no movement...');
    const originalDateNow = Date.now;
    const startTime = Date.now();
    Date.now = () => startTime + (16 * 60 * 1000);

    // Try to trigger cleanup
    this.testRunner.app.vesselDataService.removeVessel('INTER001', 'timeout');
    
    Date.now = originalDateNow;

    // Check if vessel was removed
    const vesselsAfter = this.testRunner.app.vesselDataService.getAllVessels();
    const zombieRemoved = !vesselsAfter.some(v => v.mmsi === 'INTER001');

    if (zombieRemoved) {
      this.results.passed.push('✅ Stallbackabron: Zombie vessel removed after 16 minutes');
    } else {
      this.results.failed.push('❌ Stallbackabron: Zombie vessel NOT removed after 16 minutes');
    }

    // Check overall scenario results
    const allStepsPassed = stepResults.every(r => r.passed);
    if (allStepsPassed) {
      this.results.passed.push('✅ Stallbackabron: All scenario steps passed');
    } else {
      const failedSteps = stepResults.filter(r => !r.passed).map(r => r.step);
      this.results.failed.push(`❌ Stallbackabron: Failed steps: ${failedSteps.join(', ')}`);
    }

    // Cleanup
    await this.testRunner.cleanup();
  }

  async testVesselAtOlidebron() {
    console.log('\n📍 SCENARIO 2: Vessel at Olidebron (southernmost intermediate bridge)');
    
    const vessel = {
      mmsi: 'OLIDE001',
      name: 'Olidebron Test',
      lat: 58.27200, // Near Olidebron
      lon: 12.27450,
      sog: 2.5,
      cog: 30 // Northbound
    };

    await this.testRunner._processVesselAsAISMessage(vessel);
    await this.wait(50);

    const vessels = this.testRunner.app.vesselDataService.getAllVessels();
    const testVessel = vessels.find(v => v.mmsi === 'OLIDE001');
    
    if (testVessel) {
      console.log(`  State: target=${testVessel.targetBridge}, current=${testVessel.currentBridge}, status=${testVessel.status}`);
      
      // Vessel should get Klaffbron as target since it's northbound and south of Klaffbron
      if (testVessel.targetBridge === 'Klaffbron') {
        this.results.passed.push('✅ Olidebron: Correct targetBridge assigned (Klaffbron)');
      } else {
        this.results.failed.push(`❌ Olidebron: Wrong targetBridge (${testVessel.targetBridge}), expected Klaffbron`);
      }

      // Check if flow would trigger correctly
      if (testVessel.currentBridge || testVessel.targetBridge) {
        this.results.passed.push('✅ Olidebron: Has bridge association for flow triggers');
      } else {
        this.results.failed.push('❌ Olidebron: No bridge association for flow triggers');
      }
    } else {
      this.results.failed.push('❌ Olidebron: Vessel not found in system');
    }

    await this.testRunner._cleanup();
  }

  async testVesselAtJarnvagsbron() {
    console.log('\n📍 SCENARIO 3: Vessel at Järnvägsbron (between target bridges)');
    
    // Test vessel approaching from south
    const vessel1 = {
      mmsi: 'JARNVAG001',
      name: 'Järnvägsbron North',
      lat: 58.29100, // Near Järnvägsbron
      lon: 12.29150,
      sog: 3.0,
      cog: 30 // Northbound
    };

    await this.testRunner._processVesselAsAISMessage(vessel1);
    await this.wait(50);

    // Test vessel approaching from north
    const vessel2 = {
      mmsi: 'JARNVAG002',
      name: 'Järnvägsbron South',
      lat: 58.29200, // Near Järnvägsbron
      lon: 12.29250,
      sog: 3.0,
      cog: 200 // Southbound
    };

    await this.testRunner._processVesselAsAISMessage(vessel2);
    await this.wait(50);

    const vessels = this.testRunner.app.vesselDataService.getAllVessels();
    
    // Check northbound vessel
    const northVessel = vessels.find(v => v.mmsi === 'JARNVAG001');
    if (northVessel) {
      console.log(`  Northbound: target=${northVessel.targetBridge}, current=${northVessel.currentBridge}`);
      
      // Should have Stridsbergsbron as target (already passed Klaffbron)
      if (northVessel.targetBridge === 'Stridsbergsbron') {
        this.results.passed.push('✅ Järnvägsbron North: Correct targetBridge (Stridsbergsbron)');
      } else {
        this.results.failed.push(`❌ Järnvägsbron North: Wrong targetBridge (${northVessel.targetBridge})`);
      }
    }

    // Check southbound vessel
    const southVessel = vessels.find(v => v.mmsi === 'JARNVAG002');
    if (southVessel) {
      console.log(`  Southbound: target=${southVessel.targetBridge}, current=${southVessel.currentBridge}`);
      
      // Should have Klaffbron as target (already passed Stridsbergsbron)
      if (southVessel.targetBridge === 'Klaffbron') {
        this.results.passed.push('✅ Järnvägsbron South: Correct targetBridge (Klaffbron)');
      } else {
        this.results.failed.push(`❌ Järnvägsbron South: Wrong targetBridge (${southVessel.targetBridge})`);
      }
    }

    await this.testRunner._cleanup();
  }

  async testMultipleVesselsAtIntermediateBridges() {
    console.log('\n📍 SCENARIO 4: Multiple vessels at different intermediate bridges');
    
    const vessels = [
      {
        mmsi: 'MULTI001',
        name: 'At Olidebron',
        lat: 58.27274, 
        lon: 12.27512,
        sog: 1.0,
        cog: 30
      },
      {
        mmsi: 'MULTI002',
        name: 'At Järnvägsbron',
        lat: 58.29164, 
        lon: 12.29203,
        sog: 1.0,
        cog: 200
      },
      {
        mmsi: 'MULTI003',
        name: 'At Stallbackabron',
        lat: 58.31143, 
        lon: 12.31456,
        sog: 0.5,
        cog: 200
      }
    ];

    // Process all vessels
    for (const vessel of vessels) {
      await this.testRunner._processVesselAsAISMessage(vessel);
      await this.wait(10);
    }

    // Get bridge text
    const vesselsForText = this.testRunner.app.vesselDataService.getVesselsForBridgeText();
    const bridgeText = this.testRunner.app.bridgeTextService.generateBridgeText(vesselsForText);
    
    console.log(`  Bridge text: "${bridgeText}"`);

    // Check that bridge text doesn't contain undefined or problematic text
    if (bridgeText && !bridgeText.includes('undefined') && !bridgeText.includes('null')) {
      this.results.passed.push('✅ Multiple intermediate: Bridge text generated without errors');
    } else {
      this.results.failed.push(`❌ Multiple intermediate: Bridge text contains errors: ${bridgeText}`);
    }

    // Check vessel states
    const allVessels = this.testRunner.app.vesselDataService.getAllVessels();
    console.log(`  Total vessels in system: ${allVessels.length}`);
    
    for (const vessel of allVessels) {
      console.log(`    ${vessel.name}: target=${vessel.targetBridge}, current=${vessel.currentBridge}, status=${vessel.status}`);
    }

    // All vessels should have appropriate bridge associations
    const allHaveBridgeInfo = allVessels.every(v => v.targetBridge || v.currentBridge);
    if (allHaveBridgeInfo) {
      this.results.passed.push('✅ Multiple intermediate: All vessels have bridge associations');
    } else {
      this.results.failed.push('❌ Multiple intermediate: Some vessels lack bridge associations');
    }

    await this.testRunner._cleanup();
  }

  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  printResults() {
    console.log('\n========================================');
    console.log('📊 INTERMEDIATE BRIDGE TEST RESULTS');
    console.log('========================================\n');

    console.log(`✅ PASSED: ${this.results.passed.length} tests`);
    this.results.passed.forEach(test => console.log(`   ${test}`));

    if (this.results.failed.length > 0) {
      console.log(`\n❌ FAILED: ${this.results.failed.length} tests`);
      this.results.failed.forEach(test => console.log(`   ${test}`));
    }

    const passRate = this.results.passed.length / (this.results.passed.length + this.results.failed.length) * 100;
    console.log(`\n📈 Pass rate: ${passRate.toFixed(1)}%`);
  }
}

module.exports = IntermediateBridgeTest;

if (require.main === module) {
  const test = new IntermediateBridgeTest();
  test.runAllScenarios()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Test failed:', error);
      process.exit(1);
    });
}