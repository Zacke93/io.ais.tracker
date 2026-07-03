'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

/**
 * B1 — Namnkedjan (körning 2026-07-03, fynd F1).
 *
 * VALEN fick 5 boat_near-notiser som "Unknown" innan aisstream backfyllde
 * namnet 36 min in i resan. Tre rotorsaker fixade:
 *  1. Removal-snapshotten kopierade `vessel.shipName` (fanns aldrig — fältet
 *     heter `name`) → exit-/fallbacknotiser blev ALLTID "Unknown"
 *     (fältlist-fällans FJÄRDE offer).
 *  2. Ingen persistent mmsi→namn-cache → återkommande fartyg började alltid
 *     som "Unknown" tills backfill.
 *  3. Statiska AIS-rapporter (typ 5/24 — Class B-namnens kanal) filtrerades
 *     bort före namnextraktion.
 * Dessutom (ANVÄNDARBESLUT): token-fallback är "Okänd båt", inte "Unknown".
 */

// Fälten som exit-/removal-fallbackvägen läser ur vessel:removed-snapshotten
// (_onVesselRemoved → _triggerExitPointFallback → _triggerBoatNearFlowFallback
// → _triggerBoatNearFlowForBridge). Fältlist-vakt: att ett fält finns HÄR
// betyder att removeVessel-snapshotten i VesselDataService MÅSTE bära det.
const SNAPSHOT_CONSUMED_FIELDS = [
  'mmsi', 'lat', 'lon', 'sog', 'cog',
  'targetBridge', 'currentBridge',
  'name', // ← 4:e offret: hette shipName (alltid undefined) före 2026-07-03
  '_routeDirection', '_finalTargetBridge', '_finalTargetDirection',
  'lastPassedBridge', 'lastPassedBridgeTime', 'passedBridges',
  'status', 'etaMinutes',
  'timestamp', 'lastPositionUpdate', '_lastSeen',
];

describe('B1: snapshot-fullständighet (fältlist-vakten)', () => {
  let liveServices;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    liveServices = [];
  });

  afterEach(() => {
    for (const svc of liveServices) {
      try {
        svc.clearAllTimers();
      } catch (_) { /* tomt */ }
    }
    delete global.__TEST_MODE__;
  });

  function makeVds() {
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    liveServices.push(svc);
    return svc;
  }

  test('vessel:removed-snapshotten bär VARJE fält som fallbackvägen läser', () => {
    const svc = makeVds();
    const vessel = svc.updateVessel('265000001', {
      lat: 58.2790, lon: 12.2810, sog: 4.0, cog: 30, name: 'TESTBÅT',
    });
    expect(vessel).toBeTruthy();

    let payload = null;
    svc.on('vessel:removed', (p) => {
      payload = p;
    });
    svc.removeVessel('265000001', 'test-cleanup');

    expect(payload).toBeTruthy();
    const snapshot = payload.vessel;
    for (const field of SNAPSHOT_CONSUMED_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(snapshot, field)).toBe(true);
    }
    // Kärnan i F1-fixen: namnet följer med som `name` (inte `shipName`).
    expect(snapshot.name).toBe('TESTBÅT');
    expect(snapshot.shipName).toBeUndefined();
  });
});

