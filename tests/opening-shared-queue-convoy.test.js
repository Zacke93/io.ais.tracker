'use strict';

const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES } = require('../lib/constants');
const { waitingBridge } = require('../lib/utils/bridgeQueue');

const START = Date.parse('2026-09-27T14:39:30Z');
const LEAD = '265811640';
const FOLLOWER = '265082640';
const TARGET = 'Stridsbergsbron';
const QUEUE = 'Järnvägsbron';
const LIV_QUEUE = { lat: 58.29066666666667, lon: 12.290853333333333 };
const JOHANNA_QUEUE = { lat: 58.29064, lon: 12.29095 };

describe('En positionsbelagd konvoj delar också en gemensam tidigare brokö', () => {
  let service;
  let warning;
  const boat = (mmsi, distance, extra = {}) => ({
    mmsi,
    lat: BRIDGES.stridsbergsbron.lat - distance / 111320,
    lon: BRIDGES.stridsbergsbron.lon,
    sog: 4.2,
    cog: 30,
    targetBridge: TARGET,
    _routeDirection: 'north',
    _hasMovementProof: true,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aisstream',
    etaMinutes: null,
    status: 'approaching',
    passedBridges: ['Klaffbron'],
    ...extra,
  });
  const arm = (mmsi = FOLLOWER) => service._arms.get(`${mmsi}::${TARGET}`);
  const queued = (mmsi = FOLLOWER, extra = {}) => {
    const position = mmsi === LEAD ? JOHANNA_QUEUE : LIV_QUEUE;
    return boat(mmsi, 384, {
      ...position,
      sog: mmsi === LEAD ? 1.2 : 0.4,
      _stationarySince: Date.now() - 120000,
      _stillnessAnchor: { ...position, t: Date.now() - 120000 },
      _bridgeQueueApproaches: { [QUEUE]: { confirmedAt: START - 120000, direction: 'north' } },
      ...extra,
    });
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    warning = jest.fn();
    service = new Service({ onWarning: warning, targetBridges: [TARGET] });
  });
  afterEach(() => {
    service.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  function startConvoy() {
    service.observeVessel(boat(LEAD, 550));
    service.observeVessel(boat(FOLLOWER, 730));
    jest.setSystemTime(Math.ceil(arm(LEAD).fireDueMs));
    service.tick(); service.tick();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(arm().absorbedAt).not.toBeNull();
    expect(arm().movingConvoyEventId).toBe(arm(LEAD).eventId);
    return arm().eventId;
  }

  function sharedQueue(leadOverrides = {}) {
    jest.setSystemTime(START + 4 * 60000);
    const lead = queued(LEAD, leadOverrides);
    const follower = queued();
    // Samma fysiska kö kan ha olika väntetiketter: JOHANNA sänder 1,2 kn,
    // LIV 0,4 kn. Beviset får därför inte vila enbart på statusnamnet.
    expect(waitingBridge(follower)).toBe(QUEUE);
    service.observeVessel(lead);
    service.observeVessel(follower);
  }

  test.each([0.1, 1.2])('färsk gemensam kö, ledarens fart %s: täckningen består', (sog) => {
    const eventId = startConvoy();
    const coverUntil = arm().coverUntilMs;
    sharedQueue({ sog, fixTs: START + 4 * 60000 - 81000, fixFeed: 'aishub' });
    expect(arm().eventId).toBe(eventId);
    expect(arm().coverUntilMs).toBe(coverUntil);
    expect(arm().releasedFrom.has(eventId)).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('ledarens fix 1,5 s före följarens avgång splittrar inte deras konvoj', () => {
    const eventId = startConvoy();
    sharedQueue();
    expect(arm().eventId).toBe(eventId);
    jest.setSystemTime(START + 7 * 60000);
    service.observeVessel(boat(LEAD, 230, { sog: 5.5, passedBridges: ['Klaffbron', QUEUE] }));
    expect(arm().eventId).toBe(eventId);
    jest.setSystemTime(Date.now() + 1535);
    service.observeVessel(boat(FOLLOWER, 225, { sog: 5.4, passedBridges: ['Klaffbron', QUEUE] }));
    service.tick();
    expect(arm().eventId).toBe(eventId);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('ny egen köfix efter ledarens fortsättning bevisar verklig separation', () => {
    const eventId = startConvoy();
    sharedQueue();
    jest.setSystemTime(START + 6 * 60000);
    service.observeVessel(boat(LEAD, 100, { passedBridges: ['Klaffbron', QUEUE] }));
    jest.setSystemTime(Date.now() + 60000);
    service.observeVessel(queued());
    expect(arm().eventId).toBeNull();
    expect(arm().releasedFrom.has(eventId)).toBe(true);
    jest.setSystemTime(Date.now() + 5 * 60000);
    service.tick();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0].mmsis).toEqual([FOLLOWER]);
  });

  test('en annan båts fix vid exakt samma millisekund återanvänder inte gammalt köbevis', () => {
    const eventId = startConvoy();
    sharedQueue();
    service.observeVessel(boat(LEAD, 230, { sog: 5.5, passedBridges: ['Klaffbron', QUEUE] }));
    service.tick();
    expect(arm().eventId).toBe(eventId);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('tre millisekunders bearbetning döljer inte en ny egen separat köfix', () => {
    const eventId = startConvoy();
    sharedQueue();
    jest.setSystemTime(START + 6 * 60000);
    service.observeVessel(boat(LEAD, 100, { passedBridges: ['Klaffbron', QUEUE] }));
    jest.setSystemTime(Date.now() + 60000);
    const evaluate = service._evaluateBridge.bind(service);
    jest.spyOn(service, '_evaluateBridge').mockImplementation((bridge, reason, now, mmsi) => {
      jest.setSystemTime(Date.now() + 3);
      return evaluate(bridge, reason, now + 3, mmsi);
    });
    service.observeVessel(queued());
    expect(arm().eventId).toBeNull();
    expect(arm().releasedFrom.has(eventId)).toBe(true);
  });

  test.each(['gammal position', 'stor separation', 'tappad målbro'])('%s hos värden kan inte bevisa gemensam kö', (reason) => {
    const eventId = startConvoy();
    jest.setSystemTime(START + 6 * 60000);
    if (reason === 'stor separation') service.observeVessel(boat(LEAD, 1000, { sog: 0.4 }));
    if (reason === 'tappad målbro') service.observeVessel(queued(LEAD, { targetBridge: null }));
    service.observeVessel(queued());
    expect(arm().eventId).toBeNull();
    expect(arm().releasedFrom.has(eventId)).toBe(true);
  });

  test('samma kö förlänger aldrig det redan givna täckningsfönstret', () => {
    startConvoy();
    const coverUntil = arm().coverUntilMs;
    sharedQueue();
    jest.setSystemTime(coverUntil + 1);
    service.tick();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0].mmsis).toEqual([FOLLOWER]);
  });
});
