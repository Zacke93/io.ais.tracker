'use strict';

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const constants = require('../lib/constants');

describe('ProgressiveETA - waiting clamp', () => {
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
  };

  const calculator = new ProgressiveETACalculator(logger, new BridgeRegistry());

  const baseVessel = {
    mmsi: 'WAIT001',
    targetBridge: 'Stridsbergsbron',
    status: 'waiting',
    lat: constants.BRIDGES.stridsbergsbron.lat - 0.001, // ~110m south
    lon: constants.BRIDGES.stridsbergsbron.lon,
    sog: 2,
  };

  const proximityAtTarget = {
    nearestBridge: { id: 'stridsbergsbron', distance: 120 },
    nearestDistance: 120,
  };

  test('ETA does not increase while vessel remains waiting', () => {
    // Initial calculation with reasonable speed
    const firstEta = calculator.calculateProgressiveETA({ ...baseVessel }, proximityAtTarget);
    expect(firstEta).toBeGreaterThan(0);

    // Second calculation with much slower speed (raw ETA would spike)
    const slowVessel = {
      ...baseVessel,
      sog: 0.2,
    };
    const secondEta = calculator.calculateProgressiveETA(slowVessel, proximityAtTarget);

    expect(secondEta).toBeLessThanOrEqual(firstEta);
    expect(secondEta).toBeLessThanOrEqual(constants.WAITING_STATUS_MAX_ETA_MINUTES);
  });
});
