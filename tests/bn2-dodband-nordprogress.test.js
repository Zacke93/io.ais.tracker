'use strict';

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGES } = require('../lib/constants');
const VesselDataService = require('../lib/services/VesselDataService');

/**
 * F13 (rättningskampanjen 2026-11-04): BN2-luckan i COG-dödbandet.
 *
 * BN2 sätter passerad form när bron ligger mellan sist kända position och den
 * aktuella och hoppet pekar i färdriktningen. Färdriktningen kom ur ruttlåset
 * eller kursen, men kursbanden lämnar östra dödbandet 46–134° öppet. En
 * återfödd norrgående båt utan ruttlås och med nordostlig kurs fick därför
 * ingen färdriktning, och notisen gick i förvarningsform efter korsningen:
 *  - SALTIS (värld 86, AISHub, cog 49,9°): korsning 08:56:38, notis 08:57:32
 *    "närmar sig Olidebron, beräknad ankomst om 1 minut" 115 m efter bron.
 *  - En okänd båt (värld 783, cog 46,2°): korsning 10:54:31, notis 10:55:19
 *    107 m efter bron.
 * Rättningen låter K1:s färska nordprogress bära färdriktningen i dödbandet,
 * med samma kontrakt (_freshNorthProgressMps).
 *
 * Revision 2 (omgranskningen av revision 1, dirigentens JA på fråga 1): samma
 * lucka fanns när kursen SAKNAS. AIS 360 ("ej tillgänglig") och ogiltiga
 * värden blir null i _validateAISMessage, och en återfödd båt utan föregående
 * fixobjekt behåller null. Med kursen 360 på återfödelsefixen fick SALTIS
 * fortfarande "närmar sig Olidebron, beräknad ankomst om 1 minut" 116 m efter
 * bron (granskarens repro, fixturen r2-saltis-utan-kurs.jsonl). Regeln gäller
 * nu båda fallen där kursen inte säger nord eller syd.
 */
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'r2-saltis-dodband.jsonl');
const FIXTURE_UTAN_KURS = path.join(__dirname, 'fixtures', 'r2-saltis-utan-kurs.jsonl');
const OLIDE = BRIDGES.olidebron;
const MMSI = '265316661';
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const northOf = (metres) => ({ lat: OLIDE.lat + metres / 111320, lon: OLIDE.lon });

