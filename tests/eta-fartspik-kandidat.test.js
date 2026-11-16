'use strict';

// Fartspikskandidaten (U28, dirigentens beslut 2026-11-16): ren detektion utan
// verkan. Fartspiksvakten är inte införd; dess signatur loggas som
// [ETA_SOG_SPIKE_CANDIDATE] och ingenting annat ändras. Fältfallet (körning 2,
// 13 nov 13:56Z): förra fixen 10,2 kn, nästa fix 70 s senare i målbytessamplet
// rapporterar 22,2 kn men har bara flyttat sig 356 m (9,9 kn). Positionerna här
// är syntetiska.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const {
  generateScenario, buildPath, pathMetrics,
} = require('./replay-validation/scenarioGenerator');

const M_PER_DEG_LAT = 111320;
const LAT0 = 58.30;
const LON0 = 12.30;
const MMSI = '900000003';
const KN70 = 0.5144 * 70;
const TAG = '[ETA_SOG_SPIKE_CANDIDATE]';

function makeCalculator() {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { calc: new ProgressiveETACalculator(logger, new BridgeRegistry()), logger };
}
const logged = (logger) => logger.log.mock.calls.filter(([m]) => m.includes(TAG)).length;

// En AISHub-fix `southM` meter söder om utgångspunkten, `tS` sekunder in.
function fix(southM, tS, sog, extra = {}) {
  const ts = 1800000000000 + tS * 1000;
  return {
    mmsi: MMSI,
    lat: LAT0 - southM / M_PER_DEG_LAT,
    lon: LON0,
    sog,
    cog: 180,
    fixTs: ts,
    fixFeed: 'aishub',
    timestamp: ts + 17000,
    targetBridge: 'Klaffbron',
    ...extra,
  };
}

// Förra fixen i P, målbyte (tom buffert) eller inte, nästa fix dt s senare som
// flyttat sig movedKn och rapporterar S. Returnerar nästa samples snitt.
function pair({
  P, movedKn, S, dt = 70, target = true, extraNext = {}, extraPrev = {},
}, calc) {
  calc._getAveragedSpeed(fix(0, 0, P, extraPrev), P);
  if (target) calc.clearVesselETAHistory(MMSI, 'target_transition_Stridsbergsbron_to_Klaffbron');
  return calc._getAveragedSpeed(fix(movedKn * 0.5144 * dt, dt, S, extraNext), S);
}

describe('Fartspikskandidaten: loggas, ändrar ingenting', () => {
  test('fältformen: raden kommer, och snittet är den rapporterade farten', () => {
    const { calc, logger } = makeCalculator();
    expect(pair({ P: 10.2, movedKn: 9.9, S: 22.2 }, calc)).toBe(22.2);
    expect(logged(logger)).toBe(1);
    const line = logger.log.mock.calls.find(([m]) => m.includes(TAG))[0];
    expect(line).toContain('rapporterad fart 22.2kn');
    expect(line).toContain('70 s');
    expect(calc._speedBuffers.get(MMSI)).toEqual([22.2]);
  });

  test('samma sampel en gång till (K6 efter nytt målbyte) loggas inte igen', () => {
    const { calc, logger } = makeCalculator();
    pair({ P: 10.2, movedKn: 9.9, S: 22.2 }, calc);
    calc.clearVesselETAHistory(MMSI, 'target_bridge_change_Stridsbergsbron_to_Klaffbron');
    calc._getAveragedSpeed(fix(9.9 * KN70, 70, 22.2), 22.2);
    expect(logged(logger)).toBe(1);
  });

  test.each([
    ['fylld buffert (inget målbyte)', {
      P: 10.2, movedKn: 9.9, S: 22.2, target: false,
    }],
    ['igångsättning från stillhet', { P: 0.2, movedKn: 1.0, S: 4.0 }],
    ['acceleration som syns i förflyttningen', { P: 4, movedKn: 5.5, S: 7.5 }],
    ['kvot 1,7', { P: 5, movedKn: 5, S: 8.5 }],
    ['överskott 2,8 kn', { P: 3.2, movedKn: 3.2, S: 6 }],
    ['fix 120 s isär', {
      P: 10.2, movedKn: 9.9, S: 22.2, dt: 120,
    }],
    ['fix 19 s isär', {
      P: 10.2, movedKn: 9.9, S: 22.2, dt: 19,
    }],
    ['GPS-misstänkt sampel', {
      P: 10.2, movedKn: 9.9, S: 22.2, extraNext: { _gpsJumpDetected: true },
    }],
    ['osäker förra position', {
      P: 10.2, movedKn: 9.9, S: 22.2, extraPrev: { _positionUncertain: true },
    }],
  ])('motfall: %s — ingen rad', (_name, o) => {
    const { calc, logger } = makeCalculator();
    const avg = pair(o, calc);
    expect(logged(logger)).toBe(0);
    // Snittet är bufferns vanliga: den rapporterade farten, eller med fylld
    // buffert medelvärdet av förra och nya.
    expect(avg).toBeCloseTo(o.target === false ? (o.P + o.S) / 2 : o.S, 9);
  });
});

