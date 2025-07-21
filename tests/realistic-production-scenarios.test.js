/**
 * REALISTIC PRODUCTION SCENARIOS TEST SUITE
 * 
 * Deze tester är designade för att fånga verkliga problem som uppstått i produktion,
 * baserat på användaranteckningar och logganalys.
 * 
 * Fokus: Full pipeline-tester som simulerar hela kedjan från AIS-data till bridge_text
 */

const AISBridgeApp = require('../app.js');

// Mock Homey SDK
const mockHomey = {
  ManagerSettings: {
    get: jest.fn().mockReturnValue('test-api-key'),
    set: jest.fn(),
  },
  FlowCardTrigger: jest.fn().mockImplementation(() => ({
    registerRunListener: jest.fn(),
    trigger: jest.fn().mockResolvedValue(true),
  })),
  FlowCardCondition: jest.fn().mockImplementation(() => ({
    registerRunListener: jest.fn(),
  })),
  ManagerFlow: {
    getCard: jest.fn().mockImplementation((type, id) => ({
      registerRunListener: jest.fn(),
      trigger: jest.fn().mockResolvedValue(true),
    })),
  },
  App: class MockApp {
    log = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };
    
    constructor() {
      this.devices = new Map();
    }
    
    async getDevices() {
      return Array.from(this.devices.values());
    }
    
    addMockDevice(id, capabilities = {}) {
      const device = {
        id,
        getCapabilityValue: jest.fn((cap) => capabilities[cap] || null),
        setCapabilityValue: jest.fn(),
        setUnavailable: jest.fn(),
        setAvailable: jest.fn(),
      };
      this.devices.set(id, device);
      return device;
    }
  },
};

// Global Homey mock
global.Homey = mockHomey;

