'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { TRIGGER_POINTS } = require('../lib/constants');

/**
 * H14 (helkodsgranskning 2026-08-22): en OBEKRÄFTAD U-svängsflagga
 * (_newJourneyPending) föråldrades ALDRIG när den konsumerades.
 *
 * MEKANISMEN: flaggan sätts på EN nordlig cog-fix vid sog ≥ 2 kn och
 * nollställs bara INNE i samma yttre villkor (ingen targetBridge +
 * _finalTargetDirection satt + finita cog/sog + sog ≥ 2 kn + ingen GPS-hold).
 * Sjunker farten under 2 kn — eller faller cog bort — nås grenen aldrig,
 * medan flaggan ärvs av varje AIS-rad och följer med i removal-snapshotten.
 * PENDING_MAX_AGE_MS (15 min) tillämpades BARA vid bekräftelsen; alla
 * konsumenter läste rå truthiness. Följden: en nordlig blipp följd av en
 * halvtimmes sydfärd i 1,2 kn tystade exit-notisen vid Kanalinfarten
 * (EXIT_TRIGGER_SKIP_REVERSAL) och blockerade expired-släppet.
 *
 * FIXEN: _pendingReversalActive(vessel) — satt OCH yngre än TTL:n — plus en
 * åldring i _onVesselUpdated som rensar fältet ur SJÄLVA fartygsobjektet
 * (så snapshotten aldrig bär en utgången flagga).
 */

const KANAL = TRIGGER_POINTS.kanalinfarten;
const MIN = 60 * 1000;

function makeRemovalApp() {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._triggerExitPointFallback = jest.fn().mockResolvedValue(undefined);
  app._clearBoatNearTriggers = jest.fn();
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

// Sydgående utfart 350 m norr om Kanalinfarten, bevisad transit (Olidebron
// bokförd) — allt utom U-svängsflaggan är uppfyllt.
function exitingSnapshot(overrides = {}) {
  return {
    mmsi: '265900014',
    name: 'PENDING-BÄRAREN',
    lat: KANAL.lat + 350 / 111320,
    lon: KANAL.lon,
    sog: 1.2, // kryper ut — under bekräftelsegrenens 2 kn-krav
    cog: 210,
    passedBridges: ['Olidebron'],
    _routeDirection: 'south',
    _finalTargetDirection: 'south',
    _finalTargetBridge: 'Klaffbron',
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _moored: false,
    _hasMovementProof: true,
    ...overrides,
  };
}

describe('H14: obekräftad U-svängsflagga åldras när den konsumeras', () => {
  test('FÄLTFALLET: 40 min gammal pending ⇒ exit-notisen får sin chans igen', async () => {
    const app = makeRemovalApp();
    const vessel = exitingSnapshot({
      _newJourneyPending: { dir: 'north', time: Date.now() - 40 * MIN },
    });

    await app._onVesselRemoved({ mmsi: vessel.mmsi, reason: 'timeout', vessel });

    expect(app._triggerExitPointFallback).toHaveBeenCalledTimes(1);
    const skipRows = app.log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('EXIT_TRIGGER_SKIP_REVERSAL'));
    expect(skipRows).toHaveLength(0);
  });

  test('SKYDDET STÅR KVAR: 2 min gammal pending blockerar fortfarande (A4R2-3)', async () => {
    const app = makeRemovalApp();
    const vessel = exitingSnapshot({
      _newJourneyPending: { dir: 'north', time: Date.now() - 2 * MIN },
    });

    await app._onVesselRemoved({ mmsi: vessel.mmsi, reason: 'timeout', vessel });

    expect(app._triggerExitPointFallback).not.toHaveBeenCalled();
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('EXIT_TRIGGER_SKIP_REVERSAL'))).toBe(true);
  });

  test('GRÄNSEN: precis under 15 min blockerar, precis över släpper', async () => {
    const strax = makeRemovalApp();
    await strax._onVesselRemoved({
      mmsi: '265900014',
      reason: 'timeout',
      vessel: exitingSnapshot({ _newJourneyPending: { dir: 'north', time: Date.now() - (15 * MIN - 5000) } }),
    });
    expect(strax._triggerExitPointFallback).not.toHaveBeenCalled();

    const efter = makeRemovalApp();
    await efter._onVesselRemoved({
      mmsi: '265900014',
      reason: 'timeout',
      vessel: exitingSnapshot({ _newJourneyPending: { dir: 'north', time: Date.now() - (15 * MIN + 5000) } }),
    });
    expect(efter._triggerExitPointFallback).toHaveBeenCalledTimes(1);
  });

  test('ICKE-FINIT tidsstämpel räknas som INAKTIV (bar aldrig något bevis)', async () => {
    const app = makeRemovalApp();
    await app._onVesselRemoved({
      mmsi: '265900014',
      reason: 'timeout',
      vessel: exitingSnapshot({ _newJourneyPending: { dir: 'north', time: NaN } }),
    });
    expect(app._triggerExitPointFallback).toHaveBeenCalledTimes(1);
  });

  test('NEGATIV KONTROLL: nordlig sista-kurs blockerar oavsett flagga (motbeviset intakt)', async () => {
    const app = makeRemovalApp();
    await app._onVesselRemoved({
      mmsi: '265900014',
      reason: 'timeout',
      vessel: exitingSnapshot({ cog: 20, _newJourneyPending: null }),
    });
    expect(app._triggerExitPointFallback).not.toHaveBeenCalled();
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('EXIT_TRIGGER_SKIP_REVERSAL'))).toBe(true);
  });
});