describe('F13: BN2 när kursen inte säger nord eller syd (östra dödbandet eller ingen kurs)', () => {
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
    return app;
  };

  // Återfödd 115 m norr om Olidebron; sist kända position 7 min gammal och
  // 720 m söder om bron (SALTIS-geometrin). Beviset bär samma stämpel som
  // meddelandet (K1:s färskhetskontrakt).
  const reborn = (extra = {}) => {
    const now = Date.now();
    return {
      mmsi: MMSI,
      name: 'SALTIS',
      ...northOf(115),
      lastPosition: null,
      sog: 5.7,
      cog: 49.9,
      _routeDirection: null,
      targetBridge: null,
      status: 'waiting',
      timestamp: now,
      lastPositionUpdate: now,
      _lastNorthProgress: { mps: 1.968, ts: now },
      ...extra,
    };
  };
  const candidate = { name: OLIDE.name, id: 'olidebron', source: 'current' };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-18T08:57:32.513Z'));
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

  test('färsk nordprogress bär färdriktningen i dödbandet, men inte mot en sydlig kurs eller ett ruttlås', async () => {
    const app = await boot();
    app._lastKnownPositions.set(MMSI, { ...northOf(-720), t: Date.now() - 7 * 60 * 1000 });

    // SALTIS (49,9°) och den okända båten (46,2°): passerad form.
    expect(app._hasGapCrossedNotifiedBridge(reborn(), candidate, 'current')).toBe(true);
    expect(app._hasGapCrossedNotifiedBridge(reborn({ cog: 46.2 }), candidate, 'current')).toBe(true);

    // Beviset måste vara färskt och över ribban, precis som för K1.
    const now = Date.now();
    expect(app._hasGapCrossedNotifiedBridge(
      reborn({ _lastNorthProgress: { mps: 1.968, ts: now - 1 } }), candidate, 'current',
    )).toBe(false);
    expect(app._hasGapCrossedNotifiedBridge(
      reborn({ _lastNorthProgress: { mps: VesselDataService.NORTH_PROGRESS_MIN_MPS - 0.01, ts: now } }),
      candidate, 'current',
    )).toBe(false);
    expect(app._hasGapCrossedNotifiedBridge(reborn({ _lastNorthProgress: null }), candidate, 'current'))
      .toBe(false);

    // Kursen styr fortfarande: en sydlig kurs är en återresa med bron framför
    // båten.
    expect(app._hasGapCrossedNotifiedBridge(reborn({ cog: 205 }), candidate, 'current')).toBe(false);

    // Ett ruttlås söderut vinner över nordprogressen.
    expect(app._hasGapCrossedNotifiedBridge(reborn({ _routeDirection: 'south' }), candidate, 'current'))
      .toBe(false);
  });

  test('utan kurs (AIS 360 → null) bär färsk nordprogress färdriktningen på samma sätt', async () => {
    const app = await boot();
    app._lastKnownPositions.set(MMSI, { ...northOf(-720), t: Date.now() - 7 * 60 * 1000 });
    const now = Date.now();

    // Revision 2: kursen saknas helt (null eller undefined). Förut false.
    expect(app._hasGapCrossedNotifiedBridge(reborn({ cog: null }), candidate, 'current')).toBe(true);
    expect(app._hasGapCrossedNotifiedBridge(reborn({ cog: undefined }), candidate, 'current')).toBe(true);

    // Samma beviskrav som i dödbandet: färskt och över ribban.
    expect(app._hasGapCrossedNotifiedBridge(
      reborn({ cog: null, _lastNorthProgress: { mps: 1.968, ts: now - 1 } }), candidate, 'current',
    )).toBe(false);
    expect(app._hasGapCrossedNotifiedBridge(
      reborn({ cog: null, _lastNorthProgress: { mps: VesselDataService.NORTH_PROGRESS_MIN_MPS - 0.01, ts: now } }),
      candidate, 'current',
    )).toBe(false);
    expect(app._hasGapCrossedNotifiedBridge(reborn({ cog: null, _lastNorthProgress: null }), candidate, 'current'))
      .toBe(false);

    // Ruttlåset går fortfarande först.
    expect(app._hasGapCrossedNotifiedBridge(
      reborn({ cog: null, _routeDirection: 'south' }), candidate, 'current',
    )).toBe(false);

    // Regeln ger aldrig 'south': ett hopp söderut över bron utan kurs (och
    // därmed utan nordprogress) behåller förvarningen.
    app._lastKnownPositions.set(MMSI, { ...northOf(720), t: Date.now() - 7 * 60 * 1000 });
    expect(app._hasGapCrossedNotifiedBridge(
      reborn({ ...northOf(-115), cog: null, _lastNorthProgress: null }), candidate, 'current',
    )).toBe(false);
    // Även om ett felaktigt nordbevis fanns kräver svaret att hoppet gick norrut.
    expect(app._hasGapCrossedNotifiedBridge(
      reborn({ ...northOf(-115), cog: null }), candidate, 'current',
    )).toBe(false);
  });

  test('K1:s Kanalinfartsregel läser samma färskhetskontrakt', async () => {
    const app = await boot();
    const kanal = { name: 'Kanalinfarten', id: 'kanalinfarten', source: 'trigger-point' };
    expect(app._getNotificationDirection(reborn({ _routeDirection: null }), kanal)).toBe('northbound');
    expect(app._getNotificationDirection(
      reborn({ _lastNorthProgress: { mps: 1.968, ts: Date.now() - 1 } }), kanal,
    )).toBe('unknown');
    // K1 själv är orörd (dirigentens beslut): regeln gäller bara östbandet,
    // så en båt utan kurs får fortfarande 'unknown' vid Kanalinfarten.
    expect(app._getNotificationDirection(reborn({ cog: null }), kanal)).toBe('unknown');
  });

  const replay = (fixture) => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), fixture], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
      },
    });
    return JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  };

  test('SALTIS genom hela appen: Olidebron-notisen går i passerad form', () => {
    const result = replay(FIXTURE);
    const notice = result.notifications.find((n) => n.mmsi === MMSI && n.bridge === 'Olidebron');
    // Före rättningen: "SALTIS närmar sig Olidebron, beräknad ankomst om 1 minut".
    expect(notice).toMatchObject({
      t: Date.parse('2026-06-18T08:57:32.513Z'),
      eta: -1,
      alreadyPassed: true,
      message: 'SALTIS passerade Olidebron under AIS-tystnad',
    });
    // Bara formen ändras: samma fem notiser, i samma ordning.
    expect(result.notifications.filter((n) => n.mmsi === MMSI).map((n) => n.bridge))
      .toEqual(['Kanalinfarten', 'Olidebron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron']);
  }, 60000);

  test('SALTIS med kursen 360 ("ej tillgänglig") genom hela appen: också passerad form', () => {
    // Granskarens repro: fixturen är r2-saltis-dodband.jsonl med kursen 360 på
    // återfödelsefixen 08:57:32,513. Korsningen var 08:56:38 norrut (L0).
    const result = replay(FIXTURE_UTAN_KURS);
    const notice = result.notifications.find((n) => n.mmsi === MMSI && n.bridge === 'Olidebron');
    // Före revision 2: "SALTIS närmar sig Olidebron, beräknad ankomst om 1 minut".
    expect(notice).toMatchObject({
      t: Date.parse('2026-06-18T08:57:32.513Z'),
      eta: -1,
      alreadyPassed: true,
      message: 'SALTIS passerade Olidebron under AIS-tystnad',
    });
    expect(result.notifications.filter((n) => n.mmsi === MMSI).map((n) => n.bridge))
      .toEqual(['Kanalinfarten', 'Olidebron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron']);
  }, 60000);
});
