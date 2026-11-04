'use strict';

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGES } = require('../lib/constants');
const corpora = require('./replay-validation/corpora');

/**
 * Lås för BN2- och TP1-rättelserna (helgranskningen 2026-11-03) i korpusar
 * utan golden-events. runAllCorpora jämför message, eta, already_passed och
 * mellanpassager bara för korpusar med lockEvents, och granskningen av
 * fixvågen 2026-11-04 visade att mutationer som återinför felen klarade hela
 * batteriet. Varje rad är belagd mot gt-passages: rådatans korsning ligger
 * före notisfixen.
 */
const ROOT = path.resolve(__dirname, '..');
const replayCache = new Map();
function replay(id) {
  if (!replayCache.has(id)) {
    const corpus = corpora.find((c) => c.id === id);
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), corpus.jsonl], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
      },
    });
    replayCache.set(id, JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]));
  }
  return replayCache.get(id);
}

// [korpus, mmsi, bro, notistid, källa, avstånd, meddelande, mellanpassage vid notisfixen]
const CASES = [
  // BN2, återfödd utan _routeDirection: cog-reserven bär riktningen (cog 22,9 / 10,1).
  ['20260702-11h', '265571760', 'Stallbackabron', '2026-07-02T10:16:13.829Z', 'current', 177,
    'MARLIN passerade Stallbackabron under AIS-tystnad', false],
  ['20260710-13h', '265063330', 'Stallbackabron', '2026-07-10T11:37:10.230Z', 'current', 211,
    'JOSELINA passerade Stallbackabron under AIS-tystnad', false],
  // BN2, södergående scenario B vid Stallbackabron.
  ['20260713-41h', '211881090', 'Stallbackabron', '2026-07-14T12:11:09.930Z', 'current', 12,
    'HEY JOE passerade Stallbackabron under AIS-tystnad', true],
  // BN2 vid Olidebron: återfödd (LOVA) och scenario B (KOLLAND).
  ['20260804-17h', '265530660', 'Olidebron', '2026-08-04T07:59:40.422Z', 'current', 196,
    'LOVA passerade Olidebron under AIS-tystnad', false],
  ['20260804-17h', '231915000', 'Olidebron', '2026-08-04T15:08:00.971Z', 'current', 26,
    'KOLLAND passerade Olidebron under AIS-tystnad', true],
  // TP1: mellanbrons avståndsreserv.
  ['20260601-41h', '305170000', 'Stallbackabron', '2026-06-03T02:11:48.486Z', 'current', 38,
    'ELISE har precis passerat Stallbackabron', true],
  ['20260710-13h', '244750397', 'Järnvägsbron', '2026-07-10T12:19:34.049Z', 'current', 18,
    'HELGE har precis passerat Järnvägsbron', true],
];

describe('BN2/TP1-rättelserna genom hela appen (olåsta korpusar)', () => {
  test.each(CASES)('%s %s %s %s', (id, mmsi, bridge, iso, source, distance, message, passage) => {
    const result = replay(id);
    const t = Date.parse(iso);
    const notice = result.notifications.find((n) => n.mmsi === mmsi && n.bridge === bridge && n.t === t);
    expect(notice).toMatchObject({
      source, distance, eta: -1, alreadyPassed: true, message,
    });
    const recorded = result.intermediatePassages.some((p) => p.mmsi === mmsi && p.bridge === bridge && p.t === t);
    expect(recorded).toBe(passage);
  }, 120000);
});

describe('BN2: cog-reserven när _routeDirection saknas', () => {
  let apps;
  let savedTestMode;
  const STALL = BRIDGES.stallbackabron;
  const MMSI = '265571760';
  const at = (metres) => ({ lat: STALL.lat + metres / 111320, lon: STALL.lon });
  const boot = async () => {
    const store = {};
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => (store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key]))),
        set: jest.fn((key, value) => {
          store[key] = JSON.parse(JSON.stringify(value));
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    apps.push(app);
    return app;
  };
  // Återfödd båt: ingen lastPosition, färsk sist känd position på andra sidan bron.
  const reborn = (app, nowMetres, lastKnownMetres, cog) => {
    app._lastKnownPositions.set(MMSI, { ...at(lastKnownMetres), t: Date.now() - 20 * 60 * 1000 });
    return {
      mmsi: MMSI,
      name: 'MARLIN',
      ...at(nowMetres),
      lastPosition: null,
      sog: 5,
      cog,
      _routeDirection: null,
      targetBridge: null,
      status: 'en-route',
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-02T10:16:13.829Z'));
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

  test.each([
    ['norr (MARLIN 22,9°)', 177, -3500, 22.9, true],
    ['söder, strikta bandet 215°', -180, 400, 215, true],
    ['söder, breda bandet 240°', -180, 400, 240, true],
    ['dödbandet 90°', 177, -3500, 90, false],
    ['norrkurs men hopp söderut', -180, 400, 10, false],
  ])('%s', async (_label, nowM, lastM, cog, expected) => {
    const app = await boot();
    const vessel = reborn(app, nowM, lastM, cog);
    expect(app._hasGapCrossedNotifiedBridge(vessel, { name: STALL.name }, 'current')).toBe(expected);
  });
});
