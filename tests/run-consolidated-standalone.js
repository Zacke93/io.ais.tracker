'use strict';

// Standalone runner that executes the consolidated journey scenarios
// without Jest or external installs. Uses the same RealAppTestRunner
// which boots the real app and services with mocked Homey + ws.

const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');
const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

function posNear(BRIDGES, bridgeName, distanceMeters, direction = 'south') {
  const bridge = BRIDGES[bridgeName.toLowerCase()];
  if (!bridge) throw new Error(`Unknown bridge: ${bridgeName}`);
  const latPerM = 1 / 111000;
  const lonPerM = 1 / (111000 * Math.cos(bridge.lat * Math.PI / 180));
  const canalDeg = 25; // canal tilt relative to north
  const r = (canalDeg * Math.PI) / 180;
  const dLat = distanceMeters * latPerM * Math.cos(r);
  const dLon = distanceMeters * lonPerM * Math.sin(r);
  if (direction === 'north') {
    return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
  }
  return { lat: bridge.lat - dLat, lon: bridge.lon - dLon };
}

async function main() {
  const runner = new RealAppTestRunner();
  await runner.initializeApp();
  const { BRIDGES } = require('../lib/constants');

  let failures = 0;

  // Southbound consolidated
  const v1 = {
    mmsi: '275514000', name: 'M/V Nordic Passage', sog: 5.0, cog: 205,
  };
  const southSteps = [
    {
      description: '800m N of Stallbackabron',
      vessels: [{
        ...v1, ...posNear(BRIDGES, 'Stallbackabron', 800, 'north'), status: 'en-route', targetBridge: 'Stridsbergsbron',
      }],
    },
    {
      description: '400m N of Stallbackabron',
      vessels: [{
        ...v1, ...posNear(BRIDGES, 'Stallbackabron', 400, 'north'), status: 'approaching', targetBridge: 'Stridsbergsbron', etaMinutes: 12,
      }],
    },
    {
      description: '250m N of Stallbackabron',
      vessels: [{
        ...v1, ...posNear(BRIDGES, 'Stallbackabron', 250, 'north'), status: 'stallbacka-waiting', currentBridge: 'Stallbackabron', targetBridge: 'Stridsbergsbron', etaMinutes: 10,
      }],
    },
    {
      description: 'Under Stallbackabron',
      vessels: [{
        ...v1, ...posNear(BRIDGES, 'Stallbackabron', 20, 'north'), status: 'under-bridge', currentBridge: 'Stallbackabron', targetBridge: 'Stridsbergsbron', etaMinutes: 8,
      }],
    },
    {
      description: '100m S of Stallbackabron',
      vessels: [{
        // eslint-disable-next-line max-len
        ...v1, ...posNear(BRIDGES, 'Stallbackabron', 100, 'south'), status: 'passed', lastPassedBridge: 'Stallbackabron', lastPassedBridgeTime: Date.now() - 4000, targetBridge: 'Stridsbergsbron', etaMinutes: 7,
      }],
    },
    {
      description: '400m N of Stridsbergsbron',
      vessels: [{
        // eslint-disable-next-line max-len
        ...v1, ...posNear(BRIDGES, 'Stridsbergsbron', 400, 'north'), status: 'approaching', targetBridge: 'Stridsbergsbron', etaMinutes: 4,
      }],
    },
    {
      description: '200m N of Stridsbergsbron',
      vessels: [{
        ...v1, ...posNear(BRIDGES, 'Stridsbergsbron', 200, 'north'), status: 'waiting', currentBridge: 'Stridsbergsbron', targetBridge: 'Stridsbergsbron',
      }],
    },
    {
      description: 'Under Stridsbergsbron',
      vessels: [{
        ...v1, ...posNear(BRIDGES, 'Stridsbergsbron', 25, 'north'), status: 'under-bridge', currentBridge: 'Stridsbergsbron', targetBridge: 'Stridsbergsbron',
      }],
    },
    {
      description: '80m S of Stridsbergsbron',
      vessels: [{
        // eslint-disable-next-line max-len
        ...v1, ...posNear(BRIDGES, 'Stridsbergsbron', 80, 'south'), status: 'passed', lastPassedBridge: 'Stridsbergsbron', lastPassedBridgeTime: Date.now() - 3000, targetBridge: 'Klaffbron', etaMinutes: 5,
      }],
    },
    {
      description: 'Under Järnvägsbron',
      vessels: [{
        ...v1, ...posNear(BRIDGES, 'Järnvägsbron', 15, 'north'), status: 'under-bridge', currentBridge: 'Järnvägsbron', targetBridge: 'Klaffbron', etaMinutes: 3,
      }],
    },
    {
      description: '150m N of Klaffbron',
      vessels: [{
        ...v1, ...posNear(BRIDGES, 'Klaffbron', 150, 'north'), status: 'waiting', currentBridge: 'Klaffbron', targetBridge: 'Klaffbron',
      }],
    },
    {
      description: 'Under Klaffbron',
      vessels: [{
        ...v1, ...posNear(BRIDGES, 'Klaffbron', 30, 'north'), status: 'under-bridge', currentBridge: 'Klaffbron', targetBridge: 'Klaffbron',
      }],
    },
    { description: 'Cleanup', vessels: [] },
  ];
  const southReport = await runner.runRealJourney('Southbound standalone', southSteps);
  const southOk = southReport.bridgeTextChanges.length > 8
               && southReport.finalBridgeText === BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
  console.log(`\nRESULT Southbound: ${southOk ? '✅' : '❌'} changes=${southReport.bridgeTextChanges.length}`);
  if (!southOk) failures++;

  // Multi‑vessel
  const mvSteps = [
    {
      description: '3 vessels',
      vessels: [
        {
          // eslint-disable-next-line max-len
          mmsi: '265607140', name: 'M/V Göteborg Express', ...posNear(BRIDGES, 'Klaffbron', 180, 'north'), sog: 3.2, cog: 205, status: 'waiting', currentBridge: 'Klaffbron', targetBridge: 'Klaffbron',
        },
        {
          // eslint-disable-next-line max-len
          mmsi: '265573130', name: 'M/V Baltic Carrier', ...posNear(BRIDGES, 'Stridsbergsbron', 240, 'south'), sog: 4.1, cog: 25, status: 'waiting', currentBridge: 'Stridsbergsbron', targetBridge: 'Stridsbergsbron',
        },
        {
          // eslint-disable-next-line max-len
          mmsi: '211222520', name: 'M/V Scandinavian Pride', ...posNear(BRIDGES, 'Stallbackabron', 280, 'north'), sog: 5.5, cog: 200, status: 'stallbacka-waiting', currentBridge: 'Stallbackabron', targetBridge: 'Stridsbergsbron', etaMinutes: 8,
        },
      ],
    },
    { description: 'Cleanup', vessels: [] },
  ];
  const mvReport = await runner.runRealJourney('Multi‑vessel standalone', mvSteps);
  const any = mvReport.bridgeTextChanges.map((c) => c.newText).find((t) => t.includes('Klaffbron') || t.includes('Stridsbergsbron') || t.includes('Stallbackabron'));
  let mvOk = true;
  if (any) {
    mvOk = any.includes(';') && any.includes('Stallbackabron');
  }
  console.log(`\nRESULT Multi‑vessel: ${mvOk ? '✅' : '❌'}`);
  if (!mvOk) failures++;

  await runner.cleanup();

  console.log(`\nOVERALL: ${failures === 0 ? '✅ PASS' : '❌ FAIL'} (failures=${failures})`);
  // Force exit to avoid lingering intervals from shared utilities
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Standalone runner error:', e);
  process.exitCode = 1;
});
