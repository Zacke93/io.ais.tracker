'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');
const { validateInvariants } = require('./replay-validation/invariants');

// SOAK-RESA-20, seed 46: tre på varandra följande råfixar vid högbron.
const FIXES = [
  { lat: 58.31044122083327, lon: 12.317586787217902, sog: 4.065361735410988 },
  { lat: 58.309558323977306, lon: 12.316445754628186, sog: 3.9068551233038304 },
  { lat: 58.308670045025586, lon: 12.315125336732304, sog: 3.9800808611791583 },
];
const START = Date.parse('2026-01-02T22:39:00Z');
const BRIDGE = BRIDGES.stallbackabron;

function replay(file) {
  const stdout = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, REPLAY_MONITORING: '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
    },
  });
  const result = JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  expect(result.processErrors).toBe(0);
  expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  expect(validateInvariants(result)).toEqual([]);
  return result;
}

describe('Stallbackas fysiska passagebevis är oberoende av textstatusen', () => {
  let status;
  let proximity;
  let coordinator;
  let vessel;
  let mode;
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    mode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    const logger = {
      debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const registry = new BridgeRegistry();
    coordinator = new SystemCoordinator(logger);
    status = new StatusService(registry, logger, coordinator, { anchorPassageTimestamp: jest.fn() });
    proximity = new ProximityService(registry, logger);
    vessel = {
      mmsi: '902001020', name: 'SOAK-RESA-20', sog: 4, cog: 215, targetBridge: 'Stridsbergsbron', _routeDirection: 'south', passedBridges: [], status: 'en-route',
    };
  });
  afterEach(() => {
    status.progressiveETACalculator.destroy();
    coordinator.destroy();
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = mode;
    jest.useRealTimers();
  });
  const observe = (fix, index, analysis = null) => {
    jest.setSystemTime(START + index * 60000);
    Object.assign(vessel, fix, {
      timestamp: Date.now(), fixTs: Number.isFinite(fix.fixTs) ? fix.fixTs : Date.now(), fixFeed: fix.fixFeed || 'aisstream', lastPositionUpdate: Date.now(),
    });
    const result = status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), analysis);
    vessel.status = result.status;
    return result;
  };
  const setupCross = () => {
    observe(FIXES[0], 0);
    observe(FIXES[1], 1);
    expect(vessel._underBridgeCrossedBridge).toBe('Stallbackabron');
  };
  const exitResult = (exit = FIXES[2]) => geometry.detectBridgePassage({ ...vessel, ...exit }, vessel, BRIDGE);

  test('86m före →32m efter ger ankare; först utgången32→157m bokförs', () => {
    observe(FIXES[0], 0);
    expect(geometry.detectBridgePassage({ ...vessel, ...FIXES[1] }, vessel, BRIDGE).passed).toBe(false);
    const result = observe(FIXES[1], 1);
    expect(result.status).toBe('stallbacka-waiting');
    expect(vessel._underBridgeLatched).toBeFalsy();
    expect(vessel._underBridgeCrossedBridge).toBe('Stallbackabron');
    expect(exitResult()).toMatchObject({ passed: true, method: 'traditional_close_passage' });
  });

  test('norrgående högbropassage använder samma nettobevis', () => {
    vessel.targetBridge = null;
    vessel.cog = 35;
    vessel._routeDirection = 'north';
    const mirror = (p) => ({ ...p, lat: 2 * BRIDGE.lat - p.lat, lon: 2 * BRIDGE.lon - p.lon });
    observe(mirror(FIXES[0]), 0);
    observe(mirror(FIXES[1]), 1);
    expect(vessel._underBridgeCrossedBridge).toBe('Stallbackabron');
    expect(exitResult(mirror(FIXES[2])).passed).toBe(true);
  });

  test('U-sväng tillbaka ut på ingångssidan saknar nettopassage', () => {
    setupCross();
    const returned = { lat: 2 * BRIDGE.lat - FIXES[1].lat, lon: 2 * BRIDGE.lon - FIXES[1].lon, sog: 4 };
    observe(returned, 2);
    const originalSideExit = { lat: 2 * BRIDGE.lat - FIXES[2].lat, lon: 2 * BRIDGE.lon - FIXES[2].lon, sog: 4 };
    expect(exitResult(originalSideExit).passed).toBe(false);
    observe(originalSideExit, 3);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
    expect(vessel._underBridgeEntryLat).toBeNull();
  });

  test('zonutgång rensar ankaret före ett nytt besök på samma sida', () => {
    setupCross();
    observe(FIXES[2], 2);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
    expect(vessel._underBridgeEntryLat).toBeNull();
    observe(FIXES[1], 3);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
    expect(exitResult().passed).toBe(false);
  });

  test('bokförd passage rensar även medan båten ännu är inom 50m', () => {
    setupCross();
    vessel.passedBridges = ['Stallbackabron'];
    observe(FIXES[1], 2);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
    expect(vessel._underBridgeEntryLat).toBeNull();
  });

  test('verklig ny retur får ett nytt ankare från den egna ingångssidan', () => {
    setupCross();
    observe(FIXES[2], 2);
    observe(FIXES[1], 3);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
    const returned = { lat: 2 * BRIDGE.lat - FIXES[1].lat, lon: 2 * BRIDGE.lon - FIXES[1].lon, sog: 4 };
    observe(returned, 4);
    expect(vessel._underBridgeCrossedBridge).toBe('Stallbackabron');
    expect(vessel._underBridgeEntryLat).toBeLessThan(BRIDGE.lat);
    const originalSideExit = { lat: 2 * BRIDGE.lat - FIXES[2].lat, lon: 2 * BRIDGE.lon - FIXES[2].lon, sog: 4 };
    expect(exitResult(originalSideExit).passed).toBe(true);
  });

  test.each(['GPS-hopp', 'målbyte'])('%s avbryter det tidigare beviset', (reason) => {
    setupCross();
    if (reason === 'målbyte') vessel.targetBridge = 'Klaffbron';
    observe(FIXES[1], 2, reason === 'GPS-hopp' ? { gpsJumpDetected: true } : null);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
    expect(exitResult().passed).toBe(false);
  });

  test.each([[20 * 60000, true], [20 * 60000 + 1, false]])('rent basbevis med receivegap %ims', (gap, allowed) => {
    observe(FIXES[0], 0);
    observe(FIXES[1], gap / 60000);
    expect(vessel._underBridgeCrossedBridge === 'Stallbackabron').toBe(allowed);
  });

  test('för gammalt råfixgap får inte föryngras av tätare leveranser', () => {
    observe({ ...FIXES[0], fixTs: START - 2 * 60000 }, 0);
    observe(FIXES[1], 19);
    expect(vessel._underBridgeCrossedBridge).toBeFalsy();
  });

  test.each([0, -1000])('oförändrad eller äldre råfixtid %ims bevisar ingen ny förflyttning', (dt) => {
    observe(FIXES[0], 0);
    observe({ ...FIXES[1], fixTs: START + dt }, 1);
    expect(vessel._underBridgeCrossedBridge).toBeFalsy();
  });

  test('korskällans fixtidsordning följer den befintliga kanoniska reservklockan', () => {
    observe({ ...FIXES[0], fixFeed: 'aishub' }, 0);
    observe({ ...FIXES[1], fixFeed: 'aisstream', fixTs: START - 1000 }, 1);
    expect(vessel._underBridgeCrossedBridge).toBe('Stallbackabron');
  });

  test('gammal aktuell hubposition ger inte bevis trots kort inbördes råfixgap', () => {
    observe({ ...FIXES[0], fixTs: START - 15 * 60000, fixFeed: 'aishub' }, 0);
    observe({ ...FIXES[1], fixTs: START - 14 * 60000, fixFeed: 'aishub' }, 1);
    expect(vessel._underBridgeCrossedBridge).toBeFalsy();
  });

  test('timerpass föryngrar aldrig observationsklockan', () => {
    observe(FIXES[0], 0);
    for (let minute = 1; minute <= 19; minute += 1) {
      jest.setSystemTime(START + minute * 60000);
      status.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel));
      expect(vessel._underBridgePrevClock.timestamp).toBe(START);
      expect(vessel._underBridgePrevClock.fixTs).toBe(START);
    }
    observe(FIXES[1], 21);
    expect(vessel._underBridgeCrossedBridge).toBeFalsy();
  });

  test('färska identiska AIS-positioner under två timmar håller den verkliga observationsklockan aktuell', () => {
    for (let minute = 0; minute <= 120; minute += 1) observe({ ...FIXES[0], sog: 0.1 }, minute);
    expect(vessel._underBridgePrevClock.timestamp).toBe(START + 120 * 60000);
    expect(vessel._underBridgePrevSog).toBe(0.1);
    observe(FIXES[1], 121);
    expect(vessel._underBridgeCrossedBridge).toBe('Stallbackabron');
    expect(exitResult().passed).toBe(true);
  });

  test('historiklöst AIS-objekt efter utgången kan inte låna ett tidigare ankare', () => {
    setupCross();
    vessel = {
      mmsi: '902001020', name: 'SOAK-RESA-20', sog: 4, cog: 215, targetBridge: 'Stridsbergsbron', _routeDirection: 'south', passedBridges: [], status: 'en-route',
    };
    observe(FIXES[1], 31);
    expect(vessel._underBridgeCrossedBridge).toBeFalsy();
    expect(exitResult().passed).toBe(false);
  });

  test('stillastående GPS-jitter över linjen ger inget korsningsankare', () => {
    observe({ lat: BRIDGE.lat + 20 / 111320, lon: BRIDGE.lon, sog: 0.1 }, 0);
    observe({ lat: BRIDGE.lat - 20 / 111320, lon: BRIDGE.lon, sog: 0.1 }, 1);
    expect(vessel._underBridgeCrossedBridge).toBeFalsy();
  });

  test('GPS-osäker inträdesfix kan inte skapa ett korsningsankare', () => {
    observe(FIXES[0], 0);
    observe({ ...FIXES[1], _positionUncertain: true }, 1);
    expect(vessel._underBridgeCrossedBridge).toBeFalsy();
  });

  test.each(['_gpsJumpDetected', '_positionUncertain'])('%s utan separat analysis blir ingen ren startpunkt', (flag) => {
    const realSide = { lat: 2 * BRIDGE.lat - FIXES[0].lat, lon: 2 * BRIDGE.lon - FIXES[0].lon, sog: 4 };
    observe(realSide, 0);
    observe({ ...FIXES[0], [flag]: true }, 1);
    expect(vessel._underBridgePrevLat).toBe(realSide.lat);
    observe({ ...FIXES[1], [flag]: false }, 2);
    expect(vessel._underBridgeCrossedBridge).toBeFalsy();
    expect(exitResult().passed).toBe(false);
  });
});