describe('H14: _pendingReversalActive är TTL:ns enda adress', () => {
  const app = Object.create(AISBridgeApp.prototype);

  test('satt + färsk ⇒ aktiv; satt + utgången ⇒ inaktiv', () => {
    expect(app._pendingReversalActive({ _newJourneyPending: { dir: 'north', time: Date.now() - MIN } })).toBe(true);
    expect(app._pendingReversalActive({ _newJourneyPending: { dir: 'north', time: Date.now() - 16 * MIN } })).toBe(false);
  });

  test('saknad flagga, null-fartyg och skräpvärden ⇒ inaktiv (kastar aldrig)', () => {
    expect(app._pendingReversalActive(null)).toBe(false);
    expect(app._pendingReversalActive({})).toBe(false);
    expect(app._pendingReversalActive({ _newJourneyPending: true })).toBe(false);
    expect(app._pendingReversalActive({ _newJourneyPending: { dir: 'north' } })).toBe(false);
  });
});

describe('H14: åldringen i _onVesselUpdated rensar fältet ur fartygsobjektet', () => {
  function makeUpdateApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._analyzeVesselPosition = jest.fn().mockResolvedValue(undefined);
    app._noteQuayStability = jest.fn();
    app._observeBridgeOpening = jest.fn();
    app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);
    app._checkSkippedBridgesFallback = jest.fn().mockResolvedValue(undefined);
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    app._updateUIIfNeeded = jest.fn();
    app._clearBoatNearTriggers = jest.fn();
    app.statusService = { clearVesselETAHistory: jest.fn() };
    app.vesselDataService = { clearTargetProtection: jest.fn() };
    app._vesselRemovalTimers = new Map();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    return app;
  }

  // Fartyget som bär felet: kryper söderut i 1,2 kn, alltså UNDER
  // bekräftelsegrenens 2 kn — den gren som annars hade nollställt flaggan.
  const crawlingSouth = (pendingAgeMs) => ({
    mmsi: '265900015',
    lat: KANAL.lat + 900 / 111320,
    lon: KANAL.lon,
    sog: 1.2,
    cog: 205,
    passedBridges: ['Olidebron'],
    _routeDirection: 'south',
    _finalTargetDirection: 'south',
    _newJourneyPending: { dir: 'north', time: Date.now() - pendingAgeMs },
  });

  test('utgången flagga släpps — och kan alltså inte följa med i snapshotten', async () => {
    const app = makeUpdateApp();
    const vessel = crawlingSouth(40 * MIN);
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    expect(vessel._newJourneyPending).toBeNull();
    expect(app.debug.mock.calls.some((c) => String(c[0]).includes('NEW_JOURNEY_PENDING_EXPIRED'))).toBe(true);
    expect(app.error).not.toHaveBeenCalled(); // ingen svald krasch på vägen
  });

  test('färsk flagga rörs INTE (bekräftelsen ska fortfarande kunna äga notisen)', async () => {
    const app = makeUpdateApp();
    const vessel = crawlingSouth(3 * MIN);
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    expect(vessel._newJourneyPending).not.toBeNull();
    expect(vessel._newJourneyPending.dir).toBe('north');
  });
});

