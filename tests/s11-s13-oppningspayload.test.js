'use strict';

/**
 * =============================================================================
 * S11 + S13 (systerställesrundan 2026-08-23) — SERVICESIDAN AV DE TVÅ
 * PAYLOADFÄLTEN
 * =============================================================================
 *
 * De två app-sidorna har egna sviter (s11-medlemsriktning-dedupnyckel,
 * s13-oppningsutgang-forvantad-ankomst). Den här låser att
 * BridgeOpeningService FAKTISKT producerar fälten ur riktiga armar — utan det
 * kan app-sidan vara aldrig så korrekt och ändå ligga död, precis som
 * `eventDirection` låg död tills K13b kopplade in den.
 *
 * RIGGEN ÄR K14/K13b-sviternas: riktig service, riktig observeVessel, riktig
 * tick-loop under fake timers. Inget fält skrivs av testet.
 *
 * MUTATIONSPROV (körda i isolerat träd, se rapporten):
 *  M1 = memberDirections borttaget ur payloaden ⇒ tre S11-tester röda
 *  M2 = _memberDirections läser cog i stället för ruttlåset ⇒ "samma källa som
 *       eventDirection" rött
 *  M3 = expectedArrivalMs som min() i stället för max() ⇒ "eftersläntraren" rött
 *  M4 = expectedArrivalMs saknar null-normaliseringen ⇒ "ingen prognos" rött
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Position `distanceM` meter från bron längs bäring `bearingDeg` (220 = söder om). */
function posAtDistance(bridge, distanceM, bearingDeg = 220) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/** Fartygsobjekt i samma form som VesselDataService._createVesselObject ger. */
function makeVessel(overrides = {}) {
  const bridge = overrides.bridge || KLAFF;
  const distanceM = overrides.distanceM ?? 1000;
  const bearing = overrides.bearing ?? 220;
  const pos = posAtDistance(bridge, distanceM, bearing);
  const now = Date.now();
  return {
    mmsi: overrides.mmsi || '265999001',
    name: overrides.name || 'TESTBÅT',
    lat: pos.lat,
    lon: pos.lon,
    sog: overrides.sog === undefined ? 5 : overrides.sog,
    cog: overrides.cog ?? 40,
    timestamp: overrides.timestamp ?? now,
    fixTs: overrides.fixTs ?? now,
    targetBridge: overrides.targetBridge === undefined ? bridge.name : overrides.targetBridge,
    _routeDirection: overrides._routeDirection === undefined ? 'north' : overrides._routeDirection,
    _finalTargetDirection: overrides._finalTargetDirection ?? null,
    _hasMovementProof: overrides._hasMovementProof === undefined ? true : overrides._hasMovementProof,
    _moored: overrides._moored === true,
    _stationarySince: overrides._stationarySince === undefined ? null : overrides._stationarySince,
    navStatus: overrides.navStatus === undefined ? null : overrides.navStatus,
    etaMinutes: overrides.etaMinutes ?? null,
    passedAt: overrides.passedAt || {},
    passedBridges: overrides.passedBridges || [],
  };
}

