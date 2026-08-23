'use strict';

/**
 * N25 (helkodsgranskning RUNDA 5, 2026-08-23, minor) — ETT GPS-FLAGGAT PROV REV
 * ETT MOGET STILLHETSANKARE.
 *
 * MEKANISMEN. M1 gav _stillnessAnchorInvalidated tre led, varav ett var
 * "provet är GPS-flaggat ⇒ kasta ankaret". Predikatet används i TVÅ MOTSATTA
 * betydelser: i klockstartgrenarna betyder sant "plantera ett nytt ankare HÄR",
 * i rörelsegrenarna "radera ankaret". Ett flaggat prov gjorde alltså båda —
 * rev det mogna ankaret och planterade ett färskt vid nästa klockstart.
 *
 * SKYDDSVÄRDET VAR NOLL. _stillnessJitterHolds returnerar redan falskt på sitt
 * EGET villkor (1) för exakt samma prov, så klockan nollas ändå och ingen
 * målbro kan demoteras av ett flaggat prov. Ledet skyddade ingenting.
 *
 * KOSTNADEN BLEV DYR AV M1. Före M1 var ankaret färskvara och en radering
 * kostade noll. Efter M1 bär ankaret VISTELSENS ålder, så varje flaggat prov
 * kostar en ny 30-minutersmognad — och under den mognaden nollar varje brusprov
 * klockan, dvs. en ETABLERAD kajliggare avklassas och kan få målbro med
 * textflapp. Det är M1:s eget symptom, återinfört av M1:s egen hjälpmetod.
 *
 * UPPMÄTT I TVÅ ISOLERADE TRÄD (git archive HEAD mot arbetsträdet, samma rigg:
 * 36 min ren kajvistelse, en utflykt, återkomst VID kajen, därefter CARAT:s
 * brusprofil):
 *   150 m utflykt (fysikgrinden flaggar):  HEAD ankare=null, åter-förtöjd efter
 *                                          34 min (72 min från vistelsens start)
 *                                          → fixad: ankare 36 min, 6 min (44).
 *   100 m utflykt (ingen flagga, KONTROLL): 2 min i BÅDA armarna (40 min).
 * Kontrollen visar att den ENDA skillnaden är flaggan, inte förflyttningen.
 *
 * NÅBARHET: kräver över 100 m flaggad rörelse (GPSJumpAnalyzer accepterar allt
 * därunder utan flagga); noll flaggade kajsampel i korpusarna, därav noll
 * facitpåverkan — verifierat byte-identiskt replay:all/synthetic/openings/fusion.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const constants = require('../lib/constants');

const QUAY = { lat: 58.28767, lon: 12.285705 };
const M_PER_DEG_LAT = 111320;
const KADENS_MS = 2 * 60 * 1000;
const { ARM_STALE_TTL_MS } = constants.BRIDGE_OPENING;
const CARAT_SOG = [0.1, 0.8, 0.2, 1.2, 0.1, 0.6, 0.2, 1.5, 0.1, 0.7];

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
  liveServices.push(svc);
  return svc;
}

/**
 * Ett AIS-prov genom riktiga pipelinen (inkl. riktig GPSJumpAnalyzer).
 * @param {Object} svc - VesselDataService
 * @param {string} mmsi - fartygets mmsi
 * @param {number} nordM - meter norr om QUAY
 * @param {number} sog - fart i knop
 * @param {number} dt - tid sedan förra provet (ms)
 * @returns {Object} fartygsobjektet efter provet
 */
function prov(svc, mmsi, nordM, sog, dt) {
  NOW += dt;
  svc.updateVessel(mmsi, {
    mmsi, lat: QUAY.lat + nordM / M_PER_DEG_LAT, lon: QUAY.lon, sog, cog: 10, name: 'GPSTEST', timestamp: NOW,
  });
  return svc.vessels.get(mmsi);
}

/**
 * Hela scenariot: etablerad kajvistelse → utflykt → återkomst → brusprofil.
 * @param {number} utflyktM - utflyktens längd i meter (styr om flaggan sätts)
 * @returns {Object} mätvärden
 */
