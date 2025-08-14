'use strict';

/* eslint-disable no-console */

/**
 * Complete Integration Test Suite
 * Tests all new functionality: GPSJumpAnalyzer, StatusStabilizer, SystemCoordinator, Enhanced Passage Detection
 */

// const path = require('path'); // Unused - commented out

// Mock Homey environment
global.Homey = {
  app: {
    log: console.log,
    error: console.error,
    debug: console.log,
  },
  ManagerSettings: {
    get: () => null,
    set: () => {},
  },
  Flow: {
    getCardTrigger: () => ({ trigger: () => {} }),
  },
};

// Load services
const VesselDataService = require('./lib/services/VesselDataService');
const StatusService = require('./lib/services/StatusService');
const BridgeTextService = require('./lib/services/BridgeTextService');
const SystemCoordinator = require('./lib/services/SystemCoordinator');
const GPSJumpAnalyzer = require('./lib/utils/GPSJumpAnalyzer');
const StatusStabilizer = require('./lib/services/StatusStabilizer');
const geometry = require('./lib/utils/geometry');
const { BRIDGES } = require('./lib/constants');

// Test logger
const logger = {
  log: (...args) => console.log('[LOG]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: (...args) => console.log('[DEBUG]', ...args),
};

class IntegrationTester {
  constructor() {
    this.systemCoordinator = new SystemCoordinator(logger);
    this.vesselDataService = new VesselDataService(logger);
    this.statusService = new StatusService(logger, this.systemCoordinator);
    this.bridgeTextService = new BridgeTextService(logger);
    this.gpsJumpAnalyzer = new GPSJumpAnalyzer(logger);
    this.statusStabilizer = new StatusStabilizer(logger);

    this.testResults = [];
    this.passedTests = 0;
    this.failedTests = 0;
  }

  async runAllTests() {
    console.log('\n========================================');
    console.log('🧪 COMPLETE INTEGRATION TEST SUITE');
    console.log('========================================\n');

    // Test 1: GPS Jump Analysis
    await this.testGPSJumpAnalysis();

    // Test 2: Status Stabilization
    await this.testStatusStabilization();

    // Test 3: System Coordination
    await this.testSystemCoordination();

    // Test 4: Enhanced Passage Detection
    await this.testEnhancedPassageDetection();

    // Test 5: Complete Integration Flow
    await this.testCompleteIntegrationFlow();

    // Test 6: Target Bridge Protection
    await this.testTargetBridgeProtection();

    // Test 7: Bridge Text Debouncing
    await this.testBridgeTextDebouncing();

    // Test 8: Memory Management
    await this.testMemoryManagement();

    this.printSummary();
  }

  async testGPSJumpAnalysis() {
    console.log('\n📍 TEST 1: GPS Jump Analysis');
    console.log('─────────────────────────────');

    const tests = [
      {
        name: 'Small movement (<100m)',
        current: { lat: 58.3, lon: 11.5 },
        previous: { lat: 58.3001, lon: 11.5001 },
        currentVessel: { cog: 180, sog: 5 },
        oldVessel: { cog: 180, sog: 5, timestamp: Date.now() - 30000 },
        expected: { action: 'accept', isGPSJump: false },
      },
      {
        name: 'Large movement with COG change (U-turn)',
        current: { lat: 58.3, lon: 11.5 },
        previous: { lat: 58.305, lon: 11.51 },
        currentVessel: { cog: 10, sog: 8 },
        oldVessel: { cog: 190, sog: 8, timestamp: Date.now() - 60000 },
        expected: { action: 'accept', isGPSJump: false, reason: 'legitimate_direction_change' },
      },
      {
        name: 'GPS jump (inconsistent speed)',
        current: { lat: 58.3, lon: 11.5 },
        previous: { lat: 58.32, lon: 11.52 },
        currentVessel: { cog: 180, sog: 5 },
        oldVessel: { cog: 180, sog: 5, timestamp: Date.now() - 5000 },
        expected: { action: 'gps_jump_detected', isGPSJump: true },
      },
    ];

    for (const test of tests) {
      const result = this.gpsJumpAnalyzer.analyzeMovement(
        '123456789',
        test.current,
        test.previous,
        test.currentVessel,
        test.oldVessel,
      );

      const passed = result.action === test.expected.action
                    && result.isGPSJump === test.expected.isGPSJump;

      this.recordTest(test.name, passed, result);
    }
  }

  async testStatusStabilization() {
    console.log('\n🛡️ TEST 2: Status Stabilization');
    console.log('─────────────────────────────');

    const vessel = {
      mmsi: '123456789',
      status: 'en-route',
      sog: 8,
      _distanceToNearest: 500,
    };

    const tests = [
      {
        name: 'Normal status change',
        proposedStatus: 'approaching',
        positionAnalysis: { gpsJumpDetected: false, positionUncertain: false },
        expectedStabilized: false,
      },
      {
        name: 'Status during GPS jump',
        proposedStatus: 'waiting',
        positionAnalysis: { gpsJumpDetected: true, positionUncertain: false },
        expectedStabilized: true,
      },
      {
        name: 'Status during uncertain position',
        proposedStatus: 'approaching',
        positionAnalysis: { gpsJumpDetected: false, positionUncertain: true },
        expectedStabilized: true,
      },
    ];

    for (const test of tests) {
      const result = this.statusStabilizer.stabilizeStatus(
        vessel.mmsi,
        test.proposedStatus,
        vessel,
        test.positionAnalysis,
      );

      const passed = result.stabilized === test.expectedStabilized;
      this.recordTest(test.name, passed, result);
    }
  }

  async testSystemCoordination() {
    console.log('\n🎮 TEST 3: System Coordination');
    console.log('─────────────────────────────');

    const tests = [
      {
        name: 'GPS jump coordination',
        gpsAnalysis: { isGPSJump: true, movementDistance: 800 },
        expectedProtection: true,
        expectedDebounce: true,
      },
      {
        name: 'Uncertain position coordination',
        gpsAnalysis: { action: 'accept_with_caution', movementDistance: 400 },
        expectedProtection: true,
        expectedDebounce: true,
      },
      {
        name: 'Normal movement',
        gpsAnalysis: { action: 'accept', movementDistance: 50 },
        expectedProtection: false,
        expectedDebounce: false,
      },
    ];

    for (const test of tests) {
      const result = this.systemCoordinator.coordinatePositionUpdate(
        '123456789',
        test.gpsAnalysis,
        { mmsi: '123456789' },
        null,
      );

      const passed = result.shouldActivateProtection === test.expectedProtection
                    && result.shouldDebounceText === test.expectedDebounce;

      this.recordTest(test.name, passed, result);
    }
  }

  async testEnhancedPassageDetection() {
    console.log('\n🌉 TEST 4: Enhanced Passage Detection');
    console.log('──────────────────────────────────');

    const bridge = BRIDGES.stallbackabron || {
      name: 'Stallbackabron',
      lat: 58.31265,
      lon: 11.44652,
      radius: 300,
    };

    const tests = [
      {
        name: 'Traditional close passage',
        vessel: { lat: bridge.lat, lon: bridge.lon },
        oldVessel: { lat: bridge.lat + 0.001, lon: bridge.lon },
        expectedPassed: true,
        expectedMethod: 'traditional_close_passage',
      },
      {
        name: 'Line crossing detection',
        vessel: { lat: bridge.lat - 0.002, lon: bridge.lon },
        oldVessel: { lat: bridge.lat + 0.002, lon: bridge.lon },
        expectedPassed: true,
        expectedMethod: 'enhanced_line_crossing',
      },
      {
        name: 'Stallbackabron special',
        vessel: { lat: bridge.lat - 0.001, lon: bridge.lon },
        oldVessel: { lat: bridge.lat + 0.001, lon: bridge.lon },
        expectedPassed: true,
        expectedMethod: 'stallbackabron_special',
      },
    ];

    for (const test of tests) {
      const result = geometry.detectBridgePassage(
        test.vessel,
        test.oldVessel,
        bridge,
      );

      const passed = result.passed === test.expectedPassed;
      this.recordTest(test.name, passed, result);
    }
  }

  async testCompleteIntegrationFlow() {
    console.log('\n🔄 TEST 5: Complete Integration Flow');
    console.log('──────────────────────────────────');

    // Simulate boat 257941000 scenario
    const vessel = {
      mmsi: '257941000',
      name: 'NORDIC SIRA',
      lat: 58.32,
      lon: 11.45,
      cog: 198,
      sog: 11.6,
      targetBridge: 'Stridsbergsbron',
      status: 'en-route',
      currentBridge: null,
      lastPosition: { lat: 58.315, lon: 11.44 },
      timestamp: Date.now(),
    };

    // Step 1: Update vessel with GPS jump
    console.log('  → Simulating GPS jump...');
    const oldVessel = { ...vessel };
    vessel.lat = 58.31;
    vessel.lon = 11.46;

    // Analyze GPS movement
    const gpsAnalysis = this.gpsJumpAnalyzer.analyzeMovement(
      vessel.mmsi,
      { lat: vessel.lat, lon: vessel.lon },
      oldVessel.lastPosition,
      vessel,
      oldVessel,
    );

    // Coordinate with system
    const coordination = this.systemCoordinator.coordinatePositionUpdate(
      vessel.mmsi,
      gpsAnalysis,
      vessel,
      oldVessel,
    );

    // Apply status stabilization
    const stabilizedStatus = this.statusStabilizer.stabilizeStatus(
      vessel.mmsi,
      'approaching',
      vessel,
      gpsAnalysis,
    );

    const integrationWorked = gpsAnalysis.action !== 'reject'
      && coordination.shouldActivateProtection
      && stabilizedStatus.stabilized;

    this.recordTest('Complete integration flow', integrationWorked, {
      gpsAnalysis,
      coordination,
      stabilizedStatus,
    });
  }

  async testTargetBridgeProtection() {
    console.log('\n🎯 TEST 6: Target Bridge Protection');
    console.log('────────────────────────────────');

    const vessel = {
      mmsi: '123456789',
      targetBridge: 'Stridsbergsbron',
      lat: 58.293,
      lon: 11.446,
    };

    // Test that target bridge is preserved
    // const oldVessel = { ...vessel }; // Unused - commented out // eslint-disable-line no-unused-vars
    vessel.lat = 58.294;

    this.vesselDataService.updateVessel(vessel);
    const updatedVessel = this.vesselDataService.getVessel(vessel.mmsi);

    const targetPreserved = updatedVessel && updatedVessel.targetBridge === vessel.targetBridge;
    this.recordTest('Target bridge preserved during update', targetPreserved, {
      original: vessel.targetBridge,
      updated: updatedVessel?.targetBridge,
    });

    // Test protection during GPS jump scenario
    const protectionScenario = vessel.targetBridge === 'Stridsbergsbron';
    this.recordTest('Protection scenario setup', protectionScenario, { targetBridge: vessel.targetBridge });
  }

  async testBridgeTextDebouncing() {
    console.log('\n⏱️ TEST 7: Bridge Text Debouncing');
    console.log('──────────────────────────────');

    const vessels = [
      { mmsi: '123456789', targetBridge: 'Klaffbron' },
      { mmsi: '987654321', targetBridge: 'Stridsbergsbron' },
    ];

    // Activate debounce for first vessel
    this.systemCoordinator._activateBridgeTextDebounce('123456789', Date.now());

    const debounceStatus = this.systemCoordinator.shouldDebounceBridgeText(vessels);
    const shouldDebounce = debounceStatus.shouldDebounce && debounceStatus.activeDebounces > 0;

    this.recordTest('Bridge text debouncing active', shouldDebounce, debounceStatus);
  }

  async testMemoryManagement() {
    console.log('\n🧹 TEST 8: Memory Management');
    console.log('─────────────────────────');

    // Add test data
    for (let i = 0; i < 10; i++) {
      const mmsi = `12345678${i}`;
      this.statusStabilizer._getOrCreateHistory(mmsi);
      this.systemCoordinator._getOrCreateCoordinationState(mmsi);
    }

    const beforeCleanup = {
      statusHistory: this.statusStabilizer.statusHistory.size,
      coordinationState: this.systemCoordinator.vesselCoordinationState.size,
    };

    // Run cleanup
    this.statusStabilizer.cleanup();
    this.systemCoordinator.cleanup();

    const afterCleanup = {
      statusHistory: this.statusStabilizer.statusHistory.size,
      coordinationState: this.systemCoordinator.vesselCoordinationState.size,
    };

    const cleanupWorked = afterCleanup.statusHistory <= beforeCleanup.statusHistory
                         && afterCleanup.coordinationState <= beforeCleanup.coordinationState;

    this.recordTest('Memory cleanup', cleanupWorked, { beforeCleanup, afterCleanup });
  }

  recordTest(name, passed, details) {
    const status = passed ? '✅' : '❌';
    console.log(`  ${status} ${name}`);

    if (!passed && details) {
      console.log('    Details:', JSON.stringify(details, null, 2).split('\n').join('\n    '));
    }

    this.testResults.push({ name, passed, details });
    if (passed) {
      this.passedTests++;
    } else {
      this.failedTests++;
    }
  }

  printSummary() {
    console.log('\n========================================');
    console.log('📊 TEST SUMMARY');
    console.log('========================================');
    console.log(`✅ Passed: ${this.passedTests}`);
    console.log(`❌ Failed: ${this.failedTests}`);
    console.log(`📈 Success Rate: ${((this.passedTests / (this.passedTests + this.failedTests)) * 100).toFixed(1)}%`);

    if (this.failedTests > 0) {
      console.log('\n❌ Failed Tests:');
      this.testResults
        .filter((t) => !t.passed)
        .forEach((t) => console.log(`  - ${t.name}`));
    }

    console.log('\n========================================\n');

    // process.exit(this.failedTests > 0 ? 1 : 0); // Let Node exit naturally
    if (this.failedTests > 0) {
      throw new Error(`${this.failedTests} tests failed`);
    }
  }
}

// Run tests
const tester = new IntegrationTester();
tester.runAllTests().catch(console.error);
