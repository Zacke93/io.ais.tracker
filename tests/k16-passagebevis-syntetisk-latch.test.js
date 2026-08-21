'use strict';

/**
 * K16 (fältprov 10, 2026-08-19) — DEN SYNTETISKA HÅLLNINGENS SAKNADE
 * INTRÄDESANKARE FABRICERADE EN PASSAGE OCH AVVÄPNADE EN ARMAD ÖPPNING.
 *
 * FÄLTFALLET (BALTIC JONGLEUR, MMSI 304028000, norrgående, rådata ur
 * app-20260819-081250.log):
 *   09:34:39.990  AIS 58.29192/12.29248  (41 m från Järnvägsbron, 216 m från
 *                 Stridsbergsbron) — Järnvägsbron-passagen detekteras och
 *                 _activateBridgeOpening öppnar 30 s-fönstret.
 *   09:34:39.999  🕒 [BRIDGE_OPENING] "Holding under-bridge state for
 *                 Järnvägsbron (30.0s remaining)" — StatusService latchar
 *                 under-bro SYNTETISKT, UTAN att sätta _underBridgeEntryLat/Lon.
 *   09:35:34.157  🌉 [INTERMEDIATE_UNDER] "41m from Järnvägsbron" — den RIKTIGA
 *                 latchen sätter ankaret bara när låset är OSATT, och låset var
 *                 redan satt ⇒ ankaret uteblir även här.
 *   09:35:49.642  AIS 58.29289/12.29381 (83 m från Stridsbergsbron, 82 m SÖDER
 *                 om brolinjen, 174 m från Järnvägsbron).
 *   09:35:49.643  🔍 [NO_PASSAGE] "-> Stridsbergsbron: prev=216m, curr=83m,
 *                 method=no_passage_detected, lineCross=not_crossed"
 *   09:35:49.645  ⚓ [ANCHOR_PASSAGE] "Anchored Stridsbergsbron crossing" — 2 ms
 *                 efter not_crossed. Entry↔exit-vakten läste hasEntry=false som
 *                 fail-open och ankrade på targetBridge.
 *   09:35:49.647  🔓 [OPENING_DISARM] "Stridsbergsbron avväpnad — passage
 *                 (d=216 m, varning redan skickad, armad 2034 s)" — den ÄKTA
 *                 passagen 69 s senare fick sitt ankare avvisat av
 *                 3-min-vakten. UNDER_BRIDGE_NO_CROSS loggades 0 gånger under
 *                 hela dygnet: vakten kunde aldrig ens utvärderas.
 *
 * FIXEN (StatusService.js, den syntetiska grenen i _isUnderBridge): ankra
 * fartygets position i latchögonblicket även där, så att den BEFINTLIGA
 * entry↔exit-vakten får två punkter att jämföra. Fail-open ligger kvar för
 * äkta okända (inget broobjekt / ingen position) — det här är INTE en
 * fail-closed-ändring.
 *
 * Testerna nedan är skrivna som mutationsprov: kommenteras de två raderna
 * `vessel._underBridgeEntryLat/_underBridgeEntryLon = vessel.lat/lon` bort
 * faller "fältfallet"-, "arv"- och "föräldralöst ankare"-testen (ankring i
 * stället för UNDER_BRIDGE_NO_CROSS), medan "andra sidan"-testet fortsätter
 * gå igenom — dvs. fixen stänger fabrikatet utan att stänga äkta passager.
 */

global.__TEST_MODE__ = true;

const geometry = require('../lib/utils/geometry');
const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const { BRIDGES } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;
const T0 = 1_700_000_000_000;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// Ren latitudförskjutning (samma hjälpare som under-bridge-segmentbevis-v2):
// positiva meter = norr om bron, negativa = söder.
const offsetLat = (bridge, meters) => ({
  lat: bridge.lat + meters / 111320,
  lon: bridge.lon,
});

