'use strict';

const CurrentBridgeManager = require('../lib/services/CurrentBridgeManager');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const logger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
};

describe('CurrentBridgeManager radius', () => {
  test('assigns currentBridge when vessel is within 300m', () => {
    const bridgeRegistry = new BridgeRegistry();
    const manager = new CurrentBridgeManager(bridgeRegistry, logger);

    const vessel = { mmsi: 'TEST1', currentBridge: null, distanceToCurrent: null };
    const proximityData = {
      nearestBridge: { name: 'Olidebron', distance: 280 },
      nearestDistance: 280,
    };

    manager.updateCurrentBridge(vessel, proximityData);

    expect(vessel.currentBridge).toBe('Olidebron');
    expect(vessel.distanceToCurrent).toBe(280);
  });
});
