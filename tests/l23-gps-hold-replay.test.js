'use strict';

jest.mock('homey');
const App = require('../app');
const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGE_TEXT_CONSTANTS, BRIDGES } = require('../lib/constants');

// GPS-hållning använder nu tidigare publicerat båtunderlag. Textmotorn och
// validatorn kan därför räkna samma båtar utan det gamla valideringshoppet.
describe('L23: GPS-hållning och summeringsvalidering delar fartygsunderlag', () => {
  let app;
  let held;
  const vessel = (mmsi) => ({
    mmsi,
    targetBridge: 'Klaffbron',
    etaMinutes: 4,
    status: 'en-route',
    lat: BRIDGES.klaffbron.lat - 400 / 111320,
    lon: BRIDGES.klaffbron.lon,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    passedBridges: [],
  });
  const snapshot = (vessels) => ({
    relevantVessels: vessels,
    vesselCount: vessels.length,
    vesselsBeingRemoved: new Set(),
    timestamp: Date.now(),
  });

  beforeEach(() => {
    held = new Set();
    app = new App(); app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app._isConnected = true; app._lastConnectionLost = null;
    app._updateDeviceCapability = jest.fn(); app._globalBridgeTextToken = null;
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = { hasGpsJumpHold: (mmsi) => held.has(mmsi) };
    app.bridgeTextService = new BridgeTextService(app.bridgeRegistry, app, null, app.vesselDataService);
  });

  test('två tidigare publicerade båtar behålls och valideras även när båda hålls', async () => {
    const vessels = [vessel('A'), vessel('B')];
    await app._processUIUpdate(snapshot(vessels));
    held.add('A'); held.add('B');
    const validate = jest.spyOn(app, '_validateBridgeTextSummary');
    await app._processUIUpdate(snapshot(vessels));
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.results[0].value.isValid).toBe(true);
    expect(app._lastBridgeText).toBe('Två båtar på väg mot Klaffbron, beräknad broöppning om 4 minuter');
    expect(app.error).not.toHaveBeenCalled();
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('SUMMARY_VALIDATION_SKIP'));
  });

  test('GPS-hoppets orimliga status bedöms inte mot det tidigare publicerade underlaget', async () => {
    const vessels = ['A', 'B', 'C'].map(vessel);
    await app._processUIUpdate(snapshot(vessels));
    vessels.forEach((v) => held.add(v.mmsi));
    const jumped = vessels.map((v) => ({
      ...v, status: 'under-bridge', lat: 58.31, etaMinutes: 250, _positionUncertain: true,
    }));
    expect(app._validateBridgeTextSummary(app._lastBridgeText, jumped, snapshot(jumped)).isValid).toBe(true);
  });

  test('enbart gammal text utan tidigare båtunderlag räcker inte som hållbevis', () => {
    const vessels = [vessel('A'), vessel('B')];
    held.add('A'); held.add('B');
    const result = app._validateVesselCounts('Två båtar på väg mot Klaffbron, beräknad broöppning om 4 minuter', vessels);
    expect(result.passed).toBe(false);
    expect(result.details.actualCount).toBe(0);
  });

  test('nödfallbacken renderar tidigare underlag och korrekt antal', async () => {
    const vessels = [vessel('A')];
    await app._processUIUpdate(snapshot(vessels));
    held.add('A');
    expect(app._generateSafeFallbackText(vessels, 'trasig text'))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning om 4 minuter');
  });

  test('nödfallbacken skickar inte om en text som nyss underkänts', async () => {
    const vessels = [vessel('A')];
    await app._processUIUpdate(snapshot(vessels));
    held.add('A');
    expect(app._generateSafeFallbackText(vessels, app._lastBridgeText)).not.toBe(app._lastBridgeText);
  });

  test('frånkoppling tömmer hållunderlaget före återanslutning', async () => {
    const vessels = [vessel('A')];
    await app._processUIUpdate(snapshot(vessels));
    app._isConnected = false; app._lastConnectionLost = Date.now() - 121000;
    await app._processUIUpdate(snapshot(vessels));
    expect(app._lastBridgeTextVessels.size).toBe(0);
    app._isConnected = true;
    held.add('A');
    await app._processUIUpdate(snapshot(vessels));
    expect(app._lastBridgeText).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });

  test('båt utan aktivt mål återupplivas inte i fallbacken', async () => {
    const a = vessel('A');
    await app._processUIUpdate(snapshot([a]));
    held.add('A');
    expect(app._generateSafeFallbackText([{ ...a, targetBridge: null }])).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });
});
