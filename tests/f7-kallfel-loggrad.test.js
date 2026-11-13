'use strict';

jest.mock('homey');

const EventEmitter = require('events');
const AISBridgeApp = require('../app');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const AISHubClient = require('../lib/connection/AISHubClient');

/**
 * F7 (fältprovet 2026-11-11, k1 rad 24102–24103): ett AISHub-fel
 * (connect ENETUNREACH mot AISHubs server) loggades som
 * "❌ [AIS_CONNECTION] AIS stream error", eftersom _onAISError inte tog emot
 * källan som muxen skickar som andra argument. Fältanalysen läste raden som
 * ett AISstream-fel. Provet går hela vägen: AISHub-klientens riktiga
 * nätfelsväg → muxens re-emit → appens lyssnare som _setupEventHandlers
 * kopplar.
 */
describe('F7: källfelets loggrad bär källan', () => {
  let app;
  let mux;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T02:20:00Z') });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const err = new Error('connect ENETUNREACH 144.76.105.244:443');
    err.code = 'ENETUNREACH';
    jest.spyOn(AISHubClient.prototype, '_httpGet').mockRejectedValue(err);
    const store = {};
    mux = new AISSourceMultiplexer({ log: jest.fn(), debug: jest.fn(), error: jest.fn() }, {
      get: (k) => store[k] ?? null,
      set: (k, v) => {
        store[k] = v;
      },
    });

    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    // Produktionens koppling: _setupEventHandlers binder aisClient-lyssnarna.
    app.vesselDataService = new EventEmitter();
    app.statusService = new EventEmitter();
    app.aisClient = mux;
    app.homey = {
      settings: { get: jest.fn(), set: jest.fn(), on: jest.fn() },
      flow: {
        getDeviceTriggerCard: jest.fn(),
        getTriggerCard: jest.fn(),
        getConditionCard: jest.fn(() => ({ registerRunListener: jest.fn() })),
      },
    };
    try {
      app._setupEventHandlers();
    } catch (e) {
      // Senare registreringar kan falla på stubbarna; felvägen binds tidigt.
    }
    expect(mux.listeners('error').length).toBeGreaterThan(0);
  });

  afterEach(() => {
    mux.disconnect();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const errorRows = () => app.error.mock.calls.map((c) => String(c[0]));

  test('ett AISHub-nätfel loggas som AISHub-fel, aldrig som "AIS stream error"', async () => {
    mux.applySourceConfig({ source: 'aishub', apiKey: null, aishubUsername: 'tester' });
    await jest.advanceTimersByTimeAsync(20 * 1000);
    expect(errorRows()).toContain('❌ [AIS_CONNECTION] AIS-källfel från AISHub:');
    expect(errorRows().some((r) => r.includes('AIS stream error'))).toBe(false);
    // Felobjektet följer med oförändrat (stackspåret är fältanalysens underlag).
    const row = app.error.mock.calls.find((c) => String(c[0]).includes('från AISHub'));
    expect(row[1].code).toBe('ENETUNREACH');
  });

  test('ett AISstream-fel loggas som AISstream-fel', () => {
    mux._streamClient.emit('error', new Error('socketfel'));
    expect(errorRows()).toEqual(['❌ [AIS_CONNECTION] AIS-källfel från AISstream:']);
  });

  test('ett fel utan källa (äldre anropare) påstår ingen källa', () => {
    app._onAISError(new Error('okänt'));
    expect(errorRows()).toEqual(['❌ [AIS_CONNECTION] AIS-källfel från okänd källa:']);
  });
});
