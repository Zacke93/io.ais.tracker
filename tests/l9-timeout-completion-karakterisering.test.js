'use strict';

/**
 * L9 (helkodsgranskning RUNDA 3, 2026-08-22, major/RÖD) — KARAKTERISERINGSTEST.
 *
 * FYNDET: `isCompletedTimeout` (VesselDataService.removeVessel) bokför en
 * AVSLUTAD RESA enbart på `reason === 'timeout'` + saknad målbro + Olidebron
 * eller Stallbackabron i `passedBridges`. Sanningskällan
 * `VesselLifecycleManager.hasCompletedJourney` kräver DESSUTOM att fartyget
 * lämnat terminalzonen (syd: lat < KANALINFARTEN_EXIT_LAT 58,2653; nord:
 * lat > STALLBACKABRON_EXIT_LAT 58,3125) och motiverar latgrinden uttryckligen
 * med att Kanalinfarten-notisen annars aldrig hinner fyra. Timeout-vägen
 * utelämnar båda grindarna, skriver `_completedJourneys` och armerar
 * 10-minutersblocket högst upp i `updateVessel` — en båt som VÄNDER eller
 * ligger still INNANFÖR utfarten får därför en total AIS-blackout på 10 min
 * (både boat_near och bridge_opening_soon uteblir).
 *
 * ÅTGÄRDEN ÄR ÅTERKALLAD — MEDVETET, PÅ MÄTNING. Uppdragets acceptanskrav var
 * att journeyResets/removals/rebirths inte får ÖKA i någon korpus. Åtstramningen
 * uppfyller inte det: rad ~1004 gatar gravläggningen på `!isCompletedTimeout`,
 * så varje resa som inte längre räknas som avslutad hamnar i graven i stället.
 * Uppmätt i isolerat träd (HEAD + L1 + L5, enda skillnaden = grinden), alla 18
 * korpusar, ~320 h fältdata:
 *
 *   VESSEL_REENTRY_BLOCK  116 → 66   (vinsten: −50, −43 %)
 *   JOURNEY_RESET          31 → 13
 *   COMPLETED_JOURNEY     144 → 66
 *   GRAVE_INHERIT       1 615 → 1 650 (+35 — ÖKAR i 5 korpusar: 25h +1,
 *                                      41h +9, 17h +8, both-21h +6, 42h +11)
 *   VESSEL_REMOVED      2 468 → 2 496 (+28)
 *   GRAVE_SKIP             45 → 49   (+4)
 *
 * Notis- och öppningsmultiseten var OFÖRÄNDRADE i samtliga 18 korpusar; enda
 * textrörelsen var en tidsstämpel i 20260804-17h (idx 96, −19,6 s, identisk
 * text). Två varianter mättes — (A) `hasCompletedJourney()` och (B) enbart de
 * två latitudgrindarna — med IDENTISKA siffror, så kostnaden kommer från
 * latitudgrinden, inte från `lastPassedBridge`-kravet.
 *
 * Testet låser alltså DAGENS beteende, inklusive felmoden, så att nästa runda
 * inte behöver återupptäcka den — och så att en framtida åtstramning måste
 * vända assertionerna medvetet. Se rapporten för föreslagen klassregel.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

// KANALINFARTEN_EXIT_LAT är 58,2653 (VesselLifecycleManager). 58,2700 ligger
// 52 m NORR om den — alltså INNANFÖR utfarten, fortfarande i kanalen.
const INNANFOR_UTFARTEN = { lat: 58.2700, lon: 12.2700 };

function makeLogger() {
  return {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };
}

describe('L9: timeout-completion utan terminalpositionskontroll (karakterisering)', () => {
  let svc;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-22T10:00:00.000Z'));
    logger = makeLogger();
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = { gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null };
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  function seedSouthboundInsideExit(mmsi) {
    svc.vessels.set(mmsi, {
      mmsi,
      lat: INNANFOR_UTFARTEN.lat,
      lon: INNANFOR_UTFARTEN.lon,
      sog: 0,
      cog: 200,
      status: 'en-route',
      targetBridge: null,
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
      passedBridges: ['Klaffbron', 'Olidebron'],
      lastPassedBridge: 'Olidebron',
      _routeDirection: 'south',
    });
  }

  test('DE TVÅ REGLERNA SÄGER EMOT VARANDRA — och det är timeout-vägen som är lösast', () => {
    const mmsi = '265900901';
    seedSouthboundInsideExit(mmsi);
    const vessel = svc.vessels.get(mmsi);
    // Sanningskällan: resan är INTE avslutad — båten är kvar innanför utfarten.
    expect(svc.vesselLifecycleManager.hasCompletedJourney(vessel)).toBe(false);
    // Timeout-vägen bokför den ändå som avslutad (DAGENS beteende).
    svc.removeVessel(mmsi, 'timeout');
    expect(svc._completedJourneys.has(mmsi)).toBe(true);
  });

  test('FÖLJDEN: 10 minuters total AIS-blackout för en båt som vänder innanför utfarten', () => {
    const mmsi = '265900902';
    seedSouthboundInsideExit(mmsi);
    svc.removeVessel(mmsi, 'timeout');

    // U-svängen: båten går norrut igen i 8 kn, mitt i kanalen.
    for (let i = 0; i < 16; i++) {
      jest.advanceTimersByTime(30 * 1000);
      const res = svc.updateVessel(mmsi, {
        mmsi,
        lat: INNANFOR_UTFARTEN.lat + i * 0.0011, // ~122 m per sampel
        lon: INNANFOR_UTFARTEN.lon,
        sog: 8,
        cog: 20,
        name: 'L9-PROV',
        timestamp: Date.now(),
      });
      expect(res).toBeNull(); // avvisad av reentry-blocket
    }
    const blocked = logger.debug.mock.calls
      .map((a) => String(a[0]))
      .filter((l) => l.includes('VESSEL_REENTRY_BLOCK'));
    expect(blocked.length).toBe(16);
    expect(svc.vessels.has(mmsi)).toBe(false);

    // Först efter 10 min släpps hon in igen.
    jest.advanceTimersByTime(10 * 60 * 1000);
    const after = svc.updateVessel(mmsi, {
      mmsi, lat: INNANFOR_UTFARTEN.lat + 0.02, lon: INNANFOR_UTFARTEN.lon, sog: 8, cog: 20, name: 'L9-PROV', timestamp: Date.now(),
    });
    expect(after).not.toBeNull();
  });

  test('GRAVGATEN är den andra halvan av avvägningen: completed ⇒ INGEN grav', () => {
    // Rad ~1004: `if (reason === 'timeout' && !staleAisForcedRemoval
    // && !isCompletedTimeout && !isJourneyComplete) this._buryVessel(...)`.
    // En åtstramad completed-regel flyttar alltså båtar FRÅN completed-posten
    // TILL graven — och gravläggning + återfödelse ÄR remove/recreate-churnen
    // som P9:s Fix 2 infördes för att stoppa. Uppmätt: GRAVE_INHERIT +35,
    // VESSEL_REMOVED +28 över 18 korpusar.
    const mmsi = '265900903';
    seedSouthboundInsideExit(mmsi);
    svc.removeVessel(mmsi, 'timeout');
    expect(svc._completedJourneys.has(mmsi)).toBe(true);
    expect(svc._vesselGraves.has(mmsi)).toBe(false);
  });

  test('UTANFÖR utfarten är de två reglerna redan överens (ingen konflikt att lösa)', () => {
    const mmsi = '265900904';
    seedSouthboundInsideExit(mmsi);
    const vessel = svc.vessels.get(mmsi);
    vessel.lat = 58.2600; // söder om KANALINFARTEN_EXIT_LAT
    expect(svc.vesselLifecycleManager.hasCompletedJourney(vessel)).toBe(true);
    svc.removeVessel(mmsi, 'timeout');
    expect(svc._completedJourneys.has(mmsi)).toBe(true);
  });

  test('MÅLLÖS HALVRESA bokförs fortfarande INTE som avslutad (LYS-skärpningen står kvar)', () => {
    // Fältprov 2026-07-07 (LYS 10:14): en resa är avslutad först när SISTA bron
    // i färdriktningen passerats. Utan Olidebron i passedBridges ⇒ ingen post.
    const mmsi = '265900905';
    seedSouthboundInsideExit(mmsi);
    const vessel = svc.vessels.get(mmsi);
    vessel.passedBridges = ['Klaffbron'];
    vessel.lastPassedBridge = 'Klaffbron';
    svc.removeVessel(mmsi, 'timeout');
    expect(svc._completedJourneys.has(mmsi)).toBe(false);
    expect(svc._vesselGraves.has(mmsi)).toBe(true); // hamnar i graven i stället
  });
});
