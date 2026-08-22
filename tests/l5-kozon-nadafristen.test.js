'use strict';

/**
 * L5 (helkodsgranskning RUNDA 3, 2026-08-22, major) — KÖ-ZONSGRENEN RENSADE
 * ALDRIG NÅDAFRISTEN.
 *
 * MEKANISMEN. J12 gav `_clearTargetGrace` fyra namngivna anropsställen men
 * implementerade tre (_applyTargetTransition, _confirmDirectionReversal,
 * _clearStaleTargetBeyond). Det fjärde är kö-zonsgrenen TARGET_QUEUE_ZONE:
 * den HÅLLER KVAR målet när fristen löpt ut, men lämnade posten orörd, så
 * starttiden stod kvar från FÖRSTA missen. När köundantaget upphörde var
 * `graceElapsed` minuter gammal och målet togs bort i SAMMA tick i stället för
 * efter ett nytt 60-sekundersfönster.
 *
 * FÄLTFALLET (CARAT 211452170, 2026-08-05): frist startad 04:14:21,
 * TARGET_QUEUE_ZONE 04:23:59, TARGET_CHANGE → "none" 04:40:11 med förfluten
 * frist 1550 s. Brotexten föll till "Inga båtar" samma sekund och stod fel i
 * 139 s tills ACCELERATED återtilldelade 04:42:30. Pelare 1, användarsynligt.
 *
 * FIXEN raderar posten (omstämpling är bevisat verkningslös: vid nästa
 * grenträff är förfluten tid ändå över 60 s). Systerstället
 * PROTECTION_ZONE_SAVE hoppade över hela grace-blocket på samma sätt och
 * åtgärdas med samma anrop. INGEN TIDSGRÄNS ÄNDRAS.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

// lib/constants.js BRIDGES
const KLAFF = { lat: 58.28409551543077, lon: 12.283929525245636 };
const OLIDE = { lat: 58.272743083145855, lon: 12.275115821922993 };

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

const graceKeys = (svc) => [...(svc._targetRemovalGrace || new Map()).keys()];

/** Alla loggrader (log + debug) sedan senaste nollställning. */
function loggedLines() {
  return [...logger.log.mock.calls, ...logger.debug.mock.calls].map((args) => String(args[0]));
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

beforeEach(() => {
  // Fristen mäts i väggklocka. Date.now mockas (samma modell som J12-sviten) så
  // testet kan hoppa fram minuter utan att väcka städtimrarna.
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

describe('L5: kö-zonsgrenen släpper nådafristen', () => {
  test('CARAT-SCENARIOT: köandet får inte åldra fristen — målet överlever köundantagets slut', () => {
    const svc = makeVDS();
    const mmsi = '211452170'; // CARAT, fältfallet
    const step = (dLat, sog, cog, dt) => {
      NOW += dt;
      logger.log.mockClear();
      logger.debug.mockClear();
      svc.updateVessel(mmsi, {
        mmsi, lat: KLAFF.lat + dLat, lon: KLAFF.lon, sog, cog, name: 'CARAT', timestamp: NOW,
      });
      return svc.vessels.get(mmsi);
    };

    // (1) Norrgående ~557 m söder om Klaffbron ⇒ målbro Klaffbron.
    expect(step(-0.00500, 4.0, 30, 0).targetBridge).toBe('Klaffbron');
    // (2) Närmar sig — valideringen håller. Nedtrappning i steg om högst 2,0 kn
    //     så manöverskyddet inte tar över grenen.
    step(-0.00440, 3.0, 30, 70000);
    // (3) KÖN: anflygningen stannar av ⇒ första valideringsmissen skapar fristen.
    step(-0.00435, 1.5, 30, 70000);
    expect(graceKeys(svc)).toEqual([`${mmsi}:Klaffbron`]);

    // (4) Kö-undantaget slår till när fristen löpt ut: målet HÅLLS KVAR …
    const inQueue = step(-0.00434, 1.0, 30, 70000);
    expect(loggedLines().some((l) => l.includes('TARGET_QUEUE_ZONE'))).toBe(true);
    expect(inQueue.targetBridge).toBe('Klaffbron');
    // … och posten släpps, så fristen inte fortsätter åldras under köandet.
    expect(graceKeys(svc)).toEqual([]);

    // (5) KÖUNDANTAGET UPPHÖR: aktivitetsfönstret (20 min) klingar av, så
    //     `recentlyActive` blir falskt och grenen tas inte längre.
    const afterLapse = step(-0.00433, 1.0, 30, 21 * 60 * 1000);
    const linesLapse = loggedLines();
    expect(linesLapse.some((l) => l.includes('TARGET_QUEUE_ZONE'))).toBe(false);
    // KÄRNAN: en FÄRSK 60 s-frist, inte en borttagning i samma tick.
    expect(afterLapse.targetBridge).toBe('Klaffbron');
    expect(linesLapse.some((l) => l.includes('Starting 60s grace period'))).toBe(true);
    expect(linesLapse.some((l) => l.includes('"Klaffbron" → "none"'))).toBe(false);

    // (6) Fristen fungerar som förut — bara räknad från rätt tidpunkt.
    const afterGrace = step(-0.00432, 1.0, 30, 70000);
    expect(afterGrace.targetBridge).toBeNull();
    expect(loggedLines().some((l) => /Grace period: 7\ds/.test(l))).toBe(true);
  });

  // OMSTÄMPLING HADE INTE RÄCKT (motivering, inget källtextprov — granskning 3
  // strök indexOf-testet som bara läste updateVessel som text): villkoret för
  // att nå kö-grenen är graceElapsed > TARGET_REMOVAL_GRACE_PERIOD, så en
  // omstämplad post är ändå över 60 s vid nästa grenträff och målet tas bort i
  // samma tick. Bevisat som mutation: omstämpling fäller samma två beteende-
  // tester (CARAT-scenariot + j12 steg 4b) som en helt borttagen fix.

  test('SYSTERSTÄLLET: skyddszonsgrenen släpper också posten', () => {
    const svc = makeVDS();
    const mmsi = '211452171';
    // GEOMETRIN som når grenen: skyddszonen (_isInProtectionZone) mäter mot
    // NÄRMASTE bro, medan _checkTargetBridgeProtection mäter mot MÅLBRON. Ligger
    // fartyget nära målbron latchar den yttre målbroprotektionen i stället och
    // hela grace-blocket hoppas över. Därför: 150 m norr om Olidebron (opasserad,
    // ≠ målbro ⇒ F21-bypassen gäller inte) och ~1,2 km från målbron Klaffbron.
    const vessel = {
      mmsi,
      lat: OLIDE.lat + 150 / 111320,
      lon: OLIDE.lon,
      sog: 0.2,
      cog: 30,
      targetBridge: 'Klaffbron',
      passedBridges: [],
      _routeDirection: 'north',
      timestamp: NOW,
      lastPositionUpdate: NOW,
    };
    svc.vessels.set(mmsi, vessel);
    svc._targetRemovalGrace = new Map([[`${mmsi}:Klaffbron`, NOW - 1500 * 1000]]);
    // Den gren som ska nås kräver misslyckad validering + effektivt skydd.
    expect(svc._shouldAssignTargetBridge(vessel, vessel)).toBeFalsy();
    expect(svc._isInProtectionZone(vessel)).toMatchObject({ isProtected: true, bridge: 'Olidebron' });

    logger.debug.mockClear();
    logger.log.mockClear();
    NOW += 1000;
    svc.updateVessel(mmsi, {
      mmsi, lat: vessel.lat, lon: vessel.lon, sog: 0.2, cog: 30, name: 'L5-SKYDD', timestamp: NOW,
    });
    expect(loggedLines().some((l) => l.includes('PROTECTION_ZONE_SAVE'))).toBe(true);
    expect(svc.vessels.get(mmsi).targetBridge).toBe('Klaffbron');
    // Utan raderingen låg den 1500 s gamla posten kvar och första missen EFTER
    // skyddszonen hade tagit målet i samma tick.
    expect(graceKeys(svc)).toEqual([]);
  });
});
