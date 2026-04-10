'use strict';

const fs = require('fs');
const path = require('path');
const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

const DEFAULT_BRIDGE_TEXT = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';

const parseReplayFile = (replayFile) => {
  const lines = fs.readFileSync(replayFile, 'utf8').split('\n').filter(Boolean);
  return lines.map((line) => {
    const match = line.match(/\[AIS_REPLAY_SAMPLE\]\s+({.*})/);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch (err) {
      return null;
    }
  }).filter(Boolean);
};

const getMmsiRange = (samples, mmsi) => {
  const timestamps = samples
    .filter((s) => String(s.mmsi) === String(mmsi))
    .map((s) => s.aisTimestamp)
    .filter((t) => Number.isFinite(t));

  if (timestamps.length === 0) return null;
  return {
    start: Math.min(...timestamps),
    end: Math.max(...timestamps),
  };
};

const assertNoDefaultBlinkBetweenNonDefault = (texts, contextLabel = '') => {
  const firstNonDefaultIdx = texts.findIndex((t) => t !== DEFAULT_BRIDGE_TEXT);
  expect(firstNonDefaultIdx).toBeGreaterThanOrEqual(0);

  const lastNonDefaultIdx = texts.length - 1 - [...texts].reverse().findIndex((t) => t !== DEFAULT_BRIDGE_TEXT);
  expect(lastNonDefaultIdx).toBeGreaterThanOrEqual(firstNonDefaultIdx);

  const windowTexts = texts.slice(firstNonDefaultIdx, lastNonDefaultIdx + 1);
  expect(windowTexts).not.toContain(DEFAULT_BRIDGE_TEXT);
  expect(windowTexts.length).toBeGreaterThan(0);
  expect(contextLabel).toBeTruthy();
};

describe('Bridge text full dataset replay (ais-replay-20251209-203609.jsonl)', () => {
  const replayFile = path.join(__dirname, '..', '..', 'logs', 'ais-replay-20251209-203609.jsonl');
  let runner;
  let samples;
  let logSpy;

  beforeAll(async () => {
    if (!fs.existsSync(replayFile)) {
      console.warn(`⚠️ Replay file missing: ${replayFile} — skipping full dataset replay test`);
      return;
    }

    samples = parseReplayFile(replayFile)
      .filter((s) => s && Number.isFinite(s.aisTimestamp))
      .sort((a, b) => a.aisTimestamp - b.aisTimestamp);

    if (samples.length === 0) {
      console.warn(`⚠️ No replay samples parsed from: ${replayFile} — skipping full dataset replay test`);
      return;
    }

    // Silence very verbose flow-trigger console output during full replay.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    jest.useFakeTimers();
    jest.setSystemTime(new Date(samples[0].aisTimestamp));

    runner = new RealAppTestRunner();
    await runner.initializeApp();

    // Deterministic: disable asynchronous UI scheduling/coalescing, we publish UI snapshots manually.
    runner.app._scheduleCoalescedUpdate = () => {};
  });

  afterAll(async () => {
    await runner?.cleanup();
    if (logSpy) logSpy.mockRestore();
    jest.useRealTimers();
  });

  test('does not blink to default mid-journey when replaying ALL vessels chronologically', () => {
    if (!samples) {
      console.warn('⚠️ Replay file missing/unparsed — skipping assertions');
      return;
    }

    const publishNow = () => {
      const snapshot = runner.app._createUISnapshot();
      const result = runner.app._processUIUpdate(snapshot);
      return result.bridgeText;
    };

    const history = [];

    const record = (phase) => {
      history.push({ timestamp: Date.now(), phase, text: publishNow() });
    };

    const normalizeToAISMessage = (sample) => ({
      mmsi: sample.mmsi,
      msgType: sample.msgType || 1,
      lat: sample.lat,
      lon: sample.lon,
      sog: sample.sog,
      cog: sample.cog,
      shipName: sample.shipName || 'ReplayVessel',
      timestamp: sample.aisTimestamp,
    });

    // Initial state
    record('initial');

    // Process first sample
    runner.app._processAISMessage(normalizeToAISMessage(samples[0]));
    record('after-sample');

    for (let i = 1; i < samples.length; i += 1) {
      const nextTimestamp = samples[i].aisTimestamp;
      const delta = nextTimestamp - Date.now();
      expect(delta).toBeGreaterThanOrEqual(0);

      // Advance time to just before processing next AIS sample.
      // This allows cleanup timers to fire and potentially change bridge text (e.g. the historical "hopping" bug).
      jest.advanceTimersByTime(delta);
      jest.setSystemTime(new Date(nextTimestamp));
      record('before-sample');

      runner.app._processAISMessage(normalizeToAISMessage(samples[i]));
      record('after-sample');
    }

    // Let any remaining cleanup timers settle after the last AIS sample.
    jest.advanceTimersByTime(20 * 60 * 1000);
    record('after-final-cleanup');

    const mmsisToGuard = [
      '220018000', // ORANESS (southbound) – known historical default-text hop
      '245057000', // KINNE (northbound)
    ];

    mmsisToGuard.forEach((mmsi) => {
      const range = getMmsiRange(samples, mmsi);
      expect(range).toBeTruthy();

      const textsInRange = history
        .filter((h) => h.timestamp >= range.start && h.timestamp <= range.end)
        .map((h) => h.text);

      // The goal is to prevent brief "Inga båtar..." fallbacks between meaningful journey updates.
      assertNoDefaultBlinkBetweenNonDefault(textsInRange, `mmsi=${mmsi}`);
    });
  });
});
