'use strict';

/**
 * Simple test to debug under-bridge issue
 */

const RealAppTestRunner = require('./tests/journey-scenarios/RealAppTestRunner');

async function testUnderBridge() {
  console.log('🔍 Testing under-bridge issue');

  const testRunner = new RealAppTestRunner();
  await testRunner.initializeApp();

  // Step 4: TUNA waiting at Klaffbron
  console.log('\n📍 Step 4: TUNA waiting at Klaffbron');
  await testRunner._processVesselAsAISMessage({
    mmsi: '244321000',
    name: 'TUNA',
    lat: 58.28293,
    lon: 12.28340,
    sog: 2.8,
    cog: 15.7,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const vessels4 = testRunner.app.vesselDataService.getAllVessels();
  console.log('Step 4 vessel state:', vessels4.map((v) => ({
    mmsi: v.mmsi,
    status: v.status,
    targetBridge: v.targetBridge,
    currentBridge: v.currentBridge,
    distanceToCurrent: v.distanceToCurrent,
  })));

  // Step 5: TUNA under Klaffbron
  console.log('\n📍 Step 5: TUNA under Klaffbron');
  await testRunner._processVesselAsAISMessage({
    mmsi: '244321000',
    name: 'TUNA',
    lat: 58.28410,
    lon: 12.28393,
    sog: 2.8,
    cog: 15.7,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const vessels5 = testRunner.app.vesselDataService.getAllVessels();
  console.log('Step 5 vessel state:', vessels5.map((v) => ({
    mmsi: v.mmsi,
    status: v.status,
    targetBridge: v.targetBridge,
    currentBridge: v.currentBridge,
    distanceToCurrent: v.distanceToCurrent,
  })));

  // Generate bridge text manually
  const relevantVessels = testRunner.app._findRelevantBoatsForBridgeText();
  console.log('Relevant vessels:', relevantVessels.map((v) => ({
    mmsi: v.mmsi,
    status: v.status,
    targetBridge: v.targetBridge,
    currentBridge: v.currentBridge,
    distance: v.distance,
  })));

  const bridgeText = testRunner.app.bridgeTextService.generateBridgeText(relevantVessels);
  console.log('Bridge text:', bridgeText);

  await testRunner.cleanup();
}

testUnderBridge().catch(console.error);
