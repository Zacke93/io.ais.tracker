'use strict';

jest.mock('homey');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { QUAY_DEPARTURE_GATE } = require('../lib/constants');
const { waitingBridge } = require('../lib/utils/bridgeQueue');

const MMSI = '265761140';
const DEPARTURE = Date.parse('2026-07-13T07:16:55.444Z');
const ARRIVAL = Date.parse('2026-07-13T08:02:42.751Z');
const CONFIRMED = Date.parse('2026-07-13T08:21:19.872Z');
const input = (t, arrived = false, extra = {}) => ({
  lat: arrived ? 58.290535 : 58.28022,
  lon: arrived ? 12.290996666666667 : 12.28224,
  sog: arrived ? 0 : 2.3,
  cog: arrived ? null : 0,
  name: 'IDUN',
  timestamp: t,
  fixTs: t,
  fixFeed: 'aisstream',
  ...extra,
});

describe('En längre AIS-lucka kräver ny positionsbekräftelse av kön', () => {
  let service;
  let app;
  let coordinator;
  let savedMode;

  beforeEach(() => {
    jest.useFakeTimers({ now: DEPARTURE });
    savedMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = {
      log: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      _openingQuayLedger: new Map(),
      _isNearLearnedMooringSpot: jest.fn(() => false),
    };
    coordinator = new SystemCoordinator(app);
    service = new VesselDataService(app, new BridgeRegistry(), coordinator);
    app.vesselDataService = service;
  });
  afterEach(() => {
    service.clearAllTimers();
    coordinator.destroy();
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedMode;
    jest.useRealTimers();
  });

  function seed(extra = {}) {
    const vessel = service.updateVessel(MMSI, input(DEPARTURE));
    Object.assign(vessel, { targetBridge: 'Klaffbron', _routeDirection: 'north', ...extra });
    // Samma produktionsmetod som matar öppningslagrets rena positionsminne.
    AISBridgeApp.prototype._noteQuayLedgerEntry.call(app, app._openingQuayLedger, MMSI, vessel);
    return vessel;
  }
  function arrive(extra = {}) {
    jest.setSystemTime(ARRIVAL);
    return service.updateVessel(MMSI, input(ARRIVAL, true, extra));
  }
  function confirm(previous, extra = {}, t = CONFIRMED) {
    // Appens befintliga gap-fallback låser redan riktningen efter första
    // återkomsten. Den lika riktningen får inte kasta det nya köbeviset.
    previous._routeDirection = 'north';
    previous._hasMovementProof = true;
    previous._plausibleMovementSeen = true;
    jest.setSystemTime(t);
    return service.updateVessel(MMSI, input(t, true, {
      lat: 58.290544999999995, lon: 12.290938333333335, ...extra,
    }));
  }

  test.each([false, true])('ny kö efter separat fix, med tidigare städsvep=%s', (swept) => {
    const old = seed();
    expect(service._snapshotQueueDeparture(old)).toBeNull(); // KNIGHT-gravregeln är oförändrad.
    if (swept) {
      jest.setSystemTime(DEPARTURE + VesselDataService.STALE_AIS_TIMEOUT_MS);
      expect(service.sweepStaleVessels()).toBe(1);
      expect(service.getVessel(MMSI)).toBeNull();
    }
    const first = arrive();

    expect(first).not.toBe(old);
    expect(first.targetBridge).toBeNull();
    expect(first._hasCorroboratedMovement).toBe(false);
    expect(first.passedBridges).toEqual([]);
    expect(first._queueArrivalCandidate).toMatchObject({ bridge: 'Järnvägsbron', direction: 'north' });
    expect(service._vesselGraves.has(MMSI)).toBe(false);

    const current = confirm(first);

    expect(current.targetBridge).toBe('Stridsbergsbron');
    expect(waitingBridge(current)).toBe('Järnvägsbron');
    expect(current._bridgeQueueApproaches['Järnvägsbron'].confirmedAt).toBe(CONFIRMED);
    expect(current._hasCorroboratedMovement).toBe(true);
  });

  test.each([
    ['ingen rå rörelse', { _rawPositionSog: 0 }],
    ['ärvd fart utan rå prov', { _rawPositionSog: null }],
    ['orimlig fartspik', { _rawPositionSog: 30 }],
    ['GPS-fel', { _gpsJumpDetected: true }],
    ['osäker position', { _positionUncertain: true }],
    ['förtöjd', { _moored: true }],
    ['deklarerad förtöjning', { navStatus: 5 }],
    ['gammal hubfix', { fixFeed: 'aishub', fixTs: DEPARTURE - 20 * 60000 }],
  ])('%s i avgången ger inget köunderlag', (_label, extra) => {
    seed(extra);

    expect(arrive()._queueArrivalCandidate).toBeNull();
  });

  test('AIS-tystnad ensam återupplivar inte den gamla aktiva båten', () => {
    seed();
    const entered = jest.fn();
    service.on('vessel:entered', entered);
    jest.setSystemTime(DEPARTURE + 3 * 3600000);

    service.sweepStaleVessels();

    expect(service.getVessel(MMSI)).toBeNull();
    expect(entered).not.toHaveBeenCalled();
    expect(service.getAllVessels()).toHaveLength(0);
  });

  test('upphörd rörelse ersätter avgångsunderlaget, så kvarliggande kajhistorik inte används', () => {
    const old = seed();
    Object.assign(old, { ...input(DEPARTURE + 60000), sog: 0, _rawPositionSog: 0 });
    AISBridgeApp.prototype._noteQuayLedgerEntry.call(app, app._openingQuayLedger, MMSI, old);

    expect(arrive()._queueArrivalCandidate).toBeNull();
  });

  test('gammal positionskopia från settings saknar rätt att bli en rå avgångsfix', () => {
    app._openingQuayLedger.set(MMSI, {
      lastFix: {
        lat: 58.28022, lon: 12.28224, ts: DEPARTURE, fixTs: DEPARTURE, feed: 'aisstream',
      },
      moving: true,
    });

    expect(arrive()._queueArrivalCandidate).toBeNull();
  });

  test('ren ny fix efter GPS-utslag kan inte använda den osäkra mellanpositionen', () => {
    const vessel = seed({ _gpsJumpDetected: true });
    expect(app._openingQuayLedger.get(MMSI).lastFix).toBeNull();
    Object.assign(vessel, { ...input(DEPARTURE + 1000, true), _rawPositionSog: 0, _gpsJumpDetected: false });
    AISBridgeApp.prototype._noteQuayLedgerEntry.call(app, app._openingQuayLedger, MMSI, vessel);

    expect(arrive()._queueArrivalCandidate).toBeNull();
  });

  test('kajminnets befintliga 2h-gräns räknas från råfixen, inte från removal', () => {
    seed({ lat: 58.273, lon: 12.277 });
    jest.setSystemTime(DEPARTURE + QUAY_DEPARTURE_GATE.MEMORY_MS + 1);

    const vessel = service.updateVessel(MMSI, input(Date.now(), true));

    expect(vessel._queueArrivalCandidate).toBeNull();
    expect(vessel.targetBridge).toBeNull();
  });

  test.each([
    ['omlevererad första fix', { fixTs: ARRIVAL }],
    ['ny GPS-osäkerhet', { _positionUncertain: true }],
    ['ny deklarerad förtöjning', { navStatus: 5 }],
    ['motsatt observerad färdriktning', { _routeDirection: 'south' }],
    ['retur till gamla kajen', { lat: 58.28022, lon: 12.28224 }],
  ])('%s är inte den separata bekräftelsen', (_label, extra) => {
    seed();
    const first = arrive();
    // Produktionsbyggaren härleder GPS-flaggor; pröva flaggvägen direkt på
    // samma bekräftelsemetod som annars körs under updateVessel.
    const current = {
      ...first, ...input(CONFIRMED, true), _routeDirection: 'north', ...extra,
    };
    jest.setSystemTime(CONFIRMED);

    expect(service._confirmRebornQueueApproach(current, first)).toBeNull();
    expect(current._bridgeQueueApproaches['Järnvägsbron']?.confirmedAt).toBeFalsy();
  });

  test('nytt fartygsobjekt efter mer än 30 min får inte bekräfta en gammal ankomstkandidat', () => {
    seed();
    const first = arrive();
    expect(first._queueArrivalCandidate).toBeTruthy();
    // Den senaste kända fixen är nu stilla; någon gammal avgång får inte återtas.
    AISBridgeApp.prototype._noteQuayLedgerEntry.call(app, app._openingQuayLedger, MMSI, first);
    jest.setSystemTime(ARRIVAL + VesselDataService.STALE_AIS_TIMEOUT_MS + 1);

    const current = service.updateVessel(MMSI, input(Date.now(), true));

    expect(current._queueArrivalCandidate).toBeNull();
    expect(current._bridgeQueueApproaches['Järnvägsbron']?.confirmedAt).toBeFalsy();
  });
});

