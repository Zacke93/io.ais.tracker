'use strict';

jest.mock('homey');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { __mockHomey: homey } = require('homey');
const { selectSettings, loadState, KEYS } = require('../lib/utils/replayStartupState');
const App = require('../app');

describe('Fältprovets icke-hemliga starttillstånd', () => {
  test.each([false, true])('riktig appstart skriver startfil utan att ändra en tidigare körnings minne (befintlig=%s)', async (existing) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-start-capture-'));
    const file = path.join(tmp, 'capture.jsonl');
    const stateFile = path.join(tmp, 'capture.state.json');
    const original = { version: 1, capturedAt: 123, settings: { known_vessel_names: {} } };
    if (existing) {
      fs.writeFileSync(file, JSON.stringify({ mmsi: '265000001', aisTimestamp: 124 }));
      fs.writeFileSync(stateFile, JSON.stringify(original));
    }
    const oldPath = process.env.AIS_REPLAY_CAPTURE_FILE;
    const oldMode = global.__TEST_MODE__;
    const oldSettings = homey.settings;
    let app;
    try {
      process.env.AIS_REPLAY_CAPTURE_FILE = file;
      global.__TEST_MODE__ = true;
      const settings = { debug_level: 'off', ais_api_key: null, known_vessel_names: {} };
      homey.settings = {
        get: (k) => settings[k] ?? null,
        set: (k, v) => {
          settings[k] = v;
        },
        on: () => {},
        off: () => {},
      };
      app = new App(); app.homey = homey;
      await app.onInit();
      const recorded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (existing) expect(recorded).toEqual(original);
      else {
        expect(recorded.capturedAt).toBe(app._replayStartupState.capturedAt);
        expect(recorded.settings).toEqual({ known_vessel_names: {} });
      }
    } finally {
      if (app) await app.onUninit();
      if (oldPath === undefined) delete process.env.AIS_REPLAY_CAPTURE_FILE;
      else process.env.AIS_REPLAY_CAPTURE_FILE = oldPath;
      global.__TEST_MODE__ = oldMode;
      homey.settings = oldSettings;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  test('uttrycklig nyckellista utesluter konton och API-nycklar och kopierar värden', () => {
    const settings = {
      ais_api_key: 'secret',
      aishub_username: 'private',
      arbitrary_secret: 'hidden',
      learned_mooring_spots: [{ lat: 58.267, lon: 12.266, t: 1 }],
    };
    const selected = selectSettings((k) => settings[k]);
    expect(Object.keys(selected)).toEqual(['learned_mooring_spots']);
    settings.learned_mooring_spots[0].lat = 0;
    expect(selected.learned_mooring_spots[0].lat).toBe(58.267);
    expect(JSON.stringify(selected)).not.toMatch(/secret|private|hidden/);
    expect(KEYS).not.toContain('ais_api_key');
  });
  test('även inläst testtillstånd filtreras; fel version fallerar tydligt', () => {
    const record = { version: 1, capturedAt: 123, settings: { ais_api_key: 'secret', trigger_point_visits: { version: 2, entries: {} } } };
    expect(loadState(record)).toEqual({ trigger_point_visits: record.settings.trigger_point_visits });
    expect(() => loadState({ ...record, version: 2 })).toThrow('Ogiltigt');
  });
  test('replay startar med inspelad klocka och faktiskt inlästa kajplatser', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-start-state-'));
    const t = Date.parse('2026-09-08T08:00:00Z');
    try {
      const file = path.join(tmp, 'capture.jsonl');
      fs.writeFileSync(file, JSON.stringify({
        mmsi: '265552060',
        shipName: 'CAPELLA',
        lat: 58.26805,
        lon: 12.26705,
        sog: 0,
        cog: 0,
        aisTimestamp: t + 5000,
      }));
      fs.writeFileSync(path.join(tmp, 'capture.state.json'), JSON.stringify({
        version: 1, capturedAt: t, settings: { learned_mooring_spots: [{ lat: 58.26805, lon: 12.26705, t }] },
      }));
      const run = spawnSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), file], {
        encoding: 'utf8', timeout: 15000, env: { ...process.env, REPLAY_VERBOSE: '1' }, maxBuffer: 8 * 1024 * 1024,
      });
      expect(run.status).toBe(0);
      const r = JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(run.stdout)[1]);
      expect(r.initialState).toEqual({ source: 'recorded', capturedAt: t, settingsKeys: ['learned_mooring_spots'] });
      expect(run.stderr).toContain('Restored 1 learned mooring spots');
      expect(r.processErrors).toBe(0);
      expect(r.runtimeDiagnostics.timersAfterShutdown).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
