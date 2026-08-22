'use strict';

/**
 * J2 (helkodsgranskning RUNDA 2, 2026-08-22, critical) — H1:s SYSTERSTÄLLE:
 * bronamnsgissningen får inte gå före ruttlåset vid MÅLTILLDELNING.
 *
 * MEKANISMEN. `updateVessel` har två måltilldelningsgrenar, NEW och
 * ACCELERATED, som bar var sin kopia av samma uttryck:
 * `_safeDetermineDirection(cog) || (målbro === 'Stridsbergsbron' ? 'north' : 'south')`.
 * H1 lyfte in ruttlåset i _calculateNextTargetBridge och i TARGET_END-grenen —
 * men INTE här. Namnmappningen gäller bara MELLAN broarna: SÖDER om Klaffbron
 * är Klaffbron målbro för en NORRGÅENDE, och NORR om Stridsbergsbron är
 * Stridsbergsbron målbro för en SÖDERGÅENDE. I de två yttre zonerna är
 * gissningen alltså EXAKT INVERTERAD.
 *
 * INDATAKLASSEN ÄR VANLIG. Sedan FP8/IDUN får en COG-LÖS båt målbro via
 * ruttlåset (~9 % av raderna i fältprov 10 saknar COG), men låset lästes inte
 * vid riktningshärledningen och `_lockRouteDirection` skriver ALLTID över.
 * C4b-grinden fångar bara fart under 2,0 kn.
 *
 * FÖLJDERNA (båda uppmätta i granskningen): fel riktningstoken i boat_near,
 * bron bedömd som redan passerad av öppningsmotorn — och, som testet nedan
 * visar, en BRUTEN målbrokedja: `_calculateNextTargetBridge` returnerar null
 * när låset pekar åt fel håll, vilket är H1:s ursprungliga felmod igen.
 *
 * Testet kör RIKTIG `updateVessel` (kajavgång ⇒ ACCELERATED-grenen), inte
 * handsatta fält.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

// lib/constants.js BRIDGES — kanalen är strikt latitudordnad syd→nord.
const KLAFFBRON = { lat: 58.28409551543077, lon: 12.283929525245636 };
const STRIDSBERGSBRON = { lat: 58.293524096154634, lon: 12.294566425158054 };
// 0,0018° latitud ≈ 200 m; 0,00225° ≈ 250 m.
const M200 = 0.0018;
const M250 = 0.00225;

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
 * KAJAVGÅNGEN — exakt det flöde ACCELERATED-grenen finns för:
 *  1) ett stillaliggande sampel utan målbro (fart under rörelsebeviset),
 *  2) ruttlåset står kvar som ANKOMSTBEVIS (MOORED_DEMOTE bevarar det med flit,
 *     se kommentaren vid demoten i updateVessel),
 *  3) avgång i 3 kn UTAN COG — den fartgivarlösa/COG-lösa klassen.
 */
