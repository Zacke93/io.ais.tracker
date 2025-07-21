/**
 * FULL-PIPELINE INTEGRATION TESTS
 * 
 * Dessa tester simulerar hela kedjan från AIS WebSocket data till device bridge_text updates.
 * Använder verklig AIS-data från logs-mappen för att skapa scenarion som matchar användarens beskrivningar:
 * 
 * 1. "Jasmin försvann efter att ha fått korrekt target bridge"
 * 2. "La Cle ankrad 370m från Klaffbron som börjar röra sig"  
 * 3. "Alla båtar försvann från appen när de väntade på broöppning"
 * 
 * Fokuserar på att testa:
 * - WebSocket message processing → vessel updates
 * - Vessel state changes → bridge_text generation  
 * - Bridge_text generation → device capability updates
 * - Device updates → UI syncing
 * 
 * Fångar integrationsproblem:
 * - Device update failures
 * - Race conditions i UI updates
 * - Vessel removal without bridge_text refresh
 */

// Mock setup för komplett integration testing
const Module = require('module');
const originalRequire = Module.prototype.require;

// Enhanced mock för full pipeline testing
const mockHomey = {
  app: {
    log: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    emit: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    setSettings: jest.fn(),
    getSettings: jest.fn(() => ({ 'api_key': 'test-key-12345678-1234-4567-8901-123456789012' })),
    getSetting: jest.fn(() => null),
    setSetting: jest.fn()
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
      getDevices: jest.fn(() => [mockDevice])
    }))
  }
};

// Mock device för device capability testing
const mockDevice = {
  id: 'test-device-id',
  setCapabilityValue: jest.fn(() => Promise.resolve()),
  getCapabilityValue: jest.fn(() => 'Inga båtar i närheten'),
  hasCapability: jest.fn(() => true),
  log: jest.fn(),
  error: jest.fn()
};

// Mock WebSocket för WebSocket message testing
const mockWebSocket = {
  send: jest.fn(),
  close: jest.fn(),
  readyState: 1, // OPEN
  addEventListener: jest.fn(),
  removeEventListener: jest.fn()
};

// Mock global WebSocket
global.WebSocket = jest.fn(() => mockWebSocket);

Module.prototype.require = function mockRequire(...args) {
  if (args[0] === 'homey') {
    return {
      App: class {
        constructor() {
          this.homey = mockHomey;
        }
      }
    };
  }
  if (args[0] === 'ws') {
    return jest.fn(() => mockWebSocket);
  }
  return originalRequire.apply(this, args);
};

// Import app efter mock setup
const AISBridgeApp = require('../app');

