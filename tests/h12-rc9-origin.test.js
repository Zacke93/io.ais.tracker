'use strict';

/**
 * H12 (helkodsgranskningen 2026-08-22) — RC9-origin-vakten mätte
 * SPÅRNINGSEPISOD i stället för RESA.
 *
 * MEKANISMEN. _targetOriginSideOk (och Järnvägsbro-backfillens S-F6-villkor)
 * prövar premissen "RESAN började på anflygningssidan av målbron". Båda läste
 * _firstSeenLat, som är ett EPISODANKARE: det skrivs en gång per spårnings-
 * episod (fältlistan i _createVesselObject + gravarvet) och nollställs ALDRIG
 * — varken av NEW_JOURNEY, _confirmDirectionReversal eller journey-reset. På
 * RETURBENET (kajvändning i MOORING_ZONES norr om Klaffbron, eller U-sväng i
 * samma episod) pekade ankaret därför på UTRESANS startpunkt, på fel sida av
 * den nya resans målbro. Följden: MISSED_TARGET_ORIGIN_SKIP +
 * STALE_TARGET_CLEARED i stället för MISSED_TARGET_INFERRED — tomt
 * _passageBackfills och målbron aldrig bokförd.
 *
 * FIXEN. _journeyStartLat ankras om vid varje resestart som VesselDataService
 * äger (ny måltilldelning NEW/ACCELERATED samt bekräftad riktningsreversal),
 * och vakterna läser _journeyOriginLat() med _firstSeenLat som fallback.
 * AKIRA-skyddet (SOAK-RESA-18) bevaras: en U-svängd båt med stale målbro har
 * sitt reseankare på SAMMA fel sida och underkänns fortfarande.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

// lib/constants.js BRIDGES — kanalen är strikt latitudordnad syd→nord.
const OLIDEBRON_LAT = 58.272743083145855;
const KLAFFBRON_LAT = 58.28409551543077;
const JARNVAGSBRON_LAT = 58.29164042152742;
const STRIDSBERGSBRON_LAT = 58.293524096154634;
// "Kajen norr om Klaffbron" (MOORING_ZONES) ligger 58.2857–58.2864, dvs.
// NORR om Klaffbron men SÖDER om Järnvägsbron — precis den kajvändarklass
// vars returben dog i origin-vakten.
const KAJ_LAT = 58.2860;

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

const liveServices = [];

function makeVDS() {
  const bridgeRegistry = new BridgeRegistry();
  const systemCoordinator = new SystemCoordinator(logger);
  const svc = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
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

function loggedWith(marker) {
  return logger.log.mock.calls.some((args) => String(args[0]).includes(marker));
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

describe('H12 FÄLTFALLET: returbenet efter kajvändning', () => {
  // Berättelsen: båten kom in söderifrån (episodstart 58.2700), gick norrut
  // hela kanalen, lade till vid kajen norr om Klaffbron och gick sedan SÖDERUT
  // igen. Den nya resans målbro är Klaffbron; passagen missades (AIS-glapp)
  // och Olidebron gate-bekräftas söder om den.
  function makeReturnLegVessel(extra) {
    return {
      mmsi: '265112001',
      lat: 58.2715, // söder om Olidebron
      lon: 12.2740,
      sog: 4.8,
      cog: 205,
      targetBridge: 'Klaffbron',
      _routeDirection: 'south',
      _firstSeenLat: 58.2700, // UTRESANS episodstart — söder om Klaffbron
      passedBridges: [],
      passedAt: {},
      ...extra,
    };
  }

  test('med reseankare vid kajen inferreras den missade Klaffbron-passagen', () => {
    const svc = makeVDS();
    const vessel = makeReturnLegVessel({ _journeyStartLat: KAJ_LAT });
    const oldVessel = { ...vessel, lat: 58.2745, lon: 12.2765 }; // norr om Olidebron

    svc.registerConfirmedIntermediatePassage(vessel, oldVessel, 'Olidebron', Date.now());

    expect(loggedWith('[MISSED_TARGET_INFERRED]')).toBe(true);
    expect(loggedWith('[MISSED_TARGET_ORIGIN_SKIP]')).toBe(false);
    expect(vessel._passageBackfills || []).toContain('Klaffbron');
  });

  test('UTAN reseankare (bara episodankaret) dör inferensen — den gamla buggen', () => {
    const svc = makeVDS();
    // Episodankaret ligger kvar på utresans start, söder om Klaffbron.
    const vessel = makeReturnLegVessel();
    const oldVessel = { ...vessel, lat: 58.2745, lon: 12.2765 };

    svc.registerConfirmedIntermediatePassage(vessel, oldVessel, 'Olidebron', Date.now());

    expect(loggedWith('[MISSED_TARGET_ORIGIN_SKIP]')).toBe(true);
    expect(vessel._passageBackfills || []).not.toContain('Klaffbron');
  });

  test('reseankaret VINNER över episodankaret (prioritetsordningen)', () => {
    const svc = makeVDS();
    const vessel = makeReturnLegVessel({ _journeyStartLat: KAJ_LAT });
    expect(svc._journeyOriginLat(vessel)).toBe(KAJ_LAT);
    expect(vessel._firstSeenLat).toBe(58.2700);
  });
});

describe('H12: AKIRA-skyddet (SOAK-RESA-18) är bevarat', () => {
  test('U-svängd båt med stale målbro underkänns fortfarande — ingen fantomtransition', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265112002',
      lat: 58.2971, // norr om Stridsbergsbron
      lon: 12.2999,
      sog: 5,
      cog: 20.8,
      targetBridge: 'Klaffbron', // inaktuell, bakom henne
      _routeDirection: 'north',
      _firstSeenLat: 58.2875,
      _journeyStartLat: 58.2875, // reseankaret ligger på SAMMA fel sida
      passedBridges: [],
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2893, lon: 12.2894 };
    svc.targetBridgeProtection.set('265112002', {
      isActive: true, targetBridge: 'Klaffbron', reason: 'maneuver', startTime: Date.now(),
    });

    svc.registerConfirmedIntermediatePassage(vessel, oldVessel, 'Stridsbergsbron', Date.now());

    expect(loggedWith('[MISSED_TARGET_ORIGIN_SKIP]')).toBe(true);
    expect(vessel._passageBackfills || []).not.toContain('Klaffbron');
    expect(vessel.targetBridge).toBeNull(); // _clearStaleTargetBeyond
  });

  test('fallbacken är intakt: utan reseankare gäller _firstSeenLat som förut (godkänd sida)', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265112003',
      lat: 58.2920,
      lon: 12.2925,
      sog: 5,
      cog: 25,
      targetBridge: 'Klaffbron',
      _routeDirection: 'north',
      _firstSeenLat: 58.2700, // söder om Klaffbron — vakten godkänner
      passedBridges: [],
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2905, lon: 12.2910 };

    svc.registerConfirmedIntermediatePassage(vessel, oldVessel, 'Järnvägsbron', Date.now());

    expect(loggedWith('[MISSED_TARGET_INFERRED]')).toBe(true);
    expect(vessel._passageBackfills || []).toContain('Klaffbron');
  });

  test('_journeyOriginLat faller tillbaka på _firstSeenLat och sedan på null', () => {
    const svc = makeVDS();
    expect(svc._journeyOriginLat({ _firstSeenLat: 58.27 })).toBe(58.27);
    expect(svc._journeyOriginLat({})).toBeNull();
    expect(svc._journeyOriginLat({ _journeyStartLat: NaN, _firstSeenLat: 58.27 })).toBe(58.27);
    expect(svc._journeyOriginLat(null)).toBeNull();
  });
});

describe('H12: Järnvägsbro-backfillens S-F6-villkor mäter också RESAN', () => {
  // Berättelsen: båten kom in NORRIFRÅN (episodstart 58.3050), gick söderut
  // till Klaffbron, vände och gick norrut igen med Stridsbergsbron som mål.
  // TARGET_END norrut ⇒ Järnvägsbron är geometriskt nödvändigt passerad.
  function makeNorthReturnVessel(extra) {
    return {
      mmsi: '265112004',
      lat: 58.2960, // norr om Stridsbergsbron
      lon: 12.2965,
      sog: 5.2,
      cog: 25,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      _firstSeenLat: 58.3050, // episodstart NORR om Järnvägsbron
      passedBridges: [],
      passedAt: {},
      ...extra,
    };
  }

  test('med reseankare söder om Järnvägsbron inferreras passagen', () => {
    const svc = makeVDS();
    const vessel = makeNorthReturnVessel({ _journeyStartLat: 58.2800 });
    const oldVessel = { ...vessel, lat: 58.2925, lon: 12.2938 };

    svc._applyTargetTransition(vessel, oldVessel, null); // TARGET_END

    expect(loggedWith('[INFERRED_PASSAGE]')).toBe(true);
    expect(vessel.passedBridges).toContain('Järnvägsbron');
    expect(vessel._passageBackfills || []).toContain('Järnvägsbron');
  });

  test('UTAN reseankare skippas den — den gamla buggen', () => {
    const svc = makeVDS();
    const vessel = makeNorthReturnVessel();
    const oldVessel = { ...vessel, lat: 58.2925, lon: 12.2938 };

    svc._applyTargetTransition(vessel, oldVessel, null);

    expect(loggedWith('[INFERRED_PASSAGE_SKIP]')).toBe(true);
    expect(vessel.passedBridges).not.toContain('Järnvägsbron');
  });

  test('S-F6-skyddet består: kajstart söder om Järnvägsbron ger INGEN inferens söderut', () => {
    const svc = makeVDS();
    // Kajen norr om Klaffbron men SÖDER om Järnvägsbron, sydgående mot
    // Klaffbron — hon har aldrig korsat Järnvägsbron.
    const vessel = {
      mmsi: '265112005',
      lat: 58.2830,
      lon: 12.2835,
      sog: 4.0,
      cog: 205,
      targetBridge: 'Klaffbron',
      _routeDirection: 'south',
      _firstSeenLat: KAJ_LAT,
      _journeyStartLat: KAJ_LAT,
      passedBridges: [],
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2850, lon: 12.2855 };

    svc._applyTargetTransition(vessel, oldVessel, null);

    expect(loggedWith('[INFERRED_PASSAGE_SKIP]')).toBe(true);
    expect(vessel.passedBridges).not.toContain('Järnvägsbron');
  });
});

describe('H12: reseankaret sätts vid varje resestart som VDS äger', () => {
  test('ny måltilldelning (NEW) ankrar resan vid tilldelningspositionen', () => {
    const svc = makeVDS();
    const v = svc.updateVessel('265112010', {
      lat: KAJ_LAT, lon: 12.2868, sog: 5.2, cog: 205, name: 'KAJVANDAREN',
    });
    expect(v.targetBridge).toBe('Klaffbron');
    expect(v._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
  });

  test('måltilldelning efter acceleration (ACCELERATED) ankrar om resan', () => {
    const svc = makeVDS();
    // Först stillaliggande vid kajen — ingen målbro tilldelas.
    const first = svc.updateVessel('265112011', {
      lat: KAJ_LAT, lon: 12.2868, sog: 0.1, cog: 205, name: 'ACCELERANDE',
    });
    expect(first.targetBridge).toBeFalsy();
    expect(first._journeyStartLat).toBeNull();
    // Sedan avgång söderut (ett normalt kadenssteg, ~67 m — större hopp
    // fångas av GPS-hoppvakten och skjuter upp tilldelningen).
    const moved = 58.2854;
    const second = svc.updateVessel('265112011', {
      lat: moved, lon: 12.2862, sog: 5.4, cog: 205, name: 'ACCELERANDE',
    });
    expect(second.targetBridge).toBe('Klaffbron');
    // H12-B2: ankaret seedas från EPISODANKARET (kajläget) när inget reseankare
    // finns, och på en sydresa vinner nordligast ⇒ kajen, inte de 67 m hon hann
    // röra sig innan tilldelningen. Skillnaden är kosmetisk här (båda ligger
    // norr om Klaffbron) men riktningen är hela poängen: ankaret får aldrig
    // ligga FRAMFÖR episodstarten i färdriktningen.
    expect(second._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
    // Ankaret står KVAR under resans gång (bara resestarter ankrar om).
    const third = svc.updateVessel('265112011', {
      lat: 58.2848, lon: 12.2856, sog: 5.4, cog: 205, name: 'ACCELERANDE',
    });
    expect(third._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
  });

  test('bekräftad riktningsreversal ankrar om resan (U-svängen ÄR en ny resa)', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265112012',
      lat: 58.2893,
      lon: 12.2894,
      sog: 5,
      cog: 20,
      targetBridge: 'Klaffbron',
      _routeDirection: 'south',
      _firstSeenLat: 58.2700,
      _journeyStartLat: 58.2700,
      passedBridges: [],
    };

    svc._confirmDirectionReversal(vessel, 'north', 'test');

    expect(vessel._journeyStartLat).toBeCloseTo(58.2893, 6);
    expect(vessel._routeDirection).toBe('north');
  });

  test('_anchorJourneyOrigin är no-op utan giltig position (inget halvt ankare)', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112013', lat: NaN, _journeyStartLat: 58.28 };
    svc._anchorJourneyOrigin(vessel, 'test');
    expect(vessel._journeyStartLat).toBe(58.28);
    expect(() => svc._anchorJourneyOrigin(null, 'test')).not.toThrow();
  });
});

describe('H12 FÄLTLIST-FÄLLAN: reseankaret överlever objektombyggnaden', () => {
  test('_createVesselObject ärver _journeyStartLat från oldVessel', () => {
    const svc = makeVDS();
    const oldVessel = { mmsi: '265112020', _journeyStartLat: KAJ_LAT };
    const rebuilt = svc._createVesselObject('265112020', {
      lat: 58.2840, lon: 12.2840, sog: 4, cog: 205,
    }, oldVessel);
    expect(rebuilt._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
  });

  test('en ny/återfödd båt får null — inte positionen (fallbacken ska gälla)', () => {
    const svc = makeVDS();
    const fresh = svc._createVesselObject('265112021', {
      lat: 58.2840, lon: 12.2840, sog: 4, cog: 205,
    }, undefined);
    expect(fresh._journeyStartLat).toBeNull();
    expect(fresh._firstSeenLat).toBeCloseTo(58.2840, 6);
    // Fallbacken gör att vakterna beter sig exakt som före fixen.
    expect(svc._journeyOriginLat(fresh)).toBeCloseTo(58.2840, 6);
  });

  test('ankaret överlever en hel kedja av meddelanden', () => {
    const svc = makeVDS();
    let v = svc._createVesselObject('265112022', {
      lat: KAJ_LAT, lon: 12.2868, sog: 4, cog: 205,
    }, undefined);
    svc._anchorJourneyOrigin(v, 'test-start');
    for (let i = 0; i < 5; i++) {
      v = svc._createVesselObject('265112022', {
        lat: KAJ_LAT - i * 0.0005, lon: 12.2868, sog: 4, cog: 205,
      }, v);
    }
    expect(v._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
  });
});

describe('H12: broordningen som testerna vilar på', () => {
  test('Olidebron < Klaffbron < kajen < Järnvägsbron < Stridsbergsbron', () => {
    const svc = makeVDS();
    expect(svc.bridgeRegistry.getBridgeByName('Olidebron').lat).toBeCloseTo(OLIDEBRON_LAT, 6);
    expect(svc.bridgeRegistry.getBridgeByName('Klaffbron').lat).toBeCloseTo(KLAFFBRON_LAT, 6);
    expect(svc.bridgeRegistry.getBridgeByName('Järnvägsbron').lat).toBeCloseTo(JARNVAGSBRON_LAT, 6);
    expect(svc.bridgeRegistry.getBridgeByName('Stridsbergsbron').lat).toBeCloseTo(STRIDSBERGSBRON_LAT, 6);
    expect(OLIDEBRON_LAT).toBeLessThan(KLAFFBRON_LAT);
    expect(KLAFFBRON_LAT).toBeLessThan(KAJ_LAT);
    expect(KAJ_LAT).toBeLessThan(JARNVAGSBRON_LAT);
    expect(JARNVAGSBRON_LAT).toBeLessThan(STRIDSBERGSBRON_LAT);
  });
});

/**
 * H12-B (granskningen 2026-08-22) — MÅLTILLDELNINGEN ÄR INGEN RESEGRÄNS.
 *
 * FYNDET. Första H12-versionen ankrade HÅRT även vid måltilldelning (NEW och
 * ACCELERATED). Vid tilldelningen ligger båten per konstruktion på
 * anflygningssidan av sin EGEN målbro — men inte nödvändigtvis bakom resans
 * MELLANBROAR. En nordgående som tappar målbron mellan Järnvägsbron (58.29164)
 * och Stridsbergsbron och får den ÅTERTILLDELAD där fick reseankaret flyttat
 * FRAMFÖR Järnvägsbron ⇒ startedBeyondJvb false ⇒ den geometriskt nödvändiga
 * Järnvägsbro-passagen försvann vid TARGET_END. Det är en NY falsk negativ som
 * varken episodankaret eller den gamla koden hade.
 *
 * VALET. Två alternativ stod öppna: (a) ankra vid måltilldelning ENDAST när
 * inget ankare finns, eller (b) behålla det EXTREMASTE av befintligt ankare och
 * tilldelningsposition i färdriktningen. (a) VALDES BORT: den återinför exakt
 * den bugg H12 stängde — kajvändaren har redan ett ankare från utresan, så
 * returbenets tilldelning hade inte fått ankra om och MISSED_TARGET_ORIGIN_SKIP
 * vore tillbaka. (b) klarar BÅDA: ankaret kan bara flytta BAKÅT i färdriktningen
 * (ingen ny falsk negativ), och när riktningen VÄNT är kajläget per definition
 * det extremaste i den nya riktningen (returbenet ankras om precis som förut).
 * Äkta resegränser — bekräftad reversal och app-lagrets NEW_JOURNEY — ankrar
 * fortfarande HÅRT via _anchorJourneyOrigin / det publika anchorJourneyOrigin().
 */
