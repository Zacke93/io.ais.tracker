'use strict';

/**
 * Nattjakten F12 (rättningsomgång 3, 2026-11-16): Fix D:s väntan bekräftas
 * även när målbron togs bort i väntans fix (värld 2931, HAVSORN).
 *
 * Fixen med den första omvända kursen satte väntan och tog i samma tick bort
 * målbron (MOVING_AWAY). Nästa fix, den andra omvända i följd, prövades aldrig
 * eftersom Fix D-blocket kräver målbro; låset stod kvar söderut till nästa
 * brokorsning och notisens riktningsfält var fel. Testerna låser regeln i
 * VesselDataService._confirmFixDPendingWithoutTarget och dess motfall: U18:s
 * två omvända observationer I FÖLJD, AERANDIR-ribban 2 kn, NEW_JOURNEY:s
 * domän efter ett avslutat slutmål och en omlevererad fix. Hela kedjan med
 * en verklig MOVING_AWAY prövas i det syntetiska scenariot
 * "u-sväng-målbron-borta-i-väntans-fix".
 */

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

const KLAFF = BRIDGES.klaffbron;
const JVB = BRIDGES.jarnvagsbron;
const KLAFF_JVB_M = geometry.calculateDistance(KLAFF.lat, KLAFF.lon, JVB.lat, JVB.lon);
const MMSI = '265000912';

/** Punkt på farleden metersNorth norr om Klaffbron (mot Järnvägsbron). */
function northOfKlaff(metersNorth) {
  const f = metersNorth / KLAFF_JVB_M;
  return { lat: KLAFF.lat + (JVB.lat - KLAFF.lat) * f, lon: KLAFF.lon + (JVB.lon - KLAFF.lon) * f };
}

function makeService() {
  const logger = makeLogger();
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(makeLogger()));
  svc.app = {
    gpsJumpGateService: null,
    passageLatchService: null,
    routeOrderValidator: null,
    debug: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  return { svc, logger };
}

/**
 * Sydgående mot Klaffbron, sedan den första omvända fixen (väntan sätts med
 * målbro) och målbron borttagen som i väntans tick. Returnerar sändaren och
 * väntans fixtid.
 */
function setupPendingWithoutTarget({ finalTargetDirection = null } = {}) {
  const { svc, logger } = makeService();
  let fixTs = Date.now();
  const send = (metersNorth, cog, sog, { sameFix = false } = {}) => {
    if (!sameFix) {
      jest.setSystemTime(Date.now() + 65 * 1000);
      fixTs = Date.now() - 5 * 1000;
    }
    const p = northOfKlaff(metersNorth);
    svc.updateVessel(MMSI, {
      lat: p.lat, lon: p.lon, sog, cog, name: 'F12-TEST', fixTs,
    });
    return svc.vessels.get(MMSI);
  };
  send(900, 210, 5);
  send(750, 210, 5);
  const v0 = send(600, 210, 5);
  expect(v0.targetBridge).toBe('Klaffbron');
  expect(v0._routeDirection).toBe('south');
  // Som i värld 2931: returriktningens broar är redan passerade, så ingen
  // målbro norrut kan tilldelas (och låsa riktningen) förrän resan nollställs.
  v0.passedBridges = ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron'];
  // Första omvända fixen: väntan med målbron kvar (målbron ligger bakom).
  const v1 = send(610, 35, 3.5);
  expect(v1._fixDPendingReversal).toEqual(expect.objectContaining({ dir: 'north' }));
  expect(v1.targetBridge).toBe('Klaffbron');
  // Samma tick som i värld 2931: MOVING_AWAY tog bort målbron.
  v1.targetBridge = null;
  if (finalTargetDirection) v1._finalTargetDirection = finalTargetDirection;
  const confirmed = () => logger.log.mock.calls.map((c) => String(c[0]))
    .filter((l) => l.includes('[TARGET_RECALC]') && l.includes('CONFIRMED'));
  return {
    svc, send, confirmed, pendingFixTs: fixTs,
  };
}

