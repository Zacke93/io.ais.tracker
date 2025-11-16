'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

describe('_hasPassedFinalTargetBridge', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
  });

  test('requires Stallbackabron pass when heading north', () => {
    const vessel = {
      mmsi: '9900112',
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Klaffbron', 'Stridsbergsbron'],
      cog: 5,
    };

    expect(app._hasPassedFinalTargetBridge(vessel)).toBe(false);

    vessel.passedBridges.push('Stallbackabron');
    vessel.targetBridge = null;
    vessel._finalTargetBridge = 'Stridsbergsbron';
    vessel._finalTargetDirection = 'north';

    expect(app._hasPassedFinalTargetBridge(vessel)).toBe(true);
  });

  test('requires Olidebron pass when heading south', () => {
    const vessel = {
      mmsi: '9900113',
      targetBridge: 'Klaffbron',
      passedBridges: ['Stridsbergsbron', 'Klaffbron'],
      cog: 200,
    };

    expect(app._hasPassedFinalTargetBridge(vessel)).toBe(false);

    vessel.passedBridges.push('Olidebron');
    vessel.targetBridge = null;
    vessel._finalTargetBridge = 'Klaffbron';
    vessel._finalTargetDirection = 'south';

    expect(app._hasPassedFinalTargetBridge(vessel)).toBe(true);
  });
});
