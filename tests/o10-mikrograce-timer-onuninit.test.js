'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');

/**
 * Omgång 10, spår O (fynd 7): mikrograce-pausen i `_actuallyUpdateUI`
 * (`_sleep(200)`) spårades inte. Stängdes appen medan pausen pågick låg en
 * 200 ms-timer kvar efter `onUninit`. Den gjorde ingenting (livscykelvakten),
 * men `runSoak.js` underkänner en körning med en timer kvar efter en omstart,
 * och omstartssvepet träffade läget i 3 av drygt 2 000 omstarter.
 */
describe('mikrograce-pausen lämnar ingen timer efter onUninit', () => {
  let app;
  let savedTestMode;

  beforeEach(async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 6, 13, 15, 15, 0) });
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    const store = {};
    app = new App();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (k) => (k in store ? store[k] : null),
        set: (k, v) => {
          store[k] = v;
        },
        on: jest.fn(),
        off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    await app.onInit();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
  });

  test('en UI-uppdatering i mikrograce-pausen när appen stängs: ingen timer kvar, uppdateringen avslutas', async () => {
    jest.spyOn(app, '_shouldApplyMicroGrace').mockReturnValue(true);
    const pending = app._actuallyUpdateUI();
    // Pausen har startat (200 ms) men inte löst ut.
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await app.onUninit();
    expect(jest.getTimerCount()).toBe(0);
    await expect(pending).resolves.toEqual({ success: false, error: 'lifecycle_ended' });
  });

  test('motfall: utan avstängning löper pausen ut och uppdateringen går vidare', async () => {
    jest.spyOn(app, '_shouldApplyMicroGrace').mockReturnValue(true);
    const processSpy = jest.spyOn(app, '_processUIUpdate').mockResolvedValue({ success: true });
    const pending = app._actuallyUpdateUI();
    await jest.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({ success: true });
    expect(processSpy).toHaveBeenCalledTimes(1);
    await app.onUninit();
    expect(jest.getTimerCount()).toBe(0);
  });
});