describe('H12-B: _extendJourneyOrigin — monotont ankare (kan bara flytta BAKÅT)', () => {
  test('saknat ankare sätts (identiskt med det hårda ankaret)', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112040', lat: 58.2880, _journeyStartLat: null };
    svc._extendJourneyOrigin(vessel, 'north', 'test');
    expect(vessel._journeyStartLat).toBeCloseTo(58.2880, 6);
  });

  test('NORDRESA: ett läge LÄNGRE NORRUT flyttar inte ankaret framåt', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112041', lat: 58.2925, _journeyStartLat: 58.2880 };
    svc._extendJourneyOrigin(vessel, 'north', 'test');
    expect(vessel._journeyStartLat).toBeCloseTo(58.2880, 6);
  });

  test('NORDRESA: ett läge LÄNGRE SÖDERUT flyttar ankaret bakåt', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112042', lat: 58.2750, _journeyStartLat: 58.2880 };
    svc._extendJourneyOrigin(vessel, 'north', 'test');
    expect(vessel._journeyStartLat).toBeCloseTo(58.2750, 6);
  });

  test('SYDRESA: spegelvänt — nordligast vinner', () => {
    const svc = makeVDS();
    const a = { mmsi: '265112043', lat: 58.2830, _journeyStartLat: KAJ_LAT };
    svc._extendJourneyOrigin(a, 'south', 'test');
    expect(a._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);

    const b = { mmsi: '265112044', lat: 58.3050, _journeyStartLat: KAJ_LAT };
    svc._extendJourneyOrigin(b, 'south', 'test');
    expect(b._journeyStartLat).toBeCloseTo(58.3050, 6);
  });

  test('okänd riktning rör INTE ett befintligt ankare', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112045', lat: 58.3050, _journeyStartLat: KAJ_LAT };
    svc._extendJourneyOrigin(vessel, null, 'test');
    expect(vessel._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
    svc._extendJourneyOrigin(vessel, 'unknown', 'test');
    expect(vessel._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
  });

  test('okänd riktning UTAN ankare sätter det ändå (bättre än inget origo)', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112046', lat: 58.3050, _journeyStartLat: null };
    svc._extendJourneyOrigin(vessel, null, 'test');
    expect(vessel._journeyStartLat).toBeCloseTo(58.3050, 6);
  });

  test('ogiltig position är no-op (inget halvsatt ankare)', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112047', lat: NaN, _journeyStartLat: KAJ_LAT };
    svc._extendJourneyOrigin(vessel, 'north', 'test');
    expect(vessel._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
    expect(() => svc._extendJourneyOrigin(null, 'north', 'test')).not.toThrow();
  });
});

