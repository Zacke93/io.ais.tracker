'use strict';

const RealAppTestRunner = require('./RealAppTestRunner');

/**
 * CONTROLLED NORTH TO SOUTH JOURNEY TEST
 *
 * 🎯 EXAKT KONTROLLERAT TEST för manuell verifiering
 *
 * Detta test är designat för att du ska kunna följa varje steg manuellt:
 * 1. Fartyg startar precis innanför bounding box
 * 2. Sedan exakt 600m, 450m, 250m, 45m från varje bro
 * 3. Slutligen 55m framför bro (passerat)
 *
 * KRITISKT: Testet använder 100% verklig app.js-logik via RealAppTestRunner
 * - Inga simulerade resultat
 * - Inga hårdkodade bridge text-svar
 * - Alla meddelanden kommer från den riktiga BridgeTextService
 * - Alla statusar kommer från den riktiga StatusService
 * - Alla avståndsberäkningar kommer från den riktiga ProximityService
 *
 * AVSTÅNDSTRIGGRAR (från constants.js):
 * - 500m: APPROACHING_RADIUS - "närmar sig" meddelanden
 * - 300m: APPROACH_RADIUS - "inväntar broöppning" meddelanden
 * - 50m:  UNDER_BRIDGE_DISTANCE - "broöppning pågår" meddelanden
 */

