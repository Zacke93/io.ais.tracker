'use strict';

/**
 * K-FAMILJEN — KONVOJ OCH ÖPPNING (rättningskampanjen 2026-11-04)
 * =============================================================================
 * Buggjägarens kort i r1-standard-a, alla i BridgeOpeningService:
 *
 *  F01  GLAPPREGISTRERINGEN. _recordPassage satte firstPassageAt till
 *       BOKFÖRINGSTIDEN. Efter ett AIS-avbrott ligger den ett helt avbrott
 *       efter den verkliga korsningen, och konvojfönstret svalde nästa öppning
 *       (värld 1900: ORION korsade 09:13:46, bokfördes 09:26:22; ULLA
 *       absorberades 09:26:23 och korsade 09:31:35 utan egen varning).
 *  F02/F22/F17  BAKKANTEN. Medlemskapet omprövades bara vid täckningsslutet,
 *       och släppet avfyrade på den ärvda deadlinen: SALTIS fick 54 s ledtid,
 *       PELLE varnades 18 s EFTER sin korsning.
 *  F03/F20  UNDER BRON. En båt som senast sågs inom UNDER_BRIDGE_SET_DISTANCE
 *       med ankomst inom täckningen släpptes ändå som "egen öppning" när
 *       täckningen löpte ut — och varnades efter sin tysta passage.
 *  F14  KURSEN BORT. En båt vars kurs ledde bort från bron (obekräftad
 *       U-sväng) släpptes och fick en fantomvarning.
 *
 *  F14-världen 227 (granskningen)  KORSNINGSANKARETS GOLV. Ankaret gav en
 *       retur som upptäcktes 13 m före bron en egen varning 10 s efter
 *       korsningen; under 2 × TICK står täckningen kvar som förut.
 *
 *  REVISION 3 (omgranskningen och dirigentens beslut 2026-11-05):
 *   - VÄNTAN FÖRE BRON. Visar fixet före bron en stilla eller köande båt
 *     skattas korsningen som max(rät linje, bakåt ur fixet efter bron i dess
 *     fart); den räta linjen lade den mitt i väntan (granskarens sond p2).
 *   - TÄCKNINGSSLUTET FRÅN BOKFÖRINGEN. Korsningen styr medlemskapet och
 *     bakkanten; när en tyst båt släpps står kvar som på 7699cbe (U13: den
 *     låsta raden 20260712-25h 265806230 får inte flyttas, U17).
 *   - Systerstället i observeVessel (_crossingUpperBound) och golvets
 *     medlemsvillkor (mutation X8) har egna test.
 *
 * Granskningen 2026-11-04 gjorde 17 mutationer av grindarna, och 8 överlevde.
 * Blocket "grindar som saknade fällande test" längst ned fäller var och en av
 * dem (kommentaren vid varje test namnger mutationen).
 *
 * PÅ 7699cbe (testfilen kopierad dit) är 23 av 32 röda. De 9 gröna vaktar
 * beteenden som fanns redan där och som rättningen inte får ändra:
 *  - KRAV-negativen (ARCHITECTURE.md §H29/H30, "TESTKRAVET ÄR NEGATIVT"):
 *    VIRGO och PILGRIM korsar under tystnad och får INGEN andra varning (2);
 *  - 20260712-25h 265806230: säkerhetsvarningen kommer 08:37:18 som förut (U13);
 *  - U17-kontraktet (ägarbeslut 2026-11-04): en tyst båt utanför bron prövas
 *    fortfarande vid täckningsslutet och får sin säkerhetsvarning
 *    (F11/F23-klassen);
 *  - två bakkantsfall: en prognos inom täckningen hör till öppningen, och en
 *    följare som inte setts sedan bokföringen släpps inte av rebaseringen;
 *  - tre mutationsvakter där 7699cbe redan gör rätt eftersom grinden saknas:
 *    M08 (7699cbe har ingen bakkant), M10 och notePassage före bron
 *    (7699cbe bokför alltid på bokföringstiden).
 */

global.__TEST_MODE__ = true;

const path = require('path');
const { execFileSync } = require('child_process');
const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');
const corpora = require('./replay-validation/corpora');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;
const S = 1000;

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
    fixTs: now,
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
  };
}

