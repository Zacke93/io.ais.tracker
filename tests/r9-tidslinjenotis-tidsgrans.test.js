'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * U72 (omgång 9, spår R): tidslinjenotisen (homey.notifications.createNotification)
 * saknade tidsgräns. Hängde anropet stod dedupstämpeln kvar, så samma
 * anslutningsvarning var spärrad i 24 h fast ingen notis bevisligen gått ut.
 * Nu gäller flow-kortens mönster: tidsgräns 60 s, stämpeln rullas tillbaka vid
 * tidsgränsen, och ett sent svar stämplar nyckeln om inget nyare försök gjort det.
 */
const KEY = 'aisstream:silent';

describe('Tidslinjenotisen med tidsgräns', () => {
  let app;
  let calls;
  let behaviour;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-26T12:00:00Z') });
    calls = [];
    behaviour = [];
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._runtimeLifecycle = {};
    app._shuttingDown = false;
    app.homey = {
      notifications: {
        createNotification: (n) => {
          calls.push(n.excerpt);
          const next = behaviour.shift() || 'ok';
          if (next === 'häng') return new Promise(() => {});
          if (typeof next === 'object') return next.promise;
          if (next === 'fel') return Promise.reject(new Error('avvisad'));
          return Promise.resolve();
        },
      },
    };
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('ett hängande anrop spärrar inte nästa varning i 24 h', async () => {
    behaviour.push('häng');
    const first = app._notifyConnectionIssue('AIS Tracker: första', KEY);
    await jest.advanceTimersByTimeAsync(61 * 1000);
    await first;
    expect(app._connectionIssueNotifiedAt.has(KEY)).toBe(false);
    expect(app.error.mock.calls.map((c) => c.join(' ')).some((l) => l.includes('svarade inte inom 60 s'))).toBe(true);

    await app._notifyConnectionIssue('AIS Tracker: andra', KEY);
    expect(calls).toEqual(['AIS Tracker: första', 'AIS Tracker: andra']);
    expect(app._connectionIssueNotifiedAt.has(KEY)).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ett sent svar efter tidsgränsen stämplar nyckeln, så samma varning inte går igen', async () => {
    let land;
    behaviour.push({
      promise: new Promise((resolve) => {
        land = resolve;
      }),
    });
    const first = app._notifyConnectionIssue('AIS Tracker: sen', KEY);
    await jest.advanceTimersByTimeAsync(61 * 1000);
    await first;
    expect(app._connectionIssueNotifiedAt.has(KEY)).toBe(false);
    land();
    await jest.advanceTimersByTimeAsync(0);
    expect(app._connectionIssueNotifiedAt.has(KEY)).toBe(true);
    await app._notifyConnectionIssue('AIS Tracker: sen igen', KEY);
    expect(calls).toEqual(['AIS Tracker: sen']);
  });

  test('motfall: en levererad notis spärrar samma nyckel i 24 h', async () => {
    await app._notifyConnectionIssue('AIS Tracker: ett', KEY);
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    await app._notifyConnectionIssue('AIS Tracker: två', KEY);
    expect(calls).toEqual(['AIS Tracker: ett']);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('motfall: ett avvisat anrop rullar tillbaka som förut', async () => {
    behaviour.push('fel');
    await app._notifyConnectionIssue('AIS Tracker: fel', KEY);
    expect(app._connectionIssueNotifiedAt.has(KEY)).toBe(false);
    await app._notifyConnectionIssue('AIS Tracker: igen', KEY);
    expect(calls).toEqual(['AIS Tracker: fel', 'AIS Tracker: igen']);
  });
});
