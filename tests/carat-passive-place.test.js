'use strict';

jest.mock('homey');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const App = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { QUAY_DEPARTURE_GATE } = require('../lib/constants');

const MMSI = '211452170';
const replayDir = path.join(__dirname, 'replay-validation');
const corpus = path.join(replayDir, 'corpora-data/ais-20260804-both-21h.jsonl');
const raw = fs.readFileSync(corpus, 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => String(row.mmsi) === MMSI);
const FIRST = raw[0].aisTimestamp;
const SECOND = raw[1].aisTimestamp;
const DEPARTURE = Date.parse('2026-08-05T06:53:35.495Z');

function sample(row, extra = {}) {
  return {
    ...row,
    timestamp: row.aisTimestamp,
    lastPositionUpdate: row.aisTimestamp,
    fixFeed: row.feed,
    targetBridge: null,
    _routeDirection: null,
    _gpsJumpDetected: false,
    _positionUncertain: false,
    _moored: false,
    _hasMovementProof: true,
    passedBridges: [],
    ...extra,
  };
}

describe('Passivt kajplatsbevis får motsäga en ny resa utan att återuppliva en gammal', () => {
  let app;
  let service;
  let now;
  beforeEach(() => {
    now = FIRST;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    app = Object.create(App.prototype);
    app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app._openingQuayLedger = new Map(); app._quayStableLedger = new Map();
    app._learnedMooringSpots = [];
    app._LEARNED_SPOT_TTL_MS = 7 * 24 * 60 * 60000;
    service = Object.create(VesselDataService.prototype);
    service.app = app;
    service.logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
    service.bridgeRegistry = new BridgeRegistry();
    service._completedJourneys = new Map();
  });
  afterEach(() => jest.restoreAllMocks());

  function note(vessel) {
    now = vessel.timestamp;
    app._noteQuayStability(vessel);
    return app._openingQuayLedger.get(MMSI);
  }
  function provenPlace() {
    note(sample(raw[0]));
    return note(sample(raw[1]));
  }
  function after(minutes, extra = {}) {
    now = SECOND + minutes * 60000;
    return sample(raw[1], {
      timestamp: now, lastPositionUpdate: now, fixTs: now - 50000, ...extra,
    });
  }

  test('75 min tystnad nollar aktivt ankare men bevarar färskt passivt motbevis vid samma plats', () => {
    const entry = provenPlace();
    const original = { ...entry.positionStayEvidence };
    const returned = after(75, { sog: 0.7 });
    expect(service._slowInitialQuayApproachNeedsProof(returned)).toBe(true);
    note(returned);
    expect(entry.positionStayAnchor.ts).toBe(now);
    expect(entry.positionStayEvidence).toEqual({ ...original, t: now });
    expect(returned.targetBridge).toBeNull();
    expect(returned._routeDirection).toBeNull();
    expect(returned._bridgeQueueApproaches).toBeUndefined();
    expect(service.hasRebornQueueArrivalProof(returned)).toBe(false);
    expect(service._slowInitialQuayApproachNeedsProof(after(76, { sog: 0.7 }))).toBe(true);
  });

  test.each([-1, 0, 1])('2h-gränsen prövas vid läsning oberoende av städning: %+i ms', (offset) => {
    provenPlace();
    now = SECOND + QUAY_DEPARTURE_GATE.MEMORY_MS + offset;
    const current = sample(raw[1], { timestamp: now, lastPositionUpdate: now, fixTs: now - 50000 });
    expect(service._slowInitialQuayApproachNeedsProof(current)).toBe(offset <= 0);
    if (offset > 0) {
      app._openingQuayLedger.delete(MMSI);
      expect(service._slowInitialQuayApproachNeedsProof(current)).toBe(false);
    }
  });

  test.each(['_gpsJumpDetected', '_positionUncertain'])('osäker fix förnyar inte passivt minne: %s', (flag) => {
    const entry = provenPlace();
    const proof = { ...entry.positionStayEvidence };
    note(after(75, { [flag]: true }));
    expect(entry.positionStayEvidence).toEqual(proof);
    expect(app._openingLedgerTtlClock(entry)).toBe(SECOND);
  });

  test('ren mätbar avgång och återkomst lånar inte tidigare kajvistelse', () => {
    const entry = provenPlace();
    const moved = after(1, { lat: raw[0].lat + 90 / 111320 });
    expect(service._slowInitialQuayApproachNeedsProof(moved)).toBe(false);
    note(moved);
    expect(entry.positionStayEvidence).toBeNull();
    const back = after(2, { lat: raw[0].lat });
    expect(service._slowInitialQuayApproachNeedsProof(back)).toBe(false);
    note(back);
    expect(entry.positionStayEvidence).toBeNull();
  });

  test('ett gammalt riktningslås är inget undantag från nytt positionsmotbevis', () => {
    provenPlace();
    expect(service._slowInitialQuayApproachNeedsProof(after(75, { _routeDirection: 'north' }))).toBe(true);
  });

  test('en redan aktiv kö behåller målbron även när passivt platsbevis finns', () => {
    provenPlace();
    expect(service._slowInitialQuayApproachNeedsProof(after(75, {
      targetBridge: 'Stridsbergsbron', sog: 0, _routeDirection: 'north',
    }))).toBe(false);
  });

  test.each([false, true])('03:52: ny ren observation vid inlärd kaj spärrar spöket även efter städning=%s', (pruned) => {
    const first = raw.find((row) => row.aisTimestamp === Date.parse('2026-08-05T03:49:29.182Z'));
    const second = raw.find((row) => row.aisTimestamp === Date.parse('2026-08-05T03:52:55.448Z'));
    app._learnedMooringSpots = [{ lat: first.lat, lon: first.lon, t: SECOND }];
    if (!pruned) provenPlace();
    note(sample(first));
    now = second.aisTimestamp;
    const current = sample(second);
    expect(current.sog).toBe(0.4);
    expect(service._slowInitialQuayApproachNeedsProof(current)).toBe(true);
    expect(service._shouldAssignTargetBridge(current, sample(first))).toBe(false);
  });

  test('två minuter mellan farledsfixar blir inte kajbevis genom gammalt bandSince', () => {
    const t = Date.parse('2026-07-13T08:02:42.751Z');
    const first = sample(raw[0], {
      lat: 58.290535,
      lon: 12.290996666666666,
      sog: 0,
      cog: null,
      timestamp: t,
      lastPositionUpdate: t,
      fixTs: t,
    });
    const entry = note(first);
    entry.bandSince = t - 46 * 60000;
    // Gammalt bandSince är inget positionsbevis. Den verkliga IDUN-kön
    // efter längre stillhet skyddas av gap-queue-arrival och fältprovet.
    now = t + 2 * 60000;
    const waiting = {
      ...first,
      timestamp: now,
      lastPositionUpdate: now,
      fixTs: now,
      _routeDirection: 'north',
      _plausibleMovementSeen: true,
    };
    expect(service._calculateTargetBridge(waiting)).toBe('Stridsbergsbron');
    expect(service._slowInitialQuayApproachNeedsProof(waiting)).toBe(false);
  });
});

