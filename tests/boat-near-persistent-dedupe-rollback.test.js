'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * F6 (HÖG): vid misslyckad boat_near-trigger rensade catch ENDAST session-nyckeln,
 * inte den persistenta 2h-nyckeln. En notis som aldrig levererades markerades då
 * som "nyligen skickad" och tystade failsafe-skyddsnätet i upp till 2 timmar.
 */
describe('F6: misslyckad boat_near-trigger rensar BÅDE session- och persistent-dedupe', () => {
  test('persistent-nyckeln rensas i catch (skyddsnätet tystas inte i 2h)', async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();

    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._getDirectionString = jest.fn(() => 'norrut');
    app._triggerBoatNearFlowBest = jest.fn().mockRejectedValue(new Error('flow failed'));

    const vessel = {
      mmsi: '555', name: 'TestBåt', sog: 5, etaMinutes: 4,
    };
    const candidate = {
      name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'test',
    };

    await app._triggerBoatNearFlowForBridge(vessel, candidate);

    const key = '555:Klaffbron';
    expect(app._triggeredBoatNearKeys.has(key)).toBe(false);
    expect(app._persistentRecentTriggers.has(key)).toBe(false);
  });
});