describe('B1: persistent namncache (mmsi→namn över omstart)', () => {
  let store;

  function makeApp() {
    const a = new AISBridgeApp();
    a.log = jest.fn();
    a.error = jest.fn();
    a.debug = jest.fn();
    a.homey = {
      settings: {
        get: (k) => store[k],
        set: (k, v) => {
          store[k] = v;
        },
        on: jest.fn(),
      },
    };
    a._knownVesselNames = new Map();
    a._VESSEL_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    a._VESSEL_NAME_MAX_ENTRIES = 200;
    return a;
  }

  beforeEach(() => {
    store = {};
  });

  test('remember + lookup roundtrip; "Unknown" registreras aldrig', () => {
    const app = makeApp();
    app._rememberVesselName('265741640', 'VALEN');
    expect(app._lookupVesselName('265741640')).toBe('VALEN');

    app._rememberVesselName('265999999', 'Unknown');
    app._rememberVesselName('265999998', '   ');
    expect(app._lookupVesselName('265999999')).toBeNull();
    expect(app._lookupVesselName('265999998')).toBeNull();
  });

  test('omstart: namn persisterat i instans 1 hittas av instans 2 (VALEN-fallet)', () => {
    const app1 = makeApp();
    app1._rememberVesselName('265741640', 'VALEN');
    expect(store.known_vessel_names['265741640'].name).toBe('VALEN');

    const app2 = makeApp(); // delar samma settings-store
    app2._loadVesselNames();
    expect(app2._lookupVesselName('265741640')).toBe('VALEN');
  });

  test('TTL: poster äldre än 30 dagar filtreras vid load och lookup', () => {
    const app = makeApp();
    const now = Date.now();
    store.known_vessel_names = {
      265000001: { name: 'FÄRSK', t: now - 24 * 60 * 60 * 1000 }, // 1 dag
      265000002: { name: 'GAMMAL', t: now - 31 * 24 * 60 * 60 * 1000 }, // 31 dagar
      265000003: { name: 'Unknown', t: now }, // platshållare → bort
      265000004: 'korrupt', // fel form → bort
    };
    app._loadVesselNames();
    expect(app._lookupVesselName('265000001')).toBe('FÄRSK');
    expect(app._lookupVesselName('265000002')).toBeNull();
    expect(app._lookupVesselName('265000003')).toBeNull();
    expect(app._lookupVesselName('265000004')).toBeNull();
  });

  test('storlekstak: äldst-först-eviction vid persist', () => {
    const app = makeApp();
    app._VESSEL_NAME_MAX_ENTRIES = 3;
    const now = Date.now();
    app._knownVesselNames.set('1', { name: 'ÄLDST', t: now - 4000 });
    app._knownVesselNames.set('2', { name: 'MELLAN', t: now - 3000 });
    app._knownVesselNames.set('3', { name: 'NYARE', t: now - 2000 });
    app._knownVesselNames.set('4', { name: 'NYAST', t: now - 1000 });
    app._persistVesselNames();
    expect(app._knownVesselNames.size).toBe(3);
    expect(app._knownVesselNames.has('1')).toBe(false);
    expect(store.known_vessel_names['4'].name).toBe('NYAST');
  });

  test('write-throttling: oförändrat namn samma dygn skriver inte om settings', () => {
    const app = makeApp();
    app._rememberVesselName('265741640', 'VALEN');
    const firstWrite = store.known_vessel_names;
    app._rememberVesselName('265741640', 'VALEN'); // Class B upprepar namnet
    expect(store.known_vessel_names).toBe(firstWrite); // samma objektreferens = ingen ny skrivning
    app._rememberVesselName('265741640', 'VALEN II'); // namnbyte skriver
    expect(store.known_vessel_names['265741640'].name).toBe('VALEN II');
  });

  test('defensiv: kraschar inte utan settings', () => {
    const app = makeApp();
    app.homey = undefined;
    expect(() => app._loadVesselNames()).not.toThrow();
    expect(() => app._persistVesselNames()).not.toThrow();
    expect(() => app._rememberVesselName('1', 'X')).not.toThrow();
  });

  test('_processAISMessage: cachat namn ersätter "Unknown" i vesselPatch', () => {
    const app = makeApp();
    app._rememberVesselName('265741640', 'VALEN');
    const patches = [];
    app.vesselDataService = {
      updateVessel: (mmsi, patch) => {
        patches.push({ mmsi, patch }); return null;
      },
    };
    app._captureAISReplaySample = jest.fn();

    app._processAISMessage({
      mmsi: '265741640', lat: 58.3072, lon: 12.3128, sog: 7.7, cog: 223, shipName: 'Unknown',
    });
    expect(patches[0].patch.name).toBe('VALEN');
    // Replay-inspelningen ska bära det EFFEKTIVA namnet (cache-injicerat).
    expect(app._captureAISReplaySample.mock.calls[0][0].shipName).toBe('VALEN');

    // Riktigt namn i meddelandet vinner och registreras i cachen.
    app._processAISMessage({
      mmsi: '265000005', lat: 58.3072, lon: 12.3128, sog: 5, cog: 200, shipName: 'DIANA',
    });
    expect(patches[1].patch.name).toBe('DIANA');
    expect(app._lookupVesselName('265000005')).toBe('DIANA');
  });
});

