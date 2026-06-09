'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * P2 end-to-end (2026-06-09): omstart MITT i en pågående resa — det exakta
 * produktionsscenariot som tidigare gav garanterad dubbelnotis. Testet kör
 * den RIKTIGA triggervägen (_triggerBoatNearFlowForBridge) genom hela kedjan:
 * notis → persistens → omstart (ny appinstans, samma settings-store) →
 * laddning → dedupe-spärr.
 */
describe('P2 end-to-end: omstart mitt i resa ger ingen dubbelnotis', () => {
  let store;

  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = {
      settings: {
        get: (k) => store[k],
        set: (k, v) => {
          store[k] = v;
        },
        on: jest.fn(),
      },
    };
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._PERSISTENT_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
    app._loadPersistentTriggers(); // som i onInit
    return app;
  }

  const vessel = {
    mmsi: '265001111', name: 'TESTBÅT', sog: 5.2, cog: 25, _routeDirection: 'north', etaMinutes: 8,
  };
  const klaffbron = {
    name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'target',
  };
  const stridsbergsbron = {
    name: 'Stridsbergsbron', id: 'stridsbergsbron', distance: 280, source: 'target',
  };

  beforeEach(() => {
    store = {};
  });

  test('notis före omstart blockeras efter omstart (samma fartyg+bro)', async () => {
    // --- Före omstart: notisen avfyras och persisteras ---
    const app1 = makeApp();
    await app1._triggerBoatNearFlowForBridge(vessel, klaffbron);
    expect(app1._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    expect(store.persistent_recent_triggers).toHaveProperty('265001111:Klaffbron');

    // --- Omstart: ny appinstans, in-memory-state borta, settings kvar ---
    const app2 = makeApp();
    expect(app2._triggeredBoatNearKeys.size).toBe(0); // session-dedupen är borta
    expect(app2._persistentRecentTriggers.has('265001111:Klaffbron')).toBe(true); // laddad

    // --- Samma fartyg dväljs kvar nära samma bro → INGEN dubbelnotis ---
    await app2._triggerBoatNearFlowForBridge(vessel, klaffbron);
    expect(app2._triggerBoatNearFlowBest).not.toHaveBeenCalled();
  });

  test('annan bro efter omstart blockeras INTE (dedupen är nyckelscopad)', async () => {
    const app1 = makeApp();
    await app1._triggerBoatNearFlowForBridge(vessel, klaffbron);

    const app2 = makeApp();
    await app2._triggerBoatNearFlowForBridge(vessel, stridsbergsbron);
    expect(app2._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1); // notisen får gå
  });

  test('utgången post (>2h) före omstart blockerar inte efter omstart', async () => {
    store.persistent_recent_triggers = {
      '265001111:Klaffbron': Date.now() - 3 * 60 * 60 * 1000, // 3h gammal
    };
    const app = makeApp();
    expect(app._persistentRecentTriggers.has('265001111:Klaffbron')).toBe(false); // expiry-filtrerad
    await app._triggerBoatNearFlowForBridge(vessel, klaffbron);
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('misslyckad trigger rullas tillbaka ÄVEN i persisterat tillstånd', async () => {
    const app = makeApp();
    app._triggerBoatNearFlowBest = jest.fn().mockRejectedValue(new Error('flow error'));
    await app._triggerBoatNearFlowForBridge(vessel, klaffbron);

    // Nyckeln får inte ligga kvar någonstans — annars tystas failsafe i 2h
    expect(app._triggeredBoatNearKeys.has('265001111:Klaffbron')).toBe(false);
    expect(app._persistentRecentTriggers.has('265001111:Klaffbron')).toBe(false);
    expect(store.persistent_recent_triggers || {}).not.toHaveProperty('265001111:Klaffbron');

    // ...så att retry efter omstart fungerar
    const app2 = makeApp();
    await app2._triggerBoatNearFlowForBridge(vessel, klaffbron);
    expect(app2._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });
});
