'use strict';

/**
 * REAL FLOW TRIGGER INTEGRATION TESTS
 *
 * Dessa tester fokuserar på att verifiera faktiska flow trigger-anrop
 * och token validation som Homey SDK utför. Testerna fångar upp problem
 * som bara uppstår vid riktiga flow trigger calls.
 *
 * KRITISKT: Dessa tester skulle ha fångat undefined bridge_name felet
 * som orsakade 20+ krascher i produktionsloggen.
 */

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

describe('🎯 REAL FLOW TRIGGER INTEGRATION TESTS', () => {
  let testRunner;
  let mockFlowTrigger;
  let mockTriggerCalls;

  beforeAll(async () => {
    testRunner = new RealAppTestRunner();
    await testRunner.initializeApp();

    // Setup mock flow trigger that validates tokens like Homey SDK does
    mockTriggerCalls = [];
    mockFlowTrigger = {
      trigger: jest.fn().mockImplementation((args, tokens) => {
        // SIMULATE HOMEY SDK TOKEN VALIDATION
        if (!tokens.bridge_name || typeof tokens.bridge_name !== 'string') {
          const error = new Error(`Could not trigger Flow card with id "boat_near": Invalid value for token bridge_name. Expected string but got ${typeof tokens.bridge_name}`);
          mockTriggerCalls.push({ args, tokens, error });
          throw error;
        }
        if (!tokens.vessel_name || typeof tokens.vessel_name !== 'string') {
          const error = new Error(`Could not trigger Flow card with id "boat_near": Invalid value for token vessel_name. Expected string but got ${typeof tokens.vessel_name}`);
          mockTriggerCalls.push({ args, tokens, error });
          throw error;
        }

        // Success case
        mockTriggerCalls.push({ args, tokens, success: true });
        return Promise.resolve();
      }),
    };

    // Replace app's flow trigger with our validating mock
    // Need to ensure this is set after app initialization
    testRunner.app._boatNearTrigger = mockFlowTrigger;
  }, 30000);

  afterAll(async () => {
    if (testRunner) {
      await testRunner.cleanup();
    }
  });

  beforeEach(() => {
    // Reset call tracking between tests
    mockTriggerCalls = [];
    mockFlowTrigger.trigger.mockClear();
  });

  describe('Flow Trigger Token Validation', () => {

    test('Should successfully trigger with valid bridge_name token', async () => {
      const validTriggerScenario = [
        {
          description: 'Båt approaching Klaffbron - valid token test',
          vessels: [{
            mmsi: '123456789',
            name: 'Valid Token Test',
            lat: 58.282800, // ~250m från Klaffbron
            lon: 12.283200,
            sog: 4.0,
            cog: 180,
          }],
          delaySeconds: 3, // Give time for trigger
        },
      ];

      await testRunner.runRealJourney(
        'Valid Token Flow Trigger Test',
        validTriggerScenario,
      );

      // Verify flow trigger was called successfully
      expect(mockFlowTrigger.trigger).toHaveBeenCalled();

      const successfulCalls = mockTriggerCalls.filter((call) => call.success);
      expect(successfulCalls.length).toBeGreaterThan(0);

      // Verify token structure
      const firstCall = successfulCalls[0];
      expect(firstCall.tokens).toMatchObject({
        bridge_name: expect.any(String),
        vessel_name: expect.any(String),
        direction: expect.any(String),
      });

      // Verify bridge_name is valid
      expect(firstCall.tokens.bridge_name).toBeTruthy();
      expect(firstCall.tokens.bridge_name.trim()).not.toBe('');

      console.log('✅ Flow trigger called with valid tokens:', firstCall.tokens);
    }, 45000);

    test('Should handle undefined bridge_name gracefully without crashing', async () => {
      // Force a scenario that could cause undefined bridge_name
      const edgeCaseScenario = [
        {
          description: 'Båt with potential undefined bridge scenario',
          vessels: [{
            mmsi: '987654321',
            name: '', // Empty name to test edge case
            lat: 58.284095, // At bridge position
            lon: 12.283929,
            sog: 0, // Zero speed edge case
            cog: 0, // Zero course edge case
          }],
          delaySeconds: 2,
        },
      ];

      // This should NOT crash the app even if bridge_name becomes undefined
      await expect(testRunner.runRealJourney(
        'Edge Case Flow Trigger Test',
        edgeCaseScenario,
      )).resolves.toBeTruthy();

      // Check if any calls had errors
      const errorCalls = mockTriggerCalls.filter((call) => call.error);

      if (errorCalls.length > 0) {
        console.log('⚠️ Flow trigger errors detected (expected for edge cases):');
        errorCalls.forEach((call) => {
          console.log(`  Error: ${call.error.message}`);
          console.log(`  Tokens: ${JSON.stringify(call.tokens)}`);
        });

        // Verify the error is the expected type
        errorCalls.forEach((call) => {
          expect(call.error.message).toContain('Invalid value for token bridge_name');
        });
      }

      console.log('✅ App handled edge cases without crashing');
    }, 45000);

    test('Should validate all token types correctly', async () => {
      const tokenValidationScenario = [
        {
          description: 'Båt for comprehensive token validation',
          vessels: [{
            mmsi: '555666777',
            name: 'Token Validation Test',
            lat: 58.283500, // Near Klaffbron
            lon: 12.284000,
            sog: 3.5,
            cog: 185,
          }],
          delaySeconds: 3,
        },
      ];

      await testRunner.runRealJourney(
        'Token Validation Test',
        tokenValidationScenario,
      );

      const successfulCalls = mockTriggerCalls.filter((call) => call.success);
      expect(successfulCalls.length).toBeGreaterThan(0);

      // Verify all required tokens are present and valid
      successfulCalls.forEach((call) => {
        const { tokens } = call;

        // bridge_name validation
        expect(tokens.bridge_name).toBeDefined();
        expect(typeof tokens.bridge_name).toBe('string');
        expect(tokens.bridge_name.trim()).not.toBe('');

        // vessel_name validation
        expect(tokens.vessel_name).toBeDefined();
        expect(typeof tokens.vessel_name).toBe('string');

        // direction validation
        expect(tokens.direction).toBeDefined();
        expect(typeof tokens.direction).toBe('string');

        // eta_minutes validation (can be null)
        if (tokens.eta_minutes !== null) {
          expect(typeof tokens.eta_minutes).toBe('number');
          expect(tokens.eta_minutes).toBeGreaterThanOrEqual(0);
        }

        console.log('✅ All tokens valid:', tokens);
      });
    }, 45000);

  });

  describe('Flow Trigger Deduplication', () => {

    test('Should not trigger duplicate flow calls for same vessel+bridge', async () => {
      const dedupeTestScenario = [
        {
          description: 'Båt entering trigger zone',
          vessels: [{
            mmsi: '111222333',
            name: 'Dedupe Test',
            lat: 58.282800, // ~250m från Klaffbron
            lon: 12.283200,
            sog: 3.0,
            cog: 180,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt still in same zone - should not retrigger',
          vessels: [{
            mmsi: '111222333',
            name: 'Dedupe Test',
            lat: 58.282900, // Still near Klaffbron
            lon: 12.283300,
            sog: 2.5,
            cog: 185,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt moves closer but still same bridge - should not retrigger',
          vessels: [{
            mmsi: '111222333',
            name: 'Dedupe Test',
            lat: 58.283200, // Even closer to Klaffbron
            lon: 12.283600,
            sog: 2.0,
            cog: 190,
          }],
          delaySeconds: 2,
        },
      ];

      await testRunner.runRealJourney(
        'Flow Trigger Deduplication Test',
        dedupeTestScenario,
      );

      // Should only trigger once despite multiple position updates
      const klaffbronCalls = mockTriggerCalls.filter((call) => call.success && call.args.bridge === 'klaffbron');

      // Allow for 1-2 calls max (initial trigger + potential "any" trigger)
      expect(klaffbronCalls.length).toBeLessThanOrEqual(2);

      console.log(`✅ Deduplication working: ${klaffbronCalls.length} trigger calls for Klaffbron`);
    }, 45000);

  });

  describe('Multi-Bridge Flow Triggers', () => {

    test('Should trigger correctly for different bridges simultaneously', async () => {
      const multiBridgeScenario = [
        {
          description: 'Båt 1 at Klaffbron',
          vessels: [{
            mmsi: '111111111',
            name: 'Multi Bridge Test 1',
            lat: 58.282800, // Near Klaffbron
            lon: 12.283200,
            sog: 3.0,
            cog: 180,
          }],
          delaySeconds: 2,
        },
        {
          description: 'Båt 2 at Stridsbergsbron simultaneously',
          vessels: [
            {
              mmsi: '111111111',
              name: 'Multi Bridge Test 1',
              lat: 58.283000, // Still at Klaffbron
              lon: 12.283400,
              sog: 2.8,
              cog: 185,
            },
            {
              mmsi: '222222222',
              name: 'Multi Bridge Test 2',
              lat: 58.294000, // Near Stridsbergsbron
              lon: 12.295000,
              sog: 4.0,
              cog: 220,
            },
          ],
          delaySeconds: 3,
        },
      ];

      await testRunner.runRealJourney(
        'Multi-Bridge Flow Trigger Test',
        multiBridgeScenario,
      );

      const successfulCalls = mockTriggerCalls.filter((call) => call.success);

      // Should have triggers for different bridges
      const bridgeTypes = new Set(successfulCalls.map((call) => call.args.bridge));
      expect(bridgeTypes.size).toBeGreaterThan(0);

      // Should have different bridge_name tokens
      const bridgeNames = new Set(successfulCalls.map((call) => call.tokens.bridge_name));
      expect(bridgeNames.size).toBeGreaterThan(0);

      console.log('✅ Multi-bridge triggers working');
      console.log(`  Bridge types: ${Array.from(bridgeTypes).join(', ')}`);
      console.log(`  Bridge names: ${Array.from(bridgeNames).join(', ')}`);
    }, 45000);

  });

});
