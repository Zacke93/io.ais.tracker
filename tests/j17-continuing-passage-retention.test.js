'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ProximityService = require('../lib/services/ProximityService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { TIMEOUT_SETTINGS } = require('../lib/constants');

const START = Date.parse('2026-09-17T09:00:00Z');
const MMSI = '901009017';
const REPLAY_DIR = path.join(__dirname, 'replay-validation');

// Läs endast tillstånd: riktiga appen äger inmatning, status, tid och städning.
function observer() {
  const Module = require('module');
  const fsLocal = require('fs');
  const rows = [];
  const tracked = process.env.J17_MMSI;
  const load = Module._extensions['.js'];
  Module._extensions['.js'] = function instrument(mod, filename) {
    const result = load(mod, filename);
    if (filename.endsWith('/lib/services/ProximityService.js')) {
      const proto = mod.exports.prototype;
      const original = proto.calculateProximityTimeout;
      proto.calculateProximityTimeout = function observeTimeout(vessel, ...args) {
        const timeout = original.call(this, vessel, ...args);
        if (String(vessel.mmsi) === tracked && vessel.status === 'passed') {
          rows.push({
            kind: 'passed',
            t: Date.now(),
            timeout,
            rawSog: vessel._rawPositionSog,
            bridge: vessel.lastPassedBridge,
            target: vessel.targetBridge,
          });
        }
        return timeout;
      };
    }
    if (filename.endsWith('/lib/services/VesselDataService.js')) {
      const proto = mod.exports.prototype;
      const original = proto.removeVessel;
      proto.removeVessel = function observeRemoval(mmsi, ...args) {
        const vessel = this.getVessel(mmsi);
        // Raderingen nollställer även det gamla objektet; frys mätvärden först.
        const snapshot = vessel && {
          kind: 'removed', t: Date.now(), lastFix: vessel.timestamp, target: vessel.targetBridge,
        };
        const value = original.call(this, mmsi, ...args);
        if (String(mmsi) === tracked && snapshot && !this.getVessel(mmsi)) rows.push(snapshot);
        return value;
      };
    }
    if (filename.endsWith('/lib/services/BridgeTextService.js')) {
      const proto = mod.exports.prototype;
      const original = proto.generateBridgeText;
      proto.generateBridgeText = function observeText(vessels, ...args) {
        if ((vessels || []).some((vessel) => String(vessel.mmsi) === tracked)) {
          rows.push({ kind: 'visible', t: Date.now() });
        }
        return original.call(this, vessels, ...args);
      };
    }
    return result;
  };
  process.on('exit', () => fsLocal.writeFileSync(process.env.J17_TRACE, JSON.stringify(rows)));
}

