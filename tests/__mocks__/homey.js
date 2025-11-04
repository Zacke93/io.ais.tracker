/* eslint-disable max-classes-per-file */
// Comprehensive Homey SDK mock for testing
// Provides all necessary Homey APIs used by the AIS Tracker app

// Mock WebSocket for testing
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    // Simulate connection opening
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 10);
  }

  send(data) {
    // Mock send operation
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  // Helper method for tests to simulate receiving messages
  simulateMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  // Helper method to simulate errors
  simulateError(error) {
    if (this.onerror) {
      this.onerror(error);
    }
  }
}

// Mock Homey App class
class MockApp {
  constructor() {
    this.homey = null; // Will be set after mockHomey is created
    this.settings = {};
    this.listeners = {};
  }

  log(...args) {
    // Optional: console.log('[APP]', ...args);
  }

  error(...args) {
    console.error('[APP ERROR]', ...args);
  }

  debug(...args) {
    // Optional: console.log('[APP DEBUG]', ...args);
  }

  setSettings(settings) {
    this.settings = { ...this.settings, ...settings };
  }

  getSettings() {
    return this.settings;
  }

  getSetting(key) {
    return this.settings[key] || null;
  }

  setSetting(key, value) {
    this.settings[key] = value;
  }

  on(event, listener) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(listener);
  }

  off(event, listener) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((l) => l !== listener);
    }
  }

  emit(event, ...args) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((listener) => listener(...args));
    }
  }
}

// Mock flow token
class MockFlowToken {
  constructor(id, value = '') {
    this.id = id;
    this.value = value;
  }

  async setValue(value) {
    this.value = value;
    return Promise.resolve();
  }

  async getValue() {
    return Promise.resolve(this.value);
  }
}

// Mock flow card with enhanced trigger tracking
class MockFlowCard {
  constructor() {
    this.runListeners = [];
    this.triggerCalls = []; // Track all trigger calls for testing
  }

  registerRunListener(listener) {
    this.runListeners.push(listener);
  }

  async trigger(deviceOrTokens, tokensOrState, state) {
    // CRITICAL FIX: Handle both app-level (2 params) and device-level (3 params) trigger calls
    // App-level: trigger(tokens, state)
    // Device-level: trigger(device, tokens, state)

    let device = null;
    let tokens = null;
    let actualState = null;

    // Detect call signature by checking if first param looks like a device or tokens object
    if (arguments.length === 2) {
      // App-level trigger: trigger(tokens, state)
      tokens = deviceOrTokens;
      actualState = tokensOrState;
    } else {
      // Device-level trigger: trigger(device, tokens, state)
      device = deviceOrTokens;
      tokens = tokensOrState;
      actualState = state;
    }

    // CRITICAL: Validate tokens exactly like real Homey does
    // This will catch the same errors that occurred in production logs

    try {
      // Validate boat_near flow tokens (from app.json schema)
      if (tokens.vessel_name !== undefined && typeof tokens.vessel_name !== 'string') {
        throw new Error(`Could not trigger Flow card with id "boat_near": Invalid value for token vessel_name. Expected string but got ${typeof tokens.vessel_name}`);
      }

      if (tokens.bridge_name !== undefined && typeof tokens.bridge_name !== 'string') {
        throw new Error(`Could not trigger Flow card with id "boat_near": Invalid value for token bridge_name. Expected string but got ${typeof tokens.bridge_name}`);
      }

      if (tokens.direction !== undefined && typeof tokens.direction !== 'string') {
        throw new Error(`Could not trigger Flow card with id "boat_near": Invalid value for token direction. Expected string but got ${typeof tokens.direction}`);
      }

      if (tokens.eta_minutes !== undefined && tokens.eta_minutes !== null && typeof tokens.eta_minutes !== 'number') {
        throw new Error(`Could not trigger Flow card with id "boat_near": Invalid value for token eta_minutes. Expected number but got ${typeof tokens.eta_minutes}`);
      }

      // CRITICAL: bridge_name must be defined and not null/undefined
      if (tokens.bridge_name === undefined || tokens.bridge_name === null) {
        throw new Error(`Could not trigger Flow card with id "boat_near": Invalid value for token bridge_name. Expected string but got ${tokens.bridge_name}`);
      }

      // Track successful trigger call
      const triggerCall = {
        timestamp: new Date().toISOString(),
        device: device ? device.constructor.name : null,
        tokens: { ...tokens },
        state: { ...actualState },
        success: true,
      };

      this.triggerCalls.push(triggerCall);
      console.log('🎯 Flow trigger called:', JSON.stringify(triggerCall, null, 2));

      return Promise.resolve();

    } catch (error) {
      // Track failed trigger call
      const triggerCall = {
        timestamp: new Date().toISOString(),
        device: device ? device.constructor.name : null,
        tokens: { ...tokens },
        state: { ...actualState },
        success: false,
        error: error.message,
      };

      this.triggerCalls.push(triggerCall);
      console.log('❌ Flow trigger FAILED:', JSON.stringify(triggerCall, null, 2));

      // Re-throw the error to match real Homey behavior
      throw error;
    }
  }

  // Helper for tests to simulate flow card execution
  async simulateRun(args, state) {
    for (const listener of this.runListeners) {
      const result = await listener(args, state);
      if (result !== undefined) return result;
    }
    return true;
  }

  // Test helpers
  getTriggerCalls() {
    return this.triggerCalls;
  }

  clearTriggerCalls() {
    this.triggerCalls = [];
  }
}

// Mock device
class MockDevice {
  constructor() {
    this.capabilities = {};
    this.listeners = {};
  }

  async setCapabilityValue(capability, value) {
    this.capabilities[capability] = value;
    this.emit(`capability_${capability}`, value);
    return Promise.resolve();
  }

  getCapabilityValue(capability) {
    return this.capabilities[capability];
  }

  on(event, listener) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(listener);
  }

  emit(event, ...args) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((listener) => listener(...args));
    }
  }
}

// Mock driver
class MockDriver {
  constructor() {
    this.devices = [];
  }

  getDevices() {
    return this.devices;
  }

  addDevice(device) {
    this.devices.push(device);
  }
}

// Create app instance
const appInstance = new MockApp();

// Main Homey mock object
const mockHomey = {
  app: appInstance,

  flow: {
    createToken: async (id, value) => {
      return Promise.resolve(new MockFlowToken(id, value));
    },

    getTriggerCard: (id) => {
      return new MockFlowCard();
    },

    getDeviceTriggerCard: (id) => {
      return new MockFlowCard();
    },

    getConditionCard: (id) => {
      return new MockFlowCard();
    },
  },

  drivers: {
    getDriver: (id) => {
      return new MockDriver();
    },
  },

  // Utility methods for creating mock objects
  createMockDevice: () => new MockDevice(),
  createMockWebSocket: (url) => new MockWebSocket(url),
};

// Set the circular reference after mockHomey is created
appInstance.homey = mockHomey;

// Global WebSocket mock
global.WebSocket = MockWebSocket;

// Module export for require('homey')
module.exports = {
  App: MockApp,
  Device: MockDevice,
  Driver: MockDriver,
  __mockHomey: mockHomey, // Export for direct access in tests
};