describe('H12-B JÄRNVÄGSBRON: nordgående tilldelad NORR om Jvb behåller inferensen', () => {
  // Berättelsen: resan började vid 58.2880 (SÖDER om Järnvägsbron 58.29164),
  // målbron tappades mellan Järnvägsbron och Stridsbergsbron (valideringsmiss/
  // STALE_TARGET) och återtilldelades vid 58.2925 — NORR om Järnvägsbron.
  const JOURNEY_START = 58.2880;
  const REASSIGN_LAT = 58.2925;

  function makeTargetEndVessel(journeyStartLat) {
    return {
      mmsi: '265112050',
      lat: 58.2960, // norr om Stridsbergsbron
      lon: 12.2965,
      sog: 5.2,
      cog: 25,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      _firstSeenLat: JOURNEY_START,
      _journeyStartLat: journeyStartLat,
      passedBridges: [],
      passedAt: {},
    };
  }

  test('det monotona ankaret står kvar söder om Järnvägsbron', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112050', lat: REASSIGN_LAT, _journeyStartLat: JOURNEY_START };
    svc._extendJourneyOrigin(vessel, 'north', 'target-assign-accelerated');
    expect(vessel._journeyStartLat).toBeCloseTo(JOURNEY_START, 6);
    expect(vessel._journeyStartLat).toBeLessThan(JARNVAGSBRON_LAT);
  });

  test('TARGET_END inferrerar Järnvägsbron med det monotona ankaret', () => {
    const svc = makeVDS();
    const vessel = makeTargetEndVessel(JOURNEY_START);
    const oldVessel = { ...vessel, lat: 58.2925, lon: 12.2938 };

    svc._applyTargetTransition(vessel, oldVessel, null);

    expect(loggedWith('[INFERRED_PASSAGE]')).toBe(true);
    expect(vessel.passedBridges).toContain('Järnvägsbron');
    expect(vessel._passageBackfills || []).toContain('Järnvägsbron');
  });

  test('MOTPROVET: hade ankaret flyttats framåt hade passagen fallit bort', () => {
    const svc = makeVDS();
    // Exakt vad det HÅRDA ankaret hade gett vid återtilldelningen.
    const vessel = makeTargetEndVessel(REASSIGN_LAT);
    const oldVessel = { ...vessel, lat: 58.2925, lon: 12.2938 };

    svc._applyTargetTransition(vessel, oldVessel, null);

    expect(loggedWith('[INFERRED_PASSAGE_SKIP]')).toBe(true);
    expect(vessel.passedBridges).not.toContain('Järnvägsbron');
  });

  test('INTEGRATION: ACCELERATED-återtilldelning norr om Jvb flyttar inte origo', () => {
    const svc = makeVDS();
    const mmsi = '265112051';
    // FIXKLOCKAN måste bära steget: GPSJumpAnalyzer dömer hopp mot ett
    // FYSIKFÖNSTER (fart x dt) och läser dt ur fixTs/fixFeed. Utan explicita
    // fixstämplar ligger båda meddelandena i samma millisekund, varje meter
    // blir ett "GPS-hopp" och måltilldelningen förkastas — då hade testet
    // mätt hoppvakten i stället för reseankaret. 280 m på 180 s = 3,0 kn,
    // väl inom 5,4-knopsfönstret.
    const t0 = Date.now() - 180000;
    const start = svc.updateVessel(mmsi, {
      lat: JOURNEY_START,
      lon: 12.2885,
      sog: 5.4,
      cog: 20,
      name: 'NORDFARAREN',
      fixTs: t0,
      fixFeed: 'aisstream',
    });
    expect(start.targetBridge).toBe('Stridsbergsbron');
    expect(start._journeyStartLat).toBeCloseTo(JOURNEY_START, 6);

    // Målbron tappas (valideringsmiss/STALE_TARGET) medan hon är mellan broarna.
    svc.getVessel(mmsi).targetBridge = null;

    const after = svc.updateVessel(mmsi, {
      lat: REASSIGN_LAT,
      lon: 12.2938,
      sog: 5.4,
      cog: 20,
      name: 'NORDFARAREN',
      fixTs: t0 + 180000,
      fixFeed: 'aisstream',
    });
    expect(after.targetBridge).toBe('Stridsbergsbron'); // ACCELERATED-grenen körde
    expect(after._journeyStartLat).toBeCloseTo(JOURNEY_START, 6);
  });

  test('INTEGRATION spegelvänt: sydgående återtilldelad SÖDER om Jvb flyttar inte origo', () => {
    const svc = makeVDS();
    const mmsi = '265112052';
    // Resan söderut började NORR om Järnvägsbron (mellan Jvb och
    // Stridsbergsbron); målbron tappas och återtilldelas SÖDER om Jvb.
    const southStart = 58.2930;
    const southReassign = 58.2900;
    const t0 = Date.now() - 180000;
    const start = svc.updateVessel(mmsi, {
      lat: southStart,
      lon: 12.2940,
      sog: 5.4,
      cog: 205,
      name: 'SYDFARAREN',
      fixTs: t0,
      fixFeed: 'aisstream',
    });
    expect(start.targetBridge).toBe('Klaffbron');
    expect(start._journeyStartLat).toBeCloseTo(southStart, 6);

    svc.getVessel(mmsi).targetBridge = null;

    const after = svc.updateVessel(mmsi, {
      lat: southReassign,
      lon: 12.2900,
      sog: 5.4,
      cog: 205,
      name: 'SYDFARAREN',
      fixTs: t0 + 180000,
      fixFeed: 'aisstream',
    });
    expect(after.targetBridge).toBe('Klaffbron');
    // Nordligast vinner på en sydresa ⇒ ankaret står kvar NORR om Järnvägsbron,
    // så den geometriskt nödvändiga Jvb-passagen kan inferreras vid TARGET_END.
    expect(after._journeyStartLat).toBeCloseTo(southStart, 6);
    expect(after._journeyStartLat).toBeGreaterThan(JARNVAGSBRON_LAT);
  });
});