describe('H14: exit-vägens expired-släpp läser samma tidsbundna flagga', () => {
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

  const returningSouth = (overrides = {}) => ({
    mmsi: '265900016',
    name: 'RETURFARAREN',
    lat: KANAL.lat + 330 / 111320,
    lon: KANAL.lon,
    sog: 5.0, // rörelse i NUET — släppets egna 2 kn-krav uppfyllt
    cog: 210,
    passedBridges: ['Olidebron'],
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _lastSeen: Date.now(),
    _moored: false,
    _hasMovementProof: true,
    _routeDirection: 'south',
    ...overrides,
  });

  test('utgången pending + rörelse ⇒ expired-släppet fungerar igen', async () => {
    const app = makeExitApp();
    app._triggeredBoatNearKeys.add('265900016:Kanalinfarten'); // sessionsnyckel utan persistent post
    await app._triggerExitPointFallback(returningSouth({
      _newJourneyPending: { dir: 'north', time: Date.now() - 40 * MIN },
    }));
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
  });

  test('färsk pending håller kvar blocket (F5-A/A3-1 intakt)', async () => {
    const app = makeExitApp();
    app._triggeredBoatNearKeys.add('265900016:Kanalinfarten');
    await app._triggerExitPointFallback(returningSouth({
      _newJourneyPending: { dir: 'north', time: Date.now() - 2 * MIN },
    }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('EXIT_TRIGGER_DEDUPE_EXPIRED_HOLD'))).toBe(true);
  });
});

// =============================================================================
// H14-RESTEN (fixrunda 1b, 2026-08-22) — granskarens två kvarlämnade halvor
// =============================================================================
//
// (1) TVÅ KONSUMENTER LÄSTE RÅ TRUTHINESS. Expired-släppet i notisvägens
//     dedup-gren (_triggerBoatNearFlowForBridge) och dess holdReason läste
//     `vessel._newJourneyPending` direkt medan systerställena (exit-vägens
//     motbevisgate och statusgrenen) redan bytt till predikatet. B1:s
//     motivering var att STEG 0-åldringen täcker dem i praktiken — den
//     håller, men den vilar på tre oberoende omständigheter i tre funktioner.
//
// (2) ÅLDRINGEN FANNS BARA I EN INGÅNG. STEG 0 låg i _onVesselUpdated;
//     _onVesselEntered gick rakt på _triggerBoatNearFlow och
//     _checkSkippedBridgesFallback utan den. I DAG är fältet null vid ENTERED
//     av konstruktion (VesselDataService ärver det ur oldVessel, som per
//     definition är null när eventet är 'entered'), så åldringen där är ett
//     NO-OP-försvar på djupet. Testerna nedan matar in flaggan EXPLICIT och
//     låser handlerns egen robusthet: ändrar någon ärvningsdetaljen — eller
//     återuppstår en restore-väg som fyller fältet före entered-eventet —
//     ska hålet inte öppna sig tyst.

describe('H14-resten: åldringen är GEMENSAM för ENTERED och UPDATED', () => {
  function makeEnteredApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._initializeTargetBridge = jest.fn().mockResolvedValue(undefined);
    app._analyzeVesselPosition = jest.fn().mockResolvedValue(undefined);
    app._noteQuayStability = jest.fn();
    app._observeBridgeOpening = jest.fn();
    app._checkSkippedBridgesFallback = jest.fn().mockResolvedValue(undefined);
    app._updateUI = jest.fn();
    return app;
  }

  const enteringVessel = (pendingAgeMs) => ({
    mmsi: '265900017',
    lat: KANAL.lat + 250 / 111320,
    lon: KANAL.lon,
    sog: 1.1,
    cog: 205,
    targetBridge: 'Klaffbron',
    passedBridges: [],
    _newJourneyPending: { dir: 'north', time: Date.now() - pendingAgeMs },
  });

  test('utgången flagga är BORTA redan när _triggerBoatNearFlow anropas', async () => {
    const app = makeEnteredApp();
    let seenAtNotification;
    app._triggerBoatNearFlow = jest.fn(async (v) => {
      seenAtNotification = v._newJourneyPending;
    });

    const vessel = enteringVessel(40 * MIN);
    await app._onVesselEntered({ mmsi: vessel.mmsi, vessel });

    expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
    expect(seenAtNotification).toBeNull(); // ordningen är hela poängen
    expect(vessel._newJourneyPending).toBeNull();
    expect(app.debug.mock.calls.some((c) => String(c[0]).includes('NEW_JOURNEY_PENDING_EXPIRED'))).toBe(true);
  });

  test('FÄRSK flagga överlever ENTERED-vägen (bekräftelsen ska få äga notisen)', async () => {
    const app = makeEnteredApp();
    app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);

    const vessel = enteringVessel(3 * MIN);
    await app._onVesselEntered({ mmsi: vessel.mmsi, vessel });

    expect(vessel._newJourneyPending).not.toBeNull();
    expect(vessel._newJourneyPending.dir).toBe('north');
  });

  test('ENTERED utan flagga är oförändrad (ingen ny loggrad, ingen krasch)', async () => {
    const app = makeEnteredApp();
    app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);

    const vessel = { ...enteringVessel(0), _newJourneyPending: null };
    await app._onVesselEntered({ mmsi: vessel.mmsi, vessel });

    expect(app.debug.mock.calls.some((c) => String(c[0]).includes('NEW_JOURNEY_PENDING_EXPIRED'))).toBe(false);
    expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('hjälparen är EN funktion: samma retur för båda ingångarna', () => {
    const app = Object.create(AISBridgeApp.prototype);
    app.debug = jest.fn();
    const utgangen = { _newJourneyPending: { dir: 'north', time: Date.now() - 40 * MIN } };
    const farsk = { _newJourneyPending: { dir: 'north', time: Date.now() - MIN } };

    expect(app._ageOutPendingReversal(utgangen, '1')).toBe(true);
    expect(utgangen._newJourneyPending).toBeNull();
    expect(app._ageOutPendingReversal(farsk, '2')).toBe(false);
    expect(farsk._newJourneyPending).not.toBeNull();
    // Tål allt en fältlista kan lämna efter sig.
    expect(app._ageOutPendingReversal(null, '3')).toBe(false);
    expect(app._ageOutPendingReversal({}, '4')).toBe(false);
    expect(app._ageOutPendingReversal({ _newJourneyPending: { dir: 'north', time: NaN } }, '5')).toBe(true);
  });
});

