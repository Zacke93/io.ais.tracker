'use strict';

jest.mock('homey');

const fs = require('fs');
const path = require('path');
const { __mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const AISStreamClient = require('../lib/connection/AISStreamClient');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProximityService = require('../lib/services/ProximityService');
const constants = require('../lib/constants');

/**
 * ChatGPT-granskningen 2026-07-10: extern granskning levererade 22 påståenden;
 * 11 Opus-max-granskare + dirigenten verifierade dem mot kod/officiella källor.
 * Denna fil låser de bekräftade fixarna:
 *
 *   D1 — serverfel klassificeras (auth vs övrigt) + socketen rivs (reconnect-vägen)
 *   E1 — Valid === false-rapporter avvisas (strikt: undefined får ALDRIG tappas)
 *   F1 — prenumerations-bbox från constants (SSOT); sydgränsen täcker exit-zonen
 *   G1 — eta_available-token (additiv; eta_minutes=-1-semantiken OFÖRÄNDRAD)
 *   G2 — boat_at_bridge speglar behörighetsgater; "any" täcker MEDVETET INTE
 *        Kanalinfarten (användarbeslut 2026-07-10 — endast specifika valet)
 *   G3 — bridge_text-capability är read-only (setable: false)
 *   I1 — device-init-fel ⇒ unavailable-flagga som självläker via push-vägen
 *   J1 — anslutningsnotisens 24h-dedupe rullas tillbaka vid misslyckad leverans
 */

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

// =============================================================================
// D1: felklassificering + socketrivning i AISStreamClient
// =============================================================================
describe('D1: serverfel klassificeras och river socketen', () => {
  test('nyckelrelaterat fel → auth-error (inte server-error)', () => {
    const client = new AISStreamClient(makeLogger());
    const auth = jest.fn();
    const server = jest.fn();
    client.on('auth-error', auth);
    client.on('server-error', server);

    client._onMessage(JSON.stringify({ error: 'Api Key Is Not Valid' }));

    expect(auth).toHaveBeenCalledWith('Api Key Is Not Valid');
    expect(server).not.toHaveBeenCalled();
  });

  test('icke-nyckelrelaterat fel → server-error (inte auth-error)', () => {
    const client = new AISStreamClient(makeLogger());
    const auth = jest.fn();
    const server = jest.fn();
    client.on('auth-error', auth);
    client.on('server-error', server);

    client._onMessage(JSON.stringify({ error: 'Too many requests, slow down' }));

    expect(server).toHaveBeenCalledWith('Too many requests, slow down');
    expect(auth).not.toHaveBeenCalled();
  });

  test('andra rundan: "Bounding Box Is Not Valid" → server-error (fristående "not valid" räcker inte för auth)', () => {
    const client = new AISStreamClient(makeLogger());
    const auth = jest.fn();
    const server = jest.fn();
    client.on('auth-error', auth);
    client.on('server-error', server);

    client._onMessage(JSON.stringify({ error: 'Bounding Box Is Not Valid' }));

    expect(server).toHaveBeenCalledWith('Bounding Box Is Not Valid');
    expect(auth).not.toHaveBeenCalled();
  });

  test('serverfel med live socket → terminate (close→reconnect-vägen äger övergången)', () => {
    const client = new AISStreamClient(makeLogger());
    client.on('server-error', () => {});
    client.ws = { terminate: jest.fn() };

    client._onMessage(JSON.stringify({ error: 'throttled' }));

    expect(client.ws.terminate).toHaveBeenCalledTimes(1);
  });

  test('serverfel utan socket (enhetstestläge) kraschar inte', () => {
    const client = new AISStreamClient(makeLogger());
    client.on('server-error', () => {});
    client.ws = null;
    expect(() => client._onMessage(JSON.stringify({ error: 'oops' }))).not.toThrow();
  });

  test('app.js: server-error → neutral notis (INTE nyckelrådet)', () => {
    const app = new AISBridgeApp();
    app.error = jest.fn();
    app._notifyConnectionIssue = jest.fn().mockResolvedValue(undefined);

    app._onAISServerError('server exploded');

    expect(app._notifyConnectionIssue).toHaveBeenCalledTimes(1);
    const message = app._notifyConnectionIssue.mock.calls[0][0];
    expect(message).not.toMatch(/nyckel/i);
  });
});

// =============================================================================
// E1: Valid === false avvisas — strikt, undefined släpps igenom
// =============================================================================
describe('E1: Valid-fältet i positionsrapporter', () => {
  const positionReport = (validField) => {
    const body = {
      MMSI: 265001111, Latitude: 58.29, Longitude: 12.29, Sog: 5, Cog: 25,
    };
    if (validField !== undefined) body.Valid = validField;
    return JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 265001111, Latitude: 58.29, Longitude: 12.29 },
      Message: { PositionReport: body },
    });
  };

  test('Valid: false → avvisas (ingen ais-message)', () => {
    const client = new AISStreamClient(makeLogger());
    const emitted = [];
    client.on('ais-message', (d) => emitted.push(d));
    client._onMessage(positionReport(false));
    expect(emitted).toHaveLength(0);
  });

  test('Valid: true → släpps igenom', () => {
    const client = new AISStreamClient(makeLogger());
    const emitted = [];
    client.on('ais-message', (d) => emitted.push(d));
    client._onMessage(positionReport(true));
    expect(emitted).toHaveLength(1);
  });

  test('Valid saknas (replay-/äldre format) → släpps igenom — får ALDRIG tappas', () => {
    const client = new AISStreamClient(makeLogger());
    const emitted = [];
    client.on('ais-message', (d) => emitted.push(d));
    client._onMessage(positionReport(undefined));
    expect(emitted).toHaveLength(1);
  });
});

