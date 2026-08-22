'use strict';

jest.mock('homey');

/**
 * L34 (helkodsgranskning RUNDA 3, 2026-08-22) — MÄTNINGEN KÖRDES DÄR VAKTEN
 * INTE KAN VERKA, OCH LOGGRADEN VAR OSTRYPT OCH OSANN.
 *
 * MEKANISMEN FÖRE FIXEN: `_evaluateFeedSilence('VESSEL_REMOVAL_STALE_GUARD')`
 * anropades på VARJE borttagning — före kontrollen av hur många fartyg som
 * återstår. När båtar återstod var vakten irrelevant (else-grenarna skriver
 * DEFAULT eller schemalägger en vanlig UI-cykel), men helperns egen
 * FEED_SILENCE_UNMEASURABLE-rad påstod ändå att "texten hålls, DEFAULT
 * publiceras inte" — osant i just det läget. Dessutom är det omätbara läget
 * KLIBBIGT (`lastMessageTime` nollställs aldrig), så raden upprepades
 * ostrypt: uppmätt storleksordning 5–60 rader per konfigändring.
 *
 * FIXEN: (1) anropet sker bara när `remainingVesselCount === 0`, alltså där
 * silent=true faktiskt HÅLLER texten; (2) raden stryps till 1/min per
 * omätbart läge med en kumulativ undertryckt-räknare, så fältprovsmönstret
 * bevaras; (3) formuleringen säger vad mätningen GÖR (armerar vakten) i
 * stället för att lova ett utfall helpern inte äger.
 *
 * J30:s semantik (omätbart + ansluten ⇒ TYST) är ORÖRD — se
 * tests/j30-feedtystnad-omatbar.test.js.
 */

const AISBridgeApp = require('../app');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

const HELD_TEXT = 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter';
const DEFAULT_TEXT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;

function makeRemovalApp({ remaining = 0, stats } = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app._isConnected = true;
  app._lastBridgeText = HELD_TEXT;
  app._lastBridgeAlarm = true;
  app._vesselRemovalTimers = new Map();
  app._processingRemoval = new Set();
  app._triggeredBoatNearKeys = new Set();
  app.vesselDataService = { getVesselCount: jest.fn().mockReturnValue(remaining) };
  app.statusService = {
    statusStabilizer: { removeVessel: jest.fn() },
    clearVesselETAHistory: jest.fn(),
  };
  app.bridgeTextService = { clearVesselPhaseTracking: jest.fn() };
  app._clearBoatNearTriggers = jest.fn();
  app._updateDeviceCapability = jest.fn();
  app._globalBridgeTextToken = { setValue: jest.fn().mockResolvedValue(undefined) };
  if (stats !== undefined) app.aisClient = { getConnectionStats: stats };
  return app;
}

const unmeasurableConnected = () => ({ isConnected: true, timeSinceLastMessage: null });

const removal = (mmsi) => ({
  mmsi,
  vessel: { mmsi, passedBridges: [] },
  reason: 'stale_ais',
});

const logRows = (app) => app.log.mock.calls.map((c) => String(c[0]));
const unmeasurableRows = (app) => logRows(app).filter((r) => r.includes('[FEED_SILENCE_UNMEASURABLE]'));

describe('L34 (a): anropskontraktet — mät bara där vakten kan verka', () => {
  test('BÅTAR ÅTERSTÅR ⇒ mätningen körs INTE (och ingen osann rad skrivs)', async () => {
    const app = makeRemovalApp({ remaining: 3, stats: unmeasurableConnected });
    const spy = jest.spyOn(app, '_evaluateFeedSilence');

    await app._onVesselRemoved(removal('265001111'));

    expect(spy).not.toHaveBeenCalled();
    expect(unmeasurableRows(app)).toHaveLength(0);
  });

  test('SISTA BÅTEN ⇒ mätningen körs och vakten håller texten (J30 orörd)', async () => {
    const app = makeRemovalApp({ remaining: 0, stats: unmeasurableConnected });
    const spy = jest.spyOn(app, '_evaluateFeedSilence');

    await app._onVesselRemoved(removal('265001112'));

    expect(spy).toHaveBeenCalledWith('VESSEL_REMOVAL_STALE_GUARD');
    expect(app._lastBridgeText).toBe(HELD_TEXT);
    expect(app._updateDeviceCapability).not.toHaveBeenCalledWith('bridge_text', DEFAULT_TEXT);
  });

  test('RADEN ÄR SANN: den beskriver armeringen, inte ett utfall helpern inte äger', async () => {
    const app = makeRemovalApp({ remaining: 0, stats: unmeasurableConnected });

    await app._onVesselRemoved(removal('265001113'));

    const rad = unmeasurableRows(app)[0];
    expect(rad).toBeDefined();
    expect(rad).toContain('vakten armerad');
    expect(rad).toContain('VESSEL_REMOVAL_STALE_GUARD');
  });
});

