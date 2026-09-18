'use strict';

const StatusService = require('../lib/services/StatusService');
const ProximityService = require('../lib/services/ProximityService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, UI_CONSTANTS } = require('../lib/constants');

const START = Date.parse('2026-09-18T08:00:00.000Z');
const CLEAN = { gpsJumpDetected: false, positionUncertain: false };
const GPS_JUMP = { gpsJumpDetected: true, positionUncertain: true };

describe('Statusskyddet återhämtas mellan separata GPS-störningar', () => {
  let now;
  let statusService;
  let proximityService;
  let coordinator;

  const boat = (mmsi = '265123450') => ({
    mmsi,
    status: 'waiting',
    waitingAtBridge: 'Klaffbron',
    targetBridge: 'Klaffbron',
    _routeDirection: 'north',
    sog: 2,
    cog: 0,
    etaMinutes: 8,
    lat: BRIDGES.klaffbron.lat - 200 / 111320,
    lon: BRIDGES.klaffbron.lon,
    timestamp: now,
    lastPositionUpdate: now,
  });

  const analyze = (vessel, distance, analysis, timestamp = now) => {
    Object.assign(vessel, {
      lat: BRIDGES.klaffbron.lat - distance / 111320,
      timestamp,
      lastPositionUpdate: timestamp,
    });
    const result = statusService.analyzeVesselStatus(
      vessel, proximityService.analyzeVesselProximity(vessel), analysis,
    );
    Object.assign(vessel, result);
    return result;
  };

  beforeEach(() => {
    now = START;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
    const registry = new BridgeRegistry();
    coordinator = new SystemCoordinator(logger);
    statusService = new StatusService(registry, logger, coordinator);
    proximityService = new ProximityService(registry, logger);
  });

  afterEach(() => {
    statusService.destroy();
    coordinator.destroy();
    jest.restoreAllMocks();
  });

  test('ren fix avslutar förra störningen så nästa GPS-hopp får ett nytt hållningsfönster', () => {
    const vessel = boat();
    expect(analyze(vessel, 1200, GPS_JUMP)).toMatchObject({ status: 'waiting', stabilized: true });
    now += 10000;
    expect(analyze(vessel, 200, CLEAN).status).toBe('waiting');
    now += 120000;

    expect(analyze(vessel, 1200, GPS_JUMP)).toMatchObject({
      status: 'waiting',
      waitingAtBridge: 'Klaffbron',
      stabilized: true,
      statusReason: 'gps_jump_stabilization',
    });
  });

  test('en ren fix bryter även följden av samstämmiga osäkra positionsrapporter', () => {
    const vessel = boat();
    const uncertain = { gpsJumpDetected: false, positionUncertain: true };
    expect(analyze(vessel, 1200, uncertain).status).toBe('waiting');
    now += 10000;
    expect(analyze(vessel, 200, CLEAN).status).toBe('waiting');
    now += 10000;

    expect(analyze(vessel, 1200, uncertain)).toMatchObject({
      status: 'waiting', stabilized: true, statusReason: 'uncertain_position_consistency',
    });
    now += 10000;
    expect(analyze(vessel, 1200, uncertain).status).toBe('en-route');
  });

  test('fortsatt GPS-störning håller i 30 sekunder och får sedan släppa statusen', () => {
    const vessel = boat();
    expect(analyze(vessel, 1200, GPS_JUMP).status).toBe('waiting');
    now += 10000;
    expect(analyze(vessel, 1200, GPS_JUMP, START).status).toBe('waiting');
    now += 21000;
    expect(analyze(vessel, 1200, GPS_JUMP, START).status).toBe('en-route');
  });

  test.each([
    ['timer utan positionsanalys', null, 0],
    ['gammal positionsrapport', CLEAN, UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS + 1],
  ])('%s startar inte om hållningsfönstret', (_label, analysis, age) => {
    const vessel = boat();
    expect(analyze(vessel, 1200, GPS_JUMP).status).toBe('waiting');
    now += 10000;
    expect(analyze(vessel, 200, analysis, now - age).status).toBe('waiting');
    now += 21000;

    expect(analyze(vessel, 1200, GPS_JUMP).status).toBe('en-route');
  });

  test('en båts återhämtning ändrar inte en annan båts pågående hållningsfönster', () => {
    const recovering = boat();
    const uncertain = boat('265123451');
    expect(analyze(recovering, 1200, GPS_JUMP).status).toBe('waiting');
    expect(analyze(uncertain, 1200, GPS_JUMP).status).toBe('waiting');
    now += 10000;
    expect(analyze(recovering, 200, CLEAN).status).toBe('waiting');
    now += 21000;

    expect(analyze(recovering, 1200, GPS_JUMP).status).toBe('waiting');
    expect(analyze(uncertain, 1200, GPS_JUMP).status).toBe('en-route');
  });
});
