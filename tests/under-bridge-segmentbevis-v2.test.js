'use strict';

/**
 * V2 — SEGMENTBEVIS FÖR UNDER-BRO-ZONEN (A/B-nattkörningen 2026-08-03).
 *
 * Bakgrund: med tät sampling (dubbelkälla, ~68 s kadens) kan det fix som landar
 * inne i under-bro-zonen redan ligga BORTOM brolinjen. Då blir ingångs- OCH
 * utgångssidan densamma, entry↔exit-jämförelsen läser en äkta passage som
 * kö-drift (UNDER_BRIDGE_NO_CROSS) och METHOD 1:s sidbyteskrav faller på
 * utgångssteget — hela passagen tappas.
 *
 * Nattens rådata (TIM, 212571000, norrgående):
 *   Olidebron    22:25:12 -98 m → 22:26:19 +16 m → 22:27:23 +123 m
 *   Järnvägsbron 22:45:34 -68 m → 22:46:03 +16 m → 22:46:42 +105 m
 * Båda mellanbropassagerna åts upp, ETA-motorn låg kvar i progressive_route med
 * ett växande "bakben" till bron akterut och Klaffbron-texten klättrade
 * 12→13→12→14→15→16→17 min medan båten närmade sig (+10,2 min maxfel).
 *
 * Fixen (omarbetad i granskningsrunda 2): korsar ett konsekutivfix-segment
 * brolinjen KORRIGERAS zonbesökets INTRÄDESANKARE till segmentets startpunkt.
 * Beslutet fattas därefter av den BEFINTLIGA entry↔exit-vakten (nettosidbyte),
 * både i ankringen och i geometry METHOD 1. Ett rent booleskt "bron korsades"
 * hade fabricerat passager för U-svängar och för kajbrus över linjen —
 * nettokravet gör båda ofarliga. Metoderna 4/5/6 behåller det råa
 * sidbyteskravet.
 *
 * KÄLLGRIND (batterirunda 1, omformulerad i granskningsrunda 2): beviset
 * stämplas bara när ANDRAKÄLLAN MATAR fartyget (senaste aishub-fix inom
 * UNDER_BRIDGE_CROSS_PROOF_FEED_TTL_MS) — inte "minst ett av segmentets två
 * fix". Segmentformuleringen gjorde fixen latensberoende: fusionens F6-grind
 * äter just de släpande hub-fixar som annars stod i segmentet, och beviset
 * uteblev vid +30/+60 s leveranslagg trots oförändrat giltig geometri.
 * Rotorsaken är källneutral, men enkelkälleläget är facit-låst — fyra golden-
 * texter innehåller fem äkta men tappade Olidebron-passager. Grinden håller
 * enkelkälleläget BIT-IDENTISKT tills en omlåsning beslutats.
 */

global.__TEST_MODE__ = true;

const geometry = require('../lib/utils/geometry');
const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const VesselDataService = require('../lib/services/VesselDataService');
const {
  BRIDGES,
  UNDER_BRIDGE_CROSS_SEGMENT_MAX_M,
  UNDER_BRIDGE_CROSS_PROOF_FEED_TTL_MS,
} = require('../lib/constants');

const REAL_DATE_NOW = Date.now;
const T0 = 1_700_000_000_000;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// Ren latitudförskjutning: avståndet är |meter| och projektionen på kanalaxeln
// (perpBearing 40°) blir meter * cos(40°) ≈ 0,766 * meter. Norr om bron ⇒
// projektionen positiv, söder ⇒ negativ.
const offsetLat = (bridge, meters) => ({
  lat: bridge.lat + meters / 111320,
  lon: bridge.lon,
});

