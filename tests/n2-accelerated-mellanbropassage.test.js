'use strict';

/**
 * N2 (helkodsgranskning RUNDA 5, 2026-08-23, major/RÖD, pre-existerande) —
 * ACCELERATED-TICKEN KÖRDE INGEN BROPASSAGEDETEKTERING ALLS.
 *
 * MEKANISMEN. Måltilldelningen ligger i en else-if-kedja med tre grenar (NY
 * båt, båt MED målbro, ACCELERATED = befintlig båt UTAN målbro som nu kvalar).
 * ACCELERATED-grenen sätter vessel.targetBridge, och de två mellanbroblocken
 * EFTER kedjan kräver båda att targetBridge SAKNAS. Tickens EGET segment
 * prövades därför aldrig mot någon brolinje, och _handleTargetBridgeTransition
 * kördes inte heller (kedjan hade tagit ACCELERATED-grenen). Nästa tick har ett
 * NYTT segment som inte längre spänner bron ⇒ passagen är PERMANENT förlorad.
 * Failsafen i app.js kräver latitudhopp över 556 m och täcker inte segmentet.
 *
 * RÅDATAFALLET som riggen nedan speglar: HOKUS POKUS 219028819 i korpus
 * 20260611-4h låg 55 m SÖDER om Järnvägsbron och 90 m NORR i nästa sampel
 * (gt-passages: kind=line, inferred=false, dp=55, dq=90, stepM=145, dir=nord,
 * 2026-06-11T09:57:18.647Z). Samma tick tilldelade ACCELERATED Stridsbergsbron.
 *
 * MÄTT ISOLERAT (endast N2, två isolerade träd, alla 18 korpusar):
 *  • notisANTALET oförändrat i samtliga korpusar.
 *  • 5 NYA mellanbropassager, alla rådataverifierade i gt-passages som
 *    kind=line/inferred=false med sampel på båda sidor: HOKUS POKUS/Järnvägsbron,
 *    BLADE/Stridsbergsbron + BLADE/Järnvägsbron, HEY JOE/Järnvägsbron,
 *    ANYA ELAN 380/Järnvägsbron.
 *  • 6 brotextrader rör sig i 4 korpusar (varav 2 är rena 15 ms-tidsskift).
 *  • Ett HÅRT invariantbrott FÖRSVINNER i den olåsta 42h-korpusen:
 *    "MÅLBRO SOM MELLANBRO 211214850" — MOKENDEIST:s Stridsbergsbron bokförs
 *    numera 17 s efter den verkliga korsningen i stället för 2 min 33 s efter.
 *  • ETA-noggrannheten mot rådatafacit (measureEtaAccuracy, alla korpusar):
 *    summa|fel| 28584,7 → 28594,1 min över 1724 påståenden (+0,03 %), medan
 *    20260611-4h går från median 3,14 → 0,14 min och 33 % → 100 % inom 2 min.
 *
 * ORDNINGEN: detekteringen körs FÖRE _calculateTargetBridge, alltså medan
 * vessel.targetBridge är null. Det gör grenen till en exakt spegel av det
 * mållösa MOSHE-blocket: ingen bro skippas som "målbro" och RC9-blocket
 * (MISSED_TARGET_INFERRED) är inert, så en nyss tilldelad målbro kan inte
 * omedelbart rivas av sin egen tilldelningstick.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

const M_PER_DEG_LAT = 111320;
// Registrets egna koordinater (ingen ny konstant — läses ur BridgeRegistry i
// riggen nedan, talen här är bara för läsbarhet i kommentarerna).
const JARNVAGSBRON = 'Järnvägsbron';
const STRIDSBERGSBRON = 'Stridsbergsbron';
const STALLBACKABRON = 'Stallbackabron';

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
  // Räknare för hur många gånger mellanbrodetekteringen körs per tick — det är
  // BÅDE buggen (0 gånger) och risken med fixen (2 gånger) som mäts här.
  svc._nAnrop = 0;
  const orig = svc._handleIntermediateBridgePassage.bind(svc);
  svc._handleIntermediateBridgePassage = (v, o) => {
    svc._nAnrop++;
    return orig(v, o);
  };
  liveServices.push(svc);
  return svc;
}

/**
 * Två sampel som spänner en brolinje: söder om bron, sedan norr om den.
 * @param {Object} svc - VesselDataService
 * @param {string} bronsNamn - brons namn i registret
 * @param {string} mmsi - fartygets mmsi
 * @param {number} sogFore - fart i första samplet (låg ⇒ ingen målbro ännu)
 * @param {number} sogEfter - fart i andra samplet (ACCELERATED-samplet)
 * @returns {Object} fartygsobjektet efter andra samplet
 */
