'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * U72 (omgång 9, spår R): fyra sparade kartor saknade tak vid laddning
 * (notisspärren, sista kända positioner, kajboken, inlärda kajplatser), medan
 * öppningsdedupen och besöksminnet har 2048. Vid vanlig trafik begränsas de av
 * sina egna tider, men en skadad inställning med 200 000 färska poster laddades
 * på cirka 2 s och gjorde varje persistering lika stor. Nu läses högst 2048
 * poster, de nyaste behålls och kapningen loggas.
 */
const CAP = 2048;
const N = 3000;
const NOW = Date.parse('2026-11-26T12:00:00Z');

describe('Tak 2048 vid laddning av sparade kartor', () => {
  let store;

  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = {
      settings: {
        get: (k) => (k in store ? store[k] : null),
        set: jest.fn(),
        on: jest.fn(),
      },
    };
    app._persistentRecentTriggers = new Map();
    app._PERSISTENT_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;
    app._PERSISTENT_DEDUP_RETENTION_MS = 6 * 60 * 60 * 1000;
    app._lastKnownPositions = new Map();
    app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * 60 * 1000;
    app._learnedMooringSpots = [];
    app._LEARNED_SPOT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
    app._quayStableLedger = new Map();
    return app;
  }

  const logged = (app, tag) => app.log.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes(tag));
  // Post i: stämpel NOW − (N − i) s, alltså stigande med i; de nyaste är i ≥ N − CAP.
  const stamp = (i) => NOW - (N - i) * 1000;
  const mmsi = (i) => String(230000000 + i);

  beforeEach(() => {
    store = {};
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('notisspärren: de 2048 nyaste läses och kapningen loggas', () => {
    store.persistent_recent_triggers = {};
    for (let i = 0; i < N; i++) store.persistent_recent_triggers[`${mmsi(i)}:Klaffbron`] = { t: stamp(i), dir: 'north' };
    const app = makeApp();
    app._loadPersistentTriggers();
    expect(app._persistentRecentTriggers.size).toBe(CAP);
    expect(app._persistentRecentTriggers.has(`${mmsi(N - 1)}:Klaffbron`)).toBe(true);
    expect(app._persistentRecentTriggers.has(`${mmsi(N - CAP)}:Klaffbron`)).toBe(true);
    expect(app._persistentRecentTriggers.has(`${mmsi(N - CAP - 1)}:Klaffbron`)).toBe(false);
    expect(logged(app, '[PERSISTENT_DEDUP_CAP]')).toHaveLength(1);
    expect(logged(app, '[PERSISTENT_DEDUP_CAP]')[0]).toContain(`${N - CAP} sparade`);
  });

  test('sista kända positioner: de 2048 nyaste läses och kapningen loggas', () => {
    store.last_known_positions = {};
    for (let i = 0; i < N; i++) store.last_known_positions[mmsi(i)] = { lat: 58.28, lon: 12.28, t: stamp(i) };
    const app = makeApp();
    app._loadLastKnownPositions();
    expect(app._lastKnownPositions.size).toBe(CAP);
    expect(app._lastKnownPositions.has(mmsi(N - 1))).toBe(true);
    expect(app._lastKnownPositions.has(mmsi(N - CAP - 1))).toBe(false);
    expect(logged(app, '[LAST_KNOWN_CAP]')).toHaveLength(1);
  });

  test('kajboken: de 2048 nyaste läses och kapningen loggas', () => {
    store.quay_stable_ledger = {};
    for (let i = 0; i < N; i++) store.quay_stable_ledger[mmsi(i)] = { stillAt: stamp(i), lat: 58.27, lon: 12.27 };
    const app = makeApp();
    app._loadQuayLedger();
    expect(app._quayStableLedger.size).toBe(CAP);
    expect(app._quayStableLedger.has(mmsi(N - 1))).toBe(true);
    expect(app._quayStableLedger.has(mmsi(N - CAP - 1))).toBe(false);
    expect(logged(app, '[QUAY_LEDGER_CAP]')).toHaveLength(1);
  });

  test('inlärda kajplatser: de 2048 nyaste läses i ursprunglig ordning och kapningen loggas', () => {
    // Nyast först i listan för att visa att ordningen bevaras.
    store.learned_mooring_spots = [];
    for (let i = N - 1; i >= 0; i--) store.learned_mooring_spots.push({ lat: 58.27 + i * 1e-5, lon: 12.27, t: stamp(i) });
    const app = makeApp();
    app._loadLearnedMooringSpots();
    expect(app._learnedMooringSpots).toHaveLength(CAP);
    expect(app._learnedMooringSpots[0].t).toBe(stamp(N - 1));
    expect(app._learnedMooringSpots[CAP - 1].t).toBe(stamp(N - CAP));
    expect(logged(app, '[MOORING_SPOTS_CAP]')).toHaveLength(1);
  });

  test('motfall: fältets 16 kajplatser och exakt 2048 notisspärrar läses orörda utan kapningsrad', () => {
    store.learned_mooring_spots = [];
    for (let i = 0; i < 16; i++) store.learned_mooring_spots.push({ lat: 58.27 + i * 1e-3, lon: 12.27, t: stamp(i) });
    store.persistent_recent_triggers = {};
    for (let i = 0; i < CAP; i++) store.persistent_recent_triggers[`${mmsi(i)}:Klaffbron`] = { t: stamp(i + N - CAP), dir: 'south' };
    const app = makeApp();
    app._loadLearnedMooringSpots();
    app._loadPersistentTriggers();
    expect(app._learnedMooringSpots).toEqual(store.learned_mooring_spots);
    expect(app._persistentRecentTriggers.size).toBe(CAP);
    expect(app.log.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('_CAP]'))).toHaveLength(0);
  });

  test('motfall: utgångna poster räknas inte mot taket', () => {
    store.last_known_positions = {};
    for (let i = 0; i < N; i++) {
      // Hälften är äldre än 6 h och sorteras bort före taket.
      const t = i % 2 ? NOW - 7 * 60 * 60 * 1000 : stamp(i);
      store.last_known_positions[mmsi(i)] = { lat: 58.28, lon: 12.28, t };
    }
    const app = makeApp();
    app._loadLastKnownPositions();
    expect(app._lastKnownPositions.size).toBe(N / 2);
    expect(logged(app, '[LAST_KNOWN_CAP]')).toHaveLength(0);
  });
});
