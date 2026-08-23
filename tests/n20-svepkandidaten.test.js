'use strict';

jest.mock('homey');

/**
 * N20 (helkodsgranskning RUNDA 5, 2026-08-23) — SEGMENTSVEPETS
 * TRIGGER-PUNKTSKANDIDAT FÖRLORADES NÄR FP9-GRINDEN SKIPPADE.
 *
 * MEKANISMEN FÖRE FIXEN: `_tpSweepCandidate` skrivs på exakt ETT ställe
 * (_onVesselUpdated) och finns inte i _createVesselObject:s fältlista, så
 * flaggan lever EN tick. FP9-gatens continue dödade kandidaten utan att sätta
 * någon dedup-nyckel — och för ett SVEP håller inte gatens löfte att notisen
 * bara fördröjs (ARCHITECTURE rad 457): båten har redan korsat punkten, och
 * nästa segment korsar den inte igen. Notisen uteblir alltså HELT.
 *
 * KORRIDOREN: sog under ~0,5 kn, SOG-sentinel eller förtöjd — där är sog-benet
 * gatens enda rörelsebevis.
 *
 * FIXEN SOM LANDADE — BEN A, EN RAD: ett MATCHANDE SVEP räknas som
 * transitindikation i nordgrenen. Det är en observation, inte ett antagande:
 * svepet kräver att BÅDA ändpunkterna ligger utanför 300 m-zonen, att
 * latituden är KORSAD mellan dem och att segmentets minsta avstånd ligger inne
 * i zonen. Samma bevis används redan som passagebevis i _hasPassedTriggerPoint.
 *
 * BEN B PRÖVADES OCH ÅTERKALLADES (dirigentbeslut, 2026-08-23). Benet lät ett
 * observerat latitudhopp (> 0,005°, ~550 m) passera _moored-returen i
 * large-jump-failsafen. Tre skäl fällde det: (1) den returen är inte en
 * godtycklig gate utan den kompenserande säkerhetsventil som infördes i SAMMA
 * commit som TOG BORT target-gaten; (2) benet hade NOLL uppmätt verkan i banken
 * (0 nya notiser i 18 korpusar, ~320 h) — obevisad vinst mot mätbar
 * falsklarmsrisk i pelare 2; (3) det fällde det låsta fältfallet
 * tests/korrigeringar-korning-2026-07-02b.test.js ("förtöjd båt är
 * undantagen", SY FREYJA, ~845 m latitudhopp ⇒ två nya fallback-notiser).
 * Klassen "förtöjd + oflaggat stort hopp" är därmed FORTFARANDE ÖPPEN och
 * väntar på fältbevis; se den härledande kommentaren vid returen i app.js.
 * Blocket N20 (c) nedan låser numera att ventilen står kvar.
 *
 * MÄTT FÖRE LANDNING: 18 svepgeometrier i banken, noll faktiska notisbortfall
 * på ~320 h — ben a väntas alltså ADDERA noll notiser i låst facit och
 * mätningen är grinden för att den får landa.
 *
 * MUTATIONSPROV (körs manuellt): ta bort `|| !!sweep` ur transitIndication ⇒
 * svep-testet nedan blir rött. Ändra failsafens `if (vessel._moored) return;`
 * till ben b:s villkor ⇒ det första testet i N20 (c) blir rött.
 */

const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const geometry = require('../lib/utils/geometry');
const {
  TRIGGER_POINTS, FLOW_CONSTANTS, QUAY_DEPARTURE_GATE, MOORING_DETECTION,
} = require('../lib/constants');

const TP = TRIGGER_POINTS.kanalinfarten;
const ZONE = FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD; // 300 m

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeApp() {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app._quayStableLedger = new Map();
  app._openingQuayLedger = new Map();
  app.bridgeRegistry = new BridgeRegistry();
  app.vesselDataService = {
    hasGpsJumpHold: () => false,
    isNearMooringZone: () => false,
    applyInferredPassage: jest.fn(),
  };
  app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
  app._lastKnownPositions = new Map();
  app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * 60 * 1000;
  return app;
}

// Ett glapp som lägger BÅDA ändpunkterna 522 m från punkten (utanför både
// 300 m-zonen och bokföringsbandet 500 m) medan segmentet passerar 50 m från
// den — CALIMA-klassens geometri, fast med ett längre glapp.
const lonAt = (lat, metres) => TP.lon + metres / (111320 * Math.cos((lat * Math.PI) / 180));
const SWEEP_PREV = { lat: TP.lat - 520 / 111320, lon: lonAt(TP.lat, 50) };
const SWEEP_CUR = { lat: TP.lat + 520 / 111320, lon: lonAt(TP.lat, 50) };

