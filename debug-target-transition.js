'use strict';

/**
 * Debug target bridge transitions in the GOLD STANDARD test
 */

const RealAppTestRunner = require('./tests/journey-scenarios/RealAppTestRunner');

async function debugTargetTransition() {
  console.log('🔍 Debugging target bridge transition issue');

  const testRunner = new RealAppTestRunner();
  await testRunner.initializeApp();

  console.log('\n=== REPRODUCING GOLD STANDARD STEP SEQUENCE ===');

  // Clear all vessels first
  const clearVessels = () => {
    const vessels = testRunner.app.vesselDataService.getAllVessels();
    vessels.forEach((vessel) => {
      testRunner.app.vesselDataService.removeVessel(vessel.mmsi, 'debug-cleanup');
    });
  };

  // Step 1: TUNA starts journey toward Klaffbron
  console.log('\n📍 Step 1: TUNA starts journey toward Klaffbron');
  clearVessels();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await testRunner._processVesselAsAISMessage({
    mmsi: '244321000',
    name: 'TUNA',
    lat: 58.26847333333333,
    lon: 12.26998,
    sog: 3.3,
    cog: 28.4,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  let vessels = testRunner.app.vesselDataService.getAllVessels();
  console.log('After Step 1:', vessels.map((v) => ({ mmsi: v.mmsi, status: v.status, targetBridge: v.targetBridge })));

  // Step 2: TUNA approaching through Olidebron
  console.log('\n📍 Step 2: TUNA approaching through Olidebron');
  clearVessels();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await testRunner._processVesselAsAISMessage({
    mmsi: '244321000',
    name: 'TUNA',
    lat: 58.27159666666667,
    lon: 12.273583333333333,
    sog: 3.3,
    cog: 33.3,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  vessels = testRunner.app.vesselDataService.getAllVessels();
  console.log('After Step 2:', vessels.map((v) => ({ mmsi: v.mmsi, status: v.status, targetBridge: v.targetBridge })));

  // Step 3: TUNA approaching Klaffbron (500m rule)
  console.log('\n📍 Step 3: TUNA approaching Klaffbron (500m rule)');
  clearVessels();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await testRunner._processVesselAsAISMessage({
    mmsi: '244321000',
    name: 'TUNA',
    lat: 58.28060666666667,
    lon: 12.282526666666666,
    sog: 3.5,
    cog: 18.3,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  vessels = testRunner.app.vesselDataService.getAllVessels();
  console.log('After Step 3:', vessels.map((v) => ({ mmsi: v.mmsi, status: v.status, targetBridge: v.targetBridge })));

  // Step 4: TUNA waiting at Klaffbron
  console.log('\n📍 Step 4: TUNA waiting at Klaffbron');
  clearVessels();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await testRunner._processVesselAsAISMessage({
    mmsi: '244321000',
    name: 'TUNA',
    lat: 58.282933,
    lon: 12.283400,
    sog: 2.8,
    cog: 15.7,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  vessels = testRunner.app.vesselDataService.getAllVessels();
  console.log('After Step 4:', vessels.map((v) => ({ mmsi: v.mmsi, status: v.status, targetBridge: v.targetBridge })));

  // Step 5: TUNA under Klaffbron (THE PROBLEMATIC STEP)
  console.log('\n📍 Step 5: TUNA under Klaffbron (THE PROBLEMATIC STEP)');
  clearVessels();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // First, add the vessel in step 4 position (to have previous state)
  await testRunner._processVesselAsAISMessage({
    mmsi: '244321000',
    name: 'TUNA',
    lat: 58.282933,
    lon: 12.283400,
    sog: 2.8,
    cog: 15.7,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  vessels = testRunner.app.vesselDataService.getAllVessels();
  console.log('Before Step 5 update (previous state):', vessels.map((v) => ({
    mmsi: v.mmsi,
    status: v.status,
    targetBridge: v.targetBridge,
    currentBridge: v.currentBridge,
    lat: v.lat,
    lon: v.lon,
  })));

  // Now update to step 5 position
  console.log('\n🔄 UPDATING TO STEP 5 POSITION...');
  await testRunner._processVesselAsAISMessage({
    mmsi: '244321000',
    name: 'TUNA',
    lat: 58.28409551543077, // Under Klaffbron
    lon: 12.283929525245636,
    sog: 2.8,
    cog: 15.7,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  vessels = testRunner.app.vesselDataService.getAllVessels();
  console.log('After Step 5 update:', vessels.map((v) => ({
    mmsi: v.mmsi,
    status: v.status,
    targetBridge: v.targetBridge,
    currentBridge: v.currentBridge,
    distanceToCurrent: v.distanceToCurrent,
  })));

  await testRunner.cleanup();
}

debugTargetTransition().catch(console.error);
