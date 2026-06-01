'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * F34: huvud-proximity-vägen (_triggerBoatNearFlowForBridge) läste tidigare bara
 * session-Set:en (_triggeredBoatNearKeys), inte den persistenta 2h-mappen. Vid
 * STALE_AIS-removal tömps session-Set:en men persistent lever kvar → en vessel
 * som återskapas inom 2h fick DUBBELNOTIS. Huvudvägen läser nu persistent-mappen.
 *
 * SÄKERHETSKRAV (mot missade notiser): en äkta NEW_JOURNEY rensar persistent-
 * mappen via _clearBoatNearTriggers(vessel, true), så en legitim ny resa kan
 * notifiera samma broar igen.
 */
const makeApp = () => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._getDirectionString = jest.fn(() => 'norrut');
  app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
  return app;
};

const candidate = {
  name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'target',
};
const vessel = {
  mmsi: '555', name: 'TestBåt', sog: 5, etaMinutes: 4,
};

describe('F34: persistent dedupe i huvud-proximityvägen', () => {
  test('första trigger fyrar och sätter både session + persistent', async () => {
    const app = makeApp();
    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    expect(app._triggeredBoatNearKeys.has('555:Klaffbron')).toBe(true);
    expect(app._persistentRecentTriggers.has('555:Klaffbron')).toBe(true);
  });

  test('REGRESSION F34: återskapad vessel (session-Set tömd) blockeras av persistent → ingen dubbelnotis', async () => {
    const app = makeApp();
    // Simulera tidigare resa: persistent-nyckel satt, men session-Set tömd
    // (som efter STALE_AIS-removal + återskapning).
    app._persistentRecentTriggers.set('555:Klaffbron', Date.now() - 60000); // 1 min sedan

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    // Får INTE fyra igen
    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
  });

  test('SÄKERHET: NEW_JOURNEY-rensning (clearPersistent=true) släpper igenom igen', async () => {
    const app = makeApp();
    app._persistentRecentTriggers.set('555:Klaffbron', Date.now() - 60000);

    // Ny resa rensar persistent för fartyget
    app._clearBoatNearTriggers(vessel, true);
    expect(app._persistentRecentTriggers.has('555:Klaffbron')).toBe(false);

    // Nu ska notisen kunna fyra igen
    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('SÄKERHET: ordinarie rensning (clearPersistent=false) bevarar persistent', () => {
    const app = makeApp();
    app._persistentRecentTriggers.set('555:Klaffbron', Date.now());
    app._triggeredBoatNearKeys.add('555:Klaffbron');

    // Default-rensning (under pågående resa) ska INTE röra persistent
    app._clearBoatNearTriggers(vessel);
    expect(app._triggeredBoatNearKeys.has('555:Klaffbron')).toBe(false);
    expect(app._persistentRecentTriggers.has('555:Klaffbron')).toBe(true);
  });

  test('utgången persistent-nyckel (>2h) blockerar inte', async () => {
    const app = makeApp();
    app._persistentRecentTriggers.set('555:Klaffbron', Date.now() - (3 * 60 * 60 * 1000)); // 3h

    await app._triggerBoatNearFlowForBridge(vessel, candidate);
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });
});
