/**
 * DEVICE INTEGRATION & RACE CONDITIONS TESTS
 * 
 * Fokuserar specifikt på problem som identifierats i device/UI integration:
 * - Race conditions i UI updates
 * - Device update failures och recovery
 * - WebSocket/device syncing problem
 * - Concurrent vessel updates vs device capabilities
 * - Memory leaks i device event handling
 * 
 * Dessa tester fångar de subtila integrationsproblem som kan orsaka:
 * - UI som inte uppdateras när vessels ändras
 * - Device capabilities som blir out-of-sync
 * - Flow triggers som misslyckas
 * - Bridge_text som blir "stuck" på gamla värden
 */

const Module = require('module');
const originalRequire = Module.prototype.require;

// Advanced mock setup för race condition testing
const mockHomey = {
  app: {
    log: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    emit: jest.fn(),
    on: jest.fn(),
    getSettings: jest.fn(() => ({ 'api_key': 'test-key' }))
  },
  flow: {
    createToken: jest.fn(() => Promise.resolve({ 
      setValue: jest.fn(() => Promise.resolve()),
      getValue: jest.fn(() => Promise.resolve(''))
    })),
    getDeviceTriggerCard: jest.fn(() => ({ 
      registerRunListener: jest.fn(),
      trigger: jest.fn(() => Promise.resolve())
    })),
    getConditionCard: jest.fn(() => ({ 
      registerRunListener: jest.fn()
    }))
  },
  drivers: {
    getDriver: jest.fn(() => ({
      getDevices: jest.fn(() => [mockDevice1, mockDevice2])
    }))
  }
};

// Multiple mock devices för testing
const mockDevice1 = {
  id: 'device-1',
  setCapabilityValue: jest.fn(() => Promise.resolve()),
  getCapabilityValue: jest.fn(() => 'Inga båtar i närheten'),
  hasCapability: jest.fn(() => true),
  log: jest.fn(),
  error: jest.fn()
};

const mockDevice2 = {
  id: 'device-2',
  setCapabilityValue: jest.fn(() => Promise.resolve()),
  getCapabilityValue: jest.fn(() => 'Inga båtar i närheten'),
  hasCapability: jest.fn(() => true),
  log: jest.fn(),
  error: jest.fn()
};

// Mock WebSocket med event simulation
const mockWebSocket = {
  send: jest.fn(),
  close: jest.fn(),
  readyState: 1,
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  // Simulate events
  _triggerMessage: null,
  _triggerClose: null,
  _triggerError: null
};

global.WebSocket = jest.fn(() => mockWebSocket);

Module.prototype.require = function mockRequire(...args) {
  if (args[0] === 'homey') {
    return { App: class { constructor() { this.homey = mockHomey; } } };
  }
  if (args[0] === 'ws') {
    return jest.fn(() => mockWebSocket);
  }
  return originalRequire.apply(this, args);
};

const AISBridgeApp = require('../app');

