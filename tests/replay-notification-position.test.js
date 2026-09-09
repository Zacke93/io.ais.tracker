'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { BRIDGES } = require('../lib/constants');

const RUNNER = path.join(__dirname, 'replay-validation/replayRunner.js');
const FIELD = path.join(__dirname, 'replay-validation/corpora-data/ais-20260804-17h-dag.jsonl');
const START = Date.parse('2026-09-08T08:00:07.123Z');
const MMSI = '902009072';

describe('Replaypositionen hör till kortanropet och den faktiskt mottagna AIS-raden', () => {
  let tmp;
  let rows;
  let synthetic;
  let field;
  const run = (file, env = {}) => {
    const stdout = execFileSync(process.execPath, [RUNNER, file], {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 12 * 1024 * 1024,
      env: {
        ...process.env,
        REPLAY_MONITORING: '0',
        REPLAY_FUSION: '0',
        REPLAY_VERBOSE: '',
        REPLAY_DEBUG_LEVEL: 'off',
        REPLAY_INITIAL_STATE: '',
        ...env,
      },
    });
    return JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]);
  };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-notification-position-'));
    rows = [0, 1].map((step) => ({
      mmsi: MMSI,
      shipName: 'POSITIONSVAKT',
      aisTimestamp: START + step * 1000,
      lat: BRIDGES.klaffbron.lat - 0.004 + step * 0.00003,
      lon: BRIDGES.klaffbron.lon,
      sog: 6.1,
      cog: 0,
    }));
    const input = path.join(tmp, 'same-timestamp.jsonl');
    fs.writeFileSync(input, rows.map(JSON.stringify).join('\n'));
    // Bara instrumenteringen prövas: två uttryckliga SDK-anrop med SAMMA
    // fake-tid, ett från föregående timersvep och ett efter nästa AIS-fix.
    // Rådata och klockstegningen är oförändrade i den riktiga replayrunnern.
    const preload = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(preload, `
      const Module = require('module');
      const originalLoad = Module._load;
      const wrapped = new WeakSet();
      Module._load = function(...args) {
        const App = originalLoad.apply(this, args);
        if (typeof App !== 'function' || !App.prototype?._triggerBoatNearFlowBest
            || wrapped.has(App)) return App;
        wrapped.add(App);
        const processMessage = App.prototype._processAISMessage;
        const fire = (app, name, vessel) => app._triggerBoatNearFlowBest({
          vessel_name: name, bridge_name: 'Klaffbron', direction: 'norrut', eta_minutes: -1,
        }, { mmsi: vessel.mmsi, bridge: 'klaffbron', source: 'position-probe' }, vessel);
        App.prototype._processAISMessage = function(message) {
          const result = processMessage.call(this, message);
          if (String(message.mmsi) !== '${MMSI}') return result;
          if (message.timestamp === ${START}) {
            setTimeout(() => {
              const vessel = { ...this.vesselDataService.getVessel('${MMSI}') };
              fire(this, 'BEFORE_INPUT', vessel);
              // Referensen får ändras efter SDK-anropet utan att diagnostiken följer med.
              vessel.lat = 0;
            }, 1000);
          } else if (message.timestamp === ${START + 1000}) {
            fire(this, 'AFTER_INPUT', this.vesselDataService.getVessel('${MMSI}'));
            // Samma väg används av exit-fallback när VDS inte längre har båten.
            fire(this, 'REMOVED_VESSEL', {
              mmsi: '902009073', lat: ${rows[0].lat}, lon: ${rows[0].lon},
            });
          }
          return result;
        };
        return App;
      };
    `);
    synthetic = run(input, { NODE_OPTIONS: `--require ${preload}` });
    field = run(FIELD);
  }, 45000);

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('timeranropet ser föregående position även när fake-now redan är nästa fixs tid', () => {
    const notification = synthetic.notifications.find((n) => n.name === 'BEFORE_INPUT');
    expect(notification).toMatchObject({
      t: START + 1000,
      vesselLat: rows[0].lat,
      vesselLon: rows[0].lon,
      vesselLatNext: rows[1].lat,
      success: true,
    });
  });

  test('nästa anrop vid exakt samma tid använder det nya fix som nu verkligen har matats in', () => {
    const notification = synthetic.notifications.find((n) => n.name === 'AFTER_INPUT');
    expect(notification).toMatchObject({
      t: START + 1000,
      vesselLat: rows[1].lat,
      vesselLon: rows[1].lon,
      vesselLatNext: null,
      success: true,
    });
  });

  test('borttagen båts medskickade position tappas inte av en tom VDS', () => {
    const notification = synthetic.notifications.find((n) => n.name === 'REMOVED_VESSEL');
    expect(notification).toMatchObject({
      vesselLat: rows[0].lat, vesselLon: rows[0].lon, vesselLatNext: null, success: true,
    });
  });

  test('ORCA vid Järnvägsbron: råfix 14:01:43 har inte nått kortanropet ännu', () => {
    const notification = field.notifications.find((n) => n.mmsi === '211100280' && n.bridge === 'Järnvägsbron');
    expect(notification).toMatchObject({
      vesselLat: 58.291421666666665,
      vesselLon: 12.291825,
      vesselLatNext: 58.290231666666664,
      success: true,
    });
    expect(notification.t).toBeGreaterThan(Date.parse('2026-08-04T14:00:43.502Z'));
    expect(notification.t).toBeLessThanOrEqual(Date.parse('2026-08-04T14:01:43.833Z'));
  });

  test('instrumenteringen lämnar båda körningarna utan processfel eller kvarvarande timers', () => {
    for (const replay of [synthetic, field]) {
      expect(replay.processErrors).toBe(0);
      expect(replay.runtimeDiagnostics.timersAfterShutdown).toBe(0);
    }
  });
});
