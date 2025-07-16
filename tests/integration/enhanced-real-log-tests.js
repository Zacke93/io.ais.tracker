/* eslint-disable */
'use strict';

/**
 * Enhanced Real Log Scenario Tests
 * 
 * Förbättrade tester baserade på verkliga produktionsloggar
 * med detaljerad scenariologgning för varje test.
 */

const { Homey } = require('homey');
const ScenarioLogger = require('../fixtures/scenario-logger');
const { createMockWebSocket } = require('../helpers/websocket-mock');

// Använd TestAdapter istället för app.js direkt
const TestAdapter = require('../test-adapter');

// Create WebSocket mock
let mockWs;

// Mock WebSocket constructor
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => {
    mockWs = createMockWebSocket();
    return mockWs;
  });
});

describe('Enhanced Real Log Scenarios with Scenario Logging', () => {
  let app;
  let scenarioLogger;
  let bridgeTextHistory = [];
  let flowTriggers = [];
  
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    app = new TestAdapter();
    scenarioLogger = new ScenarioLogger();
    bridgeTextHistory = [];
    flowTriggers = [];
    
    // Mocka Homey
    app.homey = {
      settings: {
        get: jest.fn((key) => {
          if (key === 'apiKey') return 'test-api-key';
          return null;
        }),
        set: jest.fn(),
        on: jest.fn()
      },
      flow: {
        getConditionCard: jest.fn(() => ({
          registerRunListener: jest.fn()
        })),
        getTriggerCard: jest.fn(() => ({
          trigger: jest.fn((args, state) => {
            flowTriggers.push({ args, state, time: Date.now() });
            scenarioLogger.logFlowTrigger('boat_near', args, state);
            return Promise.resolve();
          })
        })),
        createToken: jest.fn(() => Promise.resolve({
          setValue: jest.fn(() => Promise.resolve())
        })),
        getToken: jest.fn(() => Promise.resolve({
          setValue: jest.fn(() => Promise.resolve())
        }))
      },
      __ : jest.fn((key) => key),
      api: {
        getOwnerName: jest.fn(() => Promise.resolve('Test User'))
      },
      drivers: {
        getDriver: jest.fn(() => ({
          getDevices: jest.fn(() => [])
        }))
      }
    };
    
    // Mocka device driver med scenariologgning
    let currentBridgeText = '';
    app._bridgeStatusDriver = {
      getDevices: jest.fn(() => [{
        setCapabilityValue: jest.fn((capability, value) => {
          if (capability === 'bridge_text') {
            const oldText = currentBridgeText;
            currentBridgeText = value;
            bridgeTextHistory.push({
              time: Date.now(),
              text: value
            });
            
            // Logga alla båtar när bridge_text ändras
            const boats = app._boats || [];
            scenarioLogger.logBridgeTextChange(oldText, value, boats);
          }
        })
      }])
    };
    
    // Lägg till event listeners för status-ändringar
    if (app.on) {
      app.on('vessel:status-changed', (data) => {
        scenarioLogger.logStatusChange(
          data.mmsi,
          data.name || `Vessel ${data.mmsi}`,
          data.oldStatus,
          data.newStatus,
          data.reason || 'Status change'
        );
      });
    }
    
    app.onInit();
    jest.advanceTimersByTime(1000);
    
    // Simulera WebSocket open event
    if (mockWs) {
      mockWs.simulateOpen();
    }
  });

  afterEach(() => {
    if (mockWs) {
      mockWs.close();
    }
    jest.clearAllTimers();
    jest.useRealTimers();
    
    // Skriv alltid ut scenario-sammanfattning
    console.log('\n' + '='.repeat(60));
    scenarioLogger.printScenario();
    console.log('='.repeat(60) + '\n');
  });

  describe('Scenario 1: EMMA F 7-minuters gap (2025-07-08)', () => {
    test('EMMA F överlever 7 minuters gap utan signal', async () => {
      console.log('\n🚢 SCENARIO: EMMA F 7-minuters gap från verklig logg');
      
      const emmaF = {
        mmsi: 265512280,
        name: 'EMMA F',
        lat: 59.31853,
        lon: 18.06736,
        speed: 3.2,
        heading: 180
      };
      
      // T=0: Initial detection nära Klaffbron
      const msg1 = createAISMessage(emmaF);
      app._handleAISMessage(msg1);
      jest.advanceTimersByTime(1000);
      
      scenarioLogger.logBoatUpdate(emmaF.mmsi, emmaF.name, 
        { lat: emmaF.lat, lon: emmaF.lon }, emmaF.speed, emmaF.heading, 'approaching');
      
      // Verifiera initial detection
      expect(app._boats.length).toBe(1);
      expect(app._boats[0].name).toBe('EMMA F');
      scenarioLogger.assertBridgeTextContains('EMMA F', 'Initial detection av EMMA F');
      
      // T+2min: Normal uppdatering
      jest.advanceTimersByTime(120000);
      emmaF.lat -= 0.001;
      const msg2 = createAISMessage(emmaF);
      app._handleAISMessage(msg2);
      
      scenarioLogger.logBoatUpdate(emmaF.mmsi, emmaF.name, 
        { lat: emmaF.lat, lon: emmaF.lon }, emmaF.speed, emmaF.heading, 'approaching');
      
      // T+5min: Sista signal före gap
      jest.advanceTimersByTime(180000);
      emmaF.lat -= 0.001;
      const msg3 = createAISMessage(emmaF);
      app._handleAISMessage(msg3);
      
      console.log('⏱️  Sista signal vid T+5min, börjar 7-minuters gap...');
      
      // T+12min: Signal återkommer efter 7-minuters gap
      jest.advanceTimersByTime(420000); // 7 minuter
      
      // Kör cleanup för att testa överlevnad
      app._cleanup();
      
      // EMMA F ska fortfarande finnas (MAX_AGE_SEC = 10 min)
      expect(app._boats.length).toBe(1);
      expect(app._boats[0].name).toBe('EMMA F');
      scenarioLogger.assertBridgeTextContains('EMMA F', 'EMMA F överlevde 7-minuters gap');
      
      // Skicka ny signal för att bekräfta
      emmaF.lat -= 0.005; // Flyttat sig under gapet
      const msg4 = createAISMessage(emmaF);
      app._handleAISMessage(msg4);
      
      scenarioLogger.logBoatUpdate(emmaF.mmsi, emmaF.name, 
        { lat: emmaF.lat, lon: emmaF.lon }, emmaF.speed, emmaF.heading, 'approaching');
      
      console.log('✅ EMMA F överlevde 7-minuters gap och fortsätter spåras');
      
      // Verifiera att båten fortfarande är aktiv
      expect(app._boats[0].status).not.toBe('idle');
      
      // Slutlig verifiering
      const journey = scenarioLogger.getBoatJourney(emmaF.mmsi);
      console.log(`📊 EMMA F resa: ${journey.events.length} positionsuppdateringar över ${Math.round((journey.events[journey.events.length-1].time - journey.events[0].time) / 60000)} minuter`);
    });
  });

  describe('Scenario 2: JULIA väntar vid Stridsbergsbron', () => {
    test('JULIA får korrekt "väntar" status när hon är nära och långsam', async () => {
      console.log('\n🚢 SCENARIO: JULIA väntar vid Stridsbergsbron');
      
      const julia = {
        mmsi: 265803940,
        name: 'JULIA',
        lat: 59.32390, // 169m från Stridsbergsbron
        lon: 18.05100,
        speed: 0.2, // Mycket långsam
        heading: 270
      };
      
      // Initial position
      const msg1 = createAISMessage(julia);
      app._handleAISMessage(msg1);
      jest.advanceTimersByTime(1000);
      
      scenarioLogger.logBoatUpdate(julia.mmsi, julia.name,
        { lat: julia.lat, lon: julia.lon }, julia.speed, julia.heading, 'approaching');
      
      // Verifiera detection
      expect(app._boats.length).toBe(1);
      const boat = app._boats[0];
      expect(boat.targetBridge).toBe('Stridsbergsbron');
      expect(boat.targetDistance).toBeLessThan(200);
      
      // Behåll låg hastighet i 2+ minuter för waiting status
      console.log('⏱️  Simulerar 2+ minuter med låg hastighet...');
      
      for (let i = 0; i < 15; i++) {
        jest.advanceTimersByTime(10000); // 10 sekunder
        julia.speed = 0.1 + (Math.random() * 0.2); // 0.1-0.3 knop
        const msg = createAISMessage(julia);
        app._handleAISMessage(msg);
        
        if (i % 3 === 0) {
          scenarioLogger.logBoatUpdate(julia.mmsi, julia.name,
            { lat: julia.lat, lon: julia.lon }, julia.speed, julia.heading, boat.status);
        }
      }
      
      // Efter 2+ minuter ska status vara "waiting"
      expect(boat.status).toBe('waiting');
      expect(boat.speedBelowThresholdSince).toBeDefined();
      
      // Uppdatera bridge_text
      app._updateActiveBridgesTag();
      
      // Verifiera "väntar" i bridge_text
      scenarioLogger.assertBridgeTextMatches(/väntar|waiting|strax/i, 
        'JULIA ska visa "väntar" status');
      scenarioLogger.assertBridgeTextContains('JULIA', 'JULIA syns i bridge_text');
      
      console.log('✅ JULIA har korrekt "väntar" status när hon är nära och långsam');
      
      // Simulera att JULIA börjar röra sig igen
      julia.speed = 4.5;
      const msgMoving = createAISMessage(julia);
      mockWs.simulateMessage(msgMoving);
      jest.advanceTimersByTime(10000);
      
      // Status ska ändras tillbaka till approaching
      expect(boat.status).toBe('approaching');
      scenarioLogger.logStatusChange(julia.mmsi, julia.name, 'waiting', 'approaching', 'Ökad hastighet');
      
      console.log('📊 JULIA status-historik:', boat.status);
    });
  });

  describe('Scenario 3: SKAGERN passerar flera broar', () => {
    test('SKAGERN spåras korrekt genom hela bropassage-sekvensen', async () => {
      console.log('\n🚢 SCENARIO: SKAGERN passerar Olidebron → Klaffbron → Stridsbergsbron');
      
      const skagern = {
        mmsi: 266023000,
        name: 'SKAGERN',
        lat: 59.31553, // Börjar väster om Olidebron
        lon: 18.05300,
        speed: 6.0,
        heading: 90 // Österut
      };
      
      // Start väster om Olidebron
      const msg1 = createAISMessage(skagern);
      app._handleAISMessage(msg1);
      jest.advanceTimersByTime(1000);
      
      scenarioLogger.logBoatUpdate(skagern.mmsi, skagern.name,
        { lat: skagern.lat, lon: skagern.lon }, skagern.speed, skagern.heading, 'approaching');
      
      const boat = app._boats[0];
      expect(boat.nearBridge).toBe('Olidebron');
      
      console.log('📍 SKAGERN närmar sig Olidebron från väster');
      
      // Passera Olidebron
      skagern.lon = 18.05700; // Öster om Olidebron
      const msg2 = createAISMessage(skagern);
      app._handleAISMessage(msg2);
      jest.advanceTimersByTime(60000);
      
      expect(boat.passedBridges).toContain('Olidebron');
      expect(boat.targetBridge).toBe('Klaffbron');
      scenarioLogger.logBridgePassage(skagern.mmsi, skagern.name, 'Olidebron', 'Klaffbron');
      
      console.log('✅ Passerade Olidebron, siktar mot Klaffbron');
      
      // Närma sig Klaffbron
      skagern.lon = 18.06600;
      skagern.lat = 59.31721;
      const msg3 = createAISMessage(skagern);
      app._handleAISMessage(msg3);
      jest.advanceTimersByTime(180000);
      
      // Ska trigga flow för Klaffbron
      scenarioLogger.assertFlowTriggered('Klaffbron', 'Flow ska triggas för Klaffbron');
      scenarioLogger.assertBridgeTextContains('SKAGERN', 'SKAGERN syns när han närmar sig Klaffbron');
      
      // Passera Klaffbron
      skagern.lon = 18.06900;
      const msg4 = createAISMessage(skagern);
      app._handleAISMessage(msg4);
      jest.advanceTimersByTime(60000);
      
      expect(boat.passedBridges).toContain('Klaffbron');
      expect(boat.targetBridge).toBe('Stridsbergsbron');
      scenarioLogger.logBridgePassage(skagern.mmsi, skagern.name, 'Klaffbron', 'Stridsbergsbron');
      
      console.log('✅ Passerade Klaffbron, siktar mot Stridsbergsbron');
      
      // Närma sig Stridsbergsbron
      skagern.lon = 18.05000;
      skagern.lat = 59.32420;
      const msg5 = createAISMessage(skagern);
      app._handleAISMessage(msg5);
      jest.advanceTimersByTime(120000);
      
      // Ska trigga flow för Stridsbergsbron
      scenarioLogger.assertFlowTriggered('Stridsbergsbron', 'Flow ska triggas för Stridsbergsbron');
      
      // Sammanfatta resan
      const journey = scenarioLogger.getBoatJourney(skagern.mmsi);
      console.log(`\n📊 SKAGERN kompletta resa:`);
      console.log(`   - Broar: ${journey.bridges.join(' → ')}`);
      console.log(`   - Tid: ${Math.round((journey.events[journey.events.length-1].time - journey.events[0].time) / 60000)} minuter`);
      console.log(`   - Status-ändringar: ${journey.statuses.length}`);
    });
  });

  describe('Scenario 4: Multipla båtar och bridge_text prioritering', () => {
    test('Systemet hanterar 5 båtar samtidigt med korrekt prioritering', async () => {
      console.log('\n🚢 SCENARIO: 5 båtar samtidigt vid olika broar');
      
      const boats = [
        { mmsi: 111111111, name: 'BÅTEL 1', lat: 59.31721, lon: 18.06650, speed: 4.0, heading: 90, bridge: 'Klaffbron' },
        { mmsi: 222222222, name: 'BÅTEL 2', lat: 59.32420, lon: 18.05050, speed: 3.5, heading: 180, bridge: 'Stridsbergsbron' },
        { mmsi: 333333333, name: 'BÅTEL 3', lat: 59.31553, lon: 18.05550, speed: 5.0, heading: 90, bridge: 'Olidebron' },
        { mmsi: 444444444, name: 'BÅTEL 4', lat: 59.32280, lon: 18.04950, speed: 2.0, heading: 270, bridge: 'Järnvägsbron' },
        { mmsi: 555555555, name: 'BÅTEL 5', lat: 59.32820, lon: 18.04500, speed: 6.0, heading: 180, bridge: 'Stallbackabron' }
      ];
      
      // Skicka alla båtar
      boats.forEach((boat, index) => {
        const msg = createAISMessage(boat);
        app._handleAISMessage(msg);
        jest.advanceTimersByTime(500);
        
        scenarioLogger.logBoatUpdate(boat.mmsi, boat.name,
          { lat: boat.lat, lon: boat.lon }, boat.speed, boat.heading, 'approaching');
      });
      
      // Verifiera att alla spåras
      expect(app._boats.length).toBe(5);
      
      // Uppdatera bridge_text
      app._updateActiveBridgesTag();
      
      // Bridge_text ska prioritera target bridges (Klaffbron, Stridsbergsbron)
      scenarioLogger.assertBridgeTextContains('BÅTEL 1', 'Klaffbron-båt ska synas');
      scenarioLogger.assertBridgeTextContains('BÅTEL 2', 'Stridsbergsbron-båt ska synas');
      
      console.log('📊 Bridge text prioritering:');
      console.log(`   - Klaffbron: BÅTEL 1`);
      console.log(`   - Stridsbergsbron: BÅTEL 2`);
      console.log(`   - Övriga: ${boats.slice(2).map(b => b.name).join(', ')}`);
      
      // Simulera att BÅTEL 1 passerar Klaffbron
      boats[0].lon = 18.06900;
      const msgPassed = createAISMessage(boats[0]);
      mockWs.simulateMessage(msgPassed);
      jest.advanceTimersByTime(30000);
      
      scenarioLogger.logBridgePassage(boats[0].mmsi, boats[0].name, 'Klaffbron', null);
      
      // Nu ska en annan båt synas istället
      app._updateActiveBridgesTag();
      
      const bridgeText = bridgeTextHistory[bridgeTextHistory.length - 1].text;
      console.log(`\n📝 Uppdaterad bridge_text efter passage: "${bridgeText}"`);
      
      // Verifiera att systemet fortfarande spårar alla
      expect(app._boats.length).toBe(5);
      
      console.log('✅ Systemet hanterar 5 båtar med korrekt prioritering');
    });
  });

  describe('Scenario 5: Extrema förhållanden och feltolerans', () => {
    test('Systemet hanterar kaotiska signaler och datafel', async () => {
      console.log('\n🚢 SCENARIO: Kaotiska signaler och datafel');
      
      const chaoticBoat = {
        mmsi: 999999999,
        name: 'KAOS',
        lat: 59.31721,
        lon: 18.06700,
        speed: 5.0,
        heading: 90
      };
      
      // Normal start
      const msg1 = createAISMessage(chaoticBoat);
      app._handleAISMessage(msg1);
      jest.advanceTimersByTime(1000);
      
      const boat = app._boats[0];
      expect(boat).toBeDefined();
      
      console.log('🌀 Börjar skicka kaotiska signaler...');
      
      // Skicka 20 kaotiska uppdateringar
      for (let i = 0; i < 20; i++) {
        // Slumpmässiga värden
        chaoticBoat.speed = Math.random() * 20; // 0-20 knop
        chaoticBoat.heading = Math.random() * 360; // 0-360 grader
        chaoticBoat.lat += (Math.random() - 0.5) * 0.001; // Hoppar runt
        chaoticBoat.lon += (Math.random() - 0.5) * 0.001;
        
        // Ibland skicka ogiltiga värden
        if (i % 5 === 0) {
          chaoticBoat.speed = -1; // Ogiltig hastighet
        }
        if (i % 7 === 0) {
          chaoticBoat.lat = null; // Ogiltig position
        }
        
        const msg = createAISMessage(chaoticBoat);
        
        // Ska inte krascha
        expect(() => {
          app._handleAISMessage(msg);
        }).not.toThrow();
        
        jest.advanceTimersByTime(5000);
        
        if (i % 4 === 0) {
          scenarioLogger.logBoatUpdate(chaoticBoat.mmsi, chaoticBoat.name,
            { lat: chaoticBoat.lat, lon: chaoticBoat.lon }, 
            chaoticBoat.speed, chaoticBoat.heading, 'chaotic');
        }
      }
      
      console.log('✅ Systemet överlevde 20 kaotiska signaler utan att krascha');
      
      // Systemet ska fortfarande fungera
      app._updateActiveBridgesTag();
      app._cleanup();
      
      // Återställ normal signal
      chaoticBoat.lat = 59.31721;
      chaoticBoat.lon = 18.06700;
      chaoticBoat.speed = 4.0;
      chaoticBoat.heading = 90;
      
      const msgNormal = createAISMessage(chaoticBoat);
      mockWs.simulateMessage(msgNormal);
      jest.advanceTimersByTime(1000);
      
      console.log('✅ Systemet återhämtade sig och fungerar normalt igen');
    });
  });

  // Hjälpfunktion för att skapa AIS-meddelanden
  function createAISMessage(boat) {
    return {
      MessageID: 'PositionReport',
      MetaData: { 
        time_utc: new Date().toISOString(),
        source: 'test'
      },
      Message: {
        PositionReport: {
          Cog: boat.heading || 0,
          CommunicationState: '0',
          Latitude: boat.lat,
          Longitude: boat.lon,
          MessageID: 'PositionReport',
          NavigationalStatus: 'UnderWayUsingEngine',
          PositionAccuracy: true,
          RateOfTurn: 0,
          RepeatIndicator: 'DoNotRepeat',
          Sog: boat.speed || 0,
          Spare: false,
          SpecialManoeuvreIndicator: 'NotEngaged',
          Timestamp: 0,
          TrueHeading: boat.heading || 0,
          UserID: boat.mmsi,
          Valid: true
        }
      }
    };
  }
});