describe('H12-B2 KAJLIGGAREN UTAN MÅLBRO: episodankaret seedar det monotona ankaret', () => {
  // KLASSEN (granskningen 2026-08-22, kvarlämnad halva av H12-B). En kajliggare
  // UTAN målbro som accelererar går via ACCELERATED-grenen och har därför inget
  // tidigare reseankare. Den första versionen satte då ankaret rakt till
  // tilldelningsläget och IGNORERADE episodankaret — så det FÖRSTA ankaret kunde
  // redan ligga FRAMFÖR episodstarten och origin-vakterna blev strängare än före
  // H12. Berättelsen: första kontakt 58.2800 (SÖDER om Järnvägsbron 58.29164),
  // stillaliggande utan målbro; hon lägger ut norrut och får sin FÖRSTA målbro
  // först på 58.2950 (NORR om Järnvägsbron), t.ex. för att COG saknades vid
  // förstakontakten (9,3 % av raderna).
  const FIRST_SEEN = 58.2800;
  const ASSIGN_LAT = 58.2950;

  test('första sättningen tar episodankaret, inte tilldelningsläget', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265112090',
      lat: ASSIGN_LAT,
      _firstSeenLat: FIRST_SEEN,
      _journeyStartLat: null,
    };
    svc._extendJourneyOrigin(vessel, 'north', 'target-assign-accelerated');
    expect(vessel._journeyStartLat).toBeCloseTo(FIRST_SEEN, 6);
    expect(vessel._journeyStartLat).toBeLessThan(JARNVAGSBRON_LAT);
  });

  test('startedBeyondJvb förblir SANT ⇒ Järnvägsbron inferreras vid TARGET_END', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265112091',
      lat: 58.2960, // norr om Stridsbergsbron
      lon: 12.2965,
      sog: 5.2,
      cog: 25,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      _firstSeenLat: FIRST_SEEN,
      _journeyStartLat: null,
      passedBridges: [],
      passedAt: {},
    };
    // Måltilldelningen skedde NORR om Järnvägsbron.
    const assigning = { ...vessel, lat: ASSIGN_LAT };
    svc._extendJourneyOrigin(assigning, 'north', 'target-assign-accelerated');
    vessel._journeyStartLat = assigning._journeyStartLat;

    const oldVessel = { ...vessel, lat: 58.2925, lon: 12.2938 };
    svc._applyTargetTransition(vessel, oldVessel, null);

    expect(loggedWith('[INFERRED_PASSAGE]')).toBe(true);
    expect(vessel.passedBridges).toContain('Järnvägsbron');
    expect(vessel._passageBackfills || []).toContain('Järnvägsbron');
  });

  test('origin-vakten för missade målbroar godkänner samma resa', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265112092',
      lat: ASSIGN_LAT,
      _firstSeenLat: FIRST_SEEN,
      _journeyStartLat: null,
    };
    svc._extendJourneyOrigin(vessel, 'north', 'target-assign-accelerated');
    expect(svc._targetOriginSideOk(
      vessel, svc.bridgeRegistry.getBridgeByName('Järnvägsbron'), 'north',
    )).toBe(true);
  });

  test('MOTPROVET: utan episodankare sätts ankaret till tilldelningsläget (oförändrat)', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112093', lat: ASSIGN_LAT, _journeyStartLat: null };
    svc._extendJourneyOrigin(vessel, 'north', 'target-assign-accelerated');
    expect(vessel._journeyStartLat).toBeCloseTo(ASSIGN_LAT, 6);
  });

  test('episodankaret kan inte flytta ankaret FRAMÅT heller (sydresa)', () => {
    const svc = makeVDS();
    // Sydresa: nordligast vinner. Episodankaret ligger SÖDER om tilldelningen
    // ⇒ tilldelningsläget är extremast och vinner — seedningen kan aldrig göra
    // ankaret sämre, bara bättre.
    const vessel = {
      mmsi: '265112094',
      lat: 58.2950,
      _firstSeenLat: 58.2800,
      _journeyStartLat: null,
    };
    svc._extendJourneyOrigin(vessel, 'south', 'target-assign-accelerated');
    expect(vessel._journeyStartLat).toBeCloseTo(58.2950, 6);
  });

  test('okänd riktning UTAN reseankare materialiserar episodankaret', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265112095',
      lat: ASSIGN_LAT,
      _firstSeenLat: FIRST_SEEN,
      _journeyStartLat: null,
    };
    svc._extendJourneyOrigin(vessel, null, 'target-assign-accelerated');
    // Att gissa "bakåt" utan riktning kan bara skada — episodankaret är den
    // punkt vakterna läste FÖRE H12, så det är det säkra utgångsvärdet.
    expect(vessel._journeyStartLat).toBeCloseTo(FIRST_SEEN, 6);
  });
});

