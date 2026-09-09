'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

describe('Brotextens periodiska kontroll är oberoende av appens starttid', () => {
  const epoch = Date.parse('2026-09-08T10:00:00Z');
  let app;

  function start(offset) {
    jest.setSystemTime(epoch + offset);
    app = new AISBridgeApp();
    app._runtimeLifecycle = {};
    app._shuttingDown = false;
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.vesselDataService = { getAllVessels: () => [{ mmsi: '901009100' }] };
    app.bridgeOpeningService = { tick: jest.fn() };
    app._scheduleCoalescedUpdate = jest.fn();
    app._initializeCoalescingSystem();
    return app;
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test.each([0, 2500, 5000, 11520, 15000, 20000, 25000, 29999])(
    'start %i ms efter hel minut ger kontroller på samma tre klockslag',
    (offset) => {
      const calls = [];
      start(offset)._scheduleCoalescedUpdate.mockImplementation(() => calls.push(Date.now()));
      jest.advanceTimersByTime(90000 - offset);
      expect(calls).toEqual([epoch + 30000, epoch + 60000, epoch + 90000]);
      expect(app.bridgeOpeningService.tick).toHaveBeenCalledTimes(3);
      expect(jest.getTimerCount()).toBe(1);
    },
  );

  test('ominitiering lämnar bara en kontrolltimer', () => {
    start(2500);
    jest.advanceTimersByTime(5000);
    app._initializeCoalescingSystem();
    jest.advanceTimersByTime(52500);
    expect(app._scheduleCoalescedUpdate).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  test('en avslutad livscykel varken uppdaterar eller bokar en ny timer', () => {
    start(2500);
    app._runtimeLifecycle = {};
    jest.advanceTimersByTime(90000);
    expect(app._scheduleCoalescedUpdate).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('shutdown under själva kontrollen stoppar nästa bokning', () => {
    start(2500)._scheduleCoalescedUpdate.mockImplementation(() => {
      app._shuttingDown = true;
    });
    jest.advanceTimersByTime(90000);
    expect(app._scheduleCoalescedUpdate).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ett kastande öppningssvep stoppar inte textuppdateringen eller nästa kontroll', () => {
    start(2500).bridgeOpeningService.tick.mockImplementation(() => {
      throw new Error('tillfälligt tjänstefel');
    });
    jest.advanceTimersByTime(57500);
    expect(app._scheduleCoalescedUpdate).toHaveBeenCalledTimes(2);
    expect(app.error).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  test('en justerad systemklocka återgår till fasta klockslag utan ikappkörning', () => {
    const calls = [];
    start(0)._scheduleCoalescedUpdate.mockImplementation(() => calls.push(Date.now()));
    jest.advanceTimersByTime(10000);
    jest.setSystemTime(epoch + 17000);
    jest.advanceTimersByTime(50000);
    expect(calls).toEqual([epoch + 37000, epoch + 60000]);
    expect(jest.getTimerCount()).toBe(1);
  });
});
