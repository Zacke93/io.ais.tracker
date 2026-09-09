'use strict';

jest.mock('homey');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const App = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');
const { queueBridge } = require('../lib/utils/bridgeQueue');

const FIRST = Date.parse('2026-08-05T00:04:32.473Z');
const SECOND = Date.parse('2026-08-05T00:19:14.283Z');
const MMSI = '211452170';
const replayDir = path.join(__dirname, 'replay-validation');
const raw = fs.readFileSync(path.join(replayDir, 'corpora-data/ais-20260804-both-21h.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line))
  .filter((row) => String(row.mmsi) === MMSI && row.aisTimestamp <= SECOND);

// Första fixen togs bort innan den andra kom. Produktionsbokföringens rena
// position ska därför prövas även när VDS inte längre har någon oldVessel.
describe('Ny långsam målbro kräver avgång från ett belagt kvarvarande kajläge', () => {
  let app;
  let service;
  let now;
  const sample = (row, extra = {}) => ({
    ...row,
    mmsi: MMSI,
    timestamp: row.aisTimestamp,
    lastPositionUpdate: row.aisTimestamp,
    fixFeed: row.feed,
    _moored: false,
    _gpsJumpDetected: false,
    _positionUncertain: false,
    _routeDirection: null,
    targetBridge: null,
    passedBridges: [],
    _hasMovementProof: true,
    ...extra,
  });

  beforeEach(() => {
    now = FIRST;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    app = Object.create(App.prototype);
    app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app._openingQuayLedger = new Map();
    app._quayStableLedger = new Map();
    service = Object.create(VesselDataService.prototype);
    service.app = app;
    service.logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    service.bridgeRegistry = new BridgeRegistry();
    service._completedJourneys = new Map();
  });
  afterEach(() => jest.restoreAllMocks());

  function prior(first = sample(raw[0])) {
    now = first.timestamp;
    app._noteQuayStability(first);
    now = SECOND;
  }
  function allowed(current = sample(raw[1]), first = sample(raw[0])) {
    prior(first);
    now = current.timestamp;
    return service._shouldAssignTargetBridge(current);
  }

  test('CARATs två verkliga fix skapar varken en Stridsresa eller ett rörelsebevis av 32 m', () => {
    expect(raw).toHaveLength(2);
    expect(allowed()).toBe(false);
    expect(app._openingQuayLedger.get(MMSI).stillAt).toBe(0);
    expect(service.logger.debug.mock.calls.some(([msg]) => msg.includes('TARGET_QUAY_POSITION_PROOF'))).toBe(true);
  });

  test('nästa rena 70 m avgång släpper målbron direkt trots oförändrad låg fart', () => {
    const moving = sample(raw[1], { lat: raw[0].lat + 70 / 111320 });
    expect(allowed(moving)).toBe(true);
    expect(service._calculateTargetBridge(moving)).toBe('Stridsbergsbron');
  });

  test('en tredje oförflyttad fix efter en minut kan inte starta en spökresa', () => {
    expect(allowed()).toBe(false);
    app._noteQuayStability(sample(raw[1]));
    now = SECOND + 60000;
    const same = sample(raw[1], { timestamp: now, lastPositionUpdate: now, fixTs: now - 50000 });
    expect(service._shouldAssignTargetBridge(same)).toBe(false);
    app._noteQuayStability(same);
    expect(app._openingQuayLedger.get(MMSI).positionStayAnchor.ts).toBe(FIRST);
  });

  test('täta rena jitterprov behåller ankaret även efter två timmar', () => {
    expect(allowed()).toBe(false);
    app._noteQuayStability(sample(raw[1]));
    for (let minutes = 1; minutes <= 121; minutes += 1) {
      now = SECOND + minutes * 60000;
      const same = sample(raw[1], { timestamp: now, lastPositionUpdate: now, fixTs: now - 50000 });
      expect(service._shouldAssignTargetBridge(same)).toBe(false);
      app._noteQuayStability(same);
    }
    expect(app._openingQuayLedger.get(MMSI).positionStayAnchor.ts).toBe(FIRST);
  });

  test.each([30, 31])('ett %i minuter långt AIS-avbrott startar nytt liveankare men behåller färskt platsmotbevis', (minutes) => {
    expect(allowed()).toBe(false);
    app._noteQuayStability(sample(raw[1]));
    now = SECOND + minutes * 60000;
    const returned = sample(raw[1], { timestamp: now, lastPositionUpdate: now, fixTs: now - 50000 });
    expect(service._slowInitialQuayApproachNeedsProof(returned)).toBe(true);
    app._noteQuayStability(returned);
    expect(app._openingQuayLedger.get(MMSI).positionStayAnchor.ts).toBe(now);
  });

  test('en mätbar avgång och återkomst är ett nytt positionsunderlag', () => {
    expect(allowed()).toBe(false);
    app._noteQuayStability(sample(raw[1]));
    now = SECOND + 60000;
    const moved = sample(raw[1], {
      timestamp: now,
      lastPositionUpdate: now,
      fixTs: now,
      lat: raw[0].lat + 70 / 111320,
    });
    expect(service._slowInitialQuayApproachNeedsProof(moved)).toBe(false);
    app._noteQuayStability(moved);
    expect(app._openingQuayLedger.get(MMSI).positionStayAnchor.ts).toBe(now);
    now += 60000;
    const back = sample(raw[0], {
      timestamp: now, lastPositionUpdate: now, fixTs: now, cog: 0,
    });
    expect(service._slowInitialQuayApproachNeedsProof(back)).toBe(false);
    app._noteQuayStability(back);
    expect(app._openingQuayLedger.get(MMSI).positionStayAnchor.ts).toBe(now);
  });

  test('första kontakt och stark gles transit kräver inte ett extra AIS-prov', () => {
    now = SECOND;
    expect(service._shouldAssignTargetBridge(sample(raw[1]))).toBe(true);
    expect(allowed(sample(raw[1], { sog: 3.8 }))).toBe(true);
  });

  test('en redan tilldelad resa behålls även efter två timmars stilla väntan', () => {
    const waiting = sample(raw[1], {
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      sog: 0,
      _stationarySince: SECOND - 2 * 60 * 60000,
    });
    prior();
    expect(service._slowInitialQuayApproachNeedsProof(waiting)).toBe(false);
    expect(waiting.targetBridge).toBe('Stridsbergsbron');
  });

  test('en belagd färsk Olidekö kan få Klaffbron trots över 1,5 km till målbron', () => {
    const position = {
      lat: BRIDGES.olidebron.lat - 200 / 111320,
      lon: BRIDGES.olidebron.lon,
    };
    const arriving = sample(raw[1], {
      ...position,
      cog: 0,
      _routeDirection: 'north',
      _bridgeQueueApproaches: { Olidebron: { direction: 'north', confirmedAt: FIRST } },
    });
    prior(sample(raw[0], position));
    expect(queueBridge({ ...arriving, targetBridge: 'Klaffbron' })?.name).toBe('Olidebron');
    expect(service._slowInitialQuayApproachNeedsProof(arriving)).toBe(false);
    expect(service._slowInitialQuayApproachNeedsProof({ ...arriving, _bridgeQueueApproaches: {} })).toBe(true);
  });

  test('en kvarliggande post utanför kajbandet spärrar inte långsam öppen farled', () => {
    const position = { lat: 58.277, lon: 12.278 };
    now = FIRST;
    app._noteQuayLedgerEntry(app._openingQuayLedger, MMSI, sample(raw[0], position));
    now = SECOND;
    expect(service._slowInitialQuayApproachNeedsProof(sample(raw[1], position))).toBe(false);
  });

  test('två stilla positioner nära målbron får inte skapa en ny resa utan avgångsbevis', () => {
    const position = { lat: BRIDGES.stridsbergsbron.lat - 250 / 111320, lon: BRIDGES.stridsbergsbron.lon };
    expect(allowed(sample(raw[1], position), sample(raw[0], position))).toBe(false);
  });

  test('ett kort mötesstopp i farleden är ingen femminutersvistelse', () => {
    const first = sample(raw[0], { timestamp: SECOND - 2 * 60000, fixTs: SECOND - 2 * 60000 });
    expect(allowed(sample(raw[1]), first)).toBe(true);
  });

  test('ett gammalt kajläge efter ett långt AIS-avbrott blockerar inte en ny resa', () => {
    const first = sample(raw[0], { timestamp: SECOND - 70 * 60000, fixTs: SECOND - 70 * 60000 });
    expect(allowed(sample(raw[1]), first)).toBe(true);
  });

  test('okänd slutfart är ingen ny stillhetsobservation', () => {
    prior();
    expect(service._slowInitialQuayApproachNeedsProof(sample(raw[1], { sog: null }))).toBe(false);
  });

  test('en GPS-flaggad utflykt får inte ge falskt netto när båten återkommer till kajen', () => {
    prior();
    now = FIRST + 3 * 60000;
    app._noteQuayStability(sample(raw[0], {
      timestamp: now, fixTs: now, lat: raw[0].lat + 200 / 111320, _gpsJumpDetected: true,
    }));
    now = SECOND;
    expect(service._shouldAssignTargetBridge(sample(raw[1]))).toBe(false);
    expect(app._openingQuayLedger.get(MMSI).lastFix.ts).toBe(FIRST);
  });

  test('aktuell GPS-osäkerhet får inte öppna målgrinden via ett större netto', () => {
    expect(allowed(sample(raw[1], {
      lat: raw[0].lat + 200 / 111320, _positionUncertain: true,
    }))).toBe(false);
  });

  test('en äldre fixklocka kan inte maskeras av en färsk mottagning', () => {
    prior();
    const cur = sample(raw[1], { fixTs: SECOND - 20 * 60000 });
    expect(service._slowInitialQuayApproachNeedsProof(cur)).toBe(false);
    expect(BRIDGE_OPENING.DISARM_MOORED_MIN_DISTANCE_M).toBe(600);
  });
});

describe('CARAT genom verklig app: falsk öppning och falsk brotext försvinner tillsammans', () => {
  let directory;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-carat-initial-'));
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  function replay(name, rows, monitoring = false) {
    const file = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const out = execFileSync(process.execPath, [path.join(replayDir, 'replayRunner.js'), file], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, REPLAY_MONITORING: monitoring ? '1' : '0' },
    });
    const result = JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
    return result;
  }

  test('exakta tvåfixfallet ger ingen falsk öppning eller nedräkning under hela efterspelen', () => {
    const result = replay('quay', raw);
    expect(result.openingWarnings).toHaveLength(0);
    expect(result.bridgeTextTransitions.some(({ text }) => text.includes('på väg mot Stridsbergsbron'))).toBe(false);
  });

  test('med riktig 70 m avgång från samma kaj får båten måltext och varning direkt', () => {
    const result = replay('departure', [raw[0], { ...raw[1], lat: raw[0].lat + 70 / 111320 }]);
    expect(result.openingWarnings).toHaveLength(1);
    expect(result.openingWarnings[0]).toMatchObject({
      bridge: 'Stridsbergsbron', leadMmsi: MMSI, t: SECOND, success: true,
    });
    expect(result.bridgeTextTransitions.some(({ text }) => text.includes('på väg mot Stridsbergsbron'))).toBe(true);
  });

  test.each(['north', 'south'])('tre små riktiga 35 m-steg %s räknas ihop före notis och måltext', (direction) => {
    const sign = direction === 'north' ? 1 : -1;
    const rows = raw.map((row) => ({
      ...row,
      ...(direction === 'south' ? {
        lat: BRIDGES.klaffbron.lat + BRIDGES.stridsbergsbron.lat - row.lat,
        lon: BRIDGES.klaffbron.lon + BRIDGES.stridsbergsbron.lon - row.lon,
        cog: (row.cog + 180) % 360,
      } : {}),
    }));
    for (let step = 1; step <= 3; step += 1) {
      const t = SECOND + step * 5 * 60000;
      rows.push({
        ...rows[1],
        aisTimestamp: t,
        fixTs: t - 50000,
        lat: rows[1].lat + sign * step * 35 / 111320,
        sog: 0.6,
        cog: direction === 'north' ? 0 : 180,
      });
    }
    const result = replay(`creeping-${direction}`, rows);
    const target = direction === 'north' ? 'Stridsbergsbron' : 'Klaffbron';
    expect(result.openingWarnings).toHaveLength(1);
    expect(result.openingWarnings[0]).toMatchObject({
      bridge: target, leadMmsi: MMSI, t: SECOND + 5 * 60000, success: true,
    });
    expect(result.bridgeTextTransitions.some(({ t, text }) => t < SECOND + 5 * 60000
      && text.includes(`på väg mot ${target}`))).toBe(false);
    expect(result.bridgeTextTransitions.some(({ t, text }) => t >= SECOND + 5 * 60000
      && text.includes(`på väg mot ${target}`))).toBe(true);
  });

  test('tredje oförflyttade råfixen ger ingen fördröjd spökvarning eller spöktext', () => {
    const t = SECOND + 60000;
    const result = replay('dense-jitter', [...raw, {
      ...raw[1], aisTimestamp: t, fixTs: t - 50000,
    }]);
    expect(result.openingWarnings).toHaveLength(0);
    expect(result.bridgeTextTransitions.some(({ text }) => text.includes('på väg mot Stridsbergsbron'))).toBe(false);
  });

  test('tre timmars gles kajjitter överlever riktig monitoring utan ny spökresa', () => {
    const rows = [...raw];
    for (let minutes = 25; minutes <= 175; minutes += 25) {
      const t = SECOND + minutes * 60000;
      rows.push({ ...raw[1], aisTimestamp: t, fixTs: t - 50000 });
    }
    const result = replay('sparse-jitter-monitoring', rows, true);
    expect(result.openingWarnings).toHaveLength(0);
    expect(result.bridgeTextTransitions.some(({ text }) => text.includes('på väg mot Stridsbergsbron'))).toBe(false);
  });

  test('AIS som stängs av efter första tvetydiga fixen får ingen påhittad resa', () => {
    const result = replay('silent', [raw[0]]);
    expect(result.openingWarnings).toHaveLength(0);
    expect(result.bridgeTextTransitions.some(({ text }) => text.includes('på väg mot Stridsbergsbron'))).toBe(false);
  });
});
