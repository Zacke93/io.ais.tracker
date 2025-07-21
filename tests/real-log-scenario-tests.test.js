/**
 * REAL LOG SCENARIO TESTS
 * 
 * Dessa tester använder verklig AIS-data från production logs för att simulera
 * exakta scenarion som har hänt i verkligheten. Data extraherad från:
 * - app-20250719-001407.log (AVA scenario)
 * - app-20250720-140801.log (MARTINA scenario) 
 * - app-20250719-164252.log (RIX RIVER scenario)
 * 
 * Fokuserar på edge cases och problem som upptäckts i production:
 * - Vessels som får korrekt target bridge men ändå försvinner
 * - Status transitions som inte triggrar device updates
 * - Race conditions mellan WebSocket data och device syncing
 * - Memory leaks vid vessel cleanup
 */

const { createProductionBoat, createProductionMessageGenerator } = require('./helpers/production-test-base');

// Enhanced mock setup för real log scenario testing
const Module = require('module');
const originalRequire = Module.prototype.require;

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
    createToken: jest.fn(() => Promise.resolve({ setValue: jest.fn(() => Promise.resolve()) })),
    getDeviceTriggerCard: jest.fn(() => ({ trigger: jest.fn(() => Promise.resolve()) }))
  },
  drivers: {
    getDriver: jest.fn(() => ({ getDevices: jest.fn(() => [mockDevice]) }))
  }
};

const mockDevice = {
  setCapabilityValue: jest.fn(() => Promise.resolve()),
  getCapabilityValue: jest.fn(() => 'Inga båtar i närheten'),
  hasCapability: jest.fn(() => true)
};

Module.prototype.require = function mockRequire(...args) {
  if (args[0] === 'homey') {
    return { App: class { constructor() { this.homey = mockHomey; } } };
  }
  return originalRequire.apply(this, args);
};

const AISBridgeApp = require('../app');

