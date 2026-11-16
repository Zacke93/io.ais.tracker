'use strict';

/**
 * U36 (dirigentens beslut 2026-11-16 på ägarens uppdrag, fråga F24): EN GAMMAL
 * SVEPNOTIS HOPPAS ÖVER NÄR APPEN SJÄLV SETT ATT BÅTEN VÄNDE I GLAPPET.
 *
 * Nattjaktens F13 (värld 7432, R1, AISHub klass B): FREJA hörs söderut norr om
 * Stallbackabron 09:15, tystnar i 58 min och hörs igen 10:14 på väg norrut
 * 750 m söder om bron. Återfödelsesvepet (_checkSkippedBridgesFallback,
 * scenario A med sist kända position) skickade "FREJA passerade
 * Stallbackabron under AIS-tystnad" söderut, en passage 55 min gammal i båtens
 * gamla riktning, och tre minuter senare "närmar sig Stallbackabron" norrut.
 * Appen loggade redan själv SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED.
 *
 * Rättningen: när svepets nettoriktning motsägs av den rörelsebevisade
 * levande kursen (sweepLockRelease) och sist kända position är äldre än
 * 17 min (samma ålder som designposten SKIPPA-BRO-ÅLDER-17MIN) skickas inga
 * svepnotiser. Låset och dess släpp sker som förut. Fall där riktningarna
 * stämmer (vändning utanför området, vid boxkanten), färska återfödelser och
 * vändningar som appen inte sett påverkas inte.
 */

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { validateInvariants } = require('./replay-validation/invariants');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const MIN = 60 * 1000;

describe('U36: svepet efter ett glapp med vändning', () => {
  let apps;
  let savedTestMode;
  const MMSI = '265899297';

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
    app.__sweep = [];
    jest.spyOn(app, '_triggerBoatNearFlowFallback').mockImplementation(async (vessel, bridgeName) => {
      app.__sweep.push([bridgeName, app._getDirectionString(vessel)]);
    });
    return app;
  };

  // IRMA-geometrin (R1, F15): återfödd 465 m söder om Klaffbron; sist kända
  // läge 830 m längre söderut. Nettot säger norr (Olidebron korsad norrut).
  const reborn = (extra = {}) => ({
    mmsi: MMSI,
    name: 'IRMA',
    lat: 58.28003,
    lon: 12.28207,
    sog: 4.9,
    cog: 193.5,
    targetBridge: null,
    passedBridges: [],
    _routeDirection: null,
    _firstSeenLat: 58.28003,
    _firstSeenLon: 12.28207,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    ...extra,
  });
  const lastKnown = (app, ageMin, { lat = 58.27257, lon = 12.27504, posT = true } = {}) => {
    const entry = { lat, lon, t: Date.now() - Math.min(ageMin, 13) * MIN };
    if (posT) entry.posT = Date.now() - ageMin * MIN;
    else entry.t = Date.now() - ageMin * MIN;
    app._lastKnownPositions.set(MMSI, entry);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-20T12:05:03.466Z'));
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
    [18, []],
    [43, []],
    [17.1, []],
    [17, [['Olidebron', 'northbound']]],
    [16, [['Olidebron', 'northbound']]],
    [5, [['Olidebron', 'northbound']]],
  ])('vändningen sedd, sist kända position %s min gammal: svepnotiser %j', async (ageMin, expected) => {
    const app = await boot();
    lastKnown(app, ageMin);
    const vessel = reborn();
    await app._checkSkippedBridgesFallback(vessel, null);
    expect(app.__sweep).toEqual(expected);
    // Låset släpps som förut: den levande kursen äger riktningen.
    expect(vessel._routeDirection).toBeNull();
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('[SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED]'));
    const skipped = app.log.mock.calls.some(([line]) => String(line).includes('[SKIPPED_BRIDGES_STALE_AFTER_TURN]'));
    expect(skipped).toBe(expected.length === 0);
  });

  test('positionens egen tid saknas: borttagningstiden avgör åldern', async () => {
    const app = await boot();
    lastKnown(app, 30, { posT: false });
    await app._checkSkippedBridgesFallback(reborn(), null);
    expect(app.__sweep).toEqual([]);
  });

  test.each([
    ['kursen håller med svepet', { cog: 20 }],
    ['farten under 2 kn (vändningen inte bevisad)', { sog: 1.2 }],
    ['kursen i östra dödbandet (osäker)', { cog: 80 }],
    ['kursen saknas', { cog: null }],
  ])('vändningen inte sedd (%s), 43 min: svepnotisen går som förut', async (_label, extra) => {
    const app = await boot();
    lastKnown(app, 43);
    await app._checkSkippedBridgesFallback(reborn(extra), null);
    expect(app.__sweep.map(([bridge]) => bridge)).toEqual(['Olidebron']);
  });

  test('boxkanten: utfart norr om Stallbackabron, vändning utanför området, åter söderut: notisen går', async () => {
    // 265573130-mönstret: sist känd 300 m norr om Stallbackabron på väg norrut,
    // åter 55 min senare 530 m söder om bron på väg söderut. Nettot och
    // kursen säger båda söderut; passagen söderut är den senaste.
    const app = await boot();
    lastKnown(app, 55, { lat: 58.3125, lon: 12.3215 });
    const vessel = reborn({
      lat: 58.3053, lon: 12.3105, cog: 205, sog: 6.2, _firstSeenLat: 58.3053, _firstSeenLon: 12.3105,
    });
    await app._checkSkippedBridgesFallback(vessel, null);
    expect(app.__sweep).toEqual([['Stallbackabron', 'southbound']]);
    expect(vessel._routeDirection).toBe('south');
  });

  test('scenario B (observerat hopp, låst färdriktning) prövas inte', async () => {
    const app = await boot();
    const old = reborn({
      lat: 58.27257, lon: 12.27504, _routeDirection: 'north', timestamp: Date.now() - 25 * MIN,
    });
    const vessel = reborn({ _routeDirection: 'north', lastPosition: { lat: old.lat, lon: old.lon } });
    await app._checkSkippedBridgesFallback(vessel, old);
    expect(app.__sweep.map(([bridge]) => bridge)).toEqual(['Olidebron']);
    expect(app.log.mock.calls.some(([line]) => String(line).includes('[SKIPPED_BRIDGES_STALE_AFTER_TURN]')))
      .toBe(false);
  });
});

