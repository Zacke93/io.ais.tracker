'use strict';

jest.mock('homey');

/**
 * ChatGPT-verifieringen 2026-07-10b — användaren fick en PARTIELL extern
 * granskningssession (tokens tog slut); fem inbäddade anspråk verifierades
 * mot koden, fyra bekräftades som äkta och fixades:
 *
 *   C1 — GPS-kandidaternas livstid var _gateTimeout (30 s) och produktions-
 *        cleanupen (10s-intervall) raderade dem FÖRE nästa Class B-sample
 *        (3–15 min) → tvåstegsbekräftelsen omöjlig i produktion, osynligt
 *        för batteriet (test/replay startar aldrig cleanup-intervallet).
 *        Nu egen _candidateTtl (20 min); gate-blockeringen fortsatt 30 s.
 *   C2 — expired-släppets "curDir !== null" uppfylldes av LÅST
 *        _routeDirection även vid sog 0 (låset från gamla resan bevisar
 *        ingen ny passage) → fantom-notis i fönstret mellan dedup-expiry
 *        (notis+2h) och moored-backstopen (stillhetsstart+2h). Nu explicit
 *        fartkrav (sog ≥ 2) i både huvud- och exit-vägen.
 *   C3 — sessionssläppet krävde att 2h-posten var FYSISKT borttagen ur
 *        mappen medan _persistentDedupCheck behandlar ålder ≥ 2h som
 *        utgången → äkta ny passage strax efter 2h kunde blockeras hela
 *        prune-glappet (monitoring-cleanupen går var 60:e sekund) och
 *        missas om båten hann korsa 300 m-zonen. Nu: utgången post =
 *        frånvarande post, oberoende av prune-timing.
 *   C4 — bridge_text-cachen/hashen uppdateras FÖRE den oawaitade
 *        skrivningen: (a) misslyckad skrivning + hash-dedup → texten
 *        fastnar (värst för sluttexten "Inga båtar…" som saknar force-
 *        självläkning); (b) två parallella skrivningar kunde landa i
 *        omvänd ordning → enheten på gammalt värde, cachen på nytt.
 *        Nu: per-capability-serialisering + hash-nollställning vid fel.
 *
 *   AVVISAT: "första-och-enda AIS-provet nära bro ger ingen notis" —
 *   rörelsebeviskravet (RC-S3) är ett medvetet anti-kajliggarskydd; en
 *   enda observation utan rörelsebevis SKA inte notifiera.
 */

global.__TEST_MODE__ = true;

const AISBridgeApp = require('../app');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');

const REAL_DATE_NOW = Date.now;
const T0 = 1_700_000_000_000;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// =============================================================================
// C1: kandidat-TTL täcker Class B-kadens; gate-blockeringen fortsatt 30 s
// =============================================================================
describe('C1: GPS-kandidater överlever produktions-cleanupen över en Class B-kadens', () => {
  let now;
  let svc;

  beforeEach(() => {
    now = T0;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    svc = new GPSJumpGateService(makeLogger(), null);
  });

  afterEach(() => {
    svc.destroy();
    Date.now = REAL_DATE_NOW;
  });

  test('kandidat 3 min gammal överlever _cleanupExpiredGates (gamla 30s-gränsen raderade den)', () => {
    svc.registerCandidatePassage('265000001', 'Klaffbron', { passed: true }, {
      lat: 58.284, lon: 12.285, cog: 20, sog: 5.0,
    });
    now += 3 * 60 * 1000;
    svc._cleanupExpiredGates();

    expect(svc._candidatePassages.has('265000001')).toBe(true);

    // ...och kan därefter bekräftas (fysiskt konsistent förflyttning)
    const confirmed = svc.confirmStableCandidates('265000001', {
      lat: 58.284 + 460 / 111320, lon: 12.285, cog: 22, sog: 5.0,
    });
    expect(confirmed).toHaveLength(1);
  });

  test('kandidat äldre än 20 min städas bort (TTL:n är inte oändlig)', () => {
    svc.registerCandidatePassage('265000002', 'Klaffbron', { passed: true }, {
      lat: 58.284, lon: 12.285, cog: 20, sog: 5.0,
    });
    now += 21 * 60 * 1000;
    svc._cleanupExpiredGates();

    expect(svc._candidatePassages.has('265000002')).toBe(false);
  });

  test('gate-BLOCKERINGEN är fortsatt 30 s (C1 rör bara kandidaterna)', () => {
    svc.activateGate('265000003', 850, 'gps_jump');
    now += 31 * 1000;
    expect(svc.shouldBlockPassageDetection('265000003', { mmsi: 265000003 }, 'Klaffbron')).toBe(false);
  });
});

