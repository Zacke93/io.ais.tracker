'use strict';

/**
 * H1 (helkodsgranskningen 2026-08-22, critical) — ruttlåset måste gå FÖRE
 * COG-grinden i _calculateNextTargetBridge.
 *
 * MEKANISMEN. Metoden returnerade null på icke-finit COG innan låsen
 * (_finalTargetDirection / _routeDirection) ens lästes, medan systermetoden
 * _calculateTargetBridge sedan FP8/IDUN har MOTSATT ordning: ett låst,
 * positionsbevisat riktningsbeslut ersätter en SAKNAD COG. Nulln tolkades av
 * _applyTargetTransition som TARGET_END, riktningen gissades ur previousTarget-
 * NAMNET (Stridsbergsbron ⇒ 'north') och skrevs ovillkorligt till både
 * _routeDirection och _finalTargetDirection. För en SÖDERGÅENDE som just
 * passerat Stridsbergsbron blev låset alltså FLIPPAT, och FIX Z-nordspegeln
 * spärrade därefter varje ny måltilldelning: målbrokedjan bröts utan
 * återhämtning. Indataklassen är vanlig — 9,3 % av raderna i fältprov 10
 * saknar COG (IDUN/LINNEA-klassen: fartgivarlösa/COG-lösa AIS-rader).
 *
 * Testerna låser (a) att låset ersätter saknad COG, (b) att spärren är kvar
 * när VARKEN COG eller lås finns, (c) att COG-vägen är oförändrad och
 * (d) djupförsvaret i TARGET_END-grenen.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

// Broarnas latituder (lib/constants.js BRIDGES) — kanalen är strikt
// latitudordnad syd→nord.
const KLAFFBRON_LAT = 58.28409551543077;
const STRIDSBERGSBRON_LAT = 58.293524096154634;

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

describe('H1: _calculateNextTargetBridge — låst ruttriktning ersätter saknad COG', () => {
  test('IDUN/LINNEA-klassen: COG-lös SÖDERGÅENDE med ruttlås får Klaffbron som nästa mål', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111001',
      lat: 58.2930,
      lon: 12.2943,
      sog: 4.2,
      cog: null, // COG-lös AIS-rad
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'south',
      passedBridges: [],
    };
    expect(svc._calculateNextTargetBridge(vessel)).toBe('Klaffbron');
  });

  test('COG-lös NORRGÅENDE med ruttlås får Stridsbergsbron som nästa mål', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111002',
      lat: 58.2850,
      lon: 12.2860,
      sog: 5.1,
      cog: undefined,
      targetBridge: 'Klaffbron',
      _routeDirection: 'north',
      passedBridges: [],
    };
    expect(svc._calculateNextTargetBridge(vessel)).toBe('Stridsbergsbron');
  });

  test('NaN-COG räknas som saknad — låset gäller ändå', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111003',
      lat: 58.2930,
      lon: 12.2943,
      sog: 3.0,
      cog: NaN,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'south',
      passedBridges: [],
    };
    expect(svc._calculateNextTargetBridge(vessel)).toBe('Klaffbron');
  });

  test('precedensen är oförändrad: _finalTargetDirection slår _routeDirection även utan COG', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111004',
      lat: 58.2850,
      lon: 12.2860,
      sog: 4.0,
      cog: null,
      targetBridge: 'Klaffbron',
      _finalTargetDirection: 'north',
      _routeDirection: 'south', // äldre lås — final vinner (FIX R)
      passedBridges: [],
    };
    expect(svc._calculateNextTargetBridge(vessel)).toBe('Stridsbergsbron');
  });

  test('COG-lös vid SLUTMÅLET ger fortfarande null (ingen bro efter Klaffbron söderut)', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111005',
      lat: 58.2820,
      lon: 12.2820,
      sog: 4.0,
      cog: null,
      targetBridge: 'Klaffbron',
      _routeDirection: 'south',
      passedBridges: [],
    };
    expect(svc._calculateNextTargetBridge(vessel)).toBeNull();
  });
});

describe('H1: spärren är KVAR när varken COG eller lås finns', () => {
  test('saknad COG utan lås → null som förut', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111006',
      lat: 58.2930,
      lon: 12.2943,
      sog: 4.2,
      cog: null,
      targetBridge: 'Stridsbergsbron',
      passedBridges: [],
    };
    expect(svc._calculateNextTargetBridge(vessel)).toBeNull();
  });

  test('saknad COG med OGILTIGT låsvärde är inget bevis → null', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111007',
      lat: 58.2930,
      lon: 12.2943,
      sog: 4.2,
      cog: null,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'unknown',
      passedBridges: [],
    };
    expect(svc._calculateNextTargetBridge(vessel)).toBeNull();
  });

  test('utan målbro returneras null oavsett lås', () => {
    const svc = makeVDS();
    expect(svc._calculateNextTargetBridge({
      mmsi: '265111008', targetBridge: null, cog: null, _routeDirection: 'south',
    })).toBeNull();
  });
});

describe('H1: COG-vägen är oförändrad (regressionsvakt)', () => {
  test('nordlig COG utan lås → Klaffbron ger Stridsbergsbron', () => {
    const svc = makeVDS();
    expect(svc._calculateNextTargetBridge({
      mmsi: '265111009', targetBridge: 'Klaffbron', cog: 25, sog: 5,
    })).toBe('Stridsbergsbron');
  });

  test('sydlig COG utan lås → Stridsbergsbron ger Klaffbron', () => {
    const svc = makeVDS();
    expect(svc._calculateNextTargetBridge({
      mmsi: '265111010', targetBridge: 'Stridsbergsbron', cog: 205, sog: 5,
    })).toBe('Klaffbron');
  });

  test('låset slår COG:n precis som före fixen (FIX R)', () => {
    const svc = makeVDS();
    expect(svc._calculateNextTargetBridge({
      mmsi: '265111011',
      targetBridge: 'Stridsbergsbron',
      cog: 25, // nordlig COG-vobbel
      sog: 0.8,
      _routeDirection: 'south',
    })).toBe('Klaffbron');
  });
});

describe('H1 FÄLTFALLET: COG-lös sydgående passerar Stridsbergsbron', () => {
  test('kedjan fortsätter till Klaffbron och riktningslåset flippas INTE', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111012',
      lat: 58.2925, // söder om Stridsbergsbron
      lon: 12.2938,
      sog: 4.6,
      cog: null, // COG-lös i exakt passageticket
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'south',
      passedBridges: [],
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2940, lon: 12.2950 }; // norr om bron

    svc._handleTargetBridgeTransition(vessel, oldVessel, { confirmedPassage: true });

    expect(vessel.targetBridge).toBe('Klaffbron'); // målbrokedjan lever
    expect(vessel._routeDirection).toBe('south'); // låset INTE flippat till north
    expect(vessel._finalTargetDirection).toBeFalsy(); // ingen falsk TARGET_END
    expect(vessel.passedBridges).toContain('Stridsbergsbron');
  });

  test('FIX Z-nordspegeln spärrar INTE ny måltilldelning efteråt (följdskadan)', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111013',
      lat: 58.2925,
      lon: 12.2938,
      sog: 4.6,
      cog: null,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'south',
      passedBridges: [],
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2940, lon: 12.2950 };

    svc._handleTargetBridgeTransition(vessel, oldVessel, { confirmedPassage: true });

    // Efter transitionen: en ny måltilldelning för samma (nu COG-lösa) båt
    // ska ge Klaffbron — inte null via nordspegeln (_finalTargetDirection
    // 'north' + passedBridges innehåller Stridsbergsbron).
    expect(svc._calculateTargetBridge({
      ...vessel, targetBridge: null,
    })).toBe('Klaffbron');
  });
});

describe('H1 DJUPFÖRSVAR: TARGET_END gissar inte riktningen ur bronamnet när ett lås finns', () => {
  test('lås "south" + previousTarget Stridsbergsbron ⇒ riktningen följer låset', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111014',
      lat: 58.2925,
      lon: 12.2938,
      sog: 4.6,
      cog: null,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'south',
      passedBridges: [],
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2940, lon: 12.2950 };

    // Tvinga fram TARGET_END-grenen med nextTargetBridge=null (H1:s
    // gamla utfall, eller en stale _pendingTarget.next).
    svc._applyTargetTransition(vessel, oldVessel, null);

    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBe('south'); // INTE flippat till 'north'
    expect(vessel._finalTargetDirection).toBe('south');
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('[TARGET_END_DIR_LOCK]'),
    );
  });

  test('äkta TARGET_END utan lås använder bronamnet precis som förut', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111015',
      lat: 58.2960,
      lon: 12.2965,
      sog: 5.0,
      cog: 20,
      targetBridge: 'Stridsbergsbron',
      passedBridges: [],
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2925, lon: 12.2938 };

    svc._applyTargetTransition(vessel, oldVessel, null);

    expect(vessel._finalTargetDirection).toBe('north');
    expect(vessel._routeDirection).toBe('north');
  });

  test('äkta nordligt TARGET_END med samstämmigt lås loggar INGEN avvikelse', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265111016',
      lat: 58.2960,
      lon: 12.2965,
      sog: 5.0,
      cog: 20,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      passedBridges: [],
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2925, lon: 12.2938 };

    svc._applyTargetTransition(vessel, oldVessel, null);

    expect(vessel._finalTargetDirection).toBe('north');
    expect(logger.log).not.toHaveBeenCalledWith(
      expect.stringContaining('[TARGET_END_DIR_LOCK]'),
    );
  });
});

describe('H1: broarnas latitudordning som testet vilar på', () => {
  test('Klaffbron ligger söder om Stridsbergsbron', () => {
    const svc = makeVDS();
    expect(svc.bridgeRegistry.getBridgeByName('Klaffbron').lat).toBeCloseTo(KLAFFBRON_LAT, 6);
    expect(svc.bridgeRegistry.getBridgeByName('Stridsbergsbron').lat).toBeCloseTo(STRIDSBERGSBRON_LAT, 6);
    expect(KLAFFBRON_LAT).toBeLessThan(STRIDSBERGSBRON_LAT);
  });
});

/**
 * H1-B (granskningen 2026-08-22) — COG-INTERVALLKRAVET.
 *
 * Fyndet: metodens COG-grind nöjde sig med Number.isFinite medan systermetoden
 * _calculateTargetBridge kräver finit OCH 0 ≤ cog < 360 (cogValid, ~:3431).
 * Asymmetrin var ofarlig ENBART för att H34 nollar COG utanför 0–360 uppströms
 * (app.js + aishubParser) — en tyst koppling till en annan fil. Rullas H34
 * tillbaka återinförs asymmetrin utan att något test säger ifrån.
 *
 * VARFÖR DET SPELAR ROLL: nordbandspredikatet isNorthCog är 315–45 via 0° och
 * NORMALISERAR INTE (kontraktet i lib/utils/cogDirection). En spökkurs ≥ 315 —
 * t.ex. AIS:ens 511 "ej tillgänglig", eller 400/700 ur en trasig parser — läses
 * därför som NORRUT. En sydgående utan ruttlås fick alltså "nästa målbro"
 * beräknad ur en kurs som inte existerar. Efter fixen behandlas den som SAKNAD
 * (spärren gäller) precis som i systermetoden.
 */