describe('Hela appen på nattjaktens F13 (replay)', () => {
  function replay(file) {
    const env = { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' };
    delete env.REPLAY_MONITORING;
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), file], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    });
    return JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  }
  const iso = (t) => new Date(t).toISOString().slice(11, 19);

  test('FREJA: ingen svepnotis söderut 10:13:57; "närmar sig" norrut 10:17:14 står kvar', () => {
    const result = replay(path.join(FIXTURES, 'n2-f13-freja-svep-efter-vandning.jsonl'));
    const stall = result.notifications.filter((n) => n.bridge === 'Stallbackabron');
    expect(stall.map((n) => [iso(n.t), n.direction, n.message])).toEqual([
      ['10:17:14', 'northbound', 'FREJA närmar sig Stallbackabron, beräknad ankomst om 1 minut'],
    ]);
    expect(validateInvariants(result).filter((v) => /NOTIS-DUBBLETT/.test(v))).toEqual([]);
    expect(result.processErrors).toBe(0);
  });

  test('ORION (r2): inga svepnotiser för Kanalinfarten och Olidebron norrut efter 41 min', () => {
    const result = replay(path.join(FIXTURES, 'n2-f13r2-orion-svep-efter-vandning.jsonl'));
    expect(result.notifications.filter((n) => n.source === 'passage-fallback')).toEqual([]);
    const olide = result.notifications.filter((n) => n.bridge === 'Olidebron');
    expect(olide.map((n) => n.direction)).toEqual(['southbound']);
    expect(validateInvariants(result).filter((v) => /NOTIS-DUBBLETT/.test(v))).toEqual([]);
  });
});