describe('IDUNs fältankomst skyddar verklig långkö', () => {
  let directory;
  let prefix;
  const replayDir = path.join(__dirname, 'replay-validation');
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-gap-queue-'));
    prefix = fs.readFileSync(path.join(replayDir, 'corpora-data/ais-replay-20260712-174434.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => String(row.mmsi) === MMSI && row.aisTimestamp <= CONFIRMED);
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
  const extend = (rows) => {
    const last = prefix.at(-1);
    return [...rows, ...Array.from({ length: 36 }, (_, i) => {
      const t = CONFIRMED + (i + 1) * 5 * 60000;
      return { ...last, aisTimestamp: t, receivedAt: new Date(t).toISOString() };
    })];
  };
  const replay = (rows, name) => {
    const file = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const output = execFileSync(process.execPath, [path.join(replayDir, 'replayRunner.js'), file], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
      },
    });
    const result = JSON.parse(output.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
    return result;
  };

  test('tre timmars färska stillfixar behåller vänttext utan minuter', () => {
    const result = replay(extend(prefix), 'three-hours');
    const relevant = result.bridgeTextTransitions.filter((row) => row.t >= CONFIRMED && row.t <= CONFIRMED + 3 * 3600000);
    expect(relevant.length).toBeGreaterThan(0);
    expect(relevant.every((row) => row.text === 'En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron')).toBe(true);
    const near = result.notifications.filter((row) => row.mmsi === MMSI && row.bridge === 'Järnvägsbron');
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ t: CONFIRMED, message: 'IDUN inväntar broöppning vid Järnvägsbron', eta: -1 });
  });

  test('samma stilla väntplats utan observerad avgång blir ingen bevisad brokö', () => {
    const result = replay(extend(prefix.filter((row) => row.aisTimestamp >= ARRIVAL)), 'no-departure');
    expect(result.bridgeTextTransitions.some((row) => row.t >= ARRIVAL && row.text.includes('väntar vid Järnvägsbron'))).toBe(false);
  });

  test('en omstart mellan ankomst och separat bekräftelse återtar inget gammalt resebevis', () => {
    const result = replay([...prefix, { ctrl: 'restart', aisTimestamp: ARRIVAL + 60000 }], 'restart');
    expect(result.bridgeTextTransitions.some((row) => row.t >= CONFIRMED && row.text.includes('väntar vid Järnvägsbron'))).toBe(false);
  });
});