const proximityData = { bridges: [], nearestBridge: null };
const kanalCandidate = (app, vessel) => app._getFlowTriggerCandidates(vessel, proximityData)
  .find((c) => c.name === 'Kanalinfarten') || null;

/** Fartyg med brusigt/saknat fartvärde mitt i en observerad genomkorsning. */
const sweepingVessel = (over = {}) => ({
  mmsi: '265881122',
  lat: SWEEP_CUR.lat,
  lon: SWEEP_CUR.lon,
  sog: 0.4, // under MOVEMENT_PROOF_SOG_KN ⇒ FP9:s rörelsebevis faller
  cog: 10.0,
  targetBridge: null,
  passedBridges: [],
  // Flaggan sätts av _onVesselUpdated (segmentsvepet) exakt så här.
  _tpSweepCandidate: { name: TP.name, distance: 50 },
  ...over,
});

describe('N20 (a): svepets geometri är verkligen ett svep', () => {
  test('båda ändpunkterna utanför zonen OCH bandet, segmentet inne i zonen', () => {
    const dPrev = geometry.calculateDistance(SWEEP_PREV.lat, SWEEP_PREV.lon, TP.lat, TP.lon);
    const dCur = geometry.calculateDistance(SWEEP_CUR.lat, SWEEP_CUR.lon, TP.lat, TP.lon);
    const segDist = geometry.distancePointToSegmentM(
      TP.lat, TP.lon, SWEEP_PREV.lat, SWEEP_PREV.lon, SWEEP_CUR.lat, SWEEP_CUR.lon,
    );
    expect(dPrev).toBeGreaterThan(ZONE);
    expect(dCur).toBeGreaterThan(ZONE);
    expect(dPrev).toBeGreaterThan(QUAY_DEPARTURE_GATE.LEDGER_RADIUS_M);
    expect(segDist).toBeLessThanOrEqual(ZONE);
    // Latituden är KORSAD mellan ändpunkterna (svepets egen grind).
    expect((SWEEP_PREV.lat - TP.lat) * (SWEEP_CUR.lat - TP.lat)).toBeLessThan(0);
  });
});

describe('N20 (b): FP9-grinden får inte döda svepkandidaten', () => {
  test('FIXEN: svep utan målbro och med sog 0,4 kn ⇒ kandidaten överlever', () => {
    const app = makeApp();
    const vessel = sweepingVessel();
    app._noteQuayStability(vessel); // produktionens ordning: bokföring före notisväg

    const candidate = kanalCandidate(app, vessel);
    expect(candidate).not.toBeNull();
    expect(candidate.distance).toBe(50); // segmentets minsta avstånd
    expect(app.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('TRIGGER_POINT_SKIP_IDLE'),
    );
  });

  test('KONTROLLEN (HEAD): utan svepflaggan finns ingen kandidat alls', () => {
    const app = makeApp();
    const vessel = sweepingVessel({ _tpSweepCandidate: null });
    app._noteQuayStability(vessel);
    expect(kanalCandidate(app, vessel)).toBeNull();
  });

  test('GRINDEN LEVER: zonnärvaro utan svep och utan transitbevis skippas som förut', () => {
    const app = makeApp();
    const vessel = sweepingVessel({
      lat: TP.lat + 120 / 111320, // inne i zonen
      lon: TP.lon,
      _tpSweepCandidate: null,
    });
    app._noteQuayStability(vessel);

    expect(kanalCandidate(app, vessel)).toBeNull();
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('TRIGGER_POINT_SKIP_IDLE'));
  });

  test('SYDGRENEN ORÖRD: FP8:s kajstartarskydd gäller fortfarande', () => {
    const app = makeApp();
    const vessel = sweepingVessel({
      lat: SWEEP_PREV.lat, // söder om punkten
      lon: SWEEP_PREV.lon,
      sog: 3.0,
      _routeDirection: 'south',
      _firstSeenLat: TP.lat - 400 / 111320, // episoden började söder om punkten
    });
    app._noteQuayStability(vessel);

    expect(kanalCandidate(app, vessel)).toBeNull();
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('TRIGGER_POINT_SKIP'));
  });
});

