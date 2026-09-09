'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res; reject = rej;
  });
  return { promise, resolve, reject };
};

const makeApp = (createToken) => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app.homey = { flow: { createToken } };
  app._lastBridgeText = 'Aktuell brotext';
  return app;
};

const flush = async () => {
  for (let i = 0; i < 12; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('Drift: global token återhämtas efter långsamt Homey-svar', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T10:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('ett lyckat svar efter startens timeout bevaras och får den senaste texten', async () => {
    const pending = deferred();
    const token = { setValue: jest.fn().mockResolvedValue(undefined) };
    const app = makeApp(jest.fn(() => pending.promise));
    const init = app._initGlobalToken();
    await jest.advanceTimersByTimeAsync(10001);
    await init;
    expect(app._globalBridgeTextToken).toBeUndefined();

    app._lastBridgeText = 'Ny text medan Homey svarade långsamt';
    pending.resolve(token);
    await flush();

    expect(app._globalBridgeTextToken).toBe(token);
    expect(token.setValue).toHaveBeenLastCalledWith(app._lastBridgeText);
    await app._setGlobalTokenSafe('Nästa text');
    expect(app.homey.flow.createToken).toHaveBeenCalledTimes(1);
    expect(token.setValue).toHaveBeenLastCalledWith('Nästa text');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('token som redan registrerats hos Homey återanvänds efter tappat svar', async () => {
    const token = { setValue: jest.fn().mockResolvedValue(undefined) };
    const app = makeApp(jest.fn().mockRejectedValue(new Error('Token already exists')));
    app.homey.flow.getToken = jest.fn(() => token);

    await app._initGlobalToken();

    expect(app._globalBridgeTextToken).toBe(token);
    expect(app.homey.flow.getToken).toHaveBeenCalledWith('global_bridge_text');
    expect(app.homey.flow.createToken).not.toHaveBeenCalled();
    expect(token.setValue).toHaveBeenCalledWith(app._lastBridgeText);
  });

  test('ett sent startsvar efter shutdown startar ingen publicering', async () => {
    const pending = deferred();
    const token = { setValue: jest.fn().mockResolvedValue(undefined) };
    const app = makeApp(jest.fn(() => pending.promise));
    const init = app._initGlobalToken();
    app._shuttingDown = true;
    pending.resolve(token);
    await init;

    expect(app._globalBridgeTextToken).toBeUndefined();
    expect(token.setValue).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ett startsvar från förra livscykeln ersätter inte den nya tokenen', async () => {
    const pending = deferred();
    const oldToken = { setValue: jest.fn().mockResolvedValue(undefined) };
    const currentToken = { setValue: jest.fn().mockResolvedValue(undefined) };
    const app = makeApp(jest.fn(() => pending.promise));
    app._runtimeLifecycle = {};
    const oldInit = app._initGlobalToken();
    app._runtimeLifecycle = {};
    app._globalBridgeTextToken = currentToken;
    pending.resolve(oldToken);
    await oldInit;

    expect(app._globalBridgeTextToken).toBe(currentToken);
    expect(oldToken.setValue).not.toHaveBeenCalled();
    expect(currentToken.setValue).not.toHaveBeenCalled();
  });

  test('synkront setValue-fel släpper publiceringen och lämnar ingen timeout', async () => {
    const app = makeApp(jest.fn());
    app._globalBridgeTextToken = {
      setValue: jest.fn(() => {
        throw new Error('IPC unavailable');
      }),
    };
    app._lastBridgeTextHash = 123;

    await expect(app._setGlobalTokenSafe('Text')).resolves.toBeUndefined();

    expect(app._lastBridgeTextHash).toBeNull();
    expect(app.error).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('sen setValue-settling från förra livscykeln rör inte den nya textcachen', async () => {
    const pending = deferred();
    const app = makeApp(jest.fn());
    app._runtimeLifecycle = {};
    app._globalBridgeTextToken = { setValue: () => pending.promise };
    const write = app._setGlobalTokenSafe('Förra livscykelns text');
    await jest.advanceTimersByTimeAsync(10001);
    await write;
    app._runtimeLifecycle = {};
    app._lastBridgeTextHash = 456;

    pending.resolve();
    await flush();

    expect(app._lastBridgeTextHash).toBe(456);
  });

  test('onInit efter onUninit öppnar publiceringen igen', async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = mockHomey;
    app.homey.settings._store = {};
    const savedMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    try {
      await app.onInit();
      await app.onUninit();
      await app.onInit();
      const write = jest.fn().mockResolvedValue(undefined);
      app._writeCapabilityToDevices = write;

      app._updateDeviceCapability('bridge_text', 'Efter omstart');
      await flush();

      expect(write).toHaveBeenCalledWith('bridge_text', 'Efter omstart', expect.any(Function));
      expect(app._shuttingDown).toBe(false);
    } finally {
      await app.onUninit();
      global.__TEST_MODE__ = savedMode;
    }
  });

  test('en gammal köad capability-skrivning startar inte efter återinit', async () => {
    const pending = deferred();
    const app = makeApp(jest.fn());
    app._runtimeLifecycle = {};
    app._writeCapabilityToDevices = jest.fn().mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined);
    app._updateDeviceCapability('bridge_text', 'Gammal pågående');
    app._updateDeviceCapability('bridge_text', 'Gammal köad');
    await flush();

    app._runtimeLifecycle = {};
    app._capWriteChains = null;
    app._capWriteValues = new Map();
    app._updateDeviceCapability('bridge_text', 'Ny start');
    await flush();
    pending.resolve();
    await flush();

    expect(app._writeCapabilityToDevices).not.toHaveBeenCalledWith('bridge_text', 'Gammal köad', expect.any(Function));
    expect(app._writeCapabilityToDevices).toHaveBeenLastCalledWith('bridge_text', 'Ny start', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ett redan skickat gammalt capability-anrop återställer det nya värdet vid sen landning', async () => {
    const pending = deferred();
    const app = makeApp(jest.fn());
    app._runtimeLifecycle = {};
    let actualValue;
    const device = {
      setCapabilityValue: jest.fn()
        .mockImplementationOnce((capability, value) => pending.promise.then(() => {
          actualValue = value;
        }))
        .mockImplementation(async (capability, value) => {
          actualValue = value;
        }),
    };
    app._devices = new Set([device]);
    app._updateDeviceCapability('bridge_text', 'Gammal text');
    await flush();

    app._runtimeLifecycle = {};
    app._capWriteChains = null;
    app._capWriteValues = new Map();
    app._updateDeviceCapability('bridge_text', 'Ny text');
    await flush();
    expect(actualValue).toBe('Ny text');
    pending.resolve();
    await flush();
    await app._capWriteChains.get('bridge_text');

    expect(actualValue).toBe('Ny text');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('sen token-skrivning över återinit återställer texten om token-instansen återanvänds', async () => {
    const pending = deferred();
    const app = makeApp(jest.fn());
    app._runtimeLifecycle = {};
    let actualValue;
    app._globalBridgeTextToken = {
      setValue: jest.fn()
        .mockImplementationOnce((value) => pending.promise.then(() => {
          actualValue = value;
        }))
        .mockImplementation(async (value) => {
          actualValue = value;
        }),
    };
    const oldWrite = app._setGlobalTokenSafe('Gammal text');
    await flush();
    app._runtimeLifecycle = {};
    app._lastBridgeText = 'Ny text';
    await app._setGlobalTokenSafe('Ny text');
    pending.resolve();
    await oldWrite;
    await flush();

    expect(actualValue).toBe('Ny text');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('två SDK-wrappers för samma globala token återhämtar också en gammal skrivning', async () => {
    const pending = deferred();
    const app = makeApp(jest.fn());
    app._runtimeLifecycle = {};
    let actualValue;
    app._globalBridgeTextToken = {
      setValue: (value) => pending.promise.then(() => {
        actualValue = value;
      }),
    };
    const oldWrite = app._setGlobalTokenSafe('Gammal text');
    await flush();
    app._runtimeLifecycle = {};
    app._globalBridgeTextToken = {
      setValue: async (value) => {
        actualValue = value;
      },
    };
    app._lastBridgeText = 'Ny text';
    await app._setGlobalTokenSafe('Ny text');
    pending.resolve();
    await oldWrite;
    await flush();

    expect(actualValue).toBe('Ny text');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('sen createToken-återhämtning får inte skriva över en nyare vanlig publicering', async () => {
    const creation = deferred();
    const recoveryWrite = deferred();
    const app = makeApp(jest.fn(() => creation.promise));
    let actualValue;
    const token = {
      setValue: jest.fn()
        .mockImplementationOnce((value) => recoveryWrite.promise.then(() => {
          actualValue = value;
        }))
        .mockImplementation(async (value) => {
          actualValue = value;
        }),
    };
    const init = app._initGlobalToken();
    await jest.advanceTimersByTimeAsync(10001);
    await init;
    app._lastBridgeText = 'A';
    creation.resolve(token);
    await flush();
    app._lastBridgeText = 'B';
    await app._setGlobalTokenSafe('B');
    recoveryWrite.resolve();
    await flush();

    expect(actualValue).toBe('B');
    expect(token.setValue.mock.calls.length).toBeLessThanOrEqual(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('nyare text under tokenåterskapning supersederar den väntande publiceringen', async () => {
    const creation = deferred();
    const app = makeApp(jest.fn(() => creation.promise));
    let actualValue;
    const token = {
      setValue: jest.fn(async (value) => {
        actualValue = value;
      }),
    };
    app._lastBridgeText = 'A';
    const first = app._setGlobalTokenSafe('A');
    app._lastBridgeText = 'B';
    await app._setGlobalTokenSafe('B');
    creation.resolve(token);
    await first;

    expect(actualValue).toBe('B');
    expect(token.setValue).not.toHaveBeenCalledWith('A');
    expect(app.homey.flow.createToken).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([false, true])('sen enhetsskrivning läker även när en annan enhet aldrig svarar (omstart=%s)', async (restart) => {
    const oldA = deferred();
    const app = makeApp(jest.fn());
    app._runtimeLifecycle = {};
    let valueA;
    const deviceA = {
      setCapabilityValue: jest.fn()
        .mockImplementationOnce((capability, value) => oldA.promise.then(() => {
          valueA = value;
        }))
        .mockImplementation(async (capability, value) => {
          valueA = value;
        }),
    };
    const deviceB = {
      setCapabilityValue: jest.fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue(undefined),
    };
    app._devices = new Set([deviceA, deviceB]);
    app._updateDeviceCapability('bridge_text', 'A');
    await flush();
    if (restart) {
      app._runtimeLifecycle = {};
      app._capWriteChains = null;
      app._capWriteValues = new Map();
    } else {
      await jest.advanceTimersByTimeAsync(30001);
    }
    app._updateDeviceCapability('bridge_text', 'B');
    await flush();
    oldA.resolve();
    await flush();
    await app._capWriteChains.get('bridge_text');

    expect(valueA).toBe('B');
    expect(deviceA.setCapabilityValue.mock.calls.length).toBeLessThanOrEqual(3);
    await jest.advanceTimersByTimeAsync(30001);
    expect(jest.getTimerCount()).toBe(0);
  });
});
