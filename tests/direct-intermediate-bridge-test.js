'use strict';

/**
 * DIREKT TEST: Intermediate Bridge Text Generation
 *
 * Testar BridgeTextService direkt utan hela app-logiken
 */

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

// Mock logger
const mockLogger = {
  log: console.log,
  error: console.error,
  debug: console.log,
};

describe('🔧 DIREKT INTERMEDIATE BRIDGE TEST', () => {

  test('BridgeTextService direkt - Järnvägsbron under-bridge → målbro Stridsbergsbron', async () => {
    console.log('\n🔧 DIREKT TEST: BridgeTextService intermediate bridge');

    const bridgeRegistry = new BridgeRegistry(mockLogger);
    const bridgeTextService = new BridgeTextService(bridgeRegistry, mockLogger);

    // Skapa en vessel som är under-bridge vid Järnvägsbron, på väg mot Stridsbergsbron
    const vessel = {
      mmsi: '999000001',
      name: 'M/S Direct Test',
      lat: 58.291640, // Exakt Järnvägsbron lat
      lon: 12.292025, // Exakt Järnvägsbron lon
      sog: 3.0,
      cog: 25,
      status: 'under-bridge',
      currentBridge: 'Järnvägsbron',
      targetBridge: 'Stridsbergsbron', // KRITISK: Ska grupperas under Stridsbergsbron
      etaMinutes: 1.5,
    };

    console.log('📋 VESSEL INPUT:');
    console.log(`   MMSI: ${vessel.mmsi}`);
    console.log(`   Status: ${vessel.status}`);
    console.log(`   CurrentBridge: ${vessel.currentBridge}`);
    console.log(`   TargetBridge: ${vessel.targetBridge}`);
    console.log(`   ETA: ${vessel.etaMinutes} minuter`);

    // Generera bridge text direkt
    const bridgeText = bridgeTextService.generateBridgeText([vessel]);

    console.log('\n📊 RESULTAT:');
    console.log(`🔍 Bridge text: "${bridgeText}"`);

    // KRITISK VALIDERING
    console.log('\n✅ VALIDERING:');

    if (bridgeText.includes('Broöppning pågår vid Järnvägsbron')) {
      console.log('   ✓ Visar intermediate bridge (Järnvägsbron)');
    } else {
      console.log('   ❌ Visar INTE intermediate bridge');
    }

    if (bridgeText.includes('Stridsbergsbron')) {
      console.log('   ✓ Visar målbro (Stridsbergsbron)');
    } else {
      console.log('   ❌ Visar INTE målbro');
    }

    if (bridgeText.includes('beräknad broöppning av Stridsbergsbron')) {
      console.log('   ✓ Korrekt format med "av [målbro]"');
    } else {
      console.log('   ❌ Felaktigt format');
    }

    // Jest assertions
    expect(bridgeText).toContain('Broöppning pågår vid Järnvägsbron');
    expect(bridgeText).toContain('Stridsbergsbron');
    expect(bridgeText).toContain('beräknad broöppning av Stridsbergsbron');

    console.log('\n🎯 DIRECT TEST SLUTFÖRD - Intermediate bridge fix verifierad!');

  });

});

// Kör testet
if (require.main === module) {
  console.log('🔧 RUNNING DIRECT INTERMEDIATE BRIDGE TEST...');

  const bridgeRegistry = new BridgeRegistry({
    log: console.log,
    error: console.error,
    debug: console.log,
  });

  const bridgeTextService = new BridgeTextService(bridgeRegistry, {
    log: console.log,
    error: console.error,
    debug: console.log,
  });

  const vessel = {
    mmsi: '999000001',
    name: 'M/S Direct Test',
    lat: 58.291640,
    lon: 12.292025,
    sog: 3.0,
    cog: 25,
    status: 'under-bridge',
    currentBridge: 'Järnvägsbron',
    targetBridge: 'Stridsbergsbron',
    etaMinutes: 1.5,
  };

  console.log('\n📋 TESTING VESSEL:');
  console.log(vessel);

  const result = bridgeTextService.generateBridgeText([vessel]);
  console.log('\n📊 BRIDGE TEXT RESULT:');
  console.log(`"${result}"`);

  const hasIntermediate = result.includes('Broöppning pågår vid Järnvägsbron');
  const hasTarget = result.includes('Stridsbergsbron');
  const hasCorrectFormat = result.includes('beräknad broöppning av Stridsbergsbron');

  console.log('\n✅ ANALYSIS:');
  console.log(`   Intermediate bridge: ${hasIntermediate ? '✓' : '❌'}`);
  console.log(`   Target bridge: ${hasTarget ? '✓' : '❌'}`);
  console.log(`   Correct format: ${hasCorrectFormat ? '✓' : '❌'}`);

  if (hasIntermediate && hasTarget && hasCorrectFormat) {
    console.log('\n🎉 SUCCESS: Intermediate bridge fix working correctly!');
  } else {
    console.log('\n❌ FAILURE: Intermediate bridge fix not working');
  }
}
