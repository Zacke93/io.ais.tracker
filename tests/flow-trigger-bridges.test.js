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

describe('Flow trigger bridge selection', () => {
  let originalGetTriggerCard;
  let originalGetConditionCard;
  let originalGetDeviceTriggerCard;
  let originalEnv;
  let originalTestMode;

  beforeEach(() => {
    jest.clearAllMocks();
    originalGetTriggerCard = __mockHomey.flow.getTriggerCard;
    originalGetConditionCard = __mockHomey.flow.getConditionCard;
    originalGetDeviceTriggerCard = __mockHomey.flow.getDeviceTriggerCard;
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    originalTestMode = global.__TEST_MODE__;
    delete global.__TEST_MODE__;
  });

  afterEach(() => {
    __mockHomey.flow.getTriggerCard = originalGetTriggerCard;
    __mockHomey.flow.getConditionCard = originalGetConditionCard;
    __mockHomey.flow.getDeviceTriggerCard = originalGetDeviceTriggerCard;
    process.env.NODE_ENV = originalEnv;
    if (originalTestMode === undefined) {
      delete global.__TEST_MODE__;
    } else {
      global.__TEST_MODE__ = originalTestMode;
    }
  });

  const setupApp = async (options = {}) => {
    const { includeDevice = false } = options;
    const triggerPrototype = originalGetTriggerCard('boat_near').constructor;
    const conditionPrototype = originalGetConditionCard('boat_at_bridge').constructor;

    const triggerCard = new triggerPrototype();
    const conditionCard = new conditionPrototype();

    __mockHomey.flow.getTriggerCard = jest.fn(() => triggerCard);
    __mockHomey.flow.getConditionCard = jest.fn(() => conditionCard);
    __mockHomey.flow.getDeviceTriggerCard = jest.fn(() => null);

    const app = new AISBridgeApp();
    app.homey = __mockHomey;
    app.log = logger.log;
    app.debug = logger.debug;
    app.error = logger.error;

    app.bridgeRegistry = new BridgeRegistry();
    app.proximityService = new ProximityService(app.bridgeRegistry, logger);
    app.vesselDataService = { getAllVessels: jest.fn(() => []) };
    app._triggeredBoatNearKeys = new Set();
    app._devices = new Set();

    if (includeDevice) {
      const device = __mockHomey.createMockDevice();
      device.homey = __mockHomey;
      device.getName = () => 'Bridge Status Test';
      device.triggerBoatNear = jest.fn().mockResolvedValue(undefined);
      app._devices.add(device);
    }

    jest.useFakeTimers();
    app._testTriggerFunctionality = jest.fn().mockResolvedValue(undefined);
    await app._setupFlowCards();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();

    triggerCard.clearTriggerCalls();

    return { app, triggerCard };
  };

  test('triggers flow for intermediate current bridge within 300m', async () => {
    const { app, triggerCard } = await setupApp();
    const olide = constants.BRIDGES.olidebron;

    const vessel = {
      mmsi: 'INT001',
      name: 'Test Intermediate',
      lat: olide.lat - 0.001, // roughly 110m south
      lon: olide.lon,
      sog: 3,
      cog: 15,
      status: 'waiting',
      targetBridge: 'Klaffbron',
      currentBridge: 'Olidebron',
      distanceToCurrent: 110,
      etaMinutes: 8,
    };

    await app._triggerBoatNearFlow(vessel);

    const calls = triggerCard.getTriggerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tokens.bridge_name).toBe('Olidebron');
    expect(calls[0].state.bridge).toBe('olidebron');
    expect(calls[0].tokens.eta_minutes).toBe(8);
  });

  test('triggers flow for target bridge within 300m', async () => {
    const { app, triggerCard } = await setupApp();
    const klaff = constants.BRIDGES.klaffbron;

    const vessel = {
      mmsi: 'TGT001',
      name: 'Target Vessel',
      lat: klaff.lat - 0.001, // roughly 110m south
      lon: klaff.lon,
      sog: 3,
      cog: 205,
      status: 'waiting',
      targetBridge: 'Klaffbron',
      currentBridge: 'Klaffbron',
      distanceToCurrent: 110,
      etaMinutes: 4,
    };

    await app._triggerBoatNearFlow(vessel);

    const calls = triggerCard.getTriggerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tokens.bridge_name).toBe('Klaffbron');
    expect(calls[0].state.bridge).toBe('klaffbron');
    expect(calls[0].tokens.eta_minutes).toBe(4);
  });

  test('fires device-level trigger when bridge status device exists', async () => {
    const { app, triggerCard } = await setupApp({ includeDevice: true });
    const olide = constants.BRIDGES.olidebron;

    const vessel = {
      mmsi: 'INT_DEVICE',
      name: 'Device Vessel',
      lat: olide.lat - 0.001,
      lon: olide.lon,
      sog: 3,
      cog: 15,
      status: 'waiting',
      targetBridge: 'Klaffbron',
      currentBridge: 'Olidebron',
      distanceToCurrent: 110,
      etaMinutes: 8,
    };

    await app._triggerBoatNearFlow(vessel);

    const appCalls = triggerCard.getTriggerCalls();

    expect(appCalls).toHaveLength(1);
    const device = Array.from(app._devices)[0];
    expect(device.triggerBoatNear).toHaveBeenCalledTimes(1);
    expect(device.triggerBoatNear.mock.calls[0][0].bridge_name).toBe('Olidebron');
  });
});
