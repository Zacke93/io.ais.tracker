'use strict';

jest.mock('homey');
const fs = require('fs');
const path = require('path');
const App = require('../app');
const VDS = require('../lib/services/VesselDataService');
const Registry = require('../lib/models/BridgeRegistry');
const AISHubClient = require('../lib/connection/AISHubClient');
const { QUAY_DEPARTURE_GATE, AIS_CONFIG } = require('../lib/constants');

const MMSI = '211452170';
const raw = fs.readFileSync(path.join(__dirname, 'replay-validation/corpora-data/ais-20260804-both-21h.jsonl'), 'utf8')
  .trim().split('\n').map(JSON.parse)
  .filter((row) => row.mmsi === MMSI);
const first = raw.find((row) => row.aisTimestamp === Date.parse('2026-08-05T03:49:29.182Z'));
const second = raw.find((row) => row.aisTimestamp === Date.parse('2026-08-05T03:52:55.448Z'));

function vessel(row) {
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
  };
}
function makeApp() {
  return Object.assign(Object.create(App.prototype), {
    log: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    _openingQuayLedger: new Map(),
    _quayStableLedger: new Map(),
    _learnedMooringSpots: [{ lat: first.lat, lon: first.lon, t: first.aisTimestamp - 60000 }],
    _LEARNED_SPOT_TTL_MS: 7 * 24 * 60 * 60000,
  });
}
function makeService(app) {
  return Object.assign(Object.create(VDS.prototype), {
    app,
    bridgeRegistry: new Registry(),
    logger: { debug: jest.fn(), log: jest.fn(), error: jest.fn() },
    _completedJourneys: new Map(),
  });
}

// Mottagningstid och handläggningstid är skilda även för en helt ren fix.
// Samma tre regressioner som den ursprungliga lilla testfilen.
describe('Ren kajfix ska tåla verklig handläggningstid', () => {
  afterEach(() => jest.restoreAllMocks());
  test.each([0, 1, 25])('oförändrat kajbeslut efter %i ms processfördröjning', (delay) => {
    let now = first.aisTimestamp + delay;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const app = makeApp();
    const service = makeService(app);
    app._noteQuayStability(vessel(first));
    const entry = app._openingQuayLedger.get(MMSI);
    expect(entry.lastFix.ts).toBe(first.aisTimestamp);
    expect(entry.stillAt).toBe(first.aisTimestamp + delay);
    now = second.aisTimestamp;
    expect(service._slowInitialQuayApproachNeedsProof(vessel(second))).toBe(true);
  });
});

describe('Stillhetsmarkeringen måste höra till en ren positionsfix', () => {
  let now;
  let app;
  let service;
  beforeEach(() => {
    now = first.aisTimestamp;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    app = makeApp();
    service = makeService(app);
  });
  afterEach(() => jest.restoreAllMocks());
  function step(minutes, extra = {}) {
    const t = first.aisTimestamp + minutes * 60000;
    return {
      ...vessel(first),
      timestamp: t,
      lastPositionUpdate: t,
      fixTs: t,
      fixFeed: 'aisstream',
      sog: 0.4,
      cog: 135,
      ...extra,
    };
  }
  test.each(['_gpsJumpDetected', '_positionUncertain'])('%s kan inte skapa rent kajbevis', (flag) => {
    app._noteQuayStability(step(0, { sog: 4 }));
    expect(app._openingQuayLedger.get(MMSI).lastFix.quayStill).toBe(false);
    now = first.aisTimestamp + 60000;
    app._noteQuayStability(step(1, { [flag]: true }));
    const entry = app._openingQuayLedger.get(MMSI);
    expect(entry.lastFix.ts).toBe(first.aisTimestamp);
    expect(entry.lastFix.quayStill).toBe(false);
    now = first.aisTimestamp + 120000;
    expect(service._slowInitialQuayApproachNeedsProof(step(2))).toBe(false);
    // Nästa rena lågfix får däremot bära sitt eget bevis.
    app._noteQuayStability(step(2));
    expect(entry.lastFix.quayStill).toBe(true);
    now = first.aisTimestamp + 180000;
    expect(service._slowInitialQuayApproachNeedsProof(step(3))).toBe(true);
  });
  test('ren rörelsefix ersätter föregående stillhetsmarkering', () => {
    app._noteQuayStability(step(0));
    expect(app._openingQuayLedger.get(MMSI).lastFix.quayStill).toBe(true);
    now = first.aisTimestamp + 60000;
    app._noteQuayStability(step(1, { sog: 4 }));
    expect(app._openingQuayLedger.get(MMSI).lastFix.quayStill).toBe(false);
    now = first.aisTimestamp + 120000;
    expect(service._slowInitialQuayApproachNeedsProof(step(2))).toBe(false);
  });
  test('en ren lågfix utan oberoende kajplats är fortsatt ingen kajklassning', () => {
    app._learnedMooringSpots = [];
    app._noteQuayStability(step(0));
    expect(app._openingQuayLedger.get(MMSI).lastFix.quayStill).toBe(true);
    now = first.aisTimestamp + 120000;
    expect(service._slowInitialQuayApproachNeedsProof(step(2))).toBe(false);
  });
});

