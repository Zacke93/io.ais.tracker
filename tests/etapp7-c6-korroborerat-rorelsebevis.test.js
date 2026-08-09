'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const constants = require('../lib/constants');

/**
 * C6 (etapp 7 fas C) — KORROBORERAT RÖRELSEBEVIS. GO-rapportens M3/F2.
 *
 * `_hasMovementProof` ges av sog-grenen på ETT sampel. A/B-dagens M3 var
 * 211488728, som förekommer med EXAKT ETT sampel i hela korpus 20260804-17h
 * (`2026-08-04T11:26:10.993Z sog=13 cog=200.9`, 602 m från Stridsbergsbron)
 * och ändå hann beväpnas och fyra två öppningsvarningar på fryst position
 * (11:34:37 Stridsbergsbron eta=0, 11:42:07 Klaffbron eta=−1).
 *
 * Två predikat införs, INGET av dem rör `_hasMovementProof`:
 *   • `_hasCorroboratedMovement` — två konsekutiva rörelsesampel (strikt).
 *   • `hasArmingMovementEvidence()` — GO-F2: ≥2 obs ELLER en enda RIMLIG obs.
 *     Det är det predikat öppningsbeväpningen ska kräva; mätning i isolerat
 *     träd 2026-08-09 visar −3 öppningsvarningar (alla rådataverifierade
 *     enkelsampelsfantomer) mot −22 för det strikta.
 */