// =============================================================================
// F1: bounding box som SSOT — prenumerationen täcker exit-trösklarna
// =============================================================================
describe('F1: prenumerations-bbox från constants täcker exit-zonerna', () => {
  // Trösklarna är modul-lokala i VesselLifecycleManager.js — speglas här.
  const KANALINFARTEN_EXIT_LAT = 58.2653;
  const STALLBACKABRON_EXIT_LAT = 58.3141;

  test('constants-boxen omsluter båda journey-completion-trösklarna', () => {
    const box = constants.AIS_CONFIG.BOUNDING_BOX;
    expect(box.SOUTH).toBeLessThan(KANALINFARTEN_EXIT_LAT);
    expect(box.NORTH).toBeGreaterThan(STALLBACKABRON_EXIT_LAT);
  });

  test('_subscribe skickar exakt constants-boxen (ingen hårdkodad kopia)', () => {
    const client = new AISStreamClient(makeLogger());
    client.apiKey = 'test-key';
    client.ws = { readyState: 1, send: jest.fn() }; // 1 === WebSocket.OPEN

    client._subscribe();

    expect(client.ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(client.ws.send.mock.calls[0][0]);
    const {
      NORTH, SOUTH, EAST, WEST,
    } = constants.AIS_CONFIG.BOUNDING_BOX;
    expect(sent.BoundingBoxes).toEqual([[[NORTH, WEST], [SOUTH, EAST]]]);
  });
});

// =============================================================================
// G1: eta_available-token — additiv, -1-semantiken orörd
// =============================================================================
describe('G1: eta_available-token i boat_near', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._getDirectionString = jest.fn(() => 'norrut');
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
    return app;
  };
  const candidate = {
    name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'target',
  };

  test('känd ETA → eta_available=true och eta_minutes >= 0', async () => {
    const app = makeApp();
    await app._triggerBoatNearFlowForBridge({
      mmsi: '555', name: 'TestBåt', sog: 5, etaMinutes: 4,
    }, candidate);

    const tokens = app._triggerBoatNearFlowBest.mock.calls[0][0];
    expect(tokens.eta_available).toBe(true);
    expect(tokens.eta_minutes).toBeGreaterThanOrEqual(0);
  });

  test('okänd ETA → eta_minutes=-1 (OFÖRÄNDRAD sentinel) och eta_available=false', async () => {
    const app = makeApp();
    await app._triggerBoatNearFlowForBridge({
      mmsi: '556', name: 'OkändETA', sog: 0, etaMinutes: null,
    }, candidate);

    const tokens = app._triggerBoatNearFlowBest.mock.calls[0][0];
    expect(tokens.eta_minutes).toBe(-1);
    expect(tokens.eta_available).toBe(false);
  });

  test('flow-kontraktet deklarerar eta_available och dokumenterar -1', () => {
    const json = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../.homeycompose/flow/triggers/boat_near.json'), 'utf8',
    ));
    const tokenNames = json.tokens.map((t) => t.name);
    expect(tokenNames).toContain('eta_available');
    const etaToken = json.tokens.find((t) => t.name === 'eta_minutes');
    expect(etaToken.title.en).toMatch(/-1/);
  });
});

