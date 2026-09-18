'use strict';

const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const START = Date.parse('2026-09-18T07:00:00Z');
const MMSI = '265123456';

describe('Fysikgrindarna använder positionsfixets råa fart', () => {
  let service;
  let gate;
  let now;

  beforeEach(() => {
    jest.useFakeTimers();
    now = START;
    jest.setSystemTime(now);
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    service = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    gate = new GPSJumpGateService(logger, null);
  });

  afterEach(() => {
    service.clearAllTimers();
    gate.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function update(offsetM, sog, elapsedMs = 70000) {
    now += elapsedMs;
    jest.setSystemTime(now);
    return service.updateVessel(MMSI, {
      lat: 58.29 + offsetM / 111320,
      lon: 12.29,
      sog,
      cog: 30,
      fixTs: now,
      fixFeed: 'aisstream',
    });
  }

  test('saknad ny fart blir inte gammal stillhet i GPS-analysen eller målskyddet', () => {
    const previous = update(0, 0.2, 0);
    const current = update(300, null);

    expect(current.sog).toBe(0.2); // Presentationens befintliga arv behålls.
    expect(current._rawPositionSog).toBeNull();
    expect(current._positionAnalysis).toMatchObject({ action: 'accept', reason: 'medium_movement' });
    expect(current._positionUncertain).toBe(false);
    expect(service._detectGPSEventProtection(current, previous)).toBe(false);
  });

  test('saknad föregående fart behåller samma okänd-semantik efter objektombyggnaden', () => {
    update(0, 0.2, 0);
    const previous = update(0, null);
    const current = update(300, 0.2);

    expect(previous.sog).toBe(0.2);
    expect(previous._rawPositionSog).toBeNull();
    expect(current._positionAnalysis).toMatchObject({ action: 'accept', reason: 'medium_movement' });
    expect(service._detectGPSEventProtection(current, previous)).toBe(false);
  });

  test('två rapporterade låga farter stoppar fortfarande orimlig rörelse', () => {
    const previous = update(0, 0.2, 0);
    const current = update(300, 0.2);
    expect(current._positionAnalysis.reason).toBe('medium_movement_speed_mismatch');
    expect(current._positionUncertain).toBe(true);
    expect(service._detectGPSEventProtection(current, previous)).toBe(true);
  });

  test('saknad fart gör inte en orimligt snabb 300-metersförflyttning rimlig', () => {
    update(0, 0.2, 0);
    const current = update(300, null, 1000);
    expect(current._positionUncertain).toBe(true);
  });

  test('GPS-kandidaten får bekräftas när den färska fixen saknar fart', () => {
    const previous = update(0, 0.2, 0);
    gate.registerCandidatePassage(MMSI, 'Klaffbron', { passed: true }, previous);
    const current = update(300, null);
    expect(gate.confirmStableCandidates(MMSI, current)).toHaveLength(1);
  });

  test('kandidatens råa okända fart överlever snapshotten', () => {
    update(0, 0.2, 0);
    const previous = update(0, null);
    gate.registerCandidatePassage(MMSI, 'Klaffbron', { passed: true }, previous);
    const current = update(300, 0.2);
    expect(gate.confirmStableCandidates(MMSI, current)).toHaveLength(1);
  });
});
