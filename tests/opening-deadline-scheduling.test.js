'use strict';

const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES } = require('../lib/constants');

describe('Öppningsdeadline oberoende av watchdogens 30-sekundersfas', () => {
  let service;
  let warning;
  const boat = (distance = 1600) => ({
    mmsi: '265573130',
    name: 'PROVBÅT',
    targetBridge: 'Klaffbron',
    _routeDirection: 'north',
    _hasMovementProof: true,
    lat: BRIDGES.klaffbron.lat - distance / 111320,
    lon: BRIDGES.klaffbron.lon,
    sog: 4,
    cog: 0,
    etaMinutes: 15,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
  });
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-09-08T08:00:00Z') });
    warning = jest.fn();
    service = new Service({ scheduleDeadlines: true, onWarning: warning, targetBridges: ['Klaffbron'] });
  });
  afterEach(() => {
    service.destroy(); expect(jest.getTimerCount()).toBe(0); jest.useRealTimers();
  });
  const deadline = () => [...service._arms.values()][0].fireDueMs;
  test.each([0, 5000, 17000, 29000])('watchdogfas %s ms ändrar inte deadline', (phase) => {
    service.observeVessel(boat());
    const due = deadline();
    expect(warning).not.toHaveBeenCalled();
    const interval = setInterval(() => service.tick(), 30000);
    jest.advanceTimersByTime(phase);
    service.tick();
    jest.advanceTimersByTime(Math.floor(due - Date.now()));
    if (Date.now() < due) expect(warning).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0].t).toBeLessThanOrEqual(Math.ceil(due));
    clearInterval(interval);
  });
  test('färsk position före deadlinen ombokar den; gamla timern får inte avfyra', () => {
    service.observeVessel(boat());
    const oldDue = deadline();
    jest.advanceTimersByTime(30000);
    service.observeVessel(boat()); // färsk, samma läge: tidigast ankomst flyttas
    const newDue = deadline();
    expect(newDue).toBeGreaterThan(oldDue);
    jest.advanceTimersByTime(Math.ceil(oldDue - Date.now()) + 1);
    expect(warning).not.toHaveBeenCalled();
    jest.advanceTimersByTime(Math.ceil(newDue - Date.now()) + 1);
    expect(warning).toHaveBeenCalledTimes(1);
  });
  test('passage avbokar deadlinen', () => {
    service.observeVessel(boat()); service.notePassage('265573130', 'Klaffbron');
    jest.advanceTimersByTime(20 * 60000);
    expect(warning).not.toHaveBeenCalled();
  });
  test('nedstängning avbokar alla callbacks', () => {
    service.observeVessel(boat()); service.destroy(); jest.advanceTimersByTime(20 * 60000);
    expect(warning).not.toHaveBeenCalled();
  });
});