function runAcceleratedDeparture(svc, mmsi, { lat, lon, lock }) {
  svc.updateVessel(mmsi, {
    mmsi, lat, lon, sog: 0.1, cog: null, name: 'J2-PROV', timestamp: Date.now(),
  });
  const vessel = svc.vessels.get(mmsi);
  expect(vessel.targetBridge).toBeNull();
  vessel._routeDirection = lock;
  svc.updateVessel(mmsi, {
    mmsi, lat: lat + 0.00002, lon, sog: 3.0, cog: null, name: 'J2-PROV', timestamp: Date.now(),
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

describe('J2: ACCELERATED-grenens riktning följer ruttlåset, inte bronamnet', () => {
  test('NORRGÅENDE söder om Klaffbron (COG-lös, 3 kn): låset förblir north', () => {
    const svc = makeVDS();
    const vessel = runAcceleratedDeparture(svc, '265922001', {
      lat: KLAFFBRON.lat - M200, lon: KLAFFBRON.lon, lock: 'north',
    });

    expect(vessel.targetBridge).toBe('Klaffbron');
    // Före fixen: 'south' (bronamnet Klaffbron ⇒ syd) — inverterat.
    expect(vessel._routeDirection).toBe('north');
    // Följdbeviset: kedjan till nästa bro är hel.
    expect(svc._calculateNextTargetBridge(vessel)).toBe('Stridsbergsbron');
  });

  test('SÖDERGÅENDE norr om Stridsbergsbron (COG-lös, 3 kn): låset förblir south', () => {
    const svc = makeVDS();
    const vessel = runAcceleratedDeparture(svc, '265922002', {
      lat: STRIDSBERGSBRON.lat + M250, lon: STRIDSBERGSBRON.lon, lock: 'south',
    });

    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    // Före fixen: 'north' (bronamnet Stridsbergsbron ⇒ nord) — inverterat.
    expect(vessel._routeDirection).toBe('south');
    expect(svc._calculateNextTargetBridge(vessel)).toBe('Klaffbron');
  });

  test('COG VINNER fortfarande över låset (oförändrad förstahandskälla)', () => {
    const svc = makeVDS();
    const mmsi = '265922003';
    // Kajliggare 400 m NORR om Klaffbron med STALE nordlås, som avgår SÖDERUT
    // med entydig COG i 4 kn. Rörelsebeviset gör att C4b-grinden inte biter,
    // och COG ska äga beslutet precis som förut — äkta U-svängar
    // (HALIFAX/AKIRA-klassen) får inte frysas fast av ett gammalt lås.
    svc.updateVessel(mmsi, {
      mmsi, lat: KLAFFBRON.lat + 0.0036, lon: KLAFFBRON.lon, sog: 0.1, cog: null, name: 'J2-PROV', timestamp: Date.now(),
    });
    svc.vessels.get(mmsi)._routeDirection = 'north';
    svc.updateVessel(mmsi, {
      mmsi, lat: KLAFFBRON.lat + 0.0034, lon: KLAFFBRON.lon, sog: 4.0, cog: 190, name: 'J2-PROV', timestamp: Date.now(),
    });
    const vessel = svc.vessels.get(mmsi);
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel._routeDirection).toBe('south');
  });

  test('UTAN LÅS gäller bronamnet precis som förut (ingen ny spärr)', () => {
    const svc = makeVDS();
    // Rent enhetsprov på härledningen: varken COG eller lås ⇒ sista utvägen.
    expect(svc._deriveAssignmentDirection({ cog: null }, 'Stridsbergsbron')).toBe('north');
    expect(svc._deriveAssignmentDirection({ cog: null }, 'Klaffbron')).toBe('south');
    // Skräpvärden i låsen får inte kunna läcka igenom som riktning.
    expect(svc._deriveAssignmentDirection({ cog: null, _routeDirection: 'unknown' }, 'Klaffbron')).toBe('south');
    // _finalTargetDirection är andrahandslåset.
    expect(svc._deriveAssignmentDirection({ cog: null, _finalTargetDirection: 'north' }, 'Klaffbron')).toBe('north');
    // …och _routeDirection går före det (samma fält C4b-grinden mäter mot).
    expect(svc._deriveAssignmentDirection(
      { cog: null, _routeDirection: 'south', _finalTargetDirection: 'north' }, 'Stridsbergsbron',
    )).toBe('south');
  });

  test('NEW-grenen använder SAMMA härledning (tvillingarna får inte glida isär)', () => {
    const svc = makeVDS();
    const spy = jest.spyOn(svc, '_deriveAssignmentDirection');
    // Ny båt, norrgående med entydig COG, 500 m söder om Klaffbron.
    svc.updateVessel('265922004', {
      mmsi: '265922004',
      lat: KLAFFBRON.lat - 0.0045,
      lon: KLAFFBRON.lon,
      sog: 4.0,
      cog: 30,
      name: 'J2-NY',
      timestamp: Date.now(),
    });
    const vessel = svc.vessels.get('265922004');
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel._routeDirection).toBe('north');
    expect(spy).toHaveBeenCalledWith(vessel, 'Klaffbron');
  });
});
