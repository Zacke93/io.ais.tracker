'use strict';

/**
 * RealAppTestRunner - Tests the COMPLETE app.js logic, not just BridgeTextService
 * This creates a real AISBridgeApp instance and simulates actual AIS messages
 * to test the complete vessel lifecycle and bridge_text generation
 */

// Setup module path for mocking
const Module = require('module');

// Minimal WebSocket stub to satisfy AISStreamClient without network
function WSStub() {
  this.readyState = WSStub.OPEN;
  this._handlers = {};
}
WSStub.prototype.on = function on(evt, cb) {
  this._handlers[evt] = cb;
};
WSStub.prototype.send = function send() { /* noop */ };
WSStub.prototype.close = function close() {
  if (this._handlers.close) this._handlers.close(1000, 'test_close');
};
WSStub.OPEN = 1;

// Override require for 'homey' and 'ws' modules (avoid external deps during tests)
const originalRequire = Module.prototype.require;
Module.prototype.require = function requireOverride(id) {
  if (id === 'homey') {
    return require('../__mocks__/homey'); // eslint-disable-line global-require, import/extensions
  }
  if (id === 'ws') {
    return WSStub;
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
    this._waitMultiplier = 1; // Allow acceleration during automated tests
    this.logLevel = process.env.BRIDGE_TEXT_LOG_LEVEL || 'summary';
  }

  /**
   * Initialize the real app with mocked Homey environment
   */
  async initializeApp() {
    // Set test mode to prevent monitoring intervals
    global.__TEST_MODE__ = true;
    // Create real app instance
    this.app = new AISBridgeApp();
    this.app.homey = mockHomey;

    // Add mock settings
    mockHomey.app.settings = {
      debug_level: 'off',
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

    this._logSummary('✅ Real AISBridgeApp initialized with all services');
  }

  /**
   * Run a journey scenario using real app logic
   */
  async runRealJourney(scenarioName, journeySteps) {
    this._logVerbose(`\n🚢 REAL APP JOURNEY TEST: ${scenarioName}`);
    this._logVerbose('='.repeat(80));

    if (!this.app) {
      await this.initializeApp();
    }

    this.bridgeTextHistory = [];
    this.stepNumber = 0;

    for (const step of journeySteps) {
      this.stepNumber++;
      this._logVerbose(`\n📍 STEG ${this.stepNumber}: ${step.description}`);
      this._logVerbose('-'.repeat(50));

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
      await this._wait(1.5);

      // Log current state
      this._logCurrentAppState();

      // Check for bridge text changes
      this._checkBridgeTextChanges(step.description);

      if (step.delaySeconds) {
        this._logVerbose(`⏱️  Väntar ${step.delaySeconds} sekunder...`);
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
      sog: vessel.sog !== undefined ? vessel.sog : 3.5, // CRITICAL FIX: Properly handle sog=0
      cog: vessel.cog !== undefined ? vessel.cog : 180, // CRITICAL FIX: Properly handle cog=0
      shipName: vessel.name || 'Test Vessel',
      timestamp: Date.now(),
    };

    // Calculate distance to nearest bridge for detailed logging
    let nearestBridge = null;
    let nearestDistance = null;

    if (this.app && this.app.proximityService) {
      try {
        const proximityData = this.app.proximityService.analyzeVesselProximity({
          lat: vessel.lat,
          lon: vessel.lon,
          sog: vessel.sog,
          cog: vessel.cog,
        });
        nearestBridge = proximityData.nearestBridge;
        nearestDistance = proximityData.nearestDistance;
      } catch (error) {
        // Fallback if proximity service not available
      }
    }

    this._logVerbose(`📡 Processing AIS: ${vessel.name} (${vessel.mmsi})`);
    this._logVerbose(`   📍 Position: ${vessel.lat?.toFixed(5)}, ${vessel.lon?.toFixed(5)}`);
    this._logVerbose(`   🚤 Speed: ${vessel.sog} knop, Course: ${vessel.cog}°`);
    if (nearestBridge && nearestDistance !== null) {
      const nbName = typeof nearestBridge === 'string' ? nearestBridge : (nearestBridge.name || 'unknown');
      this._logVerbose(`   🌉 Närmaste bro: ${nbName} (${Math.round(nearestDistance)}m)`);
    }

    // Process through real app logic
    try {
      this.app._processAISMessage(aisMessage);

      // Give the app time to process the message and update bridge text
      await this._wait(3.5999999999999996);

      // Force UI update to ensure bridge text is recalculated
      if (this.app._updateUI) {
        this.app._updateUI();
        await this._wait(10.5); // Wait for debounced update
      }

      // Check for immediate bridge text change after processing
      const currentBridgeText = this.getCurrentBridgeText();
      if (currentBridgeText !== this.lastBridgeText) {
        this._logVerbose('   📢 OMEDELBAR BRIDGE TEXT ÄNDRING:');
        this._logVerbose(`   🔄 "${this.lastBridgeText}"`);
        this._logVerbose(`   ➡️  "${currentBridgeText}"`);
      }

    } catch (error) {
      console.error('❌ Error processing AIS message:', error);
      throw error;
    }
  }

  /**
   * Simulate vessel cleanup (boats leaving system)
   * @private
   */
  async _simulateVesselCleanup() {
    this._logVerbose('🧹 Simulating vessel cleanup (boats leaving system)');
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
          nearest: this.getCurrentNearestBridgeInfo(),
        };

        this.bridgeTextHistory.push(change);
        this.lastBridgeText = value;

        this._logVerbose(`🔄 BRIDGE TEXT CHANGED: "${value}"`);
        this._logVerbose(`   Previous: "${change.previousText}"`);
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
   * Log current app state with detailed bridge text analysis
   * @private
   */
  _logCurrentAppState() {
    const vesselCount = this.app.vesselDataService?.getVesselCount() || 0;
    this._logVerbose(`\n🚢 SYSTEMSTATUS: ${vesselCount} vessels active`);

    if (vesselCount > 0) {
      const vessels = this.app.vesselDataService.getAllVessels();
      this._logVerbose('📊 VESSEL DETALJER:');
      vessels.forEach((vessel, index) => {
        const distance = vessel._distanceToNearest?.toFixed(0) || 'unknown';
        const eta = vessel.etaMinutes ? `${vessel.etaMinutes.toFixed(1)}min` : 'N/A';
        const targetBridge = vessel.targetBridge || 'ingen';

        this._logVerbose(`   ${index + 1}. "${vessel.name}" (${vessel.mmsi})`);
        this._logVerbose(`      📍 Status: ${vessel.status} → Target: ${targetBridge}`);
        this._logVerbose(`      📏 Avstånd: ${distance}m | ⏱️ ETA: ${eta}`);
      });

      // Show current bridge text with analysis
      const currentBridgeText = this.getCurrentBridgeText();
      this._logVerbose('\n📢 AKTUELL BRIDGE TEXT:');
      this._logVerbose(`   "${currentBridgeText}"`);

      // Analyze bridge text content
      if (currentBridgeText !== 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron') {
        this._logVerbose('📝 BRIDGE TEXT ANALYS:');

        // Check for specific patterns
        if (currentBridgeText.includes('En båt')) this._logVerbose('   ✓ Single vessel message');
        if (currentBridgeText.includes('Två båtar')) this._logVerbose('   ✓ Two vessel message');
        if (currentBridgeText.includes('Tre båtar')) this._logVerbose('   ✓ Three vessel message');
        if (currentBridgeText.includes('ytterligare')) this._logVerbose('   ✓ Multi-vessel formatting');
        if (currentBridgeText.includes('beräknad broöppning om')) this._logVerbose('   ✓ ETA included');
        if (currentBridgeText.includes('Stallbackabron')) this._logVerbose('   ✓ Stallbackabron mentioned');
        if (currentBridgeText.includes('åker strax under')) this._logVerbose('   ✓ Stallbackabron special message');
        if (currentBridgeText.includes('inväntar broöppning')) this._logVerbose('   ✓ Waiting message');
        if (currentBridgeText.includes('har precis passerat')) this._logVerbose('   ✓ Just passed message');
      }
    } else {
      this._logVerbose('📢 BRIDGE TEXT: "Inga båtar i systemet"');
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

    this._logVerbose(`📢 CURRENT BRIDGE TEXT: "${currentBridgeText}"`);

    if (currentBridgeText !== this.lastBridgeText) {
      this._logVerbose(`🔄 DETECTED CHANGE: "${this.lastBridgeText}" → "${currentBridgeText}"`);

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
      this._logVerbose('✅ No bridge text change');
    }
  }

  /**
   * Generate comprehensive journey report
   * @private
   */
  _generateJourneyReport(scenarioName) {
    this._logVerbose(`\n${'='.repeat(80)}`);
    this._logVerbose('📋 REAL APP JOURNEY REPORT');
    this._logVerbose('='.repeat(80));

    this._logVerbose(`🎬 Scenario: ${scenarioName}`);
    this._logVerbose(`📊 Total steps: ${this.stepNumber}`);
    this._logVerbose(`🔄 Bridge text changes: ${this.bridgeTextHistory.length}`);
    this._logVerbose(`📢 Final bridge text: "${this.lastBridgeText}"`);

    if (this.bridgeTextHistory.length > 0) {
      this._logVerbose('\n📝 All Bridge Text Changes:');
      this.bridgeTextHistory.forEach((change, index) => {
        this._logVerbose(`\n  ${index + 1}. Step ${change.step}: ${change.description || 'N/A'}`);
        this._logVerbose(`     From: "${change.previousText}"`);
        this._logVerbose(`     To:   "${change.newText}"`);
        this._logVerbose(`     Vessels: ${change.vessels.length} active`);
        if (change.vessels.length > 0) {
          change.vessels.forEach((vessel) => {
            this._logVerbose(`       - ${vessel.name}: ${vessel.status} → ${vessel.targetBridge} (${vessel.distance}m, ${vessel.etaMinutes}min)`);
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
   * Get current bridge text from app
   */
  getCurrentBridgeText() {
    if (!this.app || !this.app.bridgeTextService) {
      return 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
    }

    const relevantVessels = this.app._findRelevantBoatsForBridgeText();
    return this.app.bridgeTextService.generateBridgeText(relevantVessels);
  }

  /**
   * Get nearest bridge info for the first active vessel
   */
  getCurrentNearestBridgeInfo() {
    if (!this.app || !this.app.vesselDataService || !this.app.proximityService) {
      return { name: null, distance: null };
    }
    const vessels = this.app.vesselDataService.getAllVessels();
    if (!vessels || vessels.length === 0) {
      return { name: null, distance: null };
    }
    const vessel = vessels[0];
    try {
      const prox = this.app.proximityService.analyzeVesselProximity(vessel);
      const name = prox.nearestBridge ? prox.nearestBridge.name : null;
      const distance = Number.isFinite(prox.nearestDistance) ? Math.round(prox.nearestDistance) : null;
      return { name, distance };
    } catch (e) {
      return { name: null, distance: null };
    }
  }

  /**
   * Get last and previous bridge text snapshot
   */
  getBridgeTextSnapshot() {
    const current = this.lastBridgeText;
    let previous = null;
    if (this.bridgeTextHistory && this.bridgeTextHistory.length > 0) {
      const lastChange = this.bridgeTextHistory[this.bridgeTextHistory.length - 1];
      previous = lastChange ? lastChange.previousText : null;
    }
    return { current, previous };
  }

  /**
   * Utility wait function
   * @private
   */
  async _wait(ms) {
    const scaled = Math.max(0, Math.round(ms * this._waitMultiplier));
    if (scaled === 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, scaled));
  }

  /**
   * Logging helpers with adjustable verbosity
   * @private
   */
  _shouldLog(level = 'summary') {
    const weights = { silent: 0, summary: 1, verbose: 2 };
    const current = weights[this.logLevel] ?? 1;
    const requested = weights[level] ?? 1;
    return requested <= current;
  }

  _log(level, ...args) {
    if (this._shouldLog(level)) {
      console.log(...args); // eslint-disable-line no-console
    }
  }

  _logSummary(...args) {
    this._log('summary', ...args);
  }

  _logVerbose(...args) {
    this._log('verbose', ...args);
  }

  /**
   * Generate bridge text for a specific vessel configuration (for golden snapshot testing)
   * This method:
   * 1. Clears all vessels from app state
   * 2. Processes provided vessels as AIS messages
   * 3. Returns the resulting bridge text
   * @param {Array} vessels - Array of vessel objects with {mmsi, name, lat, lon, sog, cog}
   * @returns {Promise<string>} Generated bridge text
   */
  async generateBridgeTextFromVessels(vessels) {
    if (!this.app) {
      throw new Error('App not initialized. Call initializeApp() first.');
    }

    // Clear all existing vessels to ensure clean state
    const existingVessels = this.app.vesselDataService.getAllVessels();
    for (const vessel of existingVessels) {
      this.app.vesselDataService.removeVessel(vessel.mmsi, 'snapshot-cleanup');
    }

    // Process each provided vessel as AIS message
    for (const vessel of vessels) {
      await this._processVesselAsAISMessage(vessel);
    }

    // Wait for app to fully process and update bridge text
    await this._wait(18);

    // Get and return the resulting bridge text
    return this.getCurrentBridgeText();
  }

  /**
   * Scale internal wait times (0 = immediate, 0.1 = 10% of real duration)
   * @param {number} multiplier
   */
  setWaitMultiplier(multiplier) {
    if (!Number.isFinite(multiplier) || multiplier < 0) {
      throw new Error(`Invalid wait multiplier: ${multiplier}`);
    }
    this._waitMultiplier = multiplier;
  }

  /**
   * Cleanup after tests
   */
  async cleanup() {
    if (this.app) {
      await this.app.onUninit();
      this.app = null;
    }
    // Clear test mode flag
    delete global.__TEST_MODE__;
  }
}

module.exports = RealAppTestRunner;
