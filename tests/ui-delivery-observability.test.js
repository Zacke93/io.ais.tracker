'use strict';

jest.mock('homey');
const App = require('../app');

describe('Publiceringens SDK-kvitton skiljs från önskad text', () => {
  let app;
  beforeEach(() => {
    app = new App(); app.log = jest.fn(); app.error = jest.fn();
    app._runtimeLifecycle = {}; app._devices = new Set();
  });
  test('enhetens kvitto och lästa värde loggas först när skrivningen lyckats', async () => {
    let resolve;
    const device = {
      getName: () => 'Test',
      getCapabilityValue: () => 'Text',
      setCapabilityValue: () => new Promise((r) => {
        resolve = r;
      }),
    };
    app._devices.add(device);
    const write = app._writeCapabilityToDevices('bridge_text', 'Text');
    expect(app.log).not.toHaveBeenCalled();
    resolve(); await write;
    expect(app.log).toHaveBeenCalledWith(expect.stringMatching(/UI_WRITE_ACK.*channel=device.*sdk=ok readback=match/));
  });
  test('misslyckad skrivning ger inget kvitto och tillåter nästa omskrivning', async () => {
    app._devices.add({ setCapabilityValue: () => Promise.reject(new Error('Offline')) });
    app._lastBridgeTextHash = 'old';
    await app._writeCapabilityToDevices('bridge_text', 'Text');
    expect(app.log).not.toHaveBeenCalled();
    expect(app._lastBridgeTextHash).toBeNull();
  });
  test('avvikande läst värde syns och startar självläkningen', async () => {
    app._devices.add({ setCapabilityValue: async () => {}, getCapabilityValue: () => 'Gammal text' });
    app._lastBridgeTextHash = 'old';
    await app._writeCapabilityToDevices('bridge_text', 'Text');
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('readback=mismatch'));
    expect(app._lastBridgeTextHash).toBeNull();
  });
  test('global token har sitt eget SDK-kvitto', async () => {
    app._globalBridgeTextToken = { setValue: async () => {} };
    await app._setGlobalTokenSafe('Text');
    expect(app.log).toHaveBeenCalledWith(expect.stringMatching(/UI_WRITE_ACK.*channel=global_bridge_text.*sdk=ok/));
  });
});
