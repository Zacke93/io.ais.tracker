'use strict';

const LogReplayParser = require('./LogReplayParser');
const BridgeRegistry = require('../../lib/models/BridgeRegistry');
const SystemCoordinator = require('../../lib/services/SystemCoordinator');
const BridgeTextService = require('../../lib/services/BridgeTextService');
const { BRIDGES, BRIDGE_TEXT_CONSTANTS } = require('../../lib/constants');

const logger = {
  debug: (...args) => console.log('[DEBUG]', ...args),
  log: (...args) => console.log('[LOG]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

async function main() {
  const logFile = process.argv[2] || '../logs/app-20250822-233308.log';
  const mmsiFilter = process.argv[3] || null;

  const parser = new LogReplayParser(logFile);
  const snapshots = parser.parseSnapshots();
  console.log(`Parsed ${snapshots.length} snapshots from ${logFile}`);
  // Debug: MMSI frequency
  const freq = new Map();
  for (const s of snapshots) {
    for (const v of s.vessels) {
      freq.set(v.mmsi, (freq.get(v.mmsi) || 0) + 1);
    }
  }
  console.log('Top MMSIs:', Array.from(freq.entries()).slice(0, 5));

  const registry = new BridgeRegistry(BRIDGES);
  const coordinator = new SystemCoordinator(logger);
  const service = new BridgeTextService(registry, logger, coordinator);

  let mismatches = 0;
  let checked = 0;
  for (const s of snapshots) {
    if (mmsiFilter && !s.vessels.some((v) => v.mmsi === mmsiFilter)) continue;
    checked++;
    const actual = service.generateBridgeText(s.vessels);
    const expected = s.expectedFinalMessage || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
    const ts = s.ts ? new Date(s.ts).toISOString() : 'n/a';
    const vesselSummary = s.vessels.map((v) => `${v.mmsi}/${v.name}/${v.status}/${v.targetBridge || v.currentBridge || 'none'}`).join('; ');
    if (actual !== expected) {
      mismatches++;
      console.log(`\n❌ MISMATCH @ ${ts}`);
      console.log(`   Vessels: ${vesselSummary}`);
      console.log(`   Expected: "${expected}"`);
      console.log(`   Actual:   "${actual}"`);
    }
  }

  console.log(`\nDone. Checked: ${checked}, Mismatches: ${mismatches}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
