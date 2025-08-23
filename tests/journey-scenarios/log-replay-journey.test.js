'use strict';

const LogReplayParser = require('./LogReplayParser');
const BridgeRegistry = require('../../lib/models/BridgeRegistry');
const SystemCoordinator = require('../../lib/services/SystemCoordinator');
const BridgeTextService = require('../../lib/services/BridgeTextService');
const { BRIDGES, BRIDGE_TEXT_CONSTANTS } = require('../../lib/constants');

// Simple logger to keep test output readable
const logger = {
  debug: (...args) => console.log('[DEBUG]', ...args),
  log: (...args) => console.log('[LOG]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

/**
 * This test replays a real app log, reconstructs the exact vessel snapshots
 * that BridgeTextService used, and verifies the generated bridge text matches
 * the real app output 1:1. It also prints a compact journey report.
 */
describe('🧭 Log Replay Journey - 1:1 Bridge Text Verification', () => {
  let bridgeRegistry;
  let systemCoordinator;
  let bridgeTextService;

  beforeAll(() => {
    bridgeRegistry = new BridgeRegistry(BRIDGES);
    systemCoordinator = new SystemCoordinator(logger);
    bridgeTextService = new BridgeTextService(bridgeRegistry, logger, systemCoordinator);
  });

  test('Replays single-boat northbound journey and matches messages', () => {
    // Choose a real log and a single MMSI to track through the canal
    // Note: logs folder is at repo root, test runs from io.ais.tracker
    const logFile = '../logs/app-20250822-233308.log';
    const targetMmsi = '244790715';

    const parser = new LogReplayParser(logFile);
    // First parse without filter to validate parser picks up snapshots
    const allSnapshots = parser.parseSnapshots();
    expect(allSnapshots.length).toBeGreaterThan(0);

    // Quick debug: show first snapshot vessel count to confirm parsing
    console.log(`Parsed total snapshots: ${allSnapshots.length}`);
    if (allSnapshots[0]) {
      console.log(`First snapshot vessels: ${allSnapshots[0].vessels.length}`);
    }

    // Build MMSI frequency from parsed snapshots for debugging
    const mmsiFreq = new Map();
    for (const s of allSnapshots) {
      for (const v of s.vessels) {
        mmsiFreq.set(v.mmsi, (mmsiFreq.get(v.mmsi) || 0) + 1);
      }
    }
    console.log('MMSI frequency (top 5):', Array.from(mmsiFreq.entries()).slice(0, 5));

    // Use all parsed snapshots for 1:1 verification
    const snapshots = allSnapshots;
    expect(snapshots.length).toBeGreaterThan(0);

    console.log(`\n📄 Replaying ${snapshots.length} snapshots for MMSI ${targetMmsi}`);

    let mismatches = 0;
    const updates = [];

    for (const snap of snapshots) {
      // Generate text using the same service logic
      const msg = bridgeTextService.generateBridgeText(snap.vessels);
      const expected = snap.expectedFinalMessage || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;

      const ok = msg === expected;
      if (!ok) mismatches++;

      // Collect compact update info
      const ts = snap.ts ? new Date(snap.ts).toISOString() : 'unknown';
      const vesselSummary = snap.vessels.map((v) => `${v.name || v.mmsi}: ${v.status} → ${v.targetBridge || v.currentBridge || 'none'}`).join('; ');
      updates.push({
        ts, ok, expected, actual: msg, vesselSummary,
      });

      // Do not assert immediately; collect and assert after report
    }

    // Print final report (compact)
    console.log('\n📋 Bridge Text Updates (compact):');
    updates.forEach((u, i) => {
      console.log(`  ${String(i + 1).padStart(2, '0')}. ${u.ok ? '✅' : '❌'} ${u.ts}`);
      console.log(`     Vessels: ${u.vesselSummary}`);
      console.log(`     Text:    "${u.actual}"`);
      if (!u.ok) console.log(`     Expect:  "${u.expected}"`);
    });

    console.log(`\n✅ 1:1 verification complete. Mismatches: ${mismatches}`);
    expect(mismatches).toBe(0);
  });
});
