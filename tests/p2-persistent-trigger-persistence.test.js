'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * P2 (2026-06-09): _persistentRecentTriggers (2h-dedup för boat_near) var ren
 * in-memory → en app-omstart nollade skyddet och ett fartyg som dröjde sig
 * kvar nära en bro fick garanterat dubbelnotis. Kartan persisteras nu via
 * homey.settings: laddas i onInit (med expiry-filter) och skrivs vid varje
 * mutation.
 */
describe('P2: persistent boat_near-dedup överlever omstart', () => {
  const WINDOW_MS = 2 * 60 * 60 * 1000;
  let app;
  let store;

  function makeApp() {
    const a = new AISBridgeApp();
    a.log = jest.fn();
    a.error = jest.fn();
    a.debug = jest.fn();
    a.homey = {
      settings: {
        get: (k) => store[k],
        set: (k, v) => {
          store[k] = v;
        },
        on: jest.fn(),
      },
    };
    a._persistentRecentTriggers = new Map();
    a._PERSISTENT_DEDUP_WINDOW_MS = WINDOW_MS;
    return a;
  }

  beforeEach(() => {
    store = {};
    app = makeApp();
  });

  test('laddning återställer färska poster och filtrerar utgångna', () => {
    const now = Date.now();
    store.persistent_recent_triggers = {
      '265001111:Klaffbron': now - 60 * 1000, // 1 min gammal → behålls
      '265002222:Stridsbergsbron': now - 3 * 60 * 60 * 1000, // 3h → bort
      '265003333:Olidebron': 'inte-en-timestamp', // korrupt → bort
    };

    app._loadPersistentTriggers();

    expect(app._persistentRecentTriggers.has('265001111:Klaffbron')).toBe(true);
    expect(app._persistentRecentTriggers.has('265002222:Stridsbergsbron')).toBe(false);
    expect(app._persistentRecentTriggers.has('265003333:Olidebron')).toBe(false);
  });

  test('persist skriver hela kartan till settings', () => {
    app._persistentRecentTriggers.set('265001111:Klaffbron', 1234567890);
    app._persistentRecentTriggers.set('265002222:Järnvägsbron', 1234567999);

    app._persistRecentTriggers();

    expect(store.persistent_recent_triggers).toEqual({
      '265001111:Klaffbron': 1234567890,
      '265002222:Järnvägsbron': 1234567999,
    });
  });

  test('roundtrip: persist i instans 1 → load i instans 2 (simulerad omstart)', () => {
    const ts = Date.now() - 5 * 60 * 1000; // notis för 5 min sedan
    // Nytt format 2026-07-02 (ELFKUNGEN): { t, dir } — riktningen gör dedupen
    // resemedveten över omstarter (returresa i motsatt riktning blockeras inte).
    app._persistentRecentTriggers.set('265001111:Klaffbron', { t: ts, dir: 'south' });
    app._persistRecentTriggers();

    const restartedApp = makeApp(); // delar samma settings-store
    restartedApp._loadPersistentTriggers();

    expect(restartedApp._persistentRecentTriggers.get('265001111:Klaffbron')).toEqual({ t: ts, dir: 'south' });
  });

  test('legacy-poster (rena tal) laddas som riktningslösa {t, dir: null}', () => {
    const ts = Date.now() - 5 * 60 * 1000;
    store.persistent_recent_triggers = { '265001111:Klaffbron': ts };

    app._loadPersistentTriggers();

    expect(app._persistentRecentTriggers.get('265001111:Klaffbron')).toEqual({ t: ts, dir: null });
  });

  test('riktningsmedveten dedup: samma riktning blockerar, motsatt släpper igenom (ELFKUNGEN)', () => {
    const ts = Date.now() - 95 * 60 * 1000; // 95 min sedan — inom 2h-fönstret
    app._persistentRecentTriggers.set('265573130:Stridsbergsbron', { t: ts, dir: 'north' });

    // Samma riktning → blockerad
    expect(app._persistentDedupCheck('265573130:Stridsbergsbron', { _routeDirection: 'north' }).blocked).toBe(true);
    // Motsatt riktning (returresan söderut) → NY passage, släpps igenom
    expect(app._persistentDedupCheck('265573130:Stridsbergsbron', { _routeDirection: 'south' }).blocked).toBe(false);
    // Okänd riktning → konservativ blockering
    expect(app._persistentDedupCheck('265573130:Stridsbergsbron', { cog: 90 }).blocked).toBe(true);
    // Riktningslös lagrad post (legacy) → konservativ blockering även vid motsatt riktning
    app._persistentRecentTriggers.set('265999999:Klaffbron', { t: ts, dir: null });
    expect(app._persistentDedupCheck('265999999:Klaffbron', { _routeDirection: 'south' }).blocked).toBe(true);
  });

  test('defensiv: kraschar inte utan settings (testkonstruktioner)', () => {
    app.homey = undefined;
    expect(() => app._loadPersistentTriggers()).not.toThrow();
    expect(() => app._persistRecentTriggers()).not.toThrow();

    app.homey = { settings: { get: jest.fn(), on: jest.fn() } }; // saknar set
    expect(() => app._persistRecentTriggers()).not.toThrow();
  });

  test('tom/saknad lagring ger tom karta utan fel', () => {
    app._loadPersistentTriggers();
    expect(app._persistentRecentTriggers.size).toBe(0);
  });
});
