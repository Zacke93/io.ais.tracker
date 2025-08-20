'use strict';

/**
 * Log Replay Test (Single Vessel) — Uses real app logic and real log data
 *
 * - Reads logs/app-20250817-200035.log
 * - Extracts a realistic sequence for one vessel (MMSI found in log)
 * - Reconstructs positions from nearest-bridge distances and canal bearing
 * - Feeds AIS messages through the real app (with mocked Homey)
 * - Validates that bridge text does not provide false information
 */

const fs = require('fs');
const path = require('path');
const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');
const { BRIDGES, COG_DIRECTIONS } = require('../lib/constants');

// Helpers: forward geodesic to create a coordinate given bearing and distance
function destinationPoint(lat, lon, bearingDeg, distanceMeters) {
  const R = 6371000; // meters
  const bearing = (bearingDeg * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;
  const delta = distanceMeters / R;

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);

  const sinPhi2 = sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(bearing);
  const phi2 = Math.asin(sinPhi2);
  const y = Math.sin(bearing) * sinDelta * cosPhi1;
  const x = cosDelta - sinPhi1 * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);

  const lat2 = (phi2 * 180) / Math.PI;
  let lon2 = (lambda2 * 180) / Math.PI;
  // Normalize longitude to [-180, 180)
  lon2 = ((lon2 + 540) % 360) - 180;
  return { lat: lat2, lon: lon2 };
}

function isNorthbound(cog) {
  if (!Number.isFinite(cog)) return null;
  return cog >= COG_DIRECTIONS.NORTH_MIN || cog <= COG_DIRECTIONS.NORTH_MAX;
}

// Parse relevant data from a proximity analysis block (spanning multiple lines)
function parseProximityBlock(block) {
  // Example fragments we rely on (from log):
  // nearestBridge: 'Olidebron',
  // nearestDistance: '571m',
  // speed: '3.6kn',
  // course: '31°'
  const nearestBridgeMatch = block.match(/nearestBridge:\s*'([^']+)'/);
  const nearestDistanceMatch = block.match(/nearestDistance:\s*'([\d.]+)m'/);
  const speedMatch = block.match(/speed:\s*'([\d.]+)kn'/);
  const courseMatch = block.match(/course:\s*'([\d.]+)°'/);

  const nearestBridge = nearestBridgeMatch ? nearestBridgeMatch[1] : null;
  const nearestDistance = nearestDistanceMatch ? Number(nearestDistanceMatch[1]) : null;
  const sog = speedMatch ? Number(speedMatch[1]) : null;
  const cog = courseMatch ? Number(courseMatch[1]) : null;

  return {
    nearestBridge, nearestDistance, sog, cog,
  };
}

function parseWaitingCheckLine(line) {
  // Example: [WAITING_CHECK] 257941000: Target distance = 1826m to Klaffbron
  const match = line.match(/Target distance\s*=\s*([\d.]+)m\s*to\s*([^,\n]+)/);
  if (!match) return { targetDistance: null, targetBridge: null };
  return { targetDistance: Number(match[1]), targetBridge: match[2].trim() };
}

function pickBridgeBearing(bridgeName) {
  // Canal bearing is perpendicular to bridge axisBearing (~130°), i.e. ~40°
  // We compute canal bearing from the registry bridge axisBearing.
  const bridge = BRIDGES[bridgeName?.toLowerCase?.() || ''];
  if (!bridge) return 40; // fallback canal axis
  const canalBearing = (bridge.axisBearing - 90 + 360) % 360;
  return canalBearing;
}

function computePositionFromNearest(bridgeName, distanceM, cog) {
  const b = BRIDGES[bridgeName?.toLowerCase?.() || ''];
  if (!b || !Number.isFinite(distanceM)) return null;
  const canalBearing = pickBridgeBearing(bridgeName);
  // Choose direction based on COG if available, otherwise assume outward along canal
  let bearing = canalBearing;
  const nb = isNorthbound(cog);
  if (nb === false) bearing = (canalBearing + 180) % 360;
  return destinationPoint(b.lat, b.lon, bearing, distanceM);
}