describe('K-familjen: RECOVER-släppet, bakkanten och glappregistreringen', () => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;

  const advanceTo = (t) => jest.advanceTimersByTime(t - Date.now());
  const klaff = () => warnings.filter((w) => w.bridge === 'Klaffbron');
  const armOf = (mmsi) => svc._arms.get(`${mmsi}::Klaffbron`);
  const debugLines = (tag) => logger.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(tag));

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

  /**
   * Konvoj i fältets form: LEAD 900 m i 6 kn avfyrar direkt (deadlinen har
   * redan förfallit), FOLLOWER 2400 m i 6,9 kn absorberas (prognos inom
   * ledarens fönster). LEAD passerar T0+240 s ⇒ täckningen kortas till
   * T0+840 s (K14).
   */
  const stageConvoyWithPassage = () => {
    svc.observeVessel(boat('LEAD', 900, 6));
    svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
    expect(klaff()).toHaveLength(1);
    expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
    advanceTo(T0 + 240 * S);
    svc.notePassage('LEAD', 'Klaffbron');
    expect(armOf('FOLLOWER').coverUntilMs).toBe(T0 + 840 * S);
  };

  // ===========================================================================
  // F01 — konvojfönstret ankras i den INTERPOLERADE korsningen
  // ===========================================================================
  describe('F01: glappregistreringen flyttar inte konvojfönstret', () => {
    it('ULLA-klassen: en båt som anländer efter korsningen + 600 s får sin egen varning', () => {
      // ORION avfyrar och närmar sig; sista fixet före avbrottet 72 m före bron.
      svc.observeVessel(boat('ORION', 900, 5.4));
      expect(klaff()).toHaveLength(1);
      advanceTo(T0 + 268 * S);
      svc.observeVessel(boat('ORION', 72, 5.4));
      // AIS-avbrott i 757 s. Första fixet efteråt ligger 1900 m BORTOM bron:
      // passagen upptäcks och bokförs först nu.
      advanceTo(T0 + 1025 * S);
      svc.observeVessel(boat('ORION', 1900, 5.4, { bearing: 40 }));
      expect(armOf('ORION')).toBeUndefined();

      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      // Korsningen interpoleras längs avståndet: 268 s + 757 s · 72/(72+1900).
      const crossing = T0 + 268 * S + 757 * S * (72 / 1972);
      expect(event.firstPassageAt).toBeCloseTo(crossing, -2);
      expect(event.firstPassageRegisteredAt).toBe(T0 + 1025 * S);
      expect(event.referenceArrivalMs).toBe(event.firstPassageAt);
      expect(debugLines('[OPENING_PASSAGE_TIME]')).toHaveLength(1);

      // ULLA hörs första gången sekunden efter bokföringen: 765 m, 4,7 kn,
      // ankomst ~316 s bort — ~1046 s efter ORIONs korsning, alltså NÄSTA
      // öppning (U2). Förut absorberades hon (fönstret räknat från 09:26:22).
      advanceTo(T0 + 1026 * S);
      svc.observeVessel(boat('ULLA', 765, 4.7));
      const ulla = armOf('ULLA');
      expect(ulla.absorbedAt).toBeNull();
      const own = klaff().filter((w) => w.leadMmsi === 'ULLA');
      expect(own).toHaveLength(1);
      expect(ulla.expectedArrivalMs - own[0].t).toBeGreaterThan(2 * BRIDGE_OPENING.TICK_INTERVAL_MS);
    });

    it('utan riktning faller korsningstiden tillbaka på bokföringen (ingen gissning)', () => {
      svc.observeVessel(boat('ORION', 900, 5.4));
      advanceTo(T0 + 268 * S);
      svc.observeVessel(boat('ORION', 72, 5.4));
      const arm = armOf('ORION');
      advanceTo(T0 + 1025 * S);
      const after = boat('ORION', 1900, 5.4, { bearing: 40, _routeDirection: null });
      expect(svc._crossingEstimate({ ...arm, routeDirection: null }, after, 1900, Date.now())).toBeNull();
      // Ett fix som inte ligger bortom bron ger heller ingen interpolation.
      const stillBefore = boat('ORION', 30, 5.4);
      expect(svc._crossingEstimate(arm, stillBefore, 30, Date.now())).toBeNull();
    });
  });

  // ===========================================================================
  // KORSNINGSANKARET VID VÄNTAN FÖRE BRON (omgranskningen 2026-11-05, revision 3)
  // ===========================================================================
  describe('korsningsankaret när fixet före bron visar en väntande båt', () => {
    /**
     * Omgranskningens minsta repro (2026-11-05, kampanjens sond p2): ledaren
     * ligger STILLA 100 m före bron, korsar i verkligheten T0+720 s, och nästa
     * fix kommer T0+840 s, 370 m bortom bron i 6 kn. Den räta linjen ankrade
     * korsningen i T0+273 s — mitt i väntan — och en båt som anländer 407 s
     * efter den verkliga korsningen (samma öppning enligt U2) fick en andra
     * varning. 7699cbe absorberade henne (bokföringen T0+840 s).
     */
    it('bakåtskattning ur fixet efter bron: en båt inom U2-fönstret får ingen andra varning', () => {
      svc.observeVessel(boat('LEAD', 900, 6));
      expect(klaff()).toHaveLength(1);
      advanceTo(T0 + 120 * S);
      svc.observeVessel(boat('LEAD', 100, 0)); // väntar vid stängd bro
      advanceTo(T0 + 840 * S);
      svc.observeVessel(boat('LEAD', 370, 6, { bearing: 40 }));
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      // 840 s − 370 m / (6 kn · 0,514444) ≈ 720 s; den räta linjen hade gett 273 s.
      // (Toleransen 0,5 s täcker avrundningen i testets positionsgeometri.)
      expect(event.firstPassageAt).toBeCloseTo(T0 + 840 * S - (370 / (6 * 0.514444)) * S, -3);
      expect(event.firstPassageRegisteredAt).toBe(T0 + 840 * S);

      advanceTo(T0 + 900 * S);
      svc.observeVessel(boat('NEW', 700, 6)); // ankomst ~T0+1127 s, 407 s efter korsningen
      expect(armOf('NEW').eventId).toBe(event.id);
      expect(armOf('NEW').absorbedAt).toBe(T0 + 900 * S);
      advanceTo(T0 + 1000 * S);
      expect(klaff().filter((w) => w.leadMmsi === 'NEW')).toHaveLength(0);
    });

    it('skattningens led: väntan ger max(rät linje, bakåt), utan mätbar fart gäller linjen', () => {
      svc.observeVessel(boat('LEAD', 900, 6));
      advanceTo(T0 + 120 * S);
      svc.observeVessel(boat('LEAD', 100, 0));
      const arm = armOf('LEAD');
      advanceTo(T0 + 840 * S);
      const now = Date.now();
      const linear = T0 + 120 * S + 720 * S * (100 / 470);
      const after = (sog) => boat('LEAD', 370, sog, { bearing: 40 });
      // Väntande före-fix (sog under MINIMUM_VIABLE_SPEED), 6 kn efter: bakåt.
      expect(svc._crossingEstimate(arm, after(6), 370, now))
        .toBeCloseTo(now - (370 / (6 * 0.514444)) * S, -3);
      // Köande enligt waitingAtBridge, fast farten är 0,7 kn: också bakåt.
      expect(svc._crossingEstimate({ ...arm, sog: 0.7, waitingAtBridge: 'Klaffbron' }, after(6), 370, now))
        .toBeCloseTo(now - (370 / (6 * 0.514444)) * S, -3);
      // Ingen mätbar fart efter bron (≤ 0,5 kn): den räta linjen, inte bokföringen.
      expect(svc._crossingEstimate(arm, after(0.5), 370, now)).toBeCloseTo(linear, -3);
      expect(svc._crossingEstimate(arm, after(null), 370, now)).toBeCloseTo(linear, -3);
      // Brusfart strax bortom bron: 20 m i 0,4 kn hade gett en bakåtskattning
      // ~23 s efter linjen. Under MINIMUM_VIABLE_SPEED bär farten ingen
      // skattning (samma gräns som ETA-vägen), så linjen gäller.
      const crawl = boat('LEAD', 20, 0.4, { bearing: 40 });
      const linear20 = T0 + 120 * S + 720 * S * (100 / 120);
      expect(now - (20 / (0.4 * 0.514444)) * S - linear20).toBeGreaterThan(20 * S);
      expect(svc._crossingEstimate(arm, crawl, 20, now)).toBeCloseTo(linear20, -3);
      // Långsamt fix efter bron, bakåtskattningen före linjen (här före t_före):
      // farten bär inte skattningen, linjen gäller.
      expect(now - (370 / (0.6 * 0.514444)) * S).toBeLessThan(T0 + 120 * S);
      expect(svc._crossingEstimate(arm, after(0.6), 370, now)).toBeCloseTo(linear, -3);
      // Båt i rörelse i fixet före bron: den räta linjen, som förut.
      expect(svc._crossingEstimate({ ...arm, sog: 6, waitingAtBridge: null }, after(6), 370, now))
        .toBeCloseTo(linear, -3);
    });
  });

  // ===========================================================================
  // F02/F22/F17 — bakkanten: släpp på det färska fixet, med egen deadline
  // ===========================================================================
  describe('F02/F22: medlemskapet omprövas mot en färsk prognos efter första passagen', () => {
    it('en följare vars färska prognos ligger bortom täckningen varnas med egen ledtid', () => {
      stageConvoyWithPassage();
      // Följaren saktar in: 1500 m i 5 kn ⇒ ankomst T0+853 s, efter täckningens
      // T0+840 s. Hon är nästa öppning; förut släpptes hon först vid T0+870 s,
      // efter sin egen ankomst, och avfyrade på den ärvda deadlinen.
      advanceTo(T0 + 270 * S);
      svc.observeVessel(boat('FOLLOWER', 1500, 5));
      const follower = armOf('FOLLOWER');
      expect(follower.absorbedAt).toBeNull();
      expect(debugLines('[OPENING_RECOVER]').some((l) => l.includes('bakkant'))).toBe(true);
      const arrival = follower.expectedArrivalMs;
      expect(arrival).toBeGreaterThan(T0 + 840 * S);

      advanceTo(T0 + 900 * S);
      const own = klaff().filter((w) => w.leadMmsi === 'FOLLOWER');
      expect(own).toHaveLength(1);
      // Egen deadline ur det färska fixet (KRAV 4), inte täckningens klocka.
      expect(own[0].t).toBeLessThanOrEqual(arrival - BRIDGE_OPENING.WARNING_LEAD_MS);
      expect(own[0].firedBy).toBe('deadline');
    });

    it('en följare vars färska prognos ligger INOM täckningen hör fortfarande till öppningen', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 270 * S);
      svc.observeVessel(boat('FOLLOWER', 1500, 6.9)); // ankomst ~T0+693 s
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      advanceTo(T0 + 600 * S);
      expect(klaff()).toHaveLength(1);
    });

    it('bakkanten väntar på ett fix EFTER bokföringen — rebaseringen ensam släpper ingen', () => {
      svc.observeVessel(boat('LEAD', 900, 6));
      svc.observeVessel(boat('FOLLOWER', 2400, 5.4)); // prognos ~T0+864 s, inom ledarens fönster
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      advanceTo(T0 + 240 * S);
      svc.notePassage('LEAD', 'Klaffbron');
      // Täckningen gäller nu till T0+840 s och följarens GAMLA prognos ligger
      // bortom den, men hon har inte setts sedan passagen bokfördes.
      expect(armOf('FOLLOWER').expectedArrivalMs).toBeGreaterThan(armOf('FOLLOWER').coverUntilMs);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      advanceTo(T0 + 600 * S);
      expect(klaff()).toHaveLength(1);
    });

    it('bakkanten mäts mot täckningsslutet även när ledaren passerade senare än prognosen', () => {
      // Ledaren väntar vid bron och passerar SENARE än sin prognos. K14
      // förlänger aldrig, så täckningen ligger kvar på prognosen medan
      // U2-fönstret räknas från passagen. Följaren släpps vid täckningsslutet
      // oavsett U2-fönstret; bakkanten flyttar bara släppet till fixet som
      // visar det, så att hon varnas med full ledtid. Att i stället jämföra mot
      // U2-fönstret höll kvar henne till täckningsslutet och gav en sen
      // varning (klustervärldarna 56, 119, 685 och 1643).
      svc.observeVessel(boat('LEAD', 900, 6));
      svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      const coverBefore = armOf('FOLLOWER').coverUntilMs;
      // Ledarens väntfix 20 m före bron: passagen kommer strax efter. notePassage
      // bokför den på bokföringstiden, eftersom armens senaste läge låg före
      // bron och det inte finns någon säker skattning (se _crossingUpperBound).
      advanceTo(T0 + 480 * S);
      svc.observeVessel(boat('LEAD', 20, 0.5));
      advanceTo(T0 + 500 * S);
      svc.notePassage('LEAD', 'Klaffbron');
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(event.firstPassageAt).toBeGreaterThan(T0 + 480 * S);
      const windowEnd = Math.max(event.firedAt, event.firstPassageAt) + BRIDGE_OPENING.CONVOY_WINDOW_MS;
      expect(armOf('FOLLOWER').coverUntilMs).toBe(coverBefore);
      expect(coverBefore).toBeLessThan(windowEnd);

      advanceTo(T0 + 510 * S);
      svc.observeVessel(boat('FOLLOWER', 1000, 4));
      const follower = armOf('FOLLOWER');
      const arrival = follower.expectedArrivalMs;
      expect(arrival).toBeGreaterThan(coverBefore);
      expect(arrival).toBeLessThanOrEqual(windowEnd);
      expect(follower.absorbedAt).toBeNull();
      expect(debugLines('[OPENING_RECOVER]').some((l) => l.includes('bakkant'))).toBe(true);

      // Egen varning före täckningsslutet, med full ledtid. Förut kom den
      // först vid täckningsslutet, ~104 s före ankomsten.
      advanceTo(coverBefore - 10 * S);
      const own = klaff().filter((w) => w.leadMmsi === 'FOLLOWER');
      expect(own).toHaveLength(1);
      expect(own[0].t).toBeLessThanOrEqual(arrival - BRIDGE_OPENING.WARNING_LEAD_MS);
    });
  });

  // ===========================================================================
  // F03/F20 — under bron när täckningen löper ut
  // ===========================================================================
  describe('F03/F20: tystnad under bron med ankomst inom täckningen är ingen ny öppning', () => {
    it('YRSA 2-klassen: 25 m före linjen i 7 kn, tyst — ingen varning efter passagen', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 600 * S);
      svc.observeVessel(boat('FOLLOWER', 25, 7)); // ankomst T0+607 s, inom täckningen
      advanceTo(T0 + 880 * S);
      expect(klaff()).toHaveLength(1);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(debugLines('[OPENING_RECOVER_HOLD]').some((l) => l.includes('under bron'))).toBe(true);
      // Nästa fix ligger bortom bron: passagen bokförs, ingen andra varning.
      advanceTo(T0 + 900 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 7, { bearing: 40 }));
      expect(armOf('FOLLOWER')).toBeUndefined();
      advanceTo(T0 + 1800 * S);
      expect(klaff()).toHaveLength(1);
    });

    it('ett nytt fix efter täckningsslutet som visar att hon fortfarande väntar släpper henne', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 600 * S);
      svc.observeVessel(boat('FOLLOWER', 25, 7));
      advanceTo(T0 + 880 * S);
      expect(klaff()).toHaveLength(1);
      // Hon ligger kvar under bron och väntar: ny prognos efter täckningen.
      svc.observeVessel(boat('FOLLOWER', 40, 0.6));
      const own = klaff().filter((w) => w.leadMmsi === 'FOLLOWER');
      expect(own).toHaveLength(1);
    });

    it('en hållen arm bokar ingen nolltidstimer (schemaläggaren)', () => {
      clearInterval(tickTimer);
      tickTimer = null;
      svc.destroy();
      svc = makeService({ scheduleDeadlines: true });
      stageConvoyWithPassage();
      advanceTo(T0 + 600 * S);
      svc.observeVessel(boat('FOLLOWER', 25, 7));
      advanceTo(T0 + 841 * S); // täckningsslutet + 1 ms ⇒ släppvägen håller armen
      expect(debugLines('[OPENING_RECOVER_HOLD]')).toHaveLength(1);
      // Ingen ny timer för den hållna armen: bara ett nytt fix kan häva hållet.
      expect(Number.isFinite(svc._scheduledDeadline)).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  // ===========================================================================
  // F14 — kursen leder bort från bron
  // ===========================================================================
  describe('F14: en kurs bort från bron släpps inte som egen öppning', () => {
    it('obekräftad U-sväng 700 m från bron: ingen fantomvarning, U-svängen avväpnar sedan', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 300 * S);
      // Appens riktning är fortfarande norr (Fix D:s debounce), men kursen
      // 200° leder bort från bron, som ZELDA:s cog 32,8° söderut.
      svc.observeVessel(boat('FOLLOWER', 700, 2.9, { cog: 200 }));
      advanceTo(T0 + 900 * S);
      expect(klaff()).toHaveLength(1);
      expect(debugLines('[OPENING_RECOVER_HOLD]').some((l) => l.includes('kursen leder bort'))).toBe(true);
      // Appen bekräftar vändningen: motbeviset avväpnar.
      advanceTo(T0 + 960 * S);
      svc.observeVessel(boat('FOLLOWER', 900, 3, { cog: 200, _routeDirection: 'south' }));
      expect(armOf('FOLLOWER')).toBeUndefined();
      advanceTo(T0 + 1800 * S);
      expect(klaff()).toHaveLength(1);
    });
  });

  // ===========================================================================
  // KARAKTÄRISERING — det som medvetet står kvar
  // ===========================================================================
  describe('U17-kontraktet: RECOVER vid täckningsslut för en tyst båt utanför bron', () => {
    it('kvar beväpnad 300 m före bron vid täckningsslutet ⇒ egen varning (säkerhetsvarningen behålls)', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 600 * S);
      svc.observeVessel(boat('FOLLOWER', 300, 4)); // ankomst ~T0+746 s, inom täckningen
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      advanceTo(T0 + 900 * S);
      // U17 (ägarbeslut 2026-11-04): säkerhetsvarningen för en tyst båt vars
      // senaste position sa att hon skulle hinna igenom den gemensamma
      // öppningen BEHÅLLS — ingen öppning får missas. Banken har äkta
      // räddningar av exakt den här formen (20260713-41h 219029305,
      // 20260804-17h 211488730), och samma form omfattar den tysta passagen i
      // F11/F23, som motorn registrerar som DESIGN med källa U17.
      const own = klaff().filter((w) => w.leadMmsi === 'FOLLOWER');
      expect(own).toHaveLength(1);
    });
  });

  // ===========================================================================
  // KORSNINGSANKARETS LEDTIDSGOLV (granskningen, F14-världen 227)
  // ===========================================================================
  describe('korsningsankarets golv: ingen egen varning under två tick som bara ankaret skapat', () => {
    /**
     * ORION avfyrar, sista fixet 72 m före bron T0+268 s, AIS-avbrott, och
     * passagen bokförs först T0+1025 s. Korsningen interpoleras till
     * ~T0+295,6 s. Returnerar händelsen.
     */
    const stageLateBookedPassage = () => {
      svc.observeVessel(boat('ORION', 900, 5.4));
      expect(klaff()).toHaveLength(1);
      advanceTo(T0 + 268 * S);
      svc.observeVessel(boat('ORION', 72, 5.4));
      advanceTo(T0 + 1025 * S);
      svc.observeVessel(boat('ORION', 1900, 5.4, { bearing: 40 }));
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(event.firstPassageAt).toBeLessThan(event.firstPassageRegisteredAt);
      return event;
    };

    it('ZELDA-klassen: upptäckt 60 m före bron, 23 s kvar ⇒ täckningen från bokföringen står kvar', () => {
      const event = stageLateBookedPassage();
      // LATE hörs första gången 60 m före bron i 5 kn: ankomst ~23 s bort.
      // Mot korsningen (~T0+296 s) ligger hon 753 s efter ⇒ ingen medlem;
      // mot bokföringen (T0+1025 s) 24 s efter ⇒ medlem, som på 7699cbe.
      advanceTo(T0 + 1026 * S);
      svc.observeVessel(boat('LATE', 60, 5));
      const late = armOf('LATE');
      expect(late.expectedArrivalMs - Date.now()).toBeLessThan(2 * BRIDGE_OPENING.TICK_INTERVAL_MS);
      expect(late.eventId).toBe(event.id);
      expect(late.absorbedAt).toBe(T0 + 1026 * S);
      expect(late.coverUntilMs).toBe(Math.max(event.firedAt, event.firstPassageRegisteredAt)
        + BRIDGE_OPENING.CONVOY_WINDOW_MS);
      expect(debugLines('[OPENING_ANCHOR_FLOOR]')).toHaveLength(1);
      advanceTo(T0 + 1100 * S);
      expect(klaff().filter((w) => w.leadMmsi === 'LATE')).toHaveLength(0);
    });

    it('golvets villkor: färskt rent fix, under två tick, medlem bara mot bokföringen', () => {
      const event = stageLateBookedPassage();
      advanceTo(T0 + 1026 * S);
      const now = Date.now();
      const W = BRIDGE_OPENING.CONVOY_WINDOW_MS;
      const events = svc._events.get('Klaffbron');
      const base = {
        mmsi: 'X',
        bridge: 'Klaffbron',
        lastSeenAt: now,
        lastObservedAt: null,
        lastFixClean: true,
        pendingArrivalObservation: false,
        expectedArrivalMs: now + 20 * S,
        releasedFrom: new Set(),
      };
      expect(svc._anchorFloorHost(base, events, now)).toBe(event);
      // U17: en TYST arm (inget fix i den här utvärderingen) får aldrig golvet.
      expect(svc._anchorFloorHost({ ...base, lastSeenAt: now - 600 * S }, events, now)).toBeNull();
      expect(svc._anchorFloorHost({ ...base, lastFixClean: false }, events, now)).toBeNull();
      expect(svc._anchorFloorHost({ ...base, lastObservedAt: now + 1 }, events, now)).toBeNull();
      // Två tick eller mer kvar: vanlig medlemsprövning, egen varning (U2).
      expect(svc._anchorFloorHost({ ...base, expectedArrivalMs: now + 2 * BRIDGE_OPENING.TICK_INTERVAL_MS },
        events, now)).toBeNull();
      // Inte medlem ens mot bokföringen.
      expect(svc._anchorFloorHost({ ...base, expectedArrivalMs: event.firstPassageRegisteredAt + W + 1 },
        events, now)).toBeNull();
      // Redan släppt ur händelsen.
      expect(svc._anchorFloorHost({ ...base, releasedFrom: new Set([event.id]) }, events, now)).toBeNull();
      // Utan flyttat ankare finns inget att återställa.
      const unmoved = { ...event, firstPassageAt: event.firstPassageRegisteredAt };
      expect(svc._anchorFloorHost(base, [unmoved], now)).toBeNull();
      // Den gamla täckningen har redan löpt ut: prognosen ligger fortfarande
      // inom fönstret mot bokföringen, men en absorption hade släppts direkt.
      advanceTo(Math.max(event.firedAt, event.firstPassageRegisteredAt) + W + S);
      const later = Date.now();
      const stale = { ...base, lastSeenAt: later, expectedArrivalMs: later - 30 * S };
      expect(Math.abs(stale.expectedArrivalMs - event.firstPassageRegisteredAt)).toBeLessThanOrEqual(W);
      expect(svc._anchorFloorHost(stale, [event], later)).toBeNull();
    });

    it('golvets medlemsvillkor avgör ensamt: ankomst strax efter fönstret mot bokföringen', () => {
      // Omgranskningens mutation X8 (villkoret borttaget) överlevde: fallet
      // ovan stoppas av tvåtickskravet. Här lever den gamla täckningen, och
      // ankomsten ligger under två tick bort — men 10 s efter bokföringen +
      // CONVOY_WINDOW_MS. Hon hörde inte till öppningen ens på 7699cbe, så
      // golvet har inget att återställa.
      const event = stageLateBookedPassage();
      const W = BRIDGE_OPENING.CONVOY_WINDOW_MS;
      const oldCoverEnd = Math.max(event.firedAt, event.firstPassageRegisteredAt) + W;
      advanceTo(oldCoverEnd - 25 * S);
      const now = Date.now();
      const arm = {
        mmsi: 'X',
        bridge: 'Klaffbron',
        lastSeenAt: now,
        lastObservedAt: null,
        lastFixClean: true,
        pendingArrivalObservation: false,
        expectedArrivalMs: event.firstPassageRegisteredAt + W + 10 * S,
        releasedFrom: new Set(),
      };
      expect(arm.expectedArrivalMs - now).toBeLessThan(2 * BRIDGE_OPENING.TICK_INTERVAL_MS);
      expect(now).toBeLessThanOrEqual(oldCoverEnd);
      expect(svc._anchorFloorHost(arm, [event], now)).toBeNull();
      // Kontroll: 20 s tidigare ankomst, inom fönstret mot bokföringen ⇒ golvet.
      expect(svc._anchorFloorHost({ ...arm, expectedArrivalMs: arm.expectedArrivalMs - 20 * S }, [event], now))
        .toBe(event);
    });
  });

  // ===========================================================================
  // KORSNINGSTID UTAN FIX BORTOM BRON (granskningen: notePassage och passagedomen)
  // ===========================================================================
  describe('korsningstiden när inget fix bortom bron finns', () => {
    it('notePassage när armens senaste läge redan låg bortom bron: fixets tid är övre gräns', () => {
      svc.observeVessel(boat('LEAD', 900, 6));
      advanceTo(T0 + 200 * S);
      // 300 m BORTOM bron, men appen saknar riktning i just det fixet, så
      // observeVessel:s geometriska ben är tyst. Appen bokför passagen senare.
      svc.observeVessel(boat('LEAD', 300, 6, { bearing: 40, _routeDirection: null }));
      expect(armOf('LEAD')).toBeDefined();
      advanceTo(T0 + 260 * S);
      svc.notePassage('LEAD', 'Klaffbron');
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(event.firstPassageAt).toBe(T0 + 200 * S);
      expect(event.firstPassageRegisteredAt).toBe(T0 + 260 * S);
    });

    it('observeVessel när armens senaste läge redan låg bortom bron: fixets tid är övre gräns', () => {
      // Omgranskningens systerställe (2026-11-05, kampanjens sond p1):
      // fixet bortom bron kom utan riktning och tillämpades, nästa fix med
      // riktning bokför passagen. Det finns inget fix före bron att interpolera
      // från, så _crossingEstimate ger null; förut gällde då bokföringstiden.
      svc.observeVessel(boat('LEAD', 900, 6));
      advanceTo(T0 + 100 * S);
      svc.observeVessel(boat('LEAD', 300, 6));
      advanceTo(T0 + 200 * S);
      svc.observeVessel(boat('LEAD', 300, 6, { bearing: 40, _routeDirection: null }));
      expect(armOf('LEAD')).toBeDefined();
      advanceTo(T0 + 400 * S);
      svc.observeVessel(boat('LEAD', 1200, 6, { bearing: 40 }));
      expect(armOf('LEAD')).toBeUndefined();
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(event.firstPassageAt).toBe(T0 + 200 * S);
      expect(event.firstPassageRegisteredAt).toBe(T0 + 400 * S);
      // En båt med ankomst ~T0+894 s ligger mer än 600 s efter korsningen
      // (senast T0+200 s): nästa öppning enligt U2, egen varning. Mot
      // bokföringen (T0+400 s) hade hon svalts.
      advanceTo(T0 + 700 * S);
      svc.observeVessel(boat('NEW', 600, 6));
      expect(armOf('NEW').absorbedAt).toBeNull();
      expect(klaff().filter((w) => w.leadMmsi === 'NEW')).toHaveLength(1);
    });

    it('notePassage när armens senaste läge låg FÖRE bron: bokföringstiden (ingen säker skattning)', () => {
      // MÄTT OCH AVVISAT: att projicera korsningen ur hennes prognos. En båt som
      // väntar efter sitt senaste fix korsar senare, och ett för tidigt fönster
      // gav en andra varning för samma öppning (opening-updated-host-forecast).
      svc.observeVessel(boat('ORION', 900, 5.4));
      advanceTo(T0 + 268 * S);
      svc.observeVessel(boat('ORION', 72, 5.4));
      advanceTo(T0 + 1025 * S);
      svc.notePassage('ORION', 'Klaffbron');
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(event.firstPassageAt).toBe(T0 + 1025 * S);
    });

    it('passagedomen som händelsens första passage ankras i fixets tid, inte i nu', () => {
      svc.observeVessel(boat('LEAD', 900, 6));
      svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      const cover = armOf('FOLLOWER').coverUntilMs; // ledarens prognos + 600 s, ingen passage bokförd
      advanceTo(T0 + 600 * S);
      // 300 m BORTOM bron, men utan riktning i just det fixet (se M01 nedan).
      svc.observeVessel(boat('FOLLOWER', 300, 5, { bearing: 40, _routeDirection: null }));
      advanceTo(cover + 30 * S);
      expect(armOf('FOLLOWER')).toBeUndefined();
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(event.firstPassageAt).toBe(T0 + 600 * S);
      expect(event.firstPassageRegisteredAt).toBeGreaterThan(cover);
    });
  });

  // ===========================================================================
  // GRINDAR SOM SAKNADE FÄLLANDE TEST (granskningens mutationer M01–M16)
  // ===========================================================================
  describe('grindar som saknade fällande test', () => {
    it('M01 — KRAV (1): bron bakom senaste läget vid täckningsslut ⇒ passage, ingen andra varning', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 600 * S);
      // Fixet ligger 300 m BORTOM bron, men appen saknar riktning i just det
      // fixet: observeVessel:s geometriska ben är tyst, och armen behåller
      // riktningen från beväpningen.
      svc.observeVessel(boat('FOLLOWER', 300, 5, { bearing: 40, _routeDirection: null }));
      expect(armOf('FOLLOWER')).toBeDefined();
      advanceTo(T0 + 900 * S);
      expect(armOf('FOLLOWER')).toBeUndefined();
      expect(debugLines('[OPENING_DISARM]').some((l) => l.includes('FOLLOWER') && l.includes('passage'))).toBe(true);
      advanceTo(T0 + 1800 * S);
      expect(klaff()).toHaveLength(1);
    });

    it('M02 — fryst arm vid täckningsslut: hålls kvar och seedar ingen händelse förrän ett fix kan tillämpas', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 600 * S);
      // Appen släpper målbron i det här fixet: armen kan inte uppdateras (C7b).
      svc.observeVessel(boat('FOLLOWER', 300, 4, { targetBridge: null }));
      expect(svc._hasUnappliedObservation(armOf('FOLLOWER'))).toBe(true);
      advanceTo(T0 + 900 * S);
      expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
      expect(debugLines('[OPENING_RECOVER_HOLD]').some((l) => l.includes('fryst arm'))).toBe(true);
      expect(debugLines('Öppningshändelse').filter((l) => l.includes('seed FOLLOWER'))).toHaveLength(0);
      // Första tillämpade fixet avgör: hon närmar sig fortfarande ⇒ egen varning.
      advanceTo(T0 + 930 * S);
      svc.observeVessel(boat('FOLLOWER', 250, 4));
      expect(klaff().filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(1);
    });

    it('M03 — KRAV (3), första ledet: utan ankomstfysik hålls armen (hängslen, prövas direkt)', () => {
      stageConvoyWithPassage();
      const arm = armOf('FOLLOWER');
      const event = svc._events.get('Klaffbron').find((e) => e.id === arm.eventId);
      const after = arm.coverUntilMs + 1;
      expect(svc._coverageVerdict({ ...arm, expectedArrivalMs: null }, event, after))
        .toEqual({ kind: 'hold', reason: 'ingen ankomstfysik' });
      expect(svc._coverageVerdict({ ...arm, earliestArrivalMs: Number.NaN }, event, after))
        .toEqual({ kind: 'hold', reason: 'ingen ankomstfysik' });
      expect(svc._coverageVerdict(arm, event, after)).toEqual({ kind: 'täckningsslut' });
    });

    it('M06 — bakkanten släpper bara på ett rent fix', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 270 * S);
      // Samma prognos som F02-fallet (ankomst efter täckningen), men läget är
      // osäkert (positionsanalysen tvekar; inget hopp som kräver bekräftelse).
      svc.observeVessel({ ...boat('FOLLOWER', 1500, 5), _positionUncertain: true });
      const arm = armOf('FOLLOWER');
      expect(arm.lastFixClean).toBe(false);
      expect(arm.expectedArrivalMs).toBeGreaterThan(arm.coverUntilMs);
      expect(arm.absorbedAt).toBe(T0);
      // Nästa rena fix med prognos bortom täckningen släpper henne.
      advanceTo(T0 + 300 * S);
      svc.observeVessel(boat('FOLLOWER', 1450, 5));
      expect(armOf('FOLLOWER').absorbedAt).toBeNull();
    });

    it('M08 — bakkanten släpper inte på ett fix vars kurs leder bort från bron', () => {
      stageConvoyWithPassage();
      advanceTo(T0 + 300 * S);
      // Prognosen ligger bortom täckningen, men kursen 200° leder bort från
      // bron (obekräftad U-sväng): en egen varning nu vore en fantom.
      svc.observeVessel(boat('FOLLOWER', 1500, 3, { cog: 200 }));
      const arm = armOf('FOLLOWER');
      expect(arm.expectedArrivalMs).toBeGreaterThan(arm.coverUntilMs);
      expect(arm.absorbedAt).toBe(T0);
      advanceTo(T0 + 830 * S);
      expect(klaff()).toHaveLength(1);
    });

    it('M10 — fryst arm vid passagen: korsningen bokförs på bokföringstiden (frysvakten)', () => {
      svc.observeVessel(boat('ORION', 900, 5.4));
      advanceTo(T0 + 268 * S);
      svc.observeVessel(boat('ORION', 72, 5.4));
      // Appen tappar målbron medan ORION fortfarande ligger FÖRE bron: fixet
      // läses men kan inte tillämpas. Hon hade alltså inte passerat T0+500 s.
      advanceTo(T0 + 500 * S);
      svc.observeVessel(boat('ORION', 30, 0.4, { targetBridge: null }));
      expect(svc._hasUnappliedObservation(armOf('ORION'))).toBe(true);
      advanceTo(T0 + 1025 * S);
      svc.observeVessel(boat('ORION', 1900, 5.4, { bearing: 40 }));
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      // Interpolationen mellan T0+268 s och T0+1025 s hade gett ~T0+296 s,
      // före ett läge som visade henne kvar före bron.
      expect(event.firstPassageAt).toBe(T0 + 1025 * S);
      expect(debugLines('[OPENING_PASSAGE_TIME]')).toHaveLength(0);
    });

    it('M14 — täckningsslutet rebaseras på bokföringen, inte på korsningen (U13, U17)', () => {
      // Revision 3: korsningen styr medlemskapet och bakkanten, men när en
      // TYST båt får sin säkerhetsvarning står kvar som på 7699cbe. ORIONs
      // korsning skattas till ~T0+282 s och bokförs T0+400 s; följarens
      // täckning (ORIONs prognos T0+324 s + 600 s) kortas inte, eftersom
      // bokföringen + 600 s ligger senare. Mot korsningen hade den kortats till
      // ~T0+882 s och den tysta följaren varnats före T0+900 s.
      svc.observeVessel(boat('ORION', 900, 5.4));
      svc.observeVessel(boat('FOLLOWER', 2400, 6.9)); // absorberad, tyst sedan
      const before = armOf('FOLLOWER').coverUntilMs; // ORIONs prognos + 600 s
      advanceTo(T0 + 268 * S);
      svc.observeVessel(boat('ORION', 72, 5.4));
      advanceTo(T0 + 400 * S);
      svc.observeVessel(boat('ORION', 600, 5.4, { bearing: 40 }));
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      expect(event.firstPassageAt).toBeCloseTo(T0 + 268 * S + 132 * S * (72 / 672), -2);
      const fromCrossing = Math.max(event.firedAt, event.firstPassageAt) + BRIDGE_OPENING.CONVOY_WINDOW_MS;
      expect(fromCrossing).toBeLessThan(before);
      expect(armOf('FOLLOWER').coverUntilMs).toBe(before);
      advanceTo(T0 + 900 * S);
      expect(klaff().filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(0);
      // Den tysta följaren prövas vid täckningsslutet som förut (U17).
      advanceTo(before + 60 * S);
      expect(klaff().filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(1);
    });

    it('bakkanten mäts mot U2-fönstret kring korsningen, fast täckningen räknas från bokföringen', () => {
      // Samma konvoj. Ett färskt fix efter bokföringen visar följaren med
      // ankomst efter korsningen + 600 s men före täckningsslutet: hon är
      // nästa öppning (U2) och släpps på fixet med egen deadline. Mätt mot
      // täckningsslutet ensamt hade hon hållits kvar till det och varnats på
      // en förfallen deadline (PRINCESS LIZYMAR-klassen, 20260713-41h).
      svc.observeVessel(boat('ORION', 900, 5.4));
      svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
      const cover = armOf('FOLLOWER').coverUntilMs;
      advanceTo(T0 + 268 * S);
      svc.observeVessel(boat('ORION', 72, 5.4));
      advanceTo(T0 + 400 * S);
      svc.observeVessel(boat('ORION', 600, 5.4, { bearing: 40 }));
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      const u2End = Math.max(event.firedAt, event.firstPassageAt) + BRIDGE_OPENING.CONVOY_WINDOW_MS;
      advanceTo(T0 + 420 * S);
      // Farten väljs så att ankomsten hamnar mitt mellan U2-fönstrets slut och
      // täckningsslutet.
      const target = (u2End + cover) / 2;
      const distance = 1500;
      const sog = distance / (((target - Date.now()) / 1000) * 0.514444);
      svc.observeVessel(boat('FOLLOWER', distance, sog));
      const follower = armOf('FOLLOWER');
      expect(follower.expectedArrivalMs).toBeGreaterThan(u2End);
      expect(follower.expectedArrivalMs).toBeLessThan(cover);
      expect(follower.absorbedAt).toBeNull();
      expect(debugLines('[OPENING_RECOVER]').some((l) => l.includes('bakkant'))).toBe(true);
    });

    it('en ny absorption börjar utan hållskäl (granskningen: recoverHeldAt)', () => {
      clearInterval(tickTimer);
      tickTimer = null;
      svc.destroy();
      svc = makeService({ scheduleDeadlines: true });
      stageConvoyWithPassage(); // händelse 1, FOLLOWER täckt t.o.m. T0+840 s
      advanceTo(T0 + 300 * S);
      svc.observeVessel(boat('FOLLOWER', 700, 2.9, { cog: 200 })); // kurs bort
      svc.tick();
      advanceTo(T0 + 841 * S);
      svc.tick();
      expect(armOf('FOLLOWER').recoverHeldAt).toBe(T0 + 841 * S);
      // En andra öppning: LEAD2 avfyrar direkt (deadlinen har redan förfallit).
      advanceTo(T0 + 850 * S);
      svc.observeVessel(boat('LEAD2', 900, 6));
      const second = klaff().find((w) => w.leadMmsi === 'LEAD2');
      expect(second).toBeDefined();
      // Kajstopp och ny avgång (app.js): täckningen nollställs utan släppvägen.
      svc.restartArrival('FOLLOWER', 'Klaffbron');
      advanceTo(T0 + 860 * S);
      svc.observeVessel(boat('FOLLOWER', 1000, 6)); // ankomst ~T0+1184 s, inom den andra öppningen
      const arm = armOf('FOLLOWER');
      expect(arm.eventId).toBe(second.eventId);
      expect(arm.absorbedAt).toBe(T0 + 860 * S);
      expect(arm.recoverHeldAt).toBeNull();
      expect(arm.recoverHoldReason).toBeNull();
    });
  });
});

