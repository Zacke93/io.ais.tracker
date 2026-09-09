'use strict';

const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES, UI_CONSTANTS } = require('../lib/constants');

const START = Date.parse('2026-09-08T08:00:07.123Z');
const SOFT = UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS;
const LEADER = '265111111';
const FOLLOWER = '265662320';

describe('Förbrukad öppningsprognos under AIS-tystnad', () => {
  let service;
  let warning;
  const boat = (mmsi, distance, etaMinutes, extra = {}) => ({
    mmsi,
    name: mmsi === FOLLOWER ? 'JEANNELLE' : 'LEDAREN',
    targetBridge: 'Klaffbron',
    _routeDirection: 'north',
    _hasMovementProof: true,
    lat: BRIDGES.klaffbron.lat - distance / 111320,
    lon: BRIDGES.klaffbron.lon,
    sog: 6.1,
    cog: 0,
    etaMinutes,
    timestamp: Date.now(),
    fixTs: Date.now(),
    lastPositionUpdate: Date.now(),
    ...extra,
  });
  const advanceTo = (t) => jest.advanceTimersByTime(t - Date.now());

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    warning = jest.fn();
    service = new Service({
      scheduleDeadlines: true,
      onWarning: warning,
      targetBridges: ['Klaffbron'],
    });
  });

  afterEach(() => {
    service.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  test('JEANNELLE: konvojsläpp efter 575 s tystnad ger okänd ETA på 703 m, utan flyttad varning', () => {
    service.observeVessel(boat(LEADER, 800, 5));
    advanceTo(START + 1000);
    service.observeVessel(boat(FOLLOWER, 1400, 13));
    const arm = service._arms.get(`${FOLLOWER}::Klaffbron`);
    expect(arm.absorbedAt).toBe(Date.now());
    advanceTo(START + 60000);
    service.notePassage(LEADER, 'Klaffbron');
    const due = Math.floor(arm.coverUntilMs) + 1;
    advanceTo(due - 575426);
    service.observeVessel(boat(FOLLOWER, 703.417, 5.987432664708283));
    const forecast = arm.expectedArrivalMs;
    expect(warning).toHaveBeenCalledTimes(1);

    advanceTo(due);

    expect(warning).toHaveBeenCalledTimes(2);
    const payload = warning.mock.calls[1][0];
    expect(payload).toMatchObject({
      leadMmsi: FOLLOWER,
      mmsis: [FOLLOWER],
      vesselCount: 1,
      t: due,
      dueMs: due,
      firedBy: 'deadline',
      fixAgeMs: 575426,
      etaMinutes: null,
      expectedArrivalMs: forecast,
    });
    expect(payload.distanceM).toBeGreaterThanOrEqual(700);
    expect(payload.distanceM).toBeLessThanOrEqual(704);
    expect(due - forecast).toBeGreaterThan(3 * 60000);
    expect(arm.expectedArrivalMs).toBe(forecast);
    const event = service._events.get('Klaffbron').find((e) => e.id === payload.eventId);
    expect(event.referenceArrivalMs).toBe(forecast);
  });

  test.each([
    ['färsk verklig transit nära bron', 45, 0.15, 0, 0],
    ['aktuell noll-ETA', 300, 0, 0, 0],
    ['färsk transit med kort AIS-leveranslagg', 45, 0.15, 15000, 0],
    ['avrundad nolla före prognosens slut', 703, 6, SOFT + 45000, 0],
    ['ännu positiv nedräkning från äldre fix', 1400, 12, SOFT + 60000, 6],
    ['mjukgränsens sista millisekund', 703, 2, SOFT, 0],
    ['förbrukad prognos över mjukgränsen', 703, 2, SOFT + 1, null],
  ])('%s behåller rätt ETA-semantik', (_label, distance, eta, age, expected) => {
    service.observeVessel(boat(FOLLOWER, distance, eta, { fixTs: START - age }));

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toMatchObject({ etaMinutes: expected, fixAgeMs: age });
  });

  test('stillastående kö får inga nya minuter ur en förbrukad lagrad prognos', () => {
    service.observeVessel(boat(FOLLOWER, 300, 2, {
      sog: 0, fixTs: START - SOFT - 60000, _stationarySince: START - SOFT - 60000,
    }));

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0].etaMinutes).toBeNull();
    expect(warning.mock.calls[0][0].expectedArrivalMs).toBeLessThan(START);
  });
});
