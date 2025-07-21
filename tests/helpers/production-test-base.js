// PRODUCTION TEST BASE - Gemensam bas för alla tester som använder samma logik som appen
// Denna hjälpfil säkerställer att alla tester använder exakt samma boat structure som produktionen

// Mock Homey SDK
const mockHomey = {
  app: {
    log: () => {}, error: () => {}, debug: () => {}, setSettings: () => {}, getSettings: () => ({}), getSetting: () => null, setSetting: () => {}, on: () => {}, off: () => {}, emit: () => {},
  },
  flow: { createToken: () => Promise.resolve({ setValue: () => Promise.resolve(), getValue: () => Promise.resolve('') }), getDeviceTriggerCard: () => ({ registerRunListener: () => {}, trigger: () => Promise.resolve() }), getConditionCard: () => ({ registerRunListener: () => {} }) },
  drivers: { getDriver: () => ({ getDevices: () => [] }) },
};

const Module = require('module');

const originalRequire = Module.prototype.require;
Module.prototype.require = function mockRequire(...args) {
  if (args[0] === 'homey') {
    return {
      App: class {
        constructor() {
          this.homey = mockHomey;
        }
      },
    };
  }
  return originalRequire.apply(this, args);
};

// Import MessageGenerator
const { MessageGenerator } = require('../../app');

// Bridge definitions (CORRECTED to match production app.js exactly)
const BRIDGES = {
  olidebron: {
    name: 'Olidebron', lat: 58.272743083145855, lon: 12.275115821922993, radius: 300,
  },
  klaffbron: {
    name: 'Klaffbron', lat: 58.28409551543077, lon: 12.283929525245636, radius: 300,
  },
  jarnvagsbron: {
    name: 'Järnvägsbron', lat: 58.29164042152742, lon: 12.292025280073759, radius: 300,
  },
  stridsbergsbron: {
    name: 'Stridsbergsbron', lat: 58.293524096154634, lon: 12.294566425158054, radius: 300,
  },
  stallbackabron: {
    name: 'Stallbackabron', lat: 58.31142992293701, lon: 12.31456385688822, radius: 300,
  },
};

// Create production-accurate boat objects using EXACT same structure as _findRelevantBoats creates
function createProductionBoat(mmsi, name, options = {}) {
  // This is the EXACT structure from app.js lines 3124-3141 in _findRelevantBoats + vessel tracking properties

  // Enhanced currentBridge logic to match the production app fix
  let { currentBridge } = options;
  if (!currentBridge) {
    if (options.nearBridge) {
      // Priority 1: Use nearBridge if available
      currentBridge = BRIDGES[options.nearBridge]?.name;
    } else if (options.passedBridges && options.passedBridges.length > 0) {
      // Priority 2: Use last passed bridge
      const lastPassedBridgeId = options.passedBridges[options.passedBridges.length - 1];
      currentBridge = BRIDGES[lastPassedBridgeId]?.name;
    } else if (options.targetBridge) {
      // Priority 3: Use targetBridge as fallback to prevent "vid null"
      currentBridge = options.targetBridge;
    }
    // Note: We skip the nearest bridge calculation here since it requires coordinates
  }

  return {
    mmsi,
    name: name || 'Unknown',
    targetBridge: options.targetBridge,
    currentBridge,
    nearBridge: options.nearBridge,
    etaMinutes: options.etaMinutes,
    isWaiting: options.isWaiting || options.status === 'waiting',
    isApproaching: options.isApproaching || options.status === 'approaching',
    confidence: options.confidence || (options.status === 'approaching' ? 'high' : 'medium'),
    status: options.status || 'idle',
    lastPassedBridgeTime: options.lastPassedBridgeTime,
    distance: options.distance,
    distanceToCurrent: options.distanceToCurrent,
    sog: options.sog || 0,

    // Critical properties for production accuracy - missing from original
    lat: options.lat || BRIDGES.klaffbron.lat, // Default to Klaffbron coordinates
    lon: options.lon || BRIDGES.klaffbron.lon,
    lastPosition: options.lastPosition || {
      lat: options.lat || BRIDGES.klaffbron.lat,
      lon: options.lon || BRIDGES.klaffbron.lon,
    },
    lastPositionChange: options.lastPositionChange || Date.now() - 60000, // 1 min ago default
    _distanceToNearest: options._distanceToNearest || options.distance || 300,
    _lastSeen: options._lastSeen || Date.now(),
    passedBridges: options.passedBridges || [],

    // July 2025 new properties for enhanced tracking
    cog: options.cog || 0, // Course over ground for protection zone logic
    _detectedTargetBridge: options._detectedTargetBridge, // Temporary target bridge cache
    _targetApproachBearing: options._targetApproachBearing, // For bearing-based passage detection
    _nearApproachBearing: options._nearApproachBearing, // For bearing-based passage detection
    protectionZoneEntry: options.protectionZoneEntry, // For 25-minute timeout logic
    maxRecentSpeed: options.maxRecentSpeed || options.sog || 0, // For waiting detection

    // GPS jump and stale data detection properties
    lastDataUpdate: options.lastDataUpdate || Date.now(),
    previousDistance: options.previousDistance, // For frozen data detection
    dataFrozenCount: options.dataFrozenCount || 0, // Count of identical readings

    // Speed history for smart approach detection
    speedHistory: options.speedHistory || [],

    // Route and sequence tracking
    routeSequence: options.routeSequence || [],
    hasActiveRoute: options.hasActiveRoute || false,
  };
}