describe('V2 — geometry METHOD 1 konsumerar segmentbeviset', () => {
  const bridge = BRIDGES.olidebron;
  // TIM:s utgångssteg: föregående fix 21 m NORR om bron (proj +16, alltså redan
  // bortom brolinjen), nuvarande 120 m norr. Ingen sidväxling i detta segment.
  const prevPos = offsetLat(bridge, 21);
  const currPos = offsetLat(bridge, 120);

  const mk = (pos, extra = {}) => ({
    lat: pos.lat, lon: pos.lon, sog: 3.4, cog: 20, ...extra,
  });

  test('utan bevis: utgångssteget ger INGEN passage (buggens premiss)', () => {
    const res = geometry.detectBridgePassage(mk(currPos), mk(prevPos), bridge);
    expect(res.passed).toBe(false);
    expect(res.method).toBe('no_passage_detected');
  });

  // Det korrigerade inträdesankaret: 98 m SÖDER om bron (den sida TIM kom
  // ifrån). Nettosidbytet ankare→nuvarande är då entydigt.
  const nearSideAnchor = offsetLat(bridge, -98);
  const proven = {
    _underBridgeCrossedBridge: 'Olidebron',
    _underBridgeEntryLat: nearSideAnchor.lat,
    _underBridgeEntryLon: nearSideAnchor.lon,
  };

  test('med bevis för SAMMA bro: METHOD 1 fyrar (traditional_close_passage)', () => {
    const res = geometry.detectBridgePassage(mk(currPos, proven), mk(prevPos), bridge);
    expect(res.passed).toBe(true);
    expect(res.method).toBe('traditional_close_passage');
  });

  test('bevis för ANNAN bro påverkar inte — beviset är brospecifikt', () => {
    const res = geometry.detectBridgePassage(
      mk(currPos, { ...proven, _underBridgeCrossedBridge: 'Järnvägsbron' }), mk(prevPos), bridge,
    );
    expect(res.passed).toBe(false);
  });

  test('bevis UTAN nettosidbyte fyrar INTE — U-svängen/kajbruset (granskningsrunda 2)', () => {
    // Båten korsade linjen någon gång under zonbesöket men VÄNDE och lämnar nu
    // på ingångssidan. Med ett rent booleskt bevis hade METHOD 1 gett
    // traditional_close_passage conf 0,95 — exakt den CLABBYDOO-klass
    // hasChangedBridgeSide en gång infördes för.
    const backPrev = offsetLat(bridge, -25);
    const backCurr = offsetLat(bridge, -110);
    const res = geometry.detectBridgePassage(mk(backCurr, proven), mk(backPrev), bridge);
    expect(res.passed).toBe(false);
  });

  test('bevis utan inträdesankare fyrar INTE (defensivt)', () => {
    const res = geometry.detectBridgePassage(
      mk(currPos, { _underBridgeCrossedBridge: 'Olidebron' }), mk(prevPos), bridge,
    );
    expect(res.passed).toBe(false);
  });

  test('beviset ersätter ENDAST sidbytet — METHOD 1:s egna villkor gäller', () => {
    // Rör sig MOT bron (120 m → 21 m): isNowFarther falskt ⇒ ingen passage
    // trots bevis. Skyddar mot att beviset "hänger kvar" och fabricerar en
    // passage för en båt som vänder tillbaka in i zonen.
    const towards = geometry.detectBridgePassage(
      mk(prevPos, { _underBridgeCrossedBridge: 'Olidebron' }), mk(currPos), bridge,
    );
    expect(towards.passed).toBe(false);

    // Föregående fix UTANFÖR zonen (200 m norr ⇒ wasVeryClose falskt).
    const farPrev = offsetLat(bridge, 200);
    const farRes = geometry.detectBridgePassage(
      mk(offsetLat(bridge, 400), { _underBridgeCrossedBridge: 'Olidebron' }), mk(farPrev), bridge,
    );
    expect(farRes.passed).toBe(false);
  });

  test('kö-drift på samma sida utan bevis förblir ingen passage (2026-07-03-låset)', () => {
    const inZone = offsetLat(bridge, -30); // 30 m söder, proj -23
    const outZone = offsetLat(bridge, -90); // driftar ut söderut igen
    const res = geometry.detectBridgePassage(mk(outZone), mk(inZone), bridge);
    expect(res.passed).toBe(false);
  });
});

