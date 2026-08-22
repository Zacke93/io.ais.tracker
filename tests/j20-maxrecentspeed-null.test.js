'use strict';

/**
 * J20 (helkodsgranskning RUNDA 2, 2026-08-22, major) — H19-REGRESSION:
 * `maxRecentSpeed` blev 0 i stället för OKÄNT för fartgivarlösa båtar.
 *
 * MEKANISMEN. `_calculateMaxRecentSpeed` tog `Math.max` över speedHistoryns
 * `speed`-fält. För en båt som ALDRIG rapporterar fart består historiken av
 * idel `null`, och `Math.max` KOERCERAR null till 0 — ett FINIT värde som
 * påstår "max 0,0 kn" i stället för "okänt". Bara första samplet
 * (förstakontaktsgrenen) svarade korrekt `null`, vilket är just därför felet
 * var svårt att se: det uppstod på sampel två.
 *
 * VARFÖR DET BLEV EN MAJOR. H19 (fixrunda 1) lade exit-grinden
 * `exitSpeedKnown = Number.isFinite(sog) || Number.isFinite(maxRecentSpeed)`
 * (app.js) med den uttalade avsikten att AVSTÅ när båda saknas. Med en
 * fabricerad nolla slår grinden i stället till, och HELA den fartgivarlösa
 * klassen förlorar sin Kanalinfarten-exitnotis tyst — tvärtemot kodens egen
 * kommentar.
 *
 * TESTERNA matar `sog: null` genom HELA `updateVessel`-pipelinen (dagens
 * H19-test handsätter fältet och låser därför en kombination pipelinen aldrig
 * kan producera) och läser resultatet både på fartyget och i removal-
 * snapshotten.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

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

/** Kör n AIS-rader med angivna sog-värden genom den riktiga pipelinen. */
function feed(svc, mmsi, sogs) {
  sogs.forEach((sog, i) => {
    svc.updateVessel(mmsi, {
      mmsi,
      lat: 58.2800 + i * 0.0002,
      lon: 12.2820,
      sog,
      cog: 20,
      name: 'J20-PROV',
      timestamp: Date.now(),
    });
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

describe('J20: fartgivarlös båt ger maxRecentSpeed = null, aldrig 0', () => {
  test('5 sampel med sog=null genom hela pipelinen ⇒ maxRecentSpeed null', () => {
    const svc = makeVDS();
    const vessel = feed(svc, '265933001', [null, null, null, null, null]);

    expect(vessel.speedHistory).toHaveLength(5);
    // Före fixen: 0 (Math.max koercerade null) ⇒ Number.isFinite = true.
    expect(vessel.maxRecentSpeed).toBeNull();
    expect(Number.isFinite(vessel.maxRecentSpeed)).toBe(false);
  });

  test('REMOVAL-SNAPSHOTEN bär null vidare till exit-grinden', () => {
    const svc = makeVDS();
    const mmsi = '265933002';
    feed(svc, mmsi, [null, null, null, null, null]);

    let snapshotValue = 'ej satt';
    svc.on('vessel:removed', ({ vessel }) => {
      snapshotValue = vessel.maxRecentSpeed;
    });
    svc.removeVessel(mmsi, 'manual');

    expect(snapshotValue).toBeNull();
    // Detta ÄR H19-grindens fråga (app.js): okänd fart ⇒ avstå, inte fälla.
    expect(Number.isFinite(snapshotValue)).toBe(false);
  });

  test('FÖRSTAKONTAKT med sog=null ger null (inte null-koercerat värde)', () => {
    const svc = makeVDS();
    // Direktanropet på förstakontaktsgrenen — samma regel som historikvägen.
    expect(svc._calculateMaxRecentSpeed(null, null)).toBeNull();
    expect(svc._calculateMaxRecentSpeed(null, undefined)).toBeNull();
    expect(svc._calculateMaxRecentSpeed(null, 4.2)).toBe(4.2);
    // Fartgivarlös båt som stannar på ETT sampel ska också ge okänt.
    const vessel = feed(svc, '265933003', [null]);
    expect(vessel.maxRecentSpeed).toBeNull();
  });

  test('BLANDAD SÄNDARE: max över de finita värdena är oförändrat', () => {
    const svc = makeVDS();
    const vessel = feed(svc, '265933004', [1.2, null, 6.4, null, 3.0]);
    expect(vessel.maxRecentSpeed).toBe(6.4);
  });

  test('REN SÄNDARE: oförändrat beteende (ingen ny spärr)', () => {
    const svc = makeVDS();
    const vessel = feed(svc, '265933005', [1.2, 5.5, 3.0]);
    expect(vessel.maxRecentSpeed).toBe(5.5);
  });

  test('0,0 kn är ett ÄKTA värde och får inte förväxlas med okänt', () => {
    const svc = makeVDS();
    const vessel = feed(svc, '265933006', [0, 0, 0]);
    // Rapporterad nolla ÄR kunskap — grinden ska fortsatt kunna läsa den.
    expect(vessel.maxRecentSpeed).toBe(0);
    expect(Number.isFinite(vessel.maxRecentSpeed)).toBe(true);
  });
});