// Hela kedjan: k2-formen som syntetiskt scenario (egna positioner) genom
// replayRunner, mot motfallet "igångsättning med hög kvot".
describe('Fartspikskandidaten i replayn', () => {
  const RUNNER = path.join(__dirname, 'replay-validation', 'replayRunner.js');
  const M = pathMetrics(buildPath());
  function candidateLines(scenario) {
    const samples = generateScenario(scenario);
    const file = path.join(os.tmpdir(), `kandidat-${scenario.seed}-${process.pid}.jsonl`);
    fs.writeFileSync(file, samples.map((x) => JSON.stringify(x)).join('\n'));
    try {
      const env = { ...process.env, REPLAY_VERBOSE: '1' };
      delete env.REPLAY_DEBUG_LEVEL;
      const r = spawnSync('node', [RUNNER, file], {
        encoding: 'utf8', maxBuffer: 256 << 20, env, timeout: 120000,
      });
      expect(r.status).toBe(0);
      return r.stderr.split('\n').filter((l) => l.includes(TAG));
    } finally {
      fs.unlinkSync(file);
    }
  }

  test('k2-formen: söderut 5 kn, 15 kn rapporterat i målbytessamplet 150 m söder om Stridsbergsbron', () => {
    const lines = candidateLines({
      name: 'kandidat-k2-form',
      seed: 4471,
      vessels: [{
        mmsi: '904471001',
        name: 'SYNT-KANDIDAT',
        startS: M.cum[4] - 150 + 8 * 5 * 0.5144 * 70,
        legs: [
          { toS: M.cum[4] - 150 + 1, speedKn: 5, intervalS: 70 },
          {
            toS: M.cum[4] - 150 - 5 * 0.5144 * 70 + 1, speedKn: 5, reportSogKn: 15, intervalS: 70,
          },
          { toS: M.cum[2] - 300, speedKn: 5, intervalS: 70 },
        ],
      }],
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('904471001');
    expect(lines[0]).toContain('Klaffbron');
  }, 180000);

  test('motfallet: igångsättning med hög kvot ger ingen rad', () => {
    const lines = candidateLines({
      name: 'kandidat-igangsattning',
      seed: 4472,
      vessels: [{
        mmsi: '904472001',
        name: 'SYNT-IGÅNG',
        startS: M.cum[2] - 1500,
        legs: [
          { toS: M.cum[2] - 700, speedKn: 4, intervalS: 30 },
          { stopS: 180, stopIntervalS: 60, stopSog: 0.1 },
          { toS: M.cum[2] + 300, speedKn: 4, intervalS: 30 },
        ],
      }],
    });
    expect(lines).toEqual([]);
  }, 180000);
});
