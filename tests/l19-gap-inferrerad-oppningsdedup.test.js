'use strict';

jest.mock('homey');

/**
 * L19 (helkodsgranskning RUNDA 3, 2026-08-22) — J15-SYSKONET: GAP-INFERRERADE
 * MÅLBROPASSAGER KONSUMERADE ALDRIG SIN PERSISTENTA ÖPPNINGSDEDUP-POST.
 *
 * MEKANISMEN FÖRE FIXEN: nyckelrensningen låg inne i `_observeBridgeOpening`
 * bakom 2000 ms-färskhetsgrinden ("registrerad denna tick"). Den grinden är
 * STRUKTURELLT ONÅBAR för en gap-inferrerad passage:
 *   • `_observeBridgeOpening` anropas FÖRE `_checkSkippedBridgesFallback` i
 *     BÅDA ingångarna (entered- och updated-vägen);
 *   • `applyInferredPassage` stämplar `passedAt` först DÄREFTER;
 *   • nästa `_observeBridgeOpening` kommer 70 s eller mer senare — då har
 *     2000 ms-fönstret sedan länge löpt ut.
 * Ingen annan konsumtionsväg finns (enda övriga raderingen är utgångsprunen i
 * `_persistOpeningWarnings`). Efter J15 lever posten till avfyrning +
 * konvojfönster + ETA, kapat 1 h, i stället för platta 10 min — och en omstart
 * inom fönstret laddar den som `bootLoaded`, varefter en helt ny ÄKTA öppning
 * tystas.
 *
 * FIXEN: rensningen är utbruten till `_consumeOpeningDedupForPassage` och
 * anropas även efter `applyInferredPassage`-loopen och i backfill-vägen.
 */

const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const MMSI = '265573130';
const KEY_NORTH = `Klaffbron|${MMSI}|north`;
const KEY_SOUTH = `Klaffbron|${MMSI}|south`;
const HOUR = 60 * 60 * 1000;

/**
 * App med RIKTIG bro-geometri. `applyInferredPassage` speglar VDS-kontraktet
 * som fyndet vilar på: den stämplar `passedAt` (det är just DÄRFÖR 2000 ms-
 * fönstret i _observeBridgeOpening aldrig kan se den — stämpeln sätts efter).
 */
function makeApp() {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app.bridgeRegistry = new BridgeRegistry();
  app.vesselDataService = {
    hasGpsJumpHold: () => false,
    isNearMooringZone: () => false,
    applyInferredPassage: jest.fn((vessel, oldVessel, bridgeName) => {
      if (!vessel.passedAt) vessel.passedAt = {};
      vessel.passedAt[bridgeName] = Date.now();
    }),
  };
  app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
  app._lastKnownPositions = new Map();
  app.homey = { settings: { set: jest.fn(), get: jest.fn() } };
  // Kartan skapas i onInit (som inte körs här) — spegla den initieringen.
  app._persistentOpeningWarnings = new Map();
  return app;
}

/** ELFKUNGEN-hoppet: 58,2719 → 58,2961 (fyra broar i ett 23-min-gap). */
const jumpVessel = () => ({
  mmsi: MMSI,
  lat: 58.2961,
  lon: 12.29717,
  sog: 6.7,
  cog: 50.2,
  _moored: false,
});
const jumpOld = () => ({ lat: 58.27191833333333, lon: 12.2732 });

const seedWarning = (app, key) => {
  app._persistentOpeningWarnings.set(key, {
    firedAt: Date.now() - 5 * 60 * 1000,
    expiresAt: Date.now() + HOUR,
    bootLoaded: true,
  });
};

