'use strict';

/**
 * J1 (helkodsgranskning RUNDA 2, 2026-08-22, critical) — REMOVAL-SNAPSHOTEN
 * MÅSTE ÄGA SINA EGNA VÄRDEN.
 *
 * MEKANISMEN. `removeVessel` bygger en snapshot FÖRE `_cleanupVesselState` och
 * skickar den med `vessel:removed`, just därför att städningen nollar det
 * levande objektet. U-svängsflaggan `_newJourneyPending` kopierades dock som
 * REFERENS (`vessel._newJourneyPending || null`) medan grannfältet `passedAt`
 * spreadades per värde. Fältet saknades dessutom i städningens EXPLICITA
 * nollningslista, så den dynamiska rensningsloopen nollade objektets UNDERFÄLT
 * IN-PLACE — och den kör före emit. Snapshotten levererade alltså
 * `{dir: null, time: null}`.
 *
 * VARFÖR DET BLEV KRITISKT FÖRST NU. Så länge konsumenten läste rå truthiness
 * överlevde felet oupptäckt (ett tomt objekt är fortfarande truthy). H14
 * (fixrunda 1) bytte app.js:s konsument till `_pendingReversalActive`, som
 * kräver FINIT `time` — och svarar därför ALLTID false på removal-vägen.
 * Fantom-exit-vakten var 100 % död: en U-svängd båt med färsk pending fick
 * falsk boat_near Kanalinfarten och blockerade den ÄKTA exiten i 2 h.
 *
 * TESTERNA kör RIKTIG `removeVessel` och läser snapshotten INNE i
 * `vessel:removed`-lyssnaren, precis som app.js gör.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const AISBridgeApp = require('../app');
const { TRIGGER_POINTS } = require('../lib/constants');

// Kanalinfarten ligger ~620 m från närmaste bro (Olidebron) — utanför
// PROTECTION_ZONE_RADIUS (300 m), så en timeout-radering går hela vägen
// igenom i stället för att skjutas upp av skyddszonen.
const KANAL = TRIGGER_POINTS.kanalinfarten;

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

const liveServices = [];

function makeVDS() {
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

/**
 * Kör en U-svängd båt genom den RIKTIGA pipelinen: två AIS-rader där flaggan
 * sätts på det levande objektet mellan raderna (exakt app.js:2138) och därmed
 * ärvs av `_createVesselObject` i rad två.
 */
function seedPendingVessel(svc, mmsi) {
  svc.updateVessel(mmsi, {
    mmsi, lat: KANAL.lat, lon: KANAL.lon, sog: 3.4, cog: 200, name: 'J1-PROV', timestamp: Date.now(),
  });
  svc.vessels.get(mmsi)._newJourneyPending = { dir: 'north', time: Date.now() };
  svc.updateVessel(mmsi, {
    mmsi, lat: KANAL.lat + 0.00001, lon: KANAL.lon, sog: 3.2, cog: 200, name: 'J1-PROV', timestamp: Date.now(),
  });
  return svc.vessels.get(mmsi);
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

afterEach(() => {
  while (liveServices.length > 0) {
    const svc = liveServices.pop();
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  jest.clearAllMocks();
});

describe('J1: removal-snapshotens U-svängsflagga överlever städningen', () => {
  test('RIKTIG removeVessel: lyssnaren ser {dir:"north", time:<finit>}', () => {
    const svc = makeVDS();
    const mmsi = '265911001';
    const live = seedPendingVessel(svc, mmsi);
    expect(live._newJourneyPending).toEqual({ dir: 'north', time: expect.any(Number) });

    let seen;
    svc.on('vessel:removed', ({ vessel }) => {
      // LÄSNINGEN SKER INNE I LYSSNAREN — det är hela poängen: städningen har
      // redan kört när eventet går ut.
      seen = vessel._newJourneyPending;
    });

    svc.removeVessel(mmsi, 'timeout');

    expect(seen).not.toBeNull();
    expect(seen).toBeDefined();
    expect(seen.dir).toBe('north');
    expect(Number.isFinite(seen.time)).toBe(true);
  });

  test('KONSUMENTEN: app.js _pendingReversalActive svarar true på snapshotten', () => {
    const svc = makeVDS();
    const mmsi = '265911002';
    seedPendingVessel(svc, mmsi);

    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();

    let verdict;
    svc.on('vessel:removed', ({ vessel }) => {
      verdict = app._pendingReversalActive(vessel);
    });
    svc.removeVessel(mmsi, 'timeout');

    // Före fixen: ALLTID false (time nollad in-place) ⇒ fantom-exit-vakten död.
    expect(verdict).toBe(true);
  });

  test('SNAPSHOTEN ÄGER OBJEKTET: fältet är inte samma referens som fartygets', () => {
    const svc = makeVDS();
    const mmsi = '265911003';
    const live = seedPendingVessel(svc, mmsi);
    const livePending = live._newJourneyPending;

    let snapshotPending;
    svc.on('vessel:removed', ({ vessel }) => {
      snapshotPending = vessel._newJourneyPending;
    });
    svc.removeVessel(mmsi, 'timeout');

    expect(snapshotPending).not.toBe(livePending);
  });

  test('STÄDNINGEN MUTERAR INTE OBJEKTET: fångad pending är orörd efter removal', () => {
    const svc = makeVDS();
    const mmsi = '265911004';
    const live = seedPendingVessel(svc, mmsi);
    // Fånga SJÄLVA objektet före raderingen — vem som helst kan ha en kopia av
    // referensen (snapshotten hade det). Städningen får nolla fartygets FÄLT,
    // aldrig objektets innehåll.
    const captured = live._newJourneyPending;
    const capturedTime = captured.time;

    svc.removeVessel(mmsi, 'timeout');

    expect(captured.dir).toBe('north');
    expect(captured.time).toBe(capturedTime);
    // …och fartygets eget fält ÄR nollat (minnet frigörs som förut).
    expect(live._newJourneyPending).toBeNull();
  });

  test('INVARIANT (generisk): inget objekt/array i snapshotten delas med det levande fartyget', () => {
    const svc = makeVDS();
    const mmsi = '265911005';
    const live = seedPendingVessel(svc, mmsi);
    // Ge fartyget så många sammansatta fält som möjligt innan raderingen, så
    // svepet får något att bita i (passedBridges, passedAt, speedHistory …).
    live.passedBridges = ['Klaffbron'];
    live.passedAt = { Klaffbron: Date.now() };

    const liveObjectRefs = new Map();
    for (const key of Object.keys(live)) {
      const value = live[key];
      if (value && typeof value === 'object') liveObjectRefs.set(key, value);
    }

    const shared = [];
    svc.on('vessel:removed', ({ vessel }) => {
      for (const key of Object.keys(vessel)) {
        const value = vessel[key];
        if (value && typeof value === 'object' && liveObjectRefs.get(key) === value) {
          shared.push(key);
        }
      }
    });
    svc.removeVessel(mmsi, 'timeout');

    // Delad referens = fältet kan tömmas bakvägen av _cleanupVesselState.
    // Det var exakt J1:s mekanism; invarianten fångar nästa fält som glöms.
    expect(shared).toEqual([]);
  });
});
