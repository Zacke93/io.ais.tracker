'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { generateScenario, BASE_TIME_MS } = require('./replay-validation/scenarioGenerator');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

/**
 * U84 (omgång 10, spår O, ärende O2): en obekräftad GPS-hoppposition blir inte
 * sist känd position, varken när båten raderas (`_onVesselRemoved`) eller vid
 * en ordnad omstart (A1, `_rememberLiveVesselPositions`).
 *
 * G-SYSTER (granskarens prob, felet fanns på basen): båten ligger stilla 900 m
 * söder om Klaffbron, sista fixen är ett hopp norr om Järnvägsbron, hon raderas
 * efter tystnad och hörs 41 min senare på samma plats. Med hoppet som sist känd
 * gav återfödelsen "passerade Järnvägsbron/Klaffbron under AIS-tystnad" söderut.
 *
 * Utan ren position (en kedja av obekräftade hopp längre än
 * GPSJumpAnalyzer.PASSAGE_RECOVERY_MAX_AGE_MS tappar ankaret) sparas ingenting.
 */
const MIN = 60 * 1000;

describe('U84: obekräftat hopp som sist känd position', () => {
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

  async function play(samples) {
    for (let i = 0; i < samples.length; i++) {
      if (i > 0) await jest.advanceTimersByTimeAsync(samples[i].aisTimestamp - samples[i - 1].aisTimestamp);
      feed(samples[i]);
      await jest.advanceTimersByTimeAsync(60);
    }
  }

  async function hold(sample, minutes) {
    for (let m = 0; m < minutes; m++) {
      await jest.advanceTimersByTimeAsync(MIN);
      feed(sample, { sog: 0 });
    }
  }

  const notices = () => app._boatNearTrigger.triggerCalls.filter((c) => c.success)
    .map((c) => ({ bridge: c.tokens.bridge_name, msg: c.tokens.message || '' }));

  const journey = (mmsi, name) => generateScenario({
    seed: 1010,
    vessels: [{
      mmsi, name, direction: 'north', speedKn: 6, reportIntervalS: 60,
    }],
  });

  function setup(mmsi, name) {
    const s = journey(mmsi, name);
    const kb = BRIDGES.klaffbron;
    const jvb = BRIDGES.jarnvagsbron;
    const cut = s.findIndex((x) => x.lat < kb.lat && geometry.calculateDistance(x.lat, x.lon, kb.lat, kb.lon) < 900);
    const spike = s.find((x) => x.lat > jvb.lat + 0.0012);
    return {
      s, cut, still: { ...s[cut - 1], mmsi }, spike: { ...spike, mmsi },
    };
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: BASE_TIME_MS });
    savedTestMode = global.__TEST_MODE__;
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
    process.env.NODE_ENV = savedNodeEnv;
  });

  test('G-SYSTER: hopp som sista fix före radering ger inga falska "passerade"', async () => {
    await start({});
    const MMSI = '910030004';
    const {
      s, cut, still, spike,
    } = setup(MMSI, 'PROV SYSTER');
    await play(s.slice(0, cut));
    await hold(still, 5);
    await jest.advanceTimersByTimeAsync(20 * 1000);
    feed(spike, { sog: 0.2, cog: 20 });
    await jest.advanceTimersByTimeAsync(60);
    expect(app.vesselDataService.getVessel(MMSI)._gpsJumpDetected).toBe(true);
    const n0 = notices().length;
    await jest.advanceTimersByTimeAsync(40 * MIN);
    expect(app.vesselDataService.getVessel(MMSI)).toBeFalsy();
    const lk = app._lastKnownPositions.get(MMSI);
    // Den rena positionen (den stilla båten), inte hoppet.
    expect(lk).toBeTruthy();
    expect(lk.lat).toBeCloseTo(still.lat, 6);
    await hold(still, 3);
    const resume = s.findIndex((x) => x.aisTimestamp > s[cut - 1].aisTimestamp);
    await play(s.slice(resume).map((x) => ({ ...x, mmsi: MMSI })));
    const after = notices().slice(n0);
    expect(after.some((n) => /passerade (Järnvägsbron|Klaffbron) under AIS-tystnad/.test(n.msg))).toBe(false);
    expect(after.filter((n) => n.bridge === 'Klaffbron')).toHaveLength(1);
  });

  test('motfall: utan hopp sparas båtens sista position vid radering som förut', async () => {
    await start({});
    const MMSI = '910030005';
    const { s, cut, still } = setup(MMSI, 'PROV UTAN HOPP');
    await play(s.slice(0, cut));
    await hold(still, 5);
    await jest.advanceTimersByTimeAsync(40 * MIN);
    expect(app.vesselDataService.getVessel(MMSI)).toBeFalsy();
    expect(app._lastKnownPositions.get(MMSI).lat).toBeCloseTo(still.lat, 6);
  });

  // O3 (graven): samma läge, men båten hörs igen inom gravens 15 min. Graven
  // avgör om återfödelsen sker på plats (200 m) och låter då rörelsebevisen
  // följa med. Med hoppets punkt i graven låg den stilla båten "2 km bort", och
  // bevisen kastades. En båt utan fartgivare (sog saknas) som sänder var tredje
  // minut bygger inte upp något nytt rörelsebevis under resan, så hela resan
  // norrut blev tyst. Med ankaret i graven kommer notiserna som utan hopp.
  test('graven: hopp som sista fix före radering kastar inte rörelsebevisen', async () => {
    await start({});
    const MMSI = '910030008';
    const {
      s, cut, still, spike,
    } = setup(MMSI, 'PROV GRAV');
    await play(s.slice(0, cut));
    await hold(still, 5);
    await jest.advanceTimersByTimeAsync(20 * 1000);
    feed(spike, { sog: 0.2, cog: 20 });
    await jest.advanceTimersByTimeAsync(60);
    expect(app.vesselDataService.getVessel(MMSI)._gpsJumpDetected).toBe(true);
    const n0 = notices().length;
    let tyst = 0;
    while (app.vesselDataService.getVessel(MMSI) && tyst < 60) {
      await jest.advanceTimersByTimeAsync(MIN);
      tyst++;
    }
    expect(app.vesselDataService.getVessel(MMSI)).toBeFalsy();
    const grav = app.vesselDataService._vesselGraves.get(MMSI);
    expect(grav).toBeTruthy();
    expect(grav.lat).toBeCloseTo(still.lat, 6);
    await jest.advanceTimersByTimeAsync(3 * MIN);
    feed(still, { sog: 0 });
    await jest.advanceTimersByTimeAsync(60);
    expect(app.vesselDataService.getVessel(MMSI)._hasMovementProof).toBe(true);
    await hold(still, 2);
    const resume = s.findIndex((x) => x.aisTimestamp > s[cut - 1].aisTimestamp);
    await play(s.slice(resume).filter((x, i) => i % 3 === 0).map((x) => ({ ...x, mmsi: MMSI, sog: null })));
    const after = notices().slice(n0);
    expect(after.map((n) => n.bridge)).toEqual(['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron']);
    expect(after.every((n) => /närmar sig/.test(n.msg))).toBe(true);
  });

  // Utan ren position (en kedja av hopp längre än 20 min har tappat ankaret)
  // skrivs ingen grav alls, i stället för en grav på hoppets punkt. Prövas
  // direkt på gravläggningen: i ett helt förlopp hamnar en sådan båt nära
  // broarna under målbroskydd och raderas som STALE_AIS, som aldrig gravläggs.
  test('graven: utan ren position skrivs ingen grav (hoppet sparas inte)', async () => {
    await start({});
    const vds = app.vesselDataService;
    const hopp = {
      lat: 58.2934, lon: 12.2946, _gpsJumpDetected: true, _passageRecoveryPosition: null,
    };
    vds._buryVessel('910030009', hopp);
    expect(vds._vesselGraves.has('910030009')).toBe(false);
    vds._buryVessel('910030010', { ...hopp, _passageRecoveryPosition: { lat: 58.2757, lon: 12.2790 } });
    expect(vds._vesselGraves.get('910030010').lat).toBe(58.2757);
  });

  // Ingen ren position: en kedja av obekräftade hopp (fram och tillbaka mellan
  // båtens plats och en punkt norr om Järnvägsbron) längre än 20 min tappar det
  // rena ankaret. Då sparas ingenting, varken vid radering eller vid en ordnad
  // omstart; hoppet sparas aldrig.
  async function hoppkedja(mmsi, name) {
    const {
      s, cut, still, spike,
    } = setup(mmsi, name);
    await play(s.slice(0, cut));
    await hold(still, 2);
    for (let i = 0; i < 25; i++) {
      await jest.advanceTimersByTimeAsync(MIN);
      feed(i % 2 === 0 ? spike : still, { sog: 0.2, cog: 20 });
    }
    await jest.advanceTimersByTimeAsync(60);
    return { still, spike };
  }

  test('ingen ren position vid radering: ingenting sparas (hoppet sparas inte)', async () => {
    await start({});
    const MMSI = '910030006';
    const { spike } = await hoppkedja(MMSI, 'PROV KEDJA');
    const v = app.vesselDataService.getVessel(MMSI);
    expect(v.lat).toBeCloseTo(spike.lat, 6);
    expect(v._gpsJumpDetected).toBe(true);
    expect(v._passageRecoveryPosition).toBeFalsy();
    await jest.advanceTimersByTimeAsync(45 * MIN);
    expect(app.vesselDataService.getVessel(MMSI)).toBeFalsy();
    expect(app._lastKnownPositions.has(MMSI)).toBe(false);
  });

  test('ingen ren position vid en ordnad omstart: ingenting sparas (A1)', async () => {
    await start({});
    const MMSI = '910030007';
    await hoppkedja(MMSI, 'PROV KEDJA OMSTART');
    const v = app.vesselDataService.getVessel(MMSI);
    expect(v._gpsJumpDetected).toBe(true);
    expect(v._passageRecoveryPosition).toBeFalsy();
    await app.onUninit();
    expect((store.last_known_positions || {})[MMSI]).toBeUndefined();
    app = null;
  });
});
