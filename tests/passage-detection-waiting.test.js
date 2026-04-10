'use strict';

const { detectBridgePassage } = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

describe('Passage detection — stationary/drifting vessels (Bug 2)', () => {
  // Stridsbergsbron as the test bridge
  const bridge = {
    lat: BRIDGES.stridsbergsbron.lat,
    lon: BRIDGES.stridsbergsbron.lon,
    axisBearing: BRIDGES.stridsbergsbron.axisBearing,
    name: 'Stridsbergsbron',
  };

  // Position ~200m south of Stridsbergsbron (within METHOD 5 range)
  const baseLat = bridge.lat - 0.0018;
  const baseLon = bridge.lon;

  // --- Test 1: Stationary SOG 0.3 with oscillating COG → NOT passage ---
  test('stationary vessel (SOG 0.3) with oscillating COG is NOT a passage', () => {
    const oldVessel = {
      lat: baseLat,
      lon: baseLon,
      sog: 0.3,
      cog: 180,
    };
    const vessel = {
      lat: baseLat + 0.00001,
      lon: baseLon + 0.00001, // ~1m movement
      sog: 0.3,
      cog: 280, // 100° COG change
    };

    const result = detectBridgePassage(vessel, oldVessel, bridge);
    expect(result.passed).toBe(false);
  });

  // --- Test 2: Drifting SOG 0.5 with large COG change → NOT passage ---
  test('drifting vessel (SOG 0.5) with large COG change is NOT a passage', () => {
    const oldVessel = {
      lat: baseLat,
      lon: baseLon,
      sog: 0.5,
      cog: 10,
    };
    const vessel = {
      lat: baseLat + 0.00002,
      lon: baseLon, // ~2m movement
      sog: 0.5,
      cog: 250, // 120° COG change (exceeds 60° threshold)
    };

    const result = detectBridgePassage(vessel, oldVessel, bridge);
    // METHOD 5 should NOT trigger because SOG 0.5 < 1.5 threshold
    expect(result.passed).toBe(false);
  });

  // --- Test 3: SOG 1.0 with COG change → NOT passage (under new threshold 1.5) ---
  test('slow vessel (SOG 1.0) with COG change is NOT a passage via METHOD 5', () => {
    const oldVessel = {
      lat: baseLat,
      lon: baseLon,
      sog: 1.0,
      cog: 30,
    };
    const vessel = {
      lat: baseLat + 0.0001,
      lon: baseLon, // ~11m movement
      sog: 1.0,
      cog: 200, // large COG change
    };

    const result = detectBridgePassage(vessel, oldVessel, bridge);
    // METHOD 5 should NOT trigger because SOG 1.0 < 1.5
    if (result.passed && result.method === 'direction_change_passage') {
      throw new Error('METHOD 5 should not trigger with SOG 1.0');
    }
  });

  // --- Test 4: Moving vessel (SOG 3.0) with actual displacement → passage OK ---
  test('moving vessel (SOG 3.0) with actual displacement triggers passage via METHOD 5', () => {
    // Previous: 200m south of bridge, vessel: 100m north-east (crossed)
    const oldVessel = {
      lat: bridge.lat - 0.0018,
      lon: bridge.lon,
      sog: 3.0,
      cog: 30, // heading NE
    };
    const vessel = {
      lat: bridge.lat + 0.001,
      lon: bridge.lon + 0.0005,
      sog: 3.0,
      cog: 200, // heading SW now — big COG change
    };

    const result = detectBridgePassage(vessel, oldVessel, bridge);
    // Should detect passage via some method (trajectory, line crossing, or direction change)
    expect(result.passed).toBe(true);
  });

  // --- Test 5: Old SOG < 1.0 blocks METHOD 5 ---
  test('old vessel SOG < 1.0 blocks METHOD 5 even if current SOG is high', () => {
    const oldVessel = {
      lat: baseLat,
      lon: baseLon,
      sog: 0.8,
      cog: 30,
    };
    const vessel = {
      lat: baseLat + 0.00005,
      lon: baseLon, // ~5m — below 30m movement threshold
      sog: 2.0,
      cog: 200,
    };

    const result = detectBridgePassage(vessel, oldVessel, bridge);
    // METHOD 5 should not trigger: oldVessel.sog < 1.0 AND movementDistance < 30m
    if (result.passed && result.method === 'direction_change_passage') {
      throw new Error('METHOD 5 should not trigger with oldVessel.sog 0.8');
    }
  });

  // --- Test 6: Traditional close passage still works ---
  test('traditional close passage detection still works unaffected', () => {
    const oldVessel = {
      lat: bridge.lat,
      lon: bridge.lon, // exactly at bridge
      sog: 4,
      cog: 30,
    };
    const vessel = {
      lat: bridge.lat + 0.001,
      lon: bridge.lon + 0.0005, // ~130m away
      sog: 4,
      cog: 30,
    };

    const result = detectBridgePassage(vessel, oldVessel, bridge);
    expect(result.passed).toBe(true);
    expect(result.method).toBe('traditional_close_passage');
  });

  // --- Test 7: Stallbackabron special still works ---
  test('Stallbackabron special case still works', () => {
    const stallbacka = {
      lat: BRIDGES.stallbackabron.lat,
      lon: BRIDGES.stallbackabron.lon,
      axisBearing: BRIDGES.stallbackabron.axisBearing,
      name: 'Stallbackabron',
    };

    const oldVessel = {
      lat: stallbacka.lat - 0.0005,
      lon: stallbacka.lon, // ~55m south (within 120m)
      sog: 4,
      cog: 30,
    };
    const vessel = {
      lat: stallbacka.lat + 0.001,
      lon: stallbacka.lon, // ~110m north (moving away)
      sog: 4,
      cog: 30,
    };

    const result = detectBridgePassage(vessel, oldVessel, stallbacka);
    expect(result.passed).toBe(true);
    // Should use stallbacka_special or traditional method
    expect(['stallbacka_special', 'traditional_close_passage', 'trajectory_based_passage', 'enhanced_line_crossing']).toContain(result.method);
  });

  // --- Test 8: Movement distance < 30m blocks METHOD 5 ---
  test('movement distance < 30m blocks METHOD 5 even with high SOG', () => {
    const oldVessel = {
      lat: baseLat,
      lon: baseLon,
      sog: 3.0,
      cog: 30,
    };
    const vessel = {
      lat: baseLat + 0.0001,
      lon: baseLon, // ~11m movement (< 30m threshold)
      sog: 3.0,
      cog: 200,
    };

    const result = detectBridgePassage(vessel, oldVessel, bridge);
    if (result.passed && result.method === 'direction_change_passage') {
      throw new Error('METHOD 5 should not trigger with movementDistance < 30m');
    }
  });
});
