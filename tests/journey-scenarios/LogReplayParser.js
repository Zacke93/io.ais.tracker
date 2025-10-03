'use strict';

const fs = require('fs');
const path = require('path');
const { BRIDGES, APPROACH_RADIUS, APPROACHING_RADIUS } = require('../../lib/constants');

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

    const etaByMmsi = new Map(); // mmsi -> [{ eta, speed, ts }]
    const etaFormatByMmsi = new Map(); // mmsi -> [{ eta, distance, speed, ts }]
    const passageAuditByMmsi = new Map(); // mmsi -> { lastPassedBridge, timeSinceSec, ts: Date }
    const etaInternalByMmsi = new Map(); // mmsi -> [{ eta, ts }]

    // Snapshot-local ETA collections (reset at each snapshot start)
    const snapshotEtaByMmsi = new Map(); // mmsi -> [{ eta, speed, ts }]
    const snapshotEtaFormatByMmsi = new Map(); // mmsi -> [{ eta, distance, speed, ts }]
    const snapshotEtaInternalByMmsi = new Map(); // mmsi -> [{ eta, ts }]

    const snapshots = [];
    let vesselBlocksParsed = 0;

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
        const re = new RegExp(`${key}:\\s*'([^']*)'`);
        const m = text.match(re);
        if (!m && process.env.LOG_REPLAY_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`[LogReplayParser] getString miss for ${key} in:\n${text}`);
        }
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
      if (distanceStr) {
        const d = parseNumeric(distanceStr);
        if (Number.isFinite(d)) {
          if (vessel.currentBridge) vessel.distanceToCurrent = d;
          // Keep nearest distance for Stallbacka approach reconstruction
          vessel._nearestDistance = d;
        }
      }

      return vessel;
    };

    let vesselLineHits = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];

      // Keep ETA by MMSI for later enrichment
      if (line.includes('[ETA_CALC]')) {
        const ts = parseTimestamp(line);
        // Prefer variant with explicit speed first
        let m = line.match(/\[ETA_CALC\]\s*(\d+):.*?speed=([\d.]+)kn,\s*ETA=([\d.]+)min/);
        if (m) {
          const mmsi = m[1];
          const speed = Number(m[2]);
          const eta = Number(m[3]);
          const etaEntry = { eta, speed, ts };
          // Global collection
          const arr = etaByMmsi.get(mmsi) || [];
          arr.push(etaEntry);
          etaByMmsi.set(mmsi, arr);
          // Snapshot-local collection if inside snapshot
          if (inSnapshot) {
            const snapArr = snapshotEtaByMmsi.get(mmsi) || [];
            snapArr.push(etaEntry);
            snapshotEtaByMmsi.set(mmsi, snapArr);
          }
        } else {
          m = line.match(/\[ETA_CALC\]\s*(\d+):.*?ETA=([\d.]+)min/);
          if (m) {
            const mmsi = m[1];
            const eta = Number(m[2]);
            const etaEntry = { eta, speed: null, ts };
            // Global collection
            const arr = etaByMmsi.get(mmsi) || [];
            arr.push(etaEntry);
            etaByMmsi.set(mmsi, arr);
            // Snapshot-local collection if inside snapshot
            if (inSnapshot) {
              const snapArr = snapshotEtaByMmsi.get(mmsi) || [];
              snapArr.push(etaEntry);
              snapshotEtaByMmsi.set(mmsi, snapArr);
            }
          }
        }
      }

      // Capture ETA_FORMAT (used by BridgeTextService._formatPassedETA)
      if (line.includes('[ETA_FORMAT]')) {
        const ts = parseTimestamp(line);
        const m = line.match(/\[ETA_FORMAT\]\s*(\d+):.*?distance=([\d.]+)m,\s*speed=([\d.]+)kn,\s*ETA=([\d.]+)min/);
        if (m) {
          const mmsi = m[1];
          const distance = Number(m[2]);
          const speed = Number(m[3]);
          const eta = Number(m[4]);
          const etaEntry = {
            eta, distance, speed, ts,
          };
          // Global collection
          const arr = etaFormatByMmsi.get(mmsi) || [];
          arr.push(etaEntry);
          etaFormatByMmsi.set(mmsi, arr);
          // Snapshot-local collection if inside snapshot
          if (inSnapshot) {
            const snapArr = snapshotEtaFormatByMmsi.get(mmsi) || [];
            snapArr.push(etaEntry);
            snapshotEtaFormatByMmsi.set(mmsi, snapArr);
          }
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

      // Track internal etaMinutes changes for precision
      if (line.includes('[_updateUIIfNeeded]') && line.includes('etaMinutes:')) {
        const ts = parseTimestamp(line);
        const m = line.match(/_updateUIIfNeeded\]\s*(\d+):.*etaMinutes:\s*"[^"]*"\s*→\s*"([\d.]+)"/);
        if (m) {
          const mmsi = m[1];
          const eta = Number(m[2]);
          const etaEntry = { eta, ts };
          // Global collection
          const arr = etaInternalByMmsi.get(mmsi) || [];
          arr.push(etaEntry);
          etaInternalByMmsi.set(mmsi, arr);
          // Snapshot-local collection if inside snapshot
          if (inSnapshot) {
            const snapArr = snapshotEtaInternalByMmsi.get(mmsi) || [];
            snapArr.push(etaEntry);
            snapshotEtaInternalByMmsi.set(mmsi, snapArr);
          }
        }
      }

      // Detect snapshot start
      if (line.includes('[BRIDGE_TEXT] Generating bridge text for')) {
        inSnapshot = true;
        const startTs = parseTimestamp(line);
        currentSnapshot = {
          startTs,
          ts: startTs, // Keep for backward compatibility, will be updated to endTs
          vessels: [],
          expectedFinalMessage: null,
        };
        // Clear snapshot-local ETA collections for fresh snapshot
        snapshotEtaByMmsi.clear();
        snapshotEtaFormatByMmsi.clear();
        snapshotEtaInternalByMmsi.clear();
        continue;
      }

      if (!inSnapshot) continue;

      // Capture per-vessel blocks
      if (line.includes('[BRIDGE_TEXT] Vessel')) {
        vesselLineHits += 1;
        if (process.env.LOG_REPLAY_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`[LogReplayParser] vessel start at line ${i}`);
        }
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
          vesselBlocksParsed += 1;
          // No per-vessel ETA assignment here; do it at snapshot finalize with timestamp-aware lookup
          // Enrich with passage audit
          const audit = passageAuditByMmsi.get(vessel.mmsi);
          if (audit && audit.lastPassedBridge) {
            vessel.lastPassedBridge = audit.lastPassedBridge;
            // Compute lastPassedBridgeTime as snapshot time minus timeSince
            const baseTs = currentSnapshot.ts || audit.ts || new Date();
            vessel.lastPassedBridgeTime = baseTs.getTime() - (audit.timeSinceSec * 1000);
          }

          // Inject approximate lat/lon for Stallbackabron-approach logic
          // If currentBridge is Stallbackabron and distance is present, create a synthetic position
          if (vessel.currentBridge === 'Stallbackabron') {
            const stallbacka = BRIDGES.stallbackabron || BRIDGES['stallbackabron'];
            const distStr = currentVesselBlock.join('\n').match(/distance:\s*'([0-9.]+)m'/);
            const meters = distStr ? Number(distStr[1]) : null;
            if (stallbacka && Number.isFinite(meters)) {
              // Offset in latitude by meters north (direction doesn't matter for distance)
              const metersPerDegLat = 111320;
              const dLat = meters / metersPerDegLat;
              vessel.lat = stallbacka.lat + dLat;
              vessel.lon = stallbacka.lon;
            }
          }
          currentSnapshot.vessels.push(vessel);
        } else if (process.env.LOG_REPLAY_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`[LogReplayParser] failed to parse vessel block:\n${currentVesselBlock.join('\n')}`);
        }
        continue;
      }

      // Detect final message for this snapshot
      if (line.includes('[BRIDGE_TEXT] Final message:')) {
        const m = line.match(/Final message: \"(.*)\"/);
        currentSnapshot.expectedFinalMessage = m ? m[1] : '';
        // Set end timestamp and keep for final processing
        const finalTs = parseTimestamp(line);
        if (finalTs) {
          currentSnapshot.endTs = finalTs;
          currentSnapshot.ts = finalTs; // Keep for backward compatibility
        }
        // Finalize ETAs for vessels in this snapshot with snapshot-interval priority
        if (currentSnapshot && currentSnapshot.vessels) {
          const { startTs } = currentSnapshot;
          const { endTs } = currentSnapshot;
          const tolerance = 50; // 50ms tolerance for entries just after endTs
          const preSnapshotTolerance = 100; // 100ms tolerance for entries just before startTs

          const pickLatestInInterval = (snapMap, globalMap, mmsi, startTs, endTs) => {
            const endTsWithTolerance = new Date(endTs.getTime() + tolerance);
            const startTsWithTolerance = new Date(startTs.getTime() - preSnapshotTolerance);
            // Priority 1: Latest in snapshot interval (startTs to endTs + tolerance)
            const snapArr = snapMap.get(mmsi);
            if (snapArr && snapArr.length > 0) {
              for (let k = snapArr.length - 1; k >= 0; k--) {
                const e = snapArr[k];
                if (e.ts && e.ts >= startTs && e.ts <= endTsWithTolerance) {
                  if (process.env.LOG_REPLAY_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log(`[LogReplayParser] pickLatestInInterval SNAPSHOT: ${mmsi} found ${e.eta} at ${e.ts.toISOString()}`);
                  }
                  return e;
                }
              }
            }
            // Priority 2: Extended search in global with pre-snapshot tolerance
            const globalArr = globalMap.get(mmsi);
            if (!globalArr || globalArr.length === 0) return null;
            for (let k = globalArr.length - 1; k >= 0; k--) {
              const e = globalArr[k];
              if (e.ts && e.ts >= startTsWithTolerance && e.ts <= endTsWithTolerance) {
                if (process.env.LOG_REPLAY_DEBUG) {
                  // eslint-disable-next-line no-console
                  // eslint-disable-next-line max-len
                  console.log(`[LogReplayParser] pickLatestInInterval GLOBAL: ${mmsi} found ${e.eta} at ${e.ts.toISOString()} (expanded: ${startTsWithTolerance.toISOString()}-${endTsWithTolerance.toISOString()})`);
                }
                return e;
              }
            }
            return null;
          };
          currentSnapshot.vessels.forEach((v) => {
            // Get best ETA entries using snapshot-interval priority
            const etaInternalEntry = pickLatestInInterval(snapshotEtaInternalByMmsi, etaInternalByMmsi, v.mmsi, startTs, endTs);
            const etaEntry = pickLatestInInterval(snapshotEtaByMmsi, etaByMmsi, v.mmsi, startTs, endTs);
            const etaFmtEntry = pickLatestInInterval(snapshotEtaFormatByMmsi, etaFormatByMmsi, v.mmsi, startTs, endTs);

            let chosen = null;
            // For normal approaching/en-route/waiting messages, prioritize snapshot ETAs
            if (v.status === 'approaching' || v.status === 'en-route' || v.status === 'waiting' || v.status === 'under-bridge' || v.status === 'stallbacka-waiting') {
              // Priority: etaInternal > etaCalc > etaFormat within snapshot interval
              if (etaInternalEntry && Number.isFinite(etaInternalEntry.eta)) chosen = etaInternalEntry.eta;
              else if (etaEntry && Number.isFinite(etaEntry.eta)) chosen = etaEntry.eta;
              else if (etaFmtEntry && Number.isFinite(etaFmtEntry.eta)) chosen = etaFmtEntry.eta;
            }
            // For passed messages, do not set eta here (we force recompute below)
            if (chosen != null) {
              v.etaMinutes = chosen;
              if (process.env.LOG_REPLAY_DEBUG) {
                // Determine ETA source for debugging
                let etaSource = 'format';
                if (etaInternalEntry) etaSource = 'internal';
                else if (etaEntry) etaSource = 'calc';

                // eslint-disable-next-line no-console
                console.log(`[LogReplayParser] Finalize ETA for ${v.mmsi}: ${chosen} (from ${etaSource})`);
              }
            }
            // Apply speed preference: ETA_FORMAT speed > ETA_CALC speed
            if (etaFmtEntry && Number.isFinite(etaFmtEntry.speed)) {
              v.sog = etaFmtEntry.speed;
            } else if (etaEntry && Number.isFinite(etaEntry.speed)) {
              v.sog = etaEntry.speed;
            }

            // If passed: force recalculation (ignore any stale etaMinutes from logs)
            if (v.status === 'passed') {
              v.etaMinutes = null;
              if (process.env.LOG_REPLAY_DEBUG) {
                // eslint-disable-next-line no-console
                console.log(`[LogReplayParser] passed snapshot for ${v.mmsi}: etaFmtEntry=${JSON.stringify(etaFmtEntry)} etaEntry=${JSON.stringify(etaEntry)}`);
              }
            }
            // If passed and we have ETA_FORMAT distance, synthesize position relative to target bridge
            if (v.status === 'passed' && v.targetBridge && etaFmtEntry && Number.isFinite(etaFmtEntry.distance)) {
              const targetKey = Object.keys(BRIDGES).find((k) => BRIDGES[k].name === v.targetBridge) || v.targetBridge;
              const target = BRIDGES[targetKey];
              if (target) {
                const metersPerDegLat = 111320;
                const dLat = (etaFmtEntry.distance || 0) / metersPerDegLat;
                v.lat = target.lat + dLat; // arbitrary north offset
                v.lon = target.lon;
                // Force recalculation from position for "precis passerat"
                v.etaMinutes = null;
                if (!v.sog && etaFmtEntry && Number.isFinite(etaFmtEntry.speed)) {
                  v.sog = etaFmtEntry.speed;
                }
                if (process.env.LOG_REPLAY_DEBUG) {
                  // eslint-disable-next-line no-console
                  console.log(`[LogReplayParser] Synth pos for ${v.mmsi}: ${v.lat}, ${v.lon} (d=${etaFmtEntry.distance}m, sog=${v.sog})`);
                }
              }
            }

            // If approaching Stridsbergsbron near Stallbackabron without coordinates, synthesize position from nearest distance
            if (v.status === 'approaching' && v.targetBridge === 'Stridsbergsbron' && !v.lat && Number.isFinite(v._nearestDistance)) {
              const d = v._nearestDistance;
              if (d <= APPROACHING_RADIUS && d > APPROACH_RADIUS) {
                const stallbacka = BRIDGES.stallbackabron;
                if (stallbacka) {
                  const metersPerDegLat = 111320;
                  const dLat = d / metersPerDegLat;
                  v.lat = stallbacka.lat + dLat;
                  v.lon = stallbacka.lon;
                  if (process.env.LOG_REPLAY_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log(`[LogReplayParser] Synth Stallbacka-approach pos for ${v.mmsi}: ${v.lat}, ${v.lon} (d=${d}m)`);
                  }
                }
              }
            }
          });
        }
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

    // Debug summary
    if (typeof process !== 'undefined' && process.env && process.env.LOG_REPLAY_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[LogReplayParser] snapshots=${snapshots.length}, vesselBlocks=${vesselBlocksParsed}, vesselLineHits=${vesselLineHits}`);
    }
    return snapshots;
  }
}

module.exports = LogReplayParser;