function scenario(utflyktM) {
  const svc = makeVDS();
  const mmsi = '265925001';
  const t0 = NOW;
  let forsteMooredMs = null;
  // 36 minuters REN kajvistelse: ankaret planteras vid första provet och
  // mognar (klockan nollas aldrig, alla prov är stillasampel).
  for (let i = 0; i * 2 < 36; i++) {
    const v = prov(svc, mmsi, ((i % 3) - 1) * 6, 0.1, KADENS_MS);
    if (v._moored && forsteMooredMs === null) forsteMooredMs = NOW - t0;
  }
  // Utflykten: ett STILLASAMPEL (sog 0,1) — klockan går, så re-stämplings-
  // blocket hoppas över och ankaret är orört av just det här provet.
  const ut = prov(svc, mmsi, utflyktM, 0.1, 60 * 1000);
  // Återkomsten VID kajen med ett BRUSPROV (sog 0,8 ≥ MOVEMENT_PROOF_SOG_KN).
  // Det är HÄR ledet slog till: hållet avstår (villkor 1, flaggad position) och
  // predikatet fick avgöra ankarets öde.
  const ater = prov(svc, mmsi, 0, 0.8, 60 * 1000);
  const t2 = NOW;
  let aterMooredMs = null;
  for (let i = 0; i * 2 < 90; i++) {
    const v = prov(svc, mmsi, ((i % 3) - 1) * 6, CARAT_SOG[i % CARAT_SOG.length], KADENS_MS);
    if (v._moored && aterMooredMs === null) aterMooredMs = NOW - t2;
  }
  return {
    forsteMooredMs,
    flaggadUt: ut._positionUncertain === true || ut._gpsJumpDetected === true,
    flaggadAter: ater._positionUncertain === true || ater._gpsJumpDetected === true,
    ankareEfterAter: ater._stillnessAnchor,
    ankarAlderEfterAterMs: ater._stillnessAnchor ? NOW - ater._stillnessAnchor.t : null,
    aterMooredMs,
  };
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

beforeEach(() => {
  NOW = 1754000000000;
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

describe('N25: GPS-flaggat prov river inte längre ett moget stillhetsankare', () => {
  test('150 m FLAGGAD utflykt: ankaret överlever återkomsten och mognaden behålls', () => {
    const r = scenario(150);
    // Riggkontroll: fysikgrinden MÅSTE ha flaggat båda proven, annars prövar
    // testet något annat än det påstår (0,1 kn ⇒ tillåtet ~62 m på 60 s).
    expect(r.flaggadUt).toBe(true);
    expect(r.flaggadAter).toBe(true);
    expect(r.forsteMooredMs).toBe(6 * 60 * 1000);
    // KÄRNAN: på HEAD var ankaret NULL efter återkomstprovet (ledet "GPS-flaggat
    // ⇒ kasta"). Nu lever det, och åldern är vistelsens — inte klockans.
    expect(r.ankareEfterAter).not.toBeNull();
    expect(r.ankarAlderEfterAterMs).toBeGreaterThanOrEqual(ARM_STALE_TTL_MS);
    // FÖLJDEN: hållet är nåbart igen direkt, så brusprofilen förtöjer henne på
    // 6 min i stället för HEAD:s 34 (= en hel ny ankarmognad + zonens 3 min).
    expect(r.aterMooredMs).toBe(6 * 60 * 1000);
    expect(r.aterMooredMs).toBeLessThan(ARM_STALE_TTL_MS);
  });

  test('100 m OFLAGGAD utflykt är KONTROLLEN: identisk i båda armarna', () => {
    const r = scenario(100);
    // GPSJumpAnalyzer accepterar allt under 100 m utan flagga, och 100 m ligger
    // på gränsen (`<= 100` ⇒ accepteras). Ingen flagga ⇒ N25 kan inte påverka.
    expect(r.flaggadUt).toBe(false);
    expect(r.flaggadAter).toBe(false);
    expect(r.ankarAlderEfterAterMs).toBeGreaterThanOrEqual(ARM_STALE_TTL_MS);
    // Uppmätt identiskt i HEAD-trädet och arbetsträdet: 2 min.
    expect(r.aterMooredMs).toBe(2 * 60 * 1000);
  });

  test('ÄKTA AVGÅNG kastar fortfarande ankaret, flagga eller ej', () => {
    // Kasseringsledet (a) är orört: nettot från ankaret ≥ MOVEMENT_PROOF_NET_M
    // river ankaret även när provet är flaggat. N25 tog bort ett LED, inte
    // predikatets uppgift.
    const svc = makeVDS();
    const mmsi = '265925002';
    for (let i = 0; i * 2 < 36; i++) prov(svc, mmsi, ((i % 3) - 1) * 6, 0.1, KADENS_MS);
    expect(svc.vessels.get(mmsi)._stillnessAnchor).not.toBeNull();
    // 300 m på 60 s med sog 3,0 kn: fysikgrinden flaggar (tillåtet ~185 m) och
    // nettot ligger långt över rörelsetröskeln.
    const v = prov(svc, mmsi, 300, 3.0, 60 * 1000);
    expect(v._positionUncertain === true || v._gpsJumpDetected === true).toBe(true);
    expect(v._stationarySince).toBeNull();
    expect(v._stillnessAnchor).toBeNull();
  });

  test('SAKNAT ANKARE PLANTERAS ÄVEN VID FLAGGAT PROV — annars vore hållet permanent stängt', () => {
    // Den återkallade varianten ("if (gpsSuspect) return false") hade lämnat
    // ankaret null hela vistelsen, eftersom planteringen BARA sker vid
    // klockstart. Raden nedan låser att planteringen fortfarande sker.
    const svc = makeVDS();
    const mmsi = '265925003';
    // Två prov 300 m isär i hög fart ⇒ flaggat OCH klocklöst; tredje provet är
    // ett stillasampel som startar klockan med flaggan fortfarande satt.
    prov(svc, mmsi, 0, 3.0, 0);
    const flaggat = prov(svc, mmsi, 300, 3.0, 60 * 1000);
    expect(flaggat._positionUncertain === true || flaggat._gpsJumpDetected === true).toBe(true);
    expect(flaggat._stillnessAnchor).toBeNull();
    const stilla = prov(svc, mmsi, 300, 0.1, 60 * 1000);
    expect(stilla._stationarySince).not.toBeNull();
    expect(stilla._stillnessAnchor).not.toBeNull();
    expect(stilla._stillnessAnchor.t).toBe(NOW);
  });
});