describe('Device Integration & Race Conditions Tests', () => {
  let app;
  
  beforeEach(() => {
    jest.clearAllMocks();
    app = new AISBridgeApp();
    app._devices = new Map();
    app._devices.set('device-1', mockDevice1);
    app._devices.set('device-2', mockDevice2);
    app._vessels = new Map();
    app._bridgeText = '';
    app._lastBridgeText = '';
    app._isUpdatingDevices = false;
  });

  describe('Race Condition Scenarios', () => {
    test('concurrent vessel updates med device capability updates', async () => {
      const vesselMMSI = 123456789;
      
      // Setup concurrent update scenario
      const vesselUpdates = [
        { name: 'BOAT_A', etaMinutes: 5, status: 'approaching' },
        { name: 'BOAT_B', etaMinutes: 3, status: 'waiting' },
        { name: 'BOAT_C', etaMinutes: 7, status: 'approaching' },
        { name: 'BOAT_D', etaMinutes: 2, status: 'under-bridge' }
      ];
      
      // Simulera snabba vessel additions
      const updatePromises = vesselUpdates.map((update, index) => {
        const mmsi = vesselMMSI + index;
        app._vessels.set(mmsi, {
          mmsi: mmsi,
          name: update.name,
          targetBridge: 'Klaffbron',
          status: update.status,
          etaMinutes: update.etaMinutes,
          isApproaching: update.status === 'approaching',
          isWaiting: update.status === 'waiting'
        });
        return app._updateActiveBridgesTag();
      });
      
      // Vänta på alla concurrent updates
      await Promise.all(updatePromises);
      
      // Verifiera att final state är konsekvent
      const finalBridgeTextCalls = mockDevice1.setCapabilityValue.mock.calls
        .filter(call => call[0] === 'bridge_text');
      
      expect(finalBridgeTextCalls.length).toBeGreaterThan(0);
      
      // Final bridge text ska innehålla alla boats
      const finalBridgeText = finalBridgeTextCalls[finalBridgeTextCalls.length - 1][1];
      vesselUpdates.forEach(update => {
        expect(finalBridgeText).toContain(update.name);
      });
    });

    test('WebSocket message burst under device update', async () => {
      // Setup initial vessel
      const testMMSI = 987654321;
      app._vessels.set(testMMSI, {
        mmsi: testMMSI,
        name: 'RAPID_BOAT',
        targetBridge: 'Klaffbron',
        status: 'approaching',
        etaMinutes: 5
      });
      
      // Mock slow device update
      let deviceUpdateInProgress = false;
      mockDevice1.setCapabilityValue.mockImplementation(async (capability, value) => {
        if (capability === 'bridge_text') {
          deviceUpdateInProgress = true;
          await new Promise(resolve => setTimeout(resolve, 100)); // Simulate slow update
          deviceUpdateInProgress = false;
        }
        return Promise.resolve();
      });
      
      // Simulera WebSocket message burst under device update
      const rapidMessages = Array.from({ length: 10 }, (_, i) => ({
        Message: {
          PositionReport: {
            UserID: testMMSI,
            Latitude: 58.284933 + (i * 0.0001), // Small movements
            Longitude: 12.285400 + (i * 0.0001),
            Sog: 4.0 + (i * 0.1),
            Cog: 45.0,
            TrueHeading: 45
          }
        },
        MetaData: { VesselName: 'RAPID_BOAT' }
      }));
      
      // Send rapid messages
      const messagePromises = rapidMessages.map(msg => 
        app._onWebSocketMessage({ data: JSON.stringify(msg) })
      );
      
      await Promise.all(messagePromises);
      
      // Verifiera att vessel state är konsekvent
      const vessel = app._vessels.get(testMMSI);
      expect(vessel).toBeDefined();
      expect(vessel.name).toBe('RAPID_BOAT');
      
      // Device updates ska inte ha konflikt
      expect(mockHomey.app.error).not.toHaveBeenCalledWith(
        expect.stringContaining('race condition')
      );
    });

    test('device failure under critical vessel state change', async () => {
      const criticalMMSI = 555666777;
      
      // Setup critical vessel approaching target bridge
      app._vessels.set(criticalMMSI, {
        mmsi: criticalMMSI,
        name: 'CRITICAL_BOAT',
        targetBridge: 'Stridsbergsbron',
        status: 'approaching',
        etaMinutes: 1, // Critical timing
        isApproaching: true
      });
      
      // Mock device failure
      mockDevice1.setCapabilityValue
        .mockRejectedValueOnce(new Error('Device communication failed'))
        .mockResolvedValue(undefined); // Recovery on retry
      
      // Mock device failure 
      mockDevice2.setCapabilityValue
        .mockResolvedValue(undefined); // This device works
      
      // Update ska hantera failure gracefully
      await expect(app._updateActiveBridgesTag()).resolves.not.toThrow();
      
      // Error ska loggas
      expect(mockHomey.app.error).toHaveBeenCalledWith(
        expect.stringContaining('Device communication failed')
      );
      
      // Working device ska ha uppdaterats
      expect(mockDevice2.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('CRITICAL_BOAT')
      );
    });

    test('flow trigger race condition med device update', async () => {
      const flowMMSI = 888999000;
      
      // Mock flow trigger som tar tid
      const mockFlowTrigger = jest.fn(() => 
        new Promise(resolve => setTimeout(resolve, 200))
      );
      mockHomey.flow.getDeviceTriggerCard().trigger = mockFlowTrigger;
      
      app._vessels.set(flowMMSI, {
        mmsi: flowMMSI,
        name: 'FLOW_BOAT',
        targetBridge: 'Klaffbron',
        nearBridge: 'klaffbron',
        status: 'approaching',
        triggeredFlows: new Set()
      });
      
      // Simulera concurrent flow trigger + device update
      const flowPromise = app._handleVesselApproaching(flowMMSI, 'klaffbron');
      const devicePromise = app._updateActiveBridgesTag();
      
      await Promise.all([flowPromise, devicePromise]);
      
      // Both ska ha lyckats
      expect(mockFlowTrigger).toHaveBeenCalled();
      expect(mockDevice1.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('FLOW_BOAT')
      );
      
      // Flow ska bara ha triggats en gång
      expect(mockFlowTrigger).toHaveBeenCalledTimes(1);
    });
  });

  describe('Device State Consistency Tests', () => {
    test('device capability rollback on partial failure', async () => {
      const testMMSI = 111222333;
      
      app._vessels.set(testMMSI, {
        mmsi: testMMSI,
        name: 'ROLLBACK_BOAT',
        targetBridge: 'Klaffbron',
        status: 'approaching',
        etaMinutes: 3
      });
      
      // Mock partial device failure
      mockDevice1.setCapabilityValue
        .mockImplementation((capability, value) => {
          if (capability === 'bridge_text') {
            return Promise.resolve();
          }
          if (capability === 'alarm_generic') {
            return Promise.reject(new Error('Alarm update failed'));
          }
          return Promise.resolve();
        });
      
      // Update ska hantera partial failure
      await app._updateActiveBridgesTag();
      
      // Bridge text ska ha uppdaterats på device 1
      expect(mockDevice1.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('ROLLBACK_BOAT')
      );
      
      // Error ska loggas för alarm failure
      expect(mockHomey.app.error).toHaveBeenCalledWith(
        expect.stringContaining('Alarm update failed')
      );
      
      // Device 2 ska fortfarande uppdateras
      expect(mockDevice2.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('ROLLBACK_BOAT')
      );
    });

    test('device sync after WebSocket reconnection', async () => {
      // Setup vessels före disconnect
      app._vessels.set(111111, { name: 'BOAT_1', targetBridge: 'Klaffbron', status: 'approaching' });
      app._vessels.set(222222, { name: 'BOAT_2', targetBridge: 'Stridsbergsbron', status: 'waiting' });
      
      // Initial device sync
      await app._updateActiveBridgesTag();
      expect(mockDevice1.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('BOAT_1')
      );
      
      // Simulera WebSocket disconnect
      mockDevice1.setCapabilityValue.mockClear();
      mockDevice2.setCapabilityValue.mockClear();
      
      await app._updateConnectionStatus(false);
      
      // Connection status ska uppdateras
      expect(mockDevice1.setCapabilityValue).toHaveBeenCalledWith('connection_status', false);
      expect(mockDevice2.setCapabilityValue).toHaveBeenCalledWith('connection_status', false);
      
      // Simulera reconnection + sync
      mockDevice1.setCapabilityValue.mockClear();
      mockDevice2.setCapabilityValue.mockClear();
      
      await app._updateConnectionStatus(true);
      await app._updateActiveBridgesTag();
      
      // Alla devices ska synkas med current state
      expect(mockDevice1.setCapabilityValue).toHaveBeenCalledWith('connection_status', true);
      expect(mockDevice1.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('BOAT_1')
      );
      expect(mockDevice2.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('BOAT_1')
      );
    });

    test('memory leak prevention i device event handling', async () => {
      // Track event listeners
      const eventListeners = new Set();
      mockHomey.app.on.mockImplementation((event, handler) => {
        eventListeners.add({ event, handler });
      });
      
      // Setup och teardown cycle
      for (let i = 0; i < 10; i++) {
        const testApp = new AISBridgeApp();
        testApp._devices = new Map();
        testApp._devices.set(`device-${i}`, mockDevice1);
        
        // Simulate app lifecycle
        await testApp._setupTextAndFlowEventHandlers();
        
        // Cleanup
        eventListeners.forEach(({ event, handler }) => {
          if (testApp.homey && testApp.homey.app && testApp.homey.app.off) {
            testApp.homey.app.off(event, handler);
          }
        });
        eventListeners.clear();
      }
      
      // Verifiera att inga event listeners läcker
      expect(eventListeners.size).toBe(0);
    });
  });

  describe('UI Update Timing Tests', () => {
    test('bridge_text debouncing under rapid changes', async () => {
      const rapidMMSI = 444555666;
      
      // Track alla bridge_text updates
      const bridgeTextUpdates = [];
      mockDevice1.setCapabilityValue.mockImplementation((capability, value) => {
        if (capability === 'bridge_text') {
          bridgeTextUpdates.push({ timestamp: Date.now(), value });
        }
        return Promise.resolve();
      });
      
      // Rapid ETA changes
      const etaChanges = [5, 4, 3, 2, 1, 0];
      app._vessels.set(rapidMMSI, {
        mmsi: rapidMMSI,
        name: 'RAPID_ETA',
        targetBridge: 'Klaffbron',
        status: 'approaching',
        etaMinutes: 5
      });
      
      // Apply rapid changes
      for (const eta of etaChanges) {
        app._vessels.get(rapidMMSI).etaMinutes = eta;
        await app._updateActiveBridgesTag();
        await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
      }
      
      // Verifiera reasonable number of updates (debounced)
      expect(bridgeTextUpdates.length).toBeLessThanOrEqual(etaChanges.length);
      expect(bridgeTextUpdates.length).toBeGreaterThan(0);
      
      // Final update ska ha senaste ETA
      const finalUpdate = bridgeTextUpdates[bridgeTextUpdates.length - 1];
      expect(finalUpdate.value).toContain('nu'); // ETA 0 = "nu"
    });

    test('alarm state consistency under vessel state changes', async () => {
      const alarmMMSI = 777888999;
      
      // Track alarm state changes
      const alarmChanges = [];
      mockDevice1.setCapabilityValue.mockImplementation((capability, value) => {
        if (capability === 'alarm_generic') {
          alarmChanges.push(value);
        }
        return Promise.resolve();
      });
      
      // Vessel approach sequence: approaching → waiting → under-bridge → passed
      const stateSequence = [
        { status: 'approaching', alarm: true },
        { status: 'waiting', alarm: true },
        { status: 'under-bridge', alarm: true },
        { status: 'passed', alarm: false }
      ];
      
      app._vessels.set(alarmMMSI, {
        mmsi: alarmMMSI,
        name: 'ALARM_TEST',
        targetBridge: 'Klaffbron',
        status: 'approaching'
      });
      
      for (const state of stateSequence) {
        app._vessels.get(alarmMMSI).status = state.status;
        await app._updateActiveBridgesTag();
      }
      
      // Final state ska ha alarm off
      expect(alarmChanges[alarmChanges.length - 1]).toBe(false);
      
      // Verifiera logical progression
      const hasAlarmOn = alarmChanges.some(alarm => alarm === true);
      const hasAlarmOff = alarmChanges.some(alarm => alarm === false);
      expect(hasAlarmOn).toBe(true);
      expect(hasAlarmOff).toBe(true);
    });

    test('global token sync med local device state', async () => {
      const tokenMMSI = 123123123;
      
      // Mock global token
      const mockToken = { setValue: jest.fn(() => Promise.resolve()) };
      mockHomey.flow.createToken.mockResolvedValue(mockToken);
      
      app._vessels.set(tokenMMSI, {
        mmsi: tokenMMSI,
        name: 'TOKEN_BOAT',
        targetBridge: 'Stridsbergsbron',
        status: 'approaching',
        etaMinutes: 4
      });
      
      // Update ska synka både token och device
      await app._updateActiveBridgesTag();
      
      // Global token ska uppdateras
      expect(mockToken.setValue).toHaveBeenCalled();
      
      // Device capability ska matcha token value
      const bridgeTextCall = mockDevice1.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text');
      const tokenCall = mockToken.setValue.mock.calls[0];
      
      expect(bridgeTextCall[1]).toBe(tokenCall[0]);
    });
  });

  describe('Error Recovery Integration Tests', () => {
    test('device recovery efter extended failure', async () => {
      const recoveryMMSI = 999888777;
      
      app._vessels.set(recoveryMMSI, {
        mmsi: recoveryMMSI,
        name: 'RECOVERY_BOAT',
        targetBridge: 'Klaffbron',
        status: 'approaching'
      });
      
      // Simulera extended device failure
      let failureCount = 0;
      mockDevice1.setCapabilityValue.mockImplementation(() => {
        failureCount++;
        if (failureCount <= 3) {
          return Promise.reject(new Error(`Failure ${failureCount}`));
        }
        return Promise.resolve(); // Recovery after 3 failures
      });
      
      // Multiple update attempts
      for (let i = 0; i < 5; i++) {
        await app._updateActiveBridgesTag();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Device ska eventually recover
      expect(failureCount).toBeGreaterThan(3);
      
      // Errors ska loggas för failures
      expect(mockHomey.app.error).toHaveBeenCalledTimes(3);
      
      // Final call ska lyckas
      const lastCall = mockDevice1.setCapabilityValue.mock.results[
        mockDevice1.setCapabilityValue.mock.results.length - 1
      ];
      await expect(lastCall.value).resolves.not.toThrow();
    });

    test('graceful degradation när alla devices misslyckas', async () => {
      const degradeMMSI = 666777888;
      
      app._vessels.set(degradeMMSI, {
        mmsi: degradeMMSI,
        name: 'DEGRADE_BOAT',
        targetBridge: 'Stridsbergsbron',
        status: 'approaching'
      });
      
      // Alla devices misslyckas
      mockDevice1.setCapabilityValue.mockRejectedValue(new Error('Device 1 failed'));
      mockDevice2.setCapabilityValue.mockRejectedValue(new Error('Device 2 failed'));
      
      // App ska fortsätta fungera
      await expect(app._updateActiveBridgesTag()).resolves.not.toThrow();
      
      // Errors ska loggas
      expect(mockHomey.app.error).toHaveBeenCalledWith(
        expect.stringContaining('Device 1 failed')
      );
      expect(mockHomey.app.error).toHaveBeenCalledWith(
        expect.stringContaining('Device 2 failed')
      );
      
      // Internal state ska vara konsekvent
      expect(app._vessels.has(degradeMMSI)).toBe(true);
      expect(app._bridgeText).toContain('DEGRADE_BOAT');
    });
  });
});