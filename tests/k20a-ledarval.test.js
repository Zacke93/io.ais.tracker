'use strict';

/**
 * K20a-REDO — LEDARVALET I ETT HALVT TILLÄMPAT POLLSVEP (fältprov 10, K20)
 * =============================================================================
 * FÄLTFALLET, ur rådata (ais-replay-20260819-081250.jsonl + app-loggen):
 *   09:12:06.419  265552060  CAPELLA      ← samma AISHub-poll…
 *   09:12:06.568  265606970  PILOT 761    ← …150 ms isär…
 *   09:12:06.719  304028000  BALTIC JONGLEUR  fix 09:11:47  d=1277 m
 *   09:12:06.868  211495920  TONGA            fix 09:11:47  d=1165 m
 * Basreplayn avfyrade Stridsbergsbron#2 i luckan mellan de två sista raderna.
 * Där jämfördes BJ:s NYSS uppdaterade 1277 m mot TONGA:s 79,7 s gamla 1308 m,
 * och kortet utsåg BALTIC JONGLEUR/northbound/eta 11. TONGA:s egen rad 149 ms
 * senare gav 1165 m — hon var NÄRMAST — och fältloggen bär också hennes namn
 * (TONGA/southbound/eta 8). Ett fassvep som bara flyttade korpusens starttid
 * 11,52 s bytte alltså ledande båt, riktning OCH ETA på identiska data.
 *
 * ⛔ K20a-PROJEKTIONEN ÄR ÅTERKALLAD och kommer inte tillbaka. `distanceM −
 *    sog·ålder` valde rätt båt i fältet men FEL i 2 av 2 observerbara
 *    korpusfall (20260525 Stridsbergsbron#7 MARIANNE→JOSEPHINE fast MARIANNE
 *    korsade 12,3 s först; 20260804-both-21h Klaffbron#27 BLADE→ELFKUNGEN fast
 *    ELFKUNGEN U-svängde vid Olidebron och aldrig nådde Klaffbron). Lösningen
 *    här ändrar bara NÄR jämförelsen görs — aldrig VAD som jämförs. Ett eget
 *    kontraktstest längst ned låser att ledarvalet är rått armavstånd.
 *
 * MUTATIONSPROV (körda 2026-08-21, alla fyra fäller — sha256-verifierad
 * återställning efter varje):
 *   1) ta bort raden `if (this._leadIsUnsettled(...)) continue;` i
 *      _evaluateBridge steg 4 ⇒ "FÄLTFALLET" + "GARANTIN" faller (ledaren blir
 *      BALTIC JONGLEUR/northbound, precis basreplayns fel).
 *   2) ta bort batchledet `if (!(this._observationGapMs <= BATCH_SETTLE_MS))`
 *      ⇒ "AISSTREAM-KONTRAKTET" + "BATCHFÖNSTRET" faller (20260525-klassen
 *      skjuts upp trots att ingen rad är på väg).
 *   3) ta bort `if (firedBy !== 'fix')` ⇒ "TICKEN ÄR ALLTID INERT" faller
 *      (taket "ett tick" är då inte längre bevisbart).
 *   4) ta bort `if (due.includes(lead))` ⇒ "EGEN DEADLINE" + "ENSAM MEDLEM"
 *      faller (varje avfyrning som är den färska armens EGEN skulle skjutas
 *      upp ett tick).
 * Grinden har INGEN `members.length < 2`-rad: due ⊆ members, så en händelse med
 * en enda medlem stoppas redan av led 4 (ledaren är förfallen) eller når aldrig
 * _fire (due är tom). En sådan rad hade varit en gren ingen mutation kan fälla.
 *
 * FÄLTLIST-FÄLLAN: paketet lägger INGA nya fält på fartygsobjektet — batch-
 * måttet lever på servicen (_prevObservationAt/_observationGapMs). Låst av ett
 * eget test längst ned.
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING, AIS_CONFIG } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;
const SPREAD = AIS_CONFIG.AISHUB.EMIT_SPREAD_MS; // 150 ms — poll-batchens takt

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Position `distanceM` meter från bron längs bäring `bearingDeg`. */
function posAtDistance(bridge, distanceM, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/**
 * Fartygsobjekt i samma form som VesselDataService._createVesselObject ger.
 * Sydgående båtar placeras NORR om bron (bäring 40) och nordgående SÖDER om
 * den (bäring 220) — annars ligger bron BAKOM dem och _canArm vägrar beväpna.
 */
function makeVessel(overrides = {}) {
  const dir = overrides.dir || 'north';
  const distanceM = overrides.distanceM ?? 1000;
  const pos = posAtDistance(KLAFF, distanceM, dir === 'south' ? 40 : 220);
  const now = Date.now();
  return {
    mmsi: overrides.mmsi,
    name: overrides.name || overrides.mmsi,
    lat: pos.lat,
    lon: pos.lon,
    sog: overrides.sog === undefined ? 5 : overrides.sog,
    cog: dir === 'south' ? 215 : 40,
    timestamp: overrides.timestamp ?? now,
    fixTs: overrides.fixTs ?? now,
    targetBridge: overrides.targetBridge === undefined ? KLAFF.name : overrides.targetBridge,
    _routeDirection: dir,
    _finalTargetDirection: null,
    _hasMovementProof: true,
    _moored: false,
    _stationarySince: null,
    navStatus: null,
    etaMinutes: null,
    passedAt: {},
    passedBridges: [],
  };
}

describe('K20a-redo — ledarvalet får inte avgöras mitt i ett pollsvep', () => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;

  const advance = (ms) => jest.advanceTimersByTime(ms);
  const warnFor = (bridgeName) => warnings.filter((w) => w.bridge === bridgeName);
  const armOf = (mmsi, bridgeName = KLAFF.name) => svc._arms.get(`${mmsi}::${bridgeName}`);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    svc = new BridgeOpeningService({
      logger,
      onWarning: (payload) => warnings.push(payload),
    });
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
   * FÄLTETS UTGÅNGSLÄGE, skalat till Klaffbron men med fältets EGNA tal:
   *   T0            TONGA 2400 m söderut, BALTIC JONGLEUR 2450 m norrut
   *                 (båda beväpnade, ingen deadline nära).
   *   T0+60 s       TONGA får sitt SISTA fix före racet: 1308 m ⇒ hennes
   *                 deadline förfaller T0+134,3 s.
   *   T0+139,85 s   … och sedan tystnar hon i 80 s, precis som i fältet.
   * Returnerar tiden för det sista TONGA-fixet.
   */
  const stageFieldRace = () => {
    svc.observeVessel(makeVessel({
      mmsi: 'TONGA', name: 'TONGA', dir: 'south', distanceM: 2400, sog: 4.6,
    }));
    svc.observeVessel(makeVessel({
      mmsi: 'BJ', name: 'BALTIC JONGLEUR', dir: 'north', distanceM: 2450, sog: 3.5,
    }));
    advance(60000);
    svc.observeVessel(makeVessel({
      mmsi: 'TONGA', name: 'TONGA', dir: 'south', distanceM: 1308, sog: 4.6,
    }));
    advance(79850); // → T0+139,85 s: TONGA förfallen sedan 5,6 s, ingen tick emellan
  };

  /** Poll-batchens FÖRSTA post: en båt utanför beväpningshorisonten. */
  const pollBatchFiller = () => svc.observeVessel(makeVessel({
    mmsi: 'CAPELLA', name: 'CAPELLA', dir: 'north', distanceM: 3000, sog: 4,
  }));

  // =========================================================================
  // FÄLTFALLET
  // =========================================================================
  it('FÄLTFALLET: ledarskapet avgörs INTE i luckan mellan två poster i samma poll', () => {
    stageFieldRace();
    expect(warnFor(KLAFF.name)).toHaveLength(0);
    expect(armOf('TONGA').fireDueMs).toBeLessThanOrEqual(Date.now()); // förfallen

    // --- POLL-BATCHEN, 150 ms mellan posterna (EMIT_SPREAD_MS) ---
    pollBatchFiller();
    advance(SPREAD);
    svc.observeVessel(makeVessel({
      mmsi: 'BJ', name: 'BALTIC JONGLEUR', dir: 'north', distanceM: 1277, sog: 3.5,
    }));
    // HÄR fyrade basreplayn: BJ:s färska 1277 m mot TONGA:s 80 s gamla 1308 m.
    expect(warnFor(KLAFF.name)).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('[OPENING_BATCH_SETTLE]'));

    advance(SPREAD - 1);
    svc.observeVessel(makeVessel({
      mmsi: 'TONGA', name: 'TONGA', dir: 'south', distanceM: 1165, sog: 5.2,
    }));

    // Varningen går ut när deadlinen ur det FÄRSKA fixet förfaller.
    advance(3 * BRIDGE_OPENING.TICK_INTERVAL_MS);
    const klaff = warnFor(KLAFF.name);
    expect(klaff).toHaveLength(1);
    expect(klaff[0].leadVessel).toBe('TONGA');
    expect(klaff[0].leadMmsi).toBe('TONGA');
    expect(klaff[0].direction).toBe('southbound');
    expect(klaff[0].vesselCount).toBe(2);
    // Kortets avstånd är TONGA:s EGET mätvärde, inte BJ:s och inget projicerat.
    expect(klaff[0].distanceM).toBe(Math.round(armOf('TONGA').distanceM));
    expect(klaff[0].distanceM).toBeLessThan(Math.round(armOf('BJ').distanceM));
  });

  // =========================================================================
  // AISSTREAM-KONTRAKTET — 20260525-klassen (MARIANNE/JOSEPHINE) rörs inte
  // =========================================================================
  it('AISSTREAM-KONTRAKTET: utan pågående pollsvep fyras det direkt, med den färska armen som ledare', () => {
    // Samma form som 20260525 Stridsbergsbron#7: JOSEPHINE bär ett 70 s gammalt
    // fix och är förfallen, MARIANNE kommer med ett färskt och är närmare. Det
    // finns INGEN rad på väg (aisstream, närmaste grannsampel > 8 s bort), så
    // ett uppskjut kan inte tillföra information — bara flytta varningen.
    // MARIANNE korsade också bron 12,3 s FÖRE JOSEPHINE i rådata.
    svc.observeVessel(makeVessel({
      mmsi: 'JOSEPHINE', name: 'JOSEPHINE', dir: 'south', distanceM: 2400, sog: 5.8,
    }));
    svc.observeVessel(makeVessel({
      mmsi: 'MARIANNE', name: 'MARIANNE', dir: 'south', distanceM: 2450, sog: 5.1,
    }));
    advance(60000);
    svc.observeVessel(makeVessel({
      mmsi: 'JOSEPHINE', name: 'JOSEPHINE', dir: 'south', distanceM: 1252, sog: 5.8,
    }));
    advance(79850);
    expect(warnFor(KLAFF.name)).toHaveLength(0);

    // INGEN batchgranne: förra observationen ligger 79,85 s bort.
    svc.observeVessel(makeVessel({
      mmsi: 'MARIANNE', name: 'MARIANNE', dir: 'south', distanceM: 1174, sog: 5.1,
    }));

    const klaff = warnFor(KLAFF.name);
    expect(klaff).toHaveLength(1);
    expect(klaff[0].leadVessel).toBe('MARIANNE');
    expect(klaff[0].firedBy).toBe('fix');
    expect(klaff[0].t).toBe(Date.now()); // avfyrad i SAMMA meddelande, inte uppskjuten
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('[OPENING_BATCH_SETTLE]'));
  });

  // =========================================================================
  // GRINDENS ÖVRIGA LED
  // =========================================================================
  it('TICKEN ÄR ALLTID INERT — taket "ett tick" är därmed bevisbart', () => {
    stageFieldRace();
    pollBatchFiller();
    advance(SPREAD);
    svc.observeVessel(makeVessel({
      mmsi: 'BJ', name: 'BALTIC JONGLEUR', dir: 'north', distanceM: 1277, sog: 3.5,
    }));
    const now = Date.now();
    const members = [armOf('TONGA'), armOf('BJ')];
    const due = members.filter((a) => a.fireDueMs <= now);
    // Kontrollprov: exakt samma tillstånd, bara ett annat firedBy.
    expect(svc._leadIsUnsettled({ id: 'X' }, members, due, 'fix', now)).toBe(true);
    expect(svc._leadIsUnsettled({ id: 'X' }, members, due, 'deadline', now)).toBe(false);
  });

  it('ENSAM MEDLEM: en händelse utan ledarkonkurrens fyras direkt mitt i batchen', () => {
    // Klassen är verklig: fältets Stridsbergsbron#8 och 20260712-25h
    // Stridsbergsbron#9 är enbåtshändelser som utvärderades av EN ANNAN båts
    // meddelande. De får aldrig kosta ett tick — och kan inte heller göra det,
    // eftersom due ⊆ members (se _leadIsUnsettled). Testet låser beteendet.
    pollBatchFiller();
    advance(SPREAD);
    svc.observeVessel(makeVessel({
      mmsi: 'SOLO', name: 'SOLO', dir: 'north', distanceM: 900, sog: 6,
    }));
    const klaff = warnFor(KLAFF.name);
    expect(klaff).toHaveLength(1);
    expect(klaff[0].vesselCount).toBe(1);
    expect(klaff[0].firedBy).toBe('fix');
    expect(klaff[0].t).toBe(Date.now());
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('[OPENING_BATCH_SETTLE]'));
  });

  it('EGEN DEADLINE: den färska armen fyrar direkt när varningen är HENNES', () => {
    // FIRST beväpnas långt ut; SECOND kommer i nästa poll-post 900 m ut och är
    // förfallen i samma ögonblick hon uppdateras. Hennes fix är alltså skälet
    // till avfyrningen och grinden får inte röra den.
    svc.observeVessel(makeVessel({
      mmsi: 'FIRST', name: 'FIRST', dir: 'north', distanceM: 2400, sog: 4,
    }));
    advance(SPREAD);
    svc.observeVessel(makeVessel({
      mmsi: 'SECOND', name: 'SECOND', dir: 'north', distanceM: 900, sog: 6,
    }));
    const klaff = warnFor(KLAFF.name);
    expect(klaff).toHaveLength(1);
    expect(klaff[0].leadVessel).toBe('SECOND');
    expect(klaff[0].firedBy).toBe('fix');
    expect(klaff[0].t).toBe(Date.now());
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('[OPENING_BATCH_SETTLE]'));
  });

  // =========================================================================
  // GARANTIN
  // =========================================================================
  it('GARANTIN: ett uppskjut kostar högst ETT tick, och utan färskare data blir utfallet HEAD:s', () => {
    stageFieldRace();
    pollBatchFiller();
    advance(SPREAD);
    const deferredAt = Date.now();
    svc.observeVessel(makeVessel({
      mmsi: 'BJ', name: 'BALTIC JONGLEUR', dir: 'north', distanceM: 1277, sog: 3.5,
    }));
    expect(warnFor(KLAFF.name)).toHaveLength(0);

    // TONGA tystnar helt — ingen ny rad kommer. Nästa tick måste fyra.
    advance(BRIDGE_OPENING.TICK_INTERVAL_MS);
    const klaff = warnFor(KLAFF.name);
    expect(klaff).toHaveLength(1);
    expect(klaff[0].firedBy).toBe('deadline');
    expect(klaff[0].t - deferredAt).toBeLessThanOrEqual(BRIDGE_OPENING.TICK_INTERVAL_MS);
    // Utan ny information är svaret exakt HEAD:s: BJ är närmast på rått avstånd.
    expect(klaff[0].leadVessel).toBe('BALTIC JONGLEUR');
    expect(klaff[0].vesselCount).toBe(2);
  });

  it('INGEN VARNING GÅR FÖRLORAD: antalet händelser och medlemmar är oförändrat', () => {
    stageFieldRace();
    pollBatchFiller();
    advance(SPREAD);
    svc.observeVessel(makeVessel({
      mmsi: 'BJ', name: 'BALTIC JONGLEUR', dir: 'north', distanceM: 1277, sog: 3.5,
    }));
    advance(SPREAD - 1);
    svc.observeVessel(makeVessel({
      mmsi: 'TONGA', name: 'TONGA', dir: 'south', distanceM: 1165, sog: 5.2,
    }));
    advance(10 * BRIDGE_OPENING.TICK_INTERVAL_MS);
    expect(warnFor(KLAFF.name)).toHaveLength(1);
    expect(warnFor(KLAFF.name)[0].mmsis.sort()).toEqual(['BJ', 'TONGA']);
    expect(svc.getStats().warningsFired).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // KONTRAKT
  // =========================================================================
  it('KONTRAKT: ledarvalet är rått armavstånd — ingen projektion (K20a förblir återkallad)', () => {
    // REGRESSIONSVAKT. _leadOf får bara jämföra arm.distanceM; varken
    // sog·ålder, ankomstprognos eller någon annan modell.
    expect(svc._leadDistanceM).toBeUndefined();
    const a = { distanceM: 1308, sog: 9, rawAnchorMs: T0 - 60000 };
    const b = { distanceM: 1277, sog: 0, rawAnchorMs: T0 };
    expect(svc._leadOf([a, b])).toBe(b);
    expect(svc._leadOf([b, a])).toBe(b);
    // …och _fire läser SAMMA funktion, så de två kan inte glida isär.
    expect(svc._fire.toString()).toContain('_leadOf(members)');
  });

  it('BATCHFÖNSTRET är härlett ur EMIT_SPREAD_MS, inte gissat', () => {
    // Grinden får aldrig slå till på en lucka som är större än två poster i
    // batchen — 3 × spridningen ska alltså vara utanför.
    stageFieldRace();
    pollBatchFiller();
    advance(3 * SPREAD);
    svc.observeVessel(makeVessel({
      mmsi: 'BJ', name: 'BALTIC JONGLEUR', dir: 'north', distanceM: 1277, sog: 3.5,
    }));
    expect(warnFor(KLAFF.name)).toHaveLength(1);
    expect(warnFor(KLAFF.name)[0].leadVessel).toBe('BALTIC JONGLEUR');
  });

  // =========================================================================
  // PASSAGEVÄGEN — batchledet ska vara inert AV ETT SKRIVET VILLKOR
  // =========================================================================
  it('NOTEPASSAGE: batchledet är EXPLICIT inert, inte inert av en sammanträffande tidsstämpel', () => {
    // GRANSKNINGSFYNDET 2026-08-21: _leadIsUnsettled läser this._observationGapMs,
    // ett mått som BARA observeVessel skriver. notePassage utvärderar också med
    // firedBy 'fix', så under ett pollsvep bar grinden in luckan ≤300 ms i ett
    // beslut som drevs av en PASSAGEBOKFÖRING, inte av ett pollsvep. Att den
    // ändå var inert vilade på att den enda arm som kunde ha
    // lastSeenAt === now var den passerande — som just avväpnats. Här bevisas
    // motsatsen: en passage för en båt UTAN arm (app.js:s inferens-/
    // backfill-väg) avväpnar ingen, och då NÅR utvärderingen grinden.
    clearInterval(tickTimer);
    tickTimer = null; // vi styr utvärderingarna själva

    // D bär ett GAMMALT fix och är förfallen; C kommer med ett FÄRSKT och är
    // närmare — exakt fältets form, så grinden skjuter upp vid C:s observation.
    svc.observeVessel(makeVessel({
      mmsi: 'D', name: 'DAPHNE', dir: 'north', distanceM: 1500, sog: 4,
    }));
    advance(140000); // D:s deadline (T0+111,6 s) har förfallit, ingen tick emellan
    pollBatchFiller();
    advance(SPREAD);
    svc.observeVessel(makeVessel({
      mmsi: 'C', name: 'CETUS', dir: 'north', distanceM: 1400, sog: 4,
    }));
    expect(warnFor(KLAFF.name)).toHaveLength(0); // uppskjutet, som avsett
    expect(svc._observationGapMs).toBe(SPREAD);

    // SAMMA MILLISEKUND: en passage bokförs för en båt utan arm. Utvärderingen
    // är passage-driven ⇒ batchledet får inte hålla varningen kvar en gång till.
    svc.notePassage('INFERRED', KLAFF.name);
    expect(svc._observationGapMs).toBe(Infinity);
    const klaff = warnFor(KLAFF.name);
    expect(klaff).toHaveLength(1);
    expect(klaff[0].leadVessel).toBe('CETUS');

    // MÅTTET LÄCKER INTE: nästa observeVessel räknar om det ur
    // _prevObservationAt, som notePassage inte rör.
    advance(SPREAD);
    svc.observeVessel(makeVessel({
      mmsi: 'C', name: 'CETUS', dir: 'north', distanceM: 1350, sog: 4,
    }));
    expect(svc._observationGapMs).toBe(SPREAD);
  });

  it('FÄLTLIST-FÄLLAN: inga nya fält på fartygsobjektet', () => {
    const vessel = makeVessel({ mmsi: 'RENT', dir: 'north', distanceM: 900 });
    const before = Object.keys(vessel).sort();
    svc.observeVessel(vessel);
    advance(SPREAD);
    svc.observeVessel(vessel);
    svc.tick();
    expect(Object.keys(vessel).sort()).toEqual(before);
    // Batchmåttet lever på SERVICEN, inte på fartyget.
    expect(Number.isFinite(svc._observationGapMs)).toBe(true);
  });
});