describe('H14-resten: notisvägens expired-släpp läser predikatet, inte fältet', () => {
  function makeFlowApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._persistRecentTriggers = jest.fn();
    app._getDirectionString = jest.fn(() => 'southbound');
    app._dedupDirection = jest.fn(() => 'south');
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
    return app;
  }

  // Sessionsnyckeln finns, den persistenta posten har gått ut (saknas), och
  // båten rör sig i 5 kn: släppet ska gå igenom om inget ANNAT håller emot.
  const releasableVessel = (overrides = {}) => ({
    mmsi: '265900018',
    name: 'SLÄPPKANDIDATEN',
    sog: 5,
    cog: 205,
    lat: KANAL.lat + 400 / 111320,
    lon: KANAL.lon,
    passedBridges: [],
    etaMinutes: null,
    ...overrides,
  });

  const KANDIDAT = {
    name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'current',
  };

  const holdRows = (app) => app.log.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('FLOW_TRIGGER_DEDUPE_EXPIRED_HOLD'));

  test('UTGÅNGEN flagga blockerar INTE längre släppet', async () => {
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add('265900018:Klaffbron');
    await app._triggerBoatNearFlowForBridge(releasableVessel({
      _newJourneyPending: { dir: 'north', time: Date.now() - 40 * MIN },
    }), KANDIDAT);

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('FLOW_TRIGGER_DEDUPE_DIRECTION'))).toBe(true);
    expect(holdRows(app)).toHaveLength(0);
  });

  test('FÄRSK flagga håller kvar blocket — och holdReason säger reversal pending', async () => {
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add('265900018:Klaffbron');
    await app._triggerBoatNearFlowForBridge(releasableVessel({
      _newJourneyPending: { dir: 'north', time: Date.now() - 2 * MIN },
    }), KANDIDAT);

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(holdRows(app)).toHaveLength(1);
    expect(holdRows(app)[0]).toContain('reversal pending');
  });

  test('UTGÅNGEN flagga + redan passerad bro ⇒ RÄTT holdReason (inte reversal pending)', async () => {
    // Före fixen tog den råa truthiness-grenen över och skrev "reversal
    // pending" för en flagga som inte längre bevisade något — loggen pekade
    // fältläsaren mot fel mekanism.
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add('265900018:Klaffbron');
    await app._triggerBoatNearFlowForBridge(releasableVessel({
      passedBridges: ['Klaffbron'],
      _newJourneyPending: { dir: 'north', time: Date.now() - 40 * MIN },
    }), KANDIDAT);

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(holdRows(app)).toHaveLength(1);
    expect(holdRows(app)[0]).toContain('bridge already passed this journey');
    expect(holdRows(app)[0]).not.toContain('reversal pending');
  });

  test('NEGATIV KONTROLL: utgången flagga räddar inte en STILLALIGGANDE båt (F5-A)', async () => {
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add('265900018:Klaffbron');
    await app._triggerBoatNearFlowForBridge(releasableVessel({
      sog: 0.2,
      _newJourneyPending: { dir: 'north', time: Date.now() - 40 * MIN },
    }), KANDIDAT);

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(holdRows(app)[0]).toContain('no movement evidence');
  });
});

