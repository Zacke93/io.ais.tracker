'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
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