describe('Realistic Production Scenarios', () => {
  let app;
  let mockDevice;
  
  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Skapa app-instans
    app = new AISBridgeApp();
    
    // Lägg till mock device
    mockDevice = app.addMockDevice('bridge-device-1', {
      bridge_text: '',
      alarm_generic: false,
      connection_status: true,
    });
    
    // Simulera onInit
    await app.onInit();
    
    // Simulera WebSocket-anslutning utan att faktiskt ansluta
    app.ws = {
      readyState: 1, // OPEN
      send: jest.fn(),
      close: jest.fn(),
    };
    app.isConnected = true;
  });

  afterEach(() => {
    if (app && app.onUninit) {
      app.onUninit();
    }
  });

  describe('Problem 1: Ankrade båtar hanteras fel', () => {
    test('La Cle-scenario: Ankrad båt 370m från Klaffbron som börjar röra sig mot Järnvägsbron', async () => {
      // SCENARIO: La Cle ligger ankrad 370m från Klaffbron
      // Börjar röra sig mot Järnvägsbron men får fel target bridge (Klaffbron)
      
      // Steg 1: La Cle ankrad (ska ignoreras)
      const anchoredMessage = {
        Message: {
          Positions: [{
            UserID: 219000001,
            MessageID: 1,
            Timestamp: '2025-07-20T10:00:00Z',
            Latitude: 59.3270, // 370m från Klaffbron
            Longitude: 18.0680,
            SOG: 0.1, // Nästan stillastående
            COG: 45,
            VesselName: 'La Cle',
          }],
        },
      };
      
      await app._handleAISMessage(JSON.stringify(anchoredMessage));
      
      // Verify: Ankrad båt ska inte generera bridge_text
      expect(mockDevice.setCapabilityValue).not.toHaveBeenCalledWith(
        'bridge_text', 
        expect.stringContaining('La Cle')
      );
      
      // Steg 2: La Cle börjar röra sig mot Järnvägsbron (norrut)
      const movingMessage = {
        Message: {
          Positions: [{
            UserID: 219000001,
            MessageID: 2,
            Timestamp: '2025-07-20T10:05:00Z',
            Latitude: 59.3275, // Rör sig norrut
            Longitude: 18.0685,
            SOG: 2.5, // Nu rör sig båten
            COG: 30, // Norrut mot Järnvägsbron
            VesselName: 'La Cle',
          }],
        },
      };
      
      await app._handleAISMessage(JSON.stringify(movingMessage));
      
      // Verify: Target bridge ska vara Stridsbergsbron (inte Klaffbron) 
      // eftersom båten rör sig norrut från position mellan Klaff och Järnväg
      const laCleVessel = app.vesselManager.vessels.get(219000001);
      expect(laCleVessel).toBeDefined();
      expect(laCleVessel.targetBridge).toBe('Stridsbergsbron'); // INTE Klaffbron
      
      // Steg 3: La Cle närmar sig Stridsbergsbron
      const approachingMessage = {
        Message: {
          Positions: [{
            UserID: 219000001,
            MessageID: 3,
            Timestamp: '2025-07-20T10:10:00Z',
            Latitude: 59.3290, // Närmare Stridsbergsbron
            Longitude: 18.0700,
            SOG: 3.0,
            COG: 30,
            VesselName: 'La Cle',
          }],
        },
      };
      
      await app._handleAISMessage(JSON.stringify(approachingMessage));
      
      // Verify: Bridge text ska nu visa La Cle på väg mot Stridsbergsbron
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('Stridsbergsbron')
      );
    });
  });

  describe('Problem 2: Båtar försvinner inom 300m protection zone', () => {
    test('Alla båtar försvinner vid Järnvägsbron under broöppning - KRITISK BUGG', async () => {
      // SCENARIO: Flera båtar väntar på broöppning vid Järnvägsbron
      // Alla försvinner samtidigt (inom 300m protection zone)
      
      // Båt 1: Jasmin väntar vid Järnvägsbron
      const jasminMessage = {
        Message: {
          Positions: [{
            UserID: 219000002,
            MessageID: 1,
            Timestamp: '2025-07-20T11:00:00Z',
            Latitude: 59.3262, // Vid Järnvägsbron
            Longitude: 18.0721,
            SOG: 0.2, // Väntar
            COG: 30,
            VesselName: 'Jasmin',
          }],
        },
      };
      
      // Båt 2: Parra närmar sig Stridsbergsbron
      const parraMessage = {
        Message: {
          Positions: [{
            UserID: 219000003,
            MessageID: 1,
            Timestamp: '2025-07-20T11:00:00Z',
            Latitude: 59.3280, // Närmare Stridsbergsbron
            Longitude: 18.0695,
            SOG: 1.5, // Sakta mot Stridsbergsbron
            COG: 30,
            VesselName: 'Parra',
          }],
        },
      };
      
      await app._handleAISMessage(JSON.stringify(jasminMessage));
      await app._handleAISMessage(JSON.stringify(parraMessage));
      
      // Verify: Båda båtarna ska vara i systemet
      expect(app.vesselManager.vessels.get(219000002)).toBeDefined(); // Jasmin
      expect(app.vesselManager.vessels.get(219000003)).toBeDefined(); // Parra
      
      // Simulera waiting status för Jasmin
      const jasmin = app.vesselManager.vessels.get(219000002);
      jasmin.status = 'waiting';
      jasmin.isWaiting = true;
      
      // Verify: Bridge text ska visa väntande båt
      const relevantBoats = app._findRelevantBoats();
      const bridgeText = app.messageGenerator.generateBridgeText(relevantBoats);
      expect(bridgeText).toContain('inväntar broöppning');
      
      // KRITISK TEST: Simulera timeout/cleanup försök
      // Båtarna ska INTE tas bort eftersom de är inom 300m protection zone
      
      // Försök ta bort Jasmin (inom 300m från Järnvägsbron)
      const jasminBeforeRemoval = app.vesselManager.vessels.get(219000002);
      expect(jasminBeforeRemoval).toBeDefined();
      
      // Simulera automatic cleanup försök
      app.vesselManager.removeVessel(219000002);
      
      // VERIFY: Jasmin ska FORTFARANDE finnas (protection zone)
      const jasminAfterRemoval = app.vesselManager.vessels.get(219000002);
      expect(jasminAfterRemoval).toBeDefined(); // MÅSTE finnas kvar
      
      // Verify: Bridge text ska fortfarande visa båten
      const relevantBoatsAfter = app._findRelevantBoats();
      expect(relevantBoatsAfter.length).toBeGreaterThan(0);
    });
  });

  describe('Problem 3: Passage detection missar bropassager', () => {
    test('Jasmin passerar Stallbackabron utan att systemet upptäcker det', async () => {
      // SCENARIO: Jasmin ska passera Stallbackabron och få info om detta
      
      // Steg 1: Jasmin närmar sig Stallbackabron
      const approachingMessage = {
        Message: {
          Positions: [{
            UserID: 219000004,
            MessageID: 1,
            Timestamp: '2025-07-20T12:00:00Z',
            Latitude: 59.3160, // Nära Stallbackabron
            Longitude: 18.0630,
            SOG: 3.0,
            COG: 30, // Norrut
            VesselName: 'Jasmin',
          }],
        },
      };
      
      await app._handleAISMessage(JSON.stringify(approachingMessage));
      
      // Verify: Jasmin har korrekt target bridge
      const jasminBefore = app.vesselManager.vessels.get(219000004);
      expect(jasminBefore.targetBridge).toBe('Stridsbergsbron'); // Nästa user bridge norrut
      
      // Steg 2: Jasmin passerar Stallbackabron (GPS jump scenario)
      const passedMessage = {
        Message: {
          Positions: [{
            UserID: 219000004,
            MessageID: 2,
            Timestamp: '2025-07-20T12:05:00Z',
            Latitude: 59.3190, // Passerat Stallbackabron (600m hopp)
            Longitude: 18.0650,
            SOG: 3.0,
            COG: 30,
            VesselName: 'Jasmin',
          }],
        },
      };
      
      await app._handleAISMessage(JSON.stringify(passedMessage));
      
      // VERIFY: GPS jump detection ska upptäcka Stallbackabron-passage
      const jasminAfter = app.vesselManager.vessels.get(219000004);
      expect(jasminAfter.passedBridges).toContain('stallbackabron');
      
      // VERIFY: Target bridge ska fortfarande vara Stridsbergsbron
      expect(jasminAfter.targetBridge).toBe('Stridsbergsbron');
    });
  });

  describe('Problem 4: Timing-baserade försvinnanden', () => {
    test('Jasmin försvinner efter korrekt setup - timing problem', async () => {
      // SCENARIO: Jasmin får korrekt target bridge men försvinner senare
      
      // Steg 1: Jasmin upptäcks med korrekt setup
      const initialMessage = {
        Message: {
          Positions: [{
            UserID: 219000005,
            MessageID: 1,
            Timestamp: '2025-07-20T13:00:00Z',
            Latitude: 59.3285,
            Longitude: 18.0690,
            SOG: 2.8,
            COG: 220, // Söderut mot Klaffbron
            VesselName: 'Jasmin',
          }],
        },
      };
      
      await app._handleAISMessage(JSON.stringify(initialMessage));
      
      // Verify: Korrekt initial setup
      const jasminInitial = app.vesselManager.vessels.get(219000005);
      expect(jasminInitial.targetBridge).toBe('Klaffbron'); // Korrekt söderut
      
      // Steg 2: Simulera flera uppdateringar över tid
      const timestamps = [
        '2025-07-20T13:01:00Z',
        '2025-07-20T13:02:00Z', 
        '2025-07-20T13:03:00Z',
        '2025-07-20T13:04:00Z',
        '2025-07-20T13:05:00Z', // 5 minuter senare
      ];
      
      for (let i = 0; i < timestamps.length; i++) {
        const updateMessage = {
          Message: {
            Positions: [{
              UserID: 219000005,
              MessageID: i + 2,
              Timestamp: timestamps[i],
              Latitude: 59.3285 - (i * 0.0005), // Rör sig söderut
              Longitude: 18.0690,
              SOG: 2.8,
              COG: 220,
              VesselName: 'Jasmin',
            }],
          },
        };
        
        await app._handleAISMessage(JSON.stringify(updateMessage));
        
        // VERIFY: Jasmin ska finnas kvar efter varje uppdatering
        const jasminContinuous = app.vesselManager.vessels.get(219000005);
        expect(jasminContinuous).toBeDefined();
        expect(jasminContinuous.targetBridge).toBe('Klaffbron');
      }
      
      // Final verify: Jasmin ska FORTFARANDE finnas efter 5 minuter
      const jasminFinal = app.vesselManager.vessels.get(219000005);
      expect(jasminFinal).toBeDefined();
      expect(jasminFinal.name).toBe('Jasmin');
    });
  });

  describe('Problem 5: Target bridge assignment fel', () => {
    test('Komplext scenario: Båt från söder som ska få Klaffbron men får Stridsbergsbron', async () => {
      // SCENARIO: Båt från södra hållet närmar sig broområdet
      // Ska få target bridge Klaffbron men kanske får fel
      
      const southboundMessage = {
        Message: {
          Positions: [{
            UserID: 219000006,
            MessageID: 1,
            Timestamp: '2025-07-20T14:00:00Z',
            Latitude: 59.3200, // Söder om alla broar
            Longitude: 18.0650,
            SOG: 4.0,
            COG: 45, // Nordost mot broarna
            VesselName: 'Southbound_Boat',
          }],
        },
      };
      
      await app._handleAISMessage(JSON.stringify(southboundMessage));
      
      // Verify: Target bridge assignment baserat på position och riktning
      const southBound = app.vesselManager.vessels.get(219000006);
      
      // Från söder mot nordost = första user bridge som träffas är Klaffbron
      expect(southBound.targetBridge).toBe('Klaffbron');
      
      // Continue journey - närmare Klaffbron
      const approachKlaffMessage = {
        Message: {
          Positions: [{
            UserID: 219000006,
            MessageID: 2,
            Timestamp: '2025-07-20T14:05:00Z',
            Latitude: 59.3270, // Närmare Klaffbron
            Longitude: 18.0680,
            SOG: 3.5,
            COG: 45,
            VesselName: 'Southbound_Boat',
          }],
        },
      };
      
      await app._handleAISMessage(JSON.stringify(approachKlaffMessage));
      
      // Verify: Target bridge ska bibehållas som Klaffbron
      const southBoundUpdated = app.vesselManager.vessels.get(219000006);
      expect(southBoundUpdated.targetBridge).toBe('Klaffbron');
      
      // Verify: Bridge text ska visa korrekt meddelande
      const relevantBoats = app._findRelevantBoats();
      const klaffBoats = relevantBoats.filter(b => b.targetBridge === 'Klaffbron');
      expect(klaffBoats.length).toBeGreaterThan(0);
    });
  });
});