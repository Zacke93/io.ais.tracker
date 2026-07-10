'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { TRIGGER_POINTS } = require('../lib/constants');

/**
 * Fältprov 5 (20260710-015254, 13,5 h, 12 fartyg, 79 notiser): 50 Opus-max-
 * läsare + dirigentens rådatarevision. Tre rådataverifierade fixar låses här:
 *
 *   F5-A — expired-släppet i sessionsdedupen krävde varken rörelse eller
 *          reversal-ro: (a) PILOT 761 stillaliggande vid lots-stationen
 *          (sog 0, 294 m från passerad Stallbackabron) re-notifierades när
 *          2h-posten prunades (08:25-fantomen); (b) släppet avfyrade under
 *          OBEKRÄFTAD reversal och NEW_JOURNEY-bekräftelsen 80 s senare
 *          rensade nyckeln och avfyrade om (11:32/11:33-dubbletten).
 *   F5-B — exit-fallbackens 400 m-gate strök IN-AXXI:s Kanalinfarten-notis
 *          (sista sample 546 m norr om punkten i 6,5 kn sydgående transit,
 *          Olidebron bevisat passerad) — tredje rådataverifierade fallet i
 *          klassen (318/327 m fixades med 400 m-radien). Utökad radie 800 m
 *          kräver aktiv sydtransit (sog ≥ 3, cog 135–225, Olide passerad).
 *   F5-C — PRÖVAD OCH ÅTERKALLAD: en projektionsklamp av waiting-ETA (mot
 *          SAGESSE:s 23↔12-sågtand) FÄLLDES av 41h-korpusen — klampen
 *          växlade med status-hysteresens waiting↔approaching och skapade
 *          en värre oscillation (12→71→12 på 9 s, INV-sågtand + INV-
 *          oscillation). F4-G/F4-M-läxan bekräftad fjärde gången:
 *          visningsingrepp som följer status är flappigare än beräknings-
 *          värdet. Negativtesten nedan LÅSER att projektionen inte klampar.
 */

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

