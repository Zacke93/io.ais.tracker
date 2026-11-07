'use strict';

const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES } = require('../lib/constants');

const START = Date.parse('2026-09-08T08:00:07.123Z');
const LEADER = '265111111';
const FOLLOWER = '265222222';

describe('Konvojtäckning upphör vid sin egen deadline', () => {
  let service;
  let warning;
  let watchdog;

  const boat = (mmsi, distance, etaMinutes) => ({
    mmsi,
    name: mmsi === LEADER ? 'LEDAREN' : 'EFTERFOLJAREN',
    targetBridge: 'Klaffbron',
    _routeDirection: 'north',
    _hasMovementProof: true,
    lat: BRIDGES.klaffbron.lat - distance / 111320,
    lon: BRIDGES.klaffbron.lon,
    sog: 3,
    cog: 0,
    etaMinutes,
    timestamp: Date.now(),
    fixTs: Date.now(),
    lastPositionUpdate: Date.now(),
  });
  const followerArm = () => service._arms.get(`${FOLLOWER}::Klaffbron`);
  const advanceTo = (time) => jest.advanceTimersByTime(time - Date.now());

  // Riktig absorption och riktig passage förkortar täckningen från
  // prognosens 15 minuter till den faktiska passagens 11 minuter.
  //
  // K-familjen (2026-11-04): följarens färska fix efter passagen avgör nu
  // OM täckningen gäller. Ligger hennes nya prognos INOM täckningen hör hon
  // fortfarande till öppningen och prövas först vid täckningsslutet (de här
  // testerna). Ligger den BORTOM — LA FEMME-fixet nedan, 14,51 min kvar när
  // täckningen har 2 min kvar — är hon nästa öppning och släpps redan på
  // fixet (bakkanten, sista testet).
  const prepareRebasedCoverage = ({ distance = 300, etaMinutes = 1.5 } = {}) => {
    service.observeVessel(boat(LEADER, 800, 5));
    expect(warning).toHaveBeenCalledTimes(1);
    advanceTo(START + 1000);
    service.observeVessel(boat(FOLLOWER, 1400, 13));
    expect(followerArm().absorbedAt).toBe(Date.now());
    const predictedExpiry = followerArm().coverUntilMs;
    advanceTo(START + 60000);
    service.notePassage(LEADER, 'Klaffbron');
    const expiry = followerArm().coverUntilMs;
    expect(expiry).toBeLessThan(predictedExpiry);
    // Senare färsk position med prognos inom täckningen (standard), eller
    // LA FEMME-prognosen bortom den (anroparens val).
    advanceTo(START + 9 * 60000);
    service.observeVessel(boat(FOLLOWER, distance, etaMinutes));
    expect(followerArm().fireDueMs).toBeLessThan(expiry);
    return expiry;
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    warning = jest.fn();
    watchdog = null;
    service = new Service({
      scheduleDeadlines: true,
      onWarning: warning,
      targetBridges: ['Klaffbron'],
    });
  });

  afterEach(() => {
    if (watchdog) clearInterval(watchdog);
    service.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  test.each([0, 2500, 11520, 15000])('watchdogfas %s ms ändrar varken avfyrningstid, ETA eller källa', (phase) => {
    jest.setSystemTime(START - phase);
    watchdog = setInterval(() => service.tick(), 30000);
    advanceTo(START);
    const expiry = prepareRebasedCoverage();
    expect(warning).toHaveBeenCalledTimes(1);

    advanceTo(Math.floor(expiry));
    expect(warning).toHaveBeenCalledTimes(1);
    advanceTo(Math.floor(expiry) + 1);

    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0]).toMatchObject({
      leadMmsi: FOLLOWER,
      etaMinutes: 0,
      firedBy: 'deadline',
      t: Math.floor(expiry) + 1,
    });
    advanceTo(expiry + 90000);
    expect(warning).toHaveBeenCalledTimes(2);
  });

  test.each([0, 2500, 11520, 15000])('bakkanten: watchdogfas %s ms — prognos bortom täckningen släpps på fixet', (phase) => {
    jest.setSystemTime(START - phase);
    watchdog = setInterval(() => service.tick(), 30000);
    advanceTo(START);
    const expiry = prepareRebasedCoverage({ distance: 1332, etaMinutes: 14.51 });

    // LA FEMME-fixet: 14,51 min kvar när täckningen har 2 min kvar. Hon är
    // nästa öppning (U2): täckningen släpps redan på fixet, och hon varnas på
    // sin EGEN deadline ur samma fix (KRAV 4) — före täckningsslutet, inte på
    // den gamla öppningens klocka, och oberoende av watchdogens fas.
    const arm = followerArm();
    expect(arm.absorbedAt).toBeNull();
    expect(arm.warnedAt).toBeNull();
    const due = Math.ceil(arm.fireDueMs);
    expect(due).toBeGreaterThan(Date.now());
    expect(due).toBeLessThan(expiry);
    advanceTo(due - 1);
    expect(warning).toHaveBeenCalledTimes(1);
    advanceTo(due);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0]).toMatchObject({
      leadMmsi: FOLLOWER,
      etaMinutes: 13,
      firedBy: 'deadline',
      t: due,
    });
    advanceTo(expiry + 90000);
    expect(warning).toHaveBeenCalledTimes(2);
  });

  test('tystnad och borttagning kräver inget nytt fix för att pröva den otäckta båten', () => {
    const expiry = prepareRebasedCoverage();
    service.removeVessel(FOLLOWER, 'timeout');

    advanceTo(Math.floor(expiry) + 1);

    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0].leadMmsi).toBe(FOLLOWER);
  });

  test('egen passage före täckningens slut avbokar prövningen och ger ingen sen varning', () => {
    const expiry = prepareRebasedCoverage();
    advanceTo(expiry - 1000);
    service.notePassage(FOLLOWER, 'Klaffbron');

    advanceTo(expiry + 60000);

    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('färskt motstridigt fix får inte bli en ny öppning enbart för att täckningen löper ut', () => {
    const expiry = prepareRebasedCoverage();
    advanceTo(expiry - 1000);
    service.observeVessel({ ...boat(FOLLOWER, 1332, 13), targetBridge: null });

    advanceTo(expiry + 1000);
    expect(warning).toHaveBeenCalledTimes(1);

    service.observeVessel(boat(FOLLOWER, 700, 4));
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0].leadMmsi).toBe(FOLLOWER);
  });

  test('destroy avbokar även en väntande konvojrelease', () => {
    const expiry = prepareRebasedCoverage();
    service.destroy();

    advanceTo(expiry + 60000);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
