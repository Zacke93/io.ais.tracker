'use strict';

jest.mock('homey');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const App = require('../app');
const VDS = require('../lib/services/VesselDataService');
const Registry = require('../lib/models/BridgeRegistry');
const { BRIDGES } = require('../lib/constants');

const replayDir = path.join(__dirname, 'replay-validation');
const read = (name, mmsi) => fs.readFileSync(path.join(replayDir, 'corpora-data', name), 'utf8')
  .trim().split('\n').map((row) => JSON.parse(row))
  .filter((row) => String(row.mmsi) === mmsi);
const athena = read('ais-replay-20260711-232958.jsonl', '265819940');
const akira = read('ais-replay-20260708-001857.jsonl', '257605080');
const carat = read('ais-20260804-both-21h.jsonl', '211452170');
const sample = (row, extra = {}) => ({
  ...row,
  timestamp: row.aisTimestamp,
  lastPositionUpdate: row.aisTimestamp,
  fixTs: row.aisTimestamp,
  fixFeed: 'aisstream',
  targetBridge: null,
  _routeDirection: null,
  _gpsJumpDetected: false,
  _positionUncertain: false,
  _moored: false,
  _hasMovementProof: true,
  passedBridges: [],
  ...extra,
});

describe('Ny målbro vid kaj kräver fysisk avgång även inom 600 m', () => {
  let app;
  let service;
  let now;
  beforeEach(() => {
    now = athena[0].aisTimestamp;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    app = Object.create(App.prototype);
    Object.assign(app, {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), _openingQuayLedger: new Map(), _quayStableLedger: new Map(),
    });
    service = Object.create(VDS.prototype);
    Object.assign(service, {
      app, bridgeRegistry: new Registry(), logger: { debug: jest.fn(), log: jest.fn(), error: jest.fn() }, _completedJourneys: new Map(),
    });
  });
  afterEach(() => jest.restoreAllMocks());
  function prior(rows) {
    for (const row of rows) {
      const v = sample(row);
      now = v.timestamp;
      app._noteQuayStability(v);
    }
    return app._openingQuayLedger.get(String(rows[0].mmsi));
  }
  const mirror = (row) => ({
    ...row,
    lat: BRIDGES.klaffbron.lat + BRIDGES.stridsbergsbron.lat - row.lat,
    lon: BRIDGES.klaffbron.lon + BRIDGES.stridsbergsbron.lon - row.lon,
    cog: Number.isFinite(row.cog) ? (row.cog + 180) % 360 : null,
  });

  test('AKIRAs 13,7 m på 17 min skapar ingen felaktig sydresa mot Klaff', () => {
    prior([akira[0]]);
    now = akira[1].aisTimestamp;
    const current = sample(akira[1]);
    expect(service._calculateTargetBridge(current)).toBe('Klaffbron');
    expect(service._slowInitialQuayApproachNeedsProof(current)).toBe(true);
    expect(service._shouldAssignTargetBridge(current)).toBe(false);
  });

  test.each(['south', 'north'])('ATHENAs verkliga 122 + 31 m avgång behålls %s', (direction) => {
    const rows = direction === 'south' ? athena : athena.map(mirror);
    const entry = prior(rows.slice(0, 2));
    const current = sample(rows[2]);
    now = current.timestamp;
    const bridge = direction === 'south' ? BRIDGES.klaffbron : BRIDGES.stridsbergsbron;
    expect(service._hasContinuingCleanQuayDeparture(current, entry, bridge, direction)).toBe(true);
    expect(service._slowInitialQuayApproachNeedsProof(current)).toBe(false);
    expect(service._shouldAssignTargetBridge(current)).toBe(true);
  });

  test('verklig utflykt och återgång räknas inte som fortsatt netto mot målbron', () => {
    const entry = prior(athena.slice(0, 2));
    const current = sample(athena[2], { lat: athena[0].lat - 70 / 111320 });
    now = current.timestamp;
    expect(service._hasContinuingCleanQuayDeparture(current, entry, BRIDGES.klaffbron, 'south')).toBe(false);
  });

  test('CARATs råa 7,4-knopsutflykt och återgång ger inget avgångsbevis', () => {
    const rows = carat.filter((row) => row.aisTimestamp >= Date.parse('2026-08-05T03:52:55.448Z')
      && row.aisTimestamp <= Date.parse('2026-08-05T03:57:26.930Z'));
    expect(rows.map((row) => row.sog)).toEqual([0.4, 7.4, 0.1]);
    const entry = prior(rows.slice(0, 2));
    const current = sample(rows[2]);
    now = current.timestamp;
    expect(service._hasContinuingCleanQuayDeparture(current, entry, BRIDGES.stridsbergsbron, 'north')).toBe(false);
    expect(service._hasContinuingCleanQuayDeparture(current, entry, BRIDGES.klaffbron, 'south')).toBe(false);
  });

  test.each([30, 31])('%i min gammalt positionsben får inte återge aktiv resa', (minutes) => {
    const entry = prior(athena.slice(0, 2));
    const current = sample(athena[2]);
    entry.prevFix.ts = current.timestamp - minutes * 60000;
    entry.prevFix.fixTs = entry.prevFix.ts;
    expect(service._hasContinuingCleanQuayDeparture(current, entry, BRIDGES.klaffbron, 'south')).toBe(false);
  });

  test('det äldsta råpositionsbenet måste också ligga inom 30 min på fixklockan', () => {
    const entry = prior(athena.slice(0, 2));
    const current = sample(athena[2]);
    entry.prevFix.fixTs = current.fixTs - 31 * 60000;
    expect(service._hasContinuingCleanQuayDeparture(current, entry, BRIDGES.klaffbron, 'south')).toBe(false);
  });

  test.each(['_gpsJumpDetected', '_positionUncertain'])('aktuell %s kan inte användas som avgångsbevis', (flag) => {
    const entry = prior(athena.slice(0, 2));
    expect(service._hasContinuingCleanQuayDeparture(sample(athena[2], { [flag]: true }), entry, BRIDGES.klaffbron, 'south')).toBe(false);
  });

  test('två fysikaliskt orimliga ensekundsben får ingen avgångsdispens', () => {
    const entry = prior(athena.slice(0, 2));
    const current = sample(athena[2]);
    entry.prevFix.ts = current.timestamp - 2000; entry.prevFix.fixTs = entry.prevFix.ts;
    entry.lastFix.ts = current.timestamp - 1000; entry.lastFix.fixTs = entry.lastFix.ts;
    expect(service._hasContinuingCleanQuayDeparture(current, entry, BRIDGES.klaffbron, 'south')).toBe(false);
  });

  test('bakåtriktad fixklocka får inte låna färsk mottagningstid', () => {
    const entry = prior(athena.slice(0, 2));
    const current = sample(athena[2], { fixTs: entry.lastFix.fixTs - 1000 });
    expect(service._hasContinuingCleanQuayDeparture(current, entry, BRIDGES.klaffbron, 'south')).toBe(false);
  });
});

