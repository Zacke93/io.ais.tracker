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
const { MOORING_ZONES, MOORING_DETECTION, BRIDGE_OPENING } = require('../lib/constants');

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

    // Förtöjer vid kajen (stationär i zonen). Körning 2026-07-02 (ELFKUNGEN):
    // zonlagret kräver nu stillhetsTID — 15 min för båt med target inom
    // 600 m — så en KÖARE som pausar vid kajen inför broöppning inte
    // demoteras. Kort paus (≤9 min) ska alltså INTE klassa som förtöjd:
    for (let i = 0; i < 3; i++) {
      vessel = svc.updateVessel('265000003', {
        lat: QUAY.lat, lon: QUAY.lon, sog: 0.1, cog: 30, name: 'TEST',
      });
      tick(3);
    }
    expect(vessel._moored).toBe(false); // kö-skyddad (6 min stillhet < 15 min)
    expect(vessel.targetBridge).toBe('Klaffbron');

    // ...men en äkta förtöjning (≥15 min still i zonen) demoteras:
    for (let i = 0; i < 4; i++) {
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

  test('Belagd brokö med färska positioner har ingen tvåtimmarsgräns', () => {
    sailInSouthbound('265000005');

    let vessel;
    for (let i = 0; i < 45; i++) { // 45 × 3 min = 135 min > 2h
      vessel = svc.updateVessel('265000005', {
        lat: FAIRWAY_HOLD.lat, lon: FAIRWAY_HOLD.lon, sog: 0.1, cog: 205, name: 'TEST',
      });
      tick(3);
    }
    expect(vessel._moored).toBe(false);
    expect(vessel.targetBridge).toBe('Klaffbron');
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

// =============================================================================
// C9b (C0-förarbetet 2026-08-10, FG-C9b): JITTERTÅLIG STILLHETSKLOCKA
// =============================================================================
// Före C9b nollades `_stationarySince` av ETT sog-sampel ≥ MOVEMENT_PROOF_SOG_KN
// (0,5 kn). Kajvobbel överskrider det: VIRGO (265552100) i korpus
// 20260710-015254 låg 07:06:57–11:03:53 UTC i ett kajkluster kring
// 58,31290/12,31903 med max 3,9 m nettoförflyttning, men sände 0,5 kn kl.
// 09:35:10 — klockan nollades och varken zonlagret, 2h-backstopen eller
// C9-disarmen nådde sina grindar. C9b mäter i stället rörelse som NETTO-
// FÖRFLYTTNING ÖVER ETT FÖNSTER från ett ankare som sätts när klockan startar.
const VIRGO_MMSI = '265552100';

// RÅDATA, ordagrant ur tests/replay-validation/corpora-data/
// ais-replay-20260710-015254.jsonl (fälten receivedAt/lat/lon/sog).
// KAJKLUSTRET: samtliga VIRGO-sampel i fönstret 07:06–11:24 UTC som ligger i
// klustret 58,31290/12,31903. Filen innehåller DESSUTOM en verklig utflykt
// 07:54:51–09:29:59 (318–365 m norrut, sog upp till 6,8 kn) — den är medvetet
// utelämnad här och testas separat nedan, eftersom den är ÄKTA rörelse som
// klockan SKA släppa på. Utan den utflykten är detta VIRGOs sammanhängande
// kajvistelse, och det är den vistelsen buggen gällde.
const VIRGO_QUAY_SAMPLES = [
  {
    iso: '2026-07-10T07:06:57.463Z', lat: 58.312900, lon: 12.319038, sog: 0,
  },
  {
    iso: '2026-07-10T07:09:58.226Z', lat: 58.312898, lon: 12.319030, sog: 0,
  },
  {
    iso: '2026-07-10T07:15:57.785Z', lat: 58.312910, lon: 12.318990, sog: 0,
  },
  {
    iso: '2026-07-10T07:24:57.963Z', lat: 58.312903, lon: 12.319025, sog: 0,
  },
  // KAJVOBBELSPIKEN: 0,5 kn = exakt MOVEMENT_PROOF_SOG_KN, 3,9 m från ankaret.
  {
    iso: '2026-07-10T09:35:10.567Z', lat: 58.312900, lon: 12.319105, sog: 0.5,
  },
  {
    iso: '2026-07-10T10:00:53.927Z', lat: 58.312905, lon: 12.319085, sog: 0,
  },
  {
    iso: '2026-07-10T10:06:54.185Z', lat: 58.312905, lon: 12.319078, sog: 0,
  },
  {
    iso: '2026-07-10T10:27:52.732Z', lat: 58.312908, lon: 12.319077, sog: 0,
  },
  {
    iso: '2026-07-10T10:39:54.175Z', lat: 58.312902, lon: 12.319087, sog: 0,
  },
  {
    iso: '2026-07-10T10:42:52.867Z', lat: 58.312903, lon: 12.319082, sog: 0,
  },
  {
    iso: '2026-07-10T10:48:53.796Z', lat: 58.312902, lon: 12.319083, sog: 0,
  },
  {
    iso: '2026-07-10T11:00:54.443Z', lat: 58.312912, lon: 12.319087, sog: 0,
  },
  {
    iso: '2026-07-10T11:03:53.355Z', lat: 58.312908, lon: 12.319088, sog: 0,
  },
];

// AVGÅNGEN (samma fil, samma fartyg): 11:24 ligger 29,9 m från ankaret (still-
// sampel, klockan ska hålla), 11:26 ligger 65,0 m ut och 11:29 277,8 m ut.
const VIRGO_DEPARTURE_SAMPLES = [
  {
    iso: '2026-07-10T11:24:53.970Z', lat: 58.312678, lon: 12.318748, sog: 0,
  },
  {
    iso: '2026-07-10T11:26:11.965Z', lat: 58.313458, lon: 12.318708, sog: 2.9,
  },
  {
    iso: '2026-07-10T11:29:26.203Z', lat: 58.315358, lon: 12.318188, sog: 7.6,
  },
];

// UTFLYKTEN (samma fil): första samplet efter kajklustrets fyra första —
// 325,8 m från ankaret. Äkta rörelse ⇒ klockan MÅSTE släppa.
const VIRGO_EXCURSION_SAMPLE = {
  iso: '2026-07-10T07:54:51.005Z', lat: 58.315747, lon: 12.317717, sog: 1.3,
};

// KAJVOBBELN FÖRE VISTELSEN (samma fil): klockan startar 06:34:00, och 06:41:53
// kommer en 2,9 kn-spik när ankaret är 7,9 min gammalt OCH båten netto flyttat
// 58,8 m. Båda C9b-villkoren pekar åt samma håll: släpp.
const VIRGO_EARLY_WOBBLE = [
  {
    iso: '2026-07-10T06:34:00.911Z', lat: 58.313450, lon: 12.318903, sog: 0,
  },
  {
    iso: '2026-07-10T06:40:00.799Z', lat: 58.313087, lon: 12.318905, sog: 0,
  },
  {
    iso: '2026-07-10T06:41:53.306Z', lat: 58.312922, lon: 12.318867, sog: 2.9,
  },
];

describe('C9b: jittertålig stillhetsklocka (nettoförflyttning över fönster)', () => {
  let svc;
  let mockNow;
  const realDateNow = Date.now;
  const logger = {
    debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Lättviktsrigg (samma mönster som helkodsgranskning-2026-07.test.js):
    // _updateMooringEvidence körs direkt, utan timers och utan updateVessel-
    // pipeline, så att RÅDATANS sog-fält går orört in i klockan.
    svc = Object.create(VesselDataService.prototype);
    svc.logger = logger;
    svc.bridgeRegistry = new BridgeRegistry();
    mockNow = Date.parse('2026-07-10T07:00:00.000Z');
    Date.now = () => mockNow;
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  function makeVessel(first) {
    return {
      mmsi: VIRGO_MMSI,
      lat: first.lat,
      lon: first.lon,
      sog: first.sog,
      navStatus: null,
      _moored: false,
      _stationarySince: null,
      _stillnessAnchor: null,
      _mooredReleasePending: 0,
      // VIRGO kom seglande in i korpusen (4,5–7,4 kn) — beviset är redan
      // klistrat, så rörelsebevisblocken är inte det som testas här.
      _hasMovementProof: true,
      _hasCorroboratedMovement: true,
      _plausibleMovementSeen: true,
      _firstSeenLat: 58.268382,
      _firstSeenLon: 12.269893,
    };
  }

  function feed(vessel, sample) {
    mockNow = Date.parse(sample.iso);
    vessel.lat = sample.lat;
    vessel.lon = sample.lon;
    vessel.sog = sample.sog;
    svc._updateMooringEvidence(vessel, sample.sog);
    return vessel;
  }

  test('A1.2 FIXTURDATA: kajklustrets nettoförflyttning är ≤6 m (rådataverifiering)', () => {
    const a = VIRGO_QUAY_SAMPLES[0];
    const nets = VIRGO_QUAY_SAMPLES.map(
      (s) => geometry.calculateDistance(a.lat, a.lon, s.lat, s.lon),
    );
    expect(Math.max(...nets)).toBeLessThanOrEqual(6);
    // ...och spiken är exakt tröskelvärdet, inte något över det.
    expect(VIRGO_QUAY_SAMPLES.filter((s) => s.sog >= MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN))
      .toHaveLength(1);
  });

  test('A1.2 VIRGO: 0,5-spiken mitt i kajvistelsen nollar INTE klockan (≥2 h vid slutet)', () => {
    const vessel = makeVessel(VIRGO_QUAY_SAMPLES[0]);
    feed(vessel, VIRGO_QUAY_SAMPLES[0]);
    const clockStart = vessel._stationarySince;
    expect(clockStart).toBe(Date.parse(VIRGO_QUAY_SAMPLES[0].iso));
    expect(vessel._stillnessAnchor).toEqual({
      lat: VIRGO_QUAY_SAMPLES[0].lat, lon: VIRGO_QUAY_SAMPLES[0].lon, t: clockStart,
    });

    for (const s of VIRGO_QUAY_SAMPLES.slice(1)) {
      feed(vessel, s);
      // Klockan får ALDRIG nollas under vistelsen — och den får inte heller
      // startas om (samma startvärde hela vägen).
      expect(vessel._stationarySince).toBe(clockStart);
      // Stillasampel flyttar INTE ankaret (annars kryper vobbeln med).
      expect(vessel._stillnessAnchor.t).toBe(clockStart);
    }

    const stillMs = Date.now() - vessel._stationarySince;
    expect(stillMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
    expect(Math.round(stillMs / 60000)).toBe(237); // 3 h 57 min
    // Med klockan i gång når 2h-backstopen sin grind — det var precis det som
    // var omöjligt före C9b.
    expect(vessel._moored).toBe(true);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('[STILLNESS_JITTER_HELD]'));
    const held = logger.debug.mock.calls
      .map((c) => c[0]).find((m) => m.includes('[STILLNESS_JITTER_HELD]'));
    expect(held).toMatch(/netto 3\.9 m/); // nettot står i raden
    expect(held).toMatch(/ankare 148 min gammalt/); // ankaråldern står i raden
  });

  test('A1.2b UTFLYKTEN: äkta 326 m-förflyttning släpper klockan direkt', () => {
    const vessel = makeVessel(VIRGO_QUAY_SAMPLES[0]);
    for (const s of VIRGO_QUAY_SAMPLES.slice(0, 4)) feed(vessel, s);
    expect(vessel._stationarySince).not.toBeNull();

    feed(vessel, VIRGO_EXCURSION_SAMPLE); // 325,8 m ⇒ över MOVEMENT_PROOF_NET_M
    expect(vessel._stationarySince).toBeNull();
    expect(vessel._stillnessAnchor).toBeNull();
  });

  test('A1.3 AVGÅNGEN: klockan nollad på FÖRSTA rörelsesamplet (11:26, 65 m)', () => {
    const vessel = makeVessel(VIRGO_QUAY_SAMPLES[0]);
    for (const s of VIRGO_QUAY_SAMPLES) feed(vessel, s);
    expect(vessel._stationarySince).not.toBeNull();

    // 11:24:53 — sog 0, 29,9 m från ankaret: stillasampel, klockan står kvar
    // och ankaret ligger still (får INTE flyttas fram till avgångspositionen).
    feed(vessel, VIRGO_DEPARTURE_SAMPLES[0]);
    expect(vessel._stationarySince).not.toBeNull();
    expect(vessel._stillnessAnchor.lat).toBe(VIRGO_QUAY_SAMPLES[0].lat);

    // 11:26:11 — sog 2,9 och 65,0 m netto ⇒ släpp OMEDELBART (första
    // rörelsesamplet, alltså med marginal före kravet "senast på det andra").
    feed(vessel, VIRGO_DEPARTURE_SAMPLES[1]);
    expect(vessel._stationarySince).toBeNull();
    expect(vessel._stillnessAnchor).toBeNull();
    expect(vessel._moored).toBe(false);

    feed(vessel, VIRGO_DEPARTURE_SAMPLES[2]);
    expect(vessel._stationarySince).toBeNull();
  });

  test('A1.5 RANDFALL: spik inom fönstrets första 30 min nollar precis som förr', () => {
    // Syntetiskt men minimalt: kajklustrets position, klockan startar, och en
    // 2,1 kn-spik 10 min senare med bara 5 m netto. Nettot är alltså LITET —
    // det enda som skiljer är ankaråldern (10 min < ARM_STALE_TTL_MS).
    const base = {
      iso: '2026-07-10T12:00:00.000Z', lat: 58.312900, lon: 12.319038, sog: 0,
    };
    const vessel = makeVessel(base);
    feed(vessel, base);
    expect(vessel._stationarySince).not.toBeNull();

    const spike = {
      iso: '2026-07-10T12:10:00.000Z',
      lat: base.lat + 5 / 111320,
      lon: base.lon,
      sog: 2.1,
    };
    feed(vessel, spike);
    expect(vessel._stationarySince).toBeNull(); // (b): ungt ankare ⇒ som i dag
    // M1 (RUNDA 4, 2026-08-23) — ENDA ÄNDRADE RADEN I DEN HÄR SVITEN, och den
    // låste det FELAKTIGA beteendet: raden krävde att ankaret nollades TILLSAMMANS
    // med klockan. Just den kopplingen ÄR fyndet — ankarets ålder blev då per
    // konstruktion identisk med klockans, och C9b:s 30-minutersvillkor kunde
    // aldrig uppfyllas av en båt vars givare brusar oftare än så (CARAT-klassen).
    // KLOCKANS beteende (raden ovan) är oförändrat och testets namn gäller
    // fortfarande. ANKARET ska däremot överleva: nettot är 5 m, alltså långt
    // under MOVEMENT_PROOF_NET_M, och provet är inte GPS-flaggat — ingen av de
    // två invalideringsgrunderna föreligger. Se _stillnessAnchorInvalidated().
    expect(vessel._stillnessAnchor).toEqual({ lat: base.lat, lon: base.lon, t: Date.parse(base.iso) });
  });

  test('A1.5b SPEGELN: samma spik EFTER 30 min håller klockan', () => {
    const base = {
      iso: '2026-07-10T12:00:00.000Z', lat: 58.312900, lon: 12.319038, sog: 0,
    };
    const vessel = makeVessel(base);
    feed(vessel, base);
    const clockStart = vessel._stationarySince;

    const spike = {
      iso: new Date(Date.parse(base.iso) + BRIDGE_OPENING.ARM_STALE_TTL_MS + 1000).toISOString(),
      lat: base.lat + 5 / 111320,
      lon: base.lon,
      sog: 2.1,
    };
    feed(vessel, spike);
    expect(vessel._stationarySince).toBe(clockStart);
    expect(vessel._stillnessAnchor.t).toBe(clockStart);
  });

  test('A1.5c RÅDATA-RANDFALL: VIRGOs 2,9-spik 06:41 (7,9 min ankare, 58,8 m) släpper', () => {
    const vessel = makeVessel(VIRGO_EARLY_WOBBLE[0]);
    feed(vessel, VIRGO_EARLY_WOBBLE[0]);
    feed(vessel, VIRGO_EARLY_WOBBLE[1]);
    expect(vessel._stationarySince).toBe(Date.parse(VIRGO_EARLY_WOBBLE[0].iso));
    feed(vessel, VIRGO_EARLY_WOBBLE[2]);
    expect(vessel._stationarySince).toBeNull();
  });

  // ── GRÅZONEN 0,3–0,49 kn — OMLÅST AV N7 (helkodsgranskning RUNDA 5, 2026-08-23)
  //
  // HÄR STOD ETT TEST: 'GRÅZONEN OFÖRÄNDRAD: två konsekutiva 0,4-prov släpper
  // även med gammalt ankare'. Dess sista rad löd
  //   expect(vessel._stationarySince).toBeNull(); // två i rad = oförändrad hysteres
  // efter ett par 0,4-prov på ett 60 min gammalt ankare, och namnet
  // ("OFÖRÄNDRAD") låste RUNDA 4:s medvetna avgränsning: M1 grindade BARA
  // grenen sog ≥ MOVEMENT_PROOF_SOG_KN och lät gråzonen vara.
  //
  // VARFÖR RADEN FALLER. Avgränsningen var BAKVÄND, inte neutral: ett SVAGARE
  // rörelseindicium (0,3–0,49 kn) släppte en etablerad kajliggare som ett
  // STARKARE (≥ 0,5 kn) höll kvar. N7 ger grenen samma prövning som
  // grannargrenen — _stillnessJitterHolds — så samma tre villkor (moget ankare
  // ≥ ARM_STALE_TTL_MS, ren position, netto < MOVEMENT_PROOF_NET_M) avgör i
  // BÅDA grenarna. Ingen ny konstant, ingen ny tröskel.
  //
  // VAD SOM INTE FALLER — och därför fortfarande låses, nu i två tester:
  //  • Tvåsamplingshysteresen: ETT gråzonsprov räcker aldrig (_mooredReleasePending).
  //  • UNGT ankare (< 30 min): släpper precis som förr. Det är den HALVA av den
  //    gamla assertionen som fortfarande är sann, och den har fått eget test.
  //  • Netto ≥ 50 m: släpper även på ett moget ankare (villkor 3 i hållet).
  //  • Gråzonen skriver ALDRIG ankaret (låses i m1-ihallande-stillhetsankare).
  // Fixens egen svit: n7-grazonens-jitterhall.test.js.

  test('GRÅZONEN, UNGT ANKARE: två konsekutiva 0,4-prov släpper precis som förr', () => {
    const base = {
      iso: '2026-07-10T12:00:00.000Z', lat: 58.312900, lon: 12.319038, sog: 0,
    };
    const vessel = makeVessel(base);
    feed(vessel, base);
    // 10 resp. 15 min ⇒ ankaret är YNGRE än BRIDGE_OPENING.ARM_STALE_TTL_MS
    // (30 min), så villkor (2) i jitterhållet faller och grenen beter sig
    // exakt som före N7. Detta är den bevarade halvan av det gamla testet.
    const grey = (offsetMin) => ({
      iso: new Date(Date.parse(base.iso) + offsetMin * 60000).toISOString(),
      lat: base.lat,
      lon: base.lon,
      sog: 0.4,
    });
    feed(vessel, grey(10));
    expect(vessel._stationarySince).not.toBeNull(); // ett prov räcker inte
    feed(vessel, grey(15));
    expect(vessel._stationarySince).toBeNull(); // två i rad = oförändrad hysteres
    // Släppet rör inte ankaret — bara klockan (M1:s arbetsdelning).
    expect(vessel._stillnessAnchor)
      .toEqual({ lat: base.lat, lon: base.lon, t: Date.parse(base.iso) });
  });

  test('GRÅZONEN, MOGET ANKARE: jitterhållet håller klockan (N7) — men bara utan netto', () => {
    const base = {
      iso: '2026-07-10T12:00:00.000Z', lat: 58.312900, lon: 12.319038, sog: 0,
    };
    const grey = (offsetMin, latOffsetM = 0) => ({
      iso: new Date(Date.parse(base.iso) + offsetMin * 60000).toISOString(),
      lat: base.lat + latOffsetM / 111320,
      lon: base.lon,
      sog: 0.4,
    });

    // (a) OMLÅSNINGEN: moget ankare (60 min) + noll netto ⇒ klockan BEHÅLLS.
    // Före N7 nollades den här, trots att ett STARKARE 0,5-prov på samma
    // ankare hölls av C9b/M1.
    const held = makeVessel(base);
    feed(held, base);
    const clockStart = held._stationarySince;
    feed(held, grey(60));
    expect(held._stationarySince).toBe(clockStart); // ett prov räcker inte
    feed(held, grey(65));
    expect(held._stationarySince).toBe(clockStart); // ⇐ omlåst rad (var toBeNull)
    expect(held._stillnessAnchor).toEqual({ lat: base.lat, lon: base.lon, t: clockStart });
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('[STILLNESS_JITTER_HELD]'));

    // (b) HYSTERESEN OCH VILLKOR (3) ÄR ORÖRDA: samma par prov, men med
    // nettoförflyttning över MOVEMENT_PROOF_NET_M, släpper som förut — även
    // med moget ankare. N7 gör alltså gråzonen jittertålig, inte blind.
    const released = makeVessel(base);
    feed(released, base);
    feed(released, grey(60, 25));
    expect(released._stationarySince).not.toBeNull();
    feed(released, grey(65, 65));
    expect(released._stationarySince).toBeNull();
  });

  test('GPS-FLAGGAT sampel får aldrig motivera ett håll (S-F5-riktningen)', () => {
    const base = {
      iso: '2026-07-10T12:00:00.000Z', lat: 58.312900, lon: 12.319038, sog: 0,
    };
    const vessel = makeVessel(base);
    feed(vessel, base);
    vessel._gpsJumpDetected = true;
    feed(vessel, {
      iso: '2026-07-10T13:00:00.000Z', lat: base.lat, lon: base.lon, sog: 2.1,
    });
    expect(vessel._stationarySince).toBeNull();
  });

  test('RÖRELSEBEVISEN ORÖRDA: ett håll skapar varken proof eller korroborering', () => {
    const base = {
      iso: '2026-07-10T12:00:00.000Z', lat: 58.312900, lon: 12.319038, sog: 0,
    };
    const vessel = makeVessel(base);
    vessel._hasMovementProof = false;
    vessel._hasCorroboratedMovement = false;
    vessel._plausibleMovementSeen = false;
    vessel._firstSeenLat = base.lat;
    vessel._firstSeenLon = base.lon;
    feed(vessel, base);
    feed(vessel, {
      iso: '2026-07-10T13:00:00.000Z', lat: base.lat, lon: base.lon, sog: 2.1,
    });
    // C9b rör inte rörelsebeviskedjan: spiken ger proof/plausible precis som
    // före ändringen, och klockan hålls ändå.
    expect(vessel._hasMovementProof).toBe(true);
    expect(vessel._plausibleMovementSeen).toBe(true);
    expect(vessel._stationarySince).not.toBeNull();
  });

  test('NULL-SOG-VÄGEN sätter samma fönsterankare (klockans ärliga start)', () => {
    const base = { lat: 58.312900, lon: 12.319038 };
    const vessel = makeVessel({ ...base, sog: null });
    mockNow = Date.parse('2026-07-10T12:00:00.000Z');
    vessel.sog = null;
    svc._updateMooringEvidence(vessel, null); // första provet: bara ankare
    expect(vessel._stationarySince).toBeNull();
    const nullAnchor = { ...vessel._nullSogStillAnchor };

    mockNow += 20 * 60 * 1000;
    svc._updateMooringEvidence(vessel, null); // inom jitterradien ⇒ klockan går
    expect(vessel._stationarySince).toBe(nullAnchor.t);
    expect(vessel._stillnessAnchor).toEqual(nullAnchor);
    expect(vessel._stillnessAnchor).not.toBe(vessel._nullSogStillAnchor); // kopia
  });
});

describe('C9b: väntarskyddet håller (jittrig äkta väntare 254 m från Klaffbron)', () => {
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
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
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

  test('A1.4: 115 min stilla med sog-spikar 0,6 och 2,2 ⇒ EJ förtöjd, målbron kvar', () => {
    // Väntpositionen ligger 254,2 m från Klaffbron, utanför alla kajzoner.
    // Seglar in söderut så målbron tilldelas legitimt.
    for (const p of [
      { lat: 58.28950, lon: 12.28950 },
      { lat: 58.28820, lon: 12.28800 },
      { lat: 58.28700, lon: 12.28700 },
    ]) {
      svc.updateVessel('265000101', {
        lat: p.lat, lon: p.lon, sog: 4.5, cog: 205, name: 'VÄNTARE',
      });
      mockNow += 60 * 1000;
    }
    expect(svc.getVessel('265000101').targetBridge).toBe('Klaffbron');

    // 24 sampel × 5 min = 115 min. Spikarna ligger MEDVETET efter fönstrets
    // 30 min (40 resp. 80 min) — det är där C9b faktiskt håller klockan, och
    // det är alltså det enda läget där väntaren kan hinna nå 2h-backstopen.
    let vessel;
    for (let i = 0; i < 24; i++) {
      let sog = 0.1;
      if (i === 8) sog = 0.6;
      if (i === 16) sog = 2.2;
      if (i === 23) sog = 0.0;
      vessel = svc.updateVessel('265000101', {
        // <10 m nettojitter kring väntpositionen
        lat: FAIRWAY_HOLD.lat + (i % 2 === 0 ? 0.00004 : -0.00004),
        lon: FAIRWAY_HOLD.lon,
        sog,
        cog: 205,
        name: 'VÄNTARE',
      });
      if (i < 23) mockNow += 5 * 60 * 1000;
    }

    // C9b:s faktiska verkan: klockan överlevde BÅDA spikarna...
    expect(Math.round((Date.now() - vessel._stationarySince) / 60000)).toBe(115);
    // ...men ren stillhet demoterar aldrig under 2h-backstopen.
    expect(vessel._moored).toBe(false);
    expect(vessel.targetBridge).toBe('Klaffbron');
  });

  test('Belagd väntare med positionsjitter behåller bron även bortom två timmar', () => {
    for (const p of [
      { lat: 58.28950, lon: 12.28950 },
      { lat: 58.28820, lon: 12.28800 },
      { lat: 58.28700, lon: 12.28700 },
    ]) {
      svc.updateVessel('265000102', {
        lat: p.lat, lon: p.lon, sog: 4.5, cog: 205, name: 'VÄNTARE2',
      });
      mockNow += 60 * 1000;
    }
    let vessel;
    for (let i = 0; i < 30; i++) { // 145 min
      vessel = svc.updateVessel('265000102', {
        lat: FAIRWAY_HOLD.lat + (i % 2 === 0 ? 0.00004 : -0.00004),
        lon: FAIRWAY_HOLD.lon,
        sog: i === 8 ? 0.6 : 0.1,
        cog: 205,
        name: 'VÄNTARE2',
      });
      mockNow += 5 * 60 * 1000;
    }
    expect(vessel._moored).toBe(false); // riktig kö, fortfarande färsk
    expect(vessel.targetBridge).toBe('Klaffbron');
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