describe('Real Log Scenario Tests', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new AISBridgeApp();
    app._devices = new Map();
    app._devices.set('test-device', mockDevice);
    app._vessels = new Map();
    app._lastSeen = new Map();
  });

  describe('AVA Production Scenario (Log: app-20250719-001407.log)', () => {
    /**
     * AVA Real Log Data:
     * - MMSI: 211845060
     * - Route: Klaffbron → Stallbackabron → Stridsbergsbron
     * - Status changes: approaching → waiting → approaching → under-bridge
     * - Problem: Försvann trots korrekt target bridge "Stridsbergsbron"
     */
    
    test('AVA complete journey från log data', async () => {
      const avaMMSI = 211845060;
      
      // 1. Initial entry vid Klaffbron (från log: 22:29:43)
      const avaInitial = {
        mmsi: avaMMSI,
        name: 'AVA',
        lat: 58.287320,
        lon: 12.285338,
        sog: 6.1,
        cog: 360.0,
        nearBridge: 'klaffbron',
        targetBridge: 'Stridsbergsbron',
        status: 'approaching',
        isApproaching: true,
        firstSeen: Date.now() - 1800000, // 30 min sedan (från log)
        etaMinutes: 13
      };
      
      app._vessels.set(avaMMSI, avaInitial);
      
      // Verifiera initial state
      await app._updateActiveBridgesTag();
      let bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(bridgeText).toContain('AVA');
      expect(bridgeText).toContain('Stridsbergsbron');
      expect(bridgeText).toContain('13 minuter');
      
      // 2. Status change till waiting (från log timing)
      mockDevice.setCapabilityValue.mockClear();
      app._vessels.get(avaMMSI).status = 'waiting';
      app._vessels.get(avaMMSI).isWaiting = true;
      app._vessels.get(avaMMSI).isApproaching = false;
      app._vessels.get(avaMMSI).sog = 0.6;
      app._vessels.get(avaMMSI).etaMinutes = 2;
      
      await app._updateActiveBridgesTag();
      bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(bridgeText).toContain('AVA');
      expect(bridgeText).toContain('väntar');
      
      // 3. Movement till Stridsbergsbron (från log: under-bridge)
      mockDevice.setCapabilityValue.mockClear();
      app._vessels.get(avaMMSI).nearBridge = 'stridsbergsbron';
      app._vessels.get(avaMMSI).status = 'under-bridge';
      app._vessels.get(avaMMSI).sog = 2.4;
      app._vessels.get(avaMMSI).etaMinutes = null;
      
      await app._updateActiveBridgesTag();
      bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(bridgeText).toContain('AVA');
      expect(bridgeText).toContain('Broöppning pågår');
      
      // 4. KRITISKT: AVA ska INTE försvinna under bridge passage
      const timeoutSpy = jest.spyOn(app, '_scheduleCleanup');
      app._checkVesselTimeouts();
      
      expect(app._vessels.has(avaMMSI)).toBe(true);
      expect(timeoutSpy).not.toHaveBeenCalledWith(avaMMSI);
    });

    test('AVA timeout logic under different states', async () => {
      const avaMMSI = 211845060;
      
      // Test 1: Approaching state timeout
      app._vessels.set(avaMMSI, {
        mmsi: avaMMSI,
        name: 'AVA',
        status: 'approaching',
        targetBridge: 'Stridsbergsbron',
        lastSeen: Date.now() - 300000,  // 5 min ago
        firstSeen: Date.now() - 900000   // 15 min ago
      });
      
      const timeoutMs = app._getSpeedAdjustedTimeout(avaMMSI);
      expect(timeoutMs).toBeGreaterThan(600000);  // Mer än 10 min för approaching
      
      // Test 2: Under-bridge state timeout
      app._vessels.get(avaMMSI).status = 'under-bridge';
      const underBridgeTimeout = app._getSpeedAdjustedTimeout(avaMMSI);
      expect(underBridgeTimeout).toBe(1200000);  // 20 min för under-bridge
      
      // Test 3: Waiting state timeout
      app._vessels.get(avaMMSI).status = 'waiting';
      const waitingTimeout = app._getSpeedAdjustedTimeout(avaMMSI);
      expect(waitingTimeout).toBe(1200000);  // 20 min för waiting
    });

    test('AVA device update consistency under status changes', async () => {
      const avaMMSI = 211845060;
      
      app._vessels.set(avaMMSI, {
        mmsi: avaMMSI,
        name: 'AVA',
        targetBridge: 'Stridsbergsbron',
        status: 'approaching',
        etaMinutes: 5
      });
      
      // Track alla device updates
      const deviceUpdates = [];
      mockDevice.setCapabilityValue.mockImplementation((capability, value) => {
        if (capability === 'bridge_text') {
          deviceUpdates.push(value);
        }
        return Promise.resolve();
      });
      
      // Series av status changes
      await app._updateActiveBridgesTag();  // Initial
      
      app._vessels.get(avaMMSI).status = 'waiting';
      await app._updateActiveBridgesTag();  // Change 1
      
      app._vessels.get(avaMMSI).status = 'under-bridge';
      await app._updateActiveBridgesTag();  // Change 2
      
      // Verifiera progression av meddelanden
      expect(deviceUpdates.length).toBe(3);
      expect(deviceUpdates[0]).toContain('närmar sig');
      expect(deviceUpdates[1]).toContain('väntar');
      expect(deviceUpdates[2]).toContain('Broöppning pågår');
      
      // Alla ska innehålla AVA
      deviceUpdates.forEach(update => {
        expect(update).toContain('AVA');
      });
    });
  });

  describe('MARTINA Production Scenario (Log: app-20250720-140801.log)', () => {
    /**
     * MARTINA Real Log Data:
     * - MMSI: 265762410
     * - Position: Järnvägsbron → Stridsbergsbron
     * - ETA progression: null → 2 min → 1 min → 0 min → null
     * - Problem: ETA calculations och null handling
     */
    
    test('MARTINA ETA progression från log data', async () => {
      const martinaMMSI = 265762410;
      
      // Initial setup från log (12:08:33)
      app._vessels.set(martinaMMSI, {
        mmsi: martinaMMSI,
        name: 'MARTINA',
        lat: 58.291350,
        lon: 12.291890,
        nearBridge: 'jarnvagsbron',
        targetBridge: 'Stridsbergsbron',
        sog: 3.9,
        cog: 29.7,
        status: 'approaching',
        etaMinutes: null  // Initial null från log
      });
      
      // Test ETA null handling
      await app._updateActiveBridgesTag();
      let bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(bridgeText).toContain('MARTINA');
      expect(bridgeText).toContain('okänd tid');
      
      // ETA progression som i log
      const etaProgression = [2, 1, 0, null];
      const expectedTexts = ['2 minuter', '1 minut', 'nu', 'okänd tid'];
      
      for (let i = 0; i < etaProgression.length; i++) {
        mockDevice.setCapabilityValue.mockClear();
        app._vessels.get(martinaMMSI).etaMinutes = etaProgression[i];
        
        await app._updateActiveBridgesTag();
        bridgeText = mockDevice.setCapabilityValue.mock.calls
          .find(call => call[0] === 'bridge_text')?.[1];
        
        expect(bridgeText).toContain('MARTINA');
        expect(bridgeText).toContain(expectedTexts[i]);
      }
    });

    test('MARTINA position update utan GPS jump', async () => {
      const martinaMMSI = 265762410;
      
      // Initial position
      app._vessels.set(martinaMMSI, {
        mmsi: martinaMMSI,
        name: 'MARTINA',
        lat: 58.291350,
        lon: 12.291890,
        lastPosition: { lat: 58.291350, lon: 12.291890 },
        targetBridge: 'Stridsbergsbron',
        status: 'approaching'
      });
      
      // Simulera gradual movement (ej GPS jump)
      const newPositions = [
        { lat: 58.291400, lon: 12.291950 },  // 50m movement
        { lat: 58.291450, lon: 12.292000 },  // 50m movement
        { lat: 58.291500, lon: 12.292050 }   // 50m movement
      ];
      
      for (const pos of newPositions) {
        const oldLat = app._vessels.get(martinaMMSI).lat;
        const oldLon = app._vessels.get(martinaMMSI).lon;
        
        app._vessels.get(martinaMMSI).lat = pos.lat;
        app._vessels.get(martinaMMSI).lon = pos.lon;
        
        // Check distance moved
        const distance = app._calculateDistance(oldLat, oldLon, pos.lat, pos.lon);
        expect(distance).toBeLessThan(100); // Normal movement, not GPS jump
        
        // Vessel ska behållas
        expect(app._vessels.has(martinaMMSI)).toBe(true);
        expect(app._vessels.get(martinaMMSI).targetBridge).toBe('Stridsbergsbron');
      }
    });

    test('MARTINA flow trigger progression', async () => {
      const martinaMMSI = 265762410;
      
      // Mock flow trigger
      const flowTriggerSpy = jest.spyOn(app, '_triggerBoatNearFlow').mockImplementation(() => {});
      
      app._vessels.set(martinaMMSI, {
        mmsi: martinaMMSI,
        name: 'MARTINA',
        targetBridge: 'Stridsbergsbron',
        nearBridge: 'jarnvagsbron',
        status: 'approaching',
        triggeredFlows: new Set()  // No previous triggers
      });
      
      // First approach - ska triggra flow
      await app._handleVesselApproaching(martinaMMSI, 'stridsbergsbron');
      expect(flowTriggerSpy).toHaveBeenCalledWith(martinaMMSI, 'stridsbergsbron');
      
      // Second approach samma bro - ska INTE triggra igen
      flowTriggerSpy.mockClear();
      await app._handleVesselApproaching(martinaMMSI, 'stridsbergsbron');
      expect(flowTriggerSpy).not.toHaveBeenCalled();
      
      // Approach till annan bro - ska triggra
      flowTriggerSpy.mockClear();
      await app._handleVesselApproaching(martinaMMSI, 'klaffbron');
      expect(flowTriggerSpy).toHaveBeenCalledWith(martinaMMSI, 'klaffbron');
    });
  });

  describe('RIX RIVER Production Scenario (Log: app-20250719-164252.log)', () => {
    /**
     * RIX RIVER Real Log Data:
     * - MMSI: 209325000
     * - Problem: Fick inte target bridge trots att vara nära Klaffbron
     * - COG: 25.3° (norr) men bearing till bridge 203.6° (söder)
     * - Heading check: diff=178.3°, heading towards=false
     */
    
    test('RIX RIVER heading check problem från log', async () => {
      const rixMMSI = 209325000;
      
      // Exakt data från log
      const rixData = {
        mmsi: rixMMSI,
        name: 'RIX RIVER',
        lat: 58.286843,
        lon: 12.286218,
        sog: 4.5,
        cog: 25.3,  // Nord
        nearBridge: 'klaffbron'
      };
      
      // Calculate bearing till Klaffbron
      const klaffbronLat = 58.284933;
      const klaffbronLon = 12.285400;
      const bearing = app._calculateBearing(
        rixData.lat, rixData.lon,
        klaffbronLat, klaffbronLon
      );
      
      // Från log: bearing=203.6°, diff=178.3°
      expect(Math.abs(bearing - 203.6)).toBeLessThan(5);
      
      const cogDiff = Math.abs(rixData.cog - bearing);
      const normalizedDiff = cogDiff > 180 ? 360 - cogDiff : cogDiff;
      
      // Från log: heading towards=false
      const isHeadingTowards = normalizedDiff <= 45;
      expect(isHeadingTowards).toBe(false);
      
      // Test target bridge assignment
      app._vessels.set(rixMMSI, rixData);
      
      // Ska INTE få target bridge pga heading check
      const targetBridge = app._findTargetBridge(rixMMSI, 'klaffbron');
      expect(targetBridge).toBeNull();
    });

    test('RIX RIVER proximity vs heading logic', async () => {
      const rixMMSI = 209325000;
      
      // Setup RIX RIVER nära bridge men fel riktning
      app._vessels.set(rixMMSI, {
        mmsi: rixMMSI,
        name: 'RIX RIVER',
        lat: 58.286843,
        lon: 12.286218,
        sog: 4.5,
        cog: 25.3,  // Norr
        nearBridge: 'klaffbron'
        // Ingen targetBridge pga heading check
      });
      
      // Distance till Klaffbron (från log: 334m)
      const klaffbronLat = 58.284933;
      const klaffbronLon = 12.285400;
      const distance = app._calculateDistance(
        58.286843, 12.286218,
        klaffbronLat, klaffbronLon
      );
      
      expect(Math.abs(distance - 334)).toBeLessThan(50);
      
      // Trots närhet, ingen bridge_text pga ingen target bridge
      await app._updateActiveBridgesTag();
      const bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(bridgeText).not.toContain('RIX RIVER');
      expect(bridgeText).toBe('Inga båtar i närheten av broarna');
    });

    test('RIX RIVER course correction scenario', async () => {
      const rixMMSI = 209325000;
      
      // Initial: fel riktning
      app._vessels.set(rixMMSI, {
        mmsi: rixMMSI,
        name: 'RIX RIVER',
        lat: 58.286843,
        lon: 12.286218,
        sog: 4.5,
        cog: 25.3,    // Norr (fel riktning)
        nearBridge: 'klaffbron'
      });
      
      // Ingen target bridge initially
      expect(app._vessels.get(rixMMSI).targetBridge).toBeUndefined();
      
      // Course correction: nu heading mot bridge
      app._vessels.get(rixMMSI).cog = 210.0;  // Sydväst (mot bridge)
      
      // Nu ska target bridge assignas
      const targetBridge = app._findTargetBridge(rixMMSI, 'klaffbron');
      expect(targetBridge).toBe('Klaffbron');
      
      app._vessels.get(rixMMSI).targetBridge = targetBridge;
      app._vessels.get(rixMMSI).status = 'approaching';
      app._vessels.get(rixMMSI).etaMinutes = 3;
      
      // Nu ska bridge_text visas
      await app._updateActiveBridgesTag();
      const bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(bridgeText).toContain('RIX RIVER');
      expect(bridgeText).toContain('Klaffbron');
    });
  });

  describe('Log-based Memory Management Tests', () => {
    test('vessel cleanup från production log patterns', async () => {
      // Setup multiple vessels från olika log entries
      const logVessels = [
        { mmsi: 211845060, name: 'AVA', bridge: 'stridsbergsbron' },
        { mmsi: 265762410, name: 'MARTINA', bridge: 'stridsbergsbron' },
        { mmsi: 209325000, name: 'RIX RIVER', bridge: 'klaffbron' }
      ];
      
      logVessels.forEach(vessel => {
        app._vessels.set(vessel.mmsi, {
          mmsi: vessel.mmsi,
          name: vessel.name,
          targetBridge: vessel.bridge === 'stridsbergsbron' ? 'Stridsbergsbron' : 'Klaffbron',
          status: 'approaching',
          lastSeen: Date.now() - 300000  // 5 min old
        });
      });
      
      expect(app._vessels.size).toBe(3);
      
      // Simulera cleanup av old vessels
      const timeoutSpy = jest.spyOn(app, '_scheduleCleanup');
      app._checkVesselTimeouts();
      
      // Alla vessels är fortfarande inom timeout limit
      expect(app._vessels.size).toBe(3);
      
      // Simulera very old vessels
      logVessels.forEach(vessel => {
        app._vessels.get(vessel.mmsi).lastSeen = Date.now() - 1800000; // 30 min old
      });
      
      app._checkVesselTimeouts();
      
      // Nu ska cleanup ha schemalagts
      expect(timeoutSpy).toHaveBeenCalled();
    });

    test('device state consistency under rapid vessel changes', async () => {
      // Rapid vessel additions/removals som i production logs
      const rapidChanges = [
        { action: 'add', mmsi: 111111, name: 'BOAT1' },
        { action: 'add', mmsi: 222222, name: 'BOAT2' },
        { action: 'remove', mmsi: 111111 },
        { action: 'add', mmsi: 333333, name: 'BOAT3' },
        { action: 'remove', mmsi: 222222 },
        { action: 'remove', mmsi: 333333 }
      ];
      
      let expectedNames = [];
      
      for (const change of rapidChanges) {
        mockDevice.setCapabilityValue.mockClear();
        
        if (change.action === 'add') {
          app._vessels.set(change.mmsi, {
            mmsi: change.mmsi,
            name: change.name,
            targetBridge: 'Klaffbron',
            status: 'approaching'
          });
          expectedNames.push(change.name);
        } else {
          app._vessels.delete(change.mmsi);
          expectedNames = expectedNames.filter(name => name !== change.name);
        }
        
        await app._updateActiveBridgesTag();
        
        const bridgeText = mockDevice.setCapabilityValue.mock.calls
          .find(call => call[0] === 'bridge_text')?.[1];
        
        if (expectedNames.length > 0) {
          expectedNames.forEach(name => {
            expect(bridgeText).toContain(name);
          });
        } else {
          expect(bridgeText).toBe('Inga båtar i närheten av broarna');
        }
      }
    });
  });

  describe('Production Error Scenarios från Logs', () => {
    test('null ETA handling från MARTINA log scenario', async () => {
      const martinaMMSI = 265762410;
      
      // Scenario från log: etaMinutes går från värde till null
      app._vessels.set(martinaMMSI, {
        mmsi: martinaMMSI,
        name: 'MARTINA',
        targetBridge: 'Stridsbergsbron',
        status: 'approaching',
        etaMinutes: 2  // Initial värde
      });
      
      await app._updateActiveBridgesTag();
      let bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      expect(bridgeText).toContain('2 minuter');
      
      // Change till null (som i log)
      mockDevice.setCapabilityValue.mockClear();
      app._vessels.get(martinaMMSI).etaMinutes = null;
      
      await app._updateActiveBridgesTag();
      bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      // Ska hantera null gracefully
      expect(bridgeText).toContain('MARTINA');
      expect(bridgeText).toContain('okänd tid');
      expect(bridgeText).not.toContain('null');
      expect(bridgeText).not.toContain('undefined');
    });

    test('undefined targetBridge recovery från RIX RIVER scenario', async () => {
      const rixMMSI = 209325000;
      
      // Scenario: vessel utan target bridge men nära user bridge
      app._vessels.set(rixMMSI, {
        mmsi: rixMMSI,
        name: 'RIX RIVER',
        nearBridge: 'klaffbron',
        status: 'approaching'
        // targetBridge är undefined
      });
      
      // Bridge text generation ska hantera undefined gracefully
      await app._updateActiveBridgesTag();
      const bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      // Ska inte krascha eller visa fel data
      expect(bridgeText).not.toContain('RIX RIVER');
      expect(bridgeText).toBe('Inga båtar i närheten av broarna');
      expect(bridgeText).not.toContain('undefined');
      expect(bridgeText).not.toContain('null');
    });

    test('status inkonsistens recovery från AVA scenario', async () => {
      const avaMMSI = 211845060;
      
      // Setup med inkonsistent status (från log patterns)
      app._vessels.set(avaMMSI, {
        mmsi: avaMMSI,
        name: 'AVA',
        targetBridge: 'Stridsbergsbron',
        status: 'approaching',
        isApproaching: false,  // Inkonsistent
        isWaiting: true,       // Inkonsistent
        etaMinutes: 5
      });
      
      // System ska hantera inkonsistens
      await app._updateActiveBridgesTag();
      const bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(bridgeText).toContain('AVA');
      expect(bridgeText).toContain('Stridsbergsbron');
      
      // Ska inte krascha trots inkonsistent state
      expect(bridgeText).not.toContain('undefined');
      expect(bridgeText).not.toContain('null');
    });
  });
});