function observer() {
  const Module = require('module');
  const fsLocal = require('fs');
  const rows = [];
  const load = Module._extensions['.js'];
  Module._extensions['.js'] = function instrument(mod, filename) {
    const result = load(mod, filename);
    if (filename.endsWith('/app.js') && !filename.includes('/node_modules/')) {
      const proto = mod.exports.prototype;
      const original = proto._observeBridgeOpening;
      proto._observeBridgeOpening = function observe(vessel, ...args) {
        if (String(vessel?.mmsi) === '257605080') rows.push({ t: Date.now(), target: vessel.targetBridge });
        return original.call(this, vessel, ...args);
      };
    }
    if (filename.endsWith('/lib/services/BridgeTextService.js')) {
      const proto = mod.exports.prototype;
      const original = proto.generateBridgeText;
      proto.generateBridgeText = function observeText(vessels, ...args) {
        for (const vessel of vessels || []) {
          if (String(vessel?.mmsi) === '257605080') rows.push({ t: Date.now(), target: vessel.targetBridge, text: true });
        }
        return original.call(this, vessels, ...args);
      };
    }
    return result;
  };
  process.on('exit', () => fsLocal.writeFileSync(process.env.QUAY_FIELD_TRACE, JSON.stringify(rows)));
}

describe('Riktiga fältbeslut: AKIRA lämnar norrut och ATHENA lämnar söderut', () => {
  let directory;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-quay-departure-'));
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
  function replay(file, monitoring, observe = false) {
    const args = [];
    const trace = path.join(directory, `trace-${monitoring}.json`);
    if (observe) {
      const preload = path.join(directory, 'observer.cjs');
      fs.writeFileSync(preload, `(${observer.toString()})();\n`);
      args.push('--require', preload);
    }
    args.push(path.join(replayDir, 'replayRunner.js'), file);
    const out = execFileSync(process.execPath, args, {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, QUAY_FIELD_TRACE: trace, REPLAY_MONITORING: monitoring ? '1' : '0' },
    });
    const result = JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
    return { result, observations: observe ? JSON.parse(fs.readFileSync(trace, 'utf8')) : [] };
  }

  test.each([false, true])('AKIRAs nordvarning täcker den verkliga konvojen, monitoring=%s', (monitoring) => {
    const { result, observations } = replay(path.join(replayDir, 'corpora-data/ais-replay-20260708-001857.jsonl'), monitoring, true);
    const departure = Date.parse('2026-07-08T07:05:13.717Z');
    expect(observations.filter((row) => row.t < departure && row.target)).toEqual([]);
    expect(observations.some((row) => row.t >= departure && row.target === 'Stridsbergsbron' && row.text)).toBe(true);
    const opening = result.openingWarnings.find((warning) => warning.leadMmsi === '257605080');
    expect(opening).toMatchObject({
      t: departure, bridge: 'Stridsbergsbron', direction: 'northbound', success: true,
    });
    for (const mmsi of ['219009353', '257919970']) {
      const coverage = result.openingCoverage.find((row) => row.mmsi === mmsi && row.eventId === opening.eventId);
      const passage = result.targetPassages.find((row) => row.mmsi === mmsi && row.bridge === 'Stridsbergsbron');
      expect(coverage).toMatchObject({ reason: 'absorbed', bridge: 'Stridsbergsbron' });
      expect(coverage.t).toBeLessThan(passage.t);
      expect(opening.t).toBeLessThan(passage.t);
    }
    expect(result.openingSuppressions.some((row) => row.eventId === opening.eventId)).toBe(false);
    expect(result.notifications).toHaveLength(54);
  }, 120000);

  test.each([false, true])('ATHENAs långsamma råavgång behåller riktig Klaffvarning, monitoring=%s', (monitoring) => {
    const file = path.join(directory, 'athena.jsonl');
    fs.writeFileSync(file, `${athena.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const { result } = replay(file, monitoring);
    expect(result.openingWarnings).toHaveLength(1);
    expect(result.openingWarnings[0]).toMatchObject({
      bridge: 'Klaffbron', leadMmsi: '265819940', t: athena[2].aisTimestamp, success: true,
    });
    expect(result.targetPassages).toContainEqual(expect.objectContaining({
      bridge: 'Klaffbron', mmsi: '265819940', t: athena[3].aisTimestamp,
    }));
  });
});
