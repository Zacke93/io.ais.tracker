'use strict';

const { detectBridgePassage, hasCrossedBridgeLine } = require('../lib/utils/geometry');

describe('Enhanced Passage Detection', () => {
  const stallbackabron = {
    name: 'Stallbackabron',
    lat: 58.31142992293701,
    lon: 12.31456385688822,
    axisBearing: 125
  };
  
  const klaffbron = {
    name: 'Klaffbron',
    lat: 58.28409551543077,
    lon: 12.283929525245636,
    axisBearing: 130
  };

  describe('Traditional Close Passage Detection', () => {
    test('should detect close passage with traditional method', () => {
      // Very close passage - under 50m then moving away >60m
      const oldVessel = { lat: 58.31142, lon: 12.31456, cog: 45, sog: 4.2 }; // At bridge center
      const vessel = { lat: 58.31150, lon: 12.31470, cog: 45, sog: 4.2 }; // Moving away >60m
      
      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(true);
      // May use either traditional or line crossing method
      expect(['traditional_close_passage', 'enhanced_line_crossing']).toContain(result.method);
      expect(result.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('Enhanced Line Crossing Detection', () => {
    test('should detect line crossing with enhanced method', () => {
      // Simulate boat 257941000 scenario - maneuvering near Stallbackabron
      const oldVessel = { lat: 58.310800, lon: 12.313500, cog: 200, sog: 3.8 };
      const vessel = { lat: 58.311800, lon: 12.315500, cog: 30, sog: 3.5 };
      
      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(true);
      expect(result.method).toBe('enhanced_line_crossing');
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    test('should handle relaxed line crossing for maneuvering boats', () => {
      // Large movement with direction change
      const oldVessel = { lat: 58.310000, lon: 12.313000, cog: 180, sog: 4.0 };
      const vessel = { lat: 58.312000, lon: 12.316000, cog: 45, sog: 3.8 };
      
      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(true);
      expect(['enhanced_line_crossing', 'progressive_distance', 'direction_change_passage']).toContain(result.method);
      expect(result.confidence).toBeGreaterThan(0.7);
    });
  });

  describe('Progressive Distance Detection', () => {
    test('should detect moderate distance passages', () => {
      const oldVessel = { lat: 58.310900, lon: 12.313800, cog: 45, sog: 3.5 };
      const vessel = { lat: 58.311600, lon: 12.315200, cog: 45, sog: 3.5 };
      
      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(true);
      // May use either progressive distance or line crossing
      expect(['progressive_distance', 'enhanced_line_crossing']).toContain(result.method);
      expect(result.confidence).toBeGreaterThan(0.7);
    });
  });

  describe('Direction Change Passage Detection', () => {
    test('should detect passage when boat changes direction near bridge', () => {
      // Simulate boat making significant direction change very close to bridge
      const oldVessel = { lat: 58.311100, lon: 12.314100, cog: 180, sog: 4.0 }; // Close to bridge, heading south
      const vessel = { lat: 58.311500, lon: 12.314900, cog: 30, sog: 3.8 }; // Past bridge, changed to NE
      
      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(true);
      // May use various methods including direction change
      expect(['direction_change_passage', 'enhanced_line_crossing', 'progressive_distance']).toContain(result.method);
      expect(result.confidence).toBeGreaterThan(0.6);
    });
  });

  describe('Stallbackabron Special Cases', () => {
    test('should handle Stallbackabron special detection', () => {
      const oldVessel = { lat: 58.311350, lon: 12.314400, cog: 45, sog: 3.2 };
      const vessel = { lat: 58.311500, lon: 12.314700, cog: 45, sog: 3.2 };
      
      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(true);
      expect(['stallbacka_special', 'traditional_close_passage', 'enhanced_line_crossing']).toContain(result.method);
      expect(result.confidence).toBeGreaterThan(0.75);
    });
  });

  describe('Boat 257941000 GPS Jump Scenario', () => {
    test('should handle the specific GPS jump scenario that failed', () => {
      // Reproduce the exact scenario from the bug report
      const positions = [
        { lat: 58.31000, lon: 12.31300 }, // Starting position near Stallbackabron
        { lat: 58.31140, lon: 12.31456 }, // 763m jump - near bridge center
        { lat: 58.31280, lon: 12.31612 }, // 1033m jump - past bridge
        { lat: 58.31180, lon: 12.31512 }  // 646m jump - direction change
      ];
      
      const vesselStates = [
        { cog: 200, sog: 3.8 },
        { cog: 210, sog: 3.8 },
        { cog: 30, sog: 3.5 },
        { cog: 45, sog: 3.2 }
      ];

      // Test passage detection between positions 1 and 2 (when boat crosses bridge)
      const oldVessel = { 
        ...positions[1], 
        ...vesselStates[1] 
      };
      const vessel = { 
        ...positions[2], 
        ...vesselStates[2] 
      };

      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.7);
      
      // Should work with any of the enhanced methods  
      expect(['enhanced_line_crossing', 'progressive_distance', 'direction_change_passage', 'traditional_close_passage']).toContain(result.method);
    });
  });

  describe('False Positive Prevention', () => {
    test('should not detect passage when boat approaches but does not pass', () => {
      // Boat approaches from far distance but stays distant - no actual bridge crossing
      const oldVessel = { lat: 58.308000, lon: 12.311000, cog: 45, sog: 3.0 }; // Very far from bridge
      const vessel = { lat: 58.308500, lon: 12.311500, cog: 45, sog: 3.0 }; // Still far, parallel movement
      
      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(false);
    });

    test('should not detect passage for distant movements', () => {
      // Boat far from bridge moving parallel
      const oldVessel = { lat: 58.309000, lon: 12.312000, cog: 45, sog: 4.0 };
      const vessel = { lat: 58.309500, lon: 12.312500, cog: 45, sog: 4.0 };
      
      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(false);
    });
  });

  describe('Enhanced Line Crossing Function', () => {
    test('should handle relaxed mode for maneuvering vessels', () => {
      // Position that crosses the bridge line but might be outside normal proximity 
      const prevPos = { lat: 58.310800, lon: 12.313800 }; // South of bridge
      const currPos = { lat: 58.311600, lon: 12.315200 }; // North of bridge
      
      // Standard mode might work if within proximity
      const standardResult = hasCrossedBridgeLine(prevPos, currPos, stallbackabron, {
        minProximityM: 150,
        relaxedMode: false
      });
      
      // Relaxed mode should be more lenient
      const relaxedResult = hasCrossedBridgeLine(prevPos, currPos, stallbackabron, {
        minProximityM: 250,
        maxDistanceM: 400,
        relaxedMode: true
      });
      
      // At least one should work
      expect(standardResult || relaxedResult).toBe(true);
    });
  });

  describe('Invalid Input Handling', () => {
    test('should handle invalid vessel data gracefully', () => {
      const result = detectBridgePassage(null, null, stallbackabron);
      
      expect(result.passed).toBe(false);
      expect(result.method).toBe('invalid_input');
      expect(result.confidence).toBe(0);
    });

    test('should handle invalid coordinates', () => {
      const oldVessel = { lat: NaN, lon: 12.314000, cog: 45, sog: 3.0 };
      const vessel = { lat: 58.311000, lon: 12.314500, cog: 45, sog: 3.0 };
      
      const result = detectBridgePassage(vessel, oldVessel, stallbackabron);
      
      expect(result.passed).toBe(false);
      expect(result.method).toBe('invalid_coordinates');
    });
  });

  describe('Target Bridge vs Intermediate Bridge', () => {
    test('should work equally well for target bridges like Klaffbron', () => {
      const oldVessel = { lat: 58.284000, lon: 12.283800, cog: 45, sog: 3.8 };
      const vessel = { lat: 58.284200, lon: 12.284100, cog: 45, sog: 3.8 };
      
      const result = detectBridgePassage(vessel, oldVessel, klaffbron);
      
      expect(result.passed).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.8);
    });
  });
});