// =============================================================================
// F5-A: expired-släppet kräver rörelsebevis + ingen pending-reversal
// =============================================================================
describe('F5-A: sessionsdedupens expired-släpp (PILOT 761-klassen)', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._getDirectionString = jest.fn(() => 'söderut');
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
    return app;
  };
  const candidate = {
    name: 'Stallbackabron', id: 'stallbackabron', distance: 294, source: 'nearest',
  };

  test('08:25-fantomen: stillaliggare (sog 0) + expired nyckel → BLOCKERAD', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265606970:Stallbackabron');
    // Ingen persistent-post (prunad >2h) — gamla koden släppte ovillkorligt.
    const vessel = {
      mmsi: '265606970', name: 'PILOT 761', sog: 0, cog: 338, etaMinutes: null,
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has('265606970:Stallbackabron')).toBe(true);
  });

  test('11:32-dubbletten: rörlig men reversal PENDING → BLOCKERAD (bekräftelsen äger notisen)', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265606970:Stallbackabron');
    const vessel = {
      mmsi: '265606970',
      name: 'PILOT 761',
      sog: 4.7,
      cog: 193,
      etaMinutes: 2,
      _newJourneyPending: { dir: 'south', time: Date.now() },
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
  });

  test('legitim >2h-retur i rörelse (ELFKUNGEN-klassen) → SLÄPPS som förut', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265573130:Stallbackabron');
    const vessel = {
      mmsi: '265573130', name: 'ELFKUNGEN', sog: 7.9, cog: 198, etaMinutes: 3,
    };

    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Stallbackabron', id: 'stallbackabron', distance: 250, source: 'nearest',
    });

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('flip-grenen (persistent med motsatt riktning + rörelse) orörd → SLÄPPS', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265573130:Stallbackabron');
    app._persistentRecentTriggers.set('265573130:Stallbackabron', {
      t: Date.now() - 90 * 60 * 1000, // 1,5h — inom 2h-fönstret
      dir: 'north',
    });
    const vessel = {
      mmsi: '265573130', name: 'ELFKUNGEN', sog: 7.9, cog: 198, etaMinutes: 3,
    };

    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Stallbackabron', id: 'stallbackabron', distance: 250, source: 'nearest',
    });

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// F5-B: exit-fallbackens villkorade radieutökning (IN-AXXI-klassen)
// =============================================================================
describe('F5-B: Kanalinfarten-exit med utökad radie vid aktiv sydtransit', () => {
  const tp = TRIGGER_POINTS.kanalinfarten;

  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    return app;
  };

  // ~546 m norr om punkten (IN-AXXI:s sista sample 58.27213/12.2744)
  const inAxxiSnapshot = (overrides = {}) => ({
    mmsi: '244130745',
    name: 'IN-AXXI',
    lat: 58.27213,
    lon: 12.2744,
    sog: 6.5,
    cog: 214,
    passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron', 'Olidebron'],
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _lastSeen: Date.now(),
    _moored: false,
    _hasMovementProof: true,
    _finalTargetDirection: 'south',
    ...overrides,
  });

  test('IN-AXXI-klassen: 546 m + 6,5 kn sydgående + Olide passerad → notisen AVFYRAS', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback(inAxxiSnapshot());
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledWith(
      expect.objectContaining({ mmsi: '244130745' }), 'Kanalinfarten',
    );
  });

  test('Olide-liggaren: 546 m men sog 0,2 → INGEN notis (utökningen kräver transit)', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback(inAxxiSnapshot({ sog: 0.2 }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('utan Olidebron i passedBridges → INGEN notis på utökad radie', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback(inAxxiSnapshot({
      passedBridges: ['Stallbackabron', 'Stridsbergsbron'],
    }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('nordlig kurs (cog 30) på 546 m → INGEN notis (fel riktning)', async () => {
    const app = makeApp();
    await app._triggerExitPointFallback(inAxxiSnapshot({ cog: 30 }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('bortom 800 m → INGEN notis även med full transitbevisning', async () => {
    const app = makeApp();
    // ~900 m norr om punkten
    await app._triggerExitPointFallback(inAxxiSnapshot({ lat: tp.lat + 0.0081, lon: tp.lon }));
    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
  });

  test('basfallet ≤400 m fungerar som förut (utan transitkrav)', async () => {
    const app = makeApp();
    // ~330 m norr om punkten, långsam men med rörelsebevis
    await app._triggerExitPointFallback(inAxxiSnapshot({
      lat: tp.lat + 0.003, lon: tp.lon, sog: 1.2, passedBridges: ['Olidebron'],
    }));
    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// F5-C ÅTERKALLAD: projektionen får INTE klampa ETA (korpusbelagd läxa)
// =============================================================================
describe('F5-C ÅTERKALLAD: projektionen klampar ALDRIG etaMinutes', () => {
  const makeApp = (vessel) => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.vesselDataService = { getVesselsForBridgeText: jest.fn(() => [vessel]) };
    app.proximityService = {
      analyzeVesselProximity: jest.fn(() => ({
        nearestBridge: null, nearestDistance: Infinity, bridgeDistances: {},
      })),
    };
    app.bridgeRegistry = { findBridgeIdByName: jest.fn(() => null) };
    return app;
  };

  test('waiting med okapad 23,41 → projektionen BEVARAR värdet (41h-korpusen fällde klampen: 12→71→12-oscillation)', () => {
    const app = makeApp({
      mmsi: '232043329', name: 'SAGESSE', status: 'waiting', targetBridge: 'Stridsbergsbron', etaMinutes: 23.41,
    });
    const [projected] = app._findRelevantBoatsForBridgeText();
    expect(projected.etaMinutes).toBe(23.41);
  });

  test('waiting med jättehög ETA (71) → bevaras — beräkningens ETA_WAIT_CAP äger kapningen', () => {
    const app = makeApp({
      mmsi: '265999999', name: 'KORPUSBÅTEN', status: 'waiting', targetBridge: 'Klaffbron', etaMinutes: 71,
    });
    const [projected] = app._findRelevantBoatsForBridgeText();
    expect(projected.etaMinutes).toBe(71);
  });

  test('null-ETA förblir null', () => {
    const app = makeApp({
      mmsi: '232043329', name: 'SAGESSE', status: 'waiting', targetBridge: 'Stridsbergsbron', etaMinutes: null,
    });
    const [projected] = app._findRelevantBoatsForBridgeText();
    expect(projected.etaMinutes).toBeNull();
  });
});
