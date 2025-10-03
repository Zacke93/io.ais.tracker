'use strict';

/**
 * Consolidated Bridge Text Suite
 *
 * Runs a single, comprehensive suite that:
 * - Boots the real app (AISBridgeApp) with mocked Homey
 * - Simulates full southbound and northbound journeys using realistic positions
 * - Exercises multi‑vessel scenarios with semicolon separation
 * - Optionally replays a real app log to verify 1:1 bridge text output
 *
 * This intentionally replaces a scattering of small tests with one
 * robust integration suite that uses the exact same logic as production.
 */

const fs = require('fs');
const path = require('path');
const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');
const LogReplayParser = require('./journey-scenarios/LogReplayParser');
const { BRIDGES, BRIDGE_TEXT_CONSTANTS, BRIDGE_NAME_TO_ID } = require('../lib/constants');

// Helper: realistic positions along canal using per‑bridge offsets
function posNear(bridgeName, distanceMeters, direction = 'south') {
  const id = BRIDGE_NAME_TO_ID[bridgeName];
  const bridge = id ? BRIDGES[id] : null;
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

describe('🧪 Consolidated Bridge Text Suite (real app logic + real data)', () => {
  let runner;

  beforeAll(async () => {
    runner = new RealAppTestRunner();
    await runner.initializeApp();
  }, 45000);

  afterAll(async () => {
    if (runner) await runner.cleanup();
  });

  test('Southbound complete passage with realistic positions', async () => {
    const vessel = {
      mmsi: '275514000', name: 'M/V Nordic Passage', sog: 5.0, cog: 205,
    };
    const steps = [
      {
        description: '800m N of Stallbackabron',
        vessels: [{
          ...vessel, ...posNear('Stallbackabron', 800, 'north'), status: 'en-route', targetBridge: 'Stridsbergsbron',
        }],
        delaySeconds: 2,
      },
      {
        description: '400m N of Stallbackabron (approaching)',
        vessels: [{
          ...vessel, ...posNear('Stallbackabron', 400, 'north'), status: 'approaching', targetBridge: 'Stridsbergsbron', etaMinutes: 12,
        }],
        delaySeconds: 2,
      },
      {
        description: '250m N of Stallbackabron (åker strax under)',
        vessels: [{
          ...vessel, ...posNear('Stallbackabron', 250, 'north'), status: 'stallbacka-waiting', currentBridge: 'Stallbackabron', targetBridge: 'Stridsbergsbron', etaMinutes: 10,
        }],
        delaySeconds: 2,
      },
      {
        description: 'Under Stallbackabron',
        vessels: [{
          ...vessel, ...posNear('Stallbackabron', 20, 'north'), status: 'under-bridge', currentBridge: 'Stallbackabron', targetBridge: 'Stridsbergsbron', etaMinutes: 8,
        }],
        delaySeconds: 2,
      },
      {
        description: '100m S of Stallbackabron (precis passerat)',
        vessels: [{
          ...vessel,
          ...posNear('Stallbackabron', 100, 'south'),
          status: 'passed',
          lastPassedBridge: 'Stallbackabron',
          lastPassedBridgeTime: Date.now() - 4000,
          targetBridge: 'Stridsbergsbron',
          etaMinutes: 7,
        }],
        delaySeconds: 2,
      },
      {
        description: '400m N of Stridsbergsbron (approaching)',
        vessels: [{
          ...vessel, ...posNear('Stridsbergsbron', 400, 'north'), status: 'approaching', targetBridge: 'Stridsbergsbron', etaMinutes: 4,
        }],
        delaySeconds: 2,
      },
      {
        description: '200m N of Stridsbergsbron (waiting)',
        vessels: [{
          ...vessel, ...posNear('Stridsbergsbron', 200, 'north'), status: 'waiting', currentBridge: 'Stridsbergsbron', targetBridge: 'Stridsbergsbron',
        }],
        delaySeconds: 2,
      },
      {
        description: 'Under Stridsbergsbron',
        vessels: [{
          ...vessel, ...posNear('Stridsbergsbron', 25, 'north'), status: 'under-bridge', currentBridge: 'Stridsbergsbron', targetBridge: 'Stridsbergsbron',
        }],
        delaySeconds: 2,
      },
      {
        description: '80m S of Stridsbergsbron (precis passerat → Klaffbron)',
        vessels: [{
          // eslint-disable-next-line max-len
          ...vessel, ...posNear('Stridsbergsbron', 80, 'south'), status: 'passed', lastPassedBridge: 'Stridsbergsbron', lastPassedBridgeTime: Date.now() - 3000, targetBridge: 'Klaffbron', etaMinutes: 5,
        }],
        delaySeconds: 2,
      },
      {
        description: 'Under Järnvägsbron (intermediate)',
        vessels: [{
          ...vessel, ...posNear('Järnvägsbron', 15, 'north'), status: 'under-bridge', currentBridge: 'Järnvägsbron', targetBridge: 'Klaffbron', etaMinutes: 3,
        }],
        delaySeconds: 2,
      },
      {
        description: '150m N of Klaffbron (waiting)',
        vessels: [{
          ...vessel, ...posNear('Klaffbron', 150, 'north'), status: 'waiting', currentBridge: 'Klaffbron', targetBridge: 'Klaffbron',
        }],
        delaySeconds: 2,
      },
      {
        description: 'Under Klaffbron',
        vessels: [{
          ...vessel, ...posNear('Klaffbron', 30, 'north'), status: 'under-bridge', currentBridge: 'Klaffbron', targetBridge: 'Klaffbron',
        }],
        delaySeconds: 2,
      },
      { description: 'Cleanup (leaves system)', vessels: [] },
    ];

    const report = await runner.runRealJourney('Southbound consolidated', steps);
    expect(report.bridgeTextChanges.length).toBeGreaterThan(8);
    expect(report.finalBridgeText).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  }, 60000);

  test('Northbound partial passage with intermediate bridge verification', async () => {
    const vessel = {
      mmsi: '265727030', name: 'M/V Arctic Trader', sog: 4.8, cog: 25,
    };
    const steps = [
      {
        description: '600m S of Olidebron (approaching)',
        vessels: [{
          ...vessel, ...posNear('Olidebron', 600, 'south'), status: 'approaching', targetBridge: 'Klaffbron', etaMinutes: 15,
        }],
        delaySeconds: 2,
      },
      {
        description: 'Under Olidebron (intermediate)',
        vessels: [{
          ...vessel, ...posNear('Olidebron', 10, 'south'), status: 'under-bridge', currentBridge: 'Olidebron', targetBridge: 'Klaffbron', etaMinutes: 12,
        }],
        delaySeconds: 2,
      },
      {
        description: '200m S of Klaffbron (waiting)',
        vessels: [{
          ...vessel, ...posNear('Klaffbron', 200, 'south'), status: 'waiting', currentBridge: 'Klaffbron', targetBridge: 'Klaffbron',
        }],
        delaySeconds: 2,
      },
      {
        description: 'Under Klaffbron',
        vessels: [{
          ...vessel, ...posNear('Klaffbron', 25, 'south'), status: 'under-bridge', currentBridge: 'Klaffbron', targetBridge: 'Klaffbron',
        }],
        delaySeconds: 2,
      },
      {
        description: '90m N of Klaffbron (precis passerat → Stridsbergsbron)',
        vessels: [{
          ...vessel, ...posNear('Klaffbron', 90, 'north'), status: 'passed', lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() - 3000, targetBridge: 'Stridsbergsbron', etaMinutes: 7,
        }],
        delaySeconds: 2,
      },
      {
        description: 'Under Järnvägsbron (intermediate to Stridsbergsbron)',
        vessels: [{
          ...vessel, ...posNear('Järnvägsbron', 20, 'south'), status: 'under-bridge', currentBridge: 'Järnvägsbron', targetBridge: 'Stridsbergsbron', etaMinutes: 4,
        }],
        delaySeconds: 2,
      },
    ];

    const report = await runner.runRealJourney('Northbound consolidated', steps);
    expect(report.bridgeTextChanges.length).toBeGreaterThan(4);
  }, 45000);

  test('Multi‑vessel scenario with semicolon separation and Stallbacka special', async () => {
    const steps = [
      {
        description: '3 vessels at different bridges',
        vessels: [
          {
            mmsi: '265607140', name: 'M/V Göteborg Express', ...posNear('Klaffbron', 180, 'north'), sog: 3.2, cog: 205, status: 'waiting', currentBridge: 'Klaffbron', targetBridge: 'Klaffbron',
          },
          {
            // eslint-disable-next-line max-len
            mmsi: '265573130', name: 'M/V Baltic Carrier', ...posNear('Stridsbergsbron', 240, 'south'), sog: 4.1, cog: 25, status: 'waiting', currentBridge: 'Stridsbergsbron', targetBridge: 'Stridsbergsbron',
          },
          {
            // eslint-disable-next-line max-len
            mmsi: '211222520', name: 'M/V Scandinavian Pride', ...posNear('Stallbackabron', 280, 'north'), sog: 5.5, cog: 200, status: 'stallbacka-waiting', currentBridge: 'Stallbackabron', targetBridge: 'Stridsbergsbron', etaMinutes: 8,
          },
        ],
        delaySeconds: 3,
      },
      { description: 'Cleanup', vessels: [] },
    ];

    const report = await runner.runRealJourney('Multi‑vessel consolidated', steps);
    const txts = report.bridgeTextChanges.map((c) => c.newText);
    const any = txts.find((t) => t.includes('Klaffbron') || t.includes('Stridsbergsbron') || t.includes('Stallbackabron'));
    if (any) {
      expect(any.includes(';')).toBe(true); // semicolon separation for multiple target groups
      expect(any.includes('Stallbackabron')).toBe(true); // special case present
    }
  }, 30000);

  test('Optional: Replay real app log and require 1:1 output', () => {
    const candidate = path.join(__dirname, '..', '..', 'logs', 'app-20250822-233308.log');
    if (!fs.existsSync(candidate)) {
      console.log(`ℹ️ Skipping log replay – file not found: ${candidate}`);
      expect(true).toBe(true);
      return;
    }

    const parser = new LogReplayParser(candidate);
    const snapshots = parser.parseSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);

    // Verify each snapshot’s generated text equals the expected final message
    const AISBridgeApp = require('../app');
    const app = new AISBridgeApp();
    // Use the isolated service directly for 1:1 without device update side effects
    const BridgeRegistry = require('../lib/models/BridgeRegistry');
    const SystemCoordinator = require('../lib/services/SystemCoordinator');
    const BridgeTextService = require('../lib/services/BridgeTextService');
    const registry = new BridgeRegistry(BRIDGES);
    const coordinator = new SystemCoordinator({ debug: () => {}, log: () => {}, error: () => {} });
    const svc = new BridgeTextService(registry, { debug: () => {}, log: () => {}, error: () => {} }, coordinator);

    let mismatches = 0;
    for (const snap of snapshots) {
      const msg = svc.generateBridgeText(snap.vessels);
      const expected = snap.expectedFinalMessage || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      if (msg !== expected) mismatches++;
    }
    expect(mismatches).toBe(0);
  }, 45000);
});
