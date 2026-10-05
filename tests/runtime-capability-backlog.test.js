'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

const snapshot = (vessels = []) => ({
  relevantVessels: vessels,
  vesselCount: vessels.length,
  vesselsBeingRemoved: new Set(),
  timestamp: Date.now(),
});

describe('Långsamt Homey-SDK får senaste väntande brotext efter pågående skrivning', () => {
  let app;
  let savedTestMode;

  beforeEach(async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-05T10:00:00Z') });
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = new App();
    app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: () => null, set: jest.fn(), on: jest.fn(), off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    await app.onInit();
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
  });

  const addDevice = (delayMs, delayedCapability = 'bridge_text') => {
    const values = new Map();
    const writes = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    app._devices.add({
      getName: () => `Homey svarar efter ${delayMs} ms`,
      getCapabilityValue: (capability) => values.get(capability),
      setCapabilityValue: (capability, value) => {
        if (capability !== delayedCapability) {
          values.set(capability, value);
          return Promise.resolve();
        }
        writes.push(value);
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        return new Promise((resolve) => {
          setTimeout(() => {
            values.set(capability, value);
            activeWrites--;
            resolve();
          }, delayMs);
        });
      },
    });
    return { values, writes, maxActiveWrites: () => maxActiveWrites };
  };

  test.each([false, true])('sex båtar i AIS-burst: senaste text når enheten utan historisk kö (tomt slut=%s)', async (emptyAtEnd) => {
    const device = addDevice(5000);
    app._isConnected = true;
    jest.spyOn(app, '_evaluateFeedSilence').mockReturnValue({ silent: false, feedSilentMs: 0 });
    const vessels = [];
    for (let count = 1; count <= 6; count++) {
      vessels.push({
        mmsi: String(265000120 + count),
        lat: 58.287,
        lon: 12.295,
        targetBridge: 'Stridsbergsbron',
        status: 'en-route',
        etaMinutes: 5,
        sog: 3,
        timestamp: Date.now(),
      });
      // 150 ms är spridningen mellan fartyg i ett AISHub-pollsvep.
      // eslint-disable-next-line no-await-in-loop
      const result = await app._processUIUpdate(snapshot([...vessels]));
      expect(result.success).toBe(true);
      // eslint-disable-next-line no-await-in-loop
      await jest.advanceTimersByTimeAsync(150);
    }
    if (emptyAtEnd) await app._processUIUpdate(snapshot());
    const desired = app._lastBridgeText;
    if (emptyAtEnd) expect(desired).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    else expect(desired).toMatch(/^Sex båtar/);

    await jest.advanceTimersByTimeAsync(10000);

    expect(device.values.get('bridge_text')).toBe(desired);
    expect(device.values.get('alarm_generic')).toBe(!emptyAtEnd);
    expect(device.writes).toEqual([
      'En båt på väg mot Stridsbergsbron, beräknad broöppning om 5 minuter',
      desired,
    ]);
    expect(device.maxActiveWrites()).toBe(1);
  });

  test.each([
    ['retur till pågående värde', ['A', 'B', 'A'], ['A', 'A']],
    ['flera likadana väntande värden', ['A', 'B', 'B', 'B'], ['A', 'B']],
  ])('%s hoppar över varje ersatt köpost', async (reason, values, expectedWrites) => {
    const device = addDevice(5000);
    app._updateDeviceCapability('bridge_text', values[0]);
    await jest.advanceTimersByTimeAsync(100);
    for (const value of values.slice(1)) app._updateDeviceCapability('bridge_text', value);

    await jest.advanceTimersByTimeAsync(10000);

    expect(device.writes).toEqual(expectedWrites);
    expect(device.values.get('bridge_text')).toBe(values.at(-1));
    expect(device.maxActiveWrites()).toBe(1);
  });

  test('en långsam av flera enheter håller inte kvar ersatta textvärden', async () => {
    const slow = addDevice(5000);
    const fast = addDevice(0);
    app._updateDeviceCapability('bridge_text', 'A');
    await jest.advanceTimersByTimeAsync(100);
    app._updateDeviceCapability('bridge_text', 'B');
    app._updateDeviceCapability('bridge_text', 'C');

    await jest.advanceTimersByTimeAsync(10000);

    for (const device of [slow, fast]) {
      expect(device.writes).toEqual(['A', 'C']);
      expect(device.values.get('bridge_text')).toBe('C');
      expect(device.maxActiveWrites()).toBe(1);
    }
  });

  test.each([
    ['alarm_generic', [false, true, false]],
    ['connection_status', ['connected', 'degraded', 'connected']],
  ])('%s bevarar alla tidigare ordnade flanker', async (capability, values) => {
    const device = addDevice(5000, capability);
    for (const value of values) app._updateDeviceCapability(capability, value);

    await jest.advanceTimersByTimeAsync(15000);

    expect(device.writes).toEqual(values);
    expect(device.values.get(capability)).toBe(values.at(-1));
    expect(device.maxActiveWrites()).toBe(1);
  });
});