describe('B1: statiska rapporter (static-name)', () => {
  let store;

  function makeApp() {
    const a = new AISBridgeApp();
    a.log = jest.fn();
    a.error = jest.fn();
    a.debug = jest.fn();
    a.homey = {
      settings: {
        get: (k) => store[k],
        set: (k, v) => {
          store[k] = v;
        },
        on: jest.fn(),
      },
    };
    a._knownVesselNames = new Map();
    a._VESSEL_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    a._VESSEL_NAME_MAX_ENTRIES = 200;
    return a;
  }

  beforeEach(() => {
    store = {};
  });

  test('AISStreamClient emit:ar static-name för typ 24 (ReportA) och typ 5', () => {
    const AISStreamClient = require('../lib/connection/AISStreamClient');
    const client = new AISStreamClient({ log: jest.fn(), error: jest.fn(), debug: jest.fn() });
    const emitted = [];
    client.on('static-name', (d) => emitted.push(d));

    // Typ 24 del A (Class B-namnets kanal) — ingen position.
    client._onMessage(JSON.stringify({
      MessageType: 'StaticDataReport',
      MetaData: { MMSI: 265741640 },
      Message: { StaticDataReport: { MMSI: 265741640, ReportA: { Name: 'VALEN' } } },
    }));
    // Typ 5 (Class A).
    client._onMessage(JSON.stringify({
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: 219033807 },
      Message: { ShipStaticData: { MMSI: 219033807, Name: 'SOLUTION' } },
    }));
    // Platshållare ska INTE emit:as.
    client._onMessage(JSON.stringify({
      MessageType: 'StaticDataReport',
      MetaData: { MMSI: 265000001, ShipName: 'Unknown' },
      Message: { StaticDataReport: { MMSI: 265000001 } },
    }));

    expect(emitted).toEqual([
      { mmsi: '265741640', shipName: 'VALEN' },
      { mmsi: '219033807', shipName: 'SOLUTION' },
    ]);
  });

  test('_onStaticName fyller cachen och uppdaterar levande Unknown-vessel', () => {
    const app = makeApp();
    const liveVessel = { mmsi: '265741640', name: 'Unknown' };
    app.vesselDataService = {
      getVessel: (mmsi) => (mmsi === '265741640' ? liveVessel : null),
    };

    app._onStaticName({ mmsi: '265741640', shipName: 'VALEN' });
    expect(app._lookupVesselName('265741640')).toBe('VALEN');
    expect(liveVessel.name).toBe('VALEN');

    // Ett redan känt namn på levande vessel skrivs INTE över.
    const namedVessel = { mmsi: '265000002', name: 'DIANA' };
    app.vesselDataService.getVessel = () => namedVessel;
    app._onStaticName({ mmsi: '265000002', shipName: 'DIANA II' });
    expect(namedVessel.name).toBe('DIANA'); // levande objekt orört
    expect(app._lookupVesselName('265000002')).toBe('DIANA II'); // cachen uppdaterad

    // Skapar aldrig vessel och kraschar inte utan VDS.
    app.vesselDataService = undefined;
    expect(() => app._onStaticName({ mmsi: '1', shipName: 'X' })).not.toThrow();
  });
});

describe('B1: token-fallback "Okänd båt" (användarbeslut 2026-07-03)', () => {
  test('notistoken använder cachen; annars "Okänd båt" — aldrig "Unknown"', async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = { settings: { get: () => null, set: () => {}, on: jest.fn() } };
    app._knownVesselNames = new Map();
    app._VESSEL_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    app._VESSEL_NAME_MAX_ENTRIES = 200;
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();

    const fired = [];
    app._triggerBoatNearFlowBest = async (tokens, state) => {
      fired.push({ tokens, state });
    };
    app._getDirectionString = () => 'southbound';
    app._isVesselAnchoredOutsideCanal = () => false;

    const vessel = {
      mmsi: '265000001', name: 'Unknown', lat: 58.284, lon: 12.284, sog: 4, cog: 200, status: 'en-route', etaMinutes: 5,
    };
    const candidate = {
      name: 'Klaffbron', id: 'klaffbron', distance: 120, source: 'current',
    };

    // Utan cache: "Okänd båt".
    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    expect(fired[0].tokens.vessel_name).toBe('Okänd båt');
    expect(fired[0].state.distance).toBe(120);
    expect(fired[0].state.source).toBe('current');

    // Med cache: riktiga namnet.
    app._knownVesselNames.set('265000001', { name: 'VALEN', t: Date.now() });
    app._triggeredBoatNearKeys.clear();
    app._persistentRecentTriggers.clear();
    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    expect(fired[1].tokens.vessel_name).toBe('VALEN');
  });
});