function korsaLinjen(svc, bronsNamn, mmsi, sogFore, sogEfter) {
  const bron = svc.bridgeRegistry.getBridgeByName(bronsNamn);
  const skicka = (nordM, sog, dt) => {
    NOW += dt;
    svc.updateVessel(mmsi, {
      mmsi,
      lat: bron.lat + nordM / M_PER_DEG_LAT,
      lon: bron.lon,
      sog,
      cog: 10, // norrut
      name: 'HOKUS POKUS',
      timestamp: NOW,
    });
    return svc.vessels.get(mmsi);
  };
  // HOKUS POKUS egna avstånd: 55 m söder, 90 m norr, 118 s emellan.
  skicka(-55, sogFore, 0);
  return skicka(90, sogEfter, 118000);
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

beforeEach(() => {
  NOW = 1781171760000; // 2026-06-11T09:56:00Z — HOKUS POKUS egen tid
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

describe('N2: ACCELERATED-ticken prövar sitt eget segment mot brolinjerna', () => {
  test('HOKUS POKUS-fallet: passagen bokförs i SAMMA tick som målbron tilldelas', () => {
    const svc = makeVDS();
    const v = korsaLinjen(svc, JARNVAGSBRON, '219028819', 0.2, 5.0);
    // Riggkontroll: ticken MÅSTE ha gått genom ACCELERATED-grenen, annars
    // prövar testet en annan väg än den buggen satt i.
    expect(v.targetBridge).toBe(STRIDSBERGSBRON);
    // KÄRNAN: på HEAD var passedBridges TOM och detekteringen kördes 0 gånger.
    expect(v.passedBridges).toContain(JARNVAGSBRON);
    expect(v.lastPassedBridge).toBe(JARNVAGSBRON);
    expect(svc._nAnrop).toBe(1);
    // Den NYSS tilldelade målbron får aldrig bokföras som mellanbro.
    expect(v.passedBridges).not.toContain(STRIDSBERGSBRON);
  });

  test('EXAKT ETT anrop per tick — flaggan hindrar dubbelkörning på den mållösa vägen', () => {
    // Här faller ticken igenom kedjan (ingen målbro kvalar norr om
    // Stallbackabron) och det EFTERFÖLJANDE mellanbroblocket tar passagen.
    // Anropsräknaren låser att exakt ETT av de tre ställena kör.
    const svc = makeVDS();
    const v = korsaLinjen(svc, STALLBACKABRON, '265900099', 0.2, 5.0);
    expect(v.targetBridge).toBeNull();
    expect(v.passedBridges).toEqual([STALLBACKABRON]);
    expect(svc._nAnrop).toBe(1);
  });

  test('GATEN ÄR OFÖRÄNDRAD: ett gråzonssampel utan rörelsebevis ger ingen passage', () => {
    // Samma geometri, men andra samplet ligger under MOVEMENT_PROOF_SOG_KN och
    // fartyget har inget klistrande rörelsebevis. Villkoret är kopierat ord för
    // ord från systerblocken, så jitter vid brolinjen kan inte fabricera en
    // passage — uppmätt IDENTISKT i båda armarna.
    const svc = makeVDS();
    const v = korsaLinjen(svc, JARNVAGSBRON, '219028820', 0.2, 0.4);
    expect(v.passedBridges).toEqual([]);
    expect(svc._nAnrop).toBe(0);
  });

  test('ACCELERATED-grenens EGET arbete är orört: målbro, ruttlås och reseorigo', () => {
    const svc = makeVDS();
    const v = korsaLinjen(svc, JARNVAGSBRON, '219028821', 0.2, 5.0);
    expect(v.targetBridge).toBe(STRIDSBERGSBRON);
    expect(v._routeDirection).toBe('north');
    // H12: måltilldelningen ankrar resans origo (_extendJourneyOrigin). Läs det
    // genom servicens egen accessor — fältet är internt och heter inte som
    // metoden.
    expect(Number.isFinite(svc._journeyOriginLat(v))).toBe(true);
  });
});
