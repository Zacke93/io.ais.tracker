'use strict';

/**
 * U9 — RÄDDNINGSVENTILEN I ÖPPNINGSMOTORN (paket P7, 2026-08-10).
 *
 * BAKGRUND (etapp 7 fas C-IV, 2026-08-09): C8 byggde U2:s täckningsmekanism
 * strikt — en icke-ledande båt vars bro har en o-passerad avfyrad händelse får
 * ingen egen varning — och den mättes fullt ut. Kontraktet blev nåbart som tal
 * (kvot 1,242 → 0,957; öppningar med >1 varning 79 → 20) men priset var SEX
 * ovarnade öppningar (26 → 32) och O1-täckning 332/333 → 329/333, eftersom
 * deadline-garantin (`earliestArrival − WARNING_LEAD_MS`) förföll medan båten
 * var "täckt". C8 återkallades.
 *
 * ANVÄNDARBESLUTET 2026-08-09 (väg b): "garantin står, U2 mjukas." Täckningen
 * återinförs MED en räddningsventil: förfaller en täckt båts EGEN deadline
 * medan händelsen fortfarande är o-passerad, OCH ligger hennes ankomst efter
 * den avfyrade varningens prognosfönster, så får hon en individuell varning.
 *
 * SVITEN LÅSER BÅDA HALVORNA — täckningen (annars är U9 verkningslös) och
 * ventilen (annars är den C8 med nytt namn) — plus de tre gränser som gör
 * skillnaden mellan en räddning och en andrapåminnelse:
 *   (1) en arm INOM konvojfönstret räddas ALDRIG (U2: inga andrapåminnelser),
 *   (2) ventilen är stängd när händelsen fått sin passage,
 *   (3) ledtidsgolvet (2 tick) stänger ventilen när räddningen inte längre kan
 *       bli en användbar förvarning — då står den ursprungliga täckningen kvar.
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Position på `distanceM` meter från bron längs bäring `bearingDeg` (220° = söder). */
function posAtDistance(bridge, distanceM, bearingDeg = 220) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/** Fartygsobjekt i samma form som VesselDataService._createVesselObject ger. */
function makeVessel(overrides = {}) {
  const bridge = overrides.bridge || KLAFF;
  const distanceM = overrides.distanceM ?? 1000;
  const pos = posAtDistance(bridge, distanceM, overrides.bearing ?? 220);
  const now = Date.now();
  return {
    mmsi: overrides.mmsi || '265999001',
    name: overrides.name || 'TESTBÅT',
    lat: pos.lat,
    lon: pos.lon,
    sog: overrides.sog === undefined ? 5 : overrides.sog,
    cog: overrides.cog ?? 40,
    timestamp: overrides.timestamp ?? now,
    fixTs: overrides.fixTs ?? now,
    targetBridge: overrides.targetBridge === undefined ? bridge.name : overrides.targetBridge,
    _routeDirection: overrides._routeDirection === undefined ? 'north' : overrides._routeDirection,
    _finalTargetDirection: overrides._finalTargetDirection ?? null,
    _hasMovementProof: overrides._hasMovementProof === undefined ? true : overrides._hasMovementProof,
    _moored: overrides._moored === true,
    _stationarySince: overrides._stationarySince === undefined ? null : overrides._stationarySince,
    navStatus: overrides.navStatus === undefined ? null : overrides.navStatus,
    etaMinutes: overrides.etaMinutes ?? null,
    passedAt: overrides.passedAt || {},
    passedBridges: overrides.passedBridges || [],
  };
}