describe('L19 (a): gap-inferrerad målbropassage förbrukar öppningsdedupen', () => {
  test('FÄLTFALLET: posten är borta efter svepet (den överlevde förut sin egen passage)', async () => {
    const app = makeApp();
    seedWarning(app, KEY_NORTH);

    await app._checkSkippedBridgesFallback(jumpVessel(), jumpOld());

    expect(app._persistentOpeningWarnings.has(KEY_NORTH)).toBe(false);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('OPENING_DEDUP_PASSED'))).toBe(true);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('gap-inferrerad passage'))).toBe(true);
    expect(app.homey.settings.set).toHaveBeenCalledWith('persistent_opening_warnings', expect.any(Object));
  });

  test('MEKANISMEN: 2000 ms-fönstret hinner ALDRIG se den inferrerade passagen', async () => {
    const app = makeApp();
    app.bridgeOpeningService = { observeVessel: jest.fn(), notePassage: jest.fn() };
    seedWarning(app, KEY_NORTH);
    const vessel = jumpVessel();

    // Produktionsordningen: observeVessel FÖRST (passedAt är ännu tom) …
    app._observeBridgeOpening(vessel);
    expect(app._persistentOpeningWarnings.has(KEY_NORTH)).toBe(true);
    expect(app.bridgeOpeningService.notePassage).not.toHaveBeenCalled();

    // … och svepet EFTERÅT, som stämplar passedAt.
    await app._checkSkippedBridgesFallback(vessel, jumpOld());
    expect(vessel.passedAt.Klaffbron).toEqual(expect.any(Number));
    expect(app._persistentOpeningWarnings.has(KEY_NORTH)).toBe(false);
  });

  test('RIKTNINGSOBEROENDE: hela bro|mmsi-prefixet sveps (riktningen kan ha låsts om)', async () => {
    const app = makeApp();
    seedWarning(app, KEY_NORTH);
    seedWarning(app, KEY_SOUTH);

    await app._checkSkippedBridgesFallback(jumpVessel(), jumpOld());

    expect(app._persistentOpeningWarnings.has(KEY_NORTH)).toBe(false);
    expect(app._persistentOpeningWarnings.has(KEY_SOUTH)).toBe(false);
  });

  test('AVGRÄNSAT: annan båts och annan bros poster rörs inte', async () => {
    const app = makeApp();
    seedWarning(app, KEY_NORTH);
    seedWarning(app, 'Klaffbron|999999999|north'); // annan båt
    seedWarning(app, `Stridsbergsbron|${MMSI}|north`); // annan bro — men SAMMA svep

    await app._checkSkippedBridgesFallback(jumpVessel(), jumpOld());

    expect(app._persistentOpeningWarnings.has('Klaffbron|999999999|north')).toBe(true);
    // Stridsbergsbron ligger i samma hoppfönster och ÄR en målbro ⇒ förbrukad.
    expect(app._persistentOpeningWarnings.has(`Stridsbergsbron|${MMSI}|north`)).toBe(false);
  });

  test('SCENARIO A (ny båt, ingen hoppvektor) rör INTE posten — där appliceras ingen passage', async () => {
    const app = makeApp();
    seedWarning(app, KEY_NORTH);

    // oldVessel === null ⇒ scenario 'new-vessel'; applyInferredPassage körs inte.
    await app._checkSkippedBridgesFallback({
      mmsi: MMSI, lat: 58.2961, lon: 12.29717, sog: 6.7, cog: 20, _moored: false,
    }, null);

    expect(app.vesselDataService.applyInferredPassage).not.toHaveBeenCalled();
    expect(app._persistentOpeningWarnings.has(KEY_NORTH)).toBe(true);
  });
});

describe('L19 (b): backfill-vägen förbrukar posten på samma sätt', () => {
  function makeUpdateApp() {
    const app = makeApp();
    app._analyzeVesselPosition = jest.fn().mockResolvedValue(undefined);
    app._noteQuayStability = jest.fn();
    app._observeBridgeOpening = jest.fn();
    app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);
    app._checkSkippedBridgesFallback = jest.fn().mockResolvedValue(undefined);
    app._updateUIIfNeeded = jest.fn();
    app._clearBoatNearTriggers = jest.fn();
    app.statusService = { clearVesselETAHistory: jest.fn() };
    app.vesselDataService.clearTargetProtection = jest.fn();
    app._vesselRemovalTimers = new Map();
    return app;
  }

  test('RC9-/RC2b-backfill av MÅLBRO ⇒ posten förbrukas (källan syns i loggen)', async () => {
    const app = makeUpdateApp();
    seedWarning(app, KEY_NORTH);
    const vessel = {
      mmsi: MMSI, lat: 58.2961, lon: 12.29717, sog: 6.7, cog: 20, _passageBackfills: ['Klaffbron'],
    };

    await app._onVesselUpdated({ mmsi: MMSI, vessel, oldVessel: null });

    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledWith(vessel, 'Klaffbron');
    expect(app._persistentOpeningWarnings.has(KEY_NORTH)).toBe(false);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('backfillad passage'))).toBe(true);
  });

  test('MELLANBRO-backfill rör ingen öppningsdedup (bara målbroar bokförs där)', async () => {
    const app = makeUpdateApp();
    seedWarning(app, KEY_NORTH);
    const vessel = {
      mmsi: MMSI, lat: 58.2961, lon: 12.29717, sog: 6.7, cog: 20, _passageBackfills: ['Järnvägsbron'],
    };

    await app._onVesselUpdated({ mmsi: MMSI, vessel, oldVessel: null });

    expect(app._persistentOpeningWarnings.has(KEY_NORTH)).toBe(true);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('OPENING_DEDUP_PASSED'))).toBe(false);
  });
});

describe('L19 (c): den observerade passagen är oförändrad (J15-kontraktet)', () => {
  test('färsk passedAt-stämpel inom 2000 ms ⇒ posten förbrukas som förut', () => {
    const app = makeApp();
    app.bridgeOpeningService = { observeVessel: jest.fn(), notePassage: jest.fn() };
    seedWarning(app, KEY_NORTH);
    const vessel = { mmsi: MMSI, passedAt: { Klaffbron: Date.now() } };

    app._observeBridgeOpening(vessel);

    expect(app.bridgeOpeningService.notePassage).toHaveBeenCalledWith(MMSI, 'Klaffbron');
    expect(app._persistentOpeningWarnings.has(KEY_NORTH)).toBe(false);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('bekräftad passage'))).toBe(true);
  });

  test('gammal stämpel (>2000 ms) rör fortfarande ingenting på den vägen', () => {
    const app = makeApp();
    app.bridgeOpeningService = { observeVessel: jest.fn(), notePassage: jest.fn() };
    seedWarning(app, KEY_NORTH);

    app._observeBridgeOpening({ mmsi: MMSI, passedAt: { Klaffbron: Date.now() - 70 * 1000 } });

    expect(app.bridgeOpeningService.notePassage).not.toHaveBeenCalled();
    expect(app._persistentOpeningWarnings.has(KEY_NORTH)).toBe(true);
  });
});
