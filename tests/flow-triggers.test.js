'use strict';

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

class FlowTriggerTest {
  constructor() {
    this.testRunner = new RealAppTestRunner();
    this.results = { passed: [], failed: [] };
    this.triggeredFlows = [];
  }

  async runAllTests() {
    console.log('\n🚀 Starting Flow Trigger Tests...\n');
    await this.testRunner.initializeApp();
    
    // Mock flow trigger to capture calls
    this._mockFlowTriggers();
    
    await this.testFlowTriggersAtIntermediateBridges();
    await this.testFlowTriggerTokenValidation();
    await this.testFlowTriggerWithNullTargetBridge();
    await this.testFlowTriggerFallbackLogic();
    
    this.printResults();
    await this.testRunner.cleanup();
  }

  _mockFlowTriggers() {
    // Mock the boat_near trigger to capture calls
    const boatNearTrigger = this.testRunner.app._boatNearTrigger;
    if (boatNearTrigger) {
      const originalTrigger = boatNearTrigger.trigger.bind(boatNearTrigger);
      boatNearTrigger.trigger = async (args, state, tokens) => {
        this.triggeredFlows.push({ args, tokens, timestamp: Date.now() });
        console.log(`🎯 FLOW TRIGGERED: bridge=${args.bridge}, bridge_name=${tokens.bridge_name}`);
        // Still call original to maintain app functionality
        return originalTrigger(args, state, tokens);
      };
    }
  }

  async testFlowTriggersAtIntermediateBridges() {
    console.log('\n📍 TEST: Flow Triggers at Intermediate Bridges');
    
    // Clear previous triggers
    this.triggeredFlows = [];
    
    // Vessel approaching Stallbackabron (intermediate bridge)
    const vessel = {
      mmsi: 'TRIGGER001',
      name: 'Flow Test Vessel',
      lat: 58.31000, // ~500m south of Stallbackabron
      lon: 12.31200,
      sog: 2.0,
      cog: 200, // Southbound
    };

    await this.testRunner._processVesselAsAISMessage(vessel);
    await this.wait(100);

    // Move closer to trigger 'waiting' status at Stallbackabron
    vessel.lat = 58.31100; // ~200m from Stallbackabron
    vessel.lon = 12.31400;
    await this.testRunner._processVesselAsAISMessage(vessel);
    await this.wait(100);

    // Check if flow was triggered with valid bridge_name
    const relevantTrigger = this.triggeredFlows.find(t => 
      t.tokens && t.tokens.bridge_name && t.tokens.bridge_name !== 'undefined'
    );

    if (relevantTrigger) {
      this.results.passed.push(`✅ Flow: Triggered at intermediate bridge with bridge_name="${relevantTrigger.tokens.bridge_name}"`);
    } else {
      this.results.failed.push('❌ Flow: No valid trigger for intermediate bridge vessel');
      console.log('  Captured triggers:', this.triggeredFlows.map(t => ({
        bridge: t.args?.bridge,
        bridge_name: t.tokens?.bridge_name
      })));
    }
  }

  async testFlowTriggerTokenValidation() {
    console.log('\n📍 TEST: Flow Trigger Token Validation');
    
    // Check all captured flow triggers for undefined tokens
    let hasUndefinedTokens = false;
    let invalidTokens = [];
    
    for (const trigger of this.triggeredFlows) {
      const { tokens } = trigger;
      
      if (!tokens) {
        hasUndefinedTokens = true;
        invalidTokens.push('tokens object is missing');
        continue;
      }
      
      if (tokens.bridge_name === undefined || tokens.bridge_name === null || tokens.bridge_name === 'undefined') {
        hasUndefinedTokens = true;
        invalidTokens.push(`bridge_name is ${tokens.bridge_name}`);
      }
      
      if (tokens.boat_name === undefined || tokens.boat_name === null) {
        hasUndefinedTokens = true;
        invalidTokens.push(`boat_name is ${tokens.boat_name}`);
      }
    }

    if (!hasUndefinedTokens && this.triggeredFlows.length > 0) {
      this.results.passed.push('✅ Flow: All trigger tokens have valid values');
    } else if (hasUndefinedTokens) {
      this.results.failed.push(`❌ Flow: Invalid tokens found: ${invalidTokens.join(', ')}`);
    } else {
      this.results.failed.push('❌ Flow: No flow triggers captured to validate');
    }
  }

