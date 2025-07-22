'use strict';

const RealAppTestRunner = require('./RealAppTestRunner');

/**
 * REAL APP TEST: North to South Journey
 *
 * This test uses the COMPLETE app.js logic including:
 * - VesselDataService (real vessel management)
 * - StatusService (real status analysis)
 * - ProximityService (real distance calculations)
 * - BridgeTextService (real bridge text generation)
 * - All event-driven communication
 * - Real target bridge assignment logic
 * - Real timeout and cleanup mechanisms
 */

async function runRealScenario1() {
  const runner = new RealAppTestRunner();

  // DETALJERAT TEST - varje bro testas vid exakt 300m och 50m avstånd
  // Detta visar exakt när approach (300m) och under-bridge (50m) triggers
  // Ordning: Stallbacka → Stridsbergsbron → Järnväg → Klaffbron → Olidebron
  const realJourneySteps = [
    {
      description: '🚢 Start: Båt långt norr om alla broar',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.320, // Far north
          lon: 12.320,
          sog: 4.5,
          cog: 180, // Southbound
        },
      ],
    },

    // === STALLBACKABRON (mellanbro) ===
    {
      description: '📍 Stallbackabron: 300m avstånd (approach radius)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.31415, // ~300m north of Stallbacka
          lon: 12.31726,
          sog: 4.2,
          cog: 180,
        },
      ],
    },

    {
      description: '📍 Stallbackabron: 50m avstånd (under-bridge zone)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.31188, // ~50m north of Stallbacka
          lon: 12.31501,
          sog: 3.8,
          cog: 180,
        },
      ],
    },

    {
      description: '📍 Mellan Stallbacka och Stridsbergsbron',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.302, // Between bridges
          lon: 12.305,
          sog: 4.0,
          cog: 180,
        },
      ],
    },

    // === STRIDSBERGSBRON (MÅLBRO) ===
    {
      description: '🎯 Stridsbergsbron (MÅLBRO): 300m avstånd (approach radius)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.2962, // ~300m north of Stridsbergsbron
          lon: 12.2972,
          sog: 3.9,
          cog: 180,
        },
      ],
    },

    {
      description: '🎯 Stridsbergsbron (MÅLBRO): 50m avstånd (under-bridge zone)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.29397, // ~50m north of Stridsbergsbron
          lon: 12.29501,
          sog: 3.5,
          cog: 180,
        },
      ],
    },

    {
      description: '📍 Mellan Stridsbergsbron och Järnvägsbron',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.2926, // Between bridges
          lon: 12.2930,
          sog: 4.1,
          cog: 180,
        },
      ],
    },

    // === JÄRNVÄGSBRON (mellanbro) ===
    {
      description: '📍 Järnvägsbron: 300m avstånd (approach radius)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.29437, // ~300m north of Järnvägsbron
          lon: 12.29472,
          sog: 3.8,
          cog: 180,
        },
      ],
    },

    {
      description: '📍 Järnvägsbron: 50m avstånd (under-bridge zone)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.29209, // ~50m north of Järnvägsbron
          lon: 12.29247,
          sog: 3.6,
          cog: 180,
        },
      ],
    },

    {
      description: '📍 Mellan Järnvägsbron och Klaffbron',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.288, // Between bridges
          lon: 12.288,
          sog: 3.9,
          cog: 180,
        },
      ],
    },

    // === KLAFFBRON (MÅLBRO) ===
    {
      description: '🎯 Klaffbron (MÅLBRO): 300m avstånd (approach radius)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.2868, // ~300m north of Klaffbron
          lon: 12.2866,
          sog: 3.7,
          cog: 180,
        },
      ],
    },

    {
      description: '🎯 Klaffbron (MÅLBRO): 100m avstånd (approaching)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.2849, // ~100m north of Klaffbron
          lon: 12.2847,
          sog: 3.2,
          cog: 180,
        },
      ],
    },

    {
      description: '🎯 Klaffbron (MÅLBRO): Saktar ner och väntar (waiting test)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.28450, // Close to Klaffbron
          lon: 12.28430,
          sog: 0.15, // Very slow - should trigger waiting
          cog: 180,
        },
      ],
      delaySeconds: 3,
    },

    {
      description: '🎯 Klaffbron (MÅLBRO): 50m avstånd (under-bridge zone)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.28454, // ~50m north of Klaffbron
          lon: 12.28438,
          sog: 3.0,
          cog: 180,
        },
      ],
    },

    {
      description: '📍 Mellan Klaffbron och Olidebron',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.278, // Between bridges
          lon: 12.279,
          sog: 4.0,
          cog: 180,
        },
      ],
    },

    // === OLIDEBRON (mellanbro) ===
    {
      description: '📍 Olidebron: 300m avstånd (approach radius)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.2755, // ~300m north of Olidebron
          lon: 12.2778,
          sog: 3.9,
          cog: 180,
        },
      ],
    },

    {
      description: '📍 Olidebron: 50m avstånd (under-bridge zone)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.27319, // ~50m north of Olidebron
          lon: 12.27556,
          sog: 3.6,
          cog: 180,
        },
      ],
    },

    {
      description: '🏁 Sluttest: Båt långt söder om alla broar',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.268, // Far south
          lon: 12.270,
          sog: 4.2,
          cog: 180,
        },
      ],
    },

    {
      description: '🗑️ Cleanup: Båt försvinner från systemet',
      vessels: [], // Empty = simulate vessel cleanup
    },
  ];

  try {
    console.log('🚀 Starting REAL APP Journey Test...\n');

    const results = await runner.runRealJourney(
      'REAL APP: North to South Complete Journey',
      realJourneySteps,
    );

    console.log('\n🔍 REAL APP ANALYSIS:');
    console.log('- Detta testar HELA app.js kedjan, inte bara BridgeTextService');
    console.log('- Inkluderar verklig målbro-tilldelning baserat på COG och position');
    console.log('- Inkluderar verklig status-analys (approaching/waiting/under-bridge)');
    console.log('- Inkluderar verklig avståndsberäkning och ETA');
    console.log('- Inkluderar verklig timeout och cleanup logik');
    console.log('- Inkluderar verklig event-driven kommunikation mellan services');

    console.log('\n💡 NU KAN VI SE:');
    console.log('1. Exakt hur målbro tilldelas automatiskt');
    console.log('2. Exakt när status ändras från approaching → waiting → under-bridge');
    console.log('3. Exakt hur ETA beräknas från verklig hastighet och avstånd');
    console.log('4. Exakt hur bridge_text genereras från verklig data');
    console.log('5. Alla problem i den verkliga logiken, inte bara BridgeTextService');

    return results;

  } catch (error) {
    console.error('❌ Error during real app test:', error);
    throw error;
  } finally {
    await runner.cleanup();
  }
}

// Run the test
if (require.main === module) {
  runRealScenario1()
    .then(() => {
      console.log('\n✅ Real app test completed successfully!');
    })
    .catch((error) => {
      console.error('❌ Real app test failed:', error);
      throw error;
    });
}

module.exports = runRealScenario1;
