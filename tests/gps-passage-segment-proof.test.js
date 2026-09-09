'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { BRIDGES } = require('../lib/constants');
const VesselDataService = require('../lib/services/VesselDataService');
const { generateScenario, buildPath, pathMetrics } = require('./replay-validation/scenarioGenerator');

describe('GPS-hopp över en bro och återhämtning genom hela appen', () => {
  const metrics = pathMetrics(buildPath());
  let tempDir;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-gps-passage-proof-'));
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test.each([
    ['north', 'klaffbron', 2],
    ['south', 'klaffbron', 2],
    ['north', 'jarnvagsbron', 3],
    ['south', 'jarnvagsbron', 3],
    ['north', 'stridsbergsbron', 4],
    ['south', 'stridsbergsbron', 4],
  ])('%s över %s: varken hoppet eller återhoppet får bevisa passage', (direction, bridgeId, index) => {
    const bridge = BRIDGES[bridgeId];
    const vessel = {
      mmsi: '901009023', direction, speedKn: 4.5, jitterM: 0,
    };
    // Den ostörda resan är det oberoende facit som generatorn sedan lägger
    // ett enda positionsfel ovanpå. Ingen förväntad tid hämtas från appen.
    const clean = generateScenario({ seed: 29, vessels: [{ ...vessel }] });
    const bridgeFraction = (direction === 'north' ? metrics.cum[index] : metrics.total - metrics.cum[index]) / metrics.total;
    const samples = generateScenario({
      seed: 29,
      vessels: [{
        ...vessel,
        gpsJump: {
          atFraction: bridgeFraction - 150 / metrics.total,
          offsetM: direction === 'north' ? 300 : -300,
        },
      }],
    });
    const jumpIndex = samples.findIndex((sample, i) => sample.lat !== clean[i].lat);
    const beyond = (sample) => (direction === 'north' ? sample.lat > bridge.lat : sample.lat < bridge.lat);
    const firstRealPassage = clean.find((sample) => beyond(sample));
    expect(jumpIndex).toBeGreaterThan(0);
    expect(beyond(samples[jumpIndex])).toBe(true);
    expect(beyond(samples[jumpIndex + 1])).toBe(false);
    expect(firstRealPassage.aisTimestamp).toBeGreaterThan(samples[jumpIndex + 1].aisTimestamp);

    const input = path.join(tempDir, `${direction}-${bridgeId}.jsonl`);
    fs.writeFileSync(input, samples.map((sample) => JSON.stringify(sample)).join('\n'));
    const stdout = execFileSync(process.execPath, [
      path.join(__dirname, 'replay-validation/replayRunner.js'), input,
    ], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_FUSION: '0', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
      },
    });
    const result = JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]);
    const passages = [...result.targetPassages, ...result.intermediatePassages]
      .filter((passage) => passage.bridge === bridge.name);
    expect(passages).toHaveLength(1);
    expect(passages[0].t).toBeGreaterThanOrEqual(firstRealPassage.aisTimestamp);
    expect(passages[0].t).toBeLessThanOrEqual(firstRealPassage.aisTimestamp + 120000);
    expect(result.targetPassages).toHaveLength(2);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  }, 20000);

  test.each([
    ['för gammalt', -21 * 60000],
    ['från framtiden', 60000],
    ['utan tidsstämpel', null],
  ])('ett GPS-fel får inte bevisa passage med ett ankare %s', (label, offset) => {
    const bridge = BRIDGES.klaffbron;
    const oldVessel = {
      mmsi: '901009023',
      lat: bridge.lat - 0.001,
      lon: bridge.lon,
      _gpsJumpDetected: true,
      _passageRecoveryPosition: {
        lat: bridge.lat - 0.001,
        lon: bridge.lon,
        timestamp: offset === null ? null : Date.now() + offset,
      },
    };
    const vessel = {
      mmsi: oldVessel.mmsi, targetBridge: bridge.name, lat: bridge.lat + 0.001, lon: bridge.lon,
    };
    // Båda koordinatparen korsar bron geometriskt. Utan ett giltigt rent
    // ankare får ändå ingen av produktionsvägarna registrera en passage.
    expect(VesselDataService.prototype._hasPassedTargetBridge.call({}, vessel, oldVessel)).toBe(false);
    expect(VesselDataService.prototype._hasPassedBridge.call({}, vessel, oldVessel, bridge)).toBe(false);
  });
});
