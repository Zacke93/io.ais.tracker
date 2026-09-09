'use strict';

jest.mock('homey');
const App = require('../app');
const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

describe('Bekräftad passage avslutar bara informationen om den passerade bron', () => {
  let app;
  beforeEach(() => {
    app = new App(); app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app._isConnected = true; app._lastConnectionLost = null;
    app._updateDeviceCapability = jest.fn(); app._globalBridgeTextToken = null;
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app.bridgeRegistry = new BridgeRegistry();
    app.bridgeTextService = new BridgeTextService(app.bridgeRegistry, app);
  });
  const vessel = (id, target, extra = {}) => ({
    mmsi: id, targetBridge: target, etaMinutes: 5, status: 'en-route', ...extra,
  });
  async function publish(vessels) {
    await app._processUIUpdate({
      vesselCount: vessels.length, relevantVessels: vessels, vesselsBeingRemoved: new Set(), timestamp: Date.now(),
    });
    return app._lastBridgeText;
  }
  test.each(['Klaffbron', 'Stridsbergsbron'])('%s: ingen hållning efter bekräftad sista passage', async (bridge) => {
    app._lastBridgeText = `En båt på väg mot ${bridge}, beräknad broöppning strax`;
    expect(await publish([vessel('265573130', null, { lastPassedBridge: bridge, lastPassedBridgeTime: Date.now() })]))
      .toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });
  test('nästa målbro ersätter den passerade i samma publicering', async () => {
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
    expect(await publish([vessel('265573130', 'Stridsbergsbron', { lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() })]))
      .toBe('En båt på väg mot Stridsbergsbron, beräknad broöppning om 5 minuter');
  });
  test('andra båtar till samma bro finns fortfarande med efter ledarens passage', async () => {
    app._lastBridgeText = 'Två båtar på väg mot Klaffbron, beräknad broöppning strax';
    expect(await publish([
      vessel('265573130', null, { lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() }),
      vessel('275491000', 'Klaffbron'),
    ])).toBe('En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter');
  });
  test('ETA noll eller under-bridge utan passage får inte ta bort båten', async () => {
    expect(await publish([vessel('265573130', 'Klaffbron', {
      etaMinutes: 0, status: 'under-bridge', currentBridge: 'Klaffbron', distanceToCurrent: 20,
    })])).toContain('på väg mot Klaffbron');
  });
});