describe('S11/S13 — öppningspayloadens två nya fält', () => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;

  const advance = (ms) => jest.advanceTimersByTime(ms);
  const warnFor = (bridgeName) => warnings.filter((w) => w.bridge === bridgeName);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    svc = new BridgeOpeningService({ logger, onWarning: (p) => warnings.push(p) });
    tickTimer = setInterval(() => svc.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
  });

  afterEach(() => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (svc) svc.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // ==========================================================================
  // S11 — memberDirections
  // ==========================================================================
  describe('S11 — medlemsriktningarna', () => {
    it('MÖTANDE konvoj ⇒ varje medlem bär SIN EGEN riktning', () => {
      svc.observeVessel(makeVessel({
        mmsi: 'NORR', name: 'BALTIC JONGLEUR', distanceM: 1000, sog: 5, bearing: 220, _routeDirection: 'north',
      }));
      svc.observeVessel(makeVessel({
        mmsi: 'SYD', name: 'TONGA', distanceM: 1100, sog: 5, bearing: 40, _routeDirection: 'south',
      }));
      advance(30000);

      const [w] = warnFor('Klaffbron');
      expect(w.eventDirection).toBe('mixed');
      expect(w.memberDirections).toEqual({ NORR: 'northbound', SYD: 'southbound' });
      // Ledarens fält är oförändrat — facit nycklas på det.
      expect(w.direction).toBe('northbound');
      // Kartan täcker EXAKT medlemslistan.
      expect(Object.keys(w.memberDirections).sort()).toEqual([...w.mmsis].sort());
    });

    it('SAMMA KÄLLA SOM eventDirection: ruttlåset, aldrig COG', () => {
      // COG pekar norrut (40°) men ruttlåset saknas ⇒ ingen egen uppgift.
      // `direction` har en COG-fallback och blir 'northbound'; medlemsfältet
      // ska INTE ärva den, för då hade de två fälten mätt olika saker.
      svc.observeVessel(makeVessel({
        mmsi: 'OKAND', distanceM: 900, sog: 6, cog: 40, _routeDirection: null,
      }));
      advance(30000);

      const [w] = warnFor('Klaffbron');
      expect(w.eventDirection).toBeNull();
      expect(w.memberDirections).toEqual({ OKAND: null });
    });

    it('ENIG konvoj ⇒ alla medlemmar bär samma token som eventDirection', () => {
      svc.observeVessel(makeVessel({
        mmsi: 'A', distanceM: 1000, sog: 5, _routeDirection: 'north',
      }));
      svc.observeVessel(makeVessel({
        mmsi: 'B', distanceM: 1100, sog: 5, _routeDirection: 'north',
      }));
      advance(30000);

      const [w] = warnFor('Klaffbron');
      expect(w.memberDirections).toEqual({ A: 'northbound', B: 'northbound' });
      expect(new Set(Object.values(w.memberDirections))).toEqual(new Set([w.eventDirection]));
    });
  });

  // ==========================================================================
  // S13 — expectedArrivalMs
  // ==========================================================================
  describe('S13 — armens förväntade ankomst', () => {
    it('EFTERSLÄNTRAREN styr: fältet är MAX över medlemmarna', () => {
      // Två båtar mot samma bro, olika fart ⇒ olika ankomstprognos. Posten i
      // app.js får EN gemensam utgång, så skyddet måste räcka för den sista.
      svc.observeVessel(makeVessel({
        mmsi: 'SNABB', distanceM: 1000, sog: 5, _routeDirection: 'north',
      }));
      svc.observeVessel(makeVessel({
        mmsi: 'LANGSAM', distanceM: 1100, sog: 5, _routeDirection: 'north',
      }));
      advance(30000);

      const [w] = warnFor('Klaffbron');
      expect(w.vesselCount).toBe(2);
      const armar = [...svc._arms.values()].filter((a) => a.bridge === 'Klaffbron');
      const max = Math.max(...armar.map((a) => a.expectedArrivalMs));
      const min = Math.min(...armar.map((a) => a.expectedArrivalMs));
      expect(max).toBeGreaterThan(min); // riggkontroll: prognoserna skiljer sig
      expect(w.expectedArrivalMs).toBe(max);
      // Referensankomsten (händelsens egen storhet) är MIN — de två får inte
      // förväxlas, och att de skiljer sig är hela poängen med fältet.
      expect(w.expectedArrivalMs).not.toBe(min);
    });

    it('PROGNOSEN ÄR EN EGEN STORHET — inte tokenens avrundade minuter', () => {
      // Poängen med fältet: `etaMinutes` är avrundade HELA minuter och tystnar
      // helt när B2d-grinden dömer fixet gammalt, medan `expectedArrivalMs` är
      // millisekundsprognosen som app.js behöver för omstartsskyddet.
      svc.observeVessel(makeVessel({
        mmsi: 'A', distanceM: 900, sog: 6, _routeDirection: 'north',
      }));
      advance(30000);

      const [w] = warnFor('Klaffbron');
      expect(Number.isFinite(w.expectedArrivalMs)).toBe(true);
      expect(w.expectedArrivalMs).toBeGreaterThan(Date.now());
      // Millisekundsvärdet är INTE tokenens minuter gånger 60000 — de två
      // storheterna får inte förväxlas av en framtida refaktor.
      expect(w.expectedArrivalMs).not.toBe(Date.now() + w.etaMinutes * 60000);
    });

    it('INGEN PROGNOS ⇒ null, samma konvention som dueMs/originalDueMs', () => {
      svc.observeVessel(makeVessel({
        mmsi: 'A', distanceM: 1000, sog: 5, _routeDirection: 'north',
      }));
      advance(30000);
      const [w] = warnFor('Klaffbron');
      // Hängslen: fältet får ALDRIG bära -Infinity ut i app.js.
      expect(w.expectedArrivalMs === null || Number.isFinite(w.expectedArrivalMs)).toBe(true);
      expect(Object.is(w.expectedArrivalMs, -Infinity)).toBe(false);
    });
  });

  // ==========================================================================
  // FÄLTLIST-FÄLLAN
  // ==========================================================================
  it('INGA NYA FÄLT PÅ FARTYGSOBJEKTET — armarna lever i servicens egen Map', () => {
    const v = makeVessel({
      mmsi: 'X', distanceM: 900, sog: 6, _routeDirection: 'north',
    });
    const före = Object.keys(v).sort();
    svc.observeVessel(v);
    advance(30000);
    expect(Object.keys(v).sort()).toEqual(före);
  });
});