// =============================================================================
// G2: boat_at_bridge — behörighetsgater + Kanalinfarten i "any"
// =============================================================================
describe('G2: boat_at_bridge speglar notis-vägens behörighetsgater', () => {
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

  const logger = makeLogger();

  const setupAppWithMocks = async (vesselFactory, vesselDataServiceExtras = {}) => {
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
    app.vesselDataService = {
      getAllVessels: jest.fn(() => vesselFactory()),
      ...vesselDataServiceExtras,
    };
    app.proximityService = new ProximityService(bridgeRegistry, logger);

    await app._setupFlowCards();
    return { conditionCard };
  };

  const klaffbron = constants.BRIDGES.klaffbron || Object.values(constants.BRIDGES)
    .find((b) => b.name === 'Klaffbron');

  const freshVesselAtKlaffbron = (overrides = {}) => ({
    mmsi: 'G2TEST',
    lat: klaffbron.lat + 0.0009, // ~100 m
    lon: klaffbron.lon,
    sog: 3,
    status: 'approaching',
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    ...overrides,
  });

  test('färsk, ej förtöjd båt vid Klaffbron → true (baslinje)', async () => {
    const { conditionCard } = await setupAppWithMocks(() => [freshVesselAtKlaffbron()]);
    const listener = conditionCard.runListeners[0];
    expect(await listener({ bridge: 'klaffbron' })).toBe(true);
  });

  test('förtöjd båt (_moored) vid bron → false', async () => {
    const { conditionCard } = await setupAppWithMocks(
      () => [freshVesselAtKlaffbron({ _moored: true, sog: 0 })],
    );
    const listener = conditionCard.runListeners[0];
    expect(await listener({ bridge: 'klaffbron' })).toBe(false);
  });

  test('GPS-hopp-hold → false', async () => {
    const { conditionCard } = await setupAppWithMocks(
      () => [freshVesselAtKlaffbron()],
      { hasGpsJumpHold: jest.fn(() => true) },
    );
    const listener = conditionCard.runListeners[0];
    expect(await listener({ bridge: 'klaffbron' })).toBe(false);
  });

  test('död sändare (>10 min tyst) → false', async () => {
    const staleMs = Date.now() - (11 * 60 * 1000);
    const { conditionCard } = await setupAppWithMocks(
      () => [freshVesselAtKlaffbron({ timestamp: staleMs, lastPositionUpdate: staleMs })],
    );
    const listener = conditionCard.runListeners[0];
    expect(await listener({ bridge: 'klaffbron' })).toBe(false);
  });

  test('ANVÄNDARBESLUT: "any" täcker INTE Kanalinfarten (ingen bro — endast specifikt val)', async () => {
    // 2026-07-10: ChatGPT-granskningens G2-förslag att inkludera trigger-
    // points i "any" prövades och DROGS TILLBAKA på användarens begäran.
    // Kanalinfarten är en nöjes-triggerpunkt, inte en bro — den ska bara
    // matcha det specifika dropdown-valet (testas i condition-kanalinfarten).
    const tp = constants.TRIGGER_POINTS.kanalinfarten;
    const { conditionCard } = await setupAppWithMocks(() => [{
      mmsi: 'ANYKAN',
      lat: tp.lat + 0.0009, // ~100 m från Kanalinfarten, långt från alla broar
      lon: tp.lon,
      sog: 3,
      status: 'approaching',
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
    }]);
    const listener = conditionCard.runListeners[0];
    expect(await listener({ bridge: 'any' })).toBe(false);
    // ...men det SPECIFIKA valet fungerar fortfarande för samma båt.
    expect(await listener({ bridge: 'kanalinfarten' })).toBe(true);
  });

  test('"any" utan båtar i närheten → false', async () => {
    const { conditionCard } = await setupAppWithMocks(() => [{
      mmsi: 'FARAWAY',
      lat: 58.4, // långt norr om allt
      lon: 12.29,
      sog: 3,
      status: 'en-route',
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
    }]);
    const listener = conditionCard.runListeners[0];
    expect(await listener({ bridge: 'any' })).toBe(false);
  });
});

