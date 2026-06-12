'use strict';

/**
 * RC-S-härdning ur verifieringskörningen 2026-06-11 (docs: bug-audit §status):
 * RC-S1: stabilitetströskel 120 s — flappande server (30-50s-liv) får inte
 *        nollställa backoff-räknaren (503-stormen gav 22 försök på 22 min)
 * RC-S2: exponentiell feed-watchdog-backoff vid ihållande tystnad (20→40→80
 *        →120 min tak; nollställs av färsk data)
 * RC-S3: rörelsebevis krävs även i proximity-notisvägen (source=current
 *        kringgick målbro-gaten — kajliggar-klassen på okänd plats)
 */

jest.mock('homey');

const AISBridgeApp = require('../app');
const AISStreamClient = require('../lib/connection/AISStreamClient');

const MIN = 60 * 1000;

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('RC-S1: backoff-räknaren nollställs först efter 120 s stabil drift', () => {
  function makeClient() {
    return new AISStreamClient({ log: jest.fn(), error: jest.fn(), debug: jest.fn() });
  }

  test('anslutning som lever 50 s behåller räknaren (flap-skydd)', () => {
    jest.useFakeTimers();
    const client = makeClient();
    client.reconnectAttempts = 5;
    client.ws = {};
    client._onOpen(); // startar stabilitetstimern

    jest.advanceTimersByTime(50 * 1000);
    client.isConnected = false; // anslutningen dog vid 50 s
    jest.advanceTimersByTime(120 * 1000); // timern fyrar men isConnected=false

    expect(client.reconnectAttempts).toBe(5); // INTE nollställd
    client._clearTimers();
  });

  test('anslutning som lever 120 s nollställer räknaren', () => {
    jest.useFakeTimers();
    const client = makeClient();
    client.reconnectAttempts = 5;
    client.ws = {};
    client._onOpen();

    jest.advanceTimersByTime(121 * 1000); // stabil hela vägen

    expect(client.reconnectAttempts).toBe(0);
    client._clearTimers();
  });
});

describe('RC-S2: exponentiell watchdog-backoff vid tyst kanal', () => {
  function makeApp({ uptimeMin }) {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = { settings: { get: () => 'KEY', on: jest.fn() } };
    app.aisClient = {
      isConnected: true,
      getConnectionStats: jest.fn().mockReturnValue({ timeSinceLastMessage: null, uptime: uptimeMin * MIN }),
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
    };
    return app;
  }

  test('strike 1 vid 20 min; strike 2 kräver 40 min; färsk data nollställer', () => {
    const app = makeApp({ uptimeMin: 21 });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledTimes(1);
    expect(app._feedWatchdogStrikes).toBe(1);

    // Efter omanslutning: uptime 21 min igen — under nya tröskeln 40 min → INGEN avfyrning
    app.aisClient.getConnectionStats.mockReturnValue({ timeSinceLastMessage: null, uptime: 21 * MIN });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledTimes(1);

    // 41 min tystnad → strike 2
    app.aisClient.getConnectionStats.mockReturnValue({ timeSinceLastMessage: null, uptime: 41 * MIN });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledTimes(2);
    expect(app._feedWatchdogStrikes).toBe(2);

    // Färsk data (2 min sedan) → nollställning
    app.aisClient.getConnectionStats.mockReturnValue({ timeSinceLastMessage: 2 * MIN, uptime: 90 * MIN });
    app._checkAISFeedHealth();
    expect(app._feedWatchdogStrikes).toBe(0);
  });

  test('tröskeln tak-begränsas till 120 min', () => {
    const app = makeApp({ uptimeMin: 119 });
    app._feedWatchdogStrikes = 5; // 20·2^5 = 640 min utan tak
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled(); // 119 < 120

    app.aisClient.getConnectionStats.mockReturnValue({ timeSinceLastMessage: null, uptime: 121 * MIN });
    app._checkAISFeedHealth();
    expect(app.aisClient.reconnectWithKey).toHaveBeenCalledTimes(1); // taket nått
  });
});

describe('RC-S3: rörelsebevis krävs i proximity-notisvägen', () => {
  // _triggerBoatNearFlow kortsluter i test-läge — stäng av det här
  // (samma teknik som replay-harnessen) så gaten faktiskt nås.
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;
  });
  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = true;
  });

  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._boatNearTrigger = {};
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app._findEligibleBridgesSpy = null;
    return app;
  }

  test('obevisad stillastående båt → notisvägen avbryts direkt', async () => {
    const app = makeApp();
    const vessel = {
      mmsi: '219028819', sog: 0.1, _hasMovementProof: false, _moored: false,
    };
    await app._triggerBoatNearFlow(vessel);
    // Gaten loggar skip och inget mer händer (ingen krasch, inga kandidater)
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('No movement proof yet'));
  });

  test('båt med rörelsebevis passerar gaten', async () => {
    const app = makeApp();
    const vessel = {
      mmsi: '219028819', sog: 0.1, _hasMovementProof: true, _moored: false, lat: 58.29, lon: 12.29, targetBridge: null, status: 'waiting',
    };
    await app._triggerBoatNearFlow(vessel);
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('No movement proof yet'));
  });

  test('båt i rörelse (sog ≥ 0.5) passerar utan persisterat bevis', async () => {
    const app = makeApp();
    const vessel = {
      mmsi: '219028819', sog: 4.5, _hasMovementProof: false, _moored: false, lat: 58.29, lon: 12.29, targetBridge: null, status: 'en-route',
    };
    await app._triggerBoatNearFlow(vessel);
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('No movement proof yet'));
  });
});
