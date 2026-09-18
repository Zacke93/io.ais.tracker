'use strict';

jest.mock('homey');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const {
  generateScenario, buildPath, pathMetrics, BASE_TIME_MS,
} = require('./replay-validation/scenarioGenerator');

describe('Närnotiser väntar på positionsbevis efter GPS-störning', () => {
  let app;
  const now = Date.parse('2026-09-18T10:00:00Z');

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = { hasGpsJumpHold: jest.fn(() => false) };
    app._boatNearTrigger = {};
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['GPS-hopp efter att korta tidslåset löpt ut', { _gpsJumpDetected: true }],
    ['fysiskt orimlig position', { _positionUncertain: true, _positionAnalysis: { reason: 'medium_movement_speed_mismatch' } }],
    ['aktivt tidslås', {}],
  ])('%s reserverar ingen notis före återhämtningen', async (label, flags) => {
    const vessel = {
      mmsi: '901000049',
      name: 'GPS-TEST',
      lat: 58.2834,
      lon: 12.2838,
      sog: 4.5,
      cog: 35,
      _routeDirection: 'north',
      _hasMovementProof: true,
      targetBridge: 'Klaffbron',
      status: 'approaching',
      etaMinutes: 1,
      timestamp: now - 30000,
      lastPositionUpdate: now - 30000,
      ...flags,
    };
    if (label === 'aktivt tidslås') app.vesselDataService.hasGpsJumpHold.mockReturnValue(true);
    const candidate = {
      name: 'Klaffbron', id: 'klaffbron', source: 'target', distance: 60,
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    await app._triggerBoatNearFlowFallback(vessel, 'Klaffbron', { passageTimestamp: now });

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.size).toBe(0);
    expect(app._persistentRecentTriggers.size).toBe(0);

    app.vesselDataService.hasGpsJumpHold.mockReturnValue(false);
    const clean = {
      ...vessel, _gpsJumpDetected: false, _positionUncertain: false, timestamp: now,
    };
    await app._triggerBoatNearFlowForBridge(clean, candidate);
    await app._triggerBoatNearFlowForBridge(clean, candidate);
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    expect(app._triggerBoatNearFlowBest.mock.calls[0][0].direction).toBe('norrut');
  });
});

describe('Hela resan: GPS-hopp in i notiszonen', () => {
  let dir;
  let file;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-gps-notice-'));
    file = path.join(dir, 'jump.jsonl');
    const metrics = pathMetrics(buildPath());
    const samples = generateScenario({
      seed: 49,
      vessels: [{
        mmsi: '901000049',
        name: 'SYNT-HOPPGRÄNS',
        direction: 'north',
        speedKn: 4.5,
        gpsJump: { atFraction: (metrics.cum[2] - 350) / metrics.total, offsetM: 500 },
      }],
    });
    fs.writeFileSync(file, `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test.each([false, true])('tidslåsets utgång skickar ingen notis från hoppet, monitoring=%s', (monitoring) => {
    const stdout = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), file], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: monitoring ? '1' : '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
      },
    });
    const result = JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    const notices = result.notifications.filter((n) => n.bridge === 'Klaffbron');
    expect(notices).toHaveLength(1);
    // Det injicerade hoppet kommer minut 18; första verkliga återkomst minut 19.
    // Förut avfyrade UI-timern på samma hoppfix vid 18:30 efter 2 s-holden.
    expect(notices[0].t).toBeGreaterThanOrEqual(BASE_TIME_MS + 19 * 60000);
    expect(notices[0]).toMatchObject({ direction: 'northbound', success: true, alreadyPassed: false });
    expect(result.notificationCount).toBe(6);
    expect(result.targetPassages).toHaveLength(2);
    expect(result.openingWarnings).toHaveLength(2);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  });

  test.each([false, true])('ELFKUNGENs rimliga förflyttning i AIS-glappet får sin passagenotis, monitoring=%s', (monitoring) => {
    const corpora = require('./replay-validation/corpora');
    const corpus = corpora.find((entry) => entry.id === '20260712-25h');
    const stdout = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), corpus.jsonl], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: monitoring ? '1' : '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
      },
    });
    const result = JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    // Råfixet kommer efter 25 minuter med rimlig förflyttning, men farten
    // skiljer sig från glappets medelfart. Allmän osäkerhet får inte radera
    // den geometriskt och tidsmässigt belagda Stridspassagen.
    const t = Date.parse('2026-07-13T10:54:29.213Z');
    expect(result.targetPassages).toContainEqual(expect.objectContaining({ mmsi: '265573130', bridge: 'Stridsbergsbron', t }));
    expect(result.notifications.filter((n) => n.mmsi === '265573130' && n.bridge === 'Stridsbergsbron'))
      .toEqual([
        expect.objectContaining({
          t, direction: 'northbound', success: true, alreadyPassed: true,
        }),
        expect.objectContaining({
          t: Date.parse('2026-07-13T13:06:20.330Z'), direction: 'southbound', success: true, alreadyPassed: true,
        }),
      ]);
    expect(result.notificationCount).toBe(85);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  });
});