describe('L34 (b): strypningen bevarar mönstret', () => {
  test('TRE borttagningar inom fönstret ⇒ EN rad', async () => {
    const app = makeRemovalApp({ remaining: 0, stats: unmeasurableConnected });

    await app._onVesselRemoved(removal('265002001'));
    await app._onVesselRemoved(removal('265002002'));
    await app._onVesselRemoved(removal('265002003'));

    expect(unmeasurableRows(app)).toHaveLength(1);
  });

  test('EFTER fönstret släpps en ny rad — med kumulativ undertryckt-räknare', async () => {
    const app = makeRemovalApp({ remaining: 0, stats: unmeasurableConnected });
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => t;
    try {
      await app._onVesselRemoved(removal('265002011'));
      await app._onVesselRemoved(removal('265002012'));
      await app._onVesselRemoved(removal('265002013'));
      t += 61 * 1000;
      await app._onVesselRemoved(removal('265002014'));
    } finally {
      Date.now = realNow;
    }

    const rows = unmeasurableRows(app);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('+2 undertryckta rader');
  });

  test('DE TVÅ OMÄTBARA LÄGENA stryps var för sig (ett kast döljer inte ett stumt läge)', async () => {
    const kastar = makeRemovalApp({
      remaining: 0,
      stats: () => {
        throw new Error('stats nere');
      },
    });
    await kastar._onVesselRemoved(removal('265003001'));
    await kastar._onVesselRemoved(removal('265003002'));

    const rows = unmeasurableRows(kastar);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('getConnectionStats kastade');
    // Kastet fäller INTE vakten (dagens beteende) — samma J30-kontrakt.
    expect(kastar._updateDeviceCapability).toHaveBeenCalledWith('bridge_text', DEFAULT_TEXT);
  });

  test('UI-VÄGEN har egen strypnyckel (removal tystar inte UI-radens diagnostik)', () => {
    const app = makeRemovalApp({ remaining: 0, stats: unmeasurableConnected });

    app._evaluateFeedSilence('VESSEL_REMOVAL_STALE_GUARD');
    app._evaluateFeedSilence('UI_FEED_STALE_GUARD');

    const rows = unmeasurableRows(app);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('VESSEL_REMOVAL_STALE_GUARD');
    expect(rows[1]).toContain('UI_FEED_STALE_GUARD');
  });
});

describe('L34 (c): J30-semantiken är oförändrad', () => {
  test('omätbart + ANSLUTEN ⇒ silent=true, unmeasurable=true', () => {
    const app = makeRemovalApp({ remaining: 0, stats: unmeasurableConnected });
    expect(app._evaluateFeedSilence('X')).toMatchObject({ silent: true, unmeasurable: true });
  });

  test('omätbart + EJ ansluten ⇒ silent=false (replay-harnessens läge)', () => {
    const app = makeRemovalApp({
      remaining: 0,
      stats: () => ({ isConnected: false, timeSinceLastMessage: null }),
    });
    expect(app._evaluateFeedSilence('X')).toMatchObject({ silent: false, unmeasurable: true });
  });

  test('mätbart mått bedöms på gränsen och loggar INGEN omätbar-rad', () => {
    const tyst = makeRemovalApp({
      remaining: 0,
      stats: () => ({ isConnected: true, timeSinceLastMessage: 60 * 60 * 1000 }),
    });
    expect(tyst._evaluateFeedSilence('X').silent).toBe(true);
    expect(unmeasurableRows(tyst)).toHaveLength(0);

    const farsk = makeRemovalApp({
      remaining: 0,
      stats: () => ({ isConnected: true, timeSinceLastMessage: 1000 }),
    });
    expect(farsk._evaluateFeedSilence('X').silent).toBe(false);
  });

  test('ingen aisClient alls ⇒ hasStats=false (P8-sviternas gamla beteende)', () => {
    const app = makeRemovalApp({ remaining: 0 });
    expect(app._evaluateFeedSilence('X')).toMatchObject({ hasStats: false, silent: false });
  });
});
