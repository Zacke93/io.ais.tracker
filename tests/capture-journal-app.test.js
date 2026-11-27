'use strict';

jest.mock('homey');

/**
 * U71 (omgång 9): appens koppling till fångstjournalen.
 * - Bara på debug_level 'full'; på övriga nivåer finns ingen journal och
 *   raderna loggas exakt som förut (samma anrop, samma argument).
 * - Byte av nivå under gång (av → full → av) startar och avslutar strömmar och
 *   tömmer bufferten.
 * - Ett fel i loggvägen kastar aldrig in i appen (U58).
 */

const AISBridgeApp = require('../app');

function makeApp(level) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  const store = { debug_level: level };
  app.homey = { settings: { get: (k) => store[k], on: jest.fn() } };
  app.debugLevel = level;
  app.aisClient = { reconnectWithKey: jest.fn(), disconnect: jest.fn() };
  app._setupSettingsListener();
  return { app, store };
}

function setLevel(app, store, level) {
  store.debug_level = level;
  app._onSettingsChanged('debug_level', level);
}

const lines = (fn) => fn.mock.calls.map((c) => c.join(' '));

describe('U71: utan full nivå loggas allt exakt som förut', () => {
  for (const level of ['off', 'basic', 'detailed']) {
    test(`${level}: ingen journal, samma anrop och argument`, () => {
      const { app } = makeApp(level);
      app._syncCaptureJournal('boot');
      expect(app._captureJournal == null).toBe(true);
      app._logReplaySample('{"mmsi":"1"}');
      app._logCaptured('📱 [UI_UPDATE] Bridge text updated: "x"');
      app._logCaptured('❌ [FLOW_TRIGGER_ERROR] y', 'error');
      app.debug = jest.fn();
      app._logCaptured('🔍 [FLOW_TRIGGER_SAFE_TOKENS] z', 'debug');
      app._tickCaptureJournal();
      expect(app.log.mock.calls).toEqual([
        ['[AIS_REPLAY_SAMPLE]', '{"mmsi":"1"}'],
        ['📱 [UI_UPDATE] Bridge text updated: "x"'],
      ]);
      expect(app.error.mock.calls).toEqual([['❌ [FLOW_TRIGGER_ERROR] y']]);
      expect(app.debug.mock.calls).toEqual([['🔍 [FLOW_TRIGGER_SAFE_TOKENS] z']]);
    });
  }

  test('_captureAISReplaySample på basic loggar ingenting (som förut)', () => {
    const { app } = makeApp('basic');
    app._replayCaptureFile = null;
    app._captureAISReplaySample({ mmsi: '1', lat: 1 });
    expect(app.log).not.toHaveBeenCalled();
  });
});

describe('U71: på full nivå numreras raderna', () => {
  test('start, sampel, händelser och felrad bär strömmens nummer', () => {
    const { app } = makeApp('full');
    app._syncCaptureJournal('boot');
    const { sid } = app._captureJournal;
    app._replayCaptureFile = null;
    app._captureAISReplaySample({ mmsi: '1', lat: 1 });
    app._logCaptured('📱 [UI_UPDATE] Bridge text updated: "x"');
    app._logCaptured('🔍 [FLOW_TRIGGER_SAFE_TOKENS] z', 'debug');
    app._logCaptured('❌ [FLOW_TRIGGER_ERROR] y', 'error');
    expect(lines(app.log)).toEqual([
      `#${sid}:1 [CAPTURE_START] sid=${sid} reason=boot`,
      `#${sid}:2 [AIS_REPLAY_SAMPLE] {"mmsi":"1","lat":1}`,
      `#${sid}:3 📱 [UI_UPDATE] Bridge text updated: "x"`,
      `#${sid}:4 [DEBUG] 🔍 [FLOW_TRIGGER_SAFE_TOKENS] z`,
    ]);
    expect(lines(app.error)).toEqual([`#${sid}:5 ❌ [FLOW_TRIGGER_ERROR] y`]);
  });

  test('av → full → av → full: nya strömmar, bufferten töms, slutet skrivs', () => {
    const { app, store } = makeApp('off');
    app._syncCaptureJournal('boot');
    expect(app._captureJournal == null).toBe(true);
    setLevel(app, store, 'full');
    const first = app._captureJournal;
    expect(first).toBeTruthy();
    app._logCaptured('A');
    expect(first.buffered).toBe(2);
    setLevel(app, store, 'off');
    expect(app._captureJournal).toBeNull();
    expect(first.buffered).toBe(0);
    setLevel(app, store, 'full');
    const second = app._captureJournal;
    expect(second.sid).not.toBe(first.sid);
    expect(second.sid.endsWith('-2')).toBe(true);
    const all = lines(app.log);
    expect(all).toContain(`#${first.sid}:1 [CAPTURE_START] sid=${first.sid} reason=level`);
    expect(all).toContain(`[CAPTURE_END] sid=${first.sid} seq=2 dropped=0 errors=0 reason=level`);
    expect(all).toContain(`#${second.sid}:1 [CAPTURE_START] sid=${second.sid} reason=level`);
    // full → full: samma ström.
    setLevel(app, store, 'full');
    expect(app._captureJournal).toBe(second);
  });

  test('onUninit avslutar strömmen', async () => {
    const { app } = makeApp('full');
    app._syncCaptureJournal('boot');
    const { sid } = app._captureJournal;
    await app.onUninit().catch(() => {});
    expect(app._captureJournal).toBeNull();
    expect(lines(app.log)).toContain(`[CAPTURE_END] sid=${sid} seq=1 dropped=0 errors=0 reason=uninit`);
  });
});

describe('U71: ett fel i loggvägen påverkar inte appen (U58)', () => {
  test('kastande this.log för journalrader: inget kast ut ur appens anrop', () => {
    const { app } = makeApp('full');
    app._syncCaptureJournal('boot');
    app.log = jest.fn(() => {
      throw new Error('EPIPE');
    });
    app.error = jest.fn(() => {
      throw new Error('EPIPE');
    });
    app._replayCaptureFile = null;
    expect(() => {
      app._captureAISReplaySample({ mmsi: '1' });
      app._logCaptured('📱 [UI_UPDATE] Bridge text updated: "x"');
      app._logCaptured('❌ [FLOW_TRIGGER_ERROR] y', 'error');
      app._tickCaptureJournal();
    }).not.toThrow();
    // Ett försök per rad, inget försök att logga felet (ingen slinga).
    expect(app.log.mock.calls.length).toBe(3);
    expect(app.error.mock.calls.length).toBe(1);
    expect(app._captureJournal.errors).toBe(4);
  });

  test('en journal som går sönder vid skapandet lämnar appen på vanlig loggning', () => {
    const { app } = makeApp('full');
    app.log = jest.fn((line) => {
      if (String(line).includes('[CAPTURE_START]')) throw new Error('nej');
    });
    // Även om starten inte kunde skrivas finns journalen; raden läks ur omsändningen.
    app._syncCaptureJournal('boot');
    expect(app._captureJournal).toBeTruthy();
    // En ersatt journal som kastar: anropen faller tillbaka på vanlig loggning.
    app._captureJournal = {
      record() {
        throw new Error('trasig');
      },
      tick() {
        throw new Error('trasig');
      },
    };
    app.log = jest.fn();
    expect(() => {
      app._logReplaySample('{"mmsi":"2"}');
      app._logCaptured('X');
      app._tickCaptureJournal();
    }).not.toThrow();
    expect(app.log.mock.calls).toEqual([['[AIS_REPLAY_SAMPLE]', '{"mmsi":"2"}'], ['X']]);
  });
});
