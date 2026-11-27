'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { generateScenario, BASE_TIME_MS } = require('./replay-validation/scenarioGenerator');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

/**
 * U72 (omgång 9, spår R): KÄND GRÄNS — klocksteg bakåt. Appen mäter åldrar med
 * väggklockan; Nodes timers går på monoton tid. Ställs väggklockan en timme
 * bakåt när båtens AIS tystnar strax före Klaffbron står brotextens ETA kvar
 * tills borttagningstimern tar båten efter 30 minuter, och öppningsvarningens
 * deadline skjuts upp med stegets storlek, så varningen kommer efter att båten
 * tagits bort. Det testet låser är vad användaren ser i dag, inte ett önskat
 * beteende, plus loggraden [CLOCK_STEP] som gör ett fältfall förklarbart: en
 * rad per steg, inga rader för steg framåt eller vanlig drift.
 */
const MIN = 60 * 1000;
const MMSI = '265099401';
const CUT = 30; // båten är 4 minuter från Klaffbron när AIS tystnar

describe('Klocksteg bakåt (känd gräns) och loggraden [CLOCK_STEP]', () => {
  let app;
  let device;
  let savedTestMode;
  let savedNodeEnv;

  beforeEach(async () => {
    jest.useFakeTimers({ now: BASE_TIME_MS });
    savedTestMode = global.__TEST_MODE__;
    savedNodeEnv = process.env.NODE_ENV;
    global.__TEST_MODE__ = true;
    app = new App();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: () => null, set: jest.fn(), on: jest.fn(), off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    await app.onInit();
    global.__TEST_MODE__ = undefined;
    process.env.NODE_ENV = 'production';
    // Minutloopen (borttagning av tysta båtar) som i produktion.
    app._setupMonitoring();
    const values = new Map();
    device = {
      values,
      getName: () => 'Broläge',
      getCapabilityValue: (c) => values.get(c),
      setCapabilityValue: (c, v) => {
        values.set(c, v);
        return Promise.resolve();
      },
    };
    app._devices.add(device);
    app._onAISConnected();
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
    process.env.NODE_ENV = savedNodeEnv;
  });

  async function playUntilSilence() {
    const samples = generateScenario({
      seed: 7,
      vessels: [{
        mmsi: MMSI, name: 'PROV KLOCKA', direction: 'north', speedKn: 5, reportIntervalS: 30,
      }],
    });
    for (const s of samples.slice(0, CUT)) {
      const gap = s.aisTimestamp - Date.now();
      if (gap > 0) await jest.advanceTimersByTimeAsync(gap);
      app._processAISMessage({
        mmsi: MMSI,
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
      await jest.advanceTimersByTimeAsync(60);
    }
  }

  const clockStepLines = () => app.log.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[CLOCK_STEP]'));
  const text = () => device.values.get('bridge_text');
  const vessels = () => app.vesselDataService.getVesselCount();
  const stridsWarnings = () => app._bridgeOpeningTrigger.triggerCalls
    .filter((c) => c.success && c.tokens.bridge_name === 'Stridsbergsbron');

  test('kontroll utan steg: ETA okänd inom 6 min, båten borta efter 31 min, ingen [CLOCK_STEP]', async () => {
    await playUntilSilence();
    expect(text()).toMatch(/Klaffbron, beräknad broöppning om \d+ minuter/);
    await jest.advanceTimersByTimeAsync(6 * MIN);
    expect(text()).toMatch(/Klaffbron, ETA okänd/);
    await jest.advanceTimersByTimeAsync(25 * MIN);
    expect(vessels()).toBe(0);
    expect(clockStepLines()).toHaveLength(0);
  });

  test('känd gräns: en timme bakåt låter ETA:n stå kvar tills båten tas bort, och [CLOCK_STEP] skrivs en gång', async () => {
    await playUntilSilence();
    const shownBefore = text();
    expect(shownBefore).toMatch(/Klaffbron, beräknad broöppning om \d+ minuter/);
    const warningsBefore = stridsWarnings().length;
    jest.setSystemTime(Date.now() - 60 * MIN);

    await jest.advanceTimersByTimeAsync(2 * MIN);
    expect(clockStepLines()).toHaveLength(1);
    expect(clockStepLines()[0]).toMatch(/cirka 3[56]\d\d s bakåt/);

    // Användaren ser fortfarande samma ETA 25 minuter efter att AIS tystnat.
    await jest.advanceTimersByTimeAsync(23 * MIN);
    expect(text()).toBe(shownBefore);
    expect(vessels()).toBe(1);

    // Borttagningstimern går på monoton tid: båten tas bort efter 30 minuter.
    await jest.advanceTimersByTimeAsync(6 * MIN);
    expect(vessels()).toBe(0);
    expect(text()).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(stridsWarnings().length).toBe(warningsBefore);

    // Öppningsvarningens deadline är förskjuten med steget: den kommer först
    // när väggklockan hunnit ikapp, efter att båten tagits bort.
    await jest.advanceTimersByTimeAsync(40 * MIN);
    expect(stridsWarnings().length).toBe(warningsBefore + 1);

    // Ett steg ger en rad, inte en per vakthundskörning.
    expect(clockStepLines()).toHaveLength(1);
  });

  test('ett steg framåt och vanlig drift ger ingen [CLOCK_STEP]', async () => {
    await playUntilSilence();
    jest.setSystemTime(Date.now() + 60 * MIN);
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(clockStepLines()).toHaveLength(0);
  });

  test('ett litet steg bakåt (30 s) loggas inte', async () => {
    await playUntilSilence();
    jest.setSystemTime(Date.now() - 30 * 1000);
    await jest.advanceTimersByTimeAsync(5 * MIN);
    expect(clockStepLines()).toHaveLength(0);
  });
});
