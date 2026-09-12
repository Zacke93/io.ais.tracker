'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { VESSEL_GRAVE } = require('../lib/constants');

const DEPARTURE = Date.parse('2026-07-12T07:42:00.070Z');
const ARRIVAL = Date.parse('2026-07-12T08:04:59.804Z');
const CONFIRMED = Date.parse('2026-07-12T08:23:01.404Z');
const AFTER_PASSAGE = Date.parse('2026-07-12T08:35:27.811Z');
const MMSI = '265025880';

describe('Separat bekräftad brokö efter en förlorad avgångsfix', () => {
  let service;
  let now;
  const vessel = (lat, lon, t, extra = {}) => ({
    mmsi: MMSI,
    lat,
    lon,
    timestamp: t,
    lastPositionUpdate: t,
    fixTs: t,
    fixFeed: 'aisstream',
    sog: 0,
    cog: null,
    _rawPositionSog: 0,
    _rawPositionCog: null,
    targetBridge: null,
    _routeDirection: null,
    passedBridges: [],
    _moored: false,
    _gpsJumpDetected: false,
    _positionUncertain: false,
    _hasMovementProof: false,
    _hasCorroboratedMovement: false,
    _plausibleMovementSeen: false,
    ...extra,
  });
  const departure = (extra = {}) => vessel(58.287225, 12.28582, DEPARTURE, {
    sog: 2.3,
    cog: 105.8,
    _rawPositionSog: 2.3,
    _rawPositionCog: 105.8,
    _hasMovementProof: true,
    _plausibleMovementSeen: true,
    ...extra,
  });
  const arrival = (extra = {}) => vessel(58.29059333333333, 12.29057, ARRIVAL, {
    sog: 0.1, _rawPositionSog: 0.1, ...extra,
  });
  beforeEach(() => {
    now = DEPARTURE;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    service = Object.create(VesselDataService.prototype);
    service.bridgeRegistry = new BridgeRegistry();
    service.logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    service._vesselGraves = new Map();
    service.app = { _isNearLearnedMooringSpot: jest.fn(() => false) };
  });
  afterEach(() => jest.restoreAllMocks());

  function seed(start = departure(), end = arrival()) {
    now = DEPARTURE + 10 * 60000;
    service._buryVessel(MMSI, start);
    now = end.timestamp;
    service._applyGraveInheritance(MMSI, end);
    return end;
  }
  function confirm(previous, extra = {}, t = CONFIRMED) {
    now = t;
    const current = vessel(58.290575, 12.290596666666666, t, {
      _queueArrivalCandidate: previous._queueArrivalCandidate, ...extra,
    });
    const direction = service._confirmRebornQueueApproach(current, previous);
    return { current, direction };
  }

  test('ett enda stort positionsben ger varken rörelsebevis, målbro eller riktning', () => {
    const first = seed();
    expect(first._queueArrivalCandidate).toMatchObject({ direction: 'north', bridge: 'Järnvägsbron' });
    expect(first._hasMovementProof).toBe(false);
    expect(first.targetBridge).toBeNull();
    expect(first._routeDirection).toBeNull();
    expect(service.hasRebornQueueArrivalProof(first)).toBe(false);
  });

  test('en separat färsk fix bekräftar KNIGHTs nordliga avgång och väntplats', () => {
    const { current, direction } = confirm(seed());
    expect(direction).toBe('north');
    expect(current._hasCorroboratedMovement).toBe(true);
    expect(service._shouldAssignTargetBridge(current, null)).toBe(true);
    current.targetBridge = service._calculateTargetBridge(current, direction);
    expect(current.targetBridge).toBe('Stridsbergsbron');
    expect(service.hasRebornQueueArrivalProof(current)).toBe(true);
    expect(current._bridgeQueueApproaches['Järnvägsbron'].confirmedAt).toBe(CONFIRMED);
  });

  test('okänd slutfart får använda samma fysiska bevis', () => {
    const first = seed(departure(), arrival({ sog: null, _rawPositionSog: null }));
    expect(confirm(first, { sog: null, _rawPositionSog: null }).direction).toBe('north');
  });

  test('samma bevis fungerar söderut framför Stridsbergsbron', () => {
    const start = departure({ lat: 58.2979, lon: 12.3008 });
    const first = arrival({
      lat: 58.2953,
      lon: 12.297,
      timestamp: DEPARTURE + 10 * 60000,
      lastPositionUpdate: DEPARTURE + 10 * 60000,
      fixTs: DEPARTURE + 10 * 60000,
    });
    now = first.timestamp;
    first._queueArrivalCandidate = service._rebornQueueCandidate(first, service._snapshotQueueDeparture(start));
    const next = confirm(first, { lat: 58.2953, lon: 12.297 }, first.timestamp + 2 * 60000);
    expect(next.direction).toBe('south');
    expect(service._calculateTargetBridge(next.current, next.direction)).toBe('Stridsbergsbron');
  });

  test.each([
    ['SOLUTIONs låga kajfart', { sog: 0.3, _rawPositionSog: 0.3 }],
    ['ärvd fart utan rå fart', { _rawPositionSog: null }],
    ['orimlig fartspik', { sog: 30, _rawPositionSog: 30 }],
    ['GPS-hopp i avgången', { _gpsJumpDetected: true }],
    ['osäker avgångsposition', { _positionUncertain: true }],
    ['förtöjd avgång', { _moored: true }],
    ['deklarerad förtöjning', { navStatus: 5 }],
    ['gammal aktiv resa', { targetBridge: 'Klaffbron', _routeDirection: 'south' }],
    ['tidigare passerad bro', { passedBridges: ['Klaffbron'] }],
    ['gammal hubfix', { fixFeed: 'aishub', fixTs: DEPARTURE - 20 * 60000 }],
  ])('%s är ingen ny avgångskandidat', (_label, extra) => {
    expect(seed(departure(extra))._queueArrivalCandidate).toBeNull();
  });

  test('oförändrad kajposition kan inte ge en kandidat av en fartspik', () => {
    const first = arrival({ lat: 58.28723, lon: 12.28583 });
    expect(seed(departure(), first)._queueArrivalCandidate).toBeFalsy();
  });

  test('204 m långsam norddrift når inte det tidsnormaliserade rörelsebeviset', () => {
    const end = arrival();
    const start = departure({ lat: end.lat - 204 / 111320, lon: end.lon });
    now = end.timestamp;
    expect(service._rebornQueueCandidate(end, service._snapshotQueueDeparture(start))).toBeNull();
  });

  test.each([
    ['aktuell GPS-osäkerhet', { _positionUncertain: true }],
    ['aktuellt GPS-hopp', { _gpsJumpDetected: true }],
    ['deklarerad förtöjning', { navStatus: 5 }],
    ['motsatt riktning', { cog: 180, _rawPositionCog: 180 }],
    ['redan efter brolinjen', { lat: 58.2934, lon: 12.2949 }],
    ['gammal hubfix', { fixFeed: 'aishub', fixTs: ARRIVAL - 20 * 60000 }],
  ])('%s vid återkomsten räcker inte', (_label, extra) => {
    expect(seed(departure(), arrival(extra))._queueArrivalCandidate).toBeNull();
  });

  test('motsatt riktning i avgångsfixen bryter det senare nordbeviset', () => {
    expect(seed(departure({ cog: 180, _rawPositionCog: 180 }))._queueArrivalCandidate).toBeNull();
  });
  test('en inlärd kajplats får inte bli brokö', () => {
    service.app._isNearLearnedMooringSpot.mockReturnValue(true);
    expect(seed()._queueArrivalCandidate).toBeNull();
  });
  test('gravens befintliga TTL är oförändrad även för en verklig förflyttning', () => {
    now = ARRIVAL - VESSEL_GRAVE.TTL_MS;
    service._buryVessel(MMSI, departure());
    now = ARRIVAL;
    const first = arrival();
    service._applyGraveInheritance(MMSI, first);
    expect(first._queueArrivalCandidate).toBeUndefined();
    expect(service._vesselGraves.size).toBe(0);
  });
  test('removal får inte föryngra en för gammal rå rörelsefix', () => {
    const old = departure({ timestamp: ARRIVAL - 31 * 60000, fixTs: ARRIVAL - 31 * 60000 });
    expect(seed(old)._queueArrivalCandidate).toBeNull();
  });
  test('en yngre mottagningstid får inte dölja gammal fysikalisk bas', () => {
    expect(seed(departure({ fixTs: ARRIVAL - 31 * 60000 }))._queueArrivalCandidate).toBeNull();
  });
  test('fysikaliskt omöjligt hopp blir inte riktning trots positiv nordkomponent', () => {
    const first = arrival({ timestamp: DEPARTURE + 1000, fixTs: DEPARTURE + 1000 });
    now = first.timestamp;
    expect(service._rebornQueueCandidate(first, service._snapshotQueueDeparture(departure()))).toBeNull();
  });

  test.each([
    ['aktuellt GPS-hopp', { _gpsJumpDetected: true }],
    ['osäker aktuell position', { _positionUncertain: true }],
    ['förtöjd', { _moored: true }],
    ['navstatus vid kaj', { navStatus: 5 }],
    ['återhopp till avgångsplatsen', { lat: 58.287225, lon: 12.28582 }],
    ['motsatt ny kurs', { cog: 180, _rawPositionCog: 180 }],
    ['redan efter bron', { lat: 58.2934, lon: 12.2949 }],
    ['nytt men gammalt hubfix', { fixFeed: 'aishub', fixTs: ARRIVAL }],
    ['aisstream-eko med oförändrad fixtid', { fixTs: ARRIVAL }],
  ])('%s vid bekräftelsen ger ingen målbro', (_label, extra) => {
    const result = confirm(seed(), extra);
    expect(result.direction).toBeNull();
    expect(result.current._hasMovementProof).toBe(false);
  });
  test('GPS-flaggad första återkomst får inte valideras av ett rent återhopp', () => {
    const first = seed();
    first._gpsJumpDetected = true;
    expect(confirm(first).direction).toBeNull();
  });
  test('nyupptäckt kajplats bryter en ännu obekräftad kökandidat', () => {
    const first = seed();
    service.app._isNearLearnedMooringSpot.mockReturnValue(true);
    expect(confirm(first).direction).toBeNull();
  });
  test('för kort verklig fixseparation får inte förlängas av omleverans', () => {
    const first = seed();
    const early = confirm(first, {}, ARRIVAL + 30000);
    expect(early.direction).toBeNull();
    const echo = confirm(early.current, { fixTs: ARRIVAL + 30000 }, ARRIVAL + 70000);
    expect(echo.direction).toBeNull();
    expect(confirm(echo.current, {}, ARRIVAL + 90000).direction).toBe('north');
  });
  test('timer utan ny fix och nytt objekt efter removal kan inte bekräfta kön', () => {
    const first = seed();
    now = CONFIRMED;
    expect(service._confirmRebornQueueApproach(first, null)).toBeNull();
    const next = arrival({ timestamp: CONFIRMED, fixTs: CONFIRMED });
    expect(service._confirmRebornQueueApproach(next, null)).toBeNull();
    expect(next._hasMovementProof).toBe(false);
  });
  test('obekräftad kandidat förfaller utan att tidsstämplas om', () => {
    const first = seed();
    const next = confirm(first, {}, ARRIVAL + 31 * 60000);
    expect(next.direction).toBeNull();
    expect(next.current._queueArrivalCandidate).toBeNull();
  });
  test('konsumerat köbevis gäller varken vid ny tidpunkt, GPS-osäkerhet eller passerad bro', () => {
    const { current } = confirm(seed());
    current.targetBridge = 'Stridsbergsbron';
    expect(service.hasRebornQueueArrivalProof(current)).toBe(true);
    expect(service.hasRebornQueueArrivalProof({ ...current, timestamp: current.timestamp + 1 })).toBe(false);
    expect(service.hasRebornQueueArrivalProof({ ...current, _gpsJumpDetected: true })).toBe(false);
    expect(service.hasRebornQueueArrivalProof({ ...current, passedBridges: ['Järnvägsbron'] })).toBe(false);
  });
});

