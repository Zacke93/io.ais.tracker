'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGES } = require('../lib/constants');

const BRIDGE = BRIDGES.stridsbergsbron;
const OLD_MMSI = '265123456';
const NEW_MMSI = '265654321';
const FOLLOWER_MMSI = '265777888';
const oldKey = `${BRIDGE.name}|${OLD_MMSI}|northbound`;
const vessel = (mmsi, distanceM, sog = 6) => ({
  mmsi,
  name: mmsi === OLD_MMSI ? 'REDAN VARNAD' : 'NY BESOKARE',
  lat: BRIDGE.lat - distanceM / 111320,
  lon: BRIDGE.lon,
  sog,
  cog: 0,
  timestamp: Date.now(),
  lastPositionUpdate: Date.now(),
  fixTs: Date.now(),
  targetBridge: BRIDGE.name,
  _routeDirection: 'north',
  _hasMovementProof: true,
  _plausibleMovementSeen: true,
  passedAt: {},
  passedBridges: [],
});
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('Ett undertryckt öppningskort kan inte varna bort nya konvojbåtar', () => {
  let app;
  let store;
  let savedTestMode;
  let savedNodeEnv;
  let coverage;

  const run = (callback) => {
    const savedEnv = process.env.NODE_ENV;
    const savedMode = global.__TEST_MODE__;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = false;
    try {
      callback();
    } finally {
      process.env.NODE_ENV = savedEnv;
      global.__TEST_MODE__ = savedMode;
    }
  };
  const observe = (mmsi, distanceM, sog) => run(() => app.bridgeOpeningService.observeVessel(vessel(mmsi, distanceM, sog)));
  const later = (milliseconds) => jest.setSystemTime(Date.now() + milliseconds);
  const armFor = (mmsi) => app.bridgeOpeningService._arms.get(`${mmsi}::${BRIDGE.name}`);
  const cards = () => app._bridgeOpeningTrigger.trigger.mock.calls
    .filter(([tokens]) => tokens.bridge_name === BRIDGE.name);

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-08T10:00:00Z'));
    savedTestMode = global.__TEST_MODE__;
    savedNodeEnv = process.env.NODE_ENV;
    global.__TEST_MODE__ = true;
    store = {
      persistent_opening_warnings: {
        [oldKey]: { arrivalActive: true, firedAt: Date.now() - 60000 },
      },
    };
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => (store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key]))),
        set: jest.fn((key, value) => {
          store[key] = JSON.parse(JSON.stringify(value));
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    jest.spyOn(app._bridgeOpeningTrigger, 'trigger');
    coverage = [];
    const originalCoverage = app._onBridgeOpeningCoverage.bind(app);
    jest.spyOn(app, '_onBridgeOpeningCoverage').mockImplementation((entry) => {
      coverage.push(entry);
      originalCoverage(entry);
    });
    // Appstarten är nätverksfri; därefter måste även ett sent felkvitto
    // få använda den riktiga Flow-vägen genom hela testet.
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = false;
  });

  afterEach(async () => {
    await app.onUninit();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedTestMode;
    process.env.NODE_ENV = savedNodeEnv;
    jest.useRealTimers();
  });

  test('tidigare varnad båt efter omstart ger ingen dubbelnotis men en nytillkommen båt får sitt kort', async () => {
    observe(OLD_MMSI, 700);
    await flush();
    expect(cards()).toHaveLength(0);
    const oldEventId = armFor(OLD_MMSI).eventId;
    expect(armFor(OLD_MMSI).warnedAt).not.toBeNull();

    later(60000);
    observe(NEW_MMSI, 900);
    await flush();

    expect(cards()).toHaveLength(1);
    expect(cards()[0][1].mmsis).toEqual([NEW_MMSI]);
    expect(armFor(NEW_MMSI).eventId).not.toBe(oldEventId);
    expect(coverage.some((entry) => entry.mmsi === NEW_MMSI && entry.reason === 'absorbed')).toBe(false);
    expect(app._persistentOpeningWarnings.get(oldKey).firedAt).toBe(store.persistent_opening_warnings[oldKey].firedAt);
    later(60000);
    observe(OLD_MMSI, 600);
    run(() => app.bridgeOpeningService.tick());
    await flush();
    expect(cards()).toHaveLength(1);
  });

  test('en riktig levererad varning fortsätter täcka senare båtar i samma konvoj', async () => {
    observe(OLD_MMSI, 700);
    later(60000);
    observe(NEW_MMSI, 900);
    await flush();
    const deliveredEventId = armFor(NEW_MMSI).eventId;

    later(60000);
    observe(FOLLOWER_MMSI, 900);
    await flush();

    expect(cards()).toHaveLength(1);
    expect(cards()[0][1].mmsis).toEqual([NEW_MMSI]);
    expect(armFor(FOLLOWER_MMSI).eventId).toBe(deliveredEventId);
    expect(coverage.some((entry) => entry.mmsi === FOLLOWER_MMSI
      && entry.reason === 'absorbed' && entry.eventId === deliveredEventId)).toBe(true);
  });

  test('även den alternativa breda konvojtäckningen utesluter en undertryckt värd', async () => {
    app.bridgeOpeningService.config.U9_RESCUE_COVERAGE = true;
    observe(OLD_MMSI, 700);
    const oldEventId = armFor(OLD_MMSI).eventId;
    later(60000);
    observe(NEW_MMSI, 2400, 2);
    const newArm = armFor(NEW_MMSI);

    expect(newArm.eventId).not.toBe(oldEventId);
    expect(newArm.warnedAt).toBeNull();
    expect(newArm.absorbedAt).toBeNull();
    jest.setSystemTime(Math.ceil(newArm.fireDueMs));
    run(() => app.bridgeOpeningService.tick());
    await flush();
    expect(cards()).toHaveLength(1);
    expect(cards()[0][1].mmsis).toEqual([NEW_MMSI]);
  });

  test('ett uttryckligt leveransfel kan inte absorbera en båt som anländer senare', async () => {
    app._persistentOpeningWarnings.delete(oldKey);
    app._bridgeOpeningTrigger.trigger.mockRejectedValueOnce(new Error('Homey nekade leveransen'));
    observe(OLD_MMSI, 700);
    await flush();
    expect(cards()).toHaveLength(1);
    // Det misslyckade ursprungskortet får inga automatiska extra försök.
    later(30000);
    run(() => app.bridgeOpeningService.tick());
    await flush();
    expect(cards()).toHaveLength(1);

    later(30000);
    observe(NEW_MMSI, 900);
    await flush();
    expect(cards()).toHaveLength(2);
    expect(cards()[1][1].mmsis).toEqual([NEW_MMSI]);
    expect(armFor(NEW_MMSI).absorbedAt).toBeNull();
  });

  test('en båt som absorberats under pågående SDK-anrop frigörs om kortet sedan nekas', async () => {
    app._persistentOpeningWarnings.delete(oldKey);
    let reject;
    const pending = new Promise((resolve, fail) => {
      reject = fail;
    });
    app._bridgeOpeningTrigger.trigger.mockImplementationOnce(() => pending);
    observe(OLD_MMSI, 700);
    later(60000);
    observe(NEW_MMSI, 900);
    expect(cards()).toHaveLength(1);
    expect(armFor(NEW_MMSI).absorbedAt).not.toBeNull();

    reject(new Error('Den reserverade leveransen nekades'));
    await flush();
    expect(cards()).toHaveLength(2);
    expect(cards()[1][1].mmsis).toEqual([NEW_MMSI]);
    expect(armFor(NEW_MMSI).absorbedAt).toBeNull();
    expect(armFor(OLD_MMSI).warnedAt).not.toBeNull();
    later(60000);
    run(() => app.bridgeOpeningService.tick());
    await flush();
    expect(cards()).toHaveLength(2);
  });

  test('en absorberad båt som redan passerat får ingen sen varning när SDK-anropet nekas', async () => {
    app._persistentOpeningWarnings.delete(oldKey);
    let reject;
    const pending = new Promise((resolve, fail) => {
      reject = fail;
    });
    app._bridgeOpeningTrigger.trigger.mockImplementationOnce(() => pending);
    observe(OLD_MMSI, 700);
    later(60000);
    observe(NEW_MMSI, 900);
    run(() => app.bridgeOpeningService.notePassage(NEW_MMSI, BRIDGE.name));

    reject(new Error('Sent leveransfel efter passage'));
    await flush();
    expect(cards()).toHaveLength(1);
    expect(armFor(NEW_MMSI)).toBeUndefined();
  });

  test('en tidigare inbunden men fryst båt får sin första varning när hennes färska målbro återkommer', async () => {
    observe(NEW_MMSI, 1800);
    observe(OLD_MMSI, 1800);
    expect(armFor(NEW_MMSI).eventId).toBe(armFor(OLD_MMSI).eventId);
    later(60000);
    run(() => app.bridgeOpeningService.observeVessel({
      ...vessel(NEW_MMSI, 1700),
      targetBridge: null,
    }));
    later(1000);
    observe(OLD_MMSI, 900);
    await flush();
    expect(cards()).toHaveLength(0);
    expect(armFor(NEW_MMSI).warnedAt).toBeNull();

    later(1000);
    observe(NEW_MMSI, 800);
    await flush();
    expect(cards()).toHaveLength(1);
    expect(cards()[0][1].mmsis).toEqual([NEW_MMSI]);
  });

  test('ett saknat Flow-kort vid första händelsen kan inte tysta nya båtar när kortet fungerar igen', async () => {
    app._persistentOpeningWarnings.delete(oldKey);
    const trigger = app._bridgeOpeningTrigger;
    app._bridgeOpeningTrigger = null;
    observe(OLD_MMSI, 700);
    app._bridgeOpeningTrigger = trigger;
    later(60000);
    observe(NEW_MMSI, 900);
    await flush();

    expect(cards()).toHaveLength(1);
    expect(cards()[0][1].mmsis).toEqual([NEW_MMSI]);
  });

  test('ett synkront kast från leveranscallbacken räknas inte som en konvojvarning', async () => {
    app._persistentOpeningWarnings.delete(oldKey);
    const originalCallback = app.bridgeOpeningService._onWarning;
    app.bridgeOpeningService._onWarning = jest.fn(() => {
      throw new Error('Callbacken kastade före leveransen');
    });
    observe(OLD_MMSI, 700);
    app.bridgeOpeningService._onWarning = originalCallback;
    later(60000);
    observe(NEW_MMSI, 900);
    await flush();

    expect(cards()).toHaveLength(1);
    expect(cards()[0][1].mmsis).toEqual([NEW_MMSI]);
  });
});
