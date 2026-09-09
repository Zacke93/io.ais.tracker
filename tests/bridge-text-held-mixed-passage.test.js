'use strict';

jest.mock('homey');
const App = require('../app');
const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

describe('GPS-hållning följer bara den berörda båten genom blandad trafik', () => {
  let app;
  let held;
  let now;

  beforeEach(() => {
    now = Date.parse('2026-09-08T10:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    held = new Set();
    app = new App();
    app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app._isConnected = true; app._lastConnectionLost = null;
    app._updateDeviceCapability = jest.fn(); app._globalBridgeTextToken = null;
    app._lastBridgeTextVessels = new Map();
    app.vesselDataService = { hasGpsJumpHold: (mmsi) => held.has(mmsi) };
    app.bridgeRegistry = new BridgeRegistry();
    app.bridgeTextService = new BridgeTextService(app.bridgeRegistry, app, null, app.vesselDataService);
  });

  afterEach(() => jest.restoreAllMocks());

  const boat = (mmsi, targetBridge, etaMinutes, extra = {}) => ({
    mmsi,
    targetBridge,
    etaMinutes,
    status: 'en-route',
    lat: BRIDGES.klaffbron.lat - 0.003,
    lon: BRIDGES.klaffbron.lon,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    passedBridges: [],
    ...extra,
  });
  const passed = (vessel) => ({
    ...vessel,
    targetBridge: null,
    etaMinutes: null,
    status: 'passed',
    lastPassedBridge: vessel.targetBridge,
    lastPassedBridgeTime: Date.now(),
    passedBridges: [...vessel.passedBridges, vessel.targetBridge],
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

  test('passerad Klaffbro försvinner medan en annan GPS-hållen båt behåller Stridsbergsbron', async () => {
    const a = boat('P', 'Klaffbron', 1);
    const b = boat('H', 'Stridsbergsbron', 5);
    await publish([a, b]);
    held.add('H');
    expect(await publish([passed(a), { ...b, etaMinutes: 1, _positionUncertain: true }]))
      .toBe('En båt på väg mot Stridsbergsbron, beräknad broöppning om 5 minuter');
  });

  test('nödfallbacken tar också bort den passerade bron utan att släcka den hållna', async () => {
    const a = boat('P', 'Klaffbron', 1);
    const b = boat('H', 'Stridsbergsbron', 5);
    await publish([a, b]);
    held.add('H');
    expect(app._generateSafeFallbackText([passed(a), { ...b, etaMinutes: 1, _positionUncertain: true }]))
      .toBe('En båt på väg mot Stridsbergsbron, beräknad broöppning om 5 minuter');
  });

  test('samma bro: två blir en och den passerade ledarens strax-ETA återanvänds inte', async () => {
    const a = boat('P', 'Klaffbron', 1);
    const b = boat('H', 'Klaffbron', 8);
    expect(await publish([a, b])).toContain('Två båtar');
    held.add('H');
    expect(await publish([passed(a), { ...b, etaMinutes: 1, _positionUncertain: true }]))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning om 8 minuter');
  });

  test('färska och två hållna båtar räknas tillsammans utan valideringsfallback', async () => {
    const a = boat('A', 'Klaffbron', 8);
    const b = boat('B', 'Klaffbron', 7);
    const c = boat('C', 'Stridsbergsbron', 6);
    await publish([a, b, c]);
    held.add('A'); held.add('B');
    expect(await publish([
      { ...a, etaMinutes: 1, _positionUncertain: true },
      { ...b, etaMinutes: 1, _positionUncertain: true },
      { ...c, etaMinutes: 4 },
    ])).toBe('Två båtar på väg mot Klaffbron, beräknad broöppning om 7 minuter; En båt på väg mot Stridsbergsbron, beräknad broöppning om 4 minuter');
    expect(app.error).not.toHaveBeenCalledWith(expect.stringContaining('SUMMARY_VALIDATION'));
  });

  test('vänttext utan minuter bevaras medan en annan båts färska ETA ändras', async () => {
    const bridge = BRIDGES.jarnvagsbron;
    const lat = bridge.lat - 150 / 111320;
    const a = boat('Q', 'Stridsbergsbron', 9, {
      lat,
      lon: bridge.lon,
      sog: 0,
      _routeDirection: 'north',
      _stationarySince: now - 120000,
      _stillnessAnchor: { lat, lon: bridge.lon, t: now - 120000 },
      _bridgeQueueApproaches: { [bridge.name]: { direction: 'north', confirmedAt: now - 180000 } },
    });
    const b = boat('M', 'Stridsbergsbron', 5);
    expect(await publish([a, b])).toContain('En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron');
    held.add('Q');
    expect(await publish([{ ...a, sog: 6, _positionUncertain: true }, { ...b, etaMinutes: 7 }]))
      .toBe('En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron; En båt på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter');
  });

  test('målbyte får inte återanvända en tidigare målbro', async () => {
    const a = boat('H', 'Klaffbron', 1);
    await publish([a]);
    held.add('H');
    const result = await publish([{ ...a, targetBridge: 'Stridsbergsbron', passedBridges: ['Klaffbron'] }]);
    expect(result).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });

  test('hållningen förnyar aldrig en gammal positions tidsstämpel', async () => {
    const a = boat('H', 'Klaffbron', 5);
    await publish([a]);
    const positionTime = a.timestamp;
    held.add('H');
    now += 1000;
    await publish([{ ...a, etaMinutes: 1, _positionUncertain: true }]);
    expect(app._lastBridgeTextVessels.get('H').timestamp).toBe(positionTime);
    now += 10 * 60000;
    expect(await publish([{ ...a, _positionUncertain: true }])).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });

  test('en försvunnen MMSI tas bort ur underlaget även när den sista båten hålls', async () => {
    const a = boat('P', 'Klaffbron', 1);
    const b = boat('H', 'Klaffbron', 8);
    await publish([a, b]);
    held.add('H');
    await publish([{ ...b, _positionUncertain: true }]);
    expect([...app._lastBridgeTextVessels.keys()]).toEqual(['H']);
    expect(app._lastBridgeText).toContain('En båt');
  });
});