describe('H12-B: returbenet ankras fortfarande om (H12:s egen nytta bevarad)', () => {
  test('kajvändaren: sydresa efter nordresa flyttar ankaret till kajen', () => {
    const svc = makeVDS();
    // Utresan norrut startade söder om Klaffbron.
    const vessel = { mmsi: '265112060', lat: KAJ_LAT, _journeyStartLat: 58.2700 };
    // Returbenet söderut tilldelas vid kajen — nordligast vinner ⇒ kajen.
    svc._extendJourneyOrigin(vessel, 'south', 'target-assign-accelerated');
    expect(vessel._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
    // Och därmed godkänner origin-vakten Klaffbron som mål söderut.
    expect(svc._targetOriginSideOk(
      vessel, svc.bridgeRegistry.getBridgeByName('Klaffbron'), 'south',
    )).toBe(true);
  });

  test('spegelfallet: nordresa efter sydresa flyttar ankaret till kajen', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112061', lat: KAJ_LAT, _journeyStartLat: 58.3050 };
    svc._extendJourneyOrigin(vessel, 'north', 'target-assign-accelerated');
    expect(vessel._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
    expect(svc._targetOriginSideOk(
      vessel, svc.bridgeRegistry.getBridgeByName('Stridsbergsbron'), 'north',
    )).toBe(true);
  });

  test('ACCELERATED efter kajstopp ankrar vid EPISODANKARET (H12-B2)', () => {
    const svc = makeVDS();
    const first = svc.updateVessel('265112062', {
      lat: KAJ_LAT, lon: 12.2868, sog: 0.1, cog: 205, name: 'ACCELERANDE2',
    });
    expect(first._journeyStartLat).toBeNull();
    const moved = 58.2854; // 6,7 m SÖDER om kajen — hon har redan börjat röra sig
    const second = svc.updateVessel('265112062', {
      lat: moved, lon: 12.2862, sog: 5.4, cog: 205, name: 'ACCELERANDE2',
    });
    expect(second.targetBridge).toBe('Klaffbron');
    // H12-B2 (granskningen 2026-08-22): utan ankare seedas monotoniteten från
    // EPISODANKARET. På en sydresa vinner nordligast ⇒ kajläget (58.2860), inte
    // tilldelningsläget (58.2854). Före fixen sattes ankaret rakt på
    // tilldelningsläget, dvs. ETT STEG FRAMÅT i färdriktningen jämfört med
    // episodstarten — exakt riktningen H12-B skulle omöjliggöra.
    expect(second._journeyStartLat).toBeCloseTo(KAJ_LAT, 6);
    expect(second._journeyStartLat).toBeGreaterThan(moved);
  });
});

describe('H12-B: äkta resegränser ankrar HÅRT (publikt API för app-lagret)', () => {
  test('anchorJourneyOrigin skriver över även framåt i färdriktningen', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112070', lat: 58.2925, _journeyStartLat: 58.2700 };
    svc.anchorJourneyOrigin(vessel, 'new-journey');
    expect(vessel._journeyStartLat).toBeCloseTo(58.2925, 6);
  });

  test('anchorJourneyOrigin är no-op utan giltig position', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '265112071', lat: NaN, _journeyStartLat: 58.2700 };
    svc.anchorJourneyOrigin(vessel, 'new-journey');
    expect(vessel._journeyStartLat).toBeCloseTo(58.2700, 6);
    expect(() => svc.anchorJourneyOrigin(null, 'new-journey')).not.toThrow();
  });

  test('getJourneyOriginLat speglar den interna prioritetsordningen', () => {
    const svc = makeVDS();
    expect(svc.getJourneyOriginLat({ _journeyStartLat: KAJ_LAT, _firstSeenLat: 58.27 }))
      .toBeCloseTo(KAJ_LAT, 6);
    expect(svc.getJourneyOriginLat({ _firstSeenLat: 58.27 })).toBeCloseTo(58.27, 6);
    expect(svc.getJourneyOriginLat({})).toBeNull();
    expect(svc.getJourneyOriginLat(null)).toBeNull();
  });

  test('bekräftad reversal ankrar HÅRT även när läget ligger framåt', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265112072',
      lat: 58.2960, // norr om det gamla ankaret
      lon: 12.2965,
      sog: 5,
      cog: 205,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      _journeyStartLat: 58.2700,
      passedBridges: [],
    };
    svc._confirmDirectionReversal(vessel, 'south', 'test');
    expect(vessel._journeyStartLat).toBeCloseTo(58.2960, 6);
  });
});