describe('U9: räddningsventilen i öppningsmotorn', () => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;

  const advance = (ms) => jest.advanceTimersByTime(ms);
  const warnFor = (bridgeName) => warnings.filter((w) => w.bridge === bridgeName);
  const armOf = (mmsi) => svc._arms.get(`${mmsi}::Klaffbron`);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    // MEKANIKEN PRÖVAS PÅSLAGEN. Flaggan är AV i drift (mätningen falsifierade
    // premissen — se härledningen vid BRIDGE_OPENING.U9_RESCUE_COVERAGE), men
    // koden ska förbli bevisat korrekt så länge den ligger kvar: annars ruttnar
    // den tyst och ett framtida användarbeslut aktiverar otestad logik.
    svc = new BridgeOpeningService({
      logger,
      onWarning: (payload) => warnings.push(payload),
      config: { U9_RESCUE_COVERAGE: true },
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
   * LEDAREN 700 m ut i 6 knop: hennes deadline har redan förfallit vid
   * beväpningen (700 m / 10 kn = 136 s < ledtiden 180 s), så händelsen avfyrar
   * i samma fix. Referensankomsten blir hennes förväntade ~227 s.
   */
  const fireLead = () => {
    svc.observeVessel(makeVessel({
      mmsi: 'LEAD', name: 'L', distanceM: 700, sog: 6,
    }));
    expect(warnFor('Klaffbron')).toHaveLength(1);
    return warnFor('Klaffbron')[0].eventId;
  };

  // =========================================================================
  // (A) TÄCKNINGEN — C8:s mekanism, återinförd
  // =========================================================================

  it('C8-täckningen: en båt BORTOM konvojfönstret knyts till den avfyrade, o-passerade händelsen', () => {
    const firedEventId = fireLead();

    // SEN: 2400 m ut med appens ETA 40 min ⇒ förväntad ankomst ligger ~37 min
    // efter referensen, dvs. långt utanför konvojfönstret (10 min).
    advance(30000);
    svc.observeVessel(makeVessel({
      mmsi: 'SEN', name: 'S', distanceM: 2400, sog: 2, etaMinutes: 40,
    }));

    const sen = armOf('SEN');
    expect(sen.eventId).toBe(firedEventId);
    expect(sen.coveredBeyondWindow).toBe(true);
    expect(sen.warnedAt).not.toBeNull();
    // Före U9 hade hon seedat en EGEN händelse på fläcken.
    expect(warnFor('Klaffbron')).toHaveLength(1);
  });

  it('en arm INOM konvojfönstret absorberas som förut — och flaggas ALDRIG som U9-täckt', () => {
    fireLead();
    advance(30000);
    svc.observeVessel(makeVessel({
      mmsi: 'NARA', name: 'N', distanceM: 900, sog: 5,
    }));

    const nara = armOf('NARA');
    expect(nara.absorbedAt).not.toBeNull();
    expect(nara.coveredBeyondWindow).toBe(false);
    // ...och hon kan därför aldrig nå räddningsventilen (U2: inga
    // andrapåminnelser). Enda vägen ut är _releaseStrandedArms tidsgräns.
    advance(4 * 60 * 1000);
    expect(warnFor('Klaffbron')).toHaveLength(1);
    expect(armOf('NARA').rescuedFrom.size).toBe(0);
  });

  // =========================================================================
  // (B) VENTILEN — garantin står
  // =========================================================================

  it('RÄDDNING: den täckta båtens EGNA deadline förfaller ⇒ hon får en egen varning', () => {
    const firedEventId = fireLead();
    advance(30000);
    svc.observeVessel(makeVessel({
      mmsi: 'SEN', name: 'S', distanceM: 2400, sog: 2, etaMinutes: 40,
    }));
    expect(armOf('SEN').coveredBeyondWindow).toBe(true);

    // Hennes egen deadline: 2400 m / 10 kn = 466 s till tidigast möjlig
    // ankomst, minus ledtiden 180 s ⇒ 286 s efter hennes fix.
    advance(5 * 60 * 1000);

    const klaff = warnFor('Klaffbron');
    expect(klaff).toHaveLength(2);
    const rescue = klaff[1];
    expect(rescue.mmsis).toEqual(['SEN']);
    expect(rescue.leadMmsi).toBe('SEN');
    // Räddningen är en EGEN öppning — aldrig värdens händelse (WARN-invarianten:
    // en avfyrad händelse avfyrar aldrig igen).
    expect(rescue.eventId).not.toBe(firedEventId);
    // ...och den ligger i sitt eget avfyrningsfönster (grinden i
    // runOpeningGates.analyseFireWindow kräver t − dueMs ∈ [0, 2 tick]).
    expect(rescue.t - rescue.dueMs).toBeGreaterThanOrEqual(0);
    expect(rescue.t - rescue.dueMs).toBeLessThanOrEqual(2 * BRIDGE_OPENING.TICK_INTERVAL_MS);
  });

  it('DEDUP: en räddning per (båt, händelse) — inte en per tick', () => {
    fireLead();
    advance(30000);
    svc.observeVessel(makeVessel({
      mmsi: 'SEN', name: 'S', distanceM: 2400, sog: 2, etaMinutes: 40,
    }));
    advance(5 * 60 * 1000);
    expect(warnFor('Klaffbron')).toHaveLength(2);

    // Ytterligare 20 tick utan nya fix får inte ge en tredje varning.
    advance(10 * 60 * 1000);
    expect(warnFor('Klaffbron')).toHaveLength(2);
    expect(armOf('SEN').rescuedFrom.size).toBe(1);
  });

  it('ventilen kräver att ankomsten ligger EFTER prognosfönstret — annars ingen räddning', () => {
    // Samma geometri, men appens ETA säger 3 min: hon ryms i konvojfönstret och
    // absorberas på den vanliga vägen. Ingen U9-flagga ⇒ ingen ventil.
    fireLead();
    advance(30000);
    svc.observeVessel(makeVessel({
      mmsi: 'SNABB', name: 'F', distanceM: 2400, sog: 9, etaMinutes: 3,
    }));
    expect(armOf('SNABB').coveredBeyondWindow).toBe(false);
    advance(5 * 60 * 1000);
    expect(warnFor('Klaffbron')).toHaveLength(1);
  });

  // =========================================================================
  // (C) GRÄNSERNA
  // =========================================================================

  it('VENTILEN ÄR STÄNGD när händelsen fått sin passage — då äger konvojtäckningens tidsgräns', () => {
    fireLead();
    advance(30000);
    svc.observeVessel(makeVessel({
      mmsi: 'SEN', name: 'S', distanceM: 2400, sog: 2, etaMinutes: 40,
    }));
    expect(armOf('SEN').coveredBeyondWindow).toBe(true);

    // Ledaren passerar INNAN den täckta båtens deadline hinner förfalla.
    advance(60000);
    svc.notePassage('LEAD', 'Klaffbron');

    // Vid hennes deadline (+286 s efter fixet) är händelsen passerad ⇒ ventilen
    // öppnar inte, och hon får ingen räddningsvarning.
    advance(4 * 60 * 1000);
    expect(armOf('SEN').rescuedFrom.size).toBe(0);
  });

  it('LEDTIDSGOLVET stänger ventilen — täckningen står kvar när räddningen vore värdelös', () => {
    fireLead();
    advance(30000);
    // SPURTEN: 2400 m ut i 2 knop ⇒ förväntad ankomst ~39 min, långt bortom
    // prognosfönstret (t0 + 827 s) ⇒ U9-täckt. Hennes egen deadline ligger
    // ännu 286 s fram, så garantin är intakt när täckningen ges.
    svc.observeVessel(makeVessel({
      mmsi: 'SPURTEN', name: 'G', distanceM: 2400, sog: 2,
    }));
    expect(svc._arms.get('SPURTEN::Klaffbron').coveredBeyondWindow).toBe(true);

    // 30 s senare rapporterar appen ETA 0,5 min för samma 2350 m (den
    // optimistiska ETA-klassen). Ankomstprognosen kollapsar till t0 + 90 s
    // medan deadlinen fortfarande ligger 337 s fram — och när deadlinen väl
    // förfaller är den förväntade ankomsten sedan länge passerad. En varning
    // där hade ersatt en fullgod konvojtäckning med en värdelös ledtid, så
    // ventilen håller stängt.
    advance(30000);
    svc.observeVessel(makeVessel({
      mmsi: 'SPURTEN', name: 'G', distanceM: 2350, sog: 2, etaMinutes: 0.5,
    }));
    advance(6 * 60 * 1000);
    const arm = svc._arms.get('SPURTEN::Klaffbron');
    expect(arm.coveredBeyondWindow).toBe(true);
    expect(arm.rescuedFrom.size).toBe(0);
    expect(warnFor('Klaffbron')).toHaveLength(1);
    // Loggen ska bära den stängda ventilen — klassen måste vara räknebar i fält.
    const declined = logger.debug.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[OPENING_RESCUE]') && s.includes('STÄNGD'));
    expect(declined.length).toBeGreaterThanOrEqual(1);
  });

  it('GARANTIN GÅR FÖRE TÄCKNINGEN: en arm vars deadline redan förfallit får ALDRIG bred täckning', () => {
    fireLead();
    // Ledaren står kvar beväpnad, så hennes avfyrade händelse lever vidare.
    advance(15 * 60 * 1000);
    // EFTERSLÄNTRAREN dyker upp 800 m ut: tidigast möjlig ankomst om 156 s,
    // dvs. hennes deadline (ledtid 180 s) är REDAN förfallen. Att täcka henne
    // vore rundgång — ventilen hade öppnat i samma utvärdering — så hon får
    // sin egen händelse direkt. (Utan villkoret studsade en nyss räddad arm
    // vidare till nästa avfyrade händelse: HEY JOE @ Klaffbron 2026-07-14.)
    svc.observeVessel(makeVessel({
      mmsi: 'EFTER', name: 'E', distanceM: 800, sog: 3, etaMinutes: 40,
    }));
    const arm = svc._arms.get('EFTER::Klaffbron');
    expect(arm.coveredBeyondWindow).toBe(false);
    const klaff = warnFor('Klaffbron');
    expect(klaff).toHaveLength(2);
    expect(klaff[1].mmsis).toEqual(['EFTER']);
  });

  it('täckningsflaggan dör med täckningen — en strandad arm prövas aldrig av ventilen', () => {
    fireLead();
    advance(30000);
    svc.observeVessel(makeVessel({
      mmsi: 'SEN', name: 'S', distanceM: 2400, sog: 2, etaMinutes: 40,
    }));
    expect(armOf('SEN').coveredBeyondWindow).toBe(true);
    // Räddningen sker vid hennes deadline; därefter är flaggan rensad och
    // armen bär en egen, avfyrad händelse.
    advance(5 * 60 * 1000);
    expect(armOf('SEN').coveredBeyondWindow).toBe(false);
    expect(armOf('SEN').absorbedAt).toBeNull();
    expect(armOf('SEN').coverUntilMs).toBeNull();
  });

  // =========================================================================
  // (D) DRIFTLÄGET — flaggan är AV
  // =========================================================================

  it('AVSTÄNGD I DRIFT: utan flaggan finns ingen bred täckning alls (baslinjens beteende)', () => {
    // Samma scenario som (A), men med produktionens konfiguration. Mätningen
    // 2026-08-10 fällde den breda täckningen: den splittrade fem äkta konvojer
    // (JOY + SEEBAER III @ Stridsbergsbron 2026-07-14 m.fl.), >1-räknaren gick
    // 80 → 81 och varningarna 364 → 369. Testet låser att produktionen INTE
    // kör mekaniken förrän ett nytt användarbeslut slår på den.
    const prod = new BridgeOpeningService({
      logger,
      onWarning: (payload) => warnings.push(payload),
    });
    prod.observeVessel(makeVessel({
      mmsi: 'LEAD', name: 'L', distanceM: 700, sog: 6,
    }));
    advance(30000);
    prod.observeVessel(makeVessel({
      mmsi: 'SEN', name: 'S', distanceM: 2400, sog: 2, etaMinutes: 40,
    }));
    const sen = prod._arms.get('SEN::Klaffbron');
    expect(sen.coveredBeyondWindow).toBe(false);
    expect(sen.absorbedAt).toBeNull();
    // Hon seedar sin EGEN händelse direkt, precis som före P7.
    expect(sen.eventId).not.toBe(warnFor('Klaffbron')[0].eventId);
    prod.destroy();
  });

  it('ARMFÄLTEN LIGGER PÅ ARMEN, inte på fartygsobjektet (fältlist-fällan)', () => {
    // Servicens doktrin (filhuvudet): armarna lever i servicens egen Map.
    // U9:s två nya fält får inte smyga sig in på vessel-objektet — då hade de
    // blivit fältlistans 14:e och 15:e offer.
    const vessel = makeVessel({ mmsi: 'LEAD', distanceM: 700, sog: 6 });
    svc.observeVessel(vessel);
    expect(Object.prototype.hasOwnProperty.call(vessel, 'coveredBeyondWindow')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(vessel, 'rescuedFrom')).toBe(false);
    const arm = armOf('LEAD');
    expect(arm.coveredBeyondWindow).toBe(false);
    expect(arm.rescuedFrom instanceof Set).toBe(true);
  });
});