describe('J17: bevisad fortsatt resa överlever den färska mellanpassagen', () => {
  let directory;
  let fixture;
  let preload;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-j17-retention-'));
    fixture = path.join(directory, 'continued.jsonl');
    preload = path.join(directory, 'observer.cjs');
    fs.writeFileSync(preload, `(${observer.toString()})();\n`);
    // En 19 min gammal fix följd av en bevisad Olidepassage. Nästa fix
    // kommer 12 min senare, inom appens befintliga transit- och AIS-gränser.
    // Före rättningen gick den URSPRUNGLIGA 30-minuterstimern ut vid minut30.
    const samples = [
      [0, 58.27054, 12.27345],
      [19, 58.27590, 12.27758],
      [31, 58.27999, 12.28075],
      [34, 58.28311, 12.28317],
      [36, 58.28540, 12.28533],
    ].map(([minute, lat, lon]) => ({
      mmsi: MMSI,
      lat,
      lon,
      sog: 3,
      cog: 35,
      shipName: 'J17 FORTSATT RESA',
      aisTimestamp: START + minute * 60000,
      receivedAt: new Date(START + minute * 60000).toISOString(),
    }));
    fs.writeFileSync(fixture, `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`);
  });

  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  function replay(file, mmsi, monitoring) {
    const trace = path.join(directory, 'trace.json');
    const stdout = execFileSync(process.execPath, ['--require', preload, path.join(REPLAY_DIR, 'replayRunner.js'), file], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        J17_TRACE: trace,
        J17_MMSI: mmsi,
        REPLAY_MONITORING: monitoring ? '1' : '0',
        REPLAY_FUSION: '0',
        REPLAY_VERBOSE: '',
      },
    });
    const result = JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
    return { result, observations: JSON.parse(fs.readFileSync(trace, 'utf8')) };
  }

  test.each([false, true])('resan och brotexten består fram till nästa fix, monitoring=%s', (monitoring) => {
    const { result, observations } = replay(fixture, MMSI, monitoring);
    expect(result.intermediatePassages).toEqual([
      expect.objectContaining({ mmsi: MMSI, bridge: 'Olidebron', t: START + 19 * 60000 }),
    ]);
    expect(observations.filter((row) => row.kind === 'removed' && row.t < START + 36 * 60000)).toEqual([]);
    const transitText = result.bridgeTextTransitions.filter((row) => row.t >= START + 19 * 60000 && row.t < START + 36 * 60000);
    expect(transitText.length).toBeGreaterThan(0);
    expect(transitText.every((row) => row.text.startsWith('En båt på väg mot Klaffbron'))).toBe(true);
    expect(result.targetPassages).toEqual([
      expect.objectContaining({ mmsi: MMSI, bridge: 'Klaffbron', t: START + 36 * 60000 }),
    ]);
    expect(result.notifications).toContainEqual(expect.objectContaining({
      mmsi: MMSI, bridge: 'Klaffbron', alreadyPassed: false, success: true,
    }));
    // Den vanliga 30-minutersgränsen för verklig AIS-tystnad gäller fortfarande.
    expect(observations.filter((row) => row.kind === 'removed')).toEqual([
      expect.objectContaining({ t: START + 66 * 60000, lastFix: START + 36 * 60000 }),
    ]);
  });

  const stops = [
    {
      name: 'AKIRA',
      mmsi: '257605080',
      file: 'ais-replay-20260707-092154.jsonl',
      lastFix: Date.parse('2026-07-07T08:37:10.640Z'),
      maxRetentionMs: 7 * 60000,
      sog: 0.1,
    },
    {
      name: 'MISTY',
      mmsi: '219035849',
      file: 'ais-20260804-17h-dag.jsonl',
      lastFix: Date.parse('2026-08-04T15:02:26.212Z'),
      maxRetentionMs: 18 * 60000,
      sog: 0.9,
    },
  ];
  describe.each(stops)('$name: råfältets passage följd av stopp', (stop) => {
    test.each([false, true])('får ingen förlängd resa eller spöktext, monitoring=%s', (monitoring) => {
      const { observations } = replay(path.join(REPLAY_DIR, 'corpora-data', stop.file), stop.mmsi, monitoring);
      expect(observations).toContainEqual(expect.objectContaining({
        kind: 'passed', t: stop.lastFix, rawSog: stop.sog, timeout: 65000,
      }));
      const removal = observations.find((row) => row.kind === 'removed' && row.lastFix === stop.lastFix);
      expect(removal).toBeDefined();
      expect(removal.t).toBeLessThan(stop.lastFix + stop.maxRetentionMs);
      expect(observations.some((row) => row.kind === 'visible' && row.t >= stop.lastFix + stop.maxRetentionMs)).toBe(false);
    });
  });

  const continuingFields = [
    {
      name: 'ANTARES',
      mmsi: '230167390',
      file: 'ais-replay-20260710-015254.jsonl',
      continuingAt: Date.parse('2026-07-10T11:35:04.852Z'),
      klaffAt: Date.parse('2026-07-10T11:49:37.640Z'),
      olideAt: Date.parse('2026-07-10T11:56:04.963Z'),
      inletPassed: false,
    },
    {
      name: 'SENTA',
      mmsi: '230198250',
      file: 'ais-replay-20260712-174434.jsonl',
      continuingAt: Date.parse('2026-07-13T15:35:47.053Z'),
      klaffAt: Date.parse('2026-07-13T15:50:47.297Z'),
      olideAt: Date.parse('2026-07-13T16:01:49.998Z'),
      inletPassed: true,
    },
  ];
  describe.each(continuingFields)('$name: råfältets fortsatta resa genom Olidebron', (field) => {
    test.each([false, true])('behåller resan och exakt sex notiser utan dubbletter, monitoring=%s', (monitoring) => {
      const { result, observations } = replay(path.join(REPLAY_DIR, 'corpora-data', field.file), field.mmsi, monitoring);
      expect(observations.filter((row) => row.kind === 'removed'
        && row.t >= field.continuingAt && row.t <= field.olideAt)).toEqual([]);
      expect(result.targetPassages).toContainEqual(expect.objectContaining({
        mmsi: field.mmsi, bridge: 'Klaffbron', t: field.klaffAt,
      }));
      expect(result.intermediatePassages.filter((row) => row.mmsi === field.mmsi && row.bridge === 'Olidebron')).toEqual([
        expect.objectContaining({ t: field.olideAt, noTarget: true }),
      ]);
      const notifications = result.notifications.filter((row) => row.mmsi === field.mmsi);
      expect(notifications.map((row) => row.bridge).sort()).toEqual([
        'Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron', 'Olidebron', 'Kanalinfarten',
      ].sort());
      expect(notifications.every((row) => row.success && row.direction === 'southbound')).toBe(true);
      expect(notifications).toContainEqual(expect.objectContaining({
        bridge: 'Kanalinfarten', t: field.olideAt, source: 'trigger-point', alreadyPassed: field.inletPassed,
      }));
    });
  });
});

