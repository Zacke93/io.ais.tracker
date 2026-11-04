'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { TRIGGER_POINTS } = require('../lib/constants');

/**
 * Granskningen av fixvågen 2026-11-04: boat_near-kortets tidsgräns (60 s)
 * släpper borttagningslåset, men utfallet efter tidsgränsen måste ändå
 * observeras. Före rättningen loggades FLOW_TRIGGER_SUCCESS för ett kort som
 * aldrig svarat, och ett sent fel försvann utan spår eller rollback, så bron
 * var spärrad i två timmar för en notis som aldrig levererats.
 */
const MMSI = '265009071';
const KEY = `${MMSI}:Kanalinfarten`;
const POINT = TRIGGER_POINTS.kanalinfarten;
const TIMEOUT_MS = 60 * 1000;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

describe('boat_near efter tidsgränsen: okvitterat, sen kvittens och sent fel', () => {
  let store;
  let apps;
  let savedTestMode;

  const boot = async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => clone(store[key]),
        set: jest.fn((key, value) => {
          store[key] = clone(value);
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    apps.push(app);
    return app;
  };
  const vessel = () => ({
    mmsi: MMSI,
    name: 'SENFARAREN',
    lat: POINT.lat + 100 / 111320,
    lon: POINT.lon,
    sog: 3,
    cog: 180,
    _routeDirection: 'south',
    _hasMovementProof: true,
    passedBridges: [],
    status: 'en-route',
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aishub',
  });
  const candidate = {
    name: POINT.name, id: 'kanalinfarten', distance: 100, source: 'trigger-point',
  };
  const lines = (fn) => fn.mock.calls.map((args) => args.map(String).join(' '));
  const hangingCard = (app) => {
    const control = {};
    jest.spyOn(app._boatNearTrigger, 'trigger').mockImplementation(() => new Promise((resolve, reject) => {
      control.resolve = resolve;
      control.reject = reject;
    }));
    return control;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-04T08:00:00Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    store = {};
    apps = [];
  });

  afterEach(async () => {
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      if (!app._shuttingDown) await app.onUninit();
    }
    await jest.advanceTimersByTimeAsync(0);
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('timeout: UNCONFIRMED i stället för SUCCESS, dedupen behålls', async () => {
    const app = await boot();
    hangingCard(app);
    const call = app._triggerBoatNearFlowForBridge(vessel(), candidate);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await call;
    expect(lines(app.error).some((l) => l.includes('FLOW_TRIGGER_UNCONFIRMED'))).toBe(true);
    expect(lines(app.log).some((l) => l.includes('FLOW_TRIGGER_SUCCESS'))).toBe(false);
    expect(app._triggeredBoatNearKeys.has(KEY)).toBe(true);
    expect(app._persistentRecentTriggers.has(KEY)).toBe(true);
    expect(app._triggerPointVisits.holds(MMSI)).toBe(true);
  });

  test('sen kvittens loggas som SUCCESS late=true och tillståndet står kvar', async () => {
    const app = await boot();
    const card = hangingCard(app);
    const call = app._triggerBoatNearFlowForBridge(vessel(), candidate);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await call;
    card.resolve();
    await jest.advanceTimersByTimeAsync(0);
    const success = lines(app.log).filter((l) => l.includes('FLOW_TRIGGER_SUCCESS'));
    expect(success).toHaveLength(1);
    expect(success[0]).toMatch(/\(ID=kanalinfarten, distance=100m, status=[^)]*\) late=true$/);
    expect(app._triggeredBoatNearKeys.has(KEY)).toBe(true);
    expect(app._triggerPointVisits.holds(MMSI)).toBe(true);
  });

  test('sent fel rullar tillbaka som ett vanligt fel, så notisen kan försökas igen', async () => {
    const app = await boot();
    const card = hangingCard(app);
    const call = app._triggerBoatNearFlowForBridge(vessel(), candidate);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await call;
    card.reject(new Error('sdk fel'));
    await jest.advanceTimersByTimeAsync(0);
    const errors = lines(app.error).filter((l) => l.includes('[FLOW_TRIGGER_ERROR]'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/boat_near failed for Kanalinfarten \(ID=kanalinfarten.*sdk fel late=true$/);
    expect(app._triggeredBoatNearKeys.has(KEY)).toBe(false);
    expect(app._persistentRecentTriggers.has(KEY)).toBe(false);
    expect(app._triggerPointVisits.holds(MMSI)).toBe(false);

    app._boatNearTrigger.trigger.mockResolvedValue(undefined);
    await app._triggerBoatNearFlowForBridge(vessel(), candidate);
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(2);
    expect(lines(app.log).filter((l) => l.includes('FLOW_TRIGGER_SUCCESS'))).toHaveLength(1);
  });
});
