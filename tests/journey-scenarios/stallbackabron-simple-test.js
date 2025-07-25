/**
 * STALLBACKABRON SIMPLIFIED TEST
 * Tests Stallbackabron special messages in clean, readable format
 * Focus: Journey from north bounding box → through Stallbackabron → cleanup
 */

const RealAppTestRunner = require('./RealAppTestRunner');

class StallbackabronSimpleTest {
  constructor() {
    this.runner = new RealAppTestRunner();
    this.stepEmojis = ['🎯', '🚢', '⚡', '🌉', '🔥', '✨', '🎉', '🧹'];
    this.steps = [
      {
        title: '🎯 STEG 1: Fartyg precis innanför NORTH bounding box (58.32°)',
        position: { lat: 58.31900, lon: 12.31500 },
        description: 'Initial detection, should get target bridge assignment',
      },
      {
        title: '🚢 STEG 2: 600m norr om Stallbackabron (mellanbro)',
        position: { lat: 58.31684, lon: 12.31456 },
        description: 'Approaching intermediate bridge, should show en-route to target',
      },
      {
        title: '⚡ STEG 3: 450m norr om Stallbackabron (inom APPROACHING_RADIUS)',
        position: { lat: 58.31548, lon: 12.31456 },
        description: 'Should trigger "En båt närmar sig Stallbackabron"',
      },
      {
        title: '🌉 STEG 4: 250m norr om Stallbackabron (inom APPROACH_RADIUS)',
        position: { lat: 58.31368, lon: 12.31456 },
        description: 'Should trigger "En båt åker strax under Stallbackabron"',
      },
      {
        title: '🔥 STEG 5: 45m norr om Stallbackabron (inom UNDER_BRIDGE_DISTANCE)',
        position: { lat: 58.31184, lon: 12.31456 },
        description: 'Should trigger "En båt passerar Stallbackabron"',
      },
      {
        title: '✨ STEG 6: 55m söder om Stallbackabron (precis passerat)',
        position: { lat: 58.31093, lon: 12.31456 },
        description: 'Should trigger "En båt har precis passerat Stallbackabron på väg mot..."',
      },
      {
        title: '🎉 STEG 7: 200m söder om Stallbackabron (långt passerat)',
        position: { lat: 58.30962, lon: 12.31456 },
        description: 'Should still show "precis passerat" message (1 minute hold)',
      },
      {
        title: '🧹 STEG 8: Båt försvinner från systemet (cleanup)',
        position: null,
        description: 'Simulate vessel removal, should return to "Inga båtar..."',
      },
    ];
  }

  async run() {
    console.log('🎯 STALLBACKABRON SIMPLIFIED TEST');
    console.log('='.repeat(70));
    console.log('📋 FOKUS: Stallbackabron specialmeddelanden i läsbar format');
    console.log('🔄 100% verklig app.js-logik - inga simulerade resultat');
    console.log('🌉 Testar alla Stallbackabron specialregler');
    console.log('='.repeat(70));
    console.log();

    await this.runner.initializeApp();

    const bridgeTextChanges = [];
    let previousBridgeText = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';

    // Execute each step
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      const stepNumber = i + 1;
      const emoji = this.stepEmojis[i] || '🔸';

      console.log(`${emoji} ${step.title}`);
      console.log('-'.repeat(50));

      if (step.position) {
        // Send AIS message
        const vessel = {
          mmsi: '265CONTROL',
          name: 'M/V KONTROLL',
          lat: step.position.lat,
          lon: step.position.lon,
          sog: 4.0, // 4 knots
          cog: 180, // Heading south
          timestamp: Date.now(),
        };

        await this.runner._processVesselAsAISMessage(vessel);
      } else {
        // Cleanup step - remove vessel
        this.runner.app.vesselDataService.removeVessel('265CONTROL', 'test-cleanup');
      }

      // Get current bridge text using the same method as RealAppTestRunner
      const relevantVessels = this.runner.app._findRelevantBoatsForBridgeText();
      const currentBridgeText = this.runner.app.bridgeTextService.generateBridgeText(relevantVessels);

      // Check if bridge text changed
      if (currentBridgeText !== previousBridgeText) {
        const vessels = this.getActiveVessels();
        bridgeTextChanges.push({
          step: stepNumber,
          emoji,
          title: step.title,
          from: previousBridgeText,
          to: currentBridgeText,
          vessels,
        });
        console.log('🔄 BRIDGE TEXT CHANGED!');
      } else {
        console.log('✅ No bridge text change');
      }

      console.log(`📢 CURRENT: "${currentBridgeText}"`);

      // Show vessel details if any
      const vessels = this.getActiveVessels();
      console.log(`📊 VESSELS: ${vessels.length} active`);
      if (vessels.length > 0) {
        vessels.forEach((v) => {
          console.log(`   • ${v.name} (${v.mmsi}): ${v.status} → ${v.targetBridge || 'no-target'}`);
          if (v._distanceToNearest) console.log(`     Distance: ${v._distanceToNearest.toFixed(0)}m, ETA: ${v.etaMinutes?.toFixed(1) || 'N/A'}min`);
        });
      }

      previousBridgeText = currentBridgeText;
      console.log();
    }

    // Show summary
    this.showSummary(bridgeTextChanges);
  }

  getActiveVessels() {
    if (!this.runner.app?.vesselDataService) return [];
    return this.runner.app.vesselDataService.getAllVessels();
  }

  showSummary(bridgeTextChanges) {
    console.log('='.repeat(70));
    console.log('📋 STALLBACKABRON TEST SUMMARY');
    console.log('='.repeat(70));
    console.log(`🎬 Total steps: ${this.steps.length}`);
    console.log(`🔄 Bridge text changes: ${bridgeTextChanges.length}`);
    console.log();

    console.log('📝 All Bridge Text Changes:');
    console.log();

    bridgeTextChanges.forEach((change, index) => {
      console.log(`  ${index + 1}. ${change.emoji} ${change.title}`);
      console.log(`     From: "${change.from}"`);
      console.log(`     To:   "${change.to}"`);
      console.log(`     Vessels: ${change.vessels.length} active`);

      if (change.vessels.length > 0) {
        change.vessels.forEach((v) => {
          const distance = v._distanceToNearest ? `${v._distanceToNearest.toFixed(0)}m` : 'N/A';
          const eta = v.etaMinutes ? `${v.etaMinutes.toFixed(1)}min` : 'N/A';
          console.log(`       - ${v.name}: ${v.status} → ${v.targetBridge || 'no-target'} (${distance}, ${eta})`);
        });
      }
      console.log();
    });

    console.log('🔍 STALLBACKABRON VERIFICATION CHECKLIST:');
    console.log('='.repeat(50));
    console.log('✅ STEG 3: Should show "En båt närmar sig Stallbackabron"');
    console.log('✅ STEG 4: Should show "En båt åker strax under Stallbackabron"');
    console.log('✅ STEG 5: Should show "En båt passerar Stallbackabron"');
    console.log('✅ STEG 6: Should show "En båt har precis passerat Stallbackabron på väg mot..."');
    console.log('✅ STEG 7: Should still show "precis passerat" (1 min hold)');
    console.log('✅ STEG 8: Should return to "Inga båtar är i närheten..."');
    console.log();
    console.log('🎉 Stallbackabron Simple Test completed!');
  }
}

// Run the test
if (require.main === module) {
  const test = new StallbackabronSimpleTest();
  test.run().catch(console.error);
}

module.exports = StallbackabronSimpleTest;
