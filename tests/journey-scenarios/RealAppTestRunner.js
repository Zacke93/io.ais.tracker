'use strict';

/**
 * RealAppTestRunner - Tests the COMPLETE app.js logic, not just BridgeTextService
 * This creates a real AISBridgeApp instance and simulates actual AIS messages
 * to test the complete vessel lifecycle and bridge_text generation
 */

// Setup module path for mocking
const Module = require('module');

// Override require for 'homey' module
const originalRequire = Module.prototype.require;
Module.prototype.require = function requireOverride(id) {
  if (id === 'homey') {
    return require('../__mocks__/homey'); // eslint-disable-line global-require
  }
  return originalRequire.call(this, id);
};

const mockHomey = require('../__mocks__/homey').__mockHomey;
const AISBridgeApp = require('../../app');

class RealAppTestRunner {
  constructor() {
    this.app = null;
    this.bridgeTextHistory = [];
    this.lastBridgeText = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
    this.stepNumber = 0;
  }

  /**
   * Initialize the real app with mocked Homey environment
   */
  async initializeApp() {
    // Create real app instance
    this.app = new AISBridgeApp();
    this.app.homey = mockHomey;

    // Add mock settings
    mockHomey.app.settings = {
      debug_level: 'detailed',
      ais_api_key: null, // No API key for testing
    };

    // Mock the settings interface
    mockHomey.settings = {
      get: (key) => mockHomey.app.settings[key] || null,
      on: () => {},
      off: () => {},
    };

    // Initialize the app (this runs all the real initialization)
    await this.app.onInit();

    // Hook into bridge text updates
    this._hookBridgeTextUpdates();

    console.log('✅ Real AISBridgeApp initialized with all services');
  }

  /**
   * Run a journey scenario using real app logic
   */
  async runRealJourney(scenarioName, journeySteps) {
    console.log(`\n🚢 REAL APP JOURNEY TEST: ${scenarioName}`);
    console.log('='.repeat(80));

    if (!this.app) {
      await this.initializeApp();
    }

    this.bridgeTextHistory = [];
    this.stepNumber = 0;

    for (const step of journeySteps) {
      this.stepNumber++;
      console.log(`\n📍 STEG ${this.stepNumber}: ${step.description}`);
      console.log('-'.repeat(50));

      // Process each vessel as AIS message
      if (step.vessels && step.vessels.length > 0) {
        for (const vessel of step.vessels) {
          await this._processVesselAsAISMessage(vessel);
        }
      } else {
        // Handle empty vessel array (cleanup simulation)
        await this._simulateVesselCleanup();
      }

      // Give app time to process
      await this._wait(100);

      // Log current state
      this._logCurrentAppState();

      // Check for bridge text changes
      this._checkBridgeTextChanges(step.description);

      if (step.delaySeconds) {
        console.log(`⏱️  Väntar ${step.delaySeconds} sekunder...`);
        await this._wait(step.delaySeconds * 1000);
      }
    }

    return this._generateJourneyReport(scenarioName);
  }

  /**
   * Process vessel data as real AIS message through the app
   * @private
   */
  async _processVesselAsAISMessage(vessel) {
    // Create AIS message format that the real app expects
    const aisMessage = {
      mmsi: vessel.mmsi,
      msgType: 1,
      lat: vessel.lat,
      lon: vessel.lon,
      sog: vessel.sog || 3.5,
      cog: vessel.cog || 180,
      shipName: vessel.name || 'Test Vessel',
      timestamp: Date.now(),
    };

    console.log(`📡 Processing AIS message for ${vessel.name} (${vessel.mmsi})`);
    console.log(`   Position: ${vessel.lat?.toFixed(5)}, ${vessel.lon?.toFixed(5)}`);
    console.log(`   Speed: ${vessel.sog} knop, Course: ${vessel.cog}°`);

    // Process through real app logic
    this.app._processAISMessage(aisMessage);
  }

  /**
   * Simulate vessel cleanup (boats leaving system)
   * @private
   */
  async _simulateVesselCleanup() {
    console.log('🧹 Simulating vessel cleanup (boats leaving system)');
    // Force cleanup of all vessels
    const allVessels = this.app.vesselDataService.getAllVessels();
    for (const vessel of allVessels) {
      this.app.vesselDataService.removeVessel(vessel.mmsi, 'journey-test-cleanup');
    }
  }