// Observatören läser den verkliga appens mål och brotextunderlag. Den ändrar
// inga positioner, fartyg, klockor eller produktbeslut i replayprocessen.
function preloadObserver() {
  const fsLocal = require('fs');
  const Module = require('module');
  const rows = [];
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = function observeModule(mod, filename) {
    const result = original(mod, filename);
    if (filename.endsWith('/app.js') && !filename.includes('/node_modules/')) {
      const proto = mod.exports.prototype;
      const observe = proto._observeBridgeOpening;
      proto._observeBridgeOpening = function observeTarget(vessel, ...args) {
        if (String(vessel?.mmsi) === '211452170') {
          rows.push({ t: Date.now(), tag: 'target', target: vessel.targetBridge });
        }
        return observe.call(this, vessel, ...args);
      };
    }
    if (filename.endsWith('/lib/services/BridgeTextService.js')) {
      const proto = mod.exports.prototype;
      const generate = proto.generateBridgeText;
      proto.generateBridgeText = function observeText(vessels, ...args) {
        for (const vessel of vessels || []) {
          if (String(vessel?.mmsi) === '211452170') {
            rows.push({ t: Date.now(), tag: 'text', target: vessel.targetBridge });
          }
        }
        return generate.call(this, vessels, ...args);
      };
    }
    return result;
  };
  process.on('exit', () => fsLocal.writeFileSync(process.env.CARAT_TEXT_TRACE, JSON.stringify(rows)));
}

describe('Hela CARATs fältspår: måltext får börja först vid mätbar avgång', () => {
  let directory;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-carat-place-'));
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  test.each([false, true])('alla 70 råfixar genom riktig app och monitoring=%s', (monitoring) => {
    const preload = path.join(directory, 'observe.cjs');
    const trace = path.join(directory, `trace-${monitoring}.json`);
    fs.writeFileSync(preload, `(${preloadObserver.toString()})();\n`);
    const output = execFileSync(process.execPath, [
      '--require', preload, path.join(replayDir, 'replayRunner.js'), corpus,
    ], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CARAT_TEXT_TRACE: trace, REPLAY_MONITORING: monitoring ? '1' : '0' },
    });
    const result = JSON.parse(output.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    const observations = JSON.parse(fs.readFileSync(trace, 'utf8'));
    const beforeDeparture = observations.filter((row) => row.t >= FIRST && row.t < DEPARTURE);
    expect(raw).toHaveLength(70);
    expect(beforeDeparture.filter((row) => row.tag === 'target').length).toBeGreaterThan(20);
    expect(beforeDeparture.filter((row) => row.target)).toEqual([]);
    expect(result.openingWarnings.filter((warning) => String(warning.leadMmsi) === MMSI)).toEqual([]);
    expect(result.notifications.filter((warning) => String(warning.mmsi) === MMSI)
      .map(({
        bridge, t, success, alreadyPassed,
      }) => ({
        bridge, t, success, alreadyPassed,
      })))
      .toEqual([
        {
          bridge: 'Klaffbron', t: DEPARTURE, success: true, alreadyPassed: true,
        },
        {
          bridge: 'Olidebron', t: Date.parse('2026-08-05T07:00:22.980Z'), success: true, alreadyPassed: false,
        },
        {
          bridge: 'Kanalinfarten', t: Date.parse('2026-08-05T07:04:54.398Z'), success: true, alreadyPassed: false,
        },
      ]);
    const passages = [...result.targetPassages, ...result.intermediatePassages]
      .filter((passage) => String(passage.mmsi) === MMSI && passage.bridge === 'Klaffbron');
    expect(passages).toHaveLength(1);
    expect(passages[0].t).toBe(DEPARTURE);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  }, 120000);
});
