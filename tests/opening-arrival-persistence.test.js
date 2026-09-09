'use strict';

jest.mock('homey');
const { __mockHomey: homey } = require('homey');
const App = require('../app');
const { BRIDGES } = require('../lib/constants');

// Ersätter J15/J15b/S13:s utgångstidskontrakt enligt användarbeslutet
// 2026-09-08. Bevarar uppgraderingsprov och verklig boot/persistens/Flow-väg.
describe('En öppningsvarning per faktisk ankomst, även över AIS-tystnad och omstart', () => {
  let app;
  let now;
  const key = 'Klaffbron|258177180|northbound';
  const payload = (extra = {}) => ({
    eventId: 'Klaffbron#1',
    bridge: 'Klaffbron',
    direction: 'northbound',
    etaMinutes: 15,
    vesselCount: 1,
    leadVessel: 'HERA II',
    leadMmsi: '258177180',
    mmsis: ['258177180'],
    firedBy: 'fix',
    ...extra,
  });
  async function boot(keep = false) {
    if (!keep) homey.app.settings = { debug_level: 'off', ais_api_key: null };
    homey.settings = {
      get: (k) => homey.app.settings[k] ?? null,
      set: (k, v) => {
        homey.app.settings[k] = JSON.parse(JSON.stringify(v));
      },
      on: () => {},
      off: () => {},
    };
    app = new App(); app.homey = homey;
    global.__TEST_MODE__ = true;
    await app.onInit();
    app.log = jest.fn(); app.error = jest.fn();
    app._bridgeOpeningTrigger.clearTriggerCalls();
  }
  async function warn(extra) {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; global.__TEST_MODE__ = false;
    try {
      app._onBridgeOpeningWarning(payload(extra)); await Promise.resolve();
    } finally {
      process.env.NODE_ENV = saved; global.__TEST_MODE__ = true;
    }
  }
  function fix(distance, overrides = {}) {
    now += 60000;
    app._observeOpeningArrivals({
      mmsi: '258177180',
      lat: BRIDGES.klaffbron.lat - distance / 111320,
      lon: BRIDGES.klaffbron.lon,
      sog: 4,
      timestamp: now,
      fixTs: now,
      fixFeed: 'aishub',
      ...overrides,
    });
  }
  beforeEach(async () => {
    now = Date.parse('2026-09-08T08:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await boot();
  });
  afterEach(async () => {
    await app.onUninit(); jest.restoreAllMocks(); delete global.__TEST_MODE__;
  });
  test.each([10, 35, 65, 240, 1440])('%s min tystnad utan bortfärd ger ingen andra varning', async (minutes) => {
    await warn(); now += minutes * 60000;
    await warn({ eventId: 'Klaffbron#2' });
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
  });
  test.each([-1, 0, 600, NaN])('ETA %s kan inte bestämma hur länge ett faktiskt besök varar', async (etaMinutes) => {
    await warn({ etaMinutes }); now += 4 * 3600000;
    await app.onUninit(); await boot(true); await warn();
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(0);
    expect(app._persistentOpeningWarnings.get(key).arrivalActive).toBe(true);
  });
  test('bekräftad passage frigör en senare ankomst, även efter omstart', async () => {
    await warn(); await app.onUninit(); now += 3600000; await boot(true);
    app._consumeOpeningDedupForPassage('258177180', 'Klaffbron');
    await warn();
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
  });
  test('ny riktning och tillkommen konvojmedlem får egna varningar', async () => {
    await warn();
    await warn({ eventId: 'Klaffbron#2', direction: 'southbound' });
    await warn({ eventId: 'Klaffbron#3', mmsis: ['258177180', '265573130'], vesselCount: 2 });
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(3);
  });
  test('verklig bortfärd i två nya fix frigör en återkomst i samma riktning', async () => {
    await warn(); fix(200); fix(650);
    expect(app._persistentOpeningWarnings.has(key)).toBe(true);
    await app.onUninit(); await boot(true); // halvfärdig bortfärd överlever boot
    fix(750);
    expect(app._persistentOpeningWarnings.has(key)).toBe(false);
    await warn();
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
  });
  test.each([
    { _gpsJumpDetected: true }, { _positionUncertain: true }, { sog: 0 },
    { fixTs: 1 }, { fixTs: Number.MAX_SAFE_INTEGER },
  ])('osäkra, stillastående eller gamla fix frigör inte ankomsten: %j', async (overrides) => {
    await warn(); fix(200); fix(750, overrides); fix(800, overrides);
    await warn({ eventId: 'Klaffbron#2' });
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
  });
  test('ett felaktigt bortre fix följt av återgång avslutar inte ankomsten', async () => {
    await warn(); fix(200); fix(750); fix(210); fix(760);
    expect(app._persistentOpeningWarnings.has(key)).toBe(true);
  });
  test('gammalt lagringsformat migreras utan att uppfinna obegränsat skydd', async () => {
    app._persistentOpeningWarnings.clear();
    homey.app.settings.persistent_opening_warnings = {
      [key]: { firedAt: now - 60000, expiresAt: now + 60000 },
      'Stridsbergsbron|265573130|northbound': now - 1,
    };
    app._loadPersistentOpeningWarnings(); await warn();
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(0);
    now += 60001; await warn();
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
    expect(app._persistentOpeningWarnings.get(key).arrivalActive).toBe(true);
  });
  test('lagringen är begränsad även om många sändare aldrig återkommer', () => {
    for (let i = 0; i < 2100; i++) {
      app._persistentOpeningWarnings.set(`Klaffbron|${900000000 + i}|northbound`, { arrivalActive: true, firedAt: now + i });
    }
    app._persistOpeningWarnings();
    expect(app._persistentOpeningWarnings.size).toBe(2048);
    expect(Object.keys(homey.app.settings.persistent_opening_warnings)).toHaveLength(2048);
  });
});
