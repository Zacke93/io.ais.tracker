'use strict';

/**
 * N7 (helkodsgranskning RUNDA 5, 2026-08-23, minor) — GRÅZONEN 0,3–0,49 kn VAR
 * M1:s OSKYDDADE SYSTERGREN.
 *
 * MEKANISMEN. Släpp-hysteresen i _updateMooringEvidence har tre grenar för ett
 * finit sog-prov:
 *   • sog < STATIONARY_SOG_KN (0,3)      → stillasampel, klockan startar/lever.
 *   • sog >= MOVEMENT_PROOF_SOG_KN (0,5) → rörelsesampel; M1/C9b frågar
 *     _stillnessJitterHolds innan klockan nollas.
 *   • gråzonen 0,3–0,49                  → två konsekutiva prov nollade klockan
 *     UTAN att fråga hållet.
 * Asymmetrin var bakvänd: ett SVAGARE rörelseindicium släppte en etablerad
 * kajliggare som ett STARKARE höll kvar. Ankaret rördes inte (det förblev
 * moget), men klockan dog ⇒ _classifyMooring fick "icke-stationär" ⇒
 * förtöjningen föll och målbron kunde återtilldelas med falsk broöppningstext.
 *
 * FÄLTMÄTNINGEN. 0 av 43 gråzonspar i de 18 korpusarna träffade en REDAN
 * förtöjd båt, så skadan i dag är noll och facit är byte-identiskt (verifierat i
 * två isolerade träd, replay:all + synthetic + openings + fusion). Det
 * kontrafaktiska provet är däremot dyrt: ETT enda CARAT-prov ändrat 0,2 → 0,4
 * ger 6,7 minuters falsk "beräknad broöppning om 27 minuter".
 *
 * FIXEN anropar _stillnessJitterHolds även i gråzonsgrenen innan klockan
 * nollas. Tvåsamplingshysteresen och _mooredReleasePending är OFÖRÄNDRADE.
 * Testerna nedan går genom RIKTIGA PIPELINEN (updateVessel) — inga interna fält
 * injiceras.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const constants = require('../lib/constants');

// Samma kajläge som M1-sviten: inne i kapseln "Gästhamnen norr om Klaffbron"
// (radie 35 m, queueGraceMs 0 ⇒ stillhetskravet är baskravet 3 min), ~412 m
// norr om Klaffbron.
const QUAY = { lat: 58.28767, lon: 12.285705 };
const M_PER_DEG_LAT = 111320; // meridiangraden
const { ARM_STALE_TTL_MS } = constants.BRIDGE_OPENING;
const NET_M = constants.MOORING_DETECTION.MOVEMENT_PROOF_NET_M;
const KADENS_MS = 2 * 60 * 1000;

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
 * Etablerad kajliggare med REN fartgivare: 0,1 kn var 2:a minut tills ankaret
 * passerat ARM_STALE_TTL_MS med god marginal. Klockan nollas aldrig (alla prov
 * är stillasampel), så ankaret är exakt lika gammalt som vistelsen.
 * @param {Object} svc - VesselDataService
 * @param {string} mmsi - fartygets mmsi
 * @param {number} minuter - vistelsens längd före gråzonsproven
 * @returns {number} tidpunkten då vistelsen började (ms)
 */
function laggTillKajs(svc, mmsi, minuter) {
  const t0 = NOW;
  for (let i = 0; i * 2 < minuter; i++) {
    svc.updateVessel(mmsi, {
      mmsi,
      lat: QUAY.lat + (((i % 3) - 1) * 6) / M_PER_DEG_LAT, // ±6 m kajvobbel
      lon: QUAY.lon,
      sog: 0.1,
      cog: 10,
      name: 'GRAZON',
      timestamp: NOW,
    });
    NOW += KADENS_MS;
  }
  return t0;
}

/**
 * Ett gråzonsprov (0,4 kn) på angivet nordavstånd från kajankaret.
 * @param {Object} svc - VesselDataService
 * @param {string} mmsi - fartygets mmsi
 * @param {number} nordM - meter norr om QUAY
 * @returns {Object} fartygsobjektet efter provet
 */
