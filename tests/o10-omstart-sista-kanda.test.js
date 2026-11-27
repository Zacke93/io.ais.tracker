'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { generateScenario, BASE_TIME_MS } = require('./replay-validation/scenarioGenerator');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

/**
 * O1 (omgång 10, spår O): en ordnad omstart sparar de levande båtarnas
 * positioner i `last_known_positions`, som om de raderats just då.
 *
 * Förut skrev onUninit bara de båtar som redan raderats. En båt som var i
 * kanalen vid omstarten blev efteråt en ny båt utan historik, och appen gissade
 * att hon kom från kanalens port: en falsk "passerade Klaffbron under
 * AIS-tystnad" för en bro hon passerat långt tidigare (BRANIF i banken), eller
 * inga notiser alls för broarna hon passerade under omstarten när kursen låg
 * utanför portgissningens band (EBONITA PRINCESS 40 i banken).
 */
const MIN = 60 * 1000;

describe('O1: sist kända positioner över en ordnad omstart', () => {
  let app;
  let store;
  let savedTestMode;
  let savedNodeEnv;

  async function start(initialStore) {
    store = initialStore;
    global.__TEST_MODE__ = true;
    app = new App();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (k) => (k in store ? store[k] : null),
        set: (k, v) => {
          store[k] = JSON.parse(JSON.stringify(v));
        },
        on: jest.fn(),
        off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    await app.onInit();
    global.__TEST_MODE__ = undefined;
    process.env.NODE_ENV = 'production';
    app._onAISConnected();
  }

  function feed(s, overrides = {}) {
    app._processAISMessage({
      mmsi: String(s.mmsi),
      msgType: 'PositionReport',
      lat: s.lat,
      lon: s.lon,
      sog: s.sog,
      cog: s.cog,
      shipName: s.shipName,
      timestamp: Date.now(),
      fixTs: Date.now(),
      fixFeed: 'aisstream',
      fixTsQuality: 'receipt',
      ...overrides,
    });
  }

  async function play(samples, overrides) {
    for (let i = 0; i < samples.length; i++) {
      if (i > 0) await jest.advanceTimersByTimeAsync(samples[i].aisTimestamp - samples[i - 1].aisTimestamp);
      feed(samples[i], overrides);
      await jest.advanceTimersByTimeAsync(60);
    }
  }

  const notices = () => app._boatNearTrigger.triggerCalls.filter((c) => c.success).map((c) => c.tokens.bridge_name);

  function journey(mmsi, name) {
    return generateScenario({
      seed: 1010,
      vessels: [{
        mmsi, name, direction: 'north', speedKn: 6, reportIntervalS: 60,
      }],
    });
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: BASE_TIME_MS });
    savedTestMode = global.__TEST_MODE__;
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(async () => {
    if (app) await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
    process.env.NODE_ENV = savedNodeEnv;
  });

  test('onUninit sparar en levande båts position med samma fält som en radering', async () => {
    await start({});
    const MMSI = '910010101';
    const samples = journey(MMSI, 'PROV LEVANDE');
    const kb = BRIDGES.klaffbron;
    const cut = samples.findIndex((s) => s.lat < kb.lat && geometry.calculateDistance(s.lat, s.lon, kb.lat, kb.lon) < 600);
    await play(samples.slice(0, cut));
    const last = samples[cut - 1];
    expect(app.vesselDataService.getVessel(MMSI)).toBeTruthy();
    await jest.advanceTimersByTimeAsync(30 * 1000);
    const stoppedAt = Date.now();
    await app.onUninit();
    const saved = store.last_known_positions && store.last_known_positions[MMSI];
    expect(saved).toBeTruthy();
    expect(saved.lat).toBeCloseTo(last.lat, 6);
    expect(saved.lon).toBeCloseTo(last.lon, 6);
    expect(saved.t).toBe(stoppedAt);
    expect(saved.posT).toBeLessThan(stoppedAt);
    expect(Number.isFinite(saved.fixTs)).toBe(true);
    app = null;
  });

  test('motfall: en redan raderad båts post skrivs inte om vid omstarten', async () => {
    const MMSI = '910010102';
    const old = {
      lat: BRIDGES.olidebron.lat - 0.003, lon: BRIDGES.olidebron.lon - 0.003, t: BASE_TIME_MS - 30 * MIN, posT: BASE_TIME_MS - 31 * MIN,
    };
    await start({ last_known_positions: { [MMSI]: old } });
    await jest.advanceTimersByTimeAsync(MIN);
    await app.onUninit();
    expect(store.last_known_positions[MMSI]).toEqual(old);
    app = null;
  });

  test('omstart medan båten är tyst: notiserna för broarna hon passerade kommer, utan gissning om porten', async () => {
    await start({});
    const MMSI = '910010103';
    const samples = journey(MMSI, 'PROV TYST');
    const kb = BRIDGES.klaffbron;
    const sb = BRIDGES.stridsbergsbron;
    const cut = samples.findIndex((s) => s.lat < kb.lat && geometry.calculateDistance(s.lat, s.lon, kb.lat, kb.lon) < 500);
    await play(samples.slice(0, cut));
    expect(notices()).not.toContain('Klaffbron');
    // Två minuter tyst, sedan en ordnad omstart med samma inställningar.
    await jest.advanceTimersByTimeAsync(2 * MIN);
    await app.onUninit();
    await jest.advanceTimersByTimeAsync(2 * MIN);
    await start(store);
    // Nästa position 200 m norr om Stridsbergsbron, kursen 50° (utanför
    // portgissningens nordband, som EBONITA PRINCESS 40).
    const after = samples.findIndex((s) => s.lat > sb.lat && geometry.calculateDistance(s.lat, s.lon, sb.lat, sb.lon) > 200);
    const resume = samples.slice(after, after + 4);
    await jest.advanceTimersByTimeAsync(4 * MIN);
    await play(resume, { cog: 50 });
    await jest.advanceTimersByTimeAsync(2 * MIN);
    expect(notices()).toEqual(expect.arrayContaining(['Klaffbron', 'Järnvägsbron']));
    expect(notices().filter((b) => b === 'Klaffbron')).toHaveLength(1);
  });
});
