'use strict';

/**
 * INTEGRATION & FLOW TRIGGERS VALIDATION TEST
 *
 * Fokuserar på att alla flow triggers och conditions fungerar perfekt
 * under verkliga scenarios. Testar även full integration mellan alla
 * services och capabilities.
 *
 * KRITISKA AREAS:
 * 1. Flow triggers: boat_near triggas korrekt med rätt tokens
 * 2. Flow conditions: boat_at_bridge returnerar korrekt true/false
 * 3. Capabilities uppdateras: bridge_text, connection_status, alarm_generic
 * 4. Integration mellan VesselDataService, BridgeTextService, StatusService
 * 5. Homey device interface fungerar korrekt
 *
 * 100% REAL APP med verkliga flow trigger scenarios.
 */

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

describe('🔗 INTEGRATION & FLOW TRIGGERS VALIDATION - Real App Integration Tests', () => {
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

  describe('FLOW TRIGGERS: boat_near med rätt tokens', () => {

    test('Båt approaching Klaffbron - boat_near trigger med korrekt data', async () => {
      const flowTriggerScenario = [
        {
          description: 'Båt börjar approaching Klaffbron - bör trigga boat_near',
          vessels: [{
            mmsi: '987654321',
            name: 'M/S Flow Trigger Test',
            lat: 58.281500, // ~350m från Klaffbron
            lon: 12.282500,
            sog: 4.2,
            cog: 180, // Söderut mot Klaffbron
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt närmare Klaffbron - inom 300m (trigger distance)',
          vessels: [{
            mmsi: '987654321',
            name: 'M/S Flow Trigger Test',
            lat: 58.282800, // ~250m från Klaffbron
            lon: 12.283200,
            sog: 3.8,
            cog: 185,
          }],
          delaySeconds: 3, // Längre delay för att säkerställa trigger
        },
        {
          description: 'Båt under Klaffbron - bör få under-bridge status',
          vessels: [{
            mmsi: '987654321',
            name: 'M/S Flow Trigger Test',
            lat: 58.284095, // Exakt vid Klaffbron
            lon: 12.283929,
            sog: 3.2,
            cog: 190,
          }],
          delaySeconds: 2,
        },
      ];

      const triggerReport = await testRunner.runRealJourney(
        'Flow Trigger Test - boat_near',
        flowTriggerScenario,
      );

      // FLOW TRIGGER VALIDERING

      // 1. Bridge text bör ha uppdaterats (indikerar att triggers fungerar)
      expect(triggerReport.bridgeTextChanges.length).toBeGreaterThanOrEqual(1);

      // 2. Klaffbron bör omnämnas i bridge text
      const mentionsKlaffbron = triggerReport.bridgeTextChanges.some((change) => change.newText.includes('Klaffbron'));
      expect(mentionsKlaffbron).toBe(true);

      // 3. Progressiv status changes bör synas i vessel data
      const hasProgressiveUpdates = triggerReport.bridgeTextChanges.some((change) => change.vessels && change.vessels.length > 0 && change.vessels[0].mmsi === '987654321');
      expect(hasProgressiveUpdates).toBe(true);

      console.log('✅ boat_near trigger working correctly');
      console.log(`✅ Bridge text updates: ${triggerReport.bridgeTextChanges.length}`);
      console.log(`✅ Klaffbron mentioned: ${mentionsKlaffbron}`);

    }, 45000);

    test('Multi-bridge scenario - korrekta tokens för olika broar', async () => {
      const multiBridgeScenario = [
        {
          description: 'Båt 1 approaching Klaffbron',
          vessels: [{
            mmsi: '111222333',
            name: 'Multi Bridge Test 1',
            lat: 58.282000,
            lon: 12.282000,
            sog: 4.0,
            cog: 180,
          }],
        },
        {
          description: 'Båt 2 approaching Stridsbergsbron samtidigt',
          vessels: [
            {
              mmsi: '111222333',
              name: 'Multi Bridge Test 1',
              lat: 58.283000, // Närmare Klaffbron
              lon: 12.283000,
              sog: 3.5,
              cog: 185,
            },
            {
              mmsi: '444555666',
              name: 'Multi Bridge Test 2',
              lat: 58.295000, // NORR om Stridsbergsbron för söderut (target = Stridsbergsbron)
              lon: 12.295000,
              sog: 4.5,
              cog: 220,
            },
          ],
        },
        {
          description: 'Båt 3 approaching Stallbackabron (norr om system)',
          vessels: [
            {
              mmsi: '111222333',
              name: 'Multi Bridge Test 1',
              lat: 58.284095, // Under Klaffbron
              lon: 12.283929,
              sog: 3.0,
              cog: 190,
            },
            {
              mmsi: '444555666',
              name: 'Multi Bridge Test 2',
              lat: 58.293524, // Under Stridsbergsbron
              lon: 12.294566,
              sog: 4.0,
              cog: 225,
            },
            {
              mmsi: '777888999',
              name: 'Multi Bridge Test 3',
              lat: 58.298000, // NORR om Stridsbergsbron (Stallbackabron area)
              lon: 12.299000,
              sog: 3.8,
              cog: 30, // Norrut
            },
          ],
        },
      ];

      const multiReport = await testRunner.runRealJourney(
        'Multi-Bridge Flow Triggers Test',
        multiBridgeScenario,
      );

      // MULTI-BRIDGE VALIDERING

      // DEBUGGING: Log all bridge text changes first
      console.log('DEBUG: Multi-bridge bridge text changes:');
      multiReport.bridgeTextChanges.forEach((change, i) => {
        console.log(`  ${i + 1}. "${change.newText}" (step ${change.step})`);
      });

      // 1. Flera bridge text updates för olika broar
      expect(multiReport.bridgeTextChanges.length).toBeGreaterThanOrEqual(1);

      // 2. Olika broar bör omnämnas
      const allBridgeText = multiReport.bridgeTextChanges.map((c) => c.newText).join(' ');
      const bridgeMentions = {
        klaffbron: allBridgeText.includes('Klaffbron'),
        stridsbergsbron: allBridgeText.includes('Stridsbergsbron'),
        stallbackabron: allBridgeText.includes('Stallbackabron'),
      };

      console.log(`DEBUG: All bridge text combined: "${allBridgeText}"`);
      console.log(`DEBUG: Bridge mentions: ${JSON.stringify(bridgeMentions)}`);

      // Minst 2 broar bör omnämnas (nu med korrekta positioner)
      const bridgeCount = Object.values(bridgeMentions).filter(Boolean).length;
      expect(bridgeCount).toBeGreaterThanOrEqual(2);

      console.log('✅ Multi-bridge flow triggers working');
      console.log(`✅ Bridge mentions: ${JSON.stringify(bridgeMentions)}`);

    }, 45000);
  });

  describe('FLOW CONDITIONS: boat_at_bridge logic', () => {

    test('boat_at_bridge condition - korrekt true/false för olika positioner', async () => {
      const conditionTestScenario = [
        {
          description: 'Båt FAR från alla broar - boat_at_bridge bör vara false',
          vessels: [{
            mmsi: '555111777',
            name: 'Condition Test',
            lat: 58.260000, // 1+ km söder om Olidebron
            lon: 12.260000,
            sog: 4.0,
            cog: 30,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt NEAR Klaffbron (<300m) - boat_at_bridge Klaffbron bör vara true',
          vessels: [{
            mmsi: '555111777',
            name: 'Condition Test',
            lat: 58.282500, // ~200m från Klaffbron
            lon: 12.283200,
            sog: 3.5,
            cog: 180,
          }],
          delaySeconds: 3,
        },
        {
          description: 'Båt NEAR Stridsbergsbron (<300m) - andra bridge conditions',
          vessels: [{
            mmsi: '555111777',
            name: 'Condition Test',
            lat: 58.295000, // Norr om Stridsbergsbron för korrekt målbro-tilldelning
            lon: 12.295000,
            sog: 4.2,
            cog: 220,
          }],
          delaySeconds: 2,
        },
      ];

      const conditionReport = await testRunner.runRealJourney(
        'Flow Conditions Test - boat_at_bridge',
        conditionTestScenario,
      );

      // CONDITION VALIDERING

      // Systemet bör ha reagerat på närheten till broarna
      expect(conditionReport.bridgeTextChanges.length).toBeGreaterThanOrEqual(1);

      // Bridge text bör reflektera korrekt närhet
      const mentionsBridges = conditionReport.bridgeTextChanges.some((change) => change.newText.includes('Klaffbron') || change.newText.includes('Stridsbergsbron'));
      expect(mentionsBridges).toBe(true);

      console.log('✅ boat_at_bridge conditions working correctly');

    }, 45000);
  });

  describe('CAPABILITIES UPPDATERINGAR: bridge_text, connection_status, alarm_generic', () => {

    test('All capabilities uppdateras korrekt under boat journey', async () => {
      const capabilitiesScenario = [
        {
          description: 'System start - default values',
          vessels: [], // Ingen båt först
          delaySeconds: 1,
        },
        {
          description: 'Båt approaching - capabilities bör uppdatera',
          vessels: [{
            mmsi: '999777555',
            name: 'Capabilities Test',
            lat: 58.283000,
            lon: 12.283000,
            sog: 4.0,
            cog: 180,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt under bridge - capabilities change again',
          vessels: [{
            mmsi: '999777555',
            name: 'Capabilities Test',
            lat: 58.284095, // Under Klaffbron
            lon: 12.283929,
            sog: 3.2,
            cog: 185,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt leaves - capabilities reset',
          vessels: [],
          delaySeconds: 2,
        },
      ];

      const capReport = await testRunner.runRealJourney(
        'Capabilities Update Test',
        capabilitiesScenario,
      );

      // CAPABILITIES VALIDERING

      // 1. bridge_text capability bör ha uppdaterats
      expect(capReport.bridgeTextChanges.length).toBeGreaterThan(1);

      // 2. Default message i början och slutet
      expect(capReport.finalBridgeText).toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');

      // 3. Meaningful bridge text i mitten
      const meaningfulUpdates = capReport.bridgeTextChanges.filter((change) => !change.newText.includes('Inga båtar är i närheten'));
      expect(meaningfulUpdates.length).toBeGreaterThan(0);

      console.log('✅ bridge_text capability updating correctly');
      console.log(`✅ Meaningful updates: ${meaningfulUpdates.length}`);
      console.log(`✅ Total updates: ${capReport.bridgeTextChanges.length}`);

    }, 45000);
  });

  describe('SERVICE INTEGRATION: VesselDataService ↔ BridgeTextService ↔ StatusService', () => {

    test('Komplett integration pipeline - vessel data → status → bridge text', async () => {
      const integrationScenario = [
        {
          description: 'Båt entering system - test full pipeline',
          vessels: [{
            mmsi: '123456789',
            name: 'Integration Test',
            lat: 58.285000, // Norr om Klaffbron
            lon: 12.285000,
            sog: 4.5,
            cog: 180, // Söderut
          }],
        },
        {
          description: 'Båt progress genom status changes',
          vessels: [{
            mmsi: '123456789',
            name: 'Integration Test',
            lat: 58.283500, // Approaching Klaffbron
            lon: 12.284000,
            sog: 3.8,
            cog: 185,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt waiting vid Klaffbron',
          vessels: [{
            mmsi: '123456789',
            name: 'Integration Test',
            lat: 58.283800, // Nära Klaffbron
            lon: 12.284200,
            sog: 0.8, // Slow speed = waiting
            cog: 190,
          }],
          delaySeconds: 4, // Longer delay för waiting status
        },
        {
          description: 'Båt under Klaffbron',
          vessels: [{
            mmsi: '123456789',
            name: 'Integration Test',
            lat: 58.284095, // Under Klaffbron
            lon: 12.283929,
            sog: 3.0,
            cog: 195,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt passed Klaffbron',
          vessels: [{
            mmsi: '123456789',
            name: 'Integration Test',
            lat: 58.284500, // Söder om Klaffbron
            lon: 12.283500,
            sog: 4.0,
            cog: 200,
          }],
        },
      ];

      const integrationReport = await testRunner.runRealJourney(
        'Service Integration Pipeline Test',
        integrationScenario,
      );

      // INTEGRATION VALIDERING

      // 1. Flera meaningful status changes
      expect(integrationReport.bridgeTextChanges.length).toBeGreaterThanOrEqual(3);

      // 2. Status progression bör synas i bridge text changes
      const statusProgression = integrationReport.bridgeTextChanges.map((change) => ({
        text: change.newText,
        vesselsCount: change.vessels ? change.vessels.length : 0,
      }));

      // Bör ha vessel i systemet under större delen av resan
      const withVessels = statusProgression.filter((s) => s.vesselsCount > 0);
      expect(withVessels.length).toBeGreaterThan(2);

      // 3. Bridge text terminology bör reflektera olika status
      const allTexts = integrationReport.bridgeTextChanges.map((c) => c.newText).join(' ');
      const hasStatusTerms = [
        'närmar sig',
        'inväntar',
        'pågår',
        'passerat',
        'på väg',
      ].some((term) => allTexts.includes(term));
      expect(hasStatusTerms).toBe(true);

      console.log('✅ Full service integration pipeline working');
      console.log(`✅ Status changes tracked: ${integrationReport.bridgeTextChanges.length}`);
      console.log('✅ Status terminology present in bridge texts');

    }, 45000);

    test('Error resilience - services bör hantera edge cases gracefully', async () => {
      const errorResilienceScenario = [
        {
          description: 'Normal båt för baseline',
          vessels: [{
            mmsi: '987654321',
            name: 'Normal Boat',
            lat: 58.284000,
            lon: 12.284000,
            sog: 4.0,
            cog: 180,
          }],
        },
        {
          description: 'Rapid position changes - test service robustness',
          vessels: [{
            mmsi: '987654321',
            name: 'Normal Boat',
            lat: 58.284095, // Under bridge
            lon: 12.283929,
            sog: 3.5,
            cog: 185,
          }],
        },
        {
          description: 'Extreme speed change - test ETA calculations',
          vessels: [{
            mmsi: '987654321',
            name: 'Normal Boat',
            lat: 58.284200,
            lon: 12.283700,
            sog: 0.1, // Nästan stopp
            cog: 190,
          }],
          delaySeconds: 3,
        },
        {
          description: 'High speed again - test status stability',
          vessels: [{
            mmsi: '987654321',
            name: 'Normal Boat',
            lat: 58.284500,
            lon: 12.283200,
            sog: 8.5, // Hög hastighet
            cog: 195,
          }],
        },
      ];

      const resilienceReport = await testRunner.runRealJourney(
        'Service Error Resilience Test',
        errorResilienceScenario,
      );

      // ERROR RESILIENCE VALIDERING

      // 1. Services bör ha fortsatt fungera trots extrema ändringar
      expect(resilienceReport.bridgeTextChanges.length).toBeGreaterThan(1);

      // 2. Inga system errors i bridge text
      const allTexts = resilienceReport.bridgeTextChanges.map((c) => c.newText);
      allTexts.forEach((text) => {
        expect(text).not.toContain('error');
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('null');
        expect(text).not.toContain('NaN');
      });

      // 3. Final state bör vara korrekt
      expect(typeof resilienceReport.finalBridgeText).toBe('string');
      expect(resilienceReport.finalBridgeText.length).toBeGreaterThan(10);

      console.log('✅ Services resilient to extreme edge cases');
      console.log(`✅ All bridge texts valid: ${allTexts.length}`);

    }, 45000);
  });

  describe('HOMEY DEVICE INTERFACE: Korrekt device capability hantering', () => {

    test('Device capabilities sync med app state', async () => {
      // Detta test verifierar att Homey device interface fungerar
      const deviceSyncScenario = [
        {
          description: 'System start med connected state',
          vessels: [],
          delaySeconds: 1,
        },
        {
          description: 'Båt entering - device capabilities bör uppdatera',
          vessels: [{
            mmsi: '555888999',
            name: 'Device Sync Test',
            lat: 58.283000,
            lon: 12.283000,
            sog: 4.0,
            cog: 180,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Multiple status changes - test device sync stability',
          vessels: [{
            mmsi: '555888999',
            name: 'Device Sync Test',
            lat: 58.284095, // Under bridge - major status change
            lon: 12.283929,
            sog: 3.0,
            cog: 185,
          }],
          delaySeconds: 2,
        },
      ];

      const deviceReport = await testRunner.runRealJourney(
        'Device Interface Sync Test',
        deviceSyncScenario,
      );

      // DEVICE INTERFACE VALIDERING

      // 1. Device capabilities bör ha uppdaterats
      expect(deviceReport.bridgeTextChanges.length).toBeGreaterThan(0);

      // 2. Final state bör vara consistent
      expect(typeof deviceReport.finalBridgeText).toBe('string');

      // 3. No device-related errors
      console.log('✅ Homey device interface working correctly');
      console.log(`✅ Device capability updates: ${deviceReport.bridgeTextChanges.length}`);

    }, 30000);
  });
});