describe('V2 — StatusService bygger och konsumerar segmentbeviset', () => {
  let now;
  let statusService;
  let proximityService;
  let vesselDataService;
  let logger;

  const advance = (ms) => {
    now += ms;
  };

  const analyze = (vessel, positionAnalysis = null) => {
    const prox = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, prox, positionAnalysis);
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

  const makeVessel = (overrides = {}) => ({
    mmsi: 212571000,
    name: 'TIM',
    sog: 3.4,
    cog: 20,
    status: 'en-route',
    targetBridge: 'Klaffbron',
    // Nattens TIM-fall låg i dubbelkälleläget: Olidebron aishub→aishub,
    // Järnvägsbron aishub→aisstream. Källgrinden kräver att andrakällan
    // medverkat i segmentet.
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

  // Kör TIM:s Olidebron-sekvens: 98 m söder → 21 m norr (latch) → 120 m norr.
  const runTimSequence = (vessel) => {
    place(vessel, BRIDGES.olidebron, -98);
    analyze(vessel);
    advance(67_000);
    place(vessel, BRIDGES.olidebron, 21);
    analyze(vessel);
  };

  test('inträdessteget (-98 m → +21 m) sätter beviset trots att fixen landar bortom linjen', () => {
    const vessel = makeVessel();
    runTimSequence(vessel);

    expect(vessel._underBridgeLatched).toBe(true);
    expect(vessel._underBridgeCrossedBridge).toBe('Olidebron');
    // Latch-fixen låg BORTOM linjen (+21 m norr) — hela buggens premiss. Beviset
    // flyttar därför ankaret till segmentets startpunkt, 98 m SÖDER om bron.
    expect(vessel._underBridgeEntryLat).toBeLessThan(BRIDGES.olidebron.lat);
  });

  test('U-SVÄNG: återkorsning flyttar INTE tillbaka ankaret ⇒ ingen ankring', () => {
    // AKIRA-låset i den nya situationen: båten korsar linjen, vänder och
    // lämnar zonen på ingångssidan. Ankaret korrigeras EN gång per zonbesök,
    // så entry↔exit ser samma sida och passagen ankras aldrig.
    const vessel = makeVessel();
    runTimSequence(vessel); // -98 → +21 (bevis, ankare flyttat till -98)
    expect(vessel._underBridgeCrossedBridge).toBe('Olidebron');

    advance(60_000);
    place(vessel, BRIDGES.olidebron, -25); // tillbaka SÖDER om linjen
    analyze(vessel);
    advance(60_000);
    place(vessel, BRIDGES.olidebron, -120); // ut ur zonen på INGÅNGSSIDAN
    analyze(vessel);

    expect(vesselDataService.anchorPassageTimestamp).not.toHaveBeenCalled();
    const noCrossLog = logger.debug.mock.calls
      .some((c) => String(c[0]).includes('UNDER_BRIDGE_NO_CROSS'));
    expect(noCrossLog).toBe(true);
  });

  test('JITTER: två bevisat stillaliggande sampel ger inget bevis (CG2-1-spegeln)', () => {
    // Class B-multipath hos en kajliggare/köande båt: 20-40 m brus tvärs
    // brolinjen med sog under 0,3 kn i båda ändarna.
    const vessel = makeVessel({ sog: 0.2 });
    place(vessel, BRIDGES.klaffbron, -20);
    analyze(vessel);
    advance(60_000);
    place(vessel, BRIDGES.klaffbron, 18); // 38 m förflyttning tvärs linjen
    analyze(vessel);

    expect(vessel._underBridgeCrossedBridge).toBeNull();
    const jitterLog = logger.debug.mock.calls
      .some((c) => String(c[0]).includes('UNDER_BRIDGE_CROSS_JITTER'));
    expect(jitterLog).toBe(true);
  });

  test('GPS-HOPP I SAMMA TICK sätter inget bevis (nollningen räckte inte)', () => {
    // Nollningen i analyzeVesselStatus ligger FÖRE _isUnderBridge, så hoppets
    // EGET segment kunde stämpla beviset i samma pass. VesselDataService
    // accepterar hoppositionen ("still accept new position"), så scenariot är
    // reachable i produktion.
    const vessel = makeVessel();
    place(vessel, BRIDGES.klaffbron, -250);
    analyze(vessel);
    advance(60_000);
    place(vessel, BRIDGES.klaffbron, 40);
    analyze(vessel, { gpsJumpDetected: true, analysis: { movementDistance: 290 } });

    expect(vessel._underBridgeCrossedBridge).toBeNull();
  });

  test('utgång på samma sida ankras nu via beviset (UNDER_BRIDGE_SEGMENT_CROSS)', () => {
    const vessel = makeVessel();
    runTimSequence(vessel);

    advance(64_000);
    place(vessel, BRIDGES.olidebron, 120); // ut ur zonen, fortfarande NORR
    analyze(vessel);

    expect(vessel._underBridgeLatched).toBe(false);
    expect(vesselDataService.anchorPassageTimestamp)
      .toHaveBeenCalledWith(vessel, 'Olidebron', now);
    const segmentLog = logger.debug.mock.calls
      .some((c) => String(c[0]).includes('UNDER_BRIDGE_SEGMENT_CROSS'));
    expect(segmentLog).toBe(true);
    // Beviset konsumeras och nollas när episoden avslutas.
    expect(vessel._underBridgeCrossedBridge).toBeNull();
  });

  test('kö-drift in och ut på SAMMA sida ger inget bevis och ingen ankring', () => {
    // Regressionslås för produktionsredo-fixen 2026-07-03: en köande båt som
    // kryper in i zonen och driftar ut söderut igen får ALDRIG en passage.
    const vessel = makeVessel();
    place(vessel, BRIDGES.olidebron, -120);
    analyze(vessel);
    advance(60_000);
    place(vessel, BRIDGES.olidebron, -30); // in i zonen, söder om linjen
    analyze(vessel);
    expect(vessel._underBridgeLatched).toBe(true);
    expect(vessel._underBridgeCrossedBridge).toBeNull();

    advance(60_000);
    place(vessel, BRIDGES.olidebron, -90); // ut igen, SAMMA sida
    analyze(vessel);

    expect(vesselDataService.anchorPassageTimestamp).not.toHaveBeenCalled();
    const noCrossLog = logger.debug.mock.calls
      .some((c) => String(c[0]).includes('UNDER_BRIDGE_NO_CROSS'));
    expect(noCrossLog).toBe(true);
  });

  test(`segment längre än ${UNDER_BRIDGE_CROSS_SEGMENT_MAX_M} m räknas som AIS-glapp — inget bevis`, () => {
    const vessel = makeVessel();
    place(vessel, BRIDGES.olidebron, -(UNDER_BRIDGE_CROSS_SEGMENT_MAX_M + 100));
    analyze(vessel);
    advance(600_000); // glapp
    place(vessel, BRIDGES.olidebron, 21);
    analyze(vessel);

    expect(vessel._underBridgeLatched).toBe(true);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
  });

  test('GPS-hopp nollar beviset — "sidbytet" är då hoppet, inte en passage', () => {
    const vessel = makeVessel();
    runTimSequence(vessel);
    expect(vessel._underBridgeCrossedBridge).toBe('Olidebron');

    analyze(vessel, { gpsJumpDetected: true, analysis: { movementDistance: 800 } });
    expect(vessel._underBridgeCrossedBridge).toBeNull();
  });

  test('hysteresreset (målbrobyte) nollar beviset så det inte spiller till nästa bro', () => {
    const vessel = makeVessel();
    runTimSequence(vessel);
    expect(vessel._underBridgeCrossedBridge).toBe('Olidebron');

    vessel.targetBridge = 'Stridsbergsbron';
    analyze(vessel);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
  });

  test('ENKELKÄLLA får bevis — ALICE 2026-07-12 återvunnen (breddningen 2026-08-03)', () => {
    // Korpus 20260711-16h, 244790715 ALICE, Olidebron 12:45:02→12:45:49→12:47:01:
    // proj -76 m → +12 m → +142 m. Exakt samma signatur som TIM, men båda fixen
    // kom från aisstream. FÖRE breddningen (källgrind 'aishub') tappades
    // passagen — en av FEM rådataverifierade äkta missar (NORDIC SOLA, ORANESS,
    // CATHARINA, ALICE, EXCALIBUR). Användarbeslutet 2026-08-03 satte
    // UNDER_BRIDGE_CROSS_PROOF_REQUIRED_FEED = null och golden-texten i de
    // fyra berörda korpusarna omlåstes (notis-/fördelnings-/riktningsfacit
    // byte-identiska). Testet låser numera ÅTERVINNINGEN.
    const vessel = makeVessel({ mmsi: 244790715, name: 'ALICE', fixFeed: 'aisstream' });
    place(vessel, BRIDGES.olidebron, -99); // proj -76
    analyze(vessel);
    advance(47_000);
    place(vessel, BRIDGES.olidebron, 16); // proj +12, inne i zonen
    analyze(vessel);

    expect(vessel._underBridgeLatched).toBe(true);
    // Inträdessteget korsade brolinjen ⇒ beviset stämplas trots enkelkälla.
    expect(vessel._underBridgeCrossedBridge).toBe('Olidebron');

    advance(72_000);
    // Ut ur zonen på SAMMA (bortre) sida, inom ANCHOR_MAX_DISTANCE_M (150 m) —
    // korpusens verkliga utträdesfix låg också inom ankringsfönstret.
    place(vessel, BRIDGES.olidebron, 120);
    analyze(vessel);

    // Med korrigerat inträdesankare ser entry↔exit-vakten nettosidbytet vid
    // zonutträdet och ankrar passagen — den historiska missen är återvunnen.
    // (Ankarfälten och stämpeln konsumeras och nollas när episoden avslutas,
    // samma kontrakt som TIM-testet ovan.)
    expect(vesselDataService.anchorPassageTimestamp)
      .toHaveBeenCalledWith(vessel, 'Olidebron', expect.any(Number));
    expect(vessel._underBridgeCrossedBridge).toBeNull();
  });

  test('KORSKÄLLA räcker — TIM/Järnvägsbron levererades aishub→aisstream', () => {
    const vessel = makeVessel({ fixFeed: 'aishub' });
    place(vessel, BRIDGES.jarnvagsbron, -89); // proj -68
    analyze(vessel);
    advance(29_000);
    vessel.fixFeed = 'aisstream'; // nästa fix kom från streamen
    place(vessel, BRIDGES.jarnvagsbron, 21); // proj +16
    analyze(vessel);

    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
  });

  test('KÄLLNÄRVARO: BÅDA fixen aisstream räcker om hubben matat nyligen (latensfixen)', () => {
    // Granskningsrunda 2: vid +30/+60 s leveranslagg äter F6 de släpande
    // hub-fixarna, så segmentet blir aisstream→aisstream trots att hubben
    // matar fartyget. Med den gamla segmentformuleringen föll beviset och
    // TIM@Järnvägsbron tappades igen — nu räcker källnärvaron.
    const vessel = makeVessel({ fixFeed: 'aishub' });
    place(vessel, BRIDGES.jarnvagsbron, -400); // hub-fix långt före zonen
    analyze(vessel);
    vessel.fixFeed = 'aisstream';
    advance(60_000);
    place(vessel, BRIDGES.jarnvagsbron, -89);
    analyze(vessel);
    advance(29_000);
    place(vessel, BRIDGES.jarnvagsbron, 21);
    analyze(vessel);

    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
  });

  test('KÄLLNÄRVARO-TTL:n är VILANDE med breddad grind — bevis ges även efter utlöpt TTL', () => {
    // Före breddningen 2026-08-03 asserterade det här testet att utlöpt TTL
    // återförde fartyget till enkelkälleläget (inget bevis). Med
    // UNDER_BRIDGE_CROSS_PROOF_REQUIRED_FEED = null är källgrinden vilande
    // återställningsinfrastruktur: beviset gäller oavsett källa och TTL.
    // Testet låser att breddningen faktiskt är i kraft — faller den här,
    // har någon återaktiverat grinden utan att uppdatera kontraktet.
    const vessel = makeVessel({ fixFeed: 'aishub' });
    place(vessel, BRIDGES.jarnvagsbron, -400);
    analyze(vessel);
    vessel.fixFeed = 'aisstream';
    advance(UNDER_BRIDGE_CROSS_PROOF_FEED_TTL_MS + 60_000);
    place(vessel, BRIDGES.jarnvagsbron, -89);
    analyze(vessel);
    advance(29_000);
    place(vessel, BRIDGES.jarnvagsbron, 21);
    analyze(vessel);

    expect(vessel._underBridgeCrossedBridge).toBe('Järnvägsbron');
  });

  test('timer-pass med OFÖRÄNDRAD position kollapsar inte segmentet', () => {
    // _underBridgePrev* uppdateras bara när positionen faktiskt ändras —
    // annars hade re-evalueringstimern (var 30:e sekund) skrivit över
    // föregående fix med den nuvarande och beviset vore omöjligt.
    const vessel = makeVessel();
    place(vessel, BRIDGES.olidebron, -98);
    analyze(vessel);
    analyze(vessel); // timer-pass, samma position
    analyze(vessel);
    advance(67_000);
    place(vessel, BRIDGES.olidebron, 21);
    analyze(vessel);

    expect(vessel._underBridgeCrossedBridge).toBe('Olidebron');
  });
});

describe('V2 — fältlistan bär segmentbeviset över objektombyggnaden', () => {
  const makeVds = () => {
    const logger = makeLogger();
    const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    return svc;
  };

  test('_underBridgePrev*/_underBridgeCrossedBridge överlever _createVesselObject', () => {
    global.__TEST_MODE__ = true;
    const svc = makeVds();
    try {
      const oldVessel = {
        lat: 58.2725,
        lon: 12.2748,
        _underBridgePrevLat: 58.2718,
        _underBridgePrevLon: 12.2740,
        _underBridgePrevSog: 3.4,
        _underBridgeCrossedBridge: 'Olidebron',
        _secondSourceFixAt: 1_700_000_000_000,
      };
      const rebuilt = svc._createVesselObject('212571000', {
        lat: 58.2730, lon: 12.2755, sog: 3.4, cog: 20, name: 'TIM',
      }, oldVessel);

      // Utan arv nollas beviset av VARJE meddelande (fältlist-fällan) och kan
      // aldrig bäras från inträdessteget till utgångssteget — fixen vore död
      // i produktion medan enhetstesterna såg gröna ut.
      expect(rebuilt._underBridgePrevLat).toBe(58.2718);
      expect(rebuilt._underBridgePrevLon).toBe(12.2740);
      expect(rebuilt._underBridgePrevSog).toBe(3.4);
      expect(rebuilt._underBridgeCrossedBridge).toBe('Olidebron');
      expect(rebuilt._secondSourceFixAt).toBe(1_700_000_000_000);
    } finally {
      svc.clearAllTimers();
      delete global.__TEST_MODE__;
    }
  });
});
