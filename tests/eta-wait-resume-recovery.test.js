'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, UI_CONSTANTS } = require('../lib/constants');
const corpora = require('./replay-validation/corpora');

describe('ETA återhämtas när en båt lämnar mellanbrons väntan', () => {
  let calculator;
  let waiting;
  const proximity = { nearestBridge: { id: 'olidebron', name: 'Olidebron' } };

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-08-05T07:31:00Z') });
    calculator = new ProgressiveETACalculator({ debug: jest.fn(), error: jest.fn() }, new BridgeRegistry());
    waiting = {
      mmsi: '211347380',
      lat: BRIDGES.olidebron.lat - 60 / 111320,
      lon: BRIDGES.olidebron.lon,
      sog: 0.4,
      _rawPositionSog: 0.4,
      timestamp: Date.now(),
      status: 'waiting',
      waitingAtBridge: 'Olidebron',
      targetBridge: 'Klaffbron',
      _routeDirection: 'north',
    };
  });

  afterEach(() => {
    calculator.destroy();
    jest.useRealTimers();
  });

  function resume(overrides = {}, baselineOverrides = {}) {
    calculator._processETAWithProtection({ ...waiting, ...baselineOverrides }, 90, proximity);
    jest.advanceTimersByTime(60000);
    return calculator._processETAWithProtection({
      ...waiting,
      lat: BRIDGES.olidebron.lat + 15 / 111320,
      sog: 3.7,
      _rawPositionSog: 3.7,
      timestamp: Date.now(),
      status: 'under-bridge',
      waitingAtBridge: null,
      _underBridgeLatched: true,
      ...overrides,
    }, 10, proximity);
  }

  test('ren positionsbelagd avgång ersätter väntbaslinjen även i mellanbrons närzon', () => {
    expect(resume()).toBe(10);
  });

  test.each([
    ['GPS-hopp', { _gpsJumpDetected: true }],
    ['osäker position', { _positionUncertain: true }],
    ['aktiv GPS-koordinering', { lastCoordinationLevel: 'enhanced' }],
    ['saknad råfart trots ärvd SOG', { _rawPositionSog: null }],
    ['fortsatt krypfart', { sog: 0.8, _rawPositionSog: 0.8 }],
    ['enbart fartspik utan förflyttning', { lat: BRIDGES.olidebron.lat - 60 / 111320 }],
    ['orimligt positionshopp', { lat: BRIDGES.klaffbron.lat - 0.0001 }],
    ['gammal position', { timestamp: Date.parse('2026-08-05T07:32:00Z') - UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS - 1 }],
  ])('%s får inte radera skyddets baslinje', (_name, overrides) => {
    expect(resume(overrides)).toBeGreaterThan(10);
  });

  test('bekräftad passage släpper krypväntan även när ankarets råfart var över en knop', () => {
    expect(resume({
      lastPassedBridge: 'Olidebron',
      lastPassedBridgeTime: Date.now() + 60000,
    }, { sog: 1.7, _rawPositionSog: 1.7 })).toBe(10);
  });

  test('entydigt linjekorsningsbevis släpper krypväntan före zonutgången', () => {
    expect(resume({
      _underBridgeCrossedBridge: 'Olidebron',
      _underBridgeEntryLat: waiting.lat,
      _underBridgeEntryLon: waiting.lon,
    }, { sog: 1.7, _rawPositionSog: 1.7 })).toBe(10);
  });

  test.each([
    ['saknat ankare', { _underBridgeEntryLat: null, _underBridgeEntryLon: null }],
    ['annan bro', { _underBridgeCrossedBridge: 'Järnvägsbron' }],
    ['avslutat zonbesök', { _underBridgeLatched: false }],
    ['återvänd till ingångssidan', { _underBridgeEntryLat: BRIDGES.olidebron.lat + 60 / 111320 }],
    ['epsilonbandet', { lat: BRIDGES.olidebron.lat + 5 / 111320 }],
    ['GPS-osäker fix', { _positionUncertain: true }],
  ])('%s får inte låna ett gammalt linjekorsningsbevis', (_name, overrides) => {
    expect(resume({
      _underBridgeCrossedBridge: 'Olidebron',
      _underBridgeEntryLat: waiting.lat,
      _underBridgeEntryLon: waiting.lon,
      ...overrides,
    }, { sog: 1.7, _rawPositionSog: 1.7 })).toBeGreaterThan(10);
  });

  test.each([1, 3, 50])('passage registrerad %i ms efter positionsmottagningen räknas i livekedjan', (processingMs) => {
    calculator._processETAWithProtection({ ...waiting, sog: 1.7, _rawPositionSog: 1.7 }, 90, proximity);
    jest.advanceTimersByTime(60000);
    const positionAt = Date.now();
    jest.advanceTimersByTime(processingMs);
    const result = calculator._processETAWithProtection({
      ...waiting,
      lat: BRIDGES.olidebron.lat + 15 / 111320,
      sog: 3.7,
      _rawPositionSog: 3.7,
      timestamp: positionAt,
      status: 'under-bridge',
      waitingAtBridge: null,
      _underBridgeLatched: true,
      lastPassedBridge: 'Olidebron',
      lastPassedBridgeTime: Date.now(),
    }, 10, proximity);
    expect(result).toBe(10);
  });

  test.each([
    ['utan passage', {}],
    ['passage av annan bro', { lastPassedBridge: 'Järnvägsbron', passageOffset: 60000 }],
    ['passage på förra fixet', { lastPassedBridge: 'Olidebron', passageOffset: 0 }],
    ['passage i framtiden', { lastPassedBridge: 'Olidebron', passageOffset: 60001 }],
    ['otillförlitlig passagefix', { lastPassedBridge: 'Olidebron', passageOffset: 60000, _gpsJumpDetected: true }],
    ['saknad råfart på passagefixet', { lastPassedBridge: 'Olidebron', passageOffset: 60000, _rawPositionSog: null }],
  ])('%s släpper inte krypväntans baslinje', (_name, { passageOffset, ...overrides }) => {
    expect(resume({
      ...overrides,
      lastPassedBridgeTime: Number.isFinite(passageOffset) ? Date.now() + passageOffset : undefined,
    }, { sog: 1.7, _rawPositionSog: 1.7 })).toBeGreaterThan(10);
  });

  test('bekräftad passage behåller vanlig utjämning när prognosen inte är en outlier', () => {
    calculator._processETAWithProtection({ ...waiting, sog: 1.7, _rawPositionSog: 1.7 }, 10, proximity);
    jest.advanceTimersByTime(60000);
    const result = calculator._processETAWithProtection({
      ...waiting,
      lat: BRIDGES.olidebron.lat + 15 / 111320,
      sog: 3.7,
      _rawPositionSog: 3.7,
      timestamp: Date.now(),
      status: 'under-bridge',
      waitingAtBridge: null,
      _underBridgeLatched: true,
      lastPassedBridge: 'Olidebron',
      lastPassedBridgeTime: Date.now(),
    }, 9, proximity);
    expect(result).toBeGreaterThan(9);
    expect(result).toBeLessThan(10);
  });

  test('ett GPS-fel vid väntans ankare får inte bli rörelsebevis', () => {
    expect(resume({}, { _gpsJumpDetected: true })).toBeGreaterThan(10);
  });

  test('vanlig rörelse utan föregående långsam mellanbroväntan behåller dämpningen', () => {
    expect(resume({}, { status: 'en-route', waitingAtBridge: null })).toBeGreaterThan(10);
  });
});