// =============================================================================
// KRAV-NEGATIVEN — VIRGO och PILGRIM (ARCHITECTURE.md §H29/H30)
// =============================================================================
describe('KRAV-negativen: korsning under tystnad ger ingen andra varning', () => {
  const ROOT = path.resolve(__dirname, '..');
  const cache = new Map();
  const replay = (id) => {
    if (!cache.has(id)) {
      const corpus = corpora.find((c) => c.id === id);
      const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), corpus.jsonl], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        env: {
          ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
        },
      });
      cache.set(id, JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]));
    }
    return cache.get(id);
  };

  // [korpus, mmsi, namn, rådatans passage (gt-passages, inferred), fönstrets slut]
  it.each([
    ['20260710-13h', '265552100', 'VIRGO', '2026-07-10T11:52:51.307Z', '2026-07-10T12:30:00.000Z'],
    ['20260713-41h', '211110880', 'PILGRIM', '2026-07-14T12:30:25.915Z', '2026-07-14T13:00:00.000Z'],
  ])('%s %s (%s): ingen varning med henne som medlem efter passagen', (id, mmsi, _name, passage, until) => {
    const result = replay(id);
    const after = (result.openingWarnings || []).filter((w) => w.bridge === 'Stridsbergsbron'
      && w.iso > passage && w.iso <= until
      && (String(w.leadMmsi) === mmsi || (w.mmsis || []).map(String).includes(mmsi)));
    expect(after).toEqual([]);
  }, 120000);

  it('20260712-25h 265806230 (LAENGE LAEUFT): säkerhetsvarningen kommer som på 7699cbe (U13)', () => {
    // Den låsta raden som korsningsankrad täckning flyttade (alternativ A:
    // 08:34:15). Rådatan belägger inte när hon passerade, så raden är
    // likvärdig och får inte flyttas (U13; dirigentens beslut 2026-11-05).
    // Täckningsslutet räknas därför från bokföringen: MALUCAs passage
    // bokförd 08:27:18 + 600 s.
    const result = replay('20260712-25h');
    const own = (result.openingWarnings || []).filter((w) => w.bridge === 'Stridsbergsbron'
      && String(w.leadMmsi) === '265806230');
    expect(own.map((w) => w.iso.slice(11, 19))).toEqual(['08:37:18']);
  }, 120000);
});