describe('Positionsvistelsens TTL förnyas av rena fixar, aldrig bara cacheekon', () => {
  const START = Date.parse('2026-08-05T00:00:00Z');
  const position = { lat: 58.28761, lon: 12.28569 };
  let app;
  let client;
  const sample = (t, extra = {}) => ({
    mmsi: MMSI,
    ...position,
    sog: 1.6,
    cog: 0,
    timestamp: t,
    lastPositionUpdate: t,
    fixTs: t,
    fixFeed: 'aishub',
    ...extra,
  });
  const entry = () => app._openingQuayLedger.get(MMSI);
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    app = makeApp();
    app._learnedMooringSpots = [];
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._firedOpeningEvents = new Map();
    app.vesselDataService = { getAllVessels: () => [], noteVesselSeen: jest.fn() };
  });
  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  test('färska 25-minutersfixar bevarar stillheten; enbart tickar förnyar ingen TTL', () => {
    for (let minutes = 0; minutes <= 175; minutes += 25) {
      jest.setSystemTime(START + minutes * 60000);
      app._noteQuayStability(sample(Date.now()));
      expect(entry().positionStayAnchor.ts).toBe(START);
      app._pruneDedupCaches();
      expect(entry()).toBeDefined();
    }
    const last = START + 175 * 60000;
    expect(app._openingLedgerTtlClock(entry())).toBe(last);
    jest.setSystemTime(last + QUAY_DEPARTURE_GATE.MEMORY_MS);
    app._pruneDedupCaches();
    expect(app._openingLedgerTtlClock(entry())).toBe(last);
    jest.setSystemTime(last + QUAY_DEPARTURE_GATE.MEMORY_MS + 1);
    app._pruneDedupCaches();
    expect(entry()).toBeUndefined();
  });
  test('riktig avgång får ett nytt positionsankare och är inget nytt stillhetsbevis', () => {
    app._noteQuayStability(sample(START));
    jest.setSystemTime(START + 10 * 60000);
    app._noteQuayStability(sample(Date.now()));
    expect(app._openingLedgerTtlClock(entry())).toBe(Date.now());
    jest.setSystemTime(START + 11 * 60000);
    app._noteQuayStability(sample(Date.now(), { lat: position.lat + 70 / 111320 }));
    expect(entry().positionStayAnchor.ts).toBe(Date.now());
    expect(app._openingLedgerTtlClock(entry())).toBe(START);
  });
  test('en GPS-osäker uppdatering förnyar inte positionsvistelsens TTL', () => {
    app._noteQuayStability(sample(START));
    jest.setSystemTime(START + 10 * 60000);
    app._noteQuayStability(sample(Date.now()));
    const stamp = app._openingLedgerTtlClock(entry());
    jest.setSystemTime(START + 25 * 60000);
    app._noteQuayStability(sample(Date.now(), { _gpsJumpDetected: true }));
    expect(app._openingLedgerTtlClock(entry())).toBe(stamp);
  });
  test('AISHubs riktiga cacheväg kan varken flytta kajfixen eller hålla posten efter två timmar', async () => {
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    client = new AISHubClient(logger, { get: () => null, set: () => {} });
    client._stopped = false;
    let positions = 0;
    client.on('ais-message', (row) => {
      positions++;
      app._noteQuayStability({ ...row, timestamp: Date.now(), fixFeed: 'aishub' });
    });
    client.on('vessel:seen', (data) => app._onVesselSeen(data));
    for (const minutes of [0, 25, 26, 31, 40, 60, 150, 151]) {
      jest.setSystemTime(START + minutes * 60000);
      const fix = START + Math.min(minutes, 25) * 60000;
      const records = [{
        MMSI: Number(MMSI),
        TIME: new Date(fix).toISOString().replace('T', ' ').replace('.000Z', ' GMT'),
        LATITUDE: position.lat,
        LONGITUDE: position.lon,
        SOG: 1.6,
        COG: 0,
        NAVSTAT: 0,
        NAME: 'CARAT',
      }];
      const body = JSON.stringify([{ ERROR: false, FORMAT: 'HUMAN', RECORDS: 1 }, records]);
      client._handleHttpResult({ statusCode: 200, body }, 12);
      // eslint-disable-next-line no-await-in-loop
      await jest.advanceTimersByTimeAsync(AIS_CONFIG.AISHUB.EMIT_SPREAD_MS);
      if (entry()) expect(entry().lastFix.fixTs).toBe(fix);
      app._pruneDedupCaches();
    }
    expect(positions).toBe(2);
    expect(app.vesselDataService.noteVesselSeen).toHaveBeenCalled();
    expect(entry()).toBeUndefined();
  });
});
