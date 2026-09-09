'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGES } = require('../lib/constants');

const BRIDGE = BRIDGES.stridsbergsbron;
const OLD = '265000111';
const NEW = '265000222';
const OTHER = '265000333';
const key = (mmsi, direction = 'northbound') => `${BRIDGE.name}|${mmsi}|${direction}`;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

const arm = (mmsi, overrides = {}) => ({
  mmsi,
  name: mmsi === OLD ? 'GAMLA LEDAREN' : 'NYA BATEN',
  bridge: BRIDGE.name,
  distanceM: mmsi === OLD ? 400 : 1000,
  rawAnchorMs: Date.now() - 10000,
  expectedArrivalMs: Date.now() + (mmsi === OLD ? 3 : 9) * 60000,
  waitingAtBridge: null,
  routeDirection: 'north',
  armDirection: 'north',
  cog: 0,
  sog: 4,
  warnedAt: null,
  fireDueMs: Date.now() - 25,
  originalDueMs: Date.now() - 12345,
  eligibleAt: Date.now() - 30000,
  ...overrides,
});

describe('Blandat öppningskort beskriver bara nya ankomster', () => {
  let app;
  let store;
  let savedMode;
  let savedEnv;
  let events;
  let coverage;

  const boot = async () => {
    global.__TEST_MODE__ = true;
    process.env.NODE_ENV = 'test';
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (name) => clone(store[name]),
        set: jest.fn((name, value) => {
          store[name] = clone(value);
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    jest.spyOn(app._bridgeOpeningTrigger, 'trigger');
    coverage = [];
    app.bridgeOpeningService._onCoverage = (entry) => coverage.push(entry);
    global.__TEST_MODE__ = false;
    process.env.NODE_ENV = 'production';
  };
  const fire = (members, due = members) => {
    const event = { id: `${BRIDGE.name}#${++events}`, bridge: BRIDGE.name, firedAt: null };
    app.bridgeOpeningService._fire(event, members, due, 'fix', Date.now());
    return event;
  };
  const calls = () => app._bridgeOpeningTrigger.trigger.mock.calls;
  const alreadyWarned = async () => {
    fire([arm(OLD)]);
    await flush();
    return app._persistentOpeningWarnings.get(key(OLD));
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-09T10:00:00Z'));
    savedMode = global.__TEST_MODE__;
    savedEnv = process.env.NODE_ENV;
    store = {};
    events = 0;
    await boot();
  });

  afterEach(async () => {
    await app.onUninit();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedMode;
    process.env.NODE_ENV = savedEnv;
    jest.useRealTimers();
  });

  test('ny medlem får egen ledare, ETA och antal även när endast gamla armen är förfallen', async () => {
    const previous = await alreadyWarned();
    const oldArm = arm(OLD);
    const newArm = arm(NEW, { fireDueMs: Date.now() + 60000 });
    const event = fire([oldArm, newArm], [oldArm]);
    await flush();

    expect(calls()).toHaveLength(2);
    expect(calls()[1][0]).toEqual({
      bridge_name: BRIDGE.name,
      vessel_name: 'NYA BATEN',
      direction: 'norrut',
      eta_minutes: 9,
      vessel_count: 1,
    });
    expect(calls()[1][1]).toMatchObject({
      mmsi: NEW,
      mmsis: [NEW],
      distance: 1000,
      fixAgeMs: 10000,
      dueMs: oldArm.fireDueMs,
      originalDueMs: oldArm.originalDueMs,
    });
    expect(event.referenceArrivalMs).toBe(oldArm.expectedArrivalMs);
    expect(event.firedAt).toBe(Date.now());
    expect(oldArm.warnedAt).toBe(Date.now());
    expect(newArm.warnedAt).toBe(Date.now());
    expect(coverage.filter((c) => c.eventId === event.id).map((c) => c.mmsi)).toEqual([OLD, NEW]);
    expect(app._persistentOpeningWarnings.get(key(OLD))).toBe(previous);
    expect(app._persistentOpeningWarnings.has(key(NEW))).toBe(true);
  });

  test.each([
    ['bekräftad väntan', { waitingAtBridge: 'Järnvägsbron' }, -1],
    ['gammalt råfix', { rawAnchorMs: () => Date.now() - 601000 }, -1],
    ['saknat råfix', { rawAnchorMs: null }, -1],
    ['förbrukad gammal prognos', {
      rawAnchorMs: () => Date.now() - 570000, expectedArrivalMs: () => Date.now() - 1000,
    }, -1],
    ['färsk nolla', { expectedArrivalMs: () => Date.now() }, 0],
    ['gammalt men ännu positivt estimat', { rawAnchorMs: () => Date.now() - 570000 }, 9],
  ])('%s bedöms för den nya ledaren', async (label, values, expectedEta) => {
    await alreadyWarned();
    const overrides = {};
    for (const [name, value] of Object.entries(values)) {
      overrides[name] = typeof value === 'function' ? value() : value;
    }
    fire([arm(OLD), arm(NEW, overrides)]);
    await flush();
    expect(calls()[1][0].eta_minutes).toBe(expectedEta);
    expect(calls()[1][0].vessel_name).toBe('NYA BATEN');
  });

  test.each(['north', 'south'])('gammal motsatt ledare ändrar inte nya gruppens %s-riktning', async (newDirection) => {
    const oldDirection = newDirection === 'north' ? 'south' : 'north';
    fire([arm(OLD, { routeDirection: oldDirection, armDirection: oldDirection })]);
    const first = app._persistentOpeningWarnings.get(key(OLD, `${oldDirection}bound`));
    fire([
      arm(OLD, { routeDirection: oldDirection, armDirection: oldDirection }),
      arm(NEW, { routeDirection: newDirection, armDirection: newDirection }),
    ]);
    await flush();
    expect(calls()[1][0].direction).toBe(newDirection === 'north' ? 'norrut' : 'söderut');
    expect(calls()[1][1].mmsis).toEqual([NEW]);
    expect(app._persistentOpeningWarnings.get(key(OLD, `${oldDirection}bound`))).toBe(first);
    expect(app._persistentOpeningWarnings.has(key(NEW, `${newDirection}bound`))).toBe(true);
  });

  test('två nya mötande båtar behåller båda-riktning och närmaste nya ledare', async () => {
    await alreadyWarned();
    fire([
      arm(OLD), arm(NEW, { distanceM: 1500 }),
      arm(OTHER, {
        name: 'MOTAREN', distanceM: 800, routeDirection: 'south', armDirection: 'south',
      }),
    ]);
    await flush();
    expect(calls()[1][0]).toMatchObject({ vessel_count: 2, vessel_name: 'MOTAREN', direction: 'båda' });
    expect(calls()[1][1]).toMatchObject({ mmsi: OTHER, mmsis: [NEW, OTHER], distance: 800 });
  });

  test('utan filtrering är hela ursprungliga payloaden oförändrad', async () => {
    const now = Date.now();
    let captured;
    const original = app._onBridgeOpeningWarning.bind(app);
    app._onBridgeOpeningWarning = (payload) => {
      captured = payload; return original(payload);
    };
    const selector = jest.spyOn(app.bridgeOpeningService, 'selectWarningMembers');
    fire([arm(OLD), arm(NEW)]);
    await flush();
    expect(selector).not.toHaveBeenCalled();
    expect(captured).toEqual({
      t: now,
      eventId: `${BRIDGE.name}#1`,
      bridge: BRIDGE.name,
      direction: 'northbound',
      eventDirection: 'northbound',
      memberDirections: { [OLD]: 'northbound', [NEW]: 'northbound' },
      etaMinutes: 3,
      vesselCount: 2,
      leadVessel: 'GAMLA LEDAREN',
      leadMmsi: OLD,
      firedBy: 'fix',
      mmsis: [OLD, NEW],
      distanceM: 400,
      dueMs: now - 25,
      originalDueMs: now - 12345,
      expectedArrivalMs: now + 9 * 60000,
      fixAgeMs: 10000,
    });
    expect(calls()[0][1].mmsis).toEqual([OLD, NEW]);
  });

  test('en fryst kopia skyddar ledarval, riktning, väntan och ETA från senare armmutationer', async () => {
    await alreadyWarned();
    const newer = arm(NEW);
    const original = app._onBridgeOpeningWarning.bind(app);
    app._onBridgeOpeningWarning = (payload) => {
      const frame = app.bridgeOpeningService._warningSnapshots.get(payload);
      expect(Object.isFrozen(frame)).toBe(true);
      expect(Object.isFrozen(frame.members)).toBe(true);
      expect(frame.members.every(Object.isFrozen)).toBe(true);
      expect(frame.members).not.toContain(newer);
      Object.assign(newer, {
        name: 'SENARE NAMN',
        distanceM: 1,
        expectedArrivalMs: Date.now(),
        rawAnchorMs: null,
        routeDirection: 'south',
        armDirection: 'south',
        waitingAtBridge: 'Klaffbron',
      });
      return original(payload);
    };
    fire([arm(OLD), newer]);
    await flush();
    expect(calls()[1][0]).toMatchObject({ vessel_name: 'NYA BATEN', direction: 'norrut', eta_minutes: 9 });
    expect(calls()[1][1]).toMatchObject({ distance: 1000, fixAgeMs: 10000 });
  });

  test('äldre payload utan medlemsunderlag visar cache-namn och okända mätvärden för ny båt', async () => {
    await alreadyWarned();
    app._knownVesselNames.set(NEW, { name: 'NAMNCACHEN', t: Date.now() });
    app._onBridgeOpeningWarning({
      eventId: 'legacy#2',
      bridge: BRIDGE.name,
      direction: 'northbound',
      eventDirection: 'mixed',
      memberDirections: { [OLD]: 'northbound', [NEW]: 'southbound' },
      mmsis: [OLD, NEW],
      leadMmsi: OLD,
      leadVessel: 'GAMLA LEDAREN',
      etaMinutes: 3,
      distanceM: 400,
      fixAgeMs: 10000,
      vesselCount: 2,
    });
    await flush();
    expect(calls()[1][0]).toMatchObject({
      vessel_name: 'NAMNCACHEN', vessel_count: 1, eta_minutes: -1, direction: 'söderut',
    });
    expect(calls()[1][1]).toMatchObject({
      mmsi: NEW, mmsis: [NEW], distance: null, fixAgeMs: null,
    });
  });

  test('okänd medlemsriktning behåller ursprunglig dedupnyckel efter ledarbyte', async () => {
    await alreadyWarned();
    fire([
      arm(OLD), arm(NEW, { routeDirection: 'south', armDirection: 'south' }),
      arm(OTHER, { routeDirection: null, armDirection: null, cog: null }),
    ]);
    await flush();
    expect(calls()[1][0].direction).toBe('söderut');
    expect(app._persistentOpeningWarnings.has(key(OTHER, 'northbound'))).toBe(true);
    expect(app._persistentOpeningWarnings.has(key(OTHER, 'southbound'))).toBe(false);
    const count = calls().length;
    fire([arm(OLD), arm(OTHER, { routeDirection: null, armDirection: null, cog: null })]);
    await flush();
    expect(calls()).toHaveLength(count);
  });

  test.each(['kast', 'reject'])('nekad partialleverans via %s återställer bara nya reservationen', async (mode) => {
    const previous = await alreadyWarned();
    app._bridgeOpeningTrigger.trigger.mockImplementationOnce(() => {
      if (mode === 'kast') throw new Error('SDK nekade');
      return Promise.reject(new Error('SDK nekade'));
    });
    fire([arm(OLD), arm(NEW)]);
    await flush();
    expect(calls()[1][1].mmsis).toEqual([NEW]);
    expect(app._persistentOpeningWarnings.get(key(OLD))).toBe(previous);
    expect(app._persistentOpeningWarnings.has(key(NEW))).toBe(false);
    expect(store.persistent_opening_warnings[key(OLD)]).toEqual(previous);
    expect(store.persistent_opening_warnings[key(NEW)]).toBeUndefined();
  });

  test('reserverad ny medlem återupprepas inte under await eller efter omstart', async () => {
    await alreadyWarned();
    let resolve;
    app._bridgeOpeningTrigger.trigger.mockImplementationOnce(() => new Promise((done) => {
      resolve = done;
    }));
    fire([arm(OLD), arm(NEW)]);
    fire([arm(OLD), arm(NEW)]);
    expect(calls()).toHaveLength(2);
    resolve();
    await flush();
    await app.onUninit();
    await boot();
    fire([arm(OLD), arm(NEW)]);
    expect(calls()).toHaveLength(0);
    // Samma event-id kan inte ge ett andra försök i samma livscykel.
    const event = fire([arm(OTHER)]);
    app._onBridgeOpeningWarning({ eventId: event.id, bridge: BRIDGE.name, mmsis: ['265000444'] });
    await flush();
    expect(calls()).toHaveLength(1);
  });

  test('passage eller två rena utfärdsfixar släpper samma båt för ett nytt besök', async () => {
    await alreadyWarned();
    const fix = (distanceM, t) => ({
      mmsi: OLD,
      lat: BRIDGE.lat - distanceM / 111320,
      lon: BRIDGE.lon,
      sog: 4,
      fixTs: t,
      timestamp: t,
      lastPositionUpdate: t,
    });
    app._observeOpeningArrivals(fix(400, Date.now() + 1));
    app._observeOpeningArrivals(fix(900, Date.now() + 2));
    app._observeOpeningArrivals(fix(950, Date.now() + 3));
    expect(app._persistentOpeningWarnings.has(key(OLD))).toBe(false);
    fire([arm(OLD), arm(NEW)]);
    await flush();
    expect(calls()[1][1].mmsis).toEqual([OLD, NEW]);
    app._consumeOpeningDedupForPassage(NEW, BRIDGE.name);
    fire([arm(OLD), arm(NEW)]);
    await flush();
    expect(calls()[2][1].mmsis).toEqual([NEW]);
  });
});
