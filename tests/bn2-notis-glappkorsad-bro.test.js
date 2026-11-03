'use strict';

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

/**
 * BN2 (helgranskningen 2026-11-03): en bro som korsats i ett observerat hopp
 * fick närhetsnotisen i förvarningsform.
 *
 * Närhetsnotisen (STEG 2b) går före _checkSkippedBridgesFallback, som är den
 * väg som bokför en målbro korsad i glappet. lastPassedBridge pekar då på en
 * tidigare bro, så S4 slår inte till, och fallbackens rättelse dedupas bort.
 * EBONITA fick därför "närmar sig Stridsbergsbron, beräknad ankomst om
 * 1 minut" 160 m NORR om bron efter 14,5 min glapp. FILOU fick samma fel som
 * återfödd båt via statusbytets notis (även i fältloggen). Beviset är gap-
 * kedjans egna fönster: scenario B:s hopp > 0,005° mot föregående fix, eller
 * scenario A:s sist kända position för en återfödd båt, med bron strikt
 * emellan och hoppet i färdriktningen.
 */
const ROOT = path.resolve(__dirname, '..');
const STRIDS = BRIDGES.stridsbergsbron;
const MMSI = '265580000';
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const northOf = (bridge, metres) => ({ lat: bridge.lat + metres / 111320, lon: bridge.lon });

describe('BN2: passerad form för en bro korsad i ett observerat hopp', () => {
  let apps;
  let savedTestMode;

  const boot = async () => {
    const store = {};
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

  // Föregående fix 2 068 m söder om Stridsbergsbron, aktuell 160 m norr om den.
  const FROM = northOf(STRIDS, -2068);
  const vesselAt = (pos, extra = {}) => ({
    mmsi: MMSI,
    name: 'EBONITA',
    ...pos,
    lastPosition: { ...FROM },
    sog: 6,
    cog: 25,
    _routeDirection: 'north',
    _hasMovementProof: true,
    passedBridges: ['Olidebron', 'Klaffbron', 'Järnvägsbron'],
    lastPassedBridge: 'Järnvägsbron',
    lastPassedBridgeTime: Date.now(),
    targetBridge: 'Stridsbergsbron',
    status: 'en-route',
    etaMinutes: 0.7,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aishub',
    ...extra,
  });
  const candidateFor = (vessel, source = 'target') => ({
    name: STRIDS.name,
    id: 'stridsbergsbron',
    distance: Math.round(geometry.calculateDistance(vessel.lat, vessel.lon, STRIDS.lat, STRIDS.lon)),
    source,
  });
  const sentTokens = (app) => app._boatNearTrigger.trigger.mock.calls.map(([tokens]) => tokens);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-03T08:32:59.895Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    apps = [];
  });

  afterEach(async () => {
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      if (!app._shuttingDown) await app.onUninit();
    }
    await jest.advanceTimersByTimeAsync(0);
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('beviset följer gap-kedjans fönster, undantag och färdriktning', async () => {
    const app = await boot();
    const crossed = vesselAt(northOf(STRIDS, 160));
    expect(app._hasGapCrossedNotifiedBridge(crossed, candidateFor(crossed), 'target')).toBe(true);
    // En retroaktiv källa har redan passerad form; bron framför båten inte.
    expect(app._hasGapCrossedNotifiedBridge(crossed, candidateFor(crossed), 'passage-fallback')).toBe(false);
    expect(app._hasGapCrossedNotifiedBridge(crossed, { name: 'Stallbackabron' }, 'current')).toBe(false);

    const smallStep = vesselAt(northOf(STRIDS, 160), { lastPosition: northOf(STRIDS, -300) });
    expect(app._hasGapCrossedNotifiedBridge(smallStep, candidateFor(smallStep), 'target')).toBe(false);

    const returning = vesselAt(northOf(STRIDS, 160), { _routeDirection: 'south', cog: 205 });
    expect(app._hasGapCrossedNotifiedBridge(returning, candidateFor(returning), 'target')).toBe(false);

    const moored = vesselAt(northOf(STRIDS, 160), { _moored: true });
    expect(app._hasGapCrossedNotifiedBridge(moored, candidateFor(moored), 'target')).toBe(false);

    jest.spyOn(app.vesselDataService, 'hasGpsJumpHold').mockReturnValue(true);
    expect(app._hasGapCrossedNotifiedBridge(crossed, candidateFor(crossed), 'target')).toBe(false);
  });

  test('återfödd båt: färsk sist känd position bär beviset, en utgången gör det inte', async () => {
    const app = await boot();
    const reborn = vesselAt(northOf(STRIDS, 160), { lastPosition: null });
    app._lastKnownPositions.set(MMSI, { ...northOf(STRIDS, -400), t: Date.now() - 55 * 60 * 1000 });
    expect(app._hasGapCrossedNotifiedBridge(reborn, candidateFor(reborn, 'current'), 'current')).toBe(true);
    app._lastKnownPositions.set(MMSI, { ...northOf(STRIDS, -400), t: Date.now() - 7 * 60 * 60 * 1000 });
    expect(app._hasGapCrossedNotifiedBridge(reborn, candidateFor(reborn, 'current'), 'current')).toBe(false);
  });

  test('EBONITA-fallet: notisen säger passerade, utan ETA', async () => {
    const app = await boot();
    const vessel = vesselAt(northOf(STRIDS, 160));
    await app._triggerBoatNearFlowForBridge(vessel, candidateFor(vessel));
    const [tokens] = sentTokens(app);
    expect(tokens).toMatchObject({
      bridge_name: 'Stridsbergsbron',
      eta_minutes: -1,
      eta_available: false,
      already_passed: true,
      message: 'EBONITA passerade Stridsbergsbron under AIS-tystnad',
    });
  });

  test('kontroll: utan observerat hopp består förvarningsformen', async () => {
    const app = await boot();
    const vessel = vesselAt(northOf(STRIDS, -160), {
      lastPosition: northOf(STRIDS, -260),
      passedBridges: ['Olidebron', 'Klaffbron'],
      lastPassedBridge: 'Klaffbron',
    });
    await app._triggerBoatNearFlowForBridge(vessel, candidateFor(vessel));
    const [tokens] = sentTokens(app);
    expect(tokens.already_passed).toBe(false);
    expect(tokens.message).toMatch(/^EBONITA närmar sig Stridsbergsbron/);
  });
});

test('rå EBONITA genom hela appen: korsad i glappet ⇒ passerad form, samma tid och avstånd', () => {
  const file = path.join(ROOT, 'tests/replay-validation/corpora-data/ais-replay-20260601-231305.jsonl');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), file], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' },
  });
  const result = JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  const notice = result.notifications.find((n) => n.mmsi === MMSI && n.bridge === 'Stridsbergsbron');
  expect(notice).toMatchObject({
    t: Date.parse('2026-06-03T08:32:59.895Z'),
    distance: 160,
    source: 'target',
    eta: -1,
    alreadyPassed: true,
    message: 'EBONITA  PRINCESS 40 passerade Stridsbergsbron under AIS-tystnad',
  });
}, 120000);
