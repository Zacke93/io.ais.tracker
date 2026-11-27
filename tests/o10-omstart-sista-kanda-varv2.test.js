'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { generateScenario, BASE_TIME_MS } = require('./replay-validation/scenarioGenerator');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

/**
 * O1, andra varvet (omgång 10, spår O, granskningen av 03b3035). Fallen är
 * granskarens prober i testform:
 *  A1: en obekräftad GPS-hoppposition strax före omstarten sparas inte som
 *      sist känd (annars falska "passerade … under AIS-tystnad");
 *  A2: posten från en ordnad omstart förbrukas när båten fått sin andra fix,
 *      så att en senare krasch inte laddar den;
 *  A3: posten gäller bara om appen startar inom 15 min. Efter en paus över
 *      15 min kastas positionen från stoppet vid laddningen, och testet visar
 *      att notiserna då är de som basen ger i det läget (båten har vänt, och
 *      ingen sparad position finns). Klocksteg: en stämpel i
 *      framtiden klampas till "nu" (omgång 9) och gäller; ett steg framåt
 *      gör posten för gammal;
 *  L1: ett fel i sparandet hindrar inte resten av onUninit.
 */
const MIN = 60 * 1000;

describe('O1 andra varvet: sist kända positioner över en omstart', () => {
  let app;
  let store;
  let prevN;
  let prevW;
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

  const curNotices = () => app._boatNearTrigger.triggerCalls.filter((c) => c.success)
    .map((c) => ({ bridge: c.tokens.bridge_name, dir: c.tokens.direction, msg: c.tokens.message || '' }));
  const curWarnings = () => (app._bridgeOpeningTrigger?.triggerCalls || []).filter((c) => c.success)
    .map((c) => c.tokens.bridge_name);
  const allNotices = () => prevN.concat(curNotices());
  const allWarnings = () => prevW.concat(curWarnings());

  async function graceful(pauseMs, stepMs = 0) {
    prevN = allNotices();
    prevW = allWarnings();
    await app.onUninit();
    await jest.advanceTimersByTimeAsync(pauseMs);
    if (stepMs) jest.setSystemTime(Date.now() + stepMs);
    await start(store);
  }

  async function hard(pauseMs) {
    const snap = JSON.parse(JSON.stringify(store));
    prevN = allNotices();
    prevW = allWarnings();
    await app.onUninit();
    store = snap;
    await jest.advanceTimersByTimeAsync(pauseMs);
    await start(store);
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

  async function hold(sample, minutes) {
    for (let m = 0; m < minutes; m++) {
      await jest.advanceTimersByTimeAsync(MIN);
      feed(sample, { sog: 0 });
    }
  }

  const journey = (mmsi, name, direction = 'north', speedKn = 6) => generateScenario({
    seed: 1010,
    vessels: [{
      mmsi, name, direction, speedKn, reportIntervalS: 60,
    }],
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: BASE_TIME_MS });
    savedTestMode = global.__TEST_MODE__;
    savedNodeEnv = process.env.NODE_ENV;
    prevN = [];
    prevW = [];
  });

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
    process.env.NODE_ENV = savedNodeEnv;
  });

  test('A1: ett obekräftat GPS-hopp strax före omstarten ger inga falska "passerade"', async () => {
    await start({});
    const MMSI = '910020001';
    const s = journey(MMSI, 'PROV HOPP');
    const kb = BRIDGES.klaffbron;
    const jvb = BRIDGES.jarnvagsbron;
    const cut = s.findIndex((x) => x.lat < kb.lat && geometry.calculateDistance(x.lat, x.lon, kb.lat, kb.lon) < 900);
    await play(s.slice(0, cut));
    const lastClean = s[cut - 1];
    const n0 = allNotices().length;
    const spike = s.find((x) => x.lat > jvb.lat + 0.0012);
    await jest.advanceTimersByTimeAsync(20 * 1000);
    feed({ ...spike, mmsi: MMSI, shipName: 'PROV HOPP' }, { sog: 6, cog: 20 });
    await jest.advanceTimersByTimeAsync(60);
    expect(app.vesselDataService.getVessel(MMSI)._gpsJumpDetected).toBe(true);
    await jest.advanceTimersByTimeAsync(10 * 1000);
    await graceful(2 * MIN);
    const saved = store.last_known_positions[MMSI];
    expect(saved.lat).toBeCloseTo(lastClean.lat, 6);
    const t0 = lastClean.aisTimestamp;
    const resumeIdx = s.findIndex((x) => x.aisTimestamp >= t0 + 3 * MIN);
    await jest.advanceTimersByTimeAsync(30 * 1000);
    await play(s.slice(resumeIdx));
    const after = allNotices().slice(n0);
    const kla = after.filter((n) => n.bridge === 'Klaffbron');
    expect(kla).toHaveLength(1);
    expect(kla[0].msg).not.toMatch(/passerade/);
    expect(after.filter((n) => n.bridge === 'Järnvägsbron').every((n) => !/passerade/.test(n.msg))).toBe(true);
  });

  test('A2: posten förbrukas vid andra fixen efter omstarten och laddas inte efter en krasch', async () => {
    await start({});
    const MMSI = '910020007';
    const s = journey(MMSI, 'PROV FÖRBRUKA');
    const kb = BRIDGES.klaffbron;
    const cut = s.findIndex((x) => x.lat < kb.lat && geometry.calculateDistance(x.lat, x.lon, kb.lat, kb.lon) < 900);
    await play(s.slice(0, cut));
    await jest.advanceTimersByTimeAsync(20 * 1000);
    await graceful(2 * MIN);
    expect(store.last_known_positions[MMSI].shutdown).toBe(true);
    const resumeIdx = s.findIndex((x) => x.aisTimestamp >= s[cut - 1].aisTimestamp + 3 * MIN);
    await play(s.slice(resumeIdx, resumeIdx + 1));
    // Första fixen efter omstarten: återfödelsen använder posten.
    expect(app._lastKnownPositions.has(MMSI)).toBe(true);
    await play(s.slice(resumeIdx + 1, resumeIdx + 3));
    expect(app._lastKnownPositions.has(MMSI)).toBe(false);
    expect(store.last_known_positions[MMSI]).toBeUndefined();
    await jest.advanceTimersByTimeAsync(5 * MIN);
    await hard(MIN);
    expect(app._lastKnownPositions.has(MMSI)).toBe(false);
  });

  test('A2: vänd båt vid Kajen, krasch efter en ordnad omstart: rätt bro, riktning och varning (som på basen)', async () => {
    await start({});
    const MMSI = '910020008';
    const s = journey(MMSI, 'PROV KAJ');
    const kb = BRIDGES.klaffbron;
    const sb = BRIDGES.stridsbergsbron;
    const cut = s.findIndex((x) => x.lat < kb.lat && geometry.calculateDistance(x.lat, x.lon, kb.lat, kb.lon) < 900);
    await play(s.slice(0, cut));
    await jest.advanceTimersByTimeAsync(20 * 1000);
    await graceful(2 * MIN);
    const topIdx = s.findIndex((x) => x.lat > sb.lat && geometry.calculateDistance(x.lat, x.lon, sb.lat, sb.lon) > 400);
    const resumeIdx = s.findIndex((x) => x.aisTimestamp >= s[cut - 1].aisTimestamp + 3 * MIN);
    await play(s.slice(resumeIdx, topIdx + 1));
    const south = journey(MMSI, 'PROV KAJ', 'south', 6);
    const sIdx = south.findIndex((x) => x.lat < s[topIdx].lat);
    const kajIdx = south.findIndex((x) => x.lat < kb.lat + 0.0035);
    await jest.advanceTimersByTimeAsync(MIN);
    await play(south.slice(sIdx, kajIdx + 1));
    const kaj = south[kajIdx];
    await hold(kaj, 150);
    await hard(2 * MIN);
    const n0 = allNotices().length;
    const w0 = allWarnings().length;
    await hold(kaj, 20);
    const slow = journey(MMSI, 'PROV KAJ', 'south', 1.5);
    const idx = slow.findIndex((x) => x.lat < kaj.lat - 0.0002);
    await play(slow.slice(idx));
    const kla = allNotices().slice(n0).filter((n) => n.bridge === 'Klaffbron');
    expect(kla.length).toBeGreaterThan(0);
    expect(kla[0].dir).toBe('söderut');
    expect(allWarnings().slice(w0)).toContain('Klaffbron');
  });

  test('A3: 5 h paus, båten har vänt: positionen från stoppet kastas, notiserna är basens', async () => {
    await start({});
    const MMSI = '910020005';
    const n = journey(MMSI, 'PROV LÅNG');
    const kb = BRIDGES.klaffbron;
    const cut = n.findIndex((x) => x.lat > kb.lat + 0.002);
    await play(n.slice(0, cut));
    const n0 = allNotices().length;
    await jest.advanceTimersByTimeAsync(MIN);
    await graceful(5 * 60 * MIN);
    expect(app._lastKnownPositions.has(MMSI)).toBe(false);
    const south = journey(MMSI, 'PROV LÅNG', 'south');
    const sb = BRIDGES.stridsbergsbron;
    const idx = south.findIndex((x) => x.lat < sb.lat + 0.004);
    await play(south.slice(idx, idx + 3));
    const after = allNotices().slice(n0);
    expect(after.some((x) => x.bridge === 'Stallbackabron')).toBe(true);
    expect(after.some((x) => x.bridge === 'Stridsbergsbron' && /närmar sig/.test(x.msg))).toBe(true);
    expect(after.some((x) => /passerade (Järnvägsbron|Stridsbergsbron)/.test(x.msg))).toBe(false);
  });

  // Gränsen och klockstegen: posten gäller inom 15 min, inte efter.
  const gate = [
    ['paus 14 min', 14 * MIN, 0, true],
    ['paus 16 min', 16 * MIN, 0, false],
    ['paus 2 min och klocksteg 60 min bakåt (stämpeln klampas)', 2 * MIN, -60 * MIN, true],
    ['paus 2 min och klocksteg 60 min framåt', 2 * MIN, 60 * MIN, false],
  ];
  for (const [label, pauseMs, stepMs, loaded] of gate) {
    test(`A3: ${label} ⇒ posten ${loaded ? 'laddas' : 'laddas inte'}`, async () => {
      await start({});
      const MMSI = '910020009';
      const s = journey(MMSI, 'PROV GRÄNS');
      const kb = BRIDGES.klaffbron;
      const cut = s.findIndex((x) => x.lat < kb.lat && geometry.calculateDistance(x.lat, x.lon, kb.lat, kb.lon) < 900);
      await play(s.slice(0, cut));
      await jest.advanceTimersByTimeAsync(20 * 1000);
      await graceful(pauseMs, stepMs);
      expect(app._lastKnownPositions.has(MMSI)).toBe(loaded);
    });
  }

  test('motfall: en post från en radering gäller som förut i 6 h', async () => {
    const MMSI = '910020010';
    const entry = {
      lat: BRIDGES.olidebron.lat - 0.003, lon: BRIDGES.olidebron.lon - 0.003, t: BASE_TIME_MS - 3 * 60 * MIN, posT: BASE_TIME_MS - 3 * 60 * MIN,
    };
    await start({ last_known_positions: { [MMSI]: entry } });
    expect(app._lastKnownPositions.get(MMSI)).toEqual(entry);
  });

  test('L1: ett fel när de levande båtarna sparas hindrar inte resten av onUninit', async () => {
    await start({});
    app._persistentRecentTriggers.set('910020011:Klaffbron', { t: Date.now(), dir: 'north' });
    app.vesselDataService.vessels = {
      values() {
        throw new Error('trasig karta');
      },
    };
    await expect(app.onUninit()).resolves.not.toThrow();
    expect(store.persistent_recent_triggers).toHaveProperty('910020011:Klaffbron');
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining('[LAST_KNOWN_SHUTDOWN]'), 'trasig karta');
    app = null;
  });
});
