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
