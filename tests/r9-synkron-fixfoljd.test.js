'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { generateScenario, BASE_TIME_MS } = require('./replay-validation/scenarioGenerator');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

/**
 * Omgång 9, spår R (felinjektion): flera AIS-fix för SAMMA båt som behandlas
 * synkront efter varandra. Websocketen levererar flera ramar i samma läsning
 * efter ett nätstopp där uppkopplingen inte bröts, och aisstream stämplar varje
 * meddelande med mottagningstiden. Fortsättningen efter första await i
 * _onVesselUpdated körs då först när alla fix redan analyserats, och
 * fartygsobjekten delar passedAt. Före rättningen såg det gamla fixets
 * fortsättning den senare passagen, nollade öppningsdedupen, och nästa gamla
 * fortsättning (fortfarande före bron) beväpnade och avfyrade en ny varning
 * för en bro båten redan passerat.
 */
const MMSI = '265099101';

function journey() {
  return generateScenario({
    seed: 3,
    vessels: [{
      mmsi: MMSI, name: 'PROV FOLJD', direction: 'north', speedKn: 5, reportIntervalS: 30,
    }],
  });
}

function message(s) {
  return {
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
  };
}

const klaffSide = (s) => (s.lat - BRIDGES.klaffbron.lat) * 111320;

describe('Synkron fixföljd för samma båt (nätstopp utan nedkoppling)', () => {
  let app;
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
    // Notiser och varningar går som i produktion (samma dans som replayharnessen).
    global.__TEST_MODE__ = undefined;
    process.env.NODE_ENV = 'production';
    app._onAISConnected();
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
    process.env.NODE_ENV = savedNodeEnv;
  });

  // Spela upp proverna; [first, last] levereras synkront vid det sistas tid.
  async function play(samples, burst = null) {
    for (let i = 0; i < samples.length; i++) {
      if (burst && i >= burst[0] && i < burst[1]) continue;
      const gap = samples[i].aisTimestamp - Date.now();
      if (gap > 0) await jest.advanceTimersByTimeAsync(gap);
      if (burst && i === burst[1]) {
        for (let j = burst[0]; j <= burst[1]; j++) app._processAISMessage(message(samples[j]));
      } else {
        app._processAISMessage(message(samples[i]));
      }
      await jest.advanceTimersByTimeAsync(60);
    }
    await jest.advanceTimersByTimeAsync(40 * 60 * 1000);
  }

  const warnings = () => app._bridgeOpeningTrigger.triggerCalls
    .filter((c) => c.success)
    .map((c) => `${c.tokens.bridge_name}#${c.state.eventId}`);

  test('tre fix över Klaffbrons linje i en följd ger ingen andra Klaffbronvarning', async () => {
    const samples = journey();
    // Följden: två fix före Klaffbrons linje och ett efter (samma geometri som
    // fyndet: 88 m före, 13 m före, 60 m efter).
    const first = samples.findIndex((s, i) => i > 0 && klaffSide(s) < 0 && klaffSide(samples[i + 2]) > 0
      && klaffSide(samples[i + 1]) < 0);
    expect(first).toBeGreaterThan(0);
    expect(geometry.calculateDistance(samples[first].lat, samples[first].lon,
      BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon)).toBeLessThan(150);
    await play(samples, [first, first + 2]);
    const klaff = warnings().filter((w) => w.startsWith('Klaffbron'));
    expect(klaff).toHaveLength(1);
    expect(warnings().filter((w) => w.startsWith('Stridsbergsbron'))).toHaveLength(1);
  });

  test('motfall: samma resa utan följd ger en varning per bro', async () => {
    await play(journey());
    expect(warnings().map((w) => w.split('#')[0])).toEqual(['Klaffbron', 'Stridsbergsbron']);
  });

  test('motfall: följden ändrar inte båtens notiser', async () => {
    const samples = journey();
    const first = samples.findIndex((s, i) => i > 0 && klaffSide(s) < 0 && klaffSide(samples[i + 2]) > 0
      && klaffSide(samples[i + 1]) < 0);
    await play(samples, [first, first + 2]);
    const notices = app._boatNearTrigger.triggerCalls.filter((c) => c.success).map((c) => c.tokens.bridge_name);
    expect(notices).toEqual(['Kanalinfarten', 'Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron']);
  });
});
