'use strict';

jest.mock('homey');

const { __mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const constants = require('../lib/constants');

const logger = {
  debug: jest.fn(),
  log: jest.fn(),
  error: jest.fn(),
};

describe('Flow condition argument handling', () => {
  let originalGetConditionCard;
  let originalGetTriggerCard;

  beforeEach(() => {
    jest.clearAllMocks();
    originalGetConditionCard = __mockHomey.flow.getConditionCard;
    originalGetTriggerCard = __mockHomey.flow.getTriggerCard;
  });

  afterEach(() => {
    __mockHomey.flow.getConditionCard = originalGetConditionCard;
    __mockHomey.flow.getTriggerCard = originalGetTriggerCard;
  });

  const setupAppWithMocks = async (vesselFactory) => {
    const conditionPrototype = originalGetConditionCard('boat_at_bridge').constructor;
    const triggerPrototype = originalGetTriggerCard('boat_near').constructor;
    const conditionCard = new conditionPrototype();
    const triggerCard = new triggerPrototype();

    __mockHomey.flow.getConditionCard = jest.fn(() => conditionCard);
    __mockHomey.flow.getTriggerCard = jest.fn(() => triggerCard);

    const app = new AISBridgeApp();
    app.homey = __mockHomey;
    app.log = logger.log;
    app.debug = logger.debug;
    app.error = logger.error;

    const bridgeRegistry = new BridgeRegistry();
    app.bridgeRegistry = bridgeRegistry;
    app.vesselDataService = {
      getAllVessels: jest.fn(() => vesselFactory()),
    };
    app.proximityService = new ProximityService(bridgeRegistry, logger);

    await app._setupFlowCards();
    return { app, conditionCard };
  };

  test('condition accepts dropdown object argument', async () => {
    const klaff = constants.BRIDGES.klaffbron;
    const { conditionCard } = await setupAppWithMocks(() => [{
      mmsi: 'COND001',
      lat: klaff.lat - 0.001,
      lon: klaff.lon,
      sog: 2,
      status: 'approaching',
    }]);

    expect(conditionCard.runListeners.length).toBeGreaterThan(0);
    const listener = conditionCard.runListeners[0];

    const result = await listener({ bridge: { id: 'klaffbron' } });
    expect(result).toBe(true);
  });

  test('condition accepts bridge id string argument', async () => {
    const strids = constants.BRIDGES.stridsbergsbron;
    const { conditionCard } = await setupAppWithMocks(() => [{
      mmsi: 'COND002',
      lat: strids.lat - 0.001,
      lon: strids.lon,
      sog: 2,
      status: 'approaching',
    }]);

    const listener = conditionCard.runListeners[0];
    const result = await listener({ bridge: 'stridsbergsbron' });
    expect(result).toBe(true);
  });
});
