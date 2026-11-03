'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const TriggerPointVisitTracker = require('../lib/services/TriggerPointVisitTracker');
const { BRIDGES, TRIGGER_POINTS } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

/**
 * Helgranskningen 2026-11-03: en borttagning med FULLBORDAD resa (förbi sista
 * bron och utanför kanalens utfartslatitud) är ett positionsbevis för utfärd.
 *
 * Spåraren kräver två rena fixar bortom 350 m för att se utfärden. Vid resans
 * sista punkt kunde den aldrig få dem: elimineringen sker ~300 m bortom punkten
 * och reentry-blocket kastar båtens AIS i 10 min. Besöket blev evigt öppet, och
 * en båt som kom tillbaka dagar senare tappade sin första notis. HELGE tappade
 * så sin Stallbackanotis i en kedjad replay med det persisterade minnet, och
 * enhetens egna startlägen 9/9–18/9 bar sådana poster i upp till elva dygn.
 * Besöksregeln 2026-09-07 gäller fortfarande: tystnad, förtöjning och timeout
 * utan fullbordad resa avslutar inget besök.
 */
const MMSI = '244750397';
const STALLBACKA = BRIDGES.stallbackabron;
const KEY = `${MMSI}:Stallbackabron`;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const northOf = (point, metres) => ({ lat: point.lat + metres / 111320, lon: point.lon });