describe('Nattjakten F12: Fix D:s väntan när målbron togs bort i väntans fix', () => {
  beforeEach(() => {
    global.__TEST_MODE__ = true;
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 29, 11, 50, 0) });
  });
  afterEach(() => {
    jest.useRealTimers();
    delete global.__TEST_MODE__;
  });

  test('andra omvända fixen i följd bekräftar vändningen utan målbro', () => {
    const { svc, send, confirmed } = setupPendingWithoutTarget();
    const v = send(730, 27, 3.6);
    expect(confirmed()).toHaveLength(1);
    expect(confirmed()[0]).toContain('målbron togs bort i väntans fix');
    expect(v._routeDirection).toBe('north');
    expect(v._fixDPendingReversal).toBeNull();
    svc.clearAllTimers();
  });

  test('motfall U18: en fix i dödbandet emellan bryter kedjan, låset står kvar', () => {
    const { svc, send, confirmed } = setupPendingWithoutTarget();
    send(680, 70, 3.6);
    const v = send(780, 27, 3.6);
    expect(confirmed()).toHaveLength(0);
    expect(v._routeDirection).toBe('south');
    svc.clearAllTimers();
  });

  test('motfall: en fix i den gamla riktningen bekräftar ingenting', () => {
    const { svc, send, confirmed } = setupPendingWithoutTarget();
    const v = send(560, 210, 3.6);
    expect(confirmed()).toHaveLength(0);
    expect(v._routeDirection).toBe('south');
    svc.clearAllTimers();
  });

  test('motfall AERANDIR: andra omvända fixen under 2 kn bekräftar inte', () => {
    const { svc, send, confirmed } = setupPendingWithoutTarget();
    const v = send(640, 27, 1.8);
    expect(confirmed()).toHaveLength(0);
    expect(v._routeDirection).toBe('south');
    svc.clearAllTimers();
  });

  test('motfall: samma fix omlevererad är ingen andra observation', () => {
    const { svc, send, confirmed } = setupPendingWithoutTarget();
    const v = send(610, 35, 3.5, { sameFix: true });
    expect(confirmed()).toHaveLength(0);
    expect(v._routeDirection).toBe('south');
    svc.clearAllTimers();
  });

  test('motfall: efter ett avslutat slutmål äger NEW_JOURNEY vändningen', () => {
    const { svc, send, confirmed } = setupPendingWithoutTarget({ finalTargetDirection: 'south' });
    const v = send(730, 27, 3.6);
    expect(confirmed()).toHaveLength(0);
    expect(v._routeDirection).toBe('south');
    svc.clearAllTimers();
  });

  test('motfall: en väntan utan fixtid (sparad före rättningen) bekräftas inte utan målbro', () => {
    const { svc, send, confirmed } = setupPendingWithoutTarget();
    const stored = svc.vessels.get(MMSI);
    stored._fixDPendingReversal = { dir: 'north', time: stored._fixDPendingReversal.time };
    const v = send(730, 27, 3.6);
    expect(confirmed()).toHaveLength(0);
    expect(v._routeDirection).toBe('south');
    svc.clearAllTimers();
  });
});

describe('Spegling norrut, åldersgränsen och lås som redan bytts (ur granskningen)', () => {
  beforeEach(() => {
    global.__TEST_MODE__ = true; jest.useFakeTimers({ now: Date.UTC(2026, 8, 29, 11, 50, 0) });
  });
  afterEach(() => {
    jest.useRealTimers(); delete global.__TEST_MODE__;
  });
  function mirror() {
    const { svc, logger } = makeService();
    let fixTs = Date.now();
    const send = (m, cog, sog, gapS = 65) => {
      jest.setSystemTime(Date.now() + gapS * 1000); fixTs = Date.now() - 5000; const p = northOfKlaff(m); svc.updateVessel(MMSI, {
        lat: p.lat, lon: p.lon, sog, cog, name: 'SPEGEL', fixTs,
      }); return svc.vessels.get(MMSI);
    };
    send(100, 30, 5); send(250, 30, 5); const v0 = send(400, 30, 5);
    expect(v0._routeDirection).toBe('north');
    expect(v0.targetBridge).toBe('Stridsbergsbron');
    v0.passedBridges = ['Olidebron', 'Klaffbron'];
    const v1 = send(390, 215, 3.5);
    expect(v1._fixDPendingReversal).toEqual(expect.objectContaining({ dir: 'south' }));
    v1.targetBridge = null;
    const confirmed = () => logger.log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[TARGET_RECALC]') && l.includes('CONFIRMED'));
    return {
      svc, send, confirmed, v1,
    };
  }
  test('spegling: norrlåst båt bekräftas söderut', () => {
    const { svc, send, confirmed } = mirror();
    const v = send(280, 207, 3.6);
    expect(confirmed()).toHaveLength(1); expect(v._routeDirection).toBe('south'); svc.clearAllTimers();
  });
  test('spegling: andra fixen 16 min senare bekräftar inte', () => {
    const { svc, send, confirmed } = mirror();
    send(280, 207, 3.6, 16 * 60);
    expect(confirmed()).toHaveLength(0); svc.clearAllTimers();
  });
  test('spegling: andra fixen 14 min senare bekräftar', () => {
    const { svc, send, confirmed } = mirror();
    send(280, 207, 3.6, 14 * 60);
    expect(confirmed()).toHaveLength(1); svc.clearAllTimers();
  });
  test('M5-skyddet: låset redan i väntans riktning ger ingen vändning', () => {
    const {
      svc, send, confirmed, v1,
    } = mirror();
    v1._routeDirection = 'south';
    send(280, 207, 3.6);
    expect(confirmed()).toHaveLength(0); svc.clearAllTimers();
  });
});
