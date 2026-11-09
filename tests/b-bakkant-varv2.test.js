'use strict';

/**
 * FAMILJ B (BAKKANT) — rättningskampanjen, varv 2 (2026-11-09)
 * =============================================================================
 * Konvojtäckningens släppväg i BridgeOpeningService#_coverageVerdict, enligt
 * triage A (T-A M4, M5 och M7) och buggjägarens kort F02, F05 och F08:
 *
 *  M4  BAKKANTENS FÄRSKHET. Bakkanten krävde ett fix efter BOKFÖRINGEN av
 *      ledarens passage. KRAV (2) (ARCHITECTURE.md §H29/H30) kräver ett fix
 *      efter KORSNINGEN. Bokfördes passagen sent och tystnade följaren mellan
 *      korsningen och bokföringen, fick bakkanten aldrig döma, och följaren
 *      släpptes först vid täckningsslutet, efter sin egen korsning (världarna
 *      1094 och 1476).
 *  M5  KRYPFARTENS PROGNOS. Bakkanten läste appens ETA, som efter en passage
 *      räknar med minst 2,5 kn. För en krypare i 0,9–1,3 kn låg prognosen
 *      inom U2-fönstret, och hon varnades vid täckningsslutet på en förfallen
 *      deadline (världarna 790 och 1794). Under golvet läser bakkanten nu
 *      den senare av prognosen och armens fysik.
 *  M7  TÄCKNINGSSLUT UTAN PASSAGE (ägarbeslut U24, 2026-11-09). En båt i en
 *      avfyrad händelse utan passage släpps på sin egen deadline när båda
 *      prognoserna lägger henne efter fönstret och täckningsslutet annars
 *      kommer för sent (värld 979, C-IV väg b, smal variant).
 *  REVISION efter granskningen (2026-11-09): KRAV (1) i bakkanten och i U24
 *      (grinden 'bakom', prob A1/A1b), appens egen prognos i U24 ('en-prognos',
 *      A4/A4c), och i M5 ingen fysik med köflaggan och först från det andra
 *      krypfixet i följd (kölämnaren, C4/C4b/C4c).
 *  REVISION 2 efter omgranskningen: krypräknaren räknar NYA fix (fixtiden
 *      framåt, prob D4), och ett första krypfix direkt efter marschfart läser
 *      fysiken (gles kadens D3, pendling runt golvet D2).
 *
 * Testen återskapar mekanismen i liten skala. Varje describe-block fäller
 * c14938f (stegets "röda" test); vakterna (namn som börjar med "vakt:")
 * är gröna även där och låser det som inte får ändras.
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;
const S = 1000;
const KN = 0.514444;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Position `distanceM` meter från bron längs bäring `bearingDeg` (220 = söder om, 40 = norr om). */
function posAtDistance(bridge, distanceM, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/** Norrgående båt mot Klaffbron; `bearing` 220 = anflygningssidan, 40 = bortom bron. */
function boat(mmsi, distanceM, sog, overrides = {}) {
  const pos = posAtDistance(KLAFF, distanceM, overrides.bearing ?? 220);
  const now = Date.now();
  return {
    mmsi,
    name: mmsi,
    lat: pos.lat,
    lon: pos.lon,
    sog,
    cog: overrides.cog ?? 40,
    timestamp: now,
    fixTs: overrides.fixTs ?? now,
    lastPositionUpdate: now,
    targetBridge: overrides.targetBridge === undefined ? 'Klaffbron' : overrides.targetBridge,
    _routeDirection: overrides._routeDirection === undefined ? 'north' : overrides._routeDirection,
    _finalTargetDirection: null,
    _hasMovementProof: true,
    _moored: false,
    _stationarySince: null,
    navStatus: null,
    etaMinutes: overrides.etaMinutes ?? null,
    passedAt: {},
    passedBridges: [],
    // Appens bekräftade väntan vid Klaffbron (waitingBridge i bridgeQueue).
    ...(overrides.queue ? {
      _bridgeQueueApproaches: { Klaffbron: { confirmedAt: T0, waitConfirmedAt: T0 + 60 * S, direction: 'north' } },
    } : {}),
  };
}

describe('familj B, varv 2: konvojtäckningens släppväg', () => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;

  const advanceTo = (t) => jest.advanceTimersByTime(t - Date.now());
  const klaff = () => warnings.filter((w) => w.bridge === 'Klaffbron');
  const own = (mmsi) => klaff().filter((w) => w.leadMmsi === mmsi);
  const armOf = (mmsi) => svc._arms.get(`${mmsi}::Klaffbron`);
  const debugLines = (tag) => logger.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(tag));
  const eventOf = (mmsi) => svc._events.get('Klaffbron').find((e) => e.id === armOf(mmsi).eventId);

  const makeService = (extra = {}) => new BridgeOpeningService({
    logger,
    onWarning: (payload) => warnings.push(payload),
    targetBridges: ['Klaffbron'],
    ...extra,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    svc = makeService();
    tickTimer = setInterval(() => svc.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
  });

  afterEach(() => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (svc) svc.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // ===========================================================================
  // M4 — bakkantens färskhet mäts mot den skattade korsningen
  // ===========================================================================
  describe('M4: bakkantens färskhet mot korsningen, inte mot bokföringen', () => {
    /**
     * Värld 1094 i liten skala. LEAD (900 m, 6 kn) avfyrar direkt, FOLLOWER
     * (2400 m, 6,9 kn) absorberas: täckt t.o.m. LEADs prognos + 600 s
     * (T0+891,6 s). LEAD hörs 50 m före bron T0+240 s och tystnar över bron;
     * nästa fix T0+420 s ligger 500 m bortom den. Passagen bokförs T0+420 s,
     * och korsningen interpoleras till T0+256,4 s. U2-fönstret slutar
     * T0+856,4 s.
     * FOLLOWER hörs en sista gång T0+300 s, MELLAN korsningen och
     * bokföringen: 1760 m i 6 kn, ankomst T0+870,2 s, alltså efter fönstret.
     * Sedan är hon tyst och korsar ungefär då, före täckningsslutet.
     */
    const stageLateRegistration = () => {
      svc.observeVessel(boat('LEAD', 900, 6));
      svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
      expect(klaff()).toHaveLength(1);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      const coverUntil = armOf('FOLLOWER').coverUntilMs;
      advanceTo(T0 + 240 * S);
      svc.observeVessel(boat('LEAD', 50, 6));
      advanceTo(T0 + 300 * S);
      svc.observeVessel(boat('FOLLOWER', 1760, 6));
      // Ingen passage är känd ännu: täckningen gäller.
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      return coverUntil;
    };

    it('en följare som tystnade mellan korsningen och bokföringen släpps på bokföringen och varnas före sin ankomst', () => {
      const coverUntil = stageLateRegistration();
      const arrival = armOf('FOLLOWER').expectedArrivalMs;
      advanceTo(T0 + 420 * S);
      svc.observeVessel(boat('LEAD', 500, 6, { bearing: 40 }));
      expect(armOf('LEAD')).toBeUndefined();
      const passed = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(passed.firstPassageRegisteredAt).toBe(T0 + 420 * S);
      expect(passed.firstPassageAt).toBeCloseTo(T0 + 240 * S + 180 * S * (50 / 550), -3);
      // Fixet T0+300 s ligger efter korsningen, och prognosen ligger efter
      // U2-fönstret. Bakkanten dömer på bokföringen (förut: täckt till
      // täckningsslutet, eftersom fixet låg före bokföringen).
      const windowEnd = passed.firstPassageAt + BRIDGE_OPENING.CONVOY_WINDOW_MS;
      expect(arrival).toBeGreaterThan(windowEnd);
      expect(arrival).toBeLessThan(coverUntil);
      expect(armOf('FOLLOWER').absorbedAt).toBeNull();
      expect(debugLines('[OPENING_RECOVER]').some((l) => l.includes('bakkant'))).toBe(true);

      // Egen varning på deadlinen ur fixet T0+300 s, före ankomsten och långt
      // före täckningsslutet (där c14938f släppte henne, efter korsningen).
      advanceTo(arrival - 60 * S);
      const mine = own('FOLLOWER');
      expect(mine).toHaveLength(1);
      expect(mine[0].t).toBeLessThanOrEqual(arrival - BRIDGE_OPENING.WARNING_LEAD_MS);
      expect(mine[0].t).toBeLessThan(coverUntil);
    });

    it('vakt: utan skattning (notePassage, inget fix bortom bron) gäller bokföringen som förut', () => {
      stageLateRegistration();
      // Ingen interpolation går att göra: LEADs senaste läge låg före bron, så
      // firstPassageAt blir bokföringstiden. Följarens fix T0+300 s är då inte
      // färskt, och täckningen gäller som på c14938f.
      advanceTo(T0 + 420 * S);
      svc.notePassage('LEAD', 'Klaffbron');
      const passed = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(passed.firstPassageAt).toBe(T0 + 420 * S);
      expect(passed.firstPassageAt).toBe(passed.firstPassageRegisteredAt);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      advanceTo(T0 + 800 * S);
      expect(own('FOLLOWER')).toHaveLength(0);
      expect(debugLines('[OPENING_RECOVER]')).toHaveLength(0);
    });

    it('vakt: ett fix FÖRE korsningen är inte färskt, även när passagen bokförs sent', () => {
      svc.observeVessel(boat('LEAD', 900, 6));
      svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
      advanceTo(T0 + 200 * S);
      // Följarens sista fix före korsningen (T0+256,4 s), med prognos efter fönstret.
      svc.observeVessel(boat('FOLLOWER', 2300, 5));
      advanceTo(T0 + 240 * S);
      svc.observeVessel(boat('LEAD', 50, 6));
      advanceTo(T0 + 420 * S);
      svc.observeVessel(boat('LEAD', 500, 6, { bearing: 40 }));
      const passed = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(armOf('FOLLOWER').lastSeenAt).toBeLessThan(passed.firstPassageAt);
      expect(armOf('FOLLOWER').expectedArrivalMs)
        .toBeGreaterThan(passed.firstPassageAt + BRIDGE_OPENING.CONVOY_WINDOW_MS);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(debugLines('[OPENING_RECOVER]')).toHaveLength(0);
    });

    it('vakt: domen bär samma anropsform och returform som förut (familj E instrumenterar den)', () => {
      stageLateRegistration();
      const arm = armOf('FOLLOWER');
      const event = eventOf('FOLLOWER');
      expect(svc._coverageVerdict.length).toBe(3);
      const verdict = svc._coverageVerdict(arm, event, Date.now());
      expect(typeof verdict.kind).toBe('string');
      expect(verdict.kind).toBe('covered');
    });
  });

  // ===========================================================================
  // M5 — krypfartens prognos: bakkanten läser fysiken under ETA-golvet
  // ===========================================================================
  describe('M5: en krypare under ETA-kedjans passagegolv mäts med sin egen fysik', () => {
    /**
     * Konvoj med känd passage: LEAD avfyrar T0 och passerar T0+240 s
     * (notePassage, ingen skattning), så U2-fönstret och täckningen slutar
     * T0+840 s. FOLLOWER är absorberad.
     */
    const stageConvoyWithPassage = () => {
      svc.observeVessel(boat('LEAD', 900, 6));
      svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
      expect(klaff()).toHaveLength(1);
      advanceTo(T0 + 240 * S);
      svc.notePassage('LEAD', 'Klaffbron');
      expect(armOf('FOLLOWER').coverUntilMs).toBe(T0 + 840 * S);
    };
    /** Appens ETA efter en passage: avståndet i ETA-kedjans golvfart 2,5 kn. */
    const floorEtaMinutes = (distanceM) => distanceM / (2.5 * KN) / 60;

    it('värld 790 i liten skala: 300 m i 1 kn direkt efter marschfart släpps på fixet och varnas med full ledtid', () => {
      stageConvoyWithPassage();
      // Förra fixet låg i 6,9 kn (marschfart), så det första krypfixet läser
      // fysiken (omgranskningen: en krypare som saktat in, inte en
      // kölämnare). Appens ETA (golvet 2,5 kn) säger 3,9 min, alltså ankomst
      // T0+733 s, inom fönstret. Fysiken säger 583 s, alltså T0+1083 s.
      advanceTo(T0 + 500 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 1, { etaMinutes: floorEtaMinutes(300) }));
      const arm = armOf('FOLLOWER');
      expect(arm.crawlFixes).toBe(1);
      expect(arm.crawlFromCruise).toBe(true);
      expect(arm.expectedArrivalMs).toBeLessThan(T0 + 840 * S);
      expect(arm.physicsArrivalMs).toBeCloseTo(T0 + 500 * S + (arm.distanceM / KN) * S, -1);
      expect(arm.physicsArrivalMs).toBeGreaterThan(T0 + 840 * S);
      // Släpps av bakkanten på det färska fixet (förut: täckt till T0+840 s
      // och varnad på en förfallen deadline, 47 s före korsningen i värld 790).
      expect(arm.absorbedAt).toBeNull();
      expect(debugLines('[OPENING_RECOVER]').some((l) => l.includes('bakkant'))).toBe(true);
      const mine = own('FOLLOWER');
      expect(mine).toHaveLength(1);
      expect(mine[0].t).toBe(T0 + 500 * S);
      // U22: eta-tokenen och deadlinen läser appens prognos, inte fysiken.
      expect(mine[0].etaMinutes).toBe(Math.round((arm.expectedArrivalMs - mine[0].t) / 60000));
      expect(arm.fireDueMs).toBe(Math.min(
        arm.earliestArrivalMs - BRIDGE_OPENING.WARNING_LEAD_MS,
        arm.expectedArrivalMs - BRIDGE_OPENING.FIRE_EXPECTED_ETA_MS,
      ));
    });

    it('domen bär det som jämfördes: arrivalMs, physicsArrivalMs och windowEndMs', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 500 * S);
      svc.observeVessel(boat('FOLLOWER', 1000, 6.9)); // ankomst ~T0+782 s, inom fönstret
      const arm = armOf('FOLLOWER');
      const verdict = svc._coverageVerdict(arm, eventOf('FOLLOWER'), Date.now());
      expect(verdict.kind).toBe('covered');
      expect(verdict.windowEndMs).toBe(T0 + 840 * S);
      expect(verdict.arrivalMs).toBe(arm.expectedArrivalMs);
      expect(verdict.physicsArrivalMs).toBe(arm.physicsArrivalMs);
    });

    it('KRAV (1) i bakkanten: ett fix bortom bron utan riktning släpps inte; täckningsslutet avväpnar', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 500 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 4, {
        bearing: 40, _routeDirection: null, cog: null, etaMinutes: 12,
      }));
      expect(armOf('FOLLOWER').expectedArrivalMs).toBeGreaterThan(T0 + 840 * S);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(svc._coverageVerdict(armOf('FOLLOWER'), eventOf('FOLLOWER'), Date.now()).gate).toBe('bakom');
      advanceTo(T0 + 900 * S);
      expect(armOf('FOLLOWER')).toBeUndefined();
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('vakt: över golvet (2,6 kn) läser bakkanten appens prognos som förut', () => {
      stageConvoyWithPassage();
      // Fysiken (900 m i 2,6 kn, 673 s) ligger efter fönstret, men appens ETA
      // (3 min) ligger inom det. Över golvet räknar ETA-kedjan på farten.
      advanceTo(T0 + 500 * S);
      svc.observeVessel(boat('FOLLOWER', 900, 2.6, { etaMinutes: 3 }));
      const arm = armOf('FOLLOWER');
      expect(Date.now() + (arm.distanceM / (2.6 * KN)) * S).toBeGreaterThan(T0 + 840 * S);
      expect(arm.expectedArrivalMs).toBeLessThan(T0 + 840 * S);
      expect(arm.absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('vakt: utan mätbar fart (0,4 kn) gäller appens prognos', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 500 * S);
      svc.observeVessel(boat('FOLLOWER', 120, 0.4, { etaMinutes: 2 }));
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('kölämnaren: första rörelsefixet efter stillhet läser inte fysiken (granskningens C4b)', () => {
      stageConvoyWithPassage();
      // Köar 300 m från bron och startar 30 s efter ledarens passage: ett
      // momentant fix i 0,8 kn, sedan 3,5 och 5 kn. Hon korsar inom fönstret.
      // Hon ligger still i kön, kryper ett fix och står still igen:
      // räknaren börjar om, och inget krypfix kommer direkt efter marschfart.
      advanceTo(T0 + 242 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0, { etaMinutes: floorEtaMinutes(300) }));
      advanceTo(T0 + 245 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0.8, { etaMinutes: floorEtaMinutes(300) }));
      expect(armOf('FOLLOWER').crawlFromCruise).toBe(false);
      advanceTo(T0 + 250 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0, { etaMinutes: floorEtaMinutes(300) }));
      expect(armOf('FOLLOWER').crawlFixes).toBe(0);
      advanceTo(T0 + 270 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0.8, { etaMinutes: floorEtaMinutes(300) }));
      expect(armOf('FOLLOWER').crawlFixes).toBe(1);
      expect(armOf('FOLLOWER').physicsArrivalMs).toBeGreaterThan(T0 + 840 * S);
      expect(svc._crawlArrivalMs(armOf('FOLLOWER'))).toBe(armOf('FOLLOWER').expectedArrivalMs);
      advanceTo(T0 + 300 * S);
      svc.observeVessel(boat('FOLLOWER', 260, 3.5, { etaMinutes: floorEtaMinutes(260) }));
      advanceTo(T0 + 330 * S);
      svc.observeVessel(boat('FOLLOWER', 200, 5, { etaMinutes: floorEtaMinutes(200) }));
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('kölämnarens första rörelsefix levererat två gånger (samma fixtid) räknas en gång (granskningens D4)', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 250 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0, { etaMinutes: floorEtaMinutes(300) }));
      advanceTo(T0 + 270 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0.8, { etaMinutes: floorEtaMinutes(300) }));
      // Samma fix en gång till, 5 s senare (aisstream-multiplexern filtrerar
      // inte dubbletter). Fixets tid har inte gått framåt.
      advanceTo(T0 + 275 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0.8, { etaMinutes: floorEtaMinutes(300), fixTs: T0 + 270 * S }));
      expect(armOf('FOLLOWER').crawlFixes).toBe(1);
      expect(svc._crawlArrivalMs(armOf('FOLLOWER'))).toBe(armOf('FOLLOWER').expectedArrivalMs);
      advanceTo(T0 + 300 * S);
      svc.observeVessel(boat('FOLLOWER', 260, 3.5, { etaMinutes: floorEtaMinutes(260) }));
      advanceTo(T0 + 330 * S);
      svc.observeVessel(boat('FOLLOWER', 200, 5, { etaMinutes: floorEtaMinutes(200) }));
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('gles kadens (klass B, 180 s): första krypfixet efter marschfart släpps direkt (granskningens D3)', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 480 * S);
      svc.observeVessel(boat('FOLLOWER', 600, 6, { etaMinutes: 600 / (6 * KN) / 60 }));
      // Nästa fix 220 s senare: 100 m från bron i 1 kn. Fysiken säger
      // ankomst ~T0+894 s, efter fönstret; appens ETA (golvet) T0+740 s.
      advanceTo(T0 + 700 * S);
      svc.observeVessel(boat('FOLLOWER', 100, 1, { etaMinutes: floorEtaMinutes(100) }));
      expect(armOf('FOLLOWER').crawlFromCruise).toBe(true);
      const mine = own('FOLLOWER');
      expect(mine).toHaveLength(1);
      expect(mine[0].t).toBe(T0 + 700 * S);
    });

    it('köflaggan: i appens bekräftade kö läser bakkanten inte fysiken (granskningens C4c)', () => {
      stageConvoyWithPassage();
      // Två krypfix i följd i 0,8 kn 300 m från bron, med appens köbevis.
      advanceTo(T0 + 260 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0.8, { etaMinutes: floorEtaMinutes(300), queue: true }));
      advanceTo(T0 + 290 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0.8, { etaMinutes: floorEtaMinutes(300), queue: true }));
      const arm = armOf('FOLLOWER');
      expect(arm.waitingAtBridge).toBe('Klaffbron');
      expect(arm.crawlFixes).toBe(2);
      expect(arm.physicsArrivalMs).toBeGreaterThan(T0 + 840 * S);
      expect(svc._crawlArrivalMs(arm)).toBe(arm.expectedArrivalMs);
      expect(arm.absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('utan mätbar fart (≤ 0,5 kn) bär armen ingen fysikankomst', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 500 * S);
      svc.observeVessel(boat('FOLLOWER', 120, 0.5, { etaMinutes: 2 }));
      expect(armOf('FOLLOWER').physicsArrivalMs).toBeNull();
      svc.observeVessel(boat('FOLLOWER', 120, 0.6, { etaMinutes: 2 }));
      expect(Number.isFinite(armOf('FOLLOWER').physicsArrivalMs)).toBe(true);
    });
  });
  // ===========================================================================
  // M7 — egen deadline före händelsens första passage (U24; C-IV väg b, smal)
  // ===========================================================================
  describe('M7: en absorberad båt släpps på sin egen deadline när öppningen ännu inte skett', () => {
    /**
     * Värld 979 i liten skala. LEAD (900 m, 6 kn) avfyrar direkt; referens-
     * ankomsten blir hennes prognos T0+291,6 s, och fönstret slutar T0+891,6 s.
     * Hon stannar sedan 100 m före bron och väntar: ingen passage bokförs.
     * FOLLOWER (2400 m, 6,9 kn) absorberas, täckt t.o.m. T0+891,6 s.
     */
    const stageWaitingLeader = () => {
      svc.observeVessel(boat('LEAD', 900, 6));
      svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
      expect(klaff()).toHaveLength(1);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      advanceTo(T0 + 20 * S);
      svc.observeVessel(boat('LEAD', 100, 0));
      return armOf('FOLLOWER').coverUntilMs;
    };
    const verdictNow = (mmsi) => svc._coverageVerdict(armOf(mmsi), eventOf(mmsi), Date.now());

    it('värld 979 i liten skala: följaren som saktat in varnas på sin egen deadline, inte vid täckningsslutet', () => {
      const coverUntil = stageWaitingLeader();
      expect(coverUntil).toBeCloseTo(T0 + 891.6 * S, -3);
      // 2300 m i 4,5 kn: appens ETA 16 min (ankomst ~T0+990 s) och fysiken
      // (~T0+1024 s) ligger efter fönstret. Egen deadline ~T0+297 s.
      // Täckningsslutet hade gett henne ~100 s (979: 50 s).
      advanceTo(T0 + 30 * S);
      svc.observeVessel(boat('FOLLOWER', 2300, 4.5, { etaMinutes: 16 }));
      const arm = armOf('FOLLOWER');
      const deadline = arm.earliestArrivalMs - BRIDGE_OPENING.WARNING_LEAD_MS;
      expect(arm.expectedArrivalMs).toBeGreaterThan(coverUntil);
      expect(arm.absorbedAt).toBe(T0);
      advanceTo(deadline - 5 * S);
      expect(own('FOLLOWER')).toHaveLength(0);
      advanceTo(deadline + BRIDGE_OPENING.TICK_INTERVAL_MS);
      const mine = own('FOLLOWER');
      expect(mine).toHaveLength(1);
      expect(mine[0].t).toBeLessThanOrEqual(deadline + BRIDGE_OPENING.TICK_INTERVAL_MS);
      expect(mine[0].t).toBeLessThan(coverUntil);
      expect(debugLines('[OPENING_RECOVER]').some((l) => l.includes('egen deadline'))).toBe(true);
    });

    it('schemaläggaren släpper henne på deadlinen, utan watchdog', () => {
      clearInterval(tickTimer);
      tickTimer = null;
      svc.destroy();
      svc = makeService({ scheduleDeadlines: true });
      stageWaitingLeader();
      advanceTo(T0 + 30 * S);
      svc.observeVessel(boat('FOLLOWER', 2300, 4.5, { etaMinutes: 16 }));
      const deadline = armOf('FOLLOWER').earliestArrivalMs - BRIDGE_OPENING.WARNING_LEAD_MS;
      expect(svc._ownDeadlineWakeMs(armOf('FOLLOWER'), Date.now())).toBe(Math.ceil(deadline));
      advanceTo(Math.ceil(deadline) + 1);
      const mine = own('FOLLOWER');
      expect(mine).toHaveLength(1);
      expect(mine[0].t).toBe(Math.ceil(deadline));
    });

    it('domen bär underlaget och grinden (familj E bokför dem)', () => {
      stageWaitingLeader();
      advanceTo(T0 + 30 * S);
      svc.observeVessel(boat('FOLLOWER', 2300, 4.5, { etaMinutes: 16 }));
      const verdict = verdictNow('FOLLOWER');
      expect(verdict.kind).toBe('covered');
      expect(verdict.gate).toBe('deadline');
      expect(verdict.windowEndMs).toBeCloseTo(T0 + 891.6 * S, -3);
      expect(verdict.ownDeadlineMs).toBe(armOf('FOLLOWER').earliestArrivalMs - BRIDGE_OPENING.WARNING_LEAD_MS);
      expect(verdict.arrivalMs).toBe(Math.min(armOf('FOLLOWER').expectedArrivalMs, armOf('FOLLOWER').physicsArrivalMs));
      expect(verdict.physicsArrivalMs).toBe(armOf('FOLLOWER').physicsArrivalMs);
    });

    it('vakt: en prognos inom fönstret hör till öppningen som förut (U2)', () => {
      const coverUntil = stageWaitingLeader();
      advanceTo(T0 + 300 * S);
      svc.observeVessel(boat('FOLLOWER', 1200, 6.9, { etaMinutes: 5.6 })); // ankomst ~T0+636 s
      advanceTo(coverUntil - 10 * S);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('vakt: en båt i väntzonen (≤ 350 m) släpps inte, även när prognosen ligger efter fönstret', () => {
      const coverUntil = stageWaitingLeader();
      advanceTo(T0 + 200 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 0.8, { etaMinutes: 12 })); // ankomst ~T0+920 s, deadline passerad
      expect(armOf('FOLLOWER').expectedArrivalMs).toBeGreaterThan(coverUntil);
      advanceTo(coverUntil - 10 * S);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('en båt som ligger still släpps inte (grinden ingen-fysik)', () => {
      const coverUntil = stageWaitingLeader();
      advanceTo(T0 + 200 * S);
      svc.observeVessel(boat('FOLLOWER', 1500, 0.3, { etaMinutes: 20 }));
      expect(verdictNow('FOLLOWER').gate).toBe('ingen-fysik');
      advanceTo(coverUntil - 10 * S);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('vakt: bara när BÅDA prognoserna ligger efter fönstret släpps hon', () => {
      const coverUntil = stageWaitingLeader();
      // Fysiken (2300 m i 4,5 kn) ligger efter fönstret, appens ETA (12 min) inom det.
      advanceTo(T0 + 30 * S);
      svc.observeVessel(boat('FOLLOWER', 2300, 4.5, { etaMinutes: 12 }));
      const arm = armOf('FOLLOWER');
      expect(Date.now() + (arm.distanceM / (4.5 * KN)) * S).toBeGreaterThan(coverUntil);
      expect(arm.expectedArrivalMs).toBeLessThan(coverUntil);
      advanceTo(coverUntil - 10 * S);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('vakt: ger täckningsslutet henne ledtiden ändå, står utfallet kvar (LAURIERBORG, U13)', () => {
      const coverUntil = stageWaitingLeader();
      // 2300 m i 3,5 kn: ankomst ~T0+1290 s, långt efter täckningsslutet.
      advanceTo(T0 + 30 * S);
      svc.observeVessel(boat('FOLLOWER', 2300, 3.5, { etaMinutes: 21 }));
      expect(coverUntil).toBeLessThanOrEqual(armOf('FOLLOWER').expectedArrivalMs - BRIDGE_OPENING.WARNING_LEAD_MS);
      advanceTo(coverUntil - 10 * S);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
      // Täckningsslutet (U17) släpper henne som förut, med ledtid kvar.
      advanceTo(coverUntil + BRIDGE_OPENING.TICK_INTERVAL_MS);
      expect(own('FOLLOWER')).toHaveLength(1);
    });

    it('grindarna prövas direkt: kö-flaggan, orent fix, golvet och kursen bort', () => {
      stageWaitingLeader();
      advanceTo(T0 + 30 * S);
      svc.observeVessel(boat('FOLLOWER', 2300, 4.5, { etaMinutes: 16 }));
      // Ingen utvärdering efter fixet: deadlinen passerar, armen är kvar.
      clearInterval(tickTimer);
      tickTimer = null;
      advanceTo(T0 + 400 * S);
      const arm = armOf('FOLLOWER');
      const event = eventOf('FOLLOWER');
      const now = Date.now();
      expect(arm.absorbedAt).toBe(T0);
      expect(svc._coverageVerdict(arm, event, now).kind).toBe('bakkant');
      expect(svc._coverageVerdict({ ...arm, waitingAtBridge: 'Järnvägsbron' }, event, now).gate).toBe('kö');
      expect(svc._coverageVerdict({ ...arm, lastFixClean: false }, event, now).gate).toBe('orent');
      expect(svc._coverageVerdict({ ...arm, cog: 220 }, event, now).gate).toBe('kurs');
      // Golvet: ankomst 30 s bort, fönstret slut och täckningen för sen.
      const late = { ...arm, expectedArrivalMs: now + 30 * S, physicsArrivalMs: now + 40 * S };
      const lateEvent = { ...event, referenceArrivalMs: now - BRIDGE_OPENING.CONVOY_WINDOW_MS - 60 * S };
      expect(svc._coverageVerdict({ ...late, coverUntilMs: now + 300 * S }, lateEvent, now).gate).toBe('golv');
    });

    it('utan appens prognos släpps hon inte: "båda prognoserna" kräver etaMinutes (granskningens A4)', () => {
      const coverUntil = stageWaitingLeader();
      advanceTo(T0 + 30 * S);
      svc.observeVessel(boat('FOLLOWER', 2300, 4.5)); // ingen etaMinutes: prognosen är fysiken
      expect(armOf('FOLLOWER').expectedArrivalMs).toBe(armOf('FOLLOWER').physicsArrivalMs);
      expect(verdictNow('FOLLOWER').gate).toBe('en-prognos');
      advanceTo(coverUntil - 10 * S);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('KRAV (1): ett fix bortom bron utan riktning släpps inte; täckningsslutet avväpnar (granskningens A1)', () => {
      const coverUntil = stageWaitingLeader();
      advanceTo(T0 + 30 * S);
      svc.observeVessel(boat('FOLLOWER', 2300, 4.5, { etaMinutes: 16 }));
      // 400 m BORTOM bron, utan riktning och kurs, i 0,6 kn: prognos och fysik
      // efter fönstret, egen deadline passerad. Ingen passage bokförs.
      advanceTo(T0 + 200 * S);
      svc.observeVessel(boat('FOLLOWER', 400, 0.6, {
        bearing: 40, _routeDirection: null, cog: null, etaMinutes: 12,
      }));
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(verdictNow('FOLLOWER').gate).toBe('bakom');
      advanceTo(coverUntil + BRIDGE_OPENING.TICK_INTERVAL_MS);
      expect(armOf('FOLLOWER')).toBeUndefined();
      advanceTo(T0 + 1500 * S);
      expect(own('FOLLOWER')).toHaveLength(0);
    });

    it('vakt: efter första passagen gäller bakkanten som förut, inte den egna deadlinen', () => {
      stageWaitingLeader();
      advanceTo(T0 + 30 * S);
      svc.observeVessel(boat('FOLLOWER', 2300, 4.5, { etaMinutes: 16 }));
      advanceTo(T0 + 60 * S);
      svc.notePassage('LEAD', 'Klaffbron');
      const verdict = verdictNow('FOLLOWER');
      expect(verdict.ownDeadlineMs).toBeUndefined();
      expect(verdict.gate).toBeUndefined();
    });
  });
});
