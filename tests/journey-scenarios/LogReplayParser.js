'use strict';

const fs = require('fs');
const path = require('path');

/**
 * LogReplayParser
 *
 * Parses real app logs to reconstruct the exact vessel snapshots that
 * BridgeTextService consumed when generating bridge text, including:
 * - Vessel fields (mmsi, name, status, targetBridge, currentBridge, isWaiting)
 * - Numeric ETA (minutes) from ⏰ [ETA_CALC]
 * - lastPassedBridge + lastPassedBridgeTime from 📋 [PASSAGE_AUDIT]
 * - distanceToCurrent from the logged "distance" field when currentBridge exists
 * - Expected final message from 🎯 [BRIDGE_TEXT] Final message
 */
class LogReplayParser {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    this.lines = [];
  }

  load() {
    const absPath = path.isAbsolute(this.logFilePath)
      ? this.logFilePath
      : path.join(process.cwd(), this.logFilePath);
    const content = fs.readFileSync(absPath, 'utf8');
    // Split into lines without losing timestamps
    this.lines = content.split(/\r?\n/);
  }

  /**
   * Parse the log into ordered snapshots. Each snapshot mirrors one
   * BridgeTextService generation step for N vessels and includes the
   * expected final message.
   *
   * Options:
   *  - filterMmsi: only include snapshots that mention this MMSI in vessels
   */
  parseSnapshots(options = {}) {
    if (!this.lines || this.lines.length === 0) this.load();

    const etaByMmsi = new Map(); // mmsi -> { eta: number, ts: Date }
    const passageAuditByMmsi = new Map(); // mmsi -> { lastPassedBridge, timeSinceSec, ts: Date }

    const snapshots = [];

    let inSnapshot = false;
    let currentSnapshot = null;
    let currentVesselBlock = null; // accumulating object literal lines

    const parseTimestamp = (line) => {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
      return m ? new Date(m[1]) : null;
    };

    const parseNumeric = (str) => {
      if (str == null) return null;
      const m = String(str).match(/([\d.\-]+)/);
      return m ? Number(m[1]) : null;
    };

    const parseVesselBlock = (blockLines) => {
      // The block is like:
      // {
      //   mmsi: '244790715',
      //   name: 'ALICE',
      //   currentBridge: 'Stallbackabron',
      //   targetBridge: 'Stridsbergsbron',
      //   etaMinutes: '11.6min',
      //   isWaiting: false,
      //   confidence: 'medium',
      //   distance: '323m',
      //   status: 'approaching'
      // }
      const text = blockLines.join('\n');
      const getString = (key) => {
        const m = text.match(new RegExp(`${key}:\s*'([^']*)'`));
        return m ? m[1] : null;
      };
      const getBool = (key) => {
        const m = text.match(new RegExp(`${key}:\s*(true|false)`));
        return m ? m[1] === 'true' : null;
      };

      const vessel = {
        mmsi: getString('mmsi'),
        name: getString('name') || 'Unknown',
        currentBridge: getString('currentBridge'),
        targetBridge: getString('targetBridge'),
        status: getString('status'),
        isWaiting: getBool('isWaiting') || false,
      };

      // distanceToCurrent: derive from 'distance' when currentBridge exists
      const distanceStr = getString('distance');
      if (vessel.currentBridge && distanceStr) {
        const d = parseNumeric(distanceStr);
        if (Number.isFinite(d)) vessel.distanceToCurrent = d;
      }

      return vessel;
    };

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];

      // Keep ETA by MMSI for later enrichment
      if (line.includes('[ETA_CALC]')) {
        const ts = parseTimestamp(line);
        const m = line.match(/ETA_CALC]\s*(\d+):[^E]*ETA=([\d.]+)min/);
        if (m) {
          const mmsi = m[1];
          const eta = Number(m[2]);
          etaByMmsi.set(mmsi, { eta, ts });
        }
      }

      // Track PASSAGE_AUDIT with lastPassedBridge and timeSince
      if (line.includes('[PASSAGE_AUDIT]')) {
        const ts = parseTimestamp(line);
        const m = line.match(/PASSAGE_AUDIT\]\s*(\d+):\s*lastPassedBridge=([^,]+),\s*timeSince=(\d+)s/);
        if (m) {
          const mmsi = m[1];
          const lastPassedBridge = m[2];
          const timeSinceSec = Number(m[3]);
          passageAuditByMmsi.set(mmsi, { lastPassedBridge, timeSinceSec, ts });
        }
      }

      // Detect snapshot start
      if (line.includes('[BRIDGE_TEXT] Generating bridge text for')) {
        inSnapshot = true;
        currentSnapshot = {
          ts: parseTimestamp(line),
          vessels: [],
          expectedFinalMessage: null,
        };
        continue;
      }

      if (!inSnapshot) continue;

      // Capture per-vessel blocks
      if (line.includes('[BRIDGE_TEXT] Vessel')) {
        // Start of object literal
        currentVesselBlock = [];
        // next line likely is '{', capture from there until '}'
        // include current and subsequent lines
        let j = i + 1;
        // Gather until a line that has just '}'
        while (j < this.lines.length) {
          const l = this.lines[j];
          currentVesselBlock.push(l.trim());
          if (l.trim() === '}') break;
          j += 1;
        }
        // Move i forward to end of block
        i = j;
        const vessel = parseVesselBlock(currentVesselBlock);
        if (vessel && vessel.mmsi) {
          // Enrich with ETA if available
          const etaEntry = etaByMmsi.get(vessel.mmsi);
          if (etaEntry && Number.isFinite(etaEntry.eta)) {
            vessel.etaMinutes = etaEntry.eta;
          }
          // Enrich with passage audit
          const audit = passageAuditByMmsi.get(vessel.mmsi);
          if (audit && audit.lastPassedBridge) {
            vessel.lastPassedBridge = audit.lastPassedBridge;
            // Compute lastPassedBridgeTime as snapshot time minus timeSince
            const baseTs = currentSnapshot.ts || audit.ts || new Date();
            vessel.lastPassedBridgeTime = baseTs.getTime() - (audit.timeSinceSec * 1000);
          }
          currentSnapshot.vessels.push(vessel);
        }
        continue;
      }

      // Detect final message for this snapshot
      if (line.includes('[BRIDGE_TEXT] Final message:')) {
        const m = line.match(/Final message: \"(.*)\"/);
        currentSnapshot.expectedFinalMessage = m ? m[1] : '';
        // Snapshot complete at final message
        inSnapshot = false;
        if (!options.filterMmsi
          || currentSnapshot.vessels.some((v) => v.mmsi === options.filterMmsi)) {
          snapshots.push(currentSnapshot);
        }
        currentSnapshot = null;
        continue;
      }
    }

    return snapshots;
  }
}

module.exports = LogReplayParser;
