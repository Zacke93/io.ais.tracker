'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const { BRIDGES } = require('../lib/constants');
const { generateScenario, buildPath, pathMetrics } = require('./replay-validation/scenarioGenerator');

const START = Date.parse('2026-10-05T08:00:00Z');
const MMSI = '265123456';

describe('Öppningsdeadlinen kräver betrodda positionsbevis för att ändras', () => {
  let service;
  let warnings;
  let logger;

  const vessel = (offsetM = -1500, extra = {}) => ({
    mmsi: MMSI,
    name: 'PROVBÅT',
    lat: BRIDGES.klaffbron.lat + offsetM / 111320,
    lon: BRIDGES.klaffbron.lon,
    sog: 4,
    cog: 0,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aisstream',
    targetBridge: 'Klaffbron',
    _routeDirection: 'north',
    _hasMovementProof: true,
    passedBridges: ['Olidebron'],
    etaMinutes: 15,
    ...extra,
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    warnings = jest.fn();
    logger = {
      log: jest.fn(), error: jest.fn(), debug: jest.fn(),
    };
    service = new BridgeOpeningService({ logger, scheduleDeadlines: true, onWarning: warnings });
  });

  afterEach(() => {
    service.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  test.each([
    ['GPS-hopp över bron', 400, { _gpsJumpDetected: true }],
    ['orimligt mellanstort hopp nära bron', -200, {
      _positionUncertain: true, _positionAnalysis: { reason: 'medium_movement_speed_mismatch' },
    }],
    ['GPS-hopp utanför beväpningsområdet', -4000, { _gpsJumpDetected: true }],
    ['GPS-hopp med tappad målbro', -400, { _gpsJumpDetected: true, targetBridge: null }],
    ['GPS-hopp med annan målbro', 400, { _gpsJumpDetected: true, targetBridge: 'Stridsbergsbron' }],
  ])('%s varken släcker, tidigarelägger eller flyttar den betrodda varningen', (_name, offsetM, extra) => {
    service.observeVessel(vessel());
    const trusted = service._arms.get(`${MMSI}::Klaffbron`);
    const expectedDue = trusted.fireDueMs;
    const expectedDistance = Math.round(trusted.distanceM);
    expect(warnings).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    service.observeVessel(vessel(offsetM, extra));
    expect(warnings).not.toHaveBeenCalled();
    jest.advanceTimersByTime(Math.ceil(expectedDue - Date.now()) + 1);

    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0][0]).toMatchObject({
      bridge: 'Klaffbron', distanceM: expectedDistance, firedBy: 'deadline',
    });
    expect(warnings.mock.calls[0][0].t).toBe(Math.ceil(expectedDue));
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('enbart GPS-flaggad förstakontakt beväpnar ingen prognos; ren återhämtning gör det', () => {
    service.observeVessel(vessel(-200, { _gpsJumpDetected: true }));
    jest.advanceTimersByTime(60000);
    expect(warnings).not.toHaveBeenCalled();
    expect(service.getStats().armed).toBe(0);

    service.observeVessel(vessel(-200));
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0][0]).toMatchObject({ bridge: 'Klaffbron', firedBy: 'fix' });
  });

  test('ren återhämtning uppdaterar deadline och verklig passage avslutar den', () => {
    service.observeVessel(vessel());
    const firstDue = service._arms.get(`${MMSI}::Klaffbron`).fireDueMs;
    jest.advanceTimersByTime(1000);
    service.observeVessel(vessel(400, { _gpsJumpDetected: true }));
    jest.advanceTimersByTime(30000);
    service.observeVessel(vessel(-1400));
    const freshDue = service._arms.get(`${MMSI}::Klaffbron`).fireDueMs;
    expect(freshDue).toBeGreaterThan(firstDue);
    service.notePassage(MMSI, 'Klaffbron');
    jest.advanceTimersByTime(20 * 60000);
    expect(warnings).not.toHaveBeenCalled();
  });

  test('fysiskt rimligt långt glapp med allmän försiktighet får fortfarande beväpna', () => {
    const previous = vessel(-2100, { timestamp: START - 300000, fixTs: START - 300000, cog: 80 });
    const current = vessel(-1500, { cog: 80 });
    const analysis = new GPSJumpAnalyzer(logger).analyzeMovement(MMSI, current, previous, current, previous);
    expect(analysis).toMatchObject({ action: 'accept_with_caution', reason: 'uncertain_movement', isGPSJump: false });
    service.observeVessel({ ...current, _positionUncertain: true, _positionAnalysis: analysis });
    jest.advanceTimersByTime(5 * 60000);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0][0].bridge).toBe('Klaffbron');
  });
});

describe('GPS-hopp följt av AIS-tystnad genom hela appen', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-opening-gps-proof-'));
  });

  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  function replay(samples, name) {
    const file = path.join(tempDir, `${name}.jsonl`);
    fs.writeFileSync(file, samples.map((sample) => JSON.stringify(sample)).join('\n'));
    const stdout = execFileSync(process.execPath, [
      path.join(__dirname, 'replay-validation/replayRunner.js'), file,
    ], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_FUSION: '0', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
      },
    });
    return JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]);
  }

  test('ett flaggat hopp över Klaffbron får inte förbruka den beväpnade förvarningen', () => {
    const metrics = pathMetrics(buildPath());
    const boat = {
      mmsi: '901009023', direction: 'north', speedKn: 4.5, jitterM: 0,
    };
    const clean = generateScenario({ seed: 29, vessels: [{ ...boat }] });
    const jump = generateScenario({
      seed: 29,
      vessels: [{
        ...boat,
        gpsJump: { atFraction: (metrics.cum[2] - 1300) / metrics.total, offsetM: 1600 },
      }],
    });
    const jumpIndex = jump.findIndex((sample, i) => sample.lat !== clean[i].lat);
    expect(jumpIndex).toBeGreaterThan(0);
    expect(clean[jumpIndex].lat).toBeLessThan(BRIDGES.klaffbron.lat);
    expect(jump[jumpIndex].lat).toBeGreaterThan(BRIDGES.klaffbron.lat);
    const firstRealPassage = clean.find((sample) => sample.lat > BRIDGES.klaffbron.lat);
    const withSilence = (samples) => samples.filter((_sample, i) => i <= jumpIndex || i >= jumpIndex + 12);
    const baseline = replay(withSilence(clean), 'ren');
    const disturbed = replay(withSilence(jump), 'gps-hopp');

    const warningsAtKlaff = (result) => result.openingWarnings.filter((warning) => warning.bridge === 'Klaffbron');
    expect(warningsAtKlaff(baseline)).toHaveLength(1);
    expect(warningsAtKlaff(disturbed)).toHaveLength(1);
    expect(warningsAtKlaff(disturbed)[0].t).toBeLessThan(firstRealPassage.aisTimestamp);
    expect(warningsAtKlaff(disturbed)[0].firedBy).toBe('deadline');
    expect(disturbed.targetPassages).toEqual(baseline.targetPassages);
    expect(disturbed.processErrors).toBe(0);
    expect(disturbed.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  }, 20000);
});