  /**
   * Hook into bridge text updates to capture changes
   * @private
   */
  _hookBridgeTextUpdates() {
    // Override the _updateDeviceCapability method to capture bridge_text changes
    const originalUpdateDeviceCapability = this.app._updateDeviceCapability.bind(this.app);

    this.app._updateDeviceCapability = (capability, value) => {
      if (capability === 'bridge_text' && value !== this.lastBridgeText) {
        const change = {
          step: this.stepNumber,
          timestamp: new Date().toISOString(),
          previousText: this.lastBridgeText,
          newText: value,
          vessels: this._getCurrentVesselSummary(),
        };

        this.bridgeTextHistory.push(change);
        this.lastBridgeText = value;

        console.log(`🔄 BRIDGE TEXT CHANGED: "${value}"`);
        console.log(`   Previous: "${change.previousText}"`);
      }

      // Call original method
      return originalUpdateDeviceCapability(capability, value);
    };
  }

  /**
   * Get current vessel summary for logging
   * @private
   */
  _getCurrentVesselSummary() {
    if (!this.app.vesselDataService) return [];

    const vessels = this.app.vesselDataService.getAllVessels();
    return vessels.map((vessel) => ({
      mmsi: vessel.mmsi,
      name: vessel.name,
      status: vessel.status,
      targetBridge: vessel.targetBridge,
      distance: vessel._distanceToNearest?.toFixed(0),
      etaMinutes: vessel.etaMinutes?.toFixed(1),
    }));
  }

  /**
   * Log current app state
   * @private
   */
  _logCurrentAppState() {
    const vesselCount = this.app.vesselDataService?.getVesselCount() || 0;
    console.log(`🚢 Current vessels in system: ${vesselCount}`);

    if (vesselCount > 0) {
      const vessels = this.app.vesselDataService.getAllVessels();
      vessels.forEach((vessel) => {
        console.log(`   • ${vessel.name} (${vessel.mmsi}): ${vessel.status} → ${vessel.targetBridge}`);
        console.log(`     Distance: ${vessel._distanceToNearest?.toFixed(0)}m, ETA: ${vessel.etaMinutes?.toFixed(1)}min`);
      });
    }
  }

  /**
   * Check for bridge text changes
   * @private
   */
  _checkBridgeTextChanges(stepDescription) {
    // Get current bridge text from app
    const relevantVessels = this.app._findRelevantBoatsForBridgeText();
    const currentBridgeText = this.app.bridgeTextService.generateBridgeText(relevantVessels);

    console.log(`📢 CURRENT BRIDGE TEXT: "${currentBridgeText}"`);

    if (currentBridgeText !== this.lastBridgeText) {
      console.log(`🔄 DETECTED CHANGE: "${this.lastBridgeText}" → "${currentBridgeText}"`);

      this.bridgeTextHistory.push({
        step: this.stepNumber,
        description: stepDescription,
        timestamp: new Date().toISOString(),
        previousText: this.lastBridgeText,
        newText: currentBridgeText,
        vessels: this._getCurrentVesselSummary(),
      });

      this.lastBridgeText = currentBridgeText;
    } else {
      console.log('✅ No bridge text change');
    }
  }

  /**
   * Generate comprehensive journey report
   * @private
   */
  _generateJourneyReport(scenarioName) {
    console.log(`\n${'='.repeat(80)}`);
    console.log('📋 REAL APP JOURNEY REPORT');
    console.log('='.repeat(80));

    console.log(`🎬 Scenario: ${scenarioName}`);
    console.log(`📊 Total steps: ${this.stepNumber}`);
    console.log(`🔄 Bridge text changes: ${this.bridgeTextHistory.length}`);
    console.log(`📢 Final bridge text: "${this.lastBridgeText}"`);

    if (this.bridgeTextHistory.length > 0) {
      console.log('\n📝 All Bridge Text Changes:');
      this.bridgeTextHistory.forEach((change, index) => {
        console.log(`\n  ${index + 1}. Step ${change.step}: ${change.description || 'N/A'}`);
        console.log(`     From: "${change.previousText}"`);
        console.log(`     To:   "${change.newText}"`);
        console.log(`     Vessels: ${change.vessels.length} active`);
        if (change.vessels.length > 0) {
          change.vessels.forEach((vessel) => {
            console.log(`       - ${vessel.name}: ${vessel.status} → ${vessel.targetBridge} (${vessel.distance}m, ${vessel.etaMinutes}min)`);
          });
        }
      });
    }

    return {
      scenarioName,
      totalSteps: this.stepNumber,
      bridgeTextChanges: this.bridgeTextHistory,
      finalBridgeText: this.lastBridgeText,
    };
  }

  /**
   * Utility wait function
   * @private
   */
  async _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Cleanup after tests
   */
  async cleanup() {
    if (this.app) {
      await this.app.onUninit();
      this.app = null;
    }
  }
}

module.exports = RealAppTestRunner;
