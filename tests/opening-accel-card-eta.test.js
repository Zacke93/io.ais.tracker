'use strict';

/**
 * KORTETS SIFFRA NÄR FARTÖKNINGSREGELN SLÄPPER VARNINGEN (sparr, 2026-11-15/16;
 * F7 alternativ (b), U28).
 *
 * Fartökningen före en nära bro emellan (BridgeOpeningService#_accelBeforeNearEarlier)
 * släpper spärren därför att regeln räknar med att båten går i minst
 * EARLIER_BRIDGE_ACCEL_KN. Kortet får då inte i samma ögonblick säga ETA-kedjans
 * väntans-ETA. På 8ca8a61 (regeln utan kortets siffra) sa kortet 6 och 5 min i
 * LIDAN- och NAVEN-formen när bron öppnade om drygt 3. Nu säger kortet den
 * lägsta av kedjans värde och regelns restid i max(fart, 5 kn), uppåt till hel
 * minut.
 *
 * Två former med egna positioner (samma ben som i runSyntheticScenarios, F7):
 * gång med fartökning (LIDAN) och kryp med fartökning (NAVEN). I båda ska
 * varningen komma minst 150 s före den sanna korsningen och kortets siffra ligga
 * högst 0,75 min från den sanna restiden (avrundningen till hela minuter är
 * 0,5). Basen 8c60237 fäller båda (ledtid 138 och 145 s), och 8ca8a61 fäller
 * siffran (6 mot 3,3 och 5 mot 3,0 min). Avgång ur stillhet omfattas inte av
 * regeln efter granskningen SPARR-d2 (H1); den formen är borttagen här.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  generateScenario, buildPath, pathMetrics, truthCrossings, BASE_TIME_MS,
} = require('./replay-validation/scenarioGenerator');

const M = pathMetrics(buildPath());
const SB = M.cum[4];
const JVB = M.cum[3];
const KB = M.cum[2];
const st = (v) => v * 0.5144 * 67;

const FORMS = [
  {
    name: 'LIDAN-formen (gång 2,5 → 3,0 → 3,5 kn, sedan 5,6 kn)',
    scenario: {
      seed: 5142,
      vessels: [{
        mmsi: '905142001',
        startS: KB - 500,
        legs: (() => {
          const b3 = SB - 500;
          const b2 = b3 - st(3.0);
          const A = { intervalS: 67, fixLagS: 30 };
          return [
            { toS: b2 - 3 * st(2.5), speedKn: 3.7, ...A },
            { toS: b2, speedKn: 2.5, ...A },
            { toS: b3, speedKn: 3.0, ...A },
            { toS: b3 + st(3.5), speedKn: 3.5, ...A },
            { toS: SB + 400, speedKn: 5.6, ...A },
          ];
        })(),
      }],
    },
  },
  {
    name: 'NAVEN-formen (kryp 1,6 kn, ett fix i 3,8 kn, sedan 5,5 kn)',
    scenario: {
      seed: 5122,
      vessels: [{
        mmsi: '905122001',
        startS: KB - 500,
        legs: [
          {
            toS: JVB - 700, speedKn: 4.0, intervalS: 67, fixLagS: 20,
          },
          {
            toS: JVB - 200, speedKn: 1.6, intervalS: 67, fixLagS: 20,
          },
          {
            toS: JVB - 70, speedKn: 3.8, intervalS: 67, fixLagS: 20,
          },
          {
            toS: SB + 400, speedKn: 5.5, intervalS: 67, fixLagS: 20,
          },
        ],
      }],
    },
  },
];

describe('kortets siffra när fartökningsregeln släpper varningen (F7, U28)', () => {
  test.each(FORMS.map((f) => [f.name, f.scenario]))('%s', (_name, scenario) => {
    const samples = generateScenario(scenario);
    const [{ mmsi }] = scenario.vessels;
    const file = path.join(os.tmpdir(), `opening-accel-card-eta-${scenario.seed}-${process.pid}.jsonl`);
    fs.writeFileSync(file, samples.map((s) => JSON.stringify(s)).join('\n'));
    let result;
    try {
      const out = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), file], {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env, REPLAY_MONITORING: '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
        },
      });
      result = JSON.parse(out.match(/__REPLAY_JSON__([\s\S]*?)__END__/)[1]);
    } finally {
      fs.rmSync(file, { force: true });
    }
    const [crossing] = truthCrossings(samples.truthPaths[mmsi], SB);
    const crossingMs = BASE_TIME_MS + crossing.tS * 1000;
    const warnings = result.openingWarnings.filter((w) => w.bridge === 'Stridsbergsbron' && w.mmsis.includes(mmsi));
    expect(warnings).toHaveLength(1);
    const [card] = warnings;
    expect(crossingMs - card.t).toBeGreaterThanOrEqual(150000);
    const truthMin = (crossingMs - card.t) / 60000;
    expect(Number.isFinite(card.etaMin)).toBe(true);
    expect(Math.abs(card.etaMin - truthMin)).toBeLessThanOrEqual(0.75);
    expect(result.processErrors).toBe(0);
  }, 90000);
});
