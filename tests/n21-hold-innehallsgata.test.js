'use strict';

jest.mock('homey');
const App = require('../app');
const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

// N21:s gamla bronamnsökning räckte inte vid blandad trafik: en korrekt
// bro kunde hålla kvar en helt annan passerad bro. Identiteten måste också
// stämma, och underlaget ska ha publicerats för den aktuella båten.
describe('N21: GPS-hållning kräver samma båt och samma aktuella mål', () => {
  let app;
  let held;
  const vessel = (mmsi, targetBridge) => ({
    mmsi,
    targetBridge,
    etaMinutes: 5,
    status: 'en-route',
    lat: BRIDGES.klaffbron.lat - 400 / 111320,
    lon: BRIDGES.klaffbron.lon,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    passedBridges: [],
  });
  async function publish(vessels) {
    await app._processUIUpdate({
      relevantVessels: vessels,
      vesselCount: vessels.length,
      vesselsBeingRemoved: new Set(),
      timestamp: Date.now(),
    });
    return app._lastBridgeText;
  }
  beforeEach(() => {
    held = new Set();
    app = new App(); app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app._isConnected = true; app._lastConnectionLost = null;
    app._updateDeviceCapability = jest.fn(); app._globalBridgeTextToken = null;
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = { hasGpsJumpHold: (mmsi) => held.has(mmsi) };
    app.bridgeTextService = new BridgeTextService(app.bridgeRegistry, app, null, app.vesselDataService);
  });

  test('rätt båt och mål behåller texten', async () => {
    const a = vessel('A', 'Klaffbron');
    await publish([a]);
    held.add('A');
    expect(await publish([{ ...a, etaMinutes: 1, _positionUncertain: true }]))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter');
  });

  test('samma bronamn men en annan MMSI får inte stjäla föregående båts text', async () => {
    await publish([vessel('A', 'Klaffbron')]);
    held.add('B');
    expect(await publish([vessel('B', 'Klaffbron')])).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });

  test('samma MMSI men annan målbro får varken fel bro i normaltext eller fallback', async () => {
    await publish([vessel('A', 'Klaffbron')]);
    held.add('A');
    const changed = [vessel('A', 'Stridsbergsbron')];
    expect(app._generateSafeFallbackText(changed)).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(await publish(changed)).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });

  test('passerad målbro är ingen grund för hållning', async () => {
    const a = vessel('A', 'Klaffbron');
    await publish([a]);
    held.add('A');
    const ended = [{
      ...a, targetBridge: null, lastPassedBridge: 'Klaffbron', passedBridges: ['Klaffbron'],
    }];
    expect(app._generateSafeFallbackText(ended)).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(await publish(ended)).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });

  test('publicerat underlag delar inte muterbara passage- eller väntobjekt med levande båten', async () => {
    const a = vessel('A', 'Stridsbergsbron');
    a._stillnessAnchor = { lat: a.lat, lon: a.lon, t: Date.now() };
    a._bridgeQueueApproaches = { Järnvägsbron: { direction: 'north', confirmedAt: Date.now() } };
    await publish([a]);
    const saved = app._lastBridgeTextVessels.get('A');
    a.passedBridges.push('Olidebron');
    a._stillnessAnchor.lat = 0;
    a._bridgeQueueApproaches.Järnvägsbron.confirmedAt = 0;
    expect(saved.passedBridges).toEqual([]);
    expect(saved._stillnessAnchor.lat).not.toBe(0);
    expect(saved._bridgeQueueApproaches.Järnvägsbron.confirmedAt).not.toBe(0);
  });
});
