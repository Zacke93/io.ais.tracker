'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { generateScenario, BASE_TIME_MS } = require('./replay-validation/scenarioGenerator');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

/**
 * Omgång 9, spår R (granskningen L3 och M3): sista kända positioner med en stämpel
 * i framtiden, genom hela appen.
 *
 * M3: efter ett klocksteg bakåt ligger nyss skrivna, riktiga positioner i
 * framtiden. Första versionen raderade dem i minutstädningen; en båt som tagits
 * bort under ett glapp före Klaffbron och återföds i kö efter Järnvägsbron
 * tappade då passagenotiserna för Klaffbron och Järnvägsbron (basen gav dem).
 * Nu sätts stämpeln till "nu".
 *
 * L3: en sparad position med stämpel långt fram räknades som färsk för evigt,
 * så en båt som kom tillbaka på en ny resa långt senare fick en falsk
 * "Olidebron (passerad)". Med stämpeln satt till "nu" förfaller posten efter
 * de vanliga 6 h.
 */
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe('Sista kända positioner med framtida stämpel, hela appen', () => {
  let app;
  let store;
  let savedTestMode;
  let savedNodeEnv;

  async function start(initialStore = {}) {
    store = { ...initialStore };
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
    app._setupMonitoring();
    app._onAISConnected();
  }

  function feed(s) {
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
    });
  }

  async function playAt(samples, startAt) {
    for (let i = 0; i < samples.length; i++) {
      const gap = startAt + (samples[i].aisTimestamp - samples[0].aisTimestamp) - Date.now();
      if (gap > 0) await jest.advanceTimersByTimeAsync(gap);
      feed(samples[i]);
      await jest.advanceTimersByTimeAsync(60);
    }
  }

  const notices = () => app._boatNearTrigger.triggerCalls.filter((c) => c.success).map((c) => c.tokens.bridge_name);

  beforeEach(() => {
    jest.useFakeTimers({ now: BASE_TIME_MS });
    savedTestMode = global.__TEST_MODE__;
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
    process.env.NODE_ENV = savedNodeEnv;
  });

  test('M3: klocksteg 30 min bakåt efter borttagningen; båten återföds i kö efter Järnvägsbron och får sina passagenotiser', async () => {
    await start();
    const MMSI = '265099601';
    const samples = generateScenario({
      seed: 4,
      vessels: [{
        mmsi: MMSI, name: 'PROV KO', direction: 'north', speedKn: 5, reportIntervalS: 30,
      }],
    });
    const kb = BRIDGES.klaffbron;
    const cut = samples.findIndex((s) => s.lat < kb.lat && geometry.calculateDistance(s.lat, s.lon, kb.lat, kb.lon) < 500);
    await playAt(samples.slice(0, cut), samples[0].aisTimestamp);
    // AIS tystnar; båten tas bort och hennes sista position sparas.
    await jest.advanceTimersByTimeAsync(40 * MIN);
    expect(app.vesselDataService.getVesselCount()).toBe(0);
    expect(app._lastKnownPositions.has(MMSI)).toBe(true);
    jest.setSystemTime(Date.now() - 30 * MIN);
    await jest.advanceTimersByTimeAsync(3 * MIN);
    expect(app._lastKnownPositions.has(MMSI)).toBe(true);
    // Återföds i kö efter Järnvägsbron, 0,5 kn.
    const rest = samples.findIndex((s) => s.lat > BRIDGES.jarnvagsbron.lat + 0.0015);
    const queue = samples.slice(rest, rest + 6).map((s, i) => ({
      ...s, sog: 0.5, lat: samples[rest].lat + i * 0.00003, lon: samples[rest].lon + i * 0.00003,
    }));
    await playAt(queue, Date.now() + 1000);
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(notices()).toEqual(expect.arrayContaining(['Klaffbron', 'Järnvägsbron']));
  });

  test('L3: en sparad position med stämpel år 2100 ger ingen falsk passagenotis när båten kommer tillbaka sju timmar senare', async () => {
    const MMSI = '265099602';
    const future = Date.UTC(2100, 0, 1);
    await start({
      last_known_positions: {
        [MMSI]: {
          lat: BRIDGES.olidebron.lat - 0.004, lon: BRIDGES.olidebron.lon - 0.004, t: future, posT: future,
        },
      },
    });
    const samples = generateScenario({
      seed: 9,
      vessels: [{
        mmsi: MMSI, name: 'PROV ATER', direction: 'north', speedKn: 5, reportIntervalS: 30,
      }],
    }).filter((s) => s.lat > BRIDGES.jarnvagsbron.lat + 0.0005);
    await playAt(samples, BASE_TIME_MS + 7 * HOUR);
    await jest.advanceTimersByTimeAsync(40 * MIN);
    expect(notices()).not.toContain('Olidebron');
    expect(notices()).toContain('Stridsbergsbron');
  });
});
