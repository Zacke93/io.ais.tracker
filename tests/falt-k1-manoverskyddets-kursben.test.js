'use strict';

/**
 * Fältprov k1 (2026-11-11, rättningskampanjen familj D, revision 1) —
 * MANÖVERSKYDDET SÖDER OM KANALINFARTEN-PUNKTEN KRÄVER VERKLIG RÖRELSE.
 *
 * SITUATIONEN. PRICKBJORN (265012090) fick målbro Klaffbron i 6,6 kn vid
 * Kanalinfarten, svängde in mot en kaj och låg sedan still 166 m från punkten,
 * 2,1 km från bron. Svängen aktiverade manöverskyddet med rätta. När det släppt
 * och nådafristen startat återaktiverades det av kursbrus (292° → 152° vid
 * sog 0 och 2,5 m), och nästa kurshopp (sog 0,1, 1,3 m) förlängde det. Målbron
 * släpptes 138 s för sent och texten räknade henne "på väg mot Klaffbron".
 *
 * RÄTTNINGEN (VesselDataService._maneuverLacksMovement): när BÅDA fixarna
 * ligger söder om TRIGGER_POINTS.kanalinfarten.lat (FP9-H′:s område och
 * villkor) och båten flyttat sig < NULL_SOG_STILL_RADIUS_M (40 m):
 *  - räknas kursbenet inte när samplets egen fart (_rawPositionSog) är under
 *    STATIONARY_SOG_KN (0,3 kn);
 *  - räknas inget ben när farten hoppat mer än fartbenets 2 kn (fartbrus vid
 *    kaj, granskningens M1).
 * Norr om punkten är allt oförändrat: där är kursbruset det som håller en stilla
 * köare utanför kö-zonen (granskningens H1).
 *
 * Geometrin för kajfallen ligger söder om Kanalinfarten-punkten, > 500 m från
 * alla broar (fartgrinden 0,7 kn gäller), så målet kan bara hållas av
 * manöverskyddet. Köarfallet norr om punkten följer M6-sviten (1,1–1,2 km
 * söder om Klaffbron på dess longitud).
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { MOORING_DETECTION, TRIGGER_POINTS } = require('../lib/constants');

const M_PER_DEG_LAT = 111320;
const ENTRY_LAT = TRIGGER_POINTS.kanalinfarten.lat;
// Revision 2: gränsen ligger jitterradien norr om punktens latitud.
const RADIUS_M = MOORING_DETECTION.NULL_SOG_STILL_RADIUS_M;
// Kajområdet: 890 m söder om Kanalinfarten-punkten, väster om den.
const QUAY = { lat: ENTRY_LAT - 890 / M_PER_DEG_LAT, lon: 12.2680 };
// Köaren norr om punkten: M6-svitens läge söder om Klaffbron.
const KLAFF = { lat: 58.28409551543077, lon: 12.283929525245636 };

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

const liveServices = [];
let NOW = 0;
let nowSpy = null;

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

function loggedLines() {
  return [...logger.log.mock.calls, ...logger.debug.mock.calls].map((args) => String(args[0]));
}

/** Punkt dNorthM norr och dEastM öster om origo. */
function offset(origin, dNorthM, dEastM = 0) {
  return {
    lat: origin.lat + dNorthM / M_PER_DEG_LAT,
    lon: origin.lon + dEastM / (M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)),
  };
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

beforeEach(() => {
  NOW = 1794403000000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => NOW);
});

