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

  // F5 (fältprovet 2026-11-12, k1 rad 210719/210721): Node-timern kan lösa ut
  // när väggklockan fortfarande står 1 ms före halvminuten. Den gamla
  // bokningen (30000 − now % 30000) körde då ticken på xx:59.999 och bokade
  // nästa om 1 ms, alltså samma halvminut två gånger. Fältet: 13 tidiga tick
  // på 66 h, varav ett dubbelt (03:53:59.999 och 03:54:00.001).
  // setSystemTime flyttar väggklockan utan att röra timerns återstående tid,
  // så timern löser ut när Date.now() står 1 ms före gränsen, precis som i fält.
  test('F5: en timer som löser ut 1 ms före halvminuten kör varken för tidigt eller två gånger', () => {
    const calls = [];
    start(0)._scheduleCoalescedUpdate.mockImplementation(() => calls.push(Date.now()));
    jest.advanceTimersByTime(10000);
    jest.setSystemTime(Date.now() - 1);
    jest.advanceTimersByTime(20000 + 30000 + 1000);
    expect(calls).toEqual([epoch + 30000, epoch + 60000]);
    expect(app.bridgeOpeningService.tick).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  test('F5: tidig utlösning vid varje gräns i ett halvt dygn ger exakt ett tick per halvminut', () => {
    const calls = [];
    start(2500)._scheduleCoalescedUpdate.mockImplementation(() => calls.push(Date.now()));
    for (let i = 0; i < 1440; i++) {
      // Varje varv: klockan glider 1 ms bakåt mitt i väntan (värsta fallet).
      jest.advanceTimersByTime(15000);
      jest.setSystemTime(Date.now() - 1);
      jest.advanceTimersByTime(15000);
    }
    // Alla körningar på exakta halvminutsgränser, inga dubbletter.
    expect(calls.every((t) => t % 30000 === 0)).toBe(true);
    expect(new Set(calls).size).toBe(calls.length);
    for (let i = 1; i < calls.length; i++) expect(calls[i] - calls[i - 1]).toBe(30000);
    expect(jest.getTimerCount()).toBe(1);
  });

  test('F5: en klocka som ställts bakåt inom halvminuten kör inte ticket förrän gränsen nås', () => {
    const calls = [];
    start(0)._scheduleCoalescedUpdate.mockImplementation(() => calls.push(Date.now()));
    jest.advanceTimersByTime(10000);
    jest.setSystemTime(epoch + 3000); // 7 s bakåt; timern har 20 s kvar
    jest.advanceTimersByTime(40000);
    // Före rättningen: ett tick 23 s in (utanför rutnätet) och ett till på 30 s.
    expect(calls).toEqual([epoch + 30000]);
    expect(jest.getTimerCount()).toBe(1);
  });

  test('F5/L4: en callback som kommer 2 min sent kör en gång och följer sedan rutnätet — ingen ikappkörning', () => {
    const calls = [];
    start(0)._scheduleCoalescedUpdate.mockImplementation(() => calls.push(Date.now()));
    jest.advanceTimersByTime(10000);
    // Väggklockan hoppar 2 min framåt medan timern väntar (stall/klocksteg):
    // callbacken kommer då 2 min efter sin gräns.
    jest.setSystemTime(epoch + 10000 + 120000);
    jest.advanceTimersByTime(20000 + 60000);
    expect(calls).toEqual([epoch + 150000, epoch + 180000, epoch + 210000]);
    expect(jest.getTimerCount()).toBe(1);
  });

  test('F5: en klocka som ställts bakåt mer än en halvminut låser inte ticken', () => {
    const calls = [];
    start(0)._scheduleCoalescedUpdate.mockImplementation(() => calls.push(Date.now()));
    jest.advanceTimersByTime(10000);
    jest.setSystemTime(epoch - 10 * 60 * 1000); // tio minuter bakåt
    jest.advanceTimersByTime(20000 + 60000);
    // Första gränsen efter den nya tiden, sedan varje halvminut.
    expect(calls).toEqual([epoch - 10 * 60 * 1000 + 30000, epoch - 10 * 60 * 1000 + 60000]);
    expect(jest.getTimerCount()).toBe(1);
  });
});
