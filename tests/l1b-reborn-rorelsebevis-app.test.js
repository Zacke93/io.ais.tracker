'use strict';

jest.mock('homey');

/**
 * L1-SYSTERSTÄLLET (helkodsgranskning RUNDA 3, 2026-08-22) — app-sidan.
 *
 * L1:s huvudfynd sitter i graven (VesselDataService, egen svit
 * tests/l1-graven-bevapningsbeviset.test.js). SYSTERSTÄLLET sitter här:
 * `_checkSkippedBridgesFallback` REBORN_MOVEMENT_PROOF satte bara det
 * klistrande `_hasMovementProof` när en återfödd båts hoppvektor översteg
 * 500 m — utan grav, utan `_plausibleMovementSeen`.
 *
 * VARFÖR DET SPÄRRAR SIG SJÄLVT: `_hasMovementProof` är villkoret som STÄNGER
 * lager 1-blocket (positionsgrenen) i VesselDataService._updateMooringEvidence.
 * Positionsgrenen är enda vägen till `_hasCorroboratedMovement` för en
 * FARTGIVARLÖS båt (C6-blocket kräver finit sog), och `_plausibleMovementSeen`
 * kräver finit sog i sitt eget villkor. Efter beviset kunde
 * `hasArmingMovementEvidence()` alltså ALDRIG mer bli sann för henne, och
 * J22:s beväpningsgrind i BridgeOpeningService._canArm spärrade
 * bridge_opening_soon för hennes målbro permanent.
 *
 * FIXEN: hoppvektorn (≥500 m mellan två OBSERVERADE positioner) sätter samma
 * klistrande sidobokföring som ett rimligt sog-sampel gör —
 * `_plausibleMovementSeen`. INTE det hårdare `_hasCorroboratedMovement`, som är
 * reserverat för två konsekutiva observationer.
 *
 * Predikatet som konsumeras är den RIKTIGA VesselDataService.
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

const MMSI = '265900040';
const M_PER_DEG_LAT = 111320;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

function makeApp() {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app.bridgeRegistry = new BridgeRegistry();
  app.vesselDataService = {
    hasGpsJumpHold: () => false,
    isNearMooringZone: () => false,
    applyInferredPassage: jest.fn(),
  };
  app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
  app._lastKnownPositions = new Map();
  app._persistentOpeningWarnings = new Map();
  // Sätts i onInit (som inte körs här) — samma värde, 6 h.
  app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * 60 * 1000;
  return app;
}

/** Fartygsobjekt UTAN handsatta bevisfält — de ska skrivas av produktionskoden. */
const rebornVessel = (overrides = {}) => ({
  mmsi: MMSI,
  name: 'ÅTERFÖDDA FARTGIVARLÖSA',
  lat: 58.2900,
  lon: 12.2900,
  sog: null,
  cog: null,
  _moored: false,
  ...overrides,
});

/** Sist kända position `meters` SÖDER om nuvarande ⇒ nordgående hoppvektor. */
const seedLastKnown = (app, meters) => {
  app._lastKnownPositions.set(MMSI, {
    lat: 58.2900 - meters / M_PER_DEG_LAT,
    lon: 12.2900,
    t: Date.now() - 10 * 60 * 1000,
  });
};

describe('L1-syster: REBORN_MOVEMENT_PROOF ger ett FULLSTÄNDIGT bevis', () => {
  test('KÄRNAN: 900 m hoppvektor, sog=null ⇒ BÅDA bevisfälten sätts', async () => {
    const app = makeApp();
    seedLastKnown(app, 900);
    const vessel = rebornVessel();

    await app._checkSkippedBridgesFallback(vessel, null);

    expect(vessel._hasMovementProof).toBe(true);
    expect(vessel._plausibleMovementSeen).toBe(true);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('REBORN_MOVEMENT_PROOF'))).toBe(true);
  });

  test('KONSEKVENSEN: den RIKTIGA beväpningspredikaten svarar ja (förut: nej för alltid)', async () => {
    const app = makeApp();
    seedLastKnown(app, 900);
    const vessel = rebornVessel();

    await app._checkSkippedBridgesFallback(vessel, null);

    const logger = makeLogger();
    const vds = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    try {
      expect(vds.hasArmingMovementEvidence(vessel)).toBe(true);
      // …och det är INTE via den hårdare halvan — hoppvektorn är ETT bevis.
      expect(vessel._hasCorroboratedMovement).not.toBe(true);
    } finally {
      vds.clearAllTimers();
    }
  });

  test('FÖRFIX-LÄGET dokumenterat: bara _hasMovementProof ⇒ predikatet svarar NEJ', () => {
    const logger = makeLogger();
    const vds = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    try {
      expect(vds.hasArmingMovementEvidence({ _hasMovementProof: true })).toBe(false);
    } finally {
      vds.clearAllTimers();
    }
  });

  test('500 m-TRÖSKELN ORÖRD: 300 m hopp ger inget av bevisen (SOLUTION-kalibreringen)', async () => {
    const app = makeApp();
    seedLastKnown(app, 300);
    const vessel = rebornVessel();

    await app._checkSkippedBridgesFallback(vessel, null);

    expect(vessel._hasMovementProof).toBeUndefined();
    expect(vessel._plausibleMovementSeen).toBeUndefined();
  });

  test('GRENVAKTEN ORÖRD: en båt som redan bär beviset rörs inte av svepet', async () => {
    const app = makeApp();
    seedLastKnown(app, 900);
    // Rimlighetsvaktens klass (J22): beviset kom från ett ORIMLIGT sampel, så
    // _plausibleMovementSeen är medvetet falsk. Svepet får inte tvätta det.
    const vessel = rebornVessel({ _hasMovementProof: true, _plausibleMovementSeen: false });

    await app._checkSkippedBridgesFallback(vessel, null);

    expect(vessel._plausibleMovementSeen).toBe(false);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('REBORN_MOVEMENT_PROOF'))).toBe(false);
  });

  test('TTL:n ORÖRD: en utgången sist-känd-position ger ingen hoppvektor alls', async () => {
    const app = makeApp();
    app._lastKnownPositions.set(MMSI, {
      lat: 58.2900 - 900 / M_PER_DEG_LAT,
      lon: 12.2900,
      t: Date.now() - (app._LAST_KNOWN_POSITION_TTL_MS + 60 * 1000),
    });
    const vessel = rebornVessel();

    await app._checkSkippedBridgesFallback(vessel, null);

    expect(vessel._hasMovementProof).toBeUndefined();
    expect(vessel._plausibleMovementSeen).toBeUndefined();
  });
});
