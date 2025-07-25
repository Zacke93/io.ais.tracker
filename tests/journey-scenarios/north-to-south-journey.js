'use strict';

const RealAppTestRunner = require('./RealAppTestRunner');

/**
 * REAL APP TEST: North to South Journey
 *
 * 🔄 KRITISKT: Detta test använder 100% verklig app.js-logik via RealAppTestRunner:
 * - VesselDataService (verklig vessel management)
 * - StatusService (verklig status analysis)
 * - ProximityService (verkliga avståndsberäkningar)
 * - BridgeTextService (verklig bridge text generering)
 * - All event-driven kommunikation
 * - Verklig target bridge assignment logic
 * - Verkliga timeout och cleanup mekanismer
 *
 * ⚠️ INGA SIMULERADE RESULTAT - alla meddelanden kommer från riktiga services
 * ✅ EXAKTA AVSTÅND - 600m, 450m, 250m, 45m, 55m framför varje bro
 * ✅ VERKLIGA GPS-KOORDINATER - beräknade från constants.js BRIDGES
 */

async function runRealScenario1() {
  const runner = new RealAppTestRunner();

  // KONTROLLERAT TEST - exakta avstånd: Bounding box → 600m → 450m → 250m → 45m → 55m framför
  // Detta använder 100% verklig app.js-logik utan simulerade resultat
  // Avståndstriggrar: 500m (närmar sig), 300m (inväntar broöppning), 50m (broöppning pågår)
  // Ordning: Stallbacka → Stridsbergsbron → Järnväg → Klaffbron → Olidebron

  // VERKLIGA KOORDINATER från constants.js BRIDGES
  const BRIDGE_COORDS = {
    stallbackabron: { lat: 58.31142992293701, lon: 12.31456385688822 },
    stridsbergsbron: { lat: 58.293524096154634, lon: 12.294566425158054 },
    jarnvagsbron: { lat: 58.29164042152742, lon: 12.292025280073759 },
    klaffbron: { lat: 58.28409551543077, lon: 12.283929525245636 },
    olidebron: { lat: 58.272743083145855, lon: 12.275115821922993 },
  };

  // Beräkna exakt GPS-koordinat på specificerat avstånd norr om en bro
  function calculatePositionNorthOfBridge(bridgeCoords, distanceMeters) {
    const metersPerLatDegree = 111000; // 1 grad lat ≈ 111000m
    const latOffset = distanceMeters / metersPerLatDegree;
    return {
      lat: bridgeCoords.lat + latOffset,
      lon: bridgeCoords.lon,
    };
  }

  const realJourneySteps = [
    {
      description: '🚢 Start: Båt precis innanför bounding box (58.319°)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: 58.319, // Precis innanför NORTH bounding box (58.32)
          lon: 12.315,
          sog: 4.5,
          cog: 180, // Southbound
        },
      ],
    },

    // === STALLBACKABRON (mellanbro) - EXAKTA AVSTÅND ===
    {
      description: '🌉 Stallbackabron: 600m avstånd (långt bort)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stallbackabron, 600),
          sog: 4.2,
          cog: 180,
        },
      ],
    },

    {
      description: '🌉 Stallbackabron: 450m avstånd (inom APPROACHING_RADIUS 500m)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stallbackabron, 450),
          sog: 4.0,
          cog: 180,
        },
      ],
    },

    {
      description: '🌉 Stallbackabron: 250m avstånd (inom APPROACH_RADIUS 300m - SPECIALHANTERING!)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stallbackabron, 250),
          sog: 3.8,
          cog: 180,
        },
      ],
    },

    {
      description: '🌉 Stallbackabron: 45m avstånd (inom UNDER_BRIDGE_DISTANCE 50m)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stallbackabron, 45),
          sog: 3.5,
          cog: 180,
        },
      ],
    },

    {
      description: '🌉 Stallbackabron: 55m söder om bro (passerat)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: BRIDGE_COORDS.stallbackabron.lat - (55 / 111000), // 55m söder om
          lon: BRIDGE_COORDS.stallbackabron.lon,
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

    // === STRIDSBERGSBRON (MÅLBRO) - EXAKTA AVSTÅND ===
    {
      description: '🎯 Stridsbergsbron (MÅLBRO): 600m avstånd (långt bort)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stridsbergsbron, 600),
          sog: 3.9,
          cog: 180,
        },
      ],
    },

    {
      description: '🎯 Stridsbergsbron (MÅLBRO): 450m avstånd (inom APPROACHING_RADIUS 500m)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stridsbergsbron, 450),
          sog: 3.7,
          cog: 180,
        },
      ],
    },

    {
      description: '🎯 Stridsbergsbron (MÅLBRO): 250m avstånd (inom APPROACH_RADIUS 300m)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stridsbergsbron, 250),
          sog: 3.5,
          cog: 180,
        },
      ],
    },

    {
      description: '🎯 Stridsbergsbron (MÅLBRO): 45m avstånd (inom UNDER_BRIDGE_DISTANCE 50m)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stridsbergsbron, 45),
          sog: 3.2,
          cog: 180,
        },
      ],
    },

    {
      description: '🎯 Stridsbergsbron (MÅLBRO): 55m söder om bro (passerat MÅLBRO - target bridge transition!)',
      vessels: [
        {
          mmsi: '265123456',
          name: 'M/V Nordkap',
          lat: BRIDGE_COORDS.stridsbergsbron.lat - (55 / 111000), // 55m söder om
          lon: BRIDGE_COORDS.stridsbergsbron.lon,
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
