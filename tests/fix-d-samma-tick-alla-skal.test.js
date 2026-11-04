'use strict';

/**
 * Fix D-bekräftelsen ogiltigförklarar det övergivna målet som 2-READINGS-
 * referens i SAMMA tick — för alla tre skälen, inte bara "dist > 500".
 *
 * Granskningen av fixvågen 2026-11-04: helgranskningen 2026-11-03 prövade
 * bara skälet dist > 500 (ANYA ELAN, u-sväng-gles-ais). En U-sväng 300–500 m
 * från det övergivna målet bekräftas
 * med skälet "target behind vessel" (eller "target already in passedBridges"),
 * och då är 2-READINGS-avslaget (avståndet ökar, > 300 m) skillnaden mellan
 * returmål i bekräftelseticken och en mållös tick. Fältfallet för skälet är
 * ELFKUNGEN 265573130 i both-21h 12:29:57 (127 → 317 m från Klaffbron), men
 * där finns inget mål söderut, så banken kan inte se flaggan.
 */

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

const STRIDS = BRIDGES.stridsbergsbron;
const JVB = BRIDGES.jarnvagsbron;
const KLAFF = BRIDGES.klaffbron;
const STRIDS_JVB_M = geometry.calculateDistance(STRIDS.lat, STRIDS.lon, JVB.lat, JVB.lon);
const JVB_KLAFF_M = geometry.calculateDistance(JVB.lat, JVB.lon, KLAFF.lat, KLAFF.lon);

/** Punkt på farleden metersSouth söder om Stridsbergsbron (via Järnvägsbron). */
function southOfStrids(metersSouth) {
  const lerp = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
  if (metersSouth <= STRIDS_JVB_M) return lerp(STRIDS, JVB, metersSouth / STRIDS_JVB_M);
  return lerp(JVB, KLAFF, (metersSouth - STRIDS_JVB_M) / JVB_KLAFF_M);
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

describe('Fix D: bekräftelsen släpper 2-READINGS-referensen för varje skäl', () => {
  beforeEach(() => {
    global.__TEST_MODE__ = true;
    jest.useFakeTimers({ now: Date.UTC(2026, 0, 1, 6, 0, 0) });
  });
  afterEach(() => {
    jest.useRealTimers();
    delete global.__TEST_MODE__;
  });

  test.each([
    ['target behind vessel', false],
    ['target already in passedBridges', true],
  ])('skälet "%s": returmålet tilldelas i bekräftelseticken (300–500 m, avståndet ökar)', (reason, markPassed) => {
    const { svc, logger } = makeService();
    const MMSI = '265000777';
    const send = (metersSouth, cog) => {
      const p = southOfStrids(metersSouth);
      svc.updateVessel(MMSI, {
        lat: p.lat, lon: p.lon, sog: 5.5, cog, name: 'FIXD-TEST',
      });
      jest.setSystemTime(Date.now() + 30 * 1000);
    };

    // 1. Norrgående mot Stridsbergsbron, 380 m kvar.
    send(380, 30);
    const v1 = svc.vessels.get(MMSI);
    expect(v1.targetBridge).toBe('Stridsbergsbron');
    expect(v1._routeDirection).toBe('north');
    if (markPassed) v1.passedBridges = ['Stridsbergsbron'];

    // 2. Första sydliga observationen 355 m från bron — debouncen armeras.
    send(355, 210);
    expect(svc.vessels.get(MMSI).targetBridge).toBe('Stridsbergsbron');
    expect(svc.vessels.get(MMSI)._fixDPendingReversal).toEqual(expect.objectContaining({ dir: 'south' }));

    // 3. Bekräftelsen 400 m från bron (≤ 500 m ⇒ inte dist-skälet; > 300 m och
    //    ökande ⇒ 2-READINGS mot det övergivna målet hade underkänt).
    send(400, 210);
    const confirmLine = logger.log.mock.calls.map((c) => String(c[0]))
      .find((l) => l.includes('[TARGET_RECALC]') && l.includes('CONFIRMED'));
    expect(confirmLine).toContain(reason);
    const after = svc.vessels.get(MMSI);
    expect(after._routeDirection).toBe('south');
    expect(after.targetBridge).toBe('Klaffbron');
    svc.clearAllTimers();
  });
});
