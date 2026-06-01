'use strict';

jest.mock('homey');

const { __mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const constants = require('../lib/constants');

const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };

/**
 * F36: boat_at_bridge-villkoret för "Kanalinfarten" kunde aldrig bli sant.
 * Kanalinfarten är ett giltigt dropdown-val (boat_at_bridge.json) och finns i
 * BRIDGE_ID_TO_NAME, men condition-listenern letade bara i proximityData.bridges
 * som inte innehåller trigger-punkter. Fixen speglar notis-vägen och beräknar
 * avståndet direkt mot TRIGGER_POINTS.
 */
describe('F36: boat_at_bridge condition matchar Kanalinfarten', () => {
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
    const ConditionPrototype = originalGetConditionCard('boat_at_bridge').constructor;
    const TriggerPrototype = originalGetTriggerCard('boat_near').constructor;
    const conditionCard = new ConditionPrototype();
    const triggerCard = new TriggerPrototype();
    __mockHomey.flow.getConditionCard = jest.fn(() => conditionCard);
    __mockHomey.flow.getTriggerCard = jest.fn(() => triggerCard);

    const app = new AISBridgeApp();
    app.homey = __mockHomey;
    app.log = logger.log;
    app.debug = logger.debug;
    app.error = logger.error;

    const bridgeRegistry = new BridgeRegistry();
    app.bridgeRegistry = bridgeRegistry;
    app.vesselDataService = { getAllVessels: jest.fn(() => vesselFactory()) };
    app.proximityService = new ProximityService(bridgeRegistry, logger);

    await app._setupFlowCards();
    return { conditionCard };
  };

  test('vessel inom 300m från Kanalinfarten → true (via TRIGGER_POINTS-fallback)', async () => {
    const tp = constants.TRIGGER_POINTS.kanalinfarten;
    const { conditionCard } = await setupAppWithMocks(() => [{
      mmsi: 'KAN001',
      lat: tp.lat + 0.0009, // ~100m norr
      lon: tp.lon,
      sog: 3,
      status: 'approaching',
    }]);

    const listener = conditionCard.runListeners[0];
    expect(await listener({ bridge: 'kanalinfarten' })).toBe(true);
  });

  test('vessel långt från Kanalinfarten → false', async () => {
    const tp = constants.TRIGGER_POINTS.kanalinfarten;
    const { conditionCard } = await setupAppWithMocks(() => [{
      mmsi: 'KAN002',
      lat: tp.lat + 0.01, // ~1100m
      lon: tp.lon,
      sog: 3,
      status: 'en-route',
    }]);

    const listener = conditionCard.runListeners[0];
    expect(await listener({ bridge: 'kanalinfarten' })).toBe(false);
  });

  test('riktig bro (Klaffbron) fungerar fortfarande via proximity', async () => {
    const klaff = constants.BRIDGES.klaffbron;
    const { conditionCard } = await setupAppWithMocks(() => [{
      mmsi: 'KAN003',
      lat: klaff.lat - 0.001,
      lon: klaff.lon,
      sog: 2,
      status: 'approaching',
    }]);

    const listener = conditionCard.runListeners[0];
    expect(await listener({ bridge: 'klaffbron' })).toBe(true);
  });
});
