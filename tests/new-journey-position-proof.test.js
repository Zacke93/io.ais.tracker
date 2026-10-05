'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const { BRIDGES } = require('../lib/constants');

describe('Ny resa efter målpassage kräver nya fart-, kurs- och positionsbevis', () => {
  const mmsi = '265123456';
  let app;
  let point;
  let savedTestMode;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = new AISBridgeApp();
    app.homey = {
      ...mockHomey,
      settings: {
        get: () => null, set: jest.fn(), on: jest.fn(), off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    await app.onInit();
    app._isConnected = true;
    app._lastConnectionLost = null;
    point = BRIDGES.stridsbergsbron;
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
  });

  async function update(offsetM, sog, cog, elapsedMs = 60000) {
    await jest.advanceTimersByTimeAsync(elapsedMs);
    app._processAISMessage({
      mmsi,
      shipName: 'ÅTERVÄNDAREN',
      lat: point.lat + offsetM / 111320,
      lon: point.lon,
      sog,
      cog,
      fixTs: Date.now(),
      fixFeed: 'aisstream',
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return app.vesselDataService.getVessel(mmsi);
  }

  async function completedTarget(direction = 'north') {
    point = direction === 'north' ? BRIDGES.stridsbergsbron : BRIDGES.klaffbron;
    const sign = direction === 'north' ? 1 : -1;
    for (const offset of [-300, -150, -20, 80, 160]) {
      // eslint-disable-next-line no-await-in-loop
      await update(sign * offset, 4, direction === 'north' ? 35 : 210);
    }
    const vessel = app.vesselDataService.getVessel(mmsi);
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._finalTargetDirection).toBe(direction);
    expect(vessel.passedBridges).toContain(point.name);
    expect(app._persistentRecentTriggers.has(`${mmsi}:${point.name}`)).toBe(true);
    expect(app._triggeredBoatNearKeys.has(`${mmsi}:${point.name}`)).toBe(true);
    return [...vessel.passedBridges];
  }

  function preservedJourney(vessel, passed) {
    expect(vessel._finalTargetDirection).toBe('north');
    expect(vessel._routeDirection).toBe('north');
    expect(vessel.passedBridges).toEqual(passed);
    expect(app._persistentRecentTriggers.has(`${mmsi}:${point.name}`)).toBe(true);
    expect(app._triggeredBoatNearKeys.has(`${mmsi}:${point.name}`)).toBe(true);
    expect(app.log.mock.calls.some(([line]) => String(line).includes('[NEW_JOURNEY]'))).toBe(false);
    expect(app.error).not.toHaveBeenCalled();
  }

  test('två okända farter får inte ärva marschfart och radera den nordgående resan', async () => {
    const passed = await completedTarget();
    await update(170, null, 210);
    const vessel = await update(180, null, 210);

    expect(vessel.sog).toBe(4);
    expect(vessel._rawPositionSog).toBeNull();
    expect(vessel._newJourneyPending).toBeNull();
    preservedJourney(vessel, passed);
  });

  test.each([
    ['fart', null, 210],
    ['kurs', 4, null],
  ])('en enda observerad vändning kan inte bekräftas när nästa %s saknas', async (_, sog, cog) => {
    const passed = await completedTarget();
    const first = await update(150, 4, 210);
    expect(first._newJourneyPending?.dir).toBe('south');
    const vessel = await update(140, sog, cog);
    preservedJourney(vessel, passed);

    // Två faktiskt rapporterade observationer inom fristen kan fortfarande
    // bekräfta returresan när givarna levererar igen.
    const confirmed = await update(130, 4, 210);
    expect(confirmed._finalTargetDirection).toBeNull();
    expect(confirmed._routeDirection).toBe('south');
    expect(confirmed.passedBridges).toEqual([]);
    expect(app._persistentRecentTriggers.has(`${mmsi}:${point.name}`)).toBe(false);
  });

  test('två orimliga hopp får inte bekräfta ny resa efter att första tidslåset löpt ut', async () => {
    const passed = await completedTarget();
    const first = await update(510, 4, 210, 1000);
    expect(GPSJumpAnalyzer.needsPassageConfirmation(first)).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(app.vesselDataService.hasGpsJumpHold(mmsi)).toBe(false);
    const vessel = await update(860, 4, 210, 0);
    expect(GPSJumpAnalyzer.needsPassageConfirmation(vessel)).toBe(true);
    expect(vessel._newJourneyPending).toBeNull();
    preservedJourney(vessel, passed);
  });

  test.each(['north', 'south'])('%s: två rena rapporter bekräftar riktig retur och frigör notisdedup', async (direction) => {
    await completedTarget(direction);
    const sign = direction === 'north' ? 1 : -1;
    const returnCog = direction === 'north' ? 210 : 35;
    const returnDirection = direction === 'north' ? 'south' : 'north';
    const first = await update(sign * 140, 4, returnCog);
    expect(first._newJourneyPending?.dir).toBe(returnDirection);
    expect(first._finalTargetDirection).toBe(direction);
    const second = await update(sign * 120, 4, returnCog);

    expect(second._finalTargetDirection).toBeNull();
    expect(second._newJourneyPending).toBeNull();
    expect(second._routeDirection).toBe(returnDirection);
    expect(second.passedBridges).toEqual([]);
    expect(app._persistentRecentTriggers.has(`${mmsi}:${point.name}`)).toBe(false);
    expect(app._triggeredBoatNearKeys.has(`${mmsi}:${point.name}`)).toBe(false);
    expect(app.error).not.toHaveBeenCalled();
  });
});
