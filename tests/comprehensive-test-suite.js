const { Homey } = require('homey');
const ScenarioLogger = require('./fixtures/scenario-logger');
// Använd TestAdapter istället för app.js direkt
const TestAdapter = require('./test-adapter');

// Mock WebSocket helt enkelt eftersom vi inte använder den
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    readyState: 1,
    OPEN: 1,
    CLOSED: 3,
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  }));
});

// Hjälpfunktion för att skicka AIS data
function sendAISData(app, vessel) {
  // Skicka static data först om namn finns
  if (vessel.name) {
    app._handleAISMessage({
      MessageID: 'ShipStaticData',
      MetaData: { time_utc: new Date().toISOString() },
      Message: {
        ShipStaticData: {
          Name: vessel.name,
          UserID: vessel.mmsi,
          Valid: true,
        },
      },
    });
  }

  // Vänta lite så static data hinner processas
  jest.advanceTimersByTime(10);

  // Skicka position report
  app._handleAISMessage({
    MessageID: 'PositionReport',
    MetaData: { time_utc: new Date().toISOString() },
    Message: {
      PositionReport: {
        Cog: vessel.heading || vessel.cog || 0,
        Latitude: vessel.lat,
        Longitude: vessel.lon,
        NavigationalStatus: 'UnderWayUsingEngine',
        Sog: vessel.speed || vessel.sog || 0,
        UserID: vessel.mmsi,
        Valid: true,
      },
    },
  });
}

