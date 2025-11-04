'use strict';

const { BRIDGES } = require('../../lib/constants');

/**
 * ScenarioLibrary - Curated, physically-valid test scenarios
 *
 * IMPORTANT: All scenarios are FIXED and DETERMINISTIC
 * - No runtime randomization
 * - All positions are physically valid
 * - All vessel states are realistic based on production log analysis
 *
 * Total: 20 curated scenarios covering:
 * - Core journeys (4): Complete canal passages north/south
 * - Status transitions (6): Critical state changes
 * - Multi-vessel (5): 2-5 boats in various configurations
 * - Edge cases (5): Boundary conditions and special scenarios
 */
class ScenarioLibrary {
  /**
   * Calculate realistic position offset from bridge
   * @param {string} bridgeName - Bridge name
   * @param {number} distanceMeters - Distance from bridge
   * @param {string} direction - 'north' or 'south'
   * @returns {Object} {lat, lon}
   */
  static _calculatePosition(bridgeName, distanceMeters, direction = 'south') {
    const bridgeId = bridgeName.toLowerCase().replace(/bron$/, 'bron');
    const bridge = BRIDGES[bridgeId];
    if (!bridge) throw new Error(`Bridge ${bridgeName} not found`);

    // Realistic nautical offset accounting for canal orientation
    const latOffset = distanceMeters / 111000;
    const lonOffset = distanceMeters / (111000 * Math.cos(bridge.lat * Math.PI / 180));

    // Canal angle: NNE-SSW (approximately 25 degrees from north)
    const canalAngle = 25;
    const radians = (canalAngle * Math.PI) / 180;

    if (direction === 'south') {
      return {
        lat: bridge.lat - latOffset * Math.cos(radians),
        lon: bridge.lon - lonOffset * Math.sin(radians),
      };
    }
    // north
    return {
      lat: bridge.lat + latOffset * Math.cos(radians),
      lon: bridge.lon + lonOffset * Math.sin(radians),
    };
  }

  /**
   * Get all curated scenarios
   * @returns {Array} Array of test scenarios
   */
  static getAll() {
    return [
      ...this._getCoreJourneys(),
      ...this._getStatusTransitions(),
      ...this._getMultiVesselScenarios(),
      ...this._getEdgeCases(),
    ];
  }