describe('Fullappen efter Stallbackapassagen', () => {
  test('SOAK-RESA-20s råfixar ger fallande ETA och exakt en mellanpassage', () => {
    const result = replay(path.join(__dirname, 'replay-validation/fixtures/soak-resa-20.jsonl'));
    expect(result.intermediatePassages.filter((p) => p.mmsi === '902001020' && p.bridge === 'Stallbackabron'))
      .toEqual([{
        t: START + 2 * 60000, iso: '2026-01-02T22:41:00.000Z', mmsi: '902001020', bridge: 'Stallbackabron', noTarget: false,
      }]);
    const etas = result.bridgeTextTransitions
      .filter((r) => r.t >= START + 60000 && r.t < START + 11 * 60000)
      .map((r) => r.text.match(/Stridsbergsbron, beräknad broöppning om (\d+) minuter/))
      .filter(Boolean).map((m) => Number(m[1]));
    expect(etas).toEqual([18, 17, 16, 15, 14, 13, 12, 11, 10, 9]);
    expect(result.notifications.filter((n) => n.bridge === 'Stallbackabron')).toHaveLength(1);
  });

  test('ALICEs tidigare återvunna Olidepassage består utan ETA-metodväxling', () => {
    const prefix = path.join(__dirname, 'replay-validation/corpora-data/ais-replay-20260711-232958.jsonl');
    const rows = fs.readFileSync(prefix, 'utf8').trim().split('\n').map(JSON.parse)
      .filter((row) => String(row.mmsi) === '244790715');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-alice-passage-'));
    try {
      const file = path.join(dir, 'alice.jsonl');
      fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      const result = replay(file);
      expect(result.intermediatePassages.filter((p) => p.bridge === 'Olidebron'))
        .toEqual([{
          t: Date.parse('2026-07-12T12:47:01.694Z'), iso: '2026-07-12T12:47:01.694Z', mmsi: '244790715', bridge: 'Olidebron', noTarget: false,
        }]);
      const relevant = result.bridgeTextTransitions.filter((r) => r.iso >= '2026-07-12T12:47' && r.iso < '2026-07-12T13:01');
      const etas = relevant.map((r) => r.text.match(/Klaffbron, beräknad broöppning om (\d+) minuter/))
        .filter(Boolean).map((m) => Number(m[1]));
      expect(etas.length).toBeGreaterThan(0);
      expect(etas.every((n, i) => i === 0 || n <= etas[i - 1])).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