// =============================================================================
// C2 + C3: expired-släppets fartkrav och utgången-post-semantiken
// =============================================================================
describe('C2/C3: sessionsdedupens expired-släpp (huvudvägen)', () => {
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
    name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'target',
  };

  test('C2: stillastående båt med LÅST rutt + prunad post → HOLD (gamla koden avfyrade)', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265000004:Klaffbron');
    // Ingen persistent-post (prunad) — och båten har låst rutt men sog 0.2
    const vessel = {
      mmsi: '265000004', name: 'VÄNTAREN', sog: 0.2, cog: 200, etaMinutes: 8, _routeDirection: 'south',
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has('265000004:Klaffbron')).toBe(true);
  });

  test('C2: låst rutt + äkta rörelse (sog 5) → SLÄPPS', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265000004:Klaffbron');
    const vessel = {
      mmsi: '265000004', name: 'RETUREN', sog: 5.0, cog: 200, etaMinutes: 4, _routeDirection: 'south',
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('C3: post ÄLDRE än 2h som ligger kvar i mappen behandlas som utgången → rörlig båt SLÄPPS', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265000005:Klaffbron');
    // Posten är 2h05min gammal men INTE prunad än (cleanup-glappet)
    app._persistentRecentTriggers.set('265000005:Klaffbron', {
      t: Date.now() - (2 * 60 + 5) * 60 * 1000, dir: 'south',
    });
    const vessel = {
      mmsi: '265000005', name: 'NYPASSAGEN', sog: 5.5, cog: 200, etaMinutes: 3, _routeDirection: 'south',
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('C3-negativ: FÄRSK post (1h) blockerar som förut (samma riktning)', async () => {
    const app = makeApp();
    app._triggeredBoatNearKeys.add('265000006:Klaffbron');
    app._persistentRecentTriggers.set('265000006:Klaffbron', {
      t: Date.now() - 60 * 60 * 1000, dir: 'south',
    });
    const vessel = {
      mmsi: '265000006', name: 'DUBBLETTEN', sog: 5.5, cog: 200, etaMinutes: 3, _routeDirection: 'south',
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
  });
});

// =============================================================================
// C4: publiceringsvägen — serialisering + hash-nollställning vid fel
// =============================================================================
describe('C4: capability-skrivningarna är ordnade och självläkande vid fel', () => {
  const flush = () => new Promise((resolve) => {
    setImmediate(resolve);
  });

  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._devices = new Set();
    return app;
  };

  test('C4a: misslyckad bridge_text-skrivning nollställer hash-dedupen', async () => {
    const app = makeApp();
    app._lastBridgeTextHash = 'abc123';
    app._devices.add({
      getName: () => 'TESTENHET',
      setCapabilityValue: jest.fn().mockRejectedValue(new Error('device offline')),
    });

    app._updateDeviceCapability('bridge_text', 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
    await flush();
    await flush();

    expect(app._lastBridgeTextHash).toBeNull();
    expect(app.error).toHaveBeenCalled();
  });

  test('C4a-negativ: lyckad skrivning rör inte hashen', async () => {
    const app = makeApp();
    app._lastBridgeTextHash = 'abc123';
    app._devices.add({
      getName: () => 'TESTENHET',
      setCapabilityValue: jest.fn().mockResolvedValue(undefined),
    });

    app._updateDeviceCapability('bridge_text', 'En båt på väg mot Klaffbron');
    await flush();
    await flush();

    expect(app._lastBridgeTextHash).toBe('abc123');
  });

  test('C4b: två snabba skrivningar landar i RÄTT ordning trots att den första är långsam', async () => {
    const app = makeApp();
    const writeOrder = [];
    let releaseFirst;
    const firstWriteGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;
    app._devices.add({
      getName: () => 'TESTENHET',
      setCapabilityValue: jest.fn((cap, value) => {
        callCount++;
        if (callCount === 1) {
          // Första skrivningen hänger tills vi släpper den
          return firstWriteGate.then(() => {
            writeOrder.push(value);
          });
        }
        writeOrder.push(value);
        return Promise.resolve();
      }),
    });

    app._updateDeviceCapability('bridge_text', 'beräknad broöppning om 9 minuter');
    app._updateDeviceCapability('bridge_text', 'beräknad broöppning om 4 minuter');
    await flush();
    // Före fixen: skrivning 2 ("4") fullbordades här, FÖRE skrivning 1 ("9")
    // → enheten slutade på "9". Med serialiseringen har skrivning 2 inte
    // ens startat förrän skrivning 1 släpps.
    expect(writeOrder).toEqual([]);
    releaseFirst();
    await flush();
    await flush();

    expect(writeOrder).toEqual([
      'beräknad broöppning om 9 minuter',
      'beräknad broöppning om 4 minuter',
    ]);
  });
});