describe('C6: korroborerat rörelsebevis', () => {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  let svc;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });

  afterEach(() => {
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
    delete global.__TEST_MODE__;
  });

  /** Kajliggare vid gästhamnen — fast position, ingen nettoförflyttning. */
  const makeVessel = (over = {}) => ({
    mmsi: '900000001',
    lat: 58.28714,
    lon: 12.285705,
    _firstSeenLat: 58.28714,
    _firstSeenLon: 12.285705,
    sog: 0,
    cog: 0,
    _hasMovementProof: false,
    _movementProofPending: false,
    _hasCorroboratedMovement: false,
    _corroboratedMovementPending: false,
    _plausibleMovementSeen: false,
    _moored: false,
    _stationarySince: null,
    navStatus: null,
    ...over,
  });

  test('ETT rimligt rörelsesampel: proof ja, korroborerat NEJ', () => {
    const v = makeVessel();
    svc._updateMooringEvidence(v, 5.2);
    expect(v._hasMovementProof).toBe(true);
    expect(v._hasCorroboratedMovement).toBe(false);
    expect(v._corroboratedMovementPending).toBe(true);
  });

  test('TVÅ konsekutiva rörelsesampel korroborerar', () => {
    const v = makeVessel();
    svc._updateMooringEvidence(v, 5.2);
    svc._updateMooringEvidence(v, 4.8);
    expect(v._hasCorroboratedMovement).toBe(true);
    expect(v._corroboratedMovementPending).toBe(false);
  });

  test('ett stillhetssampel emellan bryter kedjan (kajvobbel korroborerar inte)', () => {
    const v = makeVessel();
    svc._updateMooringEvidence(v, 2.9); // vobbel
    svc._updateMooringEvidence(v, 0.1); // still igen
    svc._updateMooringEvidence(v, 2.1); // vobbel
    expect(v._hasCorroboratedMovement).toBe(false);
  });

  test('sog=null är informationslöst och rör inte kedjan (S-F7-semantiken)', () => {
    const v = makeVessel();
    svc._updateMooringEvidence(v, 5.2);
    expect(v._corroboratedMovementPending).toBe(true);
    svc._updateMooringEvidence(v, null); // fartgivarlöst prov, samma position
    expect(v._corroboratedMovementPending).toBe(true);
    expect(v._hasCorroboratedMovement).toBe(false);
    svc._updateMooringEvidence(v, 5.0);
    expect(v._hasCorroboratedMovement).toBe(true);
  });

  test('M3-FALLET: ett enda ORIMLIGT sampel ger varken korroborering eller beväpningsbevis', () => {
    // 211488728, korpus 20260804-17h: sog=13 kn, ett enda sampel, ingen
    // nettoförflyttning att stödja sig på.
    const v = makeVessel({ sog: 13 });
    svc._updateMooringEvidence(v, 13);
    expect(v._hasMovementProof).toBe(true); // OFÖRÄNDRAT — alternativ A
    expect(v._hasCorroboratedMovement).toBe(false);
    expect(v._plausibleMovementSeen).toBe(false);
    expect(svc.hasArmingMovementEvidence(v)).toBe(false);
  });

  test('ORIMLIG fart MED nettoförflyttning räknas som rörelsesampel', () => {
    // 218023240, korpus 20260713-41h: 33,2 kn följt av 21,7 kn med 2 020 m
    // nettoförflyttning mellan sampeln — fysiskt konsistent, inte artefakt.
    const v = makeVessel({ sog: 33.2 });
    svc._updateMooringEvidence(v, 33.2); // net = 0 → informationslöst
    expect(v._corroboratedMovementPending).toBe(false);
    v.lat = 58.29074; // 2 020 m söderut
    v.lon = 12.309473;
    v.sog = 21.7;
    svc._updateMooringEvidence(v, 21.7);
    expect(v._corroboratedMovementPending).toBe(true); // nu räknas det
  });

  test('nettoförflyttningsgrenen korroborerar direkt (den är redan tvåsampels)', () => {
    // Fartgivarlös båt: sog saknas helt, positionen vandrar.
    const v = makeVessel({ sog: null });
    v.lat = 58.28760; // ~51 m från _firstSeen
    svc._updateMooringEvidence(v, null);
    expect(v._hasMovementProof).toBe(false);
    v.lat = 58.28770;
    svc._updateMooringEvidence(v, null);
    expect(v._hasMovementProof).toBe(true);
    expect(v._hasCorroboratedMovement).toBe(true);
  });

  test('GPS-flaggad position kan inte korroborera ett orimligt sampel', () => {
    const v = makeVessel({
      sog: 13, _gpsJumpDetected: true, lat: 58.29074, lon: 12.309473,
    });
    svc._updateMooringEvidence(v, 13);
    expect(v._hasCorroboratedMovement).toBe(false);
    expect(v._corroboratedMovementPending).toBe(false);
  });

  test('hasArmingMovementEvidence: rimlig enkelobservation duger (GO-F2)', () => {
    const v = makeVessel();
    svc._updateMooringEvidence(v, 5.2);
    expect(v._hasCorroboratedMovement).toBe(false);
    expect(svc.hasArmingMovementEvidence(v)).toBe(true);
  });

  test('hasArmingMovementEvidence: bokföringen KLISTRAR (sog=0 senare öppnar inte hålet)', () => {
    const v = makeVessel({ sog: 13 });
    svc._updateMooringEvidence(v, 13);
    v.sog = 0;
    svc._updateMooringEvidence(v, 0);
    expect(svc.hasArmingMovementEvidence(v)).toBe(false);
  });

  test('rimlighetsgränsen är BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN, inte ett löst tal', () => {
    const limit = constants.BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN;
    expect(limit).toBe(10);
    const ok = makeVessel();
    svc._updateMooringEvidence(ok, limit);
    expect(ok._plausibleMovementSeen).toBe(true);
    const over = makeVessel();
    svc._updateMooringEvidence(over, limit + 0.1);
    expect(over._plausibleMovementSeen).toBe(false);
  });

  test('predikatet är STRIKT STARKARE än _hasMovementProof (kan aldrig ge nya armar)', () => {
    const v = makeVessel();
    svc._updateMooringEvidence(v, 5.2);
    svc._updateMooringEvidence(v, 4.8);
    expect(v._hasCorroboratedMovement).toBe(true);
    expect(v._hasMovementProof).toBe(true); // delmängdsrelationen håller
  });

  // ---- FÄLTLIST-FÄLLAN ----
  test('fältlistvakt: de tre nya fälten överlever _createVesselObject', () => {
    const first = svc.updateVessel('265999001', {
      lat: 58.2700, lon: 12.2700, sog: 5.2, cog: 200, timestamp: Date.now(),
    });
    expect(first._corroboratedMovementPending).toBe(true);
    expect(first._plausibleMovementSeen).toBe(true);
    const second = svc.updateVessel('265999001', {
      lat: 58.2690, lon: 12.2690, sog: 5.0, cog: 200, timestamp: Date.now(),
    });
    // Hade fälten saknats i fältlistan hade pending nollats varje meddelande
    // och _hasCorroboratedMovement aldrig kunnat bli sant.
    expect(second._hasCorroboratedMovement).toBe(true);
    expect(second._plausibleMovementSeen).toBe(true);
  });

  test('fältlistvakt: vessel:removed-snapshotten bär båda flaggorna', () => {
    svc.updateVessel('265999002', {
      lat: 58.2700, lon: 12.2700, sog: 5.2, cog: 200, timestamp: Date.now(),
    });
    svc.updateVessel('265999002', {
      lat: 58.2690, lon: 12.2690, sog: 5.0, cog: 200, timestamp: Date.now(),
    });
    let snapshot = null;
    svc.on('vessel:removed', (e) => {
      snapshot = e.vessel;
    });
    svc.removeVessel('265999002', 'timeout');
    expect(snapshot).not.toBeNull();
    expect(snapshot._hasCorroboratedMovement).toBe(true);
    expect(snapshot._plausibleMovementSeen).toBe(true);
  });
});
