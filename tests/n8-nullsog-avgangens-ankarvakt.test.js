'use strict';

/**
 * N8 (helkodsgranskning RUNDA 5, 2026-08-23, minor) — M1:s ANKARVAKT SAKNADES
 * PÅ NULL-SOG-VÄGENS AVGÅNGSGREN.
 *
 * MEKANISMEN. M1 grindade tre skrivställen för `_stillnessAnchor`, men
 * null-sog-vägens BEVISADE avgång (positionen har flyttat sig minst
 * MOVEMENT_PROOF_NET_M från null-sog-ankaret) nollade bara stillhetsKLOCKAN och
 * bytte null-sog-ankaret — `_stillnessAnchor` lämnades orört. Före M1 var det
 * ofarligt: nästa klockstart skrev ovillkorligt över ankaret. Efter M1 sker
 * överskrivningen bara när _stillnessAnchorInvalidated svarar sant, så ett
 * ankare från en TIDIGARE vistelse bars in i en NY — och eftersom ankaråldern
 * sedan M1 MÄTER VISTELSENS ÅLDER blev C9b:s 30-minutersmognad fabricerad och
 * jitterhållet öppnade direkt.
 *
 * VEM DRABBAS? BLANDSÄNDAREN (vissa prov med sog, andra utan). En ren
 * fartgivarlös båt läser aldrig `_stillnessAnchor` — fältet konsumeras bara av
 * _stillnessJitterHolds, som anropas från de FINITA grenarna. Avgången måste
 * alltså gå via null-sog-vägen och återkomsten bära finit brus.
 *
 * UPPMÄTT I TVÅ ISOLERADE TRÄD (git archive HEAD mot arbetsträdet, samma rigg):
 *   ÄRVD vistelse (44 min kaj med sog=null, bevisad 120 m-utflykt, återkomst
 *   30 m från gamla ankaret, därefter CARAT:s brusprofil):
 *     HEAD    → förtöjd efter 8 min på ett 133 min gammalt ankare.
 *     Fixad   → förtöjd efter 34 min.
 *   FÄRSK vistelse, identisk brusprofil: 34 min i BÅDA armarna.
 * Fixen får alltså den ärvda vistelsen att sammanfalla EXAKT med den färska —
 * det är hela poängen: mognaden ska mätas från den NYA vistelsens början.
 *
 * NÅBARHET I FÄLT: mycket låg (0 sog-null-prov i 14 836 korpussampel), därav
 * "minor" och noll väntad facitpåverkan — verifierat byte-identiskt
 * replay:all/synthetic/openings/fusion.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const constants = require('../lib/constants');

// Samma kajläge som M1-sviten (kapseln "Gästhamnen norr om Klaffbron").
const QUAY = { lat: 58.28767, lon: 12.285705 };
const M_PER_DEG_LAT = 111320;
const KADENS_MS = 2 * 60 * 1000;
const NET_M = constants.MOORING_DETECTION.MOVEMENT_PROOF_NET_M;
const { ARM_STALE_TTL_MS } = constants.BRIDGE_OPENING;
// CARAT:s egen brusprofil: vartannat prov över MOVEMENT_PROOF_SOG_KN, resten
// stillasampel. Inga gråzonsvärden (0,3–0,49) — N7 är alltså inte inblandad.
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
 * Ett AIS-prov på angivet nordavstånd från kajen.
 * @param {Object} svc - VesselDataService
 * @param {string} mmsi - fartygets mmsi
 * @param {number} nordM - meter norr om QUAY
 * @param {number|null} sog - fart i knop, eller null (fältet saknas)
 * @param {number} dt - tid sedan förra provet (ms)
 * @returns {Object} fartygsobjektet efter provet
 */
function prov(svc, mmsi, nordM, sog, dt) {
  NOW += dt;
  svc.updateVessel(mmsi, {
    mmsi, lat: QUAY.lat + nordM / M_PER_DEG_LAT, lon: QUAY.lon, sog, cog: 10, name: 'BLAND', timestamp: NOW,
  });
  return svc.vessels.get(mmsi);
}

/**
 * Brusfas med CARAT:s finita profil. Returnerar tiden till förtöjning.
 * @param {Object} svc - VesselDataService
 * @param {string} mmsi - fartygets mmsi
 * @param {number} startNordM - kajlägets nordavstånd
 * @param {number} minuter - fasens längd
 * @returns {number|null} ms till _moored, eller null om det aldrig hände
 */