// =============================================================================
// NEW_JOURNEY-RESETTEN ANKRAR RESEANKARET (H12-B, fixrunda 1b 2026-08-22)
// =============================================================================
//
// NEW_JOURNEY är per definition en ÄKTA resegräns: den gamla resan slutar i
// exakt den punkten. Utan ett omankrat `_journeyStartLat` låg reseankaret kvar
// på förra resans värde tills nästa måltilldelning råkade sträcka det, och
// origin-vakterna (_targetOriginSideOk, Järnvägsbro-backfillen och sedan
// samma runda _hasPassedTriggerPoint) bedömde returbenet mot UTRESANS start.
// Skrivningen sker via VesselDataService publika anchorJourneyOrigin, som är
// samma hårda ankare _confirmDirectionReversal använder internt — EN
// sanningskälla, ingen kopierad fältskrivning i app-lagret.

describe('NEW_JOURNEY-resetten ankrar om reseankaret', () => {
  function makeJourneyApp(serviceOverrides = {}) {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._analyzeVesselPosition = jest.fn().mockResolvedValue(undefined);
    app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);
    app._checkSkippedBridgesFallback = jest.fn().mockResolvedValue(undefined);
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    app._updateUIIfNeeded = jest.fn();
    app._clearBoatNearTriggers = jest.fn();
    app.statusService = { clearVesselETAHistory: jest.fn() };
    app.vesselDataService = {
      clearTargetProtection: jest.fn(),
      hasGpsJumpHold: () => false,
      anchorJourneyOrigin: jest.fn(),
      ...serviceOverrides,
    };
    app._vesselRemovalTimers = new Map();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    return app;
  }

  // Nordresan är slut (_finalTargetDirection = north), båten vänder söderut i
  // 6 kn och den obekräftade sydflaggan är FÄRSK ⇒ bekräftelsen går igenom.
  const reversingSouth = (overrides = {}) => ({
    mmsi: '265900019',
    lat: KANAL.lat + 2400 / 111320,
    lon: KANAL.lon,
    sog: 6,
    cog: 205,
    targetBridge: null,
    passedBridges: ['Olidebron', 'Klaffbron'],
    _finalTargetBridge: 'Stridsbergsbron',
    _finalTargetDirection: 'north',
    _newJourneyPending: { dir: 'south', time: Date.now() - MIN },
    _firstSeenLat: KANAL.lat - 800 / 111320,
    _journeyStartLat: KANAL.lat - 800 / 111320,
    ...overrides,
  });

  test('bekräftad reversal ⇒ anchorJourneyOrigin anropas med vändningspunkten', async () => {
    const app = makeJourneyApp();
    const vessel = reversingSouth();
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });

    // Resetten körde (annars är hela testet meningslöst).
    expect(vessel.passedBridges).toEqual([]);
    expect(vessel._finalTargetDirection).toBeNull();
    expect(vessel._routeDirection).toBe('south');
    // ... och reseankaret ankrades om via servicen, inte via en egen skrivning.
    expect(app.vesselDataService.anchorJourneyOrigin).toHaveBeenCalledTimes(1);
    const [ankradFartyg, orsak] = app.vesselDataService.anchorJourneyOrigin.mock.calls[0];
    expect(ankradFartyg).toBe(vessel);
    expect(orsak).toBe('new-journey');
  });

  test('OBEKRÄFTAD reversal ankrar INTE (första blippen är ingen resegräns)', async () => {
    const app = makeJourneyApp();
    const vessel = reversingSouth({ _newJourneyPending: null });
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });

    expect(vessel._newJourneyPending).not.toBeNull(); // N6-debouncen satte den
    expect(vessel.passedBridges).toEqual(['Olidebron', 'Klaffbron']);
    expect(app.vesselDataService.anchorJourneyOrigin).not.toHaveBeenCalled();
  });

  test('en service UTAN metoden kraschar inte resetten (valfri koppling)', async () => {
    const app = makeJourneyApp({ anchorJourneyOrigin: undefined });
    const vessel = reversingSouth();
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });

    expect(vessel.passedBridges).toEqual([]); // resetten fullföljdes ändå
    expect(app.error).not.toHaveBeenCalled();
  });
});
