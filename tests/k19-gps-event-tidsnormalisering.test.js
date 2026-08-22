'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');

/**
 * K19 (fältprov 10 2026-08-19, mätt över 19 korpusar 2026-08-22):
 * _detectGPSEventProtection hade ett naket `movementDistance > 200` utan
 * tidsnormalisering — systerhålet till GJ-1 i GPSJumpGateService._isVesselStable.
 * Vid AISHubs kadens (fix-Δ p50 152 s) betyder 200 m bara 2,6 kn, så helt normal
 * kanalfart etiketterades som "GPS-event": 599 av 603 gps-event-aktiveringar bars
 * av det benet, 835 av dess 836 utslag var fartkonsistenta enligt
 * GPSJumpAnalyzers EGET kriterium.
 *
 * Fixen speglar GJ-1: tillåten förflyttning = maxfart × dt × 2,0-marginalen, med
 * 200 m som GOLV (Math.max) så grinden bara kan bli strängare, aldrig slappare.
 *
 * Testerna låser tre egenskaper: (1) normal kanalfart passerar, (2) fysikaliskt
 * orimlig förflyttning fångas fortfarande, (3) utan tidsbas är beteendet exakt
 * som före fixen.
 */
describe('K19: gps-event-benet tidsnormaliseras (VDS._detectGPSEventProtection)', () => {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  let svc;

  // Kanalens mitt vid Stridsbergsbron-stråket; exakt värde saknar betydelse,
  // bara avståndet mellan samplen används.
  const BASE_LAT = 58.2900;
  const BASE_LON = 12.2890;

  // geometry.calculateDistance är haversine med R = 6371000 m ⇒ ren
  // nordförflyttning på d meter är d / (R·π/180) grader latitud.
  const M_PER_DEG_LAT = 6371000 * (Math.PI / 180);
  const northOf = (meters) => BASE_LAT + meters / M_PER_DEG_LAT;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });

  /**
   * Bygger sampelparet. dtS = sekunder mellan fixen. timeBase:
   *   'fix'  – fixklocka (fixFeed + fixTs), vägen 828 av 836 utslag tog
   *   'recv' – ingen fixklocka, bara mottagningsklockan (8 av 836)
   *   'none' – ingen tidsbas alls ⇒ dtMs = 0
   *   'dupfix' – samma feed OCH identisk fixTs (byte-identisk omleverans)
   */
  const par = ({
    meters, dtS, oldSog, newSog, timeBase = 'fix',
  }) => {
    const t0 = 1_760_000_000_000;
    const t1 = t0 + dtS * 1000;
    const oldVessel = {
      mmsi: '111111111', lat: BASE_LAT, lon: BASE_LON, sog: oldSog, cog: 30,
    };
    const vessel = {
      mmsi: '111111111', lat: northOf(meters), lon: BASE_LON, sog: newSog, cog: 30,
    };
    if (timeBase === 'fix' || timeBase === 'dupfix') {
      oldVessel.fixFeed = 'aishub';
      vessel.fixFeed = 'aishub';
      oldVessel.fixTs = t0;
      vessel.fixTs = timeBase === 'dupfix' ? t0 : t1;
    }
    // Mottagningsklockan går alltid framåt (även vid duplicerat fix) — det är
    // just det som gör 'dupfix' till en fälla värd ett eget test.
    oldVessel.timestamp = t0;
    vessel.timestamp = t1;
    oldVessel.lastPositionUpdate = t0;
    vessel.lastPositionUpdate = timeBase === 'none' ? t0 : t1;
    if (timeBase === 'none') {
      oldVessel.timestamp = t0;
      vessel.timestamp = t0;
    }
    return { vessel, oldVessel };
  };

  const avstand = ({ vessel, oldVessel }) => geometry.calculateDistance(
    oldVessel.lat, oldVessel.lon, vessel.lat, vessel.lon,
  );

  // ---------------------------------------------------------------------
  // 1. NORMAL KANALFART — fyndets kärna
  // ---------------------------------------------------------------------
  test('fältprov 10, rad 31707: 246,5 m på 67 s vid sog 5,5 kn är INTE gps-event', () => {
    const p = par({
      meters: 246.5, dtS: 67, oldSog: 5.5, newSog: 5.5,
    });
    // Bevisa att testet är meningsfullt: före fixen slog benet till här.
    expect(avstand(p)).toBeGreaterThan(200);
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(false);
  });

  // 90 s ligger mitt i AISHubs uppmätta kadens (fix-Δ p50 152 s) och är den
  // kortaste luckan där HELA 5–8 kn-bandet passerar gamla 200 m-gränsen — varje
  // fall nedan är alltså ett äkta regressionsfall, inte en gratispoäng.
  test.each([5, 6, 7, 8])('normal kanalfart %s kn över 90 s ⇒ ingen gps-event', (kn) => {
    const meters = (kn * 1852 * 90) / 3600; // exakt den fart båten rapporterar
    const p = par({
      meters, dtS: 90, oldSog: kn, newSog: kn,
    });
    expect(avstand(p)).toBeGreaterThan(200); // gamla benet hade slagit till här
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(false);
  });

  test('5 kn över 70 s (180 m) låg redan under gamla gränsen — oförändrat', () => {
    const p = par({
      meters: (5 * 1852 * 70) / 3600, dtS: 70, oldSog: 5, newSog: 5,
    });
    expect(avstand(p)).toBeLessThan(200);
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(false);
  });

  test('mottagningsklockan duger som tidsbas när fixklockan saknas', () => {
    const p = par({
      meters: 246.5, dtS: 67, oldSog: 5.5, newSog: 5.5, timeBase: 'recv',
    });
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // 2. ÄKTA HOPP — detektorn ska fortfarande fånga det orimliga
  // ---------------------------------------------------------------------
  test('400 m på 10 s ⇒ gps-event (implicerat 77,8 kn)', () => {
    const p = par({
      meters: 400, dtS: 10, oldSog: 5.0, newSog: 5.0,
    });
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  test('3000 m på 60 s vid sog 6 kn ⇒ gps-event även långt över 200 m-golvet', () => {
    const p = par({
      meters: 3000, dtS: 60, oldSog: 6, newSog: 6,
    });
    // allowed = 6·1852·(60/3600)·2 = 370,4 m > 200 ⇒ golvet är inte det som fäller
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  test('B1 behåller fallet där rapporterad sog MOTSÄGER förflyttningen', () => {
    // Mätningens bevarade fall: 1021 m på 479 s vid sog 1,0 → 1,8 kn.
    // allowed = 1,8·1852·(479/3600)·2 = 887 m < 1021 m ⇒ fortfarande gps-event.
    // (Ett platt 20 kn-tak hade släppt igenom detta — därför B1, inte B2.)
    const p = par({
      meters: 1021, dtS: 479, oldSog: 1.0, newSog: 1.8,
    });
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 3. SAKNAD TIDSBAS ⇒ KONSERVATIVT (exakt dagens beteende)
  // ---------------------------------------------------------------------
  test('utan tidsbas gäller 200 m-golvet oförändrat (dagens beteende)', () => {
    const p = par({
      meters: 246.5, dtS: 0, oldSog: 5.5, newSog: 5.5, timeBase: 'none',
    });
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  test('duplicerat fix (fixDtMs = 0) vidgar INTE grinden', () => {
    // GPSJumpAnalyzer.fixDtMs returnerar 0 — inte null — när två meddelanden
    // från SAMMA feed bär identisk fixTs (dokumenterad fälla, VDS:200). dtMs > 0
    // är falskt ⇒ 200 m-golvet gäller. Medvetet val: vi faller INTE tillbaka på
    // mottagnings-Δ här, eftersom positionen då inte är en ny mätning.
    const p = par({
      meters: 250, dtS: 70, oldSog: 5.5, newSog: 5.5, timeBase: 'dupfix',
    });
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 4. GJ-2/G-2-LÄXAN: ensidigt sog=null betyder "farten okänd", inte "stilla"
  // ---------------------------------------------------------------------
  test('ensidigt sog=null får 5 kn-golvet, inte 1 kn-golvet', () => {
    // 300 m på 70 s. Med 5 kn-golv: allowed = 360,1 m ⇒ inget gps-event.
    // Med 1 kn-golv hade allowed blivit max(200, 72,0) = 200 ⇒ gps-event.
    const p = par({
      meters: 300, dtS: 70, oldSog: 0.2, newSog: null,
    });
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(false);
  });

  test('BÅDA sog kända och nära noll ⇒ 1 kn-golvet (strängare)', () => {
    // 300 m på 70 s vid sog 0,2 → allowed = max(200, 1·1852·(70/3600)·2 = 72,0)
    // = 200 ⇒ gps-event. En förtöjd båt som "flyttar sig" 300 m är fortfarande fel.
    const p = par({
      meters: 300, dtS: 70, oldSog: 0.2, newSog: 0.2,
    });
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 5. GOLVET: grinden kan ALDRIG bli slappare än före fixen
  // ---------------------------------------------------------------------
  test('under 200 m ⇒ aldrig gps-event, oavsett dt (som före fixen)', () => {
    for (const dtS of [1, 10, 67, 152, 570, 1770]) {
      const p = par({
        meters: 199, dtS, oldSog: 5.5, newSog: 5.5,
      });
      expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(false);
    }
  });

  test('korta intervall behåller 200 m-golvet ⇒ 0 NYA utslag införs', () => {
    // 201 m på 1 s vid sog 0: allowed = max(200, 1·1852·(1/3600)·2 = 1,03) = 200.
    const p = par({
      meters: 201, dtS: 1, oldSog: 0, newSog: 0,
    });
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 6. DE ANDRA TVÅ BENEN ÄR ORÖRDA
  // ---------------------------------------------------------------------
  test('_gpsJumpDetected fäller fortfarande utan någon förflyttning alls', () => {
    const p = par({
      meters: 0, dtS: 70, oldSog: 5.5, newSog: 5.5,
    });
    p.vessel._gpsJumpDetected = true;
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  test('_positionUncertain fäller fortfarande utan någon förflyttning alls', () => {
    const p = par({
      meters: 0, dtS: 70, oldSog: 5.5, newSog: 5.5,
    });
    p.vessel._positionUncertain = true;
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 7. TIDSBASVAKTEN (granskningen, röda etappen 2026-08-22)
  //
  // Första versionen av K19 räknade mottagnings-Δ:n som nowTs − prevTs UTAN att
  // kräva att prevTs fanns. Saknade oldVessel både lastPositionUpdate och
  // timestamp blev prevTs = 0, dt hela epoken (~20 400 dygn) och det tillåtna
  // avståndet ~9·10⁹ m — grinden kunde ALDRIG slå till. Felriktningen var alltså
  // FAIL-OPEN, tvärtemot systermönstret _northProgressMps, som i samma läge blir
  // konservativt. Vakten (receiveDtMs kräver nowTs > 0 OCH prevTs > 0) gör att
  // avsaknad av tidsbas i stället faller tillbaka på 200 m-golvet = beteendet
  // före K19.
  // ---------------------------------------------------------------------
  test('oldVessel utan tidsstämpel: 5 km förflyttning fälls (fail-open stängd)', () => {
    const p = par({
      meters: 5000, dtS: 70, oldSog: 5.5, newSog: 5.5, timeBase: 'recv',
    });
    delete p.oldVessel.timestamp;
    delete p.oldVessel.lastPositionUpdate;
    // UTAN vakten: prevTs = 0 ⇒ dtMs ≈ 1,76·10¹² ms ⇒ allowed ≈ 9·10⁹ m ⇒ false.
    // MED vakten: ingen tidsbas ⇒ 200 m-golvet ⇒ true.
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  test('oldVessel utan tidsstämpel: 250 m fälls precis som före K19', () => {
    const p = par({
      meters: 250, dtS: 70, oldSog: 5.5, newSog: 5.5, timeBase: 'recv',
    });
    delete p.oldVessel.timestamp;
    delete p.oldVessel.lastPositionUpdate;
    expect(avstand(p)).toBeGreaterThan(200);
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  test('vessel utan tidsstämpel (nowTs = 0) ⇒ också 200 m-golvet', () => {
    const p = par({
      meters: 250, dtS: 70, oldSog: 5.5, newSog: 5.5, timeBase: 'recv',
    });
    delete p.vessel.timestamp;
    delete p.vessel.lastPositionUpdate;
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  test('out-of-order-par (negativ dt) får 200 m-golvet, aldrig ett negativt tak', () => {
    // OBS: detta test DÖDAR INGEN mutant — `dtMs > 0` är en EKVIVALENT vakt så
    // länge golvet är Math.max(200, …), vilket granskningen 2026-08-22 visade.
    // Det låser i stället det observerbara kontraktet, så att en framtida
    // sänkning av golvet inte tyst gör negativ dt till ett negativt tak.
    const p = par({
      meters: 250, dtS: -70, oldSog: 5.5, newSog: 5.5, timeBase: 'recv',
    });
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(true);
  });

  test('vakten rör INTE det normala fallet: båda tidsstämplarna finns', () => {
    // Samma sampel som avsnitt 1:s mottagningsklocktest — tidsnormaliseringen
    // ska fortfarande gälla när tidsbasen är giltig.
    const p = par({
      meters: 246.5, dtS: 67, oldSog: 5.5, newSog: 5.5, timeBase: 'recv',
    });
    expect(avstand(p)).toBeGreaterThan(200);
    expect(svc._detectGPSEventProtection(p.vessel, p.oldVessel)).toBe(false);
  });
});
