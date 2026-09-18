'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const { BRIDGES, WAITING_STATUS_MAX_ETA_MINUTES } = require('../lib/constants');
const { generateScenario } = require('./replay-validation/scenarioGenerator');
const { validateInvariants, validateWarnInvariants } = require('./replay-validation/invariants');

describe('Väntestatusens ETA-tak tillhör den bro båten väntar vid', () => {
  let calculator;
  let proximity;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-01-01T06:00:00Z') });
    const logger = { debug: jest.fn(), error: jest.fn() };
    const registry = new BridgeRegistry();
    calculator = new ProgressiveETACalculator(logger, registry);
    proximity = new ProximityService(registry, logger);
  });

  afterEach(() => {
    calculator.destroy();
    jest.useRealTimers();
  });

  const boat = (near, target) => ({
    mmsi: '901000025',
    lat: BRIDGES[near].lat - 200 / 111320,
    lon: BRIDGES[near].lon,
    sog: 0.5,
    cog: 20,
    timestamp: Date.now(),
    status: 'waiting',
    waitingAtBridge: BRIDGES[near].name,
    targetBridge: BRIDGES[target].name,
    _routeDirection: 'north',
  });

  test.each([
    ['olidebron', 'klaffbron'],
    ['jarnvagsbron', 'stridsbergsbron'],
  ])('väntan vid %s kapar inte restiden till %s', (near, target) => {
    const vessel = boat(near, target);
    const result = calculator.calculateProgressiveETA(vessel, proximity.analyzeVesselProximity(vessel));

    expect(result).toBeGreaterThan(WAITING_STATUS_MAX_ETA_MINUTES);
  });

  test('målbrons egen väntan behåller sitt tak och skydd mot ETA-ökning', () => {
    const vessel = boat('klaffbron', 'klaffbron');
    const data = proximity.analyzeVesselProximity(vessel);
    const first = calculator.calculateProgressiveETA(vessel, data);

    expect(first).toBe(WAITING_STATUS_MAX_ETA_MINUTES);
    jest.advanceTimersByTime(60000);
    const second = calculator.calculateProgressiveETA({ ...vessel, sog: 0.1, timestamp: Date.now() }, data);
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThanOrEqual(first);
  });

  test('bekräftad väntbro går före en annan närmaste bro i zonöverlappet', () => {
    const vessel = boat('jarnvagsbron', 'stridsbergsbron');
    vessel.waitingAtBridge = 'Stridsbergsbron';
    const data = proximity.analyzeVesselProximity(vessel);
    expect(data.nearestBridge.name).toBe('Järnvägsbron');

    expect(calculator.calculateProgressiveETA(vessel, data)).toBe(WAITING_STATUS_MAX_ETA_MINUTES);
  });
});

test('0,8 kn genom Olidebron ger ingen falsk låg mål-ETA följd av 28→54-minutersstigning', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-eta-waiting-bridge-'));
  try {
    // Samma indata som det befintliga syntetiska krypfartsscenariot.
    const samples = generateScenario({
      seed: 31,
      vessels: [{
        mmsi: '901000025', direction: 'north', speedKn: 0.8, reportIntervalS: 300,
      }],
    });
    const input = path.join(directory, 'creeping.jsonl');
    fs.writeFileSync(input, samples.map((sample) => JSON.stringify(sample)).join('\n'));
    const output = execFileSync(process.execPath, [
      path.join(__dirname, 'replay-validation/replayRunner.js'), input,
    ], {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
      },
    });
    const result = JSON.parse(output.match(/__REPLAY_JSON__([\s\S]*?)__END__/)[1]);
    const times = ['2026-01-01T06:55:01Z', '2026-01-01T07:00:01Z', '2026-01-01T07:05:01Z'];
    const estimates = times.map((time) => {
      const row = result.bridgeTextTransitions.filter((entry) => entry.t <= Date.parse(time)).at(-1);
      expect(row).toBeDefined();
      expect(row.text).toContain('Klaffbron');
      return Number(row.text.match(/om (\d+) minuter/)[1]);
    });

    // Avståndet krymper vid jämn fart. Prognosen ska inte först kapas till
    // mellanbrons väntetak och sedan återhämta sig när väntestatusen upphör.
    expect(estimates[0]).toBeGreaterThan(50);
    expect(estimates[1]).toBeLessThan(estimates[0]);
    expect(estimates[2]).toBeLessThan(estimates[1]);
    expect(validateWarnInvariants(result).filter((warning) => warning.startsWith('INV-18'))).toEqual([]);
    expect(validateInvariants(result)).toEqual([]);
    expect(result.targetPassages).toHaveLength(2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