describe('N20 (b2): RESTFALLET — svep INNE i bokföringsbandet', () => {
  /**
   * MÄTT EFTER FIXEN (och medvetet låst som gränsfall, inte som önskeläge):
   * ligger svepets ändpunkter INNE i bokföringsbandet (500 m) blir varje fix
   * med sog < MOVEMENT_PROOF_SOG_KN ett stillasample i V1-kartan, som flyttar
   * ankaret till AKTUELL position. Netto-närmandet blir då 0 m och
   * _quayDepartureNeedsProof (V1:s kajgrind, ett annat och äldre skydd)
   * skippar kandidaten — nu med loggraden TRIGGER_POINT_SKIP_QUAY i stället
   * för TRIGGER_POINT_SKIP_IDLE. FP9-gaten släpper alltså igenom svepet, men
   * kajgrinden avgör.
   *
   * ATT LÅTA SVEPET RÄKNAS ÄVEN DÄR ÄR EN EGEN, MÄTT ÄNDRING och ligger
   * utanför N20:s beslutade omfattning (syntesens fixförslag namnger
   * nordgrenen och failsafen). Testet finns för att restfallet inte ska tros
   * vara stängt.
   */
  test('CALIMA-nära geometri: kajgrinden avgör, och det syns i loggen', () => {
    const app = makeApp();
    const prev = { lat: TP.lat - 330 / 111320, lon: lonAt(TP.lat, 40) };
    const cur = { lat: TP.lat + 306 / 111320, lon: lonAt(TP.lat, 40) };
    app._noteQuayStability(sweepingVessel({ lat: prev.lat, lon: prev.lon, _tpSweepCandidate: null }));
    const vessel = sweepingVessel({
      lat: cur.lat, lon: cur.lon, _tpSweepCandidate: { name: TP.name, distance: 40 },
    });
    app._noteQuayStability(vessel);

    expect(kanalCandidate(app, vessel)).toBeNull();
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('TRIGGER_POINT_SKIP_QUAY'));
    expect(app.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('TRIGGER_POINT_SKIP_IDLE'),
    );
  });
});

describe('N20 (c): failsafens förtöjningsventil står KVAR (ben b återkallat)', () => {
  /**
   * Blocket bevakar ÅTERKALLANDET, inte ben b. Det som låses är att
   * _checkSkippedBridgesFallback fortfarande returnerar på `vessel._moored`
   * FÖRE hoppvektorn beräknas — den kompenserande ventilen till den borttagna
   * target-gaten. Ett framtida försök att öppna returen igen (utan fältbevis
   * och utan omlåsning av det låsta fältfallet i
   * tests/korrigeringar-korning-2026-07-02b.test.js) blir rött här FÖRST,
   * i samma fil som en gång bar ben b.
   */
  // ELFKUNGEN-geometrin ur gap-kedjan: 58.27192 → 58.29610 i ett 23-min-gap.
  const OLD = { lat: 58.27191833333333, lon: 12.2732 };
  const JUMPED = {
    mmsi: '265573130', lat: 58.2961, lon: 12.29717, sog: 6.7, cog: 50.2, targetBridge: 'Klaffbron',
  };

  test('ÅTERKALLAT: förtöjd båt MED observerat hopp fyrar inga notiser', async () => {
    const app = makeApp();
    await app._checkSkippedBridgesFallback({ ...JUMPED, _moored: true }, OLD);

    // Hoppet är per konstruktion stort (> 0,005°) — ändå tyst, därför att
    // förtöjningsklassningen fortfarande vinner. Detta är SY FREYJA-fältfallets
    // förväntan, uttryckt i N20:s egen geometri.
    expect(Math.abs(JUMPED.lat - OLD.lat)).toBeGreaterThan(0.005);
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('FAILSAFEN LEVER: samma hopp UTAN förtöjningsflagga fyrar som förut', async () => {
    const app = makeApp();
    await app._checkSkippedBridgesFallback({ ...JUMPED, _moored: false }, OLD);

    const fired = app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
    expect(fired).toEqual(['Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron']);
  });

  test('ÖVRIGA RETURER ORÖRDA: GPS-hållning stoppar hela svepet', async () => {
    const app = makeApp();
    app.vesselDataService.hasGpsJumpHold = () => true;
    // _moored: false så det verkligen är GPS-returen som prövas, inte
    // förtöjningsreturen ovanför den.
    await app._checkSkippedBridgesFallback({ ...JUMPED, _moored: false }, OLD);

    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('STORHETERNA (dokumenterar vad ben b vägde mot)', () => {
    expect(MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN).toBe(0.5);
    // 0,005° latitud ≈ 557 m, alltså långt bortom jitterskalan.
    expect(Math.round(0.005 * 111320)).toBe(557);
  });
});