describe('H1-B: COG-intervallet är detsamma som systermetodens cogValid', () => {
  // Utan lås är spärren det enda skyddet — det är HÄR intervallkravet biter.
  // Målbron är KLAFFBRON med flit: isNorthCog(511/360/-5/700) är true (bandet
  // normaliserar inte), så den gamla grinden gav "norrut" ⇒ Stridsbergsbron.
  // Med Stridsbergsbron som utgångspunkt hade testet varit blint — där finns
  // ingen målbro norrut och null faller ut oavsett kurs.
  test.each([
    ['AIS 511 "ej tillgänglig"', 511],
    ['360 exakt (övre gränsen är EXKLUSIV)', 360],
    ['negativ kurs', -5],
    ['trasig parser', 700],
  ])('%s utan lås ⇒ null (inte Stridsbergsbron ur nordbandet)', (_label, cog) => {
    const svc = makeVDS();
    expect(svc._calculateNextTargetBridge({
      mmsi: '265111020', targetBridge: 'Klaffbron', cog, sog: 5,
    })).toBeNull();
  });

  test.each([
    ['0° (nedre gränsen är INKLUSIV)', 0, 'Stridsbergsbron'],
    ['359.9° (strax under övre gränsen)', 359.9, 'Stridsbergsbron'],
    ['180° rakt syd', 180, null],
  ])('giltig kurs %s är oförändrad', (_label, cog, expected) => {
    const svc = makeVDS();
    expect(svc._calculateNextTargetBridge({
      mmsi: '265111021', targetBridge: 'Klaffbron', cog, sog: 5,
    })).toBe(expected);
  });

  test('spökkurs 511 MED ruttlås: låset avgör, kursen får inte flippa riktningen', () => {
    const svc = makeVDS();
    expect(svc._calculateNextTargetBridge({
      mmsi: '265111022',
      targetBridge: 'Stridsbergsbron',
      cog: 511,
      sog: 4.5,
      _routeDirection: 'south',
    })).toBe('Klaffbron');
  });

  test('spökkurs 511 MED final-lås norrut ger nästa bro norrut', () => {
    const svc = makeVDS();
    expect(svc._calculateNextTargetBridge({
      mmsi: '265111023',
      targetBridge: 'Klaffbron',
      cog: 511,
      sog: 4.5,
      _finalTargetDirection: 'north',
    })).toBe('Stridsbergsbron');
  });

  test('OBEROENDE AV H34: systermetoden och H1-metoden underkänner SAMMA kurser', () => {
    const svc = makeVDS();
    // Södra kanalen, långt från broarna men innanför bounding box — positionen
    // ska inte vara det som fäller _calculateTargetBridge.
    const pos = { lat: 58.2800, lon: 12.2800, sog: 5 };
    for (const cog of [511, 360, -5, 700, NaN, null, undefined]) {
      expect(svc._calculateTargetBridge({ ...pos, mmsi: '265111024', cog })).toBeNull();
      expect(svc._calculateNextTargetBridge({
        ...pos, mmsi: '265111024', targetBridge: 'Klaffbron', cog,
      })).toBeNull();
    }
  });
});
