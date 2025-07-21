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

// Mock flow card
class MockFlowCard {
  constructor() {
    this.runListeners = [];
  }

  registerRunListener(listener) {
    this.runListeners.push(listener);
  }

  async trigger(device, tokens, state) {
    return Promise.resolve();
  }

  // Helper for tests to simulate flow card execution
  async simulateRun(args, state) {
    for (const listener of this.runListeners) {
      const result = await listener(args, state);
      if (result !== undefined) return result;
    }
    return true;
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
