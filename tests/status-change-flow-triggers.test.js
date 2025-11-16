'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

describe('_onVesselStatusChanged flow triggers', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
    app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);
    app._clearBoatNearTriggers = jest.fn();
    app._updateUI = jest.fn();
    app.vesselDataService = { removeVessel: jest.fn(), getVessel: jest.fn(() => null) };
  });

  test('triggers boat_near for stallbacka-waiting status', async () => {
    const vessel = {
      mmsi: '24681012',
      targetBridge: 'Stridsbergsbron',
      passedBridges: [],
      _finalTargetBridge: null,
    };

    await app._onVesselStatusChanged({
      vessel,
      oldStatus: 'approaching',
      newStatus: 'stallbacka-waiting',
      reason: 'unit-test',
    });

    expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
  });
});
