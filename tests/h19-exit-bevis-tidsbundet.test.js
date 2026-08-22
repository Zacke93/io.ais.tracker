'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { TRIGGER_POINTS } = require('../lib/constants');

/**
 * H19 (helkodsgranskning 2026-08-22): exit-notisens transitbevis läste hela
 * 6-timmarskartan utan tids-, riktnings- eller episodvillkor — och hela
 * exit-vägen saknade rörelsekrav i NUET.
 *
 * MEKANISMEN (två halvor, båda verifierade i granskningen):
 *  (a) hasNotifiedRealBridge svepte _persistentRecentTriggers efter valfri
 *      nyckel som inte slutar på ':Kanalinfarten'. Kartan har 6 h retention
 *      och överlever både removal och omstart, så en NORDGÅENDE entry-notis
 *      från en tidigare resa (3 h och 5,5 h gamla poster reproducerade) dög
 *      som bevis för att båten "bevisligen transiterat kanalen".
 *  (b) rörelsekravet "sog ≥ 2 kn" låg INNE i sessionsnyckel-grenen i
 *      _triggerExitPointFallback. Den mållösa klassen har ingen sådan nyckel
 *      (STEG 2 i _onVesselRemoved rensar dem när passedBridges är tom), så en
 *      båt på 0,2 kn fick notisen "… var på väg ut ur kanalen när
 *      AIS-kontakten bröts" — direkt osant.
 *
 * FIXEN: (a) beviset kräver post inom 2h-fönstret OCH dir ≠ 'north';
 * (b) hela exit-vägen kräver fart ≥ MIN_VIABLE_SPEED_KN när farten är känd.
 * Tröskeln är 0,5 kn och inte 2 kn därför att korpuslåsta ÄKTA utfarter på
 * basradien går ned till 1,2 kn (F5-B-sviten) medan de falska låg på 0,2–0,4.
 */

const KANAL = TRIGGER_POINTS.kanalinfarten;
const MIN = 60 * 1000;
const H = 60 * MIN;

function makeRemovalApp() {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._triggerExitPointFallback = jest.fn().mockResolvedValue(undefined);
  app._clearBoatNearTriggers = jest.fn(); // STEG 2 får inte städa undan testets nycklar
  app._updateUI = jest.fn();
  app.statusService = {
    statusStabilizer: { removeVessel: jest.fn() },
    clearVesselETAHistory: jest.fn(),
  };
  app.bridgeTextService = { clearVesselPhaseTracking: jest.fn() };
  app.vesselDataService = { getVesselCount: () => 1, getAllVessels: () => [] };
  app._processingRemoval = new Set();
  app._vesselRemovalTimers = new Map();
  app._skippedBridgesSweepSeen = new Map();
  app._isConnected = true;
  app.aisClient = { getConnectionStats: () => ({ timeSinceLastMessage: 1000 }) };
  return app;
}

// Den MÅLLÖSA klassen: ingen bokförd passage alls — transitbeviset måste
// komma ur notisnycklarna, och det är exakt det beviset fyndet gäller.
function targetlessSnapshot(overrides = {}) {
  return {
    mmsi: '265900019',
    name: 'BEVISLÖSA LIGGAREN',
    lat: KANAL.lat + 350 / 111320,
    lon: KANAL.lon,
    sog: 0.4,
    cog: 210,
    passedBridges: [],
    _routeDirection: 'south',
    _finalTargetDirection: null,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _moored: false,
    _hasMovementProof: true,
    ...overrides,
  };
}

