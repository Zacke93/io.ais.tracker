'use strict';

jest.mock('homey');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

const MMSI = '902009075';
const START = Date.parse('2026-09-08T08:00:07.123Z');

test('utgången sydgående båts ETA-buffert får inte följa med medan utfartsfallback väntar', async () => {
  jest.useFakeTimers({ now: START });
  const savedMode = global.__TEST_MODE__;
  global.__TEST_MODE__ = true;
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app.homey = {
    ...mockHomey,
    settings: {
      get: () => null, set: jest.fn(), on: jest.fn(), off: jest.fn(),
    },
    flow: { ...mockHomey.flow },
  };
  let finishExit;
  const exitPending = new Promise((resolve) => {
    finishExit = resolve;
  });
  try {
    await app.onInit();
    app._processAISMessage({
      mmsi: MMSI, lat: 58.288, lon: 12.288, sog: 6, cog: 180, shipName: 'UTGÅENDE', timestamp: START,
    });
    await jest.advanceTimersByTimeAsync(1000);
    const previous = app.vesselDataService.getVessel(MMSI);
    Object.assign(previous, { _routeDirection: 'south', passedBridges: ['Stridsbergsbron'], targetBridge: 'Klaffbron' });
    const calculator = app.statusService.progressiveETACalculator;
    calculator._speedBuffers.set(MMSI, [6, 6, 6]);
    calculator._etaHistory.set(MMSI, [{ timestamp: START, processedETA: 5 }]);
    const observedBuffers = [];
    const average = calculator._getAveragedSpeed.bind(calculator);
    jest.spyOn(calculator, '_getAveragedSpeed').mockImplementation((vessel, speed) => {
      observedBuffers.push([...(calculator._speedBuffers.get(MMSI) || [])]);
      return average(vessel, speed);
    });
    jest.spyOn(app, '_triggerExitPointFallback').mockReturnValue(exitPending);
    jest.setSystemTime(START + 30 * 60000 + 26218);

    app._processAISMessage({
      mmsi: MMSI, lat: 58.2879, lon: 12.288, sog: 1.7, cog: 180, shipName: 'UTGÅENDE', timestamp: Date.now(),
    });

    await jest.advanceTimersByTimeAsync(1000);

    expect(app._triggerExitPointFallback).toHaveBeenCalledTimes(1);
    expect(observedBuffers.length).toBeGreaterThan(0);
    expect(observedBuffers[0]).toEqual([]);
  } finally {
    finishExit();
    await jest.advanceTimersByTimeAsync(1000);
    await app.onUninit();
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedMode;
    jest.useRealTimers();
  }
});