// Create logger with configurable debug output
function createTestLogger(showDebug = false) {
  return {
    debug: (...args) => {
      if (showDebug) {
        const message = args.join(' ');
        if (message.includes('[BRIDGE_TEXT]')
            || message.includes('precis passerat')
            || message.includes('Under-bridge')
            || message.includes('Mellanbro')) {
          console.log('      [DEBUG]', ...args);
        }
      }
    },
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// Create production-accurate MessageGenerator
function createProductionMessageGenerator(showDebug = false) {
  const logger = createTestLogger(showDebug);
  return new MessageGenerator(BRIDGES, logger);
}

// Test step helper function
function runTestStep(title, description, boats, expectedPatterns, messageGenerator, showResults = true) {
  if (showResults) {
    console.log(`📋 ${title}`);
    console.log(`   📍 ${description}`);

    if (expectedPatterns.length > 0) {
      console.log(`   🎯 Förväntat: ${expectedPatterns.join(' ELLER ')}`);
    }
  }

  const result = messageGenerator.generateBridgeText(boats);

  if (showResults) {
    console.log(`   🌉 BRIDGE_TEXT: "${result}"`);
    console.log('');
  }

  return result;
}

// Validate that result matches expected patterns
function validateResult(result, expectedPatterns, testName) {
  const matches = expectedPatterns.some((pattern) => {
    if (pattern.includes('*')) {
      // Wildcard matching for partial patterns
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(result);
    }
    return result.includes(pattern);
  });

  if (!matches) {
    console.log(`⚠️  ${testName} unexpected result:`);
    console.log(`   Expected one of: ${expectedPatterns.join(' OR ')}`);
    console.log(`   Got: "${result}"`);
  }

  return matches;
}

// Enhanced test helpers for comprehensive scenarios
function createStationaryBoat(mmsi, name, options = {}) {
  return createProductionBoat(mmsi, name, {
    ...options,
    sog: 0.2, // Below movement threshold
    lastPositionChange: Date.now() - 60000, // 1 minute ago - no recent movement
    _distanceToNearest: options.distance || 400, // Away from bridge
    status: 'idle',
  });
}

function createProtectionZoneBoat(mmsi, name, options = {}) {
  return createProductionBoat(mmsi, name, {
    ...options,
    distance: options.distance || 250, // Within 300m protection zone
    cog: options.cog || 45, // Heading towards bridge initially
    protectionZoneEntry: Date.now() - (options.timeInZone || 5) * 60 * 1000, // Default 5min ago
    status: options.status || 'approaching',
  });
}

function createGPSJumpBoat(mmsi, name, options = {}) {
  return createProductionBoat(mmsi, name, {
    ...options,
    lastDataUpdate: Date.now() - (options.gapMinutes || 6) * 60 * 1000, // 6+ minute gap
    previousDistance: options.previousDistance || 150, // Last known position
    distance: options.distance || 800, // Current position after jump
    dataFrozenCount: 0, // Reset after jump
    status: options.status || 'approaching',
  });
}

function createBearingTestBoat(mmsi, name, options = {}) {
  return createProductionBoat(mmsi, name, {
    ...options,
    _targetApproachBearing: options.approachBearing || 0, // North approach
    _nearApproachBearing: options.nearApproachBearing,
    cog: options.currentBearing || 180, // Now south = passed
    distance: options.distance || 100,
    status: options.status || 'approaching',
  });
}

// Enhanced result validation with detailed error reporting
function validateProductionResult(result, expectedPatterns, testName, showDetails = false) {
  const matches = expectedPatterns.some((pattern) => {
    if (pattern.includes('*')) {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(result);
    }
    return result.includes(pattern);
  });

  if (!matches) {
    console.log(`⚠️  ${testName} VALIDATION FAILED:`);
    console.log(`   Expected one of: ${expectedPatterns.join(' OR ')}`);
    console.log(`   Got: "${result}"`);

    if (showDetails) {
      console.log('   Pattern analysis:');
      expectedPatterns.forEach((pattern, i) => {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        console.log(`     ${i + 1}. "${pattern}" → ${regex.test(result) ? 'MATCH' : 'NO MATCH'}`);
      });
    }
  } else if (showDetails) {
    console.log(`✅ ${testName} validation passed`);
  }

  return matches;
}

module.exports = {
  BRIDGES,
  createProductionBoat,
  createStationaryBoat,
  createProtectionZoneBoat,
  createGPSJumpBoat,
  createBearingTestBoat,
  createProductionMessageGenerator,
  runTestStep,
  validateResult,
  validateProductionResult,
};