function brusfas(svc, mmsi, startNordM, minuter) {
  const t0 = NOW;
  let mooredMs = null;
  for (let i = 0; i * 2 < minuter; i++) {
    const v = prov(svc, mmsi, startNordM + (((i % 3) - 1) * 6), CARAT_SOG[i % CARAT_SOG.length], KADENS_MS);
    if (v._moored && mooredMs === null) mooredMs = NOW - t0;
  }
  return mooredMs;
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

describe('N8: null-sog-avgångens ankarvakt', () => {
  test('BEVISAD null-sog-avgång kastar stillhetsankaret — spegel av finit-vägen', () => {
    const svc = makeVDS();
    const mmsi = '265908001';
    // 44 minuters fartgivarlös kajvistelse: klockan startar på andra provet och
    // _stillnessAnchor planteras med null-sog-ankarets ÄRLIGA starttid.
    for (let i = 0; i * 2 < 44; i++) prov(svc, mmsi, 0, null, KADENS_MS);
    const fore = svc.vessels.get(mmsi);
    expect(fore._moored).toBe(true);
    expect(fore._stillnessAnchor).not.toBeNull();
    expect(NOW - fore._stillnessAnchor.t).toBeGreaterThanOrEqual(ARM_STALE_TTL_MS);

    // Bevisad avgång: 120 m (> MOVEMENT_PROOF_NET_M) på ett null-sog-prov.
    const efter = prov(svc, mmsi, 120, null, 60 * 1000);
    expect(efter._moored).toBe(false);
    expect(efter._stationarySince).toBeNull();
    // KÄRNAN: på HEAD låg ankaret kvar (43 min gammalt) och bars in i nästa
    // vistelse. Nu kastas det — nettot 120 m ≥ MOVEMENT_PROOF_NET_M gör att
    // ankaret inte längre beskriver var båten ligger.
    expect(efter._stillnessAnchor).toBeNull();
    // Null-sog-ankaret stämplas om som förr (annan storhet, orörd av N8).
    expect(efter._nullSogStillAnchor.t).toBe(NOW);
  });

  test('ÅTERKOMSTEN MOGNAR OM: ärvd vistelse sammanfaller exakt med en färsk', () => {
    // ARM 1 — ÄRVD: kaj 44 min (sog=null) → bevisad 120 m-utflykt → återkomst
    // 30 m från gamla ankaret → CARAT:s brusprofil.
    const svcA = makeVDS();
    const mmsiA = '265908002';
    for (let i = 0; i * 2 < 44; i++) prov(svcA, mmsiA, 0, null, KADENS_MS);
    prov(svcA, mmsiA, 120, null, 60 * 1000);
    const arvdMs = brusfas(svcA, mmsiA, 30, 90);

    // ARM 2 — FÄRSK: samma brusprofil, ingen historia alls.
    NOW = 1754000000000;
    const svcB = makeVDS();
    const farskMs = brusfas(svcB, '265908003', 30, 90);

    // Uppmätt i två isolerade träd: HEAD gav 8 min för den ärvda (ett 133 min
    // gammalt ankare bars in) och 34 min för den färska. Fixen får dem att
    // sammanfalla — mognaden mäts från den NYA vistelsens början.
    expect(farskMs).toBe(34 * 60 * 1000);
    expect(arvdMs).toBe(farskMs);
    // Bandvakt oberoende av det exakta talet: den ärvda får ALDRIG förtöjas
    // snabbare än ankarmognaden, vilket var precis vad HEAD gjorde (8 min).
    expect(arvdMs).toBeGreaterThanOrEqual(ARM_STALE_TTL_MS);
  });

  test('40–49 m-bandet är INGET eget hål: ankaret omprövas vid nästa klockstart', () => {
    // Kandidatens andra påstådda ställe. Bandet (utanför jitterradien, under
    // rörelsebeviset) nollar bara klockan; ankaret prövas av
    // _stillnessAnchorInvalidated när klockan startar om, och nettot 45 m
    // ligger UNDER MOVEMENT_PROOF_NET_M, så ankaret ska BEHÅLLAS — det är
    // fortfarande samma vistelse.
    const svc = makeVDS();
    const mmsi = '265908004';
    for (let i = 0; i * 2 < 10; i++) prov(svc, mmsi, 0, null, KADENS_MS);
    const ank = { ...svc.vessels.get(mmsi)._stillnessAnchor };
    expect(NET_M).toBeGreaterThan(45); // riggens förutsättning, inte ett nytt tal
    const bandet = prov(svc, mmsi, 45, null, 60 * 1000);
    expect(bandet._stationarySince).toBeNull(); // klockan nollas (V1-4)
    expect(bandet._stillnessAnchor).toEqual(ank); // men ankaret lever
    // Två prov på plats startar klockan igen; ankaret behålls (netto < 50 m).
    prov(svc, mmsi, 45, null, 60 * 1000);
    const igen = prov(svc, mmsi, 45, null, 60 * 1000);
    expect(igen._stationarySince).not.toBeNull();
    expect(igen._stillnessAnchor).toEqual(ank);
  });
});