// =============================================================================
// G3: bridge_text-capability är read-only
// =============================================================================
describe('G3: capability-kontrakt', () => {
  test('bridge_text är setable: false (sensor är utdata, appen enda skribent)', () => {
    const json = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../.homeycompose/capabilities/bridge_text.json'), 'utf8',
    ));
    expect(json.setable).toBe(false);
    expect(json.getable).toBe(true);
  });
});

// =============================================================================
// I1: device-init-fel självläker via push-vägen
// =============================================================================
describe('I1: _updateDeviceCapability återställer unavailable-enhet', () => {
  test('lyckad capability-skrivning på _initFailed-enhet → setAvailable + flagga rensas', async () => {
    const app = new AISBridgeApp();
    app.error = jest.fn();
    const device = {
      _initFailed: true,
      setCapabilityValue: jest.fn().mockResolvedValue(undefined),
      setAvailable: jest.fn().mockResolvedValue(undefined),
    };
    app._devices = new Set([device]);

    app._updateDeviceCapability('bridge_text', 'testtext');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(device.setAvailable).toHaveBeenCalledTimes(1);
    expect(device._initFailed).toBe(false);
  });

  test('misslyckad skrivning rör INTE flaggan (enheten förblir unavailable)', async () => {
    const app = new AISBridgeApp();
    app.error = jest.fn();
    const device = {
      _initFailed: true,
      setCapabilityValue: jest.fn().mockRejectedValue(new Error('capability boom')),
      setAvailable: jest.fn().mockResolvedValue(undefined),
    };
    app._devices = new Set([device]);

    app._updateDeviceCapability('bridge_text', 'testtext');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(device.setAvailable).not.toHaveBeenCalled();
    expect(device._initFailed).toBe(true);
    expect(app.error).toHaveBeenCalled();
  });

  test('andra rundan: setAvailable-fel behåller flaggan → nytt försök vid nästa skrivning', async () => {
    const app = new AISBridgeApp();
    app.error = jest.fn();
    const device = {
      _initFailed: true,
      setCapabilityValue: jest.fn().mockResolvedValue(undefined),
      setAvailable: jest.fn()
        .mockRejectedValueOnce(new Error('setAvailable boom'))
        .mockResolvedValueOnce(undefined),
    };
    app._devices = new Set([device]);

    // Första skrivningen: setAvailable misslyckas → flaggan MÅSTE bestå
    // (gamla buggen rensade flaggan i förväg → enheten fastnade unavailable).
    app._updateDeviceCapability('bridge_text', 'text1');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(device._initFailed).toBe(true);
    expect(app.error).toHaveBeenCalled();

    // Andra skrivningen: setAvailable lyckas → flaggan rensas.
    app._updateDeviceCapability('bridge_text', 'text2');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(device.setAvailable).toHaveBeenCalledTimes(2);
    expect(device._initFailed).toBe(false);
  });
});

