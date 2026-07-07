'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

/**
 * F29: en ENSAM båt som råkar ut för en kort GPS-jump-hold (~2s) filtreras bort
 * av BridgeTextService (hasGpsJumpHold) → bridge_text flippar till DEFAULT
 * ("Inga båtar...") mitt i en resa och kommer tillbaka strax efter (flimmer).
 * _processUIUpdate behåller nu förra texten när den enda anledningen till DEFAULT
 * är att en aktiv båt (giltig targetBridge) är kortvarigt GPS-hållen.
 */
describe('F29: GPS-hold på ensam båt flippar inte UI till DEFAULT', () => {
  let app;

  const makeSnapshot = (vessels) => ({
    vesselCount: vessels.length,
    relevantVessels: vessels,
    vesselsBeingRemoved: new Set(),
  });

  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._isConnected = true;
    app._lastConnectionLost = null;
    app._updateDeviceCapability = jest.fn();
    app._globalBridgeTextToken = null;
    // BridgeTextService som returnerar DEFAULT (simulerar att enda båten filtrerats av GPS-hold)
    app.bridgeTextService = {
      generateBridgeText: jest.fn(() => BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE),
    };
    // Validering ska inte störa testet
    app._validateBridgeTextSummary = jest.fn(() => ({ isValid: true }));
  });

  test('behåller förra texten när enda båten är GPS-hållen', async () => {
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter';
    app.vesselDataService = { hasGpsJumpHold: (mmsi) => mmsi === 'HELD1' };

    const snapshot = makeSnapshot([
      { mmsi: 'HELD1', targetBridge: 'Klaffbron' },
    ]);

    await app._processUIUpdate(snapshot);

    // bridge_text-capability ska INTE ha satts till DEFAULT
    const bridgeTextCalls = app._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text');
    const sentToDefault = bridgeTextCalls.some((c) => c[1] === BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(sentToDefault).toBe(false);
  });

  test('flippar till DEFAULT normalt när ingen båt är GPS-hållen (ingen regression)', async () => {
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter';
    app.vesselDataService = { hasGpsJumpHold: () => false };

    // Båt utan hold men som ändå gav DEFAULT (t.ex. passerad/irrelevant)
    const snapshot = makeSnapshot([
      { mmsi: 'NORMAL1', targetBridge: 'Klaffbron' },
    ]);

    await app._processUIUpdate(snapshot);

    // Här SKA DEFAULT få skickas (guarden ska inte felaktigt hålla kvar)
    const bridgeTextCalls = app._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text');
    const sentToDefault = bridgeTextCalls.some((c) => c[1] === BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(sentToDefault).toBe(true);
  });
});

/**
 * FÄLTPROV 2026-07-07 (IMPERATOR 17:18, BALTIC JONGLEUR 20:46): terminal-
 * målbropassage nollar targetBridge medan båten är UNDER bron → texten föll
 * från "…strax" till "Inga båtar" mitt i broöppningen. _processUIUpdate
 * behåller nu förra texten under passed-fönstret vid målbro (PASSED_HOLD_MS).
 */
describe('PASSED_HOLD_UI: terminal-målbropassage flippar inte UI till DEFAULT', () => {
  let app;
  const { BRIDGE_TEXT_CONSTANTS: BTC } = require('../lib/constants');

  const makeSnapshot = (vessels) => ({
    vesselCount: vessels.length,
    relevantVessels: vessels,
    vesselsBeingRemoved: new Set(),
  });

  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._isConnected = true;
    app._lastConnectionLost = null;
    app._updateDeviceCapability = jest.fn();
    app._globalBridgeTextToken = null;
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app.bridgeTextService = {
      generateBridgeText: jest.fn(() => BTC.DEFAULT_MESSAGE),
    };
    app._validateBridgeTextSummary = jest.fn(() => ({ isValid: true }));
  });

  test('behåller "strax"-texten medan båten är i passed-fönstret vid målbron', async () => {
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
    const snapshot = makeSnapshot([{
      mmsi: '304028000',
      targetBridge: null, // TARGET_END nollade target
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 10 * 1000, // passerade nyss
    }]);

    await app._processUIUpdate(snapshot);

    const sentToDefault = app._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text')
      .some((c) => c[1] === BTC.DEFAULT_MESSAGE);
    expect(sentToDefault).toBe(false);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('PASSED_HOLD_UI'));
  });

  test('släpper till DEFAULT när passed-fönstret löpt ut (ingen zombie-text)', async () => {
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
    const snapshot = makeSnapshot([{
      mmsi: '304028000',
      targetBridge: null,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 200 * 1000, // > PASSED_HOLD_MS (150 s)
    }]);

    await app._processUIUpdate(snapshot);

    const sentToDefault = app._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text')
      .some((c) => c[1] === BTC.DEFAULT_MESSAGE);
    expect(sentToDefault).toBe(true);
  });

  test('mellanbro-passage (ej målbro) håller INTE texten', async () => {
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter';
    const snapshot = makeSnapshot([{
      mmsi: '304028000',
      targetBridge: null,
      lastPassedBridge: 'Olidebron', // mellanbro — inget hold-skäl
      lastPassedBridgeTime: Date.now() - 10 * 1000,
    }]);

    await app._processUIUpdate(snapshot);

    const sentToDefault = app._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text')
      .some((c) => c[1] === BTC.DEFAULT_MESSAGE);
    expect(sentToDefault).toBe(true);
  });
});
