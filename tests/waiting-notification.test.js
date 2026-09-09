'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { BRIDGES, BRIDGE_NAME_TO_ID } = require('../lib/constants');

describe('Väntnotis utan minutprognos (användarbeslut 2026-09-06)', () => {
  let app;
  let vessel;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
    vessel = {
      mmsi: '244870852',
      name: 'PHOENIX',
      sog: 0,
      cog: 40,
      _routeDirection: 'north',
      etaMinutes: 3,
      status: 'waiting',
      targetBridge: 'Stridsbergsbron',
      currentBridge: 'Järnvägsbron',
      waitingAtBridge: 'Stridsbergsbron',
    };
    stopAt('Stridsbergsbron');
  });

  function stopAt(name) {
    const bridge = Object.values(BRIDGES).find((b) => b.name === name);
    const now = Date.now();
    Object.assign(vessel, {
      lat: bridge.lat - 100 / 111320,
      lon: bridge.lon,
      timestamp: now,
      lastPositionUpdate: now - 120000,
      _stationarySince: now - 120000,
      _stillnessAnchor: { lat: bridge.lat - 100 / 111320, lon: bridge.lon, t: now - 120000 },
      _bridgeQueueApproaches: { [name]: { confirmedAt: now - 180000, direction: 'north' } },
      waitingAtBridge: name,
    });
  }

  async function notify(name = 'Stridsbergsbron', source = 'target', distance = 170) {
    await app._triggerBoatNearFlowForBridge(vessel, {
      name, id: BRIDGE_NAME_TO_ID[name], distance, source,
    });
    return app._triggerBoatNearFlowBest.mock.calls.at(-1)?.[0];
  }

  test('PHOENIX får vänttext när färska positioner styrker verklig väntan', async () => {
    const tokens = await notify();
    expect(tokens).toMatchObject({
      message: 'PHOENIX inväntar broöppning vid Stridsbergsbron',
      eta_minutes: -1,
      eta_available: false,
      already_passed: false,
      direction: 'norrut',
    });
    // Presentationen ska inte ändra ETA:n till målbron i domänmodellen.
    expect(vessel.etaMinutes).toBe(3);
  });

  test.each(['Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron'])(
    'väntan vid %s saknar minutprognos även för current-källan', async (bridge) => {
      stopAt(bridge);
      const tokens = await notify(bridge, 'current', 230);
      expect(tokens.message).toBe(`PHOENIX inväntar broöppning vid ${bridge}`);
      expect(tokens.eta_minutes).toBe(-1);
      expect(tokens.eta_available).toBe(false);
    },
  );

  test.each([0.5, 1.5, 1.8, 3.5, 4.3, 4.8, 6.4])('geografisk waiting vid %s knop påstår inte att båten väntar', async (speed) => {
    vessel.sog = speed;
    const tokens = await notify();
    expect(tokens.message).toContain('närmar sig Stridsbergsbron');
    expect(tokens.eta_available).toBe(true);
  });

  test('en ensam stoppfix blir inte väntbevis av att tiden går', async () => {
    vessel.timestamp = vessel._stationarySince;
    const tokens = await notify();
    expect(tokens.message).not.toContain('inväntar');
  });

  test('närmaste bro är inte automatiskt den bro båten väntar vid', async () => {
    const tokens = await notify('Järnvägsbron', 'current', 200);
    expect(tokens.message).toContain('närmar sig Järnvägsbron');
    expect(tokens.eta_available).toBe(false); // ingen fartprognos till den andra bron
  });

  test('väntan vid mellanbro tar inte bort målbrons ETA', async () => {
    stopAt('Järnvägsbron');
    const tokens = await notify();
    expect(tokens.message).toBe('PHOENIX närmar sig Stridsbergsbron, beräknad ankomst om 3 minuter');
    expect(tokens.eta_minutes).toBe(3);
  });

  test.each(['approaching', 'under-bridge'])(
    'kommitterad väntbro gäller före timer-konsumenten hunnit ersätta status %s', async (oldStatus) => {
      vessel.status = oldStatus;
      const tokens = await notify();
      expect(tokens.message).toContain('inväntar broöppning');
      expect(tokens.eta_available).toBe(false);
    },
  );

  test('gammal waiting-status räcker inte när ny slutstatus rensat väntbron', async () => {
    vessel.waitingAtBridge = null;
    vessel._bridgeQueueApproaches = {};
    const tokens = await notify();
    expect(tokens.message).toContain('närmar sig');
    expect(tokens.eta_available).toBe(true);
  });

  test.each(['Stallbackabron', 'Kanalinfarten'])(
    '%s får aldrig text om att invänta broöppning', async (bridge) => {
      vessel.waitingAtBridge = bridge;
      vessel.sog = 2;
      const tokens = await notify(bridge, 'current', 250);
      expect(tokens.message).toContain(`närmar sig ${bridge}`);
      expect(tokens.eta_available).toBe(true);
    },
  );

  test.each(['just-passed', 'passage-fallback', 'exit-fallback'])(
    '%s behåller efterhandsformen före eventuell väntan', async (source) => {
      const tokens = await notify('Stridsbergsbron', source);
      expect(tokens.message).not.toContain('inväntar');
      expect(tokens.already_passed).toBe(true);
      expect(tokens.eta_minutes).toBe(-1);
    },
  );

  test('nyss bokförd målpassage har företräde över äldre väntbro och lagrad ETA', async () => {
    vessel.lastPassedBridge = 'Stridsbergsbron';
    vessel.lastPassedBridgeTime = Date.now();
    const tokens = await notify();
    expect(tokens.message).toBe('PHOENIX har precis passerat Stridsbergsbron');
    expect(tokens.already_passed).toBe(true);
    expect(tokens.eta_available).toBe(false);
  });

  test.each([
    { _gpsJumpDetected: true },
    { _positionUncertain: true },
    { passedBridges: ['Stridsbergsbron'] },
    { _bridgeOpeningBridgeName: 'Stridsbergsbron', _bridgeOpeningUntil: Date.now() + 60000 },
  ])('osäkert eller passerat väntläge används inte: %p', async (fields) => {
    Object.assign(vessel, fields);
    const tokens = await notify();
    expect(tokens.message).not.toContain('inväntar');
  });

  test('okänt båtnamn får svensk vänttext och samma deduplicering', async () => {
    vessel.name = 'Unknown';
    app._lookupVesselName = jest.fn().mockReturnValue(null);
    const tokens = await notify();
    expect(tokens.message).toBe('Okänd båt inväntar broöppning vid Stridsbergsbron');
    await notify();
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });
});