// =============================================================================
// I1 (andra rundan): BridgeStatusDevice.onInit-catchen på riktiga klassen
// =============================================================================
describe('I1: BridgeStatusDevice.onInit-felvägen', () => {
  // eslint-disable-next-line global-require
  const BridgeStatusDevice = require('../drivers/bridge_status/device');

  const makeDevice = ({ appReady = true } = {}) => {
    const device = new BridgeStatusDevice();
    device.log = jest.fn();
    device.error = jest.fn();
    device.getName = jest.fn(() => 'Bridge Status');
    device.hasCapability = jest.fn(() => true);
    device.addCapability = jest.fn().mockResolvedValue(undefined);
    device.setCapabilityValue = jest.fn().mockResolvedValue(undefined);
    device.setStoreValue = jest.fn().mockResolvedValue(undefined);
    device.setUnavailable = jest.fn().mockResolvedValue(undefined);
    device.setAvailable = jest.fn().mockResolvedValue(undefined);
    const appStub = {
      _devices: new Set(),
      _lastBridgeText: 'Testtext',
      _isConnected: true,
      addDevice: jest.fn(function addDevice(d) {
        this._devices.add(d);
      }),
      _findRelevantBoatsForBridgeText: jest.fn(() => []),
      _updateUI: jest.fn(),
    };
    device.homey = { app: appReady ? appStub : null };
    return { device, appStub };
  };

  test('init-fel → _initFailed + setUnavailable + registrerad för självläkning', async () => {
    const { device, appStub } = makeDevice();
    // Tvinga fram ett fel EFTER _ensureAppReady men tidigt i kedjan.
    device.hasCapability = jest.fn(() => {
      throw new Error('capability check exploded');
    });

    await device.onInit();

    expect(device._initFailed).toBe(true);
    expect(device.setUnavailable).toHaveBeenCalledTimes(1);
    // Kärnan i andra-rundans fynd: enheten får INTE lämnas utanför
    // push-Set:en — annars når _updateDeviceCapability den aldrig och
    // självläkningen är omöjlig.
    expect(appStub.addDevice).toHaveBeenCalled();
    expect(appStub._devices.has(device)).toBe(true);
  });

  test('lyckad init → ingen felflagga, ingen setUnavailable, registrerad en gång', async () => {
    const { device, appStub } = makeDevice();

    await device.onInit();

    expect(device._initFailed).toBeUndefined();
    expect(device.setUnavailable).not.toHaveBeenCalled();
    expect(appStub._devices.has(device)).toBe(true);

    // Städa init-timern så testet inte läcker handles.
    if (device._initUpdateTimeout) clearTimeout(device._initUpdateTimeout);
  });
});

// =============================================================================
// J1: 24h-dedupen rullas tillbaka vid misslyckad leverans
// =============================================================================
describe('J1: anslutningsnotisens dedupe-rollback', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = {
      settings: { get: jest.fn(), on: jest.fn() },
      notifications: { createNotification: jest.fn() },
    };
    return app;
  };

  test('misslyckad leverans → stämpeln återställd → nästa försök släpps fram', async () => {
    const app = makeApp();
    app.homey.notifications.createNotification = jest.fn()
      .mockRejectedValueOnce(new Error('timeline boom'))
      .mockResolvedValueOnce(undefined);

    await app._notifyConnectionIssue('första (misslyckas)');
    await app._notifyConnectionIssue('andra (ska släppas fram)');

    expect(app.homey.notifications.createNotification).toHaveBeenCalledTimes(2);
    expect(app.error).toHaveBeenCalled(); // felet loggades, svaldes inte tyst
  });

  test('lyckad leverans → 24h-dedupen består (ingen regression)', async () => {
    const app = makeApp();
    app.homey.notifications.createNotification = jest.fn().mockResolvedValue(undefined);

    await app._notifyConnectionIssue('första');
    await app._notifyConnectionIssue('andra inom 24h');

    expect(app.homey.notifications.createNotification).toHaveBeenCalledTimes(1);
  });
});