test.each([
  ['ANTJE', '20260804-both-21h', '211347380', '2026-08-05T07:36:41Z'],
  ['MISTRAL', '20260806-42h', '219025192', '2026-08-07T12:16:06Z'],
])('%s får en aktuell Klaffprognos efter återupptagen rörelse', (_name, id, mmsi, at) => {
  const corpus = corpora.find((entry) => entry.id === id);
  const output = execFileSync(process.execPath, [
    path.join(__dirname, 'replay-validation/replayRunner.js'), corpus.jsonl, mmsi,
  ], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, REPLAY_MONITORING: '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
    },
  });
  const result = JSON.parse(output.match(/__REPLAY_JSON__([\s\S]*?)__END__/)[1]);
  const now = Date.parse(at);
  const { text } = result.bridgeTextTransitions.filter((entry) => entry.t <= now).at(-1);
  const eta = Number(text.match(/Klaffbron, beräknad broöppning om (?:cirka )?(\d+) minuter/)[1]);
  // Rådatans sista fix efter brolinjen är en säker övre gräns för kvarvarande
  // restid. Inget interpolerat punktfacit eller gissat farttak behövs här.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const passages = require(`./replay-validation/gt-passages/${id}.json`);
  const crossing = passages.find((entry) => entry.mmsi === mmsi
    && entry.bridge === 'Klaffbron' && entry.tFrom > now);
  expect(crossing).toBeDefined();
  expect(eta).toBeGreaterThan(0);
  expect(eta).toBeLessThanOrEqual(Math.ceil((crossing.tTo - now) / 60000));
  expect(result.processErrors).toBe(0);
}, 40000);

// Bytebevarade fartygsrader ur 21/9-körningen. Korpusen i sin helhet har två
// bortfall andra dagar och är därför inte låst som ett komplett fältfacit.
test.each([
  ['SWIX', 'eta-swix-20260926.jsonl', 0],
  ['AMELIA', 'eta-amelia-20260927.jsonl', 1],
])('%s får en aktuell Stridsprognos efter Järnvägsbrons linjekorsning', (_name, fixture, forecastMargin) => {
  const jsonl = path.join(__dirname, 'fixtures', fixture);
  const output = execFileSync(process.execPath, [
    path.join(__dirname, 'replay-validation/replayRunner.js'), jsonl,
  ], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, REPLAY_MONITORING: '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
    },
  });
  const result = JSON.parse(output.match(/__REPLAY_JSON__([\s\S]*?)__END__/)[1]);
  const warning = result.openingWarnings.find((entry) => entry.bridge === 'Stridsbergsbron');
  const notification = result.notifications.find((entry) => entry.bridge === 'Stridsbergsbron');
  expect(warning).toBeDefined();
  expect(notification).toBeDefined();
  const rows = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const afterCrossing = rows.find((entry) => entry.lat > BRIDGES.stridsbergsbron.lat
    && Date.parse(entry.receivedAt) > warning.t);
  // Den första råfixen bortom målbrolinjen är en säker övre tidsgräns.
  // Det kräver ingen linjär interpolering genom det två minuter långa glappet.
  // AMELIA accelererar efter prognosen; en minuts prognosmarginal tillåts.
  // Regressionen gäller den gamla 11-minutersbaslinjen, inte en ny fartmodell.
  const upperMinutes = Math.ceil((Date.parse(afterCrossing.receivedAt) - warning.t) / 60000) + forecastMargin;
  expect(warning.etaMin).toBeGreaterThan(0);
  expect(warning.etaMin).toBeLessThanOrEqual(upperMinutes);
  expect(notification.eta).toBeLessThanOrEqual(upperMinutes);
  expect(result.processErrors).toBe(0);
}, 40000);