describe('KNIGHT OWLs riktiga rådata genom app, notiser och öppningsmotor', () => {
  let directory;
  let raw;
  const replayDir = path.join(__dirname, 'replay-validation');
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-reborn-queue-'));
    raw = fs.readFileSync(path.join(replayDir, 'corpora-data/ais-replay-20260711-232958.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
  function replay(name, rows) {
    const file = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const result = execFileSync(process.execPath, [path.join(replayDir, 'replayRunner.js'), file], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(result.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    expect(parsed.processErrors).toBe(0);
    return parsed;
  }
  const warnings = (result) => result.openingWarnings.filter((w) => w.mmsis.includes(MMSI));
  function changeKnight(fn) {
    return raw.flatMap((row) => (String(row.mmsi) === MMSI ? fn({ ...row }) : [row]));
  }

  test('varnar före passage och visar bekräftad väntplats utan minutprognos', () => {
    const result = replay('field', raw);
    expect(warnings(result)).toHaveLength(1);
    expect(warnings(result)[0]).toMatchObject({
      bridge: 'Stridsbergsbron', t: CONFIRMED + 5 * 60000, direction: 'northbound', success: true, etaMin: -1,
    });
    expect(result.bridgeTextTransitions).toContainEqual({
      t: CONFIRMED + 25,
      iso: new Date(CONFIRMED + 25).toISOString(),
      text: 'En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron',
    });
    const near = result.notifications.filter((n) => n.mmsi === MMSI && n.bridge === 'Järnvägsbron');
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ t: CONFIRMED, alreadyPassed: false, eta: -1 });
    expect(result.targetPassages).toContainEqual({
      t: AFTER_PASSAGE, iso: new Date(AFTER_PASSAGE).toISOString(), mmsi: MMSI, bridge: 'Stridsbergsbron',
    });
    expect(result.intermediatePassages.some((p) => p.mmsi === MMSI && p.bridge === 'Järnvägsbron'
      && p.t === AFTER_PASSAGE)).toBe(true);
  });

  test.each([
    ['ingen rörelsefix', (row) => (row.aisTimestamp === DEPARTURE ? [] : [row])],
    ['ingen separat bekräftelse', (row) => (row.aisTimestamp === CONFIRMED ? [] : [row])],
    ['enstaka outlier återgår till kajen', (row) => [{
      ...row,
      ...(row.aisTimestamp === CONFIRMED ? { lat: 58.287225, lon: 12.28582 } : {}),
    }]],
    ['samma gamla fix levereras igen', (row) => [{
      ...row,
      ...(row.aisTimestamp === CONFIRMED ? { fixTs: ARRIVAL } : {}),
    }]],
    ['AIS stängs av efter första återkomsten', (row) => (row.aisTimestamp > ARRIVAL ? [] : [row])],
  ])('%s ger ingen påhittad förvarning', (name, transform) => {
    const result = replay(name, changeKnight(transform));
    expect(warnings(result)).toHaveLength(0);
  });
  test('verklig avgång och bekräftad position fungerar även med okänd slutfart', () => {
    const result = replay('unknown-arrival-speed', changeKnight((row) => [{
      ...row, ...([ARRIVAL, CONFIRMED].includes(row.aisTimestamp) ? { sog: null } : {}),
    }]));
    expect(warnings(result)).toHaveLength(1);
    expect(warnings(result)[0]).toMatchObject({ t: CONFIRMED + 5 * 60000, bridge: 'Stridsbergsbron', success: true });
  });
  test('omstart mellan kandidat och bekräftelse återupplivar inte gammalt resebevis', () => {
    const result = replay('restart', [...raw, { ctrl: 'restart', aisTimestamp: ARRIVAL + 5 * 60000 }]);
    expect(warnings(result)).toHaveLength(0);
  });
});