describe('J17: det nya undantaget kräver fortsatt transit i senaste fixen', () => {
  let proximity;
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    proximity = new ProximityService(new BridgeRegistry(), { debug: jest.fn() });
  });
  afterEach(() => jest.useRealTimers());

  function continuing(overrides = {}) {
    return {
      mmsi: MMSI,
      lat: 58.27590,
      lon: 12.27758,
      sog: 3,
      _rawPositionSog: 3,
      _routeDirection: 'north',
      targetBridge: 'Klaffbron',
      status: 'passed',
      lastPassedBridge: 'Olidebron',
      lastPassedBridgeTime: START,
      passedBridges: ['Olidebron'],
      _positionAnalysis: { action: 'accept', movementDistance: 643 },
      ...overrides,
    };
  }

  test('bekräftad passage förnyar samma livslängd som en vanlig aktiv resa', () => {
    const vessel = continuing();
    const p = proximity.analyzeVesselProximity(vessel);
    expect(proximity.calculateProximityTimeout(vessel, p)).toBe(TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    expect(proximity.calculateProximityTimeout({ ...vessel, status: 'en-route' }, p)).toBe(TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
  });

  test.each([
    ['saknad råfart trots historisk fart', { _rawPositionSog: null }],
    ['stopp efter passagen', { _rawPositionSog: 0.1 }],
    ['låg fart utan transitbevis', { _rawPositionSog: 0.9 }],
    ['osäker position', { _positionUncertain: true }],
    ['jitter utan nettoförflyttning', { _positionAnalysis: { action: 'accept', movementDistance: 20 } }],
    ['textstatus utan bokförd passage', { passedBridges: [] }],
    ['målbro bakom båten', { lat: 58.2855 }],
    ['okänd riktning', { _routeDirection: null }],
  ])('%s får behålla den korta basnivån', (_name, overrides) => {
    const vessel = continuing(overrides);
    expect(proximity.calculateProximityTimeout(vessel, proximity.analyzeVesselProximity(vessel))).toBe(65000);
  });
});