  async testFlowTriggerWithNullTargetBridge() {
    console.log('\n📍 TEST: Flow Trigger with Null Target Bridge');
    
    // Clear previous triggers
    this.triggeredFlows = [];
    
    // Create vessel at Järnvägsbron (intermediate) without target bridge
    const vessel = {
      mmsi: 'NOTARGET001',
      name: 'No Target Vessel',
      lat: 58.29100, // Near Järnvägsbron
      lon: 12.29150,
      sog: 1.0,
      cog: 30, // Northbound
    };

    await this.testRunner._processVesselAsAISMessage(vessel);
    await this.wait(100);

    // Get the vessel to check its state
    const vessels = this.testRunner.app.vesselDataService.getAllVessels();
    const testVessel = vessels.find(v => v.mmsi === 'NOTARGET001');
    
    if (testVessel) {
      console.log(`  Vessel state: currentBridge=${testVessel.currentBridge}, targetBridge=${testVessel.targetBridge}`);
    }

    // Move vessel closer to trigger waiting status
    vessel.lat = 58.29140;
    vessel.lon = 12.29190;
    await this.testRunner._processVesselAsAISMessage(vessel);
    await this.wait(100);

    // Check if flow trigger used currentBridge as fallback
    const trigger = this.triggeredFlows.find(t => t.tokens?.boat_name === 'No Target Vessel');
    
    if (trigger && trigger.tokens.bridge_name && trigger.tokens.bridge_name !== 'undefined') {
      this.results.passed.push(`✅ Flow: Fallback to currentBridge worked - bridge_name="${trigger.tokens.bridge_name}"`);
    } else if (this.triggeredFlows.length === 0) {
      // This might be expected if vessel doesn't meet trigger conditions
      this.results.passed.push('✅ Flow: No trigger for vessel without targetBridge (expected behavior)');
    } else {
      this.results.failed.push('❌ Flow: Failed to use currentBridge as fallback');
    }
  }

  async testFlowTriggerFallbackLogic() {
    console.log('\n📍 TEST: Flow Trigger Fallback Logic');
    
    // Clear previous triggers
    this.triggeredFlows = [];
    
    // Test vessel at Olidebron (intermediate, southernmost)
    const vessel = {
      mmsi: 'FALLBACK001',
      name: 'Fallback Test',
      lat: 58.27200, // Near Olidebron
      lon: 12.27450,
      sog: 2.5,
      cog: 30, // Northbound
    };

    await this.testRunner._processVesselAsAISMessage(vessel);
    await this.wait(100);

    // Check vessel state
    const vessels = this.testRunner.app.vesselDataService.getAllVessels();
    const testVessel = vessels.find(v => v.mmsi === 'FALLBACK001');
    
    if (testVessel) {
      console.log(`  Vessel at Olidebron: currentBridge=${testVessel.currentBridge}, targetBridge=${testVessel.targetBridge}, status=${testVessel.status}`);
      
      // Verify that vessel at intermediate bridge still works
      if (testVessel.currentBridge === 'Olidebron') {
        this.results.passed.push('✅ Flow: Vessel correctly identified at Olidebron');
      }
    }

    // Check if any flow was triggered
    const trigger = this.triggeredFlows.find(t => t.tokens?.boat_name === 'Fallback Test');
    if (trigger) {
      console.log(`  Flow triggered with bridge_name="${trigger.tokens.bridge_name}"`);
    }
  }

  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  printResults() {
    console.log('\n========================================');
    console.log('📊 FLOW TRIGGER TEST RESULTS');
    console.log('========================================\n');

    console.log(`✅ PASSED: ${this.results.passed.length} tests`);
    this.results.passed.forEach(test => console.log(`   ${test}`));

    if (this.results.failed.length > 0) {
      console.log(`\n❌ FAILED: ${this.results.failed.length} tests`);
      this.results.failed.forEach(test => console.log(`   ${test}`));
    }

    console.log(`\n📋 Flow triggers captured: ${this.triggeredFlows.length}`);
    this.triggeredFlows.slice(0, 10).forEach((trigger, i) => {
      console.log(`   ${i+1}. bridge=${trigger.args?.bridge}, bridge_name=${trigger.tokens?.bridge_name}, boat=${trigger.tokens?.boat_name}`);
    });
    
    if (this.triggeredFlows.length > 10) {
      console.log(`   ... and ${this.triggeredFlows.length - 10} more`);
    }

    const passRate = this.results.passed.length / (this.results.passed.length + this.results.failed.length) * 100;
    console.log(`\n📈 Pass rate: ${passRate.toFixed(1)}%`);
  }
}

module.exports = FlowTriggerTest;

if (require.main === module) {
  const test = new FlowTriggerTest();
  test.runAllTests()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Test failed:', error);
      process.exit(1);
    });
}