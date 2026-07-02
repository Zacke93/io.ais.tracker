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
  let originalEnv;
  let originalTestMode;

  beforeEach(() => {
    jest.clearAllMocks();
    originalGetTriggerCard = __mockHomey.flow.getTriggerCard;
    originalGetConditionCard = __mockHomey.flow.getConditionCard;
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    originalTestMode = global.__TEST_MODE__;
    delete global.__TEST_MODE__;
  });

  afterEach(() => {
    __mockHomey.flow.getTriggerCard = originalGetTriggerCard;
    __mockHomey.flow.getConditionCard = originalGetConditionCard;
    process.env.NODE_ENV = originalEnv;
    if (originalTestMode === undefined) {
      delete global.__TEST_MODE__;
    } else {
      global.__TEST_MODE__ = originalTestMode;
    }
  });

  const setupApp = async () => {
    const TriggerPrototype = originalGetTriggerCard('boat_near').constructor;
    const ConditionPrototype = originalGetConditionCard('boat_at_bridge').constructor;

    const triggerCard = new TriggerPrototype();
    const conditionCard = new ConditionPrototype();

    __mockHomey.flow.getTriggerCard = jest.fn(() => triggerCard);
    __mockHomey.flow.getConditionCard = jest.fn(() => conditionCard);

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
    // Token-ETA-fix (2026-06-01, replay-validering): en notis om en MELLANBRO
    // (Olidebron, source=current) ska INTE ärva vessel.etaMinutes (=8, ETA till
    // MÅLbron Klaffbron). Den ska visa ETA till den NOTIFIERADE bron: 110 m vid
    // 3 knop (~1.54 m/s) ≈ 1 min. Det gamla värdet 8 var den bugg som fixen
    // åtgärdar (vilseledande ETA till fel bro i notisen).
    expect(calls[0].tokens.eta_minutes).toBe(1);
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

  test('triggers BOTH target and current when within 300m of both (Fix 7)', async () => {
    // Fix 7: when target (Stridsbergsbron) and current (Järnvägsbron) are
    // both within 300m and are different bridges, both should fire. The
    // 300m proximity-zones overlap geographically (the bridges are ~260m
    // apart), so a vessel between them is legitimately in both zones.
    // Without this fix, the EKEN scenario (production log 2026-04-26)
    // silently dropped Stridsbergsbron's notification.
    const { app, triggerCard } = await setupApp();

    const vessel = {
      mmsi: 'V123',
      name: 'Priority Vessel',
      lat: 58.2925,
      lon: 12.2935,
      sog: 2,
      cog: 200,
      status: 'waiting',
      targetBridge: 'Stridsbergsbron',
      currentBridge: 'Järnvägsbron',
      distanceToCurrent: 150,
      etaMinutes: 6,
    };

    const proximityMock = {
      bridges: [
        { name: 'Stridsbergsbron', distance: 140 },
        { name: 'Järnvägsbron', distance: 150 },
      ],
      nearestBridge: { name: 'Järnvägsbron', distance: 150 },
    };

    jest.spyOn(app.proximityService, 'analyzeVesselProximity').mockReturnValue(proximityMock);

    await app._triggerBoatNearFlow(vessel);

    const calls = triggerCard.getTriggerCalls();
    // Both target and current trigger; dedup keys are independent per bridge
    expect(calls).toHaveLength(2);
    const bridgeNames = calls.map((c) => c.tokens.bridge_name).sort();
    expect(bridgeNames).toEqual(['Järnvägsbron', 'Stridsbergsbron']);
  });

  test('F5: stale vessel data (old AIS receipt) does NOT fire a notification', async () => {
    const { app, triggerCard } = await setupApp();
    const klaff = constants.BRIDGES.klaffbron;

    const vessel = {
      mmsi: 'STALE01',
      name: 'Stale Vessel',
      lat: klaff.lat - 0.001,
      lon: klaff.lon,
      sog: 3,
      cog: 205,
      status: 'waiting',
      targetBridge: 'Klaffbron',
      currentBridge: 'Klaffbron',
      distanceToCurrent: 110,
      etaMinutes: 4,
      // Last AIS received 20 minutes ago → exceeds stale threshold
      timestamp: Date.now() - (20 * 60 * 1000),
    };

    await app._triggerBoatNearFlow(vessel);

    expect(triggerCard.getTriggerCalls()).toHaveLength(0);
  });

  test('F5: fresh AIS receipt still fires normally', async () => {
    const { app, triggerCard } = await setupApp();
    const klaff = constants.BRIDGES.klaffbron;

    const vessel = {
      mmsi: 'FRESH01',
      name: 'Fresh Vessel',
      lat: klaff.lat - 0.001,
      lon: klaff.lon,
      sog: 3,
      cog: 205,
      status: 'waiting',
      targetBridge: 'Klaffbron',
      currentBridge: 'Klaffbron',
      distanceToCurrent: 110,
      etaMinutes: 4,
      timestamp: Date.now(), // fresh
    };

    await app._triggerBoatNearFlow(vessel);

    expect(triggerCard.getTriggerCalls()).toHaveLength(1);
    expect(triggerCard.getTriggerCalls()[0].tokens.bridge_name).toBe('Klaffbron');
  });

  test('"Any bridge" flow triggar vid VARJE bro (användarbeslut 2026-07-02)', async () => {
    const { app, triggerCard } = await setupApp();
    const runListener = triggerCard.runListeners[0];
    app._triggeredBoatNearKeys = new Set();
    const anyArgs = { bridge: 'any' };

    // F7-gaten (en gång per resa) ERSATT: "alla broar" ska matcha varje
    // avfyrad trigger. Dedup sker uppströms per mmsi:bro, så varje anrop
    // hit är redan en unik per-bro-händelse — max en notis per bro/resa.
    expect(await runListener(anyArgs, { bridge: 'klaffbron', mmsi: '555' })).toBe(true);
    expect(await runListener(anyArgs, { bridge: 'jarnvagsbron', mmsi: '555' })).toBe(true);
    expect(await runListener(anyArgs, { bridge: 'stridsbergsbron', mmsi: '555' })).toBe(true);
    // Andra fartyg fungerar oberoende
    expect(await runListener(anyArgs, { bridge: 'klaffbron', mmsi: '999' })).toBe(true);
    // A specific-bridge flow is unaffected by the "any" semantics
    expect(await runListener({ bridge: 'klaffbron' }, { bridge: 'klaffbron', mmsi: '777' })).toBe(true);
    expect(await runListener({ bridge: 'klaffbron' }, { bridge: 'jarnvagsbron', mmsi: '777' })).toBe(false);
  });
});