describe('H12-B FÄLTLIST-FÄLLAN: reseankaret följer med i vesselSnapshot', () => {
  // Positionen ligger med flit LÅNGT från broarna: removeVessel har en
  // PROTECTION_ZONE som vägrar radera ett fartyg inom 300 m av en bro.
  const FAR_FROM_BRIDGES_LAT = 58.2650;

  test('vessel:removed bär _journeyStartLat', () => {
    const svc = makeVDS();
    const mmsi = '265112080';
    svc.updateVessel(mmsi, {
      lat: FAR_FROM_BRIDGES_LAT, lon: 12.2650, sog: 5.2, cog: 20, name: 'SNAPSHOTTAD',
    });
    const live = svc.getVessel(mmsi);
    expect(live._journeyStartLat).toBeCloseTo(FAR_FROM_BRIDGES_LAT, 6);

    let snapshot = null;
    svc.on('vessel:removed', (e) => {
      snapshot = e.vessel;
    });
    svc.removeVessel(mmsi, 'timeout');

    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveProperty('_journeyStartLat');
    expect(snapshot._journeyStartLat).toBeCloseTo(FAR_FROM_BRIDGES_LAT, 6);
    expect(svc.getJourneyOriginLat(snapshot)).toBeCloseTo(FAR_FROM_BRIDGES_LAT, 6);
  });

  test('utan reseankare bär snapshotten null (inte undefined)', () => {
    const svc = makeVDS();
    const mmsi = '265112081';
    svc.updateVessel(mmsi, {
      lat: FAR_FROM_BRIDGES_LAT, lon: 12.2650, sog: 0.1, cog: 20, name: 'STILLA',
    });
    let snapshot = null;
    svc.on('vessel:removed', (e) => {
      snapshot = e.vessel;
    });
    svc.removeVessel(mmsi, 'timeout');
    expect(snapshot._journeyStartLat).toBeNull();
  });
});
