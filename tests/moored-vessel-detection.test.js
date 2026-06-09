'use strict';

/**
 * Förtöjningsdetektering (2026-06-10) — prod-bugg dag 1: båt förtöjd vid
 * kajen norr om Klaffbron (inom 280m-väntzonen) tolkades som "inväntar
 * broöppning" på obestämd tid + avfyrade falsk boat_near.
 *
 * Fyra lager testas här genom RIKTIGA updateVessel:
 *  1. Rörelsebevis: inget målbro förrän fartyget setts röra sig
 *  2. Demotering (target rensas) i stället för borttagning
 *  3. AIS NavigationalStatus (1=at anchor, 5=moored) — endast vid stillhet
 *  4. Förtöjningszon (kapsel längs kajen)
 *  5. 2h-backstop — och VIKTIGAST: en äkta väntare som väntat 90 min på
 *     rusningsspärr ska INTE demoteras.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const { MOORING_ZONES } = require('../lib/constants');

// Kajzonens mitt (mellan användarens verifierade kajsegment)
const QUAY = { lat: 58.286059, lon: 12.285651 };
// Äkta väntposition: mitt i farleden norr om Klaffbron, utanför kajkapseln
const FAIRWAY_HOLD = { lat: 58.28590, lon: 12.28660 };

describe('Förtöjningsdetektering: kajliggare vs äkta broöppningsväntare', () => {
  let svc;
  let mockNow;
  const realDateNow = Date.now;
  const logger = {
    debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 5, 10, 10, 0, 0).getTime();
    Date.now = () => mockNow;

    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    svc = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    svc.clearAllTimers();
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  function tick(minutes = 1) {
    mockNow += minutes * 60 * 1000;
  }

  // Hjälpare: segla in en båt söderut mot Klaffbron så den FÅR target legitimt
  function sailInSouthbound(mmsi) {
    const path = [
      { lat: 58.28950, lon: 12.28950 }, // norr om Järnvägsbron-trakten
      { lat: 58.28820, lon: 12.28800 },
      { lat: 58.28700, lon: 12.28700 },
    ];
    let vessel;
    for (const p of path) {
      vessel = svc.updateVessel(mmsi, {
        lat: p.lat, lon: p.lon, sog: 4.5, cog: 205, name: 'TEST',
      });
      tick(1);
    }
    return vessel;
  }

  test('sanity: väntpositionen i farleden ligger utanför kajkapseln', () => {
    const zone = MOORING_ZONES[0];
    const d = geometry.distancePointToSegmentM(
      FAIRWAY_HOLD.lat, FAIRWAY_HOLD.lon,
      zone.start.lat, zone.start.lon, zone.end.lat, zone.end.lon,
    );
    expect(d).toBeGreaterThan(zone.radiusM + 10); // marginal
  });

  test('LAGER 1: kajliggare vid appstart får ALDRIG målbro (prod-buggen)', () => {
    // Förtöjd båt med syd-pekande COG (skulle utan fixen få Klaffbron + waiting)
    let vessel;
    for (let i = 0; i < 5; i++) {
      vessel = svc.updateVessel('265000001', {
        lat: QUAY.lat, lon: QUAY.lon, sog: 0.0, cog: 205, name: 'KAJLIGGARE',
      });
      tick(3);
    }
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._hasMovementProof).toBe(false);
    expect(vessel._moored).toBe(true); // stationär + i zonen
  });

  test('LAGER 1: båt i rörelse får målbro direkt (rörelse = bevis)', () => {
    const vessel = svc.updateVessel('265000002', {
      lat: 58.28700, lon: 12.28700, sog: 4.5, cog: 205, name: 'RÖRLIG',
    });
    expect(vessel._hasMovementProof).toBe(true);
    expect(vessel.targetBridge).toBe('Klaffbron');
  });

  test('LAGER 4+2: båt seglar in, förtöjer vid kajen → demoteras (target rensas, ej borttagen)', () => {
    sailInSouthbound('265000003');
    let vessel = svc.getVessel('265000003');
    expect(vessel.targetBridge).toBe('Klaffbron');

    // Förtöjer vid kajen (stationär i zonen)
    for (let i = 0; i < 3; i++) {
      vessel = svc.updateVessel('265000003', {
        lat: QUAY.lat, lon: QUAY.lon, sog: 0.1, cog: 30, name: 'TEST',
      });
      tick(3);
    }
    expect(vessel._moored).toBe(true);
    expect(vessel.targetBridge).toBeNull(); // demoterad
    expect(svc.getVessel('265000003')).toBeTruthy(); // INTE borttagen (lager 2)
  });

  test('ÄKTA VÄNTARE: stilla i farleden 90 min (rusningsspärr) behåller målbron', () => {
    sailInSouthbound('265000004');

    // Håller position i farleden, utanför zonen, i 90 minuter
    let vessel;
    for (let i = 0; i < 30; i++) {
      vessel = svc.updateVessel('265000004', {
        lat: FAIRWAY_HOLD.lat, lon: FAIRWAY_HOLD.lon, sog: 0.1, cog: 205, name: 'TEST',
      });
      tick(3);
    }
    expect(vessel._moored).toBe(false); // ren stillhet demoterar ALDRIG (<2h)
    expect(vessel.targetBridge).toBe('Klaffbron');
  });

  test('LAGER 5: stilla i farleden >2h → backstop demoterar till slut', () => {
    sailInSouthbound('265000005');

    let vessel;
    for (let i = 0; i < 45; i++) { // 45 × 3 min = 135 min > 2h
      vessel = svc.updateVessel('265000005', {
        lat: FAIRWAY_HOLD.lat, lon: FAIRWAY_HOLD.lon, sog: 0.1, cog: 205, name: 'TEST',
      });
      tick(3);
    }
    expect(vessel._moored).toBe(true);
    expect(vessel.targetBridge).toBeNull();
  });

  test('LAGER 3: deklarerad navstatus moored + stillhet → demoteras direkt', () => {
    sailInSouthbound('265000006');

    const vessel = svc.updateVessel('265000006', {
      lat: FAIRWAY_HOLD.lat, lon: FAIRWAY_HOLD.lon, sog: 0.1, cog: 205, navStatus: 5, name: 'TEST',
    });
    expect(vessel._moored).toBe(true);
    expect(vessel.targetBridge).toBeNull();
  });

  test('LAGER 3-skydd: navstatus moored men båten RÖR SIG (glömd status) → demoteras INTE', () => {
    sailInSouthbound('265000007');

    const vessel = svc.updateVessel('265000007', {
      lat: 58.28650, lon: 12.28650, sog: 4.0, cog: 205, navStatus: 5, name: 'TEST',
    });
    expect(vessel._moored).toBe(false); // rörelse trumfar deklarerad status
    expect(vessel.targetBridge).toBe('Klaffbron');
  });

  test('ÅTERPROMOVERING: kajliggare som kastar loss får målbro inom en uppdatering', () => {
    // Förtöjd först (ingen target)
    for (let i = 0; i < 3; i++) {
      svc.updateVessel('265000008', {
        lat: QUAY.lat, lon: QUAY.lon, sog: 0.0, cog: 25, name: 'TEST',
      });
      tick(3);
    }
    expect(svc.getVessel('265000008').targetBridge).toBeNull();

    // Kastar loss norrut (mot Stridsbergsbron)
    tick(1);
    const vessel = svc.updateVessel('265000008', {
      lat: 58.28680, lon: 12.28680, sog: 4.0, cog: 30, name: 'TEST',
    });
    expect(vessel._moored).toBe(false);
    expect(vessel._hasMovementProof).toBe(true);
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
  });

  test('GENOMFART: båt som passerar zonen i fart påverkas inte', () => {
    const vessel = svc.updateVessel('265000009', {
      lat: QUAY.lat, lon: QUAY.lon, sog: 5.5, cog: 25, name: 'TEST',
    });
    expect(vessel._moored).toBe(false); // zonen kräver stillhet
    expect(vessel.targetBridge).toBe('Stridsbergsbron'); // norrgående
  });
});

describe('geometry.distancePointToSegmentM', () => {
  const A = { lat: 58.285685, lon: 12.285164 };
  const B = { lat: 58.286434, lon: 12.286138 };

  test('punkt på segmentet → ~0 m', () => {
    const mid = { lat: (A.lat + B.lat) / 2, lon: (A.lon + B.lon) / 2 };
    expect(geometry.distancePointToSegmentM(mid.lat, mid.lon, A.lat, A.lon, B.lat, B.lon)).toBeLessThan(1);
  });

  test('punkt vid ändpunkt utanför segmentet klampas till ändpunkten', () => {
    // 100 m söder om A längs segmentets förlängning → avstånd ≈ 100 m (inte 0)
    const d = geometry.distancePointToSegmentM(
      A.lat - 0.0009, A.lon - 0.00117, A.lat, A.lon, B.lat, B.lon,
    );
    expect(d).toBeGreaterThan(80);
    expect(d).toBeLessThan(160);
  });

  test('känd tvärpunkt: kajzonens mitt ligger nära linjen, farledspunkten längre bort', () => {
    const dQuay = geometry.distancePointToSegmentM(58.286059, 12.285651, A.lat, A.lon, B.lat, B.lon);
    const dFairway = geometry.distancePointToSegmentM(58.28590, 12.28660, A.lat, A.lon, B.lat, B.lon);
    expect(dQuay).toBeLessThan(10);
    expect(dFairway).toBeGreaterThan(40);
  });

  test('ogiltig indata → Infinity (säkert för <=-jämförelser)', () => {
    expect(geometry.distancePointToSegmentM(NaN, 12, A.lat, A.lon, B.lat, B.lon)).toBe(Infinity);
    expect(geometry.distancePointToSegmentM(58, null, A.lat, A.lon, B.lat, B.lon)).toBe(Infinity);
  });

  test('degenererat segment (A=B) → punktavstånd', () => {
    const d = geometry.distancePointToSegmentM(A.lat, A.lon + 0.001, A.lat, A.lon, A.lat, A.lon);
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(70);
  });
});

describe('AISStreamClient: NavigationalStatus-extraktion', () => {
  const AISStreamClient = require('../lib/connection/AISStreamClient');

  function extract(message) {
    const client = new AISStreamClient({ log: jest.fn(), error: jest.fn(), debug: jest.fn() });
    return client._extractAISData(message);
  }

  test('Class A PositionReport med NavigationalStatus → navStatus medföljer', () => {
    const data = extract({
      MessageType: 'PositionReport',
      Message: {
        PositionReport: {
          MMSI: 265000010, SOG: 0, COG: 25, NavigationalStatus: 5,
        },
      },
      MetaData: { Latitude: 58.286, Longitude: 12.2856 },
    });
    expect(data.navStatus).toBe(5);
  });

  test('Class B utan fältet → navStatus null', () => {
    const data = extract({
      MessageType: 'StandardClassBPositionReport',
      Message: { StandardClassBPositionReport: { MMSI: 265000011, SOG: 0, COG: 25 } },
      MetaData: { Latitude: 58.286, Longitude: 12.2856 },
    });
    expect(data.navStatus).toBeNull();
  });

  test('ogiltigt värde (utanför 0-15) → null', () => {
    const data = extract({
      MessageType: 'PositionReport',
      Message: {
        PositionReport: {
          MMSI: 265000012, SOG: 0, COG: 25, NavigationalStatus: 99,
        },
      },
      MetaData: { Latitude: 58.286, Longitude: 12.2856 },
    });
    expect(data.navStatus).toBeNull();
  });
});