describe('📼 Log Replay — Single Vessel Journey from Real Log', () => {
  let runner;

  beforeAll(async () => {
    runner = new RealAppTestRunner();
    await runner.initializeApp();
  }, 45000);

  afterAll(async () => {
    if (runner) await runner.cleanup();
  });

  test('Replays vessel 257941000 through canal segments from log and validates bridge text', async () => {
    const logPath = path.join(__dirname, '..', '..', 'logs', 'app-20250817-200035.log');
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split('\n');

    // Extract sequence combining proximity blocks and waiting check info for MMSI 257941000
    const MMSI = '257941000';
    const samples = [];
    let inProxBlock = false;
    let blockBuffer = '';
    let blockForMMSI = false;

    for (const line of lines) {
      // Start of proximity block for our MMSI
      if (!inProxBlock && line.includes('[PROXIMITY_ANALYSIS]') && line.includes(`${MMSI}:`)) {
        inProxBlock = true;
        blockForMMSI = true;
        blockBuffer = `${line}\n`;
        continue;
      }

      if (inProxBlock) {
        blockBuffer += `${line}\n`;
        // Heuristic end of block: a closing brace on its own line or next timestamp prefix
        if (line.trim() === '}' || /\d{4}-\d{2}-\d{2}T/.test(line)) {
          if (blockForMMSI) {
            const prox = parseProximityBlock(blockBuffer);
            if (prox.nearestBridge && prox.nearestDistance) {
              samples.push({ type: 'prox', ...prox });
            }
          }
          inProxBlock = false;
          blockForMMSI = false;
          blockBuffer = '';
        }
        continue;
      }

      // Single-line waiting check entries
      if (line.includes('[WAITING_CHECK]') && line.includes(MMSI)) {
        const { targetDistance, targetBridge } = parseWaitingCheckLine(line);
        if (targetDistance != null && targetBridge) {
          samples.push({ type: 'wait', targetDistance, targetBridge });
        }
      }
    }

    // Fuse proximity + waiting steps into a trajectory with position, target
    // Keep a manageable subset (e.g. first 40 fused snapshots)
    const fused = [];
    let lastTargetBridge = null;
    let lastCOG = null;
    let lastSOG = null;
    for (const s of samples) {
      if (s.type === 'prox') {
        // Build position estimate from nearest-bridge geometry
        const pos = computePositionFromNearest(s.nearestBridge, s.nearestDistance, s.cog);
        if (!pos) continue;
        lastCOG = Number.isFinite(s.cog) ? s.cog : lastCOG;
        lastSOG = Number.isFinite(s.sog) ? s.sog : lastSOG;
        fused.push({
          lat: pos.lat,
          lon: pos.lon,
          nearestBridge: s.nearestBridge,
          nearestDistance: s.nearestDistance,
          cog: lastCOG,
          sog: lastSOG,
          targetBridge: lastTargetBridge,
          targetDistance: null,
        });
      } else if (s.type === 'wait') {
        lastTargetBridge = s.targetBridge;
        if (fused.length > 0) {
          fused[fused.length - 1].targetBridge = s.targetBridge;
          fused[fused.length - 1].targetDistance = s.targetDistance;
        }
      }
      if (fused.length >= 40) break;
    }

    expect(fused.length).toBeGreaterThan(10);

    // Helper function for default COG
    const getDefaultCogForBridge = (targetBridge) => {
      return targetBridge === 'Klaffbron' ? 25 : 205;
    };

    // Feed into real app and validate bridge text invariants
    for (let i = 0; i < fused.length; i += 1) {
      const step = fused[i];
      // Build AIS message payload
      const ais = {
        mmsi: MMSI,
        lat: step.lat,
        lon: step.lon,
        sog: Number.isFinite(step.sog) ? step.sog : 3.0,
        cog: Number.isFinite(step.cog) ? step.cog : getDefaultCogForBridge(step.targetBridge),
        name: 'LOG Vessel 257941000',
      };

      // Process message through real app
      // eslint-disable-next-line no-await-in-loop
      await runner._processVesselAsAISMessage(ais);

      const bridgeText = runner.getCurrentBridgeText();

      // Validations derived from log distances (no false information rules)
      // 1) Waiting semantics: Distinguish target vs intermediate bridge
      // If text says "inväntar broöppning" for TARGET bridge but targetDistance > 300m → not allowed
      // If it says waiting for an INTERMEDIATE bridge, allow if nearestDistance <= 300m
      if (bridgeText.includes('inväntar broöppning')) {
        const m = bridgeText.match(/inväntar broöppning\s+(?:av|vid)\s+([^,]+)/);
        const waitingBridge = m ? m[1] : null;

        if (waitingBridge && step.targetBridge && waitingBridge === step.targetBridge) {
          if (Number.isFinite(step.targetDistance)) {
            expect(step.targetDistance <= 300).toBe(true);
          }
        } else if (waitingBridge) {
          if (Number.isFinite(step.nearestDistance)) {
            expect(step.nearestDistance <= 300).toBe(true);
          }
        }
      }

      // 2) If nearestDistance > 500m, message should NOT be waiting/under
      if (Number.isFinite(step.nearestDistance) && step.nearestDistance > 500) {
        const claimsWaiting = bridgeText.includes('inväntar broöppning');
        const claimsUnder = bridgeText.includes('Broöppning pågår') || bridgeText.includes('passerar');
        expect(claimsWaiting || claimsUnder).toBe(false);
      }

      // 3) If nearestDistance <= 50m, message may indicate under-bridge/passerar,
      //    but should not mention waiting.
      if (Number.isFinite(step.nearestDistance) && step.nearestDistance <= 50) {
        const claimsWaiting = bridgeText.includes('inväntar broöppning');
        expect(claimsWaiting).toBe(false);
      }
    }

    // Basic final sanity
    const finalText = runner.getCurrentBridgeText();
    expect(typeof finalText).toBe('string');

    // Print concise final summary for manual validation
    const { current, previous } = runner.getBridgeTextSnapshot();
    const nearest = runner.getCurrentNearestBridgeInfo();

    console.log('\n===== SLUTSAMLING (FÖR MANUELL VERIFIERING) =====');
    console.log(`BRIDGE TEXT (nu):      "${current}"`);
    console.log(`BRIDGE TEXT (tidigare): "${previous || '(saknas)'}"`);
    console.log(`POSITION:               ${nearest.name || '(okänd bro)'} ${nearest.distance != null ? `${nearest.distance}m` : '(okänt avstånd)'}`);
    console.log('=================================================');

    // Print full change timeline (previous → new + position)
    if (runner.bridgeTextHistory && runner.bridgeTextHistory.length > 0) {
      console.log('\nAlla bridge text-ändringar (i ordning):');
      runner.bridgeTextHistory.forEach((c, idx) => {
        const posName = c.nearest && c.nearest.name ? c.nearest.name : '(okänd bro)';
        const posDist = c.nearest && Number.isFinite(c.nearest.distance) ? `${c.nearest.distance}m` : '(okänt avstånd)';
        console.log(`\n${idx + 1}. Steg ${c.step} @ ${c.timestamp}`);
        console.log(`   Före: "${c.previousText}"`);
        console.log(`   Efter: "${c.newText}"`);
        console.log(`   Position: ${posName} ${posDist}`);
      });
      console.log('');
    }
  }, 90000);
});
