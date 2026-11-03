'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const {
  BRIDGES, UNDER_BRIDGE_CROSS_SEGMENT_MAX_M, LARGE_JUMP_LAT_DEG, UNDER_BRIDGE_SET_DISTANCE,
} = require('../lib/constants');

/**
 * TP1 (helgranskningen 2026-11-03): mellanbrons avståndsreserv.
 *
 * Ett långt segment som slutar strax efter brolinjen missades av geometrins
 * metoder, och varken zonstämpeln (segment ≤ 400 m) eller gap-kedjan
 * (hopp > 0,005°) tog det. Mellanbron bokfördes aldrig, och notisen sa
 * "närmar sig Järnvägsbron, beräknad ankomst strax" 35 m EFTER bron (WANDA,
 * both-21h; rådatans korsning 12:20:12 ligger före fixen 12:20:25.332).
 * Fixarna nedan är WANDAs verkliga.
 */
const JVB = BRIDGES.jarnvagsbron;
const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};
const services = [];

function makeVDS() {
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.app = {
    gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null, debug: jest.fn(), log: jest.fn(), error: jest.fn(),
  };
  services.push(svc);
  return svc;
}

const fix = (lat, lon, extra = {}) => ({
  mmsi: '211133370', lat, lon, sog: 5, cog: 214, timestamp: Date.now(), ...extra,
});
const WANDA_BEFORE = fix(58.2948, 12.29641, { cog: 222.4, sog: 5.2 });
const WANDA_AFTER = fix(58.29139833333333, 12.29164, { cog: 213.7 });

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

afterEach(() => {
  while (services.length) {
    try {
      services.pop().clearAllTimers();
    } catch (_) { /* tomt */ }
  }
});

describe('TP1: långt segment som slutar strax efter mellanbron', () => {
  test('förutsättning: WANDA-paret ligger i bandet som inga andra vägar täcker', () => {
    const segment = geometry.calculateDistance(WANDA_BEFORE.lat, WANDA_BEFORE.lon, WANDA_AFTER.lat, WANDA_AFTER.lon);
    expect(segment).toBeGreaterThan(UNDER_BRIDGE_CROSS_SEGMENT_MAX_M);
    expect(Math.abs(WANDA_AFTER.lat - WANDA_BEFORE.lat)).toBeLessThanOrEqual(LARGE_JUMP_LAT_DEG);
    expect(geometry.calculateDistance(WANDA_AFTER.lat, WANDA_AFTER.lon, JVB.lat, JVB.lon))
      .toBeLessThanOrEqual(UNDER_BRIDGE_SET_DISTANCE);
    expect(geometry.detectBridgePassage(WANDA_AFTER, WANDA_BEFORE, JVB).passed).toBe(false);
  });

  test('WANDA: passagen av Järnvägsbron bokförs vid korsningsfixen', () => {
    const svc = makeVDS();
    expect(svc._hasPassedBridge(WANDA_AFTER, WANDA_BEFORE, JVB)).toBe(true);
  });

  test('kort segment till samma fix: reserven gäller inte (bokförs vid nästa utgångsfix)', () => {
    const svc = makeVDS();
    // 300 m före fixen längs samma kurs: under segmenttaket.
    const t = 300 / geometry.calculateDistance(WANDA_BEFORE.lat, WANDA_BEFORE.lon, WANDA_AFTER.lat, WANDA_AFTER.lon);
    const shortStart = fix(
      WANDA_AFTER.lat + (WANDA_BEFORE.lat - WANDA_AFTER.lat) * t,
      WANDA_AFTER.lon + (WANDA_BEFORE.lon - WANDA_AFTER.lon) * t,
    );
    const result = geometry.detectBridgePassage(WANDA_AFTER, shortStart, JVB);
    if (!result.passed) expect(svc._hasPassedBridge(WANDA_AFTER, shortStart, JVB)).toBe(false);
  });

  test('ingen reserv utan avgörande sidbyte: fixen på linjen räknas inte som passerad', () => {
    const svc = makeVDS();
    expect(svc._hasPassedBridge(fix(JVB.lat, JVB.lon), WANDA_BEFORE, JVB)).toBe(false);
  });
});
