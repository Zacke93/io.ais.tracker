'use strict';

const { findNearestBridge, hasCrossedBridgeLine } = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

describe('Geometry null-safety — calculateDistance returning null', () => {
  const validBridge = {
    lat: BRIDGES.stridsbergsbron.lat,
    lon: BRIDGES.stridsbergsbron.lon,
    axisBearing: BRIDGES.stridsbergsbron.axisBearing,
  };

  // --- Bug #1: findNearestBridge with null distances ---

  test('findNearestBridge with vessel having invalid coordinates returns null', () => {
    const vessel = { lat: NaN, lon: NaN };
    const bridges = { stridsbergsbron: validBridge };

    const result = findNearestBridge(vessel, bridges);
    // With null-guard: should return null (no valid bridge found)
    // Without null-guard: null < Infinity → true, returns bridge with distance=null
    expect(result).toBeNull();
  });

  test('findNearestBridge with mix of valid/invalid bridges returns valid bridge', () => {
    const vessel = { lat: 58.2830, lon: 12.2890 };
    const bridges = {
      invalidBridge: { lat: NaN, lon: NaN },
      stridsbergsbron: validBridge,
    };

    const result = findNearestBridge(vessel, bridges);
    expect(result).not.toBeNull();
    expect(result.bridgeId).toBe('stridsbergsbron');
    expect(Number.isFinite(result.distance)).toBe(true);
  });

  // --- Bug #2: hasCrossedBridgeLine with null distances ---

  test('hasCrossedBridgeLine with invalid prevPos (null distance) returns false', () => {
    const prevPos = { lat: NaN, lon: 12.2890 };
    const currPos = { lat: 58.2830, lon: 12.2890 };

    const result = hasCrossedBridgeLine(prevPos, currPos, validBridge);
    // With null-guard: returns false immediately
    // Without null-guard: Math.min(null, x) → 0 ≤ 250 → true → false positive possible
    expect(result).toBe(false);
  });

  test('hasCrossedBridgeLine with invalid currPos (null distance) returns false', () => {
    const prevPos = { lat: 58.2830, lon: 12.2890 };
    const currPos = { lat: NaN, lon: 12.2890 };

    const result = hasCrossedBridgeLine(prevPos, currPos, validBridge);
    expect(result).toBe(false);
  });
});