describe('H19 (a): transitbeviset är tidsbundet och riktningsprövat', () => {
  test('FÄLTFALLET: 3 h gammal Klaffbron-post med dir north ⇒ INGEN exit-notis', async () => {
    const app = makeRemovalApp();
    app._persistentRecentTriggers.set('265900019:Klaffbron', { t: Date.now() - 3 * H, dir: 'north' });
    const vessel = targetlessSnapshot();

    await app._onVesselRemoved({ mmsi: vessel.mmsi, reason: 'timeout', vessel });

    expect(app._triggerExitPointFallback).not.toHaveBeenCalled();
  });

  test('5,5 h gammal post i RÄTT riktning ⇒ INGEN exit-notis (åldern ensam räcker)', async () => {
    const app = makeRemovalApp();
    app._persistentRecentTriggers.set('265900019:Klaffbron', { t: Date.now() - 5.5 * H, dir: 'south' });
    const vessel = targetlessSnapshot();

    await app._onVesselRemoved({ mmsi: vessel.mmsi, reason: 'timeout', vessel });

    expect(app._triggerExitPointFallback).not.toHaveBeenCalled();
  });

  test('ÄKTA KLASSEN BEVARAD: 20 min gammal sydpost ⇒ exit-anropet körs', async () => {
    const app = makeRemovalApp();
    app._persistentRecentTriggers.set('265900019:Klaffbron', { t: Date.now() - 20 * MIN, dir: 'south' });
    const vessel = targetlessSnapshot({ sog: 4.0 });

    await app._onVesselRemoved({ mmsi: vessel.mmsi, reason: 'timeout', vessel });

    expect(app._triggerExitPointFallback).toHaveBeenCalledTimes(1);
  });

  test('COG-DÖDBANDET: färsk post UTAN riktning (dir null) släpps fortfarande igenom', async () => {
    const app = makeRemovalApp();
    app._persistentRecentTriggers.set('265900019:Klaffbron', { t: Date.now() - 20 * MIN, dir: null });
    const vessel = targetlessSnapshot({ sog: 4.0 });

    await app._onVesselRemoved({ mmsi: vessel.mmsi, reason: 'timeout', vessel });

    expect(app._triggerExitPointFallback).toHaveBeenCalledTimes(1);
  });

  test('LEGACY-POSTER (rena tal, ingen riktning) bedöms på åldern', async () => {
    const fersk = makeRemovalApp();
    fersk._persistentRecentTriggers.set('265900019:Olidebron', Date.now() - 30 * MIN);
    await fersk._onVesselRemoved({
      mmsi: '265900019', reason: 'timeout', vessel: targetlessSnapshot({ sog: 4.0 }),
    });
    expect(fersk._triggerExitPointFallback).toHaveBeenCalledTimes(1);

    const gammal = makeRemovalApp();
    gammal._persistentRecentTriggers.set('265900019:Olidebron', Date.now() - 4 * H);
    await gammal._onVesselRemoved({
      mmsi: '265900019', reason: 'timeout', vessel: targetlessSnapshot({ sog: 4.0 }),
    });
    expect(gammal._triggerExitPointFallback).not.toHaveBeenCalled();
  });

  test('BOKFÖRD PASSAGE är ett eget bevis — kartans ålder rör den inte', async () => {
    const app = makeRemovalApp();
    app._persistentRecentTriggers.set('265900019:Klaffbron', { t: Date.now() - 5.5 * H, dir: 'north' });
    const vessel = targetlessSnapshot({ sog: 4.0, passedBridges: ['Olidebron'] });

    await app._onVesselRemoved({ mmsi: vessel.mmsi, reason: 'timeout', vessel });

    expect(app._triggerExitPointFallback).toHaveBeenCalledTimes(1);
  });

  test('A1R2-3-negativa intakt: enbart Kanalinfarten-nyckel är inget transitbevis', async () => {
    const app = makeRemovalApp();
    app._persistentRecentTriggers.set('265900019:Kanalinfarten', { t: Date.now() - 10 * MIN, dir: 'south' });
    const vessel = targetlessSnapshot({ sog: 4.0 });

    await app._onVesselRemoved({ mmsi: vessel.mmsi, reason: 'timeout', vessel });

    expect(app._triggerExitPointFallback).not.toHaveBeenCalled();
  });

  test('A1R2-3-positiva intakt: sessionsnyckel för riktig bro bär fortfarande beviset', async () => {
    const app = makeRemovalApp();
    app._triggeredBoatNearKeys.add('265900019:Olidebron');
    const vessel = targetlessSnapshot({ sog: 4.0 });

    await app._onVesselRemoved({ mmsi: vessel.mmsi, reason: 'timeout', vessel });

    expect(app._triggerExitPointFallback).toHaveBeenCalledTimes(1);
  });
});

describe('H19 (b): hela exit-vägen kräver rörelse i nuet', () => {
  function makeExitApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    return app;
  }

  // 330 m norr om punkten (basradien), klistrat rörelsebevis — INGEN
  // sessionsnyckel, alltså exakt den väg där 2 kn-kravet aldrig nåddes.
  const nearExit = (overrides = {}) => ({
    mmsi: '265900020',
    name: 'STILLALIGGAREN',
    lat: KANAL.lat + 330 / 111320,
    lon: KANAL.lon,
    sog: 0.2,
    cog: 205,
    passedBridges: ['Olidebron'],
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _lastSeen: Date.now(),
    _moored: false,
    _hasMovementProof: true, // klistrat, kan vara timmar gammalt
    ...overrides,
  });

  test('FÄLTFALLET: 0,2 kn ⇒ ingen "var på väg ut"-notis', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(nearExit());
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(app.debug.mock.calls.some((c) => String(c[0]).includes('EXIT_TRIGGER_SKIP_STATIONARY'))).toBe(true);
  });

  test('0,4 kn (andra verifierade fallet) ⇒ ingen notis', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(nearExit({ sog: 0.4 }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('F5-B-KONTRAKTET: 1,2 kn på basradien avfyrar fortfarande (tröskeln får inte höjas till 2)', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(nearExit({ sog: 1.2 }));
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
  });

  test('A1R2-1-KONTRAKTET: fartgivarlös (sog null) bedöms på maxRecentSpeed', async () => {
    const rorlig = makeExitApp();
    await rorlig._triggerExitPointFallback(nearExit({ sog: null, maxRecentSpeed: 5.2 }));
    expect(rorlig._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);

    const stilla = makeExitApp();
    await stilla._triggerExitPointFallback(nearExit({ sog: null, maxRecentSpeed: 0.3 }));
    expect(stilla._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('CLABBYDOO-KLASSEN: helt utan fartfält avstår grinden (ingen kunskap ⇒ ingen dom)', async () => {
    const app = makeExitApp();
    const snapshot = nearExit();
    delete snapshot.sog;
    await app._triggerExitPointFallback(snapshot);
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
  });
});
