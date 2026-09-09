'use strict';

jest.mock('homey');

const fs = require('fs');
const path = require('path');
const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');

// HEY JOE i 41 h-korpusen: watchdog publicerar precis före en säker
// Klaffpassage. Replayens 30 s-steg förstorar då en verklig 200 ms-paus
// till 30 s. Här dränerar Jest löften mellan varje timer och mäter hela
// vägen från rå AIS till publicerad text, med övriga båtar kvar.
describe('Säker passage direkt efter watchdog-publicering', () => {
  let app;
  let savedTestMode;
  let texts;
  const PASSAGE = Date.parse('2026-07-14T13:19:32.346Z');
  const WATCHDOG = Date.parse('2026-07-14T13:19:30Z');
  const ids = new Set(['211881090', '211110880', '265573130', '218023240']);
  const rows = fs.readFileSync(path.join(__dirname, 'replay-validation/corpora-data/ais-replay-20260713-221737.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
    .filter((row) => ids.has(String(row.mmsi))
      && row.aisTimestamp >= Date.parse('2026-07-14T12:30:00Z')
      && row.aisTimestamp <= PASSAGE)
    .sort((a, b) => a.aisTimestamp - b.aisTimestamp);

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(rows[0].aisTimestamp - 1000);
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = new App();
    app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: () => null, set: jest.fn(), on: jest.fn(), off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    await app.onInit();
    global.__TEST_MODE__ = undefined;
    app._isConnected = true;
    texts = [];
    const write = app._updateDeviceCapability.bind(app);
    jest.spyOn(app, '_updateDeviceCapability').mockImplementation((capability, value) => {
      if (capability === 'bridge_text') texts.push({ t: Date.now(), text: value });
      return write(capability, value);
    });
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
  });

  async function feed(row) {
    await jest.advanceTimersByTimeAsync(row.aisTimestamp - Date.now());
    app._processAISMessage({
      ...row,
      mmsi: String(row.mmsi),
      timestamp: row.aisTimestamp,
      fixTs: row.aisTimestamp,
      fixFeed: 'aisstream',
      fixTsQuality: 'receipt',
    });
    await jest.advanceTimersByTimeAsync(0);
  }

  test('passerad båt försvinner inom 300 ms och de andra båtarna behålls', async () => {
    for (const row of rows.filter((item) => item.aisTimestamp < PASSAGE)) {
      // eslint-disable-next-line no-await-in-loop
      await feed(row);
    }
    await jest.advanceTimersByTimeAsync(WATCHDOG + 100 - Date.now());
    const watchdogText = texts.find((entry) => entry.t >= WATCHDOG && entry.t < WATCHDOG + 100);
    expect(watchdogText?.text).toContain('Två båtar på väg mot Klaffbron');
    expect(watchdogText?.text).toContain('En båt på väg mot Stridsbergsbron');
    const pause = jest.spyOn(app, '_sleep');

    await feed(rows.find((row) => row.aisTimestamp === PASSAGE));
    expect(app.vesselDataService.getVessel('211881090').passedBridges).toContain('Klaffbron');
    await jest.advanceTimersByTimeAsync(300);

    expect(pause).toHaveBeenCalledWith(200);
    const updated = texts.find((entry) => entry.t >= PASSAGE
      && entry.text.includes('En båt på väg mot Klaffbron'));
    expect(updated).toBeDefined();
    expect(updated.t - PASSAGE).toBeLessThanOrEqual(300);
    expect(updated.text).toContain('En båt på väg mot Stridsbergsbron');
    expect(app.vesselDataService.getVessel('211110880').targetBridge).toBe('Klaffbron');
    expect(texts.filter((entry) => entry.t >= PASSAGE).every((entry) => !entry.text.startsWith('Inga båtar'))).toBe(true);
    expect(app.error).not.toHaveBeenCalled();
  });
});