function grazonsprov(svc, mmsi, nordM) {
  svc.updateVessel(mmsi, {
    mmsi,
    lat: QUAY.lat + nordM / M_PER_DEG_LAT,
    lon: QUAY.lon,
    sog: 0.4,
    cog: 10,
    name: 'GRAZON',
    timestamp: NOW,
  });
  NOW += KADENS_MS;
  return svc.vessels.get(mmsi);
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

describe('N7: gråzonens jitterhåll (0,3–0,49 kn)', () => {
  test('MOGET ANKARE + två gråzonsprov PÅ PLATS ⇒ förtöjningen står kvar', () => {
    const svc = makeVDS();
    const mmsi = '265907001';
    const t0 = laggTillKajs(svc, mmsi, 36);
    const forePar = svc.vessels.get(mmsi);
    // Riggkontroll: hon ÄR förtöjd, ankaret ÄR moget och klockan går.
    expect(forePar._moored).toBe(true);
    expect(NOW - forePar._stillnessAnchor.t).toBeGreaterThanOrEqual(ARM_STALE_TTL_MS);
    expect(forePar._stationarySince).not.toBeNull();
    const ankareFore = { ...forePar._stillnessAnchor };

    // Prov 1: hysteresen kräver två — klockan lever oavsett fix.
    const e1 = grazonsprov(svc, mmsi, 0);
    expect(e1._stationarySince).not.toBeNull();
    expect(e1._moored).toBe(true);

    // Prov 2: HÄR låg buggen. På HEAD nollades klockan ovillkorligt och
    // förtöjningen föll; med N7 frågas hållet först (moget ankare, netto ~0 m,
    // ren position) och klockan behålls.
    const e2 = grazonsprov(svc, mmsi, 0);
    expect(e2._stationarySince).not.toBeNull();
    expect(e2._moored).toBe(true);
    // Klockan står orörd sedan vistelsens början — hållet FÖRLÄNGER inte, det
    // avstår bara från att nolla.
    expect(e2._stationarySince).toBeLessThanOrEqual(t0 + KADENS_MS);
    // Ankaret skrivs ALDRIG i gråzonsgrenen, varken före eller efter N7.
    expect(e2._stillnessAnchor).toEqual(ankareFore);
  });

  test('SAMMA PAR MEN NETTO ≥ 50 m ⇒ klockan nollas och förtöjningen släpper', () => {
    const svc = makeVDS();
    const mmsi = '265907002';
    laggTillKajs(svc, mmsi, 36);
    expect(svc.vessels.get(mmsi)._moored).toBe(true);

    // Prov 1 halvvägs ut (under tröskeln): hysteresen kräver två prov ändå.
    const e1 = grazonsprov(svc, mmsi, NET_M / 2);
    expect(e1._stationarySince).not.toBeNull();

    // Prov 2 bortom rörelsetröskeln: villkor (3) i _stillnessJitterHolds
    // faller, klockan nollas och kajliggaren släpps — precis som på HEAD.
    const e2 = grazonsprov(svc, mmsi, NET_M + 15);
    expect(e2._stationarySince).toBeNull();
    expect(e2._moored).toBe(false);
  });

  test('UNGT ANKARE (< 30 min) ⇒ gråzonsparet släpper som före N7', () => {
    const svc = makeVDS();
    const mmsi = '265907003';
    // 20 minuters vistelse: ankaret är omoget, villkor (2) i hållet faller.
    laggTillKajs(svc, mmsi, 20);
    const fore = svc.vessels.get(mmsi);
    expect(NOW - fore._stillnessAnchor.t).toBeLessThan(ARM_STALE_TTL_MS);
    grazonsprov(svc, mmsi, 0);
    const e2 = grazonsprov(svc, mmsi, 0);
    expect(e2._stationarySince).toBeNull();
  });

  test('HYSTERESEN ÄR OFÖRÄNDRAD: ett ensamt gråzonsprov nollar aldrig, och räknaren nollställs av ett stillasampel', () => {
    const svc = makeVDS();
    const mmsi = '265907004';
    laggTillKajs(svc, mmsi, 36);
    // Ett gråzonsprov …
    const e1 = grazonsprov(svc, mmsi, 0);
    expect(e1._mooredReleasePending).toBe(1);
    // … följt av ett stillasampel nollställer räknaren (S-F7-hysteresen).
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat, lon: QUAY.lon, sog: 0.1, cog: 10, name: 'GRAZON', timestamp: NOW,
    });
    NOW += KADENS_MS;
    expect(svc.vessels.get(mmsi)._mooredReleasePending).toBe(0);
    // Räknaren nollställs OCKSÅ när hållet slår till — N7 rör inte
    // _mooredReleasePending, så nästa par prövas från noll.
    grazonsprov(svc, mmsi, 0);
    const e3 = grazonsprov(svc, mmsi, 0);
    expect(e3._mooredReleasePending).toBe(0);
    expect(e3._stationarySince).not.toBeNull();
  });

  test('GPS-FLAGGAT gråzonsprov får aldrig motivera ett håll (S-F5-riktningen)', () => {
    const svc = makeVDS();
    const mmsi = '265907005';
    laggTillKajs(svc, mmsi, 36);
    // Villkor (1) i _stillnessJitterHolds: en flaggad position får inte HÅLLA
    // klockan (hållet kan demotera en målbro). Flaggan sätts av riktiga
    // GPSJumpAnalyzer via ett 150 m-hopp som fysikgrinden underkänner
    // (0,4 kn ⇒ tillåtet ~62 m på 60 s).
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat + 150 / M_PER_DEG_LAT, lon: QUAY.lon, sog: 0.4, cog: 10, name: 'GRAZON', timestamp: NOW,
    });
    NOW += 60000;
    const flaggad = svc.vessels.get(mmsi);
    expect(flaggad._positionUncertain === true || flaggad._gpsJumpDetected === true).toBe(true);
    // Andra provet i paret, fortfarande flaggat ⇒ hållet avstår ⇒ klockan nollas.
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat, lon: QUAY.lon, sog: 0.4, cog: 10, name: 'GRAZON', timestamp: NOW,
    });
    NOW += 60000;
    const v = svc.vessels.get(mmsi);
    expect(v._positionUncertain === true || v._gpsJumpDetected === true).toBe(true);
    expect(v._stationarySince).toBeNull();
  });
});
