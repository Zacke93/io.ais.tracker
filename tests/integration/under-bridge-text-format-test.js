/**
 * Under-Bridge Text Format Tests
 * 
 * These tests verify that "Broöppning pågår vid [Bridge]" messages are 
 * generated correctly when boats are under bridges.
 */

const { createProductionBoat, createProductionMessageGenerator } = require('../helpers/production-test-base');

describe('Under-Bridge Text Format Tests', () => {

  test('should generate "Broöppning pågår vid Klaffbron" for under-bridge boat', async () => {
    // Create production-accurate boat under Klaffbron
    const boat = createProductionBoat(123456789, 'TEST_BOAT', {
      currentBridge: 'Klaffbron',
      targetBridge: 'Klaffbron',
      status: 'under-bridge',
      etaMinutes: 0,
      isWaiting: true,
      isApproaching: false,
      distanceToCurrent: 15 // Very close to bridge
    });

    const boats = [boat];
    const messageGenerator = createProductionMessageGenerator();
    const bridgeText = messageGenerator.generateBridgeText(boats);

    expect(bridgeText).toBe('Broöppning pågår vid Klaffbron');
  });

  test('should generate "Broöppning pågår vid Stridsbergsbron" for under-bridge boat', async () => {
    const boat = createProductionBoat(987654321, 'ANOTHER_BOAT', {
      currentBridge: 'Stridsbergsbron',
      targetBridge: 'Stridsbergsbron', 
      status: 'under-bridge',
      etaMinutes: 0,
      isWaiting: true,
      isApproaching: false,
      distanceToCurrent: 25
    });

    const boats = [boat];
    const messageGenerator = createProductionMessageGenerator();
    const bridgeText = messageGenerator.generateBridgeText(boats);

    expect(bridgeText).toBe('Broöppning pågår vid Stridsbergsbron');
  });

  test('should prioritize under-bridge over waiting boats', async () => {
    // Multiple boats: one under bridge, one waiting
    const underBridgeBoat = createProductionBoat(111111111, 'UNDER_BRIDGE', {
      currentBridge: 'Klaffbron',
      targetBridge: 'Klaffbron',
      status: 'under-bridge',
      etaMinutes: 0,
      isWaiting: true,
      distanceToCurrent: 10
    });

    const waitingBoat = createProductionBoat(222222222, 'WAITING', {
      currentBridge: 'Klaffbron',
      targetBridge: 'Klaffbron', 
      status: 'waiting',
      etaMinutes: 2,
      isWaiting: true,
      distanceToCurrent: 45
    });

    const boats = [waitingBoat, underBridgeBoat]; // Order shouldn't matter
    const messageGenerator = createProductionMessageGenerator();
    const bridgeText = messageGenerator.generateBridgeText(boats);

    // Should prioritize under-bridge scenario
    expect(bridgeText).toBe('Broöppning pågår vid Klaffbron');
    expect(bridgeText).not.toContain('väntar');
    expect(bridgeText).not.toContain('inväntar');
  });

  test('should show actual bridge where opening is happening', async () => {
    // Boat with different currentBridge vs targetBridge
    const boat = createProductionBoat(333333333, 'BRIDGE_MISMATCH', {
      currentBridge: 'Järnvägsbron',
      targetBridge: 'Stridsbergsbron',
      status: 'under-bridge',
      etaMinutes: 0,
      isWaiting: true,
      distanceToCurrent: 20
    });

    const boats = [boat];
    const messageGenerator = createProductionMessageGenerator();
    const bridgeText = messageGenerator.generateBridgeText(boats);

    // Should show actual bridge (currentBridge), not target bridge
    expect(bridgeText).toBe('Broöppning pågår vid Järnvägsbron');
    expect(bridgeText).not.toContain('Stridsbergsbron');
  });

  test('should handle multi-boat under-bridge scenario', async () => {
    // Multiple boats under the same bridge
    const boat1 = createProductionBoat(444444444, 'BOAT_1', {
      currentBridge: 'Klaffbron',
      targetBridge: 'Klaffbron',
      status: 'under-bridge',
      etaMinutes: 0,
      isWaiting: true,
      distanceToCurrent: 15
    });

    const boat2 = createProductionBoat(555555555, 'BOAT_2', {
      currentBridge: 'Klaffbron',
      targetBridge: 'Klaffbron',
      status: 'under-bridge', 
      etaMinutes: 0,
      isWaiting: true,
      distanceToCurrent: 25
    });

    const boats = [boat1, boat2];
    const messageGenerator = createProductionMessageGenerator();
    const bridgeText = messageGenerator.generateBridgeText(boats);

    expect(bridgeText).toBe('Broöppning pågår vid Klaffbron');
  });

  test('should handle edge case with etaMinutes: 0 but no under-bridge status', async () => {
    // Boat with 0 ETA should be treated as under-bridge
    const boat = createProductionBoat(666666666, 'ZERO_ETA', {
      currentBridge: 'Stridsbergsbron',
      targetBridge: 'Stridsbergsbron',
      status: 'approaching', // Not explicitly under-bridge
      etaMinutes: 0, // But ETA is 0
      isWaiting: false,
      distanceToCurrent: 30
    });

    const boats = [boat];
    const messageGenerator = createProductionMessageGenerator();  
    const bridgeText = messageGenerator.generateBridgeText(boats);

    expect(bridgeText).toBe('Broöppning pågår vid Stridsbergsbron');
  });

  test('should never generate old "Öppning pågår" format', async () => {
    // Test multiple scenarios to ensure old format never appears
    const testBoats = [
      createProductionBoat(777777777, 'TEST1', {
        currentBridge: 'Klaffbron', 
        targetBridge: 'Klaffbron',
        status: 'under-bridge',
        etaMinutes: 0,
        isWaiting: true,
        distanceToCurrent: 10
      }),
      createProductionBoat(888888888, 'TEST2', {
        currentBridge: 'Stridsbergsbron',
        targetBridge: 'Stridsbergsbron',
        status: 'under-bridge',
        etaMinutes: 0,
        isWaiting: true,
        distanceToCurrent: 20
      })
    ];

    for (const boat of testBoats) {
      const boats = [boat];
      const messageGenerator = createProductionMessageGenerator();
      const bridgeText = messageGenerator.generateBridgeText(boats);

      // Should always use "Broöppning pågår", never "Öppning pågår"
      expect(bridgeText).toContain('Broöppning pågår vid');
      expect(bridgeText).not.toContain('Öppning pågår vid');
    }
  });

  test('should handle fallback when currentBridge is null', async () => {
    // Edge case: under-bridge boat with null currentBridge
    const boat = createProductionBoat(999999999, 'NULL_CURRENT', {
      currentBridge: null,
      targetBridge: 'Klaffbron',
      status: 'under-bridge',
      etaMinutes: 0,
      isWaiting: true,
      distanceToCurrent: Infinity
    });

    const boats = [boat];
    const messageGenerator = createProductionMessageGenerator();
    const bridgeText = messageGenerator.generateBridgeText(boats);

    // Should fallback to targetBridge
    expect(bridgeText).toBe('Broöppning pågår vid Klaffbron');
  });
});