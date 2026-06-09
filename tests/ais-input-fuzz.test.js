'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const AISStreamClient = require('../lib/connection/AISStreamClient');

/**
 * Fuzz-test (2026-06-09): korrupt/fientlig AIS-indata får ALDRIG nå pelarna —
 * inget skräp får skapa fartyg (→ falsk bridge_text/notis) och ingenting får
 * kasta (→ krasch som fryser bridge_text och tystar notiser).
 */
describe('Fuzz: korrupt AIS-data når aldrig pelarna', () => {
  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._replayCaptureFile = null;
    app.vesselDataService = { updateVessel: jest.fn() };
    return app;
  }

  const GARBAGE_MESSAGES = [
    null,
    undefined,
    'inte ett objekt',
    42,
    [],
    {},
    { mmsi: null, lat: 58.29, lon: 12.29 },
    { mmsi: '265001111' }, // koordinater saknas
    { mmsi: '265001111', lat: null, lon: 12.29 },
    { mmsi: '265001111', lat: NaN, lon: 12.29 },
    { mmsi: '265001111', lat: Infinity, lon: 12.29 },
    { mmsi: '265001111', lat: 'femtioåtta', lon: 12.29 },
    { mmsi: '265001111', lat: 91, lon: 12.29 }, // utanför jorden
    { mmsi: '265001111', lat: -91, lon: 12.29 },
    { mmsi: '265001111', lat: 58.29, lon: 181 },
    { mmsi: '265001111', lat: 58.29, lon: -181 },
    { mmsi: '265001111', lat: 0, lon: 0 }, // Guineabukten-artefakt
    {
      mmsi: '265001111', lat: 58.29, lon: 12.29, sog: -5,
    }, // negativ fart
    {
      mmsi: '265001111', lat: 58.29, lon: 12.29, sog: 250,
    }, // omöjlig fart
    {
      mmsi: '265001111', lat: 58.29, lon: 12.29, cog: 720,
    }, // ogiltig kurs
    {
      mmsi: '265001111', lat: 58.29, lon: 12.29, cog: -10,
    },
    {
      mmsi: '265001111', lat: 58.29, lon: 12.29, shipName: 12345,
    }, // fel namntyp
  ];

  test('inget skräpmeddelande kastar eller når updateVessel', () => {
    const app = makeApp();
    for (const msg of GARBAGE_MESSAGES) {
      expect(() => app._processAISMessage(msg)).not.toThrow();
    }
    expect(app.vesselDataService.updateVessel).not.toHaveBeenCalled();
  });

  test('giltigt meddelande passerar valideringen (negativ kontroll)', () => {
    const app = makeApp();
    app._processAISMessage({
      mmsi: '265001111', lat: 58.29, lon: 12.29, sog: 5.0, cog: 25, shipName: 'OK BÅT',
    });
    expect(app.vesselDataService.updateVessel).toHaveBeenCalledTimes(1);
    const [mmsi, patch] = app.vesselDataService.updateVessel.mock.calls[0];
    expect(mmsi).toBe('265001111');
    expect(patch.lat).toBe(58.29);
  });

  test('updateVessel som kastar kraschar inte meddelandeloopen', () => {
    const app = makeApp();
    app.vesselDataService.updateVessel = jest.fn(() => {
      throw new Error('internal corruption');
    });
    expect(() => app._processAISMessage({
      mmsi: '265001111', lat: 58.29, lon: 12.29, sog: 5.0, cog: 25,
    })).not.toThrow();
    expect(app.error).toHaveBeenCalled(); // loggat, inte sväljt tyst
  });
});

describe('Fuzz: korrupt WebSocket-payload i AISStreamClient', () => {
  function makeClient() {
    const client = new AISStreamClient({ log: jest.fn(), error: jest.fn(), debug: jest.fn() });
    return client;
  }

  const GARBAGE_PAYLOADS = [
    'inte json alls',
    '',
    '{trasig json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ MessageType: 'PositionReport' }), // utan Message/Metadata
    JSON.stringify({ MessageType: 'PositionReport', Message: {}, MetaData: {} }),
    JSON.stringify({ MessageType: 'OkändTyp', Message: { x: {} } }),
    JSON.stringify({
      MessageType: 'PositionReport',
      Message: { PositionReport: { MMSI: 123 } },
      MetaData: { Latitude: 0, Longitude: 0 }, // 0,0-artefakt
    }),
  ];

  test('ingen payload kastar eller emitterar ais-message', () => {
    const client = makeClient();
    const emitted = [];
    client.on('ais-message', (d) => emitted.push(d));
    for (const payload of GARBAGE_PAYLOADS) {
      expect(() => client._onMessage(payload)).not.toThrow();
    }
    expect(emitted).toHaveLength(0);
  });

  test('server-felmeddelande emitterar auth-error (inte ais-message)', () => {
    const client = makeClient();
    const authErrors = [];
    const messages = [];
    client.on('auth-error', (d) => authErrors.push(d));
    client.on('ais-message', (d) => messages.push(d));

    client._onMessage(JSON.stringify({ error: 'Api Key Is Not Valid' }));

    expect(authErrors).toHaveLength(1);
    expect(messages).toHaveLength(0);
  });

  test('giltig position emitteras korrekt (negativ kontroll)', () => {
    const client = makeClient();
    const emitted = [];
    client.on('ais-message', (d) => emitted.push(d));
    client._onMessage(JSON.stringify({
      MessageType: 'PositionReport',
      Message: { PositionReport: { MMSI: 265001111, SOG: 5, COG: 25 } },
      MetaData: { Latitude: 58.29, Longitude: 12.29, ShipName: 'OK BÅT' },
    }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].mmsi).toBe('265001111');
    expect(emitted[0].lat).toBe(58.29);
  });
});
