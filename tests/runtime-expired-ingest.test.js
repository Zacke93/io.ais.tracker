'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES } = require('../lib/constants');

const START = Date.parse('2026-09-08T08:00:07.123Z');
const STALE = 30 * 60000;
const MMSI = '902009074';

describe('AIS-återkomst följer samma utgångna livscykel före och efter minutstädning', () => {
  let services;
  let savedMode;
  const create = () => {
    const logger = {
      log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
    };
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, new BridgeRegistry(), coordinator);
    services.push({ service, coordinator });
    return service;
  };
  const data = (overrides = {}) => ({
    lat: BRIDGES.stridsbergsbron.lat - 200 / 111320,
    lon: BRIDGES.stridsbergsbron.lon,
    name: 'UTGÅNGSVAKT',
    sog: 3,
    cog: 0,
    fixTs: Date.now(),
    fixFeed: 'aisstream',
    ...overrides,
  });
  const seed = (service, extra = {}) => {
    const vessel = service.updateVessel(MMSI, data());
    Object.assign(vessel, {
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      _hasMovementProof: true,
      passedBridges: ['Klaffbron'],
      ...extra,
    });
    return vessel;
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    savedMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    services = [];
  });
  afterEach(() => {
    for (const { service, coordinator } of services) {
      service.clearAllTimers();
      coordinator.destroy();
    }
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedMode;
    jest.useRealTimers();
  });

  test.each([STALE, STALE + 26218])('tystnad %s ms städar den gamla båten innan nästa skapas', (gap) => {
    const service = create();
    const old = seed(service);
    const events = [];
    service.on('vessel:removed', ({ vessel, reason }) => events.push({ type: 'removed', vessel, reason }));
    service.on('vessel:entered', () => events.push({ type: 'entered' }));
    service.on('vessel:updated', () => events.push({ type: 'updated' }));
    // Modellera att monitoring inte hunnit köra när en ny AIS-rad anländer.
    jest.setSystemTime(START + gap);

    const returned = service.updateVessel(MMSI, data());

    expect(events.map((event) => event.type)).toEqual(['removed', 'entered']);
    expect(events[0]).toMatchObject({ reason: 'timeout', vessel: { timestamp: START } });
    expect(returned).not.toBe(old);
    expect(service._vesselGraves.has(MMSI)).toBe(false);
    expect(service.logger.log.mock.calls.some((call) => String(call[0]).includes('[STALE_AIS]'))).toBe(true);
  });

  test('en millisekund före gränsen behåller den pågående resan', () => {
    const service = create();
    seed(service);
    const removed = jest.fn();
    service.on('vessel:removed', removed);
    jest.setSystemTime(START + STALE - 1);

    const returned = service.updateVessel(MMSI, data());

    expect(removed).not.toHaveBeenCalled();
    expect(returned.passedBridges).toContain('Klaffbron');
  });

  test('fyra timmars bekräftad stillhet är inte fyra timmars AIS-tystnad', () => {
    const service = create();
    const first = seed(service);
    const removed = jest.fn();
    service.on('vessel:removed', removed);
    let vessel = first;
    for (let minute = 3; minute <= 240; minute += 3) {
      jest.setSystemTime(START + minute * 60000);
      vessel = service.updateVessel(MMSI, data({ sog: 0 }));
    }

    expect(removed).not.toHaveBeenCalled();
    expect(vessel.timestamp).toBe(START + 240 * 60000);
    expect(vessel.lastPositionUpdate).toBe(START);
  });

  test.each([30, 45, 60])('%s min tystnad får ingen ny grav eller ärvd stillhetsklocka vid återkomsten', (minutes) => {
    const outcomes = [];
    for (const sweepFirst of [false, true]) {
      jest.setSystemTime(START);
      const service = create();
      seed(service, { _stationarySince: START - 3 * 3600000, _moored: true });
      if (sweepFirst) {
        jest.setSystemTime(START + STALE);
        expect(service.sweepStaleVessels()).toBe(1);
      }
      jest.setSystemTime(START + minutes * 60000);
      const vessel = service.updateVessel(MMSI, data({ sog: 0, cog: 0 }));
      expect(service._vesselGraves.has(MMSI)).toBe(false);
      outcomes.push({ stationarySince: vessel._stationarySince, moored: vessel._moored });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0].stationarySince).not.toBe(START - 3 * 3600000);
  });

  test.each([30, 39, 40, 45, 60])('%s min efter sista fix: avslutad resa får samma återkomstspärr med och utan tidigare svep', (minutes) => {
    const outcomes = [];
    for (const sweepFirst of [false, true]) {
      jest.setSystemTime(START);
      const service = create();
      seed(service, { targetBridge: null, passedBridges: ['Klaffbron', 'Stridsbergsbron', 'Stallbackabron'] });
      if (sweepFirst) {
        jest.setSystemTime(START + STALE);
        expect(service.sweepStaleVessels()).toBe(1);
      }
      jest.setSystemTime(START + minutes * 60000);
      const returned = service.updateVessel(MMSI, data({ cog: 180 }));
      outcomes.push(returned === null);
    }
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes[0]).toBe(minutes < 40);
  });
});

test('HAJH-LAIFs återkomst efter 30 min 26 s ger samma utfall i alla sex monitoringfaser', () => {
  const replayDir = path.join(__dirname, 'replay-validation');
  const result = spawnSync(process.execPath, [
    path.join(replayDir, 'runPhaseSweep.js'),
    path.join(replayDir, 'corpora-data/ais-replay-20260702-132758.jsonl'),
  ], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
    },
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.stdout).toContain('7 replays totalt');
  expect(result.stdout).toContain('FASSVEP: OK');
}, 20000);
