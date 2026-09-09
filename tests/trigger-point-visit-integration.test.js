'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGES, TRIGGER_POINTS } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

const MMSI = '265009071';
const KEY = `${MMSI}:Kanalinfarten`;
const POINT = TRIGGER_POINTS.kanalinfarten;
const AREAS = Object.entries({ ...BRIDGES, ...TRIGGER_POINTS })
  .map(([id, area]) => ({ id, ...area }));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const deferred = () => {
  let reject;
  const promise = new Promise((resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
};
const vesselAt = (distanceM = 100, extra = {}) => ({
  mmsi: MMSI,
  name: 'BESOKAREN',
  lat: POINT.lat + distanceM / 111320,
  lon: POINT.lon,
  sog: 3,
  cog: 180,
  _routeDirection: 'south',
  _hasMovementProof: true,
  passedBridges: [],
  status: 'en-route',
  timestamp: Date.now(),
  lastPositionUpdate: Date.now(),
  fixTs: Date.now(),
  fixFeed: 'aishub',
  ...extra,
});
const vesselAtArea = (area, distanceM = 100, extra = {}) => vesselAt(distanceM, {
  lat: area.lat + distanceM / 111320,
  lon: area.lon,
  ...extra,
});
const candidate = {
  name: POINT.name, id: 'kanalinfarten', distance: 100, source: 'trigger-point',
};

describe('Alla sex områdens besöksminne genom appens Flow- och livscykelvägar', () => {
  let store;
  let apps;
  let savedTestMode;

  const boot = async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => clone(store[key]),
        set: jest.fn((key, value) => {
          store[key] = clone(value);
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    apps.push(app);
    jest.spyOn(app._boatNearTrigger, 'trigger');
    return app;
  };

  const notify = (app, vessel = vesselAt()) => app._triggerBoatNearFlowForBridge(vessel, candidate);
  const pointCalls = (app) => app._boatNearTrigger.trigger.mock.calls
    .filter(([tokens]) => tokens.bridge_name === POINT.name);
  const areaCalls = (app, area) => app._boatNearTrigger.trigger.mock.calls
    .filter(([tokens]) => tokens.bridge_name === area.name);
  const notifyArea = (app, area, vessel = vesselAtArea(area)) => app._triggerBoatNearFlowForBridge(vessel, {
    name: area.name,
    id: area.id,
    distance: geometry.calculateDistance(vessel.lat, vessel.lon, area.lat, area.lon),
    source: area.id === 'kanalinfarten' ? 'trigger-point' : 'current',
  });
  const later = (minutes, distanceM = 100, extra = {}) => {
    jest.setSystemTime(Date.now() + minutes * 60000);
    return vesselAt(distanceM, extra);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-07T10:00:00Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    store = {};
    apps = [];
  });

  afterEach(async () => {
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      if (!app._shuttingDown) await app.onUninit();
    }
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('åtta timmars samma besök överlever legacy-prune och full settings-omstart', async () => {
    const app = await boot();
    await notify(app);
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(1);
    const originalNoticeTime = app._persistentRecentTriggers.get(KEY).t;
    for (let hour = 1; hour <= 8; hour++) {
      const vessel = later(60, 100, { sog: 0, lastPositionUpdate: originalNoticeTime });
      app._observeTriggerPointVisits(vessel);
      app._pruneDedupCaches();
      // eslint-disable-next-line no-await-in-loop
      await notify(app, vessel);
    }
    expect(app._persistentRecentTriggers.has(KEY)).toBe(false);
    expect(app._triggeredBoatNearKeys.has(KEY)).toBe(false);
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(1);

    await app.onUninit();
    const restarted = await boot();
    await notify(restarted, vesselAt(100, { sog: 0 }));
    await restarted._triggerBoatNearFlowFallback(vesselAt(), POINT.name, { detectionTs: Date.now() });
    expect(restarted._boatNearTrigger.trigger).not.toHaveBeenCalled();
    expect(restarted._triggerPointVisits.holds(MMSI)).toBe(true);
  });

  test('AIS-timeout och återfödelse på samma plats avslutar inte besöket', async () => {
    const app = await boot();
    const original = vesselAt();
    await notify(app, original);
    later(31);
    await app._onVesselRemoved({ mmsi: MMSI, vessel: original, reason: 'timeout' });
    expect(app._triggeredBoatNearKeys.has(KEY)).toBe(false);
    expect(app._triggerPointVisits.holds(MMSI)).toBe(true);
    const reborn = vesselAt(100, { _trackingEpisodeStartTs: Date.now() });
    await app._onVesselEntered({ mmsi: MMSI, vessel: reborn });
    await notify(app, reborn);
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(1);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('två rena utfärdsfix genom entered/updated och återkomst släpper samma riktning inom två timmar', async () => {
    const app = await boot();
    await notify(app);
    const firstOutside = later(1, 450);
    await app._onVesselEntered({ mmsi: MMSI, vessel: firstOutside });
    const secondOutside = later(1, 460);
    await app._onVesselUpdated({ mmsi: MMSI, vessel: secondOutside, oldVessel: firstOutside });
    expect(store.trigger_point_visits.entries[KEY].exitedAt).not.toBeNull();
    expect(app._persistentRecentTriggers.has(KEY)).toBe(true);

    const returned = later(1);
    await app._onVesselEntered({ mmsi: MMSI, vessel: returned });
    expect(app._persistentRecentTriggers.has(KEY)).toBe(false);
    expect(app._triggeredBoatNearKeys.has(KEY)).toBe(false);
    expect(store.persistent_recent_triggers[KEY]).toBeUndefined();
    await notify(app, returned);
    expect(pointCalls(app)).toHaveLength(2);
    expect(app._triggerPointVisits.holds(MMSI)).toBe(true);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('GPS-karantän i VDS kan inte frigöra ett besök via appens observationskrok', async () => {
    const app = await boot();
    await notify(app);
    const hold = jest.spyOn(app.vesselDataService, 'hasGpsJumpHold').mockReturnValue(true);
    await app._onVesselEntered({ mmsi: MMSI, vessel: later(1, 450) });
    await app._onVesselUpdated({ mmsi: MMSI, vessel: later(1, 460), oldVessel: null });
    hold.mockReturnValue(false);
    const returned = later(1);
    await app._onVesselEntered({ mmsi: MMSI, vessel: returned });
    await notify(app, returned);
    expect(pointCalls(app)).toHaveLength(1);
    expect(app._triggerPointVisits.holds(MMSI)).toBe(true);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('reserve sker före await och Flow-fel rullar tillbaka båda persistenslagren för retry', async () => {
    const app = await boot();
    const pending = deferred();
    app._boatNearTrigger.trigger.mockImplementationOnce(() => pending.promise);
    const attempt = notify(app);
    expect(store.trigger_point_visits.entries[KEY]).toBeDefined();
    expect(store.persistent_recent_triggers[KEY]).toBeDefined();
    await notify(app);
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(1);
    app._observeTriggerPointVisits(later(1));
    pending.reject(new Error('Homey Flow kunde inte levereras'));
    await attempt;
    expect(store.trigger_point_visits.entries[KEY]).toBeUndefined();
    expect(store.persistent_recent_triggers[KEY]).toBeUndefined();
    expect(app._triggeredBoatNearKeys.has(KEY)).toBe(false);
    await notify(app, later(1));
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(2);
    expect(app._triggerPointVisits.holds(MMSI)).toBe(true);
  });

  test('ett sent misslyckat Flow från förra besöket kan inte radera nästa besöks spärr', async () => {
    const app = await boot();
    const pending = deferred();
    app._boatNearTrigger.trigger.mockImplementationOnce(() => pending.promise);
    const oldAttempt = notify(app);
    app._observeTriggerPointVisits(later(1, 450));
    app._observeTriggerPointVisits(later(1, 460));
    const returned = later(1);
    app._observeTriggerPointVisits(returned);
    await notify(app, returned);
    const newStoredVisit = clone(store.trigger_point_visits.entries[KEY]);
    const newPersistentEntry = app._persistentRecentTriggers.get(KEY);
    pending.reject(new Error('Förra Flow-anropet misslyckades sent'));
    await oldAttempt;
    expect(app._persistentRecentTriggers.get(KEY)).toBe(newPersistentEntry);
    expect(store.trigger_point_visits.entries[KEY]).toEqual(newStoredVisit);
    expect(app._triggerPointVisits.holds(MMSI)).toBe(true);
    await notify(app, later(1));
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(2);
  });

  test('första utfärdsfixen persisteras direkt och överlever omstart utan onUninit', async () => {
    const app = await boot();
    await notify(app);
    app._observeTriggerPointVisits(later(1, 450));
    expect(store.trigger_point_visits.entries[KEY].outsideFixTs).not.toBeNull();
    const restarted = await boot();
    restarted._observeTriggerPointVisits(later(1, 460));
    const returned = later(1);
    restarted._observeTriggerPointVisits(returned);
    await notify(restarted, returned);
    expect(restarted._boatNearTrigger.trigger).toHaveBeenCalledTimes(1);
    expect(restarted._triggerPointVisits.holds(MMSI)).toBe(true);
  });

  test('onUninit flushar senaste rena fix trots att oförändrat besök inte skriver settings varje tick', async () => {
    const app = await boot();
    await notify(app);
    const storedFix = store.trigger_point_visits.entries[KEY].lastFixTs;
    const nextFix = later(1);
    app._observeTriggerPointVisits(nextFix);
    expect(store.trigger_point_visits.entries[KEY].lastFixTs).toBe(storedFix);
    await app.onUninit();
    expect(store.trigger_point_visits.entries[KEY].lastFixTs).toBe(nextFix.fixTs);
    const restarted = await boot();
    await notify(restarted, later(1));
    expect(restarted._boatNearTrigger.trigger).not.toHaveBeenCalled();
  });

  test.each(['number', 'object'])('legacy %s behåller tvåtimmarsskyddet och skapar besök först vid faktisk ny notis', async (format) => {
    const t = Date.now() - 60 * 60000;
    store.persistent_recent_triggers = { [KEY]: format === 'number' ? t : { t, dir: 'south' } };
    const app = await boot();
    app._observeTriggerPointVisits(vesselAt());
    await notify(app);
    expect(app._boatNearTrigger.trigger).not.toHaveBeenCalled();
    expect(app._triggerPointVisits.holds(MMSI)).toBe(false);
    const afterWindow = later(61);
    app._observeTriggerPointVisits(afterWindow);
    await notify(app, afterWindow);
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(1);
    expect(app._triggerPointVisits.holds(MMSI)).toBe(true);
    expect(store.trigger_point_visits.entries[KEY]).toBeDefined();
  });

  test('samma fartyg kan notifieras oberoende vid var och en av de fem broarna och Kanalinfarten', async () => {
    const app = await boot();
    for (const area of AREAS) {
      // eslint-disable-next-line no-await-in-loop
      await notifyArea(app, area);
      expect(areaCalls(app, area)).toHaveLength(1);
      expect(app._triggerPointVisits.holds(MMSI, area.name)).toBe(true);
    }
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(6);
    expect(Object.keys(store.trigger_point_visits.entries)).toHaveLength(6);
  });

  test('sparat v1-besök migreras vid riktig appstart till endast Kanalinfartens v2-nyckel', async () => {
    const t = Date.now() - 8 * 3600000;
    store.trigger_point_visits = {
      version: 1,
      entries: {
        [MMSI]: {
          startedAt: t, lastFixTs: t, outsideFixTs: null, exitedAt: null,
        },
      },
    };
    const app = await boot();
    await notify(app);
    expect(pointCalls(app)).toHaveLength(0);
    for (const area of AREAS.filter((entry) => entry.id !== 'kanalinfarten')) {
      expect(app._triggerPointVisits.holds(MMSI, area.name)).toBe(false);
      // eslint-disable-next-line no-await-in-loop
      await notifyArea(app, area);
      expect(areaCalls(app, area)).toHaveLength(1);
    }
    await app.onUninit();
    expect(store.trigger_point_visits.version).toBe(2);
    expect(store.trigger_point_visits.entries[MMSI]).toBeUndefined();
    expect(store.trigger_point_visits.entries[KEY]).toBeDefined();
    expect(Object.keys(store.trigger_point_visits.entries)).toHaveLength(6);
  });

  test('första historiska fallback långt från bron uppfinner inget aktivt områdesbesök', async () => {
    const area = AREAS.find((entry) => entry.name === 'Klaffbron');
    const app = await boot();
    const far = vesselAtArea(area, 800, { _routeDirection: 'north', cog: 0 });
    await app._triggerBoatNearFlowFallback(far, area.name, {
      detectionTs: Date.now(), inferredFlush: true,
    });
    expect(areaCalls(app, area)).toHaveLength(1);
    expect(app._triggerPointVisits.holds(MMSI, area.name)).toBe(false);
    later(121);
    const newVisit = vesselAtArea(area, 100, { _routeDirection: 'north', cog: 0 });
    app._observeTriggerPointVisits(newVisit);
    await notifyArea(app, area, newVisit);
    expect(areaCalls(app, area)).toHaveLength(2);
    expect(app._triggerPointVisits.holds(MMSI, area.name)).toBe(true);
  });

  test.each(AREAS)('$name: åtta timmars kö, resereset och passage inom samma område ger bara en notis', async (area) => {
    const app = await boot();
    await notifyArea(app, area);
    const originalTime = Date.now();
    for (let hour = 1; hour <= 8; hour++) {
      later(60);
      const waiting = vesselAtArea(area, 100, {
        sog: 0, status: 'waiting', lastPositionUpdate: originalTime,
      });
      app._observeTriggerPointVisits(waiting);
      app._pruneDedupCaches();
      if (hour === 4) app._clearBoatNearTriggers(waiting, true);
      // eslint-disable-next-line no-await-in-loop
      await notifyArea(app, area, waiting);
    }
    later(1);
    const passed = vesselAtArea(area, -70, {
      status: 'passed',
      passedBridges: [area.name],
      lastPassedBridge: area.name,
      lastPassedBridgeTime: Date.now(),
    });
    app._observeTriggerPointVisits(passed);
    await app._triggerBoatNearFlowFallback(passed, area.name, { detectionTs: Date.now() });
    expect(areaCalls(app, area)).toHaveLength(1);

    await app.onUninit();
    const restarted = await boot();
    await notifyArea(restarted, area, vesselAtArea(area, -70));
    expect(areaCalls(restarted, area)).toHaveLength(0);
    expect(restarted._triggerPointVisits.holds(MMSI, area.name)).toBe(true);
  });

  test.each(AREAS.flatMap((area) => [
    { ...area, returnDirection: 'south' },
    { ...area, returnDirection: 'north' },
  ]))('$name: styrkt utfärd och återkomst $returnDirection inom två timmar tillåter ny notis', async (area) => {
    const app = await boot();
    await notifyArea(app, area);
    later(1);
    app._observeTriggerPointVisits(vesselAtArea(area, 450));
    later(1);
    app._observeTriggerPointVisits(vesselAtArea(area, 460));
    later(1);
    const returned = vesselAtArea(area, 100, {
      _routeDirection: area.returnDirection,
      cog: area.returnDirection === 'north' ? 0 : 180,
    });
    app._observeTriggerPointVisits(returned);
    expect(app._persistentRecentTriggers.has(`${MMSI}:${area.name}`)).toBe(false);
    await notifyArea(app, area, returned);
    expect(areaCalls(app, area)).toHaveLength(2);
  });

  test.each(AREAS)('$name: riktningsvändning och legacy-reset inne i området skapar inget nytt besök', async (area) => {
    const app = await boot();
    await notifyArea(app, area);
    later(1);
    const reversed = vesselAtArea(area, 120, { _routeDirection: 'north', cog: 0 });
    app._clearBoatNearTriggers(reversed, true);
    app._observeTriggerPointVisits(reversed);
    await notifyArea(app, area, reversed);
    expect(areaCalls(app, area)).toHaveLength(1);
    expect(app._triggerPointVisits.holds(MMSI, area.name)).toBe(true);
  });

  test('AIS-bortfall vid en bro tar bort levande data medan endast besöksspärren överlever omstart', async () => {
    const area = AREAS.find((entry) => entry.name === 'Klaffbron');
    const app = await boot();
    const vessel = vesselAtArea(area, 100, { targetBridge: area.name, status: 'waiting' });
    app.vesselDataService.vessels.set(MMSI, vessel);
    await notifyArea(app, area, vessel);
    later(31);
    expect(app.vesselDataService.sweepStaleVessels()).toBe(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(app.vesselDataService.getAllVessels()).toEqual([]);
    expect(app._triggerPointVisits.holds(MMSI, area.name)).toBe(true);
    await app.onUninit();
    const restarted = await boot();
    expect(restarted.vesselDataService.getAllVessels()).toEqual([]);
    expect(restarted._triggerPointVisits.holds(MMSI, area.name)).toBe(true);
    await notifyArea(restarted, area);
    expect(areaCalls(restarted, area)).toHaveLength(0);
  });
});