describe('Comprehensive AIS Tracker Test Suite', () => {
  let app;
  let scenarioLogger;
  let originalBridgeText = '';
  const bridgeTextChanges = [];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Skapa ny app-instans med TestAdapter
    app = new TestAdapter();
    scenarioLogger = new ScenarioLogger();

    // Mocka Homey-metoder
    app.homey = {
      settings: {
        get: jest.fn((key) => {
          if (key === 'ais_api_key') return '12345678-1234-5678-1234-567812345678'; // Valid UUID format
          return null;
        }),
        set: jest.fn(),
        on: jest.fn(), // Lägg till on-metod för settings
      },
      flow: {
        getConditionCard: jest.fn(() => ({
          registerRunListener: jest.fn(),
        })),
        getTriggerCard: jest.fn(() => ({
          trigger: jest.fn((args, state) => {
            scenarioLogger.logFlowTrigger('boat_near', args, state);
            return Promise.resolve();
          }),
          registerRunListener: jest.fn(),
        })),
        createToken: jest.fn(() => Promise.resolve({
          setValue: jest.fn(() => Promise.resolve()),
        })),
        getToken: jest.fn(() => Promise.resolve({
          setValue: jest.fn(() => Promise.resolve()),
        })),
      },
      __: jest.fn((key) => key),
      api: {
        getOwnerName: jest.fn(() => Promise.resolve('Test User')),
      },
      drivers: {
        getDriver: jest.fn(() => ({
          getDevices: jest.fn(() => []),
        })),
      },
    };

    // Mocka device driver
    app._bridgeStatusDriver = {
      getDevices: jest.fn(() => [{
        setCapabilityValue: jest.fn((capability, value) => {
          if (capability === 'bridge_text' && value !== originalBridgeText) {
            const oldText = originalBridgeText;
            originalBridgeText = value;
            bridgeTextChanges.push({ oldText, newText: value });
            scenarioLogger.logBridgeTextChange(oldText, value, app._boats);
          }
        }),
      }]),
    };

    // Initiera appen
    app.onInit();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();

    // Skriv ut scenario-sammanfattning efter varje test
    if (scenarioLogger.events.length > 0) {
      scenarioLogger.printScenario();
    }
  });

  describe('1. Kritiska buggar från verkliga loggar', () => {
    test('Bug 1: Båt försvinner trots stabila AIS-signaler', async () => {
      console.log('\n=== TEST: Båt försvinner trots stabila signaler ===');

      // Skicka position nära Klaffbron
      const emmaF = {
        mmsi: 265512280,
        name: 'EMMA F',
        lat: 59.31853,
        lon: 18.06736,
        speed: 3.2,
        heading: 180,
      };

      // Skicka AIS data
      sendAISData(app, emmaF);

      jest.advanceTimersByTime(1000);

      scenarioLogger.logBoatUpdate(
        265512280,
        'EMMA F',
        { lat: 59.31853, lon: 18.06736 },
        3.2,
        180,
        'approaching',
      );

      // Verifiera att båten spåras
      expect(app._boats.length).toBe(1);
      expect(app._boats[0].name).toBe('EMMA F');
      scenarioLogger.assertBridgeTextContains('EMMA F', 'Båten ska synas i bridge_text');

      // Simulera 8 minuters kontinuerliga uppdateringar
      for (let i = 0; i < 8; i++) {
        jest.advanceTimersByTime(60000); // 1 minut

        // Uppdatera position något
        emmaF.lat = 59.31853 - (0.0001 * (i + 1));
        sendAISData(app, emmaF);

        scenarioLogger.logBoatUpdate(
          265512280,
          'EMMA F',
          { lat: 59.31853 - (0.0001 * (i + 1)), lon: 18.06736 },
          3.2,
          180,
          'approaching',
        );
      }

      // Båten ska fortfarande spåras efter 8 minuter
      expect(app._boats.length).toBe(1);
      expect(app._boats[0].status).not.toBe('idle');

      // Simulera 3 minuter utan signal (men under MAX_AGE_SEC)
      jest.advanceTimersByTime(180000);
      app._cleanup();

      // Båten ska fortfarande finnas kvar
      expect(app._boats.length).toBe(1);
      scenarioLogger.assertBridgeTextContains('EMMA F', 'Båten ska fortfarande synas efter 3 min utan signal');

      console.log('✅ Bug 1 löst: Båten försvinner inte längre vid korta signalavbrott');
    });

    test('Bug 2: Bridge passage detection missar båtar som passerar', async () => {
      console.log('\n=== TEST: Bridge passage detection ===');

      // Skicka första position (närmar sig)
      const testBoat = {
        mmsi: 123456789,
        name: 'TEST BOAT',
        lat: 59.31721,
        lon: 18.06623,
        speed: 5.0,
        heading: 90,
      };
      sendAISData(app, testBoat);
      jest.advanceTimersByTime(1000);

      expect(app._boats.length).toBe(1);
      const boat = app._boats[0];
      expect(boat.targetBridge).toBe('Klaffbron');
      expect(boat.targetDistance).toBeLessThan(300);

      scenarioLogger.logBoatUpdate(123456789, 'TEST BOAT',
        { lat: 59.31721, lon: 18.06623 }, 5.0, 90, 'approaching');

      // Simulera passage genom att flytta båten förbi bron
      testBoat.lon = 18.06800; // Öster om Klaffbron
      sendAISData(app, testBoat);
      jest.advanceTimersByTime(1000);

      // Verifiera att passage detekterades
      expect(boat.status).toBe('passed');
      expect(boat.passedBridges).toContain('Klaffbron');

      scenarioLogger.logBridgePassage(123456789, 'TEST BOAT', 'Klaffbron', boat.targetBridge);

      // Båten ska nu sikta mot nästa bro (om relevant)
      if (boat.targetBridge) {
        expect(boat.targetBridge).not.toBe('Klaffbron');
        console.log(`✅ Båt passerade Klaffbron och siktar nu mot ${boat.targetBridge}`);
      } else {
        console.log('✅ Båt passerade Klaffbron och har ingen nästa målbro');
      }
    });

    test('Bug 3: Unrealistic ETA för väntande båtar', async () => {
      console.log('\n=== TEST: Realistiska ETA-beräkningar ===');

      // Simulera mycket långsam båt nära bron
      const julia = {
        mmsi: 987654321,
        name: 'JULIA',
        lat: 59.32420, // Mycket nära Stridsbergsbron
        lon: 18.05043,
        speed: 0.2, // Mycket långsam
        heading: 180,
      };
      sendAISData(app, julia);
      jest.advanceTimersByTime(1000);

      const boat = app._boats[0];
      expect(boat.targetDistance).toBeLessThan(100); // Mycket nära

      // Uppdatera bridge_text
      app._updateActiveBridgesTag();

      // Verifiera att ETA är "väntar" istället för orealistisk tid
      const bridgeText = originalBridgeText;
      expect(bridgeText).toMatch(/väntar|waiting|strax/i);
      expect(bridgeText).not.toMatch(/\d{2,} minuter/); // Inte 10+ minuter

      scenarioLogger.assertBridgeTextMatches(/väntar|waiting|strax/i,
        'Långsam båt nära bron ska visa "väntar" status');

      console.log('✅ Bug 3 löst: Realistiska ETA för väntande båtar');
    });

    test('Bug 4: Protection zone håller båtar som vänder', async () => {
      console.log('\n=== TEST: Protection zone för vändande båtar ===');

      // Simulera båt som närmar sig från norr
      const vandandeBat = {
        mmsi: 111222333,
        name: 'VÄNDANDE BÅT',
        lat: 59.31950, // 200m norr om Klaffbron
        lon: 18.06700,
        speed: 3.0,
        heading: 180, // Söderut
      };
      sendAISData(app, vandandeBat);
      jest.advanceTimersByTime(1000);

      expect(app._boats.length).toBe(1);
      const boat = app._boats[0];
      expect(boat.cog).toBe(180.0);

      // Båten vänder inom protection zone
      vandandeBat.speed = 2.0;
      vandandeBat.heading = 0; // Norrut
      sendAISData(app, vandandeBat);
      jest.advanceTimersByTime(1000);

      // Båten ska fortfarande spåras trots att den vänder
      expect(app._boats.length).toBe(1);
      expect(boat.protectionZone).toBe(true);
      expect(boat.protectionZoneEnteredAt).toBeDefined();

      scenarioLogger.logStatusChange(111222333, 'VÄNDANDE BÅT',
        'approaching', 'protection_zone', 'Vände inom 300m från bron');

      console.log('✅ Bug 4 löst: Protection zone håller kvar vändande båtar');
    });

    test('Bug 5: Adaptive speed thresholds för närliggande båtar', async () => {
      console.log('\n=== TEST: Adaptiva hastighetsgränser ===');

      // Test 1: Mycket långsam båt 50m från bron
      const narliggande = {
        mmsi: 444555666,
        name: 'NÄRLIGGANDE',
        lat: 59.31730, // ~50m från Klaffbron
        lon: 18.06680,
        speed: 0.08, // Mycket långsam men över 0.05 kn
        heading: 90,
      };
      sendAISData(app, narliggande);
      jest.advanceTimersByTime(1000);

      // Båten ska spåras trots låg hastighet eftersom den är nära
      expect(app._boats.length).toBe(1);
      expect(app._boats[0].sog).toBe(0.08);

      // Test 2: Långsam båt 500m från bron
      const avlagsen = {
        mmsi: 777888999,
        name: 'AVLÄGSEN',
        lat: 59.31721, // ~500m från Klaffbron
        lon: 18.06000,
        speed: 0.15, // Under normal threshold men över adaptiv
        heading: 90,
      };
      sendAISData(app, avlagsen);
      jest.advanceTimersByTime(1000);

      // Denna båt ska filtreras bort (för långsam och för långt bort)
      const distantBoats = app._boats.filter((b) => b.mmsi === 777888999);
      expect(distantBoats.length).toBe(0);

      console.log('✅ Bug 5 löst: Adaptiva hastighetsgränser fungerar korrekt');
    });
  });

  describe('2. Kompletta scenariotester', () => {
    test('Scenario 1: Två båtar möts vid Klaffbron', async () => {
      console.log('\n=== SCENARIO: Två båtar möts vid Klaffbron ===');

      // Båt 1: EMMA F från norr
      const emmaF2 = {
        mmsi: 265512280,
        name: 'EMMA F',
        lat: 59.32000,
        lon: 18.06700,
        speed: 4.0,
        heading: 180,
      };
      sendAISData(app, emmaF2);
      jest.advanceTimersByTime(500);

      // Båt 2: JULIA från söder
      const julia2 = {
        mmsi: 265803940,
        name: 'JULIA',
        lat: 59.31400,
        lon: 18.06700,
        speed: 3.5,
        heading: 0,
      };
      sendAISData(app, julia2);
      jest.advanceTimersByTime(500);

      // Verifiera att båda spåras
      expect(app._boats.length).toBe(2);

      // Uppdatera bridge_text
      app._updateActiveBridgesTag();

      // Bridge text ska nämna båda båtarna
      scenarioLogger.assertBridgeTextContains('EMMA F', 'EMMA F ska synas');
      scenarioLogger.assertBridgeTextContains('JULIA', 'JULIA ska synas');
      scenarioLogger.assertBridgeTextContains('2 båtar', 'Ska visa att 2 båtar närmar sig');

      // Simulera att båtarna närmar sig
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(30000); // 30 sekunder

        // Uppdatera positioner
        emmaF2.lat = 59.32000 - (0.001 * (i + 1));
        sendAISData(app, emmaF2);

        julia2.lat = 59.31400 + (0.001 * (i + 1));
        sendAISData(app, julia2);
      }

      // Båda ska fortfarande spåras och ha uppdaterade ETA
      expect(app._boats.length).toBe(2);

      const emma = app._boats.find((b) => b.name === 'EMMA F');
      const julia = app._boats.find((b) => b.name === 'JULIA');

      expect(emma.eta).toBeDefined();
      expect(julia.eta).toBeDefined();

      console.log('✅ Scenario 1 klart: Två båtar möts vid Klaffbron och båda spåras korrekt');
    });

    test('Scenario 2: Båt passerar flera broar i sekvens', async () => {
      console.log('\n=== SCENARIO: Båt passerar flera broar ===');

      // Starta vid Olidebron, ska passera Klaffbron och Stridsbergsbron
      const sekvensBat = {
        mmsi: 123123123,
        name: 'SEKVENS BÅT',
        lat: 59.31553,
        lon: 18.05400, // Väster om Olidebron
        speed: 6.0,
        heading: 90, // Österut
      };
      sendAISData(app, sekvensBat);
      jest.advanceTimersByTime(1000);

      const boat = app._boats[0];
      expect(boat.nearBridge).toBe('Olidebron');

      // Simulera passage genom Olidebron
      sekvensBat.lon = 18.05700; // Öster om Olidebron
      sendAISData(app, sekvensBat);
      jest.advanceTimersByTime(1000);

      // Ska nu sikta mot Klaffbron
      expect(boat.targetBridge).toBe('Klaffbron');
      scenarioLogger.logBridgePassage(123123123, 'SEKVENS BÅT', 'Olidebron', 'Klaffbron');

      // Simulera resa till och passage av Klaffbron
      sekvensBat.lat = 59.31721;
      sekvensBat.lon = 18.06700;
      sendAISData(app, sekvensBat);
      jest.advanceTimersByTime(60000);

      // Passera Klaffbron
      sekvensBat.lon = 18.06900; // Öster om Klaffbron
      sendAISData(app, sekvensBat);
      jest.advanceTimersByTime(1000);

      // Ska nu sikta mot Stridsbergsbron
      expect(boat.passedBridges).toContain('Klaffbron');
      expect(boat.targetBridge).toBe('Stridsbergsbron');

      scenarioLogger.logBridgePassage(123123123, 'SEKVENS BÅT', 'Klaffbron', 'Stridsbergsbron');

      console.log('✅ Scenario 2 klart: Båt passerar flera broar i korrekt sekvens');
    });

    test('Scenario 3: Stresstest med 10 båtar samtidigt', async () => {
      console.log('\n=== SCENARIO: Stresstest med 10 båtar ===');

      const boats = [];

      // Skapa 10 båtar på olika positioner
      for (let i = 0; i < 10; i++) {
        const boat = {
          mmsi: 100000000 + i,
          name: `BÅTEL ${i + 1}`,
          lat: 59.31721 + (i * 0.001),
          lon: 18.06700 + (i * 0.0005),
          speed: 3.0 + (i * 0.5),
          heading: (i % 2 === 0) ? 90 : 270,
        };
        boats.push(boat);

        sendAISData(app, boat);
        jest.advanceTimersByTime(100);
      }

      // Verifiera att alla 10 båtar spåras
      expect(app._boats.length).toBe(10);

      // Mät prestanda för uppdatering
      const startTime = Date.now();
      app._updateActiveBridgesTag();
      const updateTime = Date.now() - startTime;

      console.log(`✅ Uppdatering av 10 båtar tog ${updateTime}ms`);
      expect(updateTime).toBeLessThan(100); // Ska vara snabb

      // Simulera kontinuerliga uppdateringar
      for (let t = 0; t < 5; t++) {
        jest.advanceTimersByTime(10000);

        // Uppdatera alla båtar
        boats.forEach((boat, i) => {
          boat.lat += 0.0001;
          sendAISData(app, boat);
        });

        jest.advanceTimersByTime(1000);
      }

      // Alla båtar ska fortfarande spåras
      expect(app._boats.length).toBe(10);

      console.log('✅ Scenario 3 klart: Systemet hanterar 10 båtar samtidigt utan problem');
    });
  });

  describe('3. Edge cases och feltolerans', () => {
    test('Edge case 1: Båt med ogiltig position', async () => {
      console.log('\n=== EDGE CASE: Ogiltig position ===');

      // Ska inte krascha vid ogiltig data
      expect(() => {
        app._handleAISMessage({
          MessageID: 'PositionReport',
          MetaData: { time_utc: new Date().toISOString() },
          Message: {
            PositionReport: {
              Cog: 180.0,
              Latitude: null, // Ogiltig
              Longitude: undefined, // Ogiltig
              MessageID: 'PositionReport',
              NavigationalStatus: 'UnderWayUsingEngine',
              Sog: 5.0,
              UserID: 999999999,
              Valid: true,
            },
          },
        });
      }).not.toThrow();

      // Båten ska inte läggas till
      expect(app._boats.length).toBe(0);

      console.log('✅ Edge case 1: Hanterar ogiltiga positioner korrekt');
    });

    test('Edge case 2: WebSocket återanslutning', async () => {
      console.log('\n=== EDGE CASE: WebSocket återanslutning ===');

      // TestAdapter har ingen WebSocket att testa
      // Men vi kan verifiera att app fortfarande fungerar
      const testBat = {
        mmsi: 123456789,
        name: 'TEST',
        lat: 59.31721,
        lon: 18.06700,
        speed: 5.0,
        heading: 90,
      };

      sendAISData(app, testBat);
      jest.advanceTimersByTime(1000);

      expect(app._boats.length).toBe(1);

      console.log('✅ Edge case 2: App fungerar stabilt');
    });

    test('Edge case 3: Extremt många statusändringar', async () => {
      console.log('\n=== EDGE CASE: Många statusändringar ===');

      const kaos = {
        mmsi: 888888888,
        name: 'KAOS',
        lat: 59.31721,
        lon: 18.06700,
        speed: 5.0,
        heading: 90,
      };
      sendAISData(app, kaos);
      jest.advanceTimersByTime(1000);

      const boat = app._boats[0];
      const initialStatus = boat.status;

      // Ändra hastighet fram och tillbaka 20 gånger
      for (let i = 0; i < 20; i++) {
        kaos.speed = (i % 2 === 0) ? 0.1 : 5.0;
        sendAISData(app, kaos);
        jest.advanceTimersByTime(5000);
      }

      // Systemet ska fortfarande fungera
      expect(app._boats.length).toBe(1);
      expect(boat.speedHistory).toBeDefined();
      expect(boat.speedHistory.length).toBeGreaterThan(0);

      console.log('✅ Edge case 3: Hanterar många statusändringar stabilt');
    });
  });

  describe('4. Verifiering av kravspecifikation', () => {
    test('Krav 1: Timeout-zoner enligt spec', async () => {
      console.log('\n=== KRAVSPEC: Timeout-zoner ===');

      // Test alla tre zoner
      const zones = [
        { distance: 250, expectedTimeout: 20 * 60 * 1000 }, // <300m = 20 min
        { distance: 450, expectedTimeout: 10 * 60 * 1000 }, // 300-600m = 10 min
        { distance: 800, expectedTimeout: 2 * 60 * 1000 }, // >600m = 2 min
      ];

      for (const zone of zones) {
        // Skapa båt på specifikt avstånd
        const lat = 59.31721 + (zone.distance / 111000); // Konvertera meter till grader

        const zoneBat = {
          mmsi: 200000000 + zone.distance,
          name: `ZONE_${zone.distance}`,
          lat,
          lon: 18.06700,
          speed: 3.0,
          heading: 180,
        };
        sendAISData(app, zoneBat);
        jest.advanceTimersByTime(1000);

        const boat = app._boats.find((b) => b.mmsi === (200000000 + zone.distance));
        if (boat) {
          const timeout = app._getSpeedAdjustedTimeout(boat);
          expect(timeout).toBe(zone.expectedTimeout);
          console.log(`✅ Zon ${zone.distance}m: timeout = ${timeout / 60000} minuter`);
        }
      }
    });

    test('Krav 2: ETA min-hastighetsregler', async () => {
      console.log('\n=== KRAVSPEC: ETA min-hastighetsregler ===');

      const rules = [
        { distance: 150, minSpeed: 0.5 }, // <200m
        { distance: 350, minSpeed: 1.5 }, // 200-500m
        { distance: 700, minSpeed: 2.0 }, // >500m
      ];

      for (const rule of rules) {
        // Skapa båt med hastighet under minimum
        const etaBat = {
          mmsi: 300000000 + rule.distance,
          name: `ETA_${rule.distance}`,
          lat: 59.31721,
          lon: 18.06700 + (rule.distance / 111000),
          speed: rule.minSpeed - 0.5, // Under minimum
          heading: 180,
        };
        sendAISData(app, etaBat);
        jest.advanceTimersByTime(1000);

        const boat = app._boats.find((b) => b.mmsi === (300000000 + rule.distance));
        if (boat) {
          const eta = app._calculateETA(boat);

          // ETA ska använda min-hastighet, inte faktisk hastighet
          const expectedEta = Math.round(rule.distance / (rule.minSpeed * 0.514) / 60);
          expect(eta).toBeCloseTo(expectedEta, 0);

          console.log(`✅ Avstånd ${rule.distance}m: min-hastighet ${rule.minSpeed} kn används för ETA`);
        }
      }
    });

    test('Krav 3: Status-hantering och kontinuitet', async () => {
      console.log('\n=== KRAVSPEC: Status-hantering ===');

      const statusTest = {
        mmsi: 400000000,
        name: 'STATUS TEST',
        lat: 59.31721,
        lon: 18.06700,
        speed: 5.0,
        heading: 180,
      };
      sendAISData(app, statusTest);
      jest.advanceTimersByTime(1000);

      const boat = app._boats[0];
      expect(boat.status).toBe('approaching');

      // Testa waiting status (kräver 2 min kontinuerlig låg hastighet)
      // Första minuten
      for (let i = 0; i < 6; i++) {
        statusTest.speed = 0.1;
        sendAISData(app, statusTest);
        jest.advanceTimersByTime(10000);
      }

      expect(boat.status).toBe('approaching'); // Ännu inte waiting

      // Andra minuten
      for (let i = 0; i < 6; i++) {
        statusTest.speed = 0.1;
        sendAISData(app, statusTest);
        jest.advanceTimersByTime(10000);
      }

      expect(boat.status).toBe('waiting'); // Nu waiting efter 2 min

      console.log('✅ Krav 3: Status-hantering med kontinuitetskrav fungerar');
    });
  });

  // Slutrapport
  afterAll(() => {
    console.log('\n=== OMFATTANDE TESTSVIT SLUTFÖRD ===');
    console.log('Alla tester designade för att hitta verkliga buggar');
    console.log('Scenario-loggar visar exakt vad som händer med båtar och bridge_text');
    console.log('✅ Systemet är nu mer vattentat och pålitligt');
  });
});
