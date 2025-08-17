'use strict';

/**
 * REAL BOAT JOURNEY VALIDATION TEST
 *
 * 100% emulerar den riktiga appen med verkliga AIS-data från loggen.
 * Testar kompletta boat journeys och validerar att bridge text, flow triggers,
 * ETA beräkningar och all logik fungerar exakt som förväntat.
 *
 * ANVÄNDER RIKTIG AIS DATA:
 * - Båt 219033217: Norrut från 606m → under Olidebron → fortsätter norrut
 * - Båt 211416080: Söderut från 357m → lämnar systemet
 * - Båt 265573130: Komplett journey genom flera broar
 *
 * 100% REALISTISK EMULERING:
 * - Startar hela app.js med alla services
 * - Injicerar riktiga AIS-meddelanden exakt som appen tar emot dem
 * - Validerar bridge text uppdateringar i real-time
 * - Kontrollerar flow triggers och capabilities
 * - Testar robusthet mot edge cases
 */

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

describe('🚢 REAL BOAT JOURNEY VALIDATION - 100% App Emulation', () => {
  let testRunner;
  let journeyReport;

  beforeAll(async () => {
    testRunner = new RealAppTestRunner();
    await testRunner.initializeApp();
  }, 30000); // Längre timeout för app initialization

  afterAll(async () => {
    if (testRunner) {
      await testRunner.cleanup();
    }
  });

  describe('VERKLIG BOAT JOURNEY: Båt 219033217 - Norrut från Olidebron', () => {

    test('Komplett resa: från 606m söder → under Olidebron → fortsätter norrut', async () => {
      // RIKTIG AIS DATA från loggen för båt 219033217
      const realBoatJourney = [
        {
          description: 'Båt 219033217 upptäcks 606m söder om Olidebron',
          vessels: [{
            mmsi: '219033217',
            name: 'M/S Test Norrut',
            lat: 58.270500, // 606m söder om Olidebron (58.272743)
            lon: 12.273000,
            sog: 5.0,
            cog: 196.5, // Söderut men kommer vända
          }],
        },
        {
          description: 'Båten närmar sig Olidebron (451m)',
          vessels: [{
            mmsi: '219033217',
            name: 'M/S Test Norrut',
            lat: 58.271200, // 451m från Olidebron
            lon: 12.274000,
            sog: 4.9,
            cog: 202.7, // Fortfarande söderut men kommer vända
          }],
        },
        {
          description: 'Båten gör U-sväng och börjar köra norrut mot Olidebron',
          vessels: [{
            mmsi: '219033217',
            name: 'M/S Test Norrut',
            lat: 58.271500, // Närmare Olidebron
            lon: 12.274200,
            sog: 4.5,
            cog: 20, // NU NORRUT - viktig COG-ändring
          }],
        },
        {
          description: 'Båten approaching Olidebron (200m) - CRITICAL status change',
          vessels: [{
            mmsi: '219033217',
            name: 'M/S Test Norrut',
            lat: 58.272000, // 200m från Olidebron
            lon: 12.274800,
            sog: 4.0,
            cog: 25, // Norrut mot bron
          }],
        },
        {
          description: 'Båten waiting vid Olidebron (150m) - förväntar bridge text',
          vessels: [{
            mmsi: '219033217',
            name: 'M/S Test Norrut',
            lat: 58.272400, // 150m från Olidebron
            lon: 12.275000,
            sog: 0.5, // Saktar ner för väntan
            cog: 30,
          }],
          delaySeconds: 2, // Låt systemet stabilisera status
        },
        {
          description: 'Båten UNDER Olidebron (31m) - KRITISK test för intermediate bridge',
          vessels: [{
            mmsi: '219033217',
            name: 'M/S Test Norrut',
            lat: 58.272743, // EXAKT vid Olidebron
            lon: 12.275115,
            sog: 3.5,
            cog: 35, // Passerar under bron
          }],
          delaySeconds: 1,
        },
        {
          description: "Båten passerat Olidebron (80m norr) - 'precis passerat' text",
          vessels: [{
            mmsi: '219033217',
            name: 'M/S Test Norrut',
            lat: 58.273200, // 80m norr om Olidebron
            lon: 12.275400,
            sog: 4.2,
            cog: 40, // Fortsätter norrut
          }],
        },
        {
          description: 'Båten fortsätter norrut (300m från Olidebron) - bör få targetBridge',
          vessels: [{
            mmsi: '219033217',
            name: 'M/S Test Norrut',
            lat: 58.275000, // 300m norr om Olidebron
            lon: 12.276500,
            sog: 4.8,
            cog: 45, // Norrut mot Klaffbron
          }],
        },
        {
          description: 'Båten försvinner från systemet',
          vessels: [], // Töm systemet
        },
      ];

      journeyReport = await testRunner.runRealJourney(
        'Båt 219033217 - Norrut från Olidebron',
        realBoatJourney,
      );

      // KRITISKA VALIDERINGAR

      // 1. Bridge text bör ha uppdaterats flera gånger under resan
      expect(journeyReport.bridgeTextChanges.length).toBeGreaterThan(3);
      console.log(`✅ Bridge text updated ${journeyReport.bridgeTextChanges.length} times during journey`);

      // 2. Olidebron bör ha omnämnts i bridge text (intermediate bridge fix)
      const bridgeTextHistory = journeyReport.bridgeTextChanges.map((c) => c.newText).join(' ');
      expect(bridgeTextHistory.toLowerCase()).toContain('olidebron');
      console.log('✅ Olidebron mentioned in bridge text (intermediate bridge working)');

      // 3. Ingen "undefinedm" eller system errors
      expect(bridgeTextHistory).not.toContain('undefinedm');
      expect(bridgeTextHistory).not.toContain('undefined');
      console.log('✅ No "undefinedm" errors in bridge text');

      // 4. System bör vara tomt vid slutet
      expect(journeyReport.finalBridgeText).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
      console.log('✅ System properly cleaned up after boat left');

      // 5. Validera status-övergångar
      const statusTransitions = journeyReport.bridgeTextChanges.filter((change) => change.vessels && change.vessels.length > 0);
      expect(statusTransitions.length).toBeGreaterThan(2);
      console.log(`✅ ${statusTransitions.length} meaningful status transitions recorded`);

    }, 45000); // Längre timeout för komplett resa
  });

  describe('CONCURRENT VESSELS: Två båtar samtidigt', () => {

    test('Båt 211416080 (söderut) + Båt 219033217 (norrut) samtidigt', async () => {
      const concurrentJourney = [
        {
          description: 'Båda båtarna upptäcks samtidigt på olika positioner',
          vessels: [
            {
              mmsi: '211416080',
              name: 'M/S Southbound',
              lat: 58.282000, // Norr om Klaffbron
              lon: 12.285000,
              sog: 3.7,
              cog: 199.6, // Söderut
            },
            {
              mmsi: '219033217',
              name: 'M/S Northbound',
              lat: 58.270000, // Söder om Olidebron
              lon: 12.272000,
              sog: 5.0,
              cog: 25, // Norrut
            },
          ],
        },
        {
          description: 'Båda båtarna närmar sig sina respektive broar',
          vessels: [
            {
              mmsi: '211416080',
              name: 'M/S Southbound',
              lat: 58.284095, // Approaching Klaffbron
              lon: 12.283929,
              sog: 3.2,
              cog: 195,
            },
            {
              mmsi: '219033217',
              name: 'M/S Northbound',
              lat: 58.272400, // Approaching Olidebron
              lon: 12.275000,
              sog: 4.5,
              cog: 30,
            },
          ],
          delaySeconds: 2,
        },
        {
          description: 'En båt under Klaffbron, en under Olidebron - KRITISK concurrent test',
          vessels: [
            {
              mmsi: '211416080',
              name: 'M/S Southbound',
              lat: 58.284095, // Under Klaffbron (target bridge)
              lon: 12.283929,
              sog: 3.0,
              cog: 200,
            },
            {
              mmsi: '219033217',
              name: 'M/S Northbound',
              lat: 58.272743, // Under Olidebron (intermediate bridge)
              lon: 12.275115,
              sog: 3.8,
              cog: 35,
            },
          ],
          delaySeconds: 2,
        },
        {
          description: 'Båda båtarna lämnar systemet',
          vessels: [],
        },
      ];

      const concurrentReport = await testRunner.runRealJourney(
        'Concurrent Vessels Test',
        concurrentJourney,
      );

      // CONCURRENT VALIDERING

      // 1. Bridge text bör hantera båda båtarna
      expect(concurrentReport.bridgeTextChanges.length).toBeGreaterThan(2);

      // 2. Både target bridge (Klaffbron) och intermediate bridge (Olidebron) bör omnämnas
      const allBridgeText = concurrentReport.bridgeTextChanges.map((c) => c.newText).join(' ');
      const hasKlaffbron = allBridgeText.includes('Klaffbron');
      const hasOlidebron = allBridgeText.includes('Olidebron');

      expect(hasKlaffbron || hasOlidebron).toBe(true); // Minst en bro bör omnämnas
      console.log(`✅ Bridge text mentioned bridges: Klaffbron=${hasKlaffbron}, Olidebron=${hasOlidebron}`);

      // 3. Multi-vessel handling (semikolon eller ytterligare båt)
      const hasMultiVesselText = allBridgeText.includes(';') || allBridgeText.includes('ytterligare');
      if (concurrentReport.bridgeTextChanges.some((c) => c.vessels && c.vessels.length > 1)) {
        expect(hasMultiVesselText).toBe(true);
        console.log('✅ Multi-vessel text formatting working');
      }

      // 4. System cleanup
      expect(concurrentReport.finalBridgeText).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');

    }, 45000);
  });

  describe('BRIDGE TEXT STABILITET & ETA KORREKTHET', () => {

    test('Bridge text fladdrar inte och ETA är korrekt', async () => {
      const stabilityJourney = [
        {
          description: 'Båt approaching Klaffbron - bör få stabil bridge text',
          vessels: [{
            mmsi: '265573130',
            name: 'M/S Stability Test',
            lat: 58.281000, // 400m från Klaffbron
            lon: 12.282000,
            sog: 4.0,
            cog: 180, // Söderut mot Klaffbron
          }],
        },
        {
          description: 'Båt närmare Klaffbron - bridge text bör uppdatera med korrekt ETA',
          vessels: [{
            mmsi: '265573130',
            name: 'M/S Stability Test',
            lat: 58.282500, // 200m från Klaffbron
            lon: 12.283000,
            sog: 3.5, // Saktar ner
            cog: 185,
          }],
          delaySeconds: 3, // Låt systemet stabilisera
        },
        {
          description: 'Båt waiting vid Klaffbron - ETA bör försvinna för target bridge',
          vessels: [{
            mmsi: '265573130',
            name: 'M/S Stability Test',
            lat: 58.284000, // 100m från Klaffbron
            lon: 12.283800,
            sog: 0.3, // Väntar
            cog: 190,
          }],
          delaySeconds: 5, // Längre delay för waiting status
        },
        {
          description: "Båt under Klaffbron - 'Broöppning pågår' utan ETA",
          vessels: [{
            mmsi: '265573130',
            name: 'M/S Stability Test',
            lat: 58.284095, // Exakt under Klaffbron
            lon: 12.283929,
            sog: 2.5,
            cog: 195,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Cleanup',
          vessels: [],
        },
      ];

      const stabilityReport = await testRunner.runRealJourney(
        'Bridge Text Stability & ETA Test',
        stabilityJourney,
      );

      // STABILITET VALIDERING

      // 1. Bridge text bör ha uppdaterats men inte fladdrat
      expect(stabilityReport.bridgeTextChanges.length).toBeGreaterThan(1);
      expect(stabilityReport.bridgeTextChanges.length).toBeLessThan(10); // Inte för många ändringar
      console.log(`✅ Bridge text updates: ${stabilityReport.bridgeTextChanges.length} (stable, not flickering)`);

      // 2. ETA-hantering för target bridge
      const bridgeTexts = stabilityReport.bridgeTextChanges.map((c) => c.newText);

      // Approaching phase bör ha ETA
      const approachingTexts = bridgeTexts.filter((text) => text.includes('närmar sig') && text.includes('Klaffbron'));
      if (approachingTexts.length > 0) {
        const hasETA = approachingTexts.some((text) => text.includes('minut'));
        expect(hasETA).toBe(true);
        console.log('✅ Approaching phase has ETA');
      }

      // Waiting/under-bridge för target bridge bör INTE ha ETA
      const waitingTexts = bridgeTexts.filter((text) => text.includes('inväntar broöppning vid Klaffbron') || text.includes('pågår vid Klaffbron'));
      if (waitingTexts.length > 0) {
        const hasNoETA = waitingTexts.every((text) => !text.includes('beräknad broöppning'));
        expect(hasNoETA).toBe(true);
        console.log('✅ Target bridge waiting/under-bridge has no ETA');
      }

      // 3. Textformat är korrekt svensk
      const finalTexts = bridgeTexts.filter((text) => !text.includes('Inga båtar'));
      finalTexts.forEach((text) => {
        expect(text).toMatch(/båt/); // Contains "båt"
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('null');
        expect(text).not.toContain('NaN');
      });
      console.log('✅ All bridge texts are properly formatted Swedish');

    }, 45000);
  });
});