async function controlledNorthToSouthJourney() {
  console.log('\n🎯 CONTROLLED NORTH TO SOUTH JOURNEY TEST');
  console.log('='.repeat(70));
  console.log('📋 MANUELL VERIFIERING - Följ varje steg noggrant');
  console.log('🔄 100% verklig app.js-logik - inga simulerade resultat');
  console.log('📏 Exakta avstånd: Bounding box → 600m → 450m → 250m → 45m → 55m framför');
  console.log('='.repeat(70));

  const runner = new RealAppTestRunner();

  // VERKLIGA KOORDINATER från constants.js BRIDGES
  const BRIDGE_COORDS = {
    stallbackabron: { lat: 58.31142992293701, lon: 12.31456385688822 },
    stridsbergsbron: { lat: 58.293524096154634, lon: 12.294566425158054 },
    jarnvagsbron: { lat: 58.29164042152742, lon: 12.292025280073759 },
    klaffbron: { lat: 58.28409551543077, lon: 12.283929525245636 },
    olidebron: { lat: 58.272743083145855, lon: 12.275115821922993 },
  };

  // BOUNDING BOX från constants.js AIS_CONFIG
  const BOUNDING_BOX = {
    NORTH: 58.32,
    SOUTH: 58.26,
    EAST: 12.32,
    WEST: 12.26,
  };

  /**
   * Beräkna exakt GPS-koordinat på specificerat avstånd norr om en bro
   * Använder samma matematik som app.js använder för avståndsberäkningar
   */
  function calculatePositionNorthOfBridge(bridgeCoords, distanceMeters) {
    // Approximation: 1 grad lat ≈ 111000m, 1 grad lon ≈ 56000m (vid Sverige)
    const metersPerLatDegree = 111000;
    const latOffset = distanceMeters / metersPerLatDegree;

    return {
      lat: bridgeCoords.lat + latOffset,
      lon: bridgeCoords.lon, // Samma longitud, bara norr om
    };
  }

  const controlledJourneySteps = [

    // === STEG 1: Precis innanför bounding box ===
    {
      description: '🚢 STEG 1: Fartyg precis innanför NORTH bounding box (58.32°)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        lat: BOUNDING_BOX.NORTH - 0.001, // 58.319 - precis innanför
        lon: 12.315, // Mitt i bounding box longitudwise
        sog: 4.0, // Konstant hastighet för förutsägbarhet
        cog: 180, // Rakt söderut
      }],
      analysisNote: 'Fartyget ska upptäckts av systemet och få en målbro tilldelad baserat på COG 180° (söderut)',
      expectedBehavior: 'COG 180° = söderut → ska få Stridsbergsbron som målbro (första målbro söderut)',
    },

    // === STEG 2: 600m norr om Stallbackabron ===
    {
      description: '🌉 STEG 2: 600m norr om Stallbackabron (mellanbro)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stallbackabron, 600),
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: '600m > 500m APPROACHING_RADIUS - ska visa "på väg mot" meddelande',
      expectedBehavior: 'Stallbackabron är mellanbro, målbro fortfarande Stridsbergsbron. Meddelande: "på väg mot Stridsbergsbron"',
    },

    // === STEG 3: 450m norr om Stallbackabron ===
    {
      description: '🌉 STEG 3: 450m norr om Stallbackabron (inom APPROACHING_RADIUS)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stallbackabron, 450),
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: '450m < 500m APPROACHING_RADIUS - KRITISK: Stallbackabron specialhantering!',
      expectedBehavior: 'Stallbackabron special: "En båt närmar sig Stallbackabron" ELLER "vid Stallbackabron närmar sig Stridsbergsbron"',
    },

    // === STEG 4: 250m norr om Stallbackabron ===
    {
      description: '🌉 STEG 4: 250m norr om Stallbackabron (inom APPROACH_RADIUS)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stallbackabron, 250),
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: '250m < 300m APPROACH_RADIUS - KRITISK: Stallbackabron får ALDRIG "inväntar broöppning"!',
      expectedBehavior: 'Stallbackabron special: "åker strax under Stallbackabron" INTE "inväntar broöppning"',
    },

    // === STEG 5: 45m norr om Stallbackabron ===
    {
      description: '🌉 STEG 5: 45m norr om Stallbackabron (inom UNDER_BRIDGE_DISTANCE)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stallbackabron, 45),
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: '45m < 50m UNDER_BRIDGE_DISTANCE - under-bridge status',
      expectedBehavior: 'Stallbackabron special: "En båt passerar Stallbackabron" INTE "broöppning pågår"',
    },

    // === STEG 6: 55m söder om Stallbackabron (passerat) ===
    {
      description: '🌉 STEG 6: 55m söder om Stallbackabron (passerat)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        lat: BRIDGE_COORDS.stallbackabron.lat - (55 / 111000), // 55m söder om
        lon: BRIDGE_COORDS.stallbackabron.lon,
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: 'Fartyg har passerat Stallbackabron - ska återgå till normal logik',
      expectedBehavior: '"En båt på väg mot Stridsbergsbron" - Stallbackabron specialhantering ska upphöra',
    },

    // === STEG 7: 600m norr om Stridsbergsbron (målbro) ===
    {
      description: '🎯 STEG 7: 600m norr om Stridsbergsbron (MÅLBRO)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stridsbergsbron, 600),
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: '600m > 500m från MÅLBRO - ska visa "på väg mot" med ETA',
      expectedBehavior: '"En båt på väg mot Stridsbergsbron, beräknad broöppning om X minuter"',
    },

    // === STEG 8: 450m norr om Stridsbergsbron ===
    {
      description: '🎯 STEG 8: 450m norr om Stridsbergsbron (APPROACHING_RADIUS)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stridsbergsbron, 450),
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: '450m < 500m från MÅLBRO - ska visa "närmar sig"',
      expectedBehavior: '"En båt närmar sig Stridsbergsbron" ELLER med ETA om systemet beräknar det',
    },

    // === STEG 9: 250m norr om Stridsbergsbron ===
    {
      description: '🎯 STEG 9: 250m norr om Stridsbergsbron (APPROACH_RADIUS)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stridsbergsbron, 250),
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: '250m < 300m från MÅLBRO - ska visa "inväntar broöppning"',
      expectedBehavior: '"En båt inväntar broöppning vid Stridsbergsbron" (UTAN ETA för målbro)',
    },

    // === STEG 10: 45m norr om Stridsbergsbron ===
    {
      description: '🎯 STEG 10: 45m norr om Stridsbergsbron (UNDER_BRIDGE_DISTANCE)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        ...calculatePositionNorthOfBridge(BRIDGE_COORDS.stridsbergsbron, 45),
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: '45m < 50m från MÅLBRO - ska visa "broöppning pågår"',
      expectedBehavior: '"Broöppning pågår vid Stridsbergsbron" (högsta prioritet)',
    },

    // === STEG 11: 55m söder om Stridsbergsbron (passerat målbro) ===
    {
      description: '🎯 STEG 11: 55m söder om Stridsbergsbron (passerat MÅLBRO)',
      vessels: [{
        mmsi: '265CONTROL',
        name: 'M/V KONTROLL',
        lat: BRIDGE_COORDS.stridsbergsbron.lat - (55 / 111000), // 55m söder om
        lon: BRIDGE_COORDS.stridsbergsbron.lon,
        sog: 4.0,
        cog: 180,
      }],
      analysisNote: 'KRITISK: Fartyg har passerat sin målbro - target bridge transition!',
      expectedBehavior: 'Ny målbro: Klaffbron (nästa söderut). "En båt har precis passerat Stridsbergsbron på väg mot Klaffbron"',
    },

    // === STEG 12: Cleanup test ===
    {
      description: '🧹 STEG 12: Fartyg försvinner (cleanup test)',
      vessels: [], // Inga fartyg
      analysisNote: 'System ska återgå till default-meddelande',
      expectedBehavior: '"Inga båtar är i närheten av Klaffbron eller Stridsbergsbron"',
    },
  ];

  try {
    console.log(`\n🚀 Startar kontrollerat test med ${controlledJourneySteps.length} exakta steg...\n`);

    const results = await runner.runRealJourney(
      'CONTROLLED NORTH TO SOUTH JOURNEY',
      controlledJourneySteps,
    );

    // MANUELL VERIFIERINGSGUIDE
    console.log('\n📋 MANUELL VERIFIERINGSGUIDE:');
    console.log('='.repeat(50));
    console.log('För varje steg ovan, kontrollera att:');
    console.log('1. 📍 Position: GPS-koordinater är korrekta relativt broarna');
    console.log('2. 🎯 Målbro: Korrekt målbro tilldelad baserat på COG och position');
    console.log('3. 📊 Status: Korrekt status baserat på avstånd (en-route/approaching/waiting/under-bridge/passed)');
    console.log('4. 💬 Bridge Text: Meddelande matchar förväntad behavior');
    console.log('5. 🌉 Stallbackabron: Specialhantering fungerar (ALDRIG "inväntar broöppning")');
    console.log('6. 🔄 Target Transition: Målbro växlar från Stridsbergsbron → Klaffbron efter passage');

    // KRITISKA KONTROLLPUNKTER
    console.log('\n🔍 KRITISKA KONTROLLPUNKTER:');
    console.log('='.repeat(50));
    console.log('✅ STEG 1: Målbro assignment (COG 180° → Stridsbergsbron)');
    console.log('✅ STEG 3-5: Stallbackabron specialhantering (ej "inväntar broöppning")');
    console.log('✅ STEG 8: 500m rule - "närmar sig" trigger');
    console.log('✅ STEG 9: 300m rule - "inväntar broöppning" trigger');
    console.log('✅ STEG 10: 50m rule - "broöppning pågår" trigger');
    console.log('✅ STEG 11: Target bridge transition efter passage');

    console.log('\n📐 GPS-KOORDINATER ANVÄNDA:');
    console.log('='.repeat(50));
    controlledJourneySteps.forEach((step, index) => {
      if (step.vessels.length > 0) {
        const vessel = step.vessels[0];
        console.log(`STEG ${index + 1}: lat=${vessel.lat?.toFixed(6)}, lon=${vessel.lon?.toFixed(6)}`);
      }
    });

    return results;

  } catch (error) {
    console.error('❌ Controlled North to South Journey failed:', error);
    throw error;
  } finally {
    await runner.cleanup();
  }
}

// Export for use by other modules
module.exports = controlledNorthToSouthJourney;

// Run test if called directly
if (require.main === module) {
  controlledNorthToSouthJourney()
    .then(() => {
      console.log('\n🎉 Controlled North to South Journey completed!');
      console.log('📋 Review the output above for manual verification');
    })
    .catch((error) => {
      console.error('\n💥 Controlled North to South Journey failed:', error);
      throw error;
    });
}