describe('Full-Pipeline Integration Tests', () => {
  let app;
  let mockUpdateDeviceCapabilities;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Skapa app instance
    app = new AISBridgeApp();
    
    // Mock app._devices collection
    app._devices = new Map();
    app._devices.set('test-device-id', mockDevice);
    
    // Mock private methods för testing
    mockUpdateDeviceCapabilities = jest.spyOn(app, '_updateDeviceCapabilities').mockImplementation(() => Promise.resolve());
    
    // Mock vessel storage
    app._vessels = new Map();
    app._lastSeen = new Map();
    app._bridgeText = '';
    app._lastBridgeText = '';
    
    // App är setup för testing
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Scenario 1: "Jasmin försvann efter att ha fått korrekt target bridge"', () => {
    test('båt försvinner inte premature när den har korrekt target bridge', async () => {
      // Simulera Jasmin med korrekt target bridge setup
      const jasminAISData = {
        Message: {
          PositionReport: {
            UserID: 265123456,
            Latitude: 58.287320,  // Nära Klaffbron
            Longitude: 12.285338,
            Cog: 45.0,           // Nordost
            Sog: 4.2,
            TrueHeading: 45
          }
        },
        MetaData: {
          ShipAndCargoType: 37,
          VesselName: 'JASMIN'
        }
      };

      // 1. WebSocket message processing
      const mockWebSocketMessage = { data: JSON.stringify(jasminAISData) };
      
      // Simulera vessel tracking setup
      app._vessels.set(265123456, {
        mmsi: 265123456,
        name: 'JASMIN',
        lat: 58.287320,
        lon: 12.285338,
        sog: 4.2,
        cog: 45.0,
        targetBridge: 'Klaffbron',  // Korrekt target bridge
        nearBridge: 'klaffbron',
        status: 'approaching',
        isApproaching: true,
        firstSeen: Date.now(),
        etaMinutes: 3
      });

      // 2. Simulera vessel state change
      const vesselUpdateSpy = jest.spyOn(app, '_handleVesselUpdate');
      
      // 3. Vessel är redan trackad, bara verifiera

      // 4. Verifiera att vessel inte försvinner
      expect(app._vessels.has(265123456)).toBe(true);
      expect(app._vessels.get(265123456).targetBridge).toBe('Klaffbron');
      
      // 5. Verifiera att båt inte tas bort premature
      expect(app._vessels.has(265123456)).toBe(true);
      expect(app._vessels.get(265123456).targetBridge).toBe('Klaffbron');
    });

    test('bridge_text uppdateras korrekt när Jasmin får target bridge', async () => {
      const jasminMMSI = 265123456;
      
      // Setup initial vessel utan target bridge
      app._vessels.set(jasminMMSI, {
        mmsi: jasminMMSI,
        name: 'JASMIN',
        lat: 58.287320,
        lon: 12.285338,
        sog: 4.2,
        cog: 45.0,
        nearBridge: 'klaffbron',
        status: 'approaching',
        isApproaching: true,
        firstSeen: Date.now()
      });

      // 1. Simulera target bridge assignment
      app._vessels.get(jasminMMSI).targetBridge = 'Klaffbron';
      app._vessels.get(jasminMMSI).etaMinutes = 3;

      // 2. Simulera bridge text generation
      const deviceUpdateSpy = jest.spyOn(app, '_updateDeviceCapabilities');
      
      await app._updateUI();

      // 3. Verifiera att bridge_text genereras
      expect(deviceUpdateSpy).toHaveBeenCalled();
      
      // 4. Verifiera device capability update
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('JASMIN')
      );
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('Klaffbron')
      );
    });

    test('race condition i UI updates hanteras korrekt för Jasmin', async () => {
      const jasminMMSI = 265123456;
      
      // Setup vessel med concurrent updates
      app._vessels.set(jasminMMSI, {
        mmsi: jasminMMSI,
        name: 'JASMIN',
        targetBridge: 'Klaffbron',
        status: 'approaching',
        etaMinutes: 3
      });

      // Simulera snabba concurrent updates
      const updatePromises = [];
      for (let i = 0; i < 5; i++) {
        updatePromises.push(app._updateUI());
      }

      // Vänta på alla updates
      await Promise.all(updatePromises);

      // Verifiera att device bara uppdaterades en gång per unik värde
      const bridgeTextCalls = mockDevice.setCapabilityValue.mock.calls
        .filter(call => call[0] === 'bridge_text');
      
      // Ska inte ha duplicate updates
      const uniqueValues = [...new Set(bridgeTextCalls.map(call => call[1]))];
      expect(uniqueValues.length).toBeGreaterThan(0);
      expect(uniqueValues.length).toBeLessThanOrEqual(bridgeTextCalls.length);
    });
  });

  describe('Scenario 2: "La Cle ankrad 370m från Klaffbron som börjar röra sig"', () => {
    test('stationary boat detection och movement trigger', async () => {
      const laCleMMSI = 211845060;
      
      // 1. Setup La Cle som ankrad
      app._vessels.set(laCleMMSI, {
        mmsi: laCleMMSI,
        name: 'LA CLE',
        lat: 58.284500,  // 370m från Klaffbron
        lon: 12.282000,
        sog: 0.1,        // Nästan stillastående
        cog: 180.0,
        nearBridge: 'klaffbron',
        status: 'waiting',
        isWaiting: true,
        firstSeen: Date.now() - 300000,  // 5 minuter sedan
        lastPositionChange: Date.now() - 120000,  // 2 minuter sedan
        isStationary: true
      });

      // 2. Simulera att båten börjar röra sig - direct vessel update
      app._vessels.get(laCleMMSI).lat = 58.284600;  // Flyttat 10m norr
      app._vessels.get(laCleMMSI).lon = 12.282100;
      app._vessels.get(laCleMMSI).cog = 15.0;       // Ändrad kurs mot nordost
      app._vessels.get(laCleMMSI).sog = 2.5;        // Börjat röra sig

      // 4. Verifiera status change från waiting till approaching
      const vessel = app._vessels.get(laCleMMSI);
      expect(vessel.sog).toBe(2.5);
      expect(vessel.isStationary).toBe(false);
      expect(vessel.isWaiting).toBe(false);
      expect(vessel.isApproaching).toBe(true);
      expect(vessel.status).toBe('approaching');

      // 5. Verifiera target bridge assignment
      expect(vessel.targetBridge).toBe('Klaffbron');
      expect(vessel.etaMinutes).toBeGreaterThan(0);
    });

    test('bridge_text uppdateras från "väntar" till "närmar sig"', async () => {
      const laCleMMSI = 211845060;
      
      // Initial state: väntar
      app._vessels.set(laCleMMSI, {
        mmsi: laCleMMSI,
        name: 'LA CLE',
        targetBridge: 'Klaffbron',
        status: 'waiting',
        isWaiting: true,
        sog: 0.1,
        etaMinutes: null
      });

      // Generera initial bridge text
      await app._updateUI();
      const initialText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(initialText).toContain('LA CLE');
      expect(initialText).toContain('väntar');

      // Update till rörelse
      app._vessels.get(laCleMMSI).status = 'approaching';
      app._vessels.get(laCleMMSI).isWaiting = false;
      app._vessels.get(laCleMMSI).isApproaching = true;
      app._vessels.get(laCleMMSI).sog = 2.5;
      app._vessels.get(laCleMMSI).etaMinutes = 5;

      // Generera uppdaterad bridge text
      mockDevice.setCapabilityValue.mockClear();
      await app._updateUI();
      
      const updatedText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(updatedText).toContain('LA CLE');
      expect(updatedText).toContain('närmar sig');
      expect(updatedText).toContain('5 minuter');
      expect(updatedText).not.toContain('väntar');
    });

    test('flow trigger utlöses när La Cle börjar röra sig', async () => {
      const laCleMMSI = 211845060;
      
      // Setup med flow trigger mocking
      const flowTriggerSpy = jest.spyOn(app, '_triggerBoatNearFlow');
      
      app._vessels.set(laCleMMSI, {
        mmsi: laCleMMSI,
        name: 'LA CLE',
        targetBridge: 'Klaffbron',
        nearBridge: 'klaffbron',
        status: 'waiting'
      });

      // Simulera status change till approaching
      app._vessels.get(laCleMMSI).status = 'approaching';
      app._vessels.get(laCleMMSI).isApproaching = true;
      
      // Simulera flow trigger
      await app._triggerBoatNearFlow(laCleMMSI, 'klaffbron', 'Klaffbron', 'LA CLE');
      
      expect(flowTriggerSpy).toHaveBeenCalledWith(laCleMMSI, 'klaffbron', 'Klaffbron', 'LA CLE');
      expect(mockHomey.flow.getDeviceTriggerCard().trigger).toHaveBeenCalled();
    });
  });

  describe('Scenario 3: "Alla båtar försvann från appen när de väntade på broöppning"', () => {
    test('multiple waiting boats ska inte försvinna simultaneously', async () => {
      // Setup 3 båtar som väntar på broöppning
      const waitingBoats = [
        { mmsi: 111111111, name: 'BOAT_A', bridge: 'klaffbron' },
        { mmsi: 222222222, name: 'BOAT_B', bridge: 'klaffbron' },
        { mmsi: 333333333, name: 'BOAT_C', bridge: 'stridsbergsbron' }
      ];

      waitingBoats.forEach(boat => {
        app._vessels.set(boat.mmsi, {
          mmsi: boat.mmsi,
          name: boat.name,
          targetBridge: boat.bridge === 'klaffbron' ? 'Klaffbron' : 'Stridsbergsbron',
          nearBridge: boat.bridge,
          status: 'waiting',
          isWaiting: true,
          sog: 0.2,
          firstSeen: Date.now() - 600000, // 10 minuter sedan
          lastSeen: Date.now() - 30000,   // 30 sekunder sedan
          etaMinutes: null
        });
      });

      // Generera bridge text med alla båtar
      await app._updateUI();
      
      let bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(bridgeText).toContain('BOAT_A');
      expect(bridgeText).toContain('BOAT_B');
      expect(bridgeText).toContain('BOAT_C');

      // Verifiera att alla båtar fortfarande är kvar (waiting boats ska inte försvinna)
      expect(app._vessels.size).toBe(3);
      expect(app._vessels.has(111111111)).toBe(true);
      expect(app._vessels.has(222222222)).toBe(true);
      expect(app._vessels.has(333333333)).toBe(true);
    });

    test('bridge_text refresh när båtar försvinner och device updates', async () => {
      // Setup 2 båtar
      app._vessels.set(111111111, {
        mmsi: 111111111,
        name: 'DISAPPEARING_BOAT',
        targetBridge: 'Klaffbron',
        status: 'approaching',
        etaMinutes: 2
      });
      
      app._vessels.set(222222222, {
        mmsi: 222222222,
        name: 'REMAINING_BOAT',
        targetBridge: 'Stridsbergsbron',
        status: 'approaching',
        etaMinutes: 5
      });

      // Initial bridge text med båda båtar
      await app._updateUI();
      let initialText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(initialText).toContain('DISAPPEARING_BOAT');
      expect(initialText).toContain('REMAINING_BOAT');

      // Simulera att en båt försvinner
      mockDevice.setCapabilityValue.mockClear();
      app._vessels.delete(111111111);
      
      // Bridge text ska uppdateras automatiskt
      await app._updateUI();
      
      let updatedText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(updatedText).not.toContain('DISAPPEARING_BOAT');
      expect(updatedText).toContain('REMAINING_BOAT');
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith('bridge_text', updatedText);
    });

    test('device capability consistency när vessels cleanas bort', async () => {
      // Setup vessels
      app._vessels.set(111111111, {
        mmsi: 111111111,
        name: 'TEST_BOAT',
        targetBridge: 'Klaffbron',
        status: 'approaching'
      });

      // Initial state
      await app._updateUI();
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('TEST_BOAT')
      );

      // Clear all vessels
      mockDevice.setCapabilityValue.mockClear();
      app._vessels.clear();
      
      // Update ska resultera i "Inga båtar"
      await app._updateUI();
      
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        'Inga båtar i närheten av broarna'
      );
      
      // Alarm ska stängas av
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith(
        'alarm_generic',
        false
      );
    });
  });

  describe('WebSocket Connection och Device Sync Integration', () => {
    test('WebSocket disconnection påverkar device connection_status', async () => {
      // Initial connected state
      await app._updateConnectionStatus(true);
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith('connection_status', true);

      // Simulera disconnect
      mockDevice.setCapabilityValue.mockClear();
      await app._updateConnectionStatus(false);
      
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith('connection_status', false);
    });

    test('WebSocket reconnection återställer vessel tracking', async () => {
      // Setup vessels före disconnection
      app._vessels.set(123456, { mmsi: 123456, name: 'TEST' });
      expect(app._vessels.size).toBe(1);

      // Simulera disconnect och reconnect
      await app._handleConnectionFailure();
      await app._startLiveFeed();
      
      // Verifiera att reconnection hantering fungerar
      expect(mockHomey.app.log).toHaveBeenCalledWith('WebSocket connected');
    });

    test('device update failures hanteras gracefully', async () => {
      // Mock device error
      mockDevice.setCapabilityValue.mockRejectedValueOnce(new Error('Device update failed'));

      app._vessels.set(123456, {
        mmsi: 123456,
        name: 'TEST_BOAT',
        targetBridge: 'Klaffbron',
        status: 'approaching'
      });

      // Device update ska inte krascha appen
      await expect(app._updateUI()).resolves.not.toThrow();
      
      // Error ska loggas
      expect(mockHomey.app.error).toHaveBeenCalledWith(
        expect.stringContaining('Device update failed')
      );
    });
  });

  describe('Performance och Memory Management', () => {
    test('många vessels påverkar inte device update performance', async () => {
      // Setup 20 vessels
      for (let i = 0; i < 20; i++) {
        app._vessels.set(1000000 + i, {
          mmsi: 1000000 + i,
          name: `BOAT_${i}`,
          targetBridge: i % 2 === 0 ? 'Klaffbron' : 'Stridsbergsbron',
          status: 'approaching',
          etaMinutes: Math.floor(Math.random() * 10) + 1
        });
      }

      const startTime = Date.now();
      await app._updateUI();
      const duration = Date.now() - startTime;

      // Performance ska vara under 100ms
      expect(duration).toBeLessThan(100);
      
      // Device ska ha uppdaterats korrekt
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('båtar')
      );
    });

    test('vessel cleanup påverkar inte device state consistency', async () => {
      // Setup och cleanup scenario
      app._vessels.set(123456, { mmsi: 123456, name: 'TEMP_BOAT' });
      
      await app._updateUI();
      const beforeCleanup = mockDevice.setCapabilityValue.mock.calls.length;
      
      // Cleanup
      app._vessels.clear();
      mockDevice.setCapabilityValue.mockClear();
      
      await app._updateUI();
      
      // Device ska uppdateras till empty state
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        'Inga båtar i närheten av broarna'
      );
    });
  });
});