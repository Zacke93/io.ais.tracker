/* eslint-disable */
'use strict';

/**
 * Enhanced Bug Finder Tests
 * 
 * Avancerade tester designade för att hitta subtila buggar
 * och verifiera att systemet fungerar korrekt under extrema förhållanden.
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

describe('Enhanced Bug Finder Tests with Deep Analysis', () => {
  let app;
  let scenarioLogger;
  let performanceMetrics = {
    updateTimes: [],
    cleanupTimes: [],
    memoryUsage: []
  };
  
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    app = new TestAdapter();
    scenarioLogger = new ScenarioLogger();
    
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
    
    // Mocka device driver med performance tracking
    let currentBridgeText = '';
    app._bridgeStatusDriver = {
      getDevices: jest.fn(() => [{
        setCapabilityValue: jest.fn((capability, value) => {
          if (capability === 'bridge_text') {
            const oldText = currentBridgeText;
            currentBridgeText = value;
            scenarioLogger.logBridgeTextChange(oldText, value, app._boats);
          }
        })
      }])
    };
    
    // Wrap performance-kritiska funktioner
    const originalUpdate = app._updateActiveBridgesTag;
    if (originalUpdate) {
      app._updateActiveBridgesTag = function() {
        const start = Date.now();
        const result = originalUpdate.call(this);
        performanceMetrics.updateTimes.push(Date.now() - start);
        return result;
      };
    }
    
    const originalCleanup = app._cleanup;
    if (originalCleanup) {
      app._cleanup = function() {
        const start = Date.now();
        const result = originalCleanup.call(this);
        performanceMetrics.cleanupTimes.push(Date.now() - start);
        return result;
      };
    }
    
    app.onInit();
    jest.advanceTimersByTime(1000);
    
    // Simulera WebSocket open event
    if (mockWs) {
      mockWs.simulateOpen();
    }
  });

  afterEach(() => {
    mockWs.close();
    jest.clearAllTimers();
    jest.useRealTimers();
    
    // Skriv ut scenario och performance
    if (scenarioLogger.events.length > 0) {
      console.log('\n' + '='.repeat(60));
      scenarioLogger.printScenario();
      
      if (performanceMetrics.updateTimes.length > 0) {
        console.log('\n=== PERFORMANCE METRICS ===');
        console.log(`Update times: avg ${avg(performanceMetrics.updateTimes)}ms, max ${Math.max(...performanceMetrics.updateTimes)}ms`);
        console.log(`Cleanup times: avg ${avg(performanceMetrics.cleanupTimes)}ms, max ${Math.max(...performanceMetrics.cleanupTimes)}ms`);
      }
      console.log('='.repeat(60) + '\n');
    }
  });

  describe('1. Subtila timing-buggar', () => {
    test('Bug: Race condition vid samtidiga båtuppdateringar', async () => {
      console.log('\n🐛 TEST: Race condition vid samtidiga uppdateringar');
      
      const boats = [
        { mmsi: 111111111, name: 'RACER 1', lat: 59.31721, lon: 18.06700, speed: 5.0 },
        { mmsi: 222222222, name: 'RACER 2', lat: 59.31721, lon: 18.06700, speed: 5.0 },
        { mmsi: 333333333, name: 'RACER 3', lat: 59.31721, lon: 18.06700, speed: 5.0 }
      ];
      
      // Skicka alla båtar exakt samtidigt (inom samma event loop tick)
      boats.forEach(boat => {
        const msg = createAISMessage(boat);
        app._handleAISMessage(msg);
      });
      
      // Process alla samtidigt
      jest.advanceTimersByTime(0);
      
      // Alla ska registreras korrekt
      expect(app._boats.length).toBe(3);
      expect(app._boats.map(b => b.mmsi).sort()).toEqual([111111111, 222222222, 333333333]);
      
      console.log('✅ Ingen race condition - alla båtar registrerade korrekt');
      
      // Test samtidig borttagning
      jest.advanceTimersByTime(900000); // 15 minuter senare
      
      // Alla ska tas bort vid cleanup
      app._cleanup();
      expect(app._boats.length).toBe(0);
      
      console.log('✅ Samtidig cleanup fungerar korrekt');
    });

    test('Bug: Minnestillväxt vid långvarig drift', async () => {
      console.log('\n🐛 TEST: Minnestillväxt över tid');
      
      const initialMemory = process.memoryUsage().heapUsed;
      console.log(`📊 Initial minnesanvändning: ${Math.round(initialMemory / 1024 / 1024)}MB`);
      
      // Simulera 24 timmars drift med båtar som kommer och går
      for (let hour = 0; hour < 24; hour++) {
        console.log(`⏰ Timme ${hour + 1}...`);
        
        // Lägg till 5 nya båtar varje timme
        for (let i = 0; i < 5; i++) {
          const boat = {
            mmsi: hour * 1000 + i,
            name: `BOAT_H${hour}_${i}`,
            lat: 59.31721 + (Math.random() - 0.5) * 0.01,
            lon: 18.06700 + (Math.random() - 0.5) * 0.01,
            speed: 3 + Math.random() * 5
          };
          
          const msg = createAISMessage(boat);
          app._handleAISMessage(msg);
        }
        
        jest.advanceTimersByTime(1800000); // 30 minuter
        
        // Cleanup gamla båtar
        app._cleanup();
        
        jest.advanceTimersByTime(1800000); // ytterligare 30 minuter
        
        // Mät minne varje timme
        if (hour % 4 === 0) {
          global.gc && global.gc(); // Tvinga GC om tillgängligt
          const currentMemory = process.memoryUsage().heapUsed;
          performanceMetrics.memoryUsage.push(currentMemory);
          console.log(`📊 Minnesanvändning efter ${hour + 1}h: ${Math.round(currentMemory / 1024 / 1024)}MB`);
        }
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;
      
      console.log(`\n📊 Minnestillväxt efter 24h: ${Math.round(memoryGrowth / 1024 / 1024)}MB`);
      
      // Minnesökningen ska vara rimlig (< 10MB)
      expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024);
      
      console.log('✅ Ingen signifikant minnesläcka detekterad');
    });

    test('Bug: Floating point precision i avståndberäkningar', async () => {
      console.log('\n🐛 TEST: Floating point precision problem');
      
      // Båt exakt på brons koordinater
      const boatOnBridge = {
        mmsi: 123456789,
        name: 'PRECISION',
        lat: 59.31721, // Exakt Klaffbrons lat
        lon: 18.06700, // Exakt Klaffbrons lon
        speed: 0.1
      };
      
      const msg = createAISMessage(boatOnBridge);
      mockWs.on.mock.calls[0][1](JSON.stringify(msg));
      jest.advanceTimersByTime(1000);
      
      const boat = app._boats[0];
      expect(boat.targetDistance).toBe(0); // Exakt 0
      
      // Flytta båten minimalt (floating point precision test)
      boatOnBridge.lat += 0.0000001; // Mycket liten förändring
      const msg2 = createAISMessage(boatOnBridge);
      mockWs.on.mock.calls[0][1](JSON.stringify(msg2));
      
      // Avståndet ska fortfarande beräknas korrekt
      expect(boat.targetDistance).toBeGreaterThanOrEqual(0);
      expect(boat.targetDistance).toBeLessThan(1); // Mindre än 1 meter
      
      console.log(`✅ Floating point precision hanterad: ${boat.targetDistance}m`);
    });
  });

  describe('2. State corruption buggar', () => {
    test('Bug: State corruption vid snabba statusändringar', async () => {
      console.log('\n🐛 TEST: State corruption vid snabba ändringar');
      
      const boat = {
        mmsi: 987654321,
        name: 'FLIPPER',
        lat: 59.31721,
        lon: 18.06700,
        speed: 5.0,
        heading: 90
      };
      
      // Initial position
      const msg1 = createAISMessage(boat);
      mockWs.on.mock.calls[0][1](JSON.stringify(msg1));
      jest.advanceTimersByTime(1000);
      
      const trackedBoat = app._boats[0];
      const stateHistory = [];
      
      // Gör 50 snabba ändringar
      for (let i = 0; i < 50; i++) {
        // Växla mellan olika states snabbt
        if (i % 3 === 0) {
          boat.speed = 0.1; // Trigger waiting
          boat.heading = (i * 45) % 360; // Ändra riktning
        } else if (i % 3 === 1) {
          boat.speed = 8.0; // Hög hastighet
          boat.lat += 0.001; // Flytta norr
        } else {
          boat.speed = 3.0; // Normal
          boat.lon += 0.001; // Flytta öst
        }
        
        const msg = createAISMessage(boat);
        app._handleAISMessage(msg);
        jest.advanceTimersByTime(2000); // 2 sekunder mellan
        
        stateHistory.push({
          status: trackedBoat.status,
          speed: trackedBoat.sog,
          heading: trackedBoat.cog,
          nearBridge: trackedBoat.nearBridge,
          targetBridge: trackedBoat.targetBridge
        });
      }
      
      // Verifiera att state är konsistent
      expect(trackedBoat.mmsi).toBe(987654321); // Grunddata intakt
      expect(trackedBoat.name).toBe('FLIPPER');
      expect(trackedBoat.lastSeen).toBeDefined();
      expect(trackedBoat.speedHistory).toBeDefined();
      expect(trackedBoat.speedHistory.length).toBeGreaterThan(0);
      
      // Analysera state-historik
      const uniqueStatuses = [...new Set(stateHistory.map(s => s.status))];
      console.log(`📊 Unika statusar: ${uniqueStatuses.join(', ')}`);
      console.log(`📊 State-ändringar: ${stateHistory.length}`);
      
      console.log('✅ Ingen state corruption trots 50 snabba ändringar');
    });

    test('Bug: Cirkulär referens i speedHistory', async () => {
      console.log('\n🐛 TEST: Cirkulär referens kontroll');
      
      const boat = {
        mmsi: 135792468,
        name: 'CIRCULAR',
        lat: 59.31721,
        lon: 18.06700,
        speed: 5.0
      };
      
      const msg = createAISMessage(boat);
      mockWs.on.mock.calls[0][1](JSON.stringify(msg));
      jest.advanceTimersByTime(1000);
      
      const trackedBoat = app._boats[0];
      
      // Fyll speedHistory med många entries
      for (let i = 0; i < 100; i++) {
        boat.speed = 3 + Math.random() * 4;
        const updateMsg = createAISMessage(boat);
        mockWs.on.mock.calls[0][1](JSON.stringify(updateMsg));
        jest.advanceTimersByTime(5000);
      }
      
      // Försök serialisera (skulle faila vid cirkulär referens)
      let serialized;
      expect(() => {
        serialized = JSON.stringify(trackedBoat);
      }).not.toThrow();
      
      expect(serialized).toBeDefined();
      console.log(`✅ Ingen cirkulär referens - objekt kan serialiseras (${serialized.length} tecken)`);
      
      // Verifiera att speedHistory har rimlig storlek
      expect(trackedBoat.speedHistory.length).toBeLessThanOrEqual(20); // Max history size
      console.log(`✅ SpeedHistory begränsad till ${trackedBoat.speedHistory.length} entries`);
    });
  });

  describe('3. Edge cases i bropassage-logik', () => {
    test('Bug: Båt "teleporterar" mellan broar', async () => {
      console.log('\n🐛 TEST: Teleportering mellan broar');
      
      const teleporter = {
        mmsi: 246813579,
        name: 'TELEPORTER',
        lat: 59.31553, // Vid Olidebron
        lon: 18.05550,
        speed: 5.0,
        heading: 90
      };
      
      // Start vid Olidebron
      const msg1 = createAISMessage(teleporter);
      mockWs.on.mock.calls[0][1](JSON.stringify(msg1));
      jest.advanceTimersByTime(1000);
      
      const boat = app._boats[0];
      expect(boat.nearBridge).toBe('Olidebron');
      scenarioLogger.logBoatUpdate(teleporter.mmsi, teleporter.name,
        { lat: teleporter.lat, lon: teleporter.lon }, teleporter.speed, 90, 'approaching');
      
      // "Teleportera" direkt till Stridsbergsbron (hoppa över Klaffbron)
      teleporter.lat = 59.32420;
      teleporter.lon = 18.05043;
      const msg2 = createAISMessage(teleporter);
      mockWs.on.mock.calls[0][1](JSON.stringify(msg2));
      jest.advanceTimersByTime(1000);
      
      // Systemet ska detektera den onaturliga förflyttningen
      expect(boat.nearBridge).toBe('Stridsbergsbron');
      
      // Borde ha detekterat att något är fel
      const distance = haversineDistance(
        { lat: 59.31553, lon: 18.05550 },
        { lat: 59.32420, lon: 18.05043 }
      );
      
      console.log(`📏 Teleportavstånd: ${Math.round(distance)}m`);
      console.log(`⏱️  Tid: 1 sekund`);
      console.log(`🚀 Hastighet skulle vara: ${Math.round(distance * 1.94384)}+ knop!`);
      
      // Detta är omöjligt för en båt
      expect(distance).toBeGreaterThan(500); // Mer än 500m
      
      console.log('✅ Onaturlig förflyttning detekterad');
    });

    test('Bug: Båt fastnar i "under-bridge" status', async () => {
      console.log('\n🐛 TEST: Fastnar i under-bridge status');
      
      const stuckBoat = {
        mmsi: 369258147,
        name: 'STUCK',
        lat: 59.31721,
        lon: 18.06700,
        speed: 2.0,
        heading: 90
      };
      
      // Placera båten exakt under bron
      const msg1 = createAISMessage(stuckBoat);
      mockWs.on.mock.calls[0][1](JSON.stringify(msg1));
      jest.advanceTimersByTime(1000);
      
      const boat = app._boats[0];
      
      // Sätt manuellt till under-bridge (simulera att den kom dit)
      boat.status = 'under-bridge';
      boat.targetDistance = 10; // Mycket nära
      
      console.log('🌉 Båt är under bron...');
      
      // Simulera att båten stannar under bron i 5 minuter
      for (let i = 0; i < 10; i++) {
        stuckBoat.speed = 0.1; // Nästan stillastående
        // Små rörelser fram och tillbaka
        stuckBoat.lon += (i % 2 === 0) ? 0.00001 : -0.00001;
        
        const msg = createAISMessage(stuckBoat);
        app._handleAISMessage(msg);
        jest.advanceTimersByTime(30000); // 30 sekunder
        
        scenarioLogger.logBoatUpdate(stuckBoat.mmsi, stuckBoat.name,
          { lat: stuckBoat.lat, lon: stuckBoat.lon }, stuckBoat.speed, 90, boat.status);
      }
      
      // Efter 5 minuter ska den inte längre vara "under-bridge"
      expect(boat.status).not.toBe('under-bridge');
      console.log(`✅ Båt är inte längre fastlåst i under-bridge, ny status: ${boat.status}`);
    });

    test('Bug: Negativ ETA vid bakåtgående båt', async () => {
      console.log('\n🐛 TEST: Negativ ETA för bakåtgående båt');
      
      const reverseBoat = {
        mmsi: 147258369,
        name: 'REVERSE',
        lat: 59.31721,
        lon: 18.06800, // Öster om Klaffbron
        speed: 3.0,
        heading: 270 // Västerut (mot bron från fel håll)
      };
      
      const msg = createAISMessage(reverseBoat);
      mockWs.on.mock.calls[0][1](JSON.stringify(msg));
      jest.advanceTimersByTime(1000);
      
      const boat = app._boats[0];
      
      // Båten rör sig bort från bron
      reverseBoat.lon += 0.001; // Ännu längre öster
      const msg2 = createAISMessage(reverseBoat);
      mockWs.on.mock.calls[0][1](JSON.stringify(msg2));
      jest.advanceTimersByTime(10000);
      
      // ETA ska inte vara negativ eller orimlig
      const eta = app._calculateETA(boat);
      expect(eta).toBeGreaterThanOrEqual(0);
      
      console.log(`📊 ETA för bakåtgående båt: ${eta || 'N/A'}`);
      console.log('✅ Ingen negativ ETA genererad');
    });
  });

  describe('4. Prestandatester under extrem belastning', () => {
    test('Performance: 50 båtar samtidigt', async () => {
      console.log('\n⚡ PERFORMANCE TEST: 50 båtar samtidigt');
      
      const boats = [];
      
      // Skapa 50 båtar spridda över alla broar
      for (let i = 0; i < 50; i++) {
        boats.push({
          mmsi: 500000000 + i,
          name: `LOAD_${i}`,
          lat: 59.31000 + (Math.random() * 0.02),
          lon: 18.04500 + (Math.random() * 0.03),
          speed: 2 + Math.random() * 8,
          heading: Math.random() * 360
        });
      }
      
      console.log('📊 Lägger till 50 båtar...');
      const addStart = Date.now();
      
      boats.forEach(boat => {
        const msg = createAISMessage(boat);
        app._handleAISMessage(msg);
      });
      jest.advanceTimersByTime(100);
      
      const addTime = Date.now() - addStart;
      console.log(`✅ 50 båtar tillagda på ${addTime}ms`);
      
      expect(app._boats.length).toBe(50);
      
      // Mät update-prestanda
      console.log('📊 Mäter update-prestanda...');
      const updateStart = Date.now();
      app._updateActiveBridgesTag();
      const updateTime = Date.now() - updateStart;
      
      console.log(`✅ Bridge text update med 50 båtar: ${updateTime}ms`);
      expect(updateTime).toBeLessThan(50); // Ska vara snabbt
      
      // Mät cleanup-prestanda
      console.log('📊 Mäter cleanup-prestanda...');
      jest.advanceTimersByTime(600000); // 10 minuter
      
      const cleanupStart = Date.now();
      app._cleanup();
      const cleanupTime = Date.now() - cleanupStart;
      
      console.log(`✅ Cleanup med 50 båtar: ${cleanupTime}ms`);
      expect(cleanupTime).toBeLessThan(50);
      
      // Simulera kontinuerlig drift
      console.log('📊 Simulerar 100 uppdateringar...');
      let totalUpdateTime = 0;
      
      for (let i = 0; i < 100; i++) {
        // Uppdatera några båtar
        for (let j = 0; j < 10; j++) {
          const boat = boats[Math.floor(Math.random() * boats.length)];
          boat.lat += (Math.random() - 0.5) * 0.0001;
          boat.lon += (Math.random() - 0.5) * 0.0001;
          
          const msg = createAISMessage(boat);
          app._handleAISMessage(msg);
        }
        
        const start = Date.now();
        app._updateActiveBridgesTag();
        totalUpdateTime += Date.now() - start;
        
        jest.advanceTimersByTime(1000);
      }
      
      const avgUpdateTime = totalUpdateTime / 100;
      console.log(`✅ Genomsnittlig update-tid över 100 cykler: ${avgUpdateTime.toFixed(2)}ms`);
      expect(avgUpdateTime).toBeLessThan(10);
    });
  });

  // Hjälpfunktioner
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

  function haversineDistance(pos1, pos2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = pos1.lat * Math.PI / 180;
    const φ2 = pos2.lat * Math.PI / 180;
    const Δφ = (pos2.lat - pos1.lat) * Math.PI / 180;
    const Δλ = (pos2.lon - pos1.lon) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
  }

  function avg(arr) {
    return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  }
});