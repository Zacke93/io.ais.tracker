'use strict';

const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES } = require('../lib/constants');
const { waitingBridge } = require('../lib/utils/bridgeQueue');

const START = Date.parse('2026-09-12T08:00:00Z');
const LEAD = '265000001';
const FOLLOWER = '265000002';
const TARGET = 'Stridsbergsbron';

describe('Positionsbelagd konvoj förblir täckt när fix åldras', () => {
  let service;
  let warning;
  let coverage;
  const boat = (mmsi, distance, extra = {}) => ({
    mmsi,
    name: mmsi,
    lat: BRIDGES.stridsbergsbron.lat - distance / 111320,
    lon: BRIDGES.stridsbergsbron.lon,
    sog: 4.2,
    cog: 0,
    targetBridge: TARGET,
    _routeDirection: 'north',
    _hasMovementProof: true,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aisstream',
    etaMinutes: null,
    status: 'approaching',
    passedBridges: ['Klaffbron'],
    ...extra,
  });
  const lead = (distance = 250, extra = {}) => boat(LEAD, distance, {
    passedBridges: ['Klaffbron', 'Järnvägsbron'], ...extra,
  });
  const arm = () => service._arms.get(`${FOLLOWER}::${TARGET}`);
  function startConvoy() {
    service.observeVessel(lead());
    service.observeVessel(boat(FOLLOWER, 550));
    expect(warning).toHaveBeenCalledTimes(1);
    expect(coverage.mock.calls.map(([info]) => [info.mmsi, info.reason])).toEqual([
      [LEAD, 'fired'], [FOLLOWER, 'absorbed'],
    ]);
  }
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    warning = jest.fn(); coverage = jest.fn();
    service = new Service({ onWarning: warning, onCoverage: coverage, targetBridges: [TARGET] });
  });
  afterEach(() => {
    service.destroy(); jest.useRealTimers();
  });

  test.each([true, false])('bara ledaren får nytt fix efter61s; hennes passage=%s', (passage) => {
    startConvoy();
    const { eventId } = arm();
    const coverUntil = arm().coverUntilMs;
    jest.setSystemTime(START + 61000);
    service.observeVessel(lead(250 - 61 * 4.2 * 0.514444));
    expect(arm().eventId).toBe(eventId);
    expect(arm().coverUntilMs).toBe(coverUntil);
    if (passage) service.notePassage(LEAD, TARGET);
    jest.setSystemTime(START + 76000);
    service.tick();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(arm().eventId).toBe(eventId);
  });

  test('ett nytt lågt fartvärde utan bekräftad kö är inget positionsmotbevis', () => {
    startConvoy();
    const { eventId } = arm();
    jest.setSystemTime(START + 61000);
    const unconfirmed = boat(FOLLOWER, 500, { sog: 0.1 });
    expect(waitingBridge(unconfirmed)).toBeNull();
    service.observeVessel(unconfirmed);
    jest.setSystemTime(START + 7 * 60000);
    service.tick();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(arm().eventId).toBe(eventId);
  });

  test('ny färsk bekräftad kö vid Järn frigör första egna varningen', () => {
    startConvoy();
    const oldEvent = arm().eventId;
    jest.setSystemTime(START + 3 * 60000);
    const queued = boat(FOLLOWER, 402, { sog: 0.1, status: 'waiting' });
    Object.assign(queued, {
      _stationarySince: Date.now() - 120000,
      _stillnessAnchor: { lat: queued.lat, lon: queued.lon, t: Date.now() - 120000 },
      _bridgeQueueApproaches: { Järnvägsbron: { confirmedAt: START, direction: 'north' } },
    });
    expect(waitingBridge(queued)).toBe('Järnvägsbron');
    service.observeVessel(queued);
    expect(arm().eventId).toBeNull();
    expect(arm().releasedFrom.has(oldEvent)).toBe(true);
    expect(warning).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + 5 * 60000);
    service.tick();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0]).toMatchObject({ mmsis: [FOLLOWER], etaMinutes: null });
  });

  test('befintligt coverUntil gäller fortfarande, inget nytt långtidsminne', () => {
    startConvoy();
    jest.setSystemTime(arm().coverUntilMs + 1);
    service.tick();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0].mmsis).toEqual([FOLLOWER]);
  });

  test('leveransfel frigör även den positionsbelagda följaren', () => {
    startConvoy();
    service.noteWarningDeliveryFailure(arm().eventId);
    jest.setSystemTime(START + 76000);
    service.tick();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0].mmsis).toEqual([FOLLOWER]);
  });

  test.each([
    ['fixklockor61s isär', 61000, {}],
    ['för stort uppmätt gap', 0, { distance: 850 }],
    ['motsatt riktning', 0, { _routeDirection: 'south', passedBridges: [] }],
  ])('%s kan inte ge den första fysiska absorptionen', (_label, elapsed, extra) => {
    service.observeVessel(lead());
    jest.setSystemTime(START + elapsed);
    service.observeVessel(boat(FOLLOWER, extra.distance || 550, extra));
    expect(coverage.mock.calls.filter(([info]) => info.mmsi === FOLLOWER && info.reason === 'absorbed')).toHaveLength(0);
  });

  test('positionsbevisad värd går före en äldre ovarnad prognoshändelse', () => {
    service.observeVessel(boat('265000003', 2300, { passedBridges: [], etaMinutes: 20 }));
    service.observeVessel(lead(250, { etaMinutes: 5 }));
    const firedEvent = warning.mock.calls[0][0].eventId;
    service.observeVessel(boat(FOLLOWER, 550, { etaMinutes: 12 }));
    expect(arm().eventId).toBe(firedEvent);
    expect(arm().absorbedAt).toBe(START);
    jest.setSystemTime(START + 76000);
    service.tick();
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