describe('K16 — syntetisk BRIDGE_OPENING-hållning ankrar inträdespositionen', () => {
  let now;
  let statusService;
  let proximityService;
  let vesselDataService;
  let logger;

  const advance = (ms) => {
    now += ms;
  };

  const analyze = (vessel) => {
    const prox = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, prox);
    vessel.status = result.status;
    vessel.isWaiting = result.isWaiting;
    vessel.isApproaching = result.isApproaching;
    return result;
  };

  const place = (vessel, bridge, meters) => {
    const pos = offsetLat(bridge, meters);
    vessel.lat = pos.lat;
    vessel.lon = pos.lon;
  };

  const loggedTag = (tag) => logger.debug.mock.calls
    .some((c) => String(c[0]).includes(tag));

  const makeVessel = (overrides = {}) => ({
    mmsi: 304028000,
    name: 'BALTIC JONGLEUR',
    sog: 4.6,
    cog: 37,
    status: 'en-route',
    targetBridge: 'Stridsbergsbron',
    fixFeed: 'aishub',
    ...overrides,
  });

  beforeEach(() => {
    now = T0;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    logger = makeLogger();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    vesselDataService = { anchorPassageTimestamp: jest.fn() };
    statusService = new StatusService(
      bridgeRegistry, logger, systemCoordinator, vesselDataService,
      { shouldBlockStatus: jest.fn().mockReturnValue(false) },
    );
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  // ---------------------------------------------------------------------
  // 1. FÄLTFALLET — rådatakoordinater ur loggen, inga konstruerade siffror.
  // ---------------------------------------------------------------------
  describe('BALTIC JONGLEUR 09:34:39 → 09:35:49 (rådata)', () => {
    // 09:34:39.990Z — latchögonblicket. 41 m från Järnvägsbron, 216 m från
    // Stridsbergsbron (loggens egna "prev=216m").
    const LATCH_FIX = { lat: 58.29192, lon: 12.29248 };
    // 09:35:49.642Z — utgångsfixen. 83 m från Stridsbergsbron ("curr=83m"),
    // 174 m från Järnvägsbron ("now 174m away"), 82 m SÖDER om brolinjen.
    const EXIT_FIX = { lat: 58.29289, lon: 12.29381 };

    test('geometrin i testet ÄR fältets geometri (förankrar premissen)', () => {
      const jb = BRIDGES.jarnvagsbron;
      const sb = BRIDGES.stridsbergsbron;
      expect(geometry.calculateDistance(LATCH_FIX.lat, LATCH_FIX.lon, jb.lat, jb.lon))
        .toBeCloseTo(41, -0.5);
      expect(geometry.calculateDistance(LATCH_FIX.lat, LATCH_FIX.lon, sb.lat, sb.lon))
        .toBeCloseTo(216, -0.5);
      expect(geometry.calculateDistance(EXIT_FIX.lat, EXIT_FIX.lon, sb.lat, sb.lon))
        .toBeCloseTo(83, -0.5);
      // Båda fixarna ligger på SAMMA (södra) sida om Stridsbergsbrons linje —
      // det är hela poängen: ingen korsning har skett.
      expect(geometry.hasChangedBridgeSide(LATCH_FIX, EXIT_FIX, sb)).toBe(false);
      // Och segmentet kan inte heller bevisa en korsning.
      expect(geometry.isDecisivelyOppositeBridgeSide(LATCH_FIX, EXIT_FIX, sb)).toBe(false);
    });

    const runFieldCase = () => {
      const vessel = makeVessel();
      // 09:34:39.999 — Järnvägsbron-passagen har just aktiverat 30 s-fönstret.
      vessel.lat = LATCH_FIX.lat;
      vessel.lon = LATCH_FIX.lon;
      vessel.sog = 3.7;
      vessel.cog = 34.4;
      vessel._bridgeOpeningUntil = now + 30_000;
      vessel._bridgeOpeningBridgeName = 'Järnvägsbron';
      vessel.lastPassedBridge = 'Järnvägsbron';
      vessel.lastPassedBridgeTime = now;
      analyze(vessel);

      // 09:35:49.642 — nästa AIS-fix, 69,7 s senare. Fönstret har löpt ut.
      advance(69_652);
      vessel.lat = EXIT_FIX.lat;
      vessel.lon = EXIT_FIX.lon;
      vessel.sog = 4.6;
      vessel.cog = 37.5;
      // Speglar produktionens 🚢✅ [CURRENT_BRIDGE_PASSED] i samma tick
      // (VesselDataService nollar currentBridge när Järnvägsbron ligger 174 m
      // akterut) — därför faller ankringen tillbaka på targetBridge.
      vessel.currentBridge = null;
      vessel.distanceToCurrent = null;
      analyze(vessel);
      return vessel;
    };

    test('latchögonblicket sätter inträdesankaret (fixens 2 rader)', () => {
      const vessel = makeVessel({
        lat: LATCH_FIX.lat,
        lon: LATCH_FIX.lon,
        _bridgeOpeningUntil: now + 30_000,
        _bridgeOpeningBridgeName: 'Järnvägsbron',
      });
      const result = analyze(vessel);

      expect(result.status).toBe('under-bridge');
      expect(vessel._underBridgeLatched).toBe(true);
      expect(vessel.currentBridge).toBe('Järnvägsbron');
      expect(vessel._underBridgeEntryLat).toBe(LATCH_FIX.lat);
      expect(vessel._underBridgeEntryLon).toBe(LATCH_FIX.lon);
    });

    test('utgång på SAMMA sida ankrar INGEN passage (fabrikatet stängt)', () => {
      const vessel = runFieldCase();

      expect(vessel._underBridgeLatched).toBe(false);
      // Kärnan: ingen ⚓ [ANCHOR_PASSAGE] på Stridsbergsbron.
      expect(vesselDataService.anchorPassageTimestamp).not.toHaveBeenCalled();
      // Vakten BET — i fält loggades UNDER_BRIDGE_NO_CROSS 0 gånger på 19 h.
      expect(loggedTag('UNDER_BRIDGE_NO_CROSS')).toBe(true);
      // Zonepisoden städas som förut.
      expect(vessel._underBridgeEntryLat).toBeNull();
      expect(vessel._underBridgeEntryLon).toBeNull();
      expect(vessel._underBridgeCrossedBridge).toBeNull();
    });

    test('den äkta passagen 69 s senare kan fortfarande ankras', () => {
      // Fältets följd: 09:36:58 låg BALTIC JONGLEUR norr om Stridsbergsbron.
      // Utan det falska ankaret finns ingen 3-min-vakt att kollidera med, så
      // den riktiga passagen får sitt ankare.
      const vessel = runFieldCase();
      expect(vesselDataService.anchorPassageTimestamp).not.toHaveBeenCalled();

      advance(68_423); // 09:36:58.065
      vessel.lat = 58.29423;
      vessel.lon = 12.29581; // norr om Stridsbergsbron
      vessel.sog = 5.6;
      vessel.cog = 39.5;
      vessel.currentBridge = 'Stridsbergsbron';
      analyze(vessel);
      // Båten är nu >70 m norr om bron; nästa zonbesök/passage hanteras av de
      // ordinarie vägarna. Det enda testet låser är att inget FALSKT ankare
      // ligger kvar och blockerar dem.
      expect(vesselDataService.anchorPassageTimestamp)
        .not.toHaveBeenCalledWith(vessel, 'Stridsbergsbron', T0 + 69_652);
    });
  });

  // ---------------------------------------------------------------------
  // 2. ÄKTA PASSAGE UNDER FÖNSTRET — ankringen ska vara oförändrad.
  // ---------------------------------------------------------------------
  test('syntetisk hold → utgång på ANDRA sidan ankrar passagen som förut', () => {
    const bridge = BRIDGES.klaffbron;
    const vessel = makeVessel({ targetBridge: 'Klaffbron' });
    place(vessel, bridge, -100); // 100 m SÖDER om Klaffbron
    vessel._bridgeOpeningUntil = now + 30_000;
    vessel._bridgeOpeningBridgeName = 'Klaffbron';
    analyze(vessel);
    expect(vessel._underBridgeLatched).toBe(true);
    // MEDVETET ingen assertion på inträdesankaret här: det här testet ska
    // passera BÅDE med och utan fixen (mutationsprovet), för det är beviset
    // att fixen inte stänger äkta passager.

    advance(65_000); // fönstret utlöpt
    place(vessel, bridge, 120); // 120 m NORR — äkta korsning
    analyze(vessel);

    expect(vessel._underBridgeLatched).toBe(false);
    expect(vesselDataService.anchorPassageTimestamp)
      .toHaveBeenCalledWith(vessel, 'Klaffbron', now);
    expect(loggedTag('UNDER_BRIDGE_NO_CROSS')).toBe(false);
  });

  // ---------------------------------------------------------------------
  // 3. ARVET — den riktiga latchens ankare får aldrig skrivas över.
  // ---------------------------------------------------------------------
  test('riktig latch FÖRE syntetisk hold: inträdesankaret bevaras', () => {
    const bridge = BRIDGES.klaffbron;
    const vessel = makeVessel({ targetBridge: 'Klaffbron' });
    // Riktig TARGET_UNDER-latch på 30 m söder om bron.
    place(vessel, bridge, -30);
    analyze(vessel);
    expect(vessel._underBridgeLatched).toBe(true);
    const realEntryLat = vessel._underBridgeEntryLat;
    const realEntryLon = vessel._underBridgeEntryLon;
    expect(realEntryLat).toBeCloseTo(offsetLat(bridge, -30).lat, 10);

    // Broöppningsfönstret slår till medan låset redan är satt (produktionens
    // _activateBridgeOpening kan köra i samma tick som passagen detekteras).
    advance(20_000);
    place(vessel, bridge, 20); // båten har krupit förbi linjen
    vessel._bridgeOpeningUntil = now + 30_000;
    vessel._bridgeOpeningBridgeName = 'Klaffbron';
    analyze(vessel);

    expect(vessel._underBridgeLatched).toBe(true);
    expect(vessel._underBridgeEntryLat).toBe(realEntryLat);
    expect(vessel._underBridgeEntryLon).toBe(realEntryLon);
  });

  test('upprepade hold-tick behåller FÖRSTA ankaret (episodankare, inte senaste fix)', () => {
    const bridge = BRIDGES.klaffbron;
    const vessel = makeVessel({ targetBridge: 'Klaffbron' });
    place(vessel, bridge, -140);
    vessel._bridgeOpeningUntil = now + 30_000;
    vessel._bridgeOpeningBridgeName = 'Klaffbron';
    analyze(vessel);
    const firstEntryLat = vessel._underBridgeEntryLat;
    expect(firstEntryLat).toBeCloseTo(offsetLat(bridge, -140).lat, 10);

    advance(10_000);
    place(vessel, bridge, -60); // fönstret lever, båten rör sig
    analyze(vessel);

    expect(vessel._underBridgeLatched).toBe(true);
    expect(vessel._underBridgeEntryLat).toBe(firstEntryLat);
  });

  // ---------------------------------------------------------------------
  // 4. FÖRÄLDRALÖST ANKARE — ett ankare utan lås tillhör en avslutad episod.
  // ---------------------------------------------------------------------
  test('ankare utan lås (avbruten episod) ersätts av latchpositionen', () => {
    const bridge = BRIDGES.klaffbron;
    const vessel = makeVessel({ targetBridge: 'Klaffbron' });
    // Avståndsventilen (>300 m från öppningsbron) nollar låset men INTE
    // ankaret; ett kvarglömt ankare NORR om bron hade annars gjort nästa
    // syntetiska hållning till ett falskt sidbyte.
    const stale = offsetLat(bridge, 260);
    vessel._underBridgeLatched = false;
    vessel._underBridgeEntryLat = stale.lat;
    vessel._underBridgeEntryLon = stale.lon;

    place(vessel, bridge, -100); // ny episod, båten kommer söderifrån
    vessel._bridgeOpeningUntil = now + 30_000;
    vessel._bridgeOpeningBridgeName = 'Klaffbron';
    analyze(vessel);

    expect(vessel._underBridgeEntryLat).toBeCloseTo(offsetLat(bridge, -100).lat, 10);
    expect(vessel._underBridgeEntryLat).not.toBe(stale.lat);

    advance(65_000);
    place(vessel, bridge, -130); // driftar ut på SAMMA sida
    analyze(vessel);

    expect(vesselDataService.anchorPassageTimestamp).not.toHaveBeenCalled();
    expect(loggedTag('UNDER_BRIDGE_NO_CROSS')).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 5. FAIL-OPEN ÄR KVAR — fixen är INTE fail-closed.
  // ---------------------------------------------------------------------
  test('okänd bro (inget broobjekt) ankrar fortfarande — fail-open orört', () => {
    const bridge = BRIDGES.klaffbron;
    const vessel = makeVessel({ targetBridge: 'Klaffbron' });
    place(vessel, bridge, -100);
    vessel._bridgeOpeningUntil = now + 30_000;
    vessel._bridgeOpeningBridgeName = 'Klaffbron';
    analyze(vessel);
    // Även här: ingen ankar-assertion — testet ska passera både med och utan
    // fixen, eftersom det låser att fail-open-grenen är ORÖRD.

    // Registret svarar inte på bronamnet i utgångssteget (defensiv gren:
    // `!bridgeObj` ⇒ sideChanged=true ⇒ ankring som förut).
    const realLookup = statusService.bridgeRegistry.getBridgeByName
      .bind(statusService.bridgeRegistry);
    statusService.bridgeRegistry.getBridgeByName = (name) => (
      name === 'Klaffbron' ? null : realLookup(name)
    );
    advance(65_000);
    place(vessel, bridge, -130); // samma sida — men bron är okänd
    analyze(vessel);

    expect(vesselDataService.anchorPassageTimestamp)
      .toHaveBeenCalledWith(vessel, 'Klaffbron', now);
    expect(loggedTag('UNDER_BRIDGE_NO_CROSS')).toBe(false);
  });
});