  /**
   * Core Journeys (4 scenarios)
   * Complete canal passages demonstrating all transitions
   */
  static _getCoreJourneys() {
    return [
      {
        name: 'Journey 1: Single vessel North→South (complete passage)',
        description: 'Validates all bridge text transitions through full canal southbound',
        waypoints: [
          {
            step: 1,
            description: 'Start 600m north of Stallbackabron',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('stallbackabron', 600, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 2,
            description: 'Approaching Stallbackabron (450m)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('stallbackabron', 450, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 3,
            description: 'Special waiting at Stallbackabron (280m)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('stallbackabron', 280, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 4,
            description: 'Under Stallbackabron (30m)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('stallbackabron', 30, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 5,
            description: 'Just passed Stallbackabron (80m south)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('stallbackabron', 80, 'south'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 6,
            description: 'Approaching Stridsbergsbron (450m)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('stridsbergsbron', 450, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 7,
            description: 'Waiting at Stridsbergsbron (280m)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('stridsbergsbron', 280, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 8,
            description: 'Under-bridge at Stridsbergsbron (30m)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('stridsbergsbron', 30, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 9,
            description: 'Just passed Stridsbergsbron (80m south)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('stridsbergsbron', 80, 'south'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 10,
            description: 'Approaching Klaffbron (450m)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('klaffbron', 450, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 11,
            description: 'Waiting at Klaffbron (280m)',
            vessels: [{
              mmsi: '246924000',
              name: 'LAURIERBORG',
              ...this._calculatePosition('klaffbron', 280, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 12,
            description: 'Passed Klaffbron, journey complete',
            vessels: [],
          },
        ],
      },

      {
        name: 'Journey 2: Single vessel South→North (complete passage)',
        description: 'Validates all bridge text transitions through full canal northbound',
        waypoints: [
          {
            step: 1,
            description: 'Start 600m south of Olidebron',
            vessels: [{
              mmsi: '275514000',
              name: 'NORDIC PASSAGE',
              ...this._calculatePosition('olidebron', 600, 'south'),
              sog: 4.8,
              cog: 25,
            }],
          },
          {
            step: 2,
            description: 'Approaching Klaffbron (450m)',
            vessels: [{
              mmsi: '275514000',
              name: 'NORDIC PASSAGE',
              ...this._calculatePosition('klaffbron', 450, 'south'),
              sog: 4.8,
              cog: 25,
            }],
          },
          {
            step: 3,
            description: 'Waiting at Klaffbron (280m)',
            vessels: [{
              mmsi: '275514000',
              name: 'NORDIC PASSAGE',
              ...this._calculatePosition('klaffbron', 280, 'south'),
              sog: 4.8,
              cog: 25,
            }],
          },
          {
            step: 4,
            description: 'Under-bridge at Klaffbron (30m)',
            vessels: [{
              mmsi: '275514000',
              name: 'NORDIC PASSAGE',
              ...this._calculatePosition('klaffbron', 30, 'south'),
              sog: 4.8,
              cog: 25,
            }],
          },
          {
            step: 5,
            description: 'Just passed Klaffbron (80m north)',
            vessels: [{
              mmsi: '275514000',
              name: 'NORDIC PASSAGE',
              ...this._calculatePosition('klaffbron', 80, 'north'),
              sog: 4.8,
              cog: 25,
            }],
          },
          {
            step: 6,
            description: 'Approaching Stridsbergsbron (450m)',
            vessels: [{
              mmsi: '275514000',
              name: 'NORDIC PASSAGE',
              ...this._calculatePosition('stridsbergsbron', 450, 'south'),
              sog: 4.8,
              cog: 25,
            }],
          },
          {
            step: 7,
            description: 'Waiting at Stridsbergsbron (280m)',
            vessels: [{
              mmsi: '275514000',
              name: 'NORDIC PASSAGE',
              ...this._calculatePosition('stridsbergsbron', 280, 'south'),
              sog: 4.8,
              cog: 25,
            }],
          },
          {
            step: 8,
            description: 'Journey complete',
            vessels: [],
          },
        ],
      },

      {
        name: 'Journey 3: Fast vessel (8 knots) timing validation',
        description: 'Validates ETA calculations with high-speed vessel',
        waypoints: [
          {
            step: 1,
            description: 'Fast vessel 800m from Klaffbron',
            vessels: [{
              mmsi: '265727030',
              name: 'EXPRESS',
              ...this._calculatePosition('klaffbron', 800, 'south'),
              sog: 8.0,
              cog: 25,
            }],
          },
          {
            step: 2,
            description: 'Fast approach (450m)',
            vessels: [{
              mmsi: '265727030',
              name: 'EXPRESS',
              ...this._calculatePosition('klaffbron', 450, 'south'),
              sog: 8.0,
              cog: 25,
            }],
          },
          {
            step: 3,
            description: 'Reached Klaffbron quickly',
            vessels: [{
              mmsi: '265727030',
              name: 'EXPRESS',
              ...this._calculatePosition('klaffbron', 280, 'south'),
              sog: 8.0,
              cog: 25,
            }],
          },
        ],
      },

      {
        name: 'Journey 4: Slow vessel (3 knots) timing validation',
        description: 'Validates ETA calculations with slow vessel',
        waypoints: [
          {
            step: 1,
            description: 'Slow vessel 600m from Stridsbergsbron',
            vessels: [{
              mmsi: '265607140',
              name: 'LEISURE',
              ...this._calculatePosition('stridsbergsbron', 600, 'south'),
              sog: 3.0,
              cog: 25,
            }],
          },
          {
            step: 2,
            description: 'Slow approach (450m)',
            vessels: [{
              mmsi: '265607140',
              name: 'LEISURE',
              ...this._calculatePosition('stridsbergsbron', 450, 'south'),
              sog: 3.0,
              cog: 25,
            }],
          },
          {
            step: 3,
            description: 'Still approaching slowly',
            vessels: [{
              mmsi: '265607140',
              name: 'LEISURE',
              ...this._calculatePosition('stridsbergsbron', 350, 'south'),
              sog: 3.0,
              cog: 25,
            }],
          },
        ],
      },
    ];
  }

  /**
   * Status Transitions (6 scenarios)
   * Critical state changes and boundary conditions
   */
  static _getStatusTransitions() {
    return [
      {
        name: 'Transition: Approaching → Waiting (boundary test)',
        description: 'Tests 500m→300m transition for waiting status',
        waypoints: [
          {
            step: 1,
            description: 'Just inside approaching zone (499m)',
            vessels: [{
              mmsi: '246924000',
              name: 'TEST1',
              ...this._calculatePosition('klaffbron', 499, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
          {
            step: 2,
            description: 'Just inside waiting zone (299m)',
            vessels: [{
              mmsi: '246924000',
              name: 'TEST1',
              ...this._calculatePosition('klaffbron', 299, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
        ],
      },

      {
        name: 'Transition: Waiting → Under-bridge (boundary test)',
        description: 'Tests 50m boundary for under-bridge status',
        waypoints: [
          {
            step: 1,
            description: 'Just outside under-bridge zone (51m)',
            vessels: [{
              mmsi: '246924000',
              name: 'TEST2',
              ...this._calculatePosition('stridsbergsbron', 51, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
          {
            step: 2,
            description: 'Just inside under-bridge zone (49m)',
            vessels: [{
              mmsi: '246924000',
              name: 'TEST2',
              ...this._calculatePosition('stridsbergsbron', 49, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
        ],
      },

      {
        name: 'Transition: Under-bridge → Passed',
        description: 'Tests passage detection and passed message',
        waypoints: [
          {
            step: 1,
            description: 'Under bridge (30m north)',
            vessels: [{
              mmsi: '246924000',
              name: 'TEST3',
              ...this._calculatePosition('klaffbron', 30, 'north'),
              sog: 5.0,
              cog: 205,
            }],
          },
          {
            step: 2,
            description: 'Just passed (70m south)',
            vessels: [{
              mmsi: '246924000',
              name: 'TEST3',
              ...this._calculatePosition('klaffbron', 70, 'south'),
              sog: 5.0,
              cog: 205,
            }],
          },
        ],
      },

      {
        name: 'Stallbackabron: Complete special sequence',
        description: 'Tests all Stallbackabron special messages',
        waypoints: [
          {
            step: 1,
            description: 'Approaching Stallbackabron (450m)',
            vessels: [{
              mmsi: '246924000',
              name: 'STALLTEST',
              ...this._calculatePosition('stallbackabron', 450, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 2,
            description: 'Special waiting "åker strax under" (280m)',
            vessels: [{
              mmsi: '246924000',
              name: 'STALLTEST',
              ...this._calculatePosition('stallbackabron', 280, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 3,
            description: 'Passing Stallbackabron (30m)',
            vessels: [{
              mmsi: '246924000',
              name: 'STALLTEST',
              ...this._calculatePosition('stallbackabron', 30, 'north'),
              sog: 5.2,
              cog: 205,
            }],
          },
          {
            step: 4,
            description: 'Just passed Stallbackabron (80m south)',
            vessels: [{
              mmsi: '246924000',
              name: 'STALLTEST',
              ...this._calculatePosition('stallbackabron', 80, 'south'),
              sog: 5.2,
              cog: 205,
            }],
          },
        ],
      },

      {
        name: 'Intermediate bridge: Olidebron messages',
        description: 'Tests intermediate bridge message format',
        waypoints: [
          {
            step: 1,
            description: 'Approaching Olidebron (450m)',
            vessels: [{
              mmsi: '265573130',
              name: 'INTER1',
              ...this._calculatePosition('olidebron', 450, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
          {
            step: 2,
            description: 'Waiting at Olidebron (280m)',
            vessels: [{
              mmsi: '265573130',
              name: 'INTER1',
              ...this._calculatePosition('olidebron', 280, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
          {
            step: 3,
            description: 'Under Olidebron (30m)',
            vessels: [{
              mmsi: '265573130',
              name: 'INTER1',
              ...this._calculatePosition('olidebron', 30, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
        ],
      },

      {
        name: 'Intermediate bridge: Järnvägsbron messages',
        description: 'Tests intermediate bridge message format',
        waypoints: [
          {
            step: 1,
            description: 'Approaching Järnvägsbron (450m)',
            vessels: [{
              mmsi: '211222520',
              name: 'INTER2',
              ...this._calculatePosition('jarnvagsbron', 450, 'north'),
              sog: 5.0,
              cog: 205,
            }],
          },
          {
            step: 2,
            description: 'Under Järnvägsbron (30m)',
            vessels: [{
              mmsi: '211222520',
              name: 'INTER2',
              ...this._calculatePosition('jarnvagsbron', 30, 'north'),
              sog: 5.0,
              cog: 205,
            }],
          },
        ],
      },
    ];
  }

  /**
   * Multi-Vessel Scenarios (5 scenarios)
   * 2-5 boats in various configurations
   */
  static _getMultiVesselScenarios() {
    return [
      {
        name: 'Multi: 2 vessels waiting at Klaffbron',
        description: 'Tests "Två båtar inväntar broöppning vid Klaffbron"',
        waypoints: [
          {
            step: 1,
            description: '2 boats both waiting at Klaffbron',
            vessels: [
              {
                mmsi: '246924000',
                name: 'BOAT1',
                ...this._calculatePosition('klaffbron', 280, 'south'),
                sog: 5.0,
                cog: 25,
              },
              {
                mmsi: '275514000',
                name: 'BOAT2',
                ...this._calculatePosition('klaffbron', 290, 'south'),
                sog: 5.0,
                cog: 25,
              },
            ],
          },
        ],
      },

      {
        name: 'Multi: 2 vessels same bridge (one waiting, one under-bridge)',
        description: 'Tests group behavior with under-bridge priority',
        waypoints: [
          {
            step: 1,
            description: 'One under-bridge, one waiting',
            vessels: [
              {
                mmsi: '246924000',
                name: 'BOAT1',
                ...this._calculatePosition('stridsbergsbron', 30, 'south'),
                sog: 5.0,
                cog: 25,
              },
              {
                mmsi: '275514000',
                name: 'BOAT2',
                ...this._calculatePosition('stridsbergsbron', 280, 'south'),
                sog: 5.0,
                cog: 25,
              },
            ],
          },
        ],
      },

      {
        name: 'Multi: 2 vessels different target bridges (semicolon)',
        description: 'Tests semicolon separation for different targets',
        waypoints: [
          {
            step: 1,
            description: 'One at Klaffbron, one at Stridsbergsbron',
            vessels: [
              {
                mmsi: '246924000',
                name: 'BOAT1',
                ...this._calculatePosition('klaffbron', 280, 'south'),
                sog: 5.0,
                cog: 25,
              },
              {
                mmsi: '275514000',
                name: 'BOAT2',
                ...this._calculatePosition('stridsbergsbron', 280, 'south'),
                sog: 5.0,
                cog: 25,
              },
            ],
          },
        ],
      },

      {
        name: 'Multi: 3 vessels at Klaffbron (mixed statuses)',
        description: 'Tests "Tre båtar..." message format',
        waypoints: [
          {
            step: 1,
            description: '3 boats at different distances',
            vessels: [
              {
                mmsi: '246924000',
                name: 'BOAT1',
                ...this._calculatePosition('klaffbron', 280, 'south'),
                sog: 5.0,
                cog: 25,
              },
              {
                mmsi: '275514000',
                name: 'BOAT2',
                ...this._calculatePosition('klaffbron', 300, 'south'),
                sog: 5.0,
                cog: 25,
              },
              {
                mmsi: '265727030',
                name: 'BOAT3',
                ...this._calculatePosition('klaffbron', 450, 'south'),
                sog: 5.0,
                cog: 25,
              },
            ],
          },
        ],
      },

      {
        name: 'Multi: 5 vessels at Stridsbergsbron',
        description: 'Tests "Fem båtar..." with count text helper',
        waypoints: [
          {
            step: 1,
            description: '5 boats waiting at Stridsbergsbron',
            vessels: [
              {
                mmsi: '246924000',
                name: 'BOAT1',
                ...this._calculatePosition('stridsbergsbron', 250, 'south'),
                sog: 5.0,
                cog: 25,
              },
              {
                mmsi: '275514000',
                name: 'BOAT2',
                ...this._calculatePosition('stridsbergsbron', 260, 'south'),
                sog: 5.0,
                cog: 25,
              },
              {
                mmsi: '265727030',
                name: 'BOAT3',
                ...this._calculatePosition('stridsbergsbron', 270, 'south'),
                sog: 5.0,
                cog: 25,
              },
              {
                mmsi: '265607140',
                name: 'BOAT4',
                ...this._calculatePosition('stridsbergsbron', 280, 'south'),
                sog: 5.0,
                cog: 25,
              },
              {
                mmsi: '265573130',
                name: 'BOAT5',
                ...this._calculatePosition('stridsbergsbron', 290, 'south'),
                sog: 5.0,
                cog: 25,
              },
            ],
          },
        ],
      },
    ];
  }

  /**
   * Edge Cases (5 scenarios)
   * Boundary conditions and special scenarios
   */
  static _getEdgeCases() {
    return [
      {
        name: 'Edge: Distance boundary 301m vs 299m',
        description: 'Tests precise waiting zone boundary',
        waypoints: [
          {
            step: 1,
            description: 'Just outside waiting zone (301m)',
            vessels: [{
              mmsi: '246924000',
              name: 'EDGE1',
              ...this._calculatePosition('klaffbron', 301, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
          {
            step: 2,
            description: 'Just inside waiting zone (299m)',
            vessels: [{
              mmsi: '246924000',
              name: 'EDGE1',
              ...this._calculatePosition('klaffbron', 299, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
        ],
      },

      {
        name: 'Edge: Distance boundary 51m vs 49m',
        description: 'Tests precise under-bridge boundary',
        waypoints: [
          {
            step: 1,
            description: 'Just outside under-bridge (51m)',
            vessels: [{
              mmsi: '246924000',
              name: 'EDGE2',
              ...this._calculatePosition('stridsbergsbron', 51, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
          {
            step: 2,
            description: 'Just inside under-bridge (49m)',
            vessels: [{
              mmsi: '246924000',
              name: 'EDGE2',
              ...this._calculatePosition('stridsbergsbron', 49, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
        ],
      },

      {
        name: 'Edge: No vessels (default message)',
        description: 'Tests empty vessel list returns default message',
        waypoints: [
          {
            step: 1,
            description: 'No vessels in system',
            vessels: [],
          },
        ],
      },

      {
        name: 'Edge: Vessel with missing name',
        description: 'Tests vessel without name property (should be filtered by app)',
        skipValidation: true, // This scenario intentionally has invalid data to test filtering
        waypoints: [
          {
            step: 1,
            description: 'Vessel without name (should be filtered)',
            vessels: [{
              mmsi: '999999999',
              // name intentionally missing
              ...this._calculatePosition('klaffbron', 280, 'south'),
              sog: 5.0,
              cog: 25,
            }],
          },
        ],
      },

      {
        name: 'Edge: Very slow vessel (0.5 knots)',
        description: 'Tests minimum speed fallback',
        waypoints: [
          {
            step: 1,
            description: 'Almost stationary vessel',
            vessels: [{
              mmsi: '246924000',
              name: 'SLOW',
              ...this._calculatePosition('klaffbron', 400, 'south'),
              sog: 0.5,
              cog: 25,
            }],
          },
        ],
      },
    ];
  }

  /**
   * Validate all scenarios for physical validity
   * Throws error if any scenario is physically impossible
   */
  static validate() {
    const scenarios = this.getAll();

    for (const scenario of scenarios) {
      // Skip validation for scenarios that intentionally test invalid data
      if (scenario.skipValidation) {
        console.log(`⚠️  Skipping validation for: ${scenario.name} (tests invalid data handling)`);
        continue;
      }

      for (const waypoint of scenario.waypoints) {
        for (const vessel of waypoint.vessels) {
          // Validate required properties
          if (!vessel.mmsi || !vessel.name) {
            throw new Error(
              `Scenario "${scenario.name}" step ${waypoint.step}: ` +
              `Vessel missing mmsi or name`,
            );
          }

          // Validate coordinates
          if (vessel.lat === undefined || vessel.lon === undefined) {
            throw new Error(
              `Scenario "${scenario.name}" step ${waypoint.step}: ` +
              `Vessel ${vessel.mmsi} missing coordinates`,
            );
          }

          // Validate speed
          if (vessel.sog !== undefined && (vessel.sog < 0 || vessel.sog > 20)) {
            throw new Error(
              `Scenario "${scenario.name}" step ${waypoint.step}: ` +
              `Vessel ${vessel.mmsi} has unrealistic speed: ${vessel.sog}kn`,
            );
          }

          // Validate COG
          if (vessel.cog !== undefined && (vessel.cog < 0 || vessel.cog >= 360)) {
            throw new Error(
              `Scenario "${scenario.name}" step ${waypoint.step}: ` +
              `Vessel ${vessel.mmsi} has invalid COG: ${vessel.cog}°`,
            );
          }
        }
      }
    }

    console.log(`✅ All ${scenarios.length} scenarios validated for physical validity`);
  }
}

module.exports = ScenarioLibrary;