afterEach(() => {
  while (liveServices.length > 0) {
    const svc = liveServices.pop();
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  if (nowSpy) nowSpy.mockRestore();
  jest.clearAllMocks();
});

/** Ett AIS-sampel genom den riktiga rörledningen. sog undefined = meddelandet saknar fart. */
function step(svc, mmsi, pos, sog, cog, dt) {
  NOW += dt;
  logger.log.mockClear();
  logger.debug.mockClear();
  const data = {
    mmsi, ...pos, cog, name: 'K1-TEST', timestamp: NOW,
  };
  if (sog !== undefined) data.sog = sog;
  svc.updateVessel(mmsi, data);
  return { vessel: svc.vessels.get(mmsi), lines: loggedLines() };
}

const activated = (r) => r.lines.some((l) => l.includes('TARGET_PROTECTION_ACTIVATED'));

/** Norrgående insegling söder om punkten i 4 kn ⇒ målbro Klaffbron. Slutar 120 m norr om QUAY. */
function approachSouthOfEntry(svc, mmsi) {
  step(svc, mmsi, QUAY, 4.0, 0, 0);
  step(svc, mmsi, offset(QUAY, 60), 4.0, 0, 30000);
  return step(svc, mmsi, offset(QUAY, 120), 4.0, 0, 30000).vessel;
}

/** Svängen in mot kajen (60 m, verklig manöver) och första kajsamplet (fristen startar). */
function turnAndMoor(svc, mmsi) {
  const turn = step(svc, mmsi, offset(QUAY, 120, -60), 1.1, 255, 60000);
  const still1 = step(svc, mmsi, offset(QUAY, 121, -61), 0, 150, 65000);
  return { turn, still1 };
}

describe('k1 PRICKBJORN: söder om Kanalinfarten håller kursbrus och fartbrus vid kaj inte kvar målbron', () => {
  test('svängen skyddas, kursbruset vid kajen gör det inte — målet släpps efter fristen', () => {
    const svc = makeVDS();
    const mmsi = '211999701';
    expect(approachSouthOfEntry(svc, mmsi).targetBridge).toBe('Klaffbron');

    // Svängen: kurs 0° → 255°, 4 → 1,1 kn, 60 m. Verklig rörelse ⇒ skyddet SKA
    // aktiveras, som i fältet 13:25:58.
    const { turn, still1 } = turnAndMoor(svc, mmsi);
    expect(turn.lines.some((l) => l.includes('TARGET_PROTECTION_ACTIVATED') && l.includes('maneuver'))).toBe(true);

    // Kajen, 65 s senare: sog 0, kurs 255° → 150°, 1,4 m. Skyddet släpper,
    // FP9-H′ underkänner (ingen nordprogress) och fristen startar. Före
    // rättningen förlängde kurshoppet skyddet i stället.
    expect(still1.lines.some((l) => l.includes('TARGET_PROTECTION_DEACTIVATED'))).toBe(true);
    expect(still1.lines.some((l) => l.includes('Starting 60s grace period'))).toBe(true);

    // Nästa kajsampel: sog 0,1, kurs 150° → 290°, 1 m. Kursbruset får inte
    // återaktivera skyddet (fältet 13:28:15) ⇒ fristen har gått ut.
    const still2 = step(svc, mmsi, offset(QUAY, 121, -62), 0.1, 290, 65000);
    expect(activated(still2)).toBe(false);
    expect(still2.lines.some((l) => l.includes('"Klaffbron" → "none"'))).toBe(true);
    expect(still2.vessel.targetBridge).toBeNull();
  });

  test('M1: ett fartbrus på 2,5 kn vid kajen (1 m förflyttning) återaktiverar inte skyddet', () => {
    const svc = makeVDS();
    const mmsi = '211999702';
    approachSouthOfEntry(svc, mmsi);
    turnAndMoor(svc, mmsi);

    // Granskningens störning av fältet: 13:28:15-samplet med sog 2,5 i stället
    // för 0, förflyttningen kvar på någon meter. Både fartbenet (Δ 2,5 kn) och
    // kursbenet (kurs 150° → 290° i "2,5 kn") hade återaktiverat skyddet.
    const spike = step(svc, mmsi, offset(QUAY, 122, -61), 2.5, 290, 63000);
    expect(activated(spike)).toBe(false);
    expect(spike.vessel.targetBridge).toBeNull();
  });

  test('M2: ett sampel UTAN fart efter ett stillasampel räknas inte som stilla (rörledningen)', () => {
    const svc = makeVDS();
    const mmsi = '211999703';
    approachSouthOfEntry(svc, mmsi);
    // Inbromsning i två steg, utan fartsprång över 2 kn och utan förflyttning.
    step(svc, mmsi, offset(QUAY, 120), 2.2, 0, 30000);
    const still = step(svc, mmsi, offset(QUAY, 120), 0.25, 0, 30000);
    expect(still.vessel.sog).toBe(0.25);
    // Meddelandet saknar fart: _createVesselObject ärver 0,25 till vessel.sog,
    // men samplets egen fart är okänd. Kursen hoppar 170° och båten flyttar 10 m
    // — okänd fart är inte stillhet, så kursbenet ska räknas.
    const unknown = step(svc, mmsi, offset(QUAY, 130), undefined, 170, 30000);
    expect(unknown.vessel.sog).toBe(0.25); // ärvd
    expect(unknown.vessel._rawPositionSog).toBeNull();
    expect(activated(unknown)).toBe(true);
  });
});

describe('Revision 2: kajraden vid Kanalinfarten ligger på båda sidor om punktens latitud', () => {
  // Origo på punktens latitud, 80 m väster om punkten (kajraden ligger 125–170 m
  // väster om den, > 500 m från Olidebron, så fartgrinden 0,7 kn gäller).
  const LINE = { lat: ENTRY_LAT, lon: 12.2680 };

  /** Insegling norrut, sväng in mot kaj vid dNorthM, två kajsampel med kursbrus. */
  function quayAt(svc, mmsi, quayNorthM) {
    const s = quayNorthM;
    step(svc, mmsi, offset(LINE, s - 180), 4.0, 0, 0);
    step(svc, mmsi, offset(LINE, s - 120), 4.0, 0, 30000);
    const v = step(svc, mmsi, offset(LINE, s - 60), 4.0, 0, 30000).vessel;
    // Svängen: 78 m, verklig manöver.
    const turn = step(svc, mmsi, offset(LINE, s - 29, -50), 1.1, 255, 60000);
    // Kajen: 29 m från svängsamplet, sog 0, kurs 255° → 150°.
    const still1 = step(svc, mmsi, offset(LINE, s, -51), 0, 150, 65000);
    const still2 = step(svc, mmsi, offset(LINE, s + 1, -52), 0.1, 290, 65000);
    return {
      v, turn, still1, still2,
    };
  }

  test('kajplats 9 m norr om linjen (PRICKBJORN 12 nov): fältfelets signatur är borta', () => {
    const svc = makeVDS();
    const r = quayAt(svc, '211999705', 9);
    expect(r.v.targetBridge).toBe('Klaffbron');
    expect(activated(r.turn)).toBe(true);
    // Svängsamplet ligger söder om linjen, kajsamplen norr om den — båda inom
    // gränsen. Kursbruset förlänger inte skyddet och återaktiverar det inte.
    expect(r.still1.vessel.lat).toBeGreaterThan(ENTRY_LAT);
    expect(r.still1.lines.some((l) => l.includes('TARGET_PROTECTION_DEACTIVATED'))).toBe(true);
    expect(activated(r.still2)).toBe(false);
    expect(r.still2.vessel.targetBridge).toBeNull();
  });

  test('MOTFALL: kajplats strax utanför den vidgade gränsen — som på basen', () => {
    const svc = makeVDS();
    // Hela förloppet norr om +40 m: svängen vid +51 m, kajen vid +80 m.
    const r = quayAt(svc, '211999706', 80);
    expect(r.turn.vessel.lat).toBeGreaterThan(ENTRY_LAT + RADIUS_M / M_PER_DEG_LAT);
    expect(activated(r.turn)).toBe(true);
    // Basens beteende: kursbruset förlänger skyddet, målet står kvar.
    expect(r.still1.lines.some((l) => l.includes('TARGET_PROTECTION_DEACTIVATED'))).toBe(false);
    expect(r.still2.vessel.targetBridge).toBe('Klaffbron');
  });
});

describe('H1: norr om Kanalinfarten håller kursbruset kvar en stilla köare utanför kö-zonen', () => {
  test('köare 1,1 km söder om Klaffbron, sog 0,1 och kurshopp på stället ⇒ skyddet aktiveras', () => {
    const svc = makeVDS();
    const mmsi = '211999704';
    const at = (dSouthM) => offset(KLAFF, -dSouthM);
    step(svc, mmsi, at(1200), 4.0, 30, 0);
    step(svc, mmsi, at(1140), 4.0, 30, 30000);
    const v = step(svc, mmsi, at(1080), 4.0, 30, 30000).vessel;
    expect(v.lat).toBeGreaterThan(ENTRY_LAT);
    expect(v.targetBridge).toBe('Klaffbron');
    // Stannar upp i två steg utan fartsprång över 2 kn (ingen manöver) ⇒
    // fristen startar.
    step(svc, mmsi, at(1080), 2.2, 30, 30000);
    step(svc, mmsi, at(1080), 0.25, 30, 30000);
    // Class B vid stillhet: 0,1 kn och kursen hoppar 140° på stället (Δsog
    // 0,15, så bara kursbenet kan slå till). Utanför kö-zonen (600 m) och
    // broarnas 300 m är det här det enda som håller målet.
    const queue = step(svc, mmsi, at(1081), 0.1, 170, 30000);
    expect(activated(queue)).toBe(true);
    expect(queue.vessel.targetBridge).toBe('Klaffbron');
  });
});

describe('_detectManeuverProtection: gränserna', () => {
  const south = offset(QUAY, 0);
  const north = offset(KLAFF, -1100);
  /** Sampelpar: förra fixen i origo, nya fixen dNorthM norrut. rawSog undefined ⇒ samma som sog. */
  const pair = (origin, {
    dNorthM, sogOld, sogNew, rawSog, cogOld = 30, cogNew,
  }) => [
    {
      ...offset(origin, dNorthM), sog: sogNew, cog: cogNew, _rawPositionSog: rawSog === undefined ? sogNew : rawSog,
    },
    {
      ...origin, sog: sogOld, cog: cogOld, _rawPositionSog: sogOld,
    },
  ];
  const detect = (origin, p) => makeVDS()._detectManeuverProtection(...pair(origin, p));

  test('söder om punkten, stilla enligt båda måtten: kurshopp är ingen manöver', () => {
    expect(detect(south, {
      dNorthM: 2.5, sogOld: 0.4, sogNew: 0, cogNew: 170,
    })).toBe(false);
    expect(detect(south, {
      dNorthM: MOORING_DETECTION.NULL_SOG_STILL_RADIUS_M - 1,
      sogOld: 0,
      sogNew: MOORING_DETECTION.STATIONARY_SOG_KN - 0.01,
      cogNew: 170,
    })).toBe(false);
  });

  test('söder om punkten, verklig rörelse: gråzonsfart, ≥ 40 m eller okänd fart räknas', () => {
    expect(detect(south, {
      dNorthM: 2, sogOld: 0, sogNew: MOORING_DETECTION.STATIONARY_SOG_KN, cogNew: 170,
    })).toBe(true);
    expect(detect(south, {
      dNorthM: MOORING_DETECTION.NULL_SOG_STILL_RADIUS_M + 0.5, sogOld: 0, sogNew: 0, cogNew: 90,
    })).toBe(true);
    // Okänd fart: vessel.sog är ärvd (0), samplets egen fart saknas.
    expect(detect(south, {
      dNorthM: 1, sogOld: 0, sogNew: 0, rawSog: null, cogNew: 170,
    })).toBe(true);
  });

  test('M1 söder om punkten: fartsprång > 2 kn utan 40 m förflyttning räknas inte, med förflyttning gör det', () => {
    // Fartbrus vid kaj (PRICKBJORN 13:28:15 störd till 2,5 kn): båda benen.
    expect(detect(south, {
      dNorthM: 2.5, sogOld: 0.4, sogNew: 2.5, cogOld: 152, cogNew: 292,
    })).toBe(false);
    // Fartbrus ut ur spiken (2,5 → 0,1).
    expect(detect(south, {
      dNorthM: 1.3, sogOld: 2.5, sogNew: 0.1, cogNew: 30,
    })).toBe(false);
    // Verklig acceleration från kajen med bevisad förflyttning (≥ 40 m) räknas.
    expect(detect(south, {
      dNorthM: 60, sogOld: 0, sogNew: 3.5, cogNew: 30,
    })).toBe(true);
  });

  test('söder om punkten berörs inte en verklig sväng i fart (PILOT 761 10:16:31, ägarfråga)', () => {
    expect(detect(south, {
      dNorthM: 22, sogOld: 4.5, sogNew: 3.9, cogOld: 17.7, cogNew: 319.7,
    })).toBe(true);
  });

  test('norr om punkten är allt som förut: köarens kursbrus och fartsprång räknas', () => {
    expect(detect(north, {
      dNorthM: 2.5, sogOld: 0.4, sogNew: 0, cogNew: 170,
    })).toBe(true);
    expect(detect(north, {
      dNorthM: 2.5, sogOld: 0.4, sogNew: 2.5, cogNew: 30,
    })).toBe(true);
  });

  test('revision 2: gränsen ligger 40 m norr om punktens latitud (kajraden vid Kanalinfarten)', () => {
    // 9 m norr om linjen (PRICKBJORNs kajplats 12 nov) och 2 m (CAPELLA) räknas
    // som söder om gränsen: kursbruset är ingen manöver.
    for (const dM of [2, 9, RADIUS_M - 3]) {
      expect(detect({ lat: ENTRY_LAT + dM / M_PER_DEG_LAT, lon: 12.2680 }, {
        dNorthM: 1, sogOld: 0, sogNew: 0, cogNew: 170,
      })).toBe(false);
    }
    // Fixpar som går över punktens latitud men ligger inom 40 m: söder om gränsen.
    expect(detect({ lat: ENTRY_LAT - 1 / M_PER_DEG_LAT, lon: 12.2680 }, {
      dNorthM: 2, sogOld: 0, sogNew: 0, cogNew: 170,
    })).toBe(false);
  });

  test('ett fixpar som går över den vidgade gränsen räknas som norr om den (FP9-H′ kräver båda fixarna)', () => {
    const straddle = { lat: ENTRY_LAT + (RADIUS_M - 1) / M_PER_DEG_LAT, lon: 12.2680 };
    expect(detect(straddle, {
      dNorthM: 2, sogOld: 0, sogNew: 0, cogNew: 170,
    })).toBe(true);
    // Helt norr om gränsen: som på basen.
    expect(detect({ lat: ENTRY_LAT + (RADIUS_M + 1) / M_PER_DEG_LAT, lon: 12.2680 }, {
      dNorthM: 1, sogOld: 0, sogNew: 0, cogNew: 170,
    })).toBe(true);
  });

  test('små kursändringar och små fartändringar är ingen manöver, oavsett område', () => {
    expect(detect(south, {
      dNorthM: 60, sogOld: 4, sogNew: 4, cogNew: 70,
    })).toBe(false);
    expect(detect(north, {
      dNorthM: 60, sogOld: 4, sogNew: 2.2, cogNew: 70,
    })).toBe(false);
  });
});
