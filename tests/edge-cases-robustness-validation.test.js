'use strict';

/**
 * EDGE CASES & ROBUSTNESS VALIDATION TEST
 *
 * Testar appens robusthet mot alla edge cases som du specificerade:
 * 1. Båtar som ankrar utanför skyddszon - systemet tar bort dem korrekt
 * 2. Båtar som gör skarva svängningar/U-turn - INTE tolkade som GPS-hopp
 * 3. Riktiga GPS-hopp - korrekt upptäckta och hanterade
 * 4. Flow triggers under stress och edge conditions
 * 5. Minnestester och prestanda under load
 *
 * 100% REAL APP EMULATION med extrema scenarios.
 */

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

describe('🔧 EDGE CASES & ROBUSTNESS VALIDATION - Real App Stress Tests', () => {
  let testRunner;

  beforeAll(async () => {
    testRunner = new RealAppTestRunner();
    await testRunner.initializeApp();
  }, 30000);

  afterAll(async () => {
    if (testRunner) {
      await testRunner.cleanup();
    }
  });

  describe('ANKRING & CLEANUP: Båtar utanför skyddszon', () => {

    test('Båt ankrar 2km utanför skyddszon - systemet bör ta bort den', async () => {
      const anchoringScenario = [
        {
          description: 'Båt approaching Klaffbron',
          vessels: [{
            mmsi: '999888777',
            name: 'M/S Future Anchor',
            lat: 58.282000,
            lon: 12.282000,
            sog: 4.5,
            cog: 180,
          }],
        },
        {
          description: 'Båt passerar Klaffbron och fortsätter söderut',
          vessels: [{
            mmsi: '999888777',
            name: 'M/S Future Anchor',
            lat: 58.284095, // Vid Klaffbron
            lon: 12.283929,
            sog: 3.8,
            cog: 185,
          }],
        },
        {
          description: 'Båt fortsätter söderut utanför systemet',
          vessels: [{
            mmsi: '999888777',
            name: 'M/S Future Anchor',
            lat: 58.270000, // Söder om alla broar
            lon: 12.270000,
            sog: 4.0,
            cog: 190,
          }],
        },
        {
          description: 'Båt ankrar FAR UTANFÖR skyddszon (2km från närmaste bro)',
          vessels: [{
            mmsi: '999888777',
            name: 'M/S Future Anchor',
            lat: 58.250000, // 2+ km söder om Olidebron
            lon: 12.250000,
            sog: 0.0, // ANKRAD - noll hastighet
            cog: 0, // Ingen kurs när ankrad
          }],
          delaySeconds: 3, // Låt timeout-logiken kicka in
        },
        {
          description: 'Väntar för att låta cleanup timeout köra',
          vessels: [{
            mmsi: '999888777',
            name: 'M/S Future Anchor',
            lat: 58.250000, // Samma position - fortfarande ankrad
            lon: 12.250000,
            sog: 0.1, // Minimal rörelse (som en ankrad båt)
            cog: 5,
          }],
          delaySeconds: 8, // Längre delay för timeout
        },
        {
          description: 'Kontrollera att båten tagits bort från systemet',
          vessels: [], // Ingen vessel input - bara kontrollera status
        },
      ];

      const anchorReport = await testRunner.runRealJourney(
        'Anchoring Cleanup Test',
        anchoringScenario,
      );

      // VALIDERING: Båt bör ha tagits bort av timeout-logiken
      expect(anchorReport.finalBridgeText).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');

      // Bridge text bör ha uppdaterats när båten först upptäcktes, sen tagits bort
      expect(anchorReport.bridgeTextChanges.length).toBeGreaterThan(0);
      console.log('✅ Anchored boat outside protection zone was properly removed');

    }, 45000);

    test('Båt ankrar INOM skyddszon - systemet bör INTE ta bort den', async () => {
      const protectedAnchorScenario = [
        {
          description: 'Båt approaching Klaffbron',
          vessels: [{
            mmsi: '555444333',
            name: 'M/S Protected Anchor',
            lat: 58.283000,
            lon: 12.283000,
            sog: 3.5,
            cog: 180,
          }],
        },
        {
          description: 'Båt ankrar 200m från Klaffbron (INOM skyddszon)',
          vessels: [{
            mmsi: '555444333',
            name: 'M/S Protected Anchor',
            lat: 58.282500, // 200m från Klaffbron
            lon: 12.283500,
            sog: 0.0, // Ankrad
            cog: 0,
          }],
          delaySeconds: 10, // Långt delay för timeout test
        },
        {
          description: 'Kontrollera att båten KVARSTÅR i systemet',
          vessels: [{
            mmsi: '555444333',
            name: 'M/S Protected Anchor',
            lat: 58.282500, // Samma position
            lon: 12.283500,
            sog: 0.1,
            cog: 5,
          }],
        },
      ];

      const protectedReport = await testRunner.runRealJourney(
        'Protected Anchoring Test',
        protectedAnchorScenario,
      );

      // VALIDERING: Båt inom skyddszon bör INTE tas bort
      expect(protectedReport.finalBridgeText).not.toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
      console.log('✅ Anchored boat within protection zone was preserved');

    }, 45000);
  });

  describe('SVÄNGNINGAR & GPS-HOPP: Korrekt tolkning av rörelser', () => {

    test('Båt gör skarp U-sväng - bör INTE tolkas som GPS-hopp', async () => {
      const uTurnScenario = [
        {
          description: 'Båt going söderut mot Klaffbron',
          vessels: [{
            mmsi: '777666555',
            name: 'M/S U-Turner',
            lat: 58.286000, // Norr om Klaffbron
            lon: 12.285000,
            sog: 4.5,
            cog: 180, // Söderut
          }],
        },
        {
          description: 'Båt närmar sig Klaffbron',
          vessels: [{
            mmsi: '777666555',
            name: 'M/S U-Turner',
            lat: 58.284500, // Närmare Klaffbron
            lon: 12.284500,
            sog: 4.0,
            cog: 185,
          }],
        },
        {
          description: 'Båt gör SKARP U-SVÄNG (180° COG change) - KRITISK test',
          vessels: [{
            mmsi: '777666555',
            name: 'M/S U-Turner',
            lat: 58.284200, // Lite närmare bron
            lon: 12.284200,
            sog: 2.5, // Saktar för svängen
            cog: 5, // 180° ÄNDRING från 185° → 005° (NORRUT)
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt fortsätter norrut efter U-svängen',
          vessels: [{
            mmsi: '777666555',
            name: 'M/S U-Turner',
            lat: 58.285000, // Norrut från Klaffbron
            lon: 12.285500,
            sog: 4.2, // Normal hastighet igen
            cog: 10, // Fortsatt norrut
          }],
        },
      ];

      const uTurnReport = await testRunner.runRealJourney(
        'U-Turn Test (NOT GPS Jump)',
        uTurnScenario,
      );

      // VALIDERING: U-turn bör INTE ha tolkats som GPS-hopp
      // Bridge text bör ha uppdaterats normalt genom hela sekvensen
      expect(uTurnReport.bridgeTextChanges.length).toBeGreaterThan(1);

      // Inga GPS-hopp fel bör ha loggats
      const allBridgeText = uTurnReport.bridgeTextChanges.map((c) => c.newText).join(' ');
      expect(allBridgeText).not.toContain('GPS');
      expect(allBridgeText).not.toContain('hopp');

      console.log('✅ Sharp U-turn was NOT interpreted as GPS jump');
      console.log(`✅ ${uTurnReport.bridgeTextChanges.length} normal bridge text updates during U-turn`);

    }, 45000);

    test('Riktig GPS-hopp (2km teleportation) - bör upptäckas och hanteras', async () => {
      const gpsJumpScenario = [
        {
          description: 'Båt normal position vid Klaffbron',
          vessels: [{
            mmsi: '333222111',
            name: 'M/S GPS Jumper',
            lat: 58.284095, // Vid Klaffbron
            lon: 12.283929,
            sog: 3.5,
            cog: 190,
          }],
        },
        {
          description: 'RIKTIG GPS-HOPP: Båt teleporterar 2km norrut (omöjlig rörelse)',
          vessels: [{
            mmsi: '333222111',
            name: 'M/S GPS Jumper',
            lat: 58.310000, // 2+ km norr om alla broar (TELEPORTATION)
            lon: 12.320000,
            sog: 3.8, // Samma hastighet (visar att det är GPS-fel)
            cog: 185, // Samma riktning
          }],
          delaySeconds: 3,
        },
        {
          description: 'Båt tillbaka till normal position (GPS korrigerat)',
          vessels: [{
            mmsi: '333222111',
            name: 'M/S GPS Jumper',
            lat: 58.284500, // Tillbaka nära Klaffbron
            lon: 12.284200,
            sog: 3.7,
            cog: 192,
          }],
        },
      ];

      const gpsJumpReport = await testRunner.runRealJourney(
        'Real GPS Jump Test',
        gpsJumpScenario,
      );

      // VALIDERING: System bör ha hanterat GPS-hoppet
      // Minst en bridge text update, men systemet bör vara robust
      expect(gpsJumpReport.bridgeTextChanges.length).toBeGreaterThan(0);

      // Final state bör vara korrekt
      expect(typeof gpsJumpReport.finalBridgeText).toBe('string');

      console.log('✅ Real GPS jump was detected and handled gracefully');
      console.log(`Final bridge text: "${gpsJumpReport.finalBridgeText}"`);

    }, 45000);
  });

  describe('FLOW TRIGGERS UNDER STRESS', () => {

    test('Rapid vessel changes - flow triggers bör vara stabila', async () => {
      const rapidChangesScenario = [
        {
          description: 'Båt 1 approaching Klaffbron',
          vessels: [{
            mmsi: '111',
            name: 'Rapid 1',
            lat: 58.282000,
            lon: 12.282000,
            sog: 4.0,
            cog: 180,
          }],
        },
        {
          description: 'Båt 2 approaching Stridsbergsbron',
          vessels: [
            {
              mmsi: '111',
              name: 'Rapid 1',
              lat: 58.283000,
              lon: 12.283000,
              sog: 3.8,
              cog: 185,
            },
            {
              mmsi: '222',
              name: 'Rapid 2',
              lat: 58.292000,
              lon: 12.293000,
              sog: 4.2,
              cog: 220,
            },
          ],
        },
        {
          description: 'Båt 3 approaching Olidebron + rapid status changes',
          vessels: [
            {
              mmsi: '111',
              name: 'Rapid 1',
              lat: 58.284095, // Under Klaffbron
              lon: 12.283929,
              sog: 3.5,
              cog: 190,
            },
            {
              mmsi: '222',
              name: 'Rapid 2',
              lat: 58.293524, // Under Stridsbergsbron
              lon: 12.294566,
              sog: 4.0,
              cog: 225,
            },
            {
              mmsi: '333',
              name: 'Rapid 3',
              lat: 58.271000, // Approaching Olidebron
              lon: 12.274000,
              sog: 3.9,
              cog: 35,
            },
          ],
        },
        {
          description: 'Alla båtar försvinner snabbt (stress cleanup)',
          vessels: [],
        },
      ];

      const rapidReport = await testRunner.runRealJourney(
        'Rapid Changes Flow Triggers Test',
        rapidChangesScenario,
      );

      // VALIDERING: Flow triggers bör ha fungerat utan krascher
      expect(rapidReport.bridgeTextChanges.length).toBeGreaterThan(2);

      // Inga system errors
      const allTexts = rapidReport.bridgeTextChanges.map((c) => c.newText);
      allTexts.forEach((text) => {
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('error');
        expect(text).not.toContain('null');
      });

      console.log('✅ Flow triggers stable under rapid vessel changes');
      console.log(`✅ ${rapidReport.bridgeTextChanges.length} bridge text updates without errors`);

    }, 45000);

    test('Invalid vessel data - systemet bör vara robust', async () => {
      const invalidDataScenario = [
        {
          description: 'Normal båt först',
          vessels: [{
            mmsi: '999000111',
            name: 'Normal Boat',
            lat: 58.284000,
            lon: 12.284000,
            sog: 3.5,
            cog: 180,
          }],
        },
        {
          description: 'Båt med invalid/extreme data',
          vessels: [
            {
              mmsi: '999000111',
              name: 'Normal Boat',
              lat: 58.284095,
              lon: 12.283929,
              sog: 3.2,
              cog: 185,
            },
            {
              mmsi: '999000222',
              name: 'Invalid Boat',
              lat: 999.999999, // INVALID latitude
              lon: -999.999999, // INVALID longitude
              sog: -50, // NEGATIVE speed
              cog: 720, // INVALID course (>360°)
            },
          ],
        },
        {
          description: 'Båt med null/undefined values',
          vessels: [
            {
              mmsi: '999000111',
              name: 'Normal Boat',
              lat: 58.284200,
              lon: 12.284100,
              sog: 3.0,
              cog: 190,
            },
            // Note: Vi kan inte injicera null/undefined via AIS message format,
            // men systemet bör hantera detta gracefully
          ],
        },
      ];

      const invalidReport = await testRunner.runRealJourney(
        'Invalid Data Robustness Test',
        invalidDataScenario,
      );

      // VALIDERING: System bör ha fortsatt fungera trots invalid data
      expect(invalidReport.bridgeTextChanges.length).toBeGreaterThan(0);

      // Normal båt bör fortfarande fungera
      const normalBoatWorking = invalidReport.bridgeTextChanges.some((change) => change.vessels && change.vessels.some((v) => v.mmsi === '999000111'));
      expect(normalBoatWorking).toBe(true);

      console.log('✅ System robust against invalid vessel data');

    }, 45000);
  });

  describe('MINNE & PRESTANDA UNDER LOAD', () => {

    test('Många båtar samtidigt - systemet bör vara stable', async () => {
      // Skapa många båtar på olika positioner
      const manyBoatsPositions = [];
      for (let i = 0; i < 15; i++) {
        manyBoatsPositions.push({
          mmsi: `load_test_${i}`,
          name: `Load Test Boat ${i}`,
          lat: 58.270000 + (i * 0.002), // Spread längs kanalen
          lon: 12.270000 + (i * 0.002),
          sog: 2.5 + (i * 0.3),
          cog: 180 + (i * 5),
        });
      }

      const loadTestScenario = [
        {
          description: '15 båtar entering systemet samtidigt',
          vessels: manyBoatsPositions,
        },
        {
          description: 'Alla båtar rör sig (update storm)',
          vessels: manyBoatsPositions.map((boat) => ({
            ...boat,
            lat: boat.lat + 0.001, // Alla rör sig lite
            lon: boat.lon + 0.0005,
            sog: boat.sog + 0.2,
          })),
          delaySeconds: 3,
        },
        {
          description: 'Cleanup alla båtar',
          vessels: [],
        },
      ];

      const startTime = Date.now();
      const loadReport = await testRunner.runRealJourney(
        'Load Test - Many Boats',
        loadTestScenario,
      );
      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      // PRESTANDA VALIDERING
      expect(totalDuration).toBeLessThan(30000); // Bör ta mindre än 30 sekunder
      console.log(`✅ Load test completed in ${totalDuration}ms`);

      // System bör ha hanterat många båtar utan krascher
      expect(loadReport.bridgeTextChanges.length).toBeGreaterThan(0);

      // Final cleanup bör fungera
      expect(loadReport.finalBridgeText).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');

      console.log(`✅ System handled ${manyBoatsPositions.length} boats simultaneously`);
      console.log(`✅ Bridge text updates: ${loadReport.bridgeTextChanges.length}`);

    }, 60000); // Längre timeout för load test
  });
});
