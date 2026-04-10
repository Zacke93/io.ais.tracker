'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

describe('Proximity-based flow trigger in _onVesselUpdated', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
    app._analyzeVesselPosition = jest.fn().mockResolvedValue(undefined);
    app._triggerBoatNearFlow = jest.fn().mockResolvedValue(undefined);
    app._updateUIIfNeeded = jest.fn();
    app.statusService = {
      clearVesselETAHistory: jest.fn(),
    };
  });

  test('triggers flow for vessel with currentBridge', async () => {
    const vessel = {
      mmsi: '265517000',
      currentBridge: 'Järnvägsbron',
      targetBridge: null,
      status: 'approaching',
    };

    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });

    expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
    expect(app._triggerBoatNearFlow).toHaveBeenCalledWith(vessel);
  });

  test('triggers flow for vessel with targetBridge', async () => {
    const vessel = {
      mmsi: '265517000',
      currentBridge: null,
      targetBridge: 'Klaffbron',
      status: 'approaching',
    };

    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });

    expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
    expect(app._triggerBoatNearFlow).toHaveBeenCalledWith(vessel);
  });

  test('does not trigger flow without currentBridge or targetBridge', async () => {
    const vessel = {
      mmsi: '265517000',
      currentBridge: null,
      targetBridge: null,
    };

    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });

    expect(app._triggerBoatNearFlow).not.toHaveBeenCalled();
  });

  test('dedup prevents duplicate triggers across updates', async () => {
    const vessel = {
      mmsi: '265517000',
      currentBridge: 'Järnvägsbron',
      targetBridge: 'Stridsbergsbron',
      status: 'approaching',
    };

    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: null });
    await app._onVesselUpdated({ mmsi: vessel.mmsi, vessel, oldVessel: vessel });

    // _triggerBoatNearFlow is called twice (once per update),
    // but internally the real implementation deduplicates via _triggeredBoatNearKeys.
    // Here we verify the guard condition lets both calls through.
    expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(2);
  });

  test('trigger cleared on passed status via _onVesselStatusChanged', async () => {
    app._clearBoatNearTriggers = jest.fn();
    app._hasPassedFinalTargetBridge = jest.fn().mockReturnValue(false);
    app._vesselRemovalTimers = new Map();
    app._updateUI = jest.fn();
    app.vesselDataService = { removeVessel: jest.fn(), getVessel: jest.fn(() => null) };

    const vessel = {
      mmsi: '265517000',
      targetBridge: 'Stridsbergsbron',
      // BUG 10: passedBridges must be empty for clearing to happen.
      // Active journeys (passedBridges.length > 0) preserve dedup keys.
      passedBridges: [],
      _finalTargetBridge: null,
    };

    await app._onVesselStatusChanged({
      vessel,
      oldStatus: 'waiting',
      newStatus: 'passed',
      reason: 'unit-test',
    });

    expect(app._clearBoatNearTriggers).toHaveBeenCalledWith(vessel);

    // Clean up removal timer to prevent open handle warning
    for (const timerId of app._vesselRemovalTimers.values()) {
      clearTimeout(timerId);
    }
  });
});