describe('Fullbordad resa stänger resans öppna besök', () => {
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

  const vesselAt = (metresNorth, extra = {}) => ({
    mmsi: MMSI,
    name: 'HELGE',
    ...northOf(STALLBACKA, metresNorth),
    sog: 6,
    cog: 20,
    _routeDirection: 'north',
    _hasMovementProof: true,
    passedBridges: ['Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron'],
    status: 'en-route',
    targetBridge: null,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aishub',
    ...extra,
  });
  const notifyStallbacka = (app, vessel) => app._triggerBoatNearFlowForBridge(vessel, {
    name: STALLBACKA.name,
    id: 'stallbackabron',
    distance: geometry.calculateDistance(vessel.lat, vessel.lon, STALLBACKA.lat, STALLBACKA.lon),
    source: 'current',
  });
  const stallbackaCalls = (app) => app._boatNearTrigger.trigger.mock.calls
    .filter(([tokens]) => tokens.bridge_name === STALLBACKA.name);
  const later = (minutes) => jest.setSystemTime(Date.now() + minutes * 60000);
  // Elimineringens snapshot: förbi Stallbackabron och norr om utfartslatituden.
  const completedSnapshot = () => vesselAt(360, {
    lastPassedBridge: 'Stallbackabron',
    passedBridges: ['Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron'],
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-07T10:00:00Z'));
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

  test('HELGE: elimineringen stänger Stallbackabesöket och returen tre dygn senare notifieras', async () => {
    const app = await boot();
    await notifyStallbacka(app, vesselAt(-120));
    expect(stallbackaCalls(app)).toHaveLength(1);
    expect(app._triggerPointVisits.holds(MMSI, STALLBACKA.name)).toBe(true);

    later(2);
    const snapshot = completedSnapshot();
    expect(app.vesselDataService.vesselLifecycleManager.hasCompletedJourney(snapshot)).toBe(true);
    await app._onVesselRemoved({ mmsi: MMSI, vessel: snapshot, reason: 'journey-completed' });
    expect(store.trigger_point_visits.entries[KEY].exitedAt).not.toBeNull();
    expect(app.log.mock.calls.some(([msg]) => String(msg).includes('TRIGGER_POINT_VISIT_EXIT'))).toBe(true);

    // Omstart däremellan: stängningen är persisterad, inte bara i minnet.
    await app.onUninit();
    const restarted = await boot();
    later(3 * 24 * 60);
    const returned = vesselAt(133, { cog: 200, _routeDirection: 'south', passedBridges: [] });
    await restarted._onVesselEntered({ mmsi: MMSI, vessel: returned });
    await notifyStallbacka(restarted, returned);
    expect(stallbackaCalls(restarted)).toHaveLength(1);
    expect(restarted.error).not.toHaveBeenCalled();
  });

  test('timeout utan fullbordad resa (förtöjd 100 m norr om bron) stänger inget besök', async () => {
    const app = await boot();
    await notifyStallbacka(app, vesselAt(-120));
    later(31);
    const moored = vesselAt(100, {
      sog: 0,
      lastPassedBridge: 'Stallbackabron',
      passedBridges: ['Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron'],
    });
    expect(app.vesselDataService.vesselLifecycleManager.hasCompletedJourney(moored)).toBe(false);
    await app._onVesselRemoved({ mmsi: MMSI, vessel: moored, reason: 'timeout' });
    expect(store.trigger_point_visits.entries[KEY].exitedAt).toBeNull();

    later(60);
    const back = vesselAt(100, { sog: 0 });
    await app._onVesselEntered({ mmsi: MMSI, vessel: back });
    await notifyStallbacka(app, back);
    expect(stallbackaCalls(app)).toHaveLength(1);
  });

  test('en återfödd båt under borttagningen behåller sina besök', async () => {
    const app = await boot();
    await notifyStallbacka(app, vesselAt(-120));
    later(2);
    jest.spyOn(app.vesselDataService, 'getVessel').mockReturnValue(vesselAt(380));
    await app._onVesselRemoved({ mmsi: MMSI, vessel: completedSnapshot(), reason: 'journey-completed' });
    expect(app._triggerPointVisits.exportSnapshot().entries[KEY].exitedAt).toBeNull();
  });
});

describe('TriggerPointVisitTracker.closeOpenVisits', () => {
  let now;
  let tracker;
  const fixAt = (point, metresNorth, mmsi = MMSI) => ({
    mmsi,
    ...northOf(point, metresNorth),
    timestamp: now,
    lastPositionUpdate: now,
    fixTs: now,
    fixFeed: 'aishub',
  });

  beforeEach(() => {
    now = Date.parse('2026-07-07T10:00:00Z');
    tracker = new TriggerPointVisitTracker({ now: () => now });
  });

  test('stänger bara fartygets öppna besök och posterna klarar en omstart', () => {
    const kanal = TRIGGER_POINTS.kanalinfarten;
    expect(tracker.reserve(fixAt(STALLBACKA, -100), STALLBACKA.name)).not.toBeNull();
    expect(tracker.reserve(fixAt(kanal, 100), kanal.name)).not.toBeNull();
    expect(tracker.reserve(fixAt(STALLBACKA, -100, '265000001'), STALLBACKA.name)).not.toBeNull();
    now += 60000;

    expect(tracker.closeOpenVisits(MMSI).sort()).toEqual(['Kanalinfarten', 'Stallbackabron']);
    expect(tracker.closeOpenVisits(MMSI)).toEqual([]);
    expect(tracker.closeOpenVisits('inte-ett-mmsi')).toEqual([]);

    const snapshot = tracker.exportSnapshot();
    expect(snapshot.entries[KEY].exitedAt).toBe(now);
    expect(snapshot.entries['265000001:Stallbackabron'].exitedAt).toBeNull();
    const restored = new TriggerPointVisitTracker({ now: () => now });
    expect(restored.loadSnapshot(snapshot)).toBe(3);
    expect(restored.exportSnapshot()).toEqual(snapshot);
  });

  test('ett stängt besök släpps av en återkomst inom 300 m och gallras annars efter sex timmar', () => {
    tracker.reserve(fixAt(STALLBACKA, -100), STALLBACKA.name);
    now += 60000;
    tracker.closeOpenVisits(MMSI);

    now += 60 * 60 * 1000;
    expect(tracker.observe(fixAt(STALLBACKA, 133), STALLBACKA.name)).toEqual({ changed: true, reentered: true });
    expect(tracker.holds(MMSI, STALLBACKA.name)).toBe(false);

    tracker.reserve(fixAt(STALLBACKA, -100), STALLBACKA.name);
    now += 60000;
    tracker.closeOpenVisits(MMSI);
    now += 6 * 60 * 60 * 1000 + 1;
    expect(tracker.exportSnapshot().entries[KEY]).toBeUndefined();
  });